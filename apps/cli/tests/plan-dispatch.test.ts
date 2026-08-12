import { describe, expect, it, vi } from "vitest";
import { planWorkflowViaDispatch } from "../src/commands/plan.js";

const PROPOSAL = {
  summary: "Repair auth and document the result",
  steps: [
    {
      stepKey: "repair-auth",
      title: "Repair auth",
      brief: "Repair the authentication failure with regression coverage.",
      role: "suggest",
      priority: "high",
    },
    {
      stepKey: "document",
      title: "Document the result",
      brief: "Document the verified behavior.",
      role: "suggest",
      priority: "medium",
      gate: "merge",
    },
  ],
};

describe("planWorkflowViaDispatch", () => {
  it("runs the selected planner lane through the persistent dispatch spine", async () => {
    const client = {
      enqueueDispatch: vi.fn(async () => ({
        id: "job-1",
        status: "queued",
      })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        status: "done",
        exitCode: 0,
        result: JSON.stringify(PROPOSAL),
      })),
    };
    const ensureRunnerFn = vi.fn(async () => ({
      live: true,
      started: false,
    }));

    const proposal = await planWorkflowViaDispatch({
      client: client as never,
      laneKey: "codex",
      request: "repair auth, then document it",
      taskId: "muon-plan",
      workspacePath: "/repo",
      apiBase: "http://127.0.0.1:4321",
      context: {
        laneKeys: ["claude-code", "codex"],
        harnessKeys: ["planner", "review"],
        templateKeys: ["bugfix"],
      },
      ensureRunnerFn: ensureRunnerFn as never,
    });

    expect(proposal).toMatchObject(PROPOSAL);
    expect(ensureRunnerFn).toHaveBeenCalledWith(client, {
      apiBase: "http://127.0.0.1:4321",
    });
    expect(client.enqueueDispatch).toHaveBeenCalledWith({
      kind: "oneshot",
      vendor: "codex",
      taskId: "muon-plan",
      brief: expect.stringContaining("MUON super-orchestrator planner"),
      harnessKey: "planner",
      workspacePath: "/repo",
    });
    expect(client.getDispatchJob).toHaveBeenCalledWith("job-1");
  });

  it("fails without enqueueing when no lease-fenced runner is live", async () => {
    const client = {
      enqueueDispatch: vi.fn(),
      getDispatchJob: vi.fn(),
    };

    await expect(
      planWorkflowViaDispatch({
        client: client as never,
        laneKey: "claude-code",
        request: "plan this",
        taskId: "muon-plan",
        apiBase: "http://127.0.0.1:4321",
        context: {
          laneKeys: ["claude-code"],
          harnessKeys: ["planner"],
          templateKeys: [],
        },
        ensureRunnerFn: vi.fn(async () => ({
          live: false,
          started: false,
          note: "runner unavailable",
        })) as never,
      })
    ).rejects.toThrow(/runner unavailable/i);
    expect(client.enqueueDispatch).not.toHaveBeenCalled();
  });
});
