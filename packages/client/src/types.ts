import type {
  AgentRole,
  VendorId,
  HarnessCheck,
  HarnessConfig,
  ApprovalEvidence,
  MergeReviewRecord,
  DelegationPolicy,
  LoopProgress,
  PreEditCoverage,
  WorkflowDefinition,
  WorkflowProposal,
  AttemptOutcome,
  ContextArtifactKind,
  ContextCondensationOrigin,
  ContextFrameDeliveryStatus,
  ContextFrameSource,
} from "@muon/protocol";

// D14 lives in @muon/protocol because it is a WIRE contract with a closed enum
// several packages must switch on. Re-exported here so the pre-edit surfaces keep
// pulling every pre-edit type from one module (preedit-view.ts re-exports again
// for the browser-bundled renderer).
export type {
  PreEditCoverage,
  PreEditCoverageEmptyReason,
} from "@muon/protocol";

export type TaskPriority = "low" | "medium" | "high";

export type TaskStatus =
  | "backlog"
  | "in_progress"
  | "review"
  | "done"
  | "blocked";

export type ApprovalKind =
  | "merge"
  | "command"
  | "deploy"
  | "dangerous_action"
  | "gate";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export type Lane = {
  id: string;
  key: string;
  name: string;
  provider: string;
  role: string;
  status: string;
};

export type Assignment = {
  id: string;
  taskId: string;
  laneId: string;
  summary: string;
  state: string;
  lane?: Lane;
};

export type Handoff = {
  id: string;
  taskId: string;
  fromLaneId: string;
  toLaneId: string;
  packetTitle: string;
  packetBody: string;
  status: string;
  fromLane?: Lane;
  toLane?: Lane;
};

export type ApprovalRequest = {
  id: string;
  taskId: string;
  requestedBy: string;
  kind: ApprovalKind;
  reason: string;
  status: ApprovalStatus;
  decisionNotes?: string | null;
  gateTag?: string | null;
  evidence?: ApprovalEvidence | null;
  /** Operator-derived, artifact-bound merge review audit record. */
  reviewCertification?: MergeReviewRecord | null;
  // Checkpoint edge (P0.1): the DispatchJob whose execution filed this
  // approval (agent-supplied binding; null for pre-P0.1 rows and non-job gates).
  jobId?: string | null;
  /**
   * SERVER-derived vendor of the bound job (jobId → DispatchJob.vendor on the
   * list read). Null when the approval has no resolvable job binding. Feeds
   * vendor-scoped standing consent; never caller-supplied.
   */
  laneVendor?: string | null;
  consumedAt?: string | null;
  createdAt?: string;
  decidedAt?: string | null;
};

export type LaneEventKind =
  | "task.started"
  | "task.progress"
  | "task.blocked"
  | "task.completed"
  | "approval.requested"
  // P0.4: a policy- or receipt-sourced auto-allow; every non-human allow is
  // visible on the event spine.
  | "approval.auto"
  | "handoff.created"
  | "workflow.proposed"
  | "workflow.applied"
  | "workflow.step.started"
  | "workflow.step.completed"
  | "loop.iteration"
  | "loop.escalated"
  | "loop.stopped"
  | "lane.profile.updated"
  | "harness.updated"
  | "workflow.template.updated"
  | "fleet.updated";

// P0.4: a content-bound, expiring receipt minted by an explicit operator
// opt-in on one approval decision. Bound to the exact action + payload digest
// + workspace + run + manifest; any drift falls back to the full gate.
export type ApprovalReceipt = {
  id: string;
  approvalId: string;
  taskId: string;
  jobId: string;
  sessionId?: string | null;
  workspacePath: string;
  actionClass: "read" | "test" | "edit";
  toolName: string;
  payloadDigest: string;
  manifestFingerprint?: string | null;
  expiresAt: string;
  revokedAt?: string | null;
  useCount: number;
  lastUsedAt?: string | null;
  createdAt?: string;
};

export type RecordedEvent = {
  id: string;
  laneId: string;
  taskId: string;
  kind: LaneEventKind;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  /** Auth-derived actor; nullable on rows written before migration 0043. */
  principalId?: string | null;
  principalKind?: "human" | "agent" | string | null;
  /** Human accountable for an agent act, when the ledger has that binding. */
  accountablePrincipalId?: string | null;
  /** Stable request/gate correlation id, not authority by itself. */
  requestId?: string | null;
  /** Structured before/after evidence. Untrusted data, never instructions. */
  payloadDiff?: unknown;
};

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Owning orchestrator chat for crew-created work. */
  chatId?: string | null;
  /** Set when this task is a workflow step (null/absent = ad-hoc task). */
  workflowRunId?: string | null;
  stepKey?: string | null;
  /** Target repo folder for dispatch (null = executing client's cwd). */
  workspacePath?: string | null;
  assignments?: Assignment[];
  handoffs?: Handoff[];
  approvals?: ApprovalRequest[];
};

