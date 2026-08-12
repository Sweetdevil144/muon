import { describe, expect, it, vi } from "vitest";
import { observeDispatch } from "../src/lib/dispatch-observer.js";

describe("observeDispatch", () => {
  it("tails only new stream chunks and returns the terminal job", async () => {
    const client = {
      listStreamChunks: vi
        .fn()
        .mockResolvedValueOnce([{ seq: 4 }])
        .mockResolvedValueOnce([
          {
            seq: 5,
            taskId: "task-1",
            laneId: "lane-1",
            kind: "output",
            content: "working",
            timestamp: "2026-07-16T00:00:00.000Z",
          },
        ]),
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        status: "done",
        exitCode: 0,
        result: "complete",
      })),
    };
    const chunks: string[] = [];

    const job = await observeDispatch({
      client: client as never,
      jobId: "job-1",
      taskId: "task-1",
      timeoutMs: 1_000,
      pollMs: 0,
      onChunk: (chunk) => chunks.push(chunk.content),
    });

    expect(job).toMatchObject({ status: "done", result: "complete" });
    expect(chunks).toEqual(["working"]);
    expect(client.listStreamChunks).toHaveBeenNthCalledWith(2, {
      taskId: "task-1",
      afterSeq: 4,
      limit: 100,
    });
  });

  it("fails with an actionable timeout instead of waiting forever", async () => {
    const client = {
      listStreamChunks: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        status: "running",
      })),
    };

    await expect(
      observeDispatch({
        client: client as never,
        jobId: "job-1",
        taskId: "task-1",
        timeoutMs: 0,
        pollMs: 0,
      })
    ).rejects.toThrow(/interrupt.*job-1/i);
  });
});
