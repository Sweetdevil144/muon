import { describe, expect, it } from "vitest";
import {
  buildObjectiveLoopStatus,
  buildObjectiveLoopStatusForTask,
  extractLoopMissing,
  formatObjectiveLoopHeadline,
  findLoopDispatchJob,
  pickPrimaryLoopForTask,
} from "../src/loop-status.js";
import type { DispatchJobRecord, LoopRunRecord } from "../src/types.js";

function loop(overrides: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return {
    id: "loop-1",
    taskId: "task-1",
    kind: "critique_patch",
    budget: { maxIterations: 3 },
    iterations: 1,
    status: "running",
    startedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<DispatchJobRecord> = {}): DispatchJobRecord {
  return {
    id: "job-loop",
    taskId: "task-1",
    vendor: "claude-code",
    status: "running",
    kind: "loop",
    brief: "fix tests",
    dispatchedBy: "human",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("P9 objective loop status contract", () => {
  it("extractLoopMissing returns evaluator reason + hints and never when pass=true", () => {
    expect(
      extractLoopMissing({
        iteration: 1,
        shell: [],
        evaluator: {
          laneKey: "codex",
          pass: true,
          reason: "Looks good.",
          fixHints: [],
        },
        repairSeed: "",
        updatedAt: "2026-07-31T00:00:00.000Z",
      })
    ).toBeNull();
    expect(
      extractLoopMissing({
        iteration: 2,
        shell: [{ name: "tests", ok: true, exitCode: 0 }],
        evaluator: {
          laneKey: "codex",
          pass: false,
          reason: "Error path missing.",
          fixHints: ["Handle rejection.", "Add a test."],
        },
        repairSeed: "seed",
        updatedAt: "2026-07-31T00:00:00.000Z",
      })
    ).toBe("Error path missing. (Handle rejection.; Add a test.)");
  });

  it("formatObjectiveLoopHeadline renders iteration/max and missing:", () => {
    expect(
      formatObjectiveLoopHeadline({
        iteration: 2,
        maxIterations: 3,
        status: "running",
        missing: "Error path missing.",
      })
    ).toBe("iteration 2/3 · missing: Error path missing.");
  });

  it("buildObjectiveLoopStatus exposes stop/resume affordances", () => {
    const running = buildObjectiveLoopStatus(
      loop({
        progress: {
          iteration: 2,
          shell: [{ name: "tests", ok: true, exitCode: 0 }],
          evaluator: {
            laneKey: "codex",
            pass: false,
            reason: "Missing guard.",
            fixHints: ["Add guard."],
          },
          repairSeed: "seed",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
        iterations: 2,
      }),
      job()
    );
    expect(running.canStop).toBe(true);
    expect(running.canResume).toBe(false);
    expect(running.headline).toMatch(/missing: Missing guard\./);

    const paused = buildObjectiveLoopStatus(
      loop({
        status: "aborted",
        stopReason: "paused_by_operator",
      }),
      job({ status: "interrupted", result: "interrupted by operator" })
    );
    expect(paused.canStop).toBe(false);
    expect(paused.canResume).toBe(true);
    expect(paused.resumeFromJobId).toBe("job-loop");
  });

  it("pickPrimaryLoopForTask prefers the active loop", () => {
    const chosen = pickPrimaryLoopForTask(
      [
        loop({ id: "old", status: "passed", startedAt: "2026-07-30T00:00:00.000Z" }),
        loop({ id: "live", status: "running", startedAt: "2026-07-31T00:00:00.000Z" }),
      ],
      "task-1"
    );
    expect(chosen?.id).toBe("live");
  });

  it("findLoopDispatchJob prefers live loop dispatches", () => {
    const chosen = findLoopDispatchJob(
      [
        job({ id: "done", status: "done" }),
        job({ id: "live", status: "running" }),
      ],
      "task-1"
    );
    expect(chosen?.id).toBe("live");
  });

  it("uses the loop's exact dispatch coordinate when multiple loops share a task", () => {
    const jobs = [
      job({
        id: "older-owned",
        status: "interrupted",
        createdAt: "2026-07-31T00:00:00.000Z",
      }),
      job({
        id: "newer-other-loop",
        status: "running",
        createdAt: "2026-07-31T00:01:00.000Z",
      }),
    ];
    expect(
      findLoopDispatchJob(jobs, "task-1", "older-owned")?.id
    ).toBe("older-owned");
    expect(findLoopDispatchJob(jobs, "task-1", "missing")).toBeNull();

    const status = buildObjectiveLoopStatusForTask({
      taskId: "task-1",
      loops: [
        loop({
          dispatchJobId: "older-owned",
          status: "aborted",
          stopReason: "paused_by_operator",
        }),
      ],
      jobs,
    });
    expect(status?.canResume).toBe(true);
    expect(status?.resumeFromJobId).toBe("older-owned");
  });

  it("buildObjectiveLoopStatusForTask joins loop + dispatch rows", () => {
    const status = buildObjectiveLoopStatusForTask({
      taskId: "task-1",
      loops: [loop()],
      jobs: [job()],
    });
    expect(status?.loopId).toBe("loop-1");
    expect(status?.headline).toMatch(/^iteration 1\/3/);
  });
});
