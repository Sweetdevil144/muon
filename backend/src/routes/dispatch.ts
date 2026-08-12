import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  VENDOR_CAPABILITY_DESCRIPTORS,
  fakeVendorEnabled,
  resolveVendorAction,
  sanitizeGuardedArgs,
  validateModelForVendor,
  type InvocationMode,
  type VendorKey,
} from "@muon/adapters";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  BUDGET_EXHAUSTED_MARKER,
  CONTEXT_FRAME_CONTENT_CHARS,
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_CHILDREN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_DESCENDANTS,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  agentRoleSchema,
  attemptOutcomeSchema,
  budgetRaiseGateTag,
  contextCondensationInputSchema,
  contextFrameBeginSchema,
  contextFrameDeliveryInputSchema,
  delegationManifestSchema,
  delegationRootPolicySchema,
  delegationRootPolicyV2Schema,
  dispatchActionGateTag,
  handoffPacketSchema,
  harnessCheckSchema,
  isBudgetExhausted,
  isDefaultModel,
  isVendorId,
  sessionCapability,
  vendorSupportsInteractive,
  vendorsWhere,
  type VendorId,
} from "@muon/protocol";
import { redactSecrets, taskWorktreeCandidates } from "@muon/core";
import {
  buildEventAuditStamp,
  eventAuditData,
  requestAuditColumns,
} from "../lib/event-audit.js";
import { refuseConflict } from "../lib/refusal-http.js";
import { Prisma, type DispatchJob } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentJobPrincipal,
  agentMemoryPartition,
  authoringPrincipal,
  isChatCoordinatorCapability,
  requireAgentJobAccess,
  requireAgentTaskAccess,
  requireOperator,
  OPERATOR_PRINCIPAL,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  hashRunnerLease,
  requireActiveRunnerLease,
  RUNNER_LIVE_WINDOW_MS,
} from "../lib/runner-lease.js";
import { assertMissionCostCap } from "../lib/mission-cost.js";
import { jobTerminalStore } from "../lib/job-terminal-store.js";
import { ingestMemoryNote } from "../lib/memory-ledger.js";
import {
  assertDelegationWithinParent,
  assertRoleMatchesHarness,
  assertVendorMayHoldRole,
  resolveDispatchRole,
  type HarnessRow,
} from "../lib/dispatch-role.js";
import { redeemGateAtRoute } from "../lib/gate.js";
import { mirrorToGraph } from "../lib/graph.js";
import { fileTerminalHandoff } from "../lib/terminal-handoff.js";
import {
  realpathOfNearestExisting,
  validateWorkspacePath,
} from "../lib/workspace.js";
import { repoRootOf } from "../lib/workspace-identity.js";
import { COORDINATOR_ORDINAL } from "./fleet.js";

export { RUNNER_LIVE_WINDOW_MS } from "../lib/runner-lease.js";
/**
 * Live-terminal wire bounds. A session id is DERIVED from the job id, never
 * posted freely, so the prefix lives here as the single server-side statement
 * of that shape (the runner mints the same one from @muon/runner).
 */
export const JOB_TERMINAL_SESSION_PREFIX = "pty:job:";
/** Per-frame and per-request caps; the runner splits to match. */
const TERMINAL_FRAME_CHARS = 16 * 1024;
const TERMINAL_FRAMES_PER_PUBLISH = 256;
const TERMINAL_READ_MAX_FRAMES = 500;
/**
 * Body limit for one publish. The runner batches at 96 KiB of raw console, which
 * JSON escaping can inflate roughly 6x (every ESC becomes `\u001b`), so this is
 * the ceiling that batch is chosen to sit under.
 */
const TERMINAL_PUBLISH_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_DELEGATION_ITERATIONS = 10;

function isActiveRootUniquenessError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: unknown }).code !== "P2002"
  ) {
    return false;
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return (
    (Array.isArray(target) && target.includes("chatId")) ||
    (typeof target === "string" &&
      (target.includes("chatId") ||
        target.includes("DispatchJob_one_active_root_per_chat")))
  );
}

/**
 * Job-capability dispatch projection. Raw Prisma rows contain trusted-runner
 * fields (host/lease hash), model-produced terminal prose, steer text, and
 * execution profile details that are unnecessary for coordination. The
 * orchestrator receives job/lineage/status/budget coordinates and must use the
 * governed handoff/stream tools for untrusted worker content.
 */
function jobCapabilityDispatchView(
  job: DispatchJob & {
    lastProgressAt?: string | null;
    waitingApproval?: boolean;
    currentActivity?: string | null;
  }
) {
  return {
    id: job.id,
    kind: job.kind,
    vendor: job.vendor,
    taskId: job.taskId,
    brief: "",
    // The crew role is a COORDINATE, exactly like vendor and capabilityMode:
    // it says what a job is FOR, carries no model-produced text, and the
    // coordinator cannot report its crew without it.
    role: job.role,
    harnessKey: job.harnessKey,
    maxIterations: job.maxIterations,
    maxWallMs: job.maxWallMs,
    iterationTimeoutMs: job.iterationTimeoutMs,
    approvalTimeoutMs: job.approvalTimeoutMs,
    chatId: job.chatId,
    parentJobId: job.parentJobId,
    rootJobId: job.rootJobId,
    delegationDepth: job.delegationDepth,
    maxDelegationDepth: job.maxDelegationDepth,
    maxChildren: job.maxChildren,
    maxTotalDescendants: job.maxTotalDescendants,
    maxDelegationIterations: job.maxDelegationIterations,
    maxDescendantWallMs: job.maxDescendantWallMs,
    delegationChildrenIssued: job.delegationChildrenIssued,
    delegationDescendantsIssued: job.delegationDescendantsIssued,
    delegationBudgetReservedMs: job.delegationBudgetReservedMs,
    delegationBudgetConsumedMs: job.delegationBudgetConsumedMs,
    delegationDeadline: job.delegationDeadline,
    capabilityMode: job.capabilityMode,
    status: job.status,
    agentId: null,
    dispatchedBy: job.dispatchedBy,
    interruptRequested: job.interruptRequested,
    steerMessages: [],
    resumedFromJobId: job.resumedFromJobId,
    resumedAt: job.resumedAt,
    resumedByJobId: job.resumedByJobId,
    result: null,
    exitCode: job.exitCode,
    packetJson: null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    lastProgressAt: job.lastProgressAt ?? null,
    waitingApproval: job.waitingApproval ?? false,
    // Content-bearing assistant output never crosses the job-capability
    // projection. The operator projection may show a redacted lifecycle label;
    // agents receive only this coordinate-safe state.
    currentActivity: job.currentActivity ? "control-plane activity" : null,
  };
}

const runnerLeaseSchema = z.object({
  host: z.string().trim().min(1).max(200),
  leaseToken: z.string().min(32).max(512),
});

/**
 * B2: how long after a job's terminal write its own runner may still file the
 * memory it mined from that run. One extractor pass is capped at 120s, so this
 * is generous room for a slow pass plus retries — and still a closed window, not
 * an open-ended grant. See POST /:jobId/memory-capture.
 */
const MEMORY_CAPTURE_WINDOW_MS = 10 * 60_000;

/**
 * The COORDINATES of one captured note, and nothing else. Trust, scope,
 * createdBy, taskId and chatId are absent BY CONSTRUCTION — they are derived
 * from the stored job row at the route, so this body cannot declare authority.
 * Bounds mirror `createNoteSchema` in routes/memory.ts.
 */
const leaseMemoryCaptureSchema = runnerLeaseSchema.extend({
  note: z.object({
    kind: z.enum([
      "decision",
      "constraint",
      "convention",
      "attempt",
      "question",
    ]),
    text: z.string().min(3).max(8_000),
    laneId: z.string().min(1).optional(),
    modules: z.array(z.string().min(1)).max(128).default([]),
    topics: z.array(z.string().min(1)).max(128).default([]),
    symbols: z.array(z.string().min(1)).max(128).default([]),
    outcome: attemptOutcomeSchema.optional(),
  }),
});

const leaseContextFrameBeginSchema = z.intersection(
  runnerLeaseSchema,
  contextFrameBeginSchema
);
const leaseContextFrameDeliverySchema = z.intersection(
  runnerLeaseSchema,
  contextFrameDeliveryInputSchema
);
const leaseContextCondensationSchema = z.intersection(
  runnerLeaseSchema,
  contextCondensationInputSchema
);

async function loadContextFrame(frameId: string) {
  const frame = await prisma.contextFrame.findUnique({ where: { id: frameId } });
  if (!frame) return null;
  const [exposures, delivery] = await Promise.all([
    prisma.contextExposure.findMany({
      where: { frameId },
      orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
    }),
    prisma.contextFrameDelivery.findUnique({ where: { frameId } }),
  ]);
  return { ...frame, exposures, delivery };
}

async function loadContextCondensation(condensationId: string) {
  const condensation = await prisma.contextCondensation.findUnique({
    where: { id: condensationId },
  });
  if (!condensation) return null;
  const members = await prisma.contextCondensationMember.findMany({
    where: { condensationId },
    orderBy: [{ artifactKind: "asc" }, { artifactId: "asc" }],
  });
  return { ...condensation, members };
}

function comparableContextExposures(
  exposures: Array<{
    artifactKind: string;
    artifactId: string;
    eligible: boolean;
    included: boolean;
    reason: string;
    ordinal?: number | null;
    charCount?: number | null;
    trustTier?: string | null;
  }>
) {
  return exposures
    .map((exposure) => ({
      artifactKind: exposure.artifactKind,
      artifactId: exposure.artifactId,
      eligible: exposure.eligible,
      included: exposure.included,
      reason: exposure.reason,
      ...(exposure.ordinal == null ? {} : { ordinal: exposure.ordinal }),
      ...(exposure.charCount == null ? {} : { charCount: exposure.charCount }),
      ...(exposure.trustTier == null ? {} : { trustTier: exposure.trustTier }),
    }))
    .sort((a, b) =>
      `${a.artifactKind}\0${a.artifactId}\0${a.reason}`.localeCompare(
        `${b.artifactKind}\0${b.artifactId}\0${b.reason}`
      )
    );
}

function comparableCondensationMembers(
  members: Array<{ artifactKind: string; artifactId: string }>
) {
  return members
    .map((member) => ({
      artifactKind: member.artifactKind,
      artifactId: member.artifactId,
    }))
    .sort((a, b) =>
      `${a.artifactKind}\0${a.artifactId}`.localeCompare(
        `${b.artifactKind}\0${b.artifactId}`
      )
    );
}

function publicRunner(runner: {
  id: string;
  host: string;
  pid: number | null;
  status: string;
  lastSeenAt: Date;
  createdAt: Date;
}) {
  return {
    id: runner.id,
    host: runner.host,
    pid: runner.pid,
    status: runner.status,
    lastSeenAt: runner.lastSeenAt,
    createdAt: runner.createdAt,
  };
}

/**
 * Admitted at the VENDOR level, as a POSITIVE projection of the registry's
 * `authority.dispatchable` column (ADR-0022 C2) rather than a hand-written copy
 * of it. What each lane may actually be asked to DO is bounded separately by its
 * crew ROLE (lib/dispatch-role.ts), which is where cursor's read-only boundary
 * and opencode's scout-only ceiling are enforced.
 *
 * The DEV/TEST seam stays TWO-CONDITION and both conditions are stated here: the
 * registry marks the entry `dev-test`, AND `fakeVendorEnabled()` is read LIVE on
 * every call, so the seam is never baked into a schema at module load and a
 * normal production dispatch that names `fake` is rejected (400) before any job
 * is enqueued.
 */
function allowedDispatchVendors(): readonly VendorId[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      entry.authority.dispatchable &&
      (entry.visibility === "public" ||
        (entry.visibility === "dev-test" && seamOpen))
  );
}

/**
 * The same two-condition projection over `authority.delegatable`, for the vendor
 * a WORKER may name on its own child.
 *
 * This closes the asymmetry ADR-0022 §1.1 names: the delegate schema used to
 * hardcode its own four-vendor enum and omitted the `fake` seam that
 * `allowedDispatchVendors()` admits, so the dev/test double could be dispatched
 * but never delegated to. It is now the same table, read the same way, on both
 * routes. Widening the enum grants nothing on its own — the route still refuses
 * any vendor/role pair the registry's ceiling does not declare, still refuses a
 * child whose authority tier exceeds its parent's, and still refuses
 * `orchestrator` outright.
 */
function allowedDelegateVendors(): readonly VendorId[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      entry.authority.delegatable &&
      (entry.visibility === "public" ||
        (entry.visibility === "dev-test" && seamOpen))
  );
}

/**
 * Vendors MUON curates a MODEL CATALOGUE for — the registry's own `models`
 * column, which TODO 3.3 made the single source of that fact.
 *
 * This used to be `VendorKey` membership (`VENDOR_KEYS` / `PUBLIC_VENDOR_KEYS`),
 * which was a PROXY for the catalogue rather than the catalogue: it was only
 * ever right because the descriptor table and the registry happened to omit the
 * same vendor. Now that `VendorKey` IS `VendorId`, that proxy would have
 * silently ADMITTED every registered vendor — including one with `models: null`,
 * whose id would then be waved through unverified by the "no declared policy"
 * degrade path in the adapters. Reading the column directly keeps the refusal
 * bound to the thing the error message actually claims.
 *
 * The `fake` seam is unchanged and still second-gated: it carries a catalogue,
 * but a dev/test vendor is only dispatchable at all when `MUON_FAKE_VENDOR` is
 * live, which every route below checks independently.
 */
function vendorsWithModelCatalog(): readonly string[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      entry.models !== null &&
      (entry.visibility === "public" ||
        (entry.visibility === "dev-test" && seamOpen))
  );
}

/**
 * Vendors with a NON-EMPTY vendor-native action set (`/plan`, `/effort`, …).
 *
 * The sibling of `vendorsWithModelCatalog`, and split from it by TODO 3.3 for
 * the same reason: these were ONE predicate (`VendorKey` membership) standing in
 * for two different facts, which held only while a vendor missing a descriptor
 * was missing both. `opencode` now has a descriptor row whose `actions` are
 * deliberately EMPTY, so the action gate has to ask about actions — otherwise
 * the emptiness would read as "no restriction" here and the refusal below would
 * be replaced by a vaguer one from the resolver.
 */
function vendorsWithVendorActions(): readonly string[] {
  const seamOpen = fakeVendorEnabled();
  return vendorsWhere(
    (entry) =>
      VENDOR_CAPABILITY_DESCRIPTORS[entry.id].actions.length > 0 &&
      (entry.visibility === "public" ||
        (entry.visibility === "dev-test" && seamOpen))
  );
}

/**
 * A per-dispatch `model` override is only meaningful where MUON can VALIDATE the
 * value — otherwise the override is waved through unverified by the adapters'
 * "no declared policy" degrade path and fails opaquely at the vendor, after a
 * job row already exists.
 *
 * TODO 3.4 lifted this for `opencode` without weakening it, and the distinction
 * is worth keeping straight: the gate reads `entry.models !== null`, and `null`
 * now means "nothing about an id is checkable here" rather than "nobody has
 * curated a list yet". opencode declares `known: []` + `idShape`, so
 * `validateModelForVendor` refuses `sonnet` on FORM and admits
 * `anthropic/claude-sonnet-5` with a warning that names what went unverified.
 * A lane that can check neither form nor membership still gets this 400.
 */
function assertVendorHasModelCatalog(
  app: FastifyInstance,
  vendor: string
): void {
  if (vendorsWithModelCatalog().includes(vendor)) {
    return;
  }
  throw app.httpErrors.badRequest(
    `MUON has no managed model catalog for vendor '${vendor}', so a per-dispatch model override cannot be validated for it. Set the model on the '${vendor}' lane profile instead.`
  );
}

const createDispatchSchema = z.object({
  kind: z.enum(["auto", "oneshot", "loop", "session"]).default("auto"),
  vendor: z.string().min(1),
  taskId: z.string().min(1),
  brief: z.string().min(1),
  // VISION §2, the crew role this job RUNS AS. OPTIONAL on the wire and always
  // RESOLVED server-side (`resolveDispatchRole`): an omitted role is derived
  // from the chat's crew plan / the harness rather than left null, because a
  // roleless job has no peer identity and cannot use A2A at all.
  role: agentRoleSchema.optional(),
  harnessKey: z.string().min(1).optional(),
  maxIterations: z.number().int().min(1).max(10).optional(),
  maxWallMs: z.number().int().min(1).max(1_800_000).optional(),
  // Operator-authored chat roots may NARROW the aggregate descendant pool.
  // The default remains fleet-sized; this field can never raise beyond the
  // delegation-policy ceiling and is refused on non-chat/machine-continuation
  // paths below.
  maxDescendantWallMs: z
    .number()
    .int()
    .min(1)
    .max(DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS)
    .optional(),
  checks: z.array(harnessCheckSchema).max(20).optional(),
  iterationTimeoutMs: z.number().int().min(1).max(1_800_000).optional(),
  resumeVendorSessionId: z.string().min(1).max(512).optional(),
  approvalTimeoutMs: z.number().int().min(1).max(1_800_000).optional(),
  workspacePath: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  // The operator-authored Mission Chat turn, committed atomically with its
  // root DispatchJob. This prevents a losing concurrent sender from leaving
  // an orphan human message when the one-active-root CAS rejects its job.
  humanMessage: z.string().min(1).max(100_000).optional(),
  dispatchedBy: z.string().min(1).default("orchestrator"),
  // ADR-0013 #52 v2, an OPTIONAL vendor-native action. When present it is
  // resolved SERVER-SIDE (`resolveVendorAction`) and every guard is ENFORCED at
  // THIS route, since the tier comes from auth here (the UI/CLI resolve is
  // advisory). `actionVendor` selects the descriptor (defaults to `vendor`).
  action: z.string().min(1).optional(),
  actionVendor: z.string().min(1).optional(),
  actionArgs: z.array(z.string()).optional(),
  target: z.string().min(1).optional(),
  // S6, an OPTIONAL per-dispatch model override. Validated fail-closed against
  // the EXECUTION vendor via `validateModelForVendor` BEFORE anything reaches
  // vendor argv, then persisted as a merged `actionProfilePatch: {model}`. The
  // explicit field WINS over an `action:"model"` patch (precedence below). The
  // zod bound is coarse; the S5 helper is the real (guarded/flag-shape) guard.
  model: z.string().min(1).max(200).optional(),
  // Operator opt-in that unlocks a cloud/remote (egress-gated) action. Only
  // honored for the operator tier, an agent-tier caller cannot self-opt-in.
  egressOptIn: z.boolean().optional(),
  // An operator-approved, single-use gate for a one-shot full-auto action from
  // the agent tier (reused exactly like fleet resize / workflow apply).
  gateApprovalId: z.string().min(1).optional(),
  // Resume lineage (P0.1 checkpoint+resume, Slice C1): the TERMINAL job this
  // dispatch was explicitly re-created from by a human resume act. A resumed
  // job is deliberately a NEW ROOT (fresh budgets, unweakened delegation
  // fences — callers cannot set parentJobId/rootJobId here); the lineage lives
  // in this column alone. Guarded below: 400 unless the referenced job exists,
  // 409 unless it is terminal — an in-place "resume" of a live job is
  // structurally impossible.
  resumedFromJobId: z.string().min(1).optional(),
  // S4 MACHINE CONTINUATION — the ONE chat-root shape a non-operator caller may
  // create. The always-alive runner is AGENT tier, so the operator-only fence
  // below silently 403'd every auto-resume it ever attempted: a crew finished,
  // nothing woke the coordinator, and the mission's work reached nobody.
  //
  // An ENUMERATED literal, never a "not in the forbidden set" tier: a second
  // continuation kind is REFUSED until it is written here by name, so the
  // default for anything new is closed. `assertJobTerminalContinuation` then
  // constrains every other authority field on this request explicitly.
  continuation: z.literal("job-terminal").optional(),
  /** The exact TERMINAL governed child of this chat the continuation reconciles. */
  continuationJobId: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.maxIterations !== undefined && value.kind !== "loop") {
    ctx.addIssue({
      code: "custom",
      path: ["maxIterations"],
      message: "maxIterations is only valid for loop dispatches.",
    });
  }
  if (value.maxDescendantWallMs !== undefined && !value.chatId) {
    ctx.addIssue({
      code: "custom",
      path: ["maxDescendantWallMs"],
      message: "maxDescendantWallMs is only valid for a root orchestrator chat dispatch.",
    });
  }
  if (value.checks !== undefined && value.kind !== "loop") {
    ctx.addIssue({
      code: "custom",
      path: ["checks"],
      message: "checks are only valid for loop dispatches.",
    });
  }
  if (value.iterationTimeoutMs !== undefined && value.kind !== "loop") {
    ctx.addIssue({
      code: "custom",
      path: ["iterationTimeoutMs"],
      message: "iterationTimeoutMs is only valid for loop dispatches.",
    });
  }
  if (value.humanMessage !== undefined && !value.chatId) {
    ctx.addIssue({
      code: "custom",
      path: ["humanMessage"],
      message: "humanMessage is only valid for a root orchestrator chat dispatch.",
    });
  }
  if (value.humanMessage !== undefined && value.resumedFromJobId) {
    ctx.addIssue({
      code: "custom",
      path: ["humanMessage"],
      message: "A resumed dispatch cannot create a new human Mission Chat turn.",
    });
  }
  if (value.resumeVendorSessionId !== undefined && value.kind !== "session") {
    ctx.addIssue({
      code: "custom",
      path: ["resumeVendorSessionId"],
      message: "resumeVendorSessionId is only valid for session dispatches.",
    });
  }
  if (value.approvalTimeoutMs !== undefined && value.kind !== "session") {
    ctx.addIssue({
      code: "custom",
      path: ["approvalTimeoutMs"],
      message: "approvalTimeoutMs is only valid for session dispatches.",
    });
  }
  if (value.continuationJobId !== undefined && value.continuation === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["continuationJobId"],
      message: "continuationJobId is only valid with an explicit continuation kind.",
    });
  }
  if (value.continuation !== undefined) {
    if (value.continuationJobId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["continuationJobId"],
        message:
          "A machine continuation must name the exact terminal child job it reconciles.",
      });
    }
    if (!value.chatId) {
      ctx.addIssue({
        code: "custom",
        path: ["chatId"],
        message: "A machine continuation is a chat root and requires its chatId.",
      });
    }
    if (value.kind !== "session") {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "A machine continuation is a session turn.",
      });
    }
    if (value.humanMessage !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["humanMessage"],
        message: "A machine continuation never authors a human Mission Chat turn.",
      });
    }
  }
});

