import { describe, expect, it } from "vitest";
import {
  applyTerminalActivityEvent,
  applyTerminalExit,
  INITIAL_TERMINAL_ACTIVITY,
  terminalPaneStatus,
} from "../src/lib/terminal-activity.js";

describe("applyTerminalActivityEvent (ROADMAP T2)", () => {
  it("stamps lastActivityAt and accumulates output into the tail", () => {
    const next = applyTerminalActivityEvent(
      INITIAL_TERMINAL_ACTIVITY,
      { kind: "output", data: "hello\n" },
      1000
    );
    expect(next).toEqual({
      lastActivityAt: 1000,
      exitCode: null,
      outputTail: "hello\n",
    });
  });

  it("bounds the output tail so unbounded scrollback never accumulates", () => {
    const huge = "x".repeat(10_000);
    const next = applyTerminalActivityEvent(
      INITIAL_TERMINAL_ACTIVITY,
      { kind: "output", data: huge },
      1000
    );
    expect(next.outputTail.length).toBeLessThan(huge.length);
  });

  it("an input event clears the output tail (answered prompts don't stick)", () => {
    const withOutput = applyTerminalActivityEvent(
      INITIAL_TERMINAL_ACTIVITY,
      { kind: "output", data: "Do you want to proceed? (y/n)" },
      1000
    );
    const afterInput = applyTerminalActivityEvent(
      withOutput,
      { kind: "input", data: "y\r" },
      1001
    );
    expect(afterInput.outputTail).toBe("");
    expect(afterInput.lastActivityAt).toBe(1001);
  });

  it("preserves a recorded exit code across further activity", () => {
    const exited = applyTerminalExit(INITIAL_TERMINAL_ACTIVITY, 1);
    const next = applyTerminalActivityEvent(
      exited,
      { kind: "output", data: "more\n" },
      2000
    );
    expect(next.exitCode).toBe(1);
  });
});

describe("terminalPaneStatus (ROADMAP T2)", () => {
  it("derives working from recent output", () => {
    const state = applyTerminalActivityEvent(
      INITIAL_TERMINAL_ACTIVITY,
      { kind: "output", data: "$ ls\n" },
      5000
    );
    expect(terminalPaneStatus(state, false, { now: 5100 })).toBe("working");
  });

  it("derives permission from a heuristic prompt match in recent output", () => {
    const state = applyTerminalActivityEvent(
      INITIAL_TERMINAL_ACTIVITY,
      { kind: "output", data: "Allow this action? (y/n) " },
      5000
    );
    expect(terminalPaneStatus(state, false, { now: 5100 })).toBe("permission");
  });

  it("derives review then idle across the seen gate after a clean exit", () => {
    const state = applyTerminalExit(INITIAL_TERMINAL_ACTIVITY, 0);
    expect(terminalPaneStatus(state, false, { now: 5000 })).toBe("review");
    expect(terminalPaneStatus(state, true, { now: 5000 })).toBe("idle");
  });

  it("derives failed from a non-zero exit regardless of seen", () => {
    const state = applyTerminalExit(INITIAL_TERMINAL_ACTIVITY, 127);
    expect(terminalPaneStatus(state, true, { now: 5000 })).toBe("failed");
  });
});
