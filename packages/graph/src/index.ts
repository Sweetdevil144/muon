export { MuonGraph } from "./muon-graph.js";
export { rankLanes } from "./routing.js";
export {
  classifyIncomingNote,
  reciprocalRankFusion,
  rerankBySalience,
  salienceScore,
  // KG-4 calibrated ranker.
  rerankCalibrated,
  calibratedScore,
  explainCalibratedScore,
  rankTier,
  usageNorm,
  DEFAULT_CALIBRATED_WEIGHTS,
  CENTRALITY_PRIOR_WEIGHT,
  recencyScore,
  decayAccessCount,
  USAGE_DECAY_HALF_LIFE_DAYS,
  jaccard,
  cosine,
  DUPLICATE_THRESHOLD,
  SUPERSEDE_THRESHOLD,
  COSINE_DUPLICATE_THRESHOLD,
  COSINE_SUPERSEDE_THRESHOLD,
  LEXICAL_SUPPORT_FLOOR,
  DEFAULT_DEDUP_THRESHOLDS,
  // KG-6 governed writes: the pure, deterministic trust gate.
  trustRank,
  TRUST_RANK,
  authorizesDestructiveWrite,
  type NoteVectorLookup,
  type CalibratedWeights,
  type ScoreBreakdown,
  type DedupThresholds,
  type DestructiveWriteAuthorization,
} from "./memory-ranking.js";
// R3 TTL: the graph MIRROR of the ledger's expiry rule (the ledger stays the
// source of truth and still post-filters). Pure + exported so the predicate and
// the cypher clause it pairs with can be pinned to `isExpiredRow` by test.
// Model-mined memory: PROVENANCE vocabulary, no longer a gate. Crew visibility
// admits a mined note exactly like any other agent note (the operator's
// `autoConfirmAgentMemory` posture decides); these predicates exist so a review
// surface can still say "a machine wrote this, no human has vouched for it". A
// byte-faithful mirror of @muon/core's vocabulary (the leaf package takes no
// monorepo deps); a canary test pins them together.
export {
  isModelMinedMemoryPrincipal,
  isUnreviewedModelMinedNote,
  MEMORY_EXTRACTOR_PRINCIPAL,
} from "./memory-mining.js";
export {
  isMemoryNoteExpired,
  memoryAuthorIsHuman,
  memoryNotExpiredClause,
  memoryTtlRedeemed,
  resolveExpiryNow,
  MEMORY_EXPIRY_PARAM,
  type MemoryExpiryFacts,
} from "./memory-expiry.js";
// D4 + D6: the ANCHOR term of the candidate query, in both languages, in one
// file. The cypher clause traverses the `ANCHORED_TO`/`ABOUT_SYMBOL` edge (the
// ACCESS PATH); the JS net reads `n.modules`/`n.symbols` (the AUTHORITY) and is
// what INTERSECTS the FTS/semantic arms, which take no WHERE predicate. Exported
// so a test can pin the two halves to each other.
export {
  anchorFenceIsEmpty,
  anchorSetSize,
  memoryAnchorArms,
  normalizeAnchorSet,
  noteMatchesAnchors,
  MAX_ANCHOR_VALUES,
  MEMORY_ANCHOR_MODULE_PARAM,
  MEMORY_ANCHOR_SYMBOL_PARAM,
  type MemoryAnchorArm,
  type MemoryAnchorSet,
} from "./memory-anchors.js";
// KG-6 gate: the ONE governed-read predicate. The store applies it to the
// mirror's copies while building candidates; the backend re-applies it to the
// LEDGER's copies at the route, where `confirmed` is authoritative.
// D14: `memoryGateTier` is the SAME rule with its verdict kept, so a coverage
// tally ("all 32 were crew-vouched, none confirmed") cannot drift from the
// predicate that admitted them. Diagnostic only — never an admission input.
export {
  memoryGateTier,
  memoryPassesGate,
  type MemoryGateTier,
} from "./memory-gate.js";
export {
  analyzeMemoryGraph,
  type MemoryAnalyticsInputNote,
  type MemoryAnalyticsOptions,
  type MemoryAnalyticsSnapshot,
  type MemoryCentralityScore,
  type MemoryCommunitySummary,
  type MemoryHotModule,
} from "./memory-analytics.js";
// KG-4 retrieval evaluation: metrics + deterministic calibration harness.
export {
  dcg,
  ndcgAtK,
  reciprocalRank,
  precisionAtK,
  evaluateRanker,
  runRankScenario,
  gridSearchRankWeights,
  scoreDedupThresholds,
  calibrateDedupThresholds,
  classifyDedupCase,
  DEFAULT_RANK_WEIGHT_GRID,
  DEFAULT_DEDUP_THRESHOLD_GRID,
  type RankScenario,
  type RankerFn,
  type LabeledCandidate,
  type ScenarioResult,
  type RankerReport,
  type DedupCase,
  type DedupScore,
} from "./retrieval-eval.js";
// KG-11 (ADR-0014 §7): the HONEST held-out eval of collision + duplicate-work
// detection, the activity-channel sibling of retrieval-eval. Tunes the two shipped
// knobs on TRAIN, reports precision/recall/F1/MRR on a DISJOINT TEST split.
export {
  runActivityEval,
  scoreSplit,
  gridSearchActivityKnobs,
  predictSurface,
  assertDisjointSplit,
  formatActivityEvalReport,
  DEFAULT_ACTIVITY_KNOB_GRID,
  SHIPPED_RECENT_ACTIVITY_WINDOW_MS,
  SHIPPED_DUP_WORK_THRESHOLD,
  ACTIVITY_EVAL_HONESTY,
  type ActivityEvalSet,
  type ActivityEvalReport,
  type ActivityKnobs,
  type ActivityKnobGrid,
  type EvalScenario,
  type EvalPeer,
  type SplitScore,
  type SurfacedPeer,
  type KnobSearchResult,
} from "./activity-eval.js";
export { DEFAULT_ACTIVITY_EVAL_SET } from "./fixtures/activity-eval-set.js";
// KG-12: the graph-value ablation. Measures whether MUON's GRAPH signals (N-hop
// traversal, the centrality prior) beat flat hybrid search on one corpus, with
// each signal's marginal contribution and its cost visible. Re-run after any
// retrieval change: `npm run eval:graph-value -w @muon/graph`.
export {
  runGraphValueEval,
  runGraphValueEvalProfiles,
  formatGraphValueEvalReport,
  formatGraphValueEvalProfiles,
  auditReachability,
  measureProvenanceCoverage,
  prepareGraphValueEval,
  runQueryArm,
  buildTraversalIndex,
  graphExpand,
  bm25Rank,
  lexicalRank,
  denseRank,
  entityRank,
  recallAtK,
  ndcgFull,
  conceptVector,
  toNoteRecord,
  ARM_IDS,
  ARM_CONFIGS,
  ANCHOR_ONLY_RELATIONS,
  DEFAULT_ARM_RUN_OPTIONS,
  TIGHT_ARM_RUN_OPTIONS,
  DENSE_OFF_ARM_RUN_OPTIONS,
  PROVENANCE_QUESTIONS,
  CODE_SURFACE,
  GRAPH_VALUE_EVAL_HONESTY,
  type ArmId,
  type ArmConfig,
  type ArmReport,
  type ArmRunOptions,
  type CentralityImpact,
  type CentralityMode,
  type EntityImpact,
  type CodeSurface,
  type EvalCapability,
  type EvalNote,
  type EvalQuery,
  type EvalTask,
  type ExpansionHit,
  type GraphValueEvalProfiles,
  type GraphValueEvalReport,
  type GraphValueEvalSet,
  type ProvenanceCoverage,
  type QueryRun,
  type ReachabilityAudit,
  type TraversalIndex,
  type TraversalNode,
} from "./graph-value-eval.js";
export { DEFAULT_GRAPH_VALUE_EVAL_SET } from "./fixtures/graph-value-eval-set.js";
// R2 (mem0 §5.3): the entity slice of the graph-value corpus — the base set plus
// notes whose durable nouns live in their PROSE and which anchor to no module.
export {
  ENTITY_GRAPH_VALUE_EVAL_SET,
  ENTITY_NOTES,
  ENTITY_QUERIES,
} from "./fixtures/graph-value-entity-set.js";
// R2 entity extraction + linking: the deterministic, dependency-free base tier
// that turns note text into join keys, plus the pure ranker the store and the
// eval harness share.
export {
  extractEntities,
  extractQueryEntities,
  rankByEntityMentions,
  entityIdf,
  entityKindWeight,
  // D15 + memory-index-validation.md §1.3: the path predicate itself, so the
  // coordinate layer and the health harness ask "is this path-shaped?" with the
  // production pattern rather than with a copy of it.
  isPathShaped,
  pathShapedTokens,
  PATH_RE,
  SYMBOL_RE,
  MAX_ENTITY_SCAN_CHARS,
  MIN_ENTITY_CHARS,
  MAX_ENTITY_CHARS,
  MAX_ENTITIES_PER_NOTE,
  MAX_QUERY_ENTITIES,
  type MemoryEntity,
  type MemoryEntityKind,
  type EntityMention,
  type EntityCorpusStats,
} from "./memory-entities.js";
export { extractFromSignal, type WorkSignal } from "./memory-extract.js";
// ADR-0012 symbol identity: the shared `<module>#<name>` helpers (single source
// for the ledger + graph; the provider mirrors the trivial join/split locally to
// stay native-dep-free, guarded by the merge-gating round-trip test).
export {
  toSymbolId,
  moduleOfSymbol,
  symbolNameOf,
  deriveModulesFromSymbols,
  // D2 option B (docs/design/memory-index-decisions.md): map a GitNexus symbol
  // uid onto the local id the `symbolUid` cache is keyed by.
  gitnexusUidToLocalSymbolId,
} from "./symbol-id.js";
// P2.5 HERO: the pluggable, local-first code blast-radius provider (default = no
// egress). See preEditContext for the fusion that consumes it.
export {
  NullCodeGraphProvider,
  type BlastRadius,
  type CodeGraphProvider,
  type EditTarget,
} from "./code-graph.js";
// The traversal text-gate rule, as a value, so a producer/consumer states the
// policy it implements instead of retyping a string that has already drifted
// once (R3 TTL and F9 both narrowed it after the first label was written).
export { MEMORY_TRAVERSAL_TEXT_POLICY } from "./types.js";
export type {
  Embedder,
  EmbeddingCacheStore,
  LaneOutcomeStats,
  LaneSuggestion,
  MemoryExplainResult,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphNodeType,
  MemoryGraphRelation,
  MemoryIngestResult,
  MemoryKind,
  MemoryNeighborsOptions,
  MemoryNeighborsResult,
  MemoryNoteInput,
  MemoryNoteRecord,
  MemoryNoteUpdate,
  NoteDerivation,
  NoteReviewStatus,
  MemoryRecallFilter,
  MemoryRetrievalRequest,
  MemoryTrust,
  MemoryTraversalProvenance,
  MemoryTraversalTextPolicy,
  MemoryWriteAction,
  PreEditActivity,
  PreEditDuplicateWork,
  PrincipalKind,
  PrincipalRecord,
} from "./types.js";
