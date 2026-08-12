import {
  boundStreamChunkContent,
  classifyContextWindowChunkFromLaneEvent,
  STREAM_BATCH_CONTENT_CHARS,
  STREAM_CHUNK_CONTENT_CHARS,
  STREAM_MESSAGE_CONTENT_CHARS,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type ContextWindowChunkKind,
  type LaneEvent,
  type ToolActivityDetail,
} from "@muon/protocol";
import { redactedTail } from "./build-handoff-packet.js";

/**
 * Publishes the FULL agent output stream to the brain so any surface can
 * watch an agent work live. Unlike the event recorder (which coalesces
 * progress into calm ledger milestones), this preserves every chunk,
 * batched so a chatty agent costs one request per flush window, not one
 * per token.
 */

export type StreamChunkRecord = {
  taskId: string;
  laneId: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  kind: ContextWindowChunkKind;
  content: string;
  timestamp: string;
  /**
   * Bounded, REDACTED tool-call detail (args + result tail) for the surface
   * that renders this chunk as a tool card. Present only when the adapter
   * captured something; every chunk without it renders exactly as before.
   */
  detail?: ToolActivityDetail;
};

export type StreamSink = {
  recordStreamChunks: (
    chunks: StreamChunkRecord[]
  ) => Promise<{ recorded: number }>;
};

export type StreamRecorderOptions = {
  sink: StreamSink;
  /** Attached to every chunk: which agent/session/run this stream belongs to. */
  agentId?: string;
  sessionId?: string;
  runId?: string;
  flushIntervalMs?: number;
  maxBuffered?: number;
};

export type StreamRecorder = {
  handle: (event: LaneEvent) => void;
  /** Flush remaining chunks; call once after the run ends. */
  flush: () => Promise<void>;
};

const FLUSH_INTERVAL_DEFAULT_MS = 750;
const MAX_BUFFERED_DEFAULT = 40;

/**
 * THE redaction boundary for captured tool detail.
 *
 * Adapters bound the value at its emission site but cannot redact it there:
 * `redactedTail` lives in core, and core depends on adapters, so importing it
 * the other way would be a cycle. This is the single point where a driver's
 * bounded detail becomes durable, so it is the point that scrubs it — through
 * the same control the stall-reason and handoff-packet paths use, never a
 * second redactor.
 *
 * `redactedTail` is called at the SAME bound the adapter already applied, so a
 * well-behaved value passes through unchanged; a value that arrived oversized
 * (a hostile or out-of-date driver) is cut here as well as scrubbed.
 */
export function redactToolDetail(value: unknown): ToolActivityDetail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const args =
    typeof raw.args === "string" && raw.args.length > 0
      ? redactedTail(raw.args, TOOL_ACTIVITY_ARGS_CHARS)
      : undefined;
  const result =
    typeof raw.result === "string" && raw.result.length > 0
      ? redactedTail(raw.result, TOOL_ACTIVITY_RESULT_CHARS)
      : undefined;
  if (!args && !result) return undefined;
  return {
    ...(args ? { args, argsTruncated: raw.argsTruncated === true } : {}),
    ...(result
      ? { result, resultTruncated: raw.resultTruncated === true }
      : {}),
  };
}

/** The bounded/redacted detail an activity event carries, if any. */
function detailFromEvent(event: LaneEvent): ToolActivityDetail | undefined {
  const activity = event.metadata.toolActivity;
  if (!activity || typeof activity !== "object") return undefined;
  return redactToolDetail((activity as Record<string, unknown>).detail);
}

export function createStreamRecorder(
  options: StreamRecorderOptions
): StreamRecorder {
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_DEFAULT_MS;
  const maxBuffered = options.maxBuffered ?? MAX_BUFFERED_DEFAULT;

  let buffer: StreamChunkRecord[] = [];
  /** Content characters currently buffered, for the batch-size bound. */
  let bufferedChars = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const send = () => {
    if (buffer.length === 0) {
      return;
    }
    const batch = buffer;
    buffer = [];
    bufferedChars = 0;
    // Best-effort chain: a stream gap must never fail the run itself.
    inFlight = inFlight
      .then(() => options.sink.recordStreamChunks(batch))
      .then(
        () => undefined,
        () => undefined
      );
  };

  const scheduleFlush = () => {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      send();
    }, flushIntervalMs);
    // Never keep the process alive just to flush telemetry.
    timer.unref?.();
  };

  return {
    handle: (event) => {
      if (!event.message.trim()) {
        return;
      }
      const kind = classifyContextWindowChunkFromLaneEvent(event);
      const isAssistantOutput = kind === "output" || kind === "output.message";
      // Bound by CLASS, and visibly. Assistant output gets the report-sized
      // bound: a final report arrives as ONE event, and both vendors that ran
      // the founder's mission delivered theirs whole — codex as `output`,
      // claude-code as `output.message` — so the bound has to cover both, not
      // just the typed-boundary one. Control-plane prose is MUON's own and
      // stays tight.
      const isAssistantClass =
        kind === "output" || kind === "output.message";
      // Bound what is actually STORED, prefix included, so the bound a reader is
      // told about is the bound the row obeys.
      const { content } = boundStreamChunkContent(
        isAssistantClass || kind === "activity"
          ? event.message
          : `[${event.kind}] ${event.message}`,
        isAssistantClass
          ? STREAM_MESSAGE_CONTENT_CHARS
          : STREAM_CHUNK_CONTENT_CHARS
      );
      const detail = detailFromEvent(event);
      buffer.push({
        taskId: event.taskId,
        laneId: event.laneId,
        agentId: options.agentId,
        sessionId: options.sessionId,
        runId: options.runId,
        kind,
        content,
        timestamp: event.timestamp,
        ...(detail ? { detail } : {}),
      });
      bufferedChars += content.length;
      // Bounded by COUNT and by SIZE. Without the size bound a run that emits
      // several whole 64 K messages inside one flush window would build a body
      // the write route rejects outright — and `send` swallows that failure, so
      // the loss would be silent, which is the exact defect being fixed here.
      if (
        buffer.length >= maxBuffered ||
        bufferedChars >= STREAM_BATCH_CONTENT_CHARS
      ) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        send();
        return;
      }
      scheduleFlush();
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      send();
      await inFlight;
    },
  };
}
