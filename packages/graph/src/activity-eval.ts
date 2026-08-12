import { pathToFileURL } from "node:url";
import { cosine } from "./memory-ranking.js";

/**
 * KG-11 (ADR-0014 §6/§7), the HONEST held-out eval of cross-agent collision +
 * duplicate-work detection. It is the activity-channel sibling of KG-4's
 * `retrieval-eval.ts`, and it follows the SAME discipline: build a labeled set of
 * scenarios, split it into DISJOINT train/test, GRID-TUNE the knobs on TRAIN, and
 * REPORT precision / recall / F1 / MRR on the untouched TEST split, never fit and
 * report on the same data.
 *
 * WHAT IT TUNES, the two shipped knobs of the KG-7/8/10 activity path:
 *   1. `RECENT_ACTIVITY_WINDOW_MS`, the freshness cutoff below which a peer's
 *      "recent" (past-tense) touch is still worth surfacing (`backend/src/lib/
 *      activity.ts`). Too small ⇒ miss a peer who was just here; too large ⇒
 *      surface archaeology.
 *   2. `DUP_WORK_THRESHOLD`, the brief-paraphrase cosine above which two live
 *      lanes are "doing the same work" (`backend/src/lib/duplicate-work.ts`). Too
 *      low ⇒ false-alarm on same-domain briefs; too high ⇒ miss real paraphrases.
 * The shipped defaults live in the backend (the readers own them); the eval mirrors
 * them as `SHIPPED_*` constants, pinned equal to the backend values by a
 * cross-package merge-gate test, and reports whether the TRAIN argmax lands on them.
 *
 * FAITHFUL, NOT THE READER ITSELF. The detection PREDICATES here mirror the shipped
 * readers exactly, anchor intersection (`readLiveActivity`), the `now - at <=
 * window` recency floor (`readActivity`), and the `cosine >= threshold` dup gate
 * (`readDuplicateWork`, using the REAL `cosine`), parameterized by the two knobs.
 * The readers live in the backend and can't be imported here (no LadybugDB/prisma
 * in this package), so this is the same arrangement KG-4 uses: the eval evaluates
 * the LOGIC; the backend merge-gate tests (`backend/tests/activity-gates.test.ts`)
 * exercise the REAL readers end-to-end.
 *
 * HONEST SCOPE (say it plainly). Like `retrieval-eval`, this validates the logic on
 * a small, hand-labeled, DESIGNER-authored scenario set, NOT a large-corpus
 * generalization benchmark. A clean TRAIN result is expected by construction; the
 * real, non-circular signal is the DISJOINT TEST split, which is authored to
 * include borderline cases the conservative knobs deliberately miss. No wall clock
 * (every scenario threads a fixed `now`), no network, no Ollama, no DB, the
 * embeddings are fixed per-brief vectors, so the numbers are reproducible facts.
 */

export const ACTIVITY_EVAL_HONESTY =
  "This eval validates collision + duplicate-work detection LOGIC on a small, " +
  "hand-labeled scenario set (like KG-4 retrieval-eval), tuning on TRAIN and " +
  "reporting on a DISJOINT TEST split. It is NOT a large-corpus generalization " +
  "benchmark. Embeddings are deterministic fixed vectors (no network/Ollama) and " +
  "the clock is threaded (no Date.now()), so every number is reproducible.";

/** Shipped freshness cutoff (mirror of backend `RECENT_ACTIVITY_WINDOW_MS`, 24h),
 *  pinned equal to the backend value by the cross-package merge-gate test so the
 *  eval can never silently drift from the constant it validates. */
export const SHIPPED_RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Shipped paraphrase gate (mirror of backend `DUP_WORK_THRESHOLD`, 0.86), pinned
 *  equal to the backend value by the cross-package merge-gate test. */
export const SHIPPED_DUP_WORK_THRESHOLD = 0.86;

// ── the labeled scenario shapes ──────────────────────────────────────────────

