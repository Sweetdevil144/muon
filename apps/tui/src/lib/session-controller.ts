import type {
  Lane,
  MuonApiClient,
  RecordedEvent,
  StreamChunk,
} from "@muon/client";
import {
  sessionCapability,
  vendorSupportsInteractive,
} from "@muon/client/vendors";

const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);
const DEFAULT_POLL_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function streamToLiveEvent(chunk: StreamChunk): RecordedEvent {
  return {
    id: `session-stream-${chunk.seq}`,
    laneId: chunk.laneId,
    taskId: chunk.taskId,
    kind: chunk.kind === "gate" ? "task.blocked" : "task.progress",
    message: chunk.content,
    metadata: {
      streamSeq: chunk.seq,
      streamKind: chunk.kind,
      ...(chunk.agentId ? { agentId: chunk.agentId } : {}),
    },
    timestamp: chunk.timestamp,
  };
}

export type TuiSession = {
  /** Durable dispatch coordinate used for status, steering, and interruption. */
  sessionId: string;
  laneKey: string;
  taskId: string;
  send: (message: string) => Promise<void>;
  interrupt: () => Promise<void>;
  canSend: boolean;
};

/**
 * Starts an interactive session through the persistent runner. The TUI owns no
 * vendor process or fleet reservation; it observes persisted stream chunks and
 * controls the durable dispatch job.
 */
export async function startTuiSession(input: {
  client: MuonApiClient;
  lane: Lane;
  taskId: string;
  brief: string;
  apiBase: string;
  apiToken?: string;
  pollMs?: number;
  onLiveEvent: (event: RecordedEvent) => void;
  onDone: (message: string) => void;
}): Promise<TuiSession> {
  const runner = await input.client.getRunner();
  if (!runner.live) {
    throw new Error(
      "No persistent runner is online. Start one with `muon runner`, then retry."
    );
  }
  // POSITIVE registry predicate, mirroring the CLI's WAVE D fix: the old
  // hardcoded `=== "cursor"` refusal carried prose ("readiness-only in MUON
  // v0") that stopped being true on 2026-07-25 — and let any OTHER
  // session-less lane through. The registry decides; the message says what to
  // do instead.
  if (!vendorSupportsInteractive(input.lane.key)) {
    throw new Error(
      `${input.lane.name} has no interactive session driver in MUON — dispatch it as a one-shot task instead.`
    );
  }

  const baseline = await input.client
    .listStreamChunks({
      taskId: input.taskId,
      latest: true,
      limit: 1,
    })
    .catch(() => []);
  let afterSeq = baseline.at(-1)?.seq ?? 0;

  const job = await input.client.enqueueDispatch({
    kind: "session",
    vendor: input.lane.key,
    taskId: input.taskId,
    brief: input.brief,
  });

  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  void (async () => {
    try {
      for (;;) {
        const current = await input.client.getDispatchJob(job.id);
        const chunks = await input.client
          .listStreamChunks({
            taskId: input.taskId,
            afterSeq,
            limit: 100,
          })
          .catch(() => []);
        for (const chunk of chunks) {
          input.onLiveEvent(streamToLiveEvent(chunk));
        }
        afterSeq = chunks[chunks.length - 1]?.seq ?? afterSeq;

        if (TERMINAL_STATUSES.has(current.status)) {
          const exitCode =
            current.exitCode ?? (current.status === "done" ? 0 : 1);
          input.onDone(
            current.status === "done" && exitCode === 0
              ? `session ${job.id} ended`
              : `session ${job.id} ${current.status} (exit ${exitCode})`
          );
          return;
        }
        await delay(pollMs);
      }
    } catch (error) {
      input.onDone(
        `session error: ${error instanceof Error ? error.message : error}`
      );
    }
  })();

  return {
    sessionId: job.id,
    laneKey: input.lane.key,
    taskId: input.taskId,
    send: (message) => input.client.steerDispatchJob(job.id, message),
    interrupt: () => input.client.interruptDispatchJob(job.id),
    // A SEVENTH spelling of a capability the registry already states
    // (ADR-0022 §1.2(d)). Read it, do not name the one vendor that has it.
    canSend: sessionCapability(input.lane.key).canSend,
  };
}
