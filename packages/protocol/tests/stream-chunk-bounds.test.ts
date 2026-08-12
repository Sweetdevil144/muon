import { describe, expect, it } from "vitest";
import {
  boundStreamChunkContent,
  streamTruncationMarker,
  STREAM_CHUNK_CONTENT_CHARS,
  STREAM_MESSAGE_CONTENT_CHARS,
  STREAM_TRUNCATION_MARKER_CHARS,
} from "../src/events.js";

/**
 * The founder's mission ended twice mid-word: a codex child's FINAL REPORT
 * stopped at "the latter na" and the coordinator's FINAL MISSION SUMMARY at
 * "A prefl". Both rows were exactly 4 000 characters — a silent `slice(0, N)`.
 * Bounded storage stays; SILENT bounded storage does not.
 */
describe("boundStreamChunkContent", () => {
  it("passes anything within the bound through byte-for-byte", () => {
    const report = "GOAL: ship it\n".repeat(100);
    expect(
      boundStreamChunkContent(report, STREAM_MESSAGE_CONTENT_CHARS)
    ).toEqual({ content: report, droppedChars: 0 });
  });

  it("carries a 50 KB final report whole", () => {
    const report = `${"x".repeat(50_000)}\nNEXT ACTION: land it`;
    const bounded = boundStreamChunkContent(
      report,
      STREAM_MESSAGE_CONTENT_CHARS
    );

    expect(bounded.content).toBe(report);
    expect(bounded.droppedChars).toBe(0);
  });

  it("MARKS an over-bound message instead of ending it mid-word", () => {
    const absurd = "a".repeat(5_000_000);
    const bounded = boundStreamChunkContent(
      absurd,
      STREAM_MESSAGE_CONTENT_CHARS
    );

    expect(bounded.content.length).toBeLessThanOrEqual(
      STREAM_MESSAGE_CONTENT_CHARS
    );
    expect(bounded.content).toContain("[muon:truncated]");
    // The count is exact and stated, not implied.
    expect(bounded.droppedChars).toBe(
      absurd.length - (STREAM_MESSAGE_CONTENT_CHARS - STREAM_TRUNCATION_MARKER_CHARS)
    );
    expect(bounded.content).toContain(String(bounded.droppedChars));
    expect(bounded.content).toContain("handoff_read");
    // Never a bare truncated sentence: the marker is the last thing a reader
    // sees, so nobody can mistake MUON's cut for the vendor stopping.
    expect(bounded.content.endsWith("(handoff_read).")).toBe(true);
  });

  it("keeps the tight bound tight for control-plane prose", () => {
    const bounded = boundStreamChunkContent(
      "m".repeat(10_000),
      STREAM_CHUNK_CONTENT_CHARS
    );

    expect(bounded.content.length).toBeLessThanOrEqual(
      STREAM_CHUNK_CONTENT_CHARS
    );
    expect(bounded.content).toContain("[muon:truncated]");
  });

  it("fits its own reserved room at the widest counts it can state", () => {
    // Ten-digit kept AND dropped counts: wider than any bound MUON can set.
    expect(streamTruncationMarker(9_999_999_999, 9_999_999_999).length).toBeLessThanOrEqual(
      STREAM_TRUNCATION_MARKER_CHARS
    );
  });
});
