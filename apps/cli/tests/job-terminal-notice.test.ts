import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { collectTerminalNotices } from "../src/lib/job-terminal-notice.js";

function job(overrides: Partial<DispatchJobRecord> = {}): DispatchJobRecord {
  return {
    id: "job-1",
    kind: "task",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    chatId: "chat-1",
    parentJobId: "job-root",
    status: "running",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("collectTerminalNotices", () => {
  it("announces a newly-terminal delegated worker exactly once", () => {
    const seen = new Set<string>();
    const first = collectTerminalNotices([job({ id: "A", status: "done" })], seen);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("job A finished (done)");
    // Re-seeing the same terminal job never re-announces.
    expect(collectTerminalNotices([job({ id: "A", status: "done" })], seen)).toEqual(
      []
    );
  });

  it("ignores the chat root turn, chatless jobs, and non-terminal workers", () => {
    const seen = new Set<string>();
    const notices = collectTerminalNotices(
      [
        job({ id: "root", status: "done", parentJobId: null }),
        job({ id: "loose", status: "done", chatId: null }),
        job({ id: "live", status: "running" }),
        job({ id: "worker", status: "failed" }),
      ],
      seen
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("job worker finished (failed)");
  });

  it("priming with the current jobs suppresses stale completions on resume", () => {
    const seen = new Set<string>();
    // Prime: a worker that finished before the session opened.
    collectTerminalNotices([job({ id: "old", status: "done" })], seen);
    // Later poll: "old" is not re-announced; only the new one is.
    const notices = collectTerminalNotices(
      [job({ id: "old", status: "done" }), job({ id: "new", status: "done" })],
      seen
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("job new finished");
  });
});
