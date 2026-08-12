import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_LOOP_ENTRY_PROMPT,
  objectiveLoopComposerActivity,
} from "../src/renderer/lib/objective-loop-ui.js";

describe("objective loop conversational entry", () => {
  it("ships a composer chip prompt that asks for loop dispatch", () => {
    expect(OBJECTIVE_LOOP_ENTRY_PROMPT.toLowerCase()).toContain("loop");
    expect(OBJECTIVE_LOOP_ENTRY_PROMPT.toLowerCase()).toContain("missing");
  });

  it("prefers live loop headline in composer activity", () => {
    expect(
      objectiveLoopComposerActivity({
        loopId: "loop-1",
        taskId: "task-1",
        kind: "check_repair",
        status: "running",
        iteration: 1,
        maxIterations: 3,
        missing: null,
        degraded: null,
        stopReason: null,
        headline: "iteration 1/3",
        canStop: true,
        canResume: false,
        resumeFromJobId: null,
        resumeBlockedReason: null,
      })
    ).toBe("iteration 1/3");
  });
});
