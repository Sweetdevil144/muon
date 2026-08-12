import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type ApprovalRequest as ApprovalRow,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RECEIPT_ALLOWED_CLASSES,
  WORKFLOW_AMENDABLE_STATUSES,
  WORKFLOW_AMENDED_EVENT_KIND,
  WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
  WORKFLOW_AMENDMENT_SPINE_WINDOW,
  amendWorkflowGateTag,
  applyWorkflowGateTag,
  approvalActionSchema,
  approvalEvidenceSchema,
  budgetRaiseGateTag,
  classifyToolAction,
  deriveWorkflowAmendments,
  describeGateTag,
  dispatchActionGateTag,
  isWorkflowAmendableStatus,
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  fleetGateTag,
  harnessCheckSchema,
  harnessConfigSchema,
  manualReviewAttestationSchema,
  mergeReviewRecordSchema,
  parseGateTag,
  type MergeReviewRecord,
  type ReviewCoverageCertification,
  workflowProposalSchema,
} from "@muon/protocol";
import {
  captureMergeBaseTarget,
  mergeTaskWorktree,
  recordProjectSetupConfirmation,
  resolveEffectiveProjectSetup,
  taskWorktreeCandidates,
  teardownTaskWorktreeProjectSetup,
  type MergeBaseTarget,
  type WorktreeMergeResult,
} from "@muon/core";
import { projectSetupConfirmationRequest } from "@muon/protocol/project-setup";
import { checkExecutionContainment } from "../lib/approval-containment.js";
import {
  OPERATOR_PRINCIPAL,
  agentJobPrincipal,
  authoringPrincipal,
  requireAgentTaskAccess,
  requireOperator,
  visibleTaskIdsForCapability,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  buildEventAuditStamp,
  ensureEventPrincipals,
  eventAuditData,
} from "../lib/event-audit.js";
import { hashAmendmentSteps, hashProposal } from "../lib/gate.js";
import {
  getStandingApproverGrant,
  releaseStandingApproverLease,
  renewStandingApproverLease,
} from "../lib/operator-settings.js";
import { mirrorToGraph } from "../lib/graph.js";
import { fingerprintManifest, renderCheckCommand } from "../lib/receipt.js";
import { certifyWorktreeReviewCoverage } from "../lib/review-certification.js";

/**
 * TODO 5.15 — best-effort audit row for an approval decision.
 * Never throws (the decision already landed). Logs on failure so a hole in
 * the trail is observable rather than silent.
 */
