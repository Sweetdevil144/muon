import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  harnessConfigSchema,
  workflowProposalSchema,
  type HarnessConfig,
} from "@muon/protocol";

const coreMocks = vi.hoisted(() => ({
  createDiffEvaluator: vi.fn(),
  createEventRecorder: vi.fn(),
  createStreamRecorder: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  resolveRepoRoot: vi.fn(),
  runLoop: vi.fn(),
  runWorkflowRun: vi.fn(),
  worktreeChangedFiles: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    createDiffEvaluator: coreMocks.createDiffEvaluator,
    createEventRecorder: coreMocks.createEventRecorder,
    createStreamRecorder: coreMocks.createStreamRecorder,
    ensureTaskWorktree: coreMocks.ensureTaskWorktree,
    resolveRepoRoot: coreMocks.resolveRepoRoot,
    runLoop: coreMocks.runLoop,
    runWorkflowRun: coreMocks.runWorkflowRun,
    worktreeChangedFiles: coreMocks.worktreeChangedFiles,
  };
});

import { registerLoopCommands } from "../src/commands/loop.js";
import { registerWorkflowCommands } from "../src/commands/workflow.js";

const WORKTREE_PATH = "/repo/.muon/worktrees/task-1";
const evaluator = vi.fn(async () => ({
  status: "degraded" as const,
  laneKey: "codex",
  reason: "not exercised by the loop mock",
}));

const governedHarness = harnessConfigSchema.parse({
  loopKind: "critique_patch",
  requires: { interactive: false, worktree: true },
  budget: { maxIterations: 4, maxWallMs: 60_000 },
  evaluator: {
    laneKey: "codex",
    criteria: "Reject missing error handling.",
  },
  checks: [{ name: "tests", command: "npm test" }],
});

function workflowDetail(
  kind: "check_repair" | "critique_patch" = "critique_patch"
) {
  const proposal = workflowProposalSchema.parse({
    summary: "governed workflow",
    steps: [
      {
        stepKey: "implement",
        title: "Implement",
        brief: "Fix the issue.",
        role: "suggest",
        laneKey: "claude-code",
        harnessKey: "governed",
        loop: {
          kind,
          maxIterations: 3,
          maxWallMs: 45_000,
        },
      },
    ],
  });
  return {
    run: {
      id: "run-1",
      status: "running",
      proposal,
      proposedBy: "human",
      workspacePath: "/repo",
    },
    tasks: [
      {
        id: "task-1",
        stepKey: "implement",
        status: "backlog",
        title: "Implement",
        description: "Fix the issue.",
        workspacePath: "/repo",
      },
    ],
  };
}

function fakeClient(
  harness: HarnessConfig,
  detail = workflowDetail()
): {
  client: MuonApiClient;
  getVendorReadiness: ReturnType<typeof vi.fn>;
  enqueueDispatch: ReturnType<typeof vi.fn>;
} {
  const getVendorReadiness = vi.fn(async () => [
    {
      vendor: "codex",
      installed: true,
      authenticated: true,
      detail: "ready",
    },
  ]);
  const enqueueDispatch = vi.fn(async () => ({
    id: "job-1",
    status: "queued",
  }));
  const client = {
    listLanes: vi.fn(async () => [
      { id: "lane-claude", key: "claude-code" },
      { id: "lane-codex", key: "codex" },
    ]),
    getHarness: vi.fn(async () => ({ config: harness })),
    getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    getWorkflowRun: vi.fn(async () => detail),
    recallRelatedToTask: vi.fn(async () => []),
    getVendorReadiness,
    assignTask: vi.fn(async () => ({})),
    createLoopRun: vi.fn(async () => ({ id: "loop-1" })),
    updateLoopRun: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => ({})),
    requestApproval: vi.fn(async () => ({ id: "approval-1" })),
    updateAgent: vi.fn(async () => ({})),
    getRunner: vi.fn(async () => ({
      live: true,
      runner: {
        id: "runner-1",
        host: "local",
        status: "online",
        lastSeenAt: new Date().toISOString(),
      },
    })),
    listStreamChunks: vi.fn(async () => []),
    enqueueDispatch,
    getDispatchJob: vi.fn(async () => ({
      id: "job-1",
      status: "done",
      exitCode: 0,
      result: "loop passed",
    })),
  } as unknown as MuonApiClient;
  return { client, getVendorReadiness, enqueueDispatch };
}

async function runCommand(
  register: (program: Command, createClient: () => MuonApiClient) => void,
  client: MuonApiClient,
  args: string[]
) {
  const program = new Command();
  program.exitOverride();
  register(program, () => client);
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return stderr.join("");
}

