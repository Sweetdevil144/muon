import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS,
  ATTACHED_COORDINATOR_LEASE_TTL_MS,
  ATTACHED_COORDINATOR_SWEEP_MS,
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_CHILDREN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_DESCENDANTS,
  coordinatorVendorIds,
  delegationRootPolicyV2Schema,
  type VendorId,
} from "@muon/protocol";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgentJobCapability, requireOperator } from "./auth.js";
import { prisma } from "./db.js";
import { assertVendorMayHoldRole } from "./dispatch-role.js";
import { validateWorkspacePath } from "./workspace.js";
import { COORDINATOR_ORDINAL } from "../routes/fleet.js";
import { releaseDelegationBudget } from "../routes/dispatch.js";

/**
 * The attached root's own LONG execution wall (30 min). Every delegated child
 * inherits its remaining wall-clock budget from `root.delegationDeadline`
 * (dispatch.ts's `/delegate` route reads `root.delegationDeadline.getTime() -
 * Date.now()` directly), so this is what MUST be persisted there — never the
 * short heartbeat lease below. Collapsing the two (as an earlier revision of
 * this file did) left every delegated child with ~2 minutes of wall-clock
 * (the lease TTL) instead of a real turn.
 */
const ATTACHED_ROOT_WALL_MS = 30 * 60_000;
const DEFAULT_DELEGATION_ITERATIONS = 10;

const attachSchema = z
  .object({
    vendor: z.string().min(1),
    chatId: z.string().min(1),
  })
  .strict();

function capabilityHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The long delegation/execution wall. Set ONCE at attach and NEVER shrunk or
 * extended by heartbeat — children compute their remaining budget from it, so
 * a heartbeat carries no duration semantics for this field at all.
 */
function wallDeadline(now = Date.now()): Date {
  return new Date(now + ATTACHED_ROOT_WALL_MS);
}

/**
 * The short, heartbeat-renewed capability lease (`DelegationGrant.expiresAt`).
 * Independent of the wall above: a lapsed heartbeat reaps the seat long before
 * the 30-minute wall would ever elapse on its own (ADR-0028 §3/§4).
 */
function leaseDeadline(now = Date.now()): Date {
  return new Date(now + ATTACHED_COORDINATOR_LEASE_TTL_MS);
}

/**
 * ADR-0049 — the lease a MINT stamps, before any heartbeat can exist.
 *
 * The steady-state TTL assumes a heartbeat is already flowing; between the
 * mint and the first one there is none, and that window is exactly what a
 * human spends restarting the terminal `muon mcp attach` tells them to
 * restart. At 120s the printed remedy expired before it could be used.
 *
 * The FIRST heartbeat renews at `leaseDeadline` above, so this wider window
 * exists once, for one seat, until it connects.
 */
function bootstrapLeaseDeadline(now = Date.now()): Date {
  return new Date(now + ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS);
}

function attachedRootPolicy(input: {
  jobId: string;
  workspacePath: string;
  deadline: Date;
}) {
  return delegationRootPolicyV2Schema.parse({
    version: 2,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
    maxDepth: DELEGATION_MAX_DEPTH,
    maxChildrenPerParent: DELEGATION_MAX_CHILDREN,
    maxTotalDescendants: DELEGATION_MAX_DESCENDANTS,
    maxDescendantWallMs: DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS,
    maxIterations: DEFAULT_DELEGATION_ITERATIONS,
    deadlineAt: input.deadline.toISOString(),
    authority: "orchestrator",
    childAuthority: "work",
    narrowingRequired: true,
  });
}

/**
 * Terminalise one attached root and its subtree. This is shared by explicit
 * detach and the brain-side lease sweeper so expiry cannot strand ordinal 0.
 */
/**
 * Who may be terminalised.
 *
 * A DISCRIMINATED CHOICE, not an optional field. The first version made the
 * fence `opts.requireCapabilityMode?: string` with a `{}` default, which meant
 * a caller who simply forgot the argument silently got the power to kill ANY
 * running root — the safe behaviour was not the default. That is the
 * deny-first rule this repo states for authority tiers, and it applies to a
 * reaper too. `{ unfenced: true }` is greppable; an omission is not.
 */
export type TerminalizeFence =
  | { readonly requireCapabilityMode: string }
  | { readonly unfenced: true };