export type EvalPeer = {
  id: string;
  /** Key into the eval set's `vectors` table (deterministic fake embedding). */
  briefKey: string;
  /** The peer's declared working-set anchors (symbols + modules it is touching). */
  anchors: { symbols: string[]; modules: string[] };
  /** `live` = a currently-running peer job (present tense, always fresh); `recent`
   *  = a past-tense touch whose freshness is decided by the window knob. */
  state: "live" | "recent";
  /** How long before the scenario's `now` the touch/claim happened (threaded clock,
   *  no `Date.now()`). `at` is derived from this so the window predicate is exact. */
  ageHours: number;
  /** GROUND TRUTH: should this peer surface on the anchor-collision `activity[]`? */
  truthActivity: boolean;
  /** GROUND TRUTH: should this peer surface on the paraphrase `duplicateWork[]`? */
  truthDup: boolean;
};

export type EvalScenario = {
  id: string;
  split: "train" | "test";
  /** Fixed clock instant (ISO). NO wall-clock is read anywhere in the eval. */
  now: string;
  caller: { symbols: string[]; modules: string[]; briefKey: string };
  peers: EvalPeer[];
};

export type ActivityEvalSet = {
  /** Deterministic fake embeddings: one FIXED vector per brief key. */
  vectors: Record<string, number[]>;
  scenarios: EvalScenario[];
};

export type ActivityKnobs = {
  /** `RECENT_ACTIVITY_WINDOW_MS` candidate. */
  recentWindowMs: number;
  /** `DUP_WORK_THRESHOLD` candidate. */
  dupThreshold: number;
};

