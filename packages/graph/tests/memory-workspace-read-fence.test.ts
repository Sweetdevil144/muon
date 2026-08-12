import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";

// ── ADR-0026 §11 STEP 3 — the READ path, at the graph layer ──────────────────
//
// §5 requires the fence be testable IN BOTH DIRECTIONS, and that is the whole
// reason it is a hard gate rather than a ranking preference: "ranked lower" has no
// failing case. Every test below therefore asserts a pair — the foreign-workspace
// note is NOT returned AND the same-workspace note still IS.
//
// The corpus is deliberately built so that the ONLY difference between the two
// notes an assertion compares is `workspacePath`: same module anchor, same chat,
// same trust, same author, near-identical text. That is the §1 construction — repo
// A's `src/index.ts` and repo B's are the same `list_contains(n.modules, $module)`
// and nothing else told them apart.
//
// Five candidate paths are covered because the predicate has to reach all of them:
// the lexical/as-of scan and `recallMemory` through `visibilityClauses`; FTS and
// semantic candidates through the post-fusion `partitionFilter`; `relatedToTask`
// through its own three traversal WHEREs; the traversal surfaces through
// `memoryTraversalNode`; and `memoryAnalytics`, whose coordinate-only answer is
// still an answer about a corpus.

const MOD = "src/pay/charge.ts";
const WORKSPACE_A = "/Users/dev/SWE/repo-a";
const WORKSPACE_B = "/Users/dev/SWE/repo-b";
const CHAT = "chat-shared";

let graph: MuonGraph;
let dir: string;
let inA: string;
let inB: string;
let unassigned: string;
let globalInB: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-ws-read-"));
  // FTS off: the fence must hold on the lexical + semantic paths a container/CI
  // host actually runs. The FTS path has its own coverage via `partitionFilter`,
  // which is the same function the semantic path goes through.
  graph = new MuonGraph(join(dir, "test.lbug"), { disableFts: true });
  await graph.init();

  const add = async (
    text: string,
    workspacePath: string | undefined,
    extra: { scope?: string; confirmed?: boolean } = {}
  ) => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text,
      modules: [MOD],
      topics: ["payments"],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
      ...(workspacePath ? { workspacePath } : {}),
      ...(extra.scope ? { scope: extra.scope } : {}),
    });
    if (extra.confirmed) {
      await graph.updateMemoryNote(note.id, { confirmed: true });
    }
    return note.id;
  };

  inA = await add("Charges are idempotent by request key in repo A", WORKSPACE_A);
  inB = await add("Charges are idempotent by request key in repo B", WORKSPACE_B);
  unassigned = await add("Charges are idempotent by request key, unassigned", undefined);
  // §6: `scope:"global"` + human-confirmed is the ONLY cross-chat escape hatch.
  // The workspace term is ANDed OUTSIDE it, so this must not reach repo A either.
  globalInB = await add(
    "Charges are idempotent by request key, promoted global in repo B",
    WORKSPACE_B,
    { scope: "global", confirmed: true }
  );
});

