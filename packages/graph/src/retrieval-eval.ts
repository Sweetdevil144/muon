import {
  classifyIncomingNote,
  rerankCalibrated,
  type CalibratedWeights,
  type DedupThresholds,
  type DuplicateVerdict,
  type MemoryNoteInputLike,
  type RankableNote,
  type RankInput,
} from "./memory-ranking.js";
import type { MemoryNoteRecord } from "./types.js";

/**
 * KG-4 retrieval evaluation: pure, deterministic metrics + a grid-search
 * calibrator, run against the in-repo labeled eval set (fixtures/eval-set.ts).
 * No wall-clock, no network, no DB, every scoring function takes `now` in, so
 * the calibrated ranker's win over the additive baseline, and the dedup operating
 * point, are reproducible unit facts, not vibes.
 */

// ---- graded-relevance metrics (pure) ----

/**
 * Discounted Cumulative Gain over labels already in ranked order. Standard
 * exponential gain (2^label − 1) with log2 position discount, so a graded label
 * of 3 is worth much more than 1 (rewards putting the MOST relevant first).
 */
export function dcg(rankedLabels: number[], k: number): number {
  let sum = 0;
  const n = Math.min(k, rankedLabels.length);
  for (let i = 0; i < n; i += 1) {
    sum += (2 ** rankedLabels[i] - 1) / Math.log2(i + 2);
  }
  return sum;
}

/**
 * nDCG@k, the primary retrieval-quality metric. DCG of the produced order over
 * the ideal (labels sorted desc). 1.0 = perfect ordering; 0 when no candidate is
 * relevant. `rankedLabels` are the candidates' labels in the ranker's order.
 */
export function ndcgAtK(rankedLabels: number[], k: number): number {
  const ideal = [...rankedLabels].sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  return idcg === 0 ? 0 : dcg(rankedLabels, k) / idcg;
}

