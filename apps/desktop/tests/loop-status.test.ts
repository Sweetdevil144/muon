import { describe, expect, it } from "vitest";
import type { LoopRunRecord } from "@muon/client";
import { describeLoopProgress, loopForJob } from "../src/lib/loop-status.js";

// A governed `loop` job renders as a bare "Working" for its whole life, so an
// agent iterating with failing checks looked identical to a hung one — the
// founder read a live 3/10 loop as "the subagent finished and MUON never
// refreshed" (2026-08-05). These pin the sentence that makes the two
// distinguishable, and pin that it is never invented.

const loop = (over: Partial<LoopRunRecord> = {}): LoopRunRecord =>
  ({
    id: "loop-1",
    dispatchJobId: "job-1",
    taskId: "task-1",
    kind: "check_repair",
    budget: { maxIterations: 10 },
    iterations: 2,
    status: "running",
    startedAt: new Date().toISOString(),
    ...over,
  }) as LoopRunRecord;

describe("describeLoopProgress", () => {
  it("names the iteration in flight against the budget", () => {
    expect(describeLoopProgress(loop())).toBe("loop 3/10");
  });

  it("reports the failing checks the last iteration recorded", () => {
    const line = describeLoopProgress(
      loop({
        progress: {
          iteration: 2,
          shell: [
            { name: "tests", ok: false, exitCode: 1 },
            { name: "lint", ok: true, exitCode: 0 },
          ],
        },
      } as Partial<LoopRunRecord>)
    );
    expect(line).toBe("loop 3/10 · checks failing (tests)");
  });

  it("distinguishes a reviewer rejection from a failing check", () => {
    const line = describeLoopProgress(
      loop({
        progress: {
          iteration: 2,
          shell: [{ name: "tests", ok: true, exitCode: 0 }],
          evaluator: {
            pass: false,
            reason: "missing coverage",
            fixHints: [],
            laneKey: "codex",
          },
        },
      } as Partial<LoopRunRecord>)
    );
    expect(line).toBe("loop 3/10 · reviewer asked for changes");
  });

  it("says nothing for a settled loop — a finished loop is not a status", () => {
    expect(describeLoopProgress(loop({ status: "passed" }))).toBeNull();
    expect(describeLoopProgress(loop({ status: "aborted" }))).toBeNull();
  });

  it("says nothing when there is no loop at all (every ordinary job)", () => {
    expect(describeLoopProgress(null)).toBeNull();
    expect(describeLoopProgress(undefined)).toBeNull();
  });

  it("never invents an outcome the ledger did not record", () => {
    expect(describeLoopProgress(loop({ progress: null }))).toBe("loop 3/10");
  });
});

describe("loopForJob", () => {
  it("binds a loop to its owning dispatch job only", () => {
    const runs = [loop({ id: "a", dispatchJobId: "job-1" }), loop({ id: "b", dispatchJobId: "job-2" })];
    expect(loopForJob(runs, "job-2")?.id).toBe("b");
    expect(loopForJob(runs, "job-3")).toBeNull();
  });

  it("is inert without a job id or a loop list", () => {
    expect(loopForJob(null, "job-1")).toBeNull();
    expect(loopForJob([loop()], null)).toBeNull();
  });
});
