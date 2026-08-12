import type { MemoryNoteRecord, MemoryTrust } from "./types.js";

/**
 * Memory ranking + dedup algorithms (v3). Pure functions, no DB, so the
 * retrieval quality of the shared brain is unit-testable and deterministic.
 *
 * The design decision (docs/research/memory-graph-v3.md): MUON takes
 * INSPIRATION from mem0 / Graphiti / Zep, not a clone. It keeps its
 * differentiators, human confirm/reject governance, provenance, temporal
 * validity, and adds the two things a code-work brain most needs and lacks:
 *   1. a composite relevance+recency+trust+usage reranker over hybrid
 *      (lexical/FTS + graph) candidate signals, and
 *   2. dedup/supersede on write so the brain stops accumulating near-
 *      duplicate and contradictory notes (mem0's ADD/UPDATE/NOOP idea,
 *      done deterministically so it works offline with no LLM).
 */

// ---- text similarity (deterministic, offline) ----

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "is",
  "are", "be", "we", "it", "this", "that", "with", "as", "by", "at", "from",
  "should", "must", "use", "using", "used", "when", "if", "not",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Jaccard overlap of two token sets, cheap semantic-ish similarity. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cosine similarity of two dense vectors, 0 when either is empty or the lengths
 * mismatch (so a missing/wrong-dim vector never poisons a comparison). Shared by
 * the graph's semantic recall (`semanticCandidates`) and the write-time dense
 * dedup path below, so both agree on what "similar" means (KG-3).
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function overlapCount<T>(a: T[], b: T[]): number {
  const setB = new Set(b);
  return a.filter((item) => setB.has(item)).length;
}

// ---- reciprocal rank fusion (hybrid retrieval) ----

/**
 * Reciprocal Rank Fusion (Cormack et al.), the standard, parameter-light way
 * to fuse ranked candidate lists from different retrievers (FTS, lexical,
 * graph traversal) without tuning per-retriever weights. k=60 is the
 * canonical constant. Score for a doc = Σ 1/(k + rank_in_list).
 */
export const RRF_K = 60;

export function reciprocalRankFusion(
  lists: string[][],
  k: number = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return scores;
}

// ---- composite salience reranker ----

const TRUST_WEIGHT: Record<MemoryTrust, number> = {
  low: 0.4,
  medium: 0.7,
  high: 1,
};

/** Half-life recency decay in days: a note this old scores 0.5 on recency. */
export const RECENCY_HALF_LIFE_DAYS = 30;

export function recencyScore(
  createdAt: string,
  now: number = Date.now()
): number {
  const ageMs = now - new Date(createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return 1;
  }
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Usage-reinforcement half-life in days (ADR-0009 §2.4). The v3 reinforcement
 * counter "never decays", a note used heavily long ago outranks a note used
 * lightly today forever. KG-2 fixes that: on each flush the stored `accessCount`
 * is decayed by elapsed time since it was last used, THEN the new used-signal is
 * added, so reinforcement reflects RECENT usefulness, not lifetime popularity.
 */
export const USAGE_DECAY_HALF_LIFE_DAYS = 30;

/**
 * Time-decayed `accessCount`: exponential half-life applied to the stored count
 * over the interval since `lastUsedAt`. Pure + deterministic so the decay curve
 * is unit-testable. Returns the count unchanged when it was never used (no
 * `lastUsedAt`) or the timestamp is in the future.
 */
export function decayAccessCount(
  accessCount: number,
  lastUsedAt: string | null,
  now: number = Date.now()
): number {
  if (accessCount <= 0 || !lastUsedAt) {
    return Math.max(0, accessCount);
  }
  const ageMs = now - new Date(lastUsedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return accessCount;
  }
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return accessCount * Math.pow(0.5, ageDays / USAGE_DECAY_HALF_LIFE_DAYS);
}

export type RankableNote = MemoryNoteRecord & {
  /** How many times this note has been recalled + used (reinforcement). */
  accessCount?: number;
};

export type RankInput = {
  note: RankableNote;
  /** Normalized 0..1 relevance from the retriever(s), e.g. fused RRF. */
  relevance: number;
  /**
   * Normalized 0..1 note↔module graph centrality. INERT BY DEFAULT since KG-12:
   * the calibrated ranker ignores it unless a caller explicitly opts in via
   * `centralityPrior` / `centralityTieBreak` (see CENTRALITY_PRIOR_WEIGHT for
   * why). Still accepted so `memoryAnalytics` callers and the ablation harness
   * can feed it without a signature change.
   */
  centrality?: number;
};

export type RankWeights = {
  relevance: number;
  recency: number;
  trust: number;
  confirmed: number;
  usage: number;
  stalePenalty: number;
};

/**
 * Salience weights. Relevance dominates (you asked for X), but a confirmed,
 * trusted, recently-reinforced note beats a stale unconfirmed one at similar
 * relevance, the "Generative Agents" retrieval idea (α·relevance +
 * β·recency + γ·importance), extended with MUON's governance signals.
 */
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  relevance: 1,
  recency: 0.5,
  trust: 0.4,
  confirmed: 0.5,
  usage: 0.3,
  stalePenalty: 0.8,
};

