import type { DispatchJobRecord } from "@muon/client";

type DispatchControlClient = {
  listDispatchJobs(filter?: {
    activeOnly?: boolean;
    limit?: number;
  }): Promise<DispatchJobRecord[]>;
  interruptDispatchJob(jobId: string): Promise<void>;
};

export type StopAllResult = {
  requested: number;
  stopped: number;
  failedJobIds: string[];
};

export async function stopAllDispatches(
  client: DispatchControlClient
): Promise<StopAllResult> {
  const attempted = new Set<string>();
  const failedJobIds: string[] = [];
  while (true) {
    const active = (
      await client.listDispatchJobs({ activeOnly: true, limit: 200 })
    ).filter(
      (job) =>
        !attempted.has(job.id) &&
        !job.interruptRequested &&
        (job.status === "queued" || job.status === "running")
    );
    if (active.length === 0) break;
    active.forEach((job) => attempted.add(job.id));
    const settled = await Promise.allSettled(
      active.map((job) => client.interruptDispatchJob(job.id))
    );
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        failedJobIds.push(active[index]!.id);
      }
    });
  }
  return {
    requested: attempted.size,
    stopped: attempted.size - failedJobIds.length,
    failedJobIds,
  };
}
