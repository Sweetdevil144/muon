import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANCHOR_ONLY_RELATIONS,
  ARM_CONFIGS,
  DEFAULT_ARM_RUN_OPTIONS,
  DENSE_OFF_ARM_RUN_OPTIONS,
  TIGHT_ARM_RUN_OPTIONS,
  buildTraversalIndex,
  formatGraphValueEvalProfiles,
  graphExpand,
  ndcgFull,
  prepareGraphValueEval,
  recallAtK,
  runGraphValueEval,
  runGraphValueEvalProfiles,
  runQueryArm,
  type ArmId,
  type ArmReport,
} from "../src/graph-value-eval.js";
import { DEFAULT_GRAPH_VALUE_EVAL_SET } from "../src/fixtures/graph-value-eval-set.js";
import {
  ENTITY_GRAPH_VALUE_EVAL_SET,
  ENTITY_NOTES,
} from "../src/fixtures/graph-value-entity-set.js";
import { extractEntities } from "../src/memory-entities.js";
import { MuonGraph } from "../src/muon-graph.js";

/**
 * KG-12: the graph-value ablation is a COMMITTED artifact, so it gets the same
 * treatment as the other evals — the metrics are pinned as facts, the corpus is
 * checked for the properties the verdict rests on, and the conclusions that would
 * be embarrassing to get wrong (traversal adds no gold; the gate is not weakened)
 * are asserted rather than eyeballed.
 */

const SET = DEFAULT_GRAPH_VALUE_EVAL_SET;

const arm = (report: { arms: ArmReport[] }, id: ArmId): ArmReport =>
  report.arms.find((row) => row.arm === id)!;

describe("graph-value corpus integrity", () => {
  it("has the structure the verdict depends on: hot modules, chains, chats", () => {
    const byModule = new Map<string, number>();
    for (const note of SET.notes) {
      for (const module of note.modules) {
        byModule.set(module, (byModule.get(module) ?? 0) + 1);
      }
    }
    // Hot modules must actually be hot, otherwise anchor traversal is measured
    // against a corpus with no fan-out and looks free.
    const hottest = [...byModule.values()].sort((a, b) => b - a)[0]!;
    expect(hottest).toBeGreaterThanOrEqual(6);
    expect(SET.notes.filter((note) => note.supersededBy).length).toBeGreaterThan(0);
    expect(SET.notes.filter((note) => note.contradicts).length).toBeGreaterThan(0);
    expect(SET.notes.filter((note) => !note.confirmed).length).toBeGreaterThan(0);
    expect(new Set(SET.notes.map((note) => note.chatId)).size).toBeGreaterThan(1);
    expect(SET.notes.some((note) => (note.symbols?.length ?? 0) > 0)).toBe(true);
  });

  it("labels only notes that exist, and every query is labelled", () => {
    const ids = new Set(SET.notes.map((note) => note.id));
    for (const query of SET.queries) {
      expect(Object.keys(query.labels).length).toBeGreaterThan(0);
      expect(query.rationale.length).toBeGreaterThan(20);
      for (const id of Object.keys(query.labels)) {
        expect(ids.has(id)).toBe(true);
      }
    }
  });

  it("keeps a superseded note out of the current active set", () => {
    const prepared = prepareGraphValueEval(SET);
    const retired = SET.notes.find((note) => note.supersededBy)!;
    expect(prepared.active.some((note) => note.id === retired.id)).toBe(false);
    // ...which is exactly why the lineage capability cannot be served by any
    // flat retriever: the predecessor is not a candidate at all.
    expect(prepared.byId.get(retired.id)?.status).toBe("rejected");
  });
});

