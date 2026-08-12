import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/lib/api-client.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

describe("MuonApiClient", () => {
  it("hits health endpoint and parses response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        status: "ok",
        service: "muon-backend",
        timestamp: "2026-07-06T00:00:00.000Z",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.health();

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/health", {
      headers: {},
    });
    expect(result.status).toBe("ok");
    expect(result.service).toBe("muon-backend");
  });

  it("creates task using POST payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: {
          id: "task-1",
          title: "Build CLI",
          description: "Implement task and approval commands.",
          status: "backlog",
          priority: "high",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const task = await client.createTask({
      title: "Build CLI",
      description: "Implement task and approval commands.",
      priority: "high",
    });

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Build CLI",
        description: "Implement task and approval commands.",
        priority: "high",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(task.id).toBe("task-1");
    expect(task.priority).toBe("high");
  });

  it("throws when backend returns non-ok response", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({}, 500));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await expect(client.listLanes()).rejects.toThrow("500 Error");
  });

  it("records a lane event in the backend event log", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        event: {
          id: "event-1",
          laneId: "codex",
          taskId: "task-1",
          kind: "task.started",
          message: "Running codex",
          metadata: { command: "codex" },
          timestamp: "2026-07-06T10:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const event = await client.recordEvent({
      laneId: "codex",
      taskId: "task-1",
      kind: "task.started",
      message: "Running codex",
      metadata: { command: "codex" },
      timestamp: "2026-07-06T10:00:00.000Z",
    });

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/events", {
      method: "POST",
      body: JSON.stringify({
        laneId: "codex",
        taskId: "task-1",
        kind: "task.started",
        message: "Running codex",
        metadata: { command: "codex" },
        timestamp: "2026-07-06T10:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(event.id).toBe("event-1");
  });

  it("fetches full task detail with relations", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: {
          id: "task-1",
          title: "Fix backend",
          description: "Make the API suite green.",
          status: "review",
          priority: "high",
          createdAt: "2026-07-06T09:00:00.000Z",
          updatedAt: "2026-07-06T11:00:00.000Z",
          assignments: [
            {
              id: "assignment-1",
              summary: "muon run: fix",
              state: "queued",
              createdAt: "2026-07-06T09:05:00.000Z",
              completedAt: null,
              lane: {
                id: "lane-1",
                key: "codex",
                name: "Codex",
                provider: "openai",
                role: "peer",
                status: "available",
              },
            },
          ],
          handoffs: [],
          approvals: [
            {
              id: "approval-1",
              requestedBy: "codex",
              kind: "command",
              reason: "muon run gate",
              status: "approved",
              decisionNotes: null,
              createdAt: "2026-07-06T09:01:00.000Z",
              decidedAt: "2026-07-06T09:02:00.000Z",
            },
          ],
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const task = await client.getTaskDetail("task-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/tasks/task-1",
      { headers: {} }
    );
    expect(task.id).toBe("task-1");
    expect(task.assignments[0]?.lane?.name).toBe("Codex");
    expect(task.approvals[0]?.status).toBe("approved");
  });

  it("fetches aggregated coordination metrics", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        metrics: {
          approvals: {
            decided: 2,
            pending: 1,
            averageTurnaroundMs: 120000,
            medianTurnaroundMs: 120000,
          },
          handoffs: {
            total: 2,
            prepSamples: 1,
            averagePrepMs: 30000,
            medianPrepMs: 30000,
          },
          assignments: {
            total: 3,
            duplicateBriefings: 1,
            tasksWithDuplicates: 1,
          },
          tasks: {
            total: 2,
            completed: 1,
            averageCycleMs: 3600000,
            medianCycleMs: null,
          },
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const metrics = await client.getMetrics();

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/metrics", {
      headers: {},
    });
    expect(metrics.approvals.decided).toBe(2);
    expect(metrics.tasks.medianCycleMs).toBeNull();
  });

  it("lists recorded events for a task", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        events: [
          {
            id: "event-1",
            laneId: "codex",
            taskId: "task-1",
            kind: "task.completed",
            message: "Command completed",
            metadata: { exitCode: 0 },
            timestamp: "2026-07-06T10:00:05.000Z",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const events = await client.listTaskEvents("task-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/tasks/task-1/events",
      { headers: {} }
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("task.completed");
  });
});
