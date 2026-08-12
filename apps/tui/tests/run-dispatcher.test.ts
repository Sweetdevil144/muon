import { describe, expect, it, vi } from "vitest";
import { dispatchRun } from "../src/lib/run-dispatcher.js";

const lane = {
  id: "lane-1",
  key: "codex",
  name: "Codex",
  provider: "openai",
  role: "peer",
  status: "available",
};

describe("dispatchRun", () => {
  it("assigns and observes a task through the persistent dispatch spine", async () => {
    const client = {
      getRunner: vi.fn(async () => ({
        live: true,
        runner: {
          id: "runner-1",
          host: "local",
          status: "online",
          lastSeenAt: new Date().toISOString(),
        },
      })),
      assignTask: vi.fn(async () => ({ id: "assignment-1" })),
      enqueueDispatch: vi.fn(async () => ({
        id: "job-1",
        status: "queued",
      })),
      getDispatchJob: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job-1",
          status: "running",
          agentId: "agent-1",
        })
        .mockResolvedValueOnce({
          id: "job-1",
          status: "done",
          agentId: "agent-1",
          exitCode: 0,
          result: "done",
        }),
      listStreamChunks: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            seq: 1,
            taskId: "task-1",
            laneId: "lane-1",
            agentId: "agent-1",
            kind: "output",
            content: "chunk 1",
            timestamp: "2026-07-09T01:00:01.000Z",
          },
          {
            seq: 2,
            taskId: "task-1",
            laneId: "lane-1",
            agentId: "agent-1",
            kind: "reasoning",
            content: "chunk 2",
            timestamp: "2026-07-09T01:00:02.000Z",
          },
        ])
        .mockResolvedValueOnce([]),
      recordEvent: vi.fn(async (event) => ({
        ...event,
        id: `event-${Math.random()}`,
      })),
    };
    const live: string[] = [];

    const result = await dispatchRun({
      client: client as never,
      lane,
      taskId: "task-1",
      brief: "fix things",
      cwd: "/repo",
      harnessKey: "implement",
      pollMs: 0,
      onLiveEvent: (event) => live.push(event.kind),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      output: "done",
      recorded: 3,
      failures: 0,
    });
    expect(live).toEqual([
      "task.started",
      "task.progress",
      "task.progress",
      "task.completed",
    ]);
    expect(client.assignTask).toHaveBeenCalledWith({
      taskId: "task-1",
      laneId: "lane-1",
      summary: "tui run: fix things",
    });
    expect(client.enqueueDispatch).toHaveBeenCalledWith({
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-1",
      brief: "fix things",
      harnessKey: "implement",
      workspacePath: "/repo",
    });
    expect(client.recordEvent).toHaveBeenCalledTimes(3);
  });

  it("fails visibly without creating an assignment when no runner is live", async () => {
    const client = {
      getRunner: vi.fn(async () => ({ live: false, runner: null })),
      assignTask: vi.fn(),
      enqueueDispatch: vi.fn(),
    };

    await expect(
      dispatchRun({
        client: client as never,
        lane,
        taskId: "task-1",
        brief: "fix things",
        pollMs: 0,
        onLiveEvent: () => undefined,
      })
    ).rejects.toThrow(/muon runner/i);
    expect(client.assignTask).not.toHaveBeenCalled();
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
  });
});
