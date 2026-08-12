import { describe, expect, it, vi } from "vitest";
import { startTuiSession } from "../src/lib/session-controller.js";

const lane = {
  id: "lane-1",
  key: "codex",
  name: "Codex",
  provider: "openai",
  role: "peer",
  status: "available",
};

describe("startTuiSession", () => {
  it("starts, observes, steers, and interrupts a durable session dispatch", async () => {
    let finish!: (message: string) => void;
    const done = new Promise<string>((resolve) => {
      finish = resolve;
    });
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
            content: "working",
            timestamp: "2026-07-15T12:00:00.000Z",
          },
        ]),
      enqueueDispatch: vi.fn(async () => ({
        id: "job-session",
        status: "queued",
      })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-session",
        status: "done",
        exitCode: 0,
        result: "session complete",
      })),
      steerDispatchJob: vi.fn(async () => undefined),
      interruptDispatchJob: vi.fn(async () => undefined),
    };
    const live: string[] = [];

    const session = await startTuiSession({
      client: client as never,
      lane,
      taskId: "task-1",
      brief: "Investigate the failure.",
      apiBase: "http://127.0.0.1:4321",
      apiToken: "agent-token",
      pollMs: 0,
      onLiveEvent: (event) => live.push(event.message),
      onDone: finish,
    });

    await session.send("Inspect the auth path.");
    await session.interrupt();

    expect(session).toMatchObject({
      sessionId: "job-session",
      laneKey: "codex",
      taskId: "task-1",
      canSend: true,
    });
    expect(client.enqueueDispatch).toHaveBeenCalledWith({
      kind: "session",
      vendor: "codex",
      taskId: "task-1",
      brief: "Investigate the failure.",
    });
    expect(client.steerDispatchJob).toHaveBeenCalledWith(
      "job-session",
      "Inspect the auth path."
    );
    expect(client.interruptDispatchJob).toHaveBeenCalledWith("job-session");
    await expect(done).resolves.toMatch(/session job-session ended/i);
    expect(live).toEqual(["working"]);
  });

  it("fails visibly when the persistent runner is offline", async () => {
    const client = {
      getRunner: vi.fn(async () => ({ live: false, runner: null })),
      enqueueDispatch: vi.fn(),
    };

    await expect(
      startTuiSession({
        client: client as never,
        lane,
        taskId: "task-1",
        brief: "Investigate the failure.",
        apiBase: "http://127.0.0.1:4321",
        pollMs: 0,
        onLiveEvent: () => undefined,
        onDone: () => undefined,
      })
    ).rejects.toThrow(/muon runner/i);
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
  });
});
