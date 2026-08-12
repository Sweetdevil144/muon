import { describe, expect, it } from "vitest";
import {
  assertDisjointSplit,
  DEFAULT_ACTIVITY_KNOB_GRID,
  formatActivityEvalReport,
  gridSearchActivityKnobs,
  runActivityEval,
  scoreSplit,
  SHIPPED_DUP_WORK_THRESHOLD,
  SHIPPED_RECENT_ACTIVITY_WINDOW_MS,
  type ActivityKnobs,
} from "../src/activity-eval.js";
import { DEFAULT_ACTIVITY_EVAL_SET } from "../src/fixtures/activity-eval-set.js";

// KG-11 (ADR-0014 §7), the HONEST held-out eval of cross-agent collision +
// duplicate-work detection, mirroring KG-4's retrieval-eval discipline: TUNE the two
// shipped knobs (RECENT_ACTIVITY_WINDOW_MS, DUP_WORK_THRESHOLD) on TRAIN, REPORT
// precision/recall/F1/MRR on a DISJOINT TEST split. Deterministic: fixed per-brief
// vectors (no network/Ollama), a threaded clock (no Date.now()).

const HOUR = 60 * 60 * 1000;
const trainScenarios = DEFAULT_ACTIVITY_EVAL_SET.scenarios.filter(
  (s) => s.split === "train"
);
const testScenarios = DEFAULT_ACTIVITY_EVAL_SET.scenarios.filter(
  (s) => s.split === "test"
);
const { vectors } = DEFAULT_ACTIVITY_EVAL_SET;

