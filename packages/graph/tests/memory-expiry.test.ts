import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isMemoryNoteExpired,
  memoryAuthorIsHuman,
  memoryNotExpiredClause,
  MEMORY_EXPIRY_PARAM,
} from "../src/memory-expiry.js";
import { MuonGraph } from "../src/muon-graph.js";
import type { MemoryNoteRecord, MemoryTrust } from "../src/types.js";

// ── R3 TTL: the GRAPH MIRROR of the ledger's expiry rule ──────────────────────
//
// The ledger (`backend/src/lib/memory-ledger.ts` → `isExpiredRow`) is the source
// of truth and still post-filters every route response; the graph mirror is
// DEFENCE IN DEPTH. These tests hold the two halves of the mirror together:
//
//   1. the CYPHER clause (visibilityClauses) and the TS net (applyGate) admit the
//      SAME notes — proven on a path that runs the cypher WITHOUT the net
//      (memoryAnalytics) against the reference predicate;
//   2. that predicate is an independent transcription of `isExpiredRow` +
//      `ttlRedeemed` + `parsePrincipal`, and a source canary fails loudly if the
//      ledger's rule text moves under it;
//   3. a WIPE → REPROJECT restores `expiresAt` — the failure mode that would
//      otherwise silently resurrect every expired note in the brain.

const MOD = "src/pay/charge.ts";
const CHAT = "chat-ttl";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const AT = "2026-01-01T00:00:00.000Z";

