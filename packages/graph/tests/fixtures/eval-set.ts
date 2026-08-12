import type { DedupThresholds, RankInput } from "../../src/memory-ranking.js";
import type {
  DedupCase,
  LabeledCandidate,
  RankScenario,
} from "../../src/retrieval-eval.js";
import type { MemoryNoteRecord } from "../../src/types.js";

/**
 * KG-4 labeled eval set, small, hand-labeled, deterministic, committed as a
 * fixture (NOT network-derived). It validates ranking LOGIC on labeled scenarios;
 * it is NOT a large-corpus generalization benchmark.
 *
 * METHODOLOGY (the important part): the ranking scenarios are split into a TRAIN
 * subset (the grid search fits weights here ONLY) and a DISJOINT held-out TEST
 * subset (the acceptance nDCG is reported here ONLY). Never fit and report on the
 * same scenarios. Both splits are BALANCED across the same capabilities and
 * matched in difficulty (governance-overturn gaps ~0.2, relevance-dominance gaps
 * ~0.35), so neither ranker can win by specializing.
 *
 * Parts:
 *   1. TRAIN_SCENARIOS / TEST_SCENARIOS, graded-relevance retrieval scenarios.
 *   2. DEMOTION_GUARANTEE, the reviewer's stale/contradicted-vs-fresh repro.
 *   3. DEDUP_CASES, labeled write-time dedup pairs (incl. the paraphrase band).
 */
export const EVAL_NOW = Date.parse("2026-07-11T00:00:00.000Z");

const ISO_NOW = new Date(EVAL_NOW).toISOString();
const daysAgo = (days: number): string =>
  new Date(EVAL_NOW - days * 24 * 60 * 60 * 1000).toISOString();

function mkNote(over: Partial<MemoryNoteRecord> & { id: string }): MemoryNoteRecord {
  return {
    kind: "decision",
    text: over.id,
    taskId: null,
    laneId: null,
    modules: [],
    topics: [],
    trust: "medium",
    confirmed: false,
    stale: false,
    status: "active",
    createdBy: "human",
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    validFrom: ISO_NOW,
    validTo: null,
    invalidatedAt: null,
    invalidatedBy: null,
    scope: "project",
    staleSince: null,
    supersededBy: null,
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: null,
    ...over,
  };
}

function cand(
  note: MemoryNoteRecord,
  relevance: number,
  label: number
): LabeledCandidate {
  return { input: { note, relevance } as RankInput, label };
}

function vec(c: number): number[] {
  return [c, Math.sqrt(Math.max(0, 1 - c * c)), 0];
}
const BASE_VEC = [1, 0, 0];

// ---------------------------------------------------------------------------
// 1. Ranking scenarios (graded relevance 0..3), split TRAIN vs held-out TEST
// ---------------------------------------------------------------------------

// TRAIN: the grid search fits the calibrated weights against THESE only.
export const TRAIN_SCENARIOS: RankScenario[] = [
  {
    id: "train_relevance_dominance",
    capability: "large relevance gap → relevance dominates governance",
    query: "artifact persistence",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr1-bullseye", trust: "low" }), 0.92, 3),
      cand(
        mkNote({ id: "tr1-governed", trust: "high", confirmed: true, accessCount: 30 }),
        0.5,
        1
      ),
      cand(mkNote({ id: "tr1-noise" }), 0.35, 0),
    ],
  },
  {
    id: "train_governance_overturn",
    capability: "confirmed high-trust decision surfaces above a modestly-more-relevant keyword note",
    query: "auth token policy",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr2-decision", trust: "high", confirmed: true }), 0.53, 3),
      cand(mkNote({ id: "tr2-keyword", trust: "medium" }), 0.75, 1),
      cand(mkNote({ id: "tr2-noise" }), 0.3, 0),
    ],
  },
  {
    id: "train_trust_gap",
    capability: "confirmed high-trust overturns a modest relevance gap vs low-trust",
    query: "logging approach",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr3-trusted", trust: "high", confirmed: true }), 0.58, 3),
      cand(mkNote({ id: "tr3-untrusted", trust: "low", createdBy: "agent:x" }), 0.8, 1),
      cand(mkNote({ id: "tr3-noise" }), 0.3, 0),
    ],
  },
  {
    id: "train_recency_gap",
    capability: "recent overturns a modest relevance gap vs a stale-by-age note",
    query: "deployment port",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr4-recent", createdAt: ISO_NOW }), 0.6, 3),
      cand(mkNote({ id: "tr4-old", createdAt: daysAgo(90) }), 0.81, 1),
      cand(mkNote({ id: "tr4-noise", createdAt: ISO_NOW }), 0.3, 0),
    ],
  },
  {
    id: "train_contradiction_demotion",
    capability: "a contradicted note is demoted below the authoritative one",
    query: "cache write policy",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr5-current" }), 0.6, 3),
      cand(
        mkNote({
          id: "tr5-contradicted",
          trust: "high",
          confirmed: true,
          accessCount: 30,
          conflictsWith: "tr5-current",
        }),
        1.0,
        1
      ),
      cand(mkNote({ id: "tr5-noise" }), 0.35, 0),
    ],
  },
  {
    id: "train_anchor_proximity",
    capability: "exact-anchor (about-task) > module- > lane-proximity",
    query: "notes for this task",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "tr6-about" }), 0.9, 3),
      cand(mkNote({ id: "tr6-module" }), 0.6, 2),
      cand(mkNote({ id: "tr6-lane" }), 0.3, 1),
    ],
  },
];