async function recordApprovalResolvedAudit(args: {
  approval: ApprovalRow;
  fromStatus: string;
  decisionNotesPresent: boolean;
}): Promise<void> {
  const actor = OPERATOR_PRINCIPAL;
  const stamp = buildEventAuditStamp({
    actor,
    accountable: actor,
    requestId: args.approval.id,
    payloadDiff: {
      status: { from: args.fromStatus, to: args.approval.status },
      kind: args.approval.kind,
      ...(args.decisionNotesPresent ? { decisionNotesPresent: true } : {}),
    },
  });
  await ensureEventPrincipals(stamp, actor, actor);
  try {
    await prisma.event.create({
      data: {
        laneId: "muon",
        taskId: args.approval.taskId,
        kind: "approval.resolved",
        message: `approval ${args.approval.status}: ${args.approval.kind}`,
        metadata: {
          approvalId: args.approval.id,
          kind: args.approval.kind,
          status: args.approval.status,
        },
        ...eventAuditData(stamp),
      },
    });
  } catch (error) {
    console.error(
      `[audit] approval.resolved event failed for ${args.approval.id}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const createApprovalSchema = z.object({
  taskId: z.string().min(1),
  requestedBy: z.string().min(2),
  kind: approvalActionSchema,
  reason: z.string().min(5),
  // Structured gate binding (ADR-0010 Part B): the orchestrator files a gate
  // with the action+payload tag the ROUTE later redeems it against. For a
  // `kind:"gate"` approval this is REQUIRED and the stored `reason` + `gateTag`
  // are re-derived SERVER-SIDE from it (informed consent, F-1); optional/ignored
  // for non-gate approvals (merge/command/…), which keep their agent `reason`.
  gateTag: z.string().min(1).optional(),
  evidence: approvalEvidenceSchema.optional(),
  // Checkpoint edge (P0.1 Slice A): the DispatchJob whose execution filed this
  // approval. Agent-supplied binding, corroborated by
  // `evidence.details.sessionId` → `LaneSession.jobId`; gives a resume planner
  // a durable, indexed job→gate join. Optional: every existing caller omits it.
  jobId: z.string().min(1).optional(),
});

const resolveApprovalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  decisionNotes: z.string().min(2).optional(),
  // P0.4: EXPLICIT operator opt-in to also mint a content-bound, expiring
  // receipt for THIS exact approved action. Never minted by default; bounds
  // 1 minute – 1 hour. Everything the receipt binds is server-derived from the
  // stored approval + job rows, never from this body.
  receipt: z
    .object({ ttlMs: z.number().int().min(60_000).max(3_600_000) })
    .optional(),
  // Explicit operator-only REVIEW BLIND attestation. Both coordinates and the
  // digest must exactly match a fresh server recomputation. It cannot bypass
  // stale/missing graph evidence and full-auto never supplies it.
  manualReview: manualReviewAttestationSchema.optional(),
});

const MERGE_EXECUTION_LEASE_MS = 60_000;
const MERGE_EXECUTION_HEARTBEAT_MS = 15_000;

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function repositoryMergeLeaseKey(repoRoot: string): string {
  return createHash("sha256")
    .update(`muon-repository-merge-v1\0${repoRoot}`)
    .digest("hex");
}

async function acquireRepositoryMergeLease(input: {
  repoRoot: string;
  ref: string;
  approvalId: string;
  attemptId: string;
  leaseExpiresAt: Date;
}): Promise<string | null> {
  const key = repositoryMergeLeaseKey(input.repoRoot);
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.mergeRepositoryLease.deleteMany({
          where: { key, leaseExpiresAt: { lte: new Date() } },
        });
        await tx.mergeRepositoryLease.create({
          data: {
            key,
            repoRoot: input.repoRoot,
            ref: input.ref,
            approvalId: input.approvalId,
            attemptId: input.attemptId,
            leaseExpiresAt: input.leaseExpiresAt,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return key;
  } catch (error) {
    // P2002 is the active repository/ref owner. P2034 is a serializable write
    // conflict: another claimant won this instant, so fail closed and retry.
    if (prismaErrorCode(error) === "P2002" || prismaErrorCode(error) === "P2034") {
      return null;
    }
    throw error;
  }
}

const mergeExecutionRecordSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({
        taskId: z.string().min(1),
        repoRoot: z.string().min(1).nullable(),
        worktreePath: z.string().min(1).nullable(),
        title: z.string().nullable(),
      })
      .strict(),
    expectedBase: z
      .object({
        ref: z.string().startsWith("refs/heads/"),
        head: z.string().regex(/^[0-9a-f]{7,64}$/i),
      })
      .strict()
      .nullable(),
    startedAt: z.string().datetime(),
    worktreeHead: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    verifiedWorktreeHead: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional(),
    finishedAt: z.string().datetime().optional(),
    outcome: z
      .object({
        status: z.enum([
          "merged",
          "no-op",
          "conflict",
          "blocked",
          "failed",
        ]),
        reason: z.string().optional(),
        sha: z.string().optional(),
        mergeCommit: z.string().optional(),
        message: z.string().optional(),
        changedFiles: z.number().int().nonnegative().optional(),
        recovered: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type MergeExecutionRecord = z.infer<typeof mergeExecutionRecordSchema>;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function executionOutcome(
  record: MergeExecutionRecord | undefined
): WorktreeMergeResult | undefined {
  return record?.outcome as WorktreeMergeResult | undefined;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((value, index) => value === actual[index]);
}

function noWorktreeReview(approvalId: string): ReviewCoverageCertification {
  return {
    status: "certified",
    verdict: "no-op",
    changedFiles: [],
    artifactDigest: createHash("sha256")
      .update(`muon-no-worktree-v1\0${approvalId}`)
      .digest("hex"),
  };
}

function durableReviewRecord(
  certification: ReviewCoverageCertification,
  method: MergeReviewRecord["method"]
): MergeReviewRecord {
  const record: MergeReviewRecord = {
    version: 1,
    method,
    verdict:
      method === "operator-manual"
        ? "review-blind-attested"
        : certification.status === "certified"
          ? certification.verdict
          : "review-blind-attested",
    artifactDigest: certification.artifactDigest,
    changedFiles: certification.changedFiles,
    blindFiles:
      certification.status === "blocked"
        ? (certification.blindFiles ?? [])
        : [],
    indexedCommit: certification.indexedCommit,
    baselineCommit: certification.baselineCommit,
    headCommit: certification.headCommit,
    reviewedAt: new Date().toISOString(),
    reviewer: "operator",
  };
  return mergeReviewRecordSchema.parse(record);
}

/** Greptile P1 (PR #29): merge-success teardowns are fire-and-forget so the
 *  approval response never blocks on repo-declared commands — but a SIGTERM
 *  mid-teardown must not silently abandon worktree removal + the audit row.
 *  Track them and drain (bounded) when the server closes. */
const inFlightTeardowns = new Set<Promise<void>>();
const TEARDOWN_DRAIN_CAP_MS = 20_000;

export async function registerApprovalRoutes(app: FastifyInstance) {
  app.addHook("onClose", async () => {
    if (inFlightTeardowns.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...inFlightTeardowns]),
      new Promise((resolve) => setTimeout(resolve, TEARDOWN_DRAIN_CAP_MS)),
    ]);
  });
  /**
   * INFORMED CONSENT (ADR-0010 Part B / review F-1 + F-2): for a gate, the human
   * must approve EXACTLY what the route will enforce. So the stored/displayed
   * `reason` and the enforced `gateTag` are DERIVED SERVER-SIDE from the parsed
   * binding, never the agent's free text, and an apply gate is additionally
   * bound to the proposal CONTENT hash at file time (a later proposal edit then
   * 403s at apply). Returns the canonical `{ reason, gateTag }` to store, or
   * throws a 4xx when the binding is missing/invalid.
   */
  async function deriveGateBinding(
    rawTag: string
  ): Promise<{ reason: string; gateTag: string }> {
    const parsed = parseGateTag(rawTag);
    if (!parsed || parsed.action === "other") {
      throw app.httpErrors.badRequest(
        "Unrecognized gateTag, a gate must bind a known action (set_fleet | apply_workflow | amend_workflow | dispatch_action | raise_budget)."
      );
    }
    if (parsed.action === "raise_budget") {
      // A delegation-budget raise (S9): the root jobId + the new pool live in the
      // tag, so re-canonicalize + describe from them, the human sees exactly which
      // job's pool the dispatch route will raise, and to what.
      const canonical = budgetRaiseGateTag(parsed.jobId, parsed.poolMs);
      return { reason: describeGateTag(canonical), gateTag: canonical };
    }
    if (parsed.action === "set_fleet") {
      // The counts live in the tag, so re-canonicalize + describe from them: the
      // human sees the exact counts the fleet route will enforce.
      const canonical = fleetGateTag(parsed.counts);
      return { reason: describeGateTag(canonical), gateTag: canonical };
    }
    if (parsed.action === "dispatch_action") {
      // A one-shot full-auto vendor action (ADR-0013 v2): the vendor + action
      // live in the tag, so re-canonicalize + describe from them, the human sees
      // exactly which full-auto action the dispatch route will authorize.
      const canonical = dispatchActionGateTag(parsed.vendor, parsed.verb);
      return { reason: describeGateTag(canonical), gateTag: canonical };
    }
    if (parsed.action === "amend_workflow") {
      // ADR-0045 D2: an amendment is gated exactly as hard as an apply, so it
      // is enriched exactly as hard. The appended steps live on the run's event
      // spine (the inert draft), so ENRICH from there: bind the appended-steps
      // content hash and render the real titles, and the human sees the steps
      // they are authorizing rather than a digest. A draft that is already
      // applied, or a run no longer amendable, cannot be gated at all.
      const run = await prisma.workflowRun.findUnique({
        where: { id: parsed.runId },
      });
      if (!run) {
        throw app.httpErrors.badRequest(
          `Cannot gate an amendment of unknown workflow run '${parsed.runId}'.`
        );
      }
      if (!isWorkflowAmendableStatus(run.status)) {
        throw app.httpErrors.conflict(
          `Only a ${WORKFLOW_AMENDABLE_STATUSES.join(" or ")} workflow run can be gated for an amendment; run '${parsed.runId}' is ${run.status}.`
        );
      }
      const rows = await prisma.event.findMany({
        where: {
          taskId: parsed.runId,
          kind: {
            in: [
              WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
              WORKFLOW_AMENDED_EVENT_KIND,
            ],
          },
        },
        // NEWEST window, folded oldest→newest — same direction (and same
        // reason) as the amend route's spine read: the older window can drop
        // an `applied` row while keeping its `proposed` one, which would offer
        // a gate for an amendment that already landed.
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: WORKFLOW_AMENDMENT_SPINE_WINDOW,
      });
      rows.reverse();
      const amendment = deriveWorkflowAmendments(
        rows.map((row) => ({
          kind: row.kind,
          timestamp: row.timestamp.toISOString(),
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
        }))
      ).find((entry) => entry.id === parsed.amendmentId);
      if (!amendment || amendment.workflowRunId !== parsed.runId) {
        throw app.httpErrors.badRequest(
          `Cannot gate unknown amendment '${parsed.amendmentId}' for workflow run '${parsed.runId}'.`
        );
      }
      if (amendment.status !== "proposed") {
        throw app.httpErrors.conflict(
          `Amendment '${parsed.amendmentId}' is already applied; it cannot be gated again.`
        );
      }
      const canonical = amendWorkflowGateTag(
        parsed.runId,
        parsed.amendmentId,
        hashAmendmentSteps(amendment.steps)
      );
      // The budget an appended loop carries is part of what the human decides
      // (ADR-0045 D4), so it is rendered, not hidden behind the hash.
      const titles = amendment.steps
        .map(
          (step) =>
            `${step.title}${
              step.loop
                ? ` [loop ${step.loop.kind} x${step.loop.maxIterations}${
                    step.loop.maxWallMs ? `, ${step.loop.maxWallMs}ms` : ""
                  }]`
                : ""
            }`
        )
        .join("; ");
      return {
        reason: `${describeGateTag(canonical)}: append ${amendment.steps.length} step(s): ${titles}`,
        gateTag: canonical,
      };
    }
    // apply_workflow: the steps live in the DB, so ENRICH server-side from run X
    //, bind the current proposal's content hash and render its real summary, so
    // the human can't be shown one plan while another is enforced (and a
    // post-approval edit breaks the hash).
    const run = await prisma.workflowRun.findUnique({
      where: { id: parsed.runId },
    });
    if (!run) {
      throw app.httpErrors.badRequest(
        `Cannot gate apply of unknown workflow run '${parsed.runId}'.`
      );
    }
    if (run.status !== "proposed") {
      throw app.httpErrors.conflict(
        "Only a proposed workflow run can be gated for apply."
      );
    }
    const proposal = workflowProposalSchema.parse(run.proposal);
    const canonical = applyWorkflowGateTag(parsed.runId, hashProposal(proposal));
    const titles = proposal.steps.map((step) => step.title).join("; ");
    return {
      reason: `${describeGateTag(canonical)}: "${proposal.summary}", ${proposal.steps.length} step(s): ${titles}`,
      gateTag: canonical,
    };
  }

  async function currentMergeReview(approvalId: string): Promise<{
    certification: ReviewCoverageCertification;
    target: {
      taskId: string;
      repoRoot: string | null;
      worktreePath: string | null;
      title: string | null;
      expectedBase: MergeBaseTarget | null;
    };
  }> {
    const pending = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      select: { id: true, kind: true, taskId: true },
    });
    if (!pending) {
      throw app.httpErrors.notFound(`Unknown approval '${approvalId}'.`);
    }
    if (pending.kind !== "merge") {
      throw app.httpErrors.badRequest(
        "Review certification is available only for merge approvals."
      );
    }
    const task = await prisma.task.findUnique({
      where: { id: pending.taskId },
      select: { workspacePath: true, title: true },
    });
    const repoRoot = task?.workspacePath ?? null;
    let worktreePath: string | null = null;
    if (repoRoot) {
      const candidates = taskWorktreeCandidates(repoRoot, pending.taskId);
      worktreePath =
        candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
    }
    let expectedBase: MergeBaseTarget | null = null;
    let certification: ReviewCoverageCertification;
    if (!repoRoot) {
      certification = noWorktreeReview(pending.id);
    } else if (!worktreePath || !existsSync(worktreePath)) {
      certification = {
        status: "blocked",
        blockCode: "unavailable",
        changedFiles: [],
        artifactDigest: createHash("sha256")
          .update(`muon-missing-worktree-v1\0${pending.id}\0${repoRoot}`)
          .digest("hex"),
        reason:
          "The task has a governed workspace but its expected isolated worktree is missing. Refusing to treat missing merge evidence as a no-op.",
      };
    } else {
      certification = await certifyWorktreeReviewCoverage({
        repoRoot,
        worktreePath,
      });
      try {
        expectedBase = await captureMergeBaseTarget({ repoRoot });
      } catch (error) {
        certification = {
          status: "blocked",
          blockCode: "unavailable",
          changedFiles: certification.changedFiles,
          artifactDigest: certification.artifactDigest,
          reason: `The primary merge target is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (
        expectedBase &&
        certification.headCommit &&
        expectedBase.head !== certification.headCommit
      ) {
        certification = {
          status: "blocked",
          blockCode: "stale",
          changedFiles: certification.changedFiles,
          artifactDigest: certification.artifactDigest,
          baselineCommit: certification.baselineCommit,
          headCommit: certification.headCommit,
          reason:
            "The primary branch advanced while review evidence was being captured. Refresh review before approving.",
        };
      }
    }
    return {
      certification,
      target: {
        taskId: pending.taskId,
        repoRoot,
        worktreePath,
        title: task?.title ?? null,
        expectedBase,
      },
    };
  }

  app.get("/", async (request) => {
    const visibleTaskIds = request.agentJobCapability
      ? await visibleTaskIdsForCapability(request.agentJobCapability)
      : undefined;
    const approvals = await prisma.approvalRequest.findMany({
      where: visibleTaskIds ? { taskId: { in: visibleTaskIds } } : undefined,
      orderBy: { createdAt: "desc" },
      include: { task: true },
    });
    // SERVER-derived lane attribution for vendor-scoped standing consent: the
    // vendor comes from the ledger's own job row for the approval's persisted
    // job binding, never from anything a caller asserts at read time. An
    // approval with no binding (or an unknown job) gets null, which the
    // desktop's subset coverage treats as NOT covered — fail closed.
    const jobIds = [
      ...new Set(
        approvals
          .map((approval) => approval.jobId)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      ),
    ];
    const vendorByJob = new Map<string, string>(
      jobIds.length === 0
        ? []
        : (
            await prisma.dispatchJob.findMany({
              where: { id: { in: jobIds } },
              select: { id: true, vendor: true, capabilityMode: true },
            })
          )
            // ONLY a job that acts on its OWN lane attributes a lane. A gate
            // filed by a COORDINATOR (orchestrator / attached-coordinator) is
            // filed by the coordinator's job but its authority acts elsewhere
            // — `set_fleet({codex:3})`, `raise_budget` over the whole tree,
            // `apply_workflow` across lanes. Attributing those to the
            // coordinator's own vendor would let a consent granted for lane A
            // auto-approve an action on lane B. Absent coordinate ⇒ the
            // desktop's subset coverage fails closed, which is the rule.
            .filter(
              (job) =>
                job.capabilityMode !== "orchestrator" &&
                job.capabilityMode !== ATTACHED_COORDINATOR_CAPABILITY_MODE
            )
            .map((job) => [job.id, job.vendor])
    );
    return {
      approvals: approvals.map((approval) => ({
        ...approval,
        laneVendor: approval.jobId
          ? (vendorByJob.get(approval.jobId) ?? null)
          : null,
      })),
    };
  });

  app.post("/", async (request, reply) => {
    const payload = createApprovalSchema.parse(request.body);
    await requireAgentTaskAccess(app, request, payload.taskId);
    if (payload.kind === "command" && !payload.evidence) {
      throw app.httpErrors.badRequest(
        "Command approvals require structured evidence: exact action, scope, risk, impact, and safe payload details."
      );
    }
    // PROVENANCE FROM AUTH (P3-A / H2 forgery class): `requestedBy` is derived
    // from the authenticated tier, not the body, an agent-tier caller (the
    // orchestrator files gates legitimately as an agent) cannot forge a "human:*"
    // requester. (Filing a request is agent-tier; the DECISION, PATCH, is
    // operator-only.)
    const requestedBy = request.agentJobCapability
      ? agentJobPrincipal(request.agentJobCapability)
      : authoringPrincipal(request.tier, payload.requestedBy);

    // A ROUTE-REDEEMABLE gate (the orchestrator's set_fleet / apply_workflow,
    // which always carry a gateTag) gets a server-derived subject + binding, so
    // the human sees exactly what will be enforced (F-1/F-2). A gateTag-LESS
    // `gate` is a loop/workflow ESCALATION notice (loop-runner / workflow-runner)
    //, it keeps its human-readable reason and stays inert: with no gateTag it
    // can never match a route's computed tag, so it authorizes nothing. Every
    // non-gate kind (merge/command/…) also keeps its reason.
    const { reason, gateTag } =
      payload.kind === "gate" && payload.gateTag !== undefined
        ? await deriveGateBinding(payload.gateTag)
        : {
            reason: payload.reason,
            // T5: a project-setup confirmation key rides a COMMAND approval.
            // It is not route-redeemable (redeemGateAtRoute only matches
            // kind:"gate" tags); it keys the confirmation record the approve
            // path writes, and it makes the gate DEDUPABLE below.
            gateTag:
              payload.kind === "command" &&
              payload.gateTag?.startsWith("project-setup:")
                ? payload.gateTag
                : undefined,
          };

    // T5 dedupe: every dispatch of an unconfirmed repo re-files the same
    // setup gate; the operator must see ONE decision, not one per dispatch.
    // Server-side so every surface dedupes identically.
    if (gateTag?.startsWith("project-setup:")) {
      const pending = await prisma.approvalRequest.findFirst({
        where: { taskId: payload.taskId, gateTag, status: "pending" },
      });
      if (pending) {
        reply.code(200);
        return { approval: pending, deduplicated: true };
      }
    }

    const approval = await prisma.approvalRequest.create({
      data: {
        taskId: payload.taskId,
        requestedBy,
        kind: payload.kind,
        reason,
        gateTag,
        evidence: payload.evidence,
        jobId: request.agentJobCapability?.jobId ?? payload.jobId,
      },
    });

    await prisma.task.update({
      where: { id: payload.taskId },
      data: { status: "review" },
    });

    mirrorToGraph((graph) =>
      graph.recordApproval({
        approvalId: approval.id,
        taskId: approval.taskId,
        kind: approval.kind,
        status: approval.status,
        createdAt: approval.createdAt.toISOString(),
      })
    );

    reply.code(201);
    return { approval };
  });

  // ── Standing-approver lease (Full Auto) ────────────────────────────────────
  //
  // Two path segments, so none of these can ever collide with "/:approvalId".
  //
  // Tier asymmetry, deliberate and mirrored from the R4 mining flag: WRITE is
  // operator-only — asserting that a human's standing consent is live right now
  // is precisely the claim an agent tier must never be able to make — while READ
  // is reachable by the SHARED agent bearer, because MUON's own runner is the
  // reader and has to resolve it to decide whether a coordinator may gate
  // normally instead of denying fast. A per-job capability, the credential a
  // VENDOR process actually holds, is refused: what the runner learns is one
  // bounded fact about MUON's own posture, and it must not reach a sub-agent.
  app.get("/standing-approver/lease", async (request) => {
    if (request.agentJobCapability) {
      throw app.httpErrors.forbidden(
        "A per-job capability cannot read the standing-approver lease."
      );
    }
    return { standingApprover: await getStandingApproverGrant() };
  });

  // Body-less on purpose: the TTL is fixed server-side, so this request carries
  // no authority field to bound, forge, or widen — only the operator credential.
  app.put("/standing-approver/lease", async (request) => {
    requireOperator(app, request);
    return { standingApprover: await renewStandingApproverLease() };
  });

  app.delete("/standing-approver/lease", async (request) => {
    requireOperator(app, request);
    return { standingApprover: await releaseStandingApproverLease() };
  });

  app.get("/:approvalId/review", async (request) => {
    requireOperator(app, request);
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const { certification } = await currentMergeReview(params.approvalId);
    return { certification };
  });

  async function resolveMergeApproval(
    existing: ApprovalRow,
    payload: z.infer<typeof resolveApprovalSchema>
  ) {
    const parsedExistingExecution = mergeExecutionRecordSchema.safeParse(
      existing.mergeExecution
    );
    const existingExecution = parsedExistingExecution.success
      ? parsedExistingExecution.data
      : undefined;

    // A terminal decision is immutable. Retrying the same request returns the
    // durable outcome; an opposite decision fails closed.
    if (existing.status !== "pending") {
      const merge = executionOutcome(existingExecution);
      if (existing.status === "approved") {
        if (
          payload.status === "approved" &&
          existing.mergeExecutionStatus === "succeeded" &&
          (merge?.status === "merged" || merge?.status === "no-op")
        ) {
          return { approval: existing, merge };
        }
        throw app.httpErrors.conflict(
          "This merge approval has no valid durable successful execution outcome."
        );
      }
      if (existing.status === payload.status) {
        return { approval: existing, ...(merge ? { merge } : {}) };
      }
      throw app.httpErrors.conflict(
        merge && "reason" in merge
          ? `Approval is already ${existing.status}: ${merge.reason}`
          : `Approval is already ${existing.status}.`
      );
    }

    if (payload.status === "rejected") {
      if (existing.mergeExecutionStatus === "executing") {
        throw app.httpErrors.conflict(
          "Merge execution is already in progress and cannot be re-decided."
        );
      }
      const decidedAt = new Date();
      const claimed = await prisma.approvalRequest.updateMany({
        where: {
          id: existing.id,
          status: "pending",
          mergeExecutionStatus: null,
        },
        data: {
          status: "rejected",
          decisionNotes: payload.decisionNotes,
          decidedAt,
        },
      });
      if (claimed.count !== 1) {
        const winner = await prisma.approvalRequest.findUnique({
          where: { id: existing.id },
        });
        if (winner?.status === "rejected") {
          return { approval: winner };
        }
        throw app.httpErrors.conflict(
          "Approval was decided concurrently. Refresh before retrying."
        );
      }
      const approval = {
        ...existing,
        status: "rejected",
        decisionNotes: payload.decisionNotes ?? null,
        decidedAt,
      };
      mirrorToGraph((graph) =>
        graph.recordApproval({
          approvalId: approval.id,
          taskId: approval.taskId,
          kind: approval.kind,
          status: approval.status,
          createdAt: approval.createdAt.toISOString(),
          decidedAt: approval.decidedAt?.toISOString(),
        })
      );
      return { approval };
    }

    let reviewRecord: MergeReviewRecord;
    let execution: MergeExecutionRecord;
    const now = new Date();
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + MERGE_EXECUTION_LEASE_MS);
    const recoveringExecution =
      existing.mergeExecutionStatus === "executing";

    if (existing.mergeExecutionStatus === "executing") {
      if (
        !existingExecution ||
        !existing.mergeExecutionAttemptId ||
        !existing.mergeExecutionLeaseExpiresAt
      ) {
        throw app.httpErrors.conflict(
          "The durable merge execution record is incomplete. Refusing recovery."
        );
      }
      if (existing.mergeExecutionLeaseExpiresAt.getTime() > now.getTime()) {
        throw app.httpErrors.conflict(
          "Merge execution is already in progress. Wait for it to finish before retrying."
        );
      }
      const parsedReview = mergeReviewRecordSchema.safeParse(
        existing.reviewCertification
      );
      if (!parsedReview.success) {
        throw app.httpErrors.conflict(
          "The crashed merge attempt has no valid durable review certification."
        );
      }
      reviewRecord = parsedReview.data;
      execution = existingExecution;
      const reclaimed = await prisma.approvalRequest.updateMany({
        where: {
          id: existing.id,
          status: "pending",
          mergeExecutionStatus: "executing",
          mergeExecutionAttemptId: existing.mergeExecutionAttemptId,
          mergeExecutionLeaseExpiresAt: { lte: now },
        },
        data: {
          mergeExecutionAttemptId: attemptId,
          mergeExecutionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      if (reclaimed.count !== 1) {
        throw app.httpErrors.conflict(
          "Another recovery attempt claimed this merge. Refresh before retrying."
        );
      }
    } else {
      if (existing.mergeExecutionStatus !== null) {
        throw app.httpErrors.conflict(
          "The merge execution state is not recoverable from pending."
        );
      }
      const current = await currentMergeReview(existing.id);
      const certification = current.certification;
      if (payload.manualReview) {
        if (
          certification.status !== "blocked" ||
          certification.blockCode !== "review-blind" ||
          !certification.blindFiles
        ) {
          throw app.httpErrors.conflict(
            certification.status === "blocked"
              ? `Manual review cannot bypass ${certification.blockCode} evidence: ${certification.reason}`
              : "Manual review attestation is not needed because the graph already certifies this artifact."
          );
        }
        if (
          payload.manualReview.artifactDigest !==
            certification.artifactDigest ||
          !sameStrings(
            payload.manualReview.blindFiles,
            certification.blindFiles
          )
        ) {
          throw app.httpErrors.conflict(
            "The worktree changed after review was opened. Refresh the review and inspect the current blind files before approving."
          );
        }
        reviewRecord = durableReviewRecord(certification, "operator-manual");
      } else if (certification.status !== "certified") {
        throw app.httpErrors.conflict(
          `Merge review certification failed: ${certification.reason}`
        );
      } else {
        reviewRecord = durableReviewRecord(certification, "gitnexus");
      }

      const { expectedBase, ...target } = current.target;
      if (target.repoRoot && (!target.worktreePath || !expectedBase)) {
        throw app.httpErrors.conflict(
          "The expected worktree or reviewed primary branch target is unavailable."
        );
      }
      execution = {
        version: 1,
        target,
        expectedBase,
        startedAt: now.toISOString(),
      };
      const claimed = await prisma.approvalRequest.updateMany({
        where: {
          id: existing.id,
          status: "pending",
          mergeExecutionStatus: null,
        },
        data: {
          // The human decision is intentionally NOT final yet.
          decisionNotes: payload.decisionNotes,
          reviewCertification: jsonValue(reviewRecord),
          mergeExecutionStatus: "executing",
          mergeExecutionAttemptId: attemptId,
          mergeExecutionLeaseExpiresAt: leaseExpiresAt,
          mergeExecution: jsonValue(execution),
        },
      });
      if (claimed.count !== 1) {
        const winner = await prisma.approvalRequest.findUnique({
          where: { id: existing.id },
        });
        if (
          winner?.status === "approved" &&
          winner.mergeExecutionStatus === "succeeded"
        ) {
          const winnerExecution = mergeExecutionRecordSchema.safeParse(
            winner.mergeExecution
          );
          const merge = winnerExecution.success
            ? executionOutcome(winnerExecution.data)
            : undefined;
          return { approval: winner, ...(merge ? { merge } : {}) };
        }
        throw app.httpErrors.conflict(
          "Another request claimed this pending merge. Refresh before retrying."
        );
      }
    }

    const { target, expectedBase } = execution;
    let repositoryLeaseKey: string | null = null;
    if (target.repoRoot && expectedBase) {
      repositoryLeaseKey = await acquireRepositoryMergeLease({
        repoRoot: target.repoRoot,
        ref: expectedBase.ref,
        approvalId: existing.id,
        attemptId,
        leaseExpiresAt,
      });
      if (!repositoryLeaseKey) {
        if (recoveringExecution) {
          await prisma.approvalRequest.updateMany({
            where: {
              id: existing.id,
              status: "pending",
              mergeExecutionStatus: "executing",
              mergeExecutionAttemptId: attemptId,
            },
            data: { mergeExecutionLeaseExpiresAt: new Date() },
          });
        } else {
          await prisma.approvalRequest.updateMany({
            where: {
              id: existing.id,
              status: "pending",
              mergeExecutionStatus: "executing",
              mergeExecutionAttemptId: attemptId,
            },
            data: {
              mergeExecutionStatus: null,
              mergeExecutionAttemptId: null,
              mergeExecutionLeaseExpiresAt: null,
            },
          });
        }
        throw app.httpErrors.conflict(
          "Another governed merge is already mutating this repository branch. Wait for it to finish, then refresh review and retry."
        );
      }
    }

    let leaseRefreshInFlight: Promise<void> | null = null;
    let leaseOwnershipLost = false;
    const refreshExecutionLeases = async (): Promise<void> => {
      if (!repositoryLeaseKey) return;
      if (leaseOwnershipLost) {
        throw new Error(
          "The repository merge lease was reclaimed by another execution."
        );
      }
      const refreshedAt = new Date();
      const refreshedUntil = new Date(
        refreshedAt.getTime() + MERGE_EXECUTION_LEASE_MS
      );
      const [approvalLease, repositoryLease] = await prisma.$transaction([
        prisma.approvalRequest.updateMany({
          where: {
            id: existing.id,
            status: "pending",
            mergeExecutionStatus: "executing",
            mergeExecutionAttemptId: attemptId,
          },
          data: { mergeExecutionLeaseExpiresAt: refreshedUntil },
        }),
        prisma.mergeRepositoryLease.updateMany({
          where: {
            key: repositoryLeaseKey,
            approvalId: existing.id,
            attemptId,
          },
          data: { leaseExpiresAt: refreshedUntil },
        }),
      ]);
      if (approvalLease.count !== 1 || repositoryLease.count !== 1) {
        leaseOwnershipLost = true;
        throw new Error(
          "The merge execution or repository lease was reclaimed before completion."
        );
      }
    };
    const heartbeat = () => {
      if (leaseRefreshInFlight || leaseOwnershipLost) return;
      leaseRefreshInFlight = refreshExecutionLeases()
        .catch(() => undefined)
        .finally(() => {
          leaseRefreshInFlight = null;
        });
    };
    const heartbeatTimer = repositoryLeaseKey
      ? setInterval(heartbeat, MERGE_EXECUTION_HEARTBEAT_MS)
      : null;
    heartbeatTimer?.unref?.();
    const synchronouslyRefreshExecutionLeases = async () => {
      try {
        await leaseRefreshInFlight;
        await refreshExecutionLeases();
      } catch {
        throw app.httpErrors.conflict(
          "The merge execution lease expired or was reclaimed before the repository operation completed."
        );
      }
    };

    const expireExecutionAndReleaseRepositoryLease =
      async (): Promise<void> => {
        if (!repositoryLeaseKey) return;
        const expiredAt = new Date();
        await prisma.$transaction(
          async (tx) => {
            await tx.approvalRequest.updateMany({
              where: {
                id: existing.id,
                status: "pending",
                mergeExecutionStatus: "executing",
                mergeExecutionAttemptId: attemptId,
              },
              data: { mergeExecutionLeaseExpiresAt: expiredAt },
            });
            await tx.mergeRepositoryLease.deleteMany({
              where: {
                key: repositoryLeaseKey!,
                approvalId: existing.id,
                attemptId,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      };

    let mergeResult: WorktreeMergeResult | undefined;
    let mergeFailure: { error: unknown } | null = null;
    try {
      if (!target.repoRoot && !target.worktreePath) {
        mergeResult = {
          status: "no-op",
          reason: "The task has no governed workspace — nothing to merge.",
        };
      } else if (
        !target.repoRoot ||
        !target.worktreePath ||
        !expectedBase ||
        !existsSync(target.worktreePath)
      ) {
        mergeResult = {
          status: "blocked",
          reason:
            "The expected governed worktree or reviewed primary target is missing. No merge was executed.",
        };
      } else {
        const { repoRoot, worktreePath } = target;
        mergeResult = await mergeTaskWorktree({
          repoRoot,
          worktreePath,
          message: `MUON: land ${target.title ?? existing.id}`,
          expectedBase,
          // Recovery is allowed only for a commit whose review verification was
          // itself persisted before the primary branch could mutate.
          expectedWorktreeHead: execution.verifiedWorktreeHead,
          onArtifactCaptured: async ({ worktreeHead }) => {
            const checkpointAt = new Date();
            const capturedExecution: MergeExecutionRecord = {
              ...execution,
              worktreeHead,
            };
            const captured = await prisma.approvalRequest.updateMany({
              where: {
                id: existing.id,
                status: "pending",
                mergeExecutionStatus: "executing",
                mergeExecutionAttemptId: attemptId,
                mergeExecutionLeaseExpiresAt: { gt: checkpointAt },
              },
              data: {
                mergeExecution: jsonValue(capturedExecution),
                mergeExecutionLeaseExpiresAt: new Date(
                  checkpointAt.getTime() + MERGE_EXECUTION_LEASE_MS
                ),
              },
            });
            if (captured.count !== 1) {
              throw new Error(
                "Lost the durable merge execution claim before artifact capture."
              );
            }
            execution = capturedExecution;
          },
          verifyCapturedArtifact: async () => {
            const current = await certifyWorktreeReviewCoverage({
              repoRoot,
              worktreePath,
            });
            const sameArtifact =
              current.artifactDigest === reviewRecord.artifactDigest;
            const sameManualBlindSet =
              reviewRecord.method !== "operator-manual" ||
              current.status === "certified" ||
              (current.status === "blocked" &&
                current.blockCode === "review-blind" &&
                sameStrings(
                  current.blindFiles ?? [],
                  reviewRecord.blindFiles
                ));
            const reviewStillValid =
              sameArtifact &&
              sameManualBlindSet &&
              (reviewRecord.method === "operator-manual"
                ? current.status === "certified" ||
                  (current.status === "blocked" &&
                    current.blockCode === "review-blind")
                : current.status === "certified");
            return reviewStillValid
              ? { ok: true }
              : {
                  ok: false,
                  reason:
                    "The reviewed artifact or its required graph evidence changed before merge. Refresh review and approve the current worktree.",
                };
          },
          onArtifactVerified: async ({ worktreeHead }) => {
            const checkpointAt = new Date();
            const verifiedExecution: MergeExecutionRecord = {
              ...execution,
              worktreeHead,
              verifiedWorktreeHead: worktreeHead,
            };
            const verified = await prisma.approvalRequest.updateMany({
              where: {
                id: existing.id,
                status: "pending",
                mergeExecutionStatus: "executing",
                mergeExecutionAttemptId: attemptId,
                mergeExecutionLeaseExpiresAt: { gt: checkpointAt },
              },
              data: {
                mergeExecution: jsonValue(verifiedExecution),
                mergeExecutionLeaseExpiresAt: new Date(
                  checkpointAt.getTime() + MERGE_EXECUTION_LEASE_MS
                ),
              },
            });
            if (verified.count !== 1) {
              throw new Error(
                "Lost the durable merge execution claim before verified artifact persistence."
              );
            }
            execution = verifiedExecution;
          },
          beforeBaseMutation: async () => {
            await synchronouslyRefreshExecutionLeases();
          },
        });
        if (
          (mergeResult.status === "merged" ||
            mergeResult.status === "no-op") &&
          (!execution.verifiedWorktreeHead ||
            (mergeResult.status === "merged" &&
              (mergeResult.sha !== execution.verifiedWorktreeHead ||
                !mergeResult.mergeCommit)))
        ) {
          mergeResult = {
            status: "failed",
            reason:
              "Merge executor returned success without a matching durable verified worktree commit.",
          };
        }
      }
      if (repositoryLeaseKey) {
        await synchronouslyRefreshExecutionLeases();
      }
    } catch (error) {
      mergeFailure = { error };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await leaseRefreshInFlight;
    }
    if (mergeFailure) {
      // Stop and drain heartbeat work before cleanup; otherwise an already
      // queued refresh could re-extend the approval lease after repository
      // release. If the database itself is unavailable, the existing expiries
      // remain the fail-closed backstop.
      await expireExecutionAndReleaseRepositoryLease().catch(() => undefined);
      throw mergeFailure.error;
    }
    if (!mergeResult) {
      await expireExecutionAndReleaseRepositoryLease().catch(() => undefined);
      throw app.httpErrors.internalServerError(
        "Merge execution ended without a durable outcome."
      );
    }

    const succeeded =
      mergeResult.status === "merged" || mergeResult.status === "no-op";
    const finishedAt = new Date();
    const finishedExecution: MergeExecutionRecord = {
      ...execution,
      finishedAt: finishedAt.toISOString(),
      outcome: mergeResult,
    };
    const failureReason =
      mergeResult.status === "merged" || mergeResult.status === "no-op"
        ? undefined
        : `Merge not executed (${mergeResult.status}): ${mergeResult.reason}`;
    try {
      await prisma.$transaction(
        async (tx) => {
          const finalized = await tx.approvalRequest.updateMany({
            where: {
              id: existing.id,
              status: "pending",
              mergeExecutionStatus: "executing",
              mergeExecutionAttemptId: attemptId,
              mergeExecutionLeaseExpiresAt: { gt: finishedAt },
            },
            data: {
              status: succeeded ? "approved" : "rejected",
              decisionNotes: failureReason ?? payload.decisionNotes,
              decidedAt: finishedAt,
              mergeExecutionStatus: succeeded ? "succeeded" : "failed",
              mergeExecutionAttemptId: null,
              mergeExecutionLeaseExpiresAt: null,
              mergeExecution: jsonValue(finishedExecution),
            },
          });
          if (finalized.count !== 1) {
            throw app.httpErrors.conflict(
              "Merge execution finished but its durable decision claim was lost. Retry to recover the recorded outcome."
            );
          }
          if (repositoryLeaseKey) {
            const released = await tx.mergeRepositoryLease.deleteMany({
              where: {
                key: repositoryLeaseKey,
                approvalId: existing.id,
                attemptId,
              },
            });
            if (released.count !== 1) {
              throw app.httpErrors.conflict(
                "Merge execution finished but its exact repository lease was lost. Retry to recover the recorded outcome."
              );
            }
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      await expireExecutionAndReleaseRepositoryLease().catch(() => undefined);
      throw error;
    }

    const approval = {
      ...existing,
      status: succeeded ? "approved" : "rejected",
      decisionNotes: failureReason ?? payload.decisionNotes ?? null,
      decidedAt: finishedAt,
      reviewCertification: reviewRecord,
      mergeExecutionStatus: succeeded ? "succeeded" : "failed",
      mergeExecutionAttemptId: null,
      mergeExecutionLeaseExpiresAt: null,
      mergeExecution: finishedExecution,
    } as ApprovalRow;
    mirrorToGraph((graph) =>
      graph.recordApproval({
        approvalId: approval.id,
        taskId: approval.taskId,
        kind: approval.kind,
        status: approval.status,
        createdAt: approval.createdAt.toISOString(),
        decidedAt: approval.decidedAt?.toISOString(),
      })
    );
    // F5 — the merge EXECUTION outcome is a first-class audit row (the
    // approval.resolved row above records the human decision; this one
    // records what the machine then did with it). Best-effort like every
    // audit append: never fails the merge that already happened.
    try {
      // The executor runs under the operator's approved decision (no live
      // request object here) — the accountable human IS the actor.
      const mergeStamp = buildEventAuditStamp({
        actor: OPERATOR_PRINCIPAL,
        accountable: OPERATOR_PRINCIPAL,
        requestId: approval.id,
        payloadDiff: {
          mergeExecutionStatus: {
            from: "executing",
            to: succeeded ? "succeeded" : "failed",
          },
        },
      });
      await ensureEventPrincipals(mergeStamp, OPERATOR_PRINCIPAL, OPERATOR_PRINCIPAL);
      await prisma.event.create({
        data: {
          ...eventAuditData(mergeStamp),
          laneId: "muon",
          taskId: approval.taskId,
          kind: "merge.executed",
          message: `merge ${succeeded ? "succeeded" : "failed"}: approval ${approval.id}`,
          metadata: {
            approvalId: approval.id,
            succeeded,
          },
        },
      });
    } catch (error) {
      console.error(
        `[audit] merge.executed event failed for ${approval.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    // T5 — a merged task's worktree is consumed: run repo-declared teardown
    // (confirmation-gated inside the helper; unconfirmed commands are skipped
    // with a problem, never run) and remove the tree. Best-effort + audited:
    // a teardown hiccup never un-merges anything.
    const teardownTarget = finishedExecution?.target;
    if (
      succeeded &&
      typeof teardownTarget?.repoRoot === "string" &&
      typeof teardownTarget?.worktreePath === "string"
    ) {
      const teardownRun: Promise<void> = teardownTaskWorktreeProjectSetup({
        repoRoot: teardownTarget.repoRoot,
        worktreePath: teardownTarget.worktreePath,
      })
        .then(async (teardown) => {
          await prisma.event.create({
            data: {
              laneId: "muon",
              taskId: approval.taskId,
              kind: "worktree.torn_down",
              message: teardown.removed
                ? `task worktree removed after merge (${teardown.teardown.length} teardown command(s))`
                : `task worktree teardown incomplete: ${teardown.removalError ?? teardown.teardownProblems.join("; ") ?? "unknown"}`,
              metadata: {
                approvalId: approval.id,
                removed: teardown.removed,
                teardownCommands: teardown.teardown.length,
                problems: teardown.teardownProblems.length,
              },
            },
          });
        })
        .catch((error) => {
          console.error(
            `[t5] worktree teardown failed for ${approval.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          inFlightTeardowns.delete(teardownRun);
        });
      inFlightTeardowns.add(teardownRun);
    }

    if (failureReason) {
      throw app.httpErrors.conflict(failureReason);
    }
    // TODO 5.15: merge is the highest-stakes gate — stamp the human decision.
    await recordApprovalResolvedAudit({
      approval,
      fromStatus: existing.status,
      decisionNotesPresent: Boolean(payload.decisionNotes),
    });
    const receiptSkipped =
      payload.receipt !== undefined
        ? {
            receiptSkipped: true as const,
            receiptSkippedReason:
              "Only a session command approval can mint a receipt.",
          }
        : {};
    return { approval, merge: mergeResult, ...receiptSkipped };
  }

  app.patch("/:approvalId", async (request) => {
    // GOVERN (P3-A / closes C1): approving or rejecting a human gate is the
    // human's decision, it requires the operator tier. A dispatched sub-agent
    // (or the orchestrator) holding the injected AGENT token is rejected 403, so
    // it can no longer self-approve the very gate meant to gate it. The
    // fail-closed single-use redemption below then trusts an "approved" status
    // that only an operator could have set.
    requireOperator(app, request);
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const payload = resolveApprovalSchema.parse(request.body);

    if (payload.manualReview && payload.status !== "approved") {
      throw app.httpErrors.badRequest(
        "A manual review attestation can accompany only an approved merge."
      );
    }
    if (payload.manualReview && payload.receipt) {
      throw app.httpErrors.badRequest(
        "Merge review attestation and remembered-action receipts cannot be combined."
      );
    }

    const pending = await prisma.approvalRequest.findUnique({
      where: { id: params.approvalId },
    });
    if (!pending) {
      throw app.httpErrors.notFound(`Unknown approval '${params.approvalId}'.`);
    }
    if (pending.kind === "merge") {
      return resolveMergeApproval(pending, payload);
    }
    if (payload.manualReview) {
      throw app.httpErrors.badRequest(
        "Manual review attestation is valid only for a merge approval."
      );
    }
    if (pending.status !== "pending") {
      if (pending.status === payload.status) {
        return { approval: pending };
      }
      throw app.httpErrors.conflict(
        `Approval is already ${pending.status}; a terminal decision is immutable.`
      );
    }

    // ── S0-2: worktree isolation is enforced HERE or nowhere ─────────────────
    //
    // This is the single route that turns any non-merge approval into
    // authority, so an escape refused here is refused on every surface — CLI,
    // TUI, desktop, and desktop Full Auto alike. A job bound to an isolated
    // worktree may not be authorized to touch the primary checkout, no matter
    // who (or what) presses approve. The refusal is TERMINAL so an automatic
    // approver cannot spin on it, and it names both trees so the operator can
    // see exactly which boundary was crossed.
    if (payload.status === "approved") {
      const execution = pending.jobId
        ? (
            await prisma.dispatchJob.findUnique({
              where: { id: pending.jobId },
              select: { executionPath: true, workspacePath: true, taskId: true },
            })
          )
        : null;
      const containment = checkExecutionContainment({
        executionPath: execution?.executionPath,
        workspacePath: execution?.workspacePath,
        taskId: execution?.taskId,
        evidence: pending.evidence,
      });
      if (!containment.ok) {
        await prisma.approvalRequest.updateMany({
          where: { id: params.approvalId, status: "pending" },
          data: {
            status: "rejected",
            decisionNotes: containment.reason,
            decidedAt: new Date(),
          },
        });
        throw app.httpErrors.conflict(containment.reason);
      }
    }

    const decision = {
      status: payload.status,
      decisionNotes: payload.decisionNotes,
      decidedAt: new Date(),
    };

    const decidedApproval = {
      ...pending,
      ...decision,
      decisionNotes: payload.decisionNotes ?? null,
    } as ApprovalRow;
    const resolveLostDecision = async (): Promise<ApprovalRow> => {
      const winner = await prisma.approvalRequest.findUnique({
        where: { id: params.approvalId },
      });
      if (winner?.status === payload.status) {
        return winner;
      }
      throw app.httpErrors.conflict(
        winner
          ? `Approval was already ${winner.status}; a terminal decision is immutable.`
          : "Approval disappeared before its decision could be committed."
      );
    };
    const claimDecision = async (): Promise<ApprovalRow> => {
      const claim = await prisma.approvalRequest.updateMany({
        where: { id: params.approvalId, status: "pending" },
        data: decision,
      });
      return claim.count === 1 ? decidedApproval : resolveLostDecision();
    };

    let approval: ApprovalRow;
    let receipt;
    // True only when THIS request won the pending→terminal claim. A lost race
    // must not write a duplicate audit row attributing a decision it did not make.
    let claimedByThisRequest = false;
    // BUG 1: a receipt is a best-effort ADD-ON — the human's approve/reject
    // decision must ALWAYS land. When the operator opts to "remember" an action
    // that is not receipt-eligible (e.g. a plain Bash that is not a configured
    // check), we DO NOT fail the PATCH: the decision is written normally and the
    // response carries a soft `receiptSkipped` signal + honest reason INSTEAD of
    // minting. Minting for eligible actions is unchanged (decision + mint land
    // atomically).
    let receiptSkippedReason: string | undefined;
    if (payload.status === "approved" && payload.receipt) {
      const receiptTtlMs = payload.receipt.ttlMs;
      const derived = await deriveReceiptBinding(params.approvalId);
      if (derived.ok) {
        const outcome = await prisma.$transaction(async (tx) => {
          const claim = await tx.approvalRequest.updateMany({
            where: { id: params.approvalId, status: "pending" },
            data: decision,
          });
          if (claim.count !== 1) {
            return { claimed: false as const };
          }
          const minted = await tx.approvalReceipt.create({
            data: {
              approvalId: params.approvalId,
              ...derived.binding,
              expiresAt: new Date(Date.now() + receiptTtlMs),
            },
          });
          return { claimed: true as const, receipt: minted };
        });
        if (!outcome.claimed) {
          approval = await resolveLostDecision();
        } else {
          approval = decidedApproval;
          receipt = outcome.receipt;
          claimedByThisRequest = true;
        }
      } else {
        // Not receipt-eligible: land the decision, skip the mint, keep the reason.
        receiptSkippedReason = derived.reason;
        const claim = await prisma.approvalRequest.updateMany({
          where: { id: params.approvalId, status: "pending" },
          data: decision,
        });
        if (claim.count === 1) {
          approval = decidedApproval;
          claimedByThisRequest = true;
        } else {
          approval = await resolveLostDecision();
        }
      }
    } else {
      const claim = await prisma.approvalRequest.updateMany({
        where: { id: params.approvalId, status: "pending" },
        data: decision,
      });
      if (claim.count === 1) {
        approval = decidedApproval;
        claimedByThisRequest = true;
      } else {
        approval = await resolveLostDecision();
      }
    }

    mirrorToGraph((graph) =>
      graph.recordApproval({
        approvalId: approval.id,
        taskId: approval.taskId,
        kind: approval.kind,
        status: approval.status,
        createdAt: approval.createdAt.toISOString(),
        decidedAt: approval.decidedAt?.toISOString(),
      })
    );

    // TODO 5.15 — the enterprise sentence: "a human, not an AI, approved this".
    // Only stamp when THIS request won the claim (no duplicate/misattributed rows).
    if (claimedByThisRequest) {
      await recordApprovalResolvedAudit({
        approval,
        fromStatus: pending.status,
        decisionNotesPresent: Boolean(payload.decisionNotes),
      });
    }

    // T5 — approving a project-setup gate RECORDS the confirmation, so the
    // next dispatch runs the repo-declared lifecycle. The evidence's own
    // repoRoot/setupHash (filed by the runner from the resolved plan) are the
    // binding; a failure to record surfaces as a decision note rather than
    // silently un-approving.
    if (
      claimedByThisRequest &&
      approval.status === "approved" &&
      approval.gateTag?.startsWith("project-setup:")
    ) {
      const details =
        (approval.evidence as { details?: Record<string, string> } | null)
          ?.details ?? {};
      const repoRoot = details.repoRoot;
      const setupHash = details.setupHash;
      if (repoRoot && setupHash && `project-setup:${setupHash}` === approval.gateTag) {
        try {
          // Review finding 2 — the gate's reason/evidence are AGENT-authored
          // text; the human's consent must bind to what the REPO actually
          // declares. Re-resolve the plan server-side and record only when
          // its confirmation-bound hash equals the approved one. A drifted or
          // fabricated hash is refused, never recorded.
          const livePlan = await resolveEffectiveProjectSetup({ repoRoot });
          const liveRequest = projectSetupConfirmationRequest(livePlan);
          if (liveRequest?.setupHash === setupHash) {
            await recordProjectSetupConfirmation({ repoRoot, setupHash });
          } else {
            console.error(
              `[t5] project-setup gate ${approval.id} does not match the repo's ` +
                `current plan (approved ${setupHash.slice(0, 12)}…, repo ` +
                `${liveRequest?.setupHash.slice(0, 12) ?? "none"}); confirmation NOT recorded — re-dispatch to file a fresh gate`
            );
          }
        } catch (error) {
          console.error(
            `[t5] project-setup confirmation could not be recorded for ${approval.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        console.error(
          `[t5] project-setup gate ${approval.id} carried inconsistent evidence; confirmation NOT recorded`
        );
      }
    }

    if (receipt) {
      return { approval, receipt };
    }
    if (receiptSkippedReason !== undefined) {
      // Soft signal: the decision landed but the requested receipt was not
      // minted (this action can't be remembered). The client surfaces it as an
      // informational note, never as an error.
      return { approval, receiptSkipped: true, receiptSkippedReason };
    }
    return { approval };
  });

  /**
   * P0.4 mint eligibility (informed consent for "remember this"): every field
   * a receipt binds is derived SERVER-SIDE from the stored approval, its job,
   * and the corroborating session — never from the PATCH body and never from
   * the agent-supplied jobId alone.
   *
   * BUG 1: a receipt is a best-effort add-on, so eligibility failures are NOT
   * thrown — they return `{ ok:false, reason }` and the PATCH handler lands the
   * approve/reject decision anyway (the human's decision never depends on the
   * mint). Only a genuinely non-existent approval — which cannot be decided at
   * all — throws (404). network/merge/ship (and anything unclassifiable, e.g.
   * `git push`) can never be remembered.
   */
  type ReceiptBindingResult =
    | {
        ok: true;
        binding: {
          taskId: string;
          jobId: string;
          sessionId: string;
          workspacePath: string;
          actionClass: string;
          toolName: string;
          payloadDigest: string;
          resolvedTarget: string | null;
          manifestFingerprint: string | null;
        };
      }
    | { ok: false; reason: string };

  async function deriveReceiptBinding(
    approvalId: string
  ): Promise<ReceiptBindingResult> {
    const skip = (reason: string): ReceiptBindingResult => ({
      ok: false,
      reason,
    });
    const approval = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });
    if (!approval) {
      // The approval does not exist, so it cannot be decided at all — a genuine
      // 404, not a best-effort skip.
      throw app.httpErrors.notFound(`Unknown approval '${approvalId}'.`);
    }
    if (approval.kind !== "command") {
      return skip("Only a session command approval can mint a receipt.");
    }
    const evidenceParsed = approvalEvidenceSchema.safeParse(approval.evidence);
    if (!evidenceParsed.success) {
      return skip(
        "This approval has no structured evidence; a receipt must bind an exact action."
      );
    }
    const evidence = evidenceParsed.data;
    if (!evidence.payloadDigest) {
      return skip(
        "This approval's evidence carries no payload digest — no digest, no receipt."
      );
    }
    if (!approval.jobId) {
      return skip(
        "This approval is not bound to a dispatch job; a receipt is single-run scoped."
      );
    }
    const job = await prisma.dispatchJob.findUnique({
      where: { id: approval.jobId },
    });
    if (!job) {
      return skip(
        `Approval references unknown dispatch job '${approval.jobId}'.`
      );
    }
    if (job.capabilityMode === "delegate") {
      return skip(
        "Receipts never mint in a delegate context (no descendant escalation)."
      );
    }
    // Corroborate the filer's job binding through the session ledger: the
    // evidence sessionId must be a real session executing exactly this job.
    const sessionId = evidence.details.sessionId;
    const session = sessionId
      ? await prisma.laneSession.findUnique({ where: { id: sessionId } })
      : null;
    if (!session || session.jobId !== approval.jobId) {
      return skip(
        "The approval's session does not corroborate its job binding; refusing to mint."
      );
    }
    const task = await prisma.task.findUnique({
      where: { id: approval.taskId },
    });
    const workspacePath = job.workspacePath ?? task?.workspacePath ?? null;
    if (!workspacePath) {
      return skip("A receipt needs a governed workspace.");
    }
    // The job's own configured checks (harness ∪ job): the ONLY Bash that can
    // classify as `test`, via byte-equality on the rendered command line. An
    // unparseable harness/checks payload just means fewer checks — the failure
    // direction is "refuse to mint", never "widen".
    const checkCommands: string[] = [];
    if (job.harnessKey) {
      const harness = await prisma.harness.findUnique({
        where: { key: job.harnessKey },
      });
      const config = harness
        ? harnessConfigSchema.safeParse(harness.config)
        : undefined;
      if (config?.success) {
        checkCommands.push(...config.data.checks.map(renderCheckCommand));
      }
    }
    const jobChecks = z.array(harnessCheckSchema).safeParse(job.checks ?? []);
    if (jobChecks.success) {
      checkCommands.push(...jobChecks.data.map(renderCheckCommand));
    }
    const classified = classifyToolAction({
      toolName: evidence.action,
      command: evidence.details.command,
      path: evidence.details.path,
      checkCommands,
    });
    if (
      !classified ||
      !(RECEIPT_ALLOWED_CLASSES as readonly string[]).includes(classified.class)
    ) {
      // BUG 1: word the reason by class. Only network/merge/ship carry the
      // "always ask" framing; a plain Bash that isn't a configured check (or any
      // other unclassifiable tool) is simply not one of the rememberable
      // classes — say so honestly instead of implying it's a merge/ship.
      return skip(
        classified?.class === "network"
          ? "Network actions always ask; this action can't be remembered."
          : "This action can't be remembered — only reads, edits inside the task radius, and configured checks can."
      );
    }
    // SEC-1: the ENFORCED binding is the operator-VISIBLE resolved target — the
    // exact file path (read/edit) or command line (test) the human saw on the
    // approval card, taken straight from the redacted `evidence.details` the
    // operator reviewed. `payloadDigest` (agent-authored at file time) stays on
    // the row only to narrow further. Because the redeem seam derives the SAME
    // target and the SAME digest from ONE real tool input, a bait mint (visible
    // "Edit README.md" but a digest computed over ci.yml) becomes inert: no real
    // action can satisfy the mismatched target and digest at once. `null` for a
    // target-less classification (e.g. a path-less Glob/Grep read).
    const resolvedTarget =
      classified.class === "test"
        ? (evidence.details.command ?? null)
        : (evidence.details.path ?? null);
    return {
      ok: true,
      binding: {
        taskId: approval.taskId,
        jobId: approval.jobId,
        sessionId: session.id,
        workspacePath,
        actionClass: classified.class,
        toolName: evidence.action,
        payloadDigest: evidence.payloadDigest,
        resolvedTarget,
        manifestFingerprint:
          job.delegationManifest != null
            ? fingerprintManifest(job.delegationManifest)
            : null,
      },
    };
  }

  /** Single-use delivery stamp for a session 'command' approval
   *  (consume-before-allow, P0.1 Slice A). Mirrors redeemGateAtRoute
   *  (lib/gate.ts): ONE guarded updateMany, no TOCTOU window. Agent-tier
   *  callable — the runner is the consumer — because it can only BURN
   *  authority, never grant it. `kind:"command"` only: route gates keep their
   *  exclusive redeemGateAtRoute path. The stamp is one-way and never un-set
   *  (fail-closed gates): after a crash, `approved ∧ consumedAt = null` is
   *  durable proof the allow never reached the vendor. */
  app.post("/:approvalId/consume", async (request) => {
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const result = await prisma.approvalRequest.updateMany({
      where: {
        id: params.approvalId,
        kind: "command",
        status: "approved",
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
    if (result.count !== 1) {
      throw app.httpErrors.conflict(
        "Approval is not a consumable command approval (wrong kind, undecided, or already consumed)."
      );
    }
    return { consumed: true };
  });
}
