import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";

let graph: MuonGraph;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-graph-"));
  graph = new MuonGraph(join(dir, "test.lbug"));
  await graph.init();
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MuonGraph (embedded Ladybug)", () => {
  it("mirrors lanes, tasks, assignments and computes outcome stats", async () => {
    await graph.upsertLane({ id: "lane-cx", key: "codex", name: "Codex" });
    await graph.upsertLane({ id: "lane-cc", key: "claude-code", name: "Claude Code" });
    await graph.upsertTask({ id: "task-1", title: "Ship", status: "in_progress" });

    await graph.recordAssignment({
      assignmentId: "a1",
      laneId: "lane-cx",
      taskId: "task-1",
      createdAt: "2026-07-09T01:00:00.000Z",
    });
    await graph.recordEvent({
      laneId: "lane-cx",
      taskId: "task-1",
      kind: "task.completed",
      timestamp: "2026-07-09T01:01:00.000Z",
    });

    const stats = await graph.laneOutcomeStats();
    const codex = stats.find((s) => s.laneId === "lane-cx");
    const claude = stats.find((s) => s.laneId === "lane-cc");

    expect(codex?.assignments).toBe(1);
    expect(codex?.completions).toBe(1);
    expect(codex?.averageDurationMs).toBe(60_000);
    expect(claude?.assignments).toBe(0);

    const suggestions = await graph.suggestLanes();
    expect(suggestions[0]?.laneId).toBe("lane-cx");
    expect(suggestions[0]?.reason).toContain("1/1 assignments completed");
  });

  it("stores, searches, recalls memory notes", async () => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "Use fuzzy command palette instead of colon commands",
      taskId: "task-1",
      modules: ["apps/tui/src/lib/palette.ts"],
      topics: ["tui", "ux"],
      createdBy: "human",
    });
    expect(note.id).toMatch(/^mem-/);
    expect(note.trust).toBe("medium");

    const found = await graph.searchMemory("palette fuzzy");
    expect(found.some((n) => n.id === note.id)).toBe(true);

    const byTask = await graph.recallMemory({ taskId: "task-1" });
    expect(byTask.some((n) => n.id === note.id)).toBe(true);

    const byModule = await graph.recallMemory({
      module: "apps/tui/src/lib/palette.ts",
    });
    expect(byModule.some((n) => n.id === note.id)).toBe(true);

    const byTopic = await graph.recallMemory({ topic: "ux" });
    expect(byTopic.some((n) => n.id === note.id)).toBe(true);
  });

  it("confirms, edits, and rejects notes with traceable removal", async () => {
    const note = await graph.addMemoryNote({
      kind: "constraint",
      text: "Never store vendor tokens",
      createdBy: "human",
    });

    const confirmed = await graph.updateMemoryNote(note.id, { confirmed: true });
    expect(confirmed?.confirmed).toBe(true);

    const rejected = await graph.updateMemoryNote(note.id, { status: "rejected" });
    expect(rejected?.status).toBe("rejected");

    // Rejected notes disappear from recall but the record remains readable.
    const recall = await graph.recallMemory({});
    expect(recall.some((n) => n.id === note.id)).toBe(false);
    const stillThere = await graph.getMemoryNote(note.id);
    expect(stillThere?.status).toBe("rejected");
  });

  it("marks anchored notes stale when their module is touched later", async () => {
    const note = await graph.addMemoryNote({
      kind: "convention",
      text: "Keep zod schemas at API boundaries",
      modules: ["backend/src/routes/tasks.ts"],
      createdBy: "human",
    });
    expect(note.stale).toBe(false);

    await graph.touchModules(
      ["backend/src/routes/tasks.ts"],
      new Date(Date.now() + 1000).toISOString()
    );

    const after = await graph.getMemoryNote(note.id);
    expect(after?.stale).toBe(true);
  });

  it("returns null when updating a missing note", async () => {
    expect(await graph.updateMemoryNote("mem-missing", { confirmed: true })).toBeNull();
  });

  it("text edits supersede: history is kept, new note returned", async () => {
    const original = await graph.addMemoryNote({
      kind: "decision",
      text: "Use port 3000 for the frontend",
      createdBy: "human",
    });

    const successor = await graph.updateMemoryNote(original.id, {
      text: "Use port 3050 for the frontend",
    });

    expect(successor).not.toBeNull();
    expect(successor!.id).not.toBe(original.id);
    expect(successor!.text).toContain("3050");
    expect(successor!.status).toBe("active");

    const old = await graph.getMemoryNote(original.id);
    expect(old?.invalidatedAt).toBeTruthy();
    expect(old?.invalidatedBy).toBe("superseded");
    expect(old?.supersededBy).toBe(successor!.id);
    // Old note no longer surfaces in recall, but the record remains.
    const recall = await graph.recallMemory({});
    expect(recall.some((n) => n.id === original.id)).toBe(false);
  });

  it("rejection records temporal invalidation", async () => {
    const note = await graph.addMemoryNote({
      kind: "attempt",
      text: "Tried the flaky approach",
      createdBy: "codex",
    });
    const rejected = await graph.updateMemoryNote(note.id, { status: "rejected" });
    expect(rejected?.invalidatedAt).toBeTruthy();
    expect(rejected?.invalidatedBy).toBe("human");
  });

  it("mirrors approvals with GATED_BY and touch records TOUCHED edges", async () => {
    await graph.upsertTask({ id: "task-2", title: "Gated", status: "review" });
    await graph.recordApproval({
      approvalId: "ap-1",
      taskId: "task-2",
      kind: "merge",
      status: "pending",
      createdAt: "2026-07-09T02:00:00.000Z",
    });
    await graph.recordApproval({
      approvalId: "ap-1",
      taskId: "task-2",
      kind: "merge",
      status: "approved",
      createdAt: "2026-07-09T02:00:00.000Z",
      decidedAt: "2026-07-09T02:05:00.000Z",
    });

    await graph.touchModules(
      ["src/gated.ts"],
      "2026-07-09T02:01:00.000Z",
      "task-2"
    );

    // familiarity: lane that worked on task-2 knows src/gated.ts
    await graph.upsertLane({ id: "lane-cc2", key: "claude2", name: "Claude Two" });
    await graph.recordAssignment({
      assignmentId: "a-fam",
      laneId: "lane-cc2",
      taskId: "task-2",
      createdAt: "2026-07-09T02:00:30.000Z",
    });

    const stats = await graph.laneOutcomeStats("task-2");
    const lane = stats.find((s) => s.laneId === "lane-cc2");
    expect(lane?.modulesTouched).toBe(1);
    expect(lane?.familiarModules).toBe(1);

    const suggestions = await graph.suggestLanes("task-2");
    const suggestion = suggestions.find((s) => s.laneId === "lane-cc2");
    expect(suggestion?.reason).toContain("knows 1 of this task's modules");
  });

  it("relatedToTask recalls notes via task, modules, and lanes", async () => {
    await graph.upsertTask({ id: "task-3", title: "Recall", status: "in_progress" });
    await graph.upsertLane({ id: "lane-r", key: "recall-lane", name: "Recall Lane" });
    await graph.recordAssignment({
      assignmentId: "a-r",
      laneId: "lane-r",
      taskId: "task-3",
      createdAt: "2026-07-09T03:00:00.000Z",
    });
    await graph.touchModules(["src/recall.ts"], "2026-07-09T03:01:00.000Z", "task-3");

    const direct = await graph.addMemoryNote({
      kind: "decision",
      text: "Direct note about the recall task",
      taskId: "task-3",
      createdBy: "human",
    });
    const viaModule = await graph.addMemoryNote({
      kind: "convention",
      text: "Module convention for recall.ts",
      modules: ["src/recall.ts"],
      createdBy: "human",
    });
    const viaLane = await graph.addMemoryNote({
      kind: "attempt",
      text: "Lane attempt note",
      laneId: "lane-r",
      createdBy: "recall-lane",
    });

    const related = await graph.relatedToTask("task-3");
    const ids = related.map((n) => n.id);
    expect(ids).toContain(direct.id);
    expect(ids).toContain(viaModule.id);
    expect(ids).toContain(viaLane.id);
  });

  it("relatedToTask governedOnly excludes an ungoverned note reachable via traversal (KG-6 F3)", async () => {
    await graph.upsertTask({ id: "task-gate", title: "Gate", status: "in_progress" });
    // A governed (confirmed) note and a hostile low-trust unconfirmed note, both
    // reachable via the task traversal (ABOUT_TASK).
    const governed = await graph.addMemoryNote({
      kind: "decision",
      text: "Governed decision reachable via the gate task traversal",
      taskId: "task-gate",
      createdBy: "human",
    });
    await graph.updateMemoryNote(governed.id, { confirmed: true });
    const hostile = await graph.addMemoryNote({
      kind: "attempt",
      text: "Hostile low-trust claim reachable via the gate task traversal",
      taskId: "task-gate",
      trust: "low",
      createdBy: "agent:intruder",
    });

    // General traversal sees BOTH (unchanged).
    const all = (await graph.relatedToTask("task-gate")).map((n) => n.id);
    expect(all).toContain(governed.id);
    expect(all).toContain(hostile.id);

    // Gated traversal (what P2.5's preEditContext composes) excludes the hostile
    // ungoverned note, the gate applies to the traversal path too (F3).
    const gated = (
      await graph.relatedToTask("task-gate", 50, { governedOnly: true })
    ).map((n) => n.id);
    expect(gated).toContain(governed.id);
    expect(gated).not.toContain(hostile.id);
  });

  it("mirrors workflow runs and links step tasks via STEP_OF", async () => {
    await graph.upsertTask({ id: "task-wf", title: "Step task", status: "backlog" });
    await graph.recordWorkflowRun({
      runId: "run-1",
      templateKey: "bugfix",
      status: "proposed",
      createdAt: "2026-07-10T01:00:00.000Z",
    });
    await graph.linkTaskToWorkflowRun({
      taskId: "task-wf",
      runId: "run-1",
      stepKey: "reproduce",
    });
    // Re-recording updates status through the same MERGE (mirror on apply).
    await graph.recordWorkflowRun({
      runId: "run-1",
      templateKey: "bugfix",
      status: "applied",
      createdAt: "2026-07-10T01:00:00.000Z",
    });
  });

  it("scores topic overlap between request text and lane note topics", async () => {
    await graph.upsertLane({ id: "lane-topic", key: "topic-lane", name: "Topic Lane" });
    await graph.addMemoryNote({
      kind: "convention",
      text: "Rate limiting reads the session TTL from config",
      laneId: "lane-topic",
      topics: ["rate-limiting", "auth"],
      createdBy: "human",
    });

    const suggestions = await graph.suggestLanes(
      undefined,
      "fix the broken rate-limiting on login auth"
    );
    const topicLane = suggestions.find((s) => s.laneId === "lane-topic");
    expect(topicLane?.reason).toContain("memory topic(s) match the request");

    const withoutText = await graph.suggestLanes();
    const plain = withoutText.find((s) => s.laneId === "lane-topic");
    expect(plain?.reason ?? "").not.toContain("memory topic(s)");
  });

  it("ingestMemoryNote dedups, supersedes, and flags conflicts (v3)", async () => {
    await graph.upsertTask({ id: "task-ing", title: "Ingest", status: "in_progress" });

    const first = await graph.ingestMemoryNote({
      kind: "decision",
      text: "Use the RateLimiter reading session TTL from config",
      taskId: "task-ing",
      modules: ["src/auth/limiter.ts"],
      createdBy: "human",
    });
    expect(first.action).toBe("inserted");

    // Near-identical, same anchor → duplicate (NOOP), nothing new created.
    const dup = await graph.ingestMemoryNote({
      kind: "decision",
      text: "Use the RateLimiter reading session TTL from config",
      taskId: "task-ing",
      modules: ["src/auth/limiter.ts"],
      createdBy: "codex",
    });
    expect(dup.action).toBe("duplicate");
    expect(dup.note.id).toBe(first.note.id);

    // A rewrite (not a strict token extension) → supersede.
    const refined = await graph.ingestMemoryNote({
      kind: "decision",
      text: "Configure the RateLimiter from config for session TTL",
      taskId: "task-ing",
      modules: ["src/auth/limiter.ts"],
      createdBy: "human",
    });
    expect(refined.action).toBe("superseded");
    expect(refined.relatedNoteId).toBe(first.note.id);
    const old = await graph.getMemoryNote(first.note.id);
    expect(old?.status).toBe("rejected");
    expect(old?.supersededBy).toBe(refined.note.id);

    // A contradicting constraint on the same module → conflict, both active.
    await graph.ingestMemoryNote({
      kind: "constraint",
      text: "The limiter must read TTL from config",
      modules: ["src/auth/conflict.ts"],
      createdBy: "human",
    });
    const clash = await graph.ingestMemoryNote({
      kind: "constraint",
      text: "The limiter must not read TTL from config",
      modules: ["src/auth/conflict.ts"],
      createdBy: "codex",
    });
    expect(clash.action).toBe("conflict");
    expect(clash.note.conflictsWith).toBeTruthy();
  });

  it("searchMemory reranks by salience but does NOT reinforce on read (KG-2)", async () => {
    const confirmed = await graph.addMemoryNote({
      kind: "convention",
      text: "prefer vitest for unit tests in this repo",
      topics: ["testing"],
      trust: "high",
      createdBy: "human",
    });
    await graph.updateMemoryNote(confirmed.id, { confirmed: true });
    await graph.addMemoryNote({
      kind: "attempt",
      text: "tried jest for unit tests, dropped it",
      topics: ["testing"],
      trust: "low",
      createdBy: "codex",
    });

    const before = await graph.getMemoryNote(confirmed.id);
    expect(before?.accessCount).toBe(0);

    const results = await graph.searchMemory("unit tests");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Confirmed high-trust convention outranks the low-trust attempt.
    const confirmedRank = results.findIndex((n) => n.id === confirmed.id);
    const attemptRank = results.findIndex((n) => n.text.includes("jest"));
    expect(confirmedRank).toBeGreaterThanOrEqual(0);
    expect(confirmedRank).toBeLessThan(attemptRank);

    // Reinforcement is OFF the read path: a search NEVER mutates accessCount,
    // even after any fire-and-forget tick would have landed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterRead = await graph.getMemoryNote(confirmed.id);
    expect(afterRead?.accessCount).toBe(0);
    // Nor did it silently buffer a used-signal, retrieval ≠ use.
    expect(graph.pendingReinforcementCount()).toBe(0);
  });

  it("reinforces only on an EXPLICIT used-signal, buffered then flushed (KG-2)", async () => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "explicit used-signal reinforcement note",
      topics: ["reinforce"],
      createdBy: "human",
    });

    // An explicit "used" signal buffers in memory, no synchronous write.
    graph.markMemoryUsed([note.id, note.id]); // cited twice this window
    expect(graph.pendingReinforcementCount()).toBe(1);
    const stillZero = await graph.getMemoryNote(note.id);
    expect(stillZero?.accessCount).toBe(0);

    // Flush (timer/shutdown) drains the buffer into the graph node.
    const applied = await graph.flushReinforcement();
    expect(applied.find((a) => a.noteId === note.id)?.accessCount).toBe(2);
    expect(graph.pendingReinforcementCount()).toBe(0);
    const reinforced = await graph.getMemoryNote(note.id);
    expect(reinforced?.accessCount).toBe(2);
    expect(reinforced?.lastAccessedAt).toBeTruthy();
  });

  it("treats an untrusted FTS search query as literal text, no injection/breakout (L2)", async () => {
    // GET /api/memory/search?q= is agent-tier reachable, so `q` is UNTRUSTED. The
    // FTS candidate query binds it as a $param (never string-interpolates it), so a
    // quote / backslash / statement-terminator is matched as FTS text, never Cypher.
    const marker = "zorptokeninjcanary";
    const seeded = await graph.addMemoryNote({
      kind: "decision",
      text: `${marker} sandbox breakout guard note`,
      topics: ["security"],
      createdBy: "human",
    });

    // Behaviour preserved: a plain query still matches (FTS path when enabled,
    // lexical fallback otherwise, both must find the seeded note).
    const plain = await graph.searchMemory(marker);
    expect(plain.some((n) => n.id === seeded.id)).toBe(true);

    // Quote, backslash, escaped-quote, and Cypher-injection attempts must degrade
    // to SAFE results (the real hit or none), never throw, never a second
    // statement, never a synthetic "RETURN 1" row.
    const hostile = [
      `${marker}'`,
      `${marker}\\`,
      `${marker}\\'`,
      `${marker}' RETURN 1 //`,
      `' RETURN 1 //`,
      `'; MATCH (n) DETACH DELETE n //`,
    ];
    for (const q of hostile) {
      const res = await graph.searchMemory(q);
      // No breakout: every returned row is a genuine MemoryNote record.
      for (const n of res) {
        expect(n.id).toMatch(/^mem-/);
        expect(typeof n.text).toBe("string");
      }
    }

    // The store is intact, the DETACH DELETE injection never executed.
    const stillThere = await graph.getMemoryNote(seeded.id);
    expect(stillThere?.id).toBe(seeded.id);
  });
});

