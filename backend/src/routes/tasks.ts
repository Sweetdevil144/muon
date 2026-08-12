import {
  isOwnedLinkedWorktree,
  locateTaskWorktreePath,
  verifyDurableWorktreeArtifact,
  verifyDurableWorktreeMerge,
  worktreeBaseCommit,
  worktreeChangedFiles,
  worktreeDiff,
} from "@muon/core";
import {
  handoffPacketSchema,
  mergeReviewRecordSchema,
} from "@muon/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  requireAgentOrchestratorCapability,
  requireAgentTaskAccess,
  requireAgentTaskDiffAccess,
  visibleTaskIdsForCapability,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { annotateHandoffChecks } from "../lib/check-history-read.js";
import { mirrorToGraph } from "../lib/graph.js";
import { certifyWorktreeReviewCoverage } from "../lib/review-certification.js";
import { validateWorkspacePath } from "../lib/workspace.js";

/** Wire backstop for a typed handoff packet (P0.3): 256KiB serialized. */
const HANDOFF_PACKET_MAX_BYTES = 262_144;

/** Review-lane diff read: enough for any sane crew change; truncation is
 *  reported, and the changed-file list stays complete regardless. */
const WORKTREE_DIFF_MAX_BYTES = 524_288;

const createTaskSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  workspacePath: z.string().min(1).optional(),
});

const updateTaskStatusSchema = z.object({
  status: z.enum(["backlog", "in_progress", "review", "done", "blocked"]),
});

const durableShipExecutionSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({
        repoRoot: z.string().min(1).nullable(),
        worktreePath: z.string().min(1).nullable(),
      })
      .passthrough(),
    expectedBase: z
      .object({
        ref: z.string().startsWith("refs/heads/"),
        head: z.string().regex(/^[0-9a-f]{7,64}$/i),
      })
      .strict()
      .nullable(),
    verifiedWorktreeHead: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional(),
    finishedAt: z.string().datetime(),
    outcome: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("merged"),
          sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
          mergeCommit: z.string().regex(/^[0-9a-f]{7,64}$/i),
        })
        .passthrough(),
      z.object({ status: z.literal("no-op") }).passthrough(),
    ]),
  })
  .passthrough();

function parseDurableShipSuccess(value: unknown) {
  const parsed = durableShipExecutionSchema.safeParse(value);
  if (!parsed.success) return null;
  const execution = parsed.data;
  if (execution.outcome.status === "merged") {
    return execution.verifiedWorktreeHead === execution.outcome.sha
      ? execution
      : null;
  }
  return (
    execution.target.repoRoot === null ||
    execution.verifiedWorktreeHead !== undefined
  )
    ? execution
    : null;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((value, index) => value === actual[index]);
}

async function hasCurrentDurableShipSuccess(input: {
  mergeExecution: unknown;
  reviewCertification: unknown;
}): Promise<boolean> {
  const execution = parseDurableShipSuccess(input.mergeExecution);
  if (!execution) return false;
  if (execution.target.repoRoot === null) {
    return execution.outcome.status === "no-op";
  }
  if (
    !execution.target.worktreePath ||
    !execution.expectedBase ||
    !execution.verifiedWorktreeHead
  ) {
    return false;
  }
  if (execution.outcome.status === "merged") {
    const verification = await verifyDurableWorktreeMerge({
      repoRoot: execution.target.repoRoot,
      worktreePath: execution.target.worktreePath,
      expectedBase: execution.expectedBase,
      verifiedWorktreeHead: execution.verifiedWorktreeHead,
      mergeCommit: execution.outcome.mergeCommit,
    }).catch(() => null);
    return verification?.ok === true;
  }
  const artifactVerification = await verifyDurableWorktreeArtifact({
    worktreePath: execution.target.worktreePath,
    verifiedWorktreeHead: execution.verifiedWorktreeHead,
  }).catch(() => null);
  if (artifactVerification?.ok !== true) return false;
  const review = mergeReviewRecordSchema.safeParse(
    input.reviewCertification
  );
  if (!review.success) return false;
  const current = await certifyWorktreeReviewCoverage({
    repoRoot: execution.target.repoRoot,
    worktreePath: execution.target.worktreePath,
  }).catch(() => null);
  if (!current || current.artifactDigest !== review.data.artifactDigest) {
    return false;
  }
  if (review.data.method !== "operator-manual") {
    return current.status === "certified";
  }
  return (
    current.status === "certified" ||
    (current.status === "blocked" &&
      current.blockCode === "review-blind" &&
      sameStrings(current.blindFiles ?? [], review.data.blindFiles))
  );
}

