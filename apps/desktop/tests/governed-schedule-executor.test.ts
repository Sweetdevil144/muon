import { afterEach, describe, expect, it, vi } from "vitest";
import { createGovernedScheduleExecutor } from "../src/lib/governed-schedule-executor.js";

const claim = {
  schedule: {
    id: "schedule-1",
    title: "Nightly review",
    objective: "Review the repository",
    workspacePath: "/repo",
    vendor: "codex",
    nextRunAt: "2026-08-01T00:00:00.000Z",
    runCount: 1,
    maxWallMs: 60_000,
    maxDescendantWallMs: 120_000,
    status: "completed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    occurrences: [],
  },
  occurrence: {
    id: "occurrence-1",
    scheduleId: "schedule-1",
    scheduledFor: "2026-08-01T00:00:00.000Z",
    status: "claimed",
    claimedAt: "2026-08-01T00:00:00.000Z",
  },
} as const;

afterEach(() => vi.useRealTimers());

describe("governed schedule executor", () => {
  it("does not claim while live standing consent is absent", async () => {
    const claimDueSchedule = vi.fn(async () => claim);
    const executor = createGovernedScheduleExecutor({
      client: () =>
        ({ claimDueSchedule, updateScheduleOccurrence: vi.fn() }) as never,
      canClaim: async () => false,
      execute: vi.fn(),
    });
    executor.start(60_000);
    await executor.poll();
    executor.stop();
    expect(claimDueSchedule).not.toHaveBeenCalled();
  });

  it("claims once and records the exact chat/root terminal evidence", async () => {
    const claimDueSchedule = vi
      .fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(null);
    const updateScheduleOccurrence = vi.fn(async () => claim.occurrence);
    const execute = vi.fn(async () => ({
      chatId: "chat-scheduled",
      rootJobId: "job-root",
    }));
    const executor = createGovernedScheduleExecutor({
      client: () =>
        ({ claimDueSchedule, updateScheduleOccurrence }) as never,
      canClaim: async () => true,
      execute,
    });
    executor.start(60_000);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    executor.stop();
    expect(updateScheduleOccurrence).toHaveBeenCalledWith({
      scheduleId: "schedule-1",
      occurrenceId: "occurrence-1",
      status: "done",
      chatId: "chat-scheduled",
      rootJobId: "job-root",
    });
  });

  it("turn failures become bounded failed occurrences instead of escaping the poller", async () => {
    const claimDueSchedule = vi
      .fn()
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(null);
    const updateScheduleOccurrence = vi.fn(async () => claim.occurrence);
    const lines: string[] = [];
    const executor = createGovernedScheduleExecutor({
      client: () =>
        ({ claimDueSchedule, updateScheduleOccurrence }) as never,
      canClaim: async () => true,
      execute: async () => {
        throw new Error("vendor unavailable");
      },
      log: (line) => lines.push(line),
    });
    executor.start(60_000);
    await vi.waitFor(() =>
      expect(updateScheduleOccurrence).toHaveBeenCalledWith({
        scheduleId: "schedule-1",
        occurrenceId: "occurrence-1",
        status: "failed",
        error: "vendor unavailable",
      })
    );
    executor.stop();
    expect(lines.join("\n")).toContain("vendor unavailable");
  });
});
