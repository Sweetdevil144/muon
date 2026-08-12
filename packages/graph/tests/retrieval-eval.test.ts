import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CALIBRATED_WEIGHTS,
  DEFAULT_DEDUP_THRESHOLDS,
  DEFAULT_RANK_WEIGHTS,
  rerankBySalience,
  rerankCalibrated,
  type RankInput,
} from "../src/memory-ranking.js";
import {
  calibrateDedupThresholds,
  classifyDedupCase,
  DEFAULT_DEDUP_THRESHOLD_GRID,
  DEFAULT_RANK_WEIGHT_GRID,
  evaluateRanker,
  gridSearchRankWeights,
  ndcgAtK,
  precisionAtK,
  reciprocalRank,
  scoreDedupThresholds,
  type RankerFn,
} from "../src/retrieval-eval.js";
import { MuonGraph } from "../src/muon-graph.js";
import {
  DEDUP_CASES,
  DEMOTION_CLEAN_IDS,
  DEMOTION_DEMOTED_IDS,
  DEMOTION_GUARANTEE_INPUTS,
  LEGACY_DEDUP_THRESHOLDS,
  OVERTIGHTENED_DEDUP_THRESHOLDS,
  TEST_EXPECTATIONS,
  TEST_SCENARIOS,
  TRAIN_SCENARIOS,
} from "./fixtures/eval-set.js";

const K = 5;

const baselineRanker: RankerFn = (inputs: RankInput[], now: number) =>
  rerankBySalience(inputs, DEFAULT_RANK_WEIGHTS, now);
const calibratedRanker: RankerFn = (inputs: RankInput[], now: number) =>
  rerankCalibrated(inputs, DEFAULT_CALIBRATED_WEIGHTS, now);

describe("KG-4 graded-relevance metrics (pure)", () => {
  it("nDCG@k is 1 for a perfect order, <1 when a bullseye is buried, 0 with no relevance", () => {
    expect(ndcgAtK([3, 2, 1, 0], K)).toBeCloseTo(1, 10);
    expect(ndcgAtK([0, 1, 2, 3], K)).toBeLessThan(1);
    expect(ndcgAtK([0, 0, 0], K)).toBe(0);
  });

  it("MRR and P@k reward relevant results near the top", () => {
    expect(reciprocalRank([0, 3, 0])).toBeCloseTo(0.5, 10);
    expect(reciprocalRank([0, 0, 0])).toBe(0);
    expect(precisionAtK([3, 2, 0, 0], 2)).toBeCloseTo(1, 10);
    expect(precisionAtK([0, 0, 3], 2)).toBe(0);
  });
});

describe("KG-4 honest calibration: fit on TRAIN, report on held-out TEST", () => {
  it("the shipped weights are EXACTLY the argmax of the TRAIN grid search (no hand-tuning)", () => {
    const search = gridSearchRankWeights(TRAIN_SCENARIOS, DEFAULT_RANK_WEIGHT_GRID, K);
    expect(search.best).toEqual(DEFAULT_CALIBRATED_WEIGHTS);
    // Reproducible run-to-run.
    const again = gridSearchRankWeights(TRAIN_SCENARIOS, DEFAULT_RANK_WEIGHT_GRID, K);
    expect(again.best).toEqual(search.best);
    expect(again.ndcg).toBe(search.ndcg);
    // TRAIN nDCG is NOT a perfect 1.0, the hard demotion tier legitimately costs
    // nDCG when a contradicted (relevant) note is ranked below a clean irrelevant
    // one. Honest, not rigged.
    expect(search.ndcg).toBeLessThan(1);
  });

  it("ACCEPTANCE: on the DISJOINT held-out TEST split, calibrated nDCG@5 > baseline (both reported)", () => {
    // TRAIN and TEST share NO scenarios (fit here, report there), the real,
    // non-circular result.
    const cal = evaluateRanker(TEST_SCENARIOS, calibratedRanker, K);
    const base = evaluateRanker(TEST_SCENARIOS, baselineRanker, K);

    expect(cal.ndcg).toBeGreaterThan(base.ndcg);
    expect(cal.mrr).toBeGreaterThanOrEqual(base.mrr);
    expect(cal.precision).toBeGreaterThanOrEqual(base.precision);

    console.log(
      `[KG-4 HELD-OUT nDCG@${K}] calibrated=${cal.ndcg.toFixed(4)} > baseline=${base.ndcg.toFixed(4)} ` +
        `| MRR cal=${cal.mrr.toFixed(4)} base=${base.mrr.toFixed(4)} ` +
        `| P@${K} cal=${cal.precision.toFixed(4)} base=${base.precision.toFixed(4)}`
    );
    for (const p of cal.perScenario) {
      const b = base.perScenario.find((s) => s.id === p.id)!;
      console.log(
        `  - ${p.id.padEnd(28)} calibrated nDCG=${p.ndcg.toFixed(4)} vs baseline=${b.ndcg.toFixed(4)}`
      );
    }
  });

  it("ranks each held-out capability correctly, incl. F4 (a confirmed decision is NOT buried)", () => {
    const cal = evaluateRanker(TEST_SCENARIOS, calibratedRanker, K);
    for (const scenario of TEST_SCENARIOS) {
      const result = cal.perScenario.find((s) => s.id === scenario.id)!;
      const expectation = TEST_EXPECTATIONS[scenario.id];
      const above = result.rankedIds.indexOf(expectation.above);
      const below = result.rankedIds.indexOf(expectation.below);
      expect(above, `${scenario.id}: ${expectation.above} present`).toBeGreaterThanOrEqual(0);
      expect(
        above,
        `${scenario.id}: ${expectation.above} must outrank ${expectation.below}`
      ).toBeLessThan(below);
    }
  });

  it("is deterministic: identical held-out ranking across runs", () => {
    const a = evaluateRanker(TEST_SCENARIOS, calibratedRanker, K);
    const b = evaluateRanker(TEST_SCENARIOS, calibratedRanker, K);
    expect(a.perScenario.map((s) => s.rankedIds)).toEqual(
      b.perScenario.map((s) => s.rankedIds)
    );
  });
});

