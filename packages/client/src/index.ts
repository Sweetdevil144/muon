export { MuonApiClient } from "./api-client.js";
// A control refusal (401/403) and a control outage are different facts; callers
// whose failure posture depends on WHICH one happened read it from here rather
// than from a message string.
export {
  MuonApiHttpError,
  isAuthorizationFailure,
  refusalOf,
} from "./api-client.js";
// Chat-level cancel + cancel-then-archive. Shared so "stop this chat" is ONE
// governed act (per-job `interrupt`) across desktop, CLI, and TUI — never a
// surface-local kill path.
export {
  cancelChatJobs,
  listActiveChatJobs,
  stopThenArchiveChat,
  summarizeChatCancel,
  describeChatStopBlockers,
  ChatStopBlockedError,
} from "./api-client.js";
// B3: a memory-graph outage degrades a read instead of failing it. Every
// surface that renders provenance must branch on this, or an outage looks
// like "no provenance" — a different and false claim.
export type { MemoryGraphDegraded } from "./api-client.js";
// What approving a `merge` gate DID — the field the client used to drop, which
// is why every surface could only ever say "approved" and never "landed as
// <sha>". Consumed by the desktop Changes panel's land action.
export type { ApprovalMergeResult } from "./api-client.js";
// ADR-0038 D1 slice 1: the DISCOVERED vendor MCP inventory. A read — every item
// is `state: "discovered"`, which D1 defines as denied, and no surface may
// derive an enable from it.
export type { CompatibilityMcpInventory } from "./api-client.js";
export type {
  CancelChatJobsOptions,
  CancelChatJobsResult,
  ChatJobStopState,
  ChatStopBlockReason,
  ChatStopClient,
  StopThenArchiveClient,
  StopThenArchiveResult,
} from "./api-client.js";

