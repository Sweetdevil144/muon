import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  loopKindSchema,
  loopProgressSchema,
  loopRunStatusSchema,
} from "@muon/protocol";
import {
  requireAgentTaskAccess,
  visibleTaskIdsForCapability,
} from "../lib/auth.js";
import { prisma } from "../lib/db.js";

const createLoopSchema = z.object({
  dispatchJobId: z.string().min(1).optional(),
  taskId: z.string().min(1),
  workflowRunId: z.string().min(1).optional(),
  stepKey: z.string().min(1).optional(),
  harnessKey: z.string().min(1).optional(),
  kind: loopKindSchema.default("check_repair"),
  budget: z
    .object({
      maxIterations: z.number().int().min(1).max(10).default(3),
      maxWallMs: z.number().int().positive().optional(),
    })
    .default({ maxIterations: 3 }),
});

const updateLoopSchema = z
  .object({
    iterations: z.number().int().min(0).optional(),
    progress: loopProgressSchema.optional(),
    status: loopRunStatusSchema.optional(),
    stopReason: z.string().min(1).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  });

const TERMINAL_LOOP_STATUSES = new Set([
  "passed",
  "escalated",
  "exhausted",
  "aborted",
]);

export async function registerLoopRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    const query = z
      .object({ taskId: z.string().min(1).optional() })
      .parse(request.query);
    if (query.taskId) {
      await requireAgentTaskAccess(app, request, query.taskId);
    }
    const visibleTaskIds = request.agentJobCapability
      ? await visibleTaskIdsForCapability(request.agentJobCapability)
      : undefined;

    const loops = await prisma.loopRun.findMany({
      where: visibleTaskIds
        ? {
            AND: [
              ...(query.taskId ? [{ taskId: query.taskId }] : []),
              { taskId: { in: visibleTaskIds } },
            ],
          }
        : query.taskId
          ? { taskId: query.taskId }
          : undefined,
      orderBy: { startedAt: "desc" },
    });
    return { loops };
  });

  app.post("/", async (request, reply) => {
    const payload = createLoopSchema.parse(request.body);
    await requireAgentTaskAccess(app, request, payload.taskId);

    if (
      request.agentJobCapability &&
      payload.dispatchJobId !== request.agentJobCapability.jobId
    ) {
      throw app.httpErrors.forbidden(
        "An exact-job capability may create only the loop bound to itself."
      );
    }

    if (payload.dispatchJobId) {
      const dispatch = await prisma.dispatchJob.findUnique({
        where: { id: payload.dispatchJobId },
        select: { taskId: true, kind: true },
      });
      if (
        !dispatch ||
        dispatch.taskId !== payload.taskId ||
        dispatch.kind !== "loop"
      ) {
        throw app.httpErrors.badRequest(
          "dispatchJobId must identify a loop dispatch for the submitted task."
        );
      }
    }

    const data = {
      dispatchJobId: payload.dispatchJobId,
      taskId: payload.taskId,
      workflowRunId: payload.workflowRunId,
      stepKey: payload.stepKey,
      harnessKey: payload.harnessKey,
      kind: payload.kind,
      budget: payload.budget as Prisma.InputJsonValue,
    };

    // A reclaimed runner may retry the create after the first response was
    // lost. The unique dispatch coordinate makes that replay idempotent rather
    // than creating a second live loop for the same job.
    const loop = payload.dispatchJobId
      ? await prisma.loopRun.upsert({
          where: { dispatchJobId: payload.dispatchJobId },
          create: data,
          update: {},
        })
      : await prisma.loopRun.create({ data });

    reply.code(201);
    return { loop };
  });

  app.patch("/:loopId", async (request) => {
    const params = z.object({ loopId: z.string().min(1) }).parse(request.params);
    const payload = updateLoopSchema.parse(request.body);
    const existing = await prisma.loopRun.findUnique({
      where: { id: params.loopId },
      select: { taskId: true, dispatchJobId: true },
    });
    if (!existing) {
      throw app.httpErrors.notFound("The requested loop does not exist.");
    }
    await requireAgentTaskAccess(app, request, existing.taskId);
    if (
      request.agentJobCapability &&
      existing.dispatchJobId &&
      existing.dispatchJobId !== request.agentJobCapability.jobId
    ) {
      throw app.httpErrors.forbidden(
        "An exact-job capability may update only its own loop run."
      );
    }

    const loop = await prisma.loopRun.update({
      where: { id: params.loopId },
      data: {
        ...(payload.iterations !== undefined
          ? { iterations: payload.iterations }
          : {}),
        ...(payload.progress !== undefined
          ? { progress: payload.progress as Prisma.InputJsonValue }
          : {}),
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
        ...(payload.status && TERMINAL_LOOP_STATUSES.has(payload.status)
          ? { endedAt: new Date() }
          : {}),
      },
    });

    return { loop };
  });
}