afterAll(async () => {
  await graph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ADR-0026 step 3: recallMemory is fenced, in both directions", () => {
  it("returns the SAME workspace's module-anchored note and not the other's", async () => {
    const ids = (
      await graph.recallMemory({ module: MOD, workspacePath: WORKSPACE_A })
    ).map((note) => note.id);
    // The direction that proves the fence exists.
    expect(ids).not.toContain(inB);
    // The direction that proves it is a fence and not a wall. Without this, an
    // accidental `n.workspacePath = 'nothing'` would pass the test above.
    expect(ids).toContain(inA);
  });

  it("excludes the §8 residue from a fenced read", async () => {
    const ids = (
      await graph.recallMemory({ module: MOD, workspacePath: WORKSPACE_A })
    ).map((note) => note.id);
    expect(ids).not.toContain(unassigned);
    expect(ids).toContain(inA);
  });

  it("§6: a confirmed promoted-GLOBAL note still cannot cross a workspace", async () => {
    const ids = (
      await graph.recallMemory({ module: MOD, workspacePath: WORKSPACE_A })
    ).map((note) => note.id);
    expect(ids).not.toContain(globalInB);
    // …and it IS visible from its own workspace, so the exclusion above is the
    // workspace term and not the confirmed/global logic having broken.
    const fromB = (
      await graph.recallMemory({ module: MOD, workspacePath: WORKSPACE_B })
    ).map((note) => note.id);
    expect(fromB).toContain(globalInB);
  });

  it("§8: the unscoped residue view returns ONLY the unassigned note", async () => {
    const ids = (
      await graph.recallMemory({ module: MOD, unscopedWorkspace: true })
    ).map((note) => note.id);
    expect(ids).toEqual([unassigned]);
  });

  it("§5: an ABSENT coordinate is unchanged — every note, as before the column", async () => {
    const ids = (await graph.recallMemory({ module: MOD }))
      .map((note) => note.id)
      .sort();
    expect(ids).toEqual([inA, inB, unassigned, globalInB].sort());
  });

  it("holds on the BITEMPORAL path, where the chat clause takes its strict form", async () => {
    // `visibilityClauses` swaps the chat clause for the strict `n.chatId = $chatId`
    // under `asOf`. The workspace term is asserted separately and unconditionally,
    // so an as-of read must be fenced identically — this is the branch a reader
    // would most plausibly forget.
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const ids = (
      await graph.recallMemory({ module: MOD, workspacePath: WORKSPACE_A, asOf })
    ).map((note) => note.id);
    expect(ids).not.toContain(inB);
    expect(ids).toContain(inA);
  });
});

describe("ADR-0026 step 3: searchMemory is fenced, in both directions", () => {
  it("fences the fused result set", async () => {
    const ids = (
      await graph.searchMemory("idempotent request key", 20, {
        workspacePath: WORKSPACE_A,
      })
    ).map((note) => note.id);
    expect(ids).not.toContain(inB);
    expect(ids).not.toContain(globalInB);
    expect(ids).not.toContain(unassigned);
    expect(ids).toContain(inA);
  });

  it("fences the as-of search path too", async () => {
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const ids = (
      await graph.searchMemory("idempotent request key", 20, {
        workspacePath: WORKSPACE_A,
        asOf,
      })
    ).map((note) => note.id);
    expect(ids).not.toContain(inB);
    expect(ids).toContain(inA);
  });

  it("§8: the unscoped search view returns ONLY the unassigned note", async () => {
    const ids = (
      await graph.searchMemory("idempotent request key", 20, {
        unscopedWorkspace: true,
      })
    ).map((note) => note.id);
    expect(ids).toEqual([unassigned]);
  });

  it("§5: an ABSENT coordinate still searches the whole corpus", async () => {
    const ids = (await graph.searchMemory("idempotent request key", 20)).map(
      (note) => note.id
    );
    expect(ids).toContain(inA);
    expect(ids).toContain(inB);
    expect(ids).toContain(unassigned);
  });
});

