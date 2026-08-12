import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MuonApiClient } from "@muon/client";
import { harnessConfigSchema } from "@muon/protocol";

const coreMocks = vi.hoisted(() => ({
  createDiffEvaluator: vi.fn(),
  createStreamRecorder: vi.fn(),
  ensureTaskWorktree: vi.fn(),
  resolveRepoRoot: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
  startManagedSession: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    createDiffEvaluator: coreMocks.createDiffEvaluator,
    createStreamRecorder: coreMocks.createStreamRecorder,
    ensureTaskWorktree: coreMocks.ensureTaskWorktree,
    resolveRepoRoot: coreMocks.resolveRepoRoot,
    runLaneTask: coreMocks.runLaneTask,
    runLoop: coreMocks.runLoop,
    startManagedSession: coreMocks.startManagedSession,
  };
});

import { executeJob } from "../src/execute.js";

const WORKTREE_PATH = "/repo/.muon/worktrees/task-1";

function clientFor(config: ReturnType<typeof harnessConfigSchema.parse>) {
  return {
    listLanes: vi.fn(async () => [
      { id: "lane-claude", key: "claude-code" },
      { id: "lane-codex", key: "codex" },
      { id: "lane-cursor", key: "cursor" },
    ]),
    getHarness: vi.fn(async () => ({ config })),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    getVendorReadiness: vi.fn(async () => [
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        detail: "ready",
      },
    ]),
    createLoopRun: vi.fn(async () => ({ id: "loop-1" })),
    updateLoopRun: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => ({})),
    requestApproval: vi.fn(async () => ({ id: "approval-1" })),
    recordStreamChunks: vi.fn(async () => 0),
  } as unknown as MuonApiClient;
}

