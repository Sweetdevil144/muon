import { describe, expect, it, vi } from "vitest";
import {
  STREAM_CHUNK_CONTENT_CHARS,
  STREAM_MESSAGE_CONTENT_CHARS,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type LaneEvent,
} from "@muon/protocol";
import {
  createStreamRecorder,
  type StreamChunkRecord,
} from "../src/stream-recorder.js";

const event = (
  message: string,
  metadata: LaneEvent["metadata"]
): LaneEvent => ({
  id: "event-1",
  laneId: "codex",
  taskId: "task-1",
  kind: "task.progress",
  message,
  timestamp: "2026-07-24T00:00:00.000Z",
  metadata,
});

describe("createStreamRecorder", () => {
  it("keeps control-plane progress out of assistant prose", async () => {
    const recorded: StreamChunkRecord[] = [];
    const sink = {
      recordStreamChunks: vi.fn(async (chunks: StreamChunkRecord[]) => {
        recorded.push(...chunks);
        return { recorded: chunks.length };
      }),
    };
    const recorder = createStreamRecorder({ sink });

    recorder.handle(
      event("Codex capability preflight completed", {
        controlPlane: true,
      })
    );
    recorder.handle(event("I am now planning the fix.", {}));
    await recorder.flush();

    expect(recorded).toEqual([
      expect.objectContaining({
        kind: "activity",
        content: "Codex capability preflight completed",
      }),
      expect.objectContaining({
        kind: "output",
        content: "I am now planning the fix.",
      }),
    ]);
  });

  it("keeps whole assistant messages distinct from token deltas", async () => {
    const recorded: StreamChunkRecord[] = [];
    const recorder = createStreamRecorder({
      sink: {
        recordStreamChunks: vi.fn(async (chunks: StreamChunkRecord[]) => {
          recorded.push(...chunks);
          return { recorded: chunks.length };
        }),
      },
    });

    recorder.handle(event("whole message", { outputMode: "message" }));
    recorder.handle(event(" delta", {}));
    await recorder.flush();

    expect(recorded.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "output.message", content: "whole message" },
      { kind: "output", content: " delta" },
    ]);
  });
});

/**
 * THE FOUNDER'S MISSION ENDED MID-WORD, TWICE.
 *
 * The coordinator's FINAL MISSION SUMMARY (5 431 characters — the part it lost
 * was the done/unverified verdict list and the "needs your go-ahead" ask) was
 * stored as exactly 4 000 characters ending "A prefl". The codex child's FINAL
 * REPORT (also stored at exactly 4 000) ended "the latter na". Nineteen rows in
 * that brain are exactly 4 000 characters long; the maximum over all 2 218 is
 * 4 000. A silent `slice(0, 4000)` did it, and no surface said so.
 *
 * The bound stays — a runaway vendor can emit megabytes into a local-first
 * brain — but it is now sized for a real report and it SPEAKS when it bites.
 */
describe("createStreamRecorder bounds assistant output visibly", () => {
  const recordOne = async (message: string, metadata: LaneEvent["metadata"]) => {
    const recorded: StreamChunkRecord[] = [];
    const recorder = createStreamRecorder({
      sink: {
        recordStreamChunks: vi.fn(async (chunks: StreamChunkRecord[]) => {
          recorded.push(...chunks);
          return { recorded: chunks.length };
        }),
      },
    });
    recorder.handle(event(message, metadata));
    await recorder.flush();
    return recorded[0]!;
  };

  it("round-trips a 50 KB final report INTACT, as a whole message", async () => {
    const report = `${"x".repeat(50_000)}\n\nNEXT ACTION: land the change`;

    const chunk = await recordOne(report, { outputMode: "message" });

    expect(chunk.kind).toBe("output.message");
    expect(chunk.content).toBe(report);
    expect(chunk.content).not.toContain("[muon:truncated]");
  });

  it("round-trips a 50 KB final report INTACT on the untyped `output` path too", async () => {
    // The codex child's report arrived as kind `output`, not `output.message`:
    // it is the vendor, not the label, that decides — so both carry the
    // report-sized bound or the fix misses the exact job that was cut.
    const report = `${"y".repeat(50_000)}\n\nMEMORY PROPOSALS: none`;

    const chunk = await recordOne(report, {});

    expect(chunk.kind).toBe("output");
    expect(chunk.content).toBe(report);
  });

  it("MARKS an absurd message instead of silently shortening it", async () => {
    const absurd = `${"z".repeat(400_000)}TRAILING`;

    const chunk = await recordOne(absurd, { outputMode: "message" });

    expect(chunk.content.length).toBeLessThanOrEqual(
      STREAM_MESSAGE_CONTENT_CHARS
    );
    // The three things a reader needs: that it was cut, by how much, and where
    // the full record lives.
    expect(chunk.content).toContain("[muon:truncated]");
    expect(chunk.content).toContain(
      String(absurd.length - (STREAM_MESSAGE_CONTENT_CHARS - 200))
    );
    expect(chunk.content).toContain("handoff_read");
    // What it must NOT look like: a vendor that simply stopped talking.
    expect(chunk.content.endsWith("z")).toBe(false);
  });

  it("keeps control-plane prose on the tight bound, and marks that too", async () => {
    const chunk = await recordOne("m".repeat(20_000), { controlPlane: true });

    expect(chunk.kind).toBe("activity");
    expect(chunk.content.length).toBeLessThanOrEqual(STREAM_CHUNK_CONTENT_CHARS);
    expect(chunk.content).toContain("[muon:truncated]");
  });

  it("splits a run of whole messages across batches so no body is rejected whole", async () => {
    const batches: number[] = [];
    const recorder = createStreamRecorder({
      sink: {
        recordStreamChunks: vi.fn(async (chunks: StreamChunkRecord[]) => {
          batches.push(
            chunks.reduce((total, chunk) => total + chunk.content.length, 0)
          );
          return { recorded: chunks.length };
        }),
      },
    });

    // Six whole 60 K messages inside one flush window. Under a count-only bound
    // these would have formed ONE ~360 K body; `send` swallows write failures,
    // so a route rejection would be an invisible hole in the stream.
    for (let index = 0; index < 6; index += 1) {
      recorder.handle(event("q".repeat(60_000), { outputMode: "message" }));
    }
    await recorder.flush();

    expect(batches.length).toBeGreaterThan(1);
    for (const size of batches) {
      expect(size).toBeLessThan(200_000);
    }
  });
});