const delegateDispatchSchema = z
  .object({
    kind: z.enum(["auto", "oneshot", "loop", "session"]).default("auto"),
    // Every delegatable lane may take delegated work. The boundary that used to
    // be spelled here as a narrow vendor enum ("no cursor side door") now lives
    // on the ROLE: the route refuses any vendor/role pair the registry's ceiling
    // does not declare, so cursor is reachable for review-class work and
    // unreachable for anything that writes, and opencode is unreachable for
    // implementer.
    //
    // NOT a `z.enum`: the `fake` seam has to be read LIVE (a module-load enum
    // would freeze it), so the membership check runs per parse against
    // `allowedDelegateVendors()`. The refusal is still a 400 from the same
    // schema parse.
    vendor: z.string().min(1).superRefine((value, ctx) => {
      const allowed = allowedDelegateVendors();
      if (!(allowed as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: "custom",
          message: `Unknown vendor '${value}'. Expected one of: ${allowed.join(", ")}.`,
        });
      }
    }),
    taskId: z.string().min(1),
    brief: z.string().min(5),
    // A delegate is a WORKER: the route refuses `orchestrator` outright, and a
    // resolved role can never land there either (see resolveDispatchRole).
    role: agentRoleSchema.optional(),
    harnessKey: z.string().min(1).optional(),
    maxIterations: z.number().int().min(1).max(10).optional(),
    maxWallMs: z.number().int().min(1).max(1_800_000).optional(),
    workspacePath: z.string().min(1).optional(),
    // S6, an optional model override for the delegated child. Validated against
    // the child's EXECUTION vendor and persisted as the ONLY key of the child's
    // `actionProfilePatch` (nothing else may ride a delegate patch). `.strict()`
    // above still rejects any other stray field.
    model: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxIterations !== undefined && value.kind !== "loop") {
      ctx.addIssue({
        code: "custom",
        path: ["maxIterations"],
        message: "maxIterations is only valid for loop dispatches.",
      });
    }
  });

function delegationTokenMatches(tokenHash: string, token: string): boolean {
  const expected = Buffer.from(tokenHash, "hex");
  const actual = Buffer.from(hashRunnerLease(token), "hex");
  return (
    expected.length === actual.length &&
    expected.length > 0 &&
    timingSafeEqual(expected, actual)
  );
}

/**
 * THE ONE cross-tree control MUON allows: a chat's COORDINATOR SEAT terminating
 * work IT started, in an earlier turn of the SAME chat.
 *
 * Every turn enqueues a NEW root job, so the delegation tree — the coordinate
 * `requireJobControl` keys on — changes with every message. A coordinator that
 * dispatched a crew in turn 1 and had to stop it in turn 2 was refused with "a
 * job capability cannot control another delegation tree": its own children were
 * strangers to it. Both rounds then ran concurrently over the same files, which
 * is not something a coordinator can coordinate around. This is the mirror of
 * the anchor `6c486a5` corrected on the PROOF side — the mission is the chat —
 * applied to authority.
 *
 * Five conjuncts, all required, every one read from a STORED row and never from
 * the request:
 *   1. the caller holds the chat's coordinator seat (`capabilityMode`
 *      "orchestrator" OR ADR-0028's "attached-coordinator" — both are chat-
 *      scoped coordinator seats, never stamped onto a delegate/worker) and is
 *      itself a root. A delegate child gains nothing here.
 *   2. the target is a DELEGATED job, never a root: a coordinator may stop work
 *      it commissioned, never another coordinator's turn.
 *   3. the target is still non-terminal — this is recovery, not rewriting
 *      history.
 *   4. same chat as the caller, on the target itself.
 *   5. the target's ROOT is a coordinator root of that same chat, so the lineage
 *      is provably this chat's own and not a plain dispatch that merely carries
 *      a chatId.
 * Cross-chat stays refused BY CONSTRUCTION: 4 and 5 compare stored chatIds, and
 * a null chatId is never equal to another chat's id, so no non-chat job and no
 * other chat's tree is reachable.
 */
async function coordinatorControlsChatLineage(
  caller: {
    chatId: string | null;
    parentJobId: string | null;
    capabilityMode: string | null;
  },
  target: {
    id: string;
    chatId: string | null;
    parentJobId: string | null;
    rootJobId: string | null;
    status: string;
  }
): Promise<boolean> {
  if (
    !isChatCoordinatorSeat(caller.capabilityMode) ||
    caller.parentJobId !== null ||
    !caller.chatId ||
    !target.parentJobId ||
    !["queued", "running"].includes(target.status) ||
    target.chatId !== caller.chatId
  ) {
    return false;
  }
  const targetRoot = await prisma.dispatchJob.findUnique({
    where: { id: target.rootJobId ?? target.id },
    select: { chatId: true, parentJobId: true, capabilityMode: true },
  });
  return (
    isChatCoordinatorSeat(targetRoot?.capabilityMode ?? null) &&
    targetRoot!.parentJobId === null &&
    targetRoot!.chatId === caller.chatId
  );
}

/** `capabilityMode` values that hold a chat's coordinator seat (ADR-0028
 *  §4.2/§8: an attached coordinator inherits its chat exactly like a
 *  runner-spawned orchestrator). Kept as a helper rather than inlined so the
 *  two call sites in this predicate can't drift. */
function isChatCoordinatorSeat(capabilityMode: string | null): boolean {
  return (
    capabilityMode === "orchestrator" ||
    capabilityMode === ATTACHED_COORDINATOR_CAPABILITY_MODE
  );
}

async function requireJobControl(
  app: FastifyInstance,
  request: FastifyRequest,
  targetJobId: string,
  headers: Record<string, unknown>,
  /**
   * Opt-in per route, never a default. Only INTERRUPT takes it: terminating work
   * you started is recovery, while steering another turn's live session would be
   * a fresh content-bearing write into a job this caller does not own.
   */
  options: { coordinatorChatLineage?: boolean } = {}
) {
  const target = await prisma.dispatchJob.findUnique({
    where: { id: targetJobId },
  });
  if (!target) {
    throw app.httpErrors.notFound("The requested dispatch job does not exist.");
  }
  if (request.tier === "operator") {
    return target;
  }
  const callerJobId = headers["x-muon-caller-job-id"];
  const token = headers["x-muon-delegation-token"];
  if (
    typeof callerJobId !== "string" ||
    callerJobId.length === 0 ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512
  ) {
    throw app.httpErrors.forbidden(
      "Job control requires the exact caller's unexpired capability."
    );
  }
  if (
    request.agentJobCapability &&
    request.agentJobCapability.jobId !== callerJobId
  ) {
    throw app.httpErrors.forbidden(
      "The bearer capability and job-control caller must name the same active job."
    );
  }
  const [caller, grant] = await Promise.all([
    prisma.dispatchJob.findUnique({ where: { id: callerJobId } }),
    prisma.delegationGrant.findUnique({ where: { jobId: callerJobId } }),
  ]);
  if (
    !caller ||
    !["queued", "running"].includes(caller.status) ||
    !grant ||
    grant.expiresAt.getTime() <= Date.now() ||
    !delegationTokenMatches(grant.tokenHash, token)
  ) {
    throw app.httpErrors.forbidden(
      "Job control requires the exact caller's unexpired capability."
    );
  }
  const rootJobId = caller.rootJobId ?? caller.id;
  if ((target.rootJobId ?? target.id) !== rootJobId) {
    if (
      options.coordinatorChatLineage &&
      (await coordinatorControlsChatLineage(caller, target))
    ) {
      return target;
    }
    throw app.httpErrors.forbidden(
      "A job capability cannot control another delegation tree."
    );
  }
  if (target.id === caller.id) {
    return target;
  }
  const lineage = await prisma.dispatchJob.findMany({
    where: { OR: [{ id: rootJobId }, { rootJobId }] },
  });
  const byId = new Map(lineage.map((job) => [job.id, job]));
  let current = target;
  while (current.parentJobId) {
    if (current.parentJobId === caller.id) {
      return target;
    }
    const parent = byId.get(current.parentJobId);
    if (!parent) break;
    current = parent;
  }
  throw app.httpErrors.forbidden(
    "Children may control only their own descendant subtree."
  );
}

const updateDispatchSchema = z
  .object({
    status: z
      .enum(["queued", "running", "done", "failed", "interrupted"])
      .optional(),
    agentId: z.string().min(1).nullable().optional(),
    result: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    // Typed terminal handoff packet (P0.3). AGENT-PRODUCED UNTRUSTED DATA:
    // persisted verbatim on the job row, never instructions or authority.
    // A packet only ever rides a terminal status write, so the at-least-one-
    // field refine below stays untouched.
    packet: handoffPacketSchema.nullable().optional(),
    ...runnerLeaseSchema.shape,
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.agentId !== undefined ||
      value.result !== undefined ||
      value.exitCode !== undefined,
    {
      message: "At least one dispatch update field must be provided.",
    }
  );

const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

/**
 * Release a delegated child's reserved wall-clock back to the root pool on its
 * FIRST terminal transition, and record its ACTUAL spend. `delegationBudget-
 * ReservedMs` used to be increment-only, so the first default child reserved the
 * whole pool and every sibling deterministically 409'd; this is the matching
 * decrement. `remaining = maxWallMs − reserved − consumed`, so a child that
 * finishes early frees budget for its siblings.
 *
 * Callers MUST invoke this only from a first-transition branch (a `count === 1`
 * terminal write), never from the exact-replay path — a second release would
 * widen the fail-closed cap. The decrement is a GUARDED updateMany (`gte` the
 * child's own reservation) so it can NEVER drive `reserved` negative, and it
 * never RAISES a cap: the pool is untouched, unused reservation simply returns.
 * A guard miss (would-be-negative, e.g. a lost race) is a safe no-op.
 */
export async function releaseDelegationBudget(
  tx: Pick<typeof prisma, "dispatchJob">,
  job: {
    rootJobId: string | null;
    maxWallMs: number | null;
    startedAt: Date | null;
  },
  endedAt: Date
): Promise<void> {
  const reserved = job.maxWallMs ?? 0;
  if (!job.rootJobId || reserved <= 0) {
    return;
  }
  const elapsed = job.startedAt
    ? Math.max(0, endedAt.getTime() - job.startedAt.getTime())
    : 0;
  const consumed = Math.min(reserved, elapsed);
  await tx.dispatchJob.updateMany({
    where: {
      id: job.rootJobId,
      delegationBudgetReservedMs: { gte: reserved },
    },
    data: {
      delegationBudgetReservedMs: { decrement: reserved },
      delegationBudgetConsumedMs: { increment: consumed },
    },
  });
}

/** The subset of a DispatchJob row the S9 budget projection reads. */
type BudgetJobRow = {
  id: string;
  vendor: string;
  status: string;
  maxWallMs: number | null;
  maxDescendantWallMs: number | null;
  delegationBudgetReservedMs: number;
  delegationBudgetConsumedMs: number;
  delegationChildrenIssued: number;
  maxChildren: number | null;
  delegationDescendantsIssued: number;
  maxTotalDescendants: number | null;
  delegationDepth: number;
  maxDelegationDepth: number | null;
  delegationDeadline: Date | null;
  capabilityMode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
};

/**
 * Ms one child has actually spent by `at`, bounded by its own reservation — the
 * same accounting `releaseDelegationBudget` records on a terminal child, so the
 * per-child breakdown reconciles with the root's `consumedMs`. A terminal child
 * uses its recorded window (endedAt − startedAt); a running child shows live
 * elapsed; a not-yet-started child is 0.
 */
function childConsumedMs(job: BudgetJobRow, at: number): number {
  if (!job.startedAt) return 0;
  const reserved = job.maxWallMs ?? 0;
  const end = TERMINAL_STATUSES.has(job.status)
    ? job.endedAt?.getTime() ?? job.startedAt.getTime()
    : at;
  const elapsed = Math.max(0, end - job.startedAt.getTime());
  return reserved > 0 ? Math.min(reserved, elapsed) : elapsed;
}

/**
 * S9 budget projection: numbers + enums only, NEVER agent free-text (brief /
 * result are excluded so a visibility read can't be turned into a prose
 * amplification channel). `poolMs` is the fleet-scaled descendant pool for a v2
 * root, and DEGRADES to the root's own turn budget (`maxWallMs`) for an in-flight
 * v1 root that predates the pool — preserving v1 semantics exactly. `remainingMs`
 * is the same `pool − reserved − consumed` the delegate route enforces.
 */
function budgetView(
  root: BudgetJobRow,
  descendants: BudgetJobRow[],
  at: number
) {
  const poolMs = root.maxDescendantWallMs ?? root.maxWallMs ?? 0;
  const reservedMs = root.delegationBudgetReservedMs ?? 0;
  const consumedMs = root.delegationBudgetConsumedMs ?? 0;
  return {
    jobId: root.id,
    capabilityMode: root.capabilityMode ?? null,
    rootWallMs: root.maxWallMs ?? null,
    maxDescendantWallMs: root.maxDescendantWallMs ?? null,
    poolMs,
    reservedMs,
    consumedMs,
    remainingMs: Math.max(0, poolMs - reservedMs - consumedMs),
    deadlineAt: root.delegationDeadline
      ? root.delegationDeadline.toISOString()
      : null,
    childrenIssued: root.delegationChildrenIssued ?? 0,
    maxChildren: root.maxChildren ?? null,
    descendantsIssued: root.delegationDescendantsIssued ?? 0,
    maxDescendants: root.maxTotalDescendants ?? null,
    depth: root.delegationDepth ?? 0,
    maxDepth: root.maxDelegationDepth ?? null,
    children: descendants
      .filter((child) => child.id !== root.id)
      .map((child) => ({
        jobId: child.id,
        vendor: child.vendor,
        status: child.status,
        depth: child.delegationDepth ?? 0,
        // A terminal child has RELEASED its reservation back to the pool; an
        // in-flight child still holds it. Consumed reconciles with the root.
        reservedMs: TERMINAL_STATUSES.has(child.status)
          ? 0
          : child.maxWallMs ?? 0,
        consumedMs: childConsumedMs(child, at),
      })),
  };
}

/**
 * S9 operator budget RAISE. Raise-only (monotonic) and bounded by the same
 * ceiling the v2 root policy enforces (`DELEGATION_MAX_DESCENDANTS × per-child
 * cap`), so the pool is SIZED, never uncapped. `gateApprovalId` lets an
 * agent-tier caller redeem an operator-approved single-use gate (the orchestrator
 * can only FILE the request, never self-redeem).
 */
const raiseBudgetSchema = z
  .object({
    maxDescendantWallMs: z
      .number()
      .int()
      .min(1)
      .max(DELEGATION_MAX_DESCENDANTS * 1_800_000),
    gateApprovalId: z.string().min(1).optional(),
  })
  .strict();

async function appendSteerMessage(
  jobId: string,
  message: string,
  guard: Prisma.DispatchJobWhereInput = {}
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const job = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    if (!job) return { status: "missing" as const };
    const queue = Array.isArray(job.steerMessages)
      ? (job.steerMessages as string[])
      : [];
    const next = [...queue, message];
    const updated = await prisma.dispatchJob.updateMany({
      where: {
        id: jobId,
        ...guard,
        steerMessages: { equals: queue },
      },
      data: { steerMessages: next as Prisma.InputJsonValue },
    });
    if (updated.count === 1) {
      return {
        status: "ok" as const,
        job: { ...job, steerMessages: next },
      };
    }
  }
  return { status: "conflict" as const };
}

/** The persisted, action-derived columns of a DispatchJob create. */
type DispatchActionData = {
  action?: string;
  actionProfilePatch?: Prisma.InputJsonValue;
  actionArgvOverride?: Prisma.InputJsonValue;
  actionBriefPrefix?: string;
};

/** The action resolution outcome the route persists + surfaces to the caller. */
type ResolvedActionOutcome = { data: DispatchActionData; warnings: string[] };

/**
 * ADR-0013 #52 v2, resolve a vendor action SERVER-SIDE and ENFORCE all four
 * guards at the point of dispatch (the load-bearing fix over v1). Returns the
 * columns to persist on the job, or THROWS the appropriate 4xx:
 *
 *  • `refuse` (`--strict-mcp-config`)  → 400, never dispatched (the governed-brain
 *    MCP server is non-evictable).
 *  • `dispatch-gate` (one-shot full-auto) → the OPERATOR tier applies directly; an
 *    agent-tier caller MUST present a redeemed, tag-bound, operator-approved,
 *    single-use gate (reused exactly like `PUT /api/fleet` / workflow apply), else
 *    403 BEFORE any enqueue. Interactive full-auto is already downgraded (the
 *    bypass withheld), so it is harmless and needs no gate.
 *  • `egress-gate` (cloud/remote) → withheld unless the OPERATOR opted into egress.
 *  • `warn` (append system-prompt) → allowed; the resolver's warning is surfaced.
 *  • `!supported` (unknown/mode/arg mismatch, or a `-`-prefixed subcommand target)
 *    → 400 with the reason.
 *
 * Defensive backstop: re-run `sanitizeGuardedArgs` over the resolved argv AND the
 * profile-patch extraArgs before persisting, never trust that resolve already
 * stripped. (The spawned argv is ALSO re-sanitized at the adapter, belt+braces.)
 */