export type {
  MemoryAccessAnalytics,
  MemoryAccessType,
  MemoryAccessTypeMetric,
} from "@muon/protocol";
// P1.4 memory packs: the export/import wire shapes the CLI pack writer and
// importer consume.
export type {
  GitHubConnectionStatus,
  GitHubCredential,
  GitHubDeviceFlowPoll,
  GitHubDeviceFlowStart,
  GitHubReview,
  GitHubReviewEnvelope,
  GitHubPullRequestAction,
  GitHubPullRequestActionEnvelope,
  MemoryPackExport,
  MemoryPackManifest,
  MemoryPackRecordFile,
  MemoryPackImportReport,
  // R3 TTL: the operator-owned expiry policy + the bounded sweep result.
  MemoryTtlPolicy,
  MemoryLifecyclePolicy,
  MemoryLifecycleSetting,
  MemoryLifecycleMigrationResult,
  MemoryExpirySweepResult,
  BulkMemoryRemovalRequest,
  RevertExpiredBatchResult,
} from "./api-client.js";
export { waitForApproval, type WaitForApprovalOptions } from "./approval-wait.js";
export {
  TRAJECTORY_SCHEMA_VERSION,
  TRAJECTORY_CONTEXT_GUARANTEE,
  trajectoryPayloadSchema,
  trajectoryBundleSchema,
  canonicalJson,
  createTrajectoryPayload,
  trajectoryDigestInput,
  parseTrajectoryBundle,
  replayTrajectory,
} from "./trajectory.js";
export type {
  TrajectoryPayload,
  TrajectoryBundle,
  TrajectoryReplayStep,
  TrajectoryReplay,
} from "./trajectory.js";
export {
  booleanEnvFlag,
  resolveApiBase,
  resolveApiToken,
  resolveAgentToken,
} from "./config.js";
export {
  authorizeRunnerLease,
  type RunnerLeaseAuthority,
} from "./runner-lease.js";
// ADR-0017, the Keychain custody seam (macOS `security`-CLI wrapper; degrade-safe).
export {
  isKeychainAvailable,
  storeOperatorToken,
  readOperatorToken,
  deleteOperatorToken,
  type KeychainOptions,
} from "./keychain.js";
// P2b vendor-onboarding state machine, the single shared readiness→step
// mapping + guidance copy that the desktop wizard, CLI, and TUI all render.
export {
  ONBOARDING_VENDORS,
  ONBOARDING_VENDOR_LABELS,
  NEVER_STORES_TOKEN_NOTICE,
  MANUAL_CONNECT_STEPS,
  vendorOnboardingStep,
  buildOnboardingState,
} from "./onboarding.js";
export type {
  VendorStepKind,
  VendorOnboardingStep,
  OnboardingPhase,
  OnboardingState,
} from "./onboarding.js";
// P6a, the shared pre-edit ("Brain") view-model + operator-tier adjudication
// helpers the TUI, desktop, and CLI all render from (the hero's human arm).
export {
  buildPreEditView,
  loadPreEditView,
  fetchProposalNote,
  resolveProposal,
  parseEditTarget,
  describeTarget,
  describeCoverage,
  deriveAutoContext,
} from "./preedit-view.js";
export type {
  PreEditView,
  PreEditPhase,
  PreEditMemoryView,
  PreEditWarningView,
  PreEditProposalView,
  PreEditActivityView,
  PreEditDuplicateWorkView,
  PreEditProximityLabel,
  BlastRadiusView,
  PreEditClient,
  PreEditTargetInput,
  ProposalDecision,
  AutoContext,
  AutoContextSource,
} from "./preedit-view.js";
// Production-readiness convergence contract, one pure, browser-safe projection
// of intent, governed evidence, coordination coordinates, and advisory authority.
export { buildConvergencePreflight } from "./convergence-preflight.js";
export type {
  ConvergencePosture,
  ConvergenceSeverity,
  ConvergenceRow,
  ConvergenceSection,
  ConvergenceAction,
  ConvergencePreflightInput,
  ConvergencePreflight,
} from "./convergence-preflight.js";
// P0.5 capability preflight, the ONE bounded doctor contract every surface
// (CLI --json, MCP tool, desktop diagnostics) projects from. Pure + browser-safe.
export {
  CAPABILITY_PREFLIGHT_VERSION,
  PREFLIGHT_REASON_CODES,
  PREFLIGHT_LIMITS,
  VENDOR_EXECUTION_MODES,
  VENDOR_DISPATCH_ROLES,
  buildCapabilityPreflight,
  collectCapabilityPreflight,
} from "./capability-preflight.js";
export type {
  PreflightReasonCode,
  PreflightDegradation,
  PreflightExecutionMode,
  PreflightLimits,
  PreflightVendor,
  PreflightSupervisorEvidence,
  CapabilityPreflight,
  CapabilityPreflightInput,
  CapabilityPreflightClient,
} from "./capability-preflight.js";
// The ONE rule for "which mission is this chat showing" — desktop, TUI and CLI.
export { selectMissionRoot, selectMissionRootId, type MissionRootChoice } from "./mission-root.js";
// Shared, browser-safe recursive dispatch projection for cockpit surfaces.
export { buildDispatchForest } from "./dispatch-view.js";
export type {
  DispatchTreeAuthority,
  DispatchTreeNode,
  DispatchForestSummary,
  DispatchForest,
} from "./dispatch-view.js";
// Wave 4.2 — the shared crew-liveness state machine (a stalled child lights amber
// before it dies) rendered identically by the desktop crew tree + TUI fleet rail.
export {
  deriveCrewLiveness,
  crewLivenessLabel,
} from "./crew-liveness.js";
export type {
  CrewLiveness,
  CrewLivenessInput,
  CrewLivenessOptions,
  CrewLivenessResult,
} from "./crew-liveness.js";
// S9 TUI/desktop budget surfacing: the shared read-only view-model over
// GET /api/dispatch/:jobId/budget (numbers/enums only). No raise affordance
// here by design — raises stay operator/desktop-gated.
export {
  buildBudgetLineView,
  compactBudgetDuration,
  pollFailBudgetLine,
  unknownBudgetLine,
} from "./budget-view.js";
export type {
  BudgetDescendantView,
  BudgetLineStatus,
  BudgetLineView,
} from "./budget-view.js";
export { buildApprovalReview } from "./approval-review.js";
export { buildApprovalDecision } from "./approval-decision.js";
export type {
  ApprovalDecisionInput,
  ApprovalDecisionPayload,
  DecisionSurface,
} from "./approval-decision.js";
export {
  REMEMBER_ACTION_TTL_MS,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
} from "./approval-review.js";
export type { ApprovalReview } from "./approval-review.js";
export { selectOneApprovableCard } from "./approvable-inbox.js";
export type { ApprovableInbox } from "./approvable-inbox.js";
export { buildAutonomyCommitments } from "./autonomy-commitments.js";
export {
  buildObjectiveLoopStatus,
  buildObjectiveLoopStatusForTask,
  extractLoopMissing,
  findLoopDispatchJob,
  formatObjectiveLoopHeadline,
  loopCommitmentIsActive,
  loopCommitmentIsTerminal,
  pickPrimaryLoopForTask,
} from "./loop-status.js";
export type { ObjectiveLoopControl } from "./loop-status.js";
export type {
  AutonomyCommitment,
  AutonomyCommitmentKind,
} from "./autonomy-commitments.js";
// Wave 4.1 — the inline governance projection: selects the fail-closed gate(s)
// bound to one agent's job so the tab can surface the decision in-place (routed
// into the same governed approval dialog — no second authority path).
export { buildSessionGovernance } from "./session-governance.js";
export type {
  SessionGate,
  SessionGovernance,
  SessionGovernanceJob,
} from "./session-governance.js";
export { buildAuditTrail } from "./audit-trail.js";
export type { AuditEntry, AuditTone } from "./audit-trail.js";
// P0-3's tier vocabulary, promoted here so the desktop and the CLI read the
// SAME rule for "who vouches for this note" instead of drifting copies.
export { isHumanMemoryPrincipal, memoryNoteTier } from "./memory-tier.js";
export { NAV_DESTINATIONS } from "./nav-destinations.js";
export type {
  NavDestination,
  NavDestinationEntry,
} from "./nav-destinations.js";
export {
  buildMemoryDecision,
  memoryMarkerTag,
  memoryNoteMarkers,
} from "./memory-decision.js";
export type {
  MemoryAction,
  MemoryDecisionPayload,
  MemoryMarkers,
} from "./memory-decision.js";
export type { MemoryNoteTier, MemoryTierNote } from "./memory-tier.js";
// The ONE terminal sanitizer for AGENT-AUTHORED text. Lifted here because the
// CLI (`muon crew`) and the TUI crew panel both print another agent's prose and
// each used to carry its own copy — a duplicated security control drifts, and
// the weaker copy wins. Both surfaces now import this one.
// Round-3 #8 — the evasion corpus travels the SAME path the sanitizer does,
// so any surface that can call `terminalSafe` can also replay the payloads
// that prove it was called. Re-exported rather than made a new dependency:
// apps/tui and apps/cli depend on @muon/client, not on @muon/protocol.
export {
  DANGEROUS_RANGES,
  EVASION_CORPUS,
  evasionPayloads,
  flattenDangerous,
  isDangerousCodePoint,
  residualDanger,
  type EvasionClass,
  type EvasionPayload,
} from "@muon/protocol";

