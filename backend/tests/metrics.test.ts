import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/lib/metrics.js";

const T = (iso: string) => new Date(iso);

describe("computeMetrics", () => {
  it("computes the four coordination KPIs from ledger rows", () => {
    const metrics = computeMetrics({
      tasks: [
        {
          id: "task-1",
          status: "done",
          createdAt: T("2026-07-06T09:00:00.000Z"),
          updatedAt: T("2026-07-06T10:00:00.000Z"),
        },
        {
          id: "task-2",
          status: "in_progress",
          createdAt: T("2026-07-06T09:30:00.000Z"),
          updatedAt: T("2026-07-06T09:45:00.000Z"),
        },
      ],
      assignments: [
        {
          taskId: "task-1",
          summary: "muon run: fix the tests",
          createdAt: T("2026-07-06T09:05:00.000Z"),
        },
        {
          taskId: "task-1",
          summary: "muon run: fix the tests",
          createdAt: T("2026-07-06T09:20:00.000Z"),
        },
        {
          taskId: "task-2",
          summary: "muon run: write docs",
          createdAt: T("2026-07-06T09:31:00.000Z"),
        },
      ],
      handoffs: [
        // prep time = 30s after the task.completed event below
        { taskId: "task-1", createdAt: T("2026-07-06T09:10:30.000Z") },
        // no completed event before it -> excluded from prep samples
        { taskId: "task-2", createdAt: T("2026-07-06T09:32:00.000Z") },
      ],
      approvals: [
        {
          status: "approved",
          createdAt: T("2026-07-06T09:00:00.000Z"),
          decidedAt: T("2026-07-06T09:01:00.000Z"),
        },
        {
          status: "rejected",
          createdAt: T("2026-07-06T09:00:00.000Z"),
          decidedAt: T("2026-07-06T09:03:00.000Z"),
        },
        { status: "pending", createdAt: T("2026-07-06T09:30:00.000Z"), decidedAt: null },
      ],
      events: [
        {
          taskId: "task-1",
          kind: "task.completed",
          timestamp: T("2026-07-06T09:10:00.000Z"),
        },
        {
          taskId: "task-2",
          kind: "task.started",
          timestamp: T("2026-07-06T09:31:30.000Z"),
        },
      ],
    });

    expect(metrics.approvals).toEqual({
      decided: 2,
      pending: 1,
      averageTurnaroundMs: 120_000,
      medianTurnaroundMs: 120_000,
    });
    expect(metrics.handoffs).toEqual({
      total: 2,
      prepSamples: 1,
      averagePrepMs: 30_000,
      medianPrepMs: 30_000,
    });
    expect(metrics.assignments).toEqual({
      total: 3,
      duplicateBriefings: 1,
      tasksWithDuplicates: 1,
    });
    expect(metrics.tasks).toEqual({
      total: 2,
      completed: 1,
      averageCycleMs: 3_600_000,
      medianCycleMs: 3_600_000,
    });
  });

  it("returns null aggregates when there are no samples", () => {
    const metrics = computeMetrics({
      tasks: [],
      assignments: [],
      handoffs: [],
      approvals: [],
      events: [],
    });

    expect(metrics.approvals).toEqual({
      decided: 0,
      pending: 0,
      averageTurnaroundMs: null,
      medianTurnaroundMs: null,
    });
    expect(metrics.handoffs).toEqual({
      total: 0,
      prepSamples: 0,
      averagePrepMs: null,
      medianPrepMs: null,
    });
    expect(metrics.assignments).toEqual({
      total: 0,
      duplicateBriefings: 0,
      tasksWithDuplicates: 0,
    });
    expect(metrics.tasks).toEqual({
      total: 0,
      completed: 0,
      averageCycleMs: null,
      medianCycleMs: null,
    });
  });

  it("uses the latest completed event before each handoff for prep time", () => {
    const metrics = computeMetrics({
      tasks: [],
      assignments: [],
      handoffs: [{ taskId: "task-1", createdAt: T("2026-07-06T10:00:10.000Z") }],
      approvals: [],
      events: [
        {
          taskId: "task-1",
          kind: "task.completed",
          timestamp: T("2026-07-06T09:00:00.000Z"),
        },
        {
          taskId: "task-1",
          kind: "task.completed",
          timestamp: T("2026-07-06T10:00:00.000Z"),
        },
        // after the handoff, must be ignored
        {
          taskId: "task-1",
          kind: "task.completed",
          timestamp: T("2026-07-06T11:00:00.000Z"),
        },
      ],
    });

    expect(metrics.handoffs.prepSamples).toBe(1);
    expect(metrics.handoffs.averagePrepMs).toBe(10_000);
  });
});
