import { z } from "zod";

export const laneEventKindSchema = z.enum([
  "task.started",
  "task.progress",
  "task.blocked",
  "task.completed",
  "approval.requested",
  // P0.4: a policy- or receipt-sourced auto-allow. Every non-human allow is
  // VISIBLE on the event spine (metadata carries source, action class, digest).
  "approval.auto",
  "handoff.created",
  "workflow.proposed",
  "workflow.applied",
  "workflow.step.started",
  "workflow.step.completed",
  "loop.iteration",
  "loop.escalated",
  "loop.stopped",
  "lane.profile.updated",
  "harness.updated",
  "workflow.template.updated",
  "fleet.updated",
]);
export type LaneEventKind = z.infer<typeof laneEventKindSchema>;

export const laneEventSchema = z.object({
  id: z.string().min(1),
  laneId: z.string().min(1),
  taskId: z.string().min(1),
  kind: laneEventKindSchema,
  message: z.string().min(1),
  timestamp: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type LaneEvent = z.infer<typeof laneEventSchema>;

// ── Event taxonomy (TODO 5.6) ────────────────────────────────────────────────
//
// Two durable surfaces answer different post-incident questions:
//
//   • CONTEXT WINDOW — StreamChunk rows: what the operator (and often the model)
//     saw in the live transcript. Kinds label *content*, not lifecycle.
//   • SYSTEM RECORDED — Event rows: coalesced milestones the brain persisted for
//     governance and replay. Kinds label *what happened*, not prose shape.
//
// The types MUST NOT be interchangeable: a StreamChunk kind is never a LaneEvent
// kind and vice versa. `classifyContextWindowChunkFromLaneEvent` is the single
// mapping from a streamed LaneEvent into the context-window taxonomy.

/** Kinds stored on StreamChunk — visible transcript content. */
export const contextWindowChunkKindSchema = z.enum([
  "output",
  "output.message",
  "user.message",
  "activity",
  "reasoning",
  "milestone",
  "gate",
]);
export type ContextWindowChunkKind = z.infer<
  typeof contextWindowChunkKindSchema
>;

/** Alias: Event-table kinds are system-recorded lifecycle milestones. */
export const systemRecordedEventKindSchema = laneEventKindSchema;
export type SystemRecordedEventKind = LaneEventKind;

export function isContextWindowChunkKind(
  kind: string
): kind is ContextWindowChunkKind {
  return contextWindowChunkKindSchema.safeParse(kind).success;
}

export function isSystemRecordedEventKind(
  kind: string
): kind is SystemRecordedEventKind {
  return systemRecordedEventKindSchema.safeParse(kind).success;
}

/** Map one streamed LaneEvent into the context-window chunk kind it becomes. */
export function classifyContextWindowChunkFromLaneEvent(
  event: Pick<LaneEvent, "kind" | "metadata">
): ContextWindowChunkKind {
  const isAssistantOutput =
    event.kind === "task.progress" && event.metadata.controlPlane !== true;
  if (event.metadata.controlPlane === true) {
    return "activity";
  }
  if (isAssistantOutput && event.metadata.outputMode === "message") {
    return "output.message";
  }
  if (isAssistantOutput) {
    return "output";
  }
  return "milestone";
}

/**
 * Hard character bounds for the tool-call detail MUON captures. Applied at the
 * SOURCE (in each adapter, before the vendor value is ever held in full), again
 * when the detail is redacted into a stream chunk, and once more at the write
 * route — a tool that emits 100 MB must not reach memory, the DB, the IPC
 * payload, or the DOM at any of those hops.
 *
 * Args are HEAD-kept (the command is the identity of the call); results are
 * TAIL-kept, because the end of an output is where the error lives.
 */
export const TOOL_ACTIVITY_ARGS_CHARS = 2_048;
export const TOOL_ACTIVITY_RESULT_CHARS = 8_192;
/** A single observed file coordinate carried beside tool activity metadata. */
export const TOOL_ACTIVITY_PATH_CHARS = 4_096;
/** One tool call may touch several files, but its coordinate set stays bounded. */
export const TOOL_ACTIVITY_PATHS_MAX = 32;

/**
 * Bound vendor-reported file coordinates before they ride a lane event.
 *
 * These remain DATA, not authority: the runner later resolves them inside the
 * governed worktree and intersects them with the git-observed changed-file set
 * before they may anchor a memory candidate. Keeping the raw coordinate here is
 * still useful because that later proof cannot recover which tool call touched
 * which file from final prose.
 */
export function boundToolActivityPaths(values: unknown): string[] {
  const candidates = Array.isArray(values) ? values : [values];
  const paths = new Set<string>();
  for (const value of candidates) {
    if (paths.size >= TOOL_ACTIVITY_PATHS_MAX) break;
    if (typeof value !== "string") continue;
    const clean = value
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, TOOL_ACTIVITY_PATH_CHARS);
    if (clean) paths.add(clean);
  }
  return [...paths];
}

/**
 * Hard character bounds for ONE durable stream chunk — the row every operator
 * surface reads an agent's words out of.
 *
 * Two bounds, because two classes of text ride this table:
 *
 *   • ASSISTANT OUTPUT (`output` / `output.message`) is the thing a human
 *     waited the whole mission for. A worker's FINAL REPORT and a coordinator's
 *     FINAL MISSION SUMMARY arrive here as ONE event, and a real report with a
 *     JSON shape block runs well past 20 KB. This bound is deliberately set to
 *     the same 64 K window `parseWorkerFinalReport` reads, so anything MUON can
 *     still parse as a report is also a thing MUON durably stored.
 *   • CONTROL-PLANE text (`activity` / `milestone`) is MUON's own coalesced
 *     prose, never a report, and stays on the tight bound.
 *
 * Bounded storage is not negotiable — a runaway vendor can emit megabytes into
 * a local-first brain — but a bound that BITES must SAY SO. It used to cut at
 * 4 000 characters mid-word, silently, and the founder's mission ended with a
 * report that stopped at "the latter na" and a summary that stopped at
 * "A prefl". See `boundStreamChunkContent`.
 */
export const STREAM_CHUNK_CONTENT_CHARS = 4_000;
export const STREAM_MESSAGE_CONTENT_CHARS = 64_000;

/**
 * Room reserved inside the bound for the truncation marker itself, so a bounded
 * chunk is never longer than the bound it was given. `streamTruncationMarker`
 * is asserted to fit this at its widest (ten-digit counts).
 */
export const STREAM_TRUNCATION_MARKER_CHARS = 200;

/**
 * How many characters of chunk content one POST /api/streams batch may carry.
 * The recorder flushes as soon as a batch crosses this, so a run that emits
 * several whole 64 K messages back to back sends several requests instead of
 * ONE oversized body that the route's `bodyLimit` would reject whole — and the
 * recorder swallows write failures by design, so a rejected batch is a silent
 * hole in the stream.
 */
export const STREAM_BATCH_CONTENT_CHARS = 128_000;

/** The exact words a truncated stream chunk ends with. */
export function streamTruncationMarker(kept: number, dropped: number): string {
  return (
    `\n\n[muon:truncated] MUON durably stored the first ${kept} characters ` +
    `of this message and dropped ${dropped}. The parsed final report rides ` +
    `this task's typed handoff packet (handoff_read).`
  );
}

/**
 * Bound one stream chunk's content to `maxChars`, VISIBLY.
 *
 * Head-kept (a report's opening states what it did) and, when the bound bites,
 * closed with `streamTruncationMarker` naming exactly how many characters were
 * dropped and where the typed record lives. The returned content is never
 * longer than `maxChars`, so the write route can bound the same number without
 * a second, larger allowance.
 *
 * The silent `slice(0, N)` this replaces is the whole defect: a reader cannot
 * tell a vendor that stopped mid-sentence from a vendor MUON cut mid-sentence,
 * and a governance product must not make a human guess which one happened.
 */
export function boundStreamChunkContent(
  text: string,
  maxChars: number
): { content: string; droppedChars: number } {
  if (text.length <= maxChars) {
    return { content: text, droppedChars: 0 };
  }
  const kept = Math.max(0, maxChars - STREAM_TRUNCATION_MARKER_CHARS);
  const dropped = text.length - kept;
  return {
    content: `${text.slice(0, kept)}${streamTruncationMarker(kept, dropped)}`,
    droppedChars: dropped,
  };
}

/**
 * Bounded, redacted summary of what ONE tool call did: the arguments it was
 * invoked with, and the tail of what it returned.
 *
 * This is a DELIBERATE relaxation of MUON's coordinates-only activity posture
 * (which existed so untrusted vendor payload never entered the ledger). It is
 * admitted with the controls that make it safe: bounded at every hop, passed
 * through `redactedTail` (@muon/core's single redaction control) before it is
 * ever persisted, and rendered as untrusted data behind a human expand — never
 * as MUON's own copy, never as instructions.
 *
 * Every field is optional and the whole object is optional, so a driver that
 * captures nothing, and every chunk written before this shape existed, keeps
 * rendering exactly as it does today.
 */
export const toolActivityDetailSchema = z.object({
  args: z.string().max(TOOL_ACTIVITY_ARGS_CHARS + 1).optional(),
  /** The args were clipped, so no surface can imply it holds the whole call. */
  argsTruncated: z.boolean().optional(),
  result: z.string().max(TOOL_ACTIVITY_RESULT_CHARS + 1).optional(),
  /** The result was clipped (leading text dropped, tail kept). */
  resultTruncated: z.boolean().optional(),
});

export type ToolActivityDetail = z.infer<typeof toolActivityDetailSchema>;

/** Keep newlines and tabs (the panel renders them); drop the rest of C0/C1. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Flatten an arbitrary vendor value into a preview string WITHOUT building a
 * full serialization of it first. A tool argument object can nest a megabyte of
 * file content; `JSON.stringify` would materialize all of it just to throw it
 * away. This walks with a running budget and stops the moment it is spent.
 */
function previewValue(value: unknown, budget: number): string {
  if (budget <= 0) return "";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, budget);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, budget);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let left = budget;
    for (const entry of value) {
      if (left <= 0) break;
      const part = previewValue(entry, left);
      parts.push(part);
      left -= part.length + 1;
    }
    return parts.join(" ").slice(0, budget);
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    let left = budget;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (left <= 0) break;
      const part = `${key}: ${previewValue(entry, Math.max(0, left - key.length - 2))}`;
      parts.push(part);
      left -= part.length + 1;
    }
    return parts.join("\n").slice(0, budget);
  }
  return "";
}

