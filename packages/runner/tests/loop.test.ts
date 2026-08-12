import { describe, expect, it, vi } from "vitest";
import {
  MuonApiHttpError,
  type DispatchJobRecord,
  type MuonApiClient,
} from "@muon/client";
import type { ReconcileOutcome } from "@muon/orchestrator";
import { runRunnerLoop } from "../src/loop.js";

/**
 * These exercise the runner LOOP's orchestration, heartbeat, atomic
 * agent+job claim, terminal commit, and recovery paths, without
 * running a real vendor. executeJob fails fast (no lane in the ledger) so the
 * loop's wiring is what's under test, deterministically.
 */

const QUEUED_JOB = {
  id: "job-1",
  kind: "oneshot",
  vendor: "claude-code",
  taskId: "task-1",
  brief: "do the thing",
  status: "queued",
  interruptRequested: false,
  steerMessages: [],
  dispatchedBy: "orchestrator",
};
const LEASE_TOKEN = `lease-${"a".repeat(58)}`;

function makeClient(overrides: Partial<Record<string, unknown>>): MuonApiClient {
  const base = {
    runnerHeartbeat: vi.fn(async () => undefined),
    reclaimDispatchJobs: vi.fn(async () => ({ reclaimed: 0, jobIds: [] })),
    // No lane → executeJob returns { failed } before touching any adapter.
    listLanes: vi.fn(async () => []),
    updateAgent: vi.fn(async () => ({})),
    claimDispatchJobAndAgentForLease: vi.fn(),
    updateDispatchJobForLease: vi.fn(async () => ({})),
    issueDelegationTokenForLease: vi.fn(async () => ({
      token: "job-bound-agent-capability",
      canDelegate: false,
    })),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    getTaskDetail: vi.fn(async () => undefined),
    // Reinforcement producer (KG-2): present so executeJob's fire-and-forget
    // used-signal never throws even though these fail-fast cases never reach it.
    markMemoryUsed: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as MuonApiClient;
}

async function runOneCycle(
  client: MuonApiClient,
  settled: Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const loop = runRunnerLoop(client, {
    host: "test-host",
    pid: 777,
    leaseToken: LEASE_TOKEN,
    apiBase: "http://localhost:4000",
    pollMs: 20,
    heartbeatMs: 10_000,
    signal: controller.signal,
    onLog: () => undefined,
  });
  await settled;
  controller.abort();
  await loop;
}

describe("runRunnerLoop", () => {
  it("fails before reclaiming or polling when the host lease heartbeat is rejected", async () => {
    const reclaimDispatchJobs = vi.fn();
    const listDispatchJobs = vi.fn();
    const client = makeClient({
      runnerHeartbeat: vi.fn(async () => {
        throw new Error("409 runner host lease is held by pid 41");
      }),
      reclaimDispatchJobs,
      listDispatchJobs,
    });

    await expect(
      runRunnerLoop(client, {
        host: "desktop-mac",
        pid: 99,
        leaseToken: LEASE_TOKEN,
        apiBase: "http://127.0.0.1:4000",
      })
    ).rejects.toThrow(/lease/i);

    expect(reclaimDispatchJobs).not.toHaveBeenCalled();
    expect(listDispatchJobs).not.toHaveBeenCalled();
  });

  it("refuses to start without a positive PID identity", async () => {
    const client = makeClient({});

    await expect(
      runRunnerLoop(client, {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        apiBase: "http://127.0.0.1:4000",
      })
    ).rejects.toThrow(/pid/i);
  });

  it("atomically claims the agent+job and commits terminal status through the lease", async () => {
    let onFinalize: () => void = () => undefined;
    const finalized = new Promise<void>((resolve) => {
      onFinalize = resolve;
    });

    let listed = 0;
    const claimDispatchJobAndAgentForLease = vi.fn(async () => ({
      job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
      agent: { id: "agent-1", name: "claude-1" },
    }));
    const updateDispatchJobForLease = vi.fn(async () => {
      onFinalize();
      return {};
    });
    const updateAgent = vi.fn(async () => ({}));

    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
      updateAgent,
    });

    await runOneCycle(client, finalized);

    expect(claimDispatchJobAndAgentForLease).toHaveBeenCalledWith({
      jobId: "job-1",
      host: "test-host",
      leaseToken: LEASE_TOKEN,
    });
    // Terminal status written (failed here, no lane, but the pipeline ran).
    expect(updateDispatchJobForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        status: "failed",
        host: "test-host",
        leaseToken: LEASE_TOKEN,
      })
    );
    // The backend commits terminal status + agent release atomically.
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("delivers a job-bound delegate token and aborts one-shot work on interrupt", async () => {
    let listed = 0;
    let polls = 0;
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const execute = vi.fn(
      async (
        _client: MuonApiClient,
        _job: unknown,
        _agent: unknown,
        options: { signal?: AbortSignal; delegationToken?: string }
      ) => {
        expect(options.delegationToken).toBe("job-bound-delegate-token");
        executionStarted();
        return new Promise<{
          status: "interrupted";
          result: string;
        }>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "interrupted",
                result: "interrupt propagated",
              }),
            { once: true }
          );
        });
      }
    );
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () =>
        listed++ === 0
          ? [
              {
                ...QUEUED_JOB,
                capabilityMode: "orchestrator",
              },
            ]
          : []
      ),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: {
          ...QUEUED_JOB,
          status: "running",
          agentId: "agent-1",
          capabilityMode: "orchestrator",
        },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      issueDelegationTokenForLease: vi.fn(async () => ({
        token: "job-bound-delegate-token",
        canDelegate: true,
      })),
      getDispatchJob: vi.fn(async () => ({
        interruptRequested: ++polls >= 2,
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        finalized();
        return {};
      }),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      interruptPollMs: 1,
      heartbeatMs: 10_000,
      execute,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await started;
    await done;
    controller.abort();
    await loop;

    expect(execute).toHaveBeenCalledOnce();
  });

  it("commits the terminal packet through the lease and resends the SAME packet on retry (P0.3)", async () => {
    const packet = {
      taskGoal: "Fix the parser crash",
      whatChanged: "Lane 'codex' completed the step.",
      whatFailed: "Nothing reported failing.",
      nextLaneRequest: "Review the run result and continue.",
      commandsRun: ["(command not captured)"],
      checksStatus: ["run: completed"],
      openQuestions: [],
      provenance: { lane: "codex", createdAt: "2026-07-16T00:00:00.000Z" },
      schemaVersion: 2,
      changedFiles: ["src/a.ts"],
      diffHash: `sha256:${"a".repeat(64)}`,
      diffVerified: true,
      checks: [
        { name: "tests", outcome: "passed" as const, summary: "12 passed" },
      ],
      artifacts: [],
      uncertainties: [],
      unresolvedDecisions: [],
      recommendedNextAction: "Continue in the review lane.",
      memoryProposals: [],
      degraded: { flag: false, reasons: [] },
    };
    const execute = vi.fn(async () => ({
      status: "done" as const,
      exitCode: 0,
      result: "ok",
      packet,
    }));
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    let listed = 0;
    const updateDispatchJobForLease = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET transient terminal loss"))
      .mockImplementation(async () => {
        finalized();
        return {};
      });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease,
    });

    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 20,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      execute,
      signal: controller.signal,
      onLog: () => undefined,
    });
    await done;
    controller.abort();
    await loop;

    expect(updateDispatchJobForLease).toHaveBeenCalledTimes(2);
    expect(updateDispatchJobForLease.mock.calls[0]![0]).toMatchObject({
      jobId: "job-1",
      status: "done",
      packet,
    });
    // The exact same packet is resent with the lease-fenced retry.
    expect(updateDispatchJobForLease.mock.calls[1]![0]).toMatchObject({
      packet,
    });
  });

  it("retries the same atomic claim after a transient response-loss failure", async () => {
    let listed = 0;
    const claimDispatchJobAndAgentForLease = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET after commit"))
      .mockResolvedValueOnce({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      });
    const updateDispatchJobForLease = vi.fn(async () => ({}));
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await loop;

    expect(claimDispatchJobAndAgentForLease).toHaveBeenCalledTimes(2);
    expect(updateDispatchJobForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        host: "test-host",
        leaseToken: LEASE_TOKEN,
      })
    );
  });

  it("fails a job for an un-authenticated vendor BEFORE claiming an agent (P2 readiness gate)", async () => {
    let onFail: () => void = () => undefined;
    const failed = new Promise<void>((resolve) => (onFail = resolve));

    const claimDispatchJobAndAgentForLease = vi.fn();
    let listed = 0;
    const updateDispatchJobForLease = vi.fn(async () => {
      onFail();
      return {};
    });

    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "claude-code",
          installed: true,
          authenticated: false,
          detail: "not logged in",
          fixHint: "log into Claude Code first: run `claude` and sign in",
        },
      ]),
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
    });

    await runOneCycle(client, failed);

    // No claimed-then-failed agent: never claim, fail the job with the fix.
    expect(claimDispatchJobAndAgentForLease).not.toHaveBeenCalled();
    expect(updateDispatchJobForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        status: "failed",
        host: "test-host",
        leaseToken: LEASE_TOKEN,
      })
    );
    const call = updateDispatchJobForLease.mock.calls[0]![0] as {
      result: string;
    };
    expect(call.result).toContain("claude");
  });

  it("re-probes fresh before failing, a just-logged-in vendor (stale cache) is dispatched, not failed (F4)", async () => {
    let onFinalize: () => void = () => undefined;
    const finalized = new Promise<void>((resolve) => (onFinalize = resolve));
    let listed = 0;
    const claimDispatchJobAndAgentForLease = vi.fn(async () => ({
      job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
      agent: { id: "agent-1", name: "claude-1" },
    }));
    const updateDispatchJobForLease = vi.fn(async () => {
      onFinalize();
      return {};
    });
    // Cached probe (no arg) says logged OUT; the fresh (refresh:true) re-probe
    // reflects the just-completed login → the gate must NOT fail the job.
    const getVendorReadiness = vi.fn(async (opts?: { refresh?: boolean }) => [
      {
        vendor: "claude-code",
        installed: true,
        authenticated: Boolean(opts?.refresh),
        detail: opts?.refresh ? "logged in" : "not logged in",
        fixHint: "sign in",
      },
    ]);

    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      getVendorReadiness,
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
    });

    await runOneCycle(client, finalized);

    // Re-probed fresh, saw "ready", and dispatched normally (agent claimed).
    expect(getVendorReadiness).toHaveBeenCalledWith({ refresh: true });
    expect(claimDispatchJobAndAgentForLease).toHaveBeenCalled();
  });

  it("degrades gracefully when readiness is unavailable, still claims and runs", async () => {
    let onFinalize: () => void = () => undefined;
    const finalized = new Promise<void>((resolve) => (onFinalize = resolve));
    let listed = 0;
    const claimDispatchJobAndAgentForLease = vi.fn(async () => ({
      job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
      agent: { id: "agent-1", name: "claude-1" },
    }));
    const updateDispatchJobForLease = vi.fn(async () => {
      onFinalize();
      return {};
    });

    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      // Probe throws (route missing) → the gate must not block the pipeline.
      getVendorReadiness: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
    });

    await runOneCycle(client, finalized);

    expect(claimDispatchJobAndAgentForLease).toHaveBeenCalled();
    expect(updateDispatchJobForLease).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", status: "failed" })
    );
  });

  it("keeps renewing the lease while an in-flight job drains", async () => {
    let listed = 0;
    let terminalStarted!: () => void;
    const terminalWriteStarted = new Promise<void>(
      (resolve) => (terminalStarted = resolve)
    );
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>(
      (resolve) => (releaseTerminal = resolve)
    );
    const runnerHeartbeat = vi.fn(async () => undefined);
    const client = makeClient({
      runnerHeartbeat,
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        terminalStarted();
        await terminalGate;
        return {};
      }),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 5,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await terminalWriteStarted;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 18));

    expect(runnerHeartbeat.mock.calls.length).toBeGreaterThan(1);
    releaseTerminal();
    await loop;
  });

  it("leaves the job queued when the vendor fleet is saturated", async () => {
    let onSaturated: () => void = () => undefined;
    const saturated = new Promise<void>((resolve) => (onSaturated = resolve));
    const claimDispatchJobAndAgentForLease = vi.fn(async () => {
      onSaturated(); // we reached the claim, proof the poll ran
      throw new Error("409 no idle agent");
    });
    const updateDispatchJobForLease = vi.fn();

    const client = makeClient({
      listDispatchJobs: vi.fn(async () => [QUEUED_JOB]),
      claimDispatchJobAndAgentForLease,
      updateDispatchJobForLease,
    });

    await runOneCycle(client, saturated);

    expect(claimDispatchJobAndAgentForLease).toHaveBeenCalled();
    expect(updateDispatchJobForLease).not.toHaveBeenCalled();
  });

  it("retries startup reclaim before polling any new work", async () => {
    let polled!: () => void;
    const firstPoll = new Promise<void>((resolve) => (polled = resolve));
    const reclaimDispatchJobs = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 backend warming"))
      .mockResolvedValueOnce({ reclaimed: 1, jobIds: ["job-old"] });
    const listDispatchJobs = vi.fn(async () => {
      polled();
      return [];
    });
    const client = makeClient({ reclaimDispatchJobs, listDispatchJobs });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await firstPoll;
    controller.abort();
    await loop;

    expect(reclaimDispatchJobs).toHaveBeenCalledTimes(2);
    expect(reclaimDispatchJobs.mock.invocationCallOrder[1]).toBeLessThan(
      listDispatchJobs.mock.invocationCallOrder[0]!
    );
  });

  it("does not mistake a transient error containing the word lease for a 409 fence", async () => {
    const reclaimDispatchJobs = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 lease service temporarily unavailable"))
      .mockResolvedValueOnce({ reclaimed: 0, jobIds: [] });
    const controller = new AbortController();
    const client = makeClient({
      reclaimDispatchJobs,
      listDispatchJobs: vi.fn(async () => {
        controller.abort();
        return [];
      }),
    });
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await loop;

    expect(reclaimDispatchJobs).toHaveBeenCalledTimes(2);
  });

  it("aborts active vendor execution when a successor explicitly fences the lease", async () => {
    let heartbeatCalls = 0;
    const runnerHeartbeat = vi.fn(async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls >= 2) {
        throw new Error("409 runner lease replaced by operator");
      }
    });
    let listed = 0;
    const execute = vi.fn(
      async (
        _client: MuonApiClient,
        _job: unknown,
        _agent: unknown,
        options: { signal?: AbortSignal }
      ) =>
        new Promise<{
          status: "interrupted";
          result: string;
        }>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ status: "interrupted", result: "lease lost" }),
            { once: true }
          );
        })
    );
    const client = makeClient({
      runnerHeartbeat,
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        throw new Error("409 successor reconciled job");
      }),
    });

    await runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 2,
      execute,
      onLog: () => undefined,
    });

    expect(execute).toHaveBeenCalledOnce();
    const signal = execute.mock.calls[0]?.[3].signal;
    expect(signal?.aborted).toBe(true);
  });

  it("does not start vendor work when the lease is fenced while a claim is resolving", async () => {
    let heartbeatCalls = 0;
    let markFenced!: () => void;
    const fenced = new Promise<void>((resolve) => {
      markFenced = resolve;
    });
    const runnerHeartbeat = vi.fn(async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls >= 2) {
        markFenced();
        throw new Error("409 runner lease replaced by operator");
      }
    });

    let markClaimStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    let releaseClaim!: (value: {
      job: typeof QUEUED_JOB & { agentId: string };
      agent: { id: string; name: string };
    }) => void;
    const claimGate = new Promise<{
      job: typeof QUEUED_JOB & { agentId: string };
      agent: { id: string; name: string };
    }>((resolve) => {
      releaseClaim = resolve;
    });
    let listed = 0;
    const execute = vi.fn(async () => ({
      status: "done" as const,
      result: "must not run",
    }));
    const client = makeClient({
      runnerHeartbeat,
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => {
        markClaimStarted();
        return claimGate;
      }),
      updateDispatchJobForLease: vi.fn(async () => {
        throw new Error("409 successor reconciled job");
      }),
    });

    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 1,
      execute,
      onLog: () => undefined,
    });

    await claimStarted;
    await fenced;
    releaseClaim({
      job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
      agent: { id: "agent-1", name: "claude-1" },
    });
    await loop;

    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps retrying a terminal write past three transient failures", async () => {
    let settled!: () => void;
    const reachedOutcome = new Promise<void>((resolve) => (settled = resolve));
    let listed = 0;
    const updateDispatchJobForLease = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockImplementationOnce(async () => {
        settled();
        return {};
      });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease,
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      signal: controller.signal,
      onLog: (line) => {
        if (line.includes("status write failed")) settled();
      },
    });

    await reachedOutcome;
    controller.abort();
    await loop;

    expect(updateDispatchJobForLease).toHaveBeenCalledTimes(4);
  });
});