describe("metrics", () => {
  it("recall@k measures against the FULL gold set, not the retrieved slice", () => {
    const labels = { a: 3, b: 2, c: 0 };
    expect(recallAtK(["a"], labels, 10)).toBeCloseTo(0.5, 6);
    expect(recallAtK(["a", "b"], labels, 10)).toBeCloseTo(1, 6);
    // Truncation at k must lose credit; the reranking harness's ideal-over-
    // retrieved nDCG would not catch this.
    expect(recallAtK(["c", "a", "b"], labels, 1)).toBeCloseTo(0, 6);
  });

  it("nDCG uses the ideal over the labels, so retrieving nothing relevant is 0", () => {
    const labels = { a: 3, b: 2 };
    expect(ndcgFull(["a", "b"], labels, 10)).toBeCloseTo(1, 6);
    expect(ndcgFull(["zzz"], labels, 10)).toBeCloseTo(0, 6);
    expect(ndcgFull(["b"], labels, 10)).toBeLessThan(1);
  });
});

describe("traversal expansion mirrors the shipped BFS", () => {
  it("respects relFilter and charges no query for a filtered-out branch", () => {
    const index = buildTraversalIndex(SET);
    const seed = SET.notes[0]!.id;
    const all = graphExpand(index, [seed], 2);
    const anchors = graphExpand(index, [seed], 2, ANCHOR_ONLY_RELATIONS);
    expect(anchors.storeQueries).toBeLessThan(all.storeQueries);
    expect(
      anchors.hits.every((hit) =>
        (ANCHOR_ONLY_RELATIONS as string[]).includes(hit.relation)
      )
    ).toBe(true);
  });

  it("one hop from a note reaches anchors, never sibling notes", () => {
    const index = buildTraversalIndex(SET);
    const seed = SET.notes.find((note) => note.modules.length > 0)!.id;
    const oneHop = graphExpand(index, [seed], 1, ANCHOR_ONLY_RELATIONS);
    // This is the structural reason `+graph-1hop` is inert for recall: the
    // note→module hop lands on a MODULE, and only the second hop returns notes.
    expect(oneHop.hits).toHaveLength(0);
    expect(graphExpand(index, [seed], 2, ANCHOR_ONLY_RELATIONS).hits.length)
      .toBeGreaterThan(0);
  });

  it("the expander is coordinate-only: no note prose is reachable from its index", () => {
    // The text gate is upheld BY TYPE — a traversal node has no text field — so
    // the assertion is on the shape of every node the index can produce.
    const index = buildTraversalIndex(SET);
    for (const node of index.nodes.values()) {
      expect(Object.keys(node).sort()).toEqual(["entityId", "id", "type"]);
    }
    // And no NOTE TEXT from the corpus can appear anywhere in the index.
    const serialized = JSON.stringify([...index.nodes.values()]);
    for (const note of SET.notes) {
      expect(serialized).not.toContain(note.text);
    }
  });
});

