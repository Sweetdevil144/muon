import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  APPROVAL_GRANT_HORIZON_MS,
  RECEIPT_ALLOWED_CLASSES,
} from "@muon/protocol";
import { OPERATOR_PRINCIPAL, requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  buildEventAuditStamp,
  ensureEventPrincipals,
  eventAuditData,
} from "../lib/event-audit.js";
import { fingerprintEffectivePolicy } from "../lib/policy-profile.js";

// ── ADR-0056: durable approval grants — redeem, list, revoke ─────────────────
//
// The `always` grade. Deliberately a sibling of `routes/receipts.ts` rather than
// a widening of it: a receipt binds a RUN (jobId + delegation manifest), a grant
// binds a CHAT (taskId + policy fingerprint), and one table holding both would
// need each other's authority columns nullable — a nullable authority column
// plus a second query path over the same rows is how a bounded surface stops
// being bounded.
//
// Everything else is the receipt discipline verbatim, because it is correct:
// validation and use-stamping are ONE guarded `updateMany` (no read-then-stamp
// TOCTOU); a grant is MULTI-use within its window (that is the fatigue fix); ANY
// drift — content, target, workspace, chat, policy posture, expiry, revocation,
// a delegate context — falls outside the match and the caller files the gate
// exactly as today. A miss is 200/{redeemed:false}, never an error status:
// redemption is burn-only (the agent tier can spend authority, never grant it),
// and the fail direction is always "ask a human", never deny and never allow.

const redeemBodySchema = z.object({
  taskId: z.string().min(1),
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  toolName: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // The operator-VISIBLE resolved target of THIS real tool call (P0.4 SEC-1),
  // derived by the seam from the same input that produced `payloadDigest`. A
  // target-less action sends none and matches only a target-less (NULL) grant.
  resolvedTarget: z.string().min(1).nullish(),
});

