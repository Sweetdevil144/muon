import type {
  DispatchJobRecord,
  MuonApiClient,
  StreamChunk,
} from "@muon/client";

const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function observeDispatch(input: {
  client: MuonApiClient;
  jobId: string;
  taskId: string;
  timeoutMs: number;
  pollMs?: number;
  afterSeq?: number;
  onChunk?: (chunk: StreamChunk) => void;
}): Promise<DispatchJobRecord> {
  const baseline =
    input.afterSeq === undefined
      ? await input.client
          .listStreamChunks({
            taskId: input.taskId,
            latest: true,
            limit: 1,
          })
          .catch(() => [])
      : [];
  let afterSeq = input.afterSeq ?? baseline.at(-1)?.seq ?? 0;
  const deadline = Date.now() + input.timeoutMs;
  const pollMs = input.pollMs ?? 500;

  for (;;) {
    const job = await input.client.getDispatchJob(input.jobId);
    const chunks = await input.client
      .listStreamChunks({
        taskId: input.taskId,
        afterSeq,
        limit: 100,
      })
      .catch(() => []);
    for (const chunk of chunks) {
      input.onChunk?.(chunk);
    }
    afterSeq = chunks[chunks.length - 1]?.seq ?? afterSeq;

    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Dispatch '${input.jobId}' did not finish within ${input.timeoutMs}ms. Inspect it with \`muon dispatch status --job-id ${input.jobId}\` or stop it with \`muon dispatch interrupt --job-id ${input.jobId}\`.`
      );
    }
    await delay(pollMs);
  }
}