/**
 * Bound one vendor-supplied tool value to `maxChars` of plain text.
 *
 * Called at the emission site so nothing larger than the bound is ever RETAINED
 * on a MUON event (the vendor SDK already holds its own copy; MUON's copy is
 * the one this caps). Truncation is visible twice over: the returned text
 * carries an ellipsis at the clipped edge, and `truncated` is reported so a
 * surface can say so in words instead of implying completeness.
 *
 * `keep: "tail"` is for results — the end of an output is where the error is.
 *
 * This bounds; it does NOT redact. Redaction is `redactedTail` in @muon/core,
 * applied on the way into the ledger (adapters cannot import core — core
 * depends on adapters — so the single redactor lives at that boundary).
 */
export function boundToolActivityText(
  value: unknown,
  maxChars: number,
  keep: "head" | "tail" = "head"
): { text: string; truncated: boolean } | undefined {
  // Budget the walk generously above the bound so a value that is mostly
  // structure still yields `maxChars` of readable content. A plain string is
  // clipped from the RETAINED edge first, so `keep: "tail"` on a 100 MB stdout
  // keeps the actual end of the output rather than the tail of its head.
  const budget = maxChars * 2 + 64;
  const isString = typeof value === "string";
  const source = isString
    ? keep === "tail"
      ? value.slice(-budget)
      : value.slice(0, budget)
    : previewValue(value, budget);
  // A value already clipped by the budget walk is truncated even if what
  // survived the control-char strip happens to fit — never claim completeness.
  const clippedAtSource = isString
    ? value.length > source.length
    : source.length >= budget;
  const raw = source.replace(CONTROL_CHARS, " ").trim();
  if (!raw) return undefined;
  if (raw.length <= maxChars) {
    return { text: raw, truncated: clippedAtSource };
  }
  return {
    text:
      keep === "tail"
        ? `…${raw.slice(-(maxChars - 1))}`
        : `${raw.slice(0, maxChars - 1)}…`,
    truncated: true,
  };
}
