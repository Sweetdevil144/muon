import type {
  DispatchJobRecord,
  MemoryKind,
  MemoryNote,
  MemoryTrust,
} from "@muon/client";

type AddMemoryInput = {
  kind: MemoryKind;
  text: string;
  taskId?: string;
  modules?: string[];
  topics?: string[];
  trust?: MemoryTrust;
  createdBy: string;
};

type CompletionOptions = {
  jobId: string;
  taskId: string;
  getJob(jobId: string): Promise<DispatchJobRecord>;
  recallMemories(taskId: string): Promise<MemoryNote[]>;
  addMemory(input: AddMemoryInput): Promise<MemoryNote>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
};

const TERMINAL = new Set(["done", "failed", "interrupted"]);

export async function waitForFirstTaskCompletion(
  options: CompletionOptions
): Promise<{ job: DispatchJobRecord; memory: MemoryNote }> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 2_000;
  const maxPolls = options.maxPolls ?? 300;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const job = await options.getJob(options.jobId);
    if (!TERMINAL.has(job.status)) {
      await sleep(pollMs);
      continue;
    }
    if (job.status !== "done") {
      throw new Error(
        job.result?.trim() || `first task ended with status '${job.status}'`
      );
    }

    const existing = await options.recallMemories(options.taskId);
    const memory =
      existing[0] ??
      (await options.addMemory({
        kind: "attempt",
        text:
          `MUON quickstart completed on ${job.vendor}. ` +
          (job.result?.trim() ||
            "The read-only repository summary ran and touched no files."),
        taskId: options.taskId,
        // BUG 1: the first task is strictly READ-ONLY — it writes nothing, so
        // the memory anchors to no module (topics only), never a file path that
        // would imply a written file.
        modules: [],
        topics: ["quickstart", "onboarding"],
        trust: "low",
        createdBy: "muon-quickstart",
      }));
    return { job, memory };
  }

  throw new Error(
    "first task is still running; open the activity log and retry onboarding"
  );
}
