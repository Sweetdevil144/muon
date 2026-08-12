import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// REAL SQLite + REAL LadybugDB + the REAL HTTP routes. Two findings live here,
// and both are about the boundary between the durable ledger and its best-effort
// graph mirror:
//
//   F3 — the hot read paths delegated the PRIMARY expiry decision to the graph,
//        and the ledger post-filter can only ever REMOVE rows. One failed mirror
//        write on a human confirm and a human-adjudicated note became invisible
//        to every recall path while the ledger still called it live, with no
//        operator-visible symptom. The graph may be stricter as a transient
//        optimization; it may never be the deciding authority.
//   F2 — `trust` was body-supplied and never tier-clamped, so an agent made its
//        own notes permanent (and gained supersede authority) by declaring
//        `trust:"high"`. Proven END TO END here over the real route with a real
//        job capability, because that is how it was found.

const OPERATOR = "operator-token-mirror";
const AGENT = "agent-token-mirror";
const JOB_TOKEN = `job-mirror-${"m".repeat(52)}`;
const WORKSPACE = process.cwd();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The graph mirror is fire-and-forget, so a graph assertion samples a chain
 *  nobody awaited. Poll for the eventual state rather than guessing a sleep
 *  long enough for three LadybugDB writes on a contended host. */
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

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-mirror-"));
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
      id: "task-mirror",
      title: "Mirror task",
      description: "Task backing the mirror job capability.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-mirror",
    },
  });
  await db.prisma.dispatchJob.create({
    data: {
      id: "job-mirror",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-mirror",
      chatId: "chat-mirror",
      brief: "Mirror worker.",
      workspacePath: WORKSPACE,
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-mirror",
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

describe("F3 — a stale graph mirror cannot hide a note the ledger says is live", () => {
  it("keeps a human-confirmed note on /recall and /search after a FAILED mirror write", async () => {
    const module = "backend/src/lib/mirror-fixture.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Never widen the confirmed-only gate to reach this fixture.",
      modules: [module],
      createdBy: "codex",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await settle();

    // The LEDGER is authoritative and says: confirmed, permanent, live.
    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: ingested.note.id },
    });
    expect(row.expiresAt).toBeNull();
    const ledgerView = await ledger.applyMemoryExpiry([{ id: row.id }]);
    expect(ledgerView.map((note) => note.id)).toEqual([row.id]);

    // Simulate the confirm's mirror write never landing: the graph still holds
    // the PRE-confirm projection — unconfirmed, and stamped with a deadline that
    // has since passed. This is exactly the divergence a dropped best-effort
    // write produces, and it is the state the reviewer reproduced.
    //
    // Wait for the confirm's own mirror to LAND first, so the fixture cannot be
    // overwritten by a chain still in flight (which would make this pass
    // vacuously, against a healthy graph).
    const graph = graphLib.getGraph();
    const stale = await eventually(
      () => graph.getMemoryNote(row.id),
      (note) => note?.confirmed === true
    );
    expect(stale?.confirmed).toBe(true);
    await graph.projectMemoryNote({
      ...stale!,
      confirmed: false,
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
    });

    // The graph, asked its own way, now hides it — the mirror really is stale.
    const graphDefault = await graph.recallMemory({ module });
    expect(graphDefault.map((note) => note.id)).not.toContain(row.id);

    // ...and the governed READ paths still return it, because the LEDGER
    // decides hidden-ness. Pre-fix both of these came back empty.
    const recall = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(module)}`,
      headers: auth(OPERATOR),
    });
    expect(recall.statusCode).toBe(200);
    expect(
      (recall.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).toContain(row.id);

    const search = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=confirmed-only%20gate%20fixture",
      headers: auth(OPERATOR),
    });
    expect(search.statusCode).toBe(200);
    expect(
      (search.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).toContain(row.id);
  }, 30_000);

  it("still hides a genuinely expired note, so the ledger narrowed and did not fail open", async () => {
    const module = "backend/src/lib/mirror-expired.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "An unreviewed guess that is past its deadline.",
      modules: [module],
      createdBy: "codex",
    });
    await db.prisma.memoryNote.update({
      where: { id: ingested.note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    await settle();

    const hidden = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(module)}`,
      headers: auth(OPERATOR),
    });
    expect(
      (hidden.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).not.toContain(ingested.note.id);

    // The operator opt-in still reveals it (this is the human review queue).
    const shown = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(module)}&showExpired=true`,
      headers: auth(OPERATOR),
    });
    expect(
      (shown.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).toContain(ingested.note.id);
  });

  it("does not let an AGENT-tier caller reveal expired memory through the widened graph read", async () => {
    // The graph is now asked for candidates without its expiry clause, so the
    // tier gate on `showExpired` has to hold entirely in the ledger post-filter.
    const module = "backend/src/lib/mirror-agent.ts";
    const ingested = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "An expired same-chat guess an agent must not read back.",
      modules: [module],
      chatId: "chat-mirror",
      createdBy: "codex",
    });
    await db.prisma.memoryNote.update({
      where: { id: ingested.note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    await settle();

    const res = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(module)}&showExpired=true&chatId=chat-mirror`,
      headers: auth(JOB_TOKEN),
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).not.toContain(ingested.note.id);
  });
});