describe("governed loop surface wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.resolveRepoRoot.mockResolvedValue("/repo");
    coreMocks.ensureTaskWorktree.mockResolvedValue({
      path: WORKTREE_PATH,
      created: true,
    });
    coreMocks.createDiffEvaluator.mockReturnValue(evaluator);
    coreMocks.createEventRecorder.mockReturnValue({
      handle: vi.fn(),
      flush: vi.fn(async () => undefined),
    });
    coreMocks.createStreamRecorder.mockReturnValue({
      handle: vi.fn(),
      flush: vi.fn(async () => undefined),
    });
    coreMocks.worktreeChangedFiles.mockResolvedValue([]);
    coreMocks.runLoop.mockResolvedValue({
      loopId: "loop-1",
      status: "passed",
      iterations: 1,
      stopReason: "green",
      lastChecks: [],
    });
    coreMocks.runWorkflowRun.mockImplementation(async (input) => {
      const step = input.proposal.steps[0]!;
      const task = input.tasks[0]!;
      await input.dispatch({
        step,
        task,
        laneId: "lane-claude",
        laneKey: "claude-code",
      });
      return {
        status: "done",
        completedSteps: [step.stepKey],
      };
    });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("dispatches the governed loop through the persistent runner with exact bounds", async () => {
    const { client, enqueueDispatch } = fakeClient(governedHarness);

    await runCommand(registerLoopCommands, client, [
      "loop",
      "run",
      "--lane",
      "claude-code",
      "--task-id",
      "task-1",
      "--brief",
      "Fix it",
      "--harness",
      "governed",
      "--worktree",
      "--check",
      "npm run lint",
      "--timeout",
      "30000",
    ]);

    expect(enqueueDispatch).toHaveBeenCalledWith({
      kind: "loop",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "Fix it",
      harnessKey: "governed",
      checks: [{ name: "check-1", command: "npm run lint" }],
      maxIterations: 4,
      maxWallMs: 60_000,
      iterationTimeoutMs: 30_000,
      workspacePath: "/repo",
    });
    expect(coreMocks.ensureTaskWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      taskId: "task-1",
    });
    // §C: the client can no longer claim a fleet seat at all — the backend
    // does it inside the dispatch transaction — so "it did not leak an agent"
    // is now pinned by the absence of the method itself
    // (packages/client/tests/orchestration.test.ts), not by a spy for a method
    // that does not exist.
    expect(coreMocks.createDiffEvaluator).not.toHaveBeenCalled();
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
  });

  it("lets explicit --max-iterations override the harness budget", async () => {
    const { client, enqueueDispatch } = fakeClient(governedHarness);

    await runCommand(registerLoopCommands, client, [
      "loop",
      "run",
      "--lane",
      "claude-code",
      "--task-id",
      "task-1",
      "--brief",
      "Fix it",
      "--harness",
      "governed",
      "--worktree",
      "--max-iterations",
      "2",
    ]);

    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 2,
        maxWallMs: 60_000,
      })
    );
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
  });

  it("rejects an evaluator harness without --worktree before dispatch", async () => {
    const { client, enqueueDispatch } = fakeClient(governedHarness);

    const stderr = await runCommand(registerLoopCommands, client, [
      "loop",
      "run",
      "--lane",
      "claude-code",
      "--task-id",
      "task-1",
      "--brief",
      "Fix it",
      "--harness",
      "governed",
    ]);

    expect(stderr).toMatch(/worktree/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("dispatches the CLI workflow with the exact harness and proposal budget", async () => {
    const { client, enqueueDispatch } = fakeClient(governedHarness);

    await runCommand(registerWorkflowCommands, client, [
      "workflow",
      "resume",
      "--run-id",
      "run-1",
    ]);

    expect(enqueueDispatch).toHaveBeenCalledWith({
      kind: "loop",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "Fix the issue.",
      harnessKey: "governed",
      maxIterations: 3,
      maxWallMs: 45_000,
      workspacePath: "/repo",
    });
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
  });

  it("rejects workflow/harness loop-kind mismatch before claiming an agent", async () => {
    const { client, enqueueDispatch } = fakeClient(
      governedHarness,
      workflowDetail("check_repair")
    );

    const stderr = await runCommand(registerWorkflowCommands, client, [
      "workflow",
      "resume",
      "--run-id",
      "run-1",
    ]);

    expect(stderr).toContain(
      "Workflow loop kind 'check_repair' does not match harness loop kind 'critique_patch'."
    );
    expect(enqueueDispatch).not.toHaveBeenCalled();
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
