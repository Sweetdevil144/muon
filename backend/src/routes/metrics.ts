import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/db.js";
import { computeMetrics } from "../lib/metrics.js";

export async function registerMetricsRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const [tasks, assignments, handoffs, approvals, events] =
      await Promise.all([
        prisma.task.findMany({
          select: { id: true, status: true, createdAt: true, updatedAt: true },
        }),
        prisma.assignment.findMany({
          select: { taskId: true, summary: true, createdAt: true },
        }),
        prisma.handoff.findMany({
          select: { taskId: true, createdAt: true },
        }),
        prisma.approvalRequest.findMany({
          select: { status: true, createdAt: true, decidedAt: true },
        }),
        prisma.event.findMany({
          select: { taskId: true, kind: true, timestamp: true },
        }),
      ]);

    return {
      metrics: computeMetrics({
        tasks,
        assignments,
        handoffs,
        approvals,
        events,
      }),
    };
  });
}
