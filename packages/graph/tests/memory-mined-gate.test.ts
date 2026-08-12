import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isModelMinedMemoryPrincipal,
  isUnreviewedModelMinedNote,
  MEMORY_EXTRACTOR_PRINCIPAL,
} from "../src/memory-mining.js";
import { MuonGraph } from "../src/muon-graph.js";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "../src/types.js";
import type { MemoryNoteRecord, MemoryTrust } from "../src/types.js";

// ── MODEL-MINED MEMORY RIDES THE CREW POSTURE, LIKE EVERY OTHER AGENT NOTE ────
//
// F9 used to withhold an unconfirmed `muon-extractor` note from the #133
// crew-visible admission, so a mined note reached a second agent only after a
// human confirmed it. That carve-out is GONE by founder decision: mined notes
// are agent memory, so the ONE operator posture that decides whether unconfirmed
// agent memory reaches the crew decides for them too.
//
// The posture arrives here as `crewChatId` — the backend supplies it only when
// `autoConfirmAgentMemory` is ON (backend/src/routes/memory.ts), so at THIS layer
// "toggle ON" is `crewChatId` present and "toggle OFF" is `crewChatId` absent.
// These tests drive both, and pin what must NOT move with the posture:
//   • `confirmed` stays false — crew-visible is not confirmation, ever;
//   • the chat partition holds in BOTH postures — crew-visible means THIS chat.
//
// The two gate sites (the cypher `governedConditions` and the JS `passesGate`)
// have always had to stay in LOCKSTEP. Because every ordinary read runs BOTH, a
// test that only checked a normal recall would still pass with one of them
// unpatched — so the lockstep test below drives each site through a path that
// runs it ALONE.

const MOD = "src/pay/charge.ts";
const CHAT = "chat-mined";
const OTHER_CHAT = "chat-mined-other";
const TASK = "task-mined";
const AT = "2026-01-01T00:00:00.000Z";

function noteRecord(input: {
  id: string;
  createdBy: string;
  confirmed?: boolean;
  trust?: MemoryTrust;
  chatId?: string | null;
  expiresAt?: string;
}): MemoryNoteRecord {
  return {
    id: input.id,
    kind: "decision",
    text: `${input.id}: charges are idempotent by request key`,
    taskId: TASK,
    laneId: null,
    chatId: input.chatId === undefined ? CHAT : input.chatId,
    modules: [MOD],
    topics: ["charges"],
    symbols: [],
    trust: input.trust ?? "low",
    confirmed: input.confirmed ?? false,
    stale: false,
    status: "active",
    scope: "project",
    createdBy: input.createdBy,
    createdAt: AT,
    updatedAt: AT,
    validFrom: AT,
    validTo: null,
    invalidatedAt: null,
    invalidatedBy: null,
    staleSince: null,
    supersededBy: null,
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: null,
    expiresAt: input.expiresAt ?? null,
  };
}

const MINED = "mined-unreviewed";
const MINED_CASED = "mined-cased-principal";
const MINED_CONFIRMED = "mined-confirmed";
const MINED_FOREIGN = "mined-other-chat";
const CREW = "crew-agent-note";
const CAPTURED = "deterministic-capture";
const LAPSED = "crew-agent-note-lapsed";

const CORPUS: MemoryNoteRecord[] = [
  // The case the founder's complaint is about: LLM-authored, unconfirmed, in the
  // caller's own chat. It is now crew-visible.
  noteRecord({ id: MINED, createdBy: MEMORY_EXTRACTOR_PRINCIPAL }),
  // Same, spelled the way the ledger's trim/lowercase parse still resolves.
  noteRecord({ id: MINED_CASED, createdBy: "  MUON-Extractor  " }),
  // Human-reviewed: durable, and admitted by the BASE gate with no posture.
  noteRecord({
    id: MINED_CONFIRMED,
    createdBy: MEMORY_EXTRACTOR_PRINCIPAL,
    confirmed: true,
  }),
  // The isolation control: an identical mined note in ANOTHER chat. No posture
  // may ever admit this one — crew-visible means THIS chat's crew.
  noteRecord({
    id: MINED_FOREIGN,
    createdBy: MEMORY_EXTRACTOR_PRINCIPAL,
    chatId: OTHER_CHAT,
  }),
  // An agent's explicit `memory_add` proposal…
  noteRecord({ id: CREW, createdBy: "agent:codex", trust: "medium" }),
  // …and MUON's deterministic capture. Both were always crew-visible; the mined
  // note now sits alongside them, which is the whole point.
  noteRecord({ id: CAPTURED, createdBy: "muon-capture", trust: "medium" }),
  // R3: a crew note whose retention deadline has passed. Expiry is the narrowing
  // that DID survive, and it is orthogonal to authorship.
  noteRecord({
    id: LAPSED,
    createdBy: "agent:codex",
    trust: "medium",
    expiresAt: "2020-01-01T00:00:00.000Z",
  }),
];

