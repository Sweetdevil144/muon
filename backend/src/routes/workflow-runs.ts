import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  WORKFLOW_AMENDABLE_STATUSES,
  WORKFLOW_AMENDED_EVENT_KIND,
  WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
  WORKFLOW_AMENDMENT_SPINE_WINDOW,
  applyWorkflowGateTag,
  amendWorkflowGateTag,
  deriveWorkflowAmendments,
  isWorkflowAmendableStatus,
  workflowAmendmentSchema,
  workflowProposalSchema,
  workflowRunStatusSchema,
  type AmendmentSpineEvent,
  type WorkflowAmendmentStep,
  type WorkflowProposal,
} from "@muon/protocol";
import {
  agentJobPrincipal,
  authoringPrincipal,
  isChatCoordinatorCapability,
  requireOperator,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";
import {
  hashAmendmentSteps,
  hashProposal,
  redeemGateAtRoute,
} from "../lib/gate.js";
import { getGraph, mirrorToGraph } from "../lib/graph.js";
import { refuseConflict } from "../lib/refusal-http.js";
import { availableLaneWhere } from "../lib/vendor-lanes.js";
import { planWorkflowViaAvailableLane } from "../lib/workflow-planner.js";

const runParamsSchema = z.object({ runId: z.string().min(1) });

const createRunSchema = z.object({
  templateKey: z.string().min(1).optional(),
  templateVersion: z.number().int().positive().optional(),
  request: z.string().min(3),
  workspacePath: z.string().min(1).optional(),
  chatId: z.string().min(1).max(200).optional(),
  proposal: workflowProposalSchema,
  proposedBy: z.string().min(2).default("heuristic"),
});

const updateRunSchema = z
  .object({
    status: workflowRunStatusSchema.optional(),
    proposal: workflowProposalSchema.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  });

const applyRunSchema = z.object({
  appliedBy: z.string().min(2),
  // Route-level gate (ADR-0010 Part B): an agent-tier apply must present a
  // redeemed, operator-approved, single-use gate bound to THIS runId. Optional
  // so the operator tier (the human's `muon workflow apply`) is unchanged.
  gateApprovalId: z.string().min(1).optional(),
});

function delegationTokenMatches(tokenHash: string, token: string): boolean {
  const expected = Buffer.from(tokenHash, "hex");
  const actual = Buffer.from(
    createHash("sha256").update(token).digest("hex"),
    "hex"
  );
  return (
    expected.length === actual.length &&
    expected.length > 0 &&
    timingSafeEqual(expected, actual)
  );
}

const WORKFLOW_CAPABILITY_ERROR =
  "Agent workflow access requires the exact active caller job capability for the owning chat.";

async function activeWorkflowChat(
  app: FastifyInstance,
  chatId: string
): Promise<{ workspacePath: string }> {
  const chat = await prisma.orchestratorChat.findUnique({
    where: { id: chatId },
    select: { status: true, workspacePath: true },
  });
  if (!chat) {
    throw app.httpErrors.notFound(
      "The owning orchestrator chat does not exist."
    );
  }
  if (chat.status !== "active") {
    throw app.httpErrors.conflict(
      "Cannot operate on a workflow owned by an archived chat."
    );
  }
  return chat;
}

async function requireWorkflowChatCapability(
  app: FastifyInstance,
  request: FastifyRequest,
  chatId: string | null | undefined
): Promise<{ workspacePath: string }> {
  if (request.tier === "operator") {
    if (!chatId) {
      throw app.httpErrors.badRequest("A chat id is required.");
    }
    return activeWorkflowChat(app, chatId);
  }
  const callerJobId = request.headers["x-muon-caller-job-id"];
  const token = request.headers["x-muon-delegation-token"];
  if (
    !chatId ||
    typeof callerJobId !== "string" ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512
  ) {
    throw app.httpErrors.forbidden(WORKFLOW_CAPABILITY_ERROR);
  }
  const [chat, caller, grant] = await Promise.all([
    prisma.orchestratorChat.findUnique({
      where: { id: chatId },
      select: { status: true, workspacePath: true },
    }),
    prisma.dispatchJob.findUnique({
      where: { id: callerJobId },
      select: {
        chatId: true,
        status: true,
        interruptRequested: true,
        capabilityMode: true,
      },
    }),
    prisma.delegationGrant.findUnique({
      where: { jobId: callerJobId },
    }),
  ]);
  const authenticatedJob = request.agentJobCapability;
  if (
    (authenticatedJob &&
      (authenticatedJob.jobId !== callerJobId ||
        authenticatedJob.chatId !== chatId ||
        !isChatCoordinatorCapability(authenticatedJob))) ||
    !chat ||
    chat.status !== "active" ||
    !caller ||
    caller.chatId !== chatId ||
    !["queued", "running"].includes(caller.status) ||
    caller.interruptRequested ||
    // ADR-0028 §4.2: propose_workflow is a Tier C tool, so the caller's own
    // job row may name either chat-scoped coordinator seat. `apply_workflow`
    // stays out of reach regardless — POST /:runId/apply is absent from the
    // attached-coordinator route allowlist (backend/src/lib/auth.ts), so an
    // attached bearer never reaches this helper through that route at all.
    (caller.capabilityMode !== "orchestrator" &&
      caller.capabilityMode !== ATTACHED_COORDINATOR_CAPABILITY_MODE) ||
    !grant ||
    grant.expiresAt.getTime() <= Date.now() ||
    !delegationTokenMatches(grant.tokenHash, token)
  ) {
    throw app.httpErrors.forbidden(WORKFLOW_CAPABILITY_ERROR);
  }
  return chat;
}

/**
 * Read-only Tier B exception. A hand-started observer authenticates with the
 * shared AGENT bearer and has no runner-minted job lineage; it may inspect one
 * explicitly named chat, but it cannot call any workflow mutation through this
 * path. Exact-job callers retain the stricter capability check above.
 */
async function requireWorkflowReadCapability(
  app: FastifyInstance,
  request: FastifyRequest,
  chatId: string | null | undefined
): Promise<{ workspacePath: string }> {
  const declaresJobLineage =
    request.headers["x-muon-caller-job-id"] !== undefined ||
    request.headers["x-muon-delegation-token"] !== undefined;
  if (
    request.tier === "agent" &&
    !request.agentJobCapability &&
    !declaresJobLineage
  ) {
    if (!chatId) {
      throw app.httpErrors.badRequest(
        "An attached observer must name a chat for workflow reads."
      );
    }
    return activeWorkflowChat(app, chatId);
  }
  return requireWorkflowChatCapability(app, request, chatId);
}

// ── ADR-0045: a running plan may gain a step, never change one ───────────────
//
// An amendment APPENDS steps to a run that is already executing. Everything
// below exists to keep that from becoming a rewrite:
//
//  • D1 append-only. There is no field naming an existing step, no index, no
//    order. The merged proposal is `[...existing, ...appended]` and nothing
//    else, and `handoffTo` may only point at a step this same amendment
//    introduced — pointing back at a recorded step is reaching backwards.
//  • D2 gated exactly as hard as apply. Same content-hash-bound, single-use,
//    operator-approved gate; the agent tier cannot spend the run's original
//    apply approval a second time.
//  • D3 authority is re-derived POSITIVELY, at amendment time: lane, harness
//    and failure policy are checked against the CURRENT registry, never
//    inherited from the original apply and never computed by subtraction.
//    (A retired lane the original plan legitimately used is refused now.)
//  • D5 only `running` / `paused`, as a positive list, with a typed refusal
//    (ADR-0033) naming the run's actual status.
//  • D6 provenance from auth.
//
// Two routes because informed consent needs both: the DRAFT is what lets the
// approvals route render the appended steps into the human's gate, exactly as
// the stored proposal does for apply. A draft is inert — it changes no run, no
// task, no status, and is not executable until its gate is redeemed.

const AMENDMENT_EVENT_KINDS = [
  WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
  WORKFLOW_AMENDED_EVENT_KIND,
];

const amendmentParamsSchema = z.object({
  runId: z.string().min(1),
  amendmentId: z.string().min(1),
});

/** The draft envelope: the amendment CONTENT, plus provenance the route
 *  re-derives from auth anyway. `.strict()` — D4's closed list is enforced by
 *  the shape, not by a filter. */
const proposeAmendmentSchema = z
  .object({
    amendment: workflowAmendmentSchema,
    amendedBy: z.string().min(2),
  })
  .strict();

const applyAmendmentSchema = z
  .object({
    amendedBy: z.string().min(2),
    // Same tier-conditional gate as apply: absent for the operator tier, and
    // mandatory (bound to this run + these exact steps) for the agent tier.
    gateApprovalId: z.string().min(1).optional(),
  })
  .strict();

// Structural, because the $extends'd client and its TransactionClient share no
// nominal type — this names exactly the query the spine needs (questions.ts
// carries the same pattern for ADR-0043).
type AmendmentSpineDb = {
  event: {
    findMany(args: {
      where: { taskId: string; kind: { in: string[] } };
      orderBy: ({ timestamp: "desc" } | { id: "desc" })[];
      take: number;
    }): Promise<
      {
        kind: string;
        timestamp: Date;
        metadata: unknown;
      }[]
    >;
  };
};

/**
 * The NEWEST window, folded oldest→newest (the fold needs proposed-before-
 * applied order). Workflow events are filed with the RUN id in `taskId`, the
 * convention every other workflow event in this file already uses.
 *
 * `desc + take` then reverse, NOT `asc + take` — the direction is a security
 * property, the same one ADR-0043's question spine had to learn. Taking the
 * OLDEST window on a long spine drops recent rows, so an amendment's `applied`
 * row could age out while its `proposed` row stayed in view: the fold would
 * derive an already-appended amendment as still pending, and it could be
 * appended a second time. Truncating from the other end fails the safe way —
 * an ancient amendment whose `proposed` row ages out derives as nothing at
 * all, which refuses rather than re-appends.
 */
async function amendmentSpine(
  runId: string,
  db: AmendmentSpineDb = prisma
): Promise<AmendmentSpineEvent[]> {
  const rows = await db.event.findMany({
    where: { taskId: runId, kind: { in: AMENDMENT_EVENT_KINDS } },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: WORKFLOW_AMENDMENT_SPINE_WINDOW,
  });
  rows.reverse();
  return rows.map((row) => ({
    kind: row.kind,
    timestamp: row.timestamp.toISOString(),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * D6: `amendedBy` from the authenticated principal, never the payload — the
 * same derivation `appliedBy` uses, plus the job-scoped precision `proposedBy`
 * already uses on `POST /`. An exact-job caller is recorded as its actual job
 * (it cannot name itself anything); anything else falls back to apply's rule,
 * where an agent claiming a human principal is downgraded.
 */
function amendingPrincipal(
  request: FastifyRequest,
  requested: string
): string {
  return request.agentJobCapability
    ? agentJobPrincipal(request.agentJobCapability)
    : authoringPrincipal(request.tier, requested);
}

/**
 * D5 as a typed refusal (ADR-0033): the rule, the run's ACTUAL status, and the
 * lawful next action. `proposed` is sent back to the existing edit path;
 * anything terminal is told to propose a new run or fork (ADR-0044) rather
 * than being offered a next action that does not exist.
 */
function assertAmendableStatus(
  app: FastifyInstance,
  request: FastifyRequest,
  run: { id: string; status: string }
): void {
  if (isWorkflowAmendableStatus(run.status)) {
    return;
  }
  const audience = request.tier === "operator" ? "operator" : "agent";
  refuseConflict(app, audience, {
    rule: "workflow.not_amendable",
    summary:
      run.status === "proposed"
        ? "A proposed run is not amended — it is still editable in place."
        : "Only a run that can still act may gain a step.",
    surface: "workflow amend",
    evidence: [
      { label: "status", value: run.status },
      { label: "amendable", value: WORKFLOW_AMENDABLE_STATUSES.join("|") },
      { label: "runId", value: run.id },
    ],
    nextAction:
      run.status === "proposed"
        ? {
            kind: "operator",
            action:
              "edit the proposal in place (PATCH /api/workflow-runs/:runId), then apply it",
          }
        : {
            kind: "operator",
            action:
              "propose a NEW workflow run for the newly-discovered work, or fork the mission from a recorded step",
          },
  });
}

/**
 * D3 — the authority-bearing fields of every appended step, evaluated
 * POSITIVELY against the CURRENT registry at amendment time.
 *
 * Positive membership in "lanes that exist right now", never "the lanes the
 * original plan used" and never "everything except the retired ones": a lane
 * retired since the run started is refused here even though the run's own
 * earlier steps legitimately name it. `onFail` and `gate` are closed enums in
 * the amendment schema, and `loop` is bounded there and covered by the gate's
 * content hash, so this function has nothing left to say about them.
 */
async function assertAppendedStepAuthority(
  app: FastifyInstance,
  steps: readonly WorkflowAmendmentStep[]
): Promise<void> {
  const [lanes, harnesses] = await Promise.all([
    prisma.lane.findMany({
      where: availableLaneWhere(),
      select: { key: true },
    }),
    prisma.harness.findMany({ select: { key: true } }),
  ]);
  const laneKeys = new Set(lanes.map((lane) => lane.key));
  const harnessKeys = new Set(harnesses.map((harness) => harness.key));
  for (const step of steps) {
    if (
      step.role !== "human" &&
      step.role !== "suggest" &&
      !laneKeys.has(step.role)
    ) {
      throw app.httpErrors.badRequest(
        `Appended step '${step.stepKey}' names role '${step.role}', which is neither 'human', 'suggest', nor a lane available right now.`
      );
    }
    if (step.laneKey && !laneKeys.has(step.laneKey)) {
      throw app.httpErrors.badRequest(
        `Appended step '${step.stepKey}' names lane '${step.laneKey}', which is not available right now. An amendment derives its lanes from the present registry, never from the run's original plan.`
      );
    }
    if (step.harnessKey && !harnessKeys.has(step.harnessKey)) {
      throw app.httpErrors.badRequest(
        `Appended step '${step.stepKey}' names harness '${step.harnessKey}', which does not exist.`
      );
    }
  }
}

/**
 * D1 — the appended steps against the run's CURRENT plan.
 *
 * A duplicate `stepKey` is the sharpest edit-by-collision available: the
 * workflow runner resolves a step to its task with the FIRST matching
 * `stepKey`, so a colliding append would re-point an existing, possibly
 * already-executed step. A `handoffTo` aimed at an existing step is the same
 * move in the other direction — history receiving a fresh packet — so a
 * handoff may only name a step this amendment itself introduces.
 *
 * Pure, so the apply path can re-run it INSIDE its transaction against the
 * proposal as it stands at that instant (a second amendment may have landed
 * between the draft and its gate).
 */
function assertAppendable(
  app: FastifyInstance,
  steps: readonly WorkflowAmendmentStep[],
  proposal: WorkflowProposal
): void {
  const existing = new Set(proposal.steps.map((step) => step.stepKey));
  const appended = new Set<string>();
  for (const step of steps) {
    if (existing.has(step.stepKey)) {
      throw app.httpErrors.conflict(
        `Appended step '${step.stepKey}' collides with a step this run already has. An amendment appends; it never edits, reorders, or replaces one.`
      );
    }
    if (appended.has(step.stepKey)) {
      throw app.httpErrors.badRequest(
        `Appended step '${step.stepKey}' appears twice in one amendment.`
      );
    }
    appended.add(step.stepKey);
  }
  for (const step of steps) {
    if (step.handoffTo && !appended.has(step.handoffTo)) {
      throw app.httpErrors.badRequest(
        `Appended step '${step.stepKey}' hands off to '${step.handoffTo}', which this amendment does not introduce. An amendment may not reach backwards into a step the run already has.`
      );
    }
  }
}

export async function registerWorkflowRunRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = z
      .object({
        status: z.string().min(1).optional(),
        chatId: z.string().min(1).max(200).optional(),
      })
      .parse(request.query);
    if (request.tier !== "operator") {
      await requireWorkflowReadCapability(app, request, query.chatId);
    }

    const runs = await prisma.workflowRun.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.chatId ? { chatId: query.chatId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return { runs };
  });

  app.get("/:runId", async (request) => {
    const params = runParamsSchema.parse(request.params);
    const run = await prisma.workflowRun.findUnique({
      where: { id: params.runId },
    });
    if (!run) {
      throw app.httpErrors.notFound("The requested workflow run does not exist.");
    }
    if (request.tier !== "operator") {
      await requireWorkflowChatCapability(app, request, run.chatId);
    }

    // A workflow step IS a task: the run's tasks carry the step state.
    const tasks = await prisma.task.findMany({
      where: { workflowRunId: run.id },
      orderBy: { createdAt: "asc" },
      include: {
        assignments: { include: { lane: true }, orderBy: { createdAt: "desc" } },
        approvals: { orderBy: { createdAt: "desc" } },
      },
    });

    return { run, tasks };
  });

  // One-shot "instruct" endpoint for browser surfaces: request text in, a real
  // task-scoped planner lane runs, and a stored inert proposal comes out.
  app.post("/propose", async (request, reply) => {
    requireOperator(app, request);
    const payload = z
      .object({
        request: z.string().min(3),
        workspacePath: z.string().min(1).optional(),
      })
      .parse(request.body);

    const [lanes, harnesses, templates] = await Promise.all([
      // The planner is told which lanes it may name in a plan, so a retired lane
      // must not be in the list — a step planned onto it could never dispatch.
      prisma.lane.findMany({
        where: availableLaneWhere(),
        orderBy: { createdAt: "asc" },
        select: { key: true },
      }),
      prisma.harness.findMany({
        orderBy: { key: "asc" },
        select: { key: true },
      }),
      prisma.workflowTemplate.findMany({
        orderBy: { key: "asc" },
        select: { key: true },
      }),
    ]);

    let planned;
    try {
      planned = await planWorkflowViaAvailableLane({
        request: payload.request,
        workspacePath: payload.workspacePath,
        taskId: `planner:${request.id}`,
        laneKeys: lanes.map((lane) => lane.key),
        harnessKeys: harnesses.map((harness) => harness.key),
        templateKeys: templates.map((template) => template.key),
      });
    } catch (error) {
      const reason = (
        error instanceof Error ? error.message : String(error)
      )
        .replace(/\s+/g, " ")
        .slice(0, 300);
      reply.code(503);
      return {
        error: "planner_unavailable",
        message: `Workflow planner unavailable: ${reason}`,
      };
    }
    const { proposal, plannerLaneKey } = planned;
    const proposedBy = `planner:${plannerLaneKey}`;

    // Routing enrichment: recommendation only, human edits at apply time.
    for (const step of proposal.steps) {
      if (step.role !== "suggest" || step.laneKey) {
        continue;
      }
      const suggestions = await getGraph()
        .suggestLanes(undefined, `${step.title} ${step.brief}`)
        .catch(() => []);
      const top = suggestions[0];
      if (top) {
        step.laneKey = top.laneKey;
        step.laneReason = top.reason;
      }
    }

    const run = await prisma.workflowRun.create({
      data: {
        request: payload.request,
        workspacePath: payload.workspacePath,
        proposal: proposal as unknown as Prisma.InputJsonValue,
        proposedBy,
      },
    });

    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: run.id,
        kind: "workflow.proposed",
        message: `workflow proposed: ${proposal.summary}`,
        metadata: {
          workflowRunId: run.id,
          proposedBy,
          plannerLaneKey,
          steps: proposal.steps.length,
        } as Prisma.InputJsonValue,
      },
    });

    mirrorToGraph((graph) =>
      graph.recordWorkflowRun({
        runId: run.id,
        templateKey: run.templateKey,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
      })
    );

    reply.code(201);
    return { run };
  });

  app.post("/", async (request, reply) => {
    const payload = createRunSchema.parse(request.body);
    // PROVENANCE FROM AUTH (P3-A / H2 forgery class): `proposedBy` is derived
    // from the authenticated tier, not the body, an agent cannot stamp a forged
    // "human:*" proposer on a workflow run.
    const proposedBy = request.agentJobCapability
      ? agentJobPrincipal(request.agentJobCapability)
      : authoringPrincipal(request.tier, payload.proposedBy);
    let workspacePath = payload.workspacePath;
    if (request.tier !== "operator" && !payload.chatId) {
      throw app.httpErrors.forbidden(WORKFLOW_CAPABILITY_ERROR);
    }
    if (payload.chatId) {
      const chat = await requireWorkflowChatCapability(
        app,
        request,
        payload.chatId
      );
      if (workspacePath && workspacePath !== chat.workspacePath) {
        throw app.httpErrors.conflict(
          "The workflow proposal workspace does not match its owning chat."
        );
      }
      workspacePath = chat.workspacePath;
    }

    const run = await prisma.workflowRun.create({
      data: {
        templateKey: payload.templateKey,
        templateVersion: payload.templateVersion,
        request: payload.request,
        workspacePath,
        chatId: payload.chatId,
        proposal: payload.proposal as unknown as Prisma.InputJsonValue,
        proposedBy,
      },
    });

    // The proposal is inert until a human applies it (VISION §6.1).
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: run.id,
        kind: "workflow.proposed",
        message: `workflow proposed: ${payload.proposal.summary}`,
        metadata: {
          workflowRunId: run.id,
          proposedBy,
          steps: payload.proposal.steps.length,
        } as Prisma.InputJsonValue,
      },
    });

    mirrorToGraph((graph) =>
      graph.recordWorkflowRun({
        runId: run.id,
        templateKey: run.templateKey,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
      })
    );

    reply.code(201);
    return { run };
  });

  app.patch("/:runId", async (request) => {
    const params = runParamsSchema.parse(request.params);
    const payload = updateRunSchema.parse(request.body);

    // A workflow-run STATUS transition is a human/orchestrator management act on
    // the human surface, the agent tier must not be able to flip a run's status
    // (e.g. to `applied`/`abandoned`/`running`) outside the content-hash-bound
    // apply gate. Gate status transitions to the operator tier; proposal edits on
    // a still-`proposed` run stay open, and `POST /:runId/apply` remains the
    // single gated agent path that actually creates tasks.
    if (payload.status !== undefined) {
      requireOperator(app, request);
    }

    if (payload.proposal) {
      const existing = await prisma.workflowRun.findUnique({
        where: { id: params.runId },
      });
      if (!existing) {
        throw app.httpErrors.notFound(
          "The requested workflow run does not exist."
        );
      }
      if (existing.status !== "proposed") {
        throw app.httpErrors.conflict(
          "Only proposed workflow runs can be edited."
        );
      }
      if (request.tier !== "operator") {
        await requireWorkflowChatCapability(app, request, existing.chatId);
      }
    }

    const run = await prisma.workflowRun.update({
      where: { id: params.runId },
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.proposal
          ? { proposal: payload.proposal as unknown as Prisma.InputJsonValue }
          : {}),
        ...(payload.status === "running" ? { startedAt: new Date() } : {}),
        ...(payload.status === "done" || payload.status === "abandoned"
          ? { endedAt: new Date() }
          : {}),
      },
    });

    mirrorToGraph((graph) =>
      graph.recordWorkflowRun({
        runId: run.id,
        templateKey: run.templateKey,
        status: run.status,
        createdAt: run.createdAt.toISOString(),
      })
    );

    return { run };
  });

  app.post("/:runId/apply", async (request, reply) => {
    const params = runParamsSchema.parse(request.params);
    const payload = applyRunSchema.parse(request.body);
    // PROVENANCE FROM AUTH (P3-A / closes F4, the H2 forgery class): `appliedBy`
    // is derived from the authenticated tier, not the body, an agent-tier caller
    // cannot forge "human:carol" into the workflow.applied event/record.
    const appliedBy = authoringPrincipal(request.tier, payload.appliedBy);

    const existing = await prisma.workflowRun.findUnique({
      where: { id: params.runId },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested workflow run does not exist.");
    }
    if (existing.status !== "proposed") {
      throw app.httpErrors.conflict(
        "Only proposed workflow runs can be applied."
      );
    }
    if (request.tier !== "operator") {
      await requireWorkflowChatCapability(app, request, existing.chatId);
    } else if (existing.chatId) {
      await activeWorkflowChat(app, existing.chatId);
    }
    const proposal = workflowProposalSchema.parse(existing.proposal);

    // Tier-conditional route gate (ADR-0010 Part B / closes F4 + review F-2). The
    // operator tier (the human's `muon workflow apply`) applies directly. An
    // agent-tier caller (the orchestrator applying AFTER the human approves) MUST
    // present a redeemed, tag-bound, operator-approved, SINGLE-USE gate, and the
    // gate is bound to the proposal CONTENT hash, not just the runId, so a
    // proposal edited after approval (the PATCH proposal edit is not operator-
    // gated) no longer matches → 403. Fail-closed (review F-4): the atomic redeem
    // (consume) precedes the apply write, so if the write later fails the gate is
    // spent and re-approval is needed, a deliberate trade (security > a rare
    // wasted gate). Read-only 404/409 above run BEFORE the redeem, so they don't
    // burn a gate.
    if (request.tier !== "operator") {
      const redeemed =
        payload.gateApprovalId !== undefined &&
        (await redeemGateAtRoute(
          prisma,
          payload.gateApprovalId,
          applyWorkflowGateTag(params.runId, hashProposal(proposal))
        ));
      if (!redeemed) {
        throw app.httpErrors.forbidden(
          "Applying a workflow run from the agent tier requires an operator-approved, single-use gate bound to this run's current proposal. File a gate (kind=gate) and retry with its gateApprovalId once the human approves; a used, mismatched, or edited-since-approval proposal is rejected."
        );
      }
    }

    // Apply = human decision: steps become Tasks atomically with the status
    // flip. Dispatch stays a separate, client-side action.
    const result = await prisma.$transaction(
      async (tx) => {
        const current = await tx.workflowRun.findUnique({
          where: { id: existing.id },
        });
        if (!current || current.status !== "proposed") {
          throw app.httpErrors.conflict(
            "Only proposed workflow runs can be applied."
          );
        }
        const currentProposal = workflowProposalSchema.parse(current.proposal);
        if (hashProposal(currentProposal) !== hashProposal(proposal)) {
          throw app.httpErrors.conflict(
            "The workflow proposal changed while apply was starting; review and approve the current proposal again."
          );
        }
        if (current.chatId) {
          const chat = await tx.orchestratorChat.findUnique({
            where: { id: current.chatId },
            select: { status: true },
          });
          if (chat?.status !== "active") {
            throw app.httpErrors.conflict(
              "Cannot apply a workflow owned by an archived chat."
            );
          }
        }
        // Claim the proposed run before creating tasks. This is the idempotency
        // fence for operator double-clicks and concurrent surfaces; rollback
        // restores `proposed` if any task write fails.
        const claim = await tx.workflowRun.updateMany({
          where: { id: existing.id, status: "proposed" },
          data: {
            status: "applied",
            appliedBy,
            appliedAt: new Date(),
          },
        });
        if (claim.count !== 1) {
          throw app.httpErrors.conflict(
            "Only proposed workflow runs can be applied."
          );
        }
        const tasks = [];
        for (const step of currentProposal.steps) {
          tasks.push(
            await tx.task.create({
              data: {
                title: step.title,
                description: step.brief,
                priority: step.priority,
                chatId: current.chatId,
                workflowRunId: existing.id,
                stepKey: step.stepKey,
                // Steps inherit the run's target repo.
                workspacePath: current.workspacePath,
              },
            })
          );
        }
        const run = await tx.workflowRun.findUnique({
          where: { id: existing.id },
        });
        if (!run) {
          throw app.httpErrors.notFound(
            "The requested workflow run does not exist."
          );
        }
        return { run, tasks };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: existing.id,
        kind: "workflow.applied",
        message: `workflow applied by ${appliedBy}: ${proposal.summary}`,
        metadata: {
          workflowRunId: existing.id,
          tasks: result.tasks.map((task) => task.id),
        } as Prisma.InputJsonValue,
      },
    });

    mirrorToGraph(async (graph) => {
      await graph.recordWorkflowRun({
        runId: result.run.id,
        templateKey: result.run.templateKey,
        status: result.run.status,
        createdAt: result.run.createdAt.toISOString(),
      });
      for (const task of result.tasks) {
        await graph.upsertTask({
          id: task.id,
          title: task.title,
          status: task.status,
        });
        await graph.linkTaskToWorkflowRun({
          taskId: task.id,
          runId: result.run.id,
          stepKey: task.stepKey ?? "",
        });
      }
    });

    reply.code(201);
    return result;
  });

  // ── ADR-0045: propose an amendment (inert draft) ────────────────────────────
  //
  // Nothing here changes the run. It records ONE event so the gate the human
  // decides can name the exact steps — the same reason apply's gate can name
  // the plan: the content is stored before the approval, not after it.
  app.post("/:runId/amendments", async (request, reply) => {
    const params = runParamsSchema.parse(request.params);
    const payload = proposeAmendmentSchema.parse(request.body);
    const proposedBy = amendingPrincipal(request, payload.amendedBy);

    const run = await prisma.workflowRun.findUnique({
      where: { id: params.runId },
    });
    if (!run) {
      throw app.httpErrors.notFound("The requested workflow run does not exist.");
    }
    if (request.tier !== "operator") {
      await requireWorkflowChatCapability(app, request, run.chatId);
    } else if (run.chatId) {
      await activeWorkflowChat(app, run.chatId);
    }
    assertAmendableStatus(app, request, run);

    const proposal = workflowProposalSchema.parse(run.proposal);
    const steps = payload.amendment.steps;
    assertAppendable(app, steps, proposal);
    await assertAppendedStepAuthority(app, steps);

    const amendmentId = randomUUID();
    const stepsHash = hashAmendmentSteps(steps);
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: run.id,
        kind: WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
        // Coordinate-only message: the step titles are agent-authored text and
        // must not shape a log line. They live in metadata, rendered as data.
        message: `workflow amendment ${amendmentId} proposed for run ${run.id}: ${steps.length} step(s)`,
        metadata: {
          workflowRunId: run.id,
          amendmentId,
          stepsHash,
          proposedBy,
          steps,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const amendment = deriveWorkflowAmendments(
      await amendmentSpine(run.id)
    ).find((entry) => entry.id === amendmentId);
    reply.code(201);
    return {
      amendment: amendment ?? null,
      // The tag a filer sends to `POST /api/approvals`; the server enriches it
      // with the content hash and renders the steps into the human's reason.
      gateTag: amendWorkflowGateTag(run.id, amendmentId),
    };
  });

  // ── ADR-0045: apply an amendment (the gated append) ─────────────────────────
  app.post("/:runId/amendments/:amendmentId/apply", async (request, reply) => {
    const params = amendmentParamsSchema.parse(request.params);
    const payload = applyAmendmentSchema.parse(request.body);
    // D6: from auth, never the payload.
    const amendedBy = amendingPrincipal(request, payload.amendedBy);

    const existing = await prisma.workflowRun.findUnique({
      where: { id: params.runId },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested workflow run does not exist.");
    }
    if (request.tier !== "operator") {
      await requireWorkflowChatCapability(app, request, existing.chatId);
    } else if (existing.chatId) {
      await activeWorkflowChat(app, existing.chatId);
    }
    assertAmendableStatus(app, request, existing);

    const pending = deriveWorkflowAmendments(
      await amendmentSpine(params.runId)
    ).find((entry) => entry.id === params.amendmentId);
    if (!pending || pending.workflowRunId !== params.runId) {
      throw app.httpErrors.notFound(
        `No amendment '${params.amendmentId}' was proposed for this run.`
      );
    }
    if (pending.status !== "proposed") {
      throw app.httpErrors.conflict(
        `Amendment '${params.amendmentId}' is already applied; an amendment appends exactly once.`
      );
    }
    // D3: re-derived against the PRESENT registry, not against whatever was
    // available when the draft was filed. A lane retired in between refuses
    // here, before any gate is burned.
    await assertAppendedStepAuthority(app, pending.steps);

    // D2 — gated exactly as hard as apply. The gate is bound to the runId, the
    // amendment id AND the appended-steps content hash, so an approval for one
    // amendment cannot append another, and the run's own (already spent) apply
    // approval authorizes nothing here. Same fail-closed ordering as apply: the
    // read-only 404/409s above run BEFORE the redeem, so they never burn a gate.
    if (request.tier !== "operator") {
      const redeemed =
        payload.gateApprovalId !== undefined &&
        (await redeemGateAtRoute(
          prisma,
          payload.gateApprovalId,
          amendWorkflowGateTag(
            params.runId,
            params.amendmentId,
            hashAmendmentSteps(pending.steps)
          )
        ));
      if (!redeemed) {
        throw app.httpErrors.forbidden(
          "Appending steps to a workflow run from the agent tier requires an operator-approved, single-use gate bound to this run, this amendment, and these exact steps. File a gate (kind=gate) and retry with its gateApprovalId once the human approves; a used, mismatched, or since-changed amendment is rejected."
        );
      }
    }

    // Resolved BEFORE the transaction on purpose: `requestAuditColumns` upserts
    // Principal rows through the OUTER client, and doing that while the
    // serializable transaction holds SQLite's write lock deadlocks the request.
    const auditColumns = await requestAuditColumns(request);

    const result = await prisma.$transaction(
      async (tx) => {
        const current = await tx.workflowRun.findUnique({
          where: { id: params.runId },
        });
        if (!current) {
          throw app.httpErrors.notFound(
            "The requested workflow run does not exist."
          );
        }
        // Re-checked inside the transaction: a run that reached `done` while
        // the gate was being redeemed must not gain work nothing will run.
        assertAmendableStatus(app, request, current);
        // Single-use fence, inside the transaction for the same reason the
        // question fold is (ADR-0043): two overlapping appends both read
        // "proposed", both write, and the plan grows twice.
        const claimed = deriveWorkflowAmendments(
          await amendmentSpine(params.runId, tx)
        ).find((entry) => entry.id === params.amendmentId);
        if (!claimed || claimed.status !== "proposed") {
          throw app.httpErrors.conflict(
            `Amendment '${params.amendmentId}' is already applied; an amendment appends exactly once.`
          );
        }
        if (hashAmendmentSteps(claimed.steps) !== pending.stepsHash) {
          throw app.httpErrors.conflict(
            "The amendment's steps changed while the append was starting; review and approve the current amendment again."
          );
        }
        const currentProposal = workflowProposalSchema.parse(current.proposal);
        // D1 re-checked against the plan as it stands NOW: another amendment
        // may have landed since this draft was written.
        assertAppendable(app, claimed.steps, currentProposal);

        const nextProposal = workflowProposalSchema.parse({
          ...currentProposal,
          steps: [...currentProposal.steps, ...claimed.steps],
        });
        // D4: the update touches `proposal` and nothing else — no status, no
        // budget, no timestamps. Appending is not resuming.
        const run = await tx.workflowRun.update({
          where: { id: params.runId },
          data: {
            proposal: nextProposal as unknown as Prisma.InputJsonValue,
          },
        });

        // A workflow step IS a task: without these the runner throws "has no
        // task for step" on its next pass, which is exactly the silently
        // dropped instruction D5 exists to prevent.
        const tasks = [];
        for (const step of claimed.steps) {
          tasks.push(
            await tx.task.create({
              data: {
                title: step.title,
                description: step.brief,
                priority: step.priority,
                chatId: current.chatId,
                workflowRunId: current.id,
                stepKey: step.stepKey,
                workspacePath: current.workspacePath,
              },
            })
          );
        }

        // D6: which amendment introduced which steps, and who grew the plan.
        await tx.event.create({
          data: {
            ...auditColumns,
            laneId: "muon",
            taskId: current.id,
            kind: WORKFLOW_AMENDED_EVENT_KIND,
            message: `workflow run ${current.id} amended by ${amendedBy}: ${claimed.steps.length} step(s) appended (amendment ${params.amendmentId})`,
            metadata: {
              workflowRunId: current.id,
              amendmentId: params.amendmentId,
              amendedBy,
              stepsHash: pending.stepsHash,
              stepKeys: claimed.steps.map((step) => step.stepKey),
              tasks: tasks.map((task) => task.id),
            } as Prisma.InputJsonValue,
          },
        });
        return { run, tasks };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    mirrorToGraph(async (graph) => {
      for (const task of result.tasks) {
        await graph.upsertTask({
          id: task.id,
          title: task.title,
          status: task.status,
        });
        await graph.linkTaskToWorkflowRun({
          taskId: task.id,
          runId: result.run.id,
          stepKey: task.stepKey ?? "",
        });
      }
    });

    const amendment = deriveWorkflowAmendments(
      await amendmentSpine(params.runId)
    ).find((entry) => entry.id === params.amendmentId);
    reply.code(201);
    return { run: result.run, tasks: result.tasks, amendment: amendment ?? null };
  });
}
