import { describe, expect, it, vi } from "vitest";
import { requestSecondOpinionViaDispatch } from "../src/commands/ship.js";

describe("requestSecondOpinionViaDispatch", () => {
  it("runs the reviewer through the persistent lease-fenced dispatch spine", async () => {
    const client = {
      enqueueDispatch: vi.fn(async () => ({
        id: "job-review",
        status: "queued",
      })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-review",
        status: "done",
        exitCode: 0,
        result: "VERDICT: APPROVE\nThe change is ready.",
      })),
    };
    const ensureRunnerFn = vi.fn(async () => ({
      live: true,
      started: false,
    }));

    const result = await requestSecondOpinionViaDispatch({
      client: client as never,
      reviewerLaneKey: "codex",
      taskId: "task-1",
      brief: "Review this completed work.",
      workspacePath: "/repo",
      apiBase: "http://127.0.0.1:4321",
      ensureRunnerFn: ensureRunnerFn as never,
    });

    expect(result).toBe("VERDICT: APPROVE\nThe change is ready.");
    expect(ensureRunnerFn).toHaveBeenCalledWith(client, {
      apiBase: "http://127.0.0.1:4321",
    });
    expect(client.enqueueDispatch).toHaveBeenCalledWith({
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-1",
      brief: "Review this completed work.",
      harnessKey: "review",
      workspacePath: "/repo",
    });
    expect(client.getDispatchJob).toHaveBeenCalledWith("job-review");
  });

  it("does not enqueue a review when no runner is live", async () => {
    const client = {
      enqueueDispatch: vi.fn(),
      getDispatchJob: vi.fn(),
    };

    await expect(
      requestSecondOpinionViaDispatch({
        client: client as never,
        reviewerLaneKey: "claude-code",
        taskId: "task-1",
        brief: "Review this completed work.",
        apiBase: "http://127.0.0.1:4321",
        ensureRunnerFn: vi.fn(async () => ({
          live: false,
          started: false,
          note: "runner unavailable",
        })) as never,
      })
    ).rejects.toThrow(/runner unavailable/i);
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
  });
});