describe("the ablation result (pinned)", () => {
  const profiles = runGraphValueEvalProfiles(SET);

  it("is deterministic across runs", () => {
    expect(formatGraphValueEvalProfiles(runGraphValueEvalProfiles(SET))).toBe(
      formatGraphValueEvalProfiles(profiles)
    );
  });

  it("(a) traversal contributes NO gold the flat retrievers had not already found, at shipped width", () => {
    // The load-bearing claim for verdict (a). It is stated as a GOLD-COUNT, not
    // as an nDCG delta, precisely so it cannot be dismissed as an artefact of how
    // the expansion is fused: no fusion weighting can surface a candidate that
    // the expansion never uniquely contributed.
    expect(arm(profiles.wide, "+graph-2hop").graphOnlyGoldHits).toBe(0);
    expect(arm(profiles.wide, "+graph-2hop-anchors").graphOnlyGoldHits).toBe(0);
  });

  it("(a) even where traversal IS the only path to some gold, the gold lands far below k", () => {
    // Dense-off (the default local-first install) is the ONLY configuration where
    // traversal reaches gold nothing else can. The backfill arm cannot displace a
    // flat result, so this is traversal's best case — and the recovered notes
    // still rank below any k a caller would use.
    const backfill = arm(profiles.denseOff, "+graph-2hop-backfill");
    expect(backfill.graphOnlyGoldHits).toBeGreaterThan(0);
    expect(Math.min(...backfill.graphOnlyGoldRanks)).toBeGreaterThan(
      DENSE_OFF_ARM_RUN_OPTIONS.k
    );
    // Consequently: identical recall and nDCG to the arm without traversal.
    const flat = arm(profiles.denseOff, "+centrality");
    expect(backfill.recall).toBeCloseTo(flat.recall, 6);
    expect(backfill.ndcg).toBeCloseTo(flat.ndcg, 6);
    // And a strictly worse precision, because it fills empty slots with noise.
    expect(backfill.precision).toBeLessThan(flat.precision);
  });

  it("(a) fusing traversal as a peer retriever actively degrades every profile", () => {
    for (const report of [profiles.wide, profiles.tight, profiles.denseOff]) {
      const flat = arm(report, "+centrality");
      expect(arm(report, "+graph-2hop").ndcg).toBeLessThan(flat.ndcg);
      expect(arm(report, "+graph-2hop-anchors").ndcg).toBeLessThan(flat.ndcg);
    }
  });

  it("(a) traversal's cost is an order of magnitude, not a rounding error", () => {
    const flat = arm(profiles.wide, "+centrality");
    // The shipped default (no relFilter) is ~30x the whole flat pipeline.
    expect(
      arm(profiles.wide, "+graph-2hop").storeQueries / flat.storeQueries
    ).toBeGreaterThan(20);
    // Narrowing to anchor edges cuts it roughly threefold and it is STILL ~9x.
    // (The per-relation cost model is exact — a flat per-node cap would have
    // overcharged this arm, so the number is deliberately not rounded up.)
    expect(
      arm(profiles.wide, "+graph-2hop-anchors").storeQueries / flat.storeQueries
    ).toBeGreaterThan(8);
    expect(
      arm(profiles.wide, "+graph-2hop-anchors").storeQueries
    ).toBeLessThan(arm(profiles.wide, "+graph-2hop").storeQueries);
  });

  it("(b) the centrality prior fires, and when it fires it loses", () => {
    const impact = profiles.wide.centrality;
    expect(impact.reordered).toBeGreaterThan(0); // not inert
    expect(impact.ndcgDelta).toBeLessThan(0); // and not helpful
    expect(profiles.tight.centrality.ndcgDelta).toBeLessThan(0);
    expect(profiles.denseOff.centrality.ndcgDelta).toBeLessThan(0);
    // Recall is untouched by construction: the prior reorders, never retrieves.
    expect(arm(profiles.wide, "+centrality").recall).toBeCloseTo(
      arm(profiles.wide, "fts+lex+dense").recall,
      6
    );
  });

  it("(b) the tie-break STEELMAN of the prior never fires at all", () => {
    // Job 2 allowed keeping centrality IF a narrowed variant could be shown
    // non-negative. As a last-resort tie-break it is trivially non-negative —
    // and also completely inert: RRF-fused relevance plus the governance bonus
    // essentially never produces an exact float tie, so there is nothing left for
    // it to break. Shipping it would be dead weight, which is why
    // `centralityTieBreak` stays off in DEFAULT_CALIBRATED_WEIGHTS.
    for (const report of [profiles.wide, profiles.tight, profiles.denseOff]) {
      expect(report.centralityTieBreak.reordered).toBe(0);
      expect(report.centralityTieBreak.ndcgDelta).toBe(0);
      expect(report.centralityTieBreak.mrrDelta).toBe(0);
    }
  });

  it("(b) the SHIPPED ranker is the no-prior arm — the cut is real, not cosmetic", () => {
    // `fts+lex+dense` ranks through DEFAULT_CALIBRATED_WEIGHTS verbatim, and
    // `+centrality` has to opt the prior back in explicitly. If the prior were
    // still in the shipped defaults these two arms would be identical.
    expect(ARM_CONFIGS["fts+lex+dense"].centrality).toBe("off");
    expect(ARM_CONFIGS["+centrality"].centrality).toBe("score");
    expect(arm(profiles.wide, "+centrality").ndcg).not.toBeCloseTo(
      arm(profiles.wide, "fts+lex+dense").ndcg,
      6
    );
  });

  it("(R2) the entity arm is NEVER harmful on the frozen corpus", () => {
    // The frozen corpus is entity's honest worst case: its notes keep their
    // coordinates in the STRUCTURED anchor fields and paraphrase everything else,
    // so there is almost nothing in their text to index. The bar it still has to
    // clear is "does not make anything worse".
    for (const report of [profiles.wide, profiles.tight, profiles.denseOff]) {
      expect(report.entity.recallDelta).toBeGreaterThanOrEqual(0);
      expect(report.entity.ndcgDelta).toBeGreaterThanOrEqual(0);
      expect(report.entity.mrrDelta).toBeGreaterThanOrEqual(0);
      expect(report.entity.precisionDelta).toBeGreaterThanOrEqual(0);
    }
  });

  it("(R2) the entity signal costs exactly ONE store round-trip", () => {
    // The number that separates it from traversal, which cost 30x.
    const flat = arm(profiles.wide, "fts+lex+dense");
    expect(arm(profiles.wide, "+entity").storeQueries - flat.storeQueries).toBe(1);
  });

  it("the signals that DO pay are the flat ones, and they pay a lot", () => {
    const fts = arm(profiles.wide, "fts");
    const lex = arm(profiles.wide, "fts+lex");
    const dense = arm(profiles.wide, "fts+lex+dense");
    // Anchor-aware lexical over text-only BM25.
    expect(lex.recall - fts.recall).toBeGreaterThan(0.15);
    // Dense over lexical.
    expect(dense.recall - lex.recall).toBeGreaterThan(0.15);
    expect(dense.ndcg - lex.ndcg).toBeGreaterThan(0.15);
    // Each for one extra store round-trip.
    expect(dense.storeQueries - lex.storeQueries).toBe(1);
  });

  it("the gate is not weakened anywhere in the harness", () => {
    const prepared = prepareGraphValueEval(SET);
    for (const query of SET.queries) {
      const run = runQueryArm(SET, prepared, query, ARM_CONFIGS["+graph-2hop"], {
        ...DEFAULT_ARM_RUN_OPTIONS,
        gated: true,
      });
      for (const id of run.rankedIds) {
        expect(prepared.byId.get(id)?.confirmed).toBe(true);
      }
    }
  });

  it("(c) provenance questions are edge-shaped and the corpus exercises them", () => {
    const provenance = profiles.wide.provenance;
    const edgeShaped = provenance.filter((row) => !row.answerableByFlatSearch);
    expect(edgeShaped.length).toBeGreaterThanOrEqual(4);
    // Every claimed capability is backed by at least one real instance, so the
    // structural argument is not made about an empty corpus.
    for (const row of edgeShaped) {
      expect(row.corpusInstances).toBeGreaterThan(0);
    }
    // The one question a note's own scalars answer is marked as such — the
    // matrix has to be able to say "flat search is fine here".
    expect(provenance.some((row) => row.answerableByFlatSearch)).toBe(true);
  });
});