export function salienceScore(
  input: RankInput,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
  now: number = Date.now()
): number {
  const { note, relevance } = input;
  // Diminishing returns on repeated recalls: log-scaled, capped.
  const usage = Math.min(1, Math.log1p(note.accessCount ?? 0) / Math.log(11));
  let score =
    weights.relevance * relevance +
    weights.recency * recencyScore(note.createdAt, now) +
    weights.trust * TRUST_WEIGHT[note.trust] +
    weights.confirmed * (note.confirmed ? 1 : 0) +
    weights.usage * usage;
  // Suspect (module changed after the note was written) knowledge is demoted,
  // not dropped, the human still sees it, flagged.
  if (note.stale) {
    score -= weights.stalePenalty;
  }
  return score;
}

export function rerankBySalience(
  inputs: RankInput[],
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
  now: number = Date.now()
): RankableNote[] {
  return inputs
    .map((input) => ({ input, score: salienceScore(input, weights, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.input.note.createdAt.localeCompare(a.input.note.createdAt)
    )
    .map((entry) => entry.input.note);
}

// ---- calibrated ranker (KG-4) ----
//
// The additive baseline above has two pathologies:
//   P1 governance SWAMPS relevance, it sums recency 0.5 + trust 0.4 +
//      confirmed 0.5 + usage 0.3 (up to 1.7, > the 1.0 relevance range), so a
//      barely-relevant confirmed/hot note outscores a bullseye.
//   P2 no contradiction demotion, it penalizes only `stale` (a flat −0.8) and
//      ignores `conflictsWith` entirely, so a contradicted note can rank #1.
// The calibrated ranker fixes both, principled + explainable:
//   1. relevance is the dominant BASE (weight 1);
//   2. governance (recency+trust+confirmed+usage) is a BOUNDED bonus, CAPPED, so
//      it lifts a note by at most `cap`; two notes more than (cap − minGov) apart
//      in relevance never swap on governance (a monotone learning-to-rank prior).
//      This lets a confirmed DECISION surface above a modestly-more-relevant
//      keyword note (the hero wants prior decisions prominent) WITHOUT letting
//      governance overturn a clear relevance gap;
//   3. suspect/contradicted notes are a strictly-LOWER TIER, surfaced as
//      warnings BELOW every clean active note, never leading. This is a hard
//      guarantee (see rankTier), not a fragile multiplier: the hero renders
//      CONTRADICTS as warnings, so demoted ≠ hidden, but a flagged note can never
//      outrank a clean one regardless of its relevance/governance.
// Every note's score decomposes into named contributions (explainCalibratedScore)
// for the "why this memory" surface. Weights are TUNED by deterministic grid
// search on a TRAIN split and reported on a DISJOINT held-out TEST split (see
// retrieval-eval.ts / fixtures/eval-set.ts), NOT fit-and-reported on the same
// scenarios. This validates ranking LOGIC on labeled scenarios; it is NOT a
// large-corpus generalization benchmark.

/** Trust on a pure 0..1 bonus scale for the calibrated ranker. Distinct from the
 *  baseline's TRUST_WEIGHT {0.4,0.7,1}: here low = 0, so trust can only LIFT a
 *  note, never floor its score. */
const TRUST_NORM: Record<MemoryTrust, number> = { low: 0, medium: 0.5, high: 1 };

/** Log-scaled, capped usage in 0..1, diminishing returns on repeated recalls
 *  (accessCount 10 ≈ 1.0). Mirrors the baseline's usage curve so the two rankers
 *  read the same reinforcement signal. */
export function usageNorm(accessCount: number): number {
  return Math.min(1, Math.log1p(Math.max(0, accessCount)) / Math.log(11));
}

export type CalibratedWeights = {
  /** Dominant base weight on fused retrieval relevance. */
  relevance: number;
  recency: number;
  trust: number;
  confirmed: number;
  usage: number;
  /** Upper bound on the summed governance bonus. Keeps relevance dominant: two
   *  notes more than (cap − minGovernance) apart in relevance never swap on
   *  governance alone. Governance can overcome at most (cap − recency-only) of
   *  relevance gap. The baseline had no such bound. */
  governanceCap: number;
  /**
   * KG-12: the structural centrality prior, now OPT-IN and OFF by default
   * (absent ⇒ 0). Kept as a weight rather than deleted outright so the ablation
   * harness can still reproduce the measurement that disqualified it, and so a
   * future corpus can re-argue for it with numbers instead of intuition. See
   * CENTRALITY_PRIOR_WEIGHT.
   */
  centralityPrior?: number;
  /**
   * KG-12: apply centrality as a LAST-RESORT TIE-BREAK instead of a score term —
   * it can only reorder notes whose calibrated totals are exactly equal, so it
   * can never overturn a relevance or governance decision. Also OFF by default;
   * on this corpus it fires on no query at all (see the eval's
   * `+centrality-tiebreak` arm), so shipping it would be dead weight.
   */
  centralityTieBreak?: boolean;
};

/**
 * The calibrated operating point, the argmax of mean nDCG@k over the TRAIN split
 * (retrieval-eval.ts / fixtures/eval-set.ts). Reproduced exactly by
 * gridSearchRankWeights(TRAIN_SCENARIOS, ...) so the shipped weights are provably
 * what training produced, not hand-picked. The acceptance metric is reported on
 * the DISJOINT held-out TEST split, never here.
 *
 * These weights are the exact argmax of gridSearchRankWeights(TRAIN_SCENARIOS)
 * (asserted in the eval test). governanceCap 0.55 bounds the governance bonus: a
 * fully-governed note (confirmed, high-trust, recent, used) can outrank a note at
 * most ~0.55 − 0.30 ≈ 0.25 more relevant than it (0.30 ≈ a fresh medium peer's own
 * governance), so a confirmed decision surfaces above a modestly-more-relevant
 * keyword note WITHOUT overturning a clear relevance gap (a bullseye still wins).
 */
export const DEFAULT_CALIBRATED_WEIGHTS: CalibratedWeights = {
  relevance: 1,
  recency: 0.25,
  trust: 0.1,
  confirmed: 0.2,
  usage: 0.05,
  governanceCap: 0.55,
};

/**
 * The centrality prior's original operating point — RETAINED AS A CONSTANT,
 * REMOVED FROM THE DEFAULT RANKING PATH (KG-12).
 *
 * The idea was that a well-connected note wins deterministic near-ties. The
 * ablation (`graph-value-eval.ts`, the `+centrality` arm) measured it instead of
 * assuming it, and it does not do that. It is not inert — it reorders 11/16
 * queries at the shipped width and changes the top result on 2 — and it scores
 * NEGATIVE at all three width profiles: nDCG −0.0141 / MRR −0.0313 (wide),
 * −0.0150 / −0.0306 (tight), −0.0084 / −0.0021 (dense-off). It also cannot
 * retrieve, only rerank, so its recall delta is exactly 0 by construction. A
 * signal that fires often, never adds a candidate, and loses on every profile is
 * a liability, so `DEFAULT_CALIBRATED_WEIGHTS` no longer carries it.
 *
 * The constant survives for two reasons, both deliberate: the ablation arm needs
 * it to reproduce the number above, and it is an exported symbol that downstream
 * packages import. Passing `{...DEFAULT_CALIBRATED_WEIGHTS, centralityPrior:
 * CENTRALITY_PRIOR_WEIGHT}` restores the old behaviour exactly.
 *
 * `memory-analytics.ts` is UNAFFECTED — hot modules and communities are their own
 * product surface (API + CLI + MCP), and this cut removes only the ~34 lines of
 * ranking wiring, not the analytics.
 */
export const CENTRALITY_PRIOR_WEIGHT = 0.08;

/** Which ranking tier a note falls in: 0 = clean active (the top band), 1 =
 *  suspect/contradicted (`stale` or `conflictsWith`, the strictly-lower warning
 *  band). Retrieval-time signals ONLY, NOT `status`/`supersededBy`/
 *  `invalidatedAt`, which describe state AFTER an as-of instant and would corrupt
 *  a bitemporal view (the current-set query already filters retired notes; the
 *  as-of query already scopes to validity at T, KG-5). */
export function rankTier(note: RankableNote): 0 | 1 {
  return note.stale || note.conflictsWith ? 1 : 0;
}

/** Decomposed calibrated score, each named contribution is surfaceable as a
 *  "why this memory ranked here" explanation. `total` is the within-tier ranking
 *  key; `tier` decides the band (a tier-1 note ALWAYS ranks below any tier-0). */
export type ScoreBreakdown = {
  total: number;
  /** weights.relevance × relevance. */
  relevance: number;
  /** (weights.centralityPrior ?? 0) × normalized note↔module graph centrality.
   *  KG-12: 0 on the default path — the field is KEPT rather than dropped so the
   *  "why this memory" readers that already destructure a breakdown keep working
   *  and can render an explicit zero contribution instead of a missing one. */
  centrality: number;
  /** weights.recency × recencyScore. */
  recency: number;
  /** weights.trust × trustNorm. */
  trust: number;
  /** weights.confirmed × (confirmed ? 1 : 0). */
  confirmed: number;
  /** weights.usage × usageNorm. */
  usage: number;
  /** recency+trust+confirmed+usage BEFORE the cap. */
  governanceRaw: number;
  /** min(governanceRaw, cap), what actually lifts the score. */
  governanceApplied: number;
  /** 0 = clean band, 1 = demoted warning band (strictly lower). */
  tier: 0 | 1;
  /** Human-readable demotion reasons, e.g. ["conflict"], ["stale"]. */
  demotionReason: string[];
};

/**
 * Decompose a note's calibrated score into named contributions. Pure +
 * deterministic (thread `now`, no wall-clock). The `total` is relevance +
 * capped governance; demotion is expressed as `tier` (structural), never folded
 * into the score, so the score stays a clean, comparable "why this memory" value.
 */
export function explainCalibratedScore(
  input: RankInput,
  weights: CalibratedWeights = DEFAULT_CALIBRATED_WEIGHTS,
  now: number = Date.now()
): ScoreBreakdown {
  const { note, relevance } = input;
  const relevanceContribution = weights.relevance * relevance;
  // KG-12: absent `centralityPrior` ⇒ 0, so the prior contributes nothing unless
  // a caller deliberately re-enables it (the ablation arm does; production does not).
  const centrality =
    (weights.centralityPrior ?? 0) *
    Math.max(0, Math.min(1, input.centrality ?? 0));
  const recency = weights.recency * recencyScore(note.createdAt, now);
  const trust = weights.trust * TRUST_NORM[note.trust];
  const confirmed = weights.confirmed * (note.confirmed ? 1 : 0);
  const usage = weights.usage * usageNorm(note.accessCount ?? 0);
  const governanceRaw = recency + trust + confirmed + usage;
  const governanceApplied = Math.min(governanceRaw, weights.governanceCap);

  const demotionReason: string[] = [];
  if (note.stale) {
    demotionReason.push("stale");
  }
  if (note.conflictsWith) {
    demotionReason.push("conflict");
  }

  return {
    total: relevanceContribution + centrality + governanceApplied,
    relevance: relevanceContribution,
    centrality,
    recency,
    trust,
    confirmed,
    usage,
    governanceRaw,
    governanceApplied,
    tier: rankTier(note),
    demotionReason,
  };
}

/** Calibrated within-tier score (relevance + capped governance). NOTE: ordering
 *  is (tier, score), use rerankCalibrated for the full ranking; a lower-tier
 *  note can have a higher score yet still rank below every clean note. */
export function calibratedScore(
  input: RankInput,
  weights: CalibratedWeights = DEFAULT_CALIBRATED_WEIGHTS,
  now: number = Date.now()
): number {
  return explainCalibratedScore(input, weights, now).total;
}

/**
 * KG-4 calibrated rerank. Drop-in replacement for rerankBySalience (same
 * signature shape: inputs → notes, best first). Ordering is LEXICOGRAPHIC:
 * (tier ascending, then score descending, then newest createdAt). The tier split
 * is the hard guarantee that a suspect/contradicted note NEVER outranks a clean
 * active note, surfaced as a warning below the clean band, not hidden.
 * Deterministic: equal inputs give equal output across runs.
 *
 * KG-12: `weights.centralityTieBreak` inserts centrality between the score and
 * the createdAt tiebreak — a strictly LAST-RESORT position where it can only
 * separate exactly-equal totals. OFF by default (the ablation shows it fires on
 * no query, so it would be dead code on the read path).
 */
export function rerankCalibrated(
  inputs: RankInput[],
  weights: CalibratedWeights = DEFAULT_CALIBRATED_WEIGHTS,
  now: number = Date.now()
): RankableNote[] {
  const tieBreak = weights.centralityTieBreak === true;
  return inputs
    .map((input) => ({
      input,
      tier: rankTier(input.note),
      score: calibratedScore(input, weights, now),
      centrality: tieBreak
        ? Math.max(0, Math.min(1, input.centrality ?? 0))
        : 0,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.score - a.score ||
        b.centrality - a.centrality ||
        b.input.note.createdAt.localeCompare(a.input.note.createdAt)
    )
    .map((entry) => entry.input.note);
}

// ---- dedup / contradiction on write (mem0-style, deterministic) ----

export type DuplicateVerdict =
  | { action: "insert" }
  | { action: "duplicate"; ofNoteId: string; similarity: number }
  | { action: "extends"; ofNoteId: string; similarity: number }
  | { action: "supersede"; ofNoteId: string; similarity: number }
  | { action: "conflict"; withNoteId: string; similarity: number }
  // KG-3 F1: a dense-only (lexically-unsupported) high-similarity match. Both
  // notes stay active + a "related" edge + reconcile, never a silent drop.
  | { action: "related"; withNoteId: string; similarity: number };

/** Normalize text for an exact-match check, mirrors the ledger's textHash
 *  normalize (trim, collapse whitespace, lowercase) so identical text counts as
 *  lexical corroboration even when tokenization would drop it (KG-3 F1). */
function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * TODO 4.9: the only automatic shape that may say "adds detail, both stay
 * true". Every meaningful token in the prior note must survive in the incoming
 * note and the incoming note must add at least one token. This is intentionally
 * conservative and lexical: it can miss paraphrased extensions, but a miss
 * falls back to the existing governed supersede/related paths. A hit is
 * non-destructive and gets a review marker in the durable ledger, so this
 * predicate can never retire either fact by itself.
 */
function isStrictLexicalExtension(incoming: string[], prior: string[]): boolean {
  const incomingSet = new Set(incoming);
  const priorSet = new Set(prior);
  return (
    priorSet.size > 0 &&
    incomingSet.size > priorSet.size &&
    [...priorSet].every((token) => incomingSet.has(token))
  );
}

/** Two notes are candidates for comparison only if they share an anchor. */
function sharesAnchor(a: MemoryNoteInputLike, b: MemoryNoteRecord): boolean {
  if (a.taskId && a.taskId === b.taskId) return true;
  if (overlapCount(a.modules ?? [], b.modules) > 0) return true;
  if (overlapCount(a.topics ?? [], b.topics) > 0) return true;
  // No anchors on the incoming note → fall back to lane scope.
  if (!a.taskId && (a.modules?.length ?? 0) === 0 && (a.topics?.length ?? 0) === 0) {
    return Boolean(a.laneId && a.laneId === b.laneId);
  }
  return false;
}

export type MemoryNoteInputLike = {
  kind: MemoryNoteRecord["kind"];
  text: string;
  taskId?: string | null;
  laneId?: string | null;
  modules?: string[];
  topics?: string[];
};

/**
 * Optional dense-vector lookup for the write-time dedup path (KG-3). When
 * present, similarity fires on `max(jaccard, cosine)` so a PARAPHRASE of an
 * existing note (few shared tokens but high cosine) dedups/supersedes instead of
 * accumulating a near-duplicate. Absent (no embedder configured, or a cold
 * cache) → pure jaccard, exactly the prior lexical behaviour. Injected, never
 * fetched here, `memory-ranking` stays a DB-free, deterministic pure module.
 */
export type NoteVectorLookup = {
  /** Dense vector of the incoming note (undefined → lexical-only). */
  incoming?: number[];
  /** Dense vector of an existing candidate by note id (undefined → lexical). */
  byId?: (noteId: string) => number[] | undefined;
};

// Lexical (jaccard) thresholds, token-overlap scale.
export const DUPLICATE_THRESHOLD = 0.82;
export const SUPERSEDE_THRESHOLD = 0.5;

// Dense (cosine) thresholds, a DIFFERENT scale than jaccard. With real embedding
// models even unrelated notes cosine ~0.5–0.6, so cosine gets its own, higher
// cut-offs; reusing the jaccard numbers here would make half the brain look like
// near-duplicates.
//
// KG-4 CALIBRATED (from the un-tuned KG-3 defaults, ADR-0009 open question #1).
// Grid-searched against the labeled dedup set (fixtures/eval-set.ts) with an
// ASYMMETRIC cost model, a MISSED merge (permanent near-dup accumulation) and a
// supersede→duplicate SUBTYPE error (drops the refinement) cost more than a
// spurious non-destructive `related` edge, subject to ZERO destructive false
// merges (KG-3 invariant). Chosen operating point:
//  - COSINE_DUPLICATE 0.90 → 0.92: at 0.90 a refined paraphrase (cosine ~0.91) is
//    collapsed into its predecessor as a "duplicate" (NOOP → refinement lost). At
//    0.92 refinements supersede (keep the delta); true near-identical text (cosine
//    ≥0.92 or exact match) still NOOPs. Improves duplicate-subtype precision.
//  - COSINE_SUPERSEDE STAYS 0.80 (the earlier KG-4 draft raised it to 0.83; the
//    reviewer flagged that as a RECALL regression, it turned genuine paraphrases
//    in the jaccard∈[0.30,0.50) × cosine∈[0.80,0.83) band from supersede into
//    INSERT, accumulating near-dups). Covering that band with labeled pairs, the
//    cost model keeps 0.80: recall of true merges beats avoiding a cheap `related`
//    edge on a distinct note. The lexical floor (below), not the cosine gate,
//    is what guards against destroying a distinct note.
export const COSINE_DUPLICATE_THRESHOLD = 0.92;
export const COSINE_SUPERSEDE_THRESHOLD = 0.8;

// Lexical-corroboration floor for a DESTRUCTIVE verdict (KG-3 F1). A duplicate
// (drops the incoming) or supersede (rejects the existing) is irreversible loss,
// so it is only allowed when there is genuine token overlap (jaccard ≥ floor) or
// an exact text match, NEVER on dense cosine alone. A high-cosine but
// lexically-unsupported match ("token bucket" vs "leaky bucket": cosine ~0.85,
// jaccard ~0, DIFFERENT facts) routes to the non-destructive `related` verdict:
// both notes stay active, a human reconciles.
//
// KG-4: the labeled dedup set CONFIRMS 0.30 as the operating point, it is the
// guard for KG-3's non-destructive invariant, not a cosine knob. Dropping to
// 0.25 admits a destructive merge on a low-overlap distinct note; raising to 0.35
// drops a genuine lexically-corroborated refinement. 0.30 keeps both correct.
export const LEXICAL_SUPPORT_FLOOR = 0.3;

/**
 * The full dedup operating point (KG-4). Bundles the five thresholds so the
 * calibration grid-search can sweep candidates and production can pin one set.
 * `DEFAULT_DEDUP_THRESHOLDS` mirrors the exported constants above (single source
 * of truth); `classifyIncomingNote` uses it unless a caller injects an override
 * (only the eval/calibration harness does).
 */
export type DedupThresholds = {
  duplicate: number;
  supersede: number;
  cosineDuplicate: number;
  cosineSupersede: number;
  lexicalFloor: number;
};

export const DEFAULT_DEDUP_THRESHOLDS: DedupThresholds = {
  duplicate: DUPLICATE_THRESHOLD,
  supersede: SUPERSEDE_THRESHOLD,
  cosineDuplicate: COSINE_DUPLICATE_THRESHOLD,
  cosineSupersede: COSINE_SUPERSEDE_THRESHOLD,
  lexicalFloor: LEXICAL_SUPPORT_FLOOR,
};

/**
 * Decide what to do with a proposed note given the active notes already in
 * the brain (mem0's ADD/UPDATE/DELETE/NOOP, deterministic):
 * - same-kind strict token extension + anchor   → extends (both stay), even at
 *   duplicate-strength similarity so added detail is never dropped
 * - very high text similarity + shared anchor  → duplicate (NOOP)
 * - moderate similarity, same kind + anchor     → supersede (UPDATE, temporal
 *   history preserved by the caller)
 * - moderate similarity but a decision/constraint that contradicts (opposite
 *   polarity words) → conflict: surface to the human, never silently pick
 * - otherwise                                    → insert (ADD)
 *
 * Contradiction is intentionally conservative: only decisions/constraints,
 * only when one says do/use/enable and the other not/never/disable about the
 * same anchor. False negatives (insert both) are safe, humans reconcile.
 */
const NEGATION = /\b(not|never|no|don't|do not|avoid|disable|remove|stop|drop)\b/i;

export function classifyIncomingNote(
  incoming: MemoryNoteInputLike,
  existing: MemoryNoteRecord[],
  vectors?: NoteVectorLookup,
  // KG-4: thresholds are injectable so the calibration harness can sweep a grid
  // over the SAME classifier (no logic drift). Production omits it → the tuned
  // DEFAULT_DEDUP_THRESHOLDS. Contract-preserving: prior 3-arg callers unchanged.
  thresholds: DedupThresholds = DEFAULT_DEDUP_THRESHOLDS
): DuplicateVerdict {
  const incomingTokens = tokenize(incoming.text);
  const incomingVec = vectors?.incoming;
  const incomingNorm = normalizeForMatch(incoming.text);
  const incomingNeg = NEGATION.test(incoming.text);

  // Per candidate track BOTH channels, the action tier, whether a DESTRUCTIVE
  // verdict is lexically corroborated (KG-3 F1), and whether it is an opposite-
  // polarity contradiction (KG-3 F4). Dense only participates when both vectors
  // are present; otherwise cosine is 0 and the verdict is pure jaccard.
  type Candidate = {
    note: MemoryNoteRecord;
    lex: number;
    dense: number;
    tier: number; // 2 = duplicate-strength, 1 = supersede-strength, 0 = none
    lexicallySupported: boolean;
    oppositePolarity: boolean;
    strictExtension: boolean;
  };
  const candidates: Candidate[] = [];

  for (const note of existing) {
    if (note.status !== "active") continue;
    if (!sharesAnchor(incoming, note)) continue;
    const noteTokens = tokenize(note.text);
    const lex = jaccard(incomingTokens, noteTokens);
    const existingVec = vectors?.byId?.(note.id);
    const dense =
      incomingVec && existingVec ? cosine(incomingVec, existingVec) : 0;

    const isDup =
      lex >= thresholds.duplicate || dense >= thresholds.cosineDuplicate;
    const isSupersede =
      lex >= thresholds.supersede || dense >= thresholds.cosineSupersede;
    const tier = isDup ? 2 : isSupersede ? 1 : 0;
    if (tier === 0) continue;

    // Lexical corroboration for a destructive verdict: real token overlap OR an
    // exact (normalized) text match. Dense cosine alone is NOT corroboration.
    const lexicallySupported =
      lex >= thresholds.lexicalFloor ||
      normalizeForMatch(note.text) === incomingNorm;
    // Polarity gate, now ALL kinds (KG-3 F1), not just decision/constraint.
    const oppositePolarity =
      note.kind === incoming.kind && NEGATION.test(note.text) !== incomingNeg;

    candidates.push({
      note,
      lex,
      dense,
      tier,
      lexicallySupported,
      oppositePolarity,
      strictExtension:
        note.kind === incoming.kind &&
        isStrictLexicalExtension(incomingTokens, noteTokens),
    });
  }

  if (candidates.length === 0) {
    return { action: "insert" };
  }

  const stronger = (a: Candidate, b: Candidate): Candidate =>
    b.tier > a.tier ||
    (b.tier === a.tier && Math.max(b.lex, b.dense) > Math.max(a.lex, a.dense))
      ? b
      : a;

  // F4: a same-kind, opposite-polarity candidate is a CONTRADICTION, evaluate
  // it across EVERY tier-≥1 candidate (not just the single strongest), so a
  // benign higher-cosine duplicate can never float above and mask a genuine
  // contradiction. Non-destructive (both stay active), so it needs no lexical
  // floor and is decided BEFORE any duplicate/supersede.
  const conflicts = candidates.filter((c) => c.oppositePolarity);
  if (conflicts.length > 0) {
    const best = conflicts.reduce(stronger);
    return {
      action: "conflict",
      withNoteId: best.note.id,
      similarity: Math.max(best.lex, best.dense),
    };
  }

  const best = candidates.reduce(stronger);
  const similarity = Math.max(best.lex, best.dense);

  // F1: a DESTRUCTIVE verdict (duplicate drops the incoming; supersede rejects
  // the existing) requires lexical corroboration. A dense-only match keeps BOTH
  // notes with a "related" link + reconcile, dense similarity alone must NEVER
  // silently drop/reject a note (irreversible loss).
  if (!best.lexicallySupported) {
    return { action: "related", withNoteId: best.note.id, similarity };
  }

  // A strict lexical refinement is an additive relation, never a destructive
  // rewrite. Test it before duplicate-strength similarity: an exact or
  // same-token duplicate cannot satisfy strictExtension, while a short note
  // with one added detail otherwise crosses the duplicate threshold and loses
  // the new information.
  if (best.strictExtension) {
    return { action: "extends", ofNoteId: best.note.id, similarity };
  }
  if (best.tier === 2) {
    return { action: "duplicate", ofNoteId: best.note.id, similarity };
  }
  // Same kind, moderately similar, same polarity, lexically corroborated → a
  // refinement of the old.
  if (best.note.kind === incoming.kind) {
    return { action: "supersede", ofNoteId: best.note.id, similarity };
  }
  return { action: "insert" };
}

// ---- governed multi-principal writes (KG-6) ----
//
// `classifyIncomingNote` stays PURE and trust-AGNOSTIC (above): it only decides
// whether the incoming note is a duplicate/supersede/conflict/related by text.
// The AUTHORIZATION to actually APPLY a destructive verdict (supersede that
// retires an existing note, or duplicate that drops the incoming) is a distinct,
// governance concern, it depends on WHO is writing (trust) and whether the
// victim is human-confirmed. That decision lives in the ledger (where the
// authoritative principal/trust/confirmed signals are known), but the PREDICATE
// itself is a pure, deterministic, unit-testable function kept here so both the
// ledger and the graph agree on the same rule.

/** Total order over trust for the write gate: low < medium < high. A destructive
 *  write is authorized over a victim only if the writer ranks at or above it. */
export const TRUST_RANK: Record<MemoryTrust, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function trustRank(trust: MemoryTrust): number {
  return TRUST_RANK[trust] ?? 0;
}

export type DestructiveWriteAuthorization = {
  /** The incoming note's (derived) trust. */
  incomingTrust: MemoryTrust;
  /** Whether the incoming note is authored by a HUMAN principal (the top
   *  authority, a human may refine any fact, confirmed or not). */
  incomingIsHuman: boolean;
  /** The existing (victim) note's trust. */
  existingTrust: MemoryTrust;
  /** Whether the victim is human-CONFIRMED (the strongest protection). */
  existingConfirmed: boolean;
};

/**
 * The KG-6 trust gate, the exact predicate that decides whether a DESTRUCTIVE
 * verdict may APPLY:
 *
 *   APPLY  iff  incomingIsHuman
 *          OR  (trustRank(incoming) >= trustRank(existing) AND NOT existingConfirmed)
 *
 * A human-authored write is always authorized (top authority). Otherwise a
 * same-or-higher-trust writer may supersede an UNCONFIRMED peer/lower note (no
 * over-block, a legitimate refinement still proceeds), but a lower-trust writer,
 * or ANY non-human write against a human-CONFIRMED victim, is NOT authorized,
 * the ledger keeps both notes and records a contestable PROPOSES_SUPERSEDE
 * (unconfirmed victim) or a non-destructive `related` (confirmed victim). This is
 * what makes the brain's memory ungameable by a low-trust writer.
 *
 * NOTE: this gates on DECLARED trust (the principal's trust field), NOT on
 * authenticated identity, principal authn is out of scope (see KG-6 residuals).
 */
export function authorizesDestructiveWrite(
  auth: DestructiveWriteAuthorization
): boolean {
  if (auth.incomingIsHuman) {
    return true;
  }
  return (
    trustRank(auth.incomingTrust) >= trustRank(auth.existingTrust) &&
    !auth.existingConfirmed
  );
}