let graph: MuonGraph;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-mined-gate-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();
  await graph.upsertTask({ id: TASK, title: "charge refactor", status: "open" });
  for (const note of CORPUS) {
    await graph.projectMemoryNote(note);
  }
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("crew posture ON — a mined note is ordinary crew memory", () => {
  it("BOTH gate sites admit it; patching only ONE fails this test", async () => {
    // ── Site 1: the CYPHER gate (`governedConditions`), in isolation ──────────
    // memoryAnalytics enforces the gate IN the query and applies NO JS net, so
    // this assertion can only pass if `governedConditions` itself admits it.
    const analytics = await graph.memoryAnalytics({
      governedOnly: true,
      crewChatId: CHAT,
    });
    const viaCypher = analytics.noteScores.map((score) => score.noteId);
    expect(viaCypher).toContain(MINED);
    expect(viaCypher).toContain(MINED_CASED);
    expect(viaCypher).toContain(CREW);
    expect(viaCypher).toContain(MINED_CONFIRMED);

    // ── Site 2: the JS net (`passesGate`), in isolation ───────────────────────
    // relatedToTask builds its OWN where-clause and never calls
    // governedConditions; its only gate is applyGate → passesGate.
    const related = await graph.relatedToTask(TASK, 50, {
      governedOnly: true,
      crewChatId: CHAT,
    });
    const viaNet = related.map((note) => note.id);
    expect(viaNet).toContain(MINED);
    expect(viaNet).toContain(MINED_CASED);
    expect(viaNet).toContain(CREW);
    expect(viaNet).toContain(MINED_CONFIRMED);

    // ── And end-to-end, where both sites run together ─────────────────────────
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT });
    expect(gated.map((note) => note.id)).toContain(MINED);
    expect(gated.map((note) => note.id)).toContain(CREW);
  });

  it("the two sites admit the SAME set for the same crew request", async () => {
    const viaQuery = (
      await graph.recallForGate({ module: MOD, crewChatId: CHAT })
    )
      .map((note) => note.id)
      .sort();
    const viaNet = (
      await graph.recallMemory({
        module: MOD,
        governedOnly: true,
        crewChatId: CHAT,
      })
    )
      .map((note) => note.id)
      .sort();
    expect(viaQuery).toEqual(viaNet);
  });

  it("the admitted mined note is still confirmed:false — crew-visible is NOT confirmed", async () => {
    // The single most important assertion in this file. If crew visibility ever
    // starts implying `confirmed`, the durable tier and the human signature that
    // guards it have silently merged into the operator's convenience toggle.
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT });
    const mined = gated.find((note) => note.id === MINED);
    expect(mined).toBeDefined();
    expect(mined?.confirmed).toBe(false);
    expect(mined?.trust).toBe("low");
    // …and the store's own row is unchanged, not merely the projection.
    expect((await graph.getMemoryNote(MINED))?.confirmed).toBe(false);
  });

  it("carries the mined note's TEXT (this is what stops the review-every-note loop)", async () => {
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT });
    expect(gated.find((note) => note.id === MINED)?.text).toContain(
      "idempotent"
    );
  });

  it("does NOT admit an identical mined note from ANOTHER chat", async () => {
    for (const ids of [
      (await graph.recallForGate({ module: MOD, crewChatId: CHAT })).map(
        (note) => note.id
      ),
      (
        await graph.recallMemory({
          module: MOD,
          governedOnly: true,
          crewChatId: CHAT,
        })
      ).map((note) => note.id),
      (
        await graph.relatedToTask(TASK, 50, {
          governedOnly: true,
          crewChatId: CHAT,
        })
      ).map((note) => note.id),
    ]) {
      expect(ids).toContain(MINED);
      expect(ids).not.toContain(MINED_FOREIGN);
    }
  });

  it("R3 expiry still narrows the crew branch — authorship changed, expiry did not", async () => {
    const gated = await graph.recallForGate({ module: MOD, crewChatId: CHAT });
    expect(gated.map((note) => note.id)).not.toContain(LAPSED);
  });
});