// A chat-bound delegated child (chatId + parentJobId) — the exact shape the
// runner must auto-reconcile when it finishes. The chat's own root turn and a
// chatless direct dispatch (both handled by QUEUED_JOB) must NOT reconcile.
const WATCHED_JOB = {
  ...QUEUED_JOB,
  id: "job-w",
  chatId: "chat-1",
  parentJobId: "job-root",
};

describe("runRunnerLoop — S4 durable auto-reconcile wiring (task #127)", () => {
  function makeReconciler() {
    const jobs: DispatchJobRecord[] = [];
    let onCall: () => void = () => undefined;
    const called = new Promise<void>((resolve) => (onCall = resolve));
    const reconcile = vi.fn(
      async (job: DispatchJobRecord): Promise<ReconcileOutcome> => {
        jobs.push(job);
        onCall();
        return "nudged";
      }
    );
    return { reconcile, jobs, called };
  }

  it("fires the reconciler exactly once for a watched worker going terminal", async () => {
    const { reconcile, jobs, called } = makeReconciler();
    const execute = vi.fn(async () => ({
      status: "done" as const,
      result: "ok",
      exitCode: 0,
    }));
    let listed = 0;
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [WATCHED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...WATCHED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease: vi.fn(async () => ({})),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      execute,
      reconciler: { reconcile },
      signal: controller.signal,
      onLog: () => undefined,
    });

    await called;
    controller.abort();
    await loop;

    expect(reconcile).toHaveBeenCalledTimes(1);
    // The terminal-status record is handed to the reconciler, not the queued one.
    expect(jobs[0]).toMatchObject({ id: "job-w", status: "done" });
  });

  it("does NOT reconcile a non-watched job (the chat root turn / a chatless dispatch)", async () => {
    const { reconcile } = makeReconciler();
    let finalize!: () => void;
    const finalized = new Promise<void>((resolve) => (finalize = resolve));
    const execute = vi.fn(async () => ({
      status: "done" as const,
      result: "ok",
      exitCode: 0,
    }));
    let listed = 0;
    const client = makeClient({
      // QUEUED_JOB has no chatId/parentJobId → not a watched worker.
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [QUEUED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...QUEUED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        finalize();
        return {};
      }),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      execute,
      reconciler: { reconcile },
      signal: controller.signal,
      onLog: () => undefined,
    });

    await finalized;
    // Let any (erroneous) scheduled reconcile microtask run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await loop;

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does NOT reconcile when auto-continue is disabled (operator opt-out)", async () => {
    const { reconcile } = makeReconciler();
    let finalize!: () => void;
    const finalized = new Promise<void>((resolve) => (finalize = resolve));
    const execute = vi.fn(async () => ({
      status: "done" as const,
      result: "ok",
      exitCode: 0,
    }));
    let listed = 0;
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => (listed++ === 0 ? [WATCHED_JOB] : [])),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...WATCHED_JOB, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        finalize();
        return {};
      }),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      execute,
      autoContinue: false,
      reconciler: { reconcile },
      signal: controller.signal,
      onLog: () => undefined,
    });

    await finalized;
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await loop;

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("(FIX 5) reconciles a watched worker whose delegation-token issuance failed", async () => {
    const { reconcile, jobs, called } = makeReconciler();
    const WATCHED_DELEGATE = { ...WATCHED_JOB, capabilityMode: "delegate" };
    let listed = 0;
    const client = makeClient({
      listDispatchJobs: vi.fn(async () =>
        listed++ === 0 ? [WATCHED_DELEGATE] : []
      ),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...WATCHED_DELEGATE, status: "running", agentId: "agent-1" },
        agent: { id: "agent-1", name: "claude-1" },
      })),
      // Token issuance throws → runOne commits 'failed' and returns BEFORE execute.
      // The watched worker must still drive the bounded auto-continue nudge, not
      // silently stall a headless deployment.
      issueDelegationTokenForLease: vi.fn(async () => {
        throw new Error("delegation authority unavailable");
      }),
      updateDispatchJobForLease: vi.fn(async () => ({})),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      reconciler: { reconcile },
      signal: controller.signal,
      onLog: () => undefined,
    });

    await called;
    controller.abort();
    await loop;

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(jobs[0]).toMatchObject({ id: "job-w", status: "failed" });
  });

  it("(FIX 3) files a human gate for a watched worker reclaimed at startup", async () => {
    const approvals: Array<Record<string, unknown>> = [];
    let onFiled: () => void = () => undefined;
    const filed = new Promise<void>((resolve) => (onFiled = resolve));
    const RECLAIMED_WATCHED = {
      ...WATCHED_JOB,
      status: "interrupted",
      result: "reclaimed after lease takeover; outcome unknown",
    };
    const client = makeClient({
      // Startup reclaim bulk-marks the stranded watched worker 'interrupted'
      // OUTSIDE runOne, returning its id.
      reclaimDispatchJobs: vi.fn(async () => ({
        reclaimed: 1,
        jobIds: ["job-w"],
      })),
      getDispatchJob: vi.fn(async () => RECLAIMED_WATCHED),
      listApprovals: vi.fn(async () => [...approvals]),
      requestApproval: vi.fn(async (input: Record<string, unknown>) => {
        approvals.push({ ...input, status: "pending" });
        onFiled();
        return input;
      }),
      listDispatchJobs: vi.fn(async () => []),
    });
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      retryDelay: async () => undefined,
      signal: controller.signal,
      onLog: () => undefined,
    });

    await filed;
    controller.abort();
    await loop;

    // The uncertain (interrupted) reclaimed worker reaches a human gate — never
    // an autonomous replay — so a headless deployment doesn't stall.
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "gate", jobId: "job-w" });
  });
});