const listQuerySchema = z.object({
  activeOnly: z.coerce.boolean().optional(),
  workspacePath: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

/**
 * Best-effort durable audit for one auto-resolution, written by the SERVER
 * before the seam ever hears the answer.
 *
 * The receipt path audits through the seam's `approval.auto` lane event, which
 * means the record exists only if the client's event transport delivered it. A
 * grant is longer-lived and crosses runs, so its trail may not depend on a
 * caller: this row is written here, dual-keyed so "which agent spent it"
 * (`principal`) and "which human granted it" (`accountable`) are two columns
 * rather than a reconstruction. Never throws — the redemption already landed —
 * but logs, so a hole in the trail is observable rather than silent.
 */
async function recordGrantSpendAudit(args: {
  grant: {
    id: string;
    approvalId: string;
    taskId: string;
    actionClass: string;
    toolName: string;
    payloadDigest: string;
    expiresAt: Date;
  };
  jobId: string;
  sessionId: string;
  useCount: number;
}): Promise<void> {
  const actor = "agent:muon";
  const stamp = buildEventAuditStamp({
    actor,
    accountable: OPERATOR_PRINCIPAL,
    requestId: args.grant.approvalId,
    payloadDiff: {
      grantId: args.grant.id,
      duration: "always",
      actionClass: args.grant.actionClass,
      toolName: args.grant.toolName,
    },
  });
  await ensureEventPrincipals(stamp, actor, OPERATOR_PRINCIPAL).catch(
    () => undefined
  );
  try {
    await prisma.event.create({
      data: {
        laneId: "muon",
        taskId: args.grant.taskId,
        kind: "approval.auto",
        message:
          `grant ${args.grant.id} matched this exact action ` +
          `(${args.grant.toolName}, ${args.grant.actionClass})`,
        metadata: {
          source: "grant",
          grantId: args.grant.id,
          approvalId: args.grant.approvalId,
          duration: "always",
          actionClass: args.grant.actionClass,
          toolName: args.grant.toolName,
          payloadDigest: args.grant.payloadDigest,
          jobId: args.jobId,
          sessionId: args.sessionId,
          useCount: args.useCount,
          expiresAt: args.grant.expiresAt.toISOString(),
        },
        ...eventAuditData(stamp),
      },
    });
  } catch (error) {
    console.error(
      `[adr-0056] approval.auto audit failed for grant ${args.grant.id}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function registerGrantRoutes(app: FastifyInstance) {
  app.post("/redeem", async (request) => {
    const body = redeemBodySchema.parse(request.body);
    const miss = { redeemed: false as const };

    // (i) Corroborate the caller's run binding through the session ledger: the
    // session must be a real row executing exactly this job. An agent cannot
    // borrow another run's authority by naming its jobId.
    const session = await prisma.laneSession.findUnique({
      where: { id: body.sessionId },
    });
    if (!session || session.jobId !== body.jobId) {
      return miss;
    }

    // (ii) The redeeming run must belong to the chat the grant is scoped to,
    // and must not be a descendant. `jobId` itself is deliberately NOT matched
    // against the grant — crossing the run boundary is the whole grade — so the
    // CHAT is the fence that replaces it, and it is checked positively here as
    // well as in the row match below.
    const job = await prisma.dispatchJob.findUnique({
      where: { id: body.jobId },
    });
    if (!job || job.capabilityMode === "delegate") {
      return miss;
    }
    if (job.taskId !== body.taskId) {
      return miss;
    }

    // (iii) The posture in force RIGHT NOW, recomputed from current rows: a
    // profile edited, deleted, added or re-scoped after mint invalidates every
    // grant that was minted under the old one.
    const policyFingerprint = await fingerprintEffectivePolicy({
      workspacePath: body.workspacePath,
      taskId: body.taskId,
    });

    // (iv) Exact content match, then a guarded stamp. The class filter is the
    // last fence: even a hand-forged network/merge/ship row could never redeem.
    // The horizon ceiling refuses a row whose expiry no legitimate issuer could
    // have minted, so a hand-edited `expiresAt` cannot buy an un-revocable grant.
    const now = new Date();
    const horizon = new Date(now.getTime() + APPROVAL_GRANT_HORIZON_MS);
    const grant = await prisma.approvalGrant.findFirst({
      where: {
        taskId: body.taskId,
        workspacePath: body.workspacePath,
        toolName: body.toolName,
        resolvedTarget: body.resolvedTarget ?? null,
        payloadDigest: body.payloadDigest,
        actionClass: { in: [...RECEIPT_ALLOWED_CLASSES] },
        policyFingerprint,
        revokedAt: null,
        expiresAt: { gt: now, lte: horizon },
      },
    });
    if (!grant) {
      return miss;
    }
    const stamped = await prisma.approvalGrant.updateMany({
      where: {
        id: grant.id,
        revokedAt: null,
        expiresAt: { gt: now, lte: horizon },
      },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });
    if (stamped.count !== 1) {
      return miss;
    }
    const useCount = grant.useCount + 1;
    // The audit row is written BEFORE the answer is returned: an auto-resolution
    // nobody can see afterwards is the failure mode this grade would otherwise
    // introduce.
    await recordGrantSpendAudit({
      grant,
      jobId: body.jobId,
      sessionId: body.sessionId,
      useCount,
    });
    return {
      redeemed: true,
      grant: {
        id: grant.id,
        approvalId: grant.approvalId,
        expiresAt: grant.expiresAt.toISOString(),
        useCount,
      },
    };
  });

  // Visible audit: powers `muon policy grants` and every operator surface.
  // Operator-only (like revoke): the list exposes grant metadata (workspaces,
  // payload digests, tool names, policy fingerprints) across every chat, which
  // the agent tier must not enumerate. Redemption stays content-bound.
  app.get("/", async (request) => {
    requireOperator(app, request);
    const query = listQuerySchema.parse(request.query);
    const now = new Date();
    const grants = await prisma.approvalGrant.findMany({
      where: {
        ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
        // "Active" is the SAME predicate redemption uses, horizon included, so
        // the operator's list can never show a grant that could not actually be
        // spent (or hide one that could).
        ...(query.activeOnly
          ? {
              revokedAt: null,
              expiresAt: {
                gt: now,
                lte: new Date(now.getTime() + APPROVAL_GRANT_HORIZON_MS),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return { grants };
  });

  // One-way revocation is the human's kill switch; idempotent (re-revoking a
  // revoked grant keeps the original stamp), operator-only, and effective on the
  // very next call because the redeem match requires `revokedAt: null`.
  app.post("/:grantId/revoke", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ grantId: z.string().min(1) })
      .parse(request.params);
    await prisma.approvalGrant.updateMany({
      where: { id: params.grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const grant = await prisma.approvalGrant.findUnique({
      where: { id: params.grantId },
    });
    if (!grant) {
      throw app.httpErrors.notFound(`Unknown grant '${params.grantId}'.`);
    }
    return { grant };
  });
}