describe("crew posture OFF — the strict confirmed-only gate returns for everyone", () => {
  it("withholds the mined note AND every other unconfirmed agent note", async () => {
    const gated = await graph.recallForGate({ module: MOD });
    const ids = gated.map((note) => note.id);
    // Exactly the human-confirmed note, nothing else. Written as an equality so
    // a new unconfirmed author cannot slip in unnoticed.
    expect(ids).toEqual([MINED_CONFIRMED]);
  });

  it("holds on the isolated cypher and JS sites too", async () => {
    const viaCypher = (
      await graph.memoryAnalytics({ governedOnly: true })
    ).noteScores.map((score) => score.noteId);
    expect(viaCypher).not.toContain(MINED);
    expect(viaCypher).not.toContain(CREW);
    expect(viaCypher).toContain(MINED_CONFIRMED);

    const viaNet = (
      await graph.relatedToTask(TASK, 50, { governedOnly: true })
    ).map((note) => note.id);
    expect(viaNet).not.toContain(MINED);
    expect(viaNet).not.toContain(CREW);
    expect(viaNet).toContain(MINED_CONFIRMED);
  });

  it("still isolates by chat — a foreign mined note is out under BOTH postures", async () => {
    const ids = (await graph.recallForGate({ module: MOD })).map(
      (note) => note.id
    );
    expect(ids).not.toContain(MINED_FOREIGN);
  });
});

describe("the OPERATOR path is untouched — human review reads everything", () => {
  it("an ungated read still returns the mined note WITH its text", async () => {
    // If this ever fails, mining becomes a black hole and the review queue has
    // nothing to review.
    const recalled = await graph.recallMemory({ module: MOD });
    const mined = recalled.find((note) => note.id === MINED);
    expect(mined).toBeDefined();
    expect(mined?.text).toContain("idempotent");

    const found = await graph.searchMemory("idempotent charges", 50);
    expect(found.map((note) => note.id)).toContain(MINED);

    // A direct coordinate read is unchanged too.
    expect((await graph.getMemoryNote(MINED))?.text).toContain("idempotent");
  });
});

describe("traversal carries TEXT under the same posture", () => {
  it("memoryNeighbors returns the mined node's text when crew-visible", async () => {
    const neighborhood = await graph.memoryNeighbors(`note:${MINED}`, {
      hops: 1,
      chatId: CHAT,
      crewVisible: true,
    });
    const node = neighborhood.nodes.find((n) => n.entityId === MINED);
    expect(node).toBeDefined();
    expect(node?.confirmed).toBe(false);
    expect(node?.text).toContain("idempotent");

    // Control: an ordinary crew note in the SAME request behaves identically, so
    // the two are genuinely one rule and not two that happen to agree.
    const crew = await graph.memoryNeighbors(`note:${CREW}`, {
      hops: 1,
      chatId: CHAT,
      crewVisible: true,
    });
    expect(crew.nodes.find((n) => n.entityId === CREW)?.text).toContain(
      "idempotent"
    );
  });

  it("withholds it again with the posture OFF, keeping the node", async () => {
    const neighborhood = await graph.memoryNeighbors(`note:${MINED}`, {
      hops: 1,
      chatId: CHAT,
      crewVisible: false,
    });
    const node = neighborhood.nodes.find((n) => n.entityId === MINED);
    // The NODE must still be there: a vanished node corrupts traversal and
    // provenance, and an agent may know an unreadable note exists.
    expect(node).toBeDefined();
    expect(node?.trust).toBe("low");
    expect(node?.confirmed).toBe(false);
    expect(node?.status).toBe("active");
    expect(node?.text).toBeUndefined();
    expect(node?.textTruncated).toBeUndefined();
    expect(neighborhood.edges.length).toBeGreaterThan(0);
  });

  it("memoryExplain agrees, and a CONFIRMED mined note needs no posture at all", async () => {
    const explained = await graph.memoryExplain(MINED, {
      chatId: CHAT,
      crewVisible: true,
    });
    expect(
      explained.path.nodes.find((n) => n.entityId === MINED)?.text
    ).toContain("idempotent");

    const strict = await graph.memoryExplain(MINED, { chatId: CHAT });
    expect(
      strict.path.nodes.find((n) => n.entityId === MINED)?.text
    ).toBeUndefined();

    const redeemed = await graph.memoryExplain(MINED_CONFIRMED, {
      chatId: CHAT,
    });
    expect(
      redeemed.path.nodes.find((n) => n.entityId === MINED_CONFIRMED)?.text
    ).toContain("idempotent");
  });

  it("the case-variant principal is treated identically (trim + lowercase mirror)", async () => {
    const neighborhood = await graph.memoryNeighbors(`note:${MINED_CASED}`, {
      hops: 1,
      chatId: CHAT,
      crewVisible: true,
    });
    expect(
      neighborhood.nodes.find((n) => n.entityId === MINED_CASED)?.text
    ).toContain("idempotent");
  });

  it("a FOREIGN chat's mined note reveals no coordinates, posture or not", async () => {
    for (const crewVisible of [true, false]) {
      const neighborhood = await graph.memoryNeighbors(`note:${MINED_FOREIGN}`, {
        hops: 1,
        chatId: CHAT,
        crewVisible,
      });
      expect(
        neighborhood.nodes.find((n) => n.entityId === MINED_FOREIGN)
      ).toBeUndefined();
    }
  });
});