// ── B1: a queued orchestrator root must never wait silently for the seat ─────
//
// There is ONE coordinator seat per vendor (fleet ordinal 0) and an
// `orchestrator` job may claim only that ordinal, so a failed claim is seat
// contention, never fleet saturation. The loop used to swallow the 409 with no
// terminal write, no chunk and no event, leaving the job `queued` while a human
// watched Mission Chat spin for the full 30-minute turn budget.
describe("runRunnerLoop — B1 coordinator seat contention", () => {
  const SEAT_JOB = {
    ...QUEUED_JOB,
    id: "job-coord",
    chatId: "chat-2",
    capabilityMode: "orchestrator",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  };

  it("says so in the chat AND fails the turn fast instead of waiting 30 minutes", async () => {
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const recordStreamChunks = vi.fn(async () => ({ recorded: 1 }));
    const updateDispatchJobForLease = vi.fn(async () => {
      finalized();
      return {};
    });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => [SEAT_JOB]),
      claimDispatchJobAndAgentForLease: vi.fn(async () => {
        throw new Error("409 No idle 'claude-code' fleet agent is available.");
      }),
      getDispatchJob: vi.fn(async () => SEAT_JOB),
      recordStreamChunks,
      updateDispatchJobForLease,
    });

    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      // The job above was enqueued 5 minutes ago, so any sane bound is blown.
      coordinatorSeatWaitMs: 60_000,
      signal: controller.signal,
      onLog: () => undefined,
    });
    await done;
    controller.abort();
    await loop;

    // 1. It is not silent: the chat's own lane carries the reason, which is what
    //    `waitForTerminal` forwards to the live turn.
    expect(recordStreamChunks).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: "chat-2",
        laneId: "muon-chat",
        kind: "milestone",
        content: expect.stringMatching(/coordinator seat is held/i),
      }),
    ]);
    // 2. It is not a 30-minute wait: the job reaches a terminal, legible state.
    expect(updateDispatchJobForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-coord",
        status: "failed",
        result: expect.stringMatching(
          /coordinator seat .*still held.*never started/is
        ),
      })
    );
  });

  it("lets a seat that frees inside the bound proceed normally, writing no failure", async () => {
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    // Enqueued just now: inside any bound, so a brief contention must NOT fail.
    const freshJob = {
      ...SEAT_JOB,
      createdAt: new Date().toISOString(),
    };
    let claims = 0;
    const updateDispatchJobForLease = vi.fn(async () => {
      finalized();
      return {};
    });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => [freshJob]),
      claimDispatchJobAndAgentForLease: vi.fn(async () => {
        // First tick the seat is taken; by the second it has been released.
        if (claims++ === 0) {
          throw new Error("409 No idle 'claude-code' fleet agent is available.");
        }
        return {
          job: { ...freshJob, status: "running", agentId: "agent-0" },
          agent: { id: "agent-0", name: "claude-code-coordinator" },
        };
      }),
      getDispatchJob: vi.fn(async () => freshJob),
      recordStreamChunks: vi.fn(async () => ({ recorded: 1 })),
      updateDispatchJobForLease,
    });

    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      coordinatorSeatWaitMs: 60_000,
      signal: controller.signal,
      onLog: () => undefined,
    });
    await done;
    controller.abort();
    await loop;

    // The only terminal write is the executed job's own (failed here: the test
    // client has no lane), never a seat-contention refusal.
    for (const call of updateDispatchJobForLease.mock.calls) {
      expect((call[0] as { result?: string }).result ?? "").not.toMatch(
        /coordinator seat/i
      );
    }
  });

  it("leaves a WORKER queued on fleet saturation — that is what the semaphore is for", async () => {
    const updateDispatchJobForLease = vi.fn(async () => ({}));
    const recordStreamChunks = vi.fn(async () => ({ recorded: 0 }));
    const getDispatchJob = vi.fn(async () => ({
      ...QUEUED_JOB,
      createdAt: new Date(0).toISOString(),
    }));
    const client = makeClient({
      // A worker job: no capabilityMode, enqueued long ago.
      listDispatchJobs: vi.fn(async () => [
        { ...QUEUED_JOB, createdAt: new Date(0).toISOString() },
      ]),
      claimDispatchJobAndAgentForLease: vi.fn(async () => {
        throw new Error("409 No idle 'claude-code' fleet agent is available.");
      }),
      getDispatchJob,
      recordStreamChunks,
      updateDispatchJobForLease,
    });

    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      coordinatorSeatWaitMs: 1,
      signal: controller.signal,
      onLog: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await loop;

    expect(updateDispatchJobForLease).not.toHaveBeenCalled();
    expect(recordStreamChunks).not.toHaveBeenCalled();
    // The bound is not even consulted for a worker.
    expect(getDispatchJob).not.toHaveBeenCalled();
  });
});