export type Health = {
  status: "ok";
  service: string;
  timestamp: string;
};

export type AssignmentDetail = {
  id: string;
  summary: string;
  state: string;
  createdAt: string;
  completedAt?: string | null;
  lane?: Lane;
};

export type HandoffDetail = {
  id: string;
  packetTitle: string;
  packetBody: string;
  /**
   * Typed v2 packet (P0.3), null/absent for legacy rows. Untrusted
   * agent-produced data: validate with handoffPacketSchema before use.
   */
  packetJson?: unknown;
  status: string;
  createdAt: string;
  fromLane?: Lane;
  toLane?: Lane;
};

export type ApprovalDetail = {
  id: string;
  requestedBy: string;
  kind: string;
  reason: string;
  status: string;
  decisionNotes?: string | null;
  gateTag?: string | null;
  consumedAt?: string | null;
  createdAt: string;
  decidedAt?: string | null;
};

export type CoordinationMetrics = {
  approvals: {
    decided: number;
    pending: number;
    averageTurnaroundMs: number | null;
    medianTurnaroundMs: number | null;
  };
  handoffs: {
    total: number;
    prepSamples: number;
    averagePrepMs: number | null;
    medianPrepMs: number | null;
  };
  assignments: {
    total: number;
    duplicateBriefings: number;
    tasksWithDuplicates: number;
  };
  tasks: {
    total: number;
    completed: number;
    averageCycleMs: number | null;
    medianCycleMs: number | null;
  };
};

export type TaskDetail = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  chatId?: string | null;
  workflowRunId?: string | null;
  stepKey?: string | null;
  workspacePath?: string | null;
  createdAt: string;
  updatedAt: string;
  assignments: AssignmentDetail[];
  handoffs: HandoffDetail[];
  approvals: ApprovalDetail[];
};

export type MemoryKind =
  | "decision"
  | "constraint"
  | "convention"
  | "attempt"
  | "question";

export type MemoryTrust = "low" | "medium" | "high";

export type MemoryNote = {
  id: string;
  kind: MemoryKind;
  text: string;
  taskId?: string | null;
  laneId?: string | null;
  modules: string[];
  topics: string[];
  /** Symbol anchors (ADR-0012): `<module>#<name>` ids; [] for a module-only note. */
  symbols: string[];
  trust: MemoryTrust;
  confirmed: boolean;
  stale: boolean;
  status: "active" | "paused" | "rejected";
  scope?: string;
  chatId?: string | null;
  /** ADR-0026 §8 — WHICH WORKSPACE this note belongs to (a canonical absolute repo
   *  root), or null for the unassigned residue. This is the LABEL every surface
   *  renders: `null` means "unscoped", and a surface showing a mixed page without it
   *  is the leak §1 measured (one operator library page spanning two repos with
   *  nothing distinguishing them). Absent on an older backend → null. */
  workspacePath?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** R3 TTL: the policy deadline, or null/absent when this note never expires
   *  (every human-authored, confirmed, or high-trust note, and every note
   *  written before the TTL policy existed). */
  expiresAt?: string | null;
  /** R3 TTL: derived — past its deadline and hidden from recall unless the
   *  operator explicitly asked to see expired notes. */
  expired?: boolean;
  /** Operator-owned protection from automated expiry, compaction, and delete. */
  pinned?: boolean;
  /** Source episode for this exact revision. */
  provenance?: {
    sourceType: string;
    rawRef: string | null;
    createdAt: string;
  } | null;
  /** P0-2: WHO vouched for this note. `"human"` is the strictly stronger tier
   *  and is exactly what `confirmed` reports; `"orchestrator"` means the crew's
   *  coordinator vouched, so the note is settled and usable by every agent
   *  without ever claiming a person read it. Absent/null → nobody has, and it
   *  is the only state that still owes the operator a decision. */
  confirmedBy?: "human" | "orchestrator" | null;
  /** Structured result for attempt memory; null for legacy/non-attempt notes. */
  outcome?: AttemptOutcome | null;
};

export type MemoryGraphRelation =
  | "SUPERSEDES"
  | "EXTENDS"
  | "CONTRADICTS"
  | "AUTHORED_BY"
  | "CONFIRMED_BY"
  | "ANCHORED_TO"
  | "ABOUT_SYMBOL"
  | "ABOUT_TASK"
  | "BY_LANE"
  | "TOUCHED"
  | "WORKED_ON"
  | "GATED_BY"
  | "CLONED_FROM";

export type MemoryGraphNodeType =
  | "note"
  | "principal"
  | "module"
  | "symbol"
  | "task"
  | "lane"
  | "approval";

