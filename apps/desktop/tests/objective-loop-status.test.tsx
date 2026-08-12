// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ObjectiveLoopControl } from "@muon/client";
import { ObjectiveLoopStatusBar } from "../src/renderer/objective-loop-status.js";

function status(
  overrides: Partial<ObjectiveLoopControl> = {}
): ObjectiveLoopControl {
  return {
    loopId: "loop-1",
    taskId: "task-1",
    kind: "critique_patch",
    status: "running",
    iteration: 2,
    maxIterations: 3,
    missing: "Error path missing.",
    degraded: null,
    stopReason: null,
    headline: "iteration 2/3 · missing: Error path missing.",
    canStop: true,
    canResume: false,
    resumeFromJobId: null,
    resumeBlockedReason: null,
    ...overrides,
  };
}

describe("ObjectiveLoopStatusBar", () => {
  it("renders iteration/max and missing: as control-state copy", () => {
    render(<ObjectiveLoopStatusBar status={status()} />);
    const copy = screen.getByRole("status").textContent ?? "";
    expect(copy).toContain("iteration 2/3");
    expect(copy).toContain("missing: Error path missing.");
  });

  it("wires stop and resume actions", async () => {
    const onStop = vi.fn(async () => undefined);
    const onResume = vi.fn(async () => undefined);
    render(
      <ObjectiveLoopStatusBar
        status={status({ canStop: false, canResume: true, resumeFromJobId: "job-1" })}
        onStop={onStop}
        onResume={onResume}
      />
    );
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
    screen.getByRole("button", { name: "Resume loop" }).click();
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