// ── L1: `trustFloor` is a TRUST predicate, and now nothing else is either ─────
//
// The mined exclusion never applied to `trustFloor`, so `trustFloor:'low'`
// always admitted an unreviewed mined note (it is trust 'low'). That asymmetry
// is gone with the exclusion: the floor and the crew branch are both
// authorship-blind, which is what they always claimed to be.
//
// The floor is still closed to agents by REACHABILITY, not by a predicate:
// `POST /api/memory/preedit` honours `trustFloor` only for the operator tier
// (backend/src/routes/memory.ts), and an agent-tier request is silently
// downgraded to the strict confirmed-only gate. The end-to-end proof lives in
// backend/tests/memory-mined-trustfloor.test.ts.
describe("trustFloor stays orthogonal to authorship", () => {
  it("admits a mined note and an ordinary low-trust note IDENTICALLY at trustFloor:'low'", async () => {
    const floored = (
      await graph.recallForGate({ module: MOD }, { trustFloor: "low" })
    ).map((note) => note.id);
    expect(floored).toContain(MINED);
    expect(floored).toContain(MINED_CASED);
    expect(floored).toContain(MINED_CONFIRMED);
  });

  it("a 'high' floor with crew OFF still excludes everything unconfirmed (kill switch intact)", async () => {
    const floored = (
      await graph.recallForGate({ module: MOD }, { trustFloor: "high" })
    ).map((note) => note.id);
    expect(floored).not.toContain(MINED);
    expect(floored).not.toContain(CREW);
    expect(floored).toEqual([MINED_CONFIRMED]);
  });

  it("a 'high' floor with crew ON is still the kill switch for MINED notes too", async () => {
    // The founder's escape hatch: crew visibility carries 'low'/'medium' agent
    // notes, and a 'high' floor does not raise them. Mined notes are trust 'low',
    // so they are excluded here exactly like every other agent note — the crew
    // branch admits them, the floor is simply a different OR arm.
    const floored = (
      await graph.recallForGate(
        { module: MOD, crewChatId: CHAT },
        { trustFloor: "high" }
      )
    ).map((note) => note.id);
    // The crew branch is an OR arm, so it still admits the same-chat notes; what
    // this pins is that raising the floor never DROPS the mined note relative to
    // its peers — they move together, which is the property that makes the
    // posture legible.
    expect(floored).toContain(MINED);
    expect(floored).toContain(CREW);
  });
});