/**
 * Terminalise one root job and its lineage.
 *
 * THE SHARED BODY. ADR-0040 D3 says the unattended-horizon sweep terminalises
 * "using the same transaction body as `POST /api/dispatch/reclaim` — exactly
 * as ADR-0028 §4 already does for a lapsed attach lease. Same sweeper, same
 * body, one more reason to fire." So this is extracted rather than copied:
 * two competing liveness models in one brain is how one of them rots, and two
 * copies of a release formula is how they drift.
 *
 * `requireCapabilityMode` is the ONLY difference between the callers. The
 * attach-lease sweep passes the attached-coordinator mode (it may only reap
 * what it owns); the horizon sweep passes nothing, because a daemon nobody
 * returned to is unattended regardless of which mode its work runs under.
 */
export async function terminalizeJobLineage(
  jobId: string,
  reason: string,
  now: Date,
  fence: TerminalizeFence
): Promise<boolean> {
  const requireCapabilityMode =
    "requireCapabilityMode" in fence ? fence.requireCapabilityMode : undefined;
  return prisma.$transaction(
    async (tx) => {
      const root = await tx.dispatchJob.findUnique({ where: { id: jobId } });
      if (
        !root ||
        (requireCapabilityMode !== undefined &&
          root.capabilityMode !== requireCapabilityMode) ||
        root.parentJobId !== null ||
        root.status !== "running"
      ) {
        return false;
      }
      const lineage = await tx.dispatchJob.findMany({
        where: { OR: [{ id: root.id }, { rootJobId: root.id }] },
      });
      const ids = lineage.map((job) => job.id);

      await tx.dispatchJob.updateMany({
        where: { id: root.id, status: "running" },
        data: {
          status: "interrupted",
          interruptRequested: true,
          result: reason,
          endedAt: now,
        },
      });
      await tx.dispatchJob.updateMany({
        where: { id: { in: ids }, status: "queued" },
        data: { status: "interrupted", interruptRequested: true, endedAt: now },
      });
      await tx.dispatchJob.updateMany({
        where: { id: { in: ids }, status: "running" },
        data: { interruptRequested: true },
      });

      // Queued descendants held reservations but accrued no runtime; return
      // that reservation exactly once through the SAME accounting the
      // runner's leased terminal-update path uses (dispatch.ts), so this
      // never drifts from the one true release formula. Running descendants
      // release their own reservation later, on THEIR first terminal
      // transition through that path — the `interruptRequested` write above
      // is what drives them there.
      for (const child of lineage) {
        if (child.rootJobId === root.id && child.status === "queued") {
          await releaseDelegationBudget(tx, child, now);
        }
      }

      if (root.agentId) {
        await tx.agent.updateMany({
          where: {
            id: root.agentId,
            currentJobId: root.id,
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
      await tx.laneSession.updateMany({
        where: {
          jobId: { in: ids },
          status: { in: ["running", "waiting_approval"] },
        },
        data: { status: "interrupted", endedAt: now },
      });
      await tx.delegationGrant.updateMany({
        where: { jobId: root.id },
        data: { expiresAt: now },
      });
      return true;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/** ADR-0028 §4's reaper: the shared body, fenced to what this sweep owns. */
export async function terminalizeAttachedCoordinator(
  jobId: string,
  reason: string,
  now = new Date()
): Promise<boolean> {
  return terminalizeJobLineage(jobId, reason, now, {
    requireCapabilityMode: ATTACHED_COORDINATOR_CAPABILITY_MODE,
  });
}

/**
 * One bounded brain-side sweep; safe to call on an interval or in tests.
 *
 * Reaps on the SHORT LEASE (`DelegationGrant.expiresAt`), never on the long
 * `delegationDeadline` wall — a root can be well inside its 30-minute wall
 * and still be reaped the instant its external terminal stops heartbeating
 * (ADR-0028 §4). `DelegationGrant` has no FK/relation to `DispatchJob`
 * (deliberately: it is a plain, hash-keyed capability table shared by every
 * job kind), so this is a two-step read rather than a single relational
 * query.
 */
export async function sweepExpiredAttachedCoordinators(
  now = new Date()
): Promise<string[]> {
  const roots = await prisma.dispatchJob.findMany({
    where: {
      capabilityMode: ATTACHED_COORDINATOR_CAPABILITY_MODE,
      parentJobId: null,
      status: "running",
    },
    select: { id: true },
    take: 50,
  });
  if (roots.length === 0) {
    return [];
  }
  const rootIds = roots.map((root) => root.id);
  const grants = await prisma.delegationGrant.findMany({
    where: { jobId: { in: rootIds } },
    select: { jobId: true, expiresAt: true },
  });
  const expiresAtByJobId = new Map(
    grants.map((grant) => [grant.jobId, grant.expiresAt])
  );
  const reaped: string[] = [];
  for (const id of rootIds) {
    const expiresAt = expiresAtByJobId.get(id);
    // A root with NO grant row is exactly as reapable as an expired one
    // (fail closed): a missing lease can never be treated as a live one.
    if (expiresAt && expiresAt.getTime() >= now.getTime()) {
      continue;
    }
    if (
      await terminalizeAttachedCoordinator(
        id,
        "Attached coordinator lease expired; its external terminal stopped heartbeating.",
        now
      )
    ) {
      reaped.push(id);
    }
  }
  return reaped;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic attached-coordinator lease sweep (idempotent). Unref'd
 *  so it never keeps the process alive on its own (mirrors
 *  startReinforcementFlush's shape in lib/memory-ledger.ts). */
export function startAttachedCoordinatorSweep(
  intervalMs = ATTACHED_COORDINATOR_SWEEP_MS
): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    void sweepExpiredAttachedCoordinators().catch((error) => {
      console.error(
        `attached coordinator sweep failed: ${
          error instanceof Error ? error.message : error
        }`
      );
    });
  }, intervalMs);
  sweepTimer.unref?.();
}

/** Stop the sweep timer (call on shutdown). */
export function stopAttachedCoordinatorSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function registerAttachedCoordinatorRoutes(app: FastifyInstance): void {
  app.post("/attached", async (request, reply) => {
    requireOperator(app, request);
    const input = attachSchema.parse(request.body);
    const vendors = coordinatorVendorIds();
    if (!vendors.includes(input.vendor as VendorId)) {
      throw app.httpErrors.badRequest(
        `Vendor '${input.vendor}' cannot hold MUON's coordinator seat.`
      );
    }
    assertVendorMayHoldRole(app, input.vendor, "orchestrator");

    const token = randomBytes(32).toString("hex");
    const jobId = randomUUID();
    const now = Date.now();
    // `deadline` (the long wall) and `leaseExpiresAt` (the short renewable
    // capability) are DELIBERATELY different clocks — see the CRITICAL DESIGN
    // note atop `wallDeadline`/`leaseDeadline` above.
    const deadline = wallDeadline(now);
    // ADR-0049: a MINT gets the bootstrap window. The heartbeat handler below
    // renews at the ordinary TTL, so the widening never outlives the connect.
    const leaseExpiresAt = bootstrapLeaseDeadline(now);
    const attached = await prisma.$transaction(
      async (tx) => {
        const chat = await tx.orchestratorChat.findUnique({
          where: { id: input.chatId },
        });
        if (!chat || chat.status !== "active" || !chat.taskId) {
          throw app.httpErrors.conflict(
            "Attach requires an active mission chat with its shadow task."
          );
        }
        const workspace = validateWorkspacePath(chat.workspacePath);
        if (!workspace.ok) {
          throw app.httpErrors.badRequest(workspace.reason);
        }
        const activeRoot = await tx.dispatchJob.findFirst({
          where: {
            chatId: chat.id,
            parentJobId: null,
            status: { in: ["queued", "running"] },
          },
          select: { id: true, vendor: true, capabilityMode: true },
        });
        if (activeRoot) {
          throw app.httpErrors.conflict(
            `Chat '${chat.id}' already has active root '${activeRoot.id}' (${activeRoot.vendor}, ${activeRoot.capabilityMode ?? "worker"}).`
          );
        }
        const seat = await tx.agent.findUnique({
          where: {
            vendor_ordinal: {
              vendor: input.vendor,
              ordinal: COORDINATOR_ORDINAL,
            },
          },
        });
        if (!seat || seat.status !== "idle") {
          throw app.httpErrors.conflict(
            `The '${input.vendor}' coordinator seat is already occupied${seat?.currentJobId ? ` by job '${seat.currentJobId}'` : ""}.`
          );
        }
        const reserved = await tx.agent.updateMany({
          where: { id: seat.id, status: "idle", currentJobId: null },
          data: {
            status: "working",
            currentTaskId: chat.taskId,
            currentJobId: jobId,
            sessionId: null,
          },
        });
        if (reserved.count !== 1) {
          throw app.httpErrors.conflict(
            `The '${input.vendor}' coordinator seat was claimed concurrently.`
          );
        }
        const policy = attachedRootPolicy({
          jobId,
          workspacePath: workspace.path,
          deadline,
        });
        const job = await tx.dispatchJob.create({
          data: {
            id: jobId,
            kind: "session",
            vendor: input.vendor,
            taskId: chat.taskId,
            brief: "External attached coordinator (non-hermetic human terminal).",
            role: "orchestrator",
            maxWallMs: ATTACHED_ROOT_WALL_MS,
            workspacePath: workspace.path,
            chatId: chat.id,
            delegationDepth: 0,
            maxDelegationDepth: DELEGATION_MAX_DEPTH,
            maxChildren: DELEGATION_MAX_CHILDREN,
            maxTotalDescendants: DELEGATION_MAX_DESCENDANTS,
            maxDescendantWallMs:
              DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS,
            maxDelegationIterations: DEFAULT_DELEGATION_ITERATIONS,
            delegationDeadline: deadline,
            capabilityMode: ATTACHED_COORDINATOR_CAPABILITY_MODE,
            delegationManifest: policy,
            status: "running",
            agentId: seat.id,
            dispatchedBy: "human:attached-coordinator",
            startedAt: new Date(),
          },
        });
        await tx.delegationGrant.create({
          data: {
            jobId,
            tokenHash: capabilityHash(token),
            expiresAt: leaseExpiresAt,
          },
        });
        return { job, chat };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    reply.code(201);
    return {
      job: attached.job,
      chat: attached.chat,
      // `capability.expiresAt` is the SHORT lease the caller must heartbeat
      // before, never the long wall (`attached.job.delegationDeadline`,
      // already visible on the job).
      capability: { token, expiresAt: leaseExpiresAt.toISOString() },
      attestation: {
        posture: "non-hermetic",
        claim: "MUON governs delegated children; it does not observe the external terminal's native tools.",
      },
    };
  });

  app.post("/attached/:jobId/heartbeat", async (request) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const capability = requireAgentJobCapability(app, request);
    if (
      capability.capabilityMode !== ATTACHED_COORDINATOR_CAPABILITY_MODE ||
      capability.jobId !== params.jobId
    ) {
      throw app.httpErrors.forbidden(
        "Heartbeat requires the exact attached coordinator capability."
      );
    }
    // By the time this handler runs, the auth hook's
    // `resolveActiveAgentJobCapability` has already verified the grant is
    // unexpired AND inside its independent horizon (ADR-0028 §3) — this
    // handler's only job is to RENEW that short lease. The long execution
    // wall (`delegationDeadline`) is NEVER read or written here: a heartbeat
    // carries no duration (ADR-0028 §3, "issuer computes expiry server-side
    // from a fixed TTL; attach heartbeats carry no duration field").
    const now = Date.now();
    const nextExpiresAt = leaseDeadline(now);
    const renewed = await prisma.$transaction(
      async (tx) => {
        const job = await tx.dispatchJob.findUnique({
          where: { id: params.jobId },
        });
        if (
          !job ||
          job.status !== "running" ||
          job.interruptRequested ||
          job.capabilityMode !== ATTACHED_COORDINATOR_CAPABILITY_MODE ||
          job.parentJobId !== null
        ) {
          throw app.httpErrors.conflict(
            "The attached coordinator is no longer running."
          );
        }
        const grant = await tx.delegationGrant.findUnique({
          where: { jobId: job.id },
        });
        if (!grant) {
          throw app.httpErrors.conflict(
            "The attached coordinator lease is missing."
          );
        }
        // Optimistic guard on the PRIOR expiry so a concurrent heartbeat (or
        // a sweep that already expired the grant) never overwrites a race.
        const updated = await tx.delegationGrant.updateMany({
          where: { jobId: job.id, expiresAt: grant.expiresAt },
          data: { expiresAt: nextExpiresAt },
        });
        if (updated.count !== 1) {
          throw app.httpErrors.conflict(
            "The attached coordinator lease changed concurrently."
          );
        }
        return job;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return { job: renewed, expiresAt: nextExpiresAt.toISOString() };
  });

  app.delete("/attached/:jobId", async (request) => {
    requireOperator(app, request);
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const detached = await terminalizeAttachedCoordinator(
      params.jobId,
      "Attached coordinator detached by the operator."
    );
    if (!detached) {
      throw app.httpErrors.conflict(
        "The attached coordinator is absent or already terminal."
      );
    }
    return { detached: true, jobId: params.jobId };
  });
}