function noteRecord(input: {
  id: string;
  createdBy: string;
  trust?: MemoryTrust;
  confirmed?: boolean;
  expiresAt?: string | null;
  chatId?: string | null;
}): MemoryNoteRecord {
  return {
    id: input.id,
    kind: "decision",
    text: `${input.id}: charges are idempotent by request key`,
    taskId: null,
    laneId: null,
    chatId: input.chatId ?? null,
    modules: [MOD],
    topics: ["charges"],
    symbols: [],
    trust: input.trust ?? "medium",
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

// The CORPUS. Everything past its deadline unless a never-expire invariant
// redeems it; the author column also sweeps every form `parsePrincipal` accepts.
const CORPUS: MemoryNoteRecord[] = [
  // Expired: unconfirmed, medium-trust, agent-authored, deadline in the past.
  noteRecord({ id: "expired-agent", createdBy: "agent:codex", expiresAt: PAST }),
  // Stamped but NOT yet due.
  noteRecord({ id: "live-agent", createdBy: "agent:codex", expiresAt: FUTURE }),
  // Never stamped at all.
  noteRecord({ id: "unstamped-agent", createdBy: "agent:codex" }),
  // The three REDEMPTION paths, each with a deadline already past.
  noteRecord({
    id: "redeemed-confirmed",
    createdBy: "agent:codex",
    confirmed: true,
    expiresAt: PAST,
  }),
  noteRecord({ id: "redeemed-human", createdBy: "human:alice", expiresAt: PAST }),
  noteRecord({ id: "redeemed-bare-human", createdBy: "human", expiresAt: PAST }),
  noteRecord({
    id: "redeemed-high-trust",
    createdBy: "agent:codex",
    trust: "high",
    expiresAt: PAST,
  }),
  // Author-parsing edges: the ledger TRIMS and lowercases the prefix, treats a
  // bare/empty author as the HUMAN principal, and treats every other bare string
  // (and a leading colon) as an agent vendor.
  noteRecord({ id: "author-upper-human", createdBy: "HUMAN:Alice", expiresAt: PAST }),
  noteRecord({ id: "author-padded-human", createdBy: "  human  ", expiresAt: PAST }),
  noteRecord({ id: "author-padded-prefix", createdBy: " human:bob ", expiresAt: PAST }),
  noteRecord({ id: "author-empty", createdBy: "", expiresAt: PAST }),
  noteRecord({ id: "author-bare-agent", createdBy: "muon-capture", expiresAt: PAST }),
  noteRecord({ id: "author-leading-colon", createdBy: ":human", expiresAt: PAST }),
];

/**
 * INDEPENDENT transcription of the ledger's rule (`isExpiredRow` composed with
 * `ttlRedeemed` and `parsePrincipal`), written from the ledger's shape rather than
 * from `memory-expiry.ts`. Everything below is asserted against THIS, so the graph
 * mirror can only pass by agreeing with the ledger.
 */
const LEDGER_TRUST_RANK: Record<MemoryTrust, number> = { low: 0, medium: 1, high: 2 };

function ledgerAuthorIsHuman(createdBy: string): boolean {
  // parsePrincipal: `const s = (raw ?? "").trim()`, then `human:` (case-insensitive
  // prefix) → human, bare `""`/`"human"` → human, anything else → agent.
  const s = (createdBy ?? "").trim();
  const colon = s.indexOf(":");
  if (colon > 0) {
    return s.slice(0, colon).toLowerCase() === "human";
  }
  return s === "" || s.toLowerCase() === "human";
}

function ledgerExpired(note: MemoryNoteRecord, now: Date): boolean {
  const expiresAt = note.expiresAt ? new Date(note.expiresAt) : null;
  if (expiresAt === null || expiresAt.getTime() > now.getTime()) {
    return false;
  }
  return !(
    ledgerAuthorIsHuman(note.createdBy) ||
    note.confirmed ||
    LEDGER_TRUST_RANK[note.trust] >= LEDGER_TRUST_RANK.high
  );
}

const HIDDEN = CORPUS.filter((note) => ledgerExpired(note, new Date()))
  .map((note) => note.id)
  .sort();
const VISIBLE = CORPUS.filter((note) => !ledgerExpired(note, new Date()))
  .map((note) => note.id)
  .sort();

/** Corpus ids only — later tests project extra notes onto the same anchor. */
function corpusIds(notes: readonly { id: string }[]): string[] {
  const ids = new Set(CORPUS.map((note) => note.id));
  return notes
    .map((note) => note.id)
    .filter((id) => ids.has(id))
    .sort();
}

let graph: MuonGraph;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-memory-expiry-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();
  for (const note of CORPUS) {
    await graph.projectMemoryNote(note);
  }
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R3 expiry — the reference set is non-degenerate", () => {
  it("hides exactly the unconfirmed, non-human, non-high-trust past-deadline notes", () => {
    expect(HIDDEN).toEqual([
      "author-bare-agent",
      "author-leading-colon",
      "expired-agent",
    ]);
    // Every redemption path and every human-author spelling stays visible.
    expect(VISIBLE).toContain("redeemed-confirmed");
    expect(VISIBLE).toContain("redeemed-human");
    expect(VISIBLE).toContain("redeemed-bare-human");
    expect(VISIBLE).toContain("redeemed-high-trust");
    expect(VISIBLE).toContain("author-upper-human");
    expect(VISIBLE).toContain("author-padded-human");
    expect(VISIBLE).toContain("author-padded-prefix");
    expect(VISIBLE).toContain("author-empty");
  });
});

