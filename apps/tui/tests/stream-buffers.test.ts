import { describe, expect, it } from "vitest";
import type { StreamChunk } from "@muon/client";
import {
  appendChunks,
  bufferFor,
  EMPTY_STREAM_BUFFER,
  pruneBuffers,
  resetBuffer,
  STREAM_BUFFER_CAP,
  type StreamBuffers,
} from "../src/lib/stream-buffers.js";

// ADR-0032 D2 — switching away must not destroy what you switch back to.

function chunk(seq: number, text = `line ${seq}`): StreamChunk {
  return { seq, text } as StreamChunk;
}

describe("retention across a close/reopen", () => {
  it("keeps the buffer and resumes from its cursor", () => {
    // The old behaviour: reopening reset the cursor to 0 and REPLACED the
    // buffer, so history was refetched and anything past the window was gone.
    let buffers: StreamBuffers = {};
    buffers = appendChunks(buffers, "agent-1", [chunk(1), chunk(2)]);
    // …operator switches away and back; nothing clears the buffer…
    const resumed = bufferFor(buffers, "agent-1");
    expect(resumed.cursor).toBe(2);
    expect(resumed.chunks).toHaveLength(2);

    buffers = appendChunks(buffers, "agent-1", [chunk(3)]);
    expect(bufferFor(buffers, "agent-1").chunks.map((c) => c.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it("keeps two agents' streams independent", () => {
    let buffers: StreamBuffers = {};
    buffers = appendChunks(buffers, "agent-1", [chunk(1)]);
    buffers = appendChunks(buffers, "agent-2", [chunk(7)]);
    expect(bufferFor(buffers, "agent-1").cursor).toBe(1);
    expect(bufferFor(buffers, "agent-2").cursor).toBe(7);
    expect(bufferFor(buffers, "agent-1").chunks).toHaveLength(1);
  });

  it("reports an empty buffer for an unseen subject", () => {
    expect(bufferFor({}, "nobody")).toBe(EMPTY_STREAM_BUFFER);
  });
});

describe("append is idempotent and ordered", () => {
  it("ignores chunks at or below the cursor (an overlapping poll)", () => {
    let buffers: StreamBuffers = appendChunks({}, "a", [chunk(1), chunk(2)]);
    const before = buffers;
    buffers = appendChunks(buffers, "a", [chunk(1), chunk(2)]);
    expect(buffers).toBe(before); // no new object, nothing duplicated
    expect(bufferFor(buffers, "a").chunks).toHaveLength(2);
  });

  it("takes only the new tail from a partially-overlapping poll", () => {
    let buffers: StreamBuffers = appendChunks({}, "a", [chunk(1), chunk(2)]);
    buffers = appendChunks(buffers, "a", [chunk(2), chunk(3), chunk(4)]);
    expect(bufferFor(buffers, "a").chunks.map((c) => c.seq)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(bufferFor(buffers, "a").cursor).toBe(4);
  });

  it("never moves the cursor backwards", () => {
    let buffers: StreamBuffers = appendChunks({}, "a", [chunk(10)]);
    buffers = appendChunks(buffers, "a", [chunk(3)]);
    expect(bufferFor(buffers, "a").cursor).toBe(10);
  });
});

describe("bounds", () => {
  it("caps retention so a long-running lane cannot grow without limit", () => {
    let buffers: StreamBuffers = {};
    const many = Array.from({ length: STREAM_BUFFER_CAP + 50 }, (_, i) =>
      chunk(i + 1)
    );
    buffers = appendChunks(buffers, "a", many);
    const kept = bufferFor(buffers, "a");
    expect(kept.chunks).toHaveLength(STREAM_BUFFER_CAP);
    // The TAIL is what survives — the newest output is what the operator wants.
    expect(kept.chunks[kept.chunks.length - 1]!.seq).toBe(
      STREAM_BUFFER_CAP + 50
    );
    expect(kept.cursor).toBe(STREAM_BUFFER_CAP + 50);
  });

  it("respects an explicit smaller cap", () => {
    const buffers = appendChunks(
      {},
      "a",
      [chunk(1), chunk(2), chunk(3)],
      2
    );
    expect(bufferFor(buffers, "a").chunks.map((c) => c.seq)).toEqual([2, 3]);
  });
});

describe("lifecycle", () => {
  it("prunes buffers for subjects that no longer exist", () => {
    let buffers: StreamBuffers = appendChunks({}, "gone", [chunk(1)]);
    buffers = appendChunks(buffers, "live", [chunk(1)]);
    const pruned = pruneBuffers(buffers, ["live"]);
    expect(Object.keys(pruned)).toEqual(["live"]);
  });

  it("returns the same reference when nothing is dropped", () => {
    // Pruning runs on every fleet poll; a fresh object each time would
    // re-render the desk for no reason.
    const buffers = appendChunks({}, "live", [chunk(1)]);
    expect(pruneBuffers(buffers, ["live", "other"])).toBe(buffers);
    expect(pruneBuffers({}, [])).toEqual({});
  });

  it("resets one subject without touching the others", () => {
    let buffers: StreamBuffers = appendChunks({}, "a", [chunk(1)]);
    buffers = appendChunks(buffers, "b", [chunk(1)]);
    const reset = resetBuffer(buffers, "a");
    expect(bufferFor(reset, "a")).toBe(EMPTY_STREAM_BUFFER);
    expect(bufferFor(reset, "b").chunks).toHaveLength(1);
  });

  it("resetting an unknown subject changes nothing", () => {
    const buffers = appendChunks({}, "a", [chunk(1)]);
    expect(resetBuffer(buffers, "nope")).toBe(buffers);
  });
});

describe("a departed agent leaves nothing behind", () => {
  // cubic's finding: pruning the buffer while RETAINING `agentView` left the
  // overlay open on a lane that had left the fleet AND left the 2s stream poll
  // querying it forever — the poll keys off `agentView`, not off the fleet. The
  // operator saw a frozen stream for an agent that no longer exists and had to
  // close it by hand to stop the traffic.
  //
  // The App-side fix is one `setAgentView` guard in the same effect that
  // prunes. This pins the pure half it depends on: prune must actually drop a
  // departed subject, or the guard has nothing to key off.
  it("drops the buffer of a subject that is no longer live", () => {
    const buffers = appendChunks({}, "agent-gone", [
      { seq: 1, text: "working" },
    ]);
    expect(Object.keys(buffers)).toContain("agent-gone");
    expect(Object.keys(pruneBuffers(buffers, ["agent-live"]))).not.toContain(
      "agent-gone"
    );
  });

  it("returns the SAME object when nothing departed, so the effect can bail", () => {
    // The identity check is what stops the effect from re-rendering (and
    // re-running the view guard) on every snapshot poll.
    const buffers = appendChunks({}, "agent-live", [{ seq: 1, text: "x" }]);
    expect(pruneBuffers(buffers, ["agent-live"])).toBe(buffers);
  });
});
