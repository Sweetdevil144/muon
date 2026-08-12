import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHarnessConfig, type MuonApiClient } from "@muon/client";

const coreMocks = vi.hoisted(() => ({
  ensureTaskWorktree: vi.fn(),
  resolveRepoRoot: vi.fn(),
  // The executor no longer runs checks itself: it goes through core's ONE
  // check entry point, which also qualifies coverage and derives the changed
  // packages' suites. Mocking that (rather than `runShellCheck`) is also what
  // keeps a step check in a unit test from spawning a real `npm test`.
  runChecksWithCoverage: vi.fn(),
  runWorkflowRun: vi.fn(),
  worktreeChangedFiles: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    ensureTaskWorktree: coreMocks.ensureTaskWorktree,
    resolveRepoRoot: coreMocks.resolveRepoRoot,
    runChecksWithCoverage: coreMocks.runChecksWithCoverage,
    runWorkflowRun: coreMocks.runWorkflowRun,
    worktreeChangedFiles: coreMocks.worktreeChangedFiles,
  };
});

import { executeWorkflowInTui } from "../src/lib/workflow-executor.js";

const WORKTREE_PATH = "/repo/.muon/worktrees/task-1";
const governedHarness = {
  ...emptyHarnessConfig,
  loopKind: "critique_patch" as const,
  requires: {
    ...emptyHarnessConfig.requires,
    interactive: false,
    worktree: true,
  },
  budget: {
    ...emptyHarnessConfig.budget,
    maxIterations: 4,
    maxWallMs: 60_000,
  },
  checks: [{ name: "tests", command: "npm test" }],
};

/** A harness whose step runs once and is judged by its checks, not a loop. */
const plainHarness = {
  ...emptyHarnessConfig,
  requires: {
    ...emptyHarnessConfig.requires,
    interactive: false,
    worktree: true,
  },
  checks: [{ name: "tests", command: "npm test" }],
};

function workflowDetail(
  kind: "check_repair" | "critique_patch" = "critique_patch",
  options: { loop?: boolean } = {}
) {
  if (options.loop === false) {
    return {
      run: {
        id: "run-1",
        status: "running",
        proposedBy: "human",
        workspacePath: "/repo",
        proposal: {
          summary: "governed workflow",
          steps: [
            {
              stepKey: "implement",
              title: "Implement",
              brief: "Fix the issue.",
              role: "suggest",
              laneKey: "claude-code",
              harnessKey: "governed",
            },
          ],
        },
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
  return {
    run: {
      id: "run-1",
      status: "running",
      proposedBy: "human",
      workspacePath: "/repo",
      proposal: {
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
      },
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
  kind: "check_repair" | "critique_patch" = "critique_patch",
  options: { loop?: boolean } = {}
) {
  const enqueueDispatch = vi.fn(async () => ({
    id: "job-1",
    status: "queued",
  }));
  const client = {
    getWorkflowRun: vi.fn(async () => workflowDetail(kind, options)),
    getHarness: vi.fn(async () => ({
      config: options.loop === false ? plainHarness : governedHarness,
    })),
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
  return { client, enqueueDispatch };
}

describe("TUI governed workflow executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.resolveRepoRoot.mockResolvedValue("/repo");
    coreMocks.ensureTaskWorktree.mockResolvedValue({
      path: WORKTREE_PATH,
      created: true,
    });
    coreMocks.worktreeChangedFiles.mockResolvedValue(["src/auth.ts"]);
    coreMocks.runChecksWithCoverage.mockResolvedValue({
      checks: [
        {
          name: "tests",
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputTail: "",
        },
      ],
      changedFiles: ["src/auth.ts"],
    });
    coreMocks.runWorkflowRun.mockImplementation(async (input) => {
      const result = await input.dispatch({
        step: input.proposal.steps[0]!,
        task: input.tasks[0]!,
        laneId: "lane-claude",
        laneKey: "claude-code",
      });
      expect(result).toEqual({
        ok: true,
        summary: "loop passed",
        changedFiles: ["src/auth.ts"],
      });
      return {
        status: "done",
        completedSteps: ["implement"],
      };
    });
  });

  it("dispatches the workflow loop with its exact harness and proposal budget", async () => {
    const { client, enqueueDispatch } = fakeClient();

    await executeWorkflowInTui({
      client,
      runId: "run-1",
      apiBase: "http://127.0.0.1:4000",
      onLiveEvent: vi.fn(),
      onStatus: vi.fn(),
    });

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
    expect(coreMocks.worktreeChangedFiles).toHaveBeenCalledWith(WORKTREE_PATH);
  });

  it("fails a non-loop step whose changed package had no suite to run", async () => {
    // Parity with the loop: a green declared check is not enough when a package
    // the change touched was verified by nothing. The executor asks core, and
    // core's answer — not `ok ? pass : fail` — decides the step.
    coreMocks.runChecksWithCoverage.mockResolvedValue({
      checks: [
        {
          name: "tests",
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputTail: "",
          skip: {
            kind: "superseded",
            detail: "[muon:derived-check] answered by tests[apps/cli]",
          },
        },
        {
          name: "tests[apps/cli]",
          command: "",
          ok: false,
          exitCode: 0,
          outputTail: "",
          skip: {
            kind: "no-suite",
            detail: "[muon:no-test-suite] apps/cli declares no runnable `test` script",
          },
        },
      ],
      changedFiles: ["apps/cli/src/a.ts"],
    });
    const { client } = fakeClient("check_repair", { loop: false });
    let dispatched: { ok: boolean; summary: string } | undefined;
    coreMocks.runWorkflowRun.mockImplementation(async (input) => {
      dispatched = await input.dispatch({
        step: input.proposal.steps[0]!,
        task: input.tasks[0]!,
        laneId: "lane-claude",
        laneKey: "claude-code",
      });
      return { status: "done", completedSteps: ["implement"] };
    });

    await executeWorkflowInTui({
      client,
      runId: "run-1",
      apiBase: "http://127.0.0.1:4000",
      onLiveEvent: vi.fn(),
      onStatus: vi.fn(),
    });

    expect(coreMocks.runChecksWithCoverage).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: WORKTREE_PATH, stopOnFirstFailure: true })
    );
    expect(dispatched?.ok).toBe(false);
    expect(dispatched?.summary).toContain("tests[apps/cli]");
    expect(dispatched?.summary).toContain("no-suite");
  });

  it("rejects workflow/harness loop-kind mismatch before enqueueing", async () => {
    const { client, enqueueDispatch } = fakeClient("check_repair");

    await expect(
      executeWorkflowInTui({
        client,
        runId: "run-1",
        apiBase: "http://127.0.0.1:4000",
        onLiveEvent: vi.fn(),
        onStatus: vi.fn(),
      })
    ).rejects.toThrow(
      "Workflow loop kind 'check_repair' does not match harness loop kind 'critique_patch'."
    );

    expect(enqueueDispatch).not.toHaveBeenCalled();
  });
});