describe("R3 expiry — recall + search", () => {
  it("HIDES an expired note from recallMemory and searchMemory", async () => {
    const recalled = await graph.recallMemory({ module: MOD });
    expect(corpusIds(recalled)).toEqual(VISIBLE);

    const found = await graph.searchMemory("idempotent charges", 50);
    expect(found.map((note) => note.id)).not.toContain("expired-agent");
    expect(found.map((note) => note.id)).toContain("live-agent");
  });

  it("`showExpired` REVEALS it (and only then)", async () => {
    const all = await graph.recallMemory({ module: MOD, showExpired: true });
    expect(corpusIds(all)).toEqual(
      CORPUS.map((note) => note.id).sort()
    );

    const found = await graph.searchMemory("idempotent charges", 50, {
      showExpired: true,
    });
    expect(found.map((note) => note.id)).toContain("expired-agent");
  });

  it("keeps a confirmed / human-authored / high-trust note visible past its deadline", async () => {
    const ids = (await graph.recallMemory({ module: MOD })).map((n) => n.id);
    expect(ids).toContain("redeemed-confirmed");
    expect(ids).toContain("redeemed-human");
    expect(ids).toContain("redeemed-bare-human");
    expect(ids).toContain("redeemed-high-trust");
  });

  it("evaluates expiry against `now`, not the bitemporal `asOf` — time travel is not a bypass", async () => {
    // `asOf` sits BEFORE the deadline was ever reached. The expired note must
    // still be hidden: the as-of view is about what the brain believed, not a
    // second clock for the TTL.
    const asOf = await graph.recallMemory({
      module: MOD,
      asOf: "2026-02-01T00:00:00.000Z",
    });
    expect(asOf.map((note) => note.id)).not.toContain("expired-agent");

    // An explicit (server-owned) `now` BEFORE the deadline is the supported way to
    // ask the question, and it does un-hide the note.
    const earlier = await graph.recallMemory({
      module: MOD,
      now: "2019-01-01T00:00:00.000Z",
    });
    expect(earlier.map((note) => note.id)).toContain("expired-agent");
  });

  it("relatedToTask hides expired notes too (it builds its own WHERE, so the JS net is the only guard)", async () => {
    const taskId = "task-ttl";
    await graph.upsertTask({ id: taskId, title: "charge refactor", status: "open" });
    await graph.projectMemoryNote({
      ...noteRecord({ id: "task-expired", createdBy: "agent:codex", expiresAt: PAST }),
      taskId,
    });
    await graph.projectMemoryNote({
      ...noteRecord({ id: "task-live", createdBy: "agent:codex", expiresAt: FUTURE }),
      taskId,
    });

    const related = await graph.relatedToTask(taskId);
    expect(related.map((note) => note.id)).toContain("task-live");
    expect(related.map((note) => note.id)).not.toContain("task-expired");

    const withExpired = await graph.relatedToTask(taskId, 50, {
      showExpired: true,
    });
    expect(withExpired.map((note) => note.id)).toContain("task-expired");
  });

  it("the KG-6 gate cannot resurrect an expired note through the crew-visible branch", async () => {
    // #133 admits a same-chat UNCONFIRMED agent note into the gate view. Expiry is
    // a SEPARATE bound and must survive that widening.
    const crewChat = "chat-crew";
    const crewNote = noteRecord({
      id: "expired-crew",
      createdBy: "agent:codex",
      expiresAt: PAST,
      chatId: crewChat,
    });
    await graph.projectMemoryNote(crewNote);

    const gated = await graph.recallForGate({
      module: MOD,
      crewChatId: crewChat,
    });
    expect(gated.map((note) => note.id)).not.toContain("expired-crew");

    const withExpired = await graph.recallForGate({
      module: MOD,
      crewChatId: crewChat,
      showExpired: true,
    });
    expect(withExpired.map((note) => note.id)).toContain("expired-crew");
  });
});

describe("R3 expiry — cypher clause and TS net stay in LOCKSTEP", () => {
  it("the cypher clause ALONE admits exactly the reference set", async () => {
    // memoryAnalytics runs `visibilityClauses` with NO TS post-filter, so its note
    // set is the cypher predicate's verdict on its own.
    const snapshot = await graph.memoryAnalytics();
    const viaCypher = corpusIds(
      snapshot.noteScores.map((score) => ({ id: score.noteId }))
    );
    expect(viaCypher).toEqual(VISIBLE);
  });

  it("the TS predicate agrees with the ledger transcription on every corpus row", () => {
    const now = new Date();
    for (const note of CORPUS) {
      expect({ id: note.id, expired: isMemoryNoteExpired(note, now.toISOString()) })
        .toEqual({ id: note.id, expired: ledgerExpired(note, now) });
      expect(memoryAuthorIsHuman(note.createdBy)).toBe(
        ledgerAuthorIsHuman(note.createdBy)
      );
    }
  });

  it("a note with no deadline, or an unreadable one, NEVER expires", () => {
    const base = noteRecord({ id: "x", createdBy: "agent:codex" });
    expect(isMemoryNoteExpired({ ...base, expiresAt: null })).toBe(false);
    expect(isMemoryNoteExpired({ ...base, expiresAt: "" })).toBe(false);
    expect(isMemoryNoteExpired({ ...base, expiresAt: "not-a-date" })).toBe(false);
  });
});