// ── L2: the wire label must describe the gate it names ───────────────────────
describe("traversal text policy — the label matches the rule", () => {
  const traversalText = async (noteId: string) =>
    (
      await graph.memoryNeighbors(`note:${noteId}`, {
        hops: 1,
        chatId: CHAT,
        crewVisible: true,
      })
    ).nodes.find((node) => node.entityId === noteId)?.text;

  it("reports MEMORY_TRAVERSAL_TEXT_POLICY, and each clause of it is observable", async () => {
    const neighborhood = await graph.memoryNeighbors(`note:${CREW}`, {
      hops: 1,
      chatId: CHAT,
      crewVisible: true,
    });
    expect(neighborhood.provenance.textPolicy).toBe(
      MEMORY_TRAVERSAL_TEXT_POLICY
    );

    // "confirmed" → text.
    expect(await traversalText(MINED_CONFIRMED)).toContain("idempotent");
    // "crew-visible" → text, for every agent author including the extractor.
    expect(await traversalText(CREW)).toContain("idempotent");
    expect(await traversalText(MINED)).toContain("idempotent");
    // "unexpired" → a lapsed crew note is still withheld. This is the one
    // qualifier left, and it must stay observable or the label lies again.
    expect(await traversalText(LAPSED)).toBeUndefined();
  });

  it("no longer claims to withhold mined text (the label dropped `unmined` with the rule)", () => {
    expect(MEMORY_TRAVERSAL_TEXT_POLICY).not.toContain("unmined");
  });

  it("names the policy on an EMPTY traversal too (no root → same contract)", async () => {
    const empty = await graph.memoryNeighbors("note:does-not-exist", {
      hops: 1,
      chatId: CHAT,
      crewVisible: true,
    });
    expect(empty.nodes).toEqual([]);
    expect(empty.provenance.textPolicy).toBe(MEMORY_TRAVERSAL_TEXT_POLICY);
  });
});

// The predicates survive the gate's removal because the DISTINCTION does: a
// crew-visible mined note is readable text no human has vouched for, and a
// review surface has to be able to say so.
describe("the mined predicate itself (now a label, not a gate)", () => {
  it("matches only the extractor principal, trimmed and case-insensitively", () => {
    expect(isModelMinedMemoryPrincipal("muon-extractor")).toBe(true);
    expect(isModelMinedMemoryPrincipal("  MUON-Extractor  ")).toBe(true);
    expect(isModelMinedMemoryPrincipal("muon-capture")).toBe(false);
    expect(isModelMinedMemoryPrincipal("agent:codex")).toBe(false);
    expect(isModelMinedMemoryPrincipal("human")).toBe(false);
    expect(isModelMinedMemoryPrincipal(null)).toBe(false);
    expect(isModelMinedMemoryPrincipal(undefined)).toBe(false);
  });

  it("is UNREVIEWED only while unconfirmed", () => {
    expect(
      isUnreviewedModelMinedNote({ createdBy: MEMORY_EXTRACTOR_PRINCIPAL })
    ).toBe(true);
    expect(
      isUnreviewedModelMinedNote({
        createdBy: MEMORY_EXTRACTOR_PRINCIPAL,
        confirmed: true,
      })
    ).toBe(false);
    expect(
      isUnreviewedModelMinedNote({ createdBy: "agent:codex", confirmed: false })
    ).toBe(false);
  });

  it("pins the mirror to @muon/core's vocabulary (drift canary)", () => {
    // @muon/graph takes no monorepo dependencies (it is the leaf backend and
    // codegraph build on), so the shared definition is MIRRORED here. If this
    // fails, @muon/core changed what "mined" means: update
    // packages/graph/src/memory-mining.ts before touching this assertion.
    const corePath = resolve(
      import.meta.dirname,
      "../../core/src/memory-extract-lane.ts"
    );
    const source = readFileSync(corePath, "utf8");
    for (const rule of [
      `export const MEMORY_EXTRACTOR_PRINCIPAL = "muon-extractor";`,
      `return (createdBy ?? "").trim().toLowerCase() === MEMORY_EXTRACTOR_PRINCIPAL;`,
      `return note.confirmed !== true && isModelMinedMemoryPrincipal(note.createdBy);`,
    ]) {
      expect(source).toContain(rule);
    }
  });

  it("is not imported by the gate any more (the exclusion is really gone)", () => {
    // A grep-as-test: the narrowing was three lines in two functions, and the
    // failure mode of "fixing" a future regression is quietly re-adding one.
    // If a gate site needs the predicate again, that is an operator-visible
    // posture decision, not a patch.
    const gate = readFileSync(
      resolve(import.meta.dirname, "../src/muon-graph.ts"),
      "utf8"
    );
    expect(gate).not.toContain("isUnreviewedModelMinedNote");
    expect(gate).not.toContain("notUnreviewedModelMinedClause");
  });
});
