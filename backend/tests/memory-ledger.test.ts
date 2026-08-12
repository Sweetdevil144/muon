import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// REAL SQLite + REAL LadybugDB integration (no mocks). Proves ADR-0009 Slice 1 /
// KG-1: memory has a durable relational home, the graph is a rebuildable
// projection, and the acceptance criterion, wipe the .lbug store → reproject
// from the ledger → ZERO confirmed memory lost, holds end-to-end.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

/**
 * Drain the FIRE-AND-FORGET graph mirrors instead of sleeping over them.
 *
 * Every ledger write mirrors into the graph on an unawaited chain, so a graph
 * assertion samples work nobody awaited. A fixed sleep is the wrong instrument
 * for that: one LadybugDB write costs 30–130ms on a contended host and these
 * chains are several writes deep, so `await settle()` was sampling MID-CHAIN and
 * flaked under load — a test-timing bug that looks exactly like a lost mirror.
 * `awaitGraphMirrors` is the drain the mirror registry already exposes for
 * callers that must be ordered against one (it is what the hard-delete path
 * uses): deterministic rather than a guess, and fast in the common case.
 */
const mirrors = () => graphLib.awaitGraphMirrors();

/**
 * The one fixed sleep that survives, and only in front of a NEGATIVE assertion
 * ("nothing wrote"). A sleep before a POSITIVE assertion fails whenever it is
 * too short; a sleep before a negative one can only ever be too GENEROUS to an
 * unwanted write, so it cannot manufacture a failure under load.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-ledger-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  // Deterministic lexical recall in CI (the container FTS extension is optional).
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await mirrors(); // let trailing best-effort graph mirrors finish before close
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("memory ledger (KG-1 durability)", () => {
  it("dual-write: a memory note lands in the relational ledger (authoritative)", async () => {
    const result = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Ledger is the source of truth for memory",
      modules: ["backend/src/lib/memory-ledger.ts"],
      topics: ["memory", "durability"],
      createdBy: "human",
    });
    expect(result.action).toBe("inserted");

    // The note (and its provenance) exist in the DURABLE relational tables.
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: result.note.id },
    });
    expect(row).not.toBeNull();
    expect(row?.text).toBe("Ledger is the source of truth for memory");
    expect(row?.textHash).toHaveLength(64); // sha256 hex
    expect(row?.status).toBe("active");
    expect(row?.episodeId).toBeTruthy();

    const episodes = await db.prisma.episode.count();
    expect(episodes).toBeGreaterThanOrEqual(1);
  });

  it("projector is idempotent: re-running never duplicates graph nodes", async () => {
    // Two distinct notes on distinct anchors (no dedup collapse).
    await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Never place the SQLite db on a synced volume",
      modules: ["backend/src/lib/db.ts"],
      topics: ["sqlite"],
      createdBy: "human",
    });
    await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Graph writes are best-effort mirrors of the ledger",
      modules: ["backend/src/lib/graph.ts"],
      topics: ["graph"],
      createdBy: "human",
    });

    const ledgerActive = await db.prisma.memoryNote.count({
      where: { status: "active" },
    });

    // Run the projector twice, MERGE-based upserts make it safe to re-run.
    const first = await ledger.projectLedgerToGraph();
    const second = await ledger.projectLedgerToGraph();
    expect(second.notes).toBe(first.notes);

    // The graph holds exactly one node per active ledger note (no duplication).
    const recalled = await graphLib.getGraph().recallMemory({});
    expect(recalled.length).toBe(ledgerActive);
    const ids = recalled.map((note) => note.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ACCEPTANCE: wipe the .lbug store → reproject → confirmed memory survives", async () => {
    // 1. Write a memory note and CONFIRM it (both ledger-first).
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Adopt bitemporal columns for the memory ledger",
      modules: ["backend/prisma/schema.prisma"],
      topics: ["adr-0009"],
      createdBy: "human",
    });
    const noteId = created.note.id;
    const confirmed = await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human", // KG-6 F1: only a HUMAN principal confirms
    });
    expect(confirmed?.confirmed).toBe(true);

    // Let any fire-and-forget graph mirrors finish before we tear the store down.
    await mirrors();

    // 2. WIPE the LadybugDB store, simulate a corrupt-store recovery /
    //    STORE_VERSION bump (the lever that used to permanently destroy memory).
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false); // the graph is truly gone

    // 3. Rebuild the graph PURELY from the durable ledger.
    const projection = await ledger.projectLedgerToGraph();
    expect(projection.notes).toBeGreaterThanOrEqual(1);

    // 4. Recall from the rebuilt graph, the confirmed note is back, intact.
    const recalled = await graphLib.getGraph().recallMemory({});
    const survivor = recalled.find((note) => note.id === noteId);
    expect(survivor).toBeDefined();
    expect(survivor?.text).toBe("Adopt bitemporal columns for the memory ledger");
    expect(survivor?.confirmed).toBe(true); // ZERO confirmed memory lost

    // Emit proof to the test output.
     
    console.log(
      `[KG-1 acceptance] after wipe+reproject, recall returned confirmed note: ${JSON.stringify(
        { id: survivor?.id, text: survivor?.text, confirmed: survivor?.confirmed }
      )}`
    );
  });

  it("ADR-0012: a symbol-anchored note persists symbol + AUTO-DERIVED module anchors; wipe+reproject restores symbols, Symbol nodes + ABOUT_SYMBOL, and symbol recall", async () => {
    const symId = "backend/src/lib/preedit.ts#preEditContext";
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "preEditContext fuses a 3-tier on-symbol > module > neighbour order",
      symbols: [symId],
      trust: "high",
      createdBy: "human",
    });
    const noteId = created.note.id;
    await ledger.updateMemoryNote(noteId, { confirmed: true, principal: "human" });

    // The ledger note row carries symbols AND the auto-derived module (degrade guarantee).
    const row = await db.prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.symbols).toEqual([symId]);
    expect(row?.modules).toEqual(["backend/src/lib/preedit.ts"]);

    // MemoryAnchor has a {kind:"symbol"} row AND the auto-derived {kind:"module"} row.
    const anchors = await db.prisma.memoryAnchor.findMany({ where: { noteId } });
    const anchorKeys = new Set(anchors.map((a) => `${a.kind}:${a.value}`));
    expect(anchorKeys.has(`symbol:${symId}`)).toBe(true);
    expect(anchorKeys.has("module:backend/src/lib/preedit.ts")).toBe(true);

    await mirrors();

    // WIPE the LadybugDB store, then rebuild PURELY from the durable ledger.
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);
    await ledger.projectLedgerToGraph();

    const graph = graphLib.getGraph();
    // Symbol recall + the scalar `n.symbols` restored from the note column.
    const bySymbol = await graph.recallMemory({ symbol: symId });
    expect(bySymbol.find((n) => n.id === noteId)?.symbols).toEqual([symId]);
    // The Symbol node + ABOUT_SYMBOL edge restored (wipe-survivable, zero ledger
    // reads beyond the note column).
    const rawQuery = (q: string) =>
      (
        graph as unknown as {
          query(s: string): Promise<Record<string, unknown>[]>;
        }
      ).query(q);
    const symbolNode = await rawQuery(
      `MATCH (s:Symbol {id: '${symId}'}) RETURN s.name AS name, s.module AS module`
    );
    expect(symbolNode).toHaveLength(1);
    expect(symbolNode[0]!.name).toBe("preEditContext");
    expect(symbolNode[0]!.module).toBe("backend/src/lib/preedit.ts");
    const edge = await rawQuery(
      `MATCH (n:MemoryNote {id: '${noteId}'})-[:ABOUT_SYMBOL]->(s:Symbol) RETURN s.id AS id`
    );
    expect(edge.map((r) => r.id)).toContain(symId);
  });

  it("F1: aged-anchor dedup/contradiction is caught past a 500-note window", async () => {
    const anchorModule = "aged/f1-module.ts";

    // 1. An AGED governance note on a specific anchor.
    const aged = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Use Postgres as the durable ledger store",
      modules: [anchorModule],
      topics: ["f1"],
      createdBy: "human",
    });

    // 2. Bury it under 600 NEWER active notes on UNRELATED anchors, so any
    //    recency-windowed comparison set (the old take:500) would EXCLUDE the
    //    aged note and silently mis-handle a dup/contradiction of it.
    const base = Date.now() + 60_000;
    const filler = Array.from({ length: 600 }, (_, i) => ({
      id: `f1-filler-${i}`,
      kind: "convention",
      text: `Filler convention number ${i}`,
      textHash: `f1-filler-hash-${i}`,
      trust: "medium",
      createdBy: "seed",
      modules: [`filler/${i}.ts`],
      topics: [],
      recordedAt: new Date(base + i), // strictly newer than the aged note
      validFrom: new Date(base + i),
      updatedAt: new Date(base + i),
    }));
    await db.prisma.memoryNote.createMany({ data: filler });

    const activeCount = await db.prisma.memoryNote.count({
      where: { status: "active" },
    });
    expect(activeCount).toBeGreaterThan(500); // aged note is outside any 500-window

    // 3a. A DUPLICATE of the aged note → deduped to NOOP (NOT silently inserted).
    const dup = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Use Postgres as the durable ledger store",
      modules: [anchorModule],
      topics: ["f1"],
      createdBy: "human",
    });
    expect(dup.action).toBe("duplicate");
    expect(dup.relatedNoteId).toBe(aged.note.id);

    // 3b. A CONTRADICTION of the aged note → flagged (contradicts edge +
    //     reconciliation enqueued), never inserted-and-forgotten.
    const conflict = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Do not use Postgres as the durable ledger store",
      modules: [anchorModule],
      topics: ["f1"],
      createdBy: "human",
    });
    expect(conflict.action).toBe("conflict");
    expect(conflict.relatedNoteId).toBe(aged.note.id);

    const contradictsEdge = await db.prisma.memoryEdge.findFirst({
      where: { fromId: conflict.note.id, toId: aged.note.id, kind: "contradicts" },
    });
    expect(contradictsEdge).not.toBeNull();

    const reconcile = await db.prisma.confirmation.findFirst({
      where: { noteId: conflict.note.id, decision: "reconcile" },
    });
    expect(reconcile).not.toBeNull();

     
    console.log(
      `[KG-1 F1] with ${activeCount} active notes, aged-anchor dup=${dup.action}, contradiction=${conflict.action} (contradicts edge + reconcile enqueued)`
    );

    // 4. RETIRE the filler. The 600 notes are F1's evidence, not this file's
    //    baseline, and the proof above is complete. Every LATER wipe+reproject
    //    test replays the WHOLE ledger through the graph (one projectMemoryNote
    //    + one projectAuthoredBy await per note), so leaving the fixture behind
    //    turned two sub-second durability tests into ~1,200 serial graph writes:
    //    ~19s idle and past their timeout the moment another suite contended for
    //    the CPU. A fixture that outlives its test is a leak, and here it was
    //    also the load-sensitive flake.
    const retired = await db.prisma.memoryNote.deleteMany({
      where: { id: { startsWith: "f1-filler-" } },
    });
    expect(retired.count).toBe(filler.length);
    expect(
      await db.prisma.memoryNote.count({ where: { status: "active" } })
    ).toBeLessThan(500); // the aged note, dup and contradiction all remain
  });
});

describe("memory ledger (KG-2 atomic writes + reinforcement off read path)", () => {
  it("write-actor: N concurrent ingests of a duplicate → exactly ONE insert", async () => {
    const anchor = "kg2/concurrency-module.ts";
    const build = () => ({
      kind: "decision" as const,
      text: "KG-2 serialize the ingest read-modify-write critical section",
      modules: [anchor],
      topics: ["kg2-concurrency"],
      createdBy: "human",
    });

    // Fire N ingests of the SAME note CONCURRENTLY. Without the write-actor they
    // would all read "no duplicate" and all insert (TOCTOU); with it they
    // serialize → the first inserts, the rest dedup to NOOP.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => ledger.ingestMemoryNote(build()))
    );

    const inserted = results.filter((r) => r.action === "inserted");
    const duplicate = results.filter((r) => r.action === "duplicate");
    expect(inserted).toHaveLength(1);
    expect(duplicate).toHaveLength(N - 1);
    const insertedId = inserted[0]!.note.id;
    for (const dup of duplicate) {
      expect(dup.relatedNoteId).toBe(insertedId);
    }

    // The LEDGER holds exactly ONE active note on that anchor, no duplicate row,
    // no lost supersede.
    const anchorRows = await db.prisma.memoryAnchor.findMany({
      where: { kind: "module", value: anchor },
    });
    const activeIds = new Set<string>();
    for (const row of anchorRows) {
      const note = await db.prisma.memoryNote.findUnique({
        where: { id: row.noteId },
      });
      if (note?.status === "active") {
        activeIds.add(note.id);
      }
    }
    expect(activeIds.size).toBe(1);

     
    console.log(
      `[KG-2 write-actor] ${N} concurrent duplicate ingests → inserted=${inserted.length}, duplicate=${duplicate.length}, active-on-anchor=${activeIds.size}`
    );
  });

  it("supersede is ONE transaction: successor + retire + edge commit together", async () => {
    const anchor = "kg2/txn-module.ts";
    const first = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "KG-2 use a single transaction for memory supersede writes",
      modules: [anchor],
      topics: ["kg2-txn"],
      createdBy: "human",
    });
    const refined = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "KG-2 use an atomic transaction for memory supersede writes",
      modules: [anchor],
      topics: ["kg2-txn"],
      createdBy: "human",
    });
    expect(refined.action).toBe("superseded");
    expect(refined.relatedNoteId).toBe(first.note.id);

    // All three effects are present together (one atomic commit, no orphaned
    // active successor without its supersede link).
    const successor = await db.prisma.memoryNote.findUnique({
      where: { id: refined.note.id },
    });
    const predecessor = await db.prisma.memoryNote.findUnique({
      where: { id: first.note.id },
    });
    const edge = await db.prisma.memoryEdge.findFirst({
      where: { fromId: refined.note.id, toId: first.note.id, kind: "supersedes" },
    });
    expect(successor?.status).toBe("active");
    expect(predecessor?.status).toBe("rejected");
    expect(predecessor?.supersededBy).toBe(refined.note.id);
    expect(predecessor?.retiredAt).not.toBeNull();
    expect(edge).not.toBeNull();
  });

  it("reads don't write: searchMemory does NOT mutate accessCount (KG-2)", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "KG-2 retrieval must not reinforce a note on the read path",
      modules: ["kg2/reads-module.ts"],
      topics: ["kg2-reads"],
      createdBy: "human",
    });
    await mirrors(); // the mirror must have LANDED before we read the node

    const graph = graphLib.getGraph();
    const before = await graph.getMemoryNote(created.note.id);
    expect(before?.accessCount).toBe(0);

    // Search repeatedly, retrieval must NEVER write.
    for (let i = 0; i < 3; i += 1) {
      const hits = await graph.searchMemory("retrieval reinforce read path");
      expect(hits.some((n) => n.id === created.note.id)).toBe(true);
    }
    // Drain first (a reinforcing write on the read path would be a mirror), then
    // still sleep: this is the negative assertion, so the extra 100ms only makes
    // the guard harder to fool, never flakier.
    await mirrors();
    await settle();

    const afterGraph = await graph.getMemoryNote(created.note.id);
    expect(afterGraph?.accessCount).toBe(0); // graph node untouched
    const afterLedger = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(afterLedger?.accessCount).toBe(0); // ledger untouched
    expect(afterLedger?.lastUsedAt).toBeNull();

     
    console.log(
      `[KG-2 reads-don't-write] after 3 searches, accessCount graph=${afterGraph?.accessCount} ledger=${afterLedger?.accessCount}`
    );
  });

  it("soft signal survives a wipe: reinforce → ledger → wipe+reproject → restored (KG-2 / F3)", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "KG-2 soft signals must survive a store wipe",
      modules: ["kg2/soft-signal-module.ts"],
      topics: ["kg2-soft"],
      createdBy: "human",
    });
    const noteId = created.note.id;
    await mirrors();

    // Explicit used-signal (cited twice), then flush off the read path.
    ledger.recordMemoryUsed([noteId, noteId]);
    const flushed = await ledger.flushMemoryReinforcement();
    expect(flushed).toBeGreaterThanOrEqual(1);

    // The reinforcement is now DURABLE in the ledger (not just the graph).
    const row = await db.prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.accessCount).toBe(2);
    expect(row?.lastUsedAt).not.toBeNull();

    // WIPE the graph store (STORE_VERSION bump / corrupt-store recovery).
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);

    // Rebuild purely from the ledger, the reinforcement count comes BACK.
    // The replay is BOUNDED by construction (F1 retires its 600-note fixture),
    // so assert that here: if the fixture ever leaks again this fails loudly
    // instead of silently drifting back toward the timeout.
    const projection = await ledger.projectLedgerToGraph();
    expect(projection.notes).toBeLessThan(50);
    const restored = await graphLib.getGraph().getMemoryNote(noteId);
    expect(restored?.accessCount).toBe(2);
    expect(restored?.lastAccessedAt).toBeTruthy();

     
    console.log(
      `[KG-2 soft-signal survives wipe] ledger.accessCount=${row?.accessCount} → wipe → restored graph.accessCount=${restored?.accessCount}`
    );
    // The timeout is a CEILING, not a budget: the wipe+reproject above costs
    // well under a second now that F1's fixture no longer rides along. The
    // headroom is deliberate, so a contended host cannot turn slowness into a
    // false failure — the bound that actually matters is asserted above.
  }, 30_000);

  it("module-touch staleness is persisted to the ledger and survives a wipe (KG-2 / F3)", async () => {
    const mod = "kg2/staleness-module.ts";
    const created = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "KG-2 staleness must be durable in the ledger",
      modules: [mod],
      topics: ["kg2-stale"],
      createdBy: "human",
    });
    await mirrors();

    // A later module touch marks the older anchored note suspect, persisted to
    // the LEDGER (source of truth), mirroring graph.touchModules.
    await ledger.markModulesStale([mod], new Date(Date.now() + 60_000));
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.staleSince).not.toBeNull();

    // Wipe + reproject → staleness restored from the ledger.
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    const projection = await ledger.projectLedgerToGraph();
    expect(projection.notes).toBeLessThan(50); // same bound as the case above
    const restored = await graphLib.getGraph().getMemoryNote(created.note.id);
    expect(restored?.stale).toBe(true);
    expect(restored?.staleSince).toBeTruthy();
    // Ceiling, not budget — see the reinforcement case above.
  }, 30_000);

  // Mission 420c8bf4: the implementer's constraint about the very files it was
  // editing went stale ~1 minute after creation — the runner's own "touched
  // N file(s)" event marked it. A note a task writes about the change it is
  // making is DESCRIBED by that change; only a DIFFERENT task's edit is the
  // true suspicion signal. Both witnesses (ledger + graph) hold the exemption,
  // because resolveStale ORs them.
  it("a task's own edit never stale-marks its own notes — on either witness", async () => {
    const modulePath = "stale/self-exempt.ts";
    const created = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The version command must stay exempt from the preAction hook.",
      modules: [modulePath],
      topics: ["self-exempt"],
      createdBy: "agent:codex",
      taskId: "task-self",
    });

    const touchAt = new Date(Date.now() + 60_000);
    // LEDGER witness: the same task's edit is exempt…
    await ledger.markModulesStale([modulePath], touchAt, "task-self");
    let row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.staleSince).toBeNull();

    // GRAPH witness: same exemption, in lockstep.
    const graph = graphLib.getGraph();
    await graph.projectMemoryNote(created.note);
    await graph.touchModules([modulePath], touchAt.toISOString(), "task-self");
    expect((await graph.getMemoryNote(created.note.id))?.stale).not.toBe(true);

    // …and a DIFFERENT task's edit still marks, on both.
    await ledger.markModulesStale([modulePath], touchAt, "task-other");
    row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.staleSince).not.toBeNull();
    await graph.touchModules([modulePath], touchAt.toISOString(), "task-other");
    expect((await graph.getMemoryNote(created.note.id))?.stale).toBe(true);
  }, 30_000);

  // Prisma's `NOT: { taskId: X }` is three-valued: it also excludes rows where
  // taskId IS NULL — which silently exempted every task-LESS (human/operator/
  // legacy) note from ledger staleness forever, while the graph witness (which
  // projects taskId ?? "") still marked them: the exact divergence the
  // exemption's own "lockstep" comment forbids. A task-less note is never
  // "the touching task's own" and must stay markable.
  it("the self-exemption never shields a task-LESS note from staleness", async () => {
    const modulePath = "stale/null-task.ts";
    const created = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "A task-less note anchored to a module that later changes.",
      modules: [modulePath],
      topics: ["null-task"],
      createdBy: "human",
      // no taskId — the operator/legacy shape
    });
    const touchAt = new Date(Date.now() + 60_000);
    await ledger.markModulesStale([modulePath], touchAt, "task-whoever");
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.staleSince).not.toBeNull();
  }, 30_000);

  it("flush is reentrancy-safe: concurrent flushes coalesce, drain not dropped (KG-2 / F2)", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "KG-2 F2 shutdown must drain the reinforcement buffer",
      modules: ["kg2/f2-module.ts"],
      topics: ["kg2-f2"],
      createdBy: "human",
    });
    await mirrors();
    ledger.recordMemoryUsed([created.note.id, created.note.id]); // cited twice

    // Two flushes racing (timer + shutdown) must coalesce onto ONE run, not let
    // one see an already-emptied buffer and return while the other is mid write.
    const [a, b] = await Promise.all([
      ledger.flushMemoryReinforcement(),
      ledger.flushMemoryReinforcement(),
    ]);
    expect(a).toBe(b); // both callers observed the SAME in-flight flush

    const row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.accessCount).toBe(2); // drained once, not lost, not doubled

    // A shutdown drain with nothing left buffered is a clean no-op.
    await ledger.stopReinforcementFlush();
    const after = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(after?.accessCount).toBe(2);
  });

  it("confirming a stale note clears staleness on the LIVE graph via reprojection (KG-2 / F5)", async () => {
    const modulePath = "kg2/f5-module.ts";
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "KG-2 F5 a confirm must un-stale the live graph node",
      modules: [modulePath],
      topics: ["kg2-f5"],
      createdBy: "human",
    });
    await mirrors();

    // Make it stale on BOTH sides (as the events route does): ledger + graph.
    const touchAt = new Date(Date.now() + 60_000);
    await ledger.markModulesStale([modulePath], touchAt);
    const graph = graphLib.getGraph();
    // Deterministically ensure the note + its ANCHORED_TO edge exist before the
    // touch (the ingest graph mirror is fire-and-forget, don't race it). MERGE
    // is idempotent, so this never duplicates the node.
    await graph.projectMemoryNote(created.note);
    await graph.touchModules([modulePath], touchAt.toISOString());
    expect((await graph.getMemoryNote(created.note.id))?.stale).toBe(true);

    // Confirm via the LEDGER path → clears ledger staleSince AND re-projects.
    await ledger.updateMemoryNote(created.note.id, {
      confirmed: true,
      principal: "human", // KG-6 F1: a HUMAN confirm clears suspicion
    });
    await mirrors(); // the best-effort reprojection mirror must have LANDED

    const cleared = await graph.getMemoryNote(created.note.id);
    expect(cleared?.stale).toBe(false); // live read path no longer demotes it
    expect(cleared?.staleSince).toBeNull();

    // The ledger agrees (staleSince cleared on confirm).
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(row?.staleSince).toBeNull();
  });
  // P0-2 — the founder's "Review inbox (24)" from ONE short mission. The anchor
  // pass only compares notes that already share a task/module/topic, and a mined
  // note carries no modules when its job had no governed worktree, so two jobs
  // restating the same fact were never even compared. `textHash` was already
  // written and indexed on every row; it was simply never read back.
  describe("P0-2 exact-text idempotency (restatements never accumulate)", () => {
    it("collapses a byte-identical restatement from a DIFFERENT job with no shared anchor", async () => {
      const text = "The bounded parser rejects inputs over 64KB by design";
      const first = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02",
        taskId: "task-A",
        modules: [], // no governed worktree → no module anchor
        topics: ["parser-a"],
        createdBy: "agent:job:job-A",
      });
      expect(first.action).toBe("inserted");

      // A different job, different task, disjoint topics — sharesAnchor would
      // never have compared these two, so BOTH used to insert.
      const second = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02",
        taskId: "task-B",
        modules: [],
        topics: ["parser-b"],
        createdBy: "agent:job:job-B",
      });
      expect(second.action).toBe("duplicate");
      expect(second.note.id).toBe(first.note.id);

      const active = await db.prisma.memoryNote.count({
        where: { chatId: "chat-p02", status: "active" },
      });
      expect(active).toBe(1);
    });

    it("normalizes whitespace and case, so a reflowed restatement still collapses", async () => {
      const first = await ledger.ingestMemoryNote({
        kind: "convention",
        text: "Runner retries are capped at three attempts",
        chatId: "chat-p02-norm",
        createdBy: "agent:job:job-A",
      });
      const second = await ledger.ingestMemoryNote({
        kind: "convention",
        text: "  runner   RETRIES are capped\n at three attempts  ",
        chatId: "chat-p02-norm",
        createdBy: "agent:job:job-B",
      });
      expect(second.action).toBe("duplicate");
      expect(second.note.id).toBe(first.note.id);
    });

    it("does NOT collapse across chats — each mission keeps its own copy (#126)", async () => {
      const text = "Vendor lanes are retired when the registry drops them";
      const a = await ledger.ingestMemoryNote({
        kind: "decision",
        text,
        chatId: "chat-p02-x",
        createdBy: "agent:job:job-A",
      });
      const b = await ledger.ingestMemoryNote({
        kind: "decision",
        text,
        chatId: "chat-p02-y",
        createdBy: "agent:job:job-B",
      });
      expect(b.action).toBe("inserted");
      expect(b.note.id).not.toBe(a.note.id);
    });

    it("TODO 4.15: does NOT collapse across workspaces — residue stays residue-only", async () => {
      const text = "Cross-workspace exact text must never merge partitions";
      const inA = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02-ws",
        workspacePath: "/tmp/muon-ws-a",
        createdBy: "agent:job:job-ws-a",
      });
      expect(inA.action).toBe("inserted");

      // Same chat + text, different workspace → second insert (not a merge).
      const inB = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02-ws",
        workspacePath: "/tmp/muon-ws-b",
        createdBy: "agent:job:job-ws-b",
      });
      expect(inB.action).toBe("inserted");
      expect(inB.note.id).not.toBe(inA.note.id);

      // Unassigned (§8 residue) must not collapse an assigned copy either.
      const residue = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02-ws",
        createdBy: "agent:job:job-ws-null",
      });
      expect(residue.action).toBe("inserted");
      expect(residue.note.id).not.toBe(inA.note.id);
      expect(residue.note.id).not.toBe(inB.note.id);

      // Residue-to-residue still collapses (both workspacePath NULL).
      const residueAgain = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text,
        chatId: "chat-p02-ws",
        createdBy: "agent:job:job-ws-null-2",
      });
      expect(residueAgain.action).toBe("duplicate");
      expect(residueAgain.note.id).toBe(residue.note.id);
    });

    it("does NOT collapse a different KIND or SCOPE — those are real partitions", async () => {
      const text = "Egress stays an explicit, un-auto-consented lever";
      await ledger.ingestMemoryNote({
        kind: "constraint",
        text,
        chatId: "chat-p02-k",
        createdBy: "agent:job:job-A",
      });
      const otherKind = await ledger.ingestMemoryNote({
        kind: "decision",
        text,
        chatId: "chat-p02-k",
        createdBy: "agent:job:job-A",
      });
      expect(otherKind.action).toBe("inserted");

      const otherScope = await ledger.ingestMemoryNote({
        kind: "constraint",
        text,
        scope: "lane:codex",
        chatId: "chat-p02-k",
        createdBy: "agent:job:job-A",
      });
      expect(otherScope.action).toBe("inserted");
    });

    it("a REJECTED original does not shadow a fresh statement of the same fact", async () => {
      const first = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text: "cursor-agent exits rc=0 even when logged out",
        chatId: "chat-p02-rej",
        createdBy: "agent:job:job-A",
      });
      await ledger.updateMemoryNote(first.note.id, {
        confirmed: false,
        status: "rejected",
        principal: "human",
      });
      const again = await ledger.ingestMemoryNote({
        kind: "gotcha",
        text: "cursor-agent exits rc=0 even when logged out",
        chatId: "chat-p02-rej",
        createdBy: "agent:job:job-B",
      });
      // Only ACTIVE rows are identity candidates, so a human's reject is never
      // silently re-applied to a note they never saw.
      expect(again.action).toBe("inserted");
    });
  });
});

// ADR-0027 D12-C: the orchestrator may vouch only after two independent crew
// principals support one normalized claim inside one workspace + mission.
describe("ADR-0027 crew corroboration", () => {
  let settings: typeof import("../src/lib/operator-settings.js");

  beforeAll(async () => {
    settings = await import("../src/lib/operator-settings.js");
  });

  async function confirmationsOf(noteId: string) {
    return db.prisma.confirmation.findMany({
      where: { noteId },
      orderBy: { at: "asc" },
    });
  }

  const WORKSPACE = process.cwd();

  async function corroborated(input: {
    kind: "decision" | "constraint" | "convention" | "attempt" | "question";
    text: string;
    chatId: string;
  }) {
    const first = await ledger.ingestMemoryNote({
      ...input,
      workspacePath: WORKSPACE,
      createdBy: `agent:job:${input.chatId}-a`,
    });
    const second = await ledger.ingestMemoryNote({
      ...input,
      workspacePath: WORKSPACE,
      createdBy: `agent:job:${input.chatId}-b`,
    });
    expect(second.note.id).toBe(first.note.id);
    return first;
  }

  it("keeps one agent's proposal unvouched and expiring", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The refund lane needs the idempotency key before it retries",
      chatId: "chat-vouch",
      workspacePath: WORKSPACE,
      createdBy: "agent:job:job-vouch",
    });

    const rows = await confirmationsOf(note.note.id);
    expect(rows).toHaveLength(0);
    const stored = await db.prisma.memoryNote.findUnique({
      where: { id: note.note.id },
    });
    expect(stored?.expiresAt).not.toBeNull();
    expect(await db.prisma.memoryCorroboration.count()).toBeGreaterThan(0);
  });

  it("vouches only after a second principal and makes the claim durable", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await corroborated({
      kind: "convention",
      text: "Lane budgets are reconciled once per dispatched job, never per turn",
      chatId: "chat-vouch-ttl",
    });
    const rows = await confirmationsOf(note.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.principal).toBe(
      "agent:orchestrator:corroborated:chat-vouch-ttl"
    );
    const auth = await import("../src/lib/auth.js");
    expect(auth.isHumanPrincipal(rows[0]!.principal)).toBe(false);
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: note.note.id },
    });
    expect(row?.expiresAt).toBeNull();
  });

  it("does not count one principal twice", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Crew snapshots are written before the orchestrator takes its turn",
      chatId: "chat-vouch-tier",
      workspacePath: WORKSPACE,
      createdBy: "agent:job:job-vouch-3",
    });
    await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Crew snapshots are written before the orchestrator takes its turn",
      chatId: "chat-vouch-tier",
      workspacePath: WORKSPACE,
      createdBy: "agent:job:job-vouch-3",
    });
    const library = await ledger.listMemoryLibrary({ chatId: "chat-vouch-tier" });
    const found = library.notes.find((n) => n.id === note.note.id);
    expect(found).toBeTruthy();
    expect(found!.confirmed).toBe(false);
    expect(found!.confirmedBy).toBeNull();
    expect(found!.expiresAt).not.toBeNull();
  });

  it("a HUMAN confirm still lands, is attributed to the human, and outranks the orchestrator", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await corroborated({
      kind: "decision",
      text: "Receipts expire on the server clock, never the renderer's",
      chatId: "chat-vouch-human",
    });
    await ledger.updateMemoryNote(note.note.id, {
      confirmed: true,
      principal: "human:founder",
    });
    const library = await ledger.listMemoryLibrary({ chatId: "chat-vouch-human" });
    const found = library.notes.find((n) => n.id === note.note.id);
    expect(found!.confirmed).toBe(true);
    expect(found!.confirmedBy).toBe("human");
    // Both vouches survive on the record — the trail says who said what, in order.
    const rows = await confirmationsOf(note.note.id);
    expect(rows.map((r) => r.principal)).toEqual([
      "agent:orchestrator:corroborated:chat-vouch-human",
      "human:founder",
    ]);
  });

  it("never vouches for a HUMAN-authored note (there is nothing to vouch for)", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The founder decides pricing experiments, not the crew",
      chatId: "chat-vouch-human-author",
      createdBy: "human:founder",
    });
    expect(await confirmationsOf(note.note.id)).toHaveLength(0);
  });

  it("the operator can still turn it OFF and get strict review back, unchanged", async () => {
    await settings.setAutoConfirmAgentMemory(false);
    const note = await ledger.ingestMemoryNote({
      kind: "gotcha",
      text: "Strict review keeps every mined note waiting for a person",
      chatId: "chat-vouch-off",
      createdBy: "agent:job:job-vouch-5",
    });
    expect(await confirmationsOf(note.note.id)).toHaveLength(0);
    const library = await ledger.listMemoryLibrary({ chatId: "chat-vouch-off" });
    const found = library.notes.find((n) => n.id === note.note.id);
    expect(found!.confirmed).toBe(false);
    expect(found!.confirmedBy).toBeNull();
    // …and the TTL is back, because nobody has vouched for it.
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: note.note.id },
    });
    expect(row?.expiresAt).not.toBeNull();
    await settings.setAutoConfirmAgentMemory(true);
  });

  it("never vouches for an IMPORTED pack note — a foreign workspace is not this crew", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await ledger.ingestMemoryNote(
      {
        kind: "decision",
        text: "An imported claim from somebody else's workspace",
        chatId: "chat-vouch-import",
        trust: "low",
        createdBy: "pack:deadbeef",
        proposalOnly: true,
      },
      { orchestratorConfirm: false }
    );
    expect(await confirmationsOf(note.note.id)).toHaveLength(0);
  });

  // …and it stays refused WITHOUT the caller opting out. `pack:<fingerprint>`
  // parses as an agent (a machine did write it), so "agent-authored" alone would
  // have auto-vouched a foreign workspace's claims into this crew's durable
  // memory the first time a caller forgot the flag.
  it("refuses a pack note STRUCTURALLY, even when the caller forgets the opt-out", async () => {
    await settings.setAutoConfirmAgentMemory(true);
    const note = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "A second imported claim, ingested without the explicit opt-out",
      chatId: "chat-vouch-import-2",
      trust: "low",
      createdBy: "pack:deadbeef",
      proposalOnly: true,
    });
    expect(await confirmationsOf(note.note.id)).toHaveLength(0);
  });
});

// ADR-0027: clones and human text edits are not independent crew proposals and
// therefore cannot manufacture or inherit corroboration.
describe("ADR-0027 corroboration boundaries", () => {
  let settings: typeof import("../src/lib/operator-settings.js");

  beforeAll(async () => {
    settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(true);
  });

  async function vouchOf(noteId: string) {
    const rows = await db.prisma.confirmation.findMany({
      where: { noteId },
      orderBy: { at: "asc" },
    });
    return rows.map((row) => row.principal);
  }

  it("CLONE: an agent's clone is unvouched because cloning is not independent support", async () => {
    const source = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "The CLI version literal is read once at module load",
      chatId: "chat-clone-vouch",
      // ADR-0026: same workspace on the note and the cloning caller, which is what
      // a real dispatch produces. This fixture predated the partition; the clone
      // guard now fences on it.
      workspacePath: process.cwd(),
      createdBy: "agent:job:job-clone-src",
    });
    await ledger.ingestMemoryNote({
      kind: "convention",
      text: "The CLI version literal is read once at module load",
      chatId: "chat-clone-vouch",
      workspacePath: process.cwd(),
      createdBy: "agent:job:job-clone-peer",
    });
    const cloned = await ledger.cloneMemoryNote(source.note.id, {
      tier: "agent",
      chatId: "chat-clone-vouch",
      // ADR-0026: same workspace on the note and the cloning caller, which is what
      // a real dispatch produces. This fixture predated the partition; the clone
      // guard now fences on it.
      workspacePath: process.cwd(),
      principal: "agent:job:job-clone-dst",
      crewVisible: true,
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status !== "cloned") return;
    expect(await vouchOf(cloned.note.id)).toEqual([]);
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: cloned.note.id },
    });
    expect(row?.expiresAt).not.toBeNull();
  });

  it("CLONE: a HUMAN's clone is not vouched — there is nothing to vouch for", async () => {
    const source = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Operator clones inherit the operator, not the coordinator",
      chatId: "chat-clone-human",
      createdBy: "agent:job:job-clone-h",
    });
    const cloned = await ledger.cloneMemoryNote(source.note.id, {
      tier: "operator",
      principal: "human:founder",
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status !== "cloned") return;
    expect(await vouchOf(cloned.note.id)).toEqual([]);
  });

  it("TEXT EDIT: a human rewrite does not inherit the predecessor's crew vouch", async () => {
    const note = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The --version flag prints the pacakge version",
      chatId: "chat-edit-vouch",
      workspacePath: process.cwd(),
      createdBy: "agent:job:job-edit",
    });
    await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The --version flag prints the pacakge version",
      chatId: "chat-edit-vouch",
      workspacePath: process.cwd(),
      createdBy: "agent:job:job-edit-peer",
    });
    expect((await ledger.getMemoryNote(note.note.id))?.confirmedBy).toBe(
      "orchestrator"
    );
    const successor = await ledger.updateMemoryNote(note.note.id, {
      text: "The --version flag prints the package version",
      principal: "human:founder",
    });
    expect(successor).toBeTruthy();
    expect(successor!.id).not.toBe(note.note.id);
    expect(successor!.confirmed).toBe(false);
    expect(successor!.confirmedBy).toBeNull();
    expect(successor!.expiresAt).not.toBeNull();
    expect(await vouchOf(successor!.id)).toEqual([]);
  });

  it("TEXT EDIT: a human confirm in the same request still outranks the vouch", async () => {
    const note = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Budgets reconcile per job, not per turn (draft)",
      chatId: "chat-edit-confirm",
      createdBy: "agent:job:job-edit-2",
    });
    const successor = await ledger.updateMemoryNote(note.note.id, {
      text: "Budgets reconcile once per dispatched job, never per turn",
      confirmed: true,
      principal: "human:founder",
    });
    expect(successor!.confirmed).toBe(true);
    expect(successor!.confirmedBy).toBe("human");
  });

  it("D11: a human rejection binds the claim and blocks later corroboration in that mission", async () => {
    const input = {
      kind: "attempt" as const,
      text: "The cursor permission key might be nested under legacy defaults",
      chatId: "chat-reject-bind",
      workspacePath: process.cwd(),
    };
    const first = await ledger.ingestMemoryNote({
      ...input,
      createdBy: "agent:job:reject-bind-a",
    });
    await ledger.updateMemoryNote(first.note.id, {
      confirmed: false,
      principal: "human:founder",
    });
    await ledger.ingestMemoryNote({
      ...input,
      createdBy: "agent:job:reject-bind-b",
    });
    await ledger.ingestMemoryNote({
      ...input,
      createdBy: "agent:job:reject-bind-c",
    });

    expect((await ledger.getMemoryNote(first.note.id))?.confirmedBy).toBeNull();
    expect(
      await db.prisma.memoryRejectBind.count({
        where: { noteId: first.note.id },
      })
    ).toBe(1);
    expect(
      (await vouchOf(first.note.id)).filter((principal) =>
        principal.startsWith("agent:orchestrator:")
      )
    ).toEqual([]);
  });

  // F10 — "a human decision wins in BOTH directions" has to survive a human
  // REJECT, not only a human confirm. A reject stores "nobody vouches", which is
  // shape-identical to "nobody has decided yet", so a later orchestrator row
  // used to re-vouch a note the operator had just killed. Unreachable today
  // (vouches mint only at creation); pinned because the invariant is the
  // contract, and the next path that vouches later would inherit the hole.
  it("REJECT then VOUCH: an orchestrator can never re-vouch what a human rejected", async () => {
    const note = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "A guess the operator looked at and threw out",
      chatId: "chat-reject-vouch",
      createdBy: "agent:job:job-reject",
    });
    // The human rejects it…
    await db.prisma.confirmation.create({
      data: {
        noteId: note.note.id,
        principal: "human:founder",
        decision: "reject",
      },
    });
    // …and a LATER orchestrator confirm arrives on the same note.
    await db.prisma.confirmation.create({
      data: {
        noteId: note.note.id,
        principal: ledger.orchestratorConfirmingPrincipal("chat-reject-vouch"),
        decision: "confirm",
      },
    });
    const library = await ledger.listMemoryLibrary({
      chatId: "chat-reject-vouch",
    });
    const found = library.notes.find((row) => row.id === note.note.id);
    expect(found).toBeTruthy();
    // The operator's kill stands: nobody vouches, so it is back in the queue.
    expect(found!.confirmedBy).toBeNull();
    expect(found!.confirmed).toBe(false);
    const queue = await ledger.listMemoryLibrary({
      chatId: "chat-reject-vouch",
      confirmed: "unvouched",
    });
    expect(queue.notes.map((row) => row.id)).toContain(note.note.id);
  });

  it("TEXT EDIT: a HUMAN-authored note's successor is still never vouched", async () => {
    const note = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The founder decides pricing, draft wording",
      chatId: "chat-edit-human",
      createdBy: "human:founder",
    });
    const successor = await ledger.updateMemoryNote(note.note.id, {
      text: "The founder decides pricing experiments, not the crew",
    });
    expect(await vouchOf(successor!.id)).toEqual([]);
  });
});

// P0-2 — the QUEUE surface. `unconfirmed` is an honest label for the human tier
// and a wrong one for a review queue: it counts settled, MUON-approved crew
// memory as a debt the operator owes, which is what kept the founder confirming
// notes MUON had already approved.
describe("P0-2 review-queue filter (`unvouched`)", () => {
  let settings: typeof import("../src/lib/operator-settings.js");
  let vouchedId: string;
  let unvouchedId: string;

  beforeAll(async () => {
    settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(true);
    vouchedId = (
      await ledger.ingestMemoryNote({
        kind: "convention",
        text: "Vouched: the crew already works from this one",
        chatId: "chat-queue",
        workspacePath: process.cwd(),
        createdBy: "agent:job:job-queue-a",
      })
    ).note.id;
    await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Vouched: the crew already works from this one",
      chatId: "chat-queue",
      workspacePath: process.cwd(),
      createdBy: "agent:job:job-queue-peer",
    });
    await settings.setAutoConfirmAgentMemory(false);
    unvouchedId = (
      await ledger.ingestMemoryNote({
        kind: "question",
        text: "Unvouched: nobody has looked at this one at all",
        chatId: "chat-queue",
        createdBy: "agent:job:job-queue-b",
      })
    ).note.id;
    await settings.setAutoConfirmAgentMemory(true);
  });

  it("counts and lists ONLY what nobody has vouched for", async () => {
    const queue = await ledger.listMemoryLibrary({
      chatId: "chat-queue",
      confirmed: "unvouched",
    });
    expect(queue.notes.map((note) => note.id)).toEqual([unvouchedId]);
    // `total` is the DEBT COUNTER every badge reads; it must agree with the page.
    expect(queue.total).toBe(1);
  });

  it("keeps `unconfirmed` literal — the human tier, vouched notes included", async () => {
    const humanTier = await ledger.listMemoryLibrary({
      chatId: "chat-queue",
      confirmed: "unconfirmed",
    });
    const ids = humanTier.notes.map((note) => note.id);
    expect(ids).toContain(vouchedId);
    expect(ids).toContain(unvouchedId);
  });

  // F12 — the fallback direction is right (fail closed: nobody vouched), but it
  // narrows every crew brief on that read to human-confirmed-only memory. A
  // silent narrowing looks exactly like agents that have stopped sharing
  // context, with nothing anywhere to point at.
  it("SAYS SO when a broken confirmation lookup drops the crew's vouches", async () => {
    const logged: string[] = [];
    const spyLog = vi
      .spyOn(console, "error")
      .mockImplementation((message?: unknown) => {
        logged.push(String(message));
      });
    // Manual save/restore, NOT vi.spyOn().mockRestore(): Prisma builds its
    // delegates dynamically, so restoring a spy on one deletes the method
    // outright and every later test in the file dies on it.
    const realFindMany = db.prisma.confirmation.findMany;
    const delegate = db.prisma.confirmation as unknown as Record<
      string,
      unknown
    >;
    delegate.findMany = () =>
      Promise.reject(new Error("database is locked"));
    try {
      const annotated = await ledger.applyMemoryExpiry([{ id: vouchedId }]);
      // Fail-closed on the CLAIM, open on expiry — nothing is dropped…
      expect(annotated).toHaveLength(1);
      expect(annotated[0]!.confirmedBy).toBeNull();
      expect(annotated[0]!.expired).toBe(false);
    } finally {
      delegate.findMany = realFindMany;
      spyLog.mockRestore();
    }
    // …and the degradation is visible instead of silent.
    expect(
      logged.some(
        (line) =>
          line.includes("[memory] confirmation lookup failed") &&
          line.includes("database is locked")
      )
    ).toBe(true);
    // COORDINATES ONLY: never a note id, never note text.
    expect(logged.some((line) => line.includes(vouchedId))).toBe(false);
  });

  it("a human confirm empties the queue rather than adding to it", async () => {
    await ledger.updateMemoryNote(unvouchedId, {
      confirmed: true,
      principal: "human:founder",
    });
    const queue = await ledger.listMemoryLibrary({
      chatId: "chat-queue",
      confirmed: "unvouched",
    });
    expect(queue.total).toBe(0);
    expect(queue.notes).toHaveLength(0);
  });
});
