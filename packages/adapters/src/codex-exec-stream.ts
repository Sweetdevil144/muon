import type { LaneEvent } from "@muon/protocol";
import {
  codexActivityFromItem,
  codexItemMetadata,
} from "./codex-session-driver.js";

/**
 * The one-shot Codex lane's ACTIVITY, recovered from the vendor's own machine
 * stream.
 *
 * WHY THIS EXISTS (measured live, codex 0.145.0). `codex exec` writes its
 * entire activity console — every `exec`, every tool call, every commentary
 * message — to STDERR, and puts ONLY the final agent message on STDOUT. MUON's
 * pipes transport routes stdout to `onEvent` (which becomes the durable stream
 * a human watches) and stderr to `onDiagnostic` (a watchdog sink that reaches
 * no surface). So a loop-dispatched codex child's feed contained its closing
 * sentence and nothing else: the founder's mission recorded 1 activity chunk
 * and 2 output chunks for a four-minute repair loop whose comparable
 * claude-code child recorded 90, while the child demonstrably called
 * `preflight_edit`, `claim_files`, `peer_inbox` and `peer_message` throughout.
 *
 * `--json` moves the vendor's own EVENT stream onto stdout (`thread.started`,
 * `item.started`, `item.completed`, `turn.completed`), which is a machine
 * contract rather than a rendering — the same reason this lane already reads
 * the final report from `--output-last-message` instead of scraping the
 * console. This translates that stream into the SAME lane events the
 * interactive Codex driver emits, through the SAME extractor
 * (`codexActivityFromItem`), so a one-shot Codex tool card is built by the path
 * that already exists rather than by a second mechanism that can drift.
 *
 * The Codex no-payload invariant is unchanged: the activity LINE stays bounded
 * coordinates, the untrusted payload rides `toolActivity.detail` only, bounded
 * at this emission site and redacted by @muon/core on the way into the ledger.
 */

/** Flags that turn `codex exec` into its machine-event transport. */
export const CODEX_EXEC_JSON_ARGS: readonly string[] = ["--json"];

/**
 * Hard cap on ONE unterminated JSONL line. A vendor (or a prompt-injected
 * agent's tool output echoed back through an item) can emit megabytes on one
 * line; the parse buffer must not grow with it. An over-long line is dropped up
 * to its terminator rather than parsed from the middle, which would only
 * produce a confidently wrong item.
 */
const CODEX_EXEC_MAX_LINE_CHARS = 1_000_000;

let eventSeq = 0;

function makeExecEvent(
  laneId: string,
  taskId: string,
  kind: LaneEvent["kind"],
  message: string,
  metadata: Record<string, unknown> = {}
): LaneEvent {
  eventSeq += 1;
  return {
    id: `codex-exec-${Date.now()}-${eventSeq}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    laneId,
    taskId,
    kind,
    message,
    timestamp: new Date().toISOString(),
    metadata,
  };
}

export type CodexExecStream = {
  /** Feed raw stdout bytes, in arrival order. Chunk boundaries are arbitrary. */
  admit: (chunk: string) => void;
  /** The last whole agent message seen, i.e. what the run actually answered. */
  finalMessage: () => string;
  /** True once any JSONL line parsed — "did the vendor really speak this?" */
  sawEvents: () => boolean;
};

export function createCodexExecStream(input: {
  laneId: string;
  taskId: string;
  onEvent: (event: LaneEvent) => void;
  /** Fired once with the vendor's own thread id — the resume/backlink handle. */
  onVendorSessionId?: (vendorSessionId: string) => void;
  /**
   * One compact, already-terminated line per translated item, for the live
   * TERMINAL pane.
   *
   * Under `--json` the vendor prints no console of its own, so forwarding its
   * stdout verbatim would put raw JSONL where a human is watching. This is
   * MUON's OWN rendering and is labelled as such by being deliberately unlike
   * codex's console — the pane keeps showing what the child is doing, and
   * nobody can mistake it for the vendor's words.
   */
  onConsole?: (line: string) => void;
}): CodexExecStream {
  let pending = "";
  /** The current line is past the cap: swallow it up to its terminator. */
  let overflowing = false;
  let finalMessage = "";
  let sawEvents = false;
  let sessionReported = false;

  const emit = (
    kind: LaneEvent["kind"],
    message: string,
    metadata: Record<string, unknown> = {}
  ): void => {
    if (!message.trim()) return;
    input.onEvent(
      makeExecEvent(input.laneId, input.taskId, kind, message, metadata)
    );
  };

  /** Never let a throwing viewer cost the run its vendor stream. */
  const console_ = (line: string): void => {
    try {
      input.onConsole?.(`${line}\r\n`);
    } catch {
      // ignored on purpose
    }
  };

  const handleItem = (
    phase: "started" | "completed",
    item: unknown
  ): void => {
    // An agent message is the assistant's WORDS, not activity: it must reach
    // the stream as output, on the same `outputMode: "message"` boundary the
    // interactive driver marks whole messages with, or the run's own report
    // would be recorded as a control-plane line.
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "agent_message"
    ) {
      if (phase !== "completed") return;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== "string" || !text.trim()) return;
      finalMessage = text;
      emit("task.progress", text, { outputMode: "message" });
      console_(text);
      return;
    }
    const activity = codexActivityFromItem(item);
    if (!activity) return;
    const state =
      phase === "started" ? "started" : (activity.status ?? "completed");
    emit(
      phase === "completed" && activity.status === "failed"
        ? "task.blocked"
        : "task.progress",
      `${activity.label} ${state}`,
      { controlPlane: true, ...codexItemMetadata(phase, activity) }
    );
    // Coordinates only, exactly as the activity LINE carries — the bounded
    // payload stays on `toolActivity.detail` and never reaches the terminal.
    console_(`[muon] ${activity.label} ${state}`);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not the vendor's machine stream — a banner line, a warning, anything.
      // Ignored rather than guessed at.
      return;
    }
    sawEvents = true;
    const type = message.type;
    if (type === "thread.started") {
      const threadId = message.thread_id ?? message.threadId;
      if (!sessionReported && typeof threadId === "string" && threadId) {
        sessionReported = true;
        input.onVendorSessionId?.(threadId);
      }
      return;
    }
    if (type === "item.started") {
      handleItem("started", message.item);
      return;
    }
    if (type === "item.completed") {
      handleItem("completed", message.item);
      return;
    }
    if (type === "error") {
      // The vendor's own turn-level failure. Bounded through the same event
      // path; the fatal-startup class still arrives on stderr as before.
      const detail = message.message;
      emit(
        "task.blocked",
        `Codex reported an error: ${
          typeof detail === "string" ? detail.slice(0, 500) : "no detail"
        }`,
        { controlPlane: true, reason: "codex-exec-error" }
      );
    }
  };

  return {
    admit: (chunk) => {
      if (!chunk) return;
      pending += chunk;
      for (;;) {
        const boundary = pending.indexOf("\n");
        if (boundary < 0) {
          if (pending.length > CODEX_EXEC_MAX_LINE_CHARS) {
            overflowing = true;
            pending = "";
          }
          return;
        }
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (overflowing) {
          overflowing = false;
          continue;
        }
        handleLine(line);
      }
    },
    finalMessage: () => finalMessage,
    sawEvents: () => sawEvents,
  };
}