describe("createStreamRecorder tool detail", () => {
  const record = async (metadata: LaneEvent["metadata"], message = "Bash completed") => {
    const recorded: StreamChunkRecord[] = [];
    const recorder = createStreamRecorder({
      sink: {
        recordStreamChunks: vi.fn(async (chunks: StreamChunkRecord[]) => {
          recorded.push(...chunks);
          return { recorded: chunks.length };
        }),
      },
    });
    recorder.handle(event(message, metadata));
    await recorder.flush();
    return recorded[0]!;
  };

  it("carries a bounded detail through to the chunk", async () => {
    const chunk = await record({
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: "completed",
        tool: "Bash",
        detail: { result: "PASS 12 tests", resultTruncated: false },
      },
    });

    expect(chunk.detail).toEqual({
      result: "PASS 12 tests",
      resultTruncated: false,
    });
  });

  // Vendor parity: the Codex driver emits the SAME `toolActivity.detail` shape
  // as the Claude one (beside its own coordinate record), so both vendors' cards
  // are filled by this one path and redacted by this one redactor.
  it("carries a CODEX detail through the same path, and redacts it the same way", async () => {
    const chunk = await record({
      controlPlane: true,
      codexActivity: {
        phase: "completed",
        itemId: "item-1",
        itemType: "commandExecution",
        label: "Codex command",
        status: "completed",
      },
      toolActivity: {
        provider: "codex",
        phase: "completed",
        itemId: "item-1",
        tool: "Codex command",
        detail: {
          args: "npm test",
          result: "AWS_SECRET_ACCESS_KEY=SECRET_CODEX_VALUE\nPASS 12 tests",
        },
      },
    });

    expect(chunk.detail?.args).toBe("npm test");
    expect(chunk.detail?.result).toContain("PASS 12 tests");
    expect(JSON.stringify(chunk)).not.toContain("SECRET_CODEX_VALUE");
  });

  it("REDACTS a credential-shaped string before it can become durable", async () => {
    const chunk = await record({
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: "completed",
        tool: "Bash",
        detail: {
          args: "printenv MUON_API_TOKEN=SECRET_ARG_VALUE",
          result: [
            "AWS_SECRET_ACCESS_KEY=SECRET_RESULT_VALUE",
            "Authorization: Bearer SECRET_BEARER_VALUE",
          ].join("\n"),
        },
      },
    });

    const persisted = JSON.stringify(chunk);
    expect(persisted).not.toContain("SECRET_ARG_VALUE");
    expect(persisted).not.toContain("SECRET_RESULT_VALUE");
    expect(persisted).not.toContain("SECRET_BEARER_VALUE");
    // The KEY survives — a redacted value must still be diagnosable.
    expect(chunk.detail?.args).toContain("MUON_API_TOKEN");
    expect(chunk.detail?.result).toContain("[redacted]");
  });

  it("RE-BOUNDS a detail an out-of-date or hostile driver sent oversized", async () => {
    const chunk = await record({
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: "completed",
        tool: "Bash",
        detail: {
          args: "a".repeat(200_000),
          result: `${"b".repeat(5_000_000)}Error: exit 1`,
        },
      },
    });

    expect(chunk.detail!.args!.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_ARGS_CHARS + 1
    );
    expect(chunk.detail!.result!.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_RESULT_CHARS + 1
    );
    // Tail-kept: the end of the output, where the error is, survived.
    expect(chunk.detail!.result!.endsWith("Error: exit 1")).toBe(true);
  });

  it("carries NO detail for an event that has none, so nothing changes", async () => {
    const withoutActivity = await record({ controlPlane: true });
    const withoutDetail = await record({
      controlPlane: true,
      toolActivity: { provider: "claude-code", phase: "started", tool: "Bash" },
    });
    const withEmptyDetail = await record({
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: "started",
        tool: "Bash",
        detail: { args: "" },
      },
    });

    expect(withoutActivity).not.toHaveProperty("detail");
    expect(withoutDetail).not.toHaveProperty("detail");
    expect(withEmptyDetail).not.toHaveProperty("detail");
  });

  it("ignores a detail of the wrong shape rather than persisting garbage", async () => {
    const chunk = await record({
      controlPlane: true,
      toolActivity: {
        provider: "claude-code",
        phase: "completed",
        tool: "Bash",
        detail: { args: { nested: "object" }, result: 42 },
      },
    });

    expect(chunk).not.toHaveProperty("detail");
  });
});