// TEST: DISJOINT held-out. The acceptance nDCG is reported here. Includes the
// reviewer's governance-overturn / recency-gap / trust-gap capabilities (with
// fresh numbers), plus relevance-dominance and contradiction-demotion where the
// baseline provably fails, and clean tie-breaks. Matched difficulty to TRAIN.
export const TEST_SCENARIOS: RankScenario[] = [
  {
    id: "test_governance_overturn",
    capability: "confirmed decision surfaces above a modestly-more-relevant keyword note",
    query: "rate limit policy",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te1-decision", trust: "high", confirmed: true }), 0.55, 3),
      cand(mkNote({ id: "te1-keyword", trust: "medium" }), 0.74, 1),
      cand(mkNote({ id: "te1-noise" }), 0.32, 0),
    ],
  },
  {
    id: "test_recency_gap",
    capability: "recent overturns a modest relevance gap vs an aged note",
    query: "current api base url",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te2-recent", createdAt: ISO_NOW }), 0.6, 3),
      cand(mkNote({ id: "te2-old", createdAt: daysAgo(90) }), 0.76, 1),
      cand(mkNote({ id: "te2-noise", createdAt: ISO_NOW }), 0.28, 0),
    ],
  },
  {
    id: "test_trust_gap",
    capability: "confirmed high-trust overturns a modest relevance gap vs low-trust",
    query: "error handling convention",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te3-trusted", trust: "high", confirmed: true }), 0.6, 3),
      cand(mkNote({ id: "te3-untrusted", trust: "low", createdBy: "agent:y" }), 0.78, 1),
      cand(mkNote({ id: "te3-noise" }), 0.3, 0),
    ],
  },
  {
    id: "test_relevance_dominance",
    capability: "large relevance gap → relevance dominates governance",
    query: "object storage layout",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te4-bullseye", trust: "low" }), 0.9, 3),
      cand(
        mkNote({ id: "te4-governed", trust: "high", confirmed: true, accessCount: 30 }),
        0.52,
        1
      ),
      cand(mkNote({ id: "te4-noise" }), 0.4, 0),
    ],
  },
  {
    id: "test_contradiction_demotion",
    capability: "contradicted + stale notes demoted below the authoritative one",
    query: "session ttl policy",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te5-current" }), 0.65, 3),
      cand(
        mkNote({
          id: "te5-contradicted",
          trust: "high",
          confirmed: true,
          conflictsWith: "te5-current",
        }),
        0.95,
        1
      ),
      cand(mkNote({ id: "te5-stale", stale: true }), 0.9, 1),
      // A clean-but-irrelevant note: the hard tier ranks it ABOVE the demoted
      // (contradicted/stale) notes even though they are more relevant, the
      // honest cost of "contradictions are warnings, below the clean band".
      cand(mkNote({ id: "te5-noise" }), 0.3, 0),
    ],
  },
  {
    id: "test_trust_tiebreak",
    capability: "confirmed high-trust outranks low-trust agent at equal relevance",
    query: "structured logging",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te6-high", trust: "high", confirmed: true }), 0.68, 3),
      cand(mkNote({ id: "te6-low", trust: "low", createdBy: "agent:z" }), 0.68, 1),
    ],
  },
  {
    id: "test_anchor_proximity",
    capability: "exact-anchor (about-task) > module- > lane-proximity",
    query: "task-scoped recall",
    now: EVAL_NOW,
    candidates: [
      cand(mkNote({ id: "te7-about" }), 0.85, 3),
      cand(mkNote({ id: "te7-module" }), 0.55, 2),
      cand(mkNote({ id: "te7-lane" }), 0.25, 1),
    ],
  },
];

