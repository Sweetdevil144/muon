import { describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { stopAllDispatches } from "../src/lib/cockpit-actions.js";

describe("TUI stopAllDispatches", () => {
  it("interrupts all active dispatch lanes", async () => {
    const interruptDispatchJob = vi.fn(async () => undefined);
    const result = await stopAllDispatches({
      listDispatchJobs: async () =>
        [
          { id: "job-1", status: "running" },
          { id: "job-2", status: "queued" },
          { id: "job-3", status: "done" },
        ] as DispatchJobRecord[],
      interruptDispatchJob,
    });

    expect(result).toEqual({ requested: 2, stopped: 2, failedJobIds: [] });
    expect(interruptDispatchJob).toHaveBeenCalledTimes(2);
  });

  it("does not truncate panic-stop at one dispatch page", async () => {
    const jobs = Array.from({ length: 51 }, (_, index) => ({
      id: `job-${index}`,
      status: "running",
      interruptRequested: false,
    })) as DispatchJobRecord[];
    const interrupted = new Set<string>();
    const listDispatchJobs = vi.fn(async () =>
      jobs.filter((job) => !interrupted.has(job.id)).slice(0, 50)
    );
    const interruptDispatchJob = vi.fn(async (jobId: string) => {
      interrupted.add(jobId);
    });

    await expect(
      stopAllDispatches({ listDispatchJobs, interruptDispatchJob })
    ).resolves.toEqual({
      requested: 51,
      stopped: 51,
      failedJobIds: [],
    });
    expect(listDispatchJobs).toHaveBeenCalledTimes(3);
  });
});