describe("F3 (edges) — a live-mirror edge waits for its own endpoints", () => {
  it("asks for the bounded re-attempt on every live edge, and lands the CLONED_FROM link", async () => {
    // `projectMemoryEdge` is a `MATCH (a),(b) MERGE (a)->(b)`: with an endpoint
    // not yet projected it writes nothing, reports nothing and never retries, so
    // the link is lost until a full reproject. The endpoint and the edge ride
    // SEPARATE fire-and-forget mirror chains, so under load the edge loses the
    // race — the same silent-divergence class as F3 itself, one level down.
    const graph = graphLib.getGraph();
    const projectEdge = vi.spyOn(graph, "projectMemoryEdge");
    try {
      const source = await ledger.ingestMemoryNote({
        kind: "decision",
        text: "A source note whose clone edge must not lose the race.",
        topics: ["mirror-clone"],
        createdBy: "codex",
      });
      const cloned = await ledger.cloneMemoryNote(source.note.id, {
        tier: "operator",
        principal: "human:alice",
      });
      expect(cloned.status).toBe("cloned");
      const cloneId = cloned.status === "cloned" ? cloned.note.id : "";
      const neighbourhood = await eventually(
        () => graph.memoryNeighbors(`note:${cloneId}`, { hops: 1, limit: 20 }),
        (result) => result.edges.length > 0
      );

      expect(projectEdge).toHaveBeenCalledWith(
        cloneId,
        source.note.id,
        "cloned_from",
        { awaitEndpoints: true }
      );
      expect(neighbourhood.edges).toContainEqual({
        from: `note:${cloneId}`,
        to: `note:${source.note.id}`,
        relation: "CLONED_FROM",
      });
    } finally {
      projectEdge.mockRestore();
    }
  }, 30_000);

  it("cannot be resurrected by an in-flight mirror after a hard delete", async () => {
    // The delete awaits `graph.deleteMemoryNote`, but the note's OWN ingest
    // mirror is an unawaited chain: if it lands afterwards it re-MERGEs the node
    // and puts a deleted note's TEXT back into the projection until the next
    // reproject. Deleting immediately after ingest is the tightest version of
    // that window, so this asserts the drain, not a sleep.
    const created = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "A note deleted while its own projection is still in flight.",
      topics: ["mirror-resurrect"],
      chatId: "chat-mirror",
      createdBy: "agent:codex",
    });
    const deleted = await ledger.deleteMemoryNote(created.note.id, {
      tier: "operator",
      principal: "human",
    });
    expect(deleted.status).toBe("deleted");
    expect(
      await graphLib.getGraph().getMemoryNote(created.note.id)
    ).toBeNull();
    // ...and it stays gone once every chain has certainly finished.
    await settle();
    expect(
      await graphLib.getGraph().getMemoryNote(created.note.id)
    ).toBeNull();
  }, 30_000);

  it("does NOT pay the re-attempt on the reproject path", async () => {
    // `projectLedgerToGraph` projects every node before any edge in one
    // sequential pass, and walks edges whose endpoints may be legitimately
    // tombstoned, so a bounded retry there is pure cost.
    const graph = graphLib.getGraph();
    const projectEdge = vi.spyOn(graph, "projectMemoryEdge");
    try {
      await ledger.projectLedgerToGraph(graph);
      expect(projectEdge).toHaveBeenCalled();
      for (const call of projectEdge.mock.calls) {
        expect(call[3]).toBeUndefined();
      }
    } finally {
      projectEdge.mockRestore();
    }
  });
});