export {
  NO_PRINTABLE_TEXT,
  TERMINAL_UNSAFE,
  TERMINAL_UNSAFE_BLOCK,
  terminalSafe,
  terminalSafeBlock,
  terminalSafeScreen,
} from "./terminal-safe.js";
export { loadMemoryAnalytics, loadMemoryLibrary } from "./memory-library.js";
export type {
  MemoryAnalyticsSnapshot,
  MemoryLibraryNote,
  MemoryLibraryEdge,
  MemoryLibraryConfirmation,
  MemoryLibraryImport,
  MemoryLibrarySnapshot,
  MemoryLibraryQuery,
} from "./memory-library.js";
// Agent-only, browser-safe allowlist projection for MCP pre-edit output.
export { buildAgentPreEditContext } from "./agent-preedit-context.js";
// P6, the guided first task (quickstart): seed a safe, READ-ONLY sample task
// into the user's workspace and dispatch it so a fresh user watches the loop run.
export {
  QUICKSTART_TASK_MARKER,
  QUICKSTART_SAMPLE,
  pickQuickstartVendor,
  seedQuickstartTask,
} from "./quickstart.js";
export type { QuickstartClient, QuickstartOutcome } from "./quickstart.js";
// BUG 1(b), boot cleanup: retire a quickstart task stranded QUEUED in an earlier
// session (its non-terminal jobs + pending approvals) so it can't re-fire
// approval modals every launch. Marker-scoped + idempotent; never throws.
export {
  cleanupQuickstartTasks,
  isQuickstartTask,
} from "./quickstart-cleanup.js";
export type {
  QuickstartCleanupClient,
  QuickstartCleanupResult,
} from "./quickstart-cleanup.js";
// P6, graceful vendor-error handling: classify a dispatch/run failure into a
// clear, actionable notice (not-connected → onboarding vs run-failed → retry).
export {
  classifyVendorFailure,
  sanitizeVendorErrorMessage,
  noVendorReady,
} from "./vendor-error.js";
export type { VendorErrorKind, VendorErrorNotice } from "./vendor-error.js";
export {
  type BrainLock,
  type BrainHealthFetcher,
  DB_FILE_NAME,
  GRAPH_DIR_NAME,
  LOCKFILE_NAME,
  dbFilePath,
  discoverLiveBrain,
  graphDir,
  isProcessAlive,
  lockfilePath,
  probeBrainHealth,
  readLockfile,
  readProbedLiveLockfile,
  removeLockfile,
  resolveDataDir,
  writeLockfile,
} from "./paths.js";
// ROADMAP P7 — runtime-registerable custom (ungoverned) agents. The store is
// a Node-only CRUD over `<dataDir>/custom-agents.json`; consumed by the CLI
// and by desktop's MAIN process (never the renderer, which has no filesystem
// access and never needs one — it receives the list over IPC).
export {
  CUSTOM_AGENTS_FILE_NAME,
  CustomAgentStoreError,
  customAgentsFilePath,
  findCustomAgentById,
  listCustomAgents,
  readCustomAgents,
  registerCustomAgent,
  removeCustomAgent,
} from "./custom-agents-store.js";
export {
  CUSTOM_AGENT_ID_PREFIX,
  CUSTOM_AGENT_SLUG_PATTERN,
  MAX_CUSTOM_AGENTS,
  UNGOVERNED_AUTHORITY,
  createUngovernedAgentEntry,
  customAgentId,
  customAgentRegistrationInputSchema,
  isUngovernedAgentEntry,
  isUngovernedAgentId,
  parseUngovernedAgentEntry,
  ungovernedAgentEntrySchema,
  ungovernedAgentLabel,
  ungovernedAgentSlug,
} from "@muon/protocol";
export type {
  CustomAgentRegistrationInput,
  UngovernedAgentAuthority,
  UngovernedAgentEntry,
  UngovernedAgentId,
} from "@muon/protocol";
export {
  emptyHarnessConfig,
  harnessConfigSchema,
  laneProfileSchema,
  emptyLaneProfile,
  workflowDefinitionSchema,
  workflowProposalSchema,
} from "@muon/protocol";
// Terminal-result classifiers, DESCRIPTIVE reads (same class as the schemas
// above): "was this a wall-budget kill?" and "what does a human read once the
// machine marker is off?". Re-exported because the surfaces that RENDER a
// job.result — the desktop panes, the TUI rails — depend on `@muon/client`
// alone, and a surface that cannot reach the one stripper writes its own. That
// is how `[muon:budget-exhausted]` ended up shown verbatim to the operator in
// one pane while the crew rail beside it stripped the tag.
export {
  BUDGET_EXHAUSTED_MARKER,
  isBudgetExhausted,
  isUncertainTerminalOutcome,
  withoutBudgetMarker,
} from "@muon/protocol";
export type {
  HarnessCheck,
  HarnessConfig,
  LaneProfile,
  LoopSpec,
  ManualReviewAttestation,
  MergeReviewRecord,
  McpServerConfig,
  PermissionMode,
  SandboxMode,
  ReviewCoverageCertification,
  WorkflowDefinition,
  WorkflowProposal,
  WorkflowProposalStep,
  WorkflowStep,
} from "@muon/protocol";
// The traversal text-gate rule as a VALUE, so a consumer can assert against the
// policy it was compiled with instead of retyping the literal.
export { MEMORY_TRAVERSAL_TEXT_POLICY } from "./types.js";
export type {
  AgentRecord,
  AgentStatus,
  ApprovalDetail,
  ApprovalKind,
  DispatchJobRecord,
  DispatchBudget,
  DispatchBudgetChild,
  DispatchKind,
  DispatchStatus,
  FleetReadinessReport,
  FleetSnapshot,
  FleetVendor,
  GovernedScheduleRecord,
  GovernedScheduleStatus,
  RunnerRecord,
  ScheduleOccurrenceRecord,
  ScheduleOccurrenceStatus,
  VendorReadiness,
  ApprovalReceipt,
  ApprovalRequest,
  ApprovalStatus,
  Assignment,
  AssignmentDetail,
  CoordinationMetrics,
  ContextCondensationMemberRecord,
  ContextCondensationRecord,
  ContextEvidencePage,
  ContextExposureRecord,
  ContextFrameDeliveryRecord,
  ContextFrameRecord,
  Handoff,
  HandoffDetail,
  HarnessRecord,
  Health,
  JobTerminalFrame,
  JobTerminalView,
  Lane,
  LaneEventKind,
  LaneSession,
  LaneSessionStatus,
  LaneSuggestion,
  LoopRunRecord,
  LoopRunStatus,
  MemoryCloneResult,
  MemoryCompactionResult,
  MemoryDeleteResult,
  MemoryExplainResult,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphNodeType,
  MemoryGraphRelation,
  MemoryKind,
  MemoryNeighborsResult,
  MemoryNote,
  MemoryTraversalProvenance,
  MemoryTraversalTextPolicy,
  MemoryTrust,
  EditTarget,
  PreEditActivity,
  PreEditDuplicateWork,
  PreEditContext,
  PreEditMemory,
  PreEditWarning,
  PreEditPendingProposal,
  OrchestratorChatRecord,
  RecordedEvent,
  StreamChunk,
  StreamChunkClaimInput,
  StreamChunkDetail,
  StreamChunkInput,
  StreamChunkKind,
  Task,
  TaskDetail,
  TaskPriority,
  TaskStatus,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunTask,
  WorkflowTemplateRecord,
} from "./types.js";
// P0.1 slice 1: the read-only durable run bundle. One pure, browser-safe
// projection that folds existing ledger evidence (dispatch manifest + lineage,
// S9 budgets, P0.3 handoff packets, approvals, stream milestones, capability
// preflight, artifact hashes) into a single portable JSON artifact. Strictly
// read-only; every embedded free-text field is redacted-then-bounded; no
// credential material ever enters the bundle.
export {
  RUN_BUNDLE_VERSION,
  RUN_BUNDLE_LIMITS,
  redactSecrets,
  GRAPH_MIRROR_FAILED_EVENT_KIND,
  MEMORY_INJECTED_EVENT_KIND,
  MAX_MEMORY_NOTES_PER_JOB,
  redactForPack,
  redactMachineIdentity,
  buildRunBundle,
  collectRunBundle,
  computeLineageDigest,
  classifyJobPhase,
} from "./run-bundle.js";
export type {
  RunBundle,
  RunBundleInput,
  RunBundleClient,
  RunBundleLimits,
  RunBundleSource,
  RunBundleJob,
  RunBundleHandoff,
  RunBundleApproval,
  RunBundleApprovalEvidence,
  RunBundleMilestone,
  RunBundleArtifact,
  RunBundleCheckpoint,
  RunBundleCheckpointJob,
  RunBundleJobPhase,
  RunBundleResumeMechanism,
} from "./run-bundle.js";