// ── B2: mining runs AFTER the terminal write, never before it ────────────────
//
// `captureMemories` used to be awaited inside executeJob, before the terminal
// status was committed — so the extractor's whole extra vendor process (up to
// 120s) sat between the assistant's last token and the fleet agent being
// released. On a coordinator turn that is a two-minute dead spinner on a turn
// that has visibly finished, and the one seat stays claimed the entire time.
describe("runRunnerLoop — B2 memory capture is off the critical path", () => {
  const CAPTURE_JOB = {
    ...QUEUED_JOB,
    id: "job-mine",
    chatId: "chat-3",
    capabilityMode: "orchestrator",
    createdAt: new Date().toISOString(),
  };

  function captureClient(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    const captureJobMemoryForLease = vi.fn(async () => ({
      note: {},
      action: "inserted",
    }));
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => [CAPTURE_JOB]),
      claimDispatchJobAndAgentForLease: vi.fn(async () => ({
        job: { ...CAPTURE_JOB, status: "running", agentId: "agent-0" },
        agent: { id: "agent-0", name: "claude-code-coordinator" },
      })),
      updateDispatchJobForLease: vi.fn(async () => {
        order.push("terminal");
        return {};
      }),
      // The mining posture read. Answering it is the FIRST thing the deferred
      // capture does, so it marks when mining began relative to the terminal.
      getMemoryMining: vi.fn(async () => {
        order.push("mine");
        finalized();
        return false;
      }),
      recordEvent: vi.fn(async () => undefined),
      captureJobMemoryForLease,
      ...overrides,
    });
    return { client, order, done, captureJobMemoryForLease };
  }

  async function runCapture(
    client: MuonApiClient,
    done: Promise<void>,
    execute: unknown
  ) {
    const controller = new AbortController();
    const loop = runRunnerLoop(client, {
      host: "test-host",
      pid: 777,
      leaseToken: LEASE_TOKEN,
      apiBase: "http://localhost:4000",
      pollMs: 1,
      heartbeatMs: 10_000,
      execute: execute as never,
      signal: controller.signal,
      onLog: () => undefined,
    });
    await done;
    controller.abort();
    await loop;
  }

  it("commits the terminal (releasing the seat) BEFORE mining, and still mines", async () => {
    const { client, order, done, captureJobMemoryForLease } = captureClient();
    const execute = vi.fn(async () => ({
      status: "done" as const,
      exitCode: 0,
      result: "turn complete",
      capture: {
        taskId: "task-1",
        laneId: "lane-1",
        chatId: "chat-3",
        vendor: "claude-code",
        cwd: process.cwd(),
        brief: "do the thing",
        output: "a completed thought worth remembering, at length",
      },
    }));

    await runCapture(client, done, execute);

    // The whole point: the seat-releasing terminal write happens first.
    expect(order).toEqual(["terminal", "mine"]);
    expect(captureJobMemoryForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.objectContaining({
          kind: "attempt",
          outcome: "worked",
          text: expect.stringContaining("Execution worked"),
        }),
      })
    );
  });

  it("records an interrupted vendor attempt as unknown even without a mineable capture", async () => {
    const { client, done, captureJobMemoryForLease } = captureClient();
    const execute = vi.fn(async () => ({
      status: "interrupted" as const,
      result: "runner lease changed",
    }));

    await runCapture(client, done, execute);

    expect(captureJobMemoryForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.objectContaining({
          kind: "attempt",
          outcome: "unknown",
          text: expect.stringContaining("Execution unknown"),
        }),
      })
    );
  });

  it("does not mine when the terminal write was FENCED by a successor lease", async () => {
    const getMemoryMining = vi.fn(async () => false);
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const { client } = captureClient({
      updateDispatchJobForLease: vi.fn(async () => {
        finalized();
        throw new Error("409 fenced by a successor lease");
      }),
      getMemoryMining,
    });
    const execute = vi.fn(async () => ({
      status: "done" as const,
      exitCode: 0,
      result: "turn complete",
      capture: {
        taskId: "task-1",
        laneId: "lane-1",
        chatId: "chat-3",
        vendor: "claude-code",
        cwd: process.cwd(),
        brief: "do the thing",
        output: "a completed thought worth remembering, at length",
      },
    }));

    await runCapture(client, done, execute);

    // A fenced terminal means a successor owns this job; writing its memory
    // here would be a second process speaking for work we no longer own.
    expect(getMemoryMining).not.toHaveBeenCalled();
  });

  it("surfaces a mining failure as a degraded task.progress event, still after the terminal", async () => {
    const recordEvent = vi.fn(async () => undefined);
    let finalized!: () => void;
    const done = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    const { client, order } = captureClient({
      // A REFUSED credential (401) is the fail-closed branch, and it must stay
      // loud now that it runs in the background.
      getMemoryMining: vi.fn(async () => {
        order.push("mine");
        // A REFUSED credential, not an outage: `isAuthorizationFailure` keys on
        // the typed 401/403, and only that branch fails closed WITHOUT running
        // a vendor extractor.
        throw new MuonApiHttpError(403, "Forbidden", "403 Forbidden");
      }),
      recordEvent: vi.fn(async (event: { kind?: string }) => {
        await recordEvent(event as never);
        finalized();
        return undefined;
      }),
    });
    const execute = vi.fn(async () => ({
      status: "done" as const,
      exitCode: 0,
      result: "turn complete",
      capture: {
        taskId: "task-1",
        laneId: "lane-1",
        chatId: "chat-3",
        vendor: "claude-code",
        cwd: process.cwd(),
        brief: "do the thing",
        output: "a completed thought worth remembering, at length",
      },
    }));

    await runCapture(client, done, execute);

    expect(order).toEqual(["terminal", "mine"]);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task.progress",
        metadata: expect.objectContaining({
          memoryCapture: "degraded",
          stage: "mining-auth",
        }),
      })
    );
  });
});