// ADR-0012, symbol-level anchoring at the graph layer: the scalar `n.symbols`
// recall (parity with modules, inheriting the KG-6 gate), the module
// auto-derivation, and the Symbol node + ABOUT_SYMBOL projection.
async function rawQuery(
  g: MuonGraph,
  statement: string
): Promise<Record<string, unknown>[]> {
  return (
    g as unknown as { query(s: string): Promise<Record<string, unknown>[]> }
  ).query(statement);
}

describe("MuonGraph, symbol anchors (ADR-0012)", () => {
  it("a symbol-anchored note is AUTO-anchored to its module; recall by symbol AND by module both work", async () => {
    const sym = "src/pay/charge.ts#applyCharge";
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "applyCharge is idempotent by request key",
      symbols: [sym],
      trust: "high",
      createdBy: "human",
    });
    // The module is auto-derived from the symbol id prefix (the degrade guarantee).
    expect(note.symbols).toEqual([sym]);
    expect(note.modules).toEqual(["src/pay/charge.ts"]);

    // Recall by SYMBOL (the new scalar path) finds it.
    const bySymbol = await graph.recallMemory({ symbol: sym });
    expect(bySymbol.map((n) => n.id)).toContain(note.id);
    expect(bySymbol.find((n) => n.id === note.id)?.symbols).toEqual([sym]);
    // Recall by the AUTO-DERIVED module finds it too.
    const byModule = await graph.recallMemory({ module: "src/pay/charge.ts" });
    expect(byModule.map((n) => n.id)).toContain(note.id);
  });

  it("KG-6 gate applies to symbol recall: an UNCONFIRMED symbol-anchored note is EXCLUDED; a confirmed one is INCLUDED", async () => {
    const sym = "src/gate/sym.ts#gated";
    const unconfirmed = await graph.addMemoryNote({
      kind: "attempt",
      text: "unconfirmed symbol-anchored note",
      symbols: [sym],
      trust: "low",
      createdBy: "agent:x",
    });
    const confirmed = await graph.addMemoryNote({
      kind: "decision",
      text: "confirmed symbol-anchored note",
      symbols: [sym],
      trust: "high",
      createdBy: "human",
    });
    await graph.updateMemoryNote(confirmed.id, { confirmed: true });

    // General recall sees both; the GATE (confirmed-only) sees only the confirmed.
    const general = await graph.recallMemory({ symbol: sym });
    expect(general.map((n) => n.id)).toEqual(
      expect.arrayContaining([unconfirmed.id, confirmed.id])
    );
    const gated = await graph.recallForGate({ symbol: sym });
    expect(gated.map((n) => n.id)).toContain(confirmed.id);
    expect(gated.map((n) => n.id)).not.toContain(unconfirmed.id);
  });

  it("projects a Symbol node + ABOUT_SYMBOL edge (mirroring Module/ANCHORED_TO)", async () => {
    const sym = "src/proj/node.ts#projected";
    const note = await graph.addMemoryNote({
      kind: "convention",
      text: "projected symbol note",
      symbols: [sym],
      createdBy: "human",
    });
    const symbolNode = await rawQuery(
      graph,
      `MATCH (s:Symbol {id: '${sym}'}) RETURN s.id AS id, s.module AS module, s.name AS name`
    );
    expect(symbolNode).toHaveLength(1);
    expect(symbolNode[0]!.module).toBe("src/proj/node.ts");
    expect(symbolNode[0]!.name).toBe("projected");
    const edge = await rawQuery(
      graph,
      `MATCH (n:MemoryNote {id: '${note.id}'})-[:ABOUT_SYMBOL]->(s:Symbol) RETURN s.id AS id`
    );
    expect(edge.map((r) => r.id)).toContain(sym);
  });
});