/** Agent-safe memory traversal node. `text` is the only content-bearing field
 * and is absent unless the backend's gate admitted it — the rule is named on the
 * wire by {@link MEMORY_TRAVERSAL_TEXT_POLICY}. */
export type MemoryGraphNode = {
  id: string;
  entityId: string;
  type: MemoryGraphNodeType;
  kind?: string;
  trust?: MemoryTrust;
  confirmed?: boolean;
  status?: string;
  vendor?: string | null;
  module?: string;
  name?: string;
  text?: string;
  textTruncated?: boolean;
};

export type MemoryGraphEdge = {
  from: string;
  to: string;
  relation: MemoryGraphRelation;
};

/**
 * Why a traversal node did or did not carry `text`, as the backend reports it.
 * MIRRORS `@muon/graph`'s `MEMORY_TRAVERSAL_TEXT_POLICY` (this package is
 * browser-safe and takes no graph dependency); the api-client's zod literal and
 * a drift canary keep the two spellings identical.
 *
 * Read it as: **confirmed, OR crew-visible that is also unexpired.** The
 * `unexpired` qualifier is load-bearing — a lapsed unconfirmed note (R3 TTL) is
 * crew-visible by chat and still has its text withheld, which the older
 * `confirmed-or-crew-visible` label denied. A human confirm redeems it.
 * Authorship is NOT a qualifier: crew visibility carries model-mined prose like
 * any other agent note, because the operator's `autoConfirmAgentMemory` posture
 * is what decides whether unconfirmed agent memory reaches the crew at all.
 *
 * Closed union on purpose: a future policy change must break every consumer at
 * compile time rather than arrive as an unrecognised string.
 */
export const MEMORY_TRAVERSAL_TEXT_POLICY =
  "confirmed-or-unexpired-crew-visible" as const;

export type MemoryTraversalTextPolicy = typeof MEMORY_TRAVERSAL_TEXT_POLICY;

export type MemoryTraversalProvenance = {
  root: string;
  hops: number;
  relations: MemoryGraphRelation[];
  truncated: boolean;
  textPolicy: MemoryTraversalTextPolicy;
};

export type MemoryNeighborsResult = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  provenance: MemoryTraversalProvenance;
};

export type MemoryExplainResult = {
  noteId: string;
  path: {
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
    goal: "approval" | "principal" | "task" | "anchor" | "note" | "missing";
  };
  contradictions: MemoryGraphNode[];
  provenance: MemoryTraversalProvenance;
};

export type MemoryDeleteResult = {
  noteId: string;
  deleted: true;
  alreadyDeleted: boolean;
};

export type MemoryCloneResult = {
  noteId: string;
  clonedFromNoteId: string;
  confirmed: false;
};

export type MemoryCompactionResult = {
  /**
   * What this run's counts depended on. Pass it back on an apply to bind that
   * apply to THIS preview; the brain refuses (409) if the retention window
   * moved since. It matters most here: a compaction clears text.
   */
  previewDigest?: string;
  retentionDays: number;
  cutoff: string;
  scanned: number;
  tombstoned: number;
  noteIds: string[];
  dryRun: boolean;
  batchId: string | null;
  reason: string | null;
};

export type LaneSuggestion = {
  laneId: string;
  laneKey: string;
  laneName: string;
  score: number;
  reason: string;
};

// ---- P2.5 HERO: preEditContext (the dual-graph pre-edit gate) ----

/** What the agent is about to edit. `symbol` is echoed for provenance (MUON has
 *  no symbol graph yet, CG-1); anchoring is at the MODULE level. */
export type EditTarget = {
  symbol?: string;
  module?: string;
  files?: string[];
};

/** A surfaced GOVERNED (human-confirmed) memory annotated with its proximity to
 *  the edit: 1 = on the exact target module, <1 = a blast-radius neighbour. */
export type PreEditMemory = MemoryNote & {
  proximity: number;
  onTarget: boolean;
  /** True when anchored to the exact edit-target SYMBOL (ADR-0012 finest tier). */
  onSymbol: boolean;
  /** Substrate §3.3: force-attached by path-triggered standing injection. */
  injected?: boolean;
  /**
   * ADR-0035: a same-chat peer cited this note as a finding on this radius,
   * e.g. "cited by reviewer (review_verdict)".
   *
   * COORDINATES ONLY — role and message kind. The citing message's subject and
   * body deliberately have no field to ride in here: untrusted peer prose
   * reaches an agent through `peer_inbox`, a boundary it opens itself. The
   * citation does NOT change the note's trust tier; a cited-but-unconfirmed
   * note still cannot satisfy the confirmed-only edit gate.
   */
  citedBy?: string;
};

