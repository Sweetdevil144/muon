import { describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { stopAllDispatches } from "../src/lib/cockpit-actions.js";

describe("stopAllDispatches", () => {
  it("interrupts every queued and running lane, and reports failures", async () => {
    const jobs = [
      { id: "queued", status: "queued" },
      { id: "running", status: "running" },
      { id: "done", status: "done" },
    ] as DispatchJobRecord[];
    const interrupt = vi.fn(async (jobId: string) => {
      if (jobId === "running") throw new Error("lost runner");
    });

    await expect(
      stopAllDispatches({
        listDispatchJobs: async () => jobs,
        interruptDispatchJob: interrupt,
      })
    ).resolves.toEqual({
      requested: 2,
      stopped: 1,
      failedJobIds: ["running"],
    });
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it("keeps draining active batches beyond the backend page limit", async () => {
    const jobs = Array.from({ length: 205 }, (_, index) => ({
      id: `job-${index}`,
      status: index % 2 === 0 ? "queued" : "running",
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
      requested: 205,
      stopped: 205,
      failedJobIds: [],
    });
    expect(listDispatchJobs).toHaveBeenCalledWith({
      activeOnly: true,
      limit: 200,
    });
    expect(listDispatchJobs).toHaveBeenCalledTimes(6);
  });
});