describe("KG-11: TRAIN and TEST are DISJOINT (fit here, report there)", () => {
  it("no scenario id appears in both splits, and both are non-empty", () => {
    const { train, test } = assertDisjointSplit(DEFAULT_ACTIVITY_EVAL_SET.scenarios);
    expect(train.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    // The real, non-circular guarantee: the id sets share NOTHING.
    const overlap = train.filter((id) => new Set(test).has(id));
    expect(overlap).toEqual([]);
    // The split field is the single source of truth for membership.
    expect(trainScenarios.every((s) => s.split === "train")).toBe(true);
    expect(testScenarios.every((s) => s.split === "test")).toBe(true);
  });

  it("throws if a split were made overlapping or empty (guards the harness)", () => {
    const dup = { ...testScenarios[0]!, split: "train" as const };
    expect(() =>
      assertDisjointSplit([...DEFAULT_ACTIVITY_EVAL_SET.scenarios, dup])
    ).toThrow(/overlap/i);
    expect(() => assertDisjointSplit(trainScenarios)).toThrow(/non-empty/i);
  });
});

describe("KG-11: honest calibration, grid-tune on TRAIN, report on held-out TEST", () => {
  it("the TRAIN grid search lands EXACTLY on the shipped knobs (24h / 0.86), reproducibly", () => {
    const search = gridSearchActivityKnobs(
      trainScenarios,
      DEFAULT_ACTIVITY_KNOB_GRID,
      vectors
    );
    expect(search.best.recentWindowMs).toBe(SHIPPED_RECENT_ACTIVITY_WINDOW_MS);
    expect(search.best.dupThreshold).toBe(SHIPPED_DUP_WORK_THRESHOLD);
    // TRAIN is authored to be cleanly separable by the two knobs → argmax F1 = 1.
    expect(search.f1).toBeCloseTo(1, 10);
    // Deterministic run-to-run.
    const again = gridSearchActivityKnobs(
      trainScenarios,
      DEFAULT_ACTIVITY_KNOB_GRID,
      vectors
    );
    expect(again.best).toEqual(search.best);
    expect(again.f1).toBe(search.f1);
  });

  it("BOTH knobs genuinely matter: mistuning EITHER drops TRAIN F1 below the argmax", () => {
    const optimal = scoreSplit(
      trainScenarios,
      { recentWindowMs: SHIPPED_RECENT_ACTIVITY_WINDOW_MS, dupThreshold: SHIPPED_DUP_WORK_THRESHOLD },
      vectors
    ).f1;
    // Window too small (misses a peer who was just here) / too large (archaeology).
    const tooSmall = scoreSplit(trainScenarios, { recentWindowMs: 1 * HOUR, dupThreshold: SHIPPED_DUP_WORK_THRESHOLD }, vectors).f1;
    const tooLarge = scoreSplit(trainScenarios, { recentWindowMs: 72 * HOUR, dupThreshold: SHIPPED_DUP_WORK_THRESHOLD }, vectors).f1;
    // Threshold too low (false alarms on same-domain briefs) / too high (misses paraphrases).
    const tooLoose = scoreSplit(trainScenarios, { recentWindowMs: SHIPPED_RECENT_ACTIVITY_WINDOW_MS, dupThreshold: 0.8 }, vectors).f1;
    const tooTight = scoreSplit(trainScenarios, { recentWindowMs: SHIPPED_RECENT_ACTIVITY_WINDOW_MS, dupThreshold: 0.92 }, vectors).f1;
    expect(tooSmall).toBeLessThan(optimal);
    expect(tooLarge).toBeLessThan(optimal);
    expect(tooLoose).toBeLessThan(optimal);
    expect(tooTight).toBeLessThan(optimal);
  });

  it("ACCEPTANCE: held-out TEST F1 clears the floor, and the tuned knobs are reported", () => {
    const report = runActivityEval(DEFAULT_ACTIVITY_EVAL_SET);

    // The tuned knobs are REPORTED (deliverable requirement) and confirm the shipped
    // defaults, the eval does NOT recommend weakening them.
    expect(report.tunedKnobs.recentWindowMs).toBe(SHIPPED_RECENT_ACTIVITY_WINDOW_MS);
    expect(report.tunedKnobs.dupThreshold).toBe(SHIPPED_DUP_WORK_THRESHOLD);
    expect(report.tunedMatchesShipped).toBe(true);

    const t = report.test_tuned;
    // Held-out floors, a sane bar, honest about the conservative recall trade-off.
    expect(t.f1).toBeGreaterThan(0.8);
    expect(t.precision).toBe(1); // conservative knobs raise ZERO false alarms on TEST
    expect(t.recall).toBeGreaterThan(0.75);
    expect(t.mrr).toBeGreaterThanOrEqual(0.8);
    // HONEST: the conservative knobs DO miss borderline peers on the held-out split
    // (a 26h-old touch, a 0.85-cosine paraphrase), recall is not a rigged 1.0.
    expect(t.falseNegatives).toBeGreaterThan(0);
    expect(t.falsePositives).toBe(0);

    // Tuned == shipped, so the shipped-default score is identical (no change needed).
    expect(report.test_shipped).toEqual(report.test_tuned);

    // The honesty caveat is part of the report (not a large-corpus benchmark).
    expect(report.honesty).toMatch(/NOT a large-corpus generalization benchmark/);

    // Report the ACTUAL numbers (KG-4 style).
    // eslint-disable-next-line no-console
    console.log(formatActivityEvalReport(report));
  });

  it("is deterministic: identical report across runs", () => {
    const a = runActivityEval(DEFAULT_ACTIVITY_EVAL_SET);
    const b = runActivityEval(DEFAULT_ACTIVITY_EVAL_SET);
    expect(b).toEqual(a);
  });
});

describe("KG-11: metric primitives (pure)", () => {
  it("precision/recall/F1 degrade sanely on an empty and a perfect split", () => {
    const knobs: ActivityKnobs = {
      recentWindowMs: SHIPPED_RECENT_ACTIVITY_WINDOW_MS,
      dupThreshold: SHIPPED_DUP_WORK_THRESHOLD,
    };
    // No scenarios → no decisions → vacuous P/R (1) and F1 (1), MRR 0.
    const empty = scoreSplit([], knobs, vectors);
    expect(empty.precision).toBe(1);
    expect(empty.recall).toBe(1);
    expect(empty.mrr).toBe(0);
    // TRAIN at the tuned knobs is a perfect split, every metric maxes out.
    const perfect = scoreSplit(trainScenarios, knobs, vectors);
    expect(perfect.f1).toBeCloseTo(1, 10);
    expect(perfect.mrr).toBeCloseTo(1, 10);
    expect(perfect.falsePositives).toBe(0);
    expect(perfect.falseNegatives).toBe(0);
  });
});
