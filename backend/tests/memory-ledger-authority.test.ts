import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { selectMemorySliceNotes } from "@muon/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// REAL SQLite + REAL LadybugDB + the REAL HTTP routes.
//
// memory-graph-mirror.test.ts pinned ONE direction of the ledger↔mirror
// boundary: a stale mirror may not HIDE a note the ledger says is live. This
// file pins the other direction, which was never closed:
//
//   a stale mirror may not SHOW a note the ledger says is dead, and it may not
//   describe a live note more favourably than the ledger does.
//
// Both are the same failure the founder cares about — an agent handed a wrong,
// stale, or over-vouched memory and acting on it confidently. `mirrorToGraph` is
// deliberately fire-and-forget (backend/src/lib/graph.ts), so every one of these
// divergences is a single dropped write away, and NOTHING on the read path
// consulted the ledger for status / confirmed / stale: `applyMemoryExpiry` read
// the authoritative row for exactly these ids and looked only at `expiresAt`.
//
// The fixtures simulate a dropped mirror write the same way the F3 test does:
// let the real mirror land, then re-project the PRE-mutation record so the graph
// holds exactly the state a lost write would have left behind.

const OPERATOR = "operator-token-authority";
const AGENT = "agent-token-authority";
const JOB_TOKEN = `job-authority-${"a".repeat(52)}`;
const WORKSPACE = process.cwd();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The graph mirror is fire-and-forget, so a graph assertion samples a chain
 *  nobody awaited. Poll for the eventual state rather than guessing a sleep. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

type WireNote = {
  id: string;
  text: string;
  confirmed: boolean;
  stale: boolean;
  status: string;
  trust: string;
  createdBy: string;
  confirmedBy: "human" | "orchestrator" | null;
};

type WireGate = {
  memories: WireNote[];
  warnings: { noteId: string; relatedNoteId: string }[];
  pendingProposals: { proposalNoteId: string; victimNoteId: string }[];
  /** D14 coverage. Present on the wire, so it is asserted on the wire. */
  coverage: {
    anchors: {
      modules: { requested: number; resolved: number };
      symbols: { requested: number; resolved: number };
      unreadable: number;
    };
    notes: { considered: number; admitted: number; surfaced: number };
    admittedBy: {
      humanConfirmed: number;
      crewVouched: number;
      trustFloor: number;
    };
    crewChat: boolean;
    emptyReason?: string;
  };
};

type WireTraversalNode = {
  entityId: string;
  type: string;
  text?: string;
};