function loopJob(vendor = "claude-code") {
  return {
    id: "job-1",
    kind: "loop" as const,
    vendor,
    taskId: "task-1",
    brief: "Fix the bug",
    workspacePath: "/repo/packages/app",
    harnessKey: "governed",
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

function governedLoopJob(workspacePath: string, deadlineAt: string) {
  return {
    ...loopJob("codex"),
    id: "job-root",
    chatId: "chat-root",
    workspacePath,
    capabilityMode: "orchestrator" as const,
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 4,
    maxWallMs: 60_000,
    delegationDeadline: deadlineAt,
    delegationManifest: {
      version: 1 as const,
      jobId: "job-root",
      workspacePath,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      maxIterations: 4,
      deadlineAt,
      authority: "orchestrator" as const,
      childAuthority: "work" as const,
      narrowingRequired: true as const,
    },
  };
}

describe("executeJob governed loop integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.resolveRepoRoot.mockResolvedValue("/repo");
    coreMocks.ensureTaskWorktree.mockResolvedValue({
      path: WORKTREE_PATH,
      created: true,
      preparation: { links: [], problems: [] },
    });
    coreMocks.createStreamRecorder.mockReturnValue({
      handle: vi.fn(),
      flush: vi.fn(async () => undefined),
    });
    coreMocks.createDiffEvaluator.mockReturnValue(
      vi.fn(async () => ({
        status: "degraded",
        laneKey: "codex",
        reason: "not exercised by the loop mock",
      }))
    );
    coreMocks.runLoop.mockResolvedValue({
      loopId: "loop-1",
      status: "passed",
      iterations: 1,
      stopReason: "checks green on iteration 1",
      lastChecks: [],
    });
    coreMocks.runLaneTask.mockRejectedValue(
      new Error("one-shot vendor launch must not be reached")
    );
  });

  it("creates the task worktree and threads the governed evaluator into runLoop", async () => {
    const controller = new AbortController();
    const config = harnessConfigSchema.parse({
      loopKind: "critique_patch",
      requires: { interactive: false, worktree: true },
      budget: { maxIterations: 4, maxWallMs: 60_000 },
      evaluator: {
        laneKey: "codex",
        criteria: "Reject missing errors.",
      },
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    const result = await executeJob(
      client,
      loopJob(),
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
      }
    );

    expect(result.status).toBe("done");
    expect(coreMocks.resolveRepoRoot).toHaveBeenCalledWith("/repo/packages/app");
    expect(coreMocks.ensureTaskWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      taskId: "task-1",
    });
    expect(coreMocks.createDiffEvaluator).toHaveBeenCalledWith(
      expect.objectContaining({
        implementerLaneKey: "claude-code",
        taskId: "task-1",
        cwd: WORKTREE_PATH,
        spec: config.evaluator,
        signal: expect.any(AbortSignal),
        isReady: expect.any(Function),
        onEvent: expect.any(Function),
      })
    );
    expect(coreMocks.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchJobId: "job-1",
        cwd: WORKTREE_PATH,
        maxIterations: 4,
        maxWallMs: 60_000,
        kind: "critique_patch",
        evaluate: expect.any(Function),
      })
    );

    const evaluatorArgs = coreMocks.createDiffEvaluator.mock.calls[0]![0];
    await expect(evaluatorArgs.isReady("codex")).resolves.toBe(true);
    expect(client.getVendorReadiness).toHaveBeenCalled();
  });

  it("preserves the requested cwd and omits an evaluator for a legacy loop", async () => {
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    const result = await executeJob(
      client,
      loopJob("codex"),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    expect(coreMocks.resolveRepoRoot).not.toHaveBeenCalled();
    expect(coreMocks.ensureTaskWorktree).not.toHaveBeenCalled();
    expect(coreMocks.createDiffEvaluator).not.toHaveBeenCalled();
    expect(coreMocks.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/packages/app",
        kind: "check_repair",
        evaluate: undefined,
      })
    );
  });

  it("uses task-scoped dispatch budgets instead of the harness defaults", async () => {
    const config = harnessConfigSchema.parse({
      budget: { maxIterations: 6, maxWallMs: 120_000 },
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    await executeJob(
      client,
      {
        ...loopJob("codex"),
        maxIterations: 2,
        maxWallMs: 45_000,
        checks: [{ name: "lint", command: "npm run lint" }],
        iterationTimeoutMs: 30_000,
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(coreMocks.runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 2,
        maxWallMs: 45_000,
        checks: [
          { name: "tests", command: "npm test" },
          { name: "lint", command: "npm run lint" },
        ],
        timeoutMs: 30_000,
      })
    );
  });

  it("fails before any vendor launch when task worktree creation fails", async () => {
    coreMocks.ensureTaskWorktree.mockRejectedValue(
      new Error("git worktree add failed")
    );
    const config = harnessConfigSchema.parse({
      loopKind: "critique_patch",
      requires: { interactive: false, worktree: true },
      evaluator: { criteria: "Review the patch." },
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    const result = await executeJob(
      client,
      loopJob("codex"),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/worktree|git worktree/i),
    });
    expect(coreMocks.runLoop).not.toHaveBeenCalled();
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("checks an expired governed deadline before preparing a worktree", async () => {
    const config = harnessConfigSchema.parse({
      loopKind: "critique_patch",
      requires: { interactive: false, worktree: true },
      evaluator: { laneKey: "codex", criteria: "Review the patch." },
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);
    const workspace = process.cwd();

    const result = await executeJob(
      client,
      governedLoopJob(
        workspace,
        new Date(Date.now() - 1_000).toISOString()
      ),
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
      }
    );

    expect(result).toMatchObject({
      status: "interrupted",
      result: expect.stringMatching(/deadline/i),
    });
    expect(coreMocks.resolveRepoRoot).not.toHaveBeenCalled();
    expect(coreMocks.ensureTaskWorktree).not.toHaveBeenCalled();
  });

  it("emits a typed terminal packet carrying the loop's check evidence (P0.3)", async () => {
    coreMocks.runLoop.mockResolvedValue({
      loopId: "loop-1",
      status: "passed",
      iterations: 2,
      stopReason: "checks green on iteration 2",
      finalOutput: `GOAL: Finish the loop.
CHANGED:
- Fixed the issue.
FAILED: nothing
COMMANDS RUN:
- npm test
CHECKS:
- npm test: passed
CHANGED FILES:
- src/fix.ts
OPEN QUESTIONS:
- Should the repair budget be raised?
UNCERTAINTIES:
- None
NEXT ACTION:
- Review and land the worktree.
MEMORY PROPOSALS:
- [constraint] Keep repair loops bounded.`,
      lastChecks: [
        {
          name: "tests",
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputTail: "12 passed",
        },
      ],
    });
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    const result = await executeJob(
      client,
      loopJob("codex"),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    expect(result.packet).toBeDefined();
    const packet = result.packet!;
    expect(packet.schemaVersion).toBe(2);
    expect(packet.checks).toEqual([
      expect.objectContaining({
        name: "tests",
        command: "npm test",
        outcome: "passed",
        exitCode: 0,
      }),
    ]);
    // No governed worktree harness → the missing diff hash is visibly degraded.
    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("no_diff_evidence");
    expect(packet.openQuestions).toEqual([
      "Should the repair budget be raised?",
    ]);
    expect(packet.memoryProposals).toEqual([
      { kind: "constraint", text: "Keep repair loops bounded." },
    ]);
    expect(packet.recommendedNextAction).toBe(
      "Review and land the worktree."
    );
    // The v1 prose result stays byte-identical to the old wire.
    expect(result.result).toContain("loop passed in 2 iteration(s)");
  });

  it("derives the failing-loop packet from the outcome and recommends repair", async () => {
    coreMocks.runLoop.mockResolvedValue({
      loopId: "loop-1",
      status: "escalated",
      iterations: 3,
      stopReason: "budget exhausted with tests still failing",
      approvalId: "approval-9",
      lastChecks: [
        {
          name: "tests",
          command: "npm test",
          ok: false,
          exitCode: 1,
          outputTail: "2 failed",
        },
      ],
    });
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    const result = await executeJob(
      client,
      loopJob("codex"),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("failed");
    expect(result.packet).toBeDefined();
    const packet = result.packet!;
    expect(packet.whatFailed).toContain("budget exhausted");
    expect(packet.checks[0]).toMatchObject({
      name: "tests",
      outcome: "failed",
      exitCode: 1,
    });
    expect(packet.recommendedNextAction).toMatch(/repair loop escalated/i);
  });

  it("allows a legacy governed worktree only for its exact task", async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "muon-governed-root-"))
    );
    const worktree = path.join(root, ".muon", "worktrees", "task-1");
    try {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "tests@muon.local"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.name", "MUON Tests"], {
        cwd: root,
      });
      writeFileSync(path.join(root, "seed.txt"), "seed\n");
      execFileSync("git", ["add", "seed.txt"], { cwd: root });
      execFileSync("git", ["commit", "-m", "seed"], { cwd: root });
      mkdirSync(path.dirname(worktree), { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", worktree], {
        cwd: root,
      });
      coreMocks.resolveRepoRoot.mockResolvedValue(root);
      coreMocks.ensureTaskWorktree.mockResolvedValue({
        path: worktree,
        created: true,
        preparation: { links: [], problems: [] },
      });
      const config = harnessConfigSchema.parse({
        loopKind: "critique_patch",
        requires: { interactive: false, worktree: true },
        evaluator: { laneKey: "codex", criteria: "Review the patch." },
        checks: [{ name: "tests", command: "npm test" }],
      });
      const client = clientFor(config);

      const result = await executeJob(
        client,
        governedLoopJob(
          root,
          new Date(Date.now() + 60_000).toISOString()
        ),
        { id: "agent-1", name: "codex-1" },
        {
          apiBase: "http://127.0.0.1:4000",
          delegationToken: "root-job-token",
        }
      );

      expect(result.status).toBe("done");
      expect(coreMocks.ensureTaskWorktree).toHaveBeenCalledWith({
        repoRoot: root,
        taskId: "task-1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * REGRESSION FIXTURES: the governed gate on the LOOP transport, both
   * session vendors.
   *
   * The live failures these lock out are mirror images:
   *   • codex — implement/repair loop children ran on `codex exec`, which has
   *     no approval channel at all (it ignores `approval_policy`; measured
   *     0.145.0), so a governed codex child did four minutes of
   *     write-authority work with ZERO ApprovalRequest rows.
   *   • claude-code — loop children ran on the one-shot session channel,
   *     which installs no `canUseTool`, so Claude's OWN permission layer
   *     denied every Edit/Bash with ZERO ApprovalRequest rows filed and Full
   *     Auto's standing consent had nothing to grant (the founder's FULL AUTO
   *     mission: verdict PARTIAL, no test written, no code changed).
   * The loop path must route every session-vendor iteration through the
   * managed session — the one transport that carries MUON's approval bridge.
   */
  it("a governed codex loop iteration must run through MUON's gated session transport, never exec", async () => {
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);
    const wait = vi.fn(async () => ({ exitCode: 0, output: "iteration done" }));
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-9",
      handle: { vendorSessionId: "thread-9", wait },
    });

    await executeJob(
      client,
      { ...loopJob("codex"), approvalTimeoutMs: 120_000 },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    const loopInput = coreMocks.runLoop.mock.calls[0]![0];
    // The gate rides an injected per-iteration executor; its absence is the
    // regression (the default falls back to runLaneTask -> codex exec).
    expect(loopInput.execute).toEqual(expect.any(Function));

    const iterationEvents: unknown[] = [];
    const result = await loopInput.execute({
      laneKey: "codex",
      taskId: "task-1",
      brief: "iteration brief",
      cwd: "/repo/packages/app",
      profile: loopInput.profile,
      onEvent: (event: unknown) => iterationEvents.push(event),
    });
    expect(result).toEqual({ exitCode: 0, output: "iteration done" });

    expect(coreMocks.startManagedSession).toHaveBeenCalledTimes(1);
    const [, managedInput] = coreMocks.startManagedSession.mock.calls[0]!;
    expect(managedInput).toMatchObject({
      laneKey: "codex",
      laneId: "lane-codex",
      taskId: "task-1",
      jobId: "job-1",
      brief: "iteration brief",
      approvalTimeoutMs: 120_000,
      noInteractiveApprover: false,
      // P0.4 reaches the loop gate on the same worker-only terms as the
      // interactive branch: the governed workspace and the byte-exact check
      // lines that test-class receipts redeem against.
      workspacePath: "/repo/packages/app",
      checkCommands: ["npm test"],
    });
    expect(wait).toHaveBeenCalledTimes(1);
    // The ungated one-shot transport was never touched.
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("a governed claude loop child's tool call must reach MUON's gate: iterations run through the managed session, never the one-shot channel", async () => {
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);
    // Claude reports its vendor session id on the STREAM (the first `system`
    // message), strictly after start() returns — so the handle has no id at
    // start and gains one by wait(). The capture must survive that timing.
    const handle: { vendorSessionId?: string; wait: () => Promise<unknown> } = {
      vendorSessionId: undefined,
      wait: vi.fn(async () => {
        handle.vendorSessionId = "3f8a0e5e-6a4b-4bd1-9d10-6f2a7f6f2a11";
        return { exitCode: 0, output: "iteration done" };
      }),
    };
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-10",
      handle,
    });
    const recordJobVendorSessionForLease = vi.fn(async () => ({}));
    (client as unknown as Record<string, unknown>)[
      "recordJobVendorSessionForLease"
    ] = recordJobVendorSessionForLease;

    await executeJob(
      client,
      { ...loopJob("claude-code"), approvalTimeoutMs: 120_000 },
      { id: "agent-1", name: "claude-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease: { host: "test-host", leaseToken: "lease-1" },
      }
    );

    const loopInput = coreMocks.runLoop.mock.calls[0]![0];
    // The gate rides the injected per-iteration executor; its absence is the
    // founder's exact failure (the default falls back to runLaneTask → the
    // one-shot channel, where Claude's own layer denies with zero rows filed).
    expect(loopInput.execute).toEqual(expect.any(Function));

    const result = await loopInput.execute({
      laneKey: "claude-code",
      taskId: "task-1",
      brief: "iteration brief",
      cwd: "/repo/packages/app",
      profile: loopInput.profile,
      onEvent: () => undefined,
    });
    expect(result).toEqual({ exitCode: 0, output: "iteration done" });

    expect(coreMocks.startManagedSession).toHaveBeenCalledTimes(1);
    const [, managedInput] = coreMocks.startManagedSession.mock.calls[0]!;
    expect(managedInput).toMatchObject({
      laneKey: "claude-code",
      laneId: "lane-claude",
      taskId: "task-1",
      jobId: "job-1",
      brief: "iteration brief",
      // Full Auto grants through the existing poller against THIS bound; the
      // bridge denies on its expiry (fail closed).
      approvalTimeoutMs: 120_000,
      noInteractiveApprover: false,
      // P0.4 reaches the loop gate on the same worker-only terms as the
      // interactive branch.
      workspacePath: "/repo/packages/app",
      checkCommands: ["npm test"],
    });
    // The resume/backlink handle learned at wait() is still captured.
    expect(recordJobVendorSessionForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        vendorSessionId: "3f8a0e5e-6a4b-4bd1-9d10-6f2a7f6f2a11",
      })
    );
    // The ungated one-shot transport was never touched.
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("a lane with no session driver keeps its existing transport inside the context wrapper", async () => {
    const config = harnessConfigSchema.parse({
      checks: [{ name: "tests", command: "npm test" }],
    });
    const client = clientFor(config);

    await executeJob(
      client,
      loopJob("cursor"),
      { id: "agent-1", name: "cursor-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    const loopInput = coreMocks.runLoop.mock.calls[0]![0];
    expect(loopInput.execute).toEqual(expect.any(Function));
    coreMocks.runLaneTask.mockResolvedValueOnce({
      exitCode: 0,
      output: "cursor iteration done",
    });
    const iteration = {
      laneKey: "cursor",
      taskId: "task-1",
      brief: "iteration brief",
      cwd: "/repo/packages/app",
      profile: loopInput.profile,
      onEvent: () => undefined,
    };
    await expect(loopInput.execute(iteration)).resolves.toEqual({
      exitCode: 0,
      output: "cursor iteration done",
    });
    expect(coreMocks.runLaneTask).toHaveBeenCalledWith(iteration);
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });
});