// Per-scenario "X must outrank Y" expectations for the held-out capability asserts.
export const TEST_EXPECTATIONS: Record<string, { above: string; below: string }> = {
  test_governance_overturn: { above: "te1-decision", below: "te1-keyword" },
  test_recency_gap: { above: "te2-recent", below: "te2-old" },
  test_trust_gap: { above: "te3-trusted", below: "te3-untrusted" },
  test_relevance_dominance: { above: "te4-bullseye", below: "te4-governed" },
  test_contradiction_demotion: { above: "te5-current", below: "te5-contradicted" },
  test_trust_tiebreak: { above: "te6-high", below: "te6-low" },
  test_anchor_proximity: { above: "te7-about", below: "te7-lane" },
};

// ---------------------------------------------------------------------------
// 2. F2 demotion guarantee (the reviewer's exact repro + variants)
// ---------------------------------------------------------------------------

// CLEAN active notes (various relevance) + DEMOTED notes (stale / contradicted)
// at relevance 1.0. Hard-tier guarantee: EVERY clean note ranks above EVERY
// demoted note, regardless of relevance/governance.
export const DEMOTION_GUARANTEE_INPUTS: RankInput[] = [
  { note: mkNote({ id: "dg-fresh-low", trust: "medium" }), relevance: 0.4 },
  { note: mkNote({ id: "dg-fresh-mid", trust: "medium" }), relevance: 0.6 },
  {
    note: mkNote({ id: "dg-stale-hot", trust: "high", confirmed: true, stale: true }),
    relevance: 1.0,
  },
  {
    note: mkNote({
      id: "dg-contradicted-hot",
      trust: "high",
      confirmed: true,
      conflictsWith: "x",
    }),
    relevance: 1.0,
  },
];
export const DEMOTION_CLEAN_IDS = ["dg-fresh-low", "dg-fresh-mid"];
export const DEMOTION_DEMOTED_IDS = ["dg-stale-hot", "dg-contradicted-hot"];

// ---------------------------------------------------------------------------
// 3. Dedup calibration cases (labeled desired verdict), WITH the paraphrase band
// ---------------------------------------------------------------------------

const MOD = ["m.ts"]; // shared anchor so every pair is comparable

function dedupNote(id: string, text: string, kind: MemoryNoteRecord["kind"] = "decision") {
  return mkNote({ id, text, kind, modules: MOD });
}
function incoming(text: string, kind: MemoryNoteRecord["kind"] = "decision") {
  return { kind, text, modules: MOD };
}

/**
 * Labeled pairs. Texts use disjoint 2-letter tokens ("za zb …") so each pair's
 * jaccard is exact; vectors pin an exact cosine. The set COVERS the paraphrase
 * band jaccard∈[0.30,0.50) × cosine∈[0.80,0.83) (C15/C16) that the earlier draft
 * was blind to, plus a subtype boundary (C8/C17), so `calibrateDedupThresholds`
 * picks the operating point honestly against the FULL set.
 */