async function preedit(
  body: Record<string, unknown>,
  token = OPERATOR
): Promise<WireGate> {
  const res = await app.inject({
    method: "POST",
    url: "/api/memory/preedit",
    headers: auth(token),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as WireGate;
}

async function recall(query: string, token = OPERATOR): Promise<WireNote[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/memory/recall?${query}`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { notes: WireNote[] }).notes;
}

async function search(q: string, token = OPERATOR): Promise<WireNote[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/memory/search?q=${encodeURIComponent(q)}`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { notes: WireNote[] }).notes;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-authority-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  await db.prisma.task.create({
    data: {
      id: "task-authority",
      title: "Authority task",
      description: "Task backing the authority job capability.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-authority",
    },
  });
  await db.prisma.dispatchJob.create({
    data: {
      id: "job-authority",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-authority",
      chatId: "chat-authority",
      brief: "Authority worker.",
      workspacePath: WORKSPACE,
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-authority",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
});

afterAll(async () => {
  await settle();
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("a stale graph mirror cannot SHOW a note the ledger retired", () => {
  it("keeps a human-REJECTED note off /recall and /search", async () => {
    const module = "backend/src/lib/authority-rejected.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Retry the upload three times before giving up on the shard.",
      modules: [module],
      createdBy: "codex",
    });
    await settle();
    const graph = graphLib.getGraph();
    // Capture the graph's PRE-reject projection (active, live).
    const live = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note !== null
    );
    expect(live?.status).toBe("active");

    // The operator rejects it. The LEDGER is now authoritative: retired.
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/memory/${ingested.note.id}`,
      headers: auth(OPERATOR),
      payload: { status: "rejected", principal: "human:alice" },
    });
    expect(rejected.statusCode).toBe(200);
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: ingested.note.id },
    });
    expect(row.status).toBe("rejected");
    expect(row.retiredAt).not.toBeNull();

    // Simulate the reject's mirror write never landing.
    await settle();
    await graph.projectMemoryNote(live!);
    expect((await graph.getMemoryNote(row.id))?.status).toBe("active");

    // The ledger says dead, so every governed read says dead.
    expect(
      (await recall(`module=${encodeURIComponent(module)}`)).map((n) => n.id)
    ).not.toContain(row.id);
    expect((await search("shard upload retry")).map((n) => n.id)).not.toContain(
      row.id
    );
  }, 30_000);

  it("keeps a hard-DELETED note's original text off /search", async () => {
    // The worst version: `deleteMemoryNote` tombstones the ledger text but its
    // `graph.deleteMemoryNote` is `.catch(() => undefined)`. A dropped delete
    // leaves the ORIGINAL prose readable through the mirror forever.
    const secret = "Rotate the staging credentials every Tuesday at midnight.";
    const ingested = await ledger.ingestMemoryNote({
      kind: "convention",
      text: secret,
      topics: ["authority-deleted"],
      createdBy: "codex",
    });
    await settle();
    const graph = graphLib.getGraph();
    const live = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note !== null
    );

    const deleted = await ledger.deleteMemoryNote(ingested.note.id, {
      tier: "operator",
      principal: "human",
    });
    expect(deleted.status).toBe("deleted");

    // Simulate the graph delete failing: the node is back, text and all.
    await graph.projectMemoryNote(live!);
    expect((await graph.getMemoryNote(ingested.note.id))?.text).toBe(secret);

    const hits = await search("staging credentials Tuesday");
    expect(hits.map((n) => n.id)).not.toContain(ingested.note.id);
    expect(JSON.stringify(hits)).not.toContain("Rotate the staging");
  }, 30_000);

  it("still serves a bitemporal as-of view of a note that has since been retired", async () => {
    // The narrowing above must NOT break "what did the brain believe at T" —
    // a retired note is exactly what an as-of read exists to return.
    const module = "backend/src/lib/authority-asof.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Ship the beacon poller behind an operator flag for now.",
      modules: [module],
      createdBy: "human:alice",
    });
    await settle();
    // An instant strictly AFTER the ingest and strictly BEFORE the reject, so
    // the note is inside its own valid-time window at T.
    const asOf = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ledger.updateMemoryNote(ingested.note.id, {
      status: "rejected",
      principal: "human:alice",
    });
    await settle();

    // Current view: gone.
    expect(
      (await recall(`module=${encodeURIComponent(module)}`)).map((n) => n.id)
    ).not.toContain(ingested.note.id);
    // As-of a moment when it was live: present.
    expect(
      (
        await recall(
          `module=${encodeURIComponent(module)}&asOf=${encodeURIComponent(asOf)}`
        )
      ).map((n) => n.id)
    ).toContain(ingested.note.id);
  }, 30_000);
});

describe("a stale graph mirror cannot over-state a note's provenance", () => {
  it("reports the LEDGER's confirmed flag, so a human REJECT is not read as a confirm", async () => {
    // The sharpest form of "an AI agent makes a mistake in memory fetching":
    // `selectMemorySliceNotes` puts `confirmed` notes straight into a worker's
    // brief under a heading that claims a human signed off. A dropped mirror
    // write on the un-confirm left the graph saying `confirmed: true` and every
    // recall response repeated it.
    const module = "backend/src/lib/authority-unconfirm.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Deploy straight to production without a canary stage.",
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();
    const graph = graphLib.getGraph();
    const blessed = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note?.confirmed === true
    );
    expect(blessed?.confirmed).toBe(true);

    // The human changes their mind. The ledger's latest HUMAN decision is now
    // `reject`, so `deriveConfirmedSet` no longer contains this note.
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: false,
      principal: "human:alice",
    });
    await settle();
    // ...and the un-confirm's mirror write is dropped.
    await graph.projectMemoryNote(blessed!);
    expect((await graph.getMemoryNote(ingested.note.id))?.confirmed).toBe(true);

    const notes = await recall(`module=${encodeURIComponent(module)}`);
    const wire = notes.find((note) => note.id === ingested.note.id);
    expect(wire).toBeDefined();
    expect(wire!.confirmed).toBe(false);
    expect(wire!.confirmedBy).toBeNull();
    // The consumer that actually steers an agent must now keep it out.
    expect(selectMemorySliceNotes(notes).map((n) => n.id)).not.toContain(
      ingested.note.id
    );
  }, 30_000);

  it("reports the LEDGER's stale flag so a suspect note is labelled, not dropped (D9-ii)", async () => {
    // `markModulesStale` writes the LEDGER only; the graph's `touchModules` is a
    // separate best-effort write. When the two diverge the wire must report the
    // LEDGER's answer. D9-ii keeps the note in the slice as demoted+|STALE —
    // dropping it would thin the brief of the note most likely to be relevant.
    const module = "backend/src/lib/authority-stale.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "The beacon table is keyed by shard id and sealed at write time.",
      modules: [module],
      createdBy: "human:alice",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    // The ledger goes suspect; the graph's touch is never mirrored.
    await ledger.markModulesStale([module], new Date(Date.now() + 1_000));
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: ingested.note.id },
    });
    expect(row.staleSince).not.toBeNull();
    expect(
      (await graphLib.getGraph().getMemoryNote(ingested.note.id))?.stale
    ).toBe(false);

    const notes = await recall(`module=${encodeURIComponent(module)}`);
    const wire = notes.find((note) => note.id === ingested.note.id);
    expect(wire).toBeDefined();
    expect(wire!.stale).toBe(true);
    expect(selectMemorySliceNotes(notes).map((n) => n.id)).toContain(
      ingested.note.id
    );
  }, 30_000);

  it("holds on the AGENT tier too, and the R5 filter sees the LEDGER's flags", async () => {
    // The tier that matters: this is the read an agent actually makes. Two
    // claims in one fixture — the agent does not receive a note the ledger
    // retired, and a `confirmed eq true` predicate is answered from the LEDGER.
    // The second matters because `governedMemoryView` runs the filter AFTER
    // reconciliation: a filter evaluated on the mirror's copy would answer a
    // question about the mirror, and the R5 grammar publishes `confirmed`,
    // `stale` and `status` as filterable fields.
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(true);
    const module = "backend/src/lib/authority-agent.ts";
    // ADR-0026: these bypass the route, so they must supply the partition the
    // route's derivation would have — the fixture DispatchJob carries
    // `workspacePath: WORKSPACE`, and a NULL-workspace note is the §8 residue, which
    // no AGENT read may see. The assertion below is about the LEDGER overruling the
    // MIRROR; leaving the notes unassigned would make it pass or fail on the
    // workspace fence instead, which is a different test.
    const kept = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Sequencer batches flush at four hundred rows or one second.",
      modules: [module],
      chatId: "chat-authority",
      workspacePath: WORKSPACE,
      createdBy: "agent:codex",
    });
    await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Sequencer batches flush at four hundred rows or one second.",
      modules: [module],
      chatId: "chat-authority",
      workspacePath: WORKSPACE,
      createdBy: "agent:claude-code",
    });
    const killed = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Sequencer batches were tuned to nine thousand rows, which failed.",
      modules: [module],
      chatId: "chat-authority",
      workspacePath: WORKSPACE,
      createdBy: "agent:codex",
    });
    await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Sequencer batches were tuned to nine thousand rows, which failed.",
      modules: [module],
      chatId: "chat-authority",
      workspacePath: WORKSPACE,
      createdBy: "agent:claude-code",
    });
    await settle();
    const graph = graphLib.getGraph();
    const liveKilled = await eventually(
      () => graph.getMemoryNote(killed.note.id),
      (note) => note !== null
    );
    await ledger.updateMemoryNote(killed.note.id, {
      status: "rejected",
      principal: "human:alice",
    });
    await settle();
    // The reject's mirror write is dropped — asserted, so this fixture can
    // never pass vacuously against a mirror that simply agreed.
    await graph.projectMemoryNote(liveKilled!);
    expect((await graph.getMemoryNote(killed.note.id))?.status).toBe("active");

    const agentNotes = await recall(
      `module=${encodeURIComponent(module)}&chatId=chat-authority`,
      JOB_TOKEN
    );
    const ids = agentNotes.map((note) => note.id);
    expect(ids).toContain(kept.note.id);
    expect(ids).not.toContain(killed.note.id);

    // Both survivors are orchestrator-vouched, never human-confirmed, so a
    // ledger-evaluated `confirmed eq true` returns nothing at all.
    const wire = agentNotes.find((note) => note.id === kept.note.id);
    expect(wire!.confirmed).toBe(false);
    expect(wire!.confirmedBy).toBe("orchestrator");
    const filtered = await recall(
      `module=${encodeURIComponent(module)}&chatId=chat-authority&filter=${encodeURIComponent(
        JSON.stringify({ field: "confirmed", op: "eq", value: true })
      )}`,
      JOB_TOKEN
    );
    expect(filtered).toEqual([]);
    await settings.setAutoConfirmAgentMemory(false);
  }, 30_000);

  it("carries the LEDGER's status / trust / createdBy, not the mirror's", async () => {
    // R5 publishes 20 filterable fields. Reconciling three of them left a hit
    // that reported ledger-sourced `confirmed`/`stale` NEXT TO a mirror-sourced
    // `status`/`trust`/`createdBy` that contradicted them — and the R5 filter,
    // which runs after reconciliation, then answered a question about the
    // MIRROR. `trust` is the sharpest: it is the destructive-write authority and
    // the never-expire dial, so a mirror that says "high" over a ledger "low"
    // hands an agent a note it should have been able to supersede.
    //
    // Exercised on the AS-OF path deliberately: it is the one read whose
    // candidate query does not itself require `n.status = 'active'`
    // (`visibilityClauses` swaps that clause for the bitemporal ones), so a
    // mirror-sourced `status` genuinely reaches the wire there.
    const module = "backend/src/lib/authority-fields.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "The shard rebalancer was tried with a two-minute lease and stalled.",
      modules: [module],
      trust: "low",
      createdBy: "agent:codex",
    });
    await settle();
    const graph = graphLib.getGraph();
    const live = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note !== null
    );
    const asOf = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ledger.updateMemoryNote(ingested.note.id, {
      status: "rejected",
      principal: "human:alice",
    });
    await settle();
    // One dropped mirror write, three lies at once.
    await graph.projectMemoryNote({
      ...live!,
      trust: "high",
      createdBy: "human:alice",
    });
    const mirrored = await graph.getMemoryNote(ingested.note.id);
    expect(mirrored?.trust).toBe("high");
    expect(mirrored?.status).toBe("active");

    const query = `module=${encodeURIComponent(module)}&asOf=${encodeURIComponent(asOf)}`;
    const wire = (await recall(query)).find(
      (note) => note.id === ingested.note.id
    );
    expect(wire).toBeDefined();
    expect(wire!.status).toBe("rejected");
    expect(wire!.trust).toBe("low");
    expect(wire!.createdBy).toBe("agent:codex");

    // ...and the filter is answered from those SAME ledger values.
    const byMirror = await recall(
      `${query}&filter=${encodeURIComponent(
        JSON.stringify({ field: "trust", op: "eq", value: "high" })
      )}`
    );
    expect(byMirror).toEqual([]);
    const byLedger = await recall(
      `${query}&filter=${encodeURIComponent(
        JSON.stringify({ field: "trust", op: "eq", value: "low" })
      )}`
    );
    expect(byLedger.map((note) => note.id)).toContain(ingested.note.id);
  }, 30_000);

  it("keeps a MIRROR-only stale mark, because the two staleness witnesses are independent", async () => {
    // The `stale` override REPLACED the mirror's flag, and the docstring called
    // that "narrower only". It is not: `markModulesStale` is best-effort at the
    // events route (`.catch(() => undefined)`) while `touchModules` still runs,
    // so the ordinary failure leaves mirror `stale: true` / ledger
    // `staleSince: null` — and `staleSince` is SET-ONCE, so the ledger never
    // recovers it. The wire must surface the mirror's suspect bit; D9-ii then
    // keeps the note in the slice as demoted+|STALE rather than dropping it.
    const module = "backend/src/lib/authority-stale-mirror.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Shard leases renew on the odd minute so the rebalancer never overlaps.",
      modules: [module],
      createdBy: "human:alice",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    // The event route's graph half lands; its ledger half is swallowed.
    await graphLib
      .getGraph()
      .touchModules([module], new Date(Date.now() + 1_000).toISOString());
    expect(
      (await graphLib.getGraph().getMemoryNote(ingested.note.id))?.stale
    ).toBe(true);
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: ingested.note.id },
    });
    expect(row.staleSince).toBeNull();

    const notes = await recall(`module=${encodeURIComponent(module)}`);
    const wire = notes.find((note) => note.id === ingested.note.id);
    expect(wire).toBeDefined();
    expect(wire!.stale).toBe(true);
    expect(selectMemorySliceNotes(notes).map((n) => n.id)).toContain(
      ingested.note.id
    );
  }, 30_000);

  it("does not blank an honest confirm when the ledger and the mirror agree", async () => {
    // The narrowing must not become a way to lose real vouches: a healthy
    // confirmed note still arrives confirmed, and still reaches a brief.
    const module = "backend/src/lib/authority-healthy.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Peer handoffs carry the originating lane key in their envelope.",
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    const notes = await recall(`module=${encodeURIComponent(module)}`);
    const wire = notes.find((note) => note.id === ingested.note.id);
    expect(wire).toBeDefined();
    expect(wire!.confirmed).toBe(true);
    expect(wire!.confirmedBy).toBe("human");
    expect(wire!.stale).toBe(false);
    expect(selectMemorySliceNotes(notes).map((n) => n.id)).toContain(
      ingested.note.id
    );
  }, 30_000);
});

// The HERO gate gets its own block because it is the read that matters most and
// the one every /recall guard above silently skipped: `POST /preedit` is what
// `memory_preedit` / `preflight_edit` hand an agent as "GOVERNED (human-
// confirmed) memory is trusted evidence", and it is the ONLY memory surface that
// admits verbatim TEXT on that basis.
describe("the hero gate answers from the ledger, exactly like every other read", () => {
  it("still serves a bitemporal as-of view of a note that has since been retired", async () => {
    // The /recall counterpart of this test existed; /preedit's did not, so the
    // liveness narrowing landed on the gate with NO `asOf` threaded and judged an
    // as-of answer with the CURRENT-set predicate. Every note retired since T
    // vanished from an as-of gate read — a silent, total loss of the bitemporal
    // view on the surface that shows a human what the brain believed.
    const module = "backend/src/lib/authority-gate-asof.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Route beacon writes through the primary shard until the split lands.",
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();
    // Strictly after the confirm and strictly before the reject.
    const asOf = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ledger.updateMemoryNote(ingested.note.id, {
      status: "rejected",
      principal: "human:alice",
    });
    await settle();

    // Current view: gone.
    expect((await preedit({ module })).memories.map((n) => n.id)).not.toContain(
      ingested.note.id
    );
    // As-of a moment when it was live: present, text and all.
    const asOfGate = await preedit({ module, asOf });
    expect(asOfGate.memories.map((n) => n.id)).toContain(ingested.note.id);
  }, 30_000);

  it("drops a note whose human confirm was WITHDRAWN, text and all", async () => {
    // The gate predicate (`n.confirmed = true`, muon-graph.ts) is MIRROR-sourced,
    // and a withdrawn confirm writes a `reject` Confirmation while leaving
    // `status`/`retiredAt` untouched — so the liveness narrowing keeps the row and
    // the mirror's `confirmed: true` rode out with the note's VERBATIM TEXT. This
    // is the founder's #1 failure in its sharpest form: an agent handed prose a
    // human explicitly un-blessed, under a heading that says a human signed off.
    const module = "backend/src/lib/authority-gate-unconfirm.ts";
    const secret = "Skip the idempotency key check on the payment retry path.";
    const ingested = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: secret,
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();
    const graph = graphLib.getGraph();
    const blessed = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note?.confirmed === true
    );

    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: false,
      principal: "human:alice",
    });
    await settle();
    // The un-confirm's mirror write is dropped — asserted, so this fixture can
    // never pass vacuously against a mirror that simply agreed.
    await graph.projectMemoryNote(blessed!);
    expect((await graph.getMemoryNote(ingested.note.id))?.confirmed).toBe(true);
    // The ledger still calls the row LIVE, which is exactly why liveness alone
    // never closed this.
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: ingested.note.id },
    });
    expect(row.status).toBe("active");
    expect(row.retiredAt).toBeNull();

    const gate = await preedit({ module });
    expect(gate.memories.map((n) => n.id)).not.toContain(ingested.note.id);
    expect(JSON.stringify(gate)).not.toContain("idempotency key");

    // D14 ON THE WIRE, on the one response shape that can go empty for a reason
    // no count inside the gate library knows about. The library admitted this note
    // (the mirror still says confirmed); the ROUTE's ledger pass dropped it. So the
    // coverage the route returns must be re-tallied, not passed through:
    //   - `admitted` follows the ledger, not the mirror;
    //   - `considered` still says the anchor HELD something, so this is not
    //     reported as an empty coordinate layer;
    //   - and an `emptyReason` is present at all, which is the silence D14 closes.
    expect(gate.coverage.notes.admitted).toBe(0);
    expect(gate.coverage.notes.surfaced).toBe(0);
    expect(gate.coverage.admittedBy).toEqual({
      humanConfirmed: 0,
      crewVouched: 0,
      trustFloor: 0,
    });
    expect(gate.coverage.anchors.modules.resolved).toBe(1);
    expect(gate.coverage.notes.considered).toBeGreaterThan(0);
    expect(gate.coverage.crewChat).toBe(false);
    expect(gate.coverage.emptyReason).toBe("withheld_no_crew_chat");
    // Counts only — the withheld note's id must not ride the coverage block.
    expect(JSON.stringify(gate.coverage)).not.toContain(ingested.note.id);
  }, 30_000);

  it("reconciles the operator's showExpired view too", async () => {
    // `showExpired` opts out of R3 hygiene, nothing else. The early return took
    // the whole reconciliation with it, so the ONE surface a human uses to
    // adjudicate memory was the one that showed the mirror's raw answer.
    const module = "backend/src/lib/authority-gate-showexpired.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Retire the legacy beacon poller once the split lands.",
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();
    const graph = graphLib.getGraph();
    const live = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note?.confirmed === true
    );
    await ledger.updateMemoryNote(ingested.note.id, {
      status: "rejected",
      principal: "human:alice",
    });
    await settle();
    await graph.projectMemoryNote(live!);
    expect((await graph.getMemoryNote(ingested.note.id))?.status).toBe("active");

    const gate = await preedit({ module, showExpired: true });
    expect(gate.memories.map((n) => n.id)).not.toContain(ingested.note.id);
  }, 30_000);

  it("still hands the gate an honest confirmed note, with its text", async () => {
    // The narrowing must not become a way to lose the hero's whole point.
    const module = "backend/src/lib/authority-gate-healthy.ts";
    const text = "Beacon writes carry the originating shard id in their envelope.";
    const ingested = await ledger.ingestMemoryNote({
      kind: "decision",
      text,
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    const gate = await preedit({ module });
    const wire = gate.memories.find((note) => note.id === ingested.note.id);
    expect(wire).toBeDefined();
    expect(wire!.confirmed).toBe(true);
    expect(wire!.confirmedBy).toBe("human");
    expect(wire!.text).toBe(text);
    // D14: the honest NON-empty case — a human-confirmed admission, no reason.
    expect(gate.coverage.notes.admitted).toBe(1);
    expect(gate.coverage.notes.surfaced).toBe(1);
    expect(gate.coverage.admittedBy.humanConfirmed).toBe(1);
    expect(gate.coverage.emptyReason).toBeUndefined();
  }, 30_000);
});

describe("a stale graph mirror cannot serve a destroyed note's text", () => {
  it("withholds a hard-DELETED note's text from /neighbors and /explain", async () => {
    // `redactExpiredNodes` stripped text for the EXPIRED set only, and a
    // tombstoned row is not expired: `tombstoneMemoryRow` blanks `text`, sets
    // `status:"rejected"` + `retiredAt`, and leaves `expiresAt` NULL. So the id
    // never entered the strip set and the mirror's copy of the ORIGINAL prose was
    // served — of a note the operator ordered destroyed. Agent-reachable:
    // `memoryTraversalNode` serves text when the note is confirmed.
    const secret = "The break-glass root password is stored in the ops vault.";
    const ingested = await ledger.ingestMemoryNote({
      kind: "convention",
      text: secret,
      modules: ["backend/src/lib/authority-destroyed.ts"],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();
    const graph = graphLib.getGraph();
    const blessed = await eventually(
      () => graph.getMemoryNote(ingested.note.id),
      (note) => note?.confirmed === true
    );

    const deleted = await ledger.deleteMemoryNote(ingested.note.id, {
      tier: "operator",
      principal: "human",
    });
    expect(deleted.status).toBe("deleted");
    // Simulate the graph delete failing: the node is back, text and all.
    await graph.projectMemoryNote(blessed!);
    expect((await graph.getMemoryNote(ingested.note.id))?.text).toBe(secret);

    const neighbors = await app.inject({
      method: "GET",
      url: `/api/memory/neighbors/${encodeURIComponent(`note:${ingested.note.id}`)}`,
      headers: auth(OPERATOR),
    });
    expect(neighbors.statusCode).toBe(200);
    expect(neighbors.body).not.toContain("break-glass");
    // The NODE itself must stay — a provenance walk that drops the node it was
    // asked to explain is a different bug. Coordinates only, no text.
    const node = (
      neighbors.json() as { nodes: WireTraversalNode[] }
    ).nodes.find((entry) => entry.entityId === ingested.note.id);
    expect(node).toBeDefined();
    expect(node!.text).toBeUndefined();

    const explain = await app.inject({
      method: "GET",
      url: `/api/memory/explain/${encodeURIComponent(ingested.note.id)}`,
      headers: auth(OPERATOR),
    });
    expect(explain.statusCode).toBe(200);
    expect(explain.body).not.toContain("break-glass");
  }, 30_000);

  it("keeps serving a LIVE note's text on the provenance walk", async () => {
    // The strip set is the ledger's liveness verdict, so a healthy note is
    // untouched. Without this, "strip everything" would pass the test above.
    const text = "Beacon shards are numbered from one, never from zero.";
    const ingested = await ledger.ingestMemoryNote({
      kind: "convention",
      text,
      modules: ["backend/src/lib/authority-live-walk.ts"],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    const neighbors = await app.inject({
      method: "GET",
      url: `/api/memory/neighbors/${encodeURIComponent(`note:${ingested.note.id}`)}`,
      headers: auth(OPERATOR),
    });
    expect(neighbors.statusCode).toBe(200);
    const node = (
      neighbors.json() as { nodes: WireTraversalNode[] }
    ).nodes.find((entry) => entry.entityId === ingested.note.id);
    expect(node?.text).toBe(text);
  }, 30_000);
});
