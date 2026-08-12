import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryNoteRecord, MuonGraph } from "@muon/graph";

// D4 (retrieval is CONJUNCTIVE) + D6 (ONE batched anchor query), at the two layers
// the graph package cannot reach: `preEditContext` — the hero gate that was paying
// ≥257 store round trips per read — and the routes that are its façades.
//
// REAL SQLite + REAL LadybugDB + the REAL HTTP routes, because the round-trip
// claim is about what the store is actually asked and a mocked graph cannot be
// asked anything.

const OPERATOR = "operator-token-anchorbatch";
const AGENT = "agent-token-anchorbatch";
const JOB_TOKEN = `job-anchorbatch-${"b".repeat(48)}`;
const WORKSPACE = process.cwd();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** 128 anchor modules — `MAX_ANCHOR_MODULES`, the widest radius the gate accepts,
 *  and the count the decision's 265.8 ms fan-out figure was measured at. */
const MODULES = Array.from(
  { length: 128 },
  (_, index) => `src/batch/mod${String(index).padStart(3, "0")}.ts`
);
const TARGET = MODULES[0]!;
const SYMBOL = `${TARGET}#chargeOnce`;

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let preedit: typeof import("../src/lib/preedit.js");
let app: FastifyInstance;
const confirmedIds: string[] = [];

/** Count what the STORE is asked. `execute` is private on MuonGraph, so the spy is
 *  installed on the live INSTANCE — it counts the real statements rather than a
 *  stand-in, which is the whole point: a test that only inspects the RESULT cannot
 *  tell whether the fan-out is still there. */
