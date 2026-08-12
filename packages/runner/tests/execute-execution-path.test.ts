import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { harnessConfigSchema } from "@muon/protocol";

// ── WHERE DID THIS JOB ACTUALLY RUN? (0039) ──────────────────────────────────
//
// The runner is the only party that knows: it resolves either the task's
// isolated `<repoRoot>/.muon/worktrees/<taskId>` checkout or the canonical
// workspace, right before launching the vendor. These tests pin the fact that
// it RECORDS that resolution instead of leaving every review surface to
// re-derive the harness's intent — and that recording it can neither fail a
// healthy run nor happen for a job that never launched.

const coreMocks = vi.hoisted(() => ({
  ensureTaskWorktree: vi.fn(),
  resolveRepoRoot: vi.fn(),
  runLaneTask: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    ensureTaskWorktree: coreMocks.ensureTaskWorktree,
    resolveRepoRoot: coreMocks.resolveRepoRoot,
    runLaneTask: coreMocks.runLaneTask,
  };
});
vi.mock("../src/preflight-coverage.js", () => ({
  verifyEditPreflightCoverage: vi.fn(async () => ({
    ok: true,
    changedFiles: [],
    coveredFiles: [],
    uncoveredFiles: [],
  })),
}));

import { executeJob } from "../src/execute.js";

const WORKSPACE = "/repo/packages/app";
const WORKTREE = "/repo/.muon/worktrees/task-1";
const LEASE = { host: "desktop-mac", leaseToken: `lease-${"a".repeat(58)}` };

const worktreeHarness = harnessConfigSchema.parse({
  requires: { interactive: false, worktree: true },
});
const plainHarness = harnessConfigSchema.parse({});

function clientFor(config: ReturnType<typeof harnessConfigSchema.parse>) {
  return {
    listLanes: vi.fn(async () => [{ id: "lane-codex", key: "codex" }]),
    getHarness: vi.fn(async () => ({ config })),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    recordEvent: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => undefined),
    getDispatchJob: vi.fn(async () => null),
    recordDispatchExecutionPathForLease: vi.fn(async () => ({
      executionPath: "recorded",
    })),
  } as unknown as MuonApiClient;
}

function job() {
  return {
    id: "job-1",
    kind: "oneshot" as const,
    vendor: "codex",
    taskId: "task-1",
    brief: "Do the bounded task",
    workspacePath: WORKSPACE,
    harnessKey: "governed",
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  coreMocks.resolveRepoRoot.mockResolvedValue("/repo");
  coreMocks.ensureTaskWorktree.mockResolvedValue({
    path: WORKTREE,
    created: true,
    preparation: { links: [], problems: [] },
  });
  coreMocks.runLaneTask.mockResolvedValue({
    exitCode: 0,
    output: "done",
    errorOutput: "",
    durationMs: 3,
  });
});

describe("executeJob records where the job actually ran", () => {
  it("records the isolated worktree a worktree-backed harness runs in", async () => {
    const client = clientFor(worktreeHarness);

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", runnerLease: LEASE }
    );

    expect(result.status).toBe("done");
    // The recorded path is the tree the vendor was actually handed, which is
    // exactly what `runLaneTask` received — not the canonical checkout.
    expect(coreMocks.runLaneTask).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: WORKTREE })
    );
    expect(
      client.recordDispatchExecutionPathForLease
    ).toHaveBeenCalledWith({
      jobId: "job-1",
      executionPath: WORKTREE,
      host: LEASE.host,
      leaseToken: LEASE.leaseToken,
    });
  });

  it("records the workspace root for a job that needs no worktree", async () => {
    const client = clientFor(plainHarness);

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", runnerLease: LEASE }
    );

    expect(result.status).toBe("done");
    expect(coreMocks.ensureTaskWorktree).not.toHaveBeenCalled();
    // The point of the field: "ran in the workspace root" is STATED, never left
    // as an omission a reader cannot tell apart from "we do not know".
    expect(
      client.recordDispatchExecutionPathForLease
    ).toHaveBeenCalledWith(
      expect.objectContaining({ executionPath: WORKSPACE })
    );
  });

  it("records nothing for a job that never reached its vendor launch", async () => {
    coreMocks.ensureTaskWorktree.mockRejectedValue(
      new Error("git worktree add failed")
    );
    const client = clientFor(worktreeHarness);

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", runnerLease: LEASE }
    );

    expect(result.status).toBe("failed");
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    expect(
      client.recordDispatchExecutionPathForLease
    ).not.toHaveBeenCalled();
  });

  // ── P0: a tree that cannot run a test must never reach a worker ─────────────
  //
  // The failure this replaces was silent: the tree was created, the worker was
  // launched into it, and only then discovered that nothing resolved — by which
  // point its entire run was spent. Preparation fails the dispatch instead, and
  // the reason travels with it.
  it("refuses the dispatch when the worktree is not test-capable", async () => {
    coreMocks.ensureTaskWorktree.mockRejectedValue(
      new Error("this worktree is not test-capable: '.' could not be linked (EACCES)")
    );
    const client = clientFor(worktreeHarness);

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", runnerLease: LEASE }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toContain("this worktree is not test-capable");
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("says out loud what the prepared worktree was handed", async () => {
    coreMocks.ensureTaskWorktree.mockResolvedValue({
      path: WORKTREE,
      created: true,
      preparation: {
        links: [
          { packageDir: "apps/cli", shared: 52, workspace: 6, mirroredOutputs: ["dist"] },
        ],
        problems: [],
      },
    });
    const lines: string[] = [];

    await executeJob(
      clientFor(worktreeHarness),
      job(),
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease: LEASE,
        onLog: (line: string) => lines.push(line),
      }
    );

    expect(
      lines.some(
        (line) =>
          line.includes(`task worktree created at ${WORKTREE}`) &&
          line.includes("1 package dirs linked")
      )
    ).toBe(true);
  });

  it("runs the job normally when the brain refuses the stamp", async () => {
    const client = clientFor(worktreeHarness);
    const record = vi
      .mocked(client.recordDispatchExecutionPathForLease)
      .mockRejectedValue(new Error("409 conflict"));
    const lines: string[] = [];

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease: LEASE,
        onLog: (line) => lines.push(line),
      }
    );

    // Review evidence is worth degrading; a healthy run is not worth losing.
    expect(result.status).toBe("done");
    expect(record).toHaveBeenCalled();
    expect(coreMocks.runLaneTask).toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/could not record execution path/i);
  });

  it("stamps nothing without a runner lease, exactly as before 0039", async () => {
    const client = clientFor(worktreeHarness);

    const result = await executeJob(
      client,
      job(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    expect(
      client.recordDispatchExecutionPathForLease
    ).not.toHaveBeenCalled();
  });
});