async function resolveAndEnforceAction(
  app: FastifyInstance,
  input: {
    action: string;
    actionVendor?: string;
    actionArgs?: string[];
    target?: string;
    egressOptIn?: boolean;
    gateApprovalId?: string;
    vendor: string;
    kind: "auto" | "oneshot" | "loop" | "session";
    tier: "operator" | "agent";
  }
): Promise<ResolvedActionOutcome> {
  // Which descriptor to resolve against (defaults to the dispatch lane). The
  // dev/test `fake` descriptor is admitted only when the seam is enabled.
  const descriptorVendor = (input.actionVendor ?? input.vendor) as VendorKey;
  const knownVendors = vendorsWithVendorActions();
  if (!knownVendors.includes(descriptorVendor)) {
    // Two different mistakes, two different messages: naming a bogus
    // `actionVendor` is a typo, while dispatching an action to a lane that has
    // no vendor-native action set at all (opencode) needs to say THAT, not
    // "unknown vendor" about a vendor the dispatch itself just accepted.
    throw app.httpErrors.badRequest(
      input.actionVendor
        ? `Unknown action vendor '${descriptorVendor}'. Expected one of: ${knownVendors.join(", ")}.`
        : `Vendor '${descriptorVendor}' has no vendor-native action set, so action '${input.action}' cannot be resolved for it. Dispatch it without an action, or name an actionVendor from: ${knownVendors.join(", ")}.`
    );
  }

  // Mode mirrors executeJob's interactive determination, it drives the
  // interactive full-auto downgrade (the bypass is withheld, canUseTool stays).
  // Both copies now ask the SAME registry question — "does this vendor have a
  // session driver" — instead of naming the two vendors that happen to have one
  // (ADR-0022 §1.2(c)).
  const interactive =
    input.kind === "session" ||
    (input.kind === "auto" && vendorSupportsInteractive(input.vendor));
  const mode: InvocationMode = interactive ? "interactive" : "one-shot";
  // Egress is OPERATOR-only: an agent-tier caller cannot self-opt into egress.
  const egressOptIn = input.egressOptIn === true && input.tier === "operator";

  const resolved = resolveVendorAction(descriptorVendor, input.action, {
    args: input.actionArgs,
    target: input.target,
    mode,
    egressOptIn,
  });

  // GUARD, unsupported / withheld: unknown action, wrong mode, missing/invalid
  // arg, a '-'-prefixed subcommand target, or cloud withheld (no egress opt-in).
  if (!resolved.supported) {
    throw app.httpErrors.badRequest(
      resolved.reason ?? `Action '${input.action}' is not available.`
    );
  }
  // GUARD, refuse (`--strict-mcp-config`): the governed brain is non-evictable.
  if (resolved.gate === "refuse" || resolved.refused) {
    throw app.httpErrors.badRequest(
      resolved.reason ??
        "Refused: the governed-brain MCP server is never evicted (no --strict-mcp-config)."
    );
  }
  // GUARD, dispatch-gate (one-shot full-auto). The interactive path is already
  // downgraded (harmless), so gate only a NON-downgraded full-auto: operator tier
  // passes; an agent-tier caller MUST redeem an operator gate bound to this exact
  // vendor+action. THIS is the v1 residual closed, full-auto no longer ships
  // ungated. Fail-closed: the atomic redeem consumes the gate before the enqueue.
  if (resolved.gate === "dispatch-gate" && !resolved.downgraded) {
    if (input.tier !== "operator") {
      // INFORMED-CONSENT INTEGRITY: bind the gate to the EXECUTION vendor
      // (`input.vendor`, the lane that actually runs), NOT the descriptor vendor
      // (`actionVendor`, which only selects the, vendor-agnostic for full-auto,
      // action definition). So the operator approves "full-auto on <the vendor that
      // runs>", and a gate for one vendor can't authorize full-auto on another.
      const redeemed =
        input.gateApprovalId !== undefined &&
        (await redeemGateAtRoute(
          prisma,
          input.gateApprovalId,
          dispatchActionGateTag(input.vendor, resolved.action?.id ?? input.action)
        ));
      if (!redeemed) {
        throw app.httpErrors.forbidden(
          "A one-shot full-auto vendor action from the agent tier requires an operator-approved, single-use gate bound to this exact vendor+action. File a gate (kind=gate) and retry with its gateApprovalId once the human approves; a used, mismatched, or non-gate approval is rejected."
        );
      }
    }
  }

  // DEFENSIVE BACKSTOP (route re-sanitize): never trust that the resolver already
  // stripped, re-run `sanitizeGuardedArgs` over BOTH the subcommand argv and the
  // profile-patch extraArgs, so `--strict-mcp-config` (and, interactive, a
  // permission bypass) can never be persisted onto the job in the first place.
  let profilePatch = resolved.profilePatch;
  if (profilePatch?.extraArgs && profilePatch.extraArgs.length > 0) {
    const sanitized = sanitizeGuardedArgs(profilePatch.extraArgs, { interactive });
    profilePatch = { ...profilePatch, extraArgs: sanitized.args };
  }
  let argvOverride = resolved.argvOverride;
  if (argvOverride) {
    const sanitized = sanitizeGuardedArgs(argvOverride.args, { interactive });
    argvOverride = { ...argvOverride, args: sanitized.args };
  }

  return {
    data: {
      action: resolved.action?.id ?? input.action,
      ...(profilePatch
        ? { actionProfilePatch: profilePatch as unknown as Prisma.InputJsonValue }
        : {}),
      ...(argvOverride
        ? { actionArgvOverride: argvOverride as unknown as Prisma.InputJsonValue }
        : {}),
      ...(resolved.briefPrefix ? { actionBriefPrefix: resolved.briefPrefix } : {}),
    },
    // Surface the resolver's warnings (e.g. a `warn`-gated system-prompt, or a
    // downgraded interactive full-auto) so the caller sees what MUON re-routed.
    warnings: resolved.warnings,
  };
}

/**
 * Admit ONE machine continuation: the always-alive runner opening a chat root
 * because a governed child of that chat reached terminal while the coordinator
 * was idle (S4 auto-resume).
 *
 * WHY THIS EXISTS. Chat roots are operator-only, and the runner is AGENT tier.
 * So every auto-resume the runner ever fired was refused with a 403 the
 * reconciler swallowed: the founder's crew finished, both children produced
 * real work, and nothing woke the coordinator — no continuation turn, no
 * queued reviewer, no final summary. The desktop's peer monitor defers entirely
 * whenever a runner is live, so there was no second driver either.
 *
 * BOUNDED SURFACE. Every authority field on the request is named here. Nothing
 * is derived by subtracting from a wider set, and no field rides in on a spread
 * — a field added to `createDispatchSchema` tomorrow is NOT admitted onto this
 * path until it is listed. The six things this path can never become:
 *   • another principal — it must be the runner's SHARED agent bearer, never a
 *     dispatched agent's per-job capability;
 *   • a human turn — `humanMessage` is refused (schema) and `dispatchedBy` is
 *     still derived from the tier, so the row cannot claim a human author;
 *   • a wider run — no gate redemption, egress opt-in, role claim, or resume
 *     lineage, and no vendor action except `effort` (below);
 *   • another lane — `vendor` must be the coordinator lane that owns THIS
 *     mission, read off the root job that dispatched the terminal child;
 *   • another kind of prompt — `brief` is the highest-authority field on this
 *     request (it becomes the coordinator's prompt, with orchestrator
 *     capabilityMode and a fresh delegation manifest), so it must have the
 *     shape of a wake and may not counterfeit MUON's trusted framing;
 *   • a replay — one terminal child seeds at most ONE continuation root, which
 *     is claimed durably rather than trusted to the caller.
 *
 * WHAT `model` AND `effort` ARE DOING HERE. A wake is the CONTINUATION of the
 * operator's own turn, so it has to run the way that turn ran; a wake that
 * silently dropped to the lane default would be a different turn. Both are
 * therefore admitted BY NAME and nothing else is: `model` is re-validated
 * fail-closed against the execution vendor downstream (`validateModelForVendor`),
 * and `effort` is a `gate: "none"` reasoning-level action with a constrained
 * argument — never a permission, sandbox, or egress lever.
 *
 * THE PRINCIPAL, PRECISELY. The shared agent bearer lives in the 0600
 * brain.lock and is withheld from vendor processes by the sandbox launcher's env
 * allowlist (only a per-job capability is injected). That is a real boundary,
 * not an impossibility proof: it is the macOS seatbelt profile + env allowlist
 * doing the holding, so on a platform without the sandbox, or with
 * MUON_SANDBOX=0, a shell-capable worker that can read the lockfile could
 * present this bearer. Which is exactly why the constraints above are enforced
 * HERE rather than being inferred from "only the runner can call this".
 *
 * The per-chat auto-turn cap that bounds how MANY of these may fire lives in
 * the reconcile core (AUTO_CONTINUE_CAP, counted durably off the chat lane);
 * this route bounds what ONE of them may be, and the replay claim below bounds
 * how many roots one terminal child can ever mint.
 */
async function assertJobTerminalContinuation(
  app: FastifyInstance,
  request: FastifyRequest,
  input: {
    continuation?: "job-terminal";
    continuationJobId?: string;
    chatId: string;
    kind: string;
    vendor: string;
    brief: string;
    action?: string;
    actionVendor?: string;
    actionArgs?: string[];
    gateApprovalId?: string;
    egressOptIn?: boolean;
    role?: string;
    resumedFromJobId?: string;
    maxDescendantWallMs?: number;
  }
): Promise<void> {
  const refuse = (why: string): never => {
    throw app.httpErrors.forbidden(
      `Only the human/operator surface may create a root orchestrator chat job. ${why}`
    );
  };
  if (input.continuation !== "job-terminal") {
    refuse(
      "The one exception is a job-terminal machine continuation, which must declare continuation:'job-terminal'."
    );
  }
  if (request.tier !== "agent" || request.agentJobCapability) {
    refuse(
      "A job-terminal continuation may only be filed by the runner's shared agent bearer, never by a dispatched agent's job capability."
    );
  }
  if (input.kind !== "session") {
    refuse("A job-terminal continuation is a session turn.");
  }
  if (
    input.gateApprovalId !== undefined ||
    input.egressOptIn !== undefined ||
    input.role !== undefined ||
    input.resumedFromJobId !== undefined ||
    input.maxDescendantWallMs !== undefined
  ) {
    refuse(
      "A job-terminal continuation carries no vendor action, gate redemption, egress opt-in, model override, role claim, or resume lineage."
    );
  }
  // `effort` and NOTHING else. A reasoning level is the one action a wake needs
  // to run the way the mission's own turn ran; every other action id — full-auto,
  // review, permission-mode — stays refused by falling off this exact check.
  if (input.action !== undefined) {
    const level = input.actionArgs ?? [];
    if (
      input.action !== "effort" ||
      (input.actionVendor !== undefined && input.actionVendor !== input.vendor) ||
      level.length !== 1 ||
      !level[0]
    ) {
      refuse(
        "The only vendor action a job-terminal continuation may carry is 'effort', on its own lane, with exactly one level."
      );
    }
  }
  assertWakeBriefShape(refuse, input.brief);
  const child = await prisma.dispatchJob.findUnique({
    where: { id: input.continuationJobId! },
    select: {
      id: true,
      chatId: true,
      parentJobId: true,
      rootJobId: true,
      status: true,
    },
  });
  if (
    !child ||
    child.chatId !== input.chatId ||
    !child.parentJobId ||
    !TERMINAL_STATUSES.has(child.status)
  ) {
    refuse(
      `continuationJobId '${input.continuationJobId}' must name a TERMINAL governed child job of this exact chat.`
    );
  }
  // The mission's coordinator seat, not "any dispatchable lane". A continuation
  // of a codex mission is a codex turn.
  const missionRootId = child!.rootJobId ?? child!.parentJobId!;
  const root = await prisma.dispatchJob.findUnique({
    where: { id: missionRootId },
    select: { id: true, vendor: true, chatId: true, capabilityMode: true },
  });
  if (
    !root ||
    root.chatId !== input.chatId ||
    root.capabilityMode !== "orchestrator" ||
    root.vendor !== input.vendor
  ) {
    refuse(
      `A job-terminal continuation must run on the coordinator lane that owns this mission (root '${missionRootId}'${
        root ? ` runs '${root.vendor}'` : " could not be read"
      }), not '${input.vendor}'.`
    );
  }
  // REPLAY BOUND, server-side. Without it the same terminal child could mint
  // unbounded chat roots: the only limit lived in the runner's own client, and a
  // bound that lives in the caller is not a bound. This is the advisory read;
  // the append-once claim written inside the admission transaction is the
  // authority under concurrency (unique (taskId, dedupeKey)).
  const seeded = await prisma.streamChunk.findFirst({
    where: {
      taskId: input.chatId,
      dedupeKey: continuationClaimKey(input.continuationJobId!),
    },
    select: { runId: true },
  });
  if (seeded) {
    throw app.httpErrors.conflict(
      `Terminal child '${input.continuationJobId}' has already seeded continuation root '${
        seeded.runId ?? "another dispatch"
      }'; one terminal event continues a mission at most once.`
    );
  }
}

/** The append-once key one terminal child's continuation root is claimed under. */
function continuationClaimKey(continuationJobId: string): string {
  return `continuation:job-terminal:${continuationJobId}`;
}

/**
 * A wake brief carries MUON's OWN trusted framing, so the caller may not
 * counterfeit more of it. The legitimate shape is exactly one
 * `job-terminal-continuation` control block plus the typed event envelope; a
 * dispatch contract, a human request, or a second control block would let a
 * caller-supplied string speak with MUON's voice to the coordinator.
 *
 * Shape-checking rather than deriving the brief server-side is deliberate: the
 * prompt is composed in @muon/orchestrator (system prompt + preamble + roster),
 * and moving that into the route would fork it. What the route can do — and
 * what actually bounds the authority — is refuse anything that is not a wake.
 */
function assertWakeBriefShape(
  refuse: (why: string) => never,
  brief: string
): void {
  const controlBlocks = brief.match(/<muon_control\b[^>]*>/g) ?? [];
  const wellFormed =
    brief.includes('<job_terminal_event encoding="json">') &&
    !brief.includes("<human_request") &&
    !brief.includes("<muon_dispatch_contract") &&
    controlBlocks.length <= 1 &&
    controlBlocks.every((tag) =>
      tag.startsWith('<muon_control kind="job-terminal-continuation"')
    );
  if (!wellFormed) {
    refuse(
      "A job-terminal continuation's brief must be a job-terminal wake: the typed event envelope, at most one job-terminal-continuation control block, and no dispatch contract or human request."
    );
  }
}

