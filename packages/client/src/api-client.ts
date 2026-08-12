import { z } from "zod";
import {
  loadMemoryAnalytics,
  loadMemoryLibrary,
  type MemoryAnalyticsSnapshot,
  type MemoryLibraryQuery,
  type MemoryLibrarySnapshot,
} from "./memory-library.js";
import {
  approvalEvidenceSchema,
  manualReviewAttestationSchema,
  mergeReviewRecordSchema,
  reviewCoverageCertificationSchema,
  standingApproverGrantSchema,
  harnessConfigSchema,
  harnessCheckSchema,
  capabilityDiffSchema,
  enabledItemSchema,
  enableResultSchema,
  importedItemSchema,
  laneAttestationSchema,
  type CapabilityDiff,
  type EnabledItem,
  type EnableRequest,
  type EnableResult,
  type LaneAttestation,
  delegationPolicySchema,
  laneProfileSchema,
  loopProgressSchema,
  memoryAccessAnalyticsSchema,
  memoryDirectorySnapshotSchema,
  memoryLifecyclePolicySchema,
  preEditCoverageSchema,
  workflowDefinitionSchema,
  workflowProposalSchema,
  type AgentRole,
  type HandoffPacket,
  type HarnessConfig,
  type HarnessCheck,
  type LaneProfile,
  type LoopProgress,
  type ManualReviewAttestation,
  type MemoryAccessAnalytics,
  type MemoryAccessType,
  type MemoryDirectorySnapshot,
  type MemoryFilter,
  type MemoryLifecyclePolicy,
  type ReviewCoverageCertification,
  type StandingApproverGrant,
  type VendorId,
  type WorkflowDefinition,
  type WorkflowProposal,
  type AttemptOutcome,
  type ContextCondensationInput,
  type ContextExposureInput,
  type ContextFrameDeliveryInput,
  type ContextFrameSource,
  type Refusal,
  blockingQuestionSchema,
} from "@muon/protocol";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "./types.js";
import type {
  AgentRecord,
  ApprovalKind,
  ApprovalReceipt,
  DispatchBudget,
  DispatchJobRecord,
  DispatchKind,
  FleetReadinessReport,
  JobTerminalView,
  RunnerRecord,
  ApprovalRequest,
  ApprovalStatus,
  CoordinationMetrics,
  ContextCondensationRecord,
  ContextEvidencePage,
  ContextFrameRecord,
  FleetSnapshot,
  GovernedScheduleRecord,
  GovernedScheduleStatus,
  HarnessRecord,
  Health,
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
  MemoryKind,
  MemoryExplainResult,
  MemoryGraphRelation,
  MemoryNeighborsResult,
  MemoryNote,
  MemoryTrust,
  OrchestratorChatRecord,
  PreEditContext,
  RecordedEvent,
  ScheduleOccurrenceRecord,
  Task,
  TaskDetail,
  StreamChunk,
  StreamChunkClaimInput,
  StreamChunkInput,
  TaskPriority,
  TaskStatus,
  VendorReadiness,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunTask,
  WorkflowTemplateRecord,
} from "./types.js";

type Fetcher = typeof fetch;

const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
});

/**
 * ADR-0038 D1 slice 1 — the DISCOVERED inventory of the MCP servers a user's
 * vendor CLIs already have configured.
 *
 * `importedItemSchema` is reused rather than restated, so the state literal
 * (`"discovered"`, the only one D1 has) and the `secretsRefused` contract are
 * enforced on the way IN to every surface as well as on the way out of the
 * brain. There is no `enabled` field ON AN INVENTORY ITEM and there must not
 * be one, even now that slice 2 exists: an item's enablement is a property of a
 * (lane, item) pair, not of the item, and a boolean here would be the first
 * step towards a workspace-wide grant that D6/D8 exist to forbid. Enablement
 * is read per lane, through `listLaneImports`.
 */
/**
 * ADR-0036 — a mission's cap beside what it has spent.
 *
 * `cost` is a MissionCost, which has no field called `total`: `observedUsd`
 * only ever appears beside the coverage that qualifies it, so a caller cannot
 * render the figure without having the count in hand. `summary` is the one
 * rendering, and is what surfaces should show.
 */
const missionCostViewSchema = z.object({
  capUsd: z.number().nullable(),
  capSetBy: z.string().nullable(),
  capSetAt: z.string().nullable(),
  cost: z.object({
    observedUsd: z.number(),
    reportingLanes: z.number().int(),
    totalLanes: z.number().int(),
    complete: z.boolean(),
  }),
  laneCosts: z
    .array(
      z.union([
        z.object({ laneId: z.string(), reported: z.literal(true), usd: z.number() }),
        z.object({ laneId: z.string(), reported: z.literal(false) }),
      ])
    )
    .default([]),
  silentLanes: z.array(z.string()).default([]),
  /** Tasks another mission also dispatched into, so excluded from this bill. */
  contestedTasks: z.array(z.string()).default([]),
  /** True when the read hit its own bound and omits some of the mission. */
  truncated: z.boolean().default(false),
  refusesDispatch: z.boolean(),
  summary: z.string(),
});
export type MissionCostView = z.infer<typeof missionCostViewSchema>;

/**
 * What a cap MUTATION answers with: the cap, and what it means against today's
 * spend. Deliberately without the per-lane breakdown — the route does not send
 * one, and a type that claimed otherwise would be a contract nobody wrote.
 */
const missionCapUpdateSchema = missionCostViewSchema.omit({
  laneCosts: true,
  silentLanes: true,
  contestedTasks: true,
  truncated: true,
});
export type MissionCapUpdate = z.infer<typeof missionCapUpdateSchema>;

const compatibilityMcpInventorySchema = z.object({
  items: z.array(importedItemSchema),
  unreadable: z.array(
    z.object({
      vendor: z.string(),
      sourcePath: z.string(),
      name: z.string(),
      reason: z.string(),
    })
  ),
  sources: z.array(
    z.object({
      vendor: z.string(),
      scope: z.string(),
      sourcePath: z.string(),
      status: z.enum(["read", "absent", "unreadable"]),
      reason: z.string().optional(),
      items: z.number().int().nonnegative(),
    })
  ),
});

export type CompatibilityMcpInventory = z.infer<
  typeof compatibilityMcpInventorySchema
>;

const githubCredentialSchema = z.object({
  accessToken: z.string().min(8).max(4_096),
  expiresAt: z.string().datetime().optional(),
  refreshToken: z.string().min(8).max(4_096).optional(),
  refreshExpiresAt: z.string().datetime().optional(),
  login: z.string().min(1).max(100).optional(),
});

const githubConnectionStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  login: z.string().min(1).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});

const githubDeviceFlowStartSchema = z.object({
  flowId: z.string().uuid(),
  userCode: z.string().min(1).max(64),
  verificationUri: z.string().url().max(500),
  expiresAt: z.string().datetime(),
  intervalMs: z.number().int().min(1_000).max(120_000),
});

const githubDeviceFlowPollSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    retryAfterMs: z.number().int().min(1_000).max(120_000),
  }),
  z.object({
    status: z.literal("connected"),
    login: z.string().min(1).max(100).optional(),
    expiresAt: z.string().datetime().optional(),
    credential: githubCredentialSchema,
  }),
  z.object({
    status: z.literal("expired"),
    message: z.string().min(1).max(500),
  }),
  z.object({
    status: z.literal("denied"),
    message: z.string().min(1).max(500),
  }),
  z.object({
    status: z.literal("error"),
    message: z.string().min(1).max(500),
  }),
]);

const githubRepositorySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
});

const githubReviewCheckSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.enum(["status", "check-run"]),
  state: z.enum(["success", "pending", "failure", "neutral"]),
  status: z.string().min(1).max(80),
  conclusion: z.string().max(80).nullable().optional(),
  detailsUrl: z.string().url().max(2_000).optional(),
});

const githubAvailableReviewSchema = z.object({
    status: z.literal("available"),
    repository: githubRepositorySchema,
    branch: z.string().min(1).max(255),
    pullRequest: z.object({
      number: z.number().int().positive(),
      title: z.string().max(1_000),
      url: z.string().url().max(2_000),
      headSha: z.string().min(7).max(64),
      author: z.string().min(1).max(100).optional(),
      draft: z.boolean(),
      updatedAt: z.string().datetime(),
    }),
    checks: z.object({
      state: z.enum([
        "success",
        "pending",
        "failure",
        "neutral",
        "none",
        "unknown",
      ]),
      total: z.number().int().nonnegative().max(200),
      passed: z.number().int().nonnegative().max(200),
      pending: z.number().int().nonnegative().max(200),
      failed: z.number().int().nonnegative().max(200),
      neutral: z.number().int().nonnegative().max(200),
      unavailable: z.boolean(),
      items: z.array(githubReviewCheckSchema).max(100),
    }),
  });

const githubReviewSchema = z.discriminatedUnion("status", [
  githubAvailableReviewSchema,
  z.object({
    status: z.literal("no_pull_request"),
    repository: githubRepositorySchema,
    branch: z.string().min(1).max(255),
  }),
  z.object({
    status: z.literal("degraded"),
    reason: z.string().min(1).max(500),
    action: z.string().min(1).max(500).optional(),
  }),
]);

const githubReviewEnvelopeSchema = z.object({
  review: githubReviewSchema,
  credential: githubCredentialSchema.optional(),
});

const githubPullRequestActionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.enum(["created", "existing"]),
    review: githubAvailableReviewSchema,
  }),
  z.object({
    operation: z.literal("merged"),
    pullNumber: z.number().int().positive(),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    message: z.string().min(1).max(500),
  }),
]);

const githubPullRequestActionEnvelopeSchema = z.intersection(
  githubPullRequestActionSchema,
  z.object({ credential: githubCredentialSchema.optional() })
);

const githubPublishAuthorizationSchema = z.object({
  authorized: z.literal(true),
  mergeCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
  credential: githubCredentialSchema.optional(),
});

export type GitHubCredential = z.infer<typeof githubCredentialSchema>;
export type GitHubConnectionStatus = z.infer<
  typeof githubConnectionStatusSchema
>;
export type GitHubDeviceFlowStart = z.infer<
  typeof githubDeviceFlowStartSchema
>;
export type GitHubDeviceFlowPoll = z.infer<
  typeof githubDeviceFlowPollSchema
>;
export type GitHubReview = z.infer<typeof githubReviewSchema>;
export type GitHubReviewEnvelope = z.infer<
  typeof githubReviewEnvelopeSchema
>;
export type GitHubPullRequestAction = z.infer<
  typeof githubPullRequestActionSchema
>;
export type GitHubPullRequestActionEnvelope = z.infer<
  typeof githubPullRequestActionEnvelopeSchema
>;

// The `GET /api/fleet/readiness` wire contract. Plain object (strip mode) +
// `.optional()` keeps OLD backends parseable and strips unknown future fields,
// so a credential-shaped field a hostile payload smuggles in never survives.
const fleetReadinessPayloadSchema = z.object({
  vendors: z.array(
    z.object({
      vendor: z.string(),
      installed: z.boolean(),
      authenticated: z.boolean(),
      credentialMethod: z
        .enum(["vendor-login", "api-key", "custom-provider", "local-provider"])
        .optional(),
      detail: z.string(),
      fixHint: z.string().optional(),
      authState: z
        .enum(["confirmed", "negative", "unknown", "provider-unconfigured"])
        .optional(),
      // Provider/version fingerprint (P0.1). Explicit because zod strips
      // unknown keys — without this the evidence is dropped on the wire.
      cliVersion: z.string().optional(),
    })
  ),
  anyReady: z.boolean().optional(),
  warning: z.string().optional(),
  generatedAt: z.string().optional(),
});

const laneSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  provider: z.string(),
  role: z.string(),
  status: z.string(),
});

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.string(),
  chatId: z.string().nullable().optional(),
  workflowRunId: z.string().nullable().optional(),
  stepKey: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
});

const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  requestedBy: z.string(),
  kind: z.string(),
  reason: z.string(),
  status: z.string(),
  decisionNotes: z.string().nullable().optional(),
  gateTag: z.string().nullable().optional(),
  evidence: approvalEvidenceSchema.nullable().optional(),
  reviewCertification: mergeReviewRecordSchema.nullable().optional(),
  // Checkpoint edge (P0.1): explicit in the schema because zod strips unknown
  // keys — without this the job binding would be silently dropped on the wire.
  jobId: z.string().nullable().optional(),
  consumedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  decidedAt: z.string().nullable().optional(),
});

/**
 * What approving a `merge` gate did to the primary checkout — the `merge` half
 * of `PATCH /api/approvals/:id`, mirroring `WorktreeMergeResult`
 * (packages/core/src/worktree.ts). Declared here rather than imported because
 * `@muon/client` depends only on `@muon/protocol`; the union is kept in sync by
 * `packages/client/tests/api-client.test.ts`.
 *
 * Today a non-success (`conflict`/`blocked`/`failed`) is thrown by the route as
 * a 409 carrying the same reason, so a 200 normally carries `merged`/`no-op`.
 * All five are parsed anyway: a surface must be able to RENDER whatever the
 * brain reports, not only the outcomes it expects.
 */
const approvalMergeResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("merged"),
    sha: z.string(),
    message: z.string().optional(),
    changedFiles: z.number().optional(),
    recovered: z.boolean().optional(),
    mergeCommit: z.string().optional(),
  }),
  z.object({ status: z.literal("no-op"), reason: z.string() }),
  z.object({ status: z.literal("conflict"), reason: z.string() }),
  z.object({ status: z.literal("blocked"), reason: z.string() }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

export type ApprovalMergeResult = z.infer<typeof approvalMergeResultSchema>;

const eventSchema = z.object({
  id: z.string(),
  laneId: z.string(),
  taskId: z.string(),
  kind: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string(),
  // Migration 0043 audit evidence. These MUST be explicit: Zod strips unknown
  // keys, and trajectory/audit readers otherwise lose the exact principal,
  // accountable human, request, and diff that the backend persisted.
  principalId: z.string().nullable().optional(),
  principalKind: z.string().nullable().optional(),
  accountablePrincipalId: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  payloadDiff: z.unknown().optional(),
});

const contextExposureRecordSchema = z.object({
  id: z.string(),
  frameId: z.string(),
  artifactKind: z.enum([
    "memory_note",
    "peer_message",
    "event",
    "stream_chunk",
    "condensation_summary",
  ]),
  artifactId: z.string(),
  eligible: z.boolean(),
  included: z.boolean(),
  reason: z.string(),
  ordinal: z.number().int().nullable().optional(),
  charCount: z.number().int().nullable().optional(),
  trustTier: z
    .enum(["human_confirmed", "crew_vouched", "trust_floor"])
    .nullable()
    .optional(),
  createdAt: z.string(),
});

const contextFrameDeliveryRecordSchema = z.object({
  id: z.string(),
  frameId: z.string(),
  status: z.enum(["delivered", "failed"]),
  sessionId: z.string().nullable().optional(),
  vendorSessionId: z.string().nullable().optional(),
  failure: z.string().nullable().optional(),
  createdAt: z.string(),
});

const contextFrameRecordSchema = z.object({
  id: z.string(),
  clientRequestId: z.string(),
  jobId: z.string(),
  taskId: z.string(),
  laneId: z.string(),
  workspacePath: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  missionId: z.string(),
  turnSeq: z.number().int().positive(),
  source: z.enum(["dispatch", "loop", "steer", "tool_result"]),
  completeness: z.string(),
  content: z.string(),
  contentSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  charCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: z.string(),
  exposures: z.array(contextExposureRecordSchema).default([]),
  delivery: contextFrameDeliveryRecordSchema.nullable().default(null),
});

const contextCondensationMemberRecordSchema = z.object({
  id: z.string(),
  condensationId: z.string(),
  artifactKind: z.enum([
    "memory_note",
    "peer_message",
    "event",
    "stream_chunk",
    "condensation_summary",
  ]),
  artifactId: z.string(),
  createdAt: z.string(),
});

const contextCondensationRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  taskId: z.string(),
  inputFrameId: z.string().nullable().optional(),
  outputFrameId: z.string().nullable().optional(),
  origin: z.enum(["muon", "vendor_reported"]),
  sourceResponseId: z.string(),
  summary: z.string().nullable().optional(),
  summaryOffset: z.number().int().nullable().optional(),
  createdAt: z.string(),
  members: z.array(contextCondensationMemberRecordSchema).default([]),
});

const contextEvidencePageSchema = z.object({
  frames: z.array(contextFrameRecordSchema),
  condensations: z.array(contextCondensationRecordSchema),
  condensationsTruncated: z.boolean().default(false),
});

const lanesResponseSchema = z.object({
  lanes: z.array(laneSchema),
});

const eventsResponseSchema = z.object({
  events: z.array(eventSchema),
});

// Review-lane sibling-diff read (GET /api/tasks/:taskId/worktree-diff).
const taskWorktreeDiffSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    changedFiles: z.array(z.string()),
    baseCommit: z.string().optional(),
    diff: z.object({
      text: z.string(),
      truncated: z.boolean(),
      totalBytes: z.number(),
    }),
  }),
  z.object({
    status: z.literal("no-worktree"),
    reason: z.string(),
  }),
]);

export type TaskWorktreeDiff = z.infer<typeof taskWorktreeDiffSchema>;

const taskDetailSchema = taskSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
  assignments: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      state: z.string(),
      createdAt: z.string(),
      completedAt: z.string().nullable().optional(),
      lane: laneSchema.optional(),
    })
  ),
  handoffs: z.array(
    z.object({
      id: z.string(),
      packetTitle: z.string(),
      packetBody: z.string(),
      // Typed v2 packet column (P0.3). Lenient pipe: old backends omit the
      // key (→ null); read-side honesty/validation lives in handoff_read.
      packetJson: z.unknown().default(null),
      status: z.string(),
      createdAt: z.string(),
      fromLane: laneSchema.optional(),
      toLane: laneSchema.optional(),
    })
  ),
  approvals: z.array(
    z.object({
      id: z.string(),
      requestedBy: z.string(),
      kind: z.string(),
      reason: z.string(),
      status: z.string(),
      decisionNotes: z.string().nullable().optional(),
      createdAt: z.string(),
      decidedAt: z.string().nullable().optional(),
    })
  ),
});

const tasksResponseSchema = z.object({
  tasks: z.array(taskSchema),
});

const approvalsResponseSchema = z.object({
  approvals: z.array(approvalSchema),
});

const dashboardResponseSchema = z.object({
  pendingApprovals: z.number(),
  activeHandoffs: z.number(),
});

const memoryNoteSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  taskId: z.string().nullable().optional(),
  laneId: z.string().nullable().optional(),
  modules: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  // Symbol anchors (ADR-0012); defaulted for back-compat with pre-0012 backends.
  symbols: z.array(z.string()).default([]),
  trust: z.string(),
  confirmed: z.boolean(),
  stale: z.boolean(),
  status: z.string(),
  scope: z.string().optional(),
  chatId: z.string().nullable().optional(),
  // ADR-0026 §8 — THE LABEL, and load-bearing on THIS schema for the same reason
  // `confirmedBy` below is: zod strips unknown keys, so omitting it here deletes the
  // field off every recall/search response and the §8 residue view becomes a list of
  // rows a human cannot tell apart from assigned ones. `null` IS the label ("no
  // workspace"); a surface renders it as `workspace=unscoped`. Absent on an older
  // backend → null, which reads as unassigned and is honest about what was learned.
  workspacePath: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // R3 TTL (additive): a pre-TTL backend omits both, which reads as "this note
  // never expires" — byte-for-byte the old behaviour.
  expiresAt: z.string().nullable().optional(),
  expired: z.boolean().default(false),
  pinned: z.boolean().default(false),
  provenance: z
    .object({
      sourceType: z.string(),
      rawRef: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable()
    .default(null),
  // P0-2 (additive): WHO vouched. Load-bearing on THIS schema specifically —
  // zod strips unknown keys, so an omission here silently deleted the field off
  // every recall response, and `renderMemorySlice` (which admits a human confirm
  // OR an orchestrator vouch) never saw a vouch at all. The crew went on
  // coordinating from human-confirmed memory only. Absent on an older backend →
  // null, i.e. today's "nobody has vouched".
  confirmedBy: z.enum(["human", "orchestrator"]).nullable().default(null),
  outcome: z
    .enum(["worked", "abandoned", "superseded", "unknown"])
    .nullable()
    .default(null),
});

/**
 * B3: the memory GRAPH is a best-effort mirror of the ledger (ADR-0021), so a
 * memory read that could not consult it degrades instead of 500-ing, and says
 * so with this marker. Absent = the graph answered; present = the response is
 * partial for a NAMED reason, never a silent empty success.
 */