const createAssignmentSchema = z.object({
  laneId: z.string().min(1),
  summary: z.string().min(5),
});

const createHandoffSchema = z.object({
  fromLaneId: z.string().min(1),
  toLaneId: z.string().min(1),
  packetTitle: z.string().min(3),
  packetBody: z.string().min(10),
  // Typed v2 packet (P0.3), additive: legacy prose-only writers keep working.
  // Packet content is AGENT-PRODUCED UNTRUSTED DATA: stored verbatim as data,
  // never interpreted as instructions, memory, or approval evidence.
  packet: handoffPacketSchema.optional(),
});

export async function registerTaskRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const visibleTaskIds = request.agentJobCapability
      ? await visibleTaskIdsForCapability(request.agentJobCapability)
      : undefined;
    const tasks = await prisma.task.findMany({
      where: visibleTaskIds ? { id: { in: visibleTaskIds } } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        assignments: {
          include: { lane: true },
          orderBy: { createdAt: "desc" },
        },
        handoffs: {
          include: { fromLane: true, toLane: true },
          orderBy: { createdAt: "desc" },
        },
        approvals: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return { tasks };
  });

  app.get("/dashboard", async () => {
    const [laneCounts, taskCounts, pendingApprovals, activeHandoffs] =
      await Promise.all([
        prisma.assignment.groupBy({
          by: ["laneId", "state"],
          _count: true,
        }),
        prisma.task.groupBy({
          by: ["status"],
          _count: true,
        }),
        prisma.approvalRequest.count({
          where: { status: "pending" },
        }),
        prisma.handoff.count({
          where: { status: "pending" },
        }),
      ]);

    return {
      laneCounts,
      taskCounts,
      pendingApprovals,
      activeHandoffs,
    };
  });

  app.post("/", async (request, reply) => {
    const payload = createTaskSchema.parse(request.body);
    const capability = request.agentJobCapability
      ? requireAgentOrchestratorCapability(app, request)
      : undefined;
    const taskData = {
      ...payload,
      ...(capability ? { chatId: capability.chatId } : {}),
    };
    // WORKSPACE CONTAINMENT (P3-B / audit M2): a task's workspacePath is
    // inherited as the child-process cwd when the task is later dispatched, so
    // validate it here (allowlisted roots) before it can reach a run → 400.
    if (payload.workspacePath) {
      const check = validateWorkspacePath(payload.workspacePath);
      if (!check.ok) {
        throw app.httpErrors.badRequest(check.reason);
      }
      taskData.workspacePath = check.path;
    }
    if (capability) {
      if (!capability.workspacePath) {
        throw app.httpErrors.conflict(
          "The orchestrator job has no governed workspace."
        );
      }
      if (
        taskData.workspacePath &&
        taskData.workspacePath !== capability.workspacePath
      ) {
        throw app.httpErrors.conflict(
          "A crew task must use the owning chat's governed workspace."
        );
      }
      taskData.workspacePath = capability.workspacePath;
    }
    const task = await prisma.task.create({ data: taskData });
    mirrorToGraph((graph) =>
      graph.upsertTask({ id: task.id, title: task.title, status: task.status })
    );
    reply.code(201);
    return { task };
  });

  app.get("/:taskId", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskAccess(app, request, params.taskId);

    const task = await prisma.task.findUnique({
      where: { id: params.taskId },
      include: {
        assignments: {
          include: { lane: true },
          orderBy: { createdAt: "asc" },
        },
        handoffs: {
          include: { fromLane: true, toLane: true },
          orderBy: { createdAt: "asc" },
        },
        approvals: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!task) {
      throw app.httpErrors.notFound("The requested task does not exist.");
    }

    // ADR-0037: annotate each packet's checks with what MUON knows about how
    // that check has behaved in THIS workspace.
    //
    // Annotated on READ rather than baked into the stored packet, deliberately:
    // history changes as more runs land, so a figure frozen at write time would
    // go stale and start misleading. The packet keeps exactly what the run
    // observed; the flakiness is derived beside it.
    //
    // Best-effort: a history that cannot be read is a history not shown, never
    // a failed task read. And nothing here touches `outcome` — a failed check
    // stays failed.
    const annotatedHandoffs = await annotateHandoffChecks(
      task.handoffs,
      task.workspacePath
    );

    return { task: { ...task, handoffs: annotatedHandoffs } };
  });

  // Review-lane evidence: a task's worktree diff, served by the brain (which
  // owns the worktrees) to SAME-MISSION crew. Two reviewers on two vendors had
  // zero paths to the implementer's diff (mission 420c8bf4): review_diff sees
  // only the caller's own tree, cross-task reads 403 (correctly — packets and
  // briefs are authority), and the sandbox refuses cross-worktree file reads.
  // The diff itself is the code the mission is jointly producing; reading it
  // grants no steering, no approval, no packet. Read-only; nothing mutates.
  app.get("/:taskId/worktree-diff", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskDiffAccess(app, request, params.taskId);
    const task = await prisma.task.findUnique({
      where: { id: params.taskId },
      select: { workspacePath: true },
    });
    if (!task) {
      throw app.httpErrors.notFound("The requested task does not exist.");
    }
    if (!task.workspacePath) {
      return {
        status: "no-worktree",
        reason: "This task has no governed workspace, so it owns no worktree.",
      };
    }
    const worktreePath = locateTaskWorktreePath(
      task.workspacePath,
      params.taskId
    );
    if (!isOwnedLinkedWorktree(task.workspacePath, worktreePath)) {
      return {
        status: "no-worktree",
        reason:
          "No worktree exists for this task — it was never dispatched, or its tree was already cleaned up.",
      };
    }
    const [diff, changedFiles, baseCommit] = await Promise.all([
      worktreeDiff(worktreePath, { maxBytes: WORKTREE_DIFF_MAX_BYTES }),
      worktreeChangedFiles(worktreePath),
      worktreeBaseCommit(worktreePath).catch(() => undefined),
    ]);
    return {
      status: "ok",
      // The COMPLETE changed-file set comes from git status, not from parsing
      // the (possibly truncated) text — the coverage denominator stays honest
      // even when the diff body is cut.
      changedFiles,
      baseCommit,
      diff: {
        text: diff.text,
        truncated: diff.truncated,
        totalBytes: diff.totalBytes,
      },
    };
  });

  app.get("/:taskId/events", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskAccess(app, request, params.taskId);

    const events = await prisma.event.findMany({
      where: { taskId: params.taskId },
      orderBy: { timestamp: "asc" },
    });

    if (!request.agentJobCapability) {
      return { events };
    }
    // Agent task_context needs a timeline to reconcile startup state, but raw
    // event prose/metadata is untrusted cognition. Return only authenticated
    // coordinates and a server-derived fixed message.
    return {
      events: events.map((event) => ({
        ...event,
        message: `activity: ${event.kind}`,
        metadata: {},
      })),
    };
  });

  app.patch("/:taskId/status", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskAccess(app, request, params.taskId);
    const payload = updateTaskStatusSchema.parse(request.body);

    // Ship review gate (ROADMAP Phase 6): work is not "done" until a merge
    // approval for this task has been explicitly approved by a human.
    let shipBinding:
      | { mergeExecution: unknown; reviewCertification: unknown }
      | undefined;
    if (payload.status === "done") {
      const shipApproval = await prisma.approvalRequest.findFirst({
        where: {
          taskId: params.taskId,
          kind: "merge",
          status: "approved",
          mergeExecutionStatus: "succeeded",
        },
        orderBy: { decidedAt: "desc" },
      });
      shipBinding = shipApproval
        ? {
            mergeExecution: shipApproval.mergeExecution,
            reviewCertification: shipApproval.reviewCertification,
          }
        : undefined;
      if (
        !shipBinding ||
        !(await hasCurrentDurableShipSuccess(shipBinding))
      ) {
        throw app.httpErrors.conflict(
          "Ship review required: the latest approved merge does not match the current governed worktree and primary ref. Refresh review, merge the current artifact, then mark the task done."
        );
      }
    }

    const task = await prisma.task.update({
      where: { id: params.taskId },
      data: { status: payload.status },
    });

    // The filesystem and SQLite cannot share one transaction. Re-check after
    // the durable status write so drift anywhere in the verification→write
    // window cannot leave a false `done`. The guarded rollback never overwrites
    // a concurrent status decision that already moved the task elsewhere.
    if (
      payload.status === "done" &&
      shipBinding &&
      !(await hasCurrentDurableShipSuccess(shipBinding))
    ) {
      await prisma.task.updateMany({
        where: { id: params.taskId, status: "done" },
        data: { status: "review" },
      });
      throw app.httpErrors.conflict(
        "The governed artifact changed while task completion was being committed. The task returned to review; refresh review and merge the current artifact."
      );
    }

    mirrorToGraph((graph) =>
      graph.upsertTask({ id: task.id, title: task.title, status: task.status })
    );

    return { task };
  });

  app.post("/:taskId/assignments", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskAccess(app, request, params.taskId);
    const payload = createAssignmentSchema.parse(request.body);

    const assignment = await prisma.assignment.create({
      data: {
        taskId: params.taskId,
        laneId: payload.laneId,
        summary: payload.summary,
      },
      include: { lane: true },
    });

    const task = await prisma.task.update({
      where: { id: params.taskId },
      data: { status: "in_progress" },
    });

    mirrorToGraph(async (graph) => {
      await graph.upsertLane({
        id: assignment.lane.id,
        key: assignment.lane.key,
        name: assignment.lane.name,
      });
      await graph.upsertTask({
        id: task.id,
        title: task.title,
        status: task.status,
      });
      await graph.recordAssignment({
        assignmentId: assignment.id,
        laneId: assignment.laneId,
        taskId: assignment.taskId,
        createdAt: assignment.createdAt.toISOString(),
      });
    });

    reply.code(201);
    return { assignment };
  });

  app.post("/:taskId/handoffs", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    await requireAgentTaskAccess(app, request, params.taskId);
    const payload = createHandoffSchema.parse(request.body);

    if (payload.fromLaneId === payload.toLaneId) {
      throw app.httpErrors.badRequest("A handoff must target a different lane.");
    }
    if (
      payload.packet &&
      Buffer.byteLength(JSON.stringify(payload.packet), "utf8") >
        HANDOFF_PACKET_MAX_BYTES
    ) {
      throw app.httpErrors.badRequest(
        "Handoff packet exceeds the 256KiB bound."
      );
    }

    const handoff = await prisma.handoff.create({
      data: {
        taskId: params.taskId,
        fromLaneId: payload.fromLaneId,
        toLaneId: payload.toLaneId,
        packetTitle: payload.packetTitle,
        packetBody: payload.packetBody,
        ...(payload.packet !== undefined
          ? { packetJson: payload.packet }
          : {}),
      },
      include: {
        fromLane: true,
        toLane: true,
      },
    });

    mirrorToGraph(async (graph) => {
      await graph.upsertLane({
        id: handoff.fromLane.id,
        key: handoff.fromLane.key,
        name: handoff.fromLane.name,
      });
      await graph.upsertLane({
        id: handoff.toLane.id,
        key: handoff.toLane.key,
        name: handoff.toLane.name,
      });
      await graph.recordHandoff({
        handoffId: handoff.id,
        taskId: handoff.taskId,
        fromLaneId: handoff.fromLaneId,
        toLaneId: handoff.toLaneId,
        status: handoff.status,
        createdAt: handoff.createdAt.toISOString(),
      });
    });

    reply.code(201);
    return { handoff };
  });
}
