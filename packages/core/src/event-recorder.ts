import type { LaneEventKind } from "@muon/protocol";

type StreamedEvent = {
  laneId: string;
  taskId: string;
  kind: LaneEventKind;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
};

type RecordFn = (event: {
  laneId: string;
  taskId: string;
  kind: LaneEventKind;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}) => Promise<unknown>;

export type EventRecorderSummary = {
  recorded: number;
  failures: number;
};

const DEFAULT_TAIL_CHARS = 2000;

/**
 * Persists lane events without flooding the backend: milestone events
 * (started/completed/blocked/...) are recorded one-to-one, while streamed
 * task.progress chunks are coalesced into a single record that is flushed
 * before the next milestone, preserving ledger order.
 */
export function createEventRecorder(input: {
  record: RecordFn;
  tailChars?: number;
}) {
  const tailChars = input.tailChars ?? DEFAULT_TAIL_CHARS;

  let chain: Promise<void> = Promise.resolve();
  let recorded = 0;
  let failures = 0;

  let pendingProgress:
    | { base: StreamedEvent; text: string; chunks: number }
    | undefined;

  const post = (event: Parameters<RecordFn>[0]) => {
    chain = chain.then(() =>
      input
        .record(event)
        .then(() => {
          recorded += 1;
        })
        .catch(() => {
          failures += 1;
        })
    );
  };

  const flushProgress = () => {
    if (!pendingProgress) {
      return;
    }
    const { base, text, chunks } = pendingProgress;
    pendingProgress = undefined;
    const tail =
      text.length > tailChars ? `…${text.slice(-tailChars)}` : text;
    post({
      laneId: base.laneId,
      taskId: base.taskId,
      kind: "task.progress",
      message: tail,
      metadata: { chunks },
      timestamp: base.timestamp,
    });
  };

  return {
    handle(event: StreamedEvent) {
      if (event.kind === "task.progress") {
        if (pendingProgress) {
          pendingProgress = {
            base: event,
            text: `${pendingProgress.text}\n${event.message}`,
            chunks: pendingProgress.chunks + 1,
          };
        } else {
          pendingProgress = { base: event, text: event.message, chunks: 1 };
        }
        return;
      }

      flushProgress();
      post({
        laneId: event.laneId,
        taskId: event.taskId,
        kind: event.kind,
        message: event.message,
        metadata: event.metadata,
        timestamp: event.timestamp,
      });
    },

    async flush(): Promise<EventRecorderSummary> {
      flushProgress();
      await chain;
      return { recorded, failures };
    },
  };
}