// P0.1 checkpoint+resume — the pure resume PLANNER. Reconcile-first, read-only
// by construction; re-dispatch is a separate explicit act (`--execute` /
// `--redispatch`) the CLI performs over the existing dispatch route.
export { planResume, buildRedispatchInput, classifyGate } from "./run-resume.js";
export type {
  ResumeAction,
  ResumePlan,
  ResumePlanInput,
  ResumeGateClass,
  RedispatchInput,
} from "./run-resume.js";

// Repository Reconnaissance — the superagent's read-once projection of the
// workspace shape (from each repo's local GitNexus graph) into a token-bounded
// RepoMap, plus the pure policies that turn it into a crew size (M2) and disjoint
// work-units (M3). See docs/design/repository-reconnaissance.md.
export {
  buildRepoMap,
  collectRepoSignals,
  deriveOwnedPaths,
  languagesOf,
  recommendCrewSize,
  partitionRepo,
  partitionWorkspace,
  planReconMission,
  completenessCritique,
  deriveDisjointOwnedPaths,
  RECON_QUERIES,
} from "./repo-map.js";
export type {
  RepoCluster,
  RepoUnit,
  RepoMap,
  RepoMapConfidence,
  RepoSignals,
  ClusterSignal,
  MemberSignal,
  BuildRepoMapInput,
  CypherRunner,
  ReconRepoTarget,
  DelegationCaps,
  CrewSizeInput,
  RepoMapMemorySignal,
  WorkUnit,
  ReconCrewUnit,
  ReconMissionPlan,
  PlanReconMissionInput,
  CompletenessCritique,
} from "./repo-map.js";