export async function registerDispatchRoutes(app: FastifyInstance) {
  app.post("/", async (request, reply) => {
    const {
      action,
      actionVendor,
      actionArgs,
      target,
      egressOptIn,
      gateApprovalId,
      model,
      humanMessage,
      role: requestedRole,
      dispatchedBy: rawDispatchedBy,
      // Admission-only fields: they gate WHO may open this chat root and are
      // never persisted onto the job, so they stay out of `dispatchFields`.
      continuation,
      continuationJobId,
      ...dispatchFields
    } = createDispatchSchema.parse(request.body);
    // VENDOR ALLOWLIST: reject an unknown vendor (and the dev/test `fake` vendor
    // unless its seam is explicitly enabled) with a 400, before any enqueue.
    const admittedVendors = allowedDispatchVendors();
    if (!admittedVendors.some((id) => id === dispatchFields.vendor)) {
      throw app.httpErrors.badRequest(
        `Unknown vendor '${dispatchFields.vendor}'. Expected one of: ${admittedVendors.join(", ")}.`
      );
    }
    // HARNESS ALLOWLIST (Wave 0): reject an unknown harnessKey with a clear 400
    // BEFORE enqueue, instead of letting the runner fail the job late (or the
    // caller silently retry harness-less into a lane-invalid profile). Omitting
    // harnessKey stays valid — that is the deliberate harness-less default.
    // The stored config rides along: it is what tells the role check whether
    // this harness writes.
    let harnessRow: HarnessRow;
    if (dispatchFields.harnessKey) {
      harnessRow = await prisma.harness.findUnique({
        where: { key: dispatchFields.harnessKey },
        select: { key: true, config: true },
      });
      if (!harnessRow) {
        throw app.httpErrors.badRequest(
          `Unknown harnessKey '${dispatchFields.harnessKey}'. Register it or dispatch without a harness.`
        );
      }
    }
    // WORKSPACE CONTAINMENT (P3-B / audit M2): a workspacePath becomes the child
    // process cwd + config-write base for the dispatched agent and the
    // check-runner. Constrain it to the allowlisted roots (cwd / home /
    // MUON_WORKSPACE_ROOTS) so a token-holder cannot aim the run at an arbitrary
    // directory (traversal / absolute / symlink escape) → 400.
    if (dispatchFields.workspacePath) {
      const check = validateWorkspacePath(dispatchFields.workspacePath);
      if (!check.ok) {
        throw app.httpErrors.badRequest(check.reason);
      }
      dispatchFields.workspacePath = check.path;
    }
    // PROVENANCE FROM AUTH (P3-A / H2 forgery class): `dispatchedBy` is derived
    // from the authenticated tier, not the body, an agent-tier caller cannot
    // stamp a forged "human:*" dispatcher on a job. (Dispatch itself is an AGENT
    // route, both tiers may enqueue work.)
    // RESUME LINEAGE GUARD (P0.1 Slice C1): a `resumedFromJobId` must name an
    // EXISTING job MUON stopped MID-WORK. Resume is for KILLED work only — a
    // completed, still-live, or genuinely-failed job is never replayed. That is
    // exactly the set the resume planner marks `human-review`, and it is two
    // classes, not one: an `interrupted` row, and the ONE kind of `failed` MUON
    // caused itself — a wall-budget kill (BUDGET_EXHAUSTED_MARKER). Keyed on the
    // shared marker rather than on `failed` broadly, so a vendor that failed on
    // its merits is still refused. Widened because the planner emitted
    // `human-review` + `muon bundle resume --redispatch <id>` for budget kills
    // while this refused every one of them: a printed plan whose only action
    // was a guaranteed 409. This is a cheap early refusal; the append-once claim
    // that actually fences the redispatch is stamped atomically at create time
    // below (P0.1 replay-safety), and admits the same two classes.
    if (dispatchFields.resumedFromJobId) {
      const original = await prisma.dispatchJob.findUnique({
        where: { id: dispatchFields.resumedFromJobId },
        select: { status: true, chatId: true, result: true },
      });
      if (!original) {
        throw app.httpErrors.badRequest(
          `resumedFromJobId '${dispatchFields.resumedFromJobId}' does not name an existing dispatch job.`
        );
      }
      const resumableOriginal =
        original.status === "interrupted" ||
        (original.status === "failed" && isBudgetExhausted(original.result));
      if (!resumableOriginal) {
        throw app.httpErrors.conflict(
          `resumedFromJobId '${dispatchFields.resumedFromJobId}' is '${original.status}'; only a job MUON stopped mid-work — interrupted, or failed because its own wall-clock budget ran out — can be resumed as a fresh dispatch (a completed, still-live, or genuinely failed job is never replayed).`
        );
      }
      // Resume lineage cannot be rebound across the Mission Chat partition.
      // In particular, omitting chatId from a chat-bound interrupted job used
      // to bypass the archived-chat fence, canonical task/workspace derivation,
      // and one-active-root admission. Plain jobs likewise cannot be attached
      // to a chat during replay: the original ledger coordinate is authority.
      if ((original.chatId ?? null) !== (dispatchFields.chatId ?? null)) {
        throw app.httpErrors.conflict(
          `resumedFromJobId '${dispatchFields.resumedFromJobId}' must be resumed through its exact owning chat partition.`
        );
      }
    }
    const dispatchedBy = authoringPrincipal(request.tier, rawDispatchedBy);
    if (dispatchFields.chatId && request.tier !== "operator") {
      // The ONE non-operator chat root: the runner's bounded S4 auto-resume.
      // Every other agent-tier attempt still 403s inside this helper.
      await assertJobTerminalContinuation(app, request, {
        continuation,
        continuationJobId,
        chatId: dispatchFields.chatId,
        kind: dispatchFields.kind,
        vendor: dispatchFields.vendor,
        brief: dispatchFields.brief,
        action,
        actionVendor,
        actionArgs,
        gateApprovalId,
        egressOptIn,
        role: requestedRole,
        resumedFromJobId: dispatchFields.resumedFromJobId,
        maxDescendantWallMs: dispatchFields.maxDescendantWallMs,
      });
    }
    if (dispatchFields.chatId) {
      const chat = await prisma.orchestratorChat.findUnique({
        where: { id: dispatchFields.chatId },
        select: {
          id: true,
          status: true,
          workspacePath: true,
          taskId: true,
          vendorSessionId: true,
          vendorSessionVendor: true,
          vendorSessionRootJobId: true,
        },
      });
      if (!chat) {
        throw app.httpErrors.notFound(
          "The owning orchestrator chat does not exist."
        );
      }
      if (chat.status !== "active") {
        throw app.httpErrors.conflict(
          "Cannot dispatch work for an archived orchestrator chat."
        );
      }
      // ADR-0036 D2/D6 — the dollar cap refuses NEW work.
      //
      // Here, and not in the runner: D2 says a cap never interrupts a lane in
      // flight. Cost arrives at the END of a vendor turn, so an in-flight kill
      // always overshoots the cap it was enforcing and strands partial,
      // unverified work in a worktree. Refusing the NEXT dispatch is the only
      // intervention that both lands on time and leaves the tree coherent.
      //
      // The verdict is a floor test, which D6 settles: `observed >= cap`
      // implies `actual >= cap` with certainty, so this refusal is never a
      // false brake. It can MISS — unreported lanes may already have passed
      // the cap — and that is why `capRefusesDispatch` is true for `exceeded`
      // alone and the message always carries its coverage. An `unenforceable`
      // cap does not stop work: refusing on a limit nothing can measure stops
      // a mission for a number nobody has.
      await assertMissionCostCap(dispatchFields.chatId, (message) => {
        throw app.httpErrors.conflict(message);
      });
      const chatWorkspace = validateWorkspacePath(chat.workspacePath);
      if (!chatWorkspace.ok) {
        throw app.httpErrors.badRequest(chatWorkspace.reason);
      }
      if (
        dispatchFields.workspacePath &&
        dispatchFields.workspacePath !== chatWorkspace.path
      ) {
        throw app.httpErrors.conflict(
          "The root dispatch workspace does not match its owning chat."
        );
      }
      // The chat record is the workspace authority. The renderer/orchestrator
      // may identify the chat, but it cannot rebind that chat to another cwd or
      // choose another chat/task partition.
      dispatchFields.workspacePath = chatWorkspace.path;
      dispatchFields.taskId = chat.taskId ?? chat.id;
      if (dispatchFields.resumeVendorSessionId !== undefined) {
        // G7, the chat-continuity binding. The lane must be one MUON actually
        // persists a handle for — asked of the registry, not of the vendor's
        // name — AND the chat's stored handle must be this exact lane's.
        if (
          !sessionCapability(dispatchFields.vendor).persistsSessionHandle ||
          chat.vendorSessionVendor !== dispatchFields.vendor ||
          chat.vendorSessionId !== dispatchFields.resumeVendorSessionId ||
          !chat.vendorSessionRootJobId
        ) {
          throw app.httpErrors.conflict(
            "The requested provider session is not the exact server-bound continuity handle for this chat and vendor."
          );
        }
      }
    }

    // CREW ROLE (VISION §2), resolved SERVER-SIDE and admitted FAIL-CLOSED
    // before anything is written. A root chat job is the coordinator seat, so it
    // runs as `orchestrator` unless the operator named something narrower;
    // everything else takes its role from the chat's crew plan, then its
    // harness, then the historical `implementer` default.
    //
    // `orchestrator` is the SEAT, and the seat is authenticated by the chat root
    // (operator-only, capabilityMode "orchestrator"), never by asking for it. A
    // plain job that stamped itself `orchestrator` would be claiming a peer
    // identity A2A fans role-addressed mail out to, so it is refused here.
    if (requestedRole === "orchestrator" && !dispatchFields.chatId) {
      throw app.httpErrors.badRequest(
        "The 'orchestrator' role belongs to a chat's root coordinator job and cannot be claimed by a plain dispatch. Dispatch it under a worker role, or start it as a chat root."
      );
    }
    const role = await resolveDispatchRole(prisma, {
      explicit: requestedRole,
      vendor: dispatchFields.vendor,
      chatId: dispatchFields.chatId,
      harnessKey: dispatchFields.harnessKey,
      coordinator: Boolean(dispatchFields.chatId),
    });
    assertVendorMayHoldRole(app, dispatchFields.vendor, role);
    assertRoleMatchesHarness(app, role, harnessRow);

    // ADR-0013 #52 v2, the vendor-native action surface, ENFORCED at the point of
    // dispatch. When `action` is present we resolve it SERVER-SIDE and make every
    // guard REAL here (the load-bearing fix over v1, which only LABELLED the gate):
    // the resolved patch/argv/prefix are persisted on the job and the runner
    // applies them at execution, reusing the plumbing v1 unit-tested.
    const resolvedAction = action
      ? await resolveAndEnforceAction(app, {
          action,
          actionVendor,
          actionArgs,
          target,
          egressOptIn,
          gateApprovalId,
          vendor: dispatchFields.vendor,
          kind: dispatchFields.kind,
          tier: request.tier,
        })
      : undefined;

    // S6, an OPTIONAL explicit model override. Validate it FAIL-CLOSED against
    // the EXECUTION vendor (the lane that actually runs) BEFORE it can reach any
    // vendor argv — an empty / guarded / flag-shaped or unknown-and-unsupported
    // id is a 400 guard-refusal; an unknown-but-custom id passes WITH a warning.
    const modelWarnings: string[] = [];
    // TODO 3.6: the Default sentinel validates as ok but must NOT be persisted
    // as a model override — that would hand `muon/default` to the compiler as a
    // literal id. Treat it as "no override" (same as omitting the field).
    const effectiveModel =
      model !== undefined && !isDefaultModel(model) ? model : undefined;
    if (model !== undefined && effectiveModel !== undefined) {
      assertVendorHasModelCatalog(app, dispatchFields.vendor);
      const modelCheck = validateModelForVendor(
        dispatchFields.vendor as VendorKey,
        effectiveModel
      );
      if (!modelCheck.ok) {
        throw app.httpErrors.badRequest(
          modelCheck.reason ??
            `Model '${effectiveModel}' is not valid for vendor '${dispatchFields.vendor}'.`
        );
      }
      if (modelCheck.warning) modelWarnings.push(modelCheck.warning);
    }
    // Persist the validated model as a MERGED `actionProfilePatch: {model}`; the
    // explicit field WINS over an `action:"model"` patch and leaves every other
    // resolved action column untouched (precedence: explicit dispatch model >
    // action patch > harness overlay > stored lane profile).
    const actionData = resolvedAction?.data ?? {};
    const mergedActionData =
      effectiveModel !== undefined
        ? {
            ...actionData,
            actionProfilePatch: {
              ...((actionData.actionProfilePatch as
                | Record<string, unknown>
                | undefined) ?? {}),
              model: effectiveModel,
            } as Prisma.InputJsonValue,
          }
        : actionData;

    const rootJobId = dispatchFields.chatId ? randomUUID() : undefined;
    // A resumed dispatch needs its child id KNOWN before the create so the
    // append-once claim can stamp `resumedByJobId` on the original in the SAME
    // transaction. A chat root already mints an explicit id (`rootJobId`); reuse
    // it, else mint one here. A plain (non-chat, non-resume) dispatch keeps its
    // auto-generated cuid.
    const explicitJobId =
      rootJobId ??
      (dispatchFields.resumedFromJobId ? randomUUID() : undefined);
    const rootBudgetMs =
      dispatchFields.chatId
        ? dispatchFields.maxWallMs ?? 1_800_000
        : undefined;
    // S3: the aggregate descendant pool is DECOUPLED from the root's own turn
    // timeout (`rootBudgetMs`). The super-orchestrator sits ABOVE the fleet, so
    // its pool is sized to the fleet — every descendant at the right-sized child
    // default — rather than to a single 30-min turn. Without this the first
    // default child reserved the whole turn budget and siblings 409'd.
    const rootDescendantPoolMs = dispatchFields.chatId
      ? dispatchFields.maxDescendantWallMs ??
        DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS
      : undefined;
    const rootDeadline =
      rootBudgetMs !== undefined
        ? new Date(Date.now() + rootBudgetMs)
        : undefined;
    if (dispatchFields.chatId && !dispatchFields.workspacePath) {
      throw app.httpErrors.badRequest(
        "A root orchestrator chat job requires a canonical workspace."
      );
    }
    const rootPolicy =
      rootJobId &&
      rootDeadline &&
      rootDescendantPoolMs !== undefined &&
      dispatchFields.workspacePath
        ? delegationRootPolicyV2Schema.parse({
            version: 2,
            jobId: rootJobId,
            workspacePath: dispatchFields.workspacePath,
            maxDepth: DELEGATION_MAX_DEPTH,
            maxChildrenPerParent: DELEGATION_MAX_CHILDREN,
            maxTotalDescendants: DELEGATION_MAX_DESCENDANTS,
            maxDescendantWallMs: rootDescendantPoolMs,
            maxIterations: DEFAULT_DELEGATION_ITERATIONS,
            deadlineAt: rootDeadline.toISOString(),
            authority: "orchestrator",
            childAuthority: "work",
            narrowingRequired: true,
          })
        : undefined;
    const createData = {
      ...(explicitJobId ? { id: explicitJobId } : {}),
      ...dispatchFields,
      role,
      ...(rootBudgetMs !== undefined ? { maxWallMs: rootBudgetMs } : {}),
      dispatchedBy,
      ...(dispatchFields.chatId
        ? {
            capabilityMode: "orchestrator",
            delegationDepth: 0,
            maxDelegationDepth: DELEGATION_MAX_DEPTH,
            maxChildren: DELEGATION_MAX_CHILDREN,
            maxTotalDescendants: DELEGATION_MAX_DESCENDANTS,
            maxDescendantWallMs: rootDescendantPoolMs,
            maxDelegationIterations: DEFAULT_DELEGATION_ITERATIONS,
            delegationDeadline: rootDeadline,
            delegationManifest: rootPolicy as unknown as Prisma.InputJsonValue,
          }
        : {}),
      ...mergedActionData,
    } satisfies Prisma.DispatchJobUncheckedCreateInput;

    // APPEND-ONCE RESUME CLAIM (P0.1 replay-safety): the redispatch is the only
    // write path that re-creates work, so it MUST be idempotent against a
    // second resume of the same original — sequential or concurrent. We claim
    // the ORIGINAL interrupted job with a guarded `updateMany` (CAS: WHERE
    // `resumedAt IS NULL`) and create the fresh child in ONE transaction, so the
    // stamp and the child are all-or-nothing. Only the FIRST resume matches
    // (`count === 1`); any later attempt matches 0 rows and is refused with a
    // 409 that names the claiming child but never echoes free text. This
    // write-once stamp is the ONLY mutation ever applied to the otherwise-
    // immutable interrupted row. Mirrors the gate-redemption CAS (lib/gate).
    const resumedFromJobId = dispatchFields.resumedFromJobId;
    const job = resumedFromJobId
      ? await prisma.$transaction(
          async (tx) => {
            if (dispatchFields.chatId) {
              const chat = await tx.orchestratorChat.findUnique({
                where: { id: dispatchFields.chatId },
                select: {
                  id: true,
                  status: true,
                  taskId: true,
                  vendorSessionId: true,
                  vendorSessionVendor: true,
                  vendorSessionRootJobId: true,
                },
              });
              if (chat?.status !== "active") {
                throw app.httpErrors.conflict(
                  "Cannot dispatch work for an archived orchestrator chat."
                );
              }
              if ((chat.taskId ?? chat.id) !== dispatchFields.taskId) {
                throw app.httpErrors.conflict(
                  "The chat task binding changed before resumed root admission."
                );
              }
              if (
                dispatchFields.resumeVendorSessionId !== undefined &&
                (!sessionCapability(dispatchFields.vendor)
                  .persistsSessionHandle ||
                  chat.vendorSessionVendor !== dispatchFields.vendor ||
                  chat.vendorSessionId !==
                    dispatchFields.resumeVendorSessionId ||
                  !chat.vendorSessionRootJobId)
              ) {
                throw app.httpErrors.conflict(
                  "The chat provider continuity binding changed before resumed root admission."
                );
              }
            }
            const childId = explicitJobId as string; // always set on the resume path
            const claim = await tx.dispatchJob.updateMany({
              where: {
                id: resumedFromJobId,
                resumedAt: null,
                // The SAME two resumable classes the early guard admits, re-
                // asserted atomically here because this CAS — not that read —
                // is the fence. `startsWith` on the shared marker constant is
                // the durable form of `isBudgetExhausted`: same token, no
                // second spelling of the rule. (Left at `status: "interrupted"`
                // it turned the widened guard into a 409 one layer deeper,
                // reported as "already resumed by another dispatch".)
                OR: [
                  { status: "interrupted" },
                  {
                    status: "failed",
                    result: { startsWith: BUDGET_EXHAUSTED_MARKER },
                  },
                ],
              },
              data: { resumedAt: new Date(), resumedByJobId: childId },
            });
            if (claim.count !== 1) {
              const current = await tx.dispatchJob.findUnique({
                where: { id: resumedFromJobId },
                select: { resumedByJobId: true },
              });
              throw app.httpErrors.conflict(
                `resumedFromJobId '${resumedFromJobId}' has already been resumed by job '${
                  current?.resumedByJobId ?? "another dispatch"
                }'; a terminal job is resumed at most once.`
              );
            }
            // ADR-0036 D2 — the cap, RE-CHECKED inside the transaction.
            //
            // The check before this block is advisory, exactly like the
            // continuation pre-check two screens down says of itself: it gives
            // a good refusal before the heavy work. THIS one is the fence.
            // Between the two, an operator can lower the cap and a finishing
            // turn can land its cost — and admitting work after the cap should
            // have refused it, because the read happened earlier, is the whole
            // class of bug a serializable transaction exists to close.
            await assertMissionCostCap(
              dispatchFields.chatId,
              (message) => {
                throw app.httpErrors.conflict(message);
              },
              tx
            );
            try {
              return await tx.dispatchJob.create({ data: createData });
            } catch (error) {
              if (
                dispatchFields.chatId &&
                isActiveRootUniquenessError(error)
              ) {
                throw app.httpErrors.conflict(
                  `Chat '${dispatchFields.chatId}' acquired another active root dispatch concurrently. Reattach to or interrupt that turn before resuming.`
                );
              }
              throw error;
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        )
      : dispatchFields.chatId
        ? await prisma.$transaction(
            async (tx) => {
              const chat = await tx.orchestratorChat.findUnique({
                where: { id: dispatchFields.chatId! },
                select: {
                  id: true,
                  status: true,
                  taskId: true,
                  vendorSessionId: true,
                  vendorSessionVendor: true,
                  vendorSessionRootJobId: true,
                },
              });
              if (chat?.status !== "active") {
                throw app.httpErrors.conflict(
                  "Cannot dispatch work for an archived orchestrator chat."
                );
              }
              if ((chat.taskId ?? chat.id) !== dispatchFields.taskId) {
                throw app.httpErrors.conflict(
                  "The chat task binding changed before root admission."
                );
              }
              if (
                dispatchFields.resumeVendorSessionId !== undefined &&
                (!sessionCapability(dispatchFields.vendor)
                  .persistsSessionHandle ||
                  chat.vendorSessionVendor !== dispatchFields.vendor ||
                  chat.vendorSessionId !==
                    dispatchFields.resumeVendorSessionId ||
                  !chat.vendorSessionRootJobId)
              ) {
                throw app.httpErrors.conflict(
                  "The chat provider continuity binding changed before root admission."
                );
              }
            // ADR-0036 D2 — the cap, RE-CHECKED inside the transaction.
              //
              // The check before this block is advisory, exactly like the
              // continuation pre-check two screens down says of itself: it gives
              // a good refusal before the heavy work. THIS one is the fence.
              // Between the two, an operator can lower the cap and a finishing
              // turn can land its cost — and admitting work after the cap should
              // have refused it, because the read happened earlier, is the whole
              // class of bug a serializable transaction exists to close.
              await assertMissionCostCap(
                dispatchFields.chatId,
                (message) => {
                  throw app.httpErrors.conflict(message);
                },
                tx
              );
              const activeRoot = await tx.dispatchJob.findFirst({
                where: {
                  chatId: dispatchFields.chatId!,
                  parentJobId: null,
                  status: { in: ["queued", "running"] },
                },
                select: { id: true, status: true },
              });
              if (activeRoot) {
                throw app.httpErrors.conflict(
                  `Chat '${dispatchFields.chatId}' already has active root dispatch '${activeRoot.id}' (${activeRoot.status}). Reattach to or interrupt that turn before starting another.`
                );
              }
              try {
                const created = await tx.dispatchJob.create({ data: createData });
                if (humanMessage !== undefined) {
                  await tx.streamChunk.create({
                    data: {
                      taskId: dispatchFields.chatId!,
                      laneId: "muon-chat",
                      runId: created.id,
                      kind: "user.message",
                      content: `[you] ${humanMessage}`,
                    },
                  });
                }
                // REPLAY BOUND (authority half): claim the terminal child that
                // seeded this wake, append-once on (taskId, dedupeKey). The
                // pre-check in assertJobTerminalContinuation is advisory; THIS is
                // what makes one terminal event continue a mission exactly once
                // even under concurrent runners. Doubles as the operator-visible
                // record of which child woke which root.
                if (continuationJobId !== undefined) {
                  await tx.streamChunk.create({
                    data: {
                      taskId: dispatchFields.chatId!,
                      laneId: "muon-chat",
                      runId: created.id,
                      dedupeKey: continuationClaimKey(continuationJobId),
                      kind: "milestone",
                      content: `[event] continuation root ${created.id} opened for terminal job ${continuationJobId}`,
                    },
                  });
                }
                return created;
              } catch (error) {
                // The partial unique index is the final authority under
                // concurrent requests. The read above exists only to return the
                // current job id when one is already visible.
                if (isActiveRootUniquenessError(error)) {
                  throw app.httpErrors.conflict(
                    `Chat '${dispatchFields.chatId}' acquired another active root dispatch concurrently. Reattach to or interrupt that turn before starting another.`
                  );
                }
                throw error;
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          )
        : await prisma.dispatchJob.create({ data: createData });
    reply.code(201);
    // F5 — every dispatch is an audit row: which principal launched which
    // vendor into which task. Best-effort; never fails the dispatch.
    try {
      await prisma.event.create({
        data: {
          ...(await requestAuditColumns(request)),
          laneId: job.vendor,
          taskId: job.taskId,
          kind: "dispatch.created",
          message: `dispatch ${job.kind}: ${job.vendor}${job.role ? ` as ${job.role}` : ""}`,
          metadata: { jobId: job.id, vendor: job.vendor, kind: job.kind },
        },
      });
    } catch (error) {
      console.error(
        `[audit] dispatch.created event failed for ${job.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    // A plain dispatch returns `{ job }` unchanged (back-compat); an action or
    // model dispatch additionally surfaces any warning it re-routed / flagged.
    const warnings = [...(resolvedAction?.warnings ?? []), ...modelWarnings];
    return warnings.length > 0 ? { job, warnings } : { job };
  });

  app.post("/:jobId/delegate", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const input = delegateDispatchSchema.parse(request.body);
    if (
      request.agentJobCapability &&
      request.agentJobCapability.jobId !== params.jobId
    ) {
      throw app.httpErrors.forbidden(
        "A job capability may delegate only from its exact parent job."
      );
    }
    await requireAgentTaskAccess(app, request, input.taskId);
    // A delegate is a WORKER. `orchestrator` is the coordinator SEAT — it is
    // authenticated by capabilityMode, never granted by asking — so a child that
    // names it is refused outright rather than silently downgraded.
    if (input.role === "orchestrator") {
      throw app.httpErrors.badRequest(
        "A delegated child is a worker and can never hold the 'orchestrator' role; that seat belongs to the chat's root job. Delegate under a worker role (implementer, reviewer, qa, architect, scout, docs)."
      );
    }
    // S6, validate the child model override FAIL-CLOSED against the child's
    // EXECUTION vendor before touching the DB (no side effects on a 400). An
    // agent tier may request a model but never bypass this guard.
    const modelWarnings: string[] = [];
    // TODO 3.6: same sentinel strip as the root dispatch path.
    const effectiveChildModel =
      input.model !== undefined && !isDefaultModel(input.model)
        ? input.model
        : undefined;
    if (input.model !== undefined && effectiveChildModel !== undefined) {
      assertVendorHasModelCatalog(app, input.vendor);
      const modelCheck = validateModelForVendor(
        input.vendor as VendorKey,
        effectiveChildModel
      );
      if (!modelCheck.ok) {
        throw app.httpErrors.badRequest(
          modelCheck.reason ??
            `Model '${effectiveChildModel}' is not valid for vendor '${input.vendor}'.`
        );
      }
      if (modelCheck.warning) modelWarnings.push(modelCheck.warning);
    }
    const rawToken = z
      .string()
      .min(32)
      .max(512)
      .parse(request.headers["x-muon-delegation-token"]);

    const job = await prisma.$transaction(
      async (tx) => {
        const parent = await tx.dispatchJob.findUnique({
          where: { id: params.jobId },
        });
        if (!parent) {
          throw app.httpErrors.notFound(
            "The parent dispatch job does not exist."
          );
        }
        if (parent.chatId) {
          const chat = await tx.orchestratorChat.findUnique({
            where: { id: parent.chatId },
            select: { status: true },
          });
          if (chat?.status !== "active") {
            throw app.httpErrors.conflict(
              "Delegation is closed because the owning chat is archived."
            );
          }
          // ADR-0036 D2 — a fan-out is NEW work, so the cap refuses it too.
          //
          // Both admission sites or neither. A cap that stopped the human's
          // next dispatch while an orchestrator kept spawning children would
          // be a limit on the one participant who can already see the number,
          // and none at all on the one that cannot stop itself.
          await assertMissionCostCap(
            parent.chatId,
            (message) => {
              throw app.httpErrors.conflict(message);
            },
            tx
          );
        }
        if (!["queued", "running"].includes(parent.status)) {
          throw app.httpErrors.conflict(
            "Delegation requires a queued or running parent job."
          );
        }
        if (parent.interruptRequested) {
          throw app.httpErrors.conflict(
            "Delegation is closed because cancellation has begun for this parent."
          );
        }
        // ADR-0028: an attached coordinator is a chat-scoped coordinator seat
        // exactly like a runner-spawned orchestrator — `dispatch` is one of
        // its positively-granted Tier C tools — so it may open the SAME
        // restricted delegate capability for its children.
        if (
          ![
            "orchestrator",
            "delegate",
            ATTACHED_COORDINATOR_CAPABILITY_MODE,
          ].includes(parent.capabilityMode ?? "")
        ) {
          throw app.httpErrors.forbidden(
            "This job does not hold the restricted delegate capability."
          );
        }
        const grant = await tx.delegationGrant.findUnique({
          where: { jobId: parent.id },
        });
        if (
          !grant ||
          grant.expiresAt.getTime() <= Date.now() ||
          !delegationTokenMatches(grant.tokenHash, rawToken)
        ) {
          throw app.httpErrors.forbidden(
            "The delegate capability is missing, expired, or bound to another job."
          );
        }

        // HARNESS ALLOWLIST (Wave 0): a delegate with an unknown harnessKey is
        // rejected here rather than failing the child late in the runner. Read
        // with its config, because the role admission below has to know whether
        // this harness writes.
        let harnessRow: HarnessRow;
        if (input.harnessKey) {
          harnessRow = await tx.harness.findUnique({
            where: { key: input.harnessKey },
            select: { key: true, config: true },
          });
          if (!harnessRow) {
            throw app.httpErrors.badRequest(
              `Unknown harnessKey '${input.harnessKey}'. Register it or delegate without a harness.`
            );
          }
        }

        // CREW ROLE (VISION §2) for the child, resolved from the PARENT's chat
        // partition — the crew plan is per chat, and the child inherits it. The
        // child is a worker, so `orchestrator` is unreachable even if a stale
        // binding names this vendor for it.
        const childRole = await resolveDispatchRole(tx, {
          explicit: input.role,
          vendor: input.vendor,
          chatId: parent.chatId,
          harnessKey: input.harnessKey,
          worker: true,
          parentRole: parent.role,
        });
        assertVendorMayHoldRole(app, input.vendor, childRole);
        assertRoleMatchesHarness(app, childRole, harnessRow);
        // DELEGATION NARROWS (bounded-surface rule): the child's authority tier
        // may not exceed its parent's, so a read-only worker cannot mint a
        // writing child and reach the vendor with authority it never held.
        assertDelegationWithinParent(app, {
          childRole,
          parentRole: parent.role,
          harness: harnessRow,
        });

        const rootJobId = parent.rootJobId ?? parent.id;
        const root =
          rootJobId === parent.id
            ? parent
            : await tx.dispatchJob.findUnique({ where: { id: rootJobId } });
        if (!root) {
          throw app.httpErrors.conflict(
            "The delegation root no longer exists."
          );
        }
        if (root.interruptRequested) {
          throw app.httpErrors.conflict(
            "Delegation is closed because cancellation has begun for this root."
          );
        }
        const rootPolicy = delegationRootPolicySchema.safeParse(
          root.delegationManifest
        );
        if (
          !rootPolicy.success ||
          rootPolicy.data.jobId !== root.id ||
          rootPolicy.data.workspacePath !== root.workspacePath ||
          rootPolicy.data.maxDepth !== root.maxDelegationDepth ||
          rootPolicy.data.maxChildrenPerParent !== root.maxChildren ||
          rootPolicy.data.maxTotalDescendants !== root.maxTotalDescendants ||
          rootPolicy.data.maxIterations !== root.maxDelegationIterations ||
          rootPolicy.data.deadlineAt !== root.delegationDeadline?.toISOString()
        ) {
          throw app.httpErrors.conflict(
            "The root delegation policy is missing or inconsistent."
          );
        }
        // S3: keep the fleet-scaled descendant pool in lockstep for v2 roots
        // (never "ignore unknown fields" — the strict union already forbids a
        // stray field, and the persisted column MUST equal the policy's pool). A
        // v1 in-flight root has no pool field and passes through unchanged.
        if (
          rootPolicy.data.version === 2 &&
          rootPolicy.data.maxDescendantWallMs !== root.maxDescendantWallMs
        ) {
          throw app.httpErrors.conflict(
            "The root delegation policy is missing or inconsistent."
          );
        }
        if (parent.capabilityMode === "delegate") {
          const parentManifest = delegationManifestSchema.safeParse(
            parent.delegationManifest
          );
          if (
            !parentManifest.success ||
            parentManifest.data.jobId !== parent.id ||
            parentManifest.data.parentJobId !== parent.parentJobId ||
            parentManifest.data.rootJobId !== root.id ||
            parentManifest.data.depth !== parent.delegationDepth ||
            parentManifest.data.workspacePath !== parent.workspacePath ||
            parentManifest.data.maxDepth !== parent.maxDelegationDepth ||
            parentManifest.data.maxChildrenPerParent !== parent.maxChildren ||
            parentManifest.data.maxTotalDescendants !==
              parent.maxTotalDescendants ||
            parentManifest.data.budget.maxWallMs !== parent.maxWallMs ||
            parentManifest.data.budget.maxIterations !==
              (parent.kind === "loop" ? parent.maxIterations ?? undefined : undefined) ||
            parentManifest.data.deadlineAt !==
              parent.delegationDeadline?.toISOString() ||
            parentManifest.data.delegationIterationCap !==
              parent.maxDelegationIterations
          ) {
            throw app.httpErrors.conflict(
              "The parent delegation manifest is missing or inconsistent."
            );
          }
          if (!parentManifest.data.canDelegate) {
            throw app.httpErrors.conflict(
              "This parent is at its delegation boundary."
            );
          }
        }

        const depth = (parent.delegationDepth ?? 0) + 1;
        const maxDepth = rootPolicy.data.maxDepth;
        const maxChildren = rootPolicy.data.maxChildrenPerParent;
        const maxTotalDescendants =
          rootPolicy.data.maxTotalDescendants;
        if (depth > maxDepth) {
          // ADR-0033: the observed depth and the cap were both just computed;
          // flattening them into a sentence made the agent unable to tell a
          // permanent ceiling from a transient one.
          refuseConflict(app, "agent", {
            rule: "delegation.depth",
            summary: `Delegation depth ${depth} exceeds the root max depth ${maxDepth}.`,
            surface: "delegation admission",
            evidence: [
              { label: "depth", value: depth },
              { label: "cap", value: maxDepth },
            ],
            nextAction: {
              kind: "none",
              because:
                "the depth ceiling is fixed for this mission; delegate from a shallower parent or do the work here",
            },
          });
        }

        const [directChildren, totalDescendants] = await Promise.all([
          // INTERRUPTED children do not consume the per-parent budget: an
          // interrupt is a deliberate stop (the coordinator/operator killing
          // a stalled lane), and counting it made stall-recovery a dead end —
          // a reviewer that hung for 16 minutes and was interrupted exhausted
          // the last slot, so its own replacement was refused with 409
          // (observed live, 2026-08-06). The ABSOLUTE anti-runaway bound is
          // untouched: `totalDescendants` below still counts every child
          // ever, interrupted included, so an interrupt-retry loop still
          // terminates at the root descendant ceiling.
          tx.dispatchJob.count({
            where: { parentJobId: parent.id, NOT: { status: "interrupted" } },
          }),
          tx.dispatchJob.count({ where: { rootJobId } }),
        ]);
        if (directChildren >= maxChildren) {
          refuseConflict(app, "agent", {
            rule: "delegation.children",
            summary: `Parent child limit ${maxChildren} is exhausted.`,
            surface: "delegation admission",
            evidence: [
              // The OBSERVED count, which the old message dropped — without it
              // the caller cannot tell "one slot short" from "nothing frees up".
              { label: "children", value: directChildren },
              { label: "cap", value: maxChildren },
            ],
            nextAction: {
              kind: "retry",
              after:
                "one of this parent's children finishes (an interrupted child already frees its slot)",
            },
          });
        }
        if (totalDescendants >= maxTotalDescendants) {
          refuseConflict(app, "agent", {
            rule: "delegation.descendants",
            summary: `Root descendant capacity ${maxTotalDescendants} is exhausted.`,
            surface: "delegation admission",
            evidence: [
              { label: "descendants", value: totalDescendants },
              { label: "cap", value: maxTotalDescendants },
            ],
            // Unlike the per-parent cap this one counts EVERY child ever,
            // interrupted included — it is the absolute anti-runaway bound, so
            // waiting does not free it.
            nextAction: {
              kind: "none",
              because:
                "this counts every descendant ever created, so finishing work does not free capacity; the mission needs an operator to raise it",
            },
          });
        }

        const rootWorkspace = rootPolicy.data.workspacePath;
        const workspaceCheck = validateWorkspacePath(
          input.workspacePath ?? parent.workspacePath ?? rootWorkspace,
          { roots: [rootWorkspace] }
        );
        if (!workspaceCheck.ok) {
          throw app.httpErrors.badRequest(workspaceCheck.reason);
        }
        const workspacePath = workspaceCheck.path;
        const deadline = root.delegationDeadline;
        if (!deadline) {
          throw app.httpErrors.conflict(
            "The root delegation deadline is missing."
          );
        }
        const remainingWallMs = Math.max(
          0,
          deadline.getTime() - Date.now()
        );
        const parentWallCap = parent.maxWallMs ?? remainingWallMs;
        // Root pool left AFTER released reservations and recorded spend. S3: the
        // pool is the DECOUPLED, fleet-scaled descendant budget for v2 roots; a v1
        // in-flight root (NULL column) falls back to its own turn budget, keeping
        // its prior semantics exactly. An omitted child budget takes a RIGHT-SIZED
        // share (DEFAULT_CHILD_WALL_MS) bounded by the parent cap, the wall-clock
        // remaining, and this pool — so it no longer grabs the whole pool and
        // starves its siblings. An explicit input.maxWallMs bypasses the default
        // and keeps the strict parent/root checks below.
        const descendantPool = root.maxDescendantWallMs ?? root.maxWallMs ?? 0;
        const remainingRootBudget =
          descendantPool -
          (root.delegationBudgetReservedMs ?? 0) -
          (root.delegationBudgetConsumedMs ?? 0);
        const maxWallMs =
          input.maxWallMs ??
          Math.min(
            DEFAULT_CHILD_WALL_MS,
            parentWallCap,
            remainingWallMs,
            remainingRootBudget
          );
        if (
          remainingWallMs < 1 ||
          maxWallMs > remainingWallMs ||
          maxWallMs > parentWallCap
        ) {
          throw app.httpErrors.badRequest(
            "Delegated wall-clock budget exceeds the parent/root remaining budget."
          );
        }
        const inheritedDelegationCap =
          parent.maxDelegationIterations ?? rootPolicy.data.maxIterations;
        const parentIterationCap =
          parent.kind === "loop"
            ? Math.min(
                parent.maxIterations ?? inheritedDelegationCap,
                inheritedDelegationCap
              )
            : inheritedDelegationCap;
        const maxIterations =
          input.kind === "loop"
            ? input.maxIterations ?? parentIterationCap
            : undefined;
        if (
          maxIterations !== undefined &&
          maxIterations > parentIterationCap
        ) {
          throw app.httpErrors.badRequest(
            "Delegated iteration budget cannot exceed the parent policy."
          );
        }

        // Aggregate pool check (formula computed above with released budget +
        // recorded spend). `< 1` also rejects a defaulted 0-budget child once the
        // pool is fully committed. Message kept byte-identical.
        if (maxWallMs > remainingRootBudget || remainingRootBudget < 1) {
          throw app.httpErrors.conflict(
            "The root aggregate descendant wall-clock budget is exhausted."
          );
        }
        const parentReservation =
          root.id === parent.id
            ? await tx.dispatchJob.updateMany({
                where: {
                  id: parent.id,
                  status: { in: ["queued", "running"] },
                  interruptRequested: false,
                  delegationChildrenIssued: { lt: maxChildren },
                  delegationDescendantsIssued: {
                    lt: maxTotalDescendants,
                  },
                  delegationBudgetReservedMs: {
                    lte: descendantPool - maxWallMs,
                  },
                },
                data: {
                  delegationChildrenIssued: { increment: 1 },
                  delegationDescendantsIssued: { increment: 1 },
                  delegationBudgetReservedMs: { increment: maxWallMs },
                },
              })
            : await tx.dispatchJob.updateMany({
                where: {
                  id: parent.id,
                  status: { in: ["queued", "running"] },
                  interruptRequested: false,
                  delegationChildrenIssued: { lt: maxChildren },
                },
                data: {
                  delegationChildrenIssued: { increment: 1 },
                },
              });
        if (parentReservation.count !== 1) {
          throw app.httpErrors.conflict(
            "The parent delegation capacity changed concurrently."
          );
        }
        if (root.id !== parent.id) {
          const rootReservation = await tx.dispatchJob.updateMany({
            where: {
              id: root.id,
              interruptRequested: false,
              delegationDescendantsIssued: {
                lt: maxTotalDescendants,
              },
              delegationBudgetReservedMs: {
                lte: descendantPool - maxWallMs,
              },
            },
            data: {
              delegationDescendantsIssued: { increment: 1 },
              delegationBudgetReservedMs: { increment: maxWallMs },
            },
          });
          if (rootReservation.count !== 1) {
            throw app.httpErrors.conflict(
              "The root delegation capacity changed concurrently."
            );
          }
        }

        const childId = randomUUID();
        const canDelegate =
          depth < maxDepth &&
          totalDescendants + 1 < maxTotalDescendants;
        const manifest = delegationManifestSchema.parse({
          version: 1,
          rootJobId,
          parentJobId: parent.id,
          jobId: childId,
          depth,
          maxDepth,
          maxChildrenPerParent: maxChildren,
          maxTotalDescendants,
          rootWorkspace,
          workspacePath,
          budget: {
            maxWallMs,
            ...(maxIterations !== undefined ? { maxIterations } : {}),
          },
          deadlineAt: deadline.toISOString(),
          delegationIterationCap: parentIterationCap,
          authority: "work",
          forbiddenAuthority: ["govern", "approve", "merge", "ship"],
          canDelegate,
          // Derived from the SINGLE source of truth the manifest validator
          // checks against, rather than re-composed from its parts. The
          // re-composed form (CONTEXT + delegate) silently drifted the moment a
          // new tier — A2A coordination — was added to the delegate capability
          // grant, and every delegate request began failing the manifest's own
          // `propagatedTools must equal the bounded delegate policy` refinement.
          // Producer and validator must read the same constant or the policy is
          // only as bounded as the weaker of two copies.
          propagatedTools: MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
            (name) => canDelegate || name !== "delegate"
          ),
          // ADR-0048: the parent attests what this child may do to FILES, and
          // the attestation is DERIVED from the harness's own contract rather
          // than from a caller field — a worktree-requiring harness (implement,
          // repair) exists to isolate edits, so it is the one honest signal
          // that this child is a writing child. No harness, or a harness that
          // works in place, mints `read`. The runner re-checks the same
          // harness contract at launch (defense in depth): a hand-edited
          // manifest cannot grant edit to a read-shaped harness.
          fileAuthority: harnessRequiresWorktree(harnessRow)
            ? ("edit" as const)
            : ("read" as const),
          narrowingAttested: true,
        });

        return tx.dispatchJob.create({
          data: {
            id: childId,
            kind: input.kind,
            vendor: input.vendor,
            taskId: input.taskId,
            brief: input.brief,
            role: childRole,
            ...(input.harnessKey ? { harnessKey: input.harnessKey } : {}),
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            maxWallMs,
            workspacePath,
            chatId: parent.chatId,
            parentJobId: parent.id,
            rootJobId,
            delegationDepth: depth,
            maxDelegationDepth: maxDepth,
            maxChildren,
            maxTotalDescendants,
            maxDelegationIterations: parentIterationCap,
            delegationDeadline: deadline,
            capabilityMode: "delegate",
            delegationManifest:
              manifest as unknown as Prisma.InputJsonValue,
            // S6, the ONLY action column a delegate child ever carries: the
            // validated {model} override. The runner defensively applies just
            // this key so a delegate patch can never widen the narrowed profile.
            ...(effectiveChildModel
              ? {
                  actionProfilePatch: {
                    model: effectiveChildModel,
                  } as Prisma.InputJsonValue,
                }
              : {}),
            dispatchedBy: request.agentJobCapability
              ? agentJobPrincipal(request.agentJobCapability)
              : authoringPrincipal(request.tier, "delegate"),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    reply.code(201);
    // Plain delegate returns `{ job }` (back-compat); a model override surfaces
    // any unverified-but-allowed warning so the caller can relay it.
    return modelWarnings.length > 0 ? { job, warnings: modelWarnings } : { job };
  });

  app.post("/:jobId/delegation-token", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema.parse(request.body ?? {});
    return prisma.$transaction(async (tx) => {
      const leaseHash = await requireActiveRunnerLease(
        app,
        tx,
        body.host,
        body.leaseToken
      );
      const job = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      if (
        !job ||
        job.status !== "running" ||
        job.host !== body.host ||
        job.runnerLeaseHash !== leaseHash
      ) {
        throw app.httpErrors.conflict(
          "Only the exact lease-holding runner may issue this job capability."
        );
      }
      const deadline =
        job.delegationDeadline ??
        new Date(
          Date.now() +
            (job.maxWallMs ?? 1_800_000) +
            5 * 60_000
        );
      if (deadline.getTime() <= Date.now()) {
        throw app.httpErrors.conflict(
          "The running job capability would already be expired."
        );
      }
      const canDelegate =
        job.capabilityMode === "orchestrator"
          ? true
          : job.capabilityMode === "delegate" &&
            delegationManifestSchema.safeParse(job.delegationManifest)
              .success &&
            delegationManifestSchema.parse(job.delegationManifest).canDelegate;
      const token = randomBytes(32).toString("hex");
      await tx.delegationGrant.upsert({
        where: { jobId: job.id },
        create: {
          jobId: job.id,
          tokenHash: hashRunnerLease(token),
          expiresAt: deadline,
        },
        update: {
          tokenHash: hashRunnerLease(token),
          expiresAt: deadline,
          issuedAt: new Date(),
        },
      });
      return { token, canDelegate };
    });
  });

  app.get("/", async (request) => {
    const query = z
      .object({
        status: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        chatId: z.string().min(1).optional(),
        activeOnly: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
        activeRootOnly: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
        latest: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);
    if (query.taskId) {
      await requireAgentTaskAccess(app, request, query.taskId);
    }
    if (
      request.agentJobCapability &&
      query.chatId &&
      query.chatId !== request.agentJobCapability.chatId
    ) {
      throw app.httpErrors.forbidden(
        "The active job capability cannot list another chat's dispatches."
      );
    }
    const requestedWhere = {
      ...(query.activeRootOnly
        ? {
            parentJobId: null,
            status: { in: ["queued", "running"] },
          }
        : query.activeOnly
        ? {
            status: { in: ["queued", "running"] },
            interruptRequested: false,
          }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.chatId ? { chatId: query.chatId } : {}),
    };
    const capabilityWhere = request.agentJobCapability
      ? isChatCoordinatorCapability(request.agentJobCapability)
        ? { chatId: request.agentJobCapability.chatId }
        : { id: request.agentJobCapability.jobId }
      : undefined;

    const jobs = await prisma.dispatchJob.findMany({
      where: capabilityWhere
        ? { AND: [requestedWhere, capabilityWhere] }
        : requestedWhere,
      orderBy: { createdAt: query.latest ? "desc" : "asc" },
      take: query.limit,
    });
    if (query.latest) jobs.reverse();

    // Run-scoped liveness and activity. Fleet Agent rows are reused, so agentId
    // alone can inherit a predecessor's heartbeat. StreamChunk.runId is the
    // exact dispatch coordinate; query the latest row per listed job in one
    // bounded read. Pending approvals are likewise fetched once by exact jobId.
    const jobIds = jobs.map((job) => job.id);
    const latestByRun = new Map<
      string,
      { timestamp: Date; kind: string; content: string }
    >();
    const waitingApprovalJobs = new Set<string>();
    if (jobIds.length > 0) {
      const [latestChunks, pendingApprovals] = await Promise.all([
        prisma.streamChunk.findMany({
          where: { runId: { in: jobIds } },
          orderBy: { seq: "desc" },
          distinct: ["runId"],
          select: {
            runId: true,
            timestamp: true,
            kind: true,
            content: true,
          },
        }),
        prisma.approvalRequest.findMany({
          where: { jobId: { in: jobIds }, status: "pending" },
          select: { jobId: true },
        }),
      ]);
      for (const row of latestChunks) {
        if (row.runId) {
          latestByRun.set(row.runId, {
            timestamp: row.timestamp,
            kind: row.kind,
            content: row.content,
          });
        }
      }
      for (const row of pendingApprovals) {
        if (row.jobId) waitingApprovalJobs.add(row.jobId);
      }
    }
    return {
      jobs: jobs.map((job) => {
        const latest = latestByRun.get(job.id);
        const lastProgressAt = latest?.timestamp.toISOString() ?? null;
        const currentActivity =
          latest &&
          latest.kind !== "output" &&
          latest.kind !== "output.message" &&
          latest.kind !== "reasoning"
            ? latest.content.slice(0, 200)
            : latest
              ? "Assistant response"
              : null;
        const view = {
          ...job,
          lastProgressAt,
          waitingApproval: waitingApprovalJobs.has(job.id),
          currentActivity,
        };
        return request.agentJobCapability
          ? jobCapabilityDispatchView(view)
          : view;
      }),
    };
  });

  app.get("/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    await requireAgentJobAccess(app, request, params.jobId);
    const job = await prisma.dispatchJob.findUnique({
      where: { id: params.jobId },
    });
    if (!job) {
      throw app.httpErrors.notFound("The requested dispatch job does not exist.");
    }
    return {
      job: request.agentJobCapability
        ? jobCapabilityDispatchView(job)
        : job,
    };
  });

  /**
   * S9 budget VISIBILITY (both tiers). Resolves the given job's ROOT and returns
   * the mission's pool / reserved / consumed / remaining, deadline, per-child
   * breakdown, and the depth/child/descendant caps — numbers + enums only, so a
   * read can never amplify agent free-text. Read-only; no gate.
   */
  app.get("/:jobId/budget", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    await requireAgentJobAccess(app, request, params.jobId);
    const job = await prisma.dispatchJob.findUnique({
      where: { id: params.jobId },
    });
    if (!job) {
      throw app.httpErrors.notFound("The requested dispatch job does not exist.");
    }
    const rootId = job.rootJobId ?? job.id;
    const root =
      rootId === job.id
        ? job
        : await prisma.dispatchJob.findUnique({ where: { id: rootId } });
    if (!root) {
      throw app.httpErrors.conflict(
        "The delegation root for this job no longer exists."
      );
    }
    const descendants = await prisma.dispatchJob.findMany({
      where: { rootJobId: rootId },
    });
    return { budget: budgetView(root, descendants, Date.now()) };
  });

  /**
   * S9 budget RAISE. The operator tier raises directly (the human's own
   * CLI/desktop/API act); an agent-tier caller (the orchestrator, after a budget
   * 409) MUST present a redeemed, tag-bound, operator-approved, single-use gate
   * for THIS exact root + new pool — it can only FILE the request, never redeem
   * it. The raise is monotonic (never lowers the fail-closed cap) and bounded by
   * the schema ceiling. Column AND the persisted v2 policy manifest are rewritten
   * in ONE transaction so the delegate route's root-policy consistency check
   * stays green. v1 in-flight roots (no pool) preserve their turn-budget
   * semantics and cannot be raised here.
   */
  app.patch("/:jobId/budget", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    await requireAgentJobAccess(app, request, params.jobId);
    const body = raiseBudgetSchema.parse(request.body);

    // Tier-conditional gate (ADR-0010 Part B pattern): the operator applies
    // directly; an agent-tier caller redeems a gate bound to this exact root +
    // pool. Fail-closed — the atomic consume precedes the write, so a later
    // conflict spends the gate (re-approval needed), security > a wasted gate.
    if (request.tier !== "operator") {
      const redeemed =
        body.gateApprovalId !== undefined &&
        (await redeemGateAtRoute(
          prisma,
          body.gateApprovalId,
          budgetRaiseGateTag(params.jobId, body.maxDescendantWallMs)
        ));
      if (!redeemed) {
        throw app.httpErrors.forbidden(
          "A delegation-budget raise from the agent tier requires an operator-approved, single-use gate bound to this exact job + pool. File a gate (kind=gate) and retry with its gateApprovalId once the human approves; a used, mismatched, or non-gate approval is rejected."
        );
      }
    }

    const root = await prisma.$transaction(
      async (tx) => {
        const job = await tx.dispatchJob.findUnique({
          where: { id: params.jobId },
        });
        if (!job) {
          throw app.httpErrors.notFound(
            "The requested dispatch job does not exist."
          );
        }
        if (job.capabilityMode !== "orchestrator" || job.rootJobId) {
          throw app.httpErrors.badRequest(
            "Budget raises target a root orchestrator job; delegated children share the root's pool."
          );
        }
        const currentPool = job.maxDescendantWallMs;
        if (currentPool === null || currentPool === undefined) {
          throw app.httpErrors.conflict(
            "This root predates the descendant pool; its budget follows the turn timeout and cannot be raised."
          );
        }
        if (body.maxDescendantWallMs <= currentPool) {
          throw app.httpErrors.badRequest(
            "A budget raise must increase the descendant pool above its current value."
          );
        }
        // Rewrite the persisted v2 policy in lockstep with the column so the
        // delegate route's root-policy consistency check keeps matching.
        const policy = delegationRootPolicyV2Schema.safeParse(
          job.delegationManifest
        );
        if (!policy.success || policy.data.jobId !== job.id) {
          throw app.httpErrors.conflict(
            "The root delegation policy is missing or inconsistent."
          );
        }
        const nextManifest = delegationRootPolicyV2Schema.parse({
          ...policy.data,
          maxDescendantWallMs: body.maxDescendantWallMs,
        });
        const result = await tx.dispatchJob.updateMany({
          // Monotonic guard: only raise from the exact pool we read, so a
          // concurrent raise cannot be silently clobbered.
          where: { id: job.id, maxDescendantWallMs: currentPool },
          data: {
            maxDescendantWallMs: body.maxDescendantWallMs,
            delegationManifest:
              nextManifest as unknown as Prisma.InputJsonValue,
          },
        });
        if (result.count !== 1) {
          throw app.httpErrors.conflict(
            "The root descendant pool changed concurrently; re-read and retry."
          );
        }
        return tx.dispatchJob.findUnique({ where: { id: job.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    if (!root) {
      throw app.httpErrors.conflict(
        "The dispatch job disappeared during the budget raise."
      );
    }
    const descendants = await prisma.dispatchJob.findMany({
      where: { rootJobId: root.id },
    });
    return { budget: budgetView(root, descendants, Date.now()) };
  });

  /**
   * One transaction reserves an idle fleet agent AND transitions the job
   * queued → running. A crash or lost response can no longer strand a working
   * agent between two HTTP calls. Replaying the exact committed lease returns
   * the same job+agent; every other competing claim receives 409.
   *
   * SQLite permits one writer. Concurrent DEFERRED transactions can all read
   * an idle seat and then fail while upgrading to writers instead of observing
   * the preceding commit. The embedded brain has one backend owner, so queue
   * only this short read→write critical section in-process. Requests still
   * arrive concurrently; each transaction sees the last committed claim and
   * either reserves another seat or returns the intended 409.
   */
  let dispatchClaimTail = Promise.resolve();
  const serializeDispatchClaim = async <T>(
    operation: () => Promise<T>
  ): Promise<T> => {
    const previous = dispatchClaimTail;
    let release: () => void = () => undefined;
    dispatchClaimTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  app.post("/:jobId/claim", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema.parse(request.body ?? {});

    const claimed = await serializeDispatchClaim(() =>
      prisma.$transaction(async (tx) => {
      const leaseHash = await requireActiveRunnerLease(
        app,
        tx,
        body.host,
        body.leaseToken
      );
      const existing = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      if (!existing) {
        throw app.httpErrors.notFound(
          "The requested dispatch job does not exist."
        );
      }

      if (
        existing.status === "running" &&
        existing.host === body.host &&
        existing.runnerLeaseHash === leaseHash &&
        existing.agentId
      ) {
        const agent = await tx.agent.findUnique({
          where: { id: existing.agentId },
        });
        if (
          agent?.status === "working" &&
          agent.currentJobId === existing.id
        ) {
          return { job: existing, agent };
        }
        throw app.httpErrors.conflict(
          "Dispatch claim exists, but its fleet-agent ownership is inconsistent."
        );
      }
      if (existing.status !== "queued") {
        throw app.httpErrors.conflict(
          "Dispatch job is not claimable (already taken)."
        );
      }

      // FD-6 topology: an orchestrator chat root claims ONLY the dedicated
      // coordinator lane (reserved ordinal 0) so a 30-min turn never consumes a
      // worker slot; every other (worker) job claims ordinal >= 1 and can never
      // grab the coordinator. Same lease-fenced, ordinal-ordered atomic claim.
      const ordinalScope =
        existing.capabilityMode === "orchestrator"
          ? COORDINATOR_ORDINAL
          : { gte: 1 };
      let agent = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const idle = await tx.agent.findFirst({
          where: {
            vendor: existing.vendor,
            status: "idle",
            ordinal: ordinalScope,
          },
          orderBy: { ordinal: "asc" },
        });
        if (!idle) break;
        const reserved = await tx.agent.updateMany({
          where: { id: idle.id, status: "idle" },
          data: {
            status: "working",
            currentTaskId: existing.taskId,
            currentJobId: existing.id,
            sessionId: null,
          },
        });
        if (reserved.count === 1) {
          agent = await tx.agent.findUnique({ where: { id: idle.id } });
          break;
        }
      }
      if (!agent) {
        throw app.httpErrors.conflict(
          `No idle '${existing.vendor}' fleet agent is available.`
        );
      }

      const result = await tx.dispatchJob.updateMany({
        where: { id: params.jobId, status: "queued" },
        data: {
          status: "running",
          startedAt: new Date(),
          agentId: agent.id,
          host: body.host,
          runnerLeaseHash: leaseHash,
        },
      });
      if (result.count !== 1) {
        throw app.httpErrors.conflict(
          "Dispatch job is not claimable (already taken)."
        );
      }
      const job = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      if (!job) {
        throw app.httpErrors.conflict(
          "Dispatch job disappeared during the claim transaction."
        );
      }
        return { job, agent };
      })
    );
    reply.code(201);
    return claimed;
  });

  app.patch("/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const payload = updateDispatchSchema.parse(request.body);
    const { host, leaseToken, ...update } = payload;
    if (
      update.packet &&
      Buffer.byteLength(JSON.stringify(update.packet), "utf8") > 262_144
    ) {
      throw app.httpErrors.badRequest(
        "Terminal handoff packet exceeds the 256KiB bound."
      );
    }

    const committed = await prisma.$transaction(async (tx) => {
      const leaseHash = await requireActiveRunnerLease(
        app,
        tx,
        host,
        leaseToken,
        // A transient brain outage can make the heartbeat timestamp stale while
        // the same runner is still finishing already-claimed work. The exact
        // lease hash remains authoritative until an operator-authorized
        // successor replaces it, so terminal commits must not strand the job
        // merely because freshness lapsed.
        { requireFresh: false }
      );
      const existing = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      if (!existing) {
        throw app.httpErrors.notFound(
          "The requested dispatch job does not exist."
        );
      }
      const requestedTerminal =
        update.status !== undefined && TERMINAL_STATUSES.has(update.status);
      const sameLease =
        existing.host === host && existing.runnerLeaseHash === leaseHash;

      // Assignment is immutable once the claim transaction chooses an agent.
      // Older runners may still echo the assigned id for idempotency, but no
      // caller can rewrite it through the terminal endpoint.
      if (
        update.agentId !== undefined &&
        update.agentId !== existing.agentId
      ) {
        throw app.httpErrors.conflict(
          "Dispatch agent assignment is immutable after claim."
        );
      }

      if (TERMINAL_STATUSES.has(existing.status)) {
        // Deliberately does NOT compare `packet`: an exact leased retry (same
        // status/result/exitCode) returns the stored row whatever packet rode along.
        const exactReplay =
          sameLease &&
          requestedTerminal &&
          update.status === existing.status &&
          (update.result === undefined || update.result === existing.result) &&
          (update.exitCode === undefined ||
            update.exitCode === existing.exitCode);
        if (exactReplay) {
          // The first transition already filed this job's handoff; a leased
          // retry must not file a second one.
          return { job: existing, handoff: undefined };
        }
        throw app.httpErrors.conflict(
          "Dispatch job is already terminal; only an exact leased retry is accepted."
        );
      }
      if (existing.status === "running" && !sameLease) {
        throw app.httpErrors.conflict(
          "Dispatch job belongs to a different runner lease."
        );
      }
      if (
        !requestedTerminal ||
        (existing.status !== "queued" && existing.status !== "running")
      ) {
        throw app.httpErrors.conflict(
          "The leased update must be a one-way queued/running → terminal transition."
        );
      }

      const terminalAt = new Date();
      const result = await tx.dispatchJob.updateMany({
        where: {
          id: params.jobId,
          status: existing.status,
          ...(existing.status === "running" ? { runnerLeaseHash: leaseHash } : {}),
        },
        data: {
          status: update.status,
          ...(update.result !== undefined ? { result: update.result } : {}),
          ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
          // A null packet on the wire means "no packet"; the column stays NULL.
          ...(update.packet !== undefined
            ? {
                packetJson:
                  update.packet === null
                    ? Prisma.DbNull
                    : (update.packet as Prisma.InputJsonValue),
              }
            : {}),
          ...(existing.status === "queued"
            ? { host, runnerLeaseHash: leaseHash }
            : {}),
          endedAt: terminalAt,
        },
      });
      if (result.count !== 1) {
        throw app.httpErrors.conflict(
          "Dispatch job changed before the leased update could commit."
        );
      }
      // FIRST terminal transition (count === 1): return this child's reserved
      // wall-clock to the root pool and record its spend. The exact-replay path
      // above returns before reaching here, so a retry never double-releases.
      await releaseDelegationBudget(tx, existing, terminalAt);
      if (
        existing.status === "running" &&
        existing.agentId
      ) {
        await tx.agent.updateMany({
          where: {
            id: existing.agentId,
            currentTaskId: existing.taskId,
            currentJobId: existing.id,
            status: "working",
          },
          data: {
            status: "idle",
            currentTaskId: null,
            currentJobId: null,
            sessionId: null,
          },
        });
      }
      // P0-2 (second half): the packet becomes a HANDOFF ROW here, in the same
      // transaction as the terminal status. The runner has always built a
      // correct typed packet and stored it on the job row, and `handoff_read`
      // has always read `Task.handoffs` — two halves that were never joined, so
      // every governed child reported `handoffCount 0` and every coordinator
      // fell back to reading stream prose. Filing it here (not after the
      // commit) means there is no window in which a job is terminal and its
      // record is missing.
      const handoff = await fileTerminalHandoff(
        tx,
        existing,
        update.packet ?? null,
        update.status!
      );
      const job = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      return { job, handoff };
    });
    // Same lane/handoff provenance the agent-facing handoff route mirrors, and
    // fire-and-forget for the same reason: the graph is a derived projection,
    // never the record. No lane upsert is needed here — boot projects every
    // lane node (index.ts) — and a MATCH that finds none simply lands no edge.
    const filed = committed.handoff;
    if (filed) {
      mirrorToGraph(async (graph) => {
        await graph.recordHandoff({
          handoffId: filed.id,
          taskId: filed.taskId,
          fromLaneId: filed.fromLaneId,
          toLaneId: filed.toLaneId,
          status: filed.status,
          createdAt: filed.createdAt.toISOString(),
        });
      });
    }
    return { job: committed.job };
  });

  /**
   * B2: memory capture AFTER the job's terminal write, fenced by the same
   * runner lease that owned it.
   *
   * WHY THIS EXISTS AT ALL. Mining a finished job for durable notes costs a
   * whole extra one-shot vendor lane run (up to 120s). It used to run INSIDE
   * `executeJob`, i.e. before the terminal write — so the fleet seat stayed
   * claimed and Mission Chat kept spinning for two minutes after the assistant's
   * last token. Moving it after the terminal write fixes both, but a per-job
   * capability is deliberately dead the instant its job stops being `running`
   * (`resolveActiveAgentJobCapability`), and extending THAT would widen the
   * window on the credential a VENDOR process holds. It is not widened. The
   * runner comes in through this door instead.
   *
   * WHY THE LEASE IS THE RIGHT AUTHORITY. This changes WHEN a note is written,
   * never WHO writes it or WHAT it may say. The lease-holding runner could
   * already write exactly these notes a millisecond earlier through the job
   * capability it issues itself, and it is the same authority that declares the
   * job done and releases its agent. It is not the vendor's credential: the
   * lease token lives in the runner process and is never placed on a vendor's
   * argv or env.
   *
   * BOUNDED-SURFACE COMPLETENESS. Every authority-bearing field is derived from
   * the STORED job row, never from the body — and the body is built field by
   * field, never spread:
   *   • principal/author  ← `agentJobPrincipal` on the stored job (identical to
   *                         what the agent-tier POST /api/memory derives today).
   *   • taskId / chatId   ← `agentMemoryPartition` on the stored job.
   *   • workspacePath     ← `repoRootOf(job.workspacePath)` (ADR-0026). Mined
   *                         memory is the VOLUME path into the brain, so a
   *                         partition derived only at POST /api/memory would
   *                         leave most agent notes in the §8 residue — invisible
   *                         to every agent read once the fence lands. Read from
   *                         the STORED job row, never from the body, and reduced
   *                         to the parent repo so a worktree-bound job does not
   *                         mint its own island.
   *   • proposalOnly      ← always true: this is agent-authored memory, so it
   *                         stays a proposal behind the human gate.
   *   • trust             ← NOT accepted; the ledger derives it from the author.
   *   • scope             ← NOT accepted, so this door can never mint a global
   *                         note (a human governance act, ADR B6).
   * What remains is coordinates: kind, text, laneId and the anchor arrays.
   */
  app.post("/:jobId/memory-capture", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = leaseMemoryCaptureSchema.parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken,
      // Same reasoning as the terminal write above: a transient brain outage can
      // stale the heartbeat while the same runner is still finishing the work it
      // already owns. The exact lease hash remains authoritative.
      { requireFresh: false }
    );
    const job = await prisma.dispatchJob.findUnique({
      where: { id: params.jobId },
    });
    if (
      !job ||
      job.host !== body.host ||
      job.runnerLeaseHash !== leaseHash
    ) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner may capture memory for this job."
      );
    }
    // A BOUNDED trailing window, not an open one. The capture belongs to the run
    // that just ended: one extractor pass is hard-capped at 120s, so this leaves
    // generous room for retries and a slow ingest while still refusing a runner
    // that tries to write against a long-dead job.
    const endedAt = job.endedAt?.getTime();
    const withinWindow =
      job.status === "running" ||
      (endedAt !== undefined &&
        Date.now() - endedAt <= MEMORY_CAPTURE_WINDOW_MS);
    if (!withinWindow) {
      throw app.httpErrors.conflict(
        "The post-terminal memory-capture window for this job has closed."
      );
    }
    const capability = {
      jobId: job.id,
      taskId: job.taskId,
      vendor: job.vendor,
      ...(job.chatId ? { chatId: job.chatId } : {}),
      ...(job.workspacePath ? { workspacePath: job.workspacePath } : {}),
    };
    const workspacePath = capability.workspacePath
      ? await repoRootOf(capability.workspacePath)
      : undefined;
    const result = await ingestMemoryNote({
      kind: body.note.kind,
      text: body.note.text,
      laneId: body.note.laneId,
      modules: body.note.modules,
      topics: body.note.topics,
      symbols: body.note.symbols,
      outcome: body.note.outcome,
      createdBy: agentJobPrincipal(capability),
      taskId: capability.taskId,
      chatId: agentMemoryPartition(capability),
      ...(workspacePath ? { workspacePath } : {}),
      proposalOnly: true,
    });
    reply.code(201);
    return {
      note: result.note,
      action: result.action,
      relatedNoteId: result.relatedNoteId ?? null,
    };
  });

  /**
   * TODO 5.5 — begin one immutable context frame BEFORE bytes cross a vendor
   * boundary. Only the exact lease-holding runner may write this evidence; the
   * bearer given to the vendor never receives the lease token. Task/workspace/
   * mission/lane coordinates are derived from the stored job, never the body.
   */
  app.post("/:jobId/context/frames", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = leaseContextFrameBeginSchema.parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken
    );
    const ownedJob = await prisma.dispatchJob.findFirst({
      where: {
        id: params.jobId,
        status: "running",
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      select: { id: true },
    });
    if (!ownedJob) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner of a running job may begin context evidence."
      );
    }
    const existing = await prisma.contextFrame.findUnique({
      where: {
        jobId_clientRequestId: {
          jobId: params.jobId,
          clientRequestId: body.clientRequestId,
        },
      },
    });
    if (existing) {
      const loaded = await loadContextFrame(existing.id);
      const existingExposures = comparableContextExposures(
        loaded?.exposures ?? []
      );
      if (
        existing.source !== body.source ||
        existing.content !== body.content ||
        JSON.stringify(existingExposures) !==
          JSON.stringify(comparableContextExposures(body.exposures))
      ) {
        throw app.httpErrors.conflict(
          "This context-frame request id was already used with a different payload."
        );
      }
      return { frame: loaded };
    }

    const frame = await prisma.$transaction(
      async (tx) => {
        const job = await tx.dispatchJob.findFirst({
          where: {
            id: params.jobId,
            status: "running",
            host: body.host,
            runnerLeaseHash: leaseHash,
          },
          select: {
            id: true,
            taskId: true,
            vendor: true,
            workspacePath: true,
            chatId: true,
            rootJobId: true,
          },
        });
        if (!job) {
          throw app.httpErrors.conflict(
            "Only the exact lease-holding runner of a running job may begin context evidence."
          );
        }
        const lane = await tx.lane.findUnique({
          where: { key: job.vendor },
          select: { id: true },
        });
        if (!lane) {
          throw app.httpErrors.conflict(
            "Context evidence cannot resolve the job's registered lane."
          );
        }
        const sequence = await tx.contextFrame.aggregate({
          where: { jobId: job.id },
          _max: { turnSeq: true },
        });
        const created = await tx.contextFrame.create({
          data: {
            clientRequestId: body.clientRequestId,
            jobId: job.id,
            taskId: job.taskId,
            laneId: lane.id,
            workspacePath: job.workspacePath,
            chatId: job.chatId,
            missionId: job.rootJobId ?? job.id,
            turnSeq: (sequence._max.turnSeq ?? 0) + 1,
            source: body.source,
            completeness: "muon_supplied",
            content: body.content,
            contentSha256: `sha256:${createHash("sha256")
              .update(body.content)
              .digest("hex")}`,
            charCount: body.content.length,
            // Honest estimate, visibly named as such on the read contract. No
            // tokenizer dependency and no claim about a vendor's tokenization.
            tokenEstimate: Math.ceil(body.content.length / 4),
          },
        });
        if (body.exposures.length > 0) {
          await tx.contextExposure.createMany({
            data: body.exposures.map((exposure) => ({
              frameId: created.id,
              ...exposure,
            })),
          });
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    reply.code(201);
    return { frame: await loadContextFrame(frame.id) };
  });

  /** Append the terminal receipt; ContextFrame itself is never updated. */
  app.post("/:jobId/context/frames/:frameId/delivery", async (request, reply) => {
    const params = z
      .object({ jobId: z.string().min(1), frameId: z.string().min(1) })
      .parse(request.params);
    const body = leaseContextFrameDeliverySchema.parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken,
      { requireFresh: false }
    );
    const job = await prisma.dispatchJob.findFirst({
      where: {
        id: params.jobId,
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      select: { id: true },
    });
    const frame = await prisma.contextFrame.findFirst({
      where: { id: params.frameId, jobId: params.jobId },
      select: { id: true },
    });
    if (!job || !frame) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner may complete its own context frame."
      );
    }
    const existing = await prisma.contextFrameDelivery.findUnique({
      where: { frameId: frame.id },
    });
    if (existing) {
      const same =
        existing.status === body.status &&
        existing.sessionId === (body.sessionId ?? null) &&
        existing.vendorSessionId === (body.vendorSessionId ?? null) &&
        existing.failure === (body.failure ?? null);
      if (!same) {
        throw app.httpErrors.conflict(
          "This context frame already has a different terminal delivery receipt."
        );
      }
      return { frame: await loadContextFrame(frame.id) };
    }
    await prisma.contextFrameDelivery.create({
      data: {
        frameId: frame.id,
        status: body.status,
        sessionId: body.sessionId,
        vendorSessionId: body.vendorSessionId,
        failure: body.failure,
      },
    });
    reply.code(201);
    return { frame: await loadContextFrame(frame.id) };
  });

  /**
   * Record a replay marker for a condensation MUON performed or a vendor
   * explicitly reported. The protocol refuses invented vendor summaries and
   * requires exact forgotten members for MUON-owned condensation.
   */
  app.post("/:jobId/context/condensations", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = leaseContextCondensationSchema.parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken,
      { requireFresh: false }
    );
    const job = await prisma.dispatchJob.findFirst({
      where: {
        id: params.jobId,
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      select: { id: true, taskId: true },
    });
    if (!job) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner may record context condensation for this job."
      );
    }
    const frameIds = [body.inputFrameId, body.outputFrameId].filter(
      (value): value is string => value !== undefined
    );
    if (frameIds.length > 0) {
      const owned = await prisma.contextFrame.count({
        where: { id: { in: frameIds }, jobId: job.id },
      });
      if (owned !== new Set(frameIds).size) {
        throw app.httpErrors.badRequest(
          "A condensation may reference only context frames from its own job."
        );
      }
    }
    if (body.origin === "muon") {
      const outputFrame = await prisma.contextFrame.findFirst({
        where: { id: body.outputFrameId!, jobId: job.id },
        select: { content: true },
      });
      const offset = body.summaryOffset!;
      const summary = body.summary!;
      const outputBytes = Buffer.from(outputFrame?.content ?? "", "utf8");
      const summaryBytes = Buffer.from(summary, "utf8");
      if (
        !outputFrame ||
        offset + summaryBytes.length > outputBytes.length ||
        !outputBytes
          .subarray(offset, offset + summaryBytes.length)
          .equals(summaryBytes)
      ) {
        throw app.httpErrors.badRequest(
          "A MUON condensation summary must occur byte-for-byte at summaryOffset in its output frame."
        );
      }
    }
    const existing = await prisma.contextCondensation.findUnique({
      where: {
        jobId_sourceResponseId: {
          jobId: job.id,
          sourceResponseId: body.sourceResponseId,
        },
      },
    });
    if (existing) {
      const loaded = await loadContextCondensation(existing.id);
      const existingMembers = comparableCondensationMembers(
        loaded?.members ?? []
      );
      const same =
        existing.inputFrameId === (body.inputFrameId ?? null) &&
        existing.outputFrameId === (body.outputFrameId ?? null) &&
        existing.origin === body.origin &&
        existing.summary === (body.summary ?? null) &&
        existing.summaryOffset === (body.summaryOffset ?? null) &&
        JSON.stringify(existingMembers) ===
          JSON.stringify(comparableCondensationMembers(body.members));
      if (!same) {
        throw app.httpErrors.conflict(
          "This condensation response id was already used with a different payload."
        );
      }
      return {
        condensation: loaded,
      };
    }
    const condensation = await prisma.$transaction(
      async (tx) => {
        const created = await tx.contextCondensation.create({
          data: {
            jobId: job.id,
            taskId: job.taskId,
            inputFrameId: body.inputFrameId,
            outputFrameId: body.outputFrameId,
            origin: body.origin,
            sourceResponseId: body.sourceResponseId,
            summary: body.summary,
            summaryOffset: body.summaryOffset,
          },
        });
        if (body.members.length > 0) {
          await tx.contextCondensationMember.createMany({
            data: body.members.map((member) => ({
              condensationId: created.id,
              ...member,
            })),
          });
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    reply.code(201);
    return {
      condensation: await loadContextCondensation(condensation.id),
    };
  });

  /** Stable, bounded lookup for agents and operator audit/replay surfaces. */
  app.get("/:jobId/context", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    await requireAgentJobAccess(app, request, params.jobId);
    const query = z
      .object({
        afterTurn: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        condensationLimit: z.coerce.number().int().min(1).max(500).default(200),
        afterCondensation: z.string().min(1).optional(),
      })
      .parse(request.query ?? {});
    const condensationCursor = query.afterCondensation
      ? await prisma.contextCondensation.findFirst({
          where: {
            id: query.afterCondensation,
            jobId: params.jobId,
          },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.afterCondensation && !condensationCursor) {
      throw app.httpErrors.badRequest(
        "The condensation cursor does not belong to this job."
      );
    }
    const frames = await prisma.contextFrame.findMany({
      where: { jobId: params.jobId, turnSeq: { gt: query.afterTurn } },
      orderBy: { turnSeq: "asc" },
      take: query.limit,
    });
    const frameIds = frames.map((frame) => frame.id);
    const [exposures, deliveries, condensations] = await Promise.all([
      frameIds.length > 0
        ? prisma.contextExposure.findMany({
            where: { frameId: { in: frameIds } },
            orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
          })
        : [],
      frameIds.length > 0
        ? prisma.contextFrameDelivery.findMany({
            where: { frameId: { in: frameIds } },
          })
        : [],
      prisma.contextCondensation.findMany({
        where: condensationCursor
          ? {
              jobId: params.jobId,
              OR: [
                { createdAt: { gt: condensationCursor.createdAt } },
                {
                  createdAt: condensationCursor.createdAt,
                  id: { gt: condensationCursor.id },
                },
              ],
            }
          : { jobId: params.jobId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: query.condensationLimit + 1,
      }),
    ]);
    const condensationsTruncated = condensations.length > query.condensationLimit;
    const boundedCondensations = condensations.slice(0, query.condensationLimit);
    const condensationIds = boundedCondensations.map((row) => row.id);
    const members =
      condensationIds.length > 0
        ? await prisma.contextCondensationMember.findMany({
            where: { condensationId: { in: condensationIds } },
            orderBy: [{ artifactKind: "asc" }, { artifactId: "asc" }],
          })
        : [];
    return {
      frames: frames.map((frame) => ({
        ...frame,
        exposures: exposures.filter((row) => row.frameId === frame.id),
        delivery:
          deliveries.find((row) => row.frameId === frame.id) ?? null,
      })),
      condensations: boundedCondensations.map((condensation) => ({
        ...condensation,
        members: members.filter(
          (member) => member.condensationId === condensation.id
        ),
      })),
      condensationsTruncated,
    };
  });

  app.get("/:jobId/context/frames/:frameId", async (request) => {
    const params = z
      .object({ jobId: z.string().min(1), frameId: z.string().min(1) })
      .parse(request.params);
    await requireAgentJobAccess(app, request, params.jobId);
    const frame = await loadContextFrame(params.frameId);
    if (!frame || frame.jobId !== params.jobId) {
      throw app.httpErrors.notFound("The requested context frame does not exist.");
    }
    return { frame };
  });

  /** Queue a follow-up instruction for a running session job (cross-turn steer). */
  app.post("/:jobId/steer", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        message: z.string().min(1).max(CONTEXT_FRAME_CONTENT_CHARS),
      })
      .parse(request.body);

    const controlled = await requireJobControl(
      app,
      request,
      params.jobId,
      request.headers
    );
    // The steer target comes from a STORED row, not from a request body, so no
    // admission allowlist fences it: a job whose vendor MUON no longer names
    // would otherwise stay steerable forever. An id outside the registry has no
    // declared session posture at all, and absence must read as "no capability"
    // (ADR-0022 §1.2(e)) rather than as "unconstrained".
    if (!isVendorId(controlled.vendor)) {
      throw app.httpErrors.badRequest(
        `Vendor '${controlled.vendor}' is not a lane MUON manages, so its session cannot be steered. Interrupt the job instead.`
      );
    }
    // Honest steer contract: only a vendor whose live session driver can accept
    // sends may be steered. A canSend:false vendor (e.g. claude-code, whose SDK
    // driver send() throws) would queue a message the runner can NEVER deliver —
    // it would drain→throw→requeue every poll. Reject up front rather than
    // advertise an interactive steer that silently no-ops.
    //
    // FAIL-CLOSED (ADR-0022 §1.2(e), G8). This used to read
    // `if (sessionCaps && sessionCaps.canSend === false)` against the ADAPTER's
    // descriptor table, so a lane with no descriptor at all — cursor, opencode,
    // fake — fell through and was accepted. Absence of a capability now reads as
    // "no capability", and the registry states each lane's answer positively:
    // only `codex` declares `canSend: true`.
    // ADR-0030: one owner at a time. While a native take-over holds this
    // job's session, AUTOMATION may not steer over the human's shoulder —
    // only the operator (the owner) may. Fail closed on the live session row.
    if (request.tier === "agent") {
      const humanOwned = await prisma.laneSession.findFirst({
        where: {
          jobId: params.jobId,
          owner: "human",
          status: { notIn: ["ended", "failed"] },
        },
        select: { id: true },
      });
      if (humanOwned) {
        throw app.httpErrors.conflict(
          "A human has taken this session over natively (ADR-0030). Automation cannot steer it until the operator returns the session."
        );
      }
    }
    if (!sessionCapability(controlled.vendor).canSend) {
      throw app.httpErrors.badRequest(
        `${controlled.vendor} cannot accept a live steer: its session driver does not support sending into a running session. Interrupt the job or re-dispatch with the new instruction instead.`
      );
    }
    const appended = await appendSteerMessage(params.jobId, body.message);
    if (appended.status === "missing") {
      throw app.httpErrors.notFound("The requested dispatch job does not exist.");
    }
    if (appended.status === "conflict") {
      throw app.httpErrors.conflict(
        "The steer queue remained busy; retry without dropping the instruction."
      );
    }
    return { job: appended.job };
  });

  /** Drain and clear the steer queue, called by the runner. */
  app.post("/:jobId/steer/drain", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema.parse(request.body ?? {});
    return prisma.$transaction(async (tx) => {
      const leaseHash = await requireActiveRunnerLease(
        app,
        tx,
        body.host,
        body.leaseToken
      );
      const job = await tx.dispatchJob.findUnique({
        where: { id: params.jobId },
      });
      if (!job) {
        throw app.httpErrors.notFound(
          "The requested dispatch job does not exist."
        );
      }
      if (
        job.status !== "running" ||
        job.host !== body.host ||
        job.runnerLeaseHash !== leaseHash
      ) {
        throw app.httpErrors.conflict(
          "Only the exact lease-holding runner may drain this steer queue."
        );
      }
      const messages = Array.isArray(job.steerMessages)
        ? (job.steerMessages as string[])
        : [];
      if (messages.length === 0) {
        return { messages };
      }
      const cleared = await tx.dispatchJob.updateMany({
        where: {
          id: job.id,
          status: "running",
          host: body.host,
          runnerLeaseHash: leaseHash,
          steerMessages: { equals: messages },
        },
        data: { steerMessages: [] as Prisma.InputJsonValue },
      });
      if (cleared.count !== 1) {
        throw app.httpErrors.conflict(
          "The steer queue changed while it was being drained; retry without dropping messages."
        );
      }
      return { messages };
    });
  });

  /**
   * LIVE TERMINAL — publish (runner → brain).
   *
   * The lease-holding runner relays the vendor child's console bytes here as
   * bounded frames. The first accepted batch stamps `ptySessionId` on the job,
   * which is what makes that column mean "a real process console exists",
   * rather than "a viewer could open a pane": a lane running through an
   * in-process SDK never reaches this route and its job stays NULL.
   *
   * The frames are UNTRUSTED VENDOR OUTPUT written by an agent-tier bearer, so
   * this route treats the runner's own scrubbing as unverified and re-bounds
   * (`.max()` rejects rather than silently trimming, so an over-limit poster
   * learns it is over the limit) and re-scrubs through the SAME `redactSecrets`
   * control the packet tails use. Same posture as `scrubDetail` in streams.ts.
   * Stated honestly: this is a SAFETY NET against a runner-side scrubbing bug,
   * not a boundary against a hostile lease holder — one that wanted to plant
   * text could already do so through `POST /api/streams`.
   */
  app.post(
    "/:jobId/terminal",
    // EXPLICIT, because Fastify's default is 1 MiB and the runner's batch cap is
    // set to fit UNDER this number. Leaving it implicit is how the loudest jobs
    // — the ones actually worth watching — would silently 413 their whole batch.
    { bodyLimit: TERMINAL_PUBLISH_BODY_BYTES },
    async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema
      .extend({
        sessionId: z.string().min(1).max(300),
        frames: z
          .array(
            z.object({
              seq: z.number().int().min(1),
              data: z.string().min(1).max(TERMINAL_FRAME_CHARS),
            })
          )
          .min(1)
          .max(TERMINAL_FRAMES_PER_PUBLISH),
        // Frames the runner lost before they reached here. Untrusted like every
        // other field, so it is bounded and only ever moves forward in the store.
        dropped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      })
      .parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken
    );
    // The session id is DERIVED from the job, never freely chosen: a runner that
    // could name it at will could publish one job's console under another job's
    // identity. Only the trailing per-execution epoch is the runner's to pick,
    // and it is constrained to hex — which is what lets a RECLAIMED job (same
    // id, restarted frame sequence) reset the ring instead of having every new
    // frame dropped as a replay of the dead attempt.
    const sessionPrefix = `${JOB_TERMINAL_SESSION_PREFIX}${params.jobId}:`;
    const epoch = body.sessionId.startsWith(sessionPrefix)
      ? body.sessionId.slice(sessionPrefix.length)
      : null;
    if (!epoch || !/^[0-9a-f]{8,64}$/.test(epoch)) {
      throw app.httpErrors.badRequest(
        "A live terminal session id must be derived from its own job id."
      );
    }
    const expectedSessionId = body.sessionId;
    // Same fence as the steer drain: only the exact lease-holding runner of a
    // RUNNING job may speak for that job's console.
    const claimed = await prisma.dispatchJob.findFirst({
      where: {
        id: params.jobId,
        status: "running",
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      select: { id: true, ptySessionId: true },
    });
    if (!claimed) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner of a running job may publish its live terminal."
      );
    }
    const frames = body.frames.map((frame) => ({
      seq: frame.seq,
      data: redactSecrets(frame.data),
    }));
    const lastSeq = jobTerminalStore.append(
      params.jobId,
      expectedSessionId,
      frames,
      body.dropped
    );
    if (claimed.ptySessionId !== expectedSessionId) {
      // Stamped once, on the first console byte. Scoped to the same lease so a
      // fenced predecessor cannot re-stamp a job a successor now owns.
      await prisma.dispatchJob.updateMany({
        where: {
          id: params.jobId,
          status: "running",
          host: body.host,
          runnerLeaseHash: leaseHash,
        },
        data: { ptySessionId: expectedSessionId },
      });
    }
      return { accepted: frames.length, lastSeq };
    }
  );

  /**
   * EXECUTION PATH — record where this job ACTUALLY ran (runner → brain).
   *
   * The runner resolves a job's cwd itself: an isolated
   * task checkout in MUON's external worktree store when the harness requires a
   * worktree, otherwise the canonical workspace. Until this route existed the
   * brain never learned which, so every review surface had to RE-DERIVE the
   * answer from the harness config — inferring INTENT ("this job was supposed
   * to run in a worktree") where it needed a FACT. This replaces the inference.
   *
   * NOT A CAPABILITY, A COORDINATE. Nothing is executed, written, or authorized
   * because of this column; surfaces read evidence from it. Two things keep it
   * that way:
   *
   *   1. It is only ever writable HERE. No dispatch body carries it — not the
   *      operator `POST /api/dispatch`, not the agent-facing
   *      `POST /:jobId/delegate` — so an agent can never aim a reviewer at a
   *      directory of its choosing.
   *   2. Same fence as the live-terminal publish: only the exact lease-holding
   *      runner of a RUNNING job may speak for that job's execution. A fenced
   *      predecessor whose job a successor now owns matches zero rows.
   *
   * The value is bound to either the job's exact persisted workspace (which is
   * re-validated against the dispatch allowlist) or the exact current/legacy
   * task tree derived from its workspace + task coordinates. No sibling or
   * freely chosen allowlisted directory is admitted. That is defence in depth,
   * not the boundary: a lease holder already runs vendor processes on this host.
   *
   * Deliberately overwritable BY THE CURRENT LEASE HOLDER. A reclaimed job that
   * runs again must record where it ran THIS time; the column means "where the
   * latest execution ran", never "the first place we ever heard about".
   */
  app.post("/:jobId/execution-path", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema
      .extend({ executionPath: z.string().min(1).max(4096) })
      .parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken
    );
    const claimed = await prisma.dispatchJob.findFirst({
      where: {
        id: params.jobId,
        status: "running",
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      select: { workspacePath: true, taskId: true },
    });
    if (!claimed) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner of a running job may record where it ran."
      );
    }

    const reported = realpathOfNearestExisting(body.executionPath);
    const checked = validateWorkspacePath(body.executionPath);
    const persistedWorkspace = claimed.workspacePath
      ? realpathOfNearestExisting(claimed.workspacePath)
      : undefined;
    const isExactWorkspace =
      checked.ok && checked.path === persistedWorkspace;
    let candidates: string[] = [];
    try {
      if (claimed.workspacePath) {
        candidates = taskWorktreeCandidates(
          claimed.workspacePath,
          claimed.taskId
        ).map(realpathOfNearestExisting);
      }
    } catch {
      // An invalid worktree-root configuration cannot widen this route. Exact
      // persisted-workspace recording can still proceed; external paths cannot.
    }
    if (!isExactWorkspace && !candidates.includes(reported)) {
      throw app.httpErrors.badRequest(
        `Execution path '${body.executionPath}' is neither this job's persisted workspace nor its exact managed task tree.`
      );
    }
    const executionPath = isExactWorkspace ? checked.path : reported;
    const stamped = await prisma.dispatchJob.updateMany({
      where: {
        id: params.jobId,
        status: "running",
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      data: { executionPath },
    });
    if (stamped.count !== 1) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner of a running job may record where it ran."
      );
    }
    return { executionPath };
  });

  /**
   * BACKLINK — record the vendor's OWN session id for this job's execution
   * (runner → brain).
   *
   * The value `codex resume <id>` / `claude --resume <id>` take: with it the
   * desktop can reopen the EXACT session MUON dispatched in the vendor's real
   * TUI, the brief visible as its first turn. Same posture as
   * `/:jobId/execution-path` above — A COORDINATE, NOT A CAPABILITY:
   *
   *   1. Only ever writable HERE, under the exact runner lease of the RUNNING
   *      job. No dispatch body carries it, so an agent can never point the
   *      human's resume affordance at a session of its choosing.
   *   2. The desktop's terminal host re-validates the stored value against a
   *      strict shape before it may ever reach a command line, and the argv is
   *      host-composed from an allowlist — this column is data, not argv.
   *
   * Bounded to the vendors' actual id shape (uuid-like) rather than free text:
   * the column's one consumer IS a resume argv, so the shape check here is the
   * first of the two fences.
   */
  app.post("/:jobId/vendor-session", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema
      .extend({
        vendorSessionId: z
          .string()
          .regex(
            /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/,
            "A vendor session id must be the vendor's uuid-shaped session id."
          ),
      })
      .parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken
    );
    const stamped = await prisma.dispatchJob.updateMany({
      where: {
        id: params.jobId,
        status: "running",
        host: body.host,
        runnerLeaseHash: leaseHash,
      },
      data: { vendorSessionId: body.vendorSessionId.toLowerCase() },
    });
    if (stamped.count !== 1) {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner of a running job may record its vendor session."
      );
    }
    return { vendorSessionId: body.vendorSessionId.toLowerCase() };
  });

  /**
   * LIVE TERMINAL — attach (viewer → brain). READ-ONLY, OPERATOR TIER.
   *
   * Bytes and coordinates only: a frame is console text plus a sequence number,
   * and no operator, agent, delegation, or GitHub token rides this response.
   * `requireOperator` fences it to the human's own tier — an agent bearer or a
   * job capability is refused, so a vendor process can never read another
   * agent's console through its own credential.
   *
   * Cursor-based, exactly like `GET /api/streams`, deliberately NOT SSE: the
   * "no silent hang" charter says every request settles in a bounded window,
   * and a hijacked reply would be the first thing in this brain that does not.
   *
   * THERE IS NO WRITE COUNTERPART, AND THERE MUST NOT BE. Typing into a
   * dispatched agent would bypass the approval path that makes it governed.
   * Adding input is a governance decision with its own gate, never a side
   * effect of a viewer.
   */
  app.get("/:jobId/terminal", async (request) => {
    requireOperator(app, request);
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        afterSeq: z.coerce.number().int().min(0).default(0),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(TERMINAL_READ_MAX_FRAMES)
          .default(TERMINAL_READ_MAX_FRAMES),
      })
      .parse(request.query ?? {});
    const job = await prisma.dispatchJob.findUnique({
      where: { id: params.jobId },
      select: { id: true, ptySessionId: true, status: true },
    });
    if (!job) {
      throw app.httpErrors.notFound("The requested dispatch job does not exist.");
    }
    const live = jobTerminalStore.read(
      params.jobId,
      query.afterSeq,
      query.limit
    );
    if (!live) {
      // The job row may still remember it HAD a console (a finished run, or a
      // brain that restarted). Say that plainly instead of returning an empty
      // frame list that a viewer would render as a live-but-silent agent.
      return {
        sessionId: job.ptySessionId,
        available: false,
        // The job's own status, so a viewer can tell "this console is gone"
        // from "this agent is alive and quiet". A finished job whose ring is
        // still warm would otherwise poll forever showing an empty live pane.
        jobStatus: job.status,
        frames: [],
        firstSeq: null,
        lastSeq: 0,
        dropped: 0,
      };
    }
    return {
      sessionId: live.sessionId,
      available: true,
      jobStatus: job.status,
      frames: live.frames,
      // A reader whose cursor is below `firstSeq` has missed console bytes the
      // ring dropped. Reporting it is what lets a viewer say "output was
      // trimmed" rather than silently showing a discontinuous terminal.
      firstSeq: live.firstSeq,
      lastSeq: live.lastSeq,
      // Frames lost BEFORE the brain saw them (runner queue overflow, a refused
      // batch). Same reason, different loss path.
      dropped: live.dropped,
    };
  });

  /** Restore a drained instruction that the exact runner could not deliver. */
  app.post("/:jobId/steer/requeue", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const body = runnerLeaseSchema
      .extend({ message: z.string().min(1) })
      .parse(request.body ?? {});
    const leaseHash = await requireActiveRunnerLease(
      app,
      prisma,
      body.host,
      body.leaseToken
    );
    const appended = await appendSteerMessage(params.jobId, body.message, {
      status: "running",
      host: body.host,
      runnerLeaseHash: leaseHash,
    });
    if (appended.status === "missing") {
      throw app.httpErrors.notFound("The requested dispatch job does not exist.");
    }
    if (appended.status === "conflict") {
      throw app.httpErrors.conflict(
        "Only the exact lease-holding runner may restore this steer message."
      );
    }
    return { job: appended.job };
  });

  // Round-3 #5 — "revoke this identity NOW", as an operator verb. Grants
  // already hash their tokens and honour expiry per request; what was missing
  // was a human hand that terminates a LIVE grant on demand. Deleting the
  // rows kills the credential at the auth boundary on the very next call.
  // Deliberately DISTINCT from interrupt: the process may keep running (stop
  // it with interrupt); what dies here is its authenticated identity — every
  // MCP/route call fails closed from this moment. Operator-only: no
  // coordinator lineage allowance, because un-personing a child is not a
  // coordination act.
  app.post("/:jobId/revoke-grants", async (request) => {
    requireOperator(app, request);
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const job = await prisma.dispatchJob.findUnique({
      where: { id: params.jobId },
      select: { id: true, taskId: true, vendor: true, status: true },
    });
    if (!job) {
      throw app.httpErrors.notFound(`Unknown dispatch job '${params.jobId}'.`);
    }
    const revoked = await prisma.delegationGrant.deleteMany({
      where: { jobId: job.id },
    });
    // Audit row: a credential death is a governed act someone must be able
    // to find later. Coordinate-only message.
    const stamp = buildEventAuditStamp({ actor: OPERATOR_PRINCIPAL });
    await prisma.event.create({
      data: {
        laneId: "muon",
        taskId: job.taskId,
        kind: "identity.revoked",
        message: `operator revoked ${revoked.count} grant(s) of job ${job.id}`,
        timestamp: new Date(),
        metadata: { jobId: job.id, grants: revoked.count } as Prisma.InputJsonValue,
        ...eventAuditData(stamp),
      },
    });
    return {
      jobId: job.id,
      revoked: revoked.count,
      note:
        "The identity is dead; the process is not. Use interrupt to stop the job itself.",
    };
  });

  app.post("/:jobId/interrupt", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    // The ONLY route that takes the cross-turn allowance: a coordinator must be
    // able to stop the crew it started in an earlier turn of this chat, or two
    // rounds of the same mission run concurrently over the same files.
    const job = await requireJobControl(
      app,
      request,
      params.jobId,
      request.headers,
      { coordinatorChatLineage: true }
    );
    const endedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const fenced = await tx.dispatchJob.updateMany({
        where: {
          id: job.id,
          status: { in: ["queued", "running"] },
          interruptRequested: false,
        },
        data: { interruptRequested: true },
      });
      if (fenced.count !== 1 && !job.interruptRequested) {
        throw app.httpErrors.conflict(
          "The dispatch changed while cancellation was being fenced."
        );
      }
      const rootJobId = job.rootJobId ?? job.id;
      const lineage = await tx.dispatchJob.findMany({
        where: {
          OR: [{ id: rootJobId }, { rootJobId }],
        },
      });
      const subtree = new Set([job.id]);
      let added = true;
      while (added) {
        added = false;
        for (const candidate of lineage) {
          if (
            candidate.parentJobId &&
            subtree.has(candidate.parentJobId) &&
            !subtree.has(candidate.id)
          ) {
            subtree.add(candidate.id);
            added = true;
          }
        }
      }
      const ids = [...subtree];
      await tx.dispatchJob.updateMany({
        where: { id: { in: ids }, status: "queued" },
        data: {
          status: "interrupted",
          interruptRequested: true,
          endedAt,
        },
      });
      await tx.dispatchJob.updateMany({
        where: { id: { in: ids }, status: "running" },
        data: { interruptRequested: true },
      });
      // Release the reservations of the queued descendants just terminalized.
      // `lineage` is this transaction's snapshot, so a repeat interrupt sees
      // them already interrupted and releases nothing (idempotent); running
      // descendants are only flagged here and release later through their own
      // terminal PATCH.
      for (const candidate of lineage) {
        if (subtree.has(candidate.id) && candidate.status === "queued") {
          await releaseDelegationBudget(tx, candidate, endedAt);
        }
      }
    });
    return {
      job: {
        ...job,
        interruptRequested: true,
        ...(job.status === "queued"
          ? { status: "interrupted", endedAt }
          : {}),
      },
    };
  });

  /**
   * Reclaim jobs orphaned by a crashed/killed runner. A runner calls this on
   * startup with its OWN host. A prior vendor process may still be alive even
   * after the old runner lost its lease, so replaying the job would permit two
   * agents to mutate the same workspace concurrently. Reconciliation therefore
   * marks the old run `interrupted` and releases its fleet slot; the human can
   * inspect evidence and explicitly redispatch.
   */
  app.post("/reclaim", async (request) => {
    const body = runnerLeaseSchema.parse(request.body);
    return prisma.$transaction(async (tx) => {
      const leaseHash = await requireActiveRunnerLease(
        app,
        tx,
        body.host,
        body.leaseToken
      );
      const stranded = await tx.dispatchJob.findMany({
        where: {
          status: "running",
          host: body.host,
          OR: [
            { runnerLeaseHash: null },
            { runnerLeaseHash: { not: leaseHash } },
          ],
        },
      });
      const jobIds: string[] = [];
      for (const job of stranded) {
        const reclaimedAt = new Date();
        const result = await tx.dispatchJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            runnerLeaseHash: job.runnerLeaseHash,
          },
          data: {
            status: "interrupted",
            result:
              "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
            exitCode: null,
            endedAt: reclaimedAt,
          },
        });
        if (result.count !== 1) continue;
        jobIds.push(job.id);
        // First (and only) terminal transition of this orphaned run: return its
        // reservation to the root pool so siblings can be re-dispatched.
        await releaseDelegationBudget(tx, job, reclaimedAt);
        if (job.agentId) {
          await tx.agent.updateMany({
            where: {
              id: job.agentId,
              currentTaskId: job.taskId,
              currentJobId: job.id,
              status: "working",
            },
            data: {
              status: "idle",
              currentTaskId: null,
              currentJobId: null,
              sessionId: null,
            },
          });
        }
        // Checkpoint edge (P0.1 Slice A): the dead incarnation's session
        // (running or gate-paused) is now provably not listening. Mark it
        // interrupted so a resume never treats a pre-death approval as
        // deliverable. Pending ApprovalRequests are NOT touched: the exact
        // pending gate survives for the human (REC-025 stays: no requeue).
        await tx.laneSession.updateMany({
          where: { jobId: job.id, status: { in: ["running", "waiting_approval"] } },
          data: { status: "interrupted", endedAt: reclaimedAt },
        });
      }
      return { reclaimed: jobIds.length, jobIds };
    });
  });
}