describe("KG-4 F2: demotion is a HARD TIER (the guarantee the docstring makes)", () => {
  it("every clean active note ranks above every stale/contradicted note, whatever its relevance", () => {
    const ranked = rerankCalibrated(
      DEMOTION_GUARANTEE_INPUTS,
      DEFAULT_CALIBRATED_WEIGHTS,
      0
    ).map((n) => n.id);
    const worstClean = Math.max(...DEMOTION_CLEAN_IDS.map((id) => ranked.indexOf(id)));
    const bestDemoted = Math.min(...DEMOTION_DEMOTED_IDS.map((id) => ranked.indexOf(id)));
    expect(worstClean).toBeLessThan(bestDemoted);
  });

  it("reviewer repro: a STALE note at relevance 1.0 ranks below a FRESH active note at 0.4", () => {
    const fresh = DEMOTION_GUARANTEE_INPUTS[0]; // dg-fresh-low, rel 0.4, clean
    const staleHot = DEMOTION_GUARANTEE_INPUTS[2]; // dg-stale-hot, rel 1.0, stale
    const ranked = rerankCalibrated([staleHot, fresh], DEFAULT_CALIBRATED_WEIGHTS, 0).map(
      (n) => n.id
    );
    expect(ranked).toEqual(["dg-fresh-low", "dg-stale-hot"]);
  });
});