describe("R3 expiry — traversal surfaces withhold text", () => {
  const traversalChat = "chat-traversal";

  beforeAll(async () => {
    await graph.projectMemoryNote(
      noteRecord({
        id: "traversal-expired",
        createdBy: "agent:codex",
        expiresAt: PAST,
        chatId: traversalChat,
      })
    );
    await graph.projectMemoryNote(
      noteRecord({
        id: "traversal-live",
        createdBy: "agent:codex",
        expiresAt: FUTURE,
        chatId: traversalChat,
      })
    );
  });

  it("memoryNeighbors keeps the expired node as coordinates but withholds `text`", async () => {
    const expired = await graph.memoryNeighbors("note:traversal-expired", {
      chatId: traversalChat,
      crewVisible: true,
    });
    const node = expired.nodes.find((n) => n.entityId === "traversal-expired");
    expect(node).toBeDefined();
    expect(node?.trust).toBe("medium");
    expect(node?.text).toBeUndefined();
    expect(node?.textTruncated).toBeUndefined();

    // Control: the same crew-visible tier on a note that is NOT expired still
    // carries its text, so the withholding is expiry and nothing else.
    const live = await graph.memoryNeighbors("note:traversal-live", {
      chatId: traversalChat,
      crewVisible: true,
    });
    expect(
      live.nodes.find((n) => n.entityId === "traversal-live")?.text
    ).toContain("idempotent");
  });

  it("memoryExplain withholds `text` on an expired node too", async () => {
    const explained = await graph.memoryExplain("traversal-expired", {
      chatId: traversalChat,
      crewVisible: true,
    });
    const node = explained.path.nodes.find(
      (n) => n.entityId === "traversal-expired"
    );
    expect(node).toBeDefined();
    expect(node?.text).toBeUndefined();
    expect(node?.textTruncated).toBeUndefined();

    const live = await graph.memoryExplain("traversal-live", {
      chatId: traversalChat,
      crewVisible: true,
    });
    expect(
      live.path.nodes.find((n) => n.entityId === "traversal-live")?.text
    ).toContain("idempotent");
  });
});

describe("R3 expiry — a wipe must not resurrect expired notes", () => {
  it("wipe → reproject restores `expiresAt` and the note stays hidden", async () => {
    // A wipe is a NEW, empty store: the ledger replays every note through
    // projectMemoryNote (projectLedgerToGraph). If the deadline did not survive
    // that round trip, every expired note in the brain would come back.
    const wipedDir = mkdtempSync(join(tmpdir(), "muon-memory-expiry-wipe-"));
    const rebuilt = new MuonGraph(join(wipedDir, "test.lbug"));
    try {
      await rebuilt.init();
      expect(await rebuilt.getMemoryNote("expired-agent")).toBeNull();

      for (const note of CORPUS) {
        await rebuilt.projectMemoryNote(note);
      }

      const restored = await rebuilt.getMemoryNote("expired-agent");
      expect(restored?.expiresAt).toBe(PAST);
      expect(
        (await rebuilt.recallMemory({ module: MOD })).map((note) => note.id).sort()
      ).toEqual(VISIBLE);
      expect(
        (await rebuilt.getMemoryNote("redeemed-human"))?.expiresAt
      ).toBe(PAST);
      expect((await rebuilt.getMemoryNote("unstamped-agent"))?.expiresAt).toBeNull();
    } finally {
      await rebuilt.close();
      rmSync(wipedDir, { recursive: true, force: true });
    }
  });

  it("re-projecting over an INTACT store keeps the deadline (ON MATCH, not just ON CREATE)", async () => {
    const note = CORPUS.find((row) => row.id === "expired-agent")!;
    await graph.projectMemoryNote(note);
    expect((await graph.getMemoryNote("expired-agent"))?.expiresAt).toBe(PAST);
    expect(
      (await graph.recallMemory({ module: MOD })).map((row) => row.id)
    ).not.toContain("expired-agent");
  });

  it("a CLEARED deadline (the redemption path) re-projects as never-expiring", async () => {
    // Confirming a note clears `expiresAt` in the ledger; the projection must
    // clear it on the node too, not leave the old deadline behind.
    const note = CORPUS.find((row) => row.id === "expired-agent")!;
    await graph.projectMemoryNote({ ...note, expiresAt: null, confirmed: true });
    expect((await graph.getMemoryNote("expired-agent"))?.expiresAt).toBeNull();
    expect(
      (await graph.recallMemory({ module: MOD })).map((row) => row.id)
    ).toContain("expired-agent");
    // Restore the corpus state for any later test in this file.
    await graph.projectMemoryNote(note);
  });
});

