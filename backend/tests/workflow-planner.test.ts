import { beforeEach, describe, expect, it, vi } from "vitest";
import { planWorkflowViaAvailableLane } from "../src/lib/workflow-planner.js";

const coreMock = vi.hoisted(() => ({
  proposeWorkflowViaLane: vi.fn(),
}));

const adaptersMock = vi.hoisted(() => ({
  getVendorReadinessCached: vi.fn(),
}));

const dbMock = vi.hoisted(() => ({
  prisma: {
    runner: {
      findFirst: vi.fn(),
    },
    dispatchJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@muon/core", () => coreMock);
vi.mock("@muon/adapters", () => adaptersMock);
vi.mock("../src/lib/db.js", () => dbMock);

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

describe("planWorkflowViaAvailableLane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.prisma.runner.findFirst.mockResolvedValue({
      id: "runner-1",
    });
    dbMock.prisma.dispatchJob.create.mockResolvedValue({
      id: "job-1",
      status: "queued",
    });
    dbMock.prisma.dispatchJob.findUnique.mockResolvedValue({
      id: "job-1",
      status: "done",
      exitCode: 0,
      result: JSON.stringify(PROPOSAL),
    });
    coreMock.proposeWorkflowViaLane.mockImplementation(
      async (args: {
        runTask: (input: { brief: string }) => Promise<unknown>;
      }) => {
        await args.runTask({ brief: "planner brief" });
        return PROPOSAL;
      }
    );
  });

  it("uses a real ready coding lane under a bounded read-only profile", async () => {
    adaptersMock.getVendorReadinessCached.mockResolvedValue([
      {
        vendor: "claude-code",
        installed: true,
        authenticated: false,
        detail: "not ready",
      },
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        detail: "ready via custom provider",
      },
      {
        vendor: "cursor",
        installed: true,
        authenticated: true,
        detail: "IDE readiness only",
      },
    ]);

    const result = await planWorkflowViaAvailableLane({
      request: "repair auth, then document it",
      workspacePath: "/repo",
      taskId: "planner:req-1",
      laneKeys: ["claude-code", "codex", "cursor"],
      harnessKeys: ["implement", "review"],
      templateKeys: ["bugfix"],
    });

    expect(result).toEqual({ proposal: PROPOSAL, plannerLaneKey: "codex" });
    expect(coreMock.proposeWorkflowViaLane).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "repair auth, then document it",
        context: {
          laneKeys: ["codex"],
          harnessKeys: ["implement", "review"],
          templateKeys: ["bugfix"],
        },
      })
    );
    expect(dbMock.prisma.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "oneshot",
        vendor: "codex",
        taskId: "planner:req-1",
        brief: "planner brief",
        workspacePath: "/repo",
        harnessKey: "planner",
        dispatchedBy: "system:workflow-planner",
      }),
    });
    expect(dbMock.prisma.dispatchJob.findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
  });

  it("fails visibly when no dispatch-capable planner lane is ready", async () => {
    adaptersMock.getVendorReadinessCached.mockResolvedValue([
      {
        vendor: "cursor",
        installed: true,
        authenticated: true,
        detail: "IDE readiness only",
      },
    ]);

    await expect(
      planWorkflowViaAvailableLane({
        request: "plan this work",
        taskId: "planner:req-2",
        laneKeys: ["claude-code", "codex", "cursor"],
        harnessKeys: [],
        templateKeys: [],
      })
    ).rejects.toThrow(/no dispatch-ready planner lane/i);
    expect(coreMock.proposeWorkflowViaLane).not.toHaveBeenCalled();
    expect(dbMock.prisma.dispatchJob.create).not.toHaveBeenCalled();
  });

  it("never falls back to direct vendor execution when the runner is offline", async () => {
    adaptersMock.getVendorReadinessCached.mockResolvedValue([
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        detail: "ready",
      },
    ]);
    dbMock.prisma.runner.findFirst.mockResolvedValue(null);

    await expect(
      planWorkflowViaAvailableLane({
        request: "plan this work",
        taskId: "planner:req-3",
        laneKeys: ["codex"],
        harnessKeys: [],
        templateKeys: [],
      })
    ).rejects.toThrow(/live lease-fenced runner/i);
    expect(dbMock.prisma.dispatchJob.create).not.toHaveBeenCalled();
  });
});
