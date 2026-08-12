import type { ActivityEvalSet, EvalScenario } from "../activity-eval.js";

/**
 * KG-11 (ADR-0014 §7), the LABELED, held-out eval set for cross-agent
 * collision + duplicate-work detection. Mirrors `tests/fixtures/eval-set.ts`
 * (KG-4): a small, hand-authored set of scenarios with GROUND-TRUTH labels,
 * split into DISJOINT `train` / `test` groups by an explicit `split` field.
 *
 * HONESTY (read this): this validates the DETECTION LOGIC on labeled scenarios,
 * exactly as KG-4's `retrieval-eval` validates the ranker on labeled scenarios.
 * It is NOT a large-corpus generalization benchmark, the scenarios are
 * designer-authored to be separable by the two shipped knobs, so a clean TRAIN
 * result is expected; the honest signal is the DISJOINT TEST split, which
 * includes deliberately-borderline cases the conservative knobs miss.
 *
 * DETERMINISTIC FAKE EMBEDDINGS (no network / no Ollama). `vectors` maps each
 * brief key to a FIXED vector. Every caller anchors at `[1, 0]`; each peer brief
 * is authored so `cosine([1,0], peerVec)` equals a chosen value (a peer at target
 * cosine `t` is `[t, sqrt(1 - t^2)]`). So the paraphrase-similarity numbers are
 * reproducible unit facts, and the `DUP_WORK_THRESHOLD` grid search is exercised
 * against real, known cosines, no wall clock, no embedder, no DB.
 */

/** Build a 2D unit vector whose cosine with the caller anchor `[1,0]` is `t`. */
function vec(t: number): number[] {
  return [t, Math.sqrt(1 - t * t)];
}

/** One FIXED vector per brief key (deterministic fake embeddings). The caller's
 *  brief is the `[1,0]` anchor; each peer key encodes its cosine with it. */
const VECTORS: Record<string, number[]> = {
  caller: [1, 0],
  dup95: vec(0.95), // clear paraphrase
  dup91: vec(0.91),
  dup88: vec(0.88),
  dup87: vec(0.87), // just inside the shipped 0.86 gate (a TRUE dup)
  near85: vec(0.85), // just OUTSIDE 0.86, a genuine paraphrase the gate misses
  far84: vec(0.84), // same-domain, NOT the same work (a TRUE non-dup)
  far82: vec(0.82),
  far70: vec(0.7),
  far30: vec(0.3),
  far10: vec(0.1), // unrelated
};

/** Terse peer builder. `a`/`d` are the ground-truth labels (activity / dup). */
function peer(
  id: string,
  briefKey: string,
  anchors: { symbols?: string[]; modules?: string[] },
  state: "live" | "recent",
  ageHours: number,
  a: boolean,
  d: boolean
) {
  return {
    id,
    briefKey,
    anchors: { symbols: anchors.symbols ?? [], modules: anchors.modules ?? [] },
    state,
    ageHours,
    truthActivity: a,
    truthDup: d,
  };
}

/** A single fixed clock instant for every scenario, threaded, never `Date.now()`. */
const NOW = "2026-07-12T00:00:00.000Z";

function scenario(
  id: string,
  split: "train" | "test",
  caller: { symbols?: string[]; modules?: string[]; briefKey?: string },
  peers: ReturnType<typeof peer>[]
): EvalScenario {
  return {
    id,
    split,
    now: NOW,
    caller: {
      symbols: caller.symbols ?? [],
      modules: caller.modules ?? [],
      briefKey: caller.briefKey ?? "caller",
    },
    peers,
  };
}

