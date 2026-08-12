import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RECEIPT_ALLOWED_CLASSES } from "@muon/protocol";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { fingerprintManifest } from "../lib/receipt.js";

// ── P0.4 slice 2: content-bound receipt redemption ────────────────────────────
//
// The redemption mirror of `redeemGateAtRoute` (lib/gate.ts): validation and
// use-stamping are one guarded `updateMany`, no read-then-stamp TOCTOU. Unlike
// a route gate a receipt is MULTI-use within its TTL — that is the fatigue fix
// — but every use increments `useCount`, stamps `lastUsedAt`, and is audited by
// the seam's `approval.auto` event. ANY drift — payload digest, workspace,
// tool, jobId (⇒ a later run or a descendant), manifest fingerprint, expiry,
// revocation — falls outside the match and the caller files the gate exactly
// as today. A miss is 200/{redeemed:false}, never an error status: redemption
// is burn-only (agent tier can spend authority, never grant it), and the
// fail direction is always "ask a human", never deny and never allow.

const redeemBodySchema = z.object({
  taskId: z.string().min(1),
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  toolName: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // SEC-1: the operator-VISIBLE resolved target of THIS real tool call (edit/
  // read path or test command line), derived by the seam from the same input
  // that produced `payloadDigest`. Matched against the receipt's minted target
  // so a bait mint (visible path ≠ digest) can never redeem the hidden action.
  // Optional/nullable: a target-less action (path-less Glob/Grep) sends none and
  // matches only a target-less (NULL) receipt.
  resolvedTarget: z.string().min(1).nullish(),
});

const listQuerySchema = z.object({
  activeOnly: z.coerce.boolean().optional(),
  workspacePath: z.string().min(1).optional(),
});

export async function registerReceiptRoutes(app: FastifyInstance) {
  app.post("/redeem", async (request) => {
    const body = redeemBodySchema.parse(request.body);
    const miss = { redeemed: false as const };

    // (i) Corroborate the caller's run binding: the session must be a real
    // ledger row executing exactly this job. An agent cannot borrow another
    // run's receipt by naming its jobId.
    const session = await prisma.laneSession.findUnique({
      where: { id: body.sessionId },
    });
    if (!session || session.jobId !== body.jobId) {
      return miss;
    }

    // (ii) Belt-and-suspenders descendant fence: a delegate-mode job never
    // redeems (its own jobId never equals a receipt's anyway — receipts refuse
    // to mint in a delegate context).
    const job = await prisma.dispatchJob.findUnique({
      where: { id: body.jobId },
    });
    if (!job || job.capabilityMode === "delegate") {
      return miss;
    }

    // (iii) Manifest fingerprint recomputed from the CURRENT row: a manifest
    // widened after mint re-gates everything the receipt used to cover.
    const manifestFingerprint =
      job.delegationManifest != null
        ? fingerprintManifest(job.delegationManifest)
        : null;

    // (iv) Exact content match, then a guarded stamp. The class filter is the
    // last fence: even a hand-forged network/merge/ship row could never redeem.
    const now = new Date();
    const receipt = await prisma.approvalReceipt.findFirst({
      where: {
        taskId: body.taskId,
        jobId: body.jobId,
        workspacePath: body.workspacePath,
        toolName: body.toolName,
        // SEC-1: the human-visible target the operator approved MUST equal the
        // target of this real call. A bait receipt whose stored target came from
        // one action but whose digest came from another can satisfy at most one
        // of these two clauses, never both — so the hidden action re-gates.
        resolvedTarget: body.resolvedTarget ?? null,
        payloadDigest: body.payloadDigest,
        actionClass: { in: [...RECEIPT_ALLOWED_CLASSES] },
        manifestFingerprint,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!receipt) {
      return miss;
    }
    const stamped = await prisma.approvalReceipt.updateMany({
      where: { id: receipt.id, revokedAt: null, expiresAt: { gt: now } },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });
    if (stamped.count !== 1) {
      return miss;
    }
    const current = await prisma.approvalReceipt.findUnique({
      where: { id: receipt.id },
    });
    return {
      redeemed: true,
      receipt: {
        id: receipt.id,
        expiresAt: receipt.expiresAt.toISOString(),
        useCount: current?.useCount ?? receipt.useCount + 1,
      },
    };
  });

  // Visible audit: powers `muon policy receipts` and the inbox annotation.
  // Operator-only (like revoke): the list exposes receipt metadata (workspace,
  // payload digests, tool names, manifest fingerprints) across all workspaces,
  // which the agent tier must not enumerate. Redemption stays content-bound.
  app.get("/", async (request) => {
    requireOperator(app, request);
    const query = listQuerySchema.parse(request.query);
    const receipts = await prisma.approvalReceipt.findMany({
      where: {
        ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
        ...(query.activeOnly
          ? { revokedAt: null, expiresAt: { gt: new Date() } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return { receipts };
  });

  // One-way revocation is the human's kill switch; idempotent (re-revoking a
  // revoked receipt keeps the original stamp), operator-only.
  app.post("/:receiptId/revoke", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ receiptId: z.string().min(1) })
      .parse(request.params);
    await prisma.approvalReceipt.updateMany({
      where: { id: params.receiptId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const receipt = await prisma.approvalReceipt.findUnique({
      where: { id: params.receiptId },
    });
    if (!receipt) {
      throw app.httpErrors.notFound(`Unknown receipt '${params.receiptId}'.`);
    }
    return { receipt };
  });
}