describe("R3 expiry — a NOT-YET-EXPIRED note is fully visible everywhere", () => {
  // The bug class: "not-yet-expired reads as expired". Every fresh agent note is
  // stamped ~30d out, so if a deadline in the FUTURE ever reads as past — an
  // unbound `$now`, a flipped comparison, a clause pasted without its parameter —
  // memory would vanish the instant it was written. This pins the WHOLE surface,
  // root node and edges alike, not one reported symptom.
  const chat = "chat-fresh";
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  let sourceId: string;
  let cloneId: string;

  beforeAll(async () => {
    sourceId = "fresh-source";
    cloneId = "fresh-clone";
    await graph.projectMemoryNote(
      noteRecord({ id: sourceId, createdBy: "agent:codex", chatId: chat, confirmed: true })
    );
    await graph.projectMemoryNote(
      // Exactly a fresh clone: unconfirmed, medium trust, agent-authored, stamped
      // 30 days out by the ledger's TTL policy.
      noteRecord({
        id: cloneId,
        createdBy: "agent:muon",
        chatId: chat,
        expiresAt: future,
      })
    );
    await graph.projectMemoryEdge(cloneId, sourceId, "cloned_from");
  });

  it("is returned by recall and search", async () => {
    const recalled = await graph.recallMemory({ module: MOD, chatId: chat });
    expect(recalled.map((note) => note.id)).toContain(cloneId);
    const found = await graph.searchMemory("idempotent charges", 50, { chatId: chat });
    expect(found.map((note) => note.id)).toContain(cloneId);
  });

  it("memoryNeighbors returns the ROOT NODE and its EDGES", async () => {
    const neighborhood = await graph.memoryNeighbors(cloneId, {
      hops: 1,
      relFilter: ["CLONED_FROM"],
      chatId: chat,
      crewVisible: false,
    });
    expect(neighborhood.nodes.map((node) => node.entityId)).toContain(cloneId);
    // The EDGE is the half a node-only assertion would miss: a hidden endpoint
    // silently drops the edge, so both endpoints must survive the traversal.
    expect(neighborhood.edges).toContainEqual({
      from: `note:${cloneId}`,
      to: `note:${sourceId}`,
      relation: "CLONED_FROM",
    });
    expect(neighborhood.nodes.map((node) => node.entityId)).toContain(sourceId);
  });

  it("memoryExplain returns it, and crew-visible TEXT is not withheld", async () => {
    const explained = await graph.memoryExplain(cloneId, {
      chatId: chat,
      crewVisible: true,
    });
    const node = explained.path.nodes.find((n) => n.entityId === cloneId);
    expect(node).toBeDefined();
    // Not yet due ⇒ the expiry redaction must NOT fire.
    expect(node?.text).toContain("idempotent");
  });

  it("the clause is never usable without its bound instant", () => {
    // Structural: the condition and `$now` come from one call and cannot be
    // separated, so no future call site can reintroduce an unbound comparison.
    const clause = memoryNotExpiredClause();
    expect(clause.condition).toContain(`$${MEMORY_EXPIRY_PARAM}`);
    expect(clause.params[MEMORY_EXPIRY_PARAM]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    // Even a garbage instant resolves to a real one rather than leaving it unbound.
    expect(memoryNotExpiredClause("not-a-date").params[MEMORY_EXPIRY_PARAM]).toMatch(
      /^\d{4}-/
    );
  });
});

describe("edge projection never loses an edge silently", () => {
  // Found while chasing the traversal report: `MATCH ... MERGE` writes NOTHING
  // when an endpoint is not yet projected, and never retries. The backend mirrors
  // an edge and its endpoints on INDEPENDENT fire-and-forget chains, so under load
  // the edge can lose the race and disappear until the next full reproject.
  let dir2: string;
  let store: MuonGraph;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), "muon-edge-race-"));
    store = new MuonGraph(join(dir2, "test.lbug"));
    await store.init();
    await store.projectMemoryNote(noteRecord({ id: "edge-a", createdBy: "agent:codex" }));
  });

  afterAll(async () => {
    await store.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("REPORTS a miss instead of pretending it wrote the edge", async () => {
    expect(
      await store.projectMemoryEdge("edge-a", "edge-not-yet-projected", "cloned_from")
    ).toBe(false);
    expect(await store.projectMemoryEdge("edge-a", "edge-a", "related")).toBe(true);
  });

  it("`awaitEndpoints` lands the edge when the endpoint arrives late", async () => {
    const lateId = "edge-late";
    setTimeout(() => {
      void store.projectMemoryNote(
        noteRecord({ id: lateId, createdBy: "agent:codex" })
      );
    }, 20);
    expect(
      await store.projectMemoryEdge("edge-a", lateId, "cloned_from", {
        awaitEndpoints: true,
      })
    ).toBe(true);
    const neighborhood = await store.memoryNeighbors("edge-a", {
      hops: 1,
      relFilter: ["CLONED_FROM"],
    });
    expect(neighborhood.edges).toContainEqual({
      from: "note:edge-a",
      to: `note:${lateId}`,
      relation: "CLONED_FROM",
    });
  });

  it("still gives up (never hangs, never throws) when the endpoint never arrives", async () => {
    expect(
      await store.projectMemoryEdge("edge-a", "edge-never", "cloned_from", {
        awaitEndpoints: true,
      })
    ).toBe(false);
  });
});