// ── TRAIN (12), cleanly separable, so the grid search lands UNIQUELY on the two
// shipped knobs. The window-sensitive TRUE recent touches top out at 20h and the
// FALSE ones start at 30h, so only a 24h cutoff separates them; the dup TRUEs
// bottom out at cosine 0.87 and the FALSEs top out at 0.84, so only a 0.86 gate
// separates them. (Live peers use a tiny age purely for `at`-ordering.) ─────────
const TRAIN: EvalScenario[] = [
  scenario(
    "t1-live-and-recent-boundary",
    "train",
    { symbols: ["src/pay/charge.ts#charge"], modules: ["src/pay/charge.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/pay/charge.ts#charge"], modules: ["src/pay/charge.ts"] }, "live", 0.1, true, false),
      peer("p2", "far10", { modules: ["src/pay/charge.ts"] }, "recent", 2, true, false),
      peer("p3", "far10", { modules: ["src/pay/charge.ts"] }, "recent", 30, false, false),
      peer("p4", "far10", { modules: ["src/other/z.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t2-window-20h-true-48h-false",
    "train",
    { modules: ["src/api/handler.ts"] },
    [
      peer("p1", "far30", { modules: ["src/api/handler.ts"] }, "recent", 20, true, false),
      peer("p2", "far30", { modules: ["src/api/handler.ts"] }, "recent", 48, false, false),
      peer("p3", "far30", { modules: ["src/api/handler.ts"] }, "recent", 12, true, false),
    ]
  ),
  scenario(
    "t3-dup-095-true-084-false",
    "train",
    { modules: ["src/dup/a.ts"] },
    [
      peer("p1", "dup95", { modules: ["src/x1.ts"] }, "live", 0.1, false, true),
      peer("p2", "far84", { modules: ["src/x2.ts"] }, "live", 0.1, false, false),
      peer("p3", "far30", { modules: ["src/x3.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t4-dup-087-true-082-false",
    "train",
    { modules: ["src/dup/b.ts"] },
    [
      peer("p1", "dup87", { modules: ["src/y1.ts"] }, "live", 0.1, false, true),
      peer("p2", "far82", { modules: ["src/y2.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t5-dup-088-true-070-false-plus-live-collision",
    "train",
    { symbols: ["src/svc/pay.ts#run"], modules: ["src/svc/pay.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/svc/pay.ts#run"], modules: ["src/svc/pay.ts"] }, "live", 0.1, true, false),
      peer("p2", "dup88", { modules: ["src/svc/other.ts"] }, "live", 0.1, false, true),
      peer("p3", "far70", { modules: ["src/svc/misc.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t6-recent-2h-true-70h-false-plus-dup-091",
    "train",
    { modules: ["src/cache/lru.ts"] },
    [
      peer("p1", "far10", { modules: ["src/cache/lru.ts"] }, "recent", 2, true, false),
      peer("p2", "far10", { modules: ["src/cache/lru.ts"] }, "recent", 70, false, false),
      peer("p3", "dup91", { modules: ["src/cache/other.ts"] }, "live", 0.1, false, true),
    ]
  ),
  scenario(
    "t7-all-negatives",
    "train",
    { modules: ["src/neg/x.ts"] },
    [
      peer("p1", "far30", { modules: ["src/neg/y.ts"] }, "live", 0.1, false, false),
      peer("p2", "far10", { modules: ["src/neg/w.ts"] }, "recent", 5, false, false),
    ]
  ),
  scenario(
    "t8-live-sym-and-recent-12h-true-dup-084-false",
    "train",
    { symbols: ["src/auth/login.ts#validate"], modules: ["src/auth/login.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/auth/login.ts#validate"], modules: ["src/auth/login.ts"] }, "live", 0.1, true, false),
      peer("p2", "far10", { modules: ["src/auth/login.ts"] }, "recent", 12, true, false),
      peer("p3", "far84", { modules: ["src/auth/other.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t9-dup-095-true-082-false-recent-30h-false",
    "train",
    { modules: ["src/rate/limit.ts"] },
    [
      peer("p1", "dup95", { modules: ["src/rate/other.ts"] }, "live", 0.1, false, true),
      peer("p2", "far82", { modules: ["src/rate/misc.ts"] }, "live", 0.1, false, false),
      peer("p3", "far30", { modules: ["src/rate/limit.ts"] }, "recent", 30, false, false),
    ]
  ),
  scenario(
    "t10-window-20h-true-48h-false-plus-live-sym",
    "train",
    { symbols: ["src/db/query.ts#exec"], modules: ["src/db/query.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/db/query.ts#exec"], modules: ["src/db/query.ts"] }, "live", 0.1, true, false),
      peer("p2", "far30", { modules: ["src/db/query.ts"] }, "recent", 20, true, false),
      peer("p3", "far30", { modules: ["src/db/query.ts"] }, "recent", 48, false, false),
    ]
  ),
  scenario(
    "t11-dup-088-true-084-false",
    "train",
    { modules: ["src/pipe/x.ts"] },
    [
      peer("p1", "dup88", { modules: ["src/pipe/a.ts"] }, "live", 0.1, false, true),
      peer("p2", "far84", { modules: ["src/pipe/b.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "t12-live-sym-recent-2h-true-70h-false-dup-087",
    "train",
    { symbols: ["src/queue/worker.ts#process"], modules: ["src/queue/worker.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/queue/worker.ts#process"], modules: ["src/queue/worker.ts"] }, "live", 0.1, true, false),
      peer("p2", "far10", { modules: ["src/queue/worker.ts"] }, "recent", 2, true, false),
      peer("p3", "far10", { modules: ["src/queue/worker.ts"] }, "recent", 70, false, false),
      peer("p4", "dup87", { modules: ["src/queue/other.ts"] }, "live", 0.1, false, true),
    ]
  ),
];

// ── TEST (8), DISJOINT from TRAIN (no shared scenario id, no tuning here). Mostly
// separable, plus TWO deliberately-borderline cases the conservative shipped knobs
// MISS (honest held-out recall < 1): a recent touch at 26h a human still cares
// about (e3), and a genuine paraphrase at cosine 0.85 just under the 0.86 gate
// (e5). These make the reported TEST numbers a real capability metric, not a
// rigged 1.0. ────────────────────────────────────────────────────────────────
const TEST: EvalScenario[] = [
  scenario(
    "e1-live-sym-recent-6h-true-40h-false",
    "test",
    { symbols: ["src/pay/refund.ts#refund"], modules: ["src/pay/refund.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/pay/refund.ts#refund"], modules: ["src/pay/refund.ts"] }, "live", 0.1, true, false),
      peer("p2", "far10", { modules: ["src/pay/refund.ts"] }, "recent", 6, true, false),
      peer("p3", "far10", { modules: ["src/pay/refund.ts"] }, "recent", 40, false, false),
    ]
  ),
  scenario(
    "e2-dup-091-true-030-false",
    "test",
    { modules: ["src/dup/e.ts"] },
    [
      peer("p1", "dup91", { modules: ["src/dup/e1.ts"] }, "live", 0.1, false, true),
      peer("p2", "far30", { modules: ["src/dup/e2.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "e3-hard-recent-26h-labeled-true",
    "test",
    { modules: ["src/hot/path.ts"] },
    [
      // A human still wants to know a lane worked here 26h ago, but the conservative
      // 24h window MISSES it (an honest held-out false-negative).
      peer("p1", "far10", { modules: ["src/hot/path.ts"] }, "recent", 26, true, false),
      peer("p2", "far10", { modules: ["src/hot/path.ts"] }, "live", 0.1, true, false),
    ]
  ),
  scenario(
    "e4-dup-088-true-082-false",
    "test",
    { modules: ["src/dup/f.ts"] },
    [
      peer("p1", "dup88", { modules: ["src/dup/f1.ts"] }, "live", 0.1, false, true),
      peer("p2", "far82", { modules: ["src/dup/f2.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "e5-hard-dup-085-labeled-true",
    "test",
    { modules: ["src/dup/g.ts"] },
    [
      // A genuine paraphrase at cosine 0.85, a real duplicate the conservative 0.86
      // gate MISSES (an honest held-out false-negative). A clear 0.95 dup keeps a
      // top-ranked true positive so MRR stays meaningful.
      peer("p1", "near85", { modules: ["src/dup/g1.ts"] }, "live", 0.1, false, true),
      peer("p2", "dup95", { modules: ["src/dup/g2.ts"] }, "live", 0.1, false, true),
      peer("p3", "far70", { modules: ["src/dup/g3.ts"] }, "live", 0.1, false, false),
    ]
  ),
  scenario(
    "e6-window-20h-true-48h-false-plus-live-sym",
    "test",
    { symbols: ["src/auth/token.ts#verify"], modules: ["src/auth/token.ts"] },
    [
      peer("p1", "far10", { symbols: ["src/auth/token.ts#verify"], modules: ["src/auth/token.ts"] }, "live", 0.1, true, false),
      peer("p2", "far30", { modules: ["src/auth/token.ts"] }, "recent", 20, true, false),
      peer("p3", "far30", { modules: ["src/auth/token.ts"] }, "recent", 48, false, false),
    ]
  ),
  scenario(
    "e7-all-negatives",
    "test",
    { modules: ["src/neg/e.ts"] },
    [
      peer("p1", "far30", { modules: ["src/neg/e2.ts"] }, "live", 0.1, false, false),
      peer("p2", "far10", { modules: ["src/neg/e3.ts"] }, "recent", 3, false, false),
    ]
  ),
  scenario(
    "e8-dup-095-true-084-false-recent-12h-true",
    "test",
    { symbols: ["src/report/gen.ts#build"], modules: ["src/report/gen.ts"] },
    [
      peer("p1", "dup95", { modules: ["src/report/other.ts"] }, "live", 0.1, false, true),
      peer("p2", "far84", { modules: ["src/report/misc.ts"] }, "live", 0.1, false, false),
      peer("p3", "far10", { modules: ["src/report/gen.ts"] }, "recent", 12, true, false),
    ]
  ),
];

/** The shipped labeled eval set: deterministic vectors + disjoint train/test. */
export const DEFAULT_ACTIVITY_EVAL_SET: ActivityEvalSet = {
  vectors: VECTORS,
  scenarios: [...TRAIN, ...TEST],
};