describe("KG-4 dedup threshold calibration (cost-aware, invariant-guarded)", () => {
  it("the grid search selects the shipped operating point on the FULL labeled set (band covered)", () => {
    const result = calibrateDedupThresholds(
      DEDUP_CASES,
      DEFAULT_DEDUP_THRESHOLDS,
      DEFAULT_DEDUP_THRESHOLD_GRID
    );
    expect(result.best.cosineDuplicate).toBe(0.92);
    expect(result.best.cosineSupersede).toBe(0.8); // NOT the over-tightened 0.83
    expect(result.best.lexicalFloor).toBe(0.3);
    // KG-3 invariant: zero destructive verdicts on kept-notes, zero missed merges.
    expect(result.score.destructiveFalsePositives).toBe(0);
    expect(result.score.missedMerges).toBe(0);
    expect(result.score.subtypeErrors).toBe(0);
    // Deterministic.
    const again = calibrateDedupThresholds(
      DEDUP_CASES,
      DEFAULT_DEDUP_THRESHOLDS,
      DEFAULT_DEDUP_THRESHOLD_GRID
    );
    expect(again.best).toEqual(result.best);
    console.log(
      `[KG-4 dedup] tuned(0.92/0.80/0.30): cost=${result.score.cost} correct=${result.score.correct}/${result.score.total} ` +
        `missed=${result.score.missedMerges} subtype=${result.score.subtypeErrors} overLinks=${result.score.overLinks} destrFP=${result.score.destructiveFalsePositives}`
    );
  });

  it("F3: the earlier over-tightened 0.83 gate MISSES genuine band paraphrases (higher cost)", () => {
    const tuned = scoreDedupThresholds(DEDUP_CASES, DEFAULT_DEDUP_THRESHOLDS);
    const over = scoreDedupThresholds(DEDUP_CASES, OVERTIGHTENED_DEDUP_THRESHOLDS);
    const legacy = scoreDedupThresholds(DEDUP_CASES, LEGACY_DEDUP_THRESHOLDS);
    // The tuned point covers the band (no missed merges); 0.83 misses them.
    expect(tuned.missedMerges).toBe(0);
    expect(over.missedMerges).toBeGreaterThan(0);
    expect(tuned.cost).toBeLessThan(over.cost);
    // The tuned cosDup 0.92 also fixes the legacy 0.90 subtype error (refinement
    // collapsed to a duplicate), so tuned beats legacy too.
    expect(legacy.subtypeErrors).toBeGreaterThan(0);
    expect(tuned.cost).toBeLessThan(legacy.cost);
    console.log(
      `[KG-4 dedup] tuned cost=${tuned.cost} | 0.83 over-tightened cost=${over.cost} (missed=${over.missedMerges}) | ` +
        `legacy 0.90 cost=${legacy.cost} (subtype=${legacy.subtypeErrors})`
    );
  });

  it("KG-3 invariant: dense-only (lexically-unsupported) matches NEVER get a destructive verdict", () => {
    for (const id of ["related-dense-only", "related-floor-guard", "related-dense-dup-strength"]) {
      const testCase = DEDUP_CASES.find((c) => c.id === id)!;
      expect(classifyDedupCase(testCase, DEFAULT_DEDUP_THRESHOLDS).action, id).toBe("related");
    }
    // The band paraphrases (lexically supported) DO merge, recall preserved.
    for (const id of ["sup-band-081", "sup-band-082"]) {
      const testCase = DEDUP_CASES.find((c) => c.id === id)!;
      expect(classifyDedupCase(testCase, DEFAULT_DEDUP_THRESHOLDS).action, id).toBe("supersede");
    }
  });
});

describe("KG-4 wired retrieval: scope + as-of use the SAME calibrated fusion (F3)", () => {
  let dir: string;
  let graph: MuonGraph;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "muon-kg4-"));
    graph = new MuonGraph(join(dir, "kg4.lbug"), { disableFts: true });
    await graph.init();
  });

  afterAll(async () => {
    await graph.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("scope-only search keeps the full hybrid then soft-filters (no cliff)", async () => {
    const project = await graph.addMemoryNote({
      kind: "decision",
      text: "telemetry spans flush export interval",
      topics: ["kg4-scope"],
      createdBy: "human",
      scope: "project",
    });
    const lane = await graph.addMemoryNote({
      kind: "decision",
      text: "telemetry spans flush export interval",
      topics: ["kg4-scope"],
      createdBy: "human",
      scope: "lane:codex",
    });

    const hits = await graph.searchMemory("telemetry spans flush", 20, { scope: "project" });
    const ids = hits.map((n) => n.id);
    expect(ids).toContain(project.id);
    expect(ids).not.toContain(lane.id);
  });

  it("as-of search reranks via the calibrated path and honors the bitemporal bound", async () => {
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: "kg4asof rollback playbook step",
      topics: ["kg4-asof"],
      createdBy: "human",
    });
    const created = (await graph.getMemoryNote(note.id))!.createdAt;
    const after = new Date(Date.parse(created) + 1000).toISOString();
    const before = new Date(Date.parse(created) - 1000).toISOString();

    const asOfAfter = await graph.searchMemory("kg4asof rollback playbook", 20, { asOf: after });
    expect(asOfAfter.map((n) => n.id)).toContain(note.id);
    const asOfBefore = await graph.searchMemory("kg4asof rollback playbook", 20, { asOf: before });
    expect(asOfBefore.map((n) => n.id)).not.toContain(note.id);
  });

  it("confirmed high-trust outranks a low-trust agent note (wired calibrated)", async () => {
    const confirmed = await graph.addMemoryNote({
      kind: "convention",
      text: "kg4rank prefer structured spans for tracing",
      topics: ["kg4-rank"],
      trust: "high",
      createdBy: "human",
    });
    await graph.updateMemoryNote(confirmed.id, { confirmed: true });
    await graph.addMemoryNote({
      kind: "attempt",
      text: "kg4rank tried structured spans for tracing once",
      topics: ["kg4-rank"],
      trust: "low",
      createdBy: "agent:weak",
    });

    const results = await graph.searchMemory("kg4rank structured spans tracing");
    const confirmedRank = results.findIndex((n) => n.id === confirmed.id);
    const weakRank = results.findIndex((n) => n.text.includes("once"));
    expect(confirmedRank).toBeGreaterThanOrEqual(0);
    expect(confirmedRank).toBeLessThan(weakRank);
  });
});