describe("R3 expiry — ledger drift canary", () => {
  it("the ledger's `isExpiredRow` rule is still the rule this mirror transcribes", () => {
    // A TEXT canary, deliberately: @muon/graph cannot import the backend, so the
    // only way to notice the source of truth moving is to watch it. If this fails,
    // re-read `isExpiredRow` / `ttlRedeemed` / `parsePrincipal` and update
    // packages/graph/src/memory-expiry.ts (BOTH the predicate and the cypher
    // clause) before touching this assertion.
    const ledgerPath = resolve(
      import.meta.dirname,
      "../../../backend/src/lib/memory-ledger.ts"
    );
    const source = readFileSync(ledgerPath, "utf8");
    for (const rule of [
      // isExpiredRow: deadline set AND already past …
      "if (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()) {",
      // … AND not redeemed.
      "return !ttlRedeemed({",
      'authorIsHuman: parsePrincipal(row.createdBy).kind === "human",',
      // ttlRedeemed: the three never-expire invariants.
      "args.authorIsHuman ||",
      "args.confirmed ||",
      'trustRank(args.trust) >= trustRank("high")',
      // parsePrincipal: trimmed input, `human:` prefix, bare ''/'human'.
      'const s = (raw ?? "").trim();',
      'if (prefix === "human") {',
      '} else if (s === "" || s.toLowerCase() === "human") {',
    ]) {
      expect(source).toContain(rule);
    }
  });
});