const memoryGraphDegradedSchema = z.object({
  subsystem: z.literal("memory-graph"),
  reason: z.string().max(1_000),
});

export type MemoryGraphDegraded = z.infer<typeof memoryGraphDegradedSchema>;

const memoryNotesResponseSchema = z.object({
  notes: z.array(memoryNoteSchema),
  degraded: memoryGraphDegradedSchema.optional(),
});

const memoryGraphRelationSchema = z.enum([
  "SUPERSEDES",
  "EXTENDS",
  "CONTRADICTS",
  "AUTHORED_BY",
  "CONFIRMED_BY",
  "ANCHORED_TO",
  "ABOUT_SYMBOL",
  "ABOUT_TASK",
  "BY_LANE",
  "TOUCHED",
  "WORKED_ON",
  "GATED_BY",
  "CLONED_FROM",
]);

const memoryGraphCoordinateSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9@._~:+#$%/-]+$/);

// Defensive wire allowlist for agent-facing graph surfaces. Zod strips every
// unknown field, so a future/backend-regression payload cannot smuggle task
// titles, approval reasons, principal display names, or any other prose around
// the one explicitly gated `text` field.
const memoryGraphNodeSchema = z.object({
  id: memoryGraphCoordinateSchema,
  entityId: memoryGraphCoordinateSchema,
  type: z.enum([
    "note",
    "principal",
    "module",
    "symbol",
    "task",
    "lane",
    "approval",
  ]),
  kind: memoryGraphCoordinateSchema.optional(),
  trust: z.enum(["low", "medium", "high"]).optional(),
  confirmed: z.boolean().optional(),
  status: memoryGraphCoordinateSchema.optional(),
  vendor: memoryGraphCoordinateSchema.nullable().optional(),
  module: memoryGraphCoordinateSchema.optional(),
  name: memoryGraphCoordinateSchema.optional(),
  text: z.string().max(4_000).optional(),
  textTruncated: z.boolean().optional(),
});

const memoryGraphEdgeSchema = z.object({
  from: memoryGraphCoordinateSchema,
  to: memoryGraphCoordinateSchema,
  relation: memoryGraphRelationSchema,
});

const memoryTraversalProvenanceSchema = z.object({
  root: memoryGraphCoordinateSchema,
  hops: z.number().int().nonnegative().max(6),
  relations: z.array(memoryGraphRelationSchema).max(12),
  truncated: z.boolean(),
  // The literal is sourced from the exported constant, so the wire check and the
  // TS type can never drift into disagreeing about the policy's spelling.
  textPolicy: z.literal(MEMORY_TRAVERSAL_TEXT_POLICY),
});

const memoryNeighborsResponseSchema = z.object({
  nodes: z.array(memoryGraphNodeSchema).max(100),
  edges: z.array(memoryGraphEdgeSchema).max(400),
  provenance: memoryTraversalProvenanceSchema,
  degraded: memoryGraphDegradedSchema.optional(),
});

const memoryExplainResponseSchema = z.object({
  noteId: memoryGraphCoordinateSchema,
  path: z.object({
    nodes: z.array(memoryGraphNodeSchema).max(100),
    edges: z.array(memoryGraphEdgeSchema).max(99),
    goal: z.enum(["approval", "principal", "task", "anchor", "note", "missing"]),
  }),
  contradictions: z.array(memoryGraphNodeSchema).max(100),
  provenance: memoryTraversalProvenanceSchema,
  degraded: memoryGraphDegradedSchema.optional(),
});

const memoryDeleteResponseSchema = z.object({
  noteId: memoryGraphCoordinateSchema,
  deleted: z.literal(true),
  alreadyDeleted: z.boolean(),
});

const memoryCloneResponseSchema = z.object({
  noteId: memoryGraphCoordinateSchema,
  clonedFromNoteId: memoryGraphCoordinateSchema,
  confirmed: z.literal(false),
});

const memoryCompactionResponseSchema = z.object({
  previewDigest: z.string().optional(),
  retentionDays: z.number().int().min(1).max(3_650),
  cutoff: z.string().datetime(),
  scanned: z.number().int().nonnegative().max(500),
  tombstoned: z.number().int().nonnegative().max(500),
  noteIds: z.array(memoryGraphCoordinateSchema).max(500),
  dryRun: z.boolean(),
  batchId: z.string().nullable(),
  reason: z.string().nullable(),
});

const bulkMemoryRemovalRequestSchema = z.object({
  dryRun: z.boolean().optional(),
  /** Bind an apply to the dry run that justified it (409 if the policy moved). */
  previewDigest: z.string().length(64).optional(),
  maxForget: z.number().int().min(1).max(500).optional(),
  batchId: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(500).optional(),
});

const memoryCompactionSettingSchema = z.object({
  retentionDays: z.number().int().min(1).max(3_650),
});

/** R4 memory-mining toggle (default ON server-side; see operator-settings.ts). */
const memoryMiningSettingSchema = z.object({ memoryMining: z.boolean() });

/** The self-expiring "a standing operator approver is watching" lease. */
const standingApproverLeaseSchema = z.object({
  standingApprover: standingApproverGrantSchema,
});

/** R3 TTL policy (operator-owned). `days: 0` disables expiry outright; the
 *  ceiling can never be "high" because a high-trust note never auto-expires. */
const memoryTtlPolicySchema = z.object({
  days: z.number().int().min(0).max(3_650),
  trustCeiling: z.enum(["low", "medium"]),
});

/** R3 bounded expiry sweep. `skipped` means the policy was unreadable and the
 *  sweep fail-closed to evicting nothing. */
const memoryExpirySweepSchema = z.object({
  /** What this run's counts depended on; pass it back to bind an apply. */
  previewDigest: z.string().optional(),
  ttlDays: z.number().int().min(0).max(3_650).nullable(),
  policySource: z
    .enum(["legacy_global", "kind_table"])
    .nullable()
    .optional()
    .default(null),
  daysByKind: memoryLifecyclePolicySchema.shape.daysByKind
    .nullable()
    .optional()
    .default(null),
  scanned: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  noteIds: z.array(z.string()).max(500),
  skipped: z.boolean(),
  dryRun: z.boolean(),
  batchId: z.string().nullable(),
  reason: z.string().nullable(),
});

const memoryLifecycleSettingSchema = z.object({
  source: z.enum(["legacy_global", "kind_table"]),
  legacyFallbackDays: z.number().int().min(0).max(3_650).nullable(),
  policy: memoryLifecyclePolicySchema,
  recommended: memoryLifecyclePolicySchema,
});

const memoryLifecycleMigrationSchema = z.object({
  policy: memoryLifecyclePolicySchema,
  previousSource: z.enum(["legacy_global", "kind_table"]),
  dryRun: z.boolean(),
  applied: z.boolean(),
  previewDigest: z.string().length(64),
  scanned: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  wouldHideNow: z.number().int().nonnegative(),
  wouldRestoreNow: z.number().int().nonnegative(),
  wouldBecomePermanent: z.number().int().nonnegative(),
});

const revertExpiredBatchSchema = z.object({
  batchId: z.string(),
  reverted: z.number().int().nonnegative(),
  noteIds: z.array(z.string()).max(500),
});

export type MemoryTtlPolicy = z.infer<typeof memoryTtlPolicySchema>;
export type MemoryLifecycleSetting = z.infer<
  typeof memoryLifecycleSettingSchema
>;
export type MemoryLifecycleMigrationResult = z.infer<
  typeof memoryLifecycleMigrationSchema
>;
export type { MemoryLifecyclePolicy };
export type MemoryExpirySweepResult = z.infer<typeof memoryExpirySweepSchema>;
export type BulkMemoryRemovalRequest = z.infer<
  typeof bulkMemoryRemovalRequestSchema
>;
export type RevertExpiredBatchResult = z.infer<typeof revertExpiredBatchSchema>;

// P1.4 memory packs: the operator-only export wire shape. Schema key order
// deliberately MATCHES the backend's canonical record field order, so a parsed
// record re-serializes to the exact canonical bytes its content-address (the
// recordHash filename) was computed over.
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const memoryPackManifestSchema = z.object({
  version: z.literal(1),
  origin: z.object({ fingerprint: z.string(), label: z.string() }),
  counts: z.object({
    records: z.number(),
    tombstones: z.number(),
    omitted: z.number(),
  }),
  records: z.array(
    z.object({
      hash: sha256HexSchema,
      file: z.string(),
      originNoteId: z.string(),
      textHash: sha256HexSchema,
    })
  ),
  tombstones: z.array(
    z.object({
      originNoteId: z.string(),
      textHash: sha256HexSchema,
      reason: z.enum(["superseded", "revoked"]),
      supersededByNoteId: z.string().nullable(),
      retiredAt: z.string(),
    })
  ),
  omissions: z.array(z.string()),
  invariants: z.object({
    confirmedOnly: z.boolean(),
    unconfirmedTextExcluded: z.boolean(),
    secretsRedactedBeforeWrite: z.boolean(),
    noCredentialMaterial: z.boolean(),
  }),
  packDigest: sha256HexSchema,
});
const memoryPackRecordFileSchema = z.object({
  version: z.literal(1),
  origin: z.object({
    fingerprint: z.string(),
    noteId: z.string(),
    label: z.string(),
  }),
  note: z.object({
    kind: z.string(),
    text: z.string(),
    textHash: sha256HexSchema,
    scope: z.string(),
    trust: z.string(),
    modules: z.array(z.string()),
    topics: z.array(z.string()),
    symbols: z.array(z.string()),
    validFrom: z.string(),
    recordedAt: z.string(),
  }),
  author: z.object({
    principal: z.string(),
    kind: z.enum(["human", "agent"]),
  }),
  confirmation: z.object({
    principal: z.string(),
    decision: z.literal("confirm"),
    at: z.string(),
    textHash: sha256HexSchema,
  }),
  supersededTextHashes: z.array(z.string()),
});
const memoryPackExportSchema = z.object({
  manifest: memoryPackManifestSchema,
  records: z.array(
    z.object({ hash: sha256HexSchema, record: memoryPackRecordFileSchema })
  ),
});
export type MemoryPackManifest = z.infer<typeof memoryPackManifestSchema>;
export type MemoryPackRecordFile = z.infer<typeof memoryPackRecordFileSchema>;
export type MemoryPackExport = z.infer<typeof memoryPackExportSchema>;

// P1.4 memory packs: the operator-only IMPORT report wire shape — the server's
// deterministic per-record verdicts (proposals only; nothing here is trusted).
const memoryPackImportReportSchema = z.object({
  origin: z.object({ fingerprint: z.string(), label: z.string() }),
  proposed: z.array(z.object({ recordHash: z.string(), noteId: z.string() })),
  duplicatesOfConfirmed: z.array(
    z.object({ recordHash: z.string(), noteId: z.string() })
  ),
  duplicates: z
    .array(z.object({ recordHash: z.string(), noteId: z.string() }))
    .default([]),
  alreadyImported: z.array(z.string()),
  conflicts: z.array(
    z.object({
      noteId: z.string(),
      withNoteId: z.string(),
      edgeKind: z.string(),
    })
  ),
  revocations: z.array(
    z.object({
      noteId: z.string(),
      originNoteId: z.string(),
      reason: z.string(),
    })
  ),
  refused: z.array(z.object({ recordHash: z.string(), reason: z.string() })),
  counts: z.record(z.string(), z.number()),
});
export type MemoryPackImportReport = z.infer<
  typeof memoryPackImportReportSchema
>;

// P2.5 HERO: the fused pre-edit context wire shape. `memoryNoteSchema` strips the
// extra ledger fields the backend sends; proximity/onTarget are the fusion annots.
const preEditMemorySchema = memoryNoteSchema.extend({
  proximity: z.number(),
  onTarget: z.boolean(),
  // ADR-0012 on-symbol tier flag; defaulted for back-compat with pre-0012 backends.
  onSymbol: z.boolean().default(false),
});

const preEditCrewFindingSchema = preEditMemorySchema.extend({
  confirmed: z.literal(false),
  // Widened 2026-08-06 with the crew-recall posture: null = posture-admitted
  // same-mission finding with NO vouch; "orchestrator" = the D12-C vouch.
  // Never any other principal — a wire that claims one still fails to parse.
  confirmedBy: z.literal("orchestrator").nullable(),
  tier: z.literal("crew_vouched"),
  authority: z.literal("inform"),
});

const preEditContextSchema = z.object({
  target: z.object({
    symbol: z.string().optional(),
    module: z.string().optional(),
    files: z.array(z.string()).optional(),
  }),
  blastRadius: z.object({
    modules: z.array(z.string()),
    symbols: z.array(z.string()).optional(),
    depth: z.number().optional(),
    source: z.enum(["provided", "codegraph", "target-only"]),
  }),
  memories: z.array(preEditMemorySchema),
  // ADR-0027: crew-vouched prose is an explicit INFORMATION channel, never an
  // implicit widening of `memories` (the edit-governance gate).
  crewFindings: z.array(preEditCrewFindingSchema).default([]),
  warnings: z.array(
    z.object({
      kind: z.enum(["contradicts", "proposes_supersede"]),
      noteId: z.string(),
      relatedNoteId: z.string(),
      detail: z.string(),
    })
  ),
  pendingProposals: z.array(
    z.object({
      proposalNoteId: z.string(),
      victimNoteId: z.string(),
      modules: z.array(z.string()).default([]),
      detail: z.string(),
    })
  ),
  // KG-7 + KG-8 (ADR-0014): the cross-agent activity channel, coordinates ONLY.
  // `state` is now `live` (KG-7 present tense) OR `recent` (KG-8 past tense); the
  // enum MUST admit `recent` or a KG-8 row would fail to parse. `.default([])`
  // keeps a pre-KG-7 backend (no `activity`) parseable → today's hero.
  activity: z
    .array(
      z.object({
        laneId: z.string(),
        vendor: z.string(),
        taskId: z.string(),
        jobId: z.string(),
        kind: z.enum(["running", "editing"]),
        anchor: z.string(),
        anchorKind: z.enum(["symbol", "module"]),
        at: z.string(),
        state: z.enum(["live", "recent"]),
        // KG-9 (ADR-0014 §6) proximity tier, coordinates only (booleans/a number).
        // Optional/defaulted so a pre-KG-9 backend (no tier) stays parseable → the
        // view treats every entry as a neighbour, exactly today's behaviour.
        onSymbol: z.boolean().optional(),
        onTarget: z.boolean().optional(),
        proximity: z.number().optional(),
      })
    )
    .default([]),
  // KG-10 (ADR-0014 §5): duplicate-work, OTHER live lanes doing semantically the
  // same work (brief paraphrase). COORDINATES ONLY (a similarity scalar + ids,
  // never the brief text). `.default([])` keeps a pre-KG-10 backend / dense-off
  // response parseable → today's hero.
  duplicateWork: z
    .array(
      z.object({
        jobId: z.string(),
        taskId: z.string(),
        vendor: z.string(),
        similarity: z.number(),
        state: z.literal("live"),
      })
    )
    .default([]),
  // D14 COVERAGE. THIS HOP IS THE ONE THAT SILENTLY SWALLOWS NEW FIELDS: zod
  // strips every undeclared key, so a coverage block the backend computed would
  // vanish here without an error and every surface downstream would be back to
  // "empty means who-knows-what". Declared, and reused from @muon/protocol so the
  // wire shape has exactly ONE definition rather than a hand-copy that can drift
  // from the producer. `.optional()` (no default) because a pre-D14 backend sends
  // nothing and inventing zeros would fabricate a measurement.
  coverage: preEditCoverageSchema.optional(),
});

// P0.4: receipt row as stored by the brain. Loose string enums are narrowed by
// the ApprovalReceipt type at the call sites (same pattern as approvals).
const receiptSchema = z.object({
  id: z.string(),
  approvalId: z.string(),
  taskId: z.string(),
  jobId: z.string(),
  sessionId: z.string().nullable().optional(),
  workspacePath: z.string(),
  actionClass: z.enum(["read", "test", "edit"]),
  toolName: z.string(),
  payloadDigest: z.string(),
  manifestFingerprint: z.string().nullable().optional(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable().optional(),
  useCount: z.number(),
  lastUsedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

const sessionSchema = z.object({
  id: z.string(),
  laneId: z.string(),
  taskId: z.string(),
  // Checkpoint edge (P0.1): explicit so zod does not strip the job binding.
  jobId: z.string().nullable().optional(),
  vendorSessionId: z.string().nullable().optional(),
  status: z.string(),
    owner: z.string().optional(),
    ownerChangedAt: z.string().nullable().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  lane: laneSchema.optional(),
});

const laneSuggestionSchema = z.object({
  laneId: z.string(),
  laneKey: z.string(),
  laneName: z.string(),
  score: z.number(),
  reason: z.string(),
});

const routingResponseSchema = z.object({
  suggestions: z.array(laneSuggestionSchema),
});

const harnessRecordSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  config: harnessConfigSchema,
  version: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const workflowTemplateRecordSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  version: z.number(),
  definition: workflowDefinitionSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const workflowRunSchema = z.object({
  id: z.string(),
  templateKey: z.string().nullable().optional(),
  templateVersion: z.number().nullable().optional(),
  request: z.string(),
  workspacePath: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  proposal: workflowProposalSchema,
  status: z.string(),
  proposedBy: z.string(),
  appliedBy: z.string().nullable().optional(),
  appliedAt: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type WorkflowCallerControl = {
  callerJobId: string;
  delegationToken: string;
};

function workflowCallerHeaders(
  control?: WorkflowCallerControl
): Record<string, string> | undefined {
  return control
    ? {
        "x-muon-caller-job-id": control.callerJobId,
        "x-muon-delegation-token": control.delegationToken,
      }
    : undefined;
}

const workflowRunTaskSchema = taskSchema.extend({
  assignments: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        laneId: z.string(),
        summary: z.string(),
        state: z.string(),
        lane: laneSchema.optional(),
      })
    )
    .default([]),
  approvals: z.array(approvalSchema).default([]),
});

const loopRunSchema = z.object({
  id: z.string(),
  dispatchJobId: z.string().nullable().optional(),
  taskId: z.string(),
  workflowRunId: z.string().nullable().optional(),
  stepKey: z.string().nullable().optional(),
  harnessKey: z.string().nullable().optional(),
  kind: z.string(),
  budget: z.object({
    maxIterations: z.number(),
    maxWallMs: z.number().optional(),
  }),
  progress: loopProgressSchema.nullable().optional(),
  iterations: z.number(),
  status: z.string(),
  stopReason: z.string().nullable().optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
});

const scheduleOccurrenceSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  scheduledFor: z.string(),
  status: z.enum(["claimed", "running", "done", "failed"]),
  chatId: z.string().nullable().optional(),
  rootJobId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  claimedAt: z.string(),
  startedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
});

const governedScheduleSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  workspacePath: z.string(),
  vendor: z.string(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  cadenceMinutes: z.number().int().nullable().optional(),
  nextRunAt: z.string(),
  maxRuns: z.number().int().nullable().optional(),
  runCount: z.number().int(),
  maxWallMs: z.number().int(),
  maxDescendantWallMs: z.number().int(),
  status: z.enum(["active", "paused", "completed"]),
  lastStartedAt: z.string().nullable().optional(),
  lastEndedAt: z.string().nullable().optional(),
  lastStatus: z.enum(["claimed", "running", "done", "failed"]).nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  occurrences: z.array(scheduleOccurrenceSchema).default([]),
});

const metricsResponseSchema = z.object({
  metrics: z.object({
    approvals: z.object({
      decided: z.number(),
      pending: z.number(),
      averageTurnaroundMs: z.number().nullable(),
      medianTurnaroundMs: z.number().nullable(),
    }),
    handoffs: z.object({
      total: z.number(),
      prepSamples: z.number(),
      averagePrepMs: z.number().nullable(),
      medianPrepMs: z.number().nullable(),
    }),
    assignments: z.object({
      total: z.number(),
      duplicateBriefings: z.number(),
      tasksWithDuplicates: z.number(),
    }),
    tasks: z.object({
      total: z.number(),
      completed: z.number(),
      averageCycleMs: z.number().nullable(),
      medianCycleMs: z.number().nullable(),
    }),
  }),
});

// A generous BACKSTOP against an infinite hang, not a tight deadline: the brain
// is loopback, so even the heaviest discrete calls (code-graph preedit, embedding
// recall, bundle metadata) finish in a few seconds — but a wedged Fastify handler
// or a half-open socket would otherwise block an awaiting command FOREVER, which
// silently defeats every caller's own deadline (e.g. the dispatch observer's
// poll budget). 120s clears any legitimate local call while still guaranteeing
// the request settles. Callers that need a tighter bound can lower it per client.
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Marker for a request that exceeded the client's bounded settle window. */
class RequestTimeoutError extends Error {}