/**
 * ADR-0027's informational lane. This text may help a sibling coordinate, but
 * it is never an edit-gate fact and never enters convergence authority. The
 * literal fields keep the boundary machine-checkable at every wire hop.
 *
 * `confirmedBy` widened 2026-08-06 (same founder-directed change as recall):
 * under the crew-visible posture, a SAME-MISSION unvouched note rides this
 * inform channel too — `null` says nobody vouched, and `tier` stays the gate's
 * own name for the same-chat admission ("crew_vouched" = memoryGateTier's
 * crew tier, which never consulted the vouch either).
 */
export type PreEditCrewFinding = PreEditMemory & {
  confirmed: false;
  confirmedBy: "orchestrator" | null;
  tier: "crew_vouched";
  authority: "inform";
};

/** A contested/contradicting memory to show before editing (KG-5 CONTRADICTS /
 *  KG-6 PROPOSES_SUPERSEDE). */
export type PreEditWarning = {
  kind: "contradicts" | "proposes_supersede";
  noteId: string;
  relatedNoteId: string;
  detail: string;
};

/** An unresolved PROPOSES_SUPERSEDE for the target. IDs + anchors + a GENERIC
 *  detail ONLY, never the untrusted proposal TEXT (which would be a prompt-
 *  injection vector to the agent). A human fetches the text on demand by id, then
 *  resolves it via the EXISTING KG-6 confirm route:
 *  PATCH /api/memory/{proposalNoteId} { confirmed }. */
export type PreEditPendingProposal = {
  proposalNoteId: string;
  victimNoteId: string;
  modules: string[];
  detail: string;
};

/**
 * KG-7 (ADR-0014), a cross-agent LIVE activity coordinate: which OTHER live lane
 * is currently working on the edit target's symbol/module. COORDINATES ONLY, no
 * `Event.message`, `DispatchJob.brief`, or note text ever appears here (the
 * brain-gate side-channel invariant). A sibling channel to `memories`; never a
 * memory, never in the gate.
 */
export type PreEditActivity = {
  laneId: string;
  vendor: string;
  taskId: string;
  jobId: string;
  kind: "running" | "editing";
  anchor: string;
  anchorKind: "symbol" | "module";
  at: string;
  /** KG-7 `"live"` = a peer job running right now (present tense); KG-8 `"recent"`
   *  = a peer that touched this anchor within the bounded recent window (past
   *  tense). Both ride this one coordinate-only channel; live sorts before recent. */
  state: "live" | "recent";
  /** KG-9 (ADR-0014 §6), PROXIMITY TIER, mirroring `PreEditMemory`. Coordinates
   *  only (booleans/a number from anchor-set membership). `onSymbol` = the anchor is
   *  the exact target SYMBOL (finest tier). Optional for back-compat with a pre-KG-9
   *  backend (defaulted at the wire). */
  onSymbol?: boolean;
  /** `onTarget` = the anchor is the exact target symbol OR module, the top tier,
   *  above every blast-radius neighbour. */
  onTarget?: boolean;
  /** DISPLAY proximity: 1 when `onTarget`, else the neighbour value (< 1). */
  proximity?: number;
};

/**
 * KG-10 (ADR-0014 §5 Embeddings), a DUPLICATE-WORK coordinate: another live lane
 * whose declared task brief is a SEMANTIC PARAPHRASE of the caller's brief. A
 * DISTINCT sibling channel to `activity` (dup-work is brief-similarity, not
 * anchor-based). COORDINATES ONLY, a similarity SCALAR + ids; the brief text and
 * the embedding NEVER appear here (the brain-gate side-channel invariant). Never a
 * memory, never in the gate.
 */
export type PreEditDuplicateWork = {
  jobId: string;
  taskId: string;
  vendor: string;
  /** Cosine similarity of the two briefs' embeddings, rounded, a coordinate. */
  similarity: number;
  state: "live";
};

export type PreEditContext = {
  target: EditTarget;
  blastRadius: {
    modules: string[];
    symbols?: string[];
    depth?: number;
    source: "provided" | "codegraph" | "target-only";
  };
  memories: PreEditMemory[];
  crewFindings: PreEditCrewFinding[];
  warnings: PreEditWarning[];
  pendingProposals: PreEditPendingProposal[];
  /** KG-7 (ADR-0014): OTHER live lanes on this edit target, coordinates only.
   *  Defaults to [] (a pre-KG-7 backend omits it → today's hero). */
  activity: PreEditActivity[];
  /** KG-10 (ADR-0014): OTHER live lanes doing semantically the SAME work (brief
   *  paraphrase), coordinates only. Defaults to [] (a pre-KG-10 backend, or dense
   *  off, omits it → today's hero). */
  duplicateWork: PreEditDuplicateWork[];
  /**
   * D14: how the gate LOOKED — anchors asked/resolved, notes considered/admitted/
   * surfaced, which tier admitted them, and a CLOSED-ENUM `emptyReason` when this
   * surface has nothing to show. Counts only; no note ids, no text, no
   * coordinates. DIAGNOSTIC, never authority: no surface may widen anything
   * because coverage is zero.
   *
   * Optional because a pre-D14 backend does not send it, and its ABSENCE is
   * itself the honest signal ("this backend cannot tell you why it is empty").
   * Every hop that rebuilds a context must carry it, and every hop that WITHHOLDS
   * notes must re-stamp it with `preEditCoverageForSurface`.
   */
  coverage?: PreEditCoverage;
};