function countingSpy(target: MuonGraph): {
  calls: string[];
  restore: () => void;
} {
  const holder = target as unknown as {
    execute: (statement: string, params: unknown) => Promise<unknown[]>;
  };
  const real = holder.execute.bind(target);
  const calls: string[] = [];
  holder.execute = async (statement, params) => {
    calls.push(statement);
    return real(statement, params);
  };
  return {
    calls,
    restore: () => {
      delete (target as unknown as { execute?: unknown }).execute;
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-anchorbatch-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  preedit = await import("../src/lib/preedit.js");
  await db.ensureSchema();

  await db.prisma.task.create({
    data: {
      id: "task-anchorbatch",
      title: "Anchor batch task",
      description: "Task backing the batched-anchor job capability.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-anchorbatch",
    },
  });
  await db.prisma.dispatchJob.create({
    data: {
      id: "job-anchorbatch",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-anchorbatch",
      chatId: "chat-anchorbatch",
      brief: "Batched anchor worker.",
      workspacePath: WORKSPACE,
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-anchorbatch",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
  });

  // One human-confirmed note per anchor module, so a 128-anchor gate read has 128
  // notes to find and the fan-out it replaces had 128 non-empty results.
  for (const [index, module] of MODULES.entries()) {
    const ingested = await ledger.ingestMemoryNote({
      kind: index % 2 === 0 ? "decision" : "convention",
      text: `Module ${index} charges idempotently by request key.`,
      modules: [module],
      createdBy: "human",
    });
    await ledger.updateMemoryNote(ingested.note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    confirmedIds.push(ingested.note.id);
  }
  // A symbol-anchored note, so the second namespace is real on both surfaces.
  const symbolNote = await ledger.ingestMemoryNote({
    kind: "constraint",
    text: "chargeOnce must never retry without the request key.",
    modules: [TARGET],
    symbols: [SYMBOL],
    createdBy: "human",
  });
  await ledger.updateMemoryNote(symbolNote.note.id, {
    confirmed: true,
    principal: "human:alice",
  });
  confirmedIds.push(symbolNote.note.id);

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await settle();
  await graphLib.awaitGraphMirrors();
  // 129 ledger ingests + confirms + their graph mirrors is genuinely more than
  // vitest's 10 s default hook budget on a contended host — it timed out
  // intermittently, which reads as a flake and is really a fixture cost. Stated
  // explicitly rather than trimmed, because the 128-anchor corpus IS the test:
  // `MAX_ANCHOR_MODULES` is the width the fan-out was measured at.
}, 180_000);

afterAll(async () => {
  await settle();
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("D6 — the hero gate costs the same at 1 anchor and at 128", () => {
  it("preEditContext store round trips are FLAT in anchor count (counted, not assumed)", async () => {
    const graph = graphLib.getGraph();
    const spy = countingSpy(graph);
    try {
      spy.calls.length = 0;
      const one = await preedit.preEditContext(graph, { module: TARGET });
      const oneCalls = spy.calls.length;

      spy.calls.length = 0;
      const many = await preedit.preEditContext(
        graph,
        { module: TARGET },
        { blastRadius: { modules: MODULES.slice(1), source: "provided" } }
      );
      const manyCalls = spy.calls.length;

      // Both reads found notes, so this is not two empty gates agreeing.
      expect(one.memories.length).toBeGreaterThan(0);
      expect(many.memories.length).toBeGreaterThanOrEqual(128);
      expect(many.blastRadius.modules.length).toBe(128);

      // THE CLAIM. Before D6 this difference was ~2 × 127 anchor recalls; the
      // remaining spread is the per-SURFACED-NOTE edge lookups
      // (`contradictionsOf` + `proposedSupersedesOf`), which are a function of how
      // many notes came back, not of how many anchors were asked about — that is
      // D4's other fan-out and it is explicitly NOT in this decision's scope.
      const anchorQueries = (calls: string[]) =>
        calls.filter(
          (statement) =>
            statement.includes("list_contains($anchorModules") ||
            statement.includes("list_contains($anchorSymbols")
        ).length;
      // THE PROPERTY IS FLATNESS, not a magic number, and this test used to assert
      // the number. D6's exit condition is "one round trip per gate read REGARDLESS
      // OF ANCHOR COUNT" — bounded by a constant, where the fan-out was O(anchors).
      //
      // The constant is now 4 with neighbours: gated-broad, ungated-broad, the
      // exact-target starvation guard, and the path-triggered standing arm. The
      // injection arm is independently kind-filtered so a hot decision set cannot
      // starve a must-know constraint, but it remains ONE batched query regardless
      // of whether the radius names 1 module or 128.
      const manyAnchorQueries = anchorQueries(spy.calls);
      expect(manyAnchorQueries).toBeLessThanOrEqual(4);

      spy.calls.length = 0;
      await preedit.preEditContext(graph, { module: TARGET });
      const oneAnchorQueries = anchorQueries(spy.calls);
      // 128 anchors cost AT MOST ONE query more than 1 anchor — the exact-target
      // arm. The fan-out cost 127 more. That difference is the whole decision.
      expect(manyAnchorQueries - oneAnchorQueries).toBeLessThanOrEqual(1);
      expect(oneAnchorQueries).toBeGreaterThan(0);
      expect(oneCalls).toBeGreaterThan(0);
      expect(manyCalls).toBeGreaterThan(0);
    } finally {
      spy.restore();
    }
  });

  it("the same is true with a SYMBOL target: one query per namespace, not one per anchor", async () => {
    const graph = graphLib.getGraph();
    const spy = countingSpy(graph);
    try {
      spy.calls.length = 0;
      await preedit.preEditContext(
        graph,
        { module: TARGET, symbol: SYMBOL },
        { blastRadius: { modules: MODULES.slice(1), source: "provided" } }
      );
      const anchorQueries = spy.calls.filter(
        (statement) =>
          statement.includes("list_contains($anchorModules") ||
          statement.includes("list_contains($anchorSymbols")
      );
      // gated (modules ∪ symbols = 2 arms) + ungated modules (1) + ungated
      // symbols (1) + exact-target module (1) + path-triggered standing module
      // and symbol arms (2) = 7, and NONE scale with the 128 anchors.
      // Same reasoning as the module test above: bounded by a small constant, not
      // by anchor count. The symbol target adds its own namespace arm, and the
      // exact-target module arm may add one more.
      expect(anchorQueries.length).toBeLessThanOrEqual(7);
      expect(anchorQueries.length).toBeGreaterThanOrEqual(4);
    } finally {
      spy.restore();
    }
  });
});

describe("D6 — the batched gate returns the SAME notes the fan-out did", () => {
  /** The per-anchor fan-out `preEditContext` used to run, rebuilt here as the
   *  differential oracle: one governed recall per anchor module plus one per exact
   *  symbol, merged by id — literally the replaced code. */
  async function fanOutOracle(
    graph: MuonGraph,
    modules: string[],
    symbols: string[]
  ): Promise<string[]> {
    const byId = new Map<string, MemoryNoteRecord>();
    for (const module of modules) {
      for (const note of await graph.recallForGate({ module }, { limit: 50 })) {
        byId.set(note.id, note);
      }
    }
    for (const symbol of symbols) {
      for (const note of await graph.recallForGate({ symbol }, { limit: 50 })) {
        byId.set(note.id, note);
      }
    }
    return [...byId.keys()].sort();
  }

  it("128 modules + 1 symbol: the gate's memories are the fan-out's union, exactly", async () => {
    const graph = graphLib.getGraph();
    const ctx = await preedit.preEditContext(
      graph,
      { module: TARGET, symbol: SYMBOL },
      { blastRadius: { modules: MODULES.slice(1), source: "provided" } }
    );
    expect(ctx.memories.map((m) => m.id).sort()).toEqual(
      await fanOutOracle(graph, ctx.blastRadius.modules, [SYMBOL])
    );
    expect(ctx.memories.length).toBe(confirmedIds.length);
  });

  it("coverage still counts anchors PER ANCHOR, derived from the notes' own arrays", async () => {
    const graph = graphLib.getGraph();
    const ctx = await preedit.preEditContext(
      graph,
      { module: TARGET, symbol: SYMBOL },
      { blastRadius: { modules: MODULES.slice(1), source: "provided" } }
    );
    // Every one of the 128 anchors carries a note, so every one RESOLVED — the
    // number the per-anchor fan-out's array index used to answer.
    expect(ctx.coverage.anchors.modules).toEqual({
      requested: 128,
      resolved: 128,
    });
    expect(ctx.coverage.anchors.symbols).toEqual({ requested: 1, resolved: 1 });
    expect(ctx.coverage.anchors.unreadable).toBe(0);
    expect(ctx.coverage.emptyReason).toBeUndefined();
  });

  it("an anchor NOTHING carries is still reported UNRESOLVED, not silently rolled into the batch", async () => {
    const graph = graphLib.getGraph();
    const ctx = await preedit.preEditContext(
      graph,
      { module: TARGET },
      {
        blastRadius: {
          modules: ["src/batch/barren-a.ts", "src/batch/barren-b.ts"],
          source: "provided",
        },
      }
    );
    expect(ctx.coverage.anchors.modules).toEqual({ requested: 3, resolved: 1 });
  });
});

describe("D4 — `GET /api/memory/recall` finally exposes `symbol`", () => {
  it("returns the symbol-anchored note, and only it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/recall?symbol=${encodeURIComponent(SYMBOL)}`,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    const notes = (res.json() as { notes: { id: string; symbols: string[] }[] })
      .notes;
    expect(notes.length).toBe(1);
    expect(notes[0]!.symbols).toContain(SYMBOL);
  });

  it("composes with `module`: both coordinates narrow the same read", async () => {
    const both = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(
        TARGET
      )}&symbol=${encodeURIComponent(SYMBOL)}`,
      headers: auth(OPERATOR),
    });
    expect(both.statusCode).toBe(200);
    const ids = (both.json() as { notes: { id: string }[] }).notes.map(
      (n) => n.id
    );
    // The union of the two namespaces, as the graph's anchor arms define it: the
    // module's note AND the symbol's note.
    expect(ids.length).toBe(2);
  });

  it("a symbol nothing carries returns nothing (and does not fall back to everything)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/recall?symbol=${encodeURIComponent(
        "src/nope/none.ts#ghost"
      )}`,
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { notes: unknown[] }).notes).toEqual([]);
  });

  it("is fenced for an AGENT exactly as `module` is (the workspace/chat partition still applies)", async () => {
    // The agent's job capability carries `chatId: chat-anchorbatch`; every fixture
    // note above is operator-authored with NO chat, so an agent read sees none of
    // them — the same answer `module` gives, which is the point: `symbol` is a
    // coordinate, not an authority.
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/recall?symbol=${encodeURIComponent(SYMBOL)}`,
      headers: auth(JOB_TOKEN),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { notes: unknown[] }).notes).toEqual([]);
  });
});

describe("D6 — the completeness reconciler, on demand and at boot", () => {
  it("POST /api/memory/reconcile-anchors reports the invariant and is operator-only", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/memory/reconcile-anchors",
      headers: auth(JOB_TOKEN),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: "/api/memory/reconcile-anchors",
      headers: auth(OPERATOR),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      modules: { edges: number; expected: number; orphanEdges: number };
      complete: boolean;
      repairedNotes: number;
    };
    expect(report.complete).toBe(true);
    expect(report.modules.edges).toBe(report.modules.expected);
    expect(report.modules.edges).toBeGreaterThan(0);
    expect(report.repairedNotes).toBe(0);
  });

  it("detects a dropped ANCHORED_TO write, and `{repair:true}` restores the note to the gate", async () => {
    const graph = graphLib.getGraph();
    const victim = confirmedIds[5]!;
    const before = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(MODULES[5]!)}`,
      headers: auth(OPERATOR),
    });
    expect(
      (before.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).toContain(victim);

    await (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute(
      `MATCH (n:MemoryNote {id: $id})-[r:ANCHORED_TO]->(:Module) DELETE r`,
      { id: victim }
    );

    const dryRun = await app.inject({
      method: "POST",
      url: "/api/memory/reconcile-anchors",
      headers: auth(OPERATOR),
      payload: {},
    });
    const dry = dryRun.json() as {
      complete: boolean;
      modules: { notesMissingEdges: number };
      repairedNotes: number;
    };
    expect(dry.complete).toBe(false);
    expect(dry.modules.notesMissingEdges).toBe(1);
    // REPORT BY DEFAULT: the dry run wrote nothing.
    expect(dry.repairedNotes).toBe(0);

    const repaired = await app.inject({
      method: "POST",
      url: "/api/memory/reconcile-anchors",
      headers: auth(OPERATOR),
      payload: { repair: true },
    });
    expect((repaired.json() as { repairedNotes: number }).repairedNotes).toBe(1);

    const after = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(MODULES[5]!)}`,
      headers: auth(OPERATOR),
    });
    expect(
      (after.json() as { notes: { id: string }[] }).notes.map((n) => n.id)
    ).toContain(victim);
  }, 30_000);

  it("a wiped edge set is restored by the replay (the PROJECTOR's own doing, not the reconciler's)", async () => {
    const graph = graphLib.getGraph();
    const exec = (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute.bind(graph);
    // Wipe EVERY anchor edge, leaving `n.modules` (the authority) intact. This is
    // the extreme version of the dropped-write condition, and the shape a partial
    // projection leaves behind.
    await exec(`MATCH (:MemoryNote)-[r:ANCHORED_TO]->(:Module) DELETE r`, {});
    const broken = await graph.reconcileAnchorEdges();
    expect(broken.complete).toBe(false);
    expect(broken.modules.edges).toBe(0);
    expect(broken.modules.expected).toBeGreaterThan(0);

    await ledger.projectLedgerToGraph(graph);
    expect((await graph.reconcileAnchorEdges()).complete).toBe(true);
    // Deliberately labelled: `projectMemoryNote` re-MERGEs each note's anchor edges
    // itself, so a MISSING edge is restored whether or not the reconciler ran. That
    // is worth pinning (a wipe→reproject really does heal the access path) but it is
    // NOT evidence the boot reconciler works — the next test is, and it was written
    // because turning `repair` off here changed nothing.
    //
    // Explicit timeout: the full replay runs ~3.4s locally and timed out at
    // vitest's 5s default on a slower CI runner (PR 26); its two sibling D6
    // replay tests already carry the same allowance.
  }, 30_000);

  it("the BOOT reconciler repairs the ONE divergence the projector cannot: an ORPHAN edge", async () => {
    const graph = graphLib.getGraph();
    const exec = (
      graph as unknown as {
        execute: (s: string, p: unknown) => Promise<unknown[]>;
      }
    ).execute.bind(graph);
    // An edge the note's `modules` array does not justify. `projectMemoryNote` only
    // ever MERGEs the edges the array names — it never DELETES a stale one — so this
    // divergence survives a full replay unless the reconciler at its tail removes
    // it. That makes this the isolating test for "the reconciler runs at boot", and
    // it is the mutation target for `{ repair: true }`.
    await exec(
      `MERGE (m:Module {path: $path}) ON CREATE SET m.lastTouchedAt = ''`,
      { path: "src/batch/forged-at-boot.ts" }
    );
    await exec(
      `MATCH (n:MemoryNote {id: $id}), (m:Module {path: $path})
       MERGE (n)-[:ANCHORED_TO]->(m)`,
      { id: confirmedIds[7]!, path: "src/batch/forged-at-boot.ts" }
    );
    const broken = await graph.reconcileAnchorEdges();
    expect(broken.complete).toBe(false);
    expect(broken.modules.orphanEdges).toBe(1);

    await ledger.projectLedgerToGraph(graph);
    const healed = await graph.reconcileAnchorEdges();
    expect(healed.orphanEdges ?? healed.modules.orphanEdges).toBe(0);
    expect(healed.complete).toBe(true);
    // …and the forged anchor stops resolving on the gate, which is the point: an
    // orphan edge is a note reachable through a coordinate it never claimed.
    const res = await app.inject({
      method: "GET",
      url: `/api/memory/recall?module=${encodeURIComponent(
        "src/batch/forged-at-boot.ts"
      )}`,
      headers: auth(OPERATOR),
    });
    expect((res.json() as { notes: unknown[] }).notes).toEqual([]);
  }, 30_000);
});

describe("D6 — a failed anchor-edge write is no longer swallowed", () => {
  it("surfaces on the SAME coalesced memory.graph_mirror_failed Event the mirror already raises", async () => {
    const graph = graphLib.getGraph();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Break ONLY the ANCHORED_TO edge write, exactly as a transient store error
      // would. Before D6 this was `.catch(() => undefined)` and produced no signal
      // of any kind — the note kept its `modules` array and silently lost the
      // access path the gate now reads through.
      const holder = graph as unknown as {
        execute: (statement: string, params: unknown) => Promise<unknown[]>;
      };
      const real = holder.execute.bind(graph);
      holder.execute = async (statement, params) => {
        if (statement.includes("MERGE (n)-[:ANCHORED_TO]->(m)")) {
          throw new Error("anchor edge write refused");
        }
        return real(statement, params);
      };
      try {
        const ingested = await ledger.ingestMemoryNote({
          kind: "decision",
          text: "A note whose anchor edge write is refused by the store.",
          modules: ["src/batch/refused.ts"],
          createdBy: "human",
        });
        expect(ingested.note.id).toBeTruthy();
        await settle();
        await graphLib.awaitGraphMirrors();
      } finally {
        delete (graph as unknown as { execute?: unknown }).execute;
      }

      const events = await db.prisma.event.findMany({
        where: { kind: "memory.graph_mirror_failed" },
      });
      const anchorFailures = events.filter((event) =>
        String(event.message).includes("anchor edge projection failed")
      );
      expect(anchorFailures.length).toBeGreaterThanOrEqual(1);
      // COORDINATES AND COUNTS ONLY: never the note id, never its text, never the
      // module path — `reportMirrorFailure`'s standing contract.
      const message = String(anchorFailures[0]!.message);
      expect(message).toContain("1 of 1 module anchor(s)");
      expect(message).not.toContain("src/batch/refused.ts");
      expect(message).not.toContain("mem-");
      expect(message).not.toContain("refused by the store".slice(0, 0) + "A note whose");
    } finally {
      logged.mockRestore();
    }
  }, 30_000);

  it("a replay whose per-note projection fails keeps going, and reports rather than aborting", async () => {
    const graph = graphLib.getGraph();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const holder = graph as unknown as {
        execute: (statement: string, params: unknown) => Promise<unknown[]>;
      };
      const real = holder.execute.bind(graph);
      let failures = 0;
      holder.execute = async (statement, params) => {
        // Fail the FIRST anchor-edge write of the replay only, so the abort-vs-
        // continue difference is observable: an aborting replay would leave the
        // remaining 128 notes unprojected.
        if (
          failures === 0 &&
          statement.includes("MERGE (n)-[:ANCHORED_TO]->(m)")
        ) {
          failures += 1;
          throw new Error("one bad edge write");
        }
        return real(statement, params);
      };
      let result: { notes: number } | undefined;
      try {
        result = await ledger.projectLedgerToGraph(graph);
      } finally {
        delete (graph as unknown as { execute?: unknown }).execute;
      }
      // The replay COMPLETED and reports every note it walked.
      expect(result!.notes).toBeGreaterThan(128);
      // …and the boot reconciler at its tail repaired the one dropped edge, so the
      // invariant holds again with no operator action.
      expect((await graph.reconcileAnchorEdges()).complete).toBe(true);
    } finally {
      logged.mockRestore();
    }
  }, 30_000);
});