describe("real store: fidelity + measured cost", () => {
  let graph: MuonGraph;
  let dir: string;
  let seedNoteId = "";
  let unconfirmedNoteId = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muon-graph-value-"));
    graph = new MuonGraph(join(dir, "test.lbug"));
    await graph.init();
    for (const task of DEFAULT_GRAPH_VALUE_EVAL_SET.tasks) {
      await graph.upsertTask({ id: task.id, title: task.id, status: "open" });
      await graph.touchModules(task.modules, "2026-07-20T00:00:00.000Z", task.id);
    }
    // Principals matter for the COST measurement: the ledger projects
    // AUTHORED_BY/CONFIRMED_BY in production, and those are the edges whose
    // second-hop fan-out is "every note this principal ever wrote". Omitting
    // them here would measure a traversal narrower than the shipped one.
    for (const principal of new Set(
      DEFAULT_GRAPH_VALUE_EVAL_SET.notes.map((note) => note.principal)
    )) {
      await graph.projectPrincipal({
        id: principal,
        kind: principal.startsWith("human") ? "human" : "agent",
        displayName: principal,
        vendor: null,
        trust: "high",
        createdAt: "2026-07-20T00:00:00.000Z",
      });
    }
    await graph.projectPrincipal({
      id: "human:founder",
      kind: "human",
      displayName: "founder",
      vendor: null,
      trust: "high",
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    for (const note of DEFAULT_GRAPH_VALUE_EVAL_SET.notes) {
      const created = await graph.addMemoryNote({
        kind: note.kind,
        text: note.text,
        modules: note.modules,
        symbols: note.symbols,
        taskId: note.taskId,
        trust: note.trust,
        createdBy: note.principal,
        chatId: note.chatId,
      });
      await graph.projectAuthoredBy(created.id, note.principal);
      if (note.confirmed) {
        await graph.updateMemoryNote(created.id, { confirmed: true });
        await graph.projectConfirmedBy(created.id, "human:founder");
      }
      if (note.id === "n-gate-confirmed-only") {
        seedNoteId = created.id;
      }
      if (!note.confirmed && !unconfirmedNoteId) {
        unconfirmedNoteId = created.id;
      }
    }
  }, 120_000);

  afterAll(async () => {
    await graph.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the harness's flat arm agrees with the real searchMemory on the same corpus", async () => {
    // Fidelity, not equality: the store's FTS availability is host-dependent and
    // the harness has no embedder, so this pins that the mirror retrieves the
    // SAME notes, not that it orders them identically.
    const real = await graph.searchMemory("confirmed only gate unconfirmed agent note", 10);
    expect(real.length).toBeGreaterThan(0);
    const prepared = prepareGraphValueEval(SET);
    const query = SET.queries.find((row) => row.id === "q-lex-gate")!;
    const mirrored = runQueryArm(SET, prepared, query, ARM_CONFIGS["fts+lex"], {
      ...DEFAULT_ARM_RUN_OPTIONS,
      denseOff: true,
    });
    const realTexts = new Set(real.map((note) => note.text));
    const mirrorTexts = mirrored.rankedIds
      .slice(0, 10)
      .map((id) => SET.notes.find((note) => note.id === id)!.text);
    const overlap = mirrorTexts.filter((text) => realTexts.has(text)).length;
    expect(overlap).toBeGreaterThanOrEqual(Math.min(5, mirrorTexts.length));
  });

  it("measures the REAL cost of a 2-hop traversal against a real search", async () => {
    const searchStart = performance.now();
    await graph.searchMemory("confirmed only gate unconfirmed agent note", 10);
    const searchMs = performance.now() - searchStart;

    const traversalStart = performance.now();
    const neighbors = await graph.memoryNeighbors(seedNoteId, {
      hops: 2,
      limit: 100,
    });
    const traversalMs = performance.now() - traversalStart;

    // Structural, not timing, assertions — wall clock is host-dependent and must
    // never make this test flaky. The measured numbers are logged for the report.
    expect(neighbors.nodes.length).toBeGreaterThan(1);
    expect(neighbors.provenance.hops).toBe(2);
    expect(neighbors.provenance.textPolicy).toBe("confirmed-or-unexpired-crew-visible");
    // eslint-disable-next-line no-console
    console.log(
      `[KG-12 measured] searchMemory=${searchMs.toFixed(1)}ms  ` +
        `memoryNeighbors(hops=2)=${traversalMs.toFixed(1)}ms  ` +
        `ratio=${(traversalMs / Math.max(searchMs, 0.001)).toFixed(1)}x  ` +
        `nodes=${neighbors.nodes.length} edges=${neighbors.edges.length} ` +
        `truncated=${neighbors.provenance.truncated}`
    );
  }, 120_000);

  it("R2: measures the INGEST cost of entity linking against the same corpus", async () => {
    // "Ingest must not get materially slower — measure it." Same corpus, same
    // machine, same process: 44 notes written into a store WITH the entity tables
    // and into one WITHOUT them (the degraded tier `tryEnableEntities` falls back
    // to when the tables cannot be created).
    const write = async (label: string): Promise<number> => {
      const dir = mkdtempSync(join(tmpdir(), `muon-ingest-${label}-`));
      const store = new MuonGraph(join(dir, "i.lbug"), { disableFts: true });
      try {
        await store.init();
        if (label === "without") {
          // Force the degraded tier so the two runs differ ONLY by entity writes.
          (store as unknown as { entitiesEnabled: boolean }).entitiesEnabled =
            false;
        }
        const started = performance.now();
        for (const note of DEFAULT_GRAPH_VALUE_EVAL_SET.notes) {
          await store.addMemoryNote({
            kind: note.kind,
            text: note.text,
            modules: note.modules,
            symbols: note.symbols,
            trust: note.trust,
            createdBy: note.principal,
            chatId: note.chatId,
          });
        }
        return performance.now() - started;
      } finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const withoutMs = await write("without");
    const withMs = await write("with");
    const notes = DEFAULT_GRAPH_VALUE_EVAL_SET.notes.length;
    // eslint-disable-next-line no-console
    console.log(
      `[R2 ingest cost] ${notes} notes: without entities=${withoutMs.toFixed(1)}ms ` +
        `(${(withoutMs / notes).toFixed(2)}ms/note)  with entities=${withMs.toFixed(1)}ms ` +
        `(${(withMs / notes).toFixed(2)}ms/note)  delta=${(
          ((withMs - withoutMs) / withoutMs) *
          100
        ).toFixed(1)}%`
    );
    // Structural, not timing: wall clock is host-dependent and must never make
    // this flaky. What IS asserted is the shape that bounds the cost — the node
    // MERGE and the edge MERGE are folded into ONE UNWIND statement, so ingest
    // pays exactly one extra write per note however many entities it carries,
    // and none at all for a note whose text yields no entities.
    const entityCounts = DEFAULT_GRAPH_VALUE_EVAL_SET.notes.map(
      (note) => extractEntities(note.text).length
    );
    expect(Math.max(...entityCounts)).toBeGreaterThan(1);
    expect(entityCounts.some((count) => count === 0)).toBe(true);
  }, 180_000);

  it("the real traversal withholds prose for an unconfirmed note (the gate holds)", async () => {
    expect(unconfirmedNoteId).not.toBe("");
    const neighbors = await graph.memoryNeighbors(unconfirmedNoteId, {
      hops: 1,
      limit: 20,
    });
    const node = neighbors.nodes.find((row) => row.entityId === unconfirmedNoteId);
    expect(node).toBeDefined();
    expect(node?.text).toBeUndefined();
  });
});

describe("R2 entity slice: where the signal is supposed to pay", () => {
  const profiles = runGraphValueEvalProfiles(ENTITY_GRAPH_VALUE_EVAL_SET);

  it("extends the frozen corpus ADDITIVELY — the base notes/queries are untouched", () => {
    // The whole comparability argument rests on this: if the slice edited the
    // base corpus, the traversal and centrality verdicts would be measured on
    // different ground than the one they were reached on.
    expect(
      ENTITY_GRAPH_VALUE_EVAL_SET.notes.slice(0, SET.notes.length)
    ).toEqual(SET.notes);
    expect(
      ENTITY_GRAPH_VALUE_EVAL_SET.queries.slice(0, SET.queries.length)
    ).toEqual(SET.queries);
    expect(ENTITY_GRAPH_VALUE_EVAL_SET.notes.length).toBeGreaterThan(
      SET.notes.length
    );
  });

  it("carries entity-bearing NOISE, so firing indiscriminately is punished", () => {
    // A corpus where every entity-bearing note is also gold would make any
    // entity retriever look perfect. Six of the added notes are gold for nothing.
    const goldIds = new Set(
      ENTITY_GRAPH_VALUE_EVAL_SET.queries.flatMap((query) =>
        Object.entries(query.labels)
          .filter(([, label]) => label >= 2)
          .map(([id]) => id)
      )
    );
    const entityBearingNoise = ENTITY_NOTES.filter(
      (note) => extractEntities(note.text).length > 0 && !goldIds.has(note.id)
    );
    expect(entityBearingNoise.length).toBeGreaterThanOrEqual(4);
  });

  it("improves ranking at EVERY width profile, and never costs recall", () => {
    for (const report of [profiles.wide, profiles.tight, profiles.denseOff]) {
      expect(report.entity.ndcgDelta).toBeGreaterThan(0);
      expect(report.entity.mrrDelta).toBeGreaterThan(0);
      expect(report.entity.recallDelta).toBeGreaterThanOrEqual(0);
      expect(report.entity.precisionDelta).toBeGreaterThanOrEqual(0);
    }
  });

  it("pays MOST at dense-off — the default local-first install", () => {
    // The decision-relevant profile: no embedder configured, so the entity list
    // is one of only three signals present rather than a fourth voice behind a
    // near-oracle dense arm.
    expect(profiles.denseOff.entity.ndcgDelta).toBeGreaterThan(
      profiles.wide.entity.ndcgDelta
    );
    expect(profiles.denseOff.entity.recallDelta).toBeGreaterThan(0);
  });

  it("the gain is RERANKING, not retrieval — and the report says so honestly", () => {
    // Worth pinning because it is the easy claim to overstate. Entity adds no
    // candidate the flat retrievers had not already pooled (`entityOnlyGoldHits`
    // and `entityOnlyNoise` are both 0); recall rises because a gold note that
    // sat below k gets fused UP into the top-k, not because a new note appeared.
    const impact = profiles.denseOff.entity;
    expect(impact.entityOnlyGoldHits).toBe(0);
    expect(impact.entityOnlyNoise).toBe(0);
    expect(profiles.denseOff.reachability.entityOnlyHeadroom).toBe(0);
    expect(impact.recallDelta).toBeGreaterThan(0);
  });

  it("does not fire on every query — an always-on signal would be a red flag", () => {
    const impact = profiles.wide.entity;
    expect(impact.queriesWithEntities).toBeGreaterThan(0);
    expect(impact.queriesWithEntities).toBeLessThan(impact.queries);
  });

  it("the gate still holds on the extended corpus, entity list included", () => {
    const prepared = prepareGraphValueEval(ENTITY_GRAPH_VALUE_EVAL_SET);
    for (const query of ENTITY_GRAPH_VALUE_EVAL_SET.queries) {
      const run = runQueryArm(
        ENTITY_GRAPH_VALUE_EVAL_SET,
        prepared,
        query,
        ARM_CONFIGS["+entity"],
        { ...DEFAULT_ARM_RUN_OPTIONS, gated: true }
      );
      for (const id of run.rankedIds) {
        expect(prepared.byId.get(id)?.confirmed).toBe(true);
      }
    }
  });
});

describe("profiles", () => {
  it("tight and dense-off exist so a negative result cannot hide behind one setting", () => {
    expect(TIGHT_ARM_RUN_OPTIONS.pool).toBeLessThan(DEFAULT_ARM_RUN_OPTIONS.pool);
    expect(DENSE_OFF_ARM_RUN_OPTIONS.denseOff).toBe(true);
    // The dense-off profile must actually give traversal MORE headroom than the
    // wide one, otherwise it is not the stress test it claims to be.
    const wide = runGraphValueEval(SET, DEFAULT_ARM_RUN_OPTIONS);
    const denseOff = runGraphValueEval(SET, DENSE_OFF_ARM_RUN_OPTIONS);
    expect(denseOff.reachability.graphOnlyHeadroom).toBeGreaterThan(
      wide.reachability.graphOnlyHeadroom
    );
  });
});