// ── The POST-FUSION net, exercised where it is the ONLY thing standing ────────
//
// This block needs its own store, and the reason is the whole point of the second
// net. A LEXICAL candidate has already passed `visibilityClauses`, so on the shared
// store above every fused candidate is in-workspace before `partitionFilter` ever
// sees it — an assertion there proves nothing about the net.
//
// SEMANTIC candidates are different: `semanticCandidates` filters on
// `n.status = 'active' AND size(n.embedding) > 0` and NOTHING else, and ids it
// returns are hydrated by `getMemoryNote`, which has no partition predicate at all.
// So a foreign-workspace note genuinely arrives at fusion and `partitionFilter` is
// the last gate. (FTS is the same shape; a deterministic offline embedder is used
// instead because the FTS extension is optional per host and a test that silently
// no-ops where it is absent is worse than no test.)
//
// FIRST WRITTEN WRONG, and recorded because the correction is the evidence: the
// original version of this test asserted through the lexical path and PASSED with
// the workspace term deleted from `partitionFilter`.
describe("ADR-0026 step 3: the POST-FUSION net enforces it independently", () => {
  const norm = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  // Token-disjoint from the notes below, so the LEXICAL scan cannot match them and
  // the dense tier is provably the retriever that produced the candidates.
  const QUERY = "dump packaged deliverables toward hosted vault racks";
  const TEXT_A = "Persist build artifacts into remote object storage buckets (A)";
  const TEXT_B = "Persist build artifacts into remote object storage buckets (B)";

  let dense: MuonGraph;
  let denseDir: string;
  let denseA: string;
  let denseB: string;

  beforeAll(async () => {
    const table = new Map<string, number[]>([
      [norm(QUERY), [0.95, 0.31, 0]],
      [norm(TEXT_A), [1, 0, 0]],
      [norm(TEXT_B), [1, 0, 0]],
    ]);
    denseDir = mkdtempSync(join(tmpdir(), "muon-ws-dense-"));
    dense = new MuonGraph(join(denseDir, "dense.lbug"), {
      disableFts: true,
      embedder: {
        id: "fake-ws-fence-v1",
        async embed(texts: string[]) {
          return texts.map(
            (text) => table.get(norm(text)) ?? [0, 0, 1]
          );
        },
      },
    });
    await dense.init();
    denseA = (
      await dense.addMemoryNote({
        kind: "decision",
        text: TEXT_A,
        modules: ["src/build/artifacts.ts"],
        trust: "high",
        createdBy: "human",
        workspacePath: WORKSPACE_A,
      })
    ).id;
    denseB = (
      await dense.addMemoryNote({
        kind: "decision",
        text: TEXT_B,
        modules: ["src/build/artifacts.ts"],
        trust: "high",
        createdBy: "human",
        workspacePath: WORKSPACE_B,
      })
    ).id;
  });

  afterAll(async () => {
    await dense.close();
    rmSync(denseDir, { recursive: true, force: true });
  });

  it("the dense tier really is the retriever here (the lexical scan matches nothing)", async () => {
    // Guards the guard: if the query ever became lexically matchable, the test below
    // would silently go back to proving nothing.
    const unscoped = (await dense.searchMemory(QUERY, 20)).map((note) => note.id);
    expect(unscoped).toContain(denseA);
    expect(unscoped).toContain(denseB);
  });

  it("drops a foreign-workspace SEMANTIC candidate that never saw the scoped WHERE", async () => {
    const fromA = (
      await dense.searchMemory(QUERY, 20, { workspacePath: WORKSPACE_A })
    ).map((note) => note.id);
    expect(fromA).toContain(denseA);
    expect(fromA).not.toContain(denseB);

    const fromB = (
      await dense.searchMemory(QUERY, 20, { workspacePath: WORKSPACE_B })
    ).map((note) => note.id);
    expect(fromB).toContain(denseB);
    expect(fromB).not.toContain(denseA);
  });

  it("the §8 residue view also holds against a semantic candidate", async () => {
    const residue = (
      await dense.searchMemory(QUERY, 20, { unscopedWorkspace: true })
    ).map((note) => note.id);
    expect(residue).toEqual([]);
  });
});