export async function registerRunnerRoutes(app: FastifyInstance) {
  // Trusted launchers use operator authority once to mint/rotate a narrow,
  // per-process runner capability. The row remains non-live until the child
  // proves possession through /heartbeat, so pre-authorization can never make
  // UI surfaces report a runner that failed to spawn.
  app.post("/lease", async (request) => {
    requireOperator(app, request);
    const body = runnerLeaseSchema.parse(request.body);
    const leaseHash = hashRunnerLease(body.leaseToken);
    const now = new Date();
    const existing = await prisma.runner.findFirst({
      where: { host: body.host },
      orderBy: { lastSeenAt: "desc" },
    });
    let runner;
    if (existing) {
      const replaced = await prisma.runner.updateMany({
        where: { id: existing.id, leaseHash: existing.leaseHash },
        data: {
          leaseHash,
          pid: null,
          status: "starting",
          lastSeenAt: now,
        },
      });
      if (replaced.count !== 1) {
        throw app.httpErrors.conflict(
          `Runner host '${body.host}' lease changed concurrently.`
        );
      }
      runner = {
        ...existing,
        leaseHash,
        pid: null,
        status: "starting",
        lastSeenAt: now,
      };
    } else {
      try {
        runner = await prisma.runner.create({
          data: {
            host: body.host,
            pid: null,
            leaseHash,
            status: "starting",
          },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw app.httpErrors.conflict(
            `Runner host '${body.host}' was leased concurrently.`
          );
        }
        throw error;
      }
    }
    return { runner: publicRunner(runner) };
  });

  // Heartbeat + local lease: operator authority mints/replaces one unexposed,
  // per-launch capability for a host. The agent tier may renew ONLY the exact
  // pre-authorized lease. A sub-agent that knows the host and agent token can
  // therefore neither create a runner row nor seize a stale one.
  app.post("/heartbeat", async (request) => {
    const body = z
      .object({
        host: z.string().trim().min(1).max(200),
        pid: z.number().int().positive(),
        leaseToken: z.string().min(32).max(512),
      })
      .parse(request.body);
    const leaseHash = hashRunnerLease(body.leaseToken);

    const existing = await prisma.runner.findFirst({
      where: { host: body.host },
      orderBy: { lastSeenAt: "desc" },
    });
    const now = new Date();
    let runner;
    if (existing) {
      const replacingLease = existing.leaseHash !== leaseHash;
      if (replacingLease && request.tier !== "operator") {
        // This caller may be the previously-authorized runner learning that a
        // successor replaced it. Return the explicit fencing code the runner
        // uses to cancel in-flight filesystem work immediately. It still
        // cannot acquire or replace the lease.
        throw app.httpErrors.conflict(
          `Runner host '${body.host}' lease was replaced by a trusted launcher.`
        );
      }
      // Atomic compare-and-swap: the exact incarnation renews. Replacing it is
      // an explicit operator action performed by the trusted launcher.
      const claimed = await prisma.runner.updateMany({
        where: {
          id: existing.id,
          leaseHash: existing.leaseHash,
        },
        data: {
          lastSeenAt: now,
          pid: body.pid,
          leaseHash,
          status: "online",
        },
      });
      if (claimed.count !== 1) {
        throw app.httpErrors.conflict(
          `Runner host '${body.host}' lease changed concurrently.`
        );
      }
      runner = {
        ...existing,
        pid: body.pid,
        leaseHash,
        status: "online",
        lastSeenAt: now,
      };
    } else {
      requireOperator(app, request);
      try {
        runner = await prisma.runner.create({
          data: { host: body.host, pid: body.pid, leaseHash },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw app.httpErrors.conflict(
            `Runner host '${body.host}' was leased concurrently.`
          );
        }
        throw error;
      }
    }
    return { runner: publicRunner(runner) };
  });

  app.get("/", async (request) => {
    const query = z
      .object({
        host: z.string().trim().min(1).max(200).optional(),
      })
      .parse(request.query);
    const runner = await prisma.runner.findFirst({
      where: query.host ? { host: query.host } : undefined,
      orderBy: { lastSeenAt: "desc" },
    });
    // A runner is "live" if seen in the last 15s.
    const live = runner
      ? runner.status === "online" &&
        typeof runner.pid === "number" &&
        runner.pid > 0 &&
        Date.now() - runner.lastSeenAt.getTime() < RUNNER_LIVE_WINDOW_MS
      : false;
    return { runner: runner ? publicRunner(runner) : null, live };
  });
}


/**
 * ADR-0048 — does this harness's own contract require an isolated worktree?
 *
 * Shape-checked rather than trusted: `config` is a JSON column, and a
 * malformed row must mint `read` (the conservative authority), never throw a
 * dispatch that was otherwise valid.
 */
function harnessRequiresWorktree(
  harnessRow: { config?: unknown } | undefined | null
): boolean {
  const requires = (
    harnessRow?.config as { requires?: { worktree?: unknown } } | null
  )?.requires;
  return requires?.worktree === true;
}
