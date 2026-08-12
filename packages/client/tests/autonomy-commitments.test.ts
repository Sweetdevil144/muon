import { describe, expect, it } from "vitest";
import { buildAutonomyCommitments } from "../src/autonomy-commitments.js";
import type {
  DispatchJobRecord,
  LoopRunRecord,
  WorkflowRunRecord,
} from "../src/types.js";

describe("TODO 5.17: buildAutonomyCommitments", () => {
  it("lists active loops, workflows, and dispatches — active first", () => {
    const loops: LoopRunRecord[] = [
      {
        id: "loop-1",
        taskId: "t1",
        kind: "check_repair",
        budget: { maxIterations: 3 },
        iterations: 1,
        status: "running",
        startedAt: "2026-07-31T00:02:00.000Z",
      },
      {
        id: "loop-done",
        taskId: "t1",
        kind: "check_repair",
        budget: { maxIterations: 3 },
        iterations: 3,
        status: "passed",
        startedAt: "2026-07-31T00:00:00.000Z",
        endedAt: "2026-07-31T00:01:00.000Z",
      },
    ];
    const workflows: WorkflowRunRecord[] = [
      {
        id: "wf-1",
        request: "ship the gate",
        proposal: { summary: "x", steps: [] } as never,
        status: "running",
        proposedBy: "human",
        createdAt: "2026-07-31T00:01:00.000Z",
        updatedAt: "2026-07-31T00:01:00.000Z",
        startedAt: "2026-07-31T00:01:30.000Z",
      },
    ];
    const dispatches: DispatchJobRecord[] = [
      {
        id: "job-1",
        taskId: "t1",
        vendor: "codex",
        status: "running",
        kind: "auto",
        brief: "do the thing",
        dispatchedBy: "human",
        interruptRequested: false,
        steerMessages: [],
        createdAt: "2026-07-31T00:03:00.000Z",
        startedAt: "2026-07-31T00:03:00.000Z",
      },
    ];

    const list = buildAutonomyCommitments({ loops, workflows, dispatches });
    expect(list.filter((c) => c.active).map((c) => c.id)).toEqual([
      "workflow:wf-1",
      "loop:loop-1",
      "dispatch:job-1",
    ]);
    expect(list.find((c) => c.id === "loop:loop-done")?.active).toBe(false);
    expect(list.find((c) => c.id === "loop:loop-1")?.pausable).toBe(true);
    expect(list.find((c) => c.id === "loop:loop-1")?.status).toMatch(
      /^iteration 1\/3/
    );
    expect(list.find((c) => c.id === "dispatch:job-1")?.pausable).toBe(true);
  });

  it("a paused workflow is findable but not advancing", () => {
    const list = buildAutonomyCommitments({
      workflows: [
        {
          id: "wf-p",
          request: "paused work",
          proposal: { summary: "x", steps: [] } as never,
          status: "paused",
          proposedBy: "human",
          createdAt: "2026-07-31T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.active).toBe(false);
    expect(list[0]!.pausable).toBe(false);
  });
});