describe("ADR-0026 step 3: relatedToTask and the traversal surfaces", () => {
  it("fences relatedToTask, the path that seeds every worker's brief", async () => {
    const taskId = "task-ws-fence";
    // The ABOUT_TASK edge needs the TaskNode to exist, so the traversal has
    // something to walk from — without it this test would pass vacuously (empty in,
    // empty out) and prove nothing about the fence.
    await graph.upsertTask({
      id: taskId,
      title: "Workspace fence",
      status: "in_progress",
    });
    const inTaskA = await graph.addMemoryNote({
      kind: "decision",
      text: "Repo A task decision",
      modules: [MOD],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
      taskId,
      workspacePath: WORKSPACE_A,
    });
    const inTaskB = await graph.addMemoryNote({
      kind: "decision",
      text: "Repo B task decision",
      modules: [MOD],
      trust: "high",
      createdBy: "human",
      chatId: CHAT,
      taskId,
      workspacePath: WORKSPACE_B,
    });
    // Non-vacuous first: unscoped, the traversal reaches BOTH.
    const unscopedIds = (await graph.relatedToTask(taskId, 50)).map(
      (note) => note.id
    );
    expect(unscopedIds).toContain(inTaskA.id);
    expect(unscopedIds).toContain(inTaskB.id);

    const ids = (
      await graph.relatedToTask(taskId, 50, { workspacePath: WORKSPACE_A })
    ).map((note) => note.id);
    expect(ids).not.toContain(inTaskB.id);
    expect(ids).toContain(inTaskA.id);
  });

  it("fences the provenance walk, so a foreign note's EXISTENCE stays hidden", async () => {
    const fromA = await graph.memoryNeighbors(`note:${inA}`, {
      hops: 2,
      workspacePath: WORKSPACE_A,
    });
    const entityIds = fromA.nodes.map((node) => node.entityId);
    expect(entityIds).not.toContain(inB);
    expect(entityIds).toContain(inA);
  });

  it("fences memoryExplain the same way", async () => {
    const explained = await graph.memoryExplain(`note:${inB}`, {
      workspacePath: WORKSPACE_A,
    });
    // Asked from repo A, repo B's note is not even the root of its own path.
    expect(explained.path.nodes.map((node) => node.entityId)).not.toContain(inB);
    const own = await graph.memoryExplain(`note:${inB}`, {
      workspacePath: WORKSPACE_B,
    });
    expect(own.path.nodes.map((node) => node.entityId)).toContain(inB);
  });
});

describe("ADR-0026 step 3: memoryAnalytics answers about ONE corpus", () => {
  it("counts only the fenced workspace's notes, in both directions", async () => {
    const fromA = await graph.memoryAnalytics({ workspacePath: WORKSPACE_A });
    const fromB = await graph.memoryAnalytics({ workspacePath: WORKSPACE_B });
    const unscoped = await graph.memoryAnalytics({});
    expect(fromA.noteScores.map((row) => row.noteId)).not.toContain(inB);
    expect(fromA.noteScores.map((row) => row.noteId)).toContain(inA);
    expect(fromB.noteScores.map((row) => row.noteId)).toContain(inB);
    // A narrower, never a widener: each fenced answer is a strict subset of the
    // unscoped one, and the two fenced answers cannot together exceed it.
    expect(fromA.source.notes).toBeLessThan(unscoped.source.notes);
    expect(fromA.source.notes + fromB.source.notes).toBeLessThanOrEqual(
      unscoped.source.notes
    );
  });
});

describe("ADR-0026 step 3: the fence composes with the KG-6 gate", () => {
  it("keeps `governedConditions` LIMIT-complete inside a fenced read", async () => {
    // The lockstep `memory-crew-visible.test.ts` pins for the crew admission, now
    // re-asserted with the workspace term ALSO in the WHERE: the cypher gate
    // (recallForGate, gate IN the query so LIMIT applies to the governed set) and
    // the JS net (recallMemory → applyGate) must still agree on the admitted set.
    // A fence that changed which of the two saw a note would be the drift these
    // two paths exist to prevent.
    const viaQuery = (
      await graph.recallForGate({
        module: MOD,
        workspacePath: WORKSPACE_B,
        crewChatId: CHAT,
      })
    )
      .map((note) => note.id)
      .sort();
    const viaNet = (
      await graph.recallMemory({
        module: MOD,
        workspacePath: WORKSPACE_B,
        governedOnly: true,
        crewChatId: CHAT,
      })
    )
      .map((note) => note.id)
      .sort();
    expect(viaQuery).toEqual(viaNet);
    // Non-vacuous, and fenced: repo B's notes are admitted, repo A's are not.
    expect(viaQuery).toContain(inB);
    expect(viaQuery).not.toContain(inA);
  });
});
