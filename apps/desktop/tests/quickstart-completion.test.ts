import { describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord, MemoryNote } from "@muon/client";
import { waitForFirstTaskCompletion } from "../src/lib/quickstart-completion.js";

const baseJob = {
  id: "job-1",
  taskId: "task-1",
  vendor: "codex",
  status: "done",
  result: "Summarized the repository's top-level structure.",
} as DispatchJobRecord;

const memory = {
  id: "memory-1",
  taskId: "task-1",
  text: "Quickstart completed.",
} as MemoryNote;

describe("waitForFirstTaskCompletion", () => {
  it("finishes only after the dispatch is done and memory is present", async () => {
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ ...baseJob, status: "running" })
      .mockResolvedValueOnce(baseJob);
    const recallMemories = vi.fn().mockResolvedValue([memory]);
    const addMemory = vi.fn();

    await expect(
      waitForFirstTaskCompletion({
        jobId: "job-1",
        taskId: "task-1",
        getJob,
        recallMemories,
        addMemory,
        sleep: async () => undefined,
        maxPolls: 3,
      })
    ).resolves.toEqual({ job: baseJob, memory });
    expect(addMemory).not.toHaveBeenCalled();
  });

  it("captures a reviewable task memory when the runner produced none", async () => {
    const addMemory = vi.fn().mockResolvedValue(memory);

    await expect(
      waitForFirstTaskCompletion({
        jobId: "job-1",
        taskId: "task-1",
        getJob: async () => baseJob,
        recallMemories: async () => [],
        addMemory,
        sleep: async () => undefined,
        maxPolls: 1,
      })
    ).resolves.toEqual({ job: baseJob, memory });
    expect(addMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        createdBy: "muon-quickstart",
        // BUG 1: the first task is READ-ONLY — it writes nothing, so the memory
        // anchors to no module (never a file path that implies a written file).
        modules: [],
      })
    );
    // No greet()/muon-hello artifact path is ever anchored.
    expect(JSON.stringify(addMemory.mock.calls[0]?.[0])).not.toMatch(
      /muon-hello|\.muon-quickstart/i
    );
  });

  it("fails visibly when the first dispatch does not complete", async () => {
    await expect(
      waitForFirstTaskCompletion({
        jobId: "job-1",
        taskId: "task-1",
        getJob: async () => ({
          ...baseJob,
          status: "failed",
          result: "vendor exited 1",
        }),
        recallMemories: async () => [],
        addMemory: async () => memory,
        sleep: async () => undefined,
        maxPolls: 1,
      })
    ).rejects.toThrow("vendor exited 1");
  });
});
