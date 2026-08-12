import {
  coordinatorVendorIds,
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_DESCENDANTS,
} from "@muon/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import { requestAuditColumns } from "../lib/event-audit.js";
import { validateWorkspacePath } from "../lib/workspace.js";

const MAX_ROOT_WALL_MS = 1_800_000;
const MAX_DESCENDANT_WALL_MS =
  DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS;
const coordinatorVendors = coordinatorVendorIds();

const scheduleIdSchema = z.object({ scheduleId: z.string().min(1) });
const occurrenceParamsSchema = z.object({
  scheduleId: z.string().min(1),
  occurrenceId: z.string().min(1),
});

const createScheduleSchema = z
  .object({
    title: z.string().trim().min(2).max(120),
    objective: z.string().trim().min(1).max(100_000),
    workspacePath: z.string().min(1),
    vendor: z.string().min(1),
    model: z.string().trim().min(1).max(200).optional(),
    effort: z.string().trim().min(1).max(80).optional(),
    cadenceMinutes: z.number().int().min(5).max(525_600).optional(),
    nextRunAt: z.string().datetime(),
    maxRuns: z.number().int().min(1).max(10_000).optional(),
    maxWallMs: z.number().int().min(1).max(MAX_ROOT_WALL_MS),
    maxDescendantWallMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_DESCENDANT_WALL_MS),
  })
  .superRefine((value, ctx) => {
    if (!coordinatorVendors.some((vendor) => vendor === value.vendor)) {
      ctx.addIssue({
        code: "custom",
        path: ["vendor"],
        message: `Expected a coordinator-capable vendor: ${coordinatorVendors.join(", ")}.`,
      });
    }
    if (value.cadenceMinutes === undefined && (value.maxRuns ?? 1) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["maxRuns"],
        message: "A one-shot schedule without cadenceMinutes must have maxRuns=1.",
      });
    }
  });

const updateScheduleSchema = z
  .object({
    status: z.enum(["active", "paused"]).optional(),
    nextRunAt: z.string().datetime().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field must be provided.",
  });

const completeOccurrenceSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("running"),
    chatId: z.string().min(1),
  }),
  z.object({
    status: z.enum(["done", "failed"]),
    chatId: z.string().min(1).optional(),
    rootJobId: z.string().min(1).optional(),
    error: z.string().max(4_000).optional(),
  }),
]);

function nextCursor(now: Date, cadenceMinutes: number | null): Date {
  if (cadenceMinutes === null) return now;
  return new Date(now.getTime() + cadenceMinutes * 60_000);
}