describe("F3 — a failed mirror write is LOUD", () => {
  it("logs every failure and raises an operator-visible event", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      graphLib.mirrorToGraph(async () => {
        throw new Error("mirror probe alpha");
      }, "test.alpha");
      graphLib.mirrorToGraph(async () => {
        throw new Error("mirror probe alpha");
      }, "test.alpha");
      await settle();

      // Per FAILURE, not once per process: the old `warned` latch meant the
      // second (and every later) failure was completely silent.
      const lines = logged.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("test.alpha"));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("mirror probe alpha");

      const events = await db.prisma.event.findMany({
        where: { kind: "memory.graph_mirror_failed" },
      });
      const alpha = events.filter(
        (event) => (event.metadata as { op?: string }).op === "test.alpha"
      );
      // Coalesced to one row per label per window, so a persistently broken
      // store signals without turning every memory write into an audit row.
      expect(alpha).toHaveLength(1);
      expect(alpha[0]!.message).toContain("mirror probe alpha");
      // Coordinates only: the label and the driver's message, never note text.
      expect(alpha[0]!.laneId).toBe("muon");

      // A DIFFERENT operation is never suppressed by another one's window.
      graphLib.mirrorToGraph(async () => {
        throw new Error("mirror probe beta");
      }, "test.beta");
      await settle();
      const after = await db.prisma.event.findMany({
        where: { kind: "memory.graph_mirror_failed" },
      });
      expect(
        after.filter(
          (event) => (event.metadata as { op?: string }).op === "test.beta"
        )
      ).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("F2 — an agent cannot buy permanence by declaring trust:'high'", () => {
  async function post(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload,
    });
    expect(res.statusCode).toBe(201);
    const { note } = res.json() as { note: { id: string } };
    return db.prisma.memoryNote.findUniqueOrThrow({ where: { id: note.id } });
  }

  // P0-2: permanence now has a SECOND, legitimate source — the orchestrator's
  // vouch under the default posture. The invariant under test is unchanged and
  // is asserted on both sides of that posture: a declared `trust:"high"` buys
  // an agent NOTHING, so the two notes stay indistinguishable either way.
  it("lands at the agent ceiling, indistinguishable from an omitted trust (strict review: both keep a TTL)", async () => {
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(false);
    const omitted = await post({
      kind: "decision",
      text: "An agent note that declares no trust at all.",
      topics: ["mirror-trust-a"],
      createdBy: "codex",
    });
    const claimed = await post({
      kind: "decision",
      text: "An agent note that declares itself high trust.",
      topics: ["mirror-trust-b"],
      createdBy: "codex",
      trust: "high",
    });

    expect(omitted.trust).toBe("medium");
    expect(omitted.expiresAt).not.toBeNull();
    // Pre-fix: trust=high and expiresAt=null, i.e. a note the writer made
    // permanent for itself, and one the destructive-write gate then treats as
    // authorized to supersede unconfirmed peers.
    expect(claimed.trust).toBe("medium");
    expect(claimed.expiresAt).not.toBeNull();
  });

  it("still cannot buy trust when the ORCHESTRATOR grants permanence (default posture)", async () => {
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(true);
    // Deliberately unlike the pair above: every note in this file shares the
    // job's task anchor, so near-identical prose would be compared (and
    // superseded) by the similarity pass rather than landing as a fresh row.
    const omitted = await post({
      kind: "decision",
      text: "Retry backoff doubles from two hundred milliseconds per attempt.",
      topics: ["mirror-vouch-c"],
      createdBy: "codex",
    });
    const claimed = await post({
      kind: "decision",
      text: "Shard rebalancing pauses while a snapshot upload is in flight.",
      topics: ["mirror-vouch-d"],
      createdBy: "codex",
      trust: "high",
    });
    for (const input of [
      {
        text: "Retry backoff doubles from two hundred milliseconds per attempt.",
        trust: undefined,
      },
      {
        text: "Shard rebalancing pauses while a snapshot upload is in flight.",
        trust: "high" as const,
      },
    ]) {
      await ledger.ingestMemoryNote({
        kind: "decision",
        text: input.text,
        taskId: "task-mirror",
        chatId: "chat-mirror",
        workspacePath: WORKSPACE,
        createdBy: "agent:job:job-mirror-peer",
        ...(input.trust ? { trust: input.trust } : {}),
      });
    }
    const [omittedAfter, claimedAfter] = await Promise.all([
      db.prisma.memoryNote.findUniqueOrThrow({ where: { id: omitted.id } }),
      db.prisma.memoryNote.findUniqueOrThrow({ where: { id: claimed.id } }),
    ]);
    // Permanence comes from two-principal corroboration, applied identically to
    // both — never from what either writer declared about itself.
    expect(omittedAfter.expiresAt).toBeNull();
    expect(claimedAfter.expiresAt).toBeNull();
    // The escalation the test exists for is still refused: trust stays clamped,
    // so the destructive-write gate still treats this note as a medium peer.
    expect(omittedAfter.trust).toBe("medium");
    expect(claimedAfter.trust).toBe("medium");
    await settings.setAutoConfirmAgentMemory(false);
  });

  it("still honours an honest LOWER declaration", async () => {
    const low = await post({
      kind: "attempt",
      text: "An agent note that declares itself low trust.",
      topics: ["mirror-trust-c"],
      createdBy: "codex",
      trust: "low",
    });
    expect(low.trust).toBe("low");
  });
});