// D2 option B (docs/design/memory-index-decisions.md): `symbolUid` is a
// commit-stamped CACHE, not a foreign key. `cacheSymbolUid` MERGEs the Symbol
// node and stamps {symbolUid, symbolUidAt}; `readSymbolUidCache` is the
// reader-owned lazy read that treats a `graphCommit` mismatch as a MISS.
describe("MuonGraph, symbolUid cache (D2 option B)", () => {
  it("caches a GitNexus uid against a commit and reads it back on an exact commit match", async () => {
    const localId = "src/auth/guard.ts#authorize";
    await graph.cacheSymbolUid(
      localId,
      "Function:src/auth/guard.ts:authorize",
      "commit-a"
    );
    await expect(
      graph.readSymbolUidCache(localId, "commit-a")
    ).resolves.toBe("Function:src/auth/guard.ts:authorize");
  });

  it("treats a graphCommit mismatch as a cache MISS, not a stale hit", async () => {
    const localId = "src/auth/session.ts#readSession";
    await graph.cacheSymbolUid(
      localId,
      "Function:src/auth/session.ts:readSession",
      "commit-a"
    );
    await expect(
      graph.readSymbolUidCache(localId, "commit-b")
    ).resolves.toBeUndefined();
    // The original commit still hits.
    await expect(
      graph.readSymbolUidCache(localId, "commit-a")
    ).resolves.toBe("Function:src/auth/session.ts:readSession");
  });

  it("a never-cached symbol id is a miss, not an error", async () => {
    await expect(
      graph.readSymbolUidCache("src/never/cached.ts#nope", "commit-a")
    ).resolves.toBeUndefined();
  });

  it("re-caching under a later commit overwrites the earlier stamp (idempotent, latest wins)", async () => {
    const localId = "src/pay/charge.ts#applyCharge";
    await graph.cacheSymbolUid(
      localId,
      "Function:src/pay/charge.ts:applyCharge",
      "commit-a"
    );
    await graph.cacheSymbolUid(
      localId,
      "Function:src/pay/charge.ts:applyCharge#2",
      "commit-b"
    );
    await expect(
      graph.readSymbolUidCache(localId, "commit-a")
    ).resolves.toBeUndefined();
    await expect(
      graph.readSymbolUidCache(localId, "commit-b")
    ).resolves.toBe("Function:src/pay/charge.ts:applyCharge#2");
  });

  it("shares the Symbol node with the memory anchor projection (module/name derived identically)", async () => {
    const localId = "src/shared/node.ts#shared";
    await graph.cacheSymbolUid(
      localId,
      "Function:src/shared/node.ts:shared",
      "commit-a"
    );
    const rows = await rawQuery(
      graph,
      `MATCH (s:Symbol {id: '${localId}'}) RETURN s.module AS module, s.name AS name`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("src/shared/node.ts");
    expect(rows[0]!.name).toBe("shared");
  });
});

// KG-8 (ADR-0014), the REBUILDABLE recent-activity projection at the graph layer:
// `recordActivity` MERGEs ACTED_ON(_MODULE) edges (idempotent, coordinate-only) and
// `recentActivityOn` reads them within a bounded window, symbol-preferred, self-
// excluded. Real embedded Ladybug (no mocks); a fresh store so windows are exact.
describe("MuonGraph, recent activity projection (KG-8, ADR-0014)", () => {
  let g: MuonGraph;
  let d: string;
  const SYM = "src/pay/charge.ts#charge";
  const MOD = "src/pay/charge.ts";
  const OLD = "2026-07-01T00:00:00.000Z"; // before the window floor
  const NEW = "2026-07-12T00:00:00.000Z"; // inside the window
  const SINCE = "2026-07-11T00:00:00.000Z"; // 24h floor for a "now" of 2026-07-12

  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), "muon-kg8-"));
    g = new MuonGraph(join(d, "kg8.lbug"));
    await g.init();
  });
  afterAll(async () => {
    await g.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("surfaces a WITHIN-window symbol touch as a coordinate-only `recent` row", async () => {
    await g.recordActivity({
      taskId: "task-A",
      laneId: "lane-codex-0",
      vendor: "codex",
      jobId: "job-A",
      at: NEW,
      symbols: [SYM],
    });
    const recent = await g.recentActivityOn({ symbols: [SYM], modules: [MOD] }, SINCE);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual({
      laneId: "lane-codex-0",
      vendor: "codex",
      taskId: "task-A",
      jobId: "job-A",
      kind: "editing",
      anchor: SYM,
      anchorKind: "symbol",
      at: NEW,
      state: "recent",
    });
    // COORDINATES ONLY: every key is in the allowlist, no content field exists.
    const ALLOW = new Set([
      "laneId",
      "vendor",
      "taskId",
      "jobId",
      "kind",
      "anchor",
      "anchorKind",
      "at",
      "state",
    ]);
    for (const key of Object.keys(recent[0]!)) {
      expect(ALLOW.has(key)).toBe(true);
    }
  });

  it("EXCLUDES a touch OLDER than the window floor (bounded window)", async () => {
    await g.recordActivity({
      taskId: "task-old",
      laneId: "lane-cc-0",
      vendor: "claude-code",
      jobId: "job-old",
      at: OLD,
      modules: ["src/old/win.ts"],
    });
    const recent = await g.recentActivityOn(
      { symbols: [], modules: ["src/old/win.ts"] },
      SINCE
    );
    expect(recent).toEqual([]);
  });

  it("does NOT surface a recent touch on a NON-matching anchor", async () => {
    await g.recordActivity({
      taskId: "task-other",
      laneId: "lane-cx-1",
      vendor: "codex",
      jobId: "job-other",
      at: NEW,
      symbols: ["src/unrelated/z.ts#zap"],
    });
    const recent = await g.recentActivityOn(
      { symbols: ["src/pay/charge.ts#charge"], modules: ["src/pay/charge.ts"] },
      SINCE
    );
    expect(recent.map((r) => r.taskId)).not.toContain("task-other");
  });

  it("PREFERS a symbol collision over a module one for the same task (finer anchor)", async () => {
    await g.recordActivity({
      taskId: "task-both",
      laneId: "lane-cx-2",
      vendor: "codex",
      jobId: "job-both",
      at: NEW,
      symbols: ["src/both/f.ts#run"],
      modules: ["src/both/f.ts"],
    });
    const recent = await g.recentActivityOn(
      { symbols: ["src/both/f.ts#run"], modules: ["src/both/f.ts"] },
      SINCE
    );
    const forTask = recent.filter((r) => r.taskId === "task-both");
    expect(forTask).toHaveLength(1);
    expect(forTask[0]).toMatchObject({
      anchor: "src/both/f.ts#run",
      anchorKind: "symbol",
      kind: "editing",
    });
  });

  it("SELF-EXCLUSION applies to recent (excludeTaskId / excludeJobId)", async () => {
    const anchors = { symbols: ["src/self/s.ts#m"], modules: [] as string[] };
    await g.recordActivity({
      taskId: "task-self",
      laneId: "lane-cx-3",
      vendor: "codex",
      jobId: "job-self",
      at: NEW,
      symbols: anchors.symbols,
    });
    expect(
      await g.recentActivityOn(anchors, SINCE, { taskId: "task-self" })
    ).toEqual([]);
    expect(
      await g.recentActivityOn(anchors, SINCE, { jobId: "job-self" })
    ).toEqual([]);
    // Without the exclusion it surfaces, proving the filter is what removed it.
    expect(await g.recentActivityOn(anchors, SINCE)).toHaveLength(1);
  });

  it("MERGE is idempotent + monotonic-latest: re-record advances `at`, never duplicates", async () => {
    const anchors = { symbols: ["src/idem/i.ts#go"], modules: [] as string[] };
    await g.recordActivity({
      taskId: "task-idem",
      laneId: "lane-cx-4",
      vendor: "codex",
      jobId: "job-idem-1",
      at: "2026-07-11T06:00:00.000Z",
      symbols: anchors.symbols,
    });
    await g.recordActivity({
      taskId: "task-idem",
      laneId: "lane-cx-4",
      vendor: "codex",
      jobId: "job-idem-2",
      at: NEW,
      symbols: anchors.symbols,
    });
    const recent = await g.recentActivityOn(anchors, SINCE);
    const forTask = recent.filter((r) => r.taskId === "task-idem");
    expect(forTask).toHaveLength(1); // one edge, not two
    expect(forTask[0]!.at).toBe(NEW); // advanced to the latest touch
    expect(forTask[0]!.jobId).toBe("job-idem-2");
  });
});
