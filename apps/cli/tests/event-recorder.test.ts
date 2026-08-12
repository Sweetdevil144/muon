import { describe, expect, it, vi } from "vitest";
import { createEventRecorder } from "../src/lib/event-recorder.js";

type TestEvent = {
  id: string;
  laneId: string;
  taskId: string;
  kind:
    | "task.started"
    | "task.progress"
    | "task.blocked"
    | "task.completed"
    | "approval.requested"
    | "handoff.created";
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
};

function event(overrides: Partial<TestEvent>): TestEvent {
  return {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.progress",
    message: "chunk",
    timestamp: "2026-07-06T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("createEventRecorder", () => {
  it("coalesces streamed progress chunks into a single record between milestones", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const recorder = createEventRecorder({ record });

    recorder.handle(
      event({ kind: "task.started", message: "Running codex" })
    );
    recorder.handle(event({ message: "chunk one" }));
    recorder.handle(event({ message: "chunk two" }));
    recorder.handle(
      event({ message: "chunk three", timestamp: "2026-07-06T10:00:03.000Z" })
    );
    recorder.handle(
      event({ kind: "task.completed", message: "Command completed" })
    );

    const summary = await recorder.flush();

    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls[0]?.[0].kind).toBe("task.started");
    expect(record.mock.calls[1]?.[0].kind).toBe("task.progress");
    expect(record.mock.calls[1]?.[0].message).toContain("chunk one");
    expect(record.mock.calls[1]?.[0].message).toContain("chunk three");
    expect(record.mock.calls[1]?.[0].metadata?.chunks).toBe(3);
    expect(record.mock.calls[1]?.[0].timestamp).toBe(
      "2026-07-06T10:00:03.000Z"
    );
    expect(record.mock.calls[2]?.[0].kind).toBe("task.completed");
    expect(summary).toEqual({ recorded: 3, failures: 0 });
  });

  it("flushes trailing progress chunks when the stream ends without a milestone", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const recorder = createEventRecorder({ record });

    recorder.handle(event({ message: "only chunk" }));

    const summary = await recorder.flush();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0].kind).toBe("task.progress");
    expect(summary.recorded).toBe(1);
  });

  it("caps the coalesced progress message to a tail", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const recorder = createEventRecorder({ record, tailChars: 50 });

    recorder.handle(event({ message: "x".repeat(200) }));
    recorder.handle(event({ message: "END_MARKER" }));

    await recorder.flush();

    const message = record.mock.calls[0]?.[0].message as string;
    expect(message).toContain("END_MARKER");
    expect(message.length).toBeLessThanOrEqual(60);
  });

  it("counts failures without aborting later records", async () => {
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const recorder = createEventRecorder({ record });

    recorder.handle(event({ kind: "task.started", message: "start" }));
    recorder.handle(
      event({ kind: "task.completed", message: "Command completed" })
    );

    const summary = await recorder.flush();

    expect(record).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ recorded: 1, failures: 1 });
  });

  it("records nothing when no events were handled", async () => {
    const record = vi.fn();
    const recorder = createEventRecorder({ record });

    const summary = await recorder.flush();

    expect(record).not.toHaveBeenCalled();
    expect(summary).toEqual({ recorded: 0, failures: 0 });
  });
});