export type ActivityKnobGrid = {
  recentWindowMs: number[];
  dupThreshold: number[];
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * The search space for the two knobs. Coarse + fixed-order (like KG-4's grids) so
 * the search is fast and the winner is a defensible operating point, not an overfit
 * needle. The shipped defaults (24h / 0.86) are BOTH in the grid so the eval can
 * confirm the TRAIN argmax lands on them.
 */
export const DEFAULT_ACTIVITY_KNOB_GRID: ActivityKnobGrid = {
  recentWindowMs: [1, 6, 12, 24, 48, 72].map((h) => h * HOUR_MS),
  dupThreshold: [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92],
};

// ── the detection predicates (faithful mirror of the shipped readers) ────────

/** A predicted surfaced peer, tagged for ranked-order (MRR) and provenance. */
export type SurfacedPeer = {
  peerId: string;
  /** Which channel fired: anchor-collision activity, brief paraphrase, or both. */
  via: "activity" | "dup" | "both";
  onSymbol: boolean;
  onTarget: boolean;
  state: "live" | "recent";
  /** Derived from the threaded clock, for `at`-DESC ordering, not wall-clock. */
  atMs: number;
  /** Cosine to the caller brief (dup channel only; 0 otherwise). */
  similarity: number;
};

function collides(
  peer: EvalPeer,
  callerSymbols: Set<string>,
  callerModules: Set<string>
): { onSymbol: boolean; onModule: boolean } {
  const onSymbol = peer.anchors.symbols.some((s) => callerSymbols.has(s));
  const onModule = peer.anchors.modules.some((m) => callerModules.has(m));
  return { onSymbol, onModule };
}

/**
 * The activity predicate, mirrors `readLiveActivity` (anchor intersection) fused
 * with `readActivity`'s recency floor (`now - at <= window`). A `live` peer that
 * collides always surfaces; a `recent` peer that collides surfaces only inside the
 * window. Symbol collision ranks above module collision (the hero's tiering).
 */
function predictActivity(
  scenario: EvalScenario,
  windowMs: number,
  callerSymbols: Set<string>,
  callerModules: Set<string>,
  nowMs: number
): SurfacedPeer[] {
  const out: SurfacedPeer[] = [];
  for (const peer of scenario.peers) {
    const { onSymbol, onModule } = collides(peer, callerSymbols, callerModules);
    if (!onSymbol && !onModule) {
      continue;
    }
    const ageMs = peer.ageHours * HOUR_MS;
    const fresh = peer.state === "live" || (ageMs >= 0 && ageMs <= windowMs);
    if (!fresh) {
      continue;
    }
    out.push({
      peerId: peer.id,
      via: "activity",
      onSymbol,
      onTarget: onSymbol || onModule,
      state: peer.state,
      atMs: nowMs - ageMs,
      similarity: 0,
    });
  }
  return out;
}

/**
 * The duplicate-work predicate, mirrors `computeDuplicateWork`: over the LIVE
 * peers only (running jobs), flag those whose brief cosine to the caller's brief is
 * `>= threshold`, using the REAL `cosine`. Peers with no vector are skipped
 * (uncompared → not flagged), exactly as the reader degrades.
 */
function predictDup(
  scenario: EvalScenario,
  threshold: number,
  vectors: Record<string, number[]>,
  nowMs: number
): SurfacedPeer[] {
  const callerVec = vectors[scenario.caller.briefKey];
  if (!callerVec) {
    return [];
  }
  const out: SurfacedPeer[] = [];
  for (const peer of scenario.peers) {
    if (peer.state !== "live") {
      continue;
    }
    const peerVec = vectors[peer.briefKey];
    if (!peerVec) {
      continue;
    }
    const sim = cosine(callerVec, peerVec);
    if (sim >= threshold) {
      out.push({
        peerId: peer.id,
        via: "dup",
        onSymbol: false,
        onTarget: false,
        state: peer.state,
        atMs: nowMs - peer.ageHours * HOUR_MS,
        similarity: sim,
      });
    }
  }
  return out;
}

/** Tier key for the merged surface: on-symbol (0) > on-target-module (1) >
 *  neighbour/dup (2), mirroring how the hero orders `activity[]`. */
function tierRank(p: SurfacedPeer): number {
  return p.onSymbol ? 0 : p.onTarget ? 1 : 2;
}

/**
 * The merged, ranked surface a lane would see for one scenario: activity entries
 * (tier, then live-before-recent, then `at` DESC) followed by dup entries
 * (similarity DESC), deduped by peer id (an activity hit outranks a dup hit for the
 * same peer → `via:'both'`). This is what MRR is computed over.
 */
export function predictSurface(
  scenario: EvalScenario,
  knobs: ActivityKnobs,
  vectors: Record<string, number[]>
): SurfacedPeer[] {
  const nowMs = Date.parse(scenario.now);
  const callerSymbols = new Set(scenario.caller.symbols);
  const callerModules = new Set(scenario.caller.modules);

  const activity = predictActivity(
    scenario,
    knobs.recentWindowMs,
    callerSymbols,
    callerModules,
    nowMs
  ).sort((a, b) => {
    const tier = tierRank(a) - tierRank(b);
    if (tier !== 0) {
      return tier;
    }
    if (a.state !== b.state) {
      return a.state === "live" ? -1 : 1;
    }
    return b.atMs - a.atMs;
  });

  const dup = predictDup(scenario, knobs.dupThreshold, vectors, nowMs).sort(
    (a, b) => b.similarity - a.similarity
  );

  const byId = new Map<string, SurfacedPeer>();
  for (const p of activity) {
    byId.set(p.peerId, p);
  }
  const merged: SurfacedPeer[] = [...activity];
  for (const p of dup) {
    const existing = byId.get(p.peerId);
    if (existing) {
      existing.via = "both";
      existing.similarity = p.similarity;
    } else {
      byId.set(p.peerId, p);
      merged.push(p);
    }
  }
  return merged;
}

// ── metrics (pure) ───────────────────────────────────────────────────────────

export type SplitScore = {
  scenarios: number;
  peers: number;
  /** Ground-truth positives (peers that SHOULD surface via either channel). */
  positives: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Mean reciprocal rank of the first correctly-surfaced peer, over scenarios that
   *  HAVE at least one ground-truth positive (undefined-rank scenarios excluded). */
  mrr: number;
};

/** Is a peer a ground-truth positive on EITHER channel? */
function isPositive(peer: EvalPeer): boolean {
  return peer.truthActivity || peer.truthDup;
}

/**
 * Score a set of scenarios at fixed knobs. Micro-averaged P/R/F1 over every peer
 * decision (predicted-surface vs ground-truth-should-surface), plus MRR over the
 * per-scenario ranked surface. Pure, no clock, no I/O.
 */
export function scoreSplit(
  scenarios: EvalScenario[],
  knobs: ActivityKnobs,
  vectors: Record<string, number[]>
): SplitScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let peers = 0;
  let positives = 0;
  const reciprocalRanks: number[] = [];

  for (const scenario of scenarios) {
    const surface = predictSurface(scenario, knobs, vectors);
    const predicted = new Set(surface.map((s) => s.peerId));
    const positiveIds = new Set(
      scenario.peers.filter(isPositive).map((p) => p.id)
    );

    for (const peer of scenario.peers) {
      peers += 1;
      const pred = predicted.has(peer.id);
      const actual = positiveIds.has(peer.id);
      if (actual) {
        positives += 1;
      }
      if (pred && actual) {
        tp += 1;
      } else if (pred && !actual) {
        fp += 1;
      } else if (!pred && actual) {
        fn += 1;
      } else {
        tn += 1;
      }
    }

    // MRR is only defined for scenarios with a ground-truth positive.
    if (positiveIds.size > 0) {
      let rr = 0;
      for (let i = 0; i < surface.length; i += 1) {
        if (positiveIds.has(surface[i]!.peerId)) {
          rr = 1 / (i + 1);
          break;
        }
      }
      reciprocalRanks.push(rr);
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const mrr =
    reciprocalRanks.length === 0
      ? 0
      : reciprocalRanks.reduce((a, b) => a + b, 0) / reciprocalRanks.length;

  return {
    scenarios: scenarios.length,
    peers,
    positives,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    f1,
    mrr,
  };
}

// ── grid search (deterministic) ──────────────────────────────────────────────

export type KnobSearchResult = {
  best: ActivityKnobs;
  f1: number;
  evaluated: number;
};

/**
 * Deterministic 2D grid search for the (window, threshold) pair maximizing
 * micro-F1 over the TRAIN scenarios. Fixed nested iteration order (window outer,
 * threshold inner); keeps the FIRST pair attaining the max (strict `>`), so the
 * result is reproducible run-to-run. Mirrors `gridSearchRankWeights`.
 */
export function gridSearchActivityKnobs(
  trainScenarios: EvalScenario[],
  grid: ActivityKnobGrid,
  vectors: Record<string, number[]>
): KnobSearchResult {
  let best: ActivityKnobs | null = null;
  let bestF1 = -1;
  let evaluated = 0;
  for (const recentWindowMs of grid.recentWindowMs) {
    for (const dupThreshold of grid.dupThreshold) {
      const knobs = { recentWindowMs, dupThreshold };
      const { f1 } = scoreSplit(trainScenarios, knobs, vectors);
      evaluated += 1;
      if (f1 > bestF1) {
        bestF1 = f1;
        best = knobs;
      }
    }
  }
  if (!best) {
    throw new Error("empty activity knob grid");
  }
  return { best, f1: bestF1, evaluated };
}

// ── the runnable end-to-end eval ─────────────────────────────────────────────

export type ActivityEvalReport = {
  honesty: string;
  train: { size: number; ids: string[] };
  test: { size: number; ids: string[] };
  /** The knobs the TRAIN grid search selected. */
  tunedKnobs: ActivityKnobs;
  /** F1 of the tuned knobs ON TRAIN (the argmax value). */
  trainF1: number;
  /** How many grid points were evaluated (search-space size). */
  evaluated: number;
  /** The shipped defaults, for the "did the eval confirm them?" comparison. */
  shippedKnobs: ActivityKnobs;
  tunedMatchesShipped: boolean;
  /** Held-out TEST metrics at the TUNED knobs, the real, non-circular result. */
  test_tuned: SplitScore;
  /** Held-out TEST metrics at the SHIPPED defaults (identical when tuned==shipped;
   *  reported so a change of default would be visible + justified). */
  test_shipped: SplitScore;
};

/** Assert the two splits are disjoint (no shared scenario id) and both non-empty.
 *  Returns the sorted id lists so a caller/test can display the split. */
export function assertDisjointSplit(scenarios: EvalScenario[]): {
  train: string[];
  test: string[];
} {
  const train = scenarios.filter((s) => s.split === "train").map((s) => s.id);
  const test = scenarios.filter((s) => s.split === "test").map((s) => s.id);
  const testSet = new Set(test);
  const overlap = train.filter((id) => testSet.has(id));
  if (overlap.length > 0) {
    throw new Error(`TRAIN/TEST overlap (not disjoint): ${overlap.join(", ")}`);
  }
  if (train.length === 0 || test.length === 0) {
    throw new Error("both TRAIN and TEST splits must be non-empty");
  }
  return { train: [...train].sort(), test: [...test].sort() };
}

/**
 * Run the full honest eval: prove the split is disjoint, GRID-TUNE the two knobs on
 * TRAIN, then REPORT held-out TEST precision/recall/F1/MRR at both the tuned knobs
 * and the shipped defaults. Deterministic, same input, same report.
 */
export function runActivityEval(
  evalSet: ActivityEvalSet,
  grid: ActivityKnobGrid = DEFAULT_ACTIVITY_KNOB_GRID
): ActivityEvalReport {
  const { train, test } = assertDisjointSplit(evalSet.scenarios);
  const trainScenarios = evalSet.scenarios.filter((s) => s.split === "train");
  const testScenarios = evalSet.scenarios.filter((s) => s.split === "test");

  const search = gridSearchActivityKnobs(trainScenarios, grid, evalSet.vectors);
  const shippedKnobs: ActivityKnobs = {
    recentWindowMs: SHIPPED_RECENT_ACTIVITY_WINDOW_MS,
    dupThreshold: SHIPPED_DUP_WORK_THRESHOLD,
  };

  return {
    honesty: ACTIVITY_EVAL_HONESTY,
    train: { size: train.length, ids: train },
    test: { size: test.length, ids: test },
    tunedKnobs: search.best,
    trainF1: search.f1,
    evaluated: search.evaluated,
    shippedKnobs,
    tunedMatchesShipped:
      search.best.recentWindowMs === shippedKnobs.recentWindowMs &&
      search.best.dupThreshold === shippedKnobs.dupThreshold,
    test_tuned: scoreSplit(testScenarios, search.best, evalSet.vectors),
    test_shipped: scoreSplit(testScenarios, shippedKnobs, evalSet.vectors),
  };
}

/** A compact human-readable summary of the report (for the runnable CLI + tests). */
export function formatActivityEvalReport(report: ActivityEvalReport): string {
  const hrs = (ms: number) => `${Math.round(ms / HOUR_MS)}h`;
  const pct = (n: number) => n.toFixed(4);
  const t = report.test_tuned;
  return [
    "[KG-11 activity/dup-work HONEST held-out eval]",
    report.honesty,
    `  split: TRAIN=${report.train.size} scenarios, TEST=${report.test.size} scenarios (DISJOINT)`,
    `  grid: evaluated ${report.evaluated} (window × threshold) points`,
    `  TRAIN-tuned knobs: RECENT_ACTIVITY_WINDOW_MS=${hrs(
      report.tunedKnobs.recentWindowMs
    )} DUP_WORK_THRESHOLD=${report.tunedKnobs.dupThreshold} (TRAIN F1=${pct(
      report.trainF1
    )})`,
    `  shipped defaults: window=${hrs(
      report.shippedKnobs.recentWindowMs
    )} threshold=${report.shippedKnobs.dupThreshold}, tuned ${
      report.tunedMatchesShipped ? "MATCHES shipped (confirmed)" : "DIFFERS from shipped"
    }`,
    `  HELD-OUT TEST @ tuned: precision=${pct(t.precision)} recall=${pct(
      t.recall
    )} F1=${pct(t.f1)} MRR=${pct(t.mrr)}`,
    `    (tp=${t.truePositives} fp=${t.falsePositives} fn=${t.falseNegatives} tn=${t.trueNegatives} over ${t.peers} peer decisions in ${t.scenarios} scenarios)`,
  ].join("\n");
}

// Runnable: `node dist/activity-eval.js` prints the report from the shipped set.
// Guarded so importing this module (tests, the backend) never triggers it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Lazy import keeps the fixture out of the module graph for library consumers.
  const { DEFAULT_ACTIVITY_EVAL_SET } = await import(
    "./fixtures/activity-eval-set.js"
  );
  // eslint-disable-next-line no-console
  console.log(formatActivityEvalReport(runActivityEval(DEFAULT_ACTIVITY_EVAL_SET)));
}