export const DEDUP_CASES: DedupCase[] = [
  {
    id: "dup-identical",
    label: "duplicate",
    incoming: incoming("za zb zc zd ze"),
    existing: dedupNote("ex-c1", "za zb zc zd ze"),
    incomingVec: vec(0.96),
    existingVec: BASE_VEC,
  },
  {
    id: "sup-lexical",
    label: "supersede",
    incoming: incoming("za zb zc zd zf"),
    existing: dedupNote("ex-c2", "za zb zc zd ze"),
    incomingVec: vec(0.5),
    existingVec: BASE_VEC,
  },
  {
    id: "related-dense-only",
    label: "related",
    incoming: incoming("za zb zp zq zr"),
    existing: dedupNote("ex-c3", "za zs zt zu zv"),
    incomingVec: vec(0.9),
    existingVec: BASE_VEC,
  },
  {
    id: "sup-floor-supported",
    label: "supersede",
    incoming: incoming("za zb zc zd"),
    existing: dedupNote("ex-c4", "za zb ze zf"),
    incomingVec: vec(0.86),
    existingVec: BASE_VEC,
  },
  {
    id: "related-floor-guard",
    label: "related",
    incoming: incoming("za zb zc zd"),
    existing: dedupNote("ex-c5", "za zb ze zf zg"),
    incomingVec: vec(0.9),
    existingVec: BASE_VEC,
  },
  {
    id: "insert-cos-boundary",
    label: "insert",
    incoming: incoming("zp zq zr"),
    existing: dedupNote("ex-c6", "zs zt zu"),
    incomingVec: vec(0.81),
    existingVec: BASE_VEC,
  },
  {
    id: "sup-cos-lower-bound",
    label: "supersede",
    incoming: incoming("za zb zc"),
    existing: dedupNote("ex-c7", "za zb zd ze"),
    incomingVec: vec(0.84),
    existingVec: BASE_VEC,
  },
  // C8, refinement jaccard .4 + cosine .91 → supersede (NOT duplicate). Forces
  // cosDup ≥ 0.92 (else a subtype error collapses the refinement to a duplicate).
  {
    id: "sup-cos-dup-boundary",
    label: "supersede",
    incoming: incoming("za zb zc"),
    existing: dedupNote("ex-c8", "za zb zd zf"),
    incomingVec: vec(0.91),
    existingVec: BASE_VEC,
  },
  {
    id: "dup-high-cosine",
    label: "duplicate",
    incoming: incoming("za zb zc zd zf"),
    existing: dedupNote("ex-c9", "za zb zc zd ze"),
    incomingVec: vec(0.96),
    existingVec: BASE_VEC,
  },
  {
    id: "conflict-polarity",
    label: "conflict",
    incoming: incoming("must not use za zb zc", "constraint"),
    existing: dedupNote("ex-c10", "must use za zb zc", "constraint"),
    incomingVec: vec(0.95),
    existingVec: BASE_VEC,
  },
  {
    id: "insert-kind-guard",
    label: "insert",
    incoming: incoming("za zb zc", "decision"),
    existing: dedupNote("ex-c11", "za zb zd ze", "convention"),
    incomingVec: vec(0.86),
    existingVec: BASE_VEC,
  },
  {
    id: "insert-unrelated",
    label: "insert",
    incoming: incoming("za zp zq zr zs"),
    existing: dedupNote("ex-c12", "za zt zu zv zw"),
    incomingVec: vec(0.4),
    existingVec: BASE_VEC,
  },
  {
    id: "related-dense-dup-strength",
    label: "related",
    incoming: incoming("za zb zp zq zk"),
    existing: dedupNote("ex-c13", "za zc zt zu zv"),
    incomingVec: vec(0.95),
    existingVec: BASE_VEC,
  },
  {
    id: "dup-lexical-dense-off",
    label: "duplicate",
    incoming: incoming("za zb zc zd ze"),
    existing: dedupNote("ex-c14", "za zb zc zd ze"),
  },
  // C15/C16, the PARAPHRASE BAND (jaccard .4 / .333, cosine .81 / .82), same
  // kind + lexically supported → genuine supersede. cosineSupersede 0.83 would
  // MISS these (recall regression). Covering the band keeps the gate at 0.80.
  {
    id: "sup-band-081",
    label: "supersede",
    incoming: incoming("za zb zc"),
    existing: dedupNote("ex-c15", "za zb zd ze"),
    incomingVec: vec(0.81),
    existingVec: BASE_VEC,
  },
  {
    id: "sup-band-082",
    label: "supersede",
    incoming: incoming("za zb zc zd"),
    existing: dedupNote("ex-c16", "za zb ze zf"),
    incomingVec: vec(0.82),
    existingVec: BASE_VEC,
  },
  // C17, a true near-identical duplicate at cosine .93. Forces cosDup ≤ 0.93
  // (else a duplicate is downgraded to a supersede, the other subtype error),
  // so together with C8 the gate is pinned at 0.92.
  {
    id: "dup-cos-093",
    label: "duplicate",
    incoming: incoming("za zb zc zd zf"),
    existing: dedupNote("ex-c17", "za zb zc zd ze"),
    incomingVec: vec(0.93),
    existingVec: BASE_VEC,
  },
  // C18, a DISTINCT note just below the band (jaccard 0, cosine .79). Forces
  // cosSup ≥ 0.80 (a lower gate would spuriously `related`-link it), so with the
  // band cases the supersede gate is pinned at 0.80, the original KG-3 value,
  // confirmed (not the over-tightened 0.83) by the cost-weighted calibration.
  {
    id: "insert-below-band",
    label: "insert",
    incoming: incoming("zp zq zr zs"),
    existing: dedupNote("ex-c18", "zt zu zv zw"),
    incomingVec: vec(0.79),
    existingVec: BASE_VEC,
  },
];

/** The un-tuned KG-3 defaults, kept for the honest "what the calibration confirms
 *  vs the earlier over-tightened draft" comparison. */
export const LEGACY_DEDUP_THRESHOLDS: DedupThresholds = {
  duplicate: 0.82,
  supersede: 0.5,
  cosineDuplicate: 0.9,
  cosineSupersede: 0.8,
  lexicalFloor: 0.3,
};

/** The earlier KG-4 draft point the reviewer flagged for the recall regression
 *  (cosineSupersede 0.83). Kept to demonstrate the band-recall cost it incurred. */
export const OVERTIGHTENED_DEDUP_THRESHOLDS: DedupThresholds = {
  duplicate: 0.82,
  supersede: 0.5,
  cosineDuplicate: 0.92,
  cosineSupersede: 0.83,
  lexicalFloor: 0.3,
};
