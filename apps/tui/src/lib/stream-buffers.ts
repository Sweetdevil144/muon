// ADR-0032 D2 — retained per-subject stream state.
//
// The defect this closes: the agent-stream view reset its cursor to 0 and
// REPLACED its buffer on every open, so closing a stream and reopening it
// refetched from the beginning and dropped everything past the last 200 chunks.
// Switching between two agents lost both. "Switching is an index change" is
// only true if the thing being switched away from survives.
//
// Buffers are keyed by subject (agent id) rather than by tab so the retention
// is correct whether the stream is reached from a tab, an overlay, or the rail
// — the cursor belongs to the STREAM, not to the surface showing it.

import type { StreamChunk } from "@muon/client";

export type StreamBuffer = {
  readonly chunks: readonly StreamChunk[];
  /** Highest `seq` observed; the resume point for the next poll. */
  readonly cursor: number;
};

export type StreamBuffers = Readonly<Record<string, StreamBuffer>>;

export const EMPTY_STREAM_BUFFER: StreamBuffer = { chunks: [], cursor: 0 };

/** Retained chunks per subject. Bounded — a long-running lane is unbounded. */
export const STREAM_BUFFER_CAP = 400;

export function bufferFor(
  buffers: StreamBuffers,
  subject: string
): StreamBuffer {
  return buffers[subject] ?? EMPTY_STREAM_BUFFER;
}

/**
 * Append newly polled chunks.
 *
 * Chunks at or below the retained cursor are dropped rather than appended: an
 * overlapping poll (or a resumed view that re-asked from a stale point) must
 * not duplicate or reorder what is already on screen. The cursor only ever
 * advances.
 */
export function appendChunks(
  buffers: StreamBuffers,
  subject: string,
  incoming: readonly StreamChunk[],
  cap: number = STREAM_BUFFER_CAP
): StreamBuffers {
  const existing = bufferFor(buffers, subject);
  const fresh = incoming.filter((chunk) => chunk.seq > existing.cursor);
  if (fresh.length === 0) return buffers;

  const chunks = [...existing.chunks, ...fresh].slice(-cap);
  const cursor = Math.max(
    existing.cursor,
    ...fresh.map((chunk) => chunk.seq)
  );
  return { ...buffers, [subject]: { chunks, cursor } };
}

/**
 * Drop buffers for subjects that no longer exist, so a long session does not
 * retain the scrollback of every lane it ever watched.
 */
export function pruneBuffers(
  buffers: StreamBuffers,
  liveSubjects: readonly string[]
): StreamBuffers {
  const live = new Set(liveSubjects);
  const entries = Object.entries(buffers);
  const kept = entries.filter(([subject]) => live.has(subject));
  // Same reference when nothing was dropped, so a caller can use identity to
  // skip a state update — this runs on every fleet poll, and returning a fresh
  // object every time would re-render the desk for no reason.
  if (kept.length === entries.length) return buffers;
  return Object.fromEntries(kept);
}

/**
 * Forget one subject's buffer — the explicit "start this stream over" action,
 * distinct from switching away (which retains).
 */
export function resetBuffer(
  buffers: StreamBuffers,
  subject: string
): StreamBuffers {
  if (!(subject in buffers)) return buffers;
  const { [subject]: _dropped, ...rest } = buffers;
  return rest;
}