/** Operator-only durable schedule CRUD and one-at-a-time due claims. */
export async function registerScheduleRoutes(app: FastifyInstance) {
  app.get("/", async (request) => {
    requireOperator(app, request);
    const schedules = await prisma.governedSchedule.findMany({
      include: {
        occurrences: { orderBy: { claimedAt: "desc" }, take: 8 },
      },
      orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
    });
    return { schedules };
  });

  app.post("/", async (request, reply) => {
    requireOperator(app, request);
    const payload = createScheduleSchema.parse(request.body);
    const workspace = validateWorkspacePath(payload.workspacePath);
    if (!workspace.ok) throw app.httpErrors.badRequest(workspace.reason);
    const schedule = await prisma.governedSchedule.create({
      data: {
        ...payload,
        workspacePath: workspace.path,
        nextRunAt: new Date(payload.nextRunAt),
        maxRuns: payload.maxRuns ?? (payload.cadenceMinutes ? null : 1),
      },
    });
    await prisma.event.create({
      data: {
        ...(await requestAuditColumns(request)),
        laneId: "muon",
        taskId: `schedule:${schedule.id}`,
        kind: "schedule.created",
        message: `governed schedule '${schedule.id}' created`,
        metadata: {
          vendor: schedule.vendor,
          nextRunAt: schedule.nextRunAt.toISOString(),
          maxWallMs: schedule.maxWallMs,
          maxDescendantWallMs: schedule.maxDescendantWallMs,
        },
        principalId: "human",
        principalKind: "human",
        accountablePrincipalId: "human",
      },
    });
    reply.code(201);
    return { schedule: { ...schedule, occurrences: [] } };
  });

  app.patch("/:scheduleId", async (request) => {
    requireOperator(app, request);
    const { scheduleId } = scheduleIdSchema.parse(request.params);
    const payload = updateScheduleSchema.parse(request.body);
    const existing = await prisma.governedSchedule.findUnique({
      where: { id: scheduleId },
    });
    if (!existing) throw app.httpErrors.notFound("Schedule does not exist.");
    if (existing.status === "completed" && payload.status === "active") {
      throw app.httpErrors.conflict(
        "A completed schedule cannot be resumed; create a fresh bounded schedule."
      );
    }
    const schedule = await prisma.governedSchedule.update({
      where: { id: scheduleId },
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.nextRunAt ? { nextRunAt: new Date(payload.nextRunAt) } : {}),
      },
      include: {
        occurrences: { orderBy: { claimedAt: "desc" }, take: 8 },
      },
    });
    return { schedule };
  });

  // Claim advances the cursor before returning. It is intentionally body-less:
  // the caller cannot choose which mission becomes due or widen its budgets.
  app.post("/claim-due", async (request) => {
    requireOperator(app, request);
    const now = new Date();
    const claimed = await prisma.$transaction(async (tx) => {
      const due = await tx.governedSchedule.findFirst({
        where: { status: "active", nextRunAt: { lte: now } },
        orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      });
      if (!due) return null;
      const nextRunCount = due.runCount + 1;
      const completed =
        due.cadenceMinutes === null ||
        (due.maxRuns !== null && nextRunCount >= due.maxRuns);
      const cursor = nextCursor(now, due.cadenceMinutes);
      const won = await tx.governedSchedule.updateMany({
        where: {
          id: due.id,
          status: "active",
          nextRunAt: due.nextRunAt,
          runCount: due.runCount,
        },
        data: {
          runCount: nextRunCount,
          nextRunAt: cursor,
          status: completed ? "completed" : "active",
          lastStatus: "claimed",
          lastError: null,
        },
      });
      if (won.count !== 1) return null;
      const occurrence = await tx.scheduleOccurrence.create({
        data: {
          scheduleId: due.id,
          scheduledFor: due.nextRunAt,
        },
      });
      return {
        schedule: {
          ...due,
          runCount: nextRunCount,
          nextRunAt: cursor,
          status: completed ? "completed" : "active",
          lastStatus: "claimed",
          lastError: null,
        },
        occurrence,
      };
    });
    return { claim: claimed };
  });

  app.patch("/:scheduleId/occurrences/:occurrenceId", async (request) => {
    requireOperator(app, request);
    const params = occurrenceParamsSchema.parse(request.params);
    const payload = completeOccurrenceSchema.parse(request.body);
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const occurrence = await tx.scheduleOccurrence.findFirst({
        where: { id: params.occurrenceId, scheduleId: params.scheduleId },
      });
      if (!occurrence) throw app.httpErrors.notFound("Occurrence does not exist.");
      if (occurrence.status === "done" || occurrence.status === "failed") {
        if (occurrence.status === payload.status) return occurrence;
        throw app.httpErrors.conflict("A terminal occurrence cannot transition again.");
      }
      if (payload.status === "running" && occurrence.status !== "claimed") {
        throw app.httpErrors.conflict("Only a claimed occurrence may start.");
      }
      const terminal = payload.status === "done" || payload.status === "failed";
      const updated = await tx.scheduleOccurrence.update({
        where: { id: occurrence.id },
        data: {
          status: payload.status,
          ...(payload.chatId ? { chatId: payload.chatId } : {}),
          ...(payload.status === "running" ? { startedAt: now } : {}),
          ...(terminal
            ? {
                endedAt: now,
                rootJobId: payload.rootJobId,
                error: payload.status === "failed" ? payload.error ?? "scheduled turn failed" : null,
              }
            : {}),
        },
      });
      await tx.governedSchedule.update({
        where: { id: params.scheduleId },
        data: {
          lastStatus: payload.status,
          ...(payload.status === "running" ? { lastStartedAt: now } : {}),
          ...(terminal
            ? {
                lastEndedAt: now,
                lastError: payload.status === "failed" ? payload.error ?? "scheduled turn failed" : null,
              }
            : {}),
        },
      });
      return updated;
    });
    return { occurrence: result };
  });
}