// Diff-to-Flow review evidence — the pure, fail-closed projection that maps a
// git diff onto the execution flows it disturbs, with a coverage guard so
// unindexed/new files surface as REVIEW BLIND instead of a false all-clear.
export {
  buildDiffImpact,
  diffImpactQueries,
  gitScopeArgs,
  parseHunks,
} from "./diff-impact.js";
export type {
  HunkRange,
  ChangedFile,
  GraphSymbol,
  ProcessStepRow,
  IndexFreshness,
  DiffImpactInput,
  ChangedSymbol,
  AffectedProcess,
  DiffImpactVerdict,
  DiffImpact,
  DiffScope,
} from "./diff-impact.js";

// Data-boundary evidence — which datastore tables a file touches + who else
// writes each (migration-safety signal for the pre-edit gate / confirmed memory).
export {
  buildDataBoundary,
  tablesForFileQuery,
  writersForTablesQuery,
} from "./data-boundaries.js";
export type {
  WriterRow,
  DataBoundaryInput,
  TableBoundary,
  DataBoundary,
} from "./data-boundaries.js";

// A2A — governed agent-to-agent coordination. The agent tier never names its
// own chat/mission/job (the exact-job bearer decides); the operator tier reads
// one chat because a human asked. `untrustedInboxView` is the single shaping of
// a peer's UNTRUSTED body for a model surface.
export {
  UNTRUSTED_PEER_NOTICE,
  claimFiles,
  publishFinding,
  listPeerMessages,
  loadCoordinationSnapshot,
  readPeerInbox,
  releaseFiles,
  sendPeerMessage,
  untrustedInboxView,
  waitOnPeer,
} from "./a2a.js";
// ADR-0043 — blocking questions (agent asks/withdraws own; operator answers).
export {
  askBlockingQuestion,
  answerBlockingQuestion,
  listOpenBlockingQuestions,
  listOwnBlockingQuestions,
  listTaskBlockingQuestions,
  withdrawBlockingQuestion,
} from "./questions.js";
export type {
  BlockingQuestion,
  BlockingQuestionAsk,
  BlockingQuestionStatus,
} from "@muon/protocol";
export type {
  UntrustedInboxView,
  UntrustedPeerMessageView,
} from "./a2a.js";