/**
 * A non-2xx answer from control, carrying the STATUS alongside the message.
 *
 * "Control REFUSED this credential" (401/403) and "control could not answer"
 * (timeout, socket, 5xx) are different facts, and a caller whose decision is a
 * SECURITY posture — the runner's memory-mining fail-open, for one — must not
 * have to recover that difference by string-matching a formatted message.
 * Strictly additive: the message is byte-identical to the plain `Error` this
 * replaced, so every existing `catch` behaves exactly as before.
 */
export class MuonApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    message: string,
    /**
     * ADR-0033: the typed refusal the backend attached, already projected to
     * this caller's audience server-side. Absent for a route that has not
     * adopted the typed path yet, and for every non-refusal failure — so a
     * consumer must treat it as an upgrade, never a precondition.
     */
    readonly refusal?: Refusal
  ) {
    super(message);
    this.name = "MuonApiHttpError";
  }
}

/** The refusal carried by an HTTP failure, if the route typed one. */
export function refusalOf(error: unknown): Refusal | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (current instanceof MuonApiHttpError && current.refusal) {
      return current.refusal;
    }
    current =
      current instanceof Error
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

/** True for control refusing the caller's credential/authority, as opposed to
 *  failing to answer at all. The two must never share a failure posture.
 *  Walks the `cause` chain (bounded): a wrapper like
 *  `new Error(note, { cause })` must not erase the classification the
 *  exit-code contract depends on. */
export function isAuthorizationFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (
      current instanceof MuonApiHttpError &&
      (current.status === 401 || current.status === 403)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Bound a fetch to `ms` WITHOUT changing the observable call (no injected
 * AbortSignal), so the guarantee is "the caller's await always settles". We
 * deliberately do not abort the underlying socket — for a loopback, short-lived
 * CLI/host that is a negligible leak, and racing keeps the fetcher call shape
 * that every consumer test asserts on. The timer is unref'd (never keeps the
 * process alive) and cleared on settle; the losing promise's late rejection is
 * consumed here, so it can never surface as an unhandled rejection.
 */
function withRequestTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError()), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class MuonApiClient {
  constructor(
    private baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
    private apiToken?: string,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    /**
     * Re-read where the brain LIVES, for hosts that outlive it.
     *
     * The base and the token are resolved once, at construction, from the
     * brain lockfile. That is correct for the CLI, which is a new process per
     * command. It is wrong for every long-lived host — the MCP server, the
     * TUI, the desktop — because the brain can restart onto a new port with a
     * new token while they keep running.
     *
     * Measured 2026-08-10: an MCP server started when the lockfile read
     * :55036 was still calling :55036 two days later, while `muon doctor`
     * reached the live brain on :51834 without trouble. Every memory tool an
     * attached agent held returned "fetch failed" — the moat, unreachable,
     * with nothing on any surface saying why.
     *
     * Supplying this makes a connection failure recoverable instead of
     * terminal. Omit it and behaviour is exactly as before.
     */
    private readonly rebase?: () => {
      readonly baseUrl: string;
      readonly apiToken?: string;
    } | null
  ) {}

  /**
   * Re-resolve after a refused connection, and report whether anything moved.
   *
   * Only ever called for a CONNECTION-level failure, never a timeout: a
   * refused socket means the request did not reach a server, so replaying it
   * cannot duplicate work. A timeout means the opposite — the brain may have
   * accepted and processed it — and retrying there could double a write.
   */
  private tryRebase(): boolean {
    if (!this.rebase) return false;
    let next: { readonly baseUrl: string; readonly apiToken?: string } | null;
    try {
      next = this.rebase();
    } catch {
      return false;
    }
    if (!next) return false;
    const moved =
      next.baseUrl !== this.baseUrl || next.apiToken !== this.apiToken;
    if (!moved) return false;
    this.baseUrl = next.baseUrl;
    this.apiToken = next.apiToken;
    return true;
  }

  private async request(
    path: string,
    init?: RequestInit,
    retried = false
  ): Promise<unknown> {
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      // "No silent hang" (Wave 0 charter): every discrete request settles within
      // a bounded window. request() always reads a JSON body (never a stream), so
      // this can never truncate an SSE/long-poll.
      const fetchPromise = this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          // Only declare a JSON body when one is actually sent. A body-less
          // mutation (e.g. DELETE archiveChat) with Content-Type:
          // application/json makes Fastify's JSON parser reject the empty
          // body ("Body cannot be empty …", 400). An explicit init header
          // still wins via the spread below.
          ...(init?.body != null
            ? { "Content-Type": "application/json" }
            : {}),
          ...(this.apiToken
            ? { Authorization: `Bearer ${this.apiToken}` }
            : {}),
          ...(init?.headers ?? {}),
        },
      });
      response =
        this.requestTimeoutMs > 0
          ? await withRequestTimeout(fetchPromise, this.requestTimeoutMs)
          : await fetchPromise;
    } catch (error) {
      // A wedged backend (accepted the socket, never responded) reads distinctly
      // as "did not respond in time", not a generic connection error.
      if (error instanceof RequestTimeoutError) {
        throw new Error(
          `Control did not respond within ${this.requestTimeoutMs}ms (${this.baseUrl}${path}) — is the backend healthy?`,
          { cause: error }
        );
      }
      // Network-level failure (refused/DNS). Before reporting it, ask where
      // the brain lives NOW: a long-lived host outlives brain restarts, and
      // the address it was built with goes stale silently. Retried exactly
      // once, and only when the answer actually moved, so a genuinely offline
      // brain still fails fast with the same message rather than looping.
      if (!retried && this.tryRebase()) {
        return await this.request(path, init, true);
      }
      // Name the loopback base + path we tried so "Control offline" is
      // actionable. NEVER the token or headers — only the URL we attempted.
      // Preserve the original as `cause`.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (${this.baseUrl}${path})`, { cause: error });
    }

    if (!response.ok) {
      // Surface the backend's reason (e.g. "all agents working"), status
      // codes alone make fleet/gate errors unactionable.
      let detail = "";
      let refusal: Refusal | undefined;
      try {
        const body = (await response.json()) as {
          message?: string;
          refusal?: Refusal;
        };
        if (body?.message) {
          detail = `, ${body.message}`;
        }
        // ADR-0033. Shape-checked rather than trusted: this is a response body,
        // and a malformed one must degrade to "no typed refusal" instead of
        // reaching a renderer as a half-object.
        if (
          body?.refusal &&
          typeof body.refusal === "object" &&
          typeof body.refusal.rule === "string" &&
          typeof body.refusal.summary === "string" &&
          Array.isArray(body.refusal.evidence)
        ) {
          refusal = body.refusal;
        }
      } catch {
        // non-JSON error body
      }
      throw new MuonApiHttpError(
        response.status,
        response.statusText,
        `${response.status} ${response.statusText}${detail}`,
        refusal
      );
    }

    return response.json();
  }

  /**
   * ADR-0043 operator inbox: every OPEN blocking question on the machine.
   * A CLIENT method (not the standalone helper) so long-lived hosts get the
   * moved-brain rebase and mocked stores see it like any other read.
   */
  async listOpenQuestions(): Promise<{
    questions: import("@muon/protocol").BlockingQuestion[];
    truncated: boolean;
  }> {
    return z
      .object({
        questions: z.array(blockingQuestionSchema),
        truncated: z.boolean().default(false),
      })
      .parse(await this.request("/api/questions/open"));
  }

  /** ADR-0043 operator half, through THIS client so a moved brain is
   *  followed between the poll and the human's answer. Null = no longer open. */
  async answerQuestion(input: {
    questionId: string;
    taskId: string;
    answer: string;
  }): Promise<{ answered: boolean }> {
    const result = z
      .object({ question: z.unknown().nullable() })
      .parse(
        await this.request(
          `/api/questions/${encodeURIComponent(input.questionId)}/answer`,
          {
            method: "POST",
            body: JSON.stringify({ answer: input.answer, taskId: input.taskId }),
          }
        )
      );
    return { answered: result.question !== null };
  }

  async health(): Promise<Health> {
    return healthSchema.parse(await this.request("/health"));
  }

  /**
   * ADR-0038 D1: read the vendor MCP inventory. Operator-tier route, and it
   * takes no argument on purpose — the caller cannot name a file, a vendor or a
   * scope, so there is nothing here to point at a path.
   */
  async discoverCompatibilityMcp(): Promise<CompatibilityMcpInventory> {
    return compatibilityMcpInventorySchema.parse(
      await this.request("/api/compatibility/mcp")
    );
  }

  /**
   * ADR-0038 D6/D8 — what ONE lane holds. Per lane, never workspace-wide, and
   * there is no "everything enabled anywhere" call for the same reason there is
   * no workspace scope in the store.
   */
  async listLaneImports(laneKey: string): Promise<EnabledItem[]> {
    return z
      .array(enabledItemSchema)
      .parse(
        await this.request(
          `/api/compatibility/mcp/lanes/${encodeURIComponent(laneKey)}`
        )
      );
  }

  /**
   * ADR-0038 D1/D2 — a HUMAN enables one item for one lane.
   *
   * Sends the item's NAME and nothing else about it: the backend re-reads the
   * vendor's own configuration and computes the shape and the fingerprint
   * itself, so a caller cannot approve a server whose config says something
   * different. The returned diff is computed from attested state on both
   * sides, never from this request.
   */
  async enableLaneImport(
    laneKey: string,
    request: EnableRequest & { principal?: string }
  ): Promise<EnableResult> {
    return enableResultSchema.parse(
      await this.request(
        `/api/compatibility/mcp/lanes/${encodeURIComponent(laneKey)}/enable`,
        { method: "POST", body: JSON.stringify(request) }
      )
    );
  }

  /** A human takes it back. One row, one lane. */
  async disableLaneImport(
    laneKey: string,
    request: EnableRequest
  ): Promise<{ diff: CapabilityDiff }> {
    return z
      .object({ diff: capabilityDiffSchema })
      .parse(
        await this.request(
          `/api/compatibility/mcp/lanes/${encodeURIComponent(laneKey)}/disable`,
          { method: "POST", body: JSON.stringify(request) }
        )
      );
  }

  /**
   * ADR-0038 D3 — re-attest a lane's imported servers, disabling what drifted.
   *
   * Called by the RUNNER before a governed run, which is why it is the one
   * compatibility route that does not demand operator authority (the runner's
   * own token is agent-tier). It only ever narrows: it disables on drift and
   * can never enable. A dispatched sub-agent's per-job bearer is still refused
   * by the deny-first job-route matrix.
   */
  async attestLaneImports(
    laneKey: string,
    proof?: { jobId: string; host: string; leaseToken: string }
  ): Promise<LaneAttestation> {
    return laneAttestationSchema.parse(
      await this.request(
        `/api/compatibility/mcp/lanes/${encodeURIComponent(laneKey)}/attest`,
        {
          method: "POST",
          // PROVES which job this run is launching, not merely which one it
          // names. Without operator authority the route wants both halves —
          // the runner LEASE (which process) and the job's own lease stamp
          // (which work) — so the shared agent bearer cannot enumerate, or
          // drift-disable, the imports of a lane it is not executing.
          body: JSON.stringify(proof ?? {}),
        }
      )
    );
  }

  /** Operator-only, local status. Never contains an access/refresh token. */
  async getGitHubStatus(): Promise<GitHubConnectionStatus> {
    return githubConnectionStatusSchema.parse(
      await this.request("/api/github/status")
    );
  }

  /** Start a bounded GitHub App device flow. The device code stays server-side. */
  async startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart> {
    return githubDeviceFlowStartSchema.parse(
      await this.request("/api/github/device/start", { method: "POST" })
    );
  }

  /**
   * Poll a server-kept device code. The returned credential is operator-only
   * and consumed by trusted desktop main for 0600 persistence; it must never be
   * projected onto renderer IPC or an agent environment.
   */
  async pollGitHubDeviceFlow(flowId: string): Promise<GitHubDeviceFlowPoll> {
    return githubDeviceFlowPollSchema.parse(
      await this.request("/api/github/device/poll", {
        method: "POST",
        body: JSON.stringify({ flowId }),
      })
    );
  }

  /** Re-seed a trusted backend after restart from desktop's private settings. */
  async setGitHubCredential(
    credential: GitHubCredential
  ): Promise<GitHubConnectionStatus> {
    return githubConnectionStatusSchema.parse(
      await this.request("/api/github/credential", {
        method: "PUT",
        body: JSON.stringify(credential),
      })
    );
  }

  /** Operator-only disconnect; clears server custody before desktop persistence. */
  async disconnectGitHub(): Promise<GitHubConnectionStatus> {
    return githubConnectionStatusSchema.parse(
      await this.request("/api/github/credential", { method: "DELETE" })
    );
  }

  /**
   * Find the open PR for a trusted workspace branch and read its status/check
   * runs. A rotated credential may ride back to trusted desktop main only.
   */
  async getGitHubReview(input: {
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
  }): Promise<GitHubReviewEnvelope> {
    const params = new URLSearchParams({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
    });
    if (input.headOwner) {
      params.set("headOwner", input.headOwner);
    }
    return githubReviewEnvelopeSchema.parse(
      await this.request(`/api/github/review?${params.toString()}`)
    );
  }

  /** Authorize the exact landed job before desktop publishes its Git ref. */
  async authorizeGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
  }): Promise<{
    mergeCommit: string;
    credential?: GitHubCredential;
  }> {
    const authorization = githubPublishAuthorizationSchema.parse(
      await this.request("/api/github/pull-request/authorize", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
    return {
      mergeCommit: authorization.mergeCommit,
      ...(authorization.credential
        ? { credential: authorization.credential }
        : {}),
    };
  }

  /** Create a PR only after the backend re-verifies this exact job's ship gate. */
  async createGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
    title: string;
    body?: string;
  }): Promise<GitHubPullRequestActionEnvelope> {
    return githubPullRequestActionEnvelopeSchema.parse(
      await this.request("/api/github/pull-request", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }

  /** Exact-head PR merge; the backend re-reads checks and the durable ship gate. */
  async mergeGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
    pullNumber: number;
    expectedHeadSha: string;
    method?: "merge" | "squash" | "rebase";
  }): Promise<GitHubPullRequestActionEnvelope> {
    return githubPullRequestActionEnvelopeSchema.parse(
      await this.request("/api/github/pull-request/merge", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }

  async listLanes(): Promise<Lane[]> {
    const payload = lanesResponseSchema.parse(await this.request("/api/lanes"));
    return payload.lanes;
  }

  async listTasks(): Promise<Task[]> {
    const payload = tasksResponseSchema.parse(await this.request("/api/tasks"));
    return payload.tasks.map((task) => ({
      ...task,
      status: task.status as TaskStatus,
      priority: task.priority as TaskPriority,
    }));
  }

  async createTask(input: {
    title: string;
    description: string;
    priority: TaskPriority;
    workspacePath?: string;
  }): Promise<Task> {
    const payload = z
      .object({
        task: taskSchema,
      })
      .parse(
        await this.request("/api/tasks", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );

    return {
      ...payload.task,
      status: payload.task.status as TaskStatus,
      priority: payload.task.priority as TaskPriority,
    };
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
    const payload = z
      .object({
        task: taskSchema,
      })
      .parse(
        await this.request(`/api/tasks/${taskId}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        })
      );

    return {
      ...payload.task,
      status: payload.task.status as TaskStatus,
      priority: payload.task.priority as TaskPriority,
    };
  }

  async assignTask(input: { taskId: string; laneId: string; summary: string }) {
    return this.request(`/api/tasks/${input.taskId}/assignments`, {
      method: "POST",
      body: JSON.stringify({
        laneId: input.laneId,
        summary: input.summary,
      }),
    });
  }

  async createHandoff(input: {
    taskId: string;
    fromLaneId: string;
    toLaneId: string;
    packetTitle: string;
    packetBody: string;
    /** Typed v2 packet (P0.3); optional so legacy callers compile unchanged. */
    packet?: HandoffPacket;
  }) {
    return this.request(`/api/tasks/${input.taskId}/handoffs`, {
      method: "POST",
      body: JSON.stringify({
        fromLaneId: input.fromLaneId,
        toLaneId: input.toLaneId,
        packetTitle: input.packetTitle,
        packetBody: input.packetBody,
        ...(input.packet !== undefined ? { packet: input.packet } : {}),
      }),
    });
  }

  async getMetrics(): Promise<CoordinationMetrics> {
    const payload = metricsResponseSchema.parse(
      await this.request("/api/metrics")
    );
    return payload.metrics;
  }

  async getTaskDetail(taskId: string): Promise<TaskDetail> {
    const payload = z
      .object({
        task: taskDetailSchema,
      })
      .parse(await this.request(`/api/tasks/${taskId}`));

    return payload.task;
  }

  /**
   * A SIBLING task's worktree diff, served by the brain for the review lane.
   * Same-mission fenced server-side; the diff is data (code under review),
   * never authority. `no-worktree` is an answer, not an error.
   */
  async taskWorktreeDiff(taskId: string): Promise<TaskWorktreeDiff> {
    return taskWorktreeDiffSchema.parse(
      await this.request(`/api/tasks/${encodeURIComponent(taskId)}/worktree-diff`)
    );
  }

  async recordEvent(input: {
    laneId: string;
    taskId: string;
    kind: LaneEventKind;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }): Promise<RecordedEvent> {
    const payload = z
      .object({
        event: eventSchema,
      })
      .parse(
        await this.request("/api/events", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );

    return {
      ...payload.event,
      kind: payload.event.kind as LaneEventKind,
    };
  }

  async listTaskEvents(taskId: string): Promise<RecordedEvent[]> {
    const payload = eventsResponseSchema.parse(
      await this.request(`/api/tasks/${taskId}/events`)
    );

    return payload.events.map((event) => ({
      ...event,
      kind: event.kind as LaneEventKind,
    }));
  }

  /**
   * @param kind Narrow to ONE event kind. The degradation signal
   * (`memory.graph_mirror_failed`) previously had exactly one consumer — this
   * method at `limit = 50` — so it had to WIN A RACE against ordinary event
   * volume to be seen at all, and the per-gate-read telemetry made losing that
   * race the normal case. Asking for it by name removes the race entirely.
   * It only ever NARROWS, so an omitted `kind` is byte-for-byte today's call.
   */
  async listRecentEvents(
    limit = 50,
    kind?: string
  ): Promise<RecordedEvent[]> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const query = new URLSearchParams({ limit: String(boundedLimit) });
    if (kind) {
      query.set("kind", kind);
    }
    const payload = eventsResponseSchema.parse(
      await this.request(`/api/events?${query.toString()}`)
    );
    return payload.events.map((event) => ({
      ...event,
      kind: event.kind as LaneEventKind,
    }));
  }

  /**
   * F5 — export the principal-stamped audit trail as JSONL (operator-only
   * route). Returned as raw text: the export's value is byte-stable lines
   * a human can grep/diff/archive, so the client does not re-parse them.
   */
  async exportAuditTrail(filters?: {
    taskId?: string;
    kind?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<string> {
    const query = new URLSearchParams();
    if (filters?.taskId) query.set("taskId", filters.taskId);
    if (filters?.kind) query.set("kind", filters.kind);
    if (filters?.since) query.set("since", filters.since);
    if (filters?.until) query.set("until", filters.until);
    if (filters?.limit) query.set("limit", String(filters.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await this.fetcher(
      `${this.baseUrl}/api/events/audit/export${suffix}`,
      {
        headers: this.apiToken
          ? { Authorization: `Bearer ${this.apiToken}` }
          : {},
      }
    );
    if (!response.ok) {
      throw new Error(`audit export failed: HTTP ${response.status}`);
    }
    return await response.text();
  }

  /**
   * ADR-0040 D3a — assert that a HUMAN is present at this surface.
   *
   * Call this only on real evidence of a person: a focused-and-visible desktop
   * window, an actual TUI keystroke, a typed CLI command. Do NOT call it from a
   * poll — inferring presence from polling is the exact defect that kept the
   * unattended horizon disabled, because a background process polls happily
   * with nobody at the machine.
   *
   * Best-effort by design: a daemon too old to have the route must not break a
   * surface, and failing to assert presence fails CLOSED (toward the daemon
   * being reaped), which is the safe direction.
   */
  async noteHumanPresent(surface: "desktop" | "tui" | "cli"): Promise<void> {
    await this.request("/api/attendance", {
      method: "POST",
      body: JSON.stringify({ surface }),
    }).catch(() => undefined);
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    const payload = approvalsResponseSchema.parse(
      await this.request("/api/approvals")
    );

    return payload.approvals.map((approval) => ({
      ...approval,
      kind: approval.kind as ApprovalKind,
      status: approval.status as ApprovalStatus,
    }));
  }

  async requestApproval(input: {
    taskId: string;
    requestedBy: string;
    kind: ApprovalKind;
    reason: string;
    // ADR-0010 Part B: for a `gate` approval, the exact action+payload tag the
    // route later redeems it against (kept alongside the human-readable reason).
    // Optional, non-gate approvals and every existing caller omit it.
    gateTag?: string;
    evidence?: import("@muon/protocol").ApprovalEvidence;
    // Checkpoint edge (P0.1): the DispatchJob whose execution files this
    // approval (session gates). Optional; existing callers omit it.
    jobId?: string;
  }): Promise<ApprovalRequest> {
    const payload = z
      .object({
        approval: approvalSchema,
      })
      .parse(
        await this.request("/api/approvals", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );

    return {
      ...payload.approval,
      kind: payload.approval.kind as ApprovalKind,
      status: payload.approval.status as ApprovalStatus,
    };
  }

  /**
   * Single-use delivery stamp for a session `command` approval
   * (consume-before-allow, P0.1 Slice A). Throws on any non-2xx — including
   * the 409 for an already-consumed / undecided / wrong-kind approval — so the
   * session manager fails closed to deny.
   */
  async consumeCommandApproval(approvalId: string): Promise<void> {
    await this.request(`/api/approvals/${approvalId}/consume`, {
      method: "POST",
    });
  }

  /**
   * Is a standing operator approver (Full Auto) watching the approval inbox
   * right now? READ is agent-tier reachable on purpose — MUON's own runner is
   * the reader, resolving it per gated coordinator call — while both writes
   * below stay operator-only. The answer always carries its own expiry, so a
   * caller that caches it cannot accidentally extend it.
   */
  async getStandingApprover(): Promise<StandingApproverGrant> {
    return standingApproverLeaseSchema.parse(
      await this.request("/api/approvals/standing-approver/lease")
    ).standingApprover;
  }

  /** Renew the operator's standing watch for one more server-fixed TTL. */
  async renewStandingApproverLease(): Promise<StandingApproverGrant> {
    return standingApproverLeaseSchema.parse(
      await this.request("/api/approvals/standing-approver/lease", {
        method: "PUT",
      })
    ).standingApprover;
  }

  /** Give up the watch NOW instead of letting it run out its TTL. Idempotent. */
  async releaseStandingApproverLease(): Promise<StandingApproverGrant> {
    return standingApproverLeaseSchema.parse(
      await this.request("/api/approvals/standing-approver/lease", {
        method: "DELETE",
      })
    ).standingApprover;
  }

  async getApprovalReviewCertification(
    approvalId: string
  ): Promise<ReviewCoverageCertification> {
    const payload = z
      .object({ certification: reviewCoverageCertificationSchema })
      .parse(
        await this.request(`/api/approvals/${approvalId}/review`)
      );
    return payload.certification;
  }

  async resolveApproval(input: {
    approvalId: string;
    status: Exclude<ApprovalStatus, "pending">;
    decisionNotes?: string;
    // P0.4: EXPLICIT operator opt-in to mint a content-bound, expiring receipt
    // alongside an approval. Never sent unless the human asked for it.
    receipt?: { ttlMs: number };
    /** Explicit operator attestation for the exact current REVIEW BLIND set. */
    manualReview?: ManualReviewAttestation;
  }): Promise<
    // BUG 1: the decision ALWAYS lands. When a receipt was requested but the
    // action can't be remembered, the server soft-skips the mint and flags it
    // here — an intersection so every existing caller (which only reads the
    // ApprovalRequest fields) keeps working unchanged.
    ApprovalRequest & {
      /** True when a requested receipt was NOT minted (the action can't be
       *  remembered); the approve/reject decision still succeeded. */
      receiptSkipped?: boolean;
      /** Honest reason the receipt was skipped (surface it softly, never as an
       *  error). Absent when a receipt was minted or none was requested. */
      receiptSkippedReason?: string;
      /**
       * What approving a `merge` gate ACTUALLY did to the primary checkout.
       *
       * `PATCH /api/approvals/:id` has always returned this next to `approval`
       * (backend/src/routes/approvals.ts), and this client used to parse only
       * `approval` — so every surface reported "approved" and could never say
       * "landed as <sha>". Absent for every non-merge approval, and absent on
       * any backend older than the field, which is why it is optional: reading
       * it must never turn a working decision into a parse error.
       */
      merge?: ApprovalMergeResult;
    }
  > {
    const payload = z
      .object({
        approval: approvalSchema,
        // Tolerated optional soft-skip signal (absent on mint / no-receipt).
        receiptSkipped: z.boolean().optional(),
        receiptSkippedReason: z.string().optional(),
        merge: approvalMergeResultSchema.optional(),
      })
      .parse(
        await this.request(`/api/approvals/${input.approvalId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: input.status,
            decisionNotes: input.decisionNotes,
            receipt: input.receipt,
            manualReview:
              input.manualReview === undefined
                ? undefined
                : manualReviewAttestationSchema.parse(input.manualReview),
          }),
        })
      );

    return {
      ...payload.approval,
      kind: payload.approval.kind as ApprovalKind,
      status: payload.approval.status as ApprovalStatus,
      ...(payload.receiptSkipped
        ? {
            receiptSkipped: true,
            receiptSkippedReason: payload.receiptSkippedReason,
          }
        : {}),
      ...(payload.merge ? { merge: payload.merge } : {}),
    };
  }

  // ── P0.4: workspace policy profiles + receipts ─────────────────────────────

  /**
   * The stored policy profile governing a workspace (task row beats workspace
   * row). `profile` is returned UNVALIDATED on purpose: the runner safeParses
   * it and treats anything invalid as "no profile" (today's behavior), so a
   * malformed row can never lock out or auto-allow.
   */
  async getWorkspacePolicy(input: {
    workspacePath: string;
    taskId?: string;
  }): Promise<{
    profile: unknown;
    scope: "task" | "workspace" | null;
    version: number;
  }> {
    const params = new URLSearchParams({ workspacePath: input.workspacePath });
    if (input.taskId) params.set("taskId", input.taskId);
    return z
      .object({
        profile: z.unknown(),
        scope: z.enum(["task", "workspace"]).nullable(),
        version: z.number(),
      })
      .parse(await this.request(`/api/policy/profile?${params.toString()}`)) as {
      profile: unknown;
      scope: "task" | "workspace" | null;
      version: number;
    };
  }

  /**
   * Store (upsert) a workspace or task-scoped policy profile. Operator-only
   * server-side; the strict guardedPostureSchema rejects allow-on-network/merge/
   * ship, so an over-permissive posture can never reach storage.
   */
  async putWorkspacePolicy(input: {
    workspacePath: string;
    profile: unknown;
    taskId?: string;
  }): Promise<{
    profile: unknown;
    scope: "task" | "workspace";
    version: number;
  }> {
    return z
      .object({
        profile: z.unknown(),
        scope: z.enum(["task", "workspace"]),
        version: z.number(),
      })
      .parse(
        await this.request("/api/policy/profile", {
          method: "PUT",
          body: JSON.stringify(input),
        })
      ) as { profile: unknown; scope: "task" | "workspace"; version: number };
  }

  /**
   * Remove a stored policy profile → the workspace degrades to today's
   * ask-everything (never a lockout, never an auto-allow). Operator-only.
   */
  async deleteWorkspacePolicy(input: {
    workspacePath: string;
    taskId?: string;
  }): Promise<{ deleted: number }> {
    return z
      .object({ deleted: z.number() })
      .parse(
        await this.request("/api/policy/profile", {
          method: "DELETE",
          body: JSON.stringify(input),
        })
      );
  }

  /**
   * Burn-only receipt redemption (agent tier). A miss is `redeemed: false`,
   * never an error status — the caller's contract is "miss ⇒ file the gate
   * exactly as today". Non-2xx still throws; the runner wraps it to a miss.
   */
  async redeemReceipt(input: {
    taskId: string;
    jobId: string;
    sessionId: string;
    workspacePath: string;
    toolName: string;
    payloadDigest: string;
    // SEC-1: the operator-VISIBLE resolved target of this real tool call (edit/read
    // path or test command line, redacted identically to the evidence the operator
    // saw). Declared EXPLICITLY — not merely carried on the wire by JSON.stringify
    // passthrough — so a future body-reconstruction refactor can never silently drop
    // it; the server matches it against the receipt's minted target, so a receipt
    // whose visible target and payload digest disagree can never redeem the hidden
    // action. `null`/omitted for a target-less call.
    resolvedTarget?: string | null;
  }): Promise<{
    redeemed: boolean;
    receipt?: { id: string; expiresAt: string; useCount: number };
  }> {
    return z
      .object({
        redeemed: z.boolean(),
        receipt: z
          .object({
            id: z.string(),
            expiresAt: z.string(),
            useCount: z.number(),
          })
          .optional(),
      })
      .parse(
        await this.request("/api/receipts/redeem", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
  }

  async listReceipts(filter?: {
    activeOnly?: boolean;
    workspacePath?: string;
  }): Promise<ApprovalReceipt[]> {
    const params = new URLSearchParams();
    if (filter?.activeOnly) params.set("activeOnly", "true");
    if (filter?.workspacePath) params.set("workspacePath", filter.workspacePath);
    const query = params.toString();
    const payload = z
      .object({ receipts: z.array(receiptSchema) })
      .parse(await this.request(`/api/receipts${query ? `?${query}` : ""}`));
    return payload.receipts as ApprovalReceipt[];
  }

  /** One-way operator revocation of a live receipt. */
  async revokeReceipt(receiptId: string): Promise<ApprovalReceipt> {
    const payload = z
      .object({ receipt: receiptSchema })
      .parse(
        await this.request(`/api/receipts/${receiptId}/revoke`, {
          method: "POST",
        })
      );
    return payload.receipt as ApprovalReceipt;
  }

  async dashboard() {
    return dashboardResponseSchema.parse(await this.request("/api/tasks/dashboard"));
  }

  private static toMemoryNote(raw: z.infer<typeof memoryNoteSchema>): MemoryNote {
    return {
      ...raw,
      kind: raw.kind as MemoryKind,
      trust: raw.trust as MemoryTrust,
      status: raw.status as MemoryNote["status"],
    };
  }

  async addMemoryNote(input: {
    kind: MemoryKind;
    text: string;
    taskId?: string;
    laneId?: string;
    /** #126 per-chat partition key (from MUON_CHAT_ID). Absent → a NULL-chat note. */
    chatId?: string;
    modules?: string[];
    topics?: string[];
    /** Symbol anchors (ADR-0012): `<module>#<name>` ids. */
    symbols?: string[];
    /** D1: coordinates the caller declares do not exist yet (see below). */
    plannedCoordinates?: string[];
    trust?: MemoryTrust;
    createdBy: string;
    outcome?: AttemptOutcome;
  }): Promise<MemoryNote> {
    return (await this.addMemoryNoteWithAction(input)).note;
  }

  /**
   * Like addMemoryNote, but also returns how the dedup-aware brain resolved
   * the write (inserted / duplicate / extended / superseded / conflict) so an agent can
   * learn its note was already known or flagged for human review (v3).
   */
  async addMemoryNoteWithAction(input: {
    kind: MemoryKind;
    text: string;
    taskId?: string;
    laneId?: string;
    /** #126 per-chat partition key (from MUON_CHAT_ID). Absent → a NULL-chat note. */
    chatId?: string;
    modules?: string[];
    topics?: string[];
    /** Symbol anchors (ADR-0012): `<module>#<name>` ids. */
    symbols?: string[];
    /**
     * D1 (§D1, option B): coordinates this write declares do not exist YET, so the
     * ledger marks their anchors `planned` instead of asserting `unresolved`.
     * A module path (`src/new.ts`) or a symbol id in it (`src/new.ts#build`) — both
     * reduce to the same file. Explicit and per-coordinate so a typo can never
     * silently become "planned"; a declared coordinate that IS tracked lands
     * `resolved`, because reality outranks the declaration.
     */
    plannedCoordinates?: string[];
    trust?: MemoryTrust;
    createdBy: string;
    outcome?: AttemptOutcome;
  }): Promise<{
    note: MemoryNote;
    // "related" (KG-3 F1): a dense-only match kept both notes for human review.
    // "proposed" (KG-6): a governed, contested destructive write, both notes
    // stay active with a PROPOSES_SUPERSEDE edge, pending human/peer confirmation.
    action:
      | "inserted"
      | "duplicate"
      | "extended"
      | "superseded"
      | "conflict"
      | "related"
      | "proposed";
    relatedNoteId: string | null;
  }> {
    const payload = z
      .object({
        note: memoryNoteSchema,
        action: z
          .enum([
            "inserted",
            "duplicate",
            "extended",
            "superseded",
            "conflict",
            "related",
            "proposed",
          ])
          .default("inserted"),
        relatedNoteId: z.string().nullable().default(null),
      })
      .parse(
        await this.request("/api/memory", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return {
      note: MuonApiClient.toMemoryNote(payload.note),
      action: payload.action,
      relatedNoteId: payload.relatedNoteId,
    };
  }

  async searchMemory(
    query: string,
    options?: {
      asOf?: string;
      scope?: string;
      chatId?: string;
      /** ADR-0026 §5 workspace fence. Send the path the caller is working IN (the
       *  raw invoking directory is fine and preferred — the SERVER canonicalizes,
       *  case-corrects and reduces a worktree to its repo root, so there is exactly
       *  ONE evaluator of that reduction and a surface can never disagree with the
       *  writer). Refused for an agent-tier bearer when it disagrees with the
       *  capability. Absent → today's unscoped view. */
      workspace?: string;
      /** ADR-0026 §8 residue view: ONLY notes with no workspace, each labelled by
       *  its null `workspacePath`. Operator-tier only; mutually exclusive with
       *  `workspace` (the server 400s the combination). */
      unscoped?: boolean;
      /** R3 `show_expired`. Honoured for the OPERATOR tier only; an agent-tier
       *  bearer is silently downgraded server-side to the hygienic default. */
      showExpired?: boolean;
      /** R5 bounded filter grammar; re-validated server-side. */
      filter?: MemoryFilter;
    }
  ): Promise<MemoryNote[]> {
    const params = new URLSearchParams({ q: query });
    // Bitemporal "what did the brain believe about X at T" + scope (KG-5).
    if (options?.asOf) params.set("asOf", options.asOf);
    if (options?.scope) params.set("scope", options.scope);
    // #126: a chat-scoped agent search; absent → the global view.
    if (options?.chatId) params.set("chatId", options.chatId);
    // ADR-0026: two params for two powers, never one reserved token.
    if (options?.workspace) params.set("workspace", options.workspace);
    if (options?.unscoped) params.set("unscoped", "true");
    if (options?.showExpired) params.set("showExpired", "true");
    if (options?.filter) params.set("filter", JSON.stringify(options.filter));
    const payload = memoryNotesResponseSchema.parse(
      await this.request(`/api/memory/search?${params.toString()}`)
    );
    return MuonApiClient.recalledNotes(payload);
  }

  /**
   * Operator-only memory LIBRARY browse (GET /api/memory/library): the full
   * governed snapshot (notes + edges + confirmations + import provenance) with
   * status/confirmed/kind/trust/q filters. Reuses the tested browser-pure
   * loader so the CLI, TUI, and desktop all share one fetch + one schema.
   */
  async listMemoryLibrary(
    query?: MemoryLibraryQuery
  ): Promise<MemoryLibrarySnapshot> {
    return loadMemoryLibrary({
      apiBase: this.baseUrl,
      apiToken: this.apiToken,
      fetcher: this.fetcher,
      query,
    });
  }

  /** B4 coordinate-only memory graph analytics. Agent callers pass their trusted
   * chat scope; operator callers omit it for the whole local brain. */
  async memoryAnalytics(options?: {
    chatId?: string;
    /** ADR-0026 workspace fence; the server validates and reduces it. */
    workspace?: string;
    unscoped?: boolean;
    limit?: number;
  }): Promise<MemoryAnalyticsSnapshot> {
    return loadMemoryAnalytics({
      apiBase: this.baseUrl,
      apiToken: this.apiToken,
      fetcher: this.fetcher,
      chatId: options?.chatId,
      workspace: options?.workspace,
      unscoped: options?.unscoped,
      limit: options?.limit,
    });
  }

  /** B6 operator-only confirmed-note promotion. The response is deliberately
   * coordinate-only; note text remains on the existing governed read surfaces. */
  async promoteMemoryToGlobal(noteId: string): Promise<{
    noteId: string;
    scope: "global";
    promoted: boolean;
    alreadyGlobal: boolean;
  }> {
    return z
      .object({
        noteId: z.string(),
        scope: z.literal("global"),
        promoted: z.boolean(),
        alreadyGlobal: z.boolean(),
      })
      .parse(
        await this.request(
          `/api/memory/${encodeURIComponent(noteId)}/promote-global`,
          { method: "POST" }
        )
      );
  }

  /**
   * Signal that notes were actually USED (cited/applied), not merely retrieved
   *, the explicit reinforcement signal (ADR-0009 §2.4 / KG-2). Buffered and
   * flushed off the read path server-side; searching never reinforces on its own.
   */
  async markMemoryUsed(
    noteIds: string[],
    accessType: MemoryAccessType = "legacy_used"
  ): Promise<void> {
    if (noteIds.length === 0) {
      return;
    }
    await this.request("/api/memory/used", {
      method: "POST",
      body: JSON.stringify({ noteIds, accessType }),
    });
  }

  /**
   * D2 option B (docs/design/memory-index-decisions.md): best-effort persist a
   * GitNexus uid a caller already resolved for a local symbol id, stamped to
   * the exact commit GitNexus indexed. Never authoritative and never awaited
   * by a caller that must stay read-only — a dropped write only costs the
   * NEXT reader a re-resolve, so callers should `.catch(() => undefined)`
   * this the same way `markMemoryUsed`'s reinforcement signal is fired.
   */
  async cacheSymbolUid(
    graphCommit: string,
    entries: { localId: string; gitnexusUid: string }[]
  ): Promise<{ cached: number }> {
    if (entries.length === 0) {
      return { cached: 0 };
    }
    return z
      .object({ cached: z.number() })
      .parse(
        await this.request("/api/memory/symbol-uid-cache", {
          method: "POST",
          body: JSON.stringify({ graphCommit, entries }),
        })
      );
  }

  /** TODO 4.14: exact-job, workspace-derived, confirmed-only file projection. */
  async getMemoryDirectorySnapshot(): Promise<MemoryDirectorySnapshot> {
    return memoryDirectorySnapshotSchema.parse(
      await this.request("/api/memory/directory-snapshot")
    );
  }

  /** TODO 4.12: operator-only, text-free access-type outcome cohorts. */
  async memoryAccessAnalytics(options?: {
    workspace?: string;
    unscoped?: boolean;
    limit?: number;
  }): Promise<MemoryAccessAnalytics> {
    const params = new URLSearchParams();
    if (options?.workspace) params.set("workspace", options.workspace);
    if (options?.unscoped) params.set("unscoped", "true");
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return memoryAccessAnalyticsSchema.parse(
      await this.request(`/api/memory/analytics/access-types${suffix}`)
    );
  }

  async recallMemory(filter: {
    taskId?: string;
    laneId?: string;
    module?: string;
    /**
     * D4 — the `<module>#<name>` SYMBOL anchor (ADR-0012), the finest coordinate
     * MUON records. The graph predicate and `MemoryRecallFilter.symbol` have both
     * worked since the symbol tier landed and no surface sent it, so the anchor was
     * writable and unreadable. It rides the identical path as `module` and inherits
     * the workspace fence, the chat partition, `asOf`, TTL and the KG-6 gate with
     * nothing restated — a read COORDINATE, never an authority.
     */
    symbol?: string;
    topic?: string;
    /** Bitemporal as-of instant (ISO-8601): the active set the brain believed at
     *  that time (KG-5). Default (absent) = now / current active set. */
    asOf?: string;
    /** Scope filter (KG-5 / D5): soft, restricts to that scope when set. */
    scope?: string;
    /** #126 + B6: this chat plus confirmed promoted-global memory. */
    chatId?: string;
    /** ADR-0026 §5 workspace fence; the server canonicalizes and reduces it. This
     *  is the recall that `module`/`symbol` anchors ride, so it is the exact read
     *  the ADR exists for — anchors are workspace-RELATIVE paths. */
    workspace?: string;
    /** ADR-0026 §8 residue view (operator-only). */
    unscoped?: boolean;
    /** R3 `show_expired`; operator-tier only, silently ignored for agents. */
    showExpired?: boolean;
    /** R5 bounded filter grammar; re-validated server-side. */
    filter?: MemoryFilter;
  }): Promise<MemoryNote[]> {
    const params = new URLSearchParams();
    if (filter.taskId) params.set("taskId", filter.taskId);
    if (filter.laneId) params.set("laneId", filter.laneId);
    if (filter.module) params.set("module", filter.module);
    if (filter.symbol) params.set("symbol", filter.symbol);
    if (filter.topic) params.set("topic", filter.topic);
    if (filter.asOf) params.set("asOf", filter.asOf);
    if (filter.scope) params.set("scope", filter.scope);
    if (filter.chatId) params.set("chatId", filter.chatId);
    if (filter.workspace) params.set("workspace", filter.workspace);
    if (filter.unscoped) params.set("unscoped", "true");
    if (filter.showExpired) params.set("showExpired", "true");
    if (filter.filter) params.set("filter", JSON.stringify(filter.filter));
    const payload = memoryNotesResponseSchema.parse(
      await this.request(`/api/memory/recall?${params.toString()}`)
    );
    return MuonApiClient.recalledNotes(payload);
  }

  /** ADR-0027 D13: resolve a peer-supplied stable note coordinate through the
   * agent-safe recall route. Hidden/missing ids return no note; the operator-only
   * raw note endpoint remains closed to agent tokens. */
  async recallMemoryById(noteId: string): Promise<MemoryNote[]> {
    const params = new URLSearchParams({ noteId });
    const payload = memoryNotesResponseSchema.parse(
      await this.request(`/api/memory/recall?${params.toString()}`)
    );
    return MuonApiClient.recalledNotes(payload);
  }

  /**
   * TODO 4.1 / 4.22 — the STANDING-MEMORY arm: human-confirmed `constraint` +
   * `convention` canon and explicitly pinned, confirmed global decisions for
   * the caller's workspace, no anchor, no query, no
   * chat partition. The posture is fixed SERVER-SIDE (the graph method and the
   * route's strict ledger re-gate); this method carries no knob that could
   * widen it. For an agent-tier bearer the workspace is derived from the job
   * capability, so `workspace` is only for operator callers inspecting a
   * specific repository.
   */
  async recallStandingMemory(options?: {
    workspace?: string;
  }): Promise<MemoryNote[]> {
    const params = new URLSearchParams({ standing: "true" });
    if (options?.workspace) params.set("workspace", options.workspace);
    const payload = memoryNotesResponseSchema.parse(
      await this.request(`/api/memory/recall?${params.toString()}`)
    );
    return MuonApiClient.recalledNotes(payload);
  }

  /**
   * B3: recall is the one memory read a degraded graph cannot partially serve —
   * the mirror IS the retrieval index here, so the honest degraded body is an
   * EMPTY note list. Returning that array to a caller would assert "the brain
   * remembers nothing about this", which is a different and false fact from
   * "the brain could not be consulted". So the empty-plus-`degraded` body is
   * re-raised as a NAMED failure rather than passed on as a lie.
   *
   * The improvement over the unmapped 500 this replaces is the naming: the
   * route no longer takes the whole Memory tab down with it (`/library`,
   * `/explain`, `/neighbors` all degrade and keep rendering), and what a caller
   * sees here says which subsystem failed and why.
   */
  private static recalledNotes(payload: {
    notes: z.infer<typeof memoryNoteSchema>[];
    degraded?: MemoryGraphDegraded;
  }): MemoryNote[] {
    if (payload.degraded) {
      throw new Error(
        `Memory recall could not consult the ${payload.degraded.subsystem}: ${payload.degraded.reason}. No memory was returned; this is NOT "nothing is remembered".`
      );
    }
    return payload.notes.map(MuonApiClient.toMemoryNote);
  }

  /** Graph-traversal recall: task -> modules -> notes + lane notes. A chatId
   *  admits that chat plus confirmed promoted-global memory. */
  async recallRelatedToTask(
    taskId: string,
    chatId?: string,
    filter?: MemoryFilter,
    /** ADR-0026: the workspace this traversal belongs to. Positional-last so every
     *  existing caller is unchanged. For the AGENT tier (the runner's brief-seeding
     *  call) the server derives it from the capability and this argument is
     *  redundant, which is deliberate: a workspace an agent SENDS is a claim, and
     *  §4 forbids the partition ever coming from one. */
    workspace?: string
  ): Promise<MemoryNote[]> {
    const params = new URLSearchParams({ relatedToTask: taskId });
    if (chatId) params.set("chatId", chatId);
    if (filter) params.set("filter", JSON.stringify(filter));
    if (workspace) params.set("workspace", workspace);
    const payload = memoryNotesResponseSchema.parse(
      await this.request(`/api/memory/recall?${params.toString()}`)
    );
    return MuonApiClient.recalledNotes(payload);
  }

  /** B1 bounded graph traversal. The response schema is an agent-safe allowlist:
   * unknown fields are stripped and only the backend-gated `text` field can
   * carry prose. */
  async memoryNeighbors(
    nodeId: string,
    options?: {
      hops?: number;
      relations?: MemoryGraphRelation[];
      limit?: number;
      chatId?: string;
      /** ADR-0026: the workspace this walk belongs to; the server validates and
       *  reduces it. A provenance walk is a read, so it is fenced like one. */
      workspace?: string;
      /** ADR-0026 §8 residue view (operator-only). */
      unscoped?: boolean;
    }
    // B3: `degraded` present = the graph mirror could not answer, so the
    // neighborhood is empty for a NAMED reason rather than because the note has
    // none. Additive and optional: a caller that ignores it compiles unchanged.
  ): Promise<MemoryNeighborsResult & { degraded?: MemoryGraphDegraded }> {
    const params = new URLSearchParams();
    if (options?.hops !== undefined) {
      params.set("hops", String(options.hops));
    }
    if (options?.relations?.length) {
      params.set("relations", options.relations.join(","));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.chatId) {
      params.set("chatId", options.chatId);
    }
    if (options?.workspace) {
      params.set("workspace", options.workspace);
    }
    if (options?.unscoped) {
      params.set("unscoped", "true");
    }
    const query = params.toString();
    return memoryNeighborsResponseSchema.parse(
      await this.request(
        `/api/memory/neighbors/${encodeURIComponent(nodeId)}${
          query ? `?${query}` : ""
        }`
      )
    ) as MemoryNeighborsResult & { degraded?: MemoryGraphDegraded };
  }

  /** B2 shortest governed provenance path + contradiction coordinates.
   *  B3: `degraded` present = the mirror was unavailable, so `goal: "missing"`
   *  here means "could not be asked", not "no provenance exists". */
  async memoryExplain(
    noteId: string,
    options?: {
      limit?: number;
      chatId?: string;
      /** ADR-0026 workspace fence; see `memoryNeighbors`. */
      workspace?: string;
      unscoped?: boolean;
    }
  ): Promise<MemoryExplainResult & { degraded?: MemoryGraphDegraded }> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options?.chatId) {
      params.set("chatId", options.chatId);
    }
    if (options?.workspace) {
      params.set("workspace", options.workspace);
    }
    if (options?.unscoped) {
      params.set("unscoped", "true");
    }
    const query = params.toString();
    return memoryExplainResponseSchema.parse(
      await this.request(
        `/api/memory/explain/${encodeURIComponent(noteId)}${
          query ? `?${query}` : ""
        }`
      )
    ) as MemoryExplainResult & { degraded?: MemoryGraphDegraded };
  }

  /** B3 governed hard delete. Agent scope is supplied only by trusted MCP state. */
  async deleteMemoryNote(
    noteId: string,
    options?: { chatId?: string }
  ): Promise<MemoryDeleteResult> {
    const params = new URLSearchParams();
    if (options?.chatId) params.set("chatId", options.chatId);
    const query = params.toString();
    return memoryDeleteResponseSchema.parse(
      await this.request(
        `/api/memory/${encodeURIComponent(noteId)}${query ? `?${query}` : ""}`,
        { method: "DELETE" }
      )
    ) as MemoryDeleteResult;
  }

  /** B3 clone-to-proposal. The wire response is coordinates only, never note text. */
  async cloneMemoryNote(
    noteId: string,
    options?: { chatId?: string }
  ): Promise<MemoryCloneResult> {
    return memoryCloneResponseSchema.parse(
      await this.request(`/api/memory/${encodeURIComponent(noteId)}/clone`, {
        method: "POST",
        body: JSON.stringify({
          ...(options?.chatId ? { chatId: options.chatId } : {}),
        }),
      })
    ) as MemoryCloneResult;
  }

  async getMemoryCompactionRetentionDays(): Promise<number> {
    return memoryCompactionSettingSchema.parse(
      await this.request("/api/memory/settings/memory-compaction-retention")
    ).retentionDays;
  }

  async setMemoryCompactionRetentionDays(
    retentionDays: number
  ): Promise<number> {
    return memoryCompactionSettingSchema.parse(
      await this.request("/api/memory/settings/memory-compaction-retention", {
        method: "PUT",
        body: JSON.stringify({ retentionDays }),
      })
    ).retentionDays;
  }

  /**
   * R4 memory mining. READ is agent-tier reachable on purpose — the runner
   * resolves it after every job to decide whether to mine — while the WRITE
   * below stays operator-only.
   */
  async getMemoryMining(): Promise<boolean> {
    return memoryMiningSettingSchema.parse(
      await this.request("/api/memory/settings/memory-mining")
    ).memoryMining;
  }

  async setMemoryMining(enabled: boolean): Promise<boolean> {
    return memoryMiningSettingSchema.parse(
      await this.request("/api/memory/settings/memory-mining", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      })
    ).memoryMining;
  }

  /** R3 TTL policy read. Operator-tier only: an eviction posture is a human
   *  decision, so unlike the mining flag the agent tier cannot even read it. */
  async getMemoryTtlPolicy(): Promise<MemoryTtlPolicy> {
    return memoryTtlPolicySchema.parse(
      await this.request("/api/memory/settings/memory-ttl")
    );
  }

  async setMemoryTtlPolicy(policy: MemoryTtlPolicy): Promise<MemoryTtlPolicy> {
    return memoryTtlPolicySchema.parse(
      await this.request("/api/memory/settings/memory-ttl", {
        method: "PUT",
        body: JSON.stringify(policy),
      })
    );
  }

  /** TODO 4.11: effective table plus the server's proposed first migration. */
  async getMemoryLifecyclePolicy(): Promise<MemoryLifecycleSetting> {
    return memoryLifecycleSettingSchema.parse(
      await this.request("/api/memory/settings/memory-lifecycle")
    );
  }

  async migrateMemoryLifecyclePolicy(
    policy: MemoryLifecyclePolicy,
    options:
      | { dryRun: true }
      | { dryRun: false; previewDigest: string }
  ): Promise<MemoryLifecycleMigrationResult> {
    return memoryLifecycleMigrationSchema.parse(
      await this.request("/api/memory/settings/memory-lifecycle/migrate", {
        method: "POST",
        body: JSON.stringify({ policy, ...options }),
      })
    );
  }

  /** R3 bounded expiry sweep (operator-tier). Idempotent and observationally
   *  neutral — reads derive hidden-ness from `expiresAt` whether or not this has
   *  run — so calling it only materializes the soft tombstone sooner. */
  async sweepExpiredMemory(
    options: BulkMemoryRemovalRequest = {}
  ): Promise<MemoryExpirySweepResult> {
    return memoryExpirySweepSchema.parse(
      await this.request("/api/memory/sweep-expired", {
        method: "POST",
        body: JSON.stringify(options),
      })
    );
  }

  async compactMemory(
    options: BulkMemoryRemovalRequest = {}
  ): Promise<MemoryCompactionResult> {
    return memoryCompactionResponseSchema.parse(
      await this.request("/api/memory/compact", {
        method: "POST",
        body: JSON.stringify(options),
      })
    ) as MemoryCompactionResult;
  }

  async revertExpiredMemoryBatch(
    batchId: string
  ): Promise<RevertExpiredBatchResult> {
    return revertExpiredBatchSchema.parse(
      await this.request("/api/memory/revert-expired-batch", {
        method: "POST",
        body: JSON.stringify({ batchId }),
      })
    );
  }

  /**
   * P2.5 HERO, the dual-graph pre-edit gate. Fuses the CODE blast-radius with the
   * GOVERNED (confirmed-only, KG-6) memory anchored to it and returns prior
   * decisions + contradiction warnings + pending proposals. The orchestrator, which
   * holds the hosted code-graph client (GitNexus), calls impact THERE and passes
   * the affected modules in `blastRadiusModules`; MUON's backend makes no such call.
   * Powers the human surfaces (TUI/app, P6) and the agent MCP tool.
   */
  async preEditContext(input: {
    symbol?: string;
    module?: string;
    files?: string[];
    /** Orchestrator-supplied affected modules (from its GitNexus impact call). */
    blastRadiusModules?: string[];
    blastRadiusSymbols?: string[];
    blastRadiusDepth?: number;
    /** Bitemporal as-of (KG-5): the governed set the brain believed at time T. */
    asOf?: string;
    scope?: string;
    /** #126 per-chat partition: hard-scope every memory read in the gate to this
     *  chat (agent gate reads); absent → the global gate (human Brain panel). */
    chatId?: string;
    /** ADR-0026 §9 workspace fence on the HERO read — the one surface where a
     *  cross-repo anchor collision would put another repo's decision in front of an
     *  editing agent. Send the raw path; the server validates and reduces it, and
     *  refuses an agent-tier claim that disagrees with the capability. */
    workspace?: string;
    /** ADR-0026 §8 residue view (operator-only). */
    unscoped?: boolean;
    /** Gate trust floor (KG-6): also admit trust >= floor even if not confirmed. */
    trustFloor?: MemoryTrust;
    /** KG-7 (ADR-0014) self-exclusion: the calling lane's own task/job, so it is
     *  never surfaced as a peer live on its own code. */
    excludeTaskId?: string;
    excludeJobId?: string;
  }): Promise<PreEditContext> {
    const payload = preEditContextSchema.parse(
      await this.request("/api/memory/preedit", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
    return {
      target: payload.target,
      blastRadius: payload.blastRadius,
      memories: payload.memories.map((memory) => ({
        ...MuonApiClient.toMemoryNote(memory),
        proximity: memory.proximity,
        onTarget: memory.onTarget,
        onSymbol: memory.onSymbol,
      })),
      crewFindings: payload.crewFindings.map((memory) => ({
        ...MuonApiClient.toMemoryNote(memory),
        confirmed: false,
        // Carry the wire truth: "orchestrator" is a claim someone vouched,
        // and a posture-admitted (auto-tier) finding has NO vouch to claim.
        confirmedBy:
          memory.confirmedBy === "orchestrator"
            ? ("orchestrator" as const)
            : null,
        proximity: memory.proximity,
        onTarget: memory.onTarget,
        onSymbol: memory.onSymbol,
        tier: "crew_vouched" as const,
        authority: "inform" as const,
      })),
      warnings: payload.warnings,
      pendingProposals: payload.pendingProposals,
      activity: payload.activity,
      duplicateWork: payload.duplicateWork,
      // D14: the SECOND place this field can vanish — the return is rebuilt
      // field-by-field, not spread, so declaring the schema key is not enough.
      // Carried verbatim: this hop shows every note it received, so it re-stamps
      // nothing (`notes.surfaced` is still the gate's own answer).
      ...(payload.coverage ? { coverage: payload.coverage } : {}),
    };
  }

  /**
   * P6a, the human's note-by-id read (OPERATOR-tier). Fetches a single note by
   * id INCLUDING its text. The human pre-edit ("Brain") panel calls this to pull
   * a pending PROPOSES_SUPERSEDE proposal's TEXT ON DEMAND so a human can read it
   * before confirming/rejecting, the text the hero gate deliberately withholds
   * from the agent. Backed by operator-tier `GET /api/memory/:id`; an agent-tier
   * token is 403'd there, so this never becomes an exfiltration path.
   */
  async getMemoryNote(
    noteId: string,
    options?: { chatId?: string; workspace?: string; unscoped?: boolean }
  ): Promise<MemoryNote> {
    const params = new URLSearchParams();
    if (options?.chatId) {
      params.set("chatId", options.chatId);
    }
    if (options?.workspace) {
      params.set("workspace", options.workspace);
    }
    if (options?.unscoped) {
      params.set("unscoped", "true");
    }
    const query = params.toString();
    const payload = z
      .object({ note: memoryNoteSchema })
      .parse(
        await this.request(
          `/api/memory/${noteId}${query ? `?${query}` : ""}`
        )
      );
    return MuonApiClient.toMemoryNote(payload.note);
  }

  /**
   * WIN 3 (founder product decision) — read the #133 operator-tier
   * crew-visible toggle so the memory UI can PRESENT agent-authored,
   * crew-visible notes as already-active ("Auto · crew memory") instead of a
   * "Review needed" review queue when it is ON. This is a FRAMING read only:
   * it never confirms a note, never widens the per-chat blast radius, and
   * never touches the human-only `confirmed` flag (the durable tier and the
   * operator kill switch are unchanged — see operator-settings.ts). The route
   * is operator-tier for read AND write, so an agent-tier token is 403'd here.
   */
  async getAutoConfirmAgentMemory(): Promise<boolean> {
    const payload = z
      .object({ autoConfirmAgentMemory: z.boolean() })
      .parse(
        await this.request("/api/memory/settings/auto-confirm-agent-memory")
      );
    return payload.autoConfirmAgentMemory;
  }

  /**
   * P1.4, the operator-only memory-pack export read. Returns the deterministic,
   * content-addressed pack of the workspace's CONFIRMED memories (+ tombstones)
   * for the CLI to write into a file store. Pure read: the backend redacts and
   * filters before any byte reaches the wire, and an agent-tier token is 403'd
   * at the route, so this can never expose the raw sync transport to an agent.
   */
  async exportMemoryPack(workspace?: string): Promise<MemoryPackExport> {
    const params = new URLSearchParams();
    if (workspace) {
      params.set("workspace", workspace);
    }
    const qs = params.toString();
    return memoryPackExportSchema.parse(
      await this.request(`/api/memory/pack/export${qs ? `?${qs}` : ""}`)
    );
  }

  /**
   * P1.4, the operator-only memory-pack import write. Posts a pack (manifest +
   * inlined content-addressed records) for the backend to re-verify and stage
   * as PROPOSALS — the server trusts nothing sent here, no record can land
   * confirmed, and an agent-tier token is 403'd at the route. Returns the
   * deterministic per-record report (proposed / duplicates / conflicts /
   * revocations / refused).
   */
  async importMemoryPack(
    pack: {
      manifest: MemoryPackManifest;
      records: { hash: string; record: MemoryPackRecordFile }[];
    },
    /**
     * ADR-0026 §7 — the RECEIVING workspace, which the import stamps onto every
     * proposal it lands. A query param and not part of the body ON PURPOSE: the
     * body is the untrusted pack, and the partition must never be settable by a
     * pack's contents. The server validates and reduces it (`repoRootOf`), so a
     * worktree or case-variant spelling lands on the same partition the write path
     * stored.
     *
     * Omitted → the note lands unassigned, which §8 makes invisible to every agent
     * read and non-exportable. That is fail-closed and it is also useless, so a
     * surface offering `pack import` should send this.
     */
    workspace?: string
  ): Promise<MemoryPackImportReport> {
    const params = new URLSearchParams();
    if (workspace) {
      params.set("workspace", workspace);
    }
    const qs = params.toString();
    return memoryPackImportReportSchema.parse(
      await this.request(`/api/memory/pack/import${qs ? `?${qs}` : ""}`, {
        method: "POST",
        body: JSON.stringify(pack),
      })
    );
  }

  async updateMemoryNote(input: {
    noteId: string;
    confirmed?: boolean;
    text?: string;
    trust?: MemoryTrust;
    status?: "active" | "paused" | "rejected";
    pinned?: boolean;
    /** KG-6: the confirming/rejecting principal (e.g. "human:carol"). Threaded so
     *  CONFIRMED_BY points at the ACTUAL confirmer and a confirm resolves any
     *  PROPOSES_SUPERSEDE the note authored. Omitted → the ledger defaults to the
     *  human operator ("human"), so prior callers are unchanged. */
    principal?: string;
  }): Promise<MemoryNote> {
    const { noteId, ...body } = input;
    const payload = z
      .object({ note: memoryNoteSchema })
      .parse(
        await this.request(`/api/memory/${noteId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return MuonApiClient.toMemoryNote(payload.note);
  }

  async suggestLanes(taskId?: string, text?: string): Promise<LaneSuggestion[]> {
    const params = new URLSearchParams();
    if (taskId) params.set("taskId", taskId);
    if (text) params.set("text", text);
    const query = params.toString();
    const payload = routingResponseSchema.parse(
      await this.request(`/api/routing/suggest${query ? `?${query}` : ""}`)
    );
    return payload.suggestions;
  }

  /**
   * ADR-0036 D6 — this mission's cap, its spend, and the ONE rendering.
   *
   * `summary` is not a convenience: D1 forbids a surface from showing a bare
   * number, so the figure and the coverage that qualifies it are returned
   * together and every caller renders the sentence rather than the float.
   */
  async getMissionCost(chatId: string): Promise<MissionCostView> {
    return missionCostViewSchema.parse(
      await this.request(`/api/chats/${encodeURIComponent(chatId)}/cost`)
    );
  }

  /**
   * Set, raise, lower or (with `null`) clear this mission's cap. Operator.
   *
   * Returns a NARROWER type than `getMissionCost` on purpose, and says so in
   * the type rather than in a comment: the mutation route answers with the cap
   * and what it means against today's spend, not with the per-lane breakdown.
   * An earlier version parsed the same schema with two fields made optional
   * and then CAST the result back — so callers were told `laneCosts` and
   * `silentLanes` were there when the route never sends them, and the first
   * one to read them would have found an empty array and believed it.
   */
  async setMissionCostCap(
    chatId: string,
    capUsd: number | null
  ): Promise<MissionCapUpdate> {
    return missionCapUpdateSchema.parse(
      await this.request(`/api/chats/${encodeURIComponent(chatId)}/cost-cap`, {
        method: "PUT",
        body: JSON.stringify({ capUsd }),
      })
    );
  }

  /**
   * The operator DEFAULT for chats created from now on (ADR-0036 D7).
   *
   * It cannot reach a mission that already exists — the default is COPIED into
   * a chat at creation, never read live — which is what stops an edit here
   * from silently re-capping work in flight.
   */
  async getMissionCostCapDefault(): Promise<number | null> {
    return z
      .object({ capUsd: z.number().nullable() })
      .parse(await this.request("/api/chats/settings/cost-cap-default")).capUsd;
  }

  async setMissionCostCapDefault(capUsd: number | null): Promise<number | null> {
    return z
      .object({ capUsd: z.number().nullable() })
      .parse(
        await this.request("/api/chats/settings/cost-cap-default", {
          method: "PUT",
          body: JSON.stringify({ capUsd }),
        })
      ).capUsd;
  }

  async getLaneProfile(
    laneId: string
  ): Promise<{ profile: LaneProfile; version: number }> {
    const payload = z
      .object({ profile: laneProfileSchema, version: z.number() })
      .parse(await this.request(`/api/lanes/${laneId}/profile`));
    return payload;
  }

  async putLaneProfile(
    laneId: string,
    profile: LaneProfile
  ): Promise<{ profile: LaneProfile; version: number }> {
    const payload = z
      .object({ profile: laneProfileSchema, version: z.number() })
      .parse(
        await this.request(`/api/lanes/${laneId}/profile`, {
          method: "PUT",
          body: JSON.stringify(profile),
        })
      );
    return payload;
  }

  async createSession(input: {
    laneId: string;
    taskId: string;
    // Checkpoint edge (P0.1): the DispatchJob this session executes.
    jobId?: string;
    vendorSessionId?: string;
  }): Promise<LaneSession> {
    const payload = z
      .object({ session: sessionSchema })
      .parse(
        await this.request("/api/sessions", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return payload.session as LaneSession;
  }

  async updateSession(input: {
    sessionId: string;
    status?: LaneSessionStatus;
    vendorSessionId?: string;
  }): Promise<LaneSession> {
    const { sessionId, ...body } = input;
    const payload = z
      .object({ session: sessionSchema })
      .parse(
        await this.request(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.session as LaneSession;
  }

  async listSessions(filter?: {
    taskId?: string;
    status?: string;
  }): Promise<LaneSession[]> {
    const params = new URLSearchParams();
    if (filter?.taskId) params.set("taskId", filter.taskId);
    if (filter?.status) params.set("status", filter.status);
    const query = params.toString();
    const payload = z
      .object({ sessions: z.array(sessionSchema) })
      .parse(await this.request(`/api/sessions${query ? `?${query}` : ""}`));
    return payload.sessions as LaneSession[];
  }

  /** ADR-0030: hand a live session to the human (operator tier). */
  async takeOverSession(
    sessionId: string
  ): Promise<{ session: LaneSession; alreadyOwned: boolean }> {
    const payload = z
      .object({ session: sessionSchema, alreadyOwned: z.boolean() })
      .parse(
        await this.request(`/api/sessions/${sessionId}/take-over`, {
          method: "POST",
        })
      );
    return payload as { session: LaneSession; alreadyOwned: boolean };
  }

  /** ADR-0030: return a taken-over session to automation (operator tier). */
  async returnSession(sessionId: string): Promise<{
    session: LaneSession;
    alreadyOwned: boolean;
    snapshot: { dirtyFiles: number | null; readinessDegraded: boolean } | null;
  }> {
    const payload = z
      .object({
        session: sessionSchema,
        alreadyOwned: z.boolean(),
        snapshot: z
          .object({
            dirtyFiles: z.number().nullable(),
            readinessDegraded: z.boolean(),
          })
          .nullable(),
      })
      .parse(
        await this.request(`/api/sessions/${sessionId}/return`, {
          method: "POST",
        })
      );
    return payload as never;
  }

  // ---- harnesses (named execution constraint bundles) ----

  async listHarnesses(): Promise<HarnessRecord[]> {
    const payload = z
      .object({ harnesses: z.array(harnessRecordSchema) })
      .parse(await this.request("/api/harnesses"));
    return payload.harnesses as HarnessRecord[];
  }

  async getHarness(key: string): Promise<HarnessRecord> {
    const payload = z
      .object({ harness: harnessRecordSchema })
      .parse(await this.request(`/api/harnesses/${encodeURIComponent(key)}`));
    return payload.harness as HarnessRecord;
  }

  async putHarness(
    key: string,
    input: { name: string; config: HarnessConfig; createdBy?: string }
  ): Promise<HarnessRecord> {
    const payload = z
      .object({ harness: harnessRecordSchema })
      .parse(
        await this.request(`/api/harnesses/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify(input),
        })
      );
    return payload.harness as HarnessRecord;
  }

  // ---- workflow templates ----

  async listWorkflowTemplates(): Promise<WorkflowTemplateRecord[]> {
    const payload = z
      .object({ templates: z.array(workflowTemplateRecordSchema) })
      .parse(await this.request("/api/workflows"));
    return payload.templates as WorkflowTemplateRecord[];
  }

  async getWorkflowTemplate(key: string): Promise<WorkflowTemplateRecord> {
    const payload = z
      .object({ template: workflowTemplateRecordSchema })
      .parse(await this.request(`/api/workflows/${encodeURIComponent(key)}`));
    return payload.template as WorkflowTemplateRecord;
  }

  // ---- workflow runs (proposals stay inert until a human applies) ----

  async createWorkflowRun(
    input: {
      templateKey?: string;
      templateVersion?: number;
      request: string;
      workspacePath?: string;
      chatId?: string;
      proposal: WorkflowProposal;
      proposedBy?: string;
    },
    control?: WorkflowCallerControl
  ): Promise<WorkflowRunRecord> {
    const payload = z
      .object({ run: workflowRunSchema })
      .parse(
        await this.request("/api/workflow-runs", {
          method: "POST",
          body: JSON.stringify(input),
          headers: workflowCallerHeaders(control),
        })
      );
    return payload.run as WorkflowRunRecord;
  }

  async listWorkflowRuns(
    filter?: {
      status?: WorkflowRunStatus;
      chatId?: string;
    },
    control?: WorkflowCallerControl
  ): Promise<WorkflowRunRecord[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set("status", filter.status);
    if (filter?.chatId) params.set("chatId", filter.chatId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const payload = z
      .object({ runs: z.array(workflowRunSchema) })
      .parse(
        await this.request(`/api/workflow-runs${query}`, {
          headers: workflowCallerHeaders(control),
        })
      );
    return payload.runs as WorkflowRunRecord[];
  }

  async getWorkflowRun(
    runId: string,
    control?: WorkflowCallerControl
  ): Promise<WorkflowRunDetail> {
    const payload = z
      .object({ run: workflowRunSchema, tasks: z.array(workflowRunTaskSchema) })
      .parse(
        await this.request(`/api/workflow-runs/${runId}`, {
          headers: workflowCallerHeaders(control),
        })
      );
    return payload as unknown as WorkflowRunDetail;
  }

  async applyWorkflowRun(
    runId: string,
    appliedBy: string,
    // ADR-0010 Part B: the agent tier must send a redeemed, operator-approved
    // single-use gate id bound to this runId; the route 403s without it. The
    // operator tier (`muon workflow apply`) omits it and applies directly.
    gateApprovalId?: string,
    control?: WorkflowCallerControl
  ): Promise<{ run: WorkflowRunRecord; tasks: WorkflowRunTask[] }> {
    const payload = z
      .object({ run: workflowRunSchema, tasks: z.array(workflowRunTaskSchema) })
      .parse(
        await this.request(`/api/workflow-runs/${runId}/apply`, {
          method: "POST",
          body: JSON.stringify(
            gateApprovalId ? { appliedBy, gateApprovalId } : { appliedBy }
          ),
          headers: workflowCallerHeaders(control),
        })
      );
    return payload as unknown as {
      run: WorkflowRunRecord;
      tasks: WorkflowRunTask[];
    };
  }

  async updateWorkflowRun(input: {
    runId: string;
    status?: WorkflowRunStatus;
    proposal?: WorkflowProposal;
  }): Promise<WorkflowRunRecord> {
    const { runId, ...body } = input;
    const payload = z
      .object({ run: workflowRunSchema })
      .parse(
        await this.request(`/api/workflow-runs/${runId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.run as WorkflowRunRecord;
  }

  // ---- loop runs ----

  async createLoopRun(input: {
    dispatchJobId?: string;
    taskId: string;
    workflowRunId?: string;
    stepKey?: string;
    harnessKey?: string;
    kind?: string;
    budget?: { maxIterations: number; maxWallMs?: number };
  }): Promise<LoopRunRecord> {
    const payload = z
      .object({ loop: loopRunSchema })
      .parse(
        await this.request("/api/loops", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return payload.loop as LoopRunRecord;
  }

  async updateLoopRun(input: {
    loopId: string;
    iterations?: number;
    progress?: LoopProgress;
    status?: LoopRunStatus;
    stopReason?: string;
  }): Promise<LoopRunRecord> {
    const { loopId, ...body } = input;
    const payload = z
      .object({ loop: loopRunSchema })
      .parse(
        await this.request(`/api/loops/${loopId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.loop as LoopRunRecord;
  }

  async listLoopRuns(filter?: { taskId?: string }): Promise<LoopRunRecord[]> {
    const query = filter?.taskId
      ? `?taskId=${encodeURIComponent(filter.taskId)}`
      : "";
    const payload = z
      .object({ loops: z.array(loopRunSchema) })
      .parse(await this.request(`/api/loops${query}`));
    return payload.loops as LoopRunRecord[];
  }

  // ---- governed schedules ----

  async listSchedules(): Promise<GovernedScheduleRecord[]> {
    const payload = z
      .object({ schedules: z.array(governedScheduleSchema) })
      .parse(await this.request("/api/schedules"));
    return payload.schedules as GovernedScheduleRecord[];
  }

  async createSchedule(input: {
    title: string;
    objective: string;
    workspacePath: string;
    vendor: string;
    model?: string;
    effort?: string;
    cadenceMinutes?: number;
    nextRunAt: string;
    maxRuns?: number;
    maxWallMs: number;
    maxDescendantWallMs: number;
  }): Promise<GovernedScheduleRecord> {
    const payload = z
      .object({ schedule: governedScheduleSchema })
      .parse(
        await this.request("/api/schedules", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return payload.schedule as GovernedScheduleRecord;
  }

  async updateSchedule(input: {
    scheduleId: string;
    status?: Exclude<GovernedScheduleStatus, "completed">;
    nextRunAt?: string;
  }): Promise<GovernedScheduleRecord> {
    const { scheduleId, ...body } = input;
    const payload = z
      .object({ schedule: governedScheduleSchema })
      .parse(
        await this.request(`/api/schedules/${scheduleId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.schedule as GovernedScheduleRecord;
  }

  async claimDueSchedule(): Promise<{
    schedule: GovernedScheduleRecord;
    occurrence: ScheduleOccurrenceRecord;
  } | null> {
    const payload = z
      .object({
        claim: z
          .object({
            schedule: governedScheduleSchema,
            occurrence: scheduleOccurrenceSchema,
          })
          .nullable(),
      })
      .parse(
        await this.request("/api/schedules/claim-due", { method: "POST" })
      );
    return payload.claim as {
      schedule: GovernedScheduleRecord;
      occurrence: ScheduleOccurrenceRecord;
    } | null;
  }

  async updateScheduleOccurrence(input: {
    scheduleId: string;
    occurrenceId: string;
    status: "running" | "done" | "failed";
    chatId?: string;
    rootJobId?: string;
    error?: string;
  }): Promise<ScheduleOccurrenceRecord> {
    const { scheduleId, occurrenceId, ...body } = input;
    const payload = z
      .object({ occurrence: scheduleOccurrenceSchema })
      .parse(
        await this.request(
          `/api/schedules/${scheduleId}/occurrences/${occurrenceId}`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
      );
    return payload.occurrence as ScheduleOccurrenceRecord;
  }

  // ---- orchestrator chats ----

  private static chatSchema = z.object({
    id: z.string(),
    title: z.string(),
    workspacePath: z.string(),
    taskId: z.string().nullable().optional(),
    vendorSessionId: z.string().nullable().optional(),
    vendorSessionVendor: z.string().nullable().optional(),
    vendorSessionRootJobId: z.string().nullable().optional(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

  async listChats(filter?: {
    status?: "active" | "archived" | "all";
  }): Promise<OrchestratorChatRecord[]> {
    // Default (no param) → the backend returns ACTIVE chats only, so archived
    // (soft-deleted) chats drop out of every list surface unless explicitly
    // asked for. An older backend simply ignores the query and returns all.
    const path = filter?.status
      ? `/api/chats?status=${encodeURIComponent(filter.status)}`
      : "/api/chats";
    const payload = z
      .object({ chats: z.array(MuonApiClient.chatSchema) })
      .parse(await this.request(path));
    return payload.chats as OrchestratorChatRecord[];
  }

  async createChat(input: {
    title?: string;
    workspacePath: string;
  }): Promise<OrchestratorChatRecord> {
    const payload = z
      .object({ chat: MuonApiClient.chatSchema })
      .parse(
        await this.request("/api/chats", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return payload.chat as OrchestratorChatRecord;
  }

  async getChat(chatId: string): Promise<OrchestratorChatRecord> {
    const payload = z
      .object({ chat: MuonApiClient.chatSchema })
      .parse(await this.request(`/api/chats/${chatId}`));
    return payload.chat as OrchestratorChatRecord;
  }

  async updateChat(input: {
    chatId: string;
    title?: string;
    vendorSessionId?: string;
    // The lane that OWNS the chat's continuity handle. Any vendor id may be
    // named here; the route is the boundary and admits only a lane whose
    // registry entry declares `session.persistsSessionHandle` (ADR-0022 G7).
    vendorSessionVendor?: VendorId;
    vendorSessionRootJobId?: string;
    status?: "active" | "archived";
  }): Promise<OrchestratorChatRecord> {
    const { chatId, ...body } = input;
    const payload = z
      .object({ chat: MuonApiClient.chatSchema })
      .parse(
        await this.request(`/api/chats/${chatId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.chat as OrchestratorChatRecord;
  }

  /**
   * "Delete" a chat = OPERATOR-tier SOFT archive (S7/FD-2). The row and its
   * whole audit trail (shadow Task, StreamChunks, Events, ApprovalRequests)
   * survive; the chat just flips status→"archived" and leaves the default
   * lists. An agent-tier caller is 403'd at the route. Returns the archived
   * record.
   */
  async archiveChat(chatId: string): Promise<OrchestratorChatRecord> {
    const payload = z
      .object({ chat: MuonApiClient.chatSchema })
      .parse(
        await this.request(`/api/chats/${chatId}`, {
          method: "DELETE",
        })
      );
    return payload.chat as OrchestratorChatRecord;
  }

  // ---- agent fleet (0–3 instances per vendor) ----

  private static agentSchema = z.object({
    id: z.string(),
    vendor: z.string(),
    name: z.string(),
    ordinal: z.number(),
    status: z.string(),
    currentTaskId: z.string().nullable().optional(),
    currentJobId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
  });

  async getFleet(): Promise<FleetSnapshot> {
    const payload = z
      .object({
        counts: z.record(z.string(), z.number()),
        agents: z.array(MuonApiClient.agentSchema),
        warnings: z.array(z.string()).optional(),
      })
      .parse(await this.request("/api/fleet"));
    return payload as FleetSnapshot;
  }

  async setFleet(
    // WAVE D: this spelled three vendors and had done since before Cursor
    // became a managed lane, so a caller could not even TYPE a count for the
    // fourth. `Partial<Record<VendorId, number>>` follows the registry; the
    // route still decides which ids it accepts.
    counts: Partial<Record<VendorId, number>>,
    // ADR-0010 Part B: the agent tier must send a redeemed, operator-approved
    // single-use gate id bound to these exact counts; the route 403s without it.
    // Operator-tier surfaces (CLI/TUI/desktop) omit it and apply directly.
    gateApprovalId?: string
  ): Promise<FleetSnapshot> {
    const payload = z
      .object({
        counts: z.record(z.string(), z.number()),
        agents: z.array(MuonApiClient.agentSchema),
        warnings: z.array(z.string()).optional(),
      })
      .parse(
        await this.request("/api/fleet", {
          method: "PUT",
          body: JSON.stringify(
            gateApprovalId ? { ...counts, gateApprovalId } : counts
          ),
        })
      );
    return payload as FleetSnapshot;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const payload = z
      .object({ agents: z.array(MuonApiClient.agentSchema) })
      .parse(await this.request("/api/fleet/agents"));
    return payload.agents as AgentRecord[];
  }

  async updateAgent(input: {
    agentId: string;
    status?: "idle" | "working" | "offline";
    currentTaskId?: string | null;
    sessionId?: string | null;
  }): Promise<AgentRecord> {
    const { agentId, ...body } = input;
    const payload = z
      .object({ agent: MuonApiClient.agentSchema })
      .parse(
        await this.request(`/api/fleet/agents/${agentId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.agent as AgentRecord;
  }

  /**
   * Credential-aware readiness per vendor (P2 onboarding): installed plus
   * positive native-login or trusted provider evidence. The embedded backend
   * is LOCAL; credential values are never returned. Pass `{ refresh: true }`
   * after changing login/provider configuration or before permanently
   * blocking a dispatch.
   */
  async getVendorReadiness(opts?: {
    refresh?: boolean;
  }): Promise<VendorReadiness[]> {
    return (await this.getFleetReadinessReport(opts)).vendors;
  }

  /** Full readiness report: vendors + backend anyReady/warning/generatedAt (probe freshness). */
  async getFleetReadinessReport(opts?: {
    refresh?: boolean;
  }): Promise<FleetReadinessReport> {
    const query = opts?.refresh ? "?refresh=1" : "";
    return fleetReadinessPayloadSchema.parse(
      await this.request(`/api/fleet/readiness${query}`)
    ) as FleetReadinessReport;
  }

  // ---- agent output streams (watch-an-agent views) ----

  async recordStreamChunks(
    chunks: StreamChunkInput[]
  ): Promise<{ recorded: number }> {
    return z
      .object({ recorded: z.number() })
      .parse(
        await this.request("/api/streams", {
          method: "POST",
          body: JSON.stringify({ chunks }),
        })
      );
  }

  /**
   * Atomically append one milestone iff its task-scoped claim key is new.
   * Used for cross-process reconciliation ownership; the boolean is the only
   * returned field so no stream content crosses an authority boundary.
   */
  async claimStreamChunk(
    input: StreamChunkClaimInput
  ): Promise<{ claimed: boolean }> {
    return z
      .object({ claimed: z.boolean() })
      .parse(
        await this.request("/api/streams/claim", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
  }

  // ---- dispatch jobs + runner (R1 persistent runner) ----

  private static dispatchJobSchema = z.object({
    id: z.string(),
    kind: z.string(),
    vendor: z.string(),
    taskId: z.string(),
    brief: z.string(),
    // VISION §2 crew role. Kept as a plain string (not the enum) so an
    // unrecognized value from a newer backend degrades to "the runner refuses to
    // launch a role it cannot bound", never to a parse failure that would strand
    // the whole job record.
    role: z.string().nullable().optional(),
    harnessKey: z.string().nullable().optional(),
    maxIterations: z.number().int().nullable().optional(),
    maxWallMs: z.number().int().nullable().optional(),
    checks: z.array(harnessCheckSchema).nullable().optional(),
    iterationTimeoutMs: z.number().int().nullable().optional(),
    resumeVendorSessionId: z.string().nullable().optional(),
    approvalTimeoutMs: z.number().int().nullable().optional(),
    workspacePath: z.string().nullable().optional(),
    chatId: z.string().nullable().optional(),
    parentJobId: z.string().nullable().optional(),
    rootJobId: z.string().nullable().optional(),
    delegationDepth: z.number().int().optional(),
    maxDelegationDepth: z.number().int().nullable().optional(),
    maxChildren: z.number().int().nullable().optional(),
    maxTotalDescendants: z.number().int().nullable().optional(),
    maxDelegationIterations: z.number().int().nullable().optional(),
    // S3/S9 pool + released-spend accounting. Optional so an older backend that
    // does not yet emit them parses cleanly (back-compat).
    maxDescendantWallMs: z.number().int().nullable().optional(),
    delegationChildrenIssued: z.number().int().optional(),
    delegationDescendantsIssued: z.number().int().optional(),
    delegationBudgetReservedMs: z.number().int().optional(),
    delegationBudgetConsumedMs: z.number().int().optional(),
    delegationDeadline: z.string().nullable().optional(),
    capabilityMode: z.string().nullable().optional(),
    delegationManifest: delegationPolicySchema.nullable().optional(),
    status: z.string(),
    agentId: z.string().nullable().optional(),
    dispatchedBy: z.string(),
    interruptRequested: z.boolean(),
    // `.catch([])` (not `.default`): the column is nullable (Json?), so tolerate
    // a null/legacy/invalid value → [] rather than throwing (review finding F4).
    steerMessages: z.array(z.string()).catch([]),
    // ADR-0013 v2, resolved vendor action carried on the job (nullable; a plain
    // dispatch leaves them null). Tolerated as-is so the runner can apply them.
    action: z.string().nullable().optional(),
    actionProfilePatch: z.record(z.string(), z.unknown()).nullable().optional(),
    actionArgvOverride: z
      .object({ command: z.string().optional(), args: z.array(z.string()) })
      .nullable()
      .optional(),
    actionBriefPrefix: z.string().nullable().optional(),
    // Resume lineage (P0.1). Optional so an older backend parses cleanly.
    resumedFromJobId: z.string().nullable().optional(),
    // Append-once resume claim (P0.1 replay-safety). The resume planner reads
    // these to classify an already-resumed original (skip, never redispatch).
    resumedAt: z.string().nullable().optional(),
    resumedByJobId: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
    exitCode: z.number().nullable().optional(),
    // Typed terminal packet column (P0.3). Lenient pipe (unknown → null when
    // absent); consumers validate with handoffPacketSchema at read time.
    packetJson: z.unknown().default(null),
    // LIVE TERMINAL attach coordinate (0038). Optional so an older backend that
    // does not emit it parses cleanly; null means "no live console for this
    // job", and the viewer falls back to the recorded stream.
    ptySessionId: z.string().nullable().optional(),
    // BACKLINK: the vendor's OWN session id for this job's latest execution
    // (codex rollout / claude session uuid). Optional so an older backend
    // parses cleanly; null means "no resume handle is known for this job".
    vendorSessionId: z.string().nullable().optional(),
    // Where the job ACTUALLY ran (0039). Optional so an older backend that does
    // not emit it parses cleanly; null/absent means "unknown", which a reader
    // resolves by deriving the tree — never by assuming the workspace root.
    executionPath: z.string().nullable().optional(),
    createdAt: z.string(),
    startedAt: z.string().nullable().optional(),
    endedAt: z.string().nullable().optional(),
    // Wave 4.2 crew-liveness: the job's most recent stream-chunk (output) time,
    // enriched by GET /api/dispatch. null = no output yet. Optional so an older
    // backend that doesn't emit it parses cleanly.
    lastProgressAt: z.string().nullable().optional(),
    waitingApproval: z.boolean().optional(),
    currentActivity: z.string().max(200).nullable().optional(),
  });

  async enqueueDispatch(input: {
    kind?: DispatchKind;
    vendor: string;
    taskId: string;
    brief: string;
    // VISION §2, the crew role this job runs as. Optional: the route RESOLVES
    // one (crew plan → harness → implementer) and admits it fail-closed against
    // the vendor's declared ceiling, so an omitted role is never a null column.
    role?: AgentRole;
    harnessKey?: string;
    maxIterations?: number;
    maxWallMs?: number;
    /** Operator-authored root only: bounded aggregate descendant wall budget. */
    maxDescendantWallMs?: number;
    checks?: HarnessCheck[];
    iterationTimeoutMs?: number;
    resumeVendorSessionId?: string;
    approvalTimeoutMs?: number;
    workspacePath?: string;
    chatId?: string;
    /** Operator-authored turn, atomically persisted with a chat root job. */
    humanMessage?: string;
    dispatchedBy?: string;
    // S6, an optional per-dispatch model override. The route validates it
    // fail-closed against the execution vendor before it can reach vendor argv
    // and persists it as a merged `actionProfilePatch: {model}`.
    model?: string;
    // ADR-0013 #52 v2, vendor-native action fields. When `action` is set the
    // dispatch route resolves it SERVER-SIDE and enforces every guard at the
    // point of execution (the UI/CLI resolve is advisory; tier comes from auth
    // at the route). `actionVendor` selects the descriptor (defaults to vendor);
    // `egressOptIn` unlocks a cloud/remote action (operator only); a full-auto
    // action from the agent tier needs `gateApprovalId` (an operator gate).
    action?: string;
    actionVendor?: string;
    actionArgs?: string[];
    target?: string;
    egressOptIn?: boolean;
    gateApprovalId?: string;
    // Resume lineage (P0.1): names the terminal job this fresh dispatch was
    // re-created from by an explicit human resume act. The route 400s unless
    // it exists and 409s unless it is terminal.
    resumedFromJobId?: string;
    // S4 machine continuation: the ONE chat-root shape a non-operator caller
    // (the always-alive runner) may create — one bounded reconciliation turn
    // for a governed child that went terminal while the coordinator was idle.
    // An ENUMERATED kind: the route admits this literal and nothing else, so a
    // future continuation kind is refused until it is added there by name.
    continuation?: "job-terminal";
    /** The exact terminal child job this continuation reconciles. */
    continuationJobId?: string;
  }): Promise<DispatchJobRecord> {
    const payload = z
      .object({ job: MuonApiClient.dispatchJobSchema })
      .parse(
        await this.request("/api/dispatch", {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    return payload.job as DispatchJobRecord;
  }

  async listDispatchJobs(filter?: {
    status?: string;
    taskId?: string;
    chatId?: string;
    activeOnly?: boolean;
    activeRootOnly?: boolean;
    latest?: boolean;
    limit?: number;
  }): Promise<DispatchJobRecord[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set("status", filter.status);
    if (filter?.taskId) params.set("taskId", filter.taskId);
    if (filter?.chatId) params.set("chatId", filter.chatId);
    if (filter?.activeOnly) params.set("activeOnly", "true");
    if (filter?.activeRootOnly) params.set("activeRootOnly", "true");
    if (filter?.latest) params.set("latest", "true");
    if (filter?.limit) params.set("limit", String(filter.limit));
    const query = params.toString();
    const payload = z
      .object({ jobs: z.array(MuonApiClient.dispatchJobSchema) })
      .parse(await this.request(`/api/dispatch${query ? `?${query}` : ""}`));
    return payload.jobs as DispatchJobRecord[];
  }

  async delegateDispatch(
    parentJobId: string,
    input: {
      kind?: DispatchKind;
      vendor: string;
      taskId: string;
      brief: string;
      // The child's crew role. `orchestrator` is refused outright (a delegate is
      // a worker); omitted resolves from the parent chat's crew plan.
      role?: AgentRole;
      harnessKey?: string;
      maxIterations?: number;
      maxWallMs?: number;
      workspacePath?: string;
      // S6, an optional model override for the delegated child; the route
      // validates it against the child's execution vendor and persists it as
      // the only key of the child's `actionProfilePatch`.
      model?: string;
    },
    delegationToken: string
  ): Promise<DispatchJobRecord> {
    const payload = z
      .object({ job: MuonApiClient.dispatchJobSchema })
      .parse(
        await this.request(`/api/dispatch/${parentJobId}/delegate`, {
          method: "POST",
          headers: {
            "x-muon-delegation-token": delegationToken,
          },
          body: JSON.stringify(input),
        })
      );
    return payload.job as DispatchJobRecord;
  }

  async issueDelegationTokenForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
  }): Promise<{ token: string; canDelegate: boolean }> {
    const { jobId, ...body } = input;
    return z
      .object({
        token: z.string().min(32).max(512),
        canDelegate: z.boolean(),
      })
      .parse(
        await this.request(`/api/dispatch/${jobId}/delegation-token`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
  }

  // ── ADR-0028 Tier C: the attached (external, non-hermetic) coordinator ──
  //
  // `attachCoordinator`/`detachCoordinator` are OPERATOR-tier only — the
  // human's own CLI/TUI/desktop surface mints or revokes the seat, never the
  // vendor session itself (backend/src/lib/attached-coordinator.ts). The
  // resulting `capability.token` is the ONE bearer an attached `muon-mcp`
  // process ever holds: the SAME value both authenticates its Authorization
  // header (resolving the exact-job capability server-side) AND is the
  // `x-muon-delegation-token` `delegateDispatch` sends when the attached
  // coordinator's `dispatch` tool spawns a child — see the route-level
  // `capabilityTokenMatches`/`delegationTokenMatches` checks against the
  // SAME `DelegationGrant` row. `heartbeatAttachedCoordinator` must be
  // called with a client constructed from THAT token, never the operator or
  // shared agent token.
  private static attachedCoordinatorAttachSchema = z.object({
    job: MuonApiClient.dispatchJobSchema,
    chat: MuonApiClient.chatSchema,
    capability: z.object({
      token: z.string().min(32).max(512),
      expiresAt: z.string(),
    }),
    attestation: z.object({
      posture: z.string(),
      claim: z.string(),
    }),
  });

  /** Mint an attached-coordinator seat for `vendor` on `chatId` (operator-tier). */
  async attachCoordinator(input: {
    vendor: string;
    chatId: string;
  }): Promise<{
    job: DispatchJobRecord;
    chat: OrchestratorChatRecord;
    capability: { token: string; expiresAt: string };
    attestation: { posture: string; claim: string };
  }> {
    const payload = MuonApiClient.attachedCoordinatorAttachSchema.parse(
      await this.request("/api/dispatch/attached", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
    return {
      job: payload.job as DispatchJobRecord,
      chat: payload.chat as OrchestratorChatRecord,
      capability: payload.capability,
      attestation: payload.attestation,
    };
  }

  /**
   * Renew the attached coordinator's short heartbeat lease
   * (`DelegationGrant.expiresAt`). The long execution wall
   * (`delegationDeadline`) never moves here — see
   * `backend/src/lib/attached-coordinator.ts`'s heartbeat route comment.
   */
  async heartbeatAttachedCoordinator(
    jobId: string
  ): Promise<{ job: DispatchJobRecord; expiresAt: string }> {
    const payload = z
      .object({
        job: MuonApiClient.dispatchJobSchema,
        expiresAt: z.string(),
      })
      .parse(
        await this.request(
          `/api/dispatch/attached/${encodeURIComponent(jobId)}/heartbeat`,
          { method: "POST" }
        )
      );
    return {
      job: payload.job as DispatchJobRecord,
      expiresAt: payload.expiresAt,
    };
  }

  /** Detach (operator-tier): terminalizes the root and frees the coordinator seat. */
  async detachCoordinator(
    jobId: string
  ): Promise<{ detached: boolean; jobId: string }> {
    return z
      .object({ detached: z.boolean(), jobId: z.string() })
      .parse(
        await this.request(
          `/api/dispatch/attached/${encodeURIComponent(jobId)}`,
          { method: "DELETE" }
        )
      );
  }

  async getDispatchJob(jobId: string): Promise<DispatchJobRecord> {
    // Escaped like every other id this client puts in a path: `:jobId` is ONE
    // path segment, and the callers include surfaces (desktop IPC handlers)
    // whose input originates in an untrusted renderer.
    const payload = z
      .object({ job: MuonApiClient.dispatchJobSchema })
      .parse(await this.request(`/api/dispatch/${encodeURIComponent(jobId)}`));
    return payload.job as DispatchJobRecord;
  }

  // S9 mission budget (numbers + enums only). Read-only for both tiers.
  private static budgetSchema = z.object({
    jobId: z.string(),
    capabilityMode: z.string().nullable().optional(),
    rootWallMs: z.number().int().nullable(),
    maxDescendantWallMs: z.number().int().nullable(),
    poolMs: z.number().int(),
    reservedMs: z.number().int(),
    consumedMs: z.number().int(),
    remainingMs: z.number().int(),
    deadlineAt: z.string().nullable(),
    childrenIssued: z.number().int(),
    maxChildren: z.number().int().nullable(),
    descendantsIssued: z.number().int(),
    maxDescendants: z.number().int().nullable(),
    depth: z.number().int(),
    maxDepth: z.number().int().nullable(),
    children: z.array(
      z.object({
        jobId: z.string(),
        vendor: z.string(),
        status: z.string(),
        depth: z.number().int(),
        reservedMs: z.number().int(),
        consumedMs: z.number().int(),
      })
    ),
  });

  /**
   * S9 budget VISIBILITY. Returns the given job's MISSION budget (resolved to its
   * root): pool, reserved, consumed, remaining, deadline, per-child breakdown,
   * and the depth/child/descendant caps. Read-only; allowed for both tiers.
   */
  async getDispatchBudget(jobId: string): Promise<DispatchBudget> {
    const payload = z
      .object({ budget: MuonApiClient.budgetSchema })
      .parse(await this.request(`/api/dispatch/${jobId}/budget`));
    return payload.budget as DispatchBudget;
  }

  /**
   * S9 budget RAISE (operator act). Raises the root mission's descendant pool.
   * The operator tier raises directly; an agent-tier caller must pass a redeemed
   * `gateApprovalId` (an operator-approved single-use gate bound to this exact
   * job + pool). Raise-only + ceiling-bounded server-side.
   */
  async raiseDispatchBudget(
    jobId: string,
    input: { maxDescendantWallMs: number; gateApprovalId?: string }
  ): Promise<DispatchBudget> {
    const payload = z
      .object({ budget: MuonApiClient.budgetSchema })
      .parse(
        await this.request(`/api/dispatch/${jobId}/budget`, {
          method: "PATCH",
          body: JSON.stringify(input),
        })
      );
    return payload.budget as DispatchBudget;
  }

  /** Atomically reserve an idle agent and claim the job under one runner lease. */
  async claimDispatchJobAndAgentForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
  }): Promise<{ job: DispatchJobRecord; agent: AgentRecord }> {
    const { jobId, ...body } = input;
    const payload = z
      .object({
        job: MuonApiClient.dispatchJobSchema,
        agent: MuonApiClient.agentSchema,
      })
      .parse(
        await this.request(`/api/dispatch/${jobId}/claim`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
    return payload as {
      job: DispatchJobRecord;
      agent: AgentRecord;
    };
  }

  /**
   * Reconcile jobs a prior runner on this host orphaned (crash/kill): mark
   * their uncertain execution interrupted and release their agents. Called by
   * a successor runner on startup; never silently replays old work.
   */
  async reclaimDispatchJobs(
    host: string,
    leaseToken: string
  ): Promise<{ reclaimed: number; jobIds: string[] }> {
    return z
      .object({ reclaimed: z.number(), jobIds: z.array(z.string()) })
      .parse(
        await this.request("/api/dispatch/reclaim", {
          method: "POST",
          body: JSON.stringify({ host, leaseToken }),
        })
      );
  }

  /** Update a job through the active runner lease (terminal writes are fenced). */
  async updateDispatchJobForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
    status?: "queued" | "running" | "done" | "failed" | "interrupted";
    result?: string | null;
    exitCode?: number | null;
    /** Typed terminal handoff packet (P0.3); null means "no packet". */
    packet?: HandoffPacket | null;
  }): Promise<DispatchJobRecord> {
    const { jobId, ...body } = input;
    const payload = z
      .object({ job: MuonApiClient.dispatchJobSchema })
      .parse(
        await this.request(`/api/dispatch/${jobId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      );
    return payload.job as DispatchJobRecord;
  }

  /**
   * B2: file ONE note mined from a job the caller's lease owns, AFTER that job's
   * terminal write released its fleet agent.
   *
   * The per-job capability is dead the moment its job stops running (by design —
   * that window belongs to the VENDOR process), so post-terminal capture comes
   * in on the runner lease instead. The route derives author, task and chat
   * partition from the stored job row and forces `proposalOnly`; this body
   * carries coordinates only, which is why there is no `trust`, `scope`,
   * `createdBy`, `taskId` or `chatId` to pass.
   */
  async captureJobMemoryForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
    note: {
      kind: MemoryKind;
      text: string;
      laneId?: string;
      modules?: string[];
      topics?: string[];
      symbols?: string[];
      outcome?: AttemptOutcome;
    };
  }): Promise<{ note: MemoryNote; action: string }> {
    const { jobId, ...body } = input;
    const payload = z
      .object({
        note: memoryNoteSchema,
        action: z.string().default("inserted"),
      })
      .parse(
        await this.request(`/api/dispatch/${jobId}/memory-capture`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
    return {
      note: MuonApiClient.toMemoryNote(payload.note),
      action: payload.action,
    };
  }

  /** Persist the exact MUON-supplied prompt before attempting vendor delivery. */
  async beginContextFrameForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
    clientRequestId: string;
    source: ContextFrameSource;
    content: string;
    exposures?: ContextExposureInput[];
  }): Promise<ContextFrameRecord> {
    const { jobId, ...body } = input;
    const payload = z
      .object({ frame: contextFrameRecordSchema })
      .parse(
        await this.request(
          `/api/dispatch/${encodeURIComponent(jobId)}/context/frames`,
          { method: "POST", body: JSON.stringify(body) }
        )
      );
    return payload.frame as ContextFrameRecord;
  }

  /** Append one terminal receipt for the frame; a conflicting replay is refused. */
  async completeContextFrameForLease(input: {
    jobId: string;
    frameId: string;
    host: string;
    leaseToken: string;
  } & ContextFrameDeliveryInput): Promise<ContextFrameRecord> {
    const { jobId, frameId, ...body } = input;
    const payload = z
      .object({ frame: contextFrameRecordSchema })
      .parse(
        await this.request(
          `/api/dispatch/${encodeURIComponent(jobId)}/context/frames/${encodeURIComponent(frameId)}/delivery`,
          { method: "POST", body: JSON.stringify(body) }
        )
      );
    return payload.frame as ContextFrameRecord;
  }

  /** Record an exact MUON condensation or an honest vendor knowledge-gap marker. */
  async recordContextCondensationForLease(input: {
    jobId: string;
    host: string;
    leaseToken: string;
  } & ContextCondensationInput): Promise<ContextCondensationRecord> {
    const { jobId, ...body } = input;
    const payload = z
      .object({ condensation: contextCondensationRecordSchema })
      .parse(
        await this.request(
          `/api/dispatch/${encodeURIComponent(jobId)}/context/condensations`,
          { method: "POST", body: JSON.stringify(body) }
        )
      );
    return payload.condensation as ContextCondensationRecord;
  }

  /** Bounded, stable context evidence lookup for audit and replay. */
  async listJobContext(
    jobId: string,
    filter?: {
      afterTurn?: number;
      limit?: number;
      condensationLimit?: number;
      afterCondensation?: string;
    }
  ): Promise<ContextEvidencePage> {
    const params = new URLSearchParams();
    if (filter?.afterTurn !== undefined) {
      params.set("afterTurn", String(filter.afterTurn));
    }
    if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
    if (filter?.condensationLimit !== undefined) {
      params.set("condensationLimit", String(filter.condensationLimit));
    }
    if (filter?.afterCondensation !== undefined) {
      params.set("afterCondensation", filter.afterCondensation);
    }
    const query = params.toString();
    return contextEvidencePageSchema.parse(
      await this.request(
        `/api/dispatch/${encodeURIComponent(jobId)}/context${query ? `?${query}` : ""}`
      )
    ) as ContextEvidencePage;
  }

  async steerDispatchJob(
    jobId: string,
    message: string,
    control?: { callerJobId: string; delegationToken: string }
  ): Promise<void> {
    await this.request(`/api/dispatch/${jobId}/steer`, {
      method: "POST",
      ...(control
        ? {
            headers: {
              "x-muon-caller-job-id": control.callerJobId,
              "x-muon-delegation-token": control.delegationToken,
            },
          }
        : {}),
      body: JSON.stringify({ message }),
    });
  }

  async drainDispatchSteer(
    jobId: string,
    runner: { host: string; leaseToken: string }
  ): Promise<string[]> {
    const payload = z
      .object({ messages: z.array(z.string()) })
      .parse(
        await this.request(`/api/dispatch/${jobId}/steer/drain`, {
          method: "POST",
          body: JSON.stringify(runner),
        })
      );
    return payload.messages;
  }

  async requeueDispatchSteer(
    jobId: string,
    message: string,
    runner: { host: string; leaseToken: string }
  ): Promise<void> {
    await this.request(`/api/dispatch/${jobId}/steer/requeue`, {
      method: "POST",
      body: JSON.stringify({ ...runner, message }),
    });
  }

  async interruptDispatchJob(
    jobId: string,
    control?: { callerJobId: string; delegationToken: string }
  ): Promise<void> {
    await this.request(`/api/dispatch/${jobId}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
      ...(control
        ? {
            headers: {
              "x-muon-caller-job-id": control.callerJobId,
              "x-muon-delegation-token": control.delegationToken,
            },
          }
        : {}),
    });
  }

  /**
   * Round-3 #5 — operator-only: kill a job's LIVE credential now. Distinct
   * from interrupt: the process may keep running; its authenticated identity
   * is dead from the next call on.
   */
  async revokeDispatchGrants(
    jobId: string
  ): Promise<{ jobId: string; revoked: number; note: string }> {
    // NOTE: unlike every sibling here, this one does not parse the body
    // through a schema — it was riding `request()`'s implicit `any`, which
    // annotating the return type has now revealed. Cast rather than silently
    // changing what this method validates; tightening it is its own change.
    return (await this.request(`/api/dispatch/${jobId}/revoke-grants`, {
      method: "POST",
      body: JSON.stringify({}),
    })) as { jobId: string; revoked: number; note: string };
  }

  /**
   * LIVE TERMINAL — publish (runner only, lease-fenced).
   *
   * Relays a batch of the vendor child's console frames. Fire-and-forget by
   * contract: the runner swallows every failure, because a job must never fail,
   * stall, or slow down because its live view could not be delivered.
   */
  async publishJobTerminalForLease(input: {
    jobId: string;
    sessionId: string;
    frames: { seq: number; data: string }[];
    /** Cumulative frames this session lost before they reached the brain. */
    dropped: number;
    host: string;
    leaseToken: string;
  }): Promise<{ accepted: number; lastSeq: number }> {
    const { jobId, ...body } = input;
    return z
      .object({ accepted: z.number().int(), lastSeq: z.number().int() })
      .parse(
        await this.request(`/api/dispatch/${jobId}/terminal`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
  }

  /**
   * BACKLINK — record the vendor's OWN session id for this job's run
   * (runner only, lease-fenced, write-once per execution).
   *
   * This is what ties a dispatched job to the session the vendor itself
   * recorded on disk: `codex resume <id>` / `claude --resume <id>` reopen the
   * EXACT session MUON dispatched — its brief visible as the first turn — in
   * the vendor's real TUI. Best-effort by contract: a resume handle is a
   * convenience and must never fail the run.
   */
  async recordJobVendorSessionForLease(input: {
    jobId: string;
    vendorSessionId: string;
    host: string;
    leaseToken: string;
  }): Promise<{ vendorSessionId: string }> {
    const { jobId, ...body } = input;
    return z
      .object({ vendorSessionId: z.string() })
      .parse(
        await this.request(`/api/dispatch/${jobId}/vendor-session`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
  }

  /**
   * Record the cwd this job's vendor was ACTUALLY launched in, fenced by the
   * runner lease that owns the running job.
   *
   * The runner is the only party that knows this: it resolves either the task's
   * isolated worktree or the canonical workspace at launch. Without it a review
   * surface can only re-derive the harness's INTENT, which is not the same
   * claim. The brain re-validates the path against its workspace allowlist and
   * stores the normalized form, so the value a reader gets back is the
   * canonical one.
   *
   * Best-effort by design: a failure here degrades the review view (the reader
   * falls back to deriving the tree) and must never fail the run.
   */
  async recordDispatchExecutionPathForLease(input: {
    jobId: string;
    executionPath: string;
    host: string;
    leaseToken: string;
  }): Promise<{ executionPath: string }> {
    const { jobId, ...body } = input;
    return z
      .object({ executionPath: z.string() })
      .parse(
        await this.request(`/api/dispatch/${jobId}/execution-path`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
  }

  /**
   * LIVE TERMINAL — attach (operator only, READ-ONLY).
   *
   * Cursor-based like `listStreamChunks`: pass the last `lastSeq` back as
   * `afterSeq`. `available:false` means this brain process holds no console for
   * the job (it finished, or the brain restarted), and the caller should fall
   * back to the recorded stream rather than render a blank live pane.
   *
   * There is deliberately NO write counterpart. Sending input to a dispatched
   * agent would bypass the approval gate that makes it governed.
   */
  async readJobTerminal(
    jobId: string,
    options?: { afterSeq?: number; limit?: number }
  ): Promise<JobTerminalView> {
    const params = new URLSearchParams();
    if (options?.afterSeq !== undefined) {
      params.set("afterSeq", String(options.afterSeq));
    }
    if (options?.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    const query = params.toString();
    return z
      .object({
        sessionId: z.string().nullable(),
        available: z.boolean(),
        jobStatus: z.string(),
        frames: z.array(
          z.object({ seq: z.number().int(), data: z.string() })
        ),
        firstSeq: z.number().int().nullable(),
        lastSeq: z.number().int(),
        dropped: z.number().int(),
      })
      .parse(
        await this.request(
          `/api/dispatch/${jobId}/terminal${query ? `?${query}` : ""}`
        )
      );
  }

  async runnerHeartbeat(
    host: string,
    pid: number,
    leaseToken: string
  ): Promise<void> {
    await this.request("/api/runner/heartbeat", {
      method: "POST",
      body: JSON.stringify({ host, pid, leaseToken }),
    });
  }

  async getRunner(): Promise<{ runner: RunnerRecord | null; live: boolean }> {
    const payload = z
      .object({
        runner: z
          .object({
            id: z.string(),
            host: z.string(),
            pid: z.number().nullable().optional(),
            status: z.string(),
            lastSeenAt: z.string(),
          })
          .nullable(),
        live: z.boolean(),
      })
      .parse(await this.request("/api/runner"));
    return payload as { runner: RunnerRecord | null; live: boolean };
  }

  async listStreamChunks(filter: {
    taskId?: string;
    runId?: string;
    sessionId?: string;
    agentId?: string;
    afterSeq?: number;
    limit?: number;
    /** Return the NEWEST `limit` chunks (for resuming long histories). */
    latest?: boolean;
  }): Promise<StreamChunk[]> {
    const params = new URLSearchParams();
    if (filter.taskId) params.set("taskId", filter.taskId);
    if (filter.runId) params.set("runId", filter.runId);
    if (filter.sessionId) params.set("sessionId", filter.sessionId);
    if (filter.agentId) params.set("agentId", filter.agentId);
    if (filter.afterSeq) params.set("afterSeq", String(filter.afterSeq));
    if (filter.limit) params.set("limit", String(filter.limit));
    if (filter.latest) params.set("latest", "true");
    const payload = z
      .object({
        chunks: z.array(
          z.object({
            seq: z.number(),
            taskId: z.string(),
            laneId: z.string(),
            agentId: z.string().nullable().optional(),
            sessionId: z.string().nullable().optional(),
            runId: z.string().nullable().optional(),
            kind: z.string(),
            content: z.string(),
            // Bounded, redacted tool args/result (migration 0036). MUST be
            // declared here: zod STRIPS unknown keys, so omitting it silently
            // drops the field on read and the transcript's tool cards render an
            // empty body no matter how correct every other hop is.
            detail: z
              .object({
                args: z.string().optional(),
                argsTruncated: z.boolean().optional(),
                result: z.string().optional(),
                resultTruncated: z.boolean().optional(),
              })
              .nullish(),
            timestamp: z.string(),
          })
        ),
      })
      .parse(await this.request(`/api/streams?${params.toString()}`));
    return payload.chunks as StreamChunk[];
  }
}

// ── Chat-level cancel: stop everything one chat owns, over the governed path ──
//
// This is the SHARED implementation every human surface (desktop, CLI, TUI)
// runs, so "cancel this chat" means the same governed act everywhere: the
// operator-tier `POST /api/dispatch/:jobId/interrupt` and nothing else. There is
// deliberately no chat-scoped kill route — that would be a second cancellation
// mechanism outside the per-job authority checks.
//
// The invariant that makes it correct: the archive precondition
// (backend/src/routes/chats.ts) counts `DispatchJob WHERE chatId = ? AND status
// IN ('queued','running')`. We enumerate the SAME set by asking the dispatch
// list for exactly those two statuses on exactly that chatId — never by paging
// the chat's whole job history and filtering client-side, which silently
// truncates (`GET /api/dispatch` caps `limit` at 200 and, without `latest`,
// returns the OLDEST 200 rows — on a busy chat that window can contain no live
// job at all). `chatId` propagates to every delegated descendant, so this set is
// the full subtree the precondition sees.

/** The exact statuses the archive precondition refuses on. */
const ACTIVE_DISPATCH_STATUSES = ["queued", "running"] as const;

/** How many jobs a single status page may return (the route's own ceiling). */
const ACTIVE_DISPATCH_PAGE = 200;

export type ChatStopClient = {
  listDispatchJobs(filter?: {
    status?: string;
    chatId?: string;
    latest?: boolean;
    limit?: number;
  }): Promise<DispatchJobRecord[]>;
  interruptDispatchJob(jobId: string): Promise<void>;
  /** Optional: probed only to explain why a job will not stop. */
  getRunner?(): Promise<{ runner: RunnerRecord | null; live: boolean }>;
};

/** Why a job is STILL queued/running after the stop pass. Never "cancelled". */
export type ChatStopBlockReason =
  /** Interrupt accepted; the runner has not finished draining the vendor yet. */
  | "stopping"
  /** The interrupt request itself failed (authority, network, race). */
  | "interrupt-failed"
  /** Appeared after the last sweep and was never asked to stop. */
  | "unstopped";

export type ChatJobStopState = {
  jobId: string;
  vendor: string;
  /** The last status actually observed on the ledger — not an assumption. */
  status: string;
  reason?: ChatStopBlockReason;
  error?: string;
};

export type CancelChatJobsResult = {
  chatId: string;
  /** Distinct jobs seen queued/running at any point during this call. */
  found: number;
  /** Jobs whose interrupt is now on the ledger (this press or an earlier one). */
  requested: number;
  /** VERIFIED terminal. Only these may be described as stopped. */
  stopped: ChatJobStopState[];
  /** STILL queued/running when we stopped looking. Blocks archiving. */
  blocked: ChatJobStopState[];
  /** Every job id seen for this chat (per-job UI teardown, best effort). */
  observedJobIds: string[];
  /** null = not probed. false = nothing is draining a running job. */
  runnerLive: boolean | null;
};

export type CancelChatJobsOptions = {
  /**
   * How long to keep re-reading the ledger after the interrupts are on it.
   * Interrupt is a REQUEST for a running job: the backend only flags
   * `interruptRequested`, and the runner terminalizes it after the vendor
   * actually drains (~250ms detect + up to ~3s vendor settle). 0 still performs
   * one authoritative re-read, so a queued job (terminalized synchronously by
   * the interrupt route) is reported as stopped, never as "stopping".
   */
  settleMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Probe runner liveness when something will not stop (default true). */
  probeRunner?: boolean;
};

function stopStateOf(
  job: DispatchJobRecord,
  reason?: ChatStopBlockReason,
  error?: string
): ChatJobStopState {
  return {
    jobId: job.id,
    vendor: job.vendor,
    status: job.status,
    ...(reason ? { reason } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The chat's live jobs, read the same way the archive precondition counts them.
 * Two status-scoped pages (newest first) instead of one history page, so a chat
 * with a long job history can never hide its live work behind the row cap.
 */
export async function listActiveChatJobs(
  client: ChatStopClient,
  chatId: string
): Promise<DispatchJobRecord[]> {
  const pages = await Promise.all(
    ACTIVE_DISPATCH_STATUSES.map((status) =>
      client.listDispatchJobs({
        chatId,
        status,
        latest: true,
        limit: ACTIVE_DISPATCH_PAGE,
      })
    )
  );
  const byId = new Map<string, DispatchJobRecord>();
  for (const page of pages) {
    for (const job of page) {
      // Re-check client-side: a filter the server ignored must never widen this
      // set into "terminal jobs we then claim to have stopped".
      if (job.status === "queued" || job.status === "running") {
        byId.set(job.id, job);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Cancel every queued/running job a chat owns, honestly.
 *
 * Idempotent: a job already carrying `interruptRequested` is counted as
 * requested and not re-POSTed, so pressing cancel twice is a no-op rather than
 * a second act. Bounded: the settle window is a deadline, not a retry storm.
 * Fail-closed reporting: a job is only ever in `stopped` when the ledger showed
 * it leave the queued/running set — everything else lands in `blocked` with the
 * reason it is still there.
 */
export async function cancelChatJobs(
  client: ChatStopClient,
  chatId: string,
  options: CancelChatJobsOptions = {}
): Promise<CancelChatJobsResult> {
  const settleMs = Math.max(0, options.settleMs ?? 3_000);
  const pollMs = Math.max(10, options.pollMs ?? 250);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + settleMs;

  const seen = new Map<string, DispatchJobRecord>();
  const requested = new Set<string>();
  const failures = new Map<string, string>();
  const observedJobIds = new Set<string>();

  // Best-effort history read, used ONLY to tear down per-job UI (terminals,
  // panes) for jobs this chat owns. Never authoritative for the stop decision,
  // so a failure here must not block the cancel.
  await client
    .listDispatchJobs({ chatId, latest: true, limit: ACTIVE_DISPATCH_PAGE })
    .then((jobs) => jobs.forEach((job) => observedJobIds.add(job.id)))
    .catch(() => undefined);

  let active = await listActiveChatJobs(client, chatId);
  for (;;) {
    for (const job of active) {
      seen.set(job.id, job);
      observedJobIds.add(job.id);
      if (requested.has(job.id)) {
        continue;
      }
      if (job.interruptRequested) {
        // Already fenced by an earlier press (or by Stop all). Re-POSTing is
        // harmless but pointless; count it as requested and let it drain.
        requested.add(job.id);
        continue;
      }
      try {
        await client.interruptDispatchJob(job.id);
        requested.add(job.id);
        failures.delete(job.id);
      } catch (error) {
        // Keep going: one job refusing to stop must not strand its siblings.
        // Retried on the next pass while the deadline allows.
        failures.set(
          job.id,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Authoritative re-read AFTER the sweep — this is what decides "stopped".
    active = await listActiveChatJobs(client, chatId);
    if (active.length === 0 || now() >= deadline) {
      break;
    }
    await sleep(pollMs);
    // Re-swept on the next pass: already-requested jobs are skipped, failed
    // interrupts are retried, and a child that appeared meanwhile is caught.
    active = await listActiveChatJobs(client, chatId);
  }

  const stillActive = new Map(active.map((job) => [job.id, job]));
  for (const job of active) {
    seen.set(job.id, job);
    observedJobIds.add(job.id);
  }

  const blocked: ChatJobStopState[] = [];
  for (const job of stillActive.values()) {
    const error = failures.get(job.id);
    blocked.push(
      stopStateOf(
        job,
        error
          ? "interrupt-failed"
          : requested.has(job.id)
            ? "stopping"
            : "unstopped",
        error
      )
    );
  }
  const stopped: ChatJobStopState[] = [];
  for (const [jobId, job] of seen) {
    if (!stillActive.has(jobId)) {
      stopped.push(stopStateOf(job));
    }
  }

  let runnerLive: boolean | null = null;
  if (
    blocked.length > 0 &&
    options.probeRunner !== false &&
    typeof client.getRunner === "function"
  ) {
    runnerLive = await client
      .getRunner()
      .then((state) => state.live)
      .catch(() => null);
  }

  return {
    chatId,
    found: seen.size,
    requested: requested.size,
    stopped,
    blocked,
    observedJobIds: [...observedJobIds],
    runnerLive,
  };
}

function jobLabel(state: ChatJobStopState): string {
  const base = `${state.jobId.slice(0, 8)} (${state.vendor}, ${state.status})`;
  if (state.reason === "interrupt-failed") {
    return `${base} — could not be stopped: ${state.error ?? "unknown error"}`;
  }
  if (state.reason === "unstopped") {
    return `${base} — started after the stop pass`;
  }
  return base;
}

/**
 * Name the jobs that are still holding this chat open, and why. Returns null
 * when nothing is blocking. Shared by every surface so a blocked archive reads
 * identically in the sidebar, the CLI, and the TUI.
 */
export function describeChatStopBlockers(
  result: CancelChatJobsResult
): string | null {
  if (result.blocked.length === 0) {
    return null;
  }
  const shown = result.blocked.slice(0, 5).map(jobLabel);
  const rest = result.blocked.length - shown.length;
  const list = shown.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
  const hint =
    result.runnerLive === false &&
    result.blocked.some((state) => state.status === "running")
      ? " No runner is online, so a running job cannot finish draining — start the MUON runner, then try again."
      : "";
  return `${result.blocked.length} job${
    result.blocked.length === 1 ? " is" : "s are"
  } still active: ${list}.${hint}`;
}

/** One honest line describing what a chat cancel actually achieved. */
export function summarizeChatCancel(result: CancelChatJobsResult): string {
  if (result.found === 0) {
    return "Nothing to stop — this chat has no queued or running jobs.";
  }
  const stopped = result.stopped.length;
  if (result.blocked.length === 0) {
    return `Stopped ${stopped} job${stopped === 1 ? "" : "s"} in this chat.`;
  }
  return `Stopped ${stopped} of ${result.found}. ${describeChatStopBlockers(
    result
  )}`;
}

/** Thrown instead of a raw 409 when live work is holding a chat open. */
export class ChatStopBlockedError extends Error {
  readonly result: CancelChatJobsResult;
  constructor(message: string, result: CancelChatJobsResult) {
    super(message);
    this.name = "ChatStopBlockedError";
    this.result = result;
  }
}

export type StopThenArchiveClient = ChatStopClient & {
  archiveChat(chatId: string): Promise<OrchestratorChatRecord>;
};

export type StopThenArchiveResult = {
  chat: OrchestratorChatRecord;
  cancel: CancelChatJobsResult;
  observedJobIds: string[];
};

/**
 * Stop a chat's work, THEN archive it — the archive is only attempted once the
 * precondition is genuinely satisfied.
 *
 * The bug this replaces: the old flow treated its settle deadline as permission
 * to archive anyway ("soft archive"), but the backend never permitted that. A
 * running job is not terminal when its interrupt is accepted — only the runner
 * terminalizes it — so every archive of a chat with a running job raced a
 * precondition that could not yet be true and surfaced a bare `409 Conflict`.
 *
 * Now: if anything is still live after the settle window we throw
 * ChatStopBlockedError naming the exact jobs, and the chat stays visible and
 * usable. The single bounded retry covers only the narrow race where a job is
 * created between the final read and the DELETE.
 */
export async function stopThenArchiveChat(
  client: StopThenArchiveClient,
  chatId: string,
  options: CancelChatJobsOptions = {}
): Promise<StopThenArchiveResult> {
  const observedJobIds = new Set<string>();
  let lastCancel: CancelChatJobsResult | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cancel = await cancelChatJobs(client, chatId, options);
    lastCancel = cancel;
    cancel.observedJobIds.forEach((jobId) => observedJobIds.add(jobId));
    const blockers = describeChatStopBlockers(cancel);
    if (blockers) {
      throw new ChatStopBlockedError(
        `Cannot archive this chat yet. ${blockers} Nothing was archived; the chat is still here.`,
        cancel
      );
    }
    try {
      const chat = await client.archiveChat(chatId);
      return { chat, cancel, observedJobIds: [...observedJobIds] };
    } catch (error) {
      // Either a job was dispatched into the gap before the DELETE (the next
      // pass will stop it and report honestly), or the failure is unrelated.
      lastError = error;
    }
  }
  const blockers = lastCancel ? describeChatStopBlockers(lastCancel) : null;
  if (blockers) {
    throw new ChatStopBlockedError(
      `Cannot archive this chat yet. ${blockers} Nothing was archived; the chat is still here.`,
      lastCancel as CancelChatJobsResult
    );
  }
  throw new Error(
    `Could not archive this chat: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError }
  );
}