export type HarnessRecord = {
  id: string;
  key: string;
  name: string;
  config: HarnessConfig;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTemplateRecord = {
  id: string;
  key: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunStatus =
  | "proposed"
  | "applied"
  | "running"
  | "paused"
  | "done"
  | "abandoned";

export type WorkflowRunRecord = {
  id: string;
  templateKey?: string | null;
  templateVersion?: number | null;
  request: string;
  workspacePath?: string | null;
  chatId?: string | null;
  proposal: WorkflowProposal;
  status: WorkflowRunStatus;
  proposedBy: string;
  appliedBy?: string | null;
  appliedAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunTask = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  workflowRunId?: string | null;
  stepKey?: string | null;
  workspacePath?: string | null;
  assignments: Assignment[];
  approvals: ApprovalRequest[];
};

export type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  tasks: WorkflowRunTask[];
};

export type LoopRunStatus =
  | "running"
  | "passed"
  | "escalated"
  | "exhausted"
  | "aborted";

export type LoopRunRecord = {
  id: string;
  /** Exact owning loop dispatch; absent only on pre-0051 ledger rows. */
  dispatchJobId?: string | null;
  taskId: string;
  workflowRunId?: string | null;
  stepKey?: string | null;
  harnessKey?: string | null;
  kind: string;
  budget: { maxIterations: number; maxWallMs?: number };
  progress?: LoopProgress | null;
  iterations: number;
  status: LoopRunStatus;
  stopReason?: string | null;
  startedAt: string;
  endedAt?: string | null;
};

export type GovernedScheduleStatus = "active" | "paused" | "completed";
export type ScheduleOccurrenceStatus = "claimed" | "running" | "done" | "failed";

export type ScheduleOccurrenceRecord = {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  status: ScheduleOccurrenceStatus;
  chatId?: string | null;
  rootJobId?: string | null;
  error?: string | null;
  claimedAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type GovernedScheduleRecord = {
  id: string;
  title: string;
  objective: string;
  workspacePath: string;
  vendor: string;
  model?: string | null;
  effort?: string | null;
  cadenceMinutes?: number | null;
  nextRunAt: string;
  maxRuns?: number | null;
  runCount: number;
  maxWallMs: number;
  maxDescendantWallMs: number;
  status: GovernedScheduleStatus;
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
  lastStatus?: ScheduleOccurrenceStatus | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  occurrences: ScheduleOccurrenceRecord[];
};

/** A conversation with the super-orchestrator, bound to a workspace folder. */
export type OrchestratorChatRecord = {
  id: string;
  title: string;
  workspacePath: string;
  /** Shadow task anchoring the chat in the ledger (gates, provenance). */
  taskId?: string | null;
  vendorSessionId?: string | null;
  vendorSessionVendor?: "claude-code" | string | null;
  vendorSessionRootJobId?: string | null;
  status: "active" | "archived" | string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Every vendor the fleet route sizes.
 *
 * WAVE D: an alias of `VendorId` rather than a fourth hand-written spelling of
 * the vendor set. The alias survives one release for consumers that name it.
 *
 * A TYPE was never the admission gate here and must not be read as one: which
 * ids the route actually sizes is `fleetVendorIds()` (Wave C2), checked at
 * runtime. Narrowing this alias would only have moved the drift, not the gate.
 */
export type FleetVendor = VendorId;
export type AgentStatus = "idle" | "working" | "offline";

export type DispatchKind = "auto" | "oneshot" | "loop" | "session";
export type DispatchStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "interrupted";

/** One artifact MUON evaluated for a prompt boundary. */
export type ContextExposureRecord = {
  id: string;
  frameId: string;
  artifactKind: ContextArtifactKind;
  artifactId: string;
  eligible: boolean;
  included: boolean;
  reason: string;
  ordinal?: number | null;
  charCount?: number | null;
  trustTier?: "human_confirmed" | "crew_vouched" | "trust_floor" | null;
  createdAt: string;
};

/** Append-only receipt for MUON's delivery attempt, not a model-attention claim. */
export type ContextFrameDeliveryRecord = {
  id: string;
  frameId: string;
  status: ContextFrameDeliveryStatus;
  sessionId?: string | null;
  vendorSessionId?: string | null;
  failure?: string | null;
  createdAt: string;
};

export type ContextFrameRecord = {
  id: string;
  clientRequestId: string;
  jobId: string;
  taskId: string;
  laneId: string;
  workspacePath?: string | null;
  chatId?: string | null;
  missionId: string;
  turnSeq: number;
  source: ContextFrameSource;
  completeness: "muon_supplied" | string;
  content: string;
  contentSha256: string;
  charCount: number;
  tokenEstimate: number;
  createdAt: string;
  exposures: ContextExposureRecord[];
  delivery: ContextFrameDeliveryRecord | null;
};

export type ContextCondensationMemberRecord = {
  id: string;
  condensationId: string;
  artifactKind: ContextArtifactKind;
  artifactId: string;
  createdAt: string;
};

export type ContextCondensationRecord = {
  id: string;
  jobId: string;
  taskId: string;
  inputFrameId?: string | null;
  outputFrameId?: string | null;
  origin: ContextCondensationOrigin;
  sourceResponseId: string;
  summary?: string | null;
  summaryOffset?: number | null;
  createdAt: string;
  members: ContextCondensationMemberRecord[];
};

export type ContextEvidencePage = {
  frames: ContextFrameRecord[];
  condensations: ContextCondensationRecord[];
  condensationsTruncated: boolean;
};

/** A unit of sub-agent work executed by the persistent runner (R1). */
export type DispatchJobRecord = {
  id: string;
  kind: DispatchKind | string;
  vendor: string;
  taskId: string;
  brief: string;
  // VISION §2: the crew role this job RUNS AS, resolved server-side at dispatch.
  // The runner narrows the composed profile to it and A2A derives peer identity
  // from it. Optional/nullable so a pre-role job (and an older backend) parses.
  role?: AgentRole | string | null;
  harnessKey?: string | null;
  maxIterations?: number | null;
  maxWallMs?: number | null;
  checks?: HarnessCheck[] | null;
  iterationTimeoutMs?: number | null;
  resumeVendorSessionId?: string | null;
  approvalTimeoutMs?: number | null;
  workspacePath?: string | null;
  chatId?: string | null;
  parentJobId?: string | null;
  rootJobId?: string | null;
  delegationDepth?: number;
  maxDelegationDepth?: number | null;
  maxChildren?: number | null;
  maxTotalDescendants?: number | null;
  maxDelegationIterations?: number | null;
  // Fleet-scaled descendant pool (S3): the aggregate wall-clock a root's whole
  // delegation subtree may reserve, decoupled from the root's own turn timeout.
  // NULL for pre-S3 (v1) roots and non-root jobs, which fall back to `maxWallMs`.
  maxDescendantWallMs?: number | null;
  delegationChildrenIssued?: number;
  delegationDescendantsIssued?: number;
  delegationBudgetReservedMs?: number;
  // Released-reservation accounting (S1): a child's actual spend, recorded on its
  // first terminal transition. `remaining = pool − reserved − consumed`.
  delegationBudgetConsumedMs?: number;
  delegationDeadline?: string | null;
  capabilityMode?: "orchestrator" | "delegate" | "worker" | string | null;
  delegationManifest?: DelegationPolicy | null;
  status: DispatchStatus | string;
  agentId?: string | null;
  dispatchedBy: string;
  interruptRequested: boolean;
  steerMessages: string[];
  /**
   * ADR-0013 #52 v2, a vendor action resolved + guard-enforced at the dispatch
   * route, carried on the job for the runner to apply at execution. `action` is
   * the resolved action id; `actionProfilePatch` merges into the compiled
   * LaneProfile; `actionArgvOverride` overrides the one-shot taskCommand;
   * `actionBriefPrefix` prepends to the brief. Null for a plain dispatch.
   */
  action?: string | null;
  actionProfilePatch?: Record<string, unknown> | null;
  actionArgvOverride?: { command?: string; args: string[] } | null;
  actionBriefPrefix?: string | null;
  // Resume lineage (P0.1): the terminal job this dispatch was re-created from
  // by an explicit human resume act. Null for every non-resumed job.
  resumedFromJobId?: string | null;
  // Append-once resume claim (P0.1 replay-safety): stamped ONCE on an
  // interrupted ORIGINAL the first time it is resumed. `resumedAt` present ⇒ a
  // fresh child (`resumedByJobId`) already claimed it, so the resume planner
  // classifies it `already-resumed` and a second redispatch is refused (409).
  resumedAt?: string | null;
  resumedByJobId?: string | null;
  result?: string | null;
  exitCode?: number | null;
  /**
   * Typed terminal handoff packet (P0.3), null/absent for legacy rows and
   * non-emitting kinds. Untrusted agent-produced data: validate with
   * handoffPacketSchema before use.
   */
  packetJson?: unknown;
  /**
   * LIVE TERMINAL: the read-only console session the runner published for this
   * job, shaped `pty:job:<jobId>`. Non-null means MUON actually observed console
   * bytes from this job's vendor child — never merely that a pane could be
   * opened. NULL for a lane that runs through an in-process SDK or a protocol
   * channel (claude-code, `codex app-server`), for a job that produced no
   * console output, and for every pre-0038 row; all of those fall back to the
   * recorded stream, which is honest rather than a blank pane labelled "live".
   *
   * This is an ATTACH coordinate for `GET /api/dispatch/:jobId/terminal`, NOT a
   * spawn coordinate: it must never be handed to a terminal-open path, which
   * would start a fresh vendor CLI instead of showing this one.
   */
  ptySessionId?: string | null;
  /**
   * BACKLINK: the vendor's OWN session id for this job's latest execution —
   * the codex rollout id printed in its exec banner, or the Claude session
   * uuid the Agent SDK streams. With it the human reopens the EXACT session
   * MUON dispatched in the vendor's real TUI (`codex resume <id>`,
   * `claude --resume <id>`), the dispatched brief visible as its first turn.
   *
   * NULL/absent means "no resume handle is known": a pre-backlink row, a lane
   * that never reported one, or a run killed before the id was seen. It is a
   * COORDINATE the terminal host re-validates before any spawn — never a
   * value the renderer may hand to a command line itself.
   */
  vendorSessionId?: string | null;
  /**
   * WHERE THIS JOB ACTUALLY RAN: the absolute cwd the lease-holding runner
   * handed the vendor — the task's isolated `<repoRoot>/.muon/worktrees/
   * <taskId>` checkout when the harness requires a worktree, otherwise the
   * canonical workspace. Recorded for BOTH shapes, so "it ran in the workspace
   * root" is a stated fact rather than an omission.
   *
   * NULL/absent means exactly UNKNOWN — a pre-0039 row, a job that never
   * reached launch, or a run whose stamp failed — and a reader must fall back
   * to deriving the tree instead of assuming the workspace root.
   *
   * An observation, never an instruction: read review evidence from it, but
   * never spawn, write, or authorize anything because of it.
   */
  executionPath?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  /**
   * Wave 4.2 crew-liveness: the job's most recent stream-chunk (output) time,
   * enriched by GET /api/dispatch. null/absent = no output yet — the signal that
   * distinguishes a working child from a startup-hang.
   */
  lastProgressAt?: string | null;
  /** True only while this exact job has an unresolved human approval. */
  waitingApproval?: boolean;
  /** Operator-visible, bounded lifecycle label; never raw tool arguments/results. */
  currentActivity?: string | null;
};

/** One relayed piece of a job's live console. `seq` is per-session, 1-based. */
export type JobTerminalFrame = { seq: number; data: string };

/**
 * A read-only attach to a dispatched job's live console.
 *
 * `available:false` is the honest "this brain holds no console for that job"
 * answer — the run finished, or the brain restarted and dropped its bounded
 * ring. A viewer must fall back to the recorded stream on it, never render an
 * empty pane labelled live.
 *
 * `firstSeq` is the earliest frame still retained. A reader whose cursor sits
 * below it has missed console bytes the ring dropped, and should say so rather
 * than present a discontinuous terminal as continuous.
 */
export type JobTerminalView = {
  sessionId: string | null;
  available: boolean;
  /**
   * The JOB's status, not the console's. It is what distinguishes "this agent
   * is alive and quiet" from "this agent finished and you are looking at its
   * last output" — a finished job's ring stays warm, so without this a viewer
   * would poll an empty live pane forever.
   */
  jobStatus: string;
  frames: JobTerminalFrame[];
  firstSeq: number | null;
  lastSeq: number;
  /**
   * Frames lost before the brain saw them: runner queue overflow, a refused
   * batch, a scrub-safety drop. Every loss path leaves a hole in `seq`, and
   * `firstSeq` reports only the brain's own ring trimming — so a viewer that
   * ignores this will render a discontinuous terminal as continuous.
   */
  dropped: number;
};

/** Per-child slice of a mission budget (S9): numbers + enums only, no free text. */
export type DispatchBudgetChild = {
  jobId: string;
  vendor: string;
  status: DispatchStatus | string;
  depth: number;
  /** Wall-clock still reserved by this child (0 once it has terminalized). */
  reservedMs: number;
  /** Wall-clock this child has actually spent (live for a running child). */
  consumedMs: number;
};

/**
 * S9 mission budget: the root's fleet-scaled descendant pool and its accounting.
 * `poolMs` is `maxDescendantWallMs` for a v2 root and falls back to the root's own
 * turn budget (`rootWallMs`) for a v1 root. `remainingMs = poolMs − reservedMs −
 * consumedMs`. Numbers + enums only — never agent-produced text.
 */
export type DispatchBudget = {
  jobId: string;
  capabilityMode?: string | null;
  rootWallMs: number | null;
  maxDescendantWallMs: number | null;
  poolMs: number;
  reservedMs: number;
  consumedMs: number;
  remainingMs: number;
  deadlineAt: string | null;
  childrenIssued: number;
  maxChildren: number | null;
  descendantsIssued: number;
  maxDescendants: number | null;
  depth: number;
  maxDepth: number | null;
  children: DispatchBudgetChild[];
};

export type RunnerRecord = {
  id: string;
  host: string;
  pid?: number | null;
  status: string;
  lastSeenAt: string;
};

/** A running instance of a lane, the fleet the orchestrator dispatches to. */
export type AgentRecord = {
  id: string;
  vendor: string;
  name: string;
  ordinal: number;
  status: AgentStatus | string;
  currentTaskId?: string | null;
  currentJobId?: string | null;
  sessionId?: string | null;
};

export type FleetSnapshot = {
  counts: Record<string, number>;
  agents: AgentRecord[];
  warnings?: string[];
};

export type VendorCredentialMethod =
  | "vendor-login"
  | "api-key"
  | "custom-provider"
  | "local-provider";

/**
 * Credential-aware readiness for one vendor (P2 onboarding). `installed` =
 * the CLI binary is present; `authenticated` = MUON has positive evidence
 * that the CLI can authenticate through native login or its configured
 * provider. `detail` never carries a credential value (it may carry the
 * connected native account). Mirrors `VendorReadiness` in `@muon/adapters`,
 * the `GET /api/fleet/readiness` wire contract.
 */
export type VendorReadiness = {
  vendor: string;
  installed: boolean;
  authenticated: boolean;
  credentialMethod?: VendorCredentialMethod;
  detail: string;
  fixHint?: string;
  /** Machine-stable auth evidence. Absent on older payloads (fall back to `authenticated`). */
  authState?: "confirmed" | "negative" | "unknown" | "provider-unconfigured";
  /**
   * Provider/version fingerprint (P0.1 checkpoint+resume): first line of the
   * CLI's own `--version` output, bounded. A version string is a fingerprint
   * REF, never a secret. Absent/null when unprobed — honest absence.
   */
  cliVersion?: string | null;
};

/**
 * The full `GET /api/fleet/readiness` payload: the vendor rows PLUS the
 * backend's own aggregate verdict, soft warning, and probe freshness stamp.
 * Every field beyond `vendors` is optional so older backends stay parseable.
 */
export type FleetReadinessReport = {
  vendors: VendorReadiness[];
  anyReady?: boolean;
  warning?: string;
  generatedAt?: string;
};

export type StreamChunkKind =
  | "output"
  | "output.message"
  | "user.message"
  | "activity"
  | "reasoning"
  | "milestone"
  | "gate";

/**
 * Bounded, redacted summary of what ONE tool call did, carried alongside the
 * activity line that announced it.
 *
 * UNTRUSTED agent/vendor text. It is bounded at the adapter (args head-kept,
 * result TAIL-kept), scrubbed by @muon/core's single `redactedTail` control on
 * the way into the ledger and again at the write route, and rendered only as
 * data behind a human expand — never as MUON's own copy, never as instructions.
 *
 * Every field is optional, and so is the whole object: a chunk written before
 * this shape existed (or by an adapter that captured nothing) has no detail at
 * all and must render exactly as it does today.
 */
export type StreamChunkDetail = {
  args?: string;
  /** The args were clipped; a surface must not imply it holds the whole call. */
  argsTruncated?: boolean;
  result?: string;
  /** The result was clipped (leading output dropped, tail kept). */
  resultTruncated?: boolean;
};

/** One chunk of live agent output, what the watch-an-agent views render. */
export type StreamChunk = {
  seq: number;
  taskId: string;
  laneId: string;
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  kind: StreamChunkKind;
  content: string;
  /** Absent/null ⇒ no captured detail. Never means "the tool returned nothing". */
  detail?: StreamChunkDetail | null;
  timestamp: string;
};

export type StreamChunkInput = {
  taskId: string;
  laneId: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  kind?: StreamChunkKind;
  content: string;
  detail?: StreamChunkDetail;
  timestamp?: string;
};

export type StreamChunkClaimInput = {
  taskId: string;
  laneId: string;
  claimKey: string;
  kind: "milestone";
  content: string;
};

export type LaneSessionStatus =
  | "running"
  | "waiting_approval"
  | "interrupted"
  | "ended"
  | "failed";

export type LaneSession = {
  id: string;
  laneId: string;
  taskId: string;
  // Checkpoint edge (P0.1): the DispatchJob this session executes.
  jobId?: string | null;
  vendorSessionId?: string | null;
  status: string;
  /** ADR-0030: "muon" (automation may act) | "human" (native take-over live). */
  owner?: string;
  ownerChangedAt?: string | null;
  startedAt: string;
  endedAt?: string | null;
  lane?: Lane;
};