// Role assignment — MUON decides what each agent is FOR. Assigning a role only
// ever NARROWS a lane profile; nothing on this wire can widen one.
export {
  assignCrewRoles,
  CREW_PLAN_STATUSES,
  crewLaneSchema,
  crewPlanStatusSchema,
  loadCrewRolePlan,
  loadCrewRoles,
  parseRolePin,
  rolePinSchema,
} from "./crew-roles.js";
export type {
  CrewLane,
  CrewPlanStatus,
  CrewRolePlanView,
  CrewRolesView,
  RolePin,
} from "./crew-roles.js";

// The agent-role + A2A PROTOCOL surface, re-exported the same way
// `laneProfileSchema` and friends already are. Surfaces that only depend on
// `@muon/client` (the TUI) could read a crew plan but could not say what a role
// is ALLOWED to do, so the TUI crew panel silently omitted the authority the CLI
// prints. These are DESCRIPTIVE reads — the role vocabulary, its authority
// ceilings, and the A2A wire shapes/limits.
//
// Deliberately NOT re-exported: `narrowProfileForRole` / `assertProfileMatchesRole`
// / `isWriteClassTool` / `WRITE_CLASS_TOOL_NAMES`. Those are the ENFORCEMENT
// half; they belong to the runner and backend, which own `@muon/protocol`
// directly. A UI package that can render authority must not also be able to
// re-compute (and therefore mis-apply) it.
export {
  AGENT_ROLES,
  ROLE_SPECS,
  agentRoleSchema,
  crewRolePlanSchema,
  isReadOnlyRole,
  roleAuthoritySchema,
  roleBindingSchema,
  roleSpec,
  // A2A wire schemas + the bounds every surface must respect.
  A2A_PROTOCOL_VERSION,
  CLAIM_TTL_MS,
  MAX_CLAIMED_PATHS_PER_JOB,
  MAX_PEER_BODY_CHARS,
  MAX_PEER_INBOX_PAGE,
  MAX_PEER_MESSAGES_PER_JOB,
  MAX_PEER_REFS,
  MAX_PEER_SUBJECT_CHARS,
  claimIntentSchema,
  claimsConflict,
  coordinationSnapshotSchema,
  peerAddressSchema,
  peerMessageKindSchema,
  peerMessageSchema,
} from "@muon/protocol";
export type {
  AgentRole,
  ClaimConflict,
  ClaimIntent,
  ClaimResult,
  CoordinationSnapshot,
  CrewRolePlan,
  FileClaim,
  PeerAddress,
  PeerInbox,
  PeerMessage,
  PeerMessageKind,
  PeerMessageSend,
  PeerRefs,
  RoleAuthority,
  RoleBinding,
  RoleSpec,
} from "@muon/protocol";

// Flow-scope — compile an execution flow's membership to concrete file:symbol
// scope for a dispatch brief (re-resolved from a stable anchor, no step-fences).
export {
  buildFlowScope,
  parseSymbolUid,
  flowsForAnchorQuery,
  flowMembersQuery,
} from "./flow-scope.js";
export type {
  FlowRow,
  FlowMemberRow,
  FlowScopeInput,
  FlowMember,
  FlowScopeUnit,
  FlowScope,
} from "./flow-scope.js";

// Read-side handoff honesty, shared by handoff_read (MCP) and the desktop.
export {
  classifyHandoffPacket,
  describeHandoffContract,
  type ClassifiedHandoffPacket,
  type HandoffPacketContract,
} from "./handoff-view.js";