/** Reciprocal rank of the first RELEVANT (label ≥ threshold) result, else 0. */
export function reciprocalRank(rankedLabels: number[], threshold = 2): number {
  for (let i = 0; i < rankedLabels.length; i += 1) {
    if (rankedLabels[i] >= threshold) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Precision@k, fraction of the top-k that is relevant (label ≥ threshold). */
export function precisionAtK(
  rankedLabels: number[],
  k: number,
  threshold = 2
): number {
  const n = Math.min(k, rankedLabels.length);
  if (n === 0) {
    return 0;
  }
  let hits = 0;
  for (let i = 0; i < n; i += 1) {
    if (rankedLabels[i] >= threshold) {
      hits += 1;
    }
  }
  return hits / n;
}

// ---- ranking eval harness ----

export type LabeledCandidate = {
  input: RankInput;
  /** Graded relevance 0 (irrelevant) .. 3 (bullseye). */
  label: number;
};

export type RankScenario = {
  id: string;
  /** Which retrieval capability this scenario exercises. */
  capability: string;
  query: string;
  /** Threaded evaluation instant (ms), NO wall-clock in scoring. */
  now: number;
  candidates: LabeledCandidate[];
};

/** A ranker under evaluation: inputs + instant → notes, best first. */
export type RankerFn = (inputs: RankInput[], now: number) => RankableNote[];

export type ScenarioResult = {
  id: string;
  capability: string;
  rankedIds: string[];
  ndcg: number;
  reciprocalRank: number;
  precision: number;
};

export function runRankScenario(
  scenario: RankScenario,
  ranker: RankerFn,
  k: number,
  relevantThreshold = 2
): ScenarioResult {
  const labelById = new Map<string, number>(
    scenario.candidates.map((candidate) => [candidate.input.note.id, candidate.label])
  );
  const ranked = ranker(
    scenario.candidates.map((candidate) => candidate.input),
    scenario.now
  );
  const rankedIds = ranked.map((note) => note.id);
  const rankedLabels = rankedIds.map((id) => labelById.get(id) ?? 0);
  return {
    id: scenario.id,
    capability: scenario.capability,
    rankedIds,
    ndcg: ndcgAtK(rankedLabels, k),
    reciprocalRank: reciprocalRank(rankedLabels, relevantThreshold),
    precision: precisionAtK(rankedLabels, k, relevantThreshold),
  };
}

export type RankerReport = {
  ndcg: number;
  mrr: number;
  precision: number;
  perScenario: ScenarioResult[];
};

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Mean nDCG@k / MRR / P@k of a ranker across all scenarios. */
export function evaluateRanker(
  scenarios: RankScenario[],
  ranker: RankerFn,
  k: number,
  relevantThreshold = 2
): RankerReport {
  const perScenario = scenarios.map((scenario) =>
    runRankScenario(scenario, ranker, k, relevantThreshold)
  );
  return {
    ndcg: mean(perScenario.map((result) => result.ndcg)),
    mrr: mean(perScenario.map((result) => result.reciprocalRank)),
    precision: mean(perScenario.map((result) => result.precision)),
    perScenario,
  };
}

// ---- calibrated-weight grid search ----

export type RankWeightGrid = {
  recency: number[];
  trust: number[];
  confirmed: number[];
  usage: number[];
  governanceCap: number[];
};

/**
 * The search space for the calibrated weights. Deliberately small + coarse so
 * the search is fast and the winner is a defensible operating point rather than
 * an overfit needle. `relevance` is pinned at 1 (the base scale everything else
 * is expressed relative to). Demotion is structural (a hard tier, see
 * rankTier), not a tuned weight, so it is NOT part of the grid.
 */
export const DEFAULT_RANK_WEIGHT_GRID: RankWeightGrid = {
  recency: [0.1, 0.15, 0.2, 0.25, 0.3],
  trust: [0.1, 0.15, 0.2, 0.25],
  confirmed: [0.1, 0.15, 0.2, 0.25],
  usage: [0.05, 0.1, 0.15],
  governanceCap: [0.35, 0.4, 0.45, 0.5, 0.55, 0.6],
};

export type WeightSearchResult = {
  best: CalibratedWeights;
  ndcg: number;
  evaluated: number;
};

/**
 * Deterministic grid search for the calibrated weights that maximize mean nDCG@k
 * over the TRAIN scenarios. Iterates the grid in a FIXED nested order and keeps
 * the FIRST weight set that attains the max (strict `>`), so the result is
 * reproducible run-to-run, the smallest-governanceCap point on the optimal
 * plateau (relevance kept maximally dominant while still satisfying every TRAIN
 * scenario). The winner is SHIPPED as DEFAULT_CALIBRATED_WEIGHTS and evaluated on
 * the disjoint held-out TEST split.
 */
export function gridSearchRankWeights(
  scenarios: RankScenario[],
  grid: RankWeightGrid,
  k: number
): WeightSearchResult {
  let best: CalibratedWeights | null = null;
  let bestNdcg = -1;
  let evaluated = 0;
  for (const governanceCap of grid.governanceCap) {
    for (const recency of grid.recency) {
      for (const trust of grid.trust) {
        for (const confirmed of grid.confirmed) {
          for (const usage of grid.usage) {
            const weights: CalibratedWeights = {
              relevance: 1,
              recency,
              trust,
              confirmed,
              usage,
              governanceCap,
            };
            const ndcg = evaluateRanker(
              scenarios,
              (inputs, now) => rerankCalibrated(inputs, weights, now),
              k
            ).ndcg;
            evaluated += 1;
            if (ndcg > bestNdcg) {
              bestNdcg = ndcg;
              best = weights;
            }
          }
        }
      }
    }
  }
  if (!best) {
    throw new Error("empty weight grid");
  }
  return { best, ndcg: bestNdcg, evaluated };
}

// ---- dedup threshold calibration ----

export type DedupAction = DuplicateVerdict["action"];

export type DedupCase = {
  id: string;
  /** The desired verdict, the ground-truth label. */
  label: DedupAction;
  incoming: MemoryNoteInputLike;
  existing: MemoryNoteRecord;
  /** Optional dense vectors; absent → pure-lexical (dense-OFF) path. */
  incomingVec?: number[];
  existingVec?: number[];
};

/** Classify one labeled case through the REAL classifier at given thresholds. */
export function classifyDedupCase(
  testCase: DedupCase,
  thresholds: DedupThresholds
): DuplicateVerdict {
  const vectors =
    testCase.incomingVec && testCase.existingVec
      ? {
          incoming: testCase.incomingVec,
          byId: (id: string) =>
            id === testCase.existing.id ? testCase.existingVec : undefined,
        }
      : undefined;
  return classifyIncomingNote(
    testCase.incoming,
    [testCase.existing],
    vectors,
    thresholds
  );
}

const DESTRUCTIVE: ReadonlySet<DedupAction> = new Set(["duplicate", "supersede"]);

// Asymmetric error costs for the dedup operating point (F3). A MISSED merge is a
// PERMANENT near-duplicate accumulating in the brain forever; a supersede
// mislabeled as a DUPLICATE drops the incoming REFINEMENT (NOOP keeps the old
// note, losing the new delta), also information loss; a spurious `related`
// over-link is a cheap, non-destructive edge a human can ignore. So missed merges
// and subtype (supersede↔duplicate) errors are weighted heavier than over-links,
// the calibration prefers a permissive cosineSupersede (recall) once the
// paraphrase band is covered, and a cosineDuplicate that separates true dups from
// refinements.
export const MISSED_MERGE_COST = 3;
export const SUBTYPE_ERROR_COST = 2;
export const OVER_LINK_COST = 1;

export type DedupScore = {
  thresholds: DedupThresholds;
  total: number;
  /** Exact verdict matches (predicted action === labeled action). */
  correct: number;
  accuracy: number;
  /** Of predicted destructive verdicts, fraction that were labeled destructive. */
  mergePrecision: number;
  /** Of labeled destructive cases, fraction predicted destructive (recall). */
  mergeRecall: number;
  /** Of predicted `duplicate`, fraction truly `duplicate` (subtype precision). */
  duplicatePrecision: number;
  /** DESTRUCTIVE verdict on a non-destructive-labeled case, MUST be 0 (KG-3
   *  invariant: never silently drop/retire a distinct/related/contradicting note). */
  destructiveFalsePositives: number;
  /** Labeled duplicate/supersede that we FAILED to merge (insert/related instead)
   * , a permanent near-duplicate accumulation. */
  missedMerges: number;
  /** Labeled duplicate predicted supersede or vice-versa, both destructive, but
   *  a refinement collapsed to a duplicate loses the incoming delta. */
  subtypeErrors: number;
  /** `related` predicted where the label is `insert`, spurious over-linking. */
  overLinks: number;
  /** Weighted error cost (the calibration MINIMIZES it subject to
   *  destructiveFalsePositives === 0):
   *  MISSED_MERGE_COST·missed + SUBTYPE_ERROR_COST·subtype + OVER_LINK_COST·over. */
  cost: number;
};

/** Score a threshold set against the labeled dedup cases. */
export function scoreDedupThresholds(
  cases: DedupCase[],
  thresholds: DedupThresholds
): DedupScore {
  let correct = 0;
  let predictedMerge = 0;
  let labeledMerge = 0;
  let mergeTruePositive = 0;
  let predictedDuplicate = 0;
  let duplicateTruePositive = 0;
  let destructiveFalsePositives = 0;
  let missedMerges = 0;
  let subtypeErrors = 0;
  let overLinks = 0;

  for (const testCase of cases) {
    const action = classifyDedupCase(testCase, thresholds).action;
    const labelDestructive = DESTRUCTIVE.has(testCase.label);
    const predDestructive = DESTRUCTIVE.has(action);
    if (action === testCase.label) {
      correct += 1;
    }
    if (labelDestructive) {
      labeledMerge += 1;
      if (predDestructive) {
        mergeTruePositive += 1;
        if (action !== testCase.label) {
          subtypeErrors += 1; // dup↔supersede confusion (both destructive)
        }
      } else {
        missedMerges += 1;
      }
    }
    if (predDestructive) {
      predictedMerge += 1;
      if (!labelDestructive) {
        destructiveFalsePositives += 1;
      }
    }
    if (action === "duplicate") {
      predictedDuplicate += 1;
      if (testCase.label === "duplicate") {
        duplicateTruePositive += 1;
      }
    }
    if (action === "related" && testCase.label === "insert") {
      overLinks += 1;
    }
  }

  return {
    thresholds,
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    mergePrecision: predictedMerge === 0 ? 1 : mergeTruePositive / predictedMerge,
    mergeRecall: labeledMerge === 0 ? 1 : mergeTruePositive / labeledMerge,
    duplicatePrecision:
      predictedDuplicate === 0 ? 1 : duplicateTruePositive / predictedDuplicate,
    destructiveFalsePositives,
    missedMerges,
    subtypeErrors,
    overLinks,
    cost:
      MISSED_MERGE_COST * missedMerges +
      SUBTYPE_ERROR_COST * subtypeErrors +
      OVER_LINK_COST * overLinks,
  };
}

export type DedupThresholdGrid = {
  cosineDuplicate: number[];
  cosineSupersede: number[];
  lexicalFloor: number[];
};

/**
 * Search space for the dedup cosine gates + lexical floor. The jaccard duplicate/
 * supersede thresholds are held at their (already sound) defaults, KG-4 only
 * calibrates the dense gates and the destructive-verdict floor.
 */
export const DEFAULT_DEDUP_THRESHOLD_GRID: DedupThresholdGrid = {
  cosineDuplicate: [0.88, 0.9, 0.92, 0.94, 0.96],
  cosineSupersede: [0.78, 0.8, 0.81, 0.82, 0.83, 0.85],
  lexicalFloor: [0.25, 0.3, 0.35],
};

export type DedupSearchResult = {
  best: DedupThresholds;
  score: DedupScore;
  evaluated: number;
};

/**
 * Deterministic grid search for the dedup operating point. HARD CONSTRAINT: any
 * threshold set that produces a destructive false positive (drops/retires a
 * non-destructive-labeled note) is rejected outright, KG-3's non-destructive
 * invariant is non-negotiable, never traded for accuracy. Among the rest,
 * MINIMIZE the asymmetric error cost (missed merge ≫ over-link); ties keep the
 * first point in fixed iteration order (smallest cosine = highest merge recall,
 * which the cost model already favors).
 */
export function calibrateDedupThresholds(
  cases: DedupCase[],
  base: DedupThresholds,
  grid: DedupThresholdGrid
): DedupSearchResult {
  let best: DedupThresholds | null = null;
  let bestScore: DedupScore | null = null;
  let evaluated = 0;
  for (const cosineDuplicate of grid.cosineDuplicate) {
    for (const cosineSupersede of grid.cosineSupersede) {
      for (const lexicalFloor of grid.lexicalFloor) {
        const thresholds: DedupThresholds = {
          ...base,
          cosineDuplicate,
          cosineSupersede,
          lexicalFloor,
        };
        const score = scoreDedupThresholds(cases, thresholds);
        evaluated += 1;
        // Invariant guard: never accept a point that destroys a note it should
        // have kept, no matter how accurate otherwise.
        if (score.destructiveFalsePositives > 0) {
          continue;
        }
        if (!bestScore || score.cost < bestScore.cost) {
          best = thresholds;
          bestScore = score;
        }
      }
    }
  }
  if (!best || !bestScore) {
    throw new Error("no feasible dedup threshold set (all violated the invariant)");
  }
  return { best, score: bestScore, evaluated };
}
