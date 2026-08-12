import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emptyHarnessConfig,
  type MuonApiClient,
} from "@muon/client";
import {
  BUDGET_EXHAUSTED_MARKER,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  PRE_LAUNCH_INTERRUPT_RESULTS,
  STREAM_MESSAGE_CONTENT_CHARS,
  isBudgetExhausted,
  isPreLaunchInterrupt,
  laneProfileSchema,
} from "@muon/protocol";

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
}));
const preflightMocks = vi.hoisted(() => ({
  verifyEditPreflightCoverage: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    startManagedSession: coreMocks.startManagedSession,
    runLaneTask: coreMocks.runLaneTask,
    runLoop: coreMocks.runLoop,
  };
});
vi.mock("../src/preflight-coverage.js", () => ({
  verifyEditPreflightCoverage:
    preflightMocks.verifyEditPreflightCoverage,
}));

import {
  executeJob,
  resolveStallWindows,
  runPendingCapture,
} from "../src/execute.js";

/**
 * B2: memory capture is DEFERRED past the terminal write, so a test that
 * measures what the brain learned has to drive the same second step the runner
 * does. The sink mirrors the runner's lease sink; a non-chat job's partition is
 * derived server-side, so nothing is passed here.
 */
async function drainCapture(
  client: { addMemoryNoteWithAction: (input: never) => Promise<unknown> },
  result: { capture?: Parameters<typeof runPendingCapture>[1] }
): Promise<void> {
  if (!result.capture) return;
  await runPendingCapture(client as never, result.capture, {
    sink: {
      addMemoryNoteWithAction: (candidate) =>
        client.addMemoryNoteWithAction(candidate as never) as Promise<{
          action: string;
        }>,
    },
  });
}

beforeEach(() => {
  preflightMocks.verifyEditPreflightCoverage.mockReset();
  preflightMocks.verifyEditPreflightCoverage.mockResolvedValue({
    ok: true,
    changedFiles: [],
    coveredFiles: [],
    uncoveredFiles: [],
  });
});

// A delegation deadline safely in the future: the old hard-coded 2026-07-16
// literal became a time bomb the day it passed.
const TEST_DELEGATION_DEADLINE = new Date(
  Date.now() + 60 * 60 * 1000
).toISOString();

describe("executeJob lease launch fence", () => {
  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.startManagedSession.mockRejectedValue(
      new Error("interactive vendor launch must not be reached")
    );
  });

  it("does not launch an interactive vendor after authority is lost during setup", async () => {
    const controller = new AbortController();
    const client = {
      listLanes: vi.fn(async () => {
        controller.abort();
        return [{ id: "lane-1", key: "claude-code" }];
      }),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const result = await executeJob(
      client,
      {
        id: "job-1",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-1",
        brief: "do the thing",
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
      }
    );

    expect(result).toMatchObject({
      status: "interrupted",
      result: expect.stringMatching(/authority|lease/i),
    });
    // The pre-launch literal is the shared protocol constant (byte-identical),
    // so a resume planner can classify this row as provably-unstarted.
    expect(PRE_LAUNCH_INTERRUPT_RESULTS).toContain(result.result);
    expect(isPreLaunchInterrupt(result.result)).toBe(true);
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });

  it("wires the checkpoint ledger: jobId rides into the session and consume maps to the client (P0.1 Slice A)", async () => {
    const controller = new AbortController();
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt: vi.fn(async () => undefined),
        wait: async () => ({ exitCode: 0, output: "" }),
      },
    });
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const requestApproval = vi.fn(async () => ({
      id: "approval-9",
      status: "pending",
    }));
    const consumeCommandApproval = vi.fn(async () => undefined);
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => {
        controller.abort();
        markUpdateStarted();
        await updateGate;
        return {};
      }),
      recordEvent: vi.fn(async () => undefined),
      requestApproval,
      consumeCommandApproval,
    } as unknown as MuonApiClient;

    const execution = executeJob(
      client,
      {
        id: "job-1",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-1",
        brief: "do the thing",
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
      }
    );

    await updateStarted;
    await Promise.resolve();

    const [ledger, sessionInput] =
      coreMocks.startManagedSession.mock.calls[0]!;
    // The job binding rides into the managed session (→ LaneSession.jobId)…
    expect(sessionInput).toMatchObject({ jobId: "job-1" });
    // …the ledger maps the single-use delivery stamp onto the client…
    await ledger.consumeApproval("approval-9");
    expect(consumeCommandApproval).toHaveBeenCalledWith("approval-9");
    // …and the session gate carries its job binding onto the wire.
    await ledger.requestApproval({
      taskId: "task-1",
      requestedBy: "claude-code",
      kind: "command",
      reason: "session tool 'Bash' (session session-1)",
      evidence: {
        action: "Bash",
        scope: "Command: npm test",
        riskLevel: "high",
        impactIfApproved:
          "Runs a shell command in the selected workspace and may read, modify, or delete files.",
        details: {},
      },
      jobId: "job-1",
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1" })
    );

    releaseUpdate();
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("interrupts a managed session while agent-session persistence is still pending", async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined);
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt,
        wait: async () => ({ exitCode: 0, output: "" }),
      },
    });

    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => {
        controller.abort();
        markUpdateStarted();
        await updateGate;
        return {};
      }),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const execution = executeJob(
      client,
      {
        id: "job-1",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-1",
        brief: "do the thing",
        resumeVendorSessionId: "claude-session-42",
        approvalTimeoutMs: 90_000,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
      }
    );

    await updateStarted;
    await Promise.resolve();
    expect(coreMocks.startManagedSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resumeVendorSessionId: "claude-session-42",
        approvalTimeoutMs: 90_000,
      })
    );
    expect(interrupt).toHaveBeenCalledOnce();

    releaseUpdate();
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("enforces the immediate session wall-clock cap before the root deadline", async () => {
    const controller = new AbortController();
    let sessionSignal!: AbortSignal;
    coreMocks.startManagedSession.mockImplementation(async (_ledger, input) => {
      sessionSignal = input.signal;
      return {
        sessionId: "session-budget",
        handle: {
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "late completion" }),
        },
      };
    });
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => {
        markUpdateStarted();
        await updateGate;
        return {};
      }),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const execution = executeJob(
      client,
      {
        id: "job-budget",
        kind: "session",
        vendor: "codex",
        taskId: "task-budget",
        chatId: "chat-budget",
        brief: "finish within the child cap",
        workspacePath: workspace,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 2,
        maxWallMs: 20,
        delegationDeadline: deadlineAt,
        delegationManifest: {
          version: 1,
          jobId: "job-budget",
          workspacePath: workspace,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 2,
          deadlineAt,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        signal: controller.signal,
        steerPollMs: 1,
      }
    );

    await updateStarted;
    await new Promise((resolve) => setTimeout(resolve, 35));
    try {
      expect(sessionSignal.aborted).toBe(true);
    } finally {
      controller.abort();
      releaseUpdate();
    }
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });
  });

  it("lease-requeues a drained steer when the live session rejects delivery", async () => {
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-steer",
      handle: {
        send: vi.fn(async () => {
          throw new Error("session closed");
        }),
        interrupt: async () => undefined,
        wait: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { exitCode: 0, output: "session settled" };
        },
      },
    });
    const requeueDispatchSteer = vi.fn(async () => undefined);
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi
        .fn()
        .mockResolvedValueOnce(["preserve this instruction"])
        .mockResolvedValue([]),
      requeueDispatchSteer,
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
    const runnerLease = {
      host: "desktop-mac",
      leaseToken: `lease-${"a".repeat(58)}`,
    };

    await executeJob(
      client,
      {
        id: "job-steer",
        kind: "session",
        vendor: "codex",
        taskId: "task-steer",
        brief: "accept a follow-up",
        workspacePath: process.cwd(),
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease,
        steerPollMs: 1,
      }
    );

    expect(requeueDispatchSteer).toHaveBeenCalledWith(
      "job-steer",
      "preserve this instruction",
      runnerLease
    );
  });

  it("records exact context before transport and appends delivery after acceptance", async () => {
    const order: string[] = [];
    coreMocks.startManagedSession.mockImplementation(async (_ledger, input) => {
      order.push("transport");
      return {
        sessionId: "session-context",
        handle: {
          vendorSessionId: "thread-context",
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "done" }),
        },
      };
    });
    const beginContextFrameForLease = vi.fn(async (input) => {
      order.push("begin");
      return {
        id: "frame-context",
        clientRequestId: input.clientRequestId,
        jobId: "job-context",
        taskId: "task-context",
        laneId: "lane-1",
        missionId: "job-context",
        turnSeq: 1,
        source: input.source,
        completeness: "muon_supplied",
        content: input.content,
        contentSha256: `sha256:${"a".repeat(64)}`,
        charCount: input.content.length,
        tokenEstimate: 1,
        createdAt: "2026-08-01T00:00:00.000Z",
        exposures: [],
        delivery: null,
      } as never;
    });
    const completeContextFrameForLease = vi.fn(async (input) => {
      order.push(`receipt:${input.status}`);
      return {} as never;
    });
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      recordDispatchExecutionPathForLease: vi.fn(async () => ({})),
      beginContextFrameForLease,
      completeContextFrameForLease,
      recordContextCondensationForLease: vi.fn(async () => ({})),
    } as unknown as MuonApiClient;
    const runnerLease = {
      host: "desktop-mac",
      leaseToken: `lease-${"e".repeat(58)}`,
    };

    const result = await executeJob(
      client,
      {
        id: "job-context",
        kind: "session",
        vendor: "codex",
        taskId: "task-context",
        brief: "preserve this exact goal",
        workspacePath: process.cwd(),
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "human:operator",
      },
      { id: "agent-context", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        runnerLease,
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    expect(order.slice(0, 3)).toEqual([
      "begin",
      "transport",
      "receipt:delivered",
    ]);
    const exactDeliveredBrief = coreMocks.startManagedSession.mock.calls[0]![1]
      .brief as string;
    expect(beginContextFrameForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-context",
        host: runnerLease.host,
        leaseToken: runnerLease.leaseToken,
        source: "dispatch",
        content: exactDeliveredBrief,
      })
    );
    expect(completeContextFrameForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        frameId: "frame-context",
        status: "delivered",
        sessionId: "session-context",
        vendorSessionId: "thread-context",
      })
    );
  });

  it("compiles a deny-first Codex orchestrator profile and streams under the chat", async () => {
    coreMocks.startManagedSession.mockImplementation(async (_ledger, input) => {
      input.onEvent({
        laneId: "lane-1",
        taskId: "task-shadow",
        kind: "task.progress",
        message: "dispatching child",
        timestamp: "2026-07-16T00:00:00.000Z",
        metadata: {},
      });
      return {
        sessionId: "session-1",
        handle: {
          vendorSessionId: "codex-thread-42",
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "dispatching child" }),
        },
      };
    });
    const recordStreamChunks = vi.fn(async () => ({ recorded: 1 }));
    const updateChat = vi.fn(async () => ({}));
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks,
      updateChat,
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const result = await executeJob(
      client,
      {
        id: "job-chat",
        kind: "session",
        vendor: "codex",
        taskId: "task-shadow",
        chatId: "chat-1",
        brief: "orchestrate",
        workspacePath: workspace,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: deadlineAt,
        delegationManifest: {
          version: 1,
          jobId: "job-chat",
          workspacePath: workspace,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    const muon = sessionInput.profile.mcpServers.find(
      (server: { name: string }) => server.name === "muon"
    );
    expect(muon.env).toMatchObject({
      MUON_MCP_MODE: "orchestrator",
      MUON_CHAT_ID: "chat-1",
      MUON_CHAT_TASK_ID: "task-shadow",
      MUON_WORKSPACE: workspace,
    });
    // The orchestrator is structurally read/plan/delegate-only. Native file
    // tools would bypass worktree isolation and pre-edit enforcement.
    const expectedMcp = MUON_ORCHESTRATOR_TOOL_NAMES.map(
      (name) => `mcp__muon__${name}`
    );
    expect(sessionInput.profile.allowedTools).toEqual(expectedMcp);
    expect(sessionInput.profile.allowedTools).not.toEqual(
      expect.arrayContaining(["Read", "Write", "Edit"])
    );
    // The whole MCP control inventory is still present and exactly-named…
    for (const tool of expectedMcp) {
      expect(sessionInput.profile.allowedTools).toContain(tool);
    }
    // …and the deny-first posture holds: no wildcard, no bare MCP-server grant,
    // and NOTHING that can shell out or reach the network (no Bash).
    expect(sessionInput.profile.allowedTools).not.toContain("mcp__muon");
    expect(sessionInput.profile.allowedTools).not.toContain("Bash");
    expect(
      sessionInput.profile.allowedTools.every(
        (name: string) => !name.includes("*")
      )
    ).toBe(true);
    // Native Codex children would bypass MUON's exact-job delegation token,
    // lineage, workspace, and budget enforcement.
    expect(sessionInput.profile.rawConfig).toEqual({
      "features.multi_agent": false,
    });
    // (ii) companion: the coordinator session is flagged so an UN-granted tool
    // fast-denies instead of 300s-hanging (proven end-to-end in session-manager).
    expect(sessionInput.noInteractiveApprover).toBe(true);
    expect(recordStreamChunks).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: "chat-1",
        laneId: "muon-chat",
        runId: "job-chat",
        content: "dispatching child",
      }),
    ]);
    // Codex threads are not resumable and therefore never become chat
    // continuity authority.
    expect(updateChat).not.toHaveBeenCalled();
  });

  it("EXCLUDES a stored worker-lane grant (Glob) from the orchestrator grant (no lane-grant leak)", async () => {
    // SECURITY FIX: the orchestrator chat runs on the SHARED vendor lane
    // (CHAT_LANE_KEY) with an always-empty harness, so applyHarnessToProfile
    // yields baseProfile.allowedTools === the raw USER worker-lane profile. If the
    // operator pre-authorized a tool there (`Glob`, `Bash`, `*`), spreading
    // baseProfile.allowedTools into the union would silently promote it into the
    // UNWATCHED coordinator's SDK-preauthorized grant — bypassing bridgeApproval/
    // fast-deny (an SDK-preauthorized tool never reaches canUseTool). The grant is
    // therefore bounded to EXACTLY the MCP inventory; a stored `Glob` is
    // dropped. Modelled here as a stored lane profile carrying `Glob`.
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-1",
      handle: {
        vendorSessionId: "claude-session-42",
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "orchestrated" }),
      },
    });
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({
        // A worker lane an operator pre-authorized: a stored tool grant AND a
        // gate-bypassing permissionMode. NEITHER may leak onto the coordinator.
        //
        // `full-auto` is MUON's normalized gate-bypassing mode (it compiles to
        // claude `bypassPermissions` / codex `never`). The vendor-native spelling
        // `"bypassPermissions"` is NOT in `permissionModeSchema`, so using it
        // here made `laneProfileSchema.parse` throw INSIDE this async mock; the
        // rejection was swallowed by executeJob's `.catch(() => undefined)` and
        // the test then asserted against no stored profile at all — passing
        // vacuously while proving nothing about leakage.
        profile: laneProfileSchema.parse({
          allowedTools: ["Glob"],
          permissionMode: "full-auto",
        }),
      })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      updateChat: vi.fn(async () => ({})),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const result = await executeJob(
      client,
      {
        id: "job-chat",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-shadow",
        chatId: "chat-1",
        brief: "orchestrate",
        workspacePath: workspace,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: deadlineAt,
        delegationManifest: {
          version: 1,
          jobId: "job-chat",
          workspacePath: workspace,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    const allowedTools =
      coreMocks.startManagedSession.mock.calls[0]![1].profile.allowedTools;
    // The stored worker-lane grant is EXCLUDED — no lane-grant leak into the
    // unwatched coordinator.
    expect(allowedTools).not.toContain("Glob");
    // The grant is EXACTLY the governed coordinator MCP inventory.
    const expectedMcp = MUON_ORCHESTRATOR_TOOL_NAMES.map(
      (name) => `mcp__muon__${name}`
    );
    expect(allowedTools).toEqual(expectedMcp);
    expect(allowedTools).not.toEqual(
      expect.arrayContaining(["Read", "Write", "Edit"])
    );
    // No duplicates (Set-deduped), no wildcard, and nothing that can shell out.
    expect(new Set(allowedTools).size).toBe(allowedTools.length);
    expect(allowedTools.every((name: string) => !name.includes("*"))).toBe(true);
    expect(allowedTools).not.toContain("Bash");
    // And the OTHER authority axis: the stored lane's gate-bypassing
    // permissionMode does NOT leak — the coordinator runs must-ask "default".
    expect(
      coreMocks.startManagedSession.mock.calls[0]![1].profile.permissionMode
    ).toBe("default");
    expect(client.updateChat).toHaveBeenCalledWith({
      chatId: "chat-1",
      vendorSessionId: "claude-session-42",
      vendorSessionVendor: "claude-code",
      vendorSessionRootJobId: "job-chat",
    });
  });

  it("REFUSES launch when the computed orchestrator grant is wider than the bounded set", async () => {
    // Defense-in-depth mirror of the delegate exactTools guard: even if a later
    // step re-widens the coordinator past its MCP inventory — here a
    // hand-crafted actionProfilePatch, which mergeProfilePatch APPENDS onto
    // allowedTools — the over-capability assertion refuses launch fail-closed. The
    // unwatched coordinator never reaches the vendor with an extra pre-authorized
    // tool (here `Bash`).
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      updateChat: vi.fn(async () => ({})),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const result = await executeJob(
      client,
      {
        id: "job-chat",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-shadow",
        chatId: "chat-1",
        brief: "orchestrate",
        workspacePath: workspace,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: deadlineAt,
        delegationManifest: {
          version: 1,
          jobId: "job-chat",
          workspacePath: workspace,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        // Over-wide: an appended allowedTools grant the assertion must catch.
        actionProfilePatch: { allowedTools: ["Bash"] },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toContain(
      "wider than the read/plan/delegate coordinator grant"
    );
    // The over-capability guard fires BEFORE any vendor launch.
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });

  it("attests the exact work-only delegate profile before launching a child", async () => {
    coreMocks.startManagedSession.mockImplementation(async (_ledger, input) => {
      input.onEvent({
        laneId: "lane-1",
        taskId: "task-child",
        kind: "task.progress",
        message: "private worker output",
        timestamp: "2026-07-16T00:00:00.000Z",
        metadata: {},
      });
      return {
        sessionId: "session-child",
        handle: {
          vendorSessionId: "child-thread",
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "child done" }),
        },
      };
    });
    const recordStreamChunks = vi.fn(async () => ({ recorded: 0 }));
    const updateChat = vi.fn(async () => ({}));
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({
        profile: {
          permissionMode: "full-auto",
          rawConfig: { dangerous: true },
          mcpServers: [
            {
              name: "ambient",
              command: "ambient-mcp",
              args: [],
              env: {},
            },
          ],
        },
      })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks,
      updateChat,
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
    const workspace = process.cwd();
    const manifest = {
      version: 1 as const,
      rootJobId: "job-root",
      parentJobId: "job-parent",
      jobId: "job-child",
      depth: 2,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      rootWorkspace: workspace,
      workspacePath: workspace,
      budget: { maxWallMs: 120_000 },
      deadlineAt: TEST_DELEGATION_DEADLINE,
      delegationIterationCap: 3,
      authority: "work" as const,
      forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
      canDelegate: true,
      propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
      narrowingAttested: true as const,
    };

    const result = await executeJob(
      client,
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        chatId: "chat-1",
        brief: "fix parser",
        workspacePath: workspace,
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 3,
        maxWallMs: 120_000,
        delegationDeadline: TEST_DELEGATION_DEADLINE,
        capabilityMode: "delegate",
        delegationManifest: manifest,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "child-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
    expect(profile.allowedTools).toEqual(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES.map(
        (name) => `mcp__muon__${name}`
      )
    );
    expect(profile.allowedTools).not.toContain("mcp__muon__set_fleet");
    expect(profile.mcpServers.map((server: { name: string }) => server.name)).toEqual([
      "muon",
    ]);
    expect(profile.permissionMode).not.toBe("full-auto");
    expect(profile.rawConfig).toEqual({});
    const muon = profile.mcpServers.find(
      (server: { name: string }) => server.name === "muon"
    );
    expect(muon.env).toMatchObject({
      MUON_MCP_MODE: "delegate",
      MUON_DELEGATE_CAN_SPAWN: "true",
      MUON_JOB_ID: "job-child",
      MUON_PARENT_JOB_ID: "job-parent",
      MUON_ROOT_JOB_ID: "job-root",
      MUON_DELEGATION_DEPTH: "2",
      // #126: the delegate (WORKER-tier) MCP env MUST carry the chat id, not just
      // the orchestrator. Without this a delegate sub-agent's memory_add/search/
      // recall/preedit ran with MUON_CHAT_ID unset → writes landed chatId=NULL and
      // the cross-chat leak silently persisted (the #1 risk). Inherited from the
      // root chat via job.chatId → the base MUON MCP env.
      MUON_CHAT_ID: "chat-1",
    });
    expect(recordStreamChunks).toHaveBeenCalledWith([
      expect.objectContaining({
        taskId: "task-child",
        laneId: "lane-1",
        runId: "job-child",
        content: "private worker output",
      }),
    ]);
    expect(recordStreamChunks).not.toHaveBeenCalledWith([
      expect.objectContaining({ taskId: "chat-1", laneId: "muon-chat" }),
    ]);
    // A child session can never overwrite coordinator continuity.
    expect(updateChat).not.toHaveBeenCalled();
  });

  // ── S6: a delegate child may carry a {model} override ────────────────────────
  function delegateModelClient(): MuonApiClient {
    return {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({
        profile: {
          permissionMode: "full-auto",
          rawConfig: { dangerous: true },
          mcpServers: [
            { name: "ambient", command: "ambient-mcp", args: [], env: {} },
          ],
        },
      })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
  }

  function delegateModelManifest(workspace: string) {
    return {
      version: 1 as const,
      rootJobId: "job-root",
      parentJobId: "job-parent",
      jobId: "job-child",
      depth: 2,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      rootWorkspace: workspace,
      workspacePath: workspace,
      budget: { maxWallMs: 120_000 },
      deadlineAt: TEST_DELEGATION_DEADLINE,
      delegationIterationCap: 3,
      authority: "work" as const,
      forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
      canDelegate: true,
      propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
      narrowingAttested: true as const,
    };
  }

  it("applies a validated {model} override to a delegate child and still attests narrowing", async () => {
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-child",
      handle: {
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "child done" }),
      },
    });
    const workspace = process.cwd();
    const result = await executeJob(
      delegateModelClient(),
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        chatId: "chat-1",
        brief: "fix parser",
        workspacePath: workspace,
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 3,
        maxWallMs: 120_000,
        delegationDeadline: TEST_DELEGATION_DEADLINE,
        capabilityMode: "delegate",
        delegationManifest: delegateModelManifest(workspace),
        // The ONLY action column a delegate child ever carries (route-enforced).
        actionProfilePatch: { model: "gpt-5-codex" },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "child-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
    // The model rode through, and the narrowed capability set is byte-identical.
    expect(profile.model).toBe("gpt-5-codex");
    expect(profile.permissionMode).not.toBe("full-auto");
    expect(profile.rawConfig).toEqual({});
    expect(profile.allowedTools).toEqual(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES.map((name) => `mcp__muon__${name}`)
    );
    expect(
      profile.mcpServers.map((server: { name: string }) => server.name)
    ).toEqual(["muon"]);
  });

  it("picks ONLY {model} from a wider delegate actionProfilePatch (defensive narrowing)", async () => {
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-child",
      handle: {
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "child done" }),
      },
    });
    const workspace = process.cwd();
    const result = await executeJob(
      delegateModelClient(),
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        chatId: "chat-1",
        brief: "fix parser",
        workspacePath: workspace,
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 3,
        maxWallMs: 120_000,
        delegationDeadline: TEST_DELEGATION_DEADLINE,
        capabilityMode: "delegate",
        delegationManifest: delegateModelManifest(workspace),
        // A hostile/wider patch on the row: the runner must apply ONLY {model}
        // so none of these can widen the narrowed delegate profile.
        actionProfilePatch: {
          model: "gpt-5-codex",
          permissionMode: "full-auto",
          rawConfig: { dangerous: true },
          extraArgs: ["--dangerously-skip-permissions"],
          allowedTools: ["mcp__muon__set_fleet"],
          mcpServers: [
            { name: "evil", command: "evil-mcp", args: [], env: {} },
          ],
        } as unknown as Record<string, unknown>,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "child-job-token",
        steerPollMs: 1,
      }
    );

    // The child still launches (attestation passes) with ONLY the model applied.
    expect(result.status).toBe("done");
    const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
    expect(profile.model).toBe("gpt-5-codex");
    expect(profile.permissionMode).not.toBe("full-auto");
    expect(profile.rawConfig).toEqual({});
    expect(profile.extraArgs).toEqual([]);
    expect(profile.allowedTools).not.toContain("mcp__muon__set_fleet");
    expect(profile.allowedTools).toEqual(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES.map((name) => `mcp__muon__${name}`)
    );
    expect(
      profile.mcpServers.map((server: { name: string }) => server.name)
    ).toEqual(["muon"]);
  });

  it("launches a leaf delegate with context-only MCP and no delegation token", async () => {
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-leaf",
      handle: {
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "leaf done" }),
      },
    });
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const propagatedTools = MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
      (name) => name !== "delegate"
    );

    const result = await executeJob(
      client,
      {
        id: "job-leaf",
        kind: "session",
        vendor: "codex",
        taskId: "task-leaf",
        brief: "finish the bounded leaf task",
        workspacePath: workspace,
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 3,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 2,
        maxWallMs: 120_000,
        delegationDeadline: deadlineAt,
        capabilityMode: "delegate",
        delegationManifest: {
          version: 1,
          rootJobId: "job-root",
          parentJobId: "job-parent",
          jobId: "job-leaf",
          depth: 3,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          rootWorkspace: workspace,
          workspacePath: workspace,
          budget: { maxWallMs: 120_000 },
          deadlineAt,
          delegationIterationCap: 2,
          authority: "work",
          forbiddenAuthority: ["govern", "approve", "merge", "ship"],
          canDelegate: false,
          propagatedTools,
          narrowingAttested: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
    expect(profile.allowedTools).toEqual(
      propagatedTools.map((name) => `mcp__muon__${name}`)
    );
    const muon = profile.mcpServers[0];
    expect(muon.env).toMatchObject({
      MUON_MCP_MODE: "delegate",
      MUON_DELEGATE_CAN_SPAWN: "false",
    });
    expect(muon.env).not.toHaveProperty("MUON_DELEGATION_TOKEN");
  });

  it("refuses a governed workspace that was retargeted after dispatch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "muon-runner-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "muon-runner-outside-"));
    const workspace = path.join(root, "work");
    mkdirSync(workspace);
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    rmSync(workspace, { recursive: true });
    symlinkSync(outside, workspace);
    try {
      const client = {
        listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
        getTaskDetail: vi.fn(async () => undefined),
        getLaneProfile: vi.fn(async () => ({ profile: undefined })),
        recallRelatedToTask: vi.fn(async () => []),
        markMemoryUsed: vi.fn(async () => undefined),
      } as unknown as MuonApiClient;
      const result = await executeJob(
        client,
        {
          id: "job-child",
          kind: "session",
          vendor: "codex",
          taskId: "task-child",
          brief: "escape after validation",
          workspacePath: workspace,
          parentJobId: "job-root",
          rootJobId: "job-root",
          delegationDepth: 1,
          maxDelegationDepth: 3,
          maxChildren: 3,
          maxTotalDescendants: 8,
          maxDelegationIterations: 2,
          maxWallMs: 120_000,
          delegationDeadline: deadlineAt,
          capabilityMode: "delegate",
          delegationManifest: {
            version: 1,
            rootJobId: "job-root",
            parentJobId: "job-root",
            jobId: "job-child",
            depth: 1,
            maxDepth: 3,
            maxChildrenPerParent: 3,
            maxTotalDescendants: 8,
            rootWorkspace: root,
            workspacePath: workspace,
            budget: { maxWallMs: 120_000 },
            deadlineAt,
            delegationIterationCap: 2,
            authority: "work",
            forbiddenAuthority: ["govern", "approve", "merge", "ship"],
            canDelegate: false,
            propagatedTools: MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
              (name) => name !== "delegate"
            ),
            narrowingAttested: true,
          },
          status: "running",
          interruptRequested: false,
          steerMessages: [],
          dispatchedBy: "agent:delegate",
        },
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000" }
      );

      expect(result).toMatchObject({
        status: "failed",
        result: expect.stringMatching(/workspace|canonical|retarget/i),
      });
      expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses launch after the absolute delegation deadline", async () => {
    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() - 1_000).toISOString();
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
    const result = await executeJob(
      client,
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        brief: "run too late",
        workspacePath: workspace,
        parentJobId: "job-root",
        rootJobId: "job-root",
        delegationDepth: 1,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 2,
        maxWallMs: 120_000,
        delegationDeadline: deadlineAt,
        capabilityMode: "delegate",
        delegationManifest: {
          version: 1,
          rootJobId: "job-root",
          parentJobId: "job-root",
          jobId: "job-child",
          depth: 1,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          rootWorkspace: workspace,
          workspacePath: workspace,
          budget: { maxWallMs: 120_000 },
          deadlineAt,
          delegationIterationCap: 2,
          authority: "work",
          forbiddenAuthority: ["govern", "approve", "merge", "ship"],
          canDelegate: false,
          propagatedTools: MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
            (name) => name !== "delegate"
          ),
          narrowingAttested: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result).toMatchObject({
      status: "interrupted",
      result: expect.stringMatching(/deadline/i),
    });
    // Byte-identical to the shared protocol constant: this refusal is one of
    // the three provably-unstarted pre-launch interrupts.
    expect(PRE_LAUNCH_INTERRUPT_RESULTS).toContain(result.result);
    expect(isPreLaunchInterrupt(result.result)).toBe(true);
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });

  it("fails closed before vendor launch when child narrowing is malformed", async () => {
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;

    const result = await executeJob(
      client,
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        brief: "fix parser",
        workspacePath: "/repo",
        capabilityMode: "delegate",
        delegationManifest: {
          authority: "govern",
        } as never,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/narrowing|attest/i),
    });
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });

  it("fails closed when a valid manifest does not match persisted child scope", async () => {
    const client = {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    } as unknown as MuonApiClient;
    const manifest = {
      version: 1 as const,
      rootJobId: "job-root",
      parentJobId: "job-parent",
      jobId: "different-child",
      depth: 2,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      rootWorkspace: "/repo",
      workspacePath: "/repo",
      budget: { maxWallMs: 120_000 },
      deadlineAt: TEST_DELEGATION_DEADLINE,
      delegationIterationCap: 3,
      authority: "work" as const,
      forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
      canDelegate: false,
      propagatedTools: MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
        (name) => name !== "delegate"
      ),
      narrowingAttested: true as const,
    };

    const result = await executeJob(
      client,
      {
        id: "job-child",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child",
        brief: "fix parser",
        workspacePath: "/repo",
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 2,
        capabilityMode: "delegate",
        delegationManifest: manifest,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/manifest|scope|lineage/i),
    });
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });
});

describe("executeJob terminal handoff packets (P0.3)", () => {
  beforeEach(() => {
    coreMocks.runLaneTask.mockReset();
    coreMocks.startManagedSession.mockReset();
    coreMocks.startManagedSession.mockRejectedValue(
      new Error("interactive vendor launch must not be reached")
    );
  });

  function oneShotClient() {
    return {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getHarness: vi.fn(async () => ({ config: emptyHarnessConfig })),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    } as unknown as MuonApiClient;
  }

  function oneShotJob(brief = "Do the bounded one-shot task") {
    return {
      id: "job-os",
      kind: "oneshot" as const,
      vendor: "codex",
      taskId: "task-os",
      brief,
      status: "running",
      interruptRequested: false,
      steerMessages: [],
      dispatchedBy: "orchestrator",
    };
  }

  it("emits an honestly degraded packet from a one-shot terminal (no checks, no worktree)", async () => {
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: "did the thing",
      errorOutput: "",
      durationMs: 5,
    });

    const result = await executeJob(
      oneShotClient(),
      oneShotJob(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    // v1 prose result unchanged.
    expect(result.result).toBe("did the thing");
    expect(result.packet).toBeDefined();
    const packet = result.packet!;
    expect(packet.schemaVersion).toBe(2);
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("no_check_evidence");
    expect(packet.degraded.reasons).toContain("no_diff_evidence");
    expect(packet.diffVerified).toBe(false);
    expect(packet.recommendedNextAction).toContain("task-os");
  });

  it("fails a shell-green implement terminal when changed files lack verified preflight coverage", async () => {
    const client = oneShotClient();
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: "implemented without preflight",
      errorOutput: "",
      durationMs: 5,
    });
    preflightMocks.verifyEditPreflightCoverage.mockResolvedValue({
      ok: false,
      changedFiles: ["src/change.ts"],
      coveredFiles: [],
      uncoveredFiles: ["src/change.ts"],
      reason:
        "No verified preflight_edit evidence was recorded for this job.",
    });

    const result = await executeJob(
      client,
      {
        ...oneShotJob(),
        harnessKey: "implement",
      },
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toMatch(/MUON completion gate/i);
    expect(preflightMocks.verifyEditPreflightCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        taskId: "task-os",
        jobId: "job-os",
        nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(client.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task.blocked",
        metadata: expect.objectContaining({
          jobId: "job-os",
          uncoveredFiles: ["src/change.ts"],
        }),
      })
    );
    expect(result.packet).toMatchObject({
      checksStatus: expect.arrayContaining(["run: blocked"]),
      whatFailed: expect.stringMatching(/preflight_edit/i),
      recommendedNextAction: expect.stringMatching(/preflight_edit/i),
    });
  });

  it("captures the exact final report into the packet and low-trust memory proposals", async () => {
    const client = oneShotClient();
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: `work log
GOAL: Preserve durable worker discoveries.
CHANGED:
- Added a bounded parser.
FAILED: nothing
COMMANDS RUN:
- npm test
CHECKS:
- npm test: passed
CHANGED FILES:
- packages/core/src/worker-final-report.ts
OPEN QUESTIONS:
- Should proposal review show task provenance?
UNCERTAINTIES:
- Threshold calibration still needs realistic fixtures.
NEXT ACTION:
- Review the unconfirmed proposals.
MEMORY PROPOSALS:
- [decision] Parse only the final complete report.
- Untyped lessons remain attempts.`,
      errorOutput: "",
      durationMs: 5,
    });

    const result = await executeJob(
      client,
      oneShotJob(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.packet).toMatchObject({
      openQuestions: ["Should proposal review show task provenance?"],
      uncertainties: ["Threshold calibration still needs realistic fixtures."],
      recommendedNextAction: "Review the unconfirmed proposals.",
      memoryProposals: [
        { kind: "decision", text: "Parse only the final complete report." },
        { kind: "attempt", text: "Untyped lessons remain attempts." },
      ],
    });
    await drainCapture(client, result);
    expect(client.addMemoryNoteWithAction).toHaveBeenCalledTimes(3);
    expect(client.addMemoryNoteWithAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "question",
        text: "Should proposal review show task provenance?",
        trust: "low",
        createdBy: "agent:codex",
      })
    );
    expect(client.addMemoryNoteWithAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "decision",
        text: "Parse only the final complete report.",
        trust: "low",
        createdBy: "agent:codex",
      })
    );
  });

  it("captures an explicit final proposal section even when the full report is incomplete", async () => {
    const client = oneShotClient();
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: `Work completed, but this vendor omitted the leading report labels.
MEMORY PROPOSALS:
- [constraint] Same-chat agent notes remain unconfirmed until governed.
- Objective recall must deduplicate notes by durable id.`,
      errorOutput: "",
      durationMs: 5,
    });

    const result = await executeJob(
      client,
      oneShotJob(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.packet?.memoryProposals).toEqual([
      {
        kind: "constraint",
        text: "Same-chat agent notes remain unconfirmed until governed.",
      },
      {
        kind: "attempt",
        text: "Objective recall must deduplicate notes by durable id.",
      },
    ]);
    await drainCapture(client, result);
    expect(client.addMemoryNoteWithAction).toHaveBeenCalledTimes(2);
    expect(client.addMemoryNoteWithAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "constraint",
        trust: "low",
        modules: [],
      })
    );
  });

  it("reuses confirmed objective memory on a fresh task without injecting unconfirmed proposals", async () => {
    const client = oneShotClient();
    const confirmed = {
      id: "mem-confirmed",
      kind: "constraint",
      text: "Use the durable task ledger as the source of truth.",
      confirmed: true,
      stale: false,
    };
    const unconfirmed = {
      id: "mem-proposal",
      kind: "attempt",
      text: "Unconfirmed cross-agent proposal text.",
      confirmed: false,
      stale: false,
    };
    client.recallRelatedToTask = vi.fn(async () => [confirmed]) as never;
    client.searchMemory = vi.fn(async () => [
      confirmed,
      unconfirmed,
    ]) as never;
    let launchedBrief = "";
    coreMocks.runLaneTask.mockImplementation(async (input) => {
      launchedBrief = input.brief;
      return {
        exitCode: 0,
        output: "MEMORY PROPOSALS: none",
        errorOutput: "",
        durationMs: 5,
      };
    });

    await executeJob(
      client,
      {
        ...oneShotJob(
          "Fix the durable task ledger while preserving its source-of-truth invariant."
        ),
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        jobClient: client,
      }
    );

    expect(client.searchMemory).toHaveBeenCalledWith(
      "Fix the durable task ledger while preserving its source-of-truth invariant.",
      {}
    );
    expect(launchedBrief).toContain(confirmed.text);
    expect(launchedBrief).not.toContain(unconfirmed.text);
    expect(launchedBrief.match(new RegExp(confirmed.text, "g"))).toHaveLength(1);
    expect(client.markMemoryUsed).toHaveBeenCalledWith(
      ["mem-confirmed"],
      "brief_injection"
    );
  });

  // ── ADR-0026 §9: the memory slice states WHICH REPOSITORY it is ─────────────
  //
  // Two claims, and the SECOND is the one that needs a test here rather than in
  // core: the heading's wording is core's (`memory-slice.test.ts`), but WHERE the
  // runner reads the value from is this file's, and getting it wrong is invisible in
  // the rendered string. §4 is explicit that `MUON_WORKSPACE` must not be the source
  // — `execute.ts` remaps it to the governed task WORKTREE for every worker under an
  // editing harness, so a preamble derived from it labels each dispatch with its own
  // throwaway path. The authenticated `DispatchJob.workspacePath` is the source.
  it("labels the memory slice with job.workspacePath, NEVER with MUON_WORKSPACE", async () => {
    const client = oneShotClient();
    const confirmed = {
      id: "mem-ws-label",
      kind: "constraint",
      text: "Charges are idempotent by request key.",
      confirmed: true,
      stale: false,
    };
    client.recallRelatedToTask = vi.fn(async () => [confirmed]) as never;
    client.searchMemory = vi.fn(async () => []) as never;
    let launchedBrief = "";
    coreMocks.runLaneTask.mockImplementation(async (input) => {
      launchedBrief = input.brief;
      return { exitCode: 0, output: "ok", errorOutput: "", durationMs: 5 };
    });

    const previous = process.env.MUON_WORKSPACE;
    // The worktree shape `execute.ts` itself installs for a worker under an editing
    // harness. If the preamble ever read the env var, THIS is what it would say.
    process.env.MUON_WORKSPACE =
      "/Users/dev/SWE/repo-a/.muon/worktrees/task-os";
    try {
      await executeJob(
        client,
        { ...oneShotJob(), workspacePath: "/Users/dev/SWE/repo-a" },
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000", jobClient: client }
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MUON_WORKSPACE;
      } else {
        process.env.MUON_WORKSPACE = previous;
      }
    }

    const heading = launchedBrief
      .split("\n")
      .find((line) => line.startsWith("Shared memory ("));
    expect(heading).toContain("scoped to /Users/dev/SWE/repo-a");
    // The direction that catches the forbidden source: one memory island per
    // dispatch, by construction, on the most common code path.
    expect(heading).not.toContain(".muon/worktrees");
  });

  it("omits the workspace from the slice when the job has none (§5 monotonic)", async () => {
    const client = oneShotClient();
    client.recallRelatedToTask = vi.fn(async () => [
      { id: "m", kind: "constraint", text: "A fact.", confirmed: true, stale: false },
    ]) as never;
    client.searchMemory = vi.fn(async () => []) as never;
    let launchedBrief = "";
    coreMocks.runLaneTask.mockImplementation(async (input) => {
      launchedBrief = input.brief;
      return { exitCode: 0, output: "ok", errorOutput: "", durationMs: 5 };
    });

    await executeJob(
      client,
      oneShotJob(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", jobClient: client }
    );

    // Asserted against the SLICE HEADING, not the whole brief: the worker-discipline
    // preamble already contains the phrase "scoped to this workspace's local graph"
    // (about the CODE graph), and a bare substring check would match that instead.
    const heading = launchedBrief
      .split("\n")
      .find((line) => line.startsWith("Shared memory ("));
    expect(heading).toBeDefined();
    expect(heading).not.toContain("scoped to");
  });

  it("emits no packet when execution is interrupted", async () => {
    const controller = new AbortController();
    coreMocks.runLaneTask.mockImplementation(async () => {
      controller.abort();
      return { exitCode: 0, output: "late", errorOutput: "", durationMs: 5 };
    });

    const result = await executeJob(
      oneShotClient(),
      oneShotJob(),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", signal: controller.signal }
    );

    expect(result.status).toBe("interrupted");
    expect(result.packet).toBeUndefined();
  });

  it("still returns the terminal result when packet building itself fails", async () => {
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: "ok output",
      errorOutput: "",
      durationMs: 5,
    });

    // A 2-char brief violates the packet schema's taskGoal bound: the builder
    // throws, and emission must swallow it without failing the terminal.
    const result = await executeJob(
      oneShotClient(),
      oneShotJob("hm"),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    expect(result.result).toBe("ok output");
    expect(result.packet).toBeUndefined();
  });
});

// ── P0.4 slice 2: workspace policy sourcing + enforcement threading ───────────
//
// The runner is the ONLY place a stored profile enters enforcement, and it is
// degrade-safe by construction: fetch error, missing row, or invalid JSON all
// yield no `policy` input — the session manager then behaves byte-identically
// to today. Delegates and orchestrators NEVER receive policy or workspacePath:
// a policy allow evaluated inside a child could otherwise widen past the
// parent's exact tool manifest.
describe("executeJob policy profile threading (P0.4)", () => {
  const VALID_PROFILE = {
    version: 1,
    label: "seam",
    postures: {
      read: "allow",
      test: "allow",
      edit: "gate",
      network: "gate",
      merge: "gate",
      ship: "gate",
    },
    editInRadius: "allow",
    taskRadius: ["src"],
  };

  function sessionClient(extra: Record<string, unknown> = {}): MuonApiClient {
    return {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      getWorkspacePolicy: vi.fn(async () => ({
        profile: VALID_PROFILE,
        scope: "workspace",
        version: 1,
      })),
      redeemReceipt: vi.fn(async () => ({ redeemed: false })),
      ...extra,
    } as unknown as MuonApiClient;
  }

  function workerJob(extra: Record<string, unknown> = {}) {
    return {
      id: "job-policy",
      kind: "session",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "do the thing",
      workspacePath: process.cwd(),
      checks: [{ name: "tests", command: "npm test" }],
      status: "running",
      interruptRequested: false,
      steerMessages: [],
      dispatchedBy: "orchestrator",
      ...extra,
    } as Parameters<typeof executeJob>[1];
  }

  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "done" }),
      },
    });
  });

  it("fetches, validates, and threads the workspace profile for a worker session", async () => {
    const client = sessionClient();

    const result = await executeJob(
      client,
      workerJob(),
      { id: "agent-1", name: "claude-code-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    expect(result.status).toBe("done");
    expect(
      (client as unknown as { getWorkspacePolicy: ReturnType<typeof vi.fn> })
        .getWorkspacePolicy
    ).toHaveBeenCalledWith({
      workspacePath: process.cwd(),
      taskId: "task-1",
    });
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    expect(sessionInput.workspacePath).toBe(process.cwd());
    expect(sessionInput.policy).toBeDefined();
    expect(sessionInput.policy.profile).toMatchObject({ label: "seam" });
    expect(typeof sessionInput.policy.executionCwd).toBe("string");
    expect(sessionInput.policy.checkCommands).toContain("npm test");
    // (iii) WORKER path unchanged: the orchestrator-only fast-deny flag is NEVER
    // set for a worker, so its human-in-the-loop 300s gate keeps full semantics.
    expect(sessionInput.noInteractiveApprover).toBeFalsy();
  });

  it("maps the ledger's redeemReceipt onto the client and wraps every failure to a miss", async () => {
    const redeemReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        redeemed: true,
        receipt: {
          id: "rcpt-1",
          expiresAt: "2026-07-17T01:00:00.000Z",
          useCount: 1,
        },
      })
      .mockResolvedValueOnce({ redeemed: false })
      .mockRejectedValueOnce(new Error("brain unreachable"));
    const client = sessionClient({ redeemReceipt });

    await executeJob(
      client,
      workerJob(),
      { id: "agent-1", name: "claude-code-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    const [ledger] = coreMocks.startManagedSession.mock.calls[0]!;
    const binding = {
      taskId: "task-1",
      jobId: "job-policy",
      sessionId: "session-1",
      workspacePath: process.cwd(),
      toolName: "Edit",
      payloadDigest: "a".repeat(64),
    };
    await expect(ledger.redeemReceipt(binding)).resolves.toEqual({
      receiptId: "rcpt-1",
      expiresAt: "2026-07-17T01:00:00.000Z",
    });
    await expect(ledger.redeemReceipt(binding)).resolves.toBeNull();
    // Transport errors are a MISS (⇒ gate), never a crash and never an allow.
    await expect(ledger.redeemReceipt(binding)).resolves.toBeNull();
  });

  it("an invalid stored profile degrades to no policy (today's behavior)", async () => {
    const client = sessionClient({
      getWorkspacePolicy: vi.fn(async () => ({
        profile: { version: 99, hostile: true },
        scope: "workspace",
        version: 1,
      })),
    });

    const result = await executeJob(
      client,
      workerJob(),
      { id: "agent-1", name: "claude-code-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    expect(result.status).toBe("done");
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    expect(sessionInput.policy).toBeUndefined();
    // The governed workspace still rides along for receipt scoping.
    expect(sessionInput.workspacePath).toBe(process.cwd());
  });

  it("a failing profile fetch degrades to no policy, never a lockout", async () => {
    const client = sessionClient({
      getWorkspacePolicy: vi.fn(async () => {
        throw new Error("brain unreachable");
      }),
    });

    const result = await executeJob(
      client,
      workerJob(),
      { id: "agent-1", name: "claude-code-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    expect(result.status).toBe("done");
    expect(
      coreMocks.startManagedSession.mock.calls[0]![1].policy
    ).toBeUndefined();
  });

  it("a job with no governed workspace gets neither fetch nor threading", async () => {
    const client = sessionClient();

    await executeJob(
      client,
      workerJob({ workspacePath: undefined }),
      { id: "agent-1", name: "claude-code-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );

    expect(
      (client as unknown as { getWorkspacePolicy: ReturnType<typeof vi.fn> })
        .getWorkspacePolicy
    ).not.toHaveBeenCalled();
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    expect(sessionInput.workspacePath).toBeUndefined();
    expect(sessionInput.policy).toBeUndefined();
  });

  it("a delegate child never receives policy or workspacePath (descendant fence)", async () => {
    const client = sessionClient({ listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]) });
    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const manifest = {
      version: 1 as const,
      rootJobId: "job-root",
      parentJobId: "job-parent",
      jobId: "job-child",
      depth: 2,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      rootWorkspace: workspace,
      workspacePath: workspace,
      budget: { maxWallMs: 120_000 },
      deadlineAt,
      delegationIterationCap: 3,
      authority: "work" as const,
      forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
      canDelegate: true,
      propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
      narrowingAttested: true as const,
    };

    const result = await executeJob(
      client,
      {
        id: "job-child",
        kind: "session",
        vendor: "codex",
        taskId: "task-child",
        chatId: "chat-1",
        brief: "fix parser",
        workspacePath: workspace,
        parentJobId: "job-parent",
        rootJobId: "job-root",
        delegationDepth: 2,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 3,
        maxWallMs: 120_000,
        delegationDeadline: deadlineAt,
        capabilityMode: "delegate",
        delegationManifest: manifest,
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "agent:delegate",
      },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "child-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    expect(
      (client as unknown as { getWorkspacePolicy: ReturnType<typeof vi.fn> })
        .getWorkspacePolicy
    ).not.toHaveBeenCalled();
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    expect(sessionInput.policy).toBeUndefined();
    expect(sessionInput.workspacePath).toBeUndefined();
  });

  it("an orchestrator never receives policy or workspacePath", async () => {
    const client = sessionClient({ updateChat: vi.fn(async () => ({})) });
    const workspace = process.cwd();
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();

    const result = await executeJob(
      client,
      {
        id: "job-chat",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-shadow",
        chatId: "chat-1",
        brief: "orchestrate",
        workspacePath: workspace,
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: deadlineAt,
        delegationManifest: {
          version: 1,
          jobId: "job-chat",
          workspacePath: workspace,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt,
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
        status: "running",
        interruptRequested: false,
        steerMessages: [],
        dispatchedBy: "orchestrator",
      },
      { id: "agent-1", name: "claude-code-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        delegationToken: "root-job-token",
        steerPollMs: 1,
      }
    );

    expect(result.status).toBe("done");
    expect(
      (client as unknown as { getWorkspacePolicy: ReturnType<typeof vi.fn> })
        .getWorkspacePolicy
    ).not.toHaveBeenCalled();
    const sessionInput = coreMocks.startManagedSession.mock.calls[0]![1];
    expect(sessionInput.policy).toBeUndefined();
    expect(sessionInput.workspacePath).toBeUndefined();
  });
});

describe("executeJob liveness watchdog (Wave 0)", () => {
  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.runLaneTask.mockReset();
    coreMocks.runLoop.mockReset();
  });

  const baseClient = () =>
    ({
      listLanes: async () => [{ id: "lane-1", key: "claude-code" }],
      getTaskDetail: async () => undefined,
      getLaneProfile: async () => ({ profile: undefined }),
      recallRelatedToTask: async () => [],
      markMemoryUsed: async () => undefined,
      updateAgent: async () => ({}),
      recordEvent: async () => undefined,
      getDispatchJob: async () => null,
    }) as unknown as MuonApiClient;

  const sessionJob = {
    id: "job-1",
    kind: "session" as const,
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    status: "running" as const,
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator" as const,
  };
  const agent = { id: "agent-1", name: "claude-code-1" };

  it("stops a silent vendor FAST with a distinct startup reason (reproduces the codex hang)", async () => {
    // The bug: a vendor launches, emits NOTHING, and burns its whole wall-clock
    // budget then dies at exit 130 with a generic message. The watchdog must
    // fail it fast with a diagnosable reason instead.
    let resolveWait!: (v: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (r) => {
        resolveWait = r;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (
        _ledger: unknown,
        opts: { onVendorStderrAttached?: () => void }
      ) => {
        // The real session manager announces attachment at driver selection;
        // both interactive drivers now forward the vendor's own stderr.
        opts.onVendorStderrAttached?.();
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 40,
      steerPollMs: 15,
    });

    expect(result.status).toBe("interrupted");
    // The reason states only what MUON observed. An observer WAS attached and
    // the vendor wrote nothing to it, so the report may say so — and it must
    // not assert the old "likely a startup/auth/profile/MCP" cause it never saw.
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/produced nothing on stdout or stderr/i);
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    expect(result.result).not.toMatch(/likely a startup/i);
    expect(result.result).not.toMatch(/captured no stderr/i);
    // Stopped by the watchdog via interrupt, not a full-budget wall-clock death.
    expect(interrupt).toHaveBeenCalled();
  });

  it("does NOT fire once the vendor produces output (watchdog cleared on first stream event)", async () => {
    const controller = new AbortController();
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        // First output arrives immediately → clears the watchdog…
        try {
          opts.onEvent?.({
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.progress",
            message: "working",
            timestamp: new Date().toISOString(),
            metadata: {},
          });
        } catch {
          // event-shape tolerance: markProgress runs before streams.handle.
        }
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt: vi.fn(async () => undefined),
            // …and the session runs PAST the watchdog window before an external
            // authority interrupt (not the watchdog) ends it.
            wait: () =>
              new Promise((resolve) => {
                controller.signal.addEventListener(
                  "abort",
                  () => resolve({ exitCode: 130, output: "partial" }),
                  { once: true }
                );
              }),
          },
        };
      }
    );
    setTimeout(() => controller.abort(new Error("operator stop")), 70);

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      signal: controller.signal,
      startupTimeoutMs: 30,
      steerPollMs: 15,
    });

    expect(result.status).toBe("interrupted");
    // Interrupted by the operator, NOT by the startup watchdog: had markProgress
    // failed to clear the timer, the watchdog would have fired at 30ms and this
    // would carry the "no output within…" reason.
    expect(result.result).not.toMatch(/no output within/i);
  });

  it("stops a provider that goes silent after its first output", async () => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "working" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        opts.onEvent?.({
          id: "first-output",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.progress",
          message: "working",
          timestamp: new Date().toISOString(),
          metadata: {},
        });
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 100,
      postOutputTimeoutMs: 35,
      steerPollMs: 10,
    });

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(
      /no assistant or tool activity for \d+s after work began/i
    );
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    expect(interrupt).toHaveBeenCalled();
  });

  it("pauses the post-output watchdog while human approval is pending", async () => {
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        opts.onEvent?.({
          id: "first-output",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.progress",
          message: "working",
          timestamp: new Date().toISOString(),
          metadata: {},
        });
        opts.onEvent?.({
          id: "approval",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "approval.requested",
          message: "waiting for approval",
          timestamp: new Date().toISOString(),
          metadata: { controlPlane: true },
        });
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt: vi.fn(async () => undefined),
            wait: () =>
              new Promise<{ exitCode: number; output: string }>((resolve) => {
                setTimeout(() => {
                  opts.onEvent?.({
                    id: "approval-resolved",
                    laneId: "lane-1",
                    taskId: "task-1",
                    kind: "task.progress",
                    message: "approved",
                    timestamp: new Date().toISOString(),
                    metadata: {
                      controlPlane: true,
                      approvalResolved: true,
                    },
                  });
                  opts.onEvent?.({
                    id: "completed",
                    laneId: "lane-1",
                    taskId: "task-1",
                    kind: "task.completed",
                    message: "completed",
                    timestamp: new Date().toISOString(),
                    metadata: {},
                  });
                  resolve({ exitCode: 0, output: "done" });
                }, 60);
              }),
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 100,
      postOutputTimeoutMs: 25,
      steerPollMs: 10,
    });

    expect(result.status).toBe("done");
    expect(result.result).toBe("done");
  });

  it("keeps the watchdog paused until every concurrent approval settles", async () => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "partial" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        const emit = (id: string, kind: string, metadata: object = {}) =>
          opts.onEvent?.({
            id,
            laneId: "lane-1",
            taskId: "task-1",
            kind,
            message: id,
            timestamp: new Date().toISOString(),
            metadata,
          });
        emit("first-output", "task.progress");
        emit("approval-a", "approval.requested", { controlPlane: true });
        emit("approval-b", "approval.requested", { controlPlane: true });
        setTimeout(
          () =>
            emit("approval-a-resolved", "task.progress", {
              controlPlane: true,
              approvalPendingCount: 1,
            }),
          15
        );
        setTimeout(() => {
          emit("approval-b-resolved", "task.progress", {
            controlPlane: true,
            approvalResolved: true,
          });
          emit("completed", "task.completed");
          resolveWait({ exitCode: 0, output: "done" });
        }, 65);
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 100,
      postOutputTimeoutMs: 25,
      steerPollMs: 10,
    });

    expect(result).toMatchObject({ status: "done", result: "done" });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("rearms the watchdog after the final concurrent approval resolves", async () => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "partial" });
    });
    const fallback = setTimeout(
      () => resolveWait({ exitCode: 0, output: "stale" }),
      90
    );
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        const emit = (id: string, kind: string, metadata: object = {}) =>
          opts.onEvent?.({
            id,
            laneId: "lane-1",
            taskId: "task-1",
            kind,
            message: id,
            timestamp: new Date().toISOString(),
            metadata,
          });
        emit("first-output", "task.progress");
        emit("approval-a", "approval.requested", { controlPlane: true });
        emit("approval-b", "approval.requested", { controlPlane: true });
        setTimeout(
          () =>
            emit("approval-a-resolved", "task.progress", {
              controlPlane: true,
              approvalPendingCount: 1,
            }),
          5
        );
        setTimeout(
          () =>
            emit("approval-b-resolved", "task.progress", {
              controlPlane: true,
              approvalResolved: true,
            }),
          15
        );
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 100,
      postOutputTimeoutMs: 25,
      steerPollMs: 10,
    });
    clearTimeout(fallback);

    expect(result.status).toBe("interrupted");
    expect(interrupt).toHaveBeenCalled();
  });

  it("rearms inactivity detection after a nonterminal tool failure", async () => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "partial" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        opts.onEvent?.({
          id: "first-output",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.progress",
          message: "working",
          timestamp: new Date().toISOString(),
          metadata: {},
        });
        opts.onEvent?.({
          id: "tool-failed",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.blocked",
          message: "Read failed",
          timestamp: new Date().toISOString(),
          metadata: {
            controlPlane: true,
            toolActivity: {
              provider: "claude-code",
              phase: "failed",
              tool: "Read",
            },
          },
        });
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 100,
      postOutputTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no assistant or tool activity/i);
    expect(interrupt).toHaveBeenCalled();
  });

  it("does not mistake lifecycle and profile diagnostics for vendor output", async () => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (_ledger: unknown, opts: { onEvent?: (event: unknown) => void }) => {
        opts.onEvent?.({
          id: "started",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.started",
          message: "Vendor session started",
          timestamp: new Date().toISOString(),
          metadata: {},
        });
        opts.onEvent?.({
          id: "profile-note",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.progress",
          message: "profile compatibility note",
          timestamp: new Date().toISOString(),
          metadata: { profileUnsupported: "sandbox=read-only" },
        });
        opts.onEvent?.({
          id: "preflight-note",
          laneId: "lane-1",
          taskId: "task-1",
          kind: "task.progress",
          message: "Codex capability preflight completed",
          timestamp: new Date().toISOString(),
          metadata: { controlPlane: true },
        });
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );

    const result = await executeJob(baseClient(), sessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 35,
      steerPollMs: 10,
    });

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    expect(interrupt).toHaveBeenCalled();
  });

  it("clears the watchdog on the ONESHOT (runLaneTask) path too, not just interactive (review regression)", async () => {
    // The oneshot onEvent originally lacked markProgress, so a healthy oneshot
    // that streams past the window (research harness, `muon run --action`, cursor)
    // was falsely killed at the watchdog with a "no output" reason.
    const controller = new AbortController();
    coreMocks.runLaneTask.mockImplementation(
      async (opts: {
        onEvent?: (event: unknown) => void;
        signal?: AbortSignal;
      }) => {
        try {
          opts.onEvent?.({
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.progress",
            message: "streaming",
            timestamp: new Date().toISOString(),
            metadata: {},
          });
        } catch {
          // event-shape tolerance: markProgress runs before streams.handle.
        }
        return await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, output: "partial" }),
            { once: true }
          );
        });
      }
    );
    setTimeout(() => controller.abort(new Error("operator stop")), 70);

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, kind: "oneshot" },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
        startupTimeoutMs: 30,
        steerPollMs: 15,
      }
    );

    expect(result.status).toBe("interrupted");
    // Interrupted by the operator, NOT the watchdog: without markProgress on the
    // oneshot path this would carry the "no output within…" reason at 30ms.
    expect(result.result).not.toMatch(/no output within/i);
  });

  it("surfaces the diagnosable startup reason on the LOOP path (implement/repair), not a generic 'runner authority lost' (review F1)", async () => {
    // implement and repair run in LOOP mode. When the startup watchdog fires it
    // aborts the shared signal; runLoop then returns GRACEFULLY as "aborted" with
    // a generic authority-loss stopReason and never reaches the catch block that
    // surfaces the real reason. Before the fix this misreported the exact
    // codex-hang class as a runner/lease problem on the two heaviest harnesses.
    coreMocks.runLoop.mockImplementation(
      async (opts: { signal?: AbortSignal }) =>
        // Never call onEvent → markProgress never fires → the watchdog is free to
        // fire. On abort, resolve like the real runLoop does: a graceful
        // "aborted" outcome, NOT a throw (which is exactly why the catch-block
        // stall-reason path is bypassed on the loop path).
        await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "aborted",
                stopReason:
                  "runner authority lost; active loop execution cancelled",
                iterations: 0,
                lastChecks: [],
              }),
            { once: true }
          );
        })
    );

    const result = await executeJob(
      baseClient(),
      {
        ...sessionJob,
        kind: "loop",
        checks: [{ name: "test", command: "true" }],
        maxIterations: 1,
      },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 40,
        steerPollMs: 15,
      }
    );

    expect(result.status).toBe("interrupted");
    // The FIX: the loop-path result now carries the diagnosable stall reason
    // instead of the generic "runner authority lost" loop stopReason.
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    expect(result.result).not.toMatch(/runner authority lost/i);
    expect(coreMocks.runLoop).toHaveBeenCalled();
  });

  it("reports the vendor's OWN stderr, redacted, instead of asserting an unobserved cause", async () => {
    // The founder's live failure: `codex` was rejected on a workspace SPEND CAP
    // and took ~5 minutes to say so, while the watchdog fired at 90s and blamed
    // "a startup, auth, profile, or MCP-handshake failure" it never observed.
    // The stderr the vendor DID produce inside the window is the evidence.
    coreMocks.runLaneTask.mockImplementation(
      async (opts: {
        onDiagnostic?: (chunk: string) => void;
        signal?: AbortSignal;
      }) => {
        opts.onDiagnostic?.(
          [
            "WARN: MCP OAuth refresh failed",
            "OPENAI_API_KEY=sk-live-DEADBEEFCAFE",
            "ERROR: You hit your spend cap set by the owner of your workspace.",
            "",
          ].join("\n")
        );
        return await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, output: "" }),
            { once: true }
          );
        });
      }
    );

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, kind: "oneshot" },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 30,
        steerPollMs: 10,
      }
    );

    // stderr is a DIAGNOSTIC, not vendor progress: it must never disarm the
    // watchdog, only explain why it fired.
    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/wrote to stderr/i);
    expect(result.result).toContain("You hit your spend cap");
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    // Credentials in that stderr never reach the surfaced reason or the log.
    expect(result.result).not.toContain("sk-live-DEADBEEFCAFE");
    expect(result.result).toContain("OPENAI_API_KEY=[redacted]");
  });

  it("says plainly when the vendor produced nothing on either stream", async () => {
    coreMocks.runLaneTask.mockImplementation(
      async (opts: { signal?: AbortSignal }) =>
        await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, output: "" }),
            { once: true }
          );
        })
    );

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, kind: "oneshot" },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 30,
        steerPollMs: 10,
      }
    );

    expect(result.status).toBe("interrupted");
    // A watched-and-silent child is a far stronger signal than a cause list.
    expect(result.result).toMatch(/produced nothing on stdout or stderr/i);
    expect(result.result).not.toMatch(/wrote to stderr/i);
  });

  // ── INTERACTIVE PATH (kind auto|session + claude-code/codex) ──────────────
  // The founder's Mission Chat turn runs HERE, not on the one-shot path above:
  // `startManagedSession` → CodexSessionDriver. Until the sink reached this
  // branch, the exact repro still printed "MUON captured no stderr from codex".

  const codexClient = () =>
    ({
      listLanes: async () => [{ id: "lane-1", key: "codex" }],
      getTaskDetail: async () => undefined,
      getLaneProfile: async () => ({ profile: undefined }),
      recallRelatedToTask: async () => [],
      markMemoryUsed: async () => undefined,
      updateAgent: async () => ({}),
      recordEvent: async () => undefined,
      getDispatchJob: async () => null,
    }) as unknown as MuonApiClient;

  const codexSessionJob = { ...sessionJob, vendor: "codex" };

  /**
   * Stands in for the real `startManagedSession`: announces the observer at
   * driver selection, replays the vendor's stderr through it, and NEVER emits a
   * lane event — the session hangs exactly as the founder's did.
   */
  const hangingCodexSession = (stderr: string[]) => {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "" });
    });
    coreMocks.startManagedSession.mockImplementation(
      async (
        _ledger: unknown,
        opts: {
          onDiagnostic?: (chunk: string) => void;
          onVendorStderrAttached?: () => void;
        }
      ) => {
        opts.onVendorStderrAttached?.();
        for (const chunk of stderr) {
          opts.onDiagnostic?.(chunk);
        }
        return {
          sessionId: "session-1",
          handle: {
            send: async () => undefined,
            interrupt,
            wait: () => waitPromise,
          },
        };
      }
    );
    return { interrupt };
  };

  it("surfaces the vendor's OWN stderr on the INTERACTIVE path (the founder's spend-cap hang)", async () => {
    // Reproduced directly: codex was rejected on a workspace SPEND CAP and took
    // ~5 minutes to say so, while the watchdog fired at 90s and blamed "a
    // startup, auth, profile, or MCP-handshake failure" it never observed.
    const { interrupt } = hangingCodexSession([
      "WARN: MCP OAuth refresh failed\n",
      "OPENAI_API_KEY=sk-live-DEADBEEFCAFE\n",
      "ERROR: You hit your spend cap set by the owner of your workspace.\n",
    ]);

    const result = await executeJob(codexClient(), codexSessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/wrote to stderr/i);
    expect(result.result).toContain("You hit your spend cap");
    expect(result.result).toMatch(/quota \/ billing \/ rate-limit/i);
    // The four guesses the founder actually saw are gone.
    expect(result.result).not.toMatch(/likely a startup/i);
    expect(interrupt).toHaveBeenCalled();
  });

  it("redacts credential-shaped strings in INTERACTIVE stderr", async () => {
    // Vendor stderr routinely carries credentials, and this string reaches the
    // runner log and the brain. It goes through @muon/core's single redaction
    // control (`redactedTail`) — never a second copy.
    hangingCodexSession([
      "OPENAI_API_KEY=sk-live-DEADBEEFCAFE\n",
      "Authorization: Bearer abcdef0123456789\n",
      "ERROR: You hit your spend cap set by the owner of your workspace.\n",
    ]);

    const result = await executeJob(codexClient(), codexSessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.result).not.toContain("sk-live-DEADBEEFCAFE");
    expect(result.result).not.toContain("abcdef0123456789");
    expect(result.result).toContain("OPENAI_API_KEY=[redacted]");
    expect(result.result).toContain("You hit your spend cap");
  });

  it("does NOT let INTERACTIVE stderr disarm the startup watchdog", async () => {
    // Only genuine vendor activity may clear the watchdog. stderr is a
    // DIAGNOSTIC: it explains why the watchdog fired, it must never prevent it
    // (otherwise a chatty-but-dead vendor would burn the whole wall-clock budget).
    const { interrupt } = hangingCodexSession(
      Array.from({ length: 40 }, (_, index) => `noisy stderr line ${index}\n`)
    );

    const result = await executeJob(codexClient(), codexSessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(interrupt).toHaveBeenCalled();
  });

  it("keeps the INTERACTIVE stall reason bounded when the vendor floods stderr", async () => {
    hangingCodexSession([
      ...Array.from({ length: 8 }, () => "A".repeat(1_000_000)),
      "LAST_STDERR_MARKER",
    ]);

    const result = await executeJob(codexClient(), codexSessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.result.length).toBeLessThan(3000);
    expect(result.result).toContain("LAST_STDERR_MARKER");
  });

  it("still says 'captured no stderr' when the session driver announces NO observer", async () => {
    // The third state survives: a driver that does not forward stderr never
    // announces attachment, and the report then refuses to claim a silence
    // nobody listened for. This is the guard against re-asserting unseen causes.
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    coreMocks.startManagedSession.mockImplementation(async () => ({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt: vi.fn(async () => {
          resolveWait({ exitCode: 130, output: "" });
        }),
        wait: () => waitPromise,
      },
    }));

    const result = await executeJob(codexClient(), codexSessionJob, agent, {
      apiBase: "http://127.0.0.1:4000",
      startupTimeoutMs: 30,
      steerPollMs: 10,
    });

    expect(result.result).toMatch(/captured no stderr from codex/i);
    expect(result.result).not.toMatch(/produced nothing on stdout or stderr/i);
  });

  it("surfaces the vendor's OWN stderr on the LOOP path (implement/repair)", async () => {
    coreMocks.runLoop.mockImplementation(
      async (opts: {
        onDiagnostic?: (chunk: string) => void;
        signal?: AbortSignal;
      }) => {
        opts.onDiagnostic?.(
          "ERROR: You hit your spend cap set by the owner of your workspace.\n"
        );
        return await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "aborted",
                stopReason:
                  "runner authority lost; active loop execution cancelled",
                iterations: 0,
                lastChecks: [],
              }),
            { once: true }
          );
        });
      }
    );

    const result = await executeJob(
      codexClient(),
      {
        ...codexSessionJob,
        kind: "loop",
        checks: [{ name: "test", command: "true" }],
        maxIterations: 1,
      },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 40,
        steerPollMs: 15,
      }
    );

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(result.result).toMatch(/wrote to stderr/i);
    expect(result.result).toContain("You hit your spend cap");
    expect(result.result).not.toMatch(/captured no stderr/i);
  });

  it("keeps the stall reason bounded when the vendor floods stderr", async () => {
    coreMocks.runLaneTask.mockImplementation(
      async (opts: {
        onDiagnostic?: (chunk: string) => void;
        signal?: AbortSignal;
      }) => {
        // ~8MB across chunks, including one single multi-megabyte write.
        for (let index = 0; index < 8; index += 1) {
          opts.onDiagnostic?.("A".repeat(1_000_000));
        }
        opts.onDiagnostic?.("LAST_STDERR_MARKER");
        return await new Promise((resolve) => {
          opts.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, output: "" }),
            { once: true }
          );
        });
      }
    );

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, kind: "oneshot" },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 30,
        steerPollMs: 10,
      }
    );

    expect(result.status).toBe("interrupted");
    // Bounded: a hostile or noisy vendor cannot balloon the reason or the log.
    expect(result.result.length).toBeLessThan(3000);
    // …and the bound keeps the NEWEST output, where the failure actually is.
    expect(result.result).toContain("LAST_STDERR_MARKER");
  });
});

describe("executeJob role authority enforcement (VISION §2)", () => {
  beforeEach(() => {
    coreMocks.runLaneTask.mockReset();
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output: "reviewed",
      errorOutput: "",
      durationMs: 5,
    });
    coreMocks.startManagedSession.mockReset();
    coreMocks.startManagedSession.mockRejectedValue(
      new Error("interactive vendor launch must not be reached")
    );
  });

  /**
   * A worker lane an operator pre-authorized to the hilt, with write authority
   * routed through EVERY passthrough surface at once. This is what a role has
   * to survive contact with: the stored profile is not hostile, it is just a
   * normal full-auto implementer lane being reused for review work.
   */
  function wideOpenLaneProfile() {
    return laneProfileSchema.parse({
      permissionMode: "full-auto",
      sandbox: "full-access",
      allowedTools: ["Read", "Grep", "Write", "Edit", "mcp__fs__write_file"],
      extraArgs: ["--model=frontier", "--force", "--sandbox", "danger-full-access"],
      rawConfig: {
        "tools.sandbox_mode": "danger-full-access",
        approval_policy: "never",
      },
    });
  }

  function roleClient(profile?: unknown) {
    return {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getHarness: vi.fn(async () => ({ config: emptyHarnessConfig })),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    } as unknown as MuonApiClient;
  }

  /**
   * `role` is an additive, nullable dispatch column landing in a parallel
   * change; the runner reads it defensively, so the fixture supplies it the
   * same way rather than depending on the record type having caught up.
   */
  function roleJob(overrides: Record<string, unknown>) {
    return {
      id: "job-role",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-role",
      brief: "review the diff",
      status: "running",
      interruptRequested: false,
      steerMessages: [],
      dispatchedBy: "orchestrator",
      ...overrides,
    } as Parameters<typeof executeJob>[1];
  }

  it("REFUSES to launch a reviewer whose action argv carries --force", async () => {
    // `actionArgvOverride` reaches the vendor argv WITHOUT passing through the
    // lane profile, so profile narrowing alone cannot see it. A read-only role
    // plus a widening action are contradictory instructions: fail closed rather
    // than run a "reviewer" that was handed --force on the command line.
    const result = await executeJob(
      roleClient(),
      roleJob({
        role: "reviewer",
        actionArgvOverride: { command: "codex", args: ["exec", "--force"] },
      }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toContain(
      "vendor action argv exceeds the authority of role 'reviewer'"
    );
    expect(result.result).toContain("refusing vendor launch");
    // The guard fires BEFORE any vendor launch.
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
  });

  it("REFUSES a read-only role whose action argv re-opens the sandbox", async () => {
    const result = await executeJob(
      roleClient(),
      roleJob({
        role: "qa",
        actionArgvOverride: {
          args: ["exec", "--sandbox", "danger-full-access"],
        },
      }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toContain("role 'qa'");
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("REFUSES a role this runner does not recognize (version skew fails closed)", async () => {
    // A newer brain naming a role an older runner binary cannot bound must not
    // silently run unbounded — the operator believes the agent is constrained.
    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({ role: "superuser" }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("failed");
    expect(result.result).toContain("does not recognize");
    expect(result.result).toContain("refusing vendor launch");
    expect(coreMocks.runLaneTask).not.toHaveBeenCalled();
  });

  it("lets a reviewer launch, but strips every write surface off the profile it reaches the vendor with", async () => {
    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({ role: "reviewer" }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.runLaneTask.mock.calls[0]![0].profile;
    // No write-class native tool survives, in any spelling.
    expect(profile.allowedTools).toEqual(["Read", "Grep"]);
    // Sandbox forced read-only, permission mode clamped to the role ceiling.
    expect(profile.sandbox).toBe("read-only");
    expect(profile.permissionMode).toBe("default");
    // No authority-widening argv, and the value token of `--sandbox x` went
    // with it rather than being orphaned into a positional.
    expect(profile.extraArgs).toEqual(["--model=frontier"]);
    // No authority-widening vendor-native config, dotted key included.
    expect(profile.rawConfig).toEqual({});
    // The governed MUON MCP server still reaches the reviewer — narrowing must
    // remove authority, not the tools MUON itself governs.
    expect(profile.mcpServers.map((server: { name: string }) => server.name)).toContain(
      "muon"
    );
  });

  it("holds for EVERY read-only role, not just reviewer", async () => {
    for (const role of ["reviewer", "qa", "architect", "scout"]) {
      coreMocks.runLaneTask.mockClear();
      const result = await executeJob(
        roleClient(wideOpenLaneProfile()),
        roleJob({ role }),
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000" }
      );
      expect(result.status).toBe("done");
      const profile = coreMocks.runLaneTask.mock.calls[0]![0].profile;
      expect(profile.sandbox).toBe("read-only");
      expect(profile.allowedTools).toEqual(["Read", "Grep"]);
      expect(profile.extraArgs).toEqual(["--model=frontier"]);
      expect(profile.rawConfig).toEqual({});
    }
  });

  it("a role NEVER grants authority the lane profile did not already have", async () => {
    // `implementer` tolerates auto-edits, but a lane that left the mode unset
    // runs at the vendor default. Naming the agent an implementer must not
    // upgrade it — a role narrows, it never hands anything out.
    const result = await executeJob(
      roleClient(laneProfileSchema.parse({ allowedTools: ["Read", "Write"] })),
      roleJob({ role: "implementer" }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.runLaneTask.mock.calls[0]![0].profile;
    expect(profile.permissionMode).toBeUndefined();
    expect(profile.sandbox).toBeUndefined();
    // A write-authority role keeps its write tools — narrowing, not crippling.
    expect(profile.allowedTools).toEqual(["Read", "Write"]);
  });

  it("clamps a write-authority role that IS set wider than its ceiling", async () => {
    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({ role: "implementer" }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.runLaneTask.mock.calls[0]![0].profile;
    expect(profile.permissionMode).toBe("auto-edits");
    expect(profile.sandbox).toBe("workspace-write");
  });

  it("a job with NO role behaves exactly as today (no narrowing, no assertion)", async () => {
    // The whole backwards-compatibility contract in one assertion: the stored
    // profile reaches the vendor untouched when the dispatch row carries no
    // role, including the surfaces a role would have stripped.
    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({}),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.runLaneTask.mock.calls[0]![0].profile;
    expect(profile.allowedTools).toContain("Write");
    expect(profile.sandbox).toBe("full-access");
    expect(profile.permissionMode).toBe("full-auto");
    expect(profile.extraArgs).toContain("--force");
    expect(profile.rawConfig).toMatchObject({
      "tools.sandbox_mode": "danger-full-access",
    });
  });

  it("treats an explicit null role as no role at all", async () => {
    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({ role: null }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    expect(
      coreMocks.runLaneTask.mock.calls[0]![0].profile.allowedTools
    ).toContain("Write");
  });

  it("narrows the profile handed to a role-bound LOOP as well as a one-shot", async () => {
    coreMocks.runLoop.mockReset();
    coreMocks.runLoop.mockResolvedValue({
      status: "passed",
      stopReason: "checks green",
      iterations: 1,
      lastChecks: [],
      finalOutput: "done",
    });

    const result = await executeJob(
      roleClient(wideOpenLaneProfile()),
      roleJob({
        role: "qa",
        kind: "loop",
        checks: [{ name: "test", command: "true" }],
        maxIterations: 1,
      }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000" }
    );

    expect(result.status).toBe("done");
    const profile = coreMocks.runLoop.mock.calls[0]![0].profile;
    expect(profile.sandbox).toBe("read-only");
    expect(profile.allowedTools).toEqual(["Read", "Grep"]);
  });
});

// ── F2: a wall-budget kill must never be readable as a human interrupt ───────
describe("executeJob wall-budget exhaustion", () => {
  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.runLaneTask.mockReset();
    coreMocks.runLoop.mockReset();
  });

  const baseClient = () =>
    ({
      listLanes: async () => [{ id: "lane-1", key: "claude-code" }],
      getTaskDetail: async () => undefined,
      getLaneProfile: async () => ({ profile: undefined }),
      recallRelatedToTask: async () => [],
      markMemoryUsed: async () => undefined,
      updateAgent: async () => ({}),
      recordEvent: async () => undefined,
      getDispatchJob: async () => null,
    }) as unknown as MuonApiClient;

  const agent = { id: "agent-1", name: "claude-code-1" };
  const sessionJob = {
    id: "job-1",
    kind: "session" as const,
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    status: "running" as const,
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator" as const,
  };

  /** A session whose vendor only exits when MUON interrupts it — the 130 case. */
  function silentUntilInterrupted() {
    let resolveWait!: (value: { exitCode: number; output: string }) => void;
    const waitPromise = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveWait = resolve;
      }
    );
    // Exactly what the founder's DB recorded: SIGINT, exit 130, partial work.
    const interrupt = vi.fn(async () => {
      resolveWait({ exitCode: 130, output: "half of the refactor" });
    });
    coreMocks.startManagedSession.mockImplementation(async () => ({
      sessionId: "session-1",
      handle: {
        send: async () => undefined,
        interrupt,
        wait: () => waitPromise,
      },
    }));
    return { interrupt };
  }

  it("commits a budget kill as FAILED with a machine-readable reason, never as an interrupt", async () => {
    const { interrupt } = silentUntilInterrupted();

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, maxWallMs: 1_000 },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        // Both watchdogs off, so the ONLY thing that can end this run is its
        // own wall budget — the exact shape of the founder's two 603s workers.
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
        steerPollMs: 20,
      }
    );

    expect(interrupt).toHaveBeenCalled();
    // THE fix: the status alone already rules out "a human stopped this".
    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("interrupted");
    // …and the reason is classifiable, not prose a reader has to interpret.
    expect(isBudgetExhausted(result.result)).toBe(true);
    expect(result.result.startsWith(BUDGET_EXHAUSTED_MARKER)).toBe(true);
    // The record states the budget, the spend, and that nobody acted — the
    // three facts the coordinator lacked when it told the founder its workers
    // had been "cut off by something outside their own control".
    expect(result.result).toMatch(/wall-clock budget of 1s ran out after \d+s/);
    expect(result.result).toMatch(/No human interrupted this run/);
    expect(result.result).toMatch(/larger maxWallMs/);
    // Cut short mid-thought: no fabricated handoff packet, nothing mined.
    expect(result.packet).toBeUndefined();
    expect(result.capture).toBeUndefined();
  });

  it("still reports a REAL human interrupt as interrupted (the fix does not swallow it)", async () => {
    const { interrupt } = silentUntilInterrupted();
    let polls = 0;
    const client = {
      ...baseClient(),
      // The human pressed stop: the brain reports interruptRequested.
      getDispatchJob: async () => {
        polls += 1;
        return polls >= 1 ? { id: "job-1", interruptRequested: true } : null;
      },
    } as unknown as MuonApiClient;

    const result = await executeJob(
      client,
      // A budget large enough that it cannot be what ends this run.
      { ...sessionJob, maxWallMs: 600_000 },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
        steerPollMs: 10,
      }
    );

    expect(interrupt).toHaveBeenCalled();
    expect(result.status).toBe("interrupted");
    expect(isBudgetExhausted(result.result)).toBe(false);
  });

  it("still reports a lost runner lease as interrupted, not as a budget failure", async () => {
    silentUntilInterrupted();
    const controller = new AbortController();
    // The lease is fenced ~immediately; the budget is nowhere near elapsing.
    setTimeout(() => controller.abort(), 20);

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, maxWallMs: 600_000 },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        signal: controller.signal,
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
        steerPollMs: 10,
      }
    );

    expect(result.status).toBe("interrupted");
    expect(isBudgetExhausted(result.result)).toBe(false);
  });

  it("a startup stall keeps its own diagnostic and is never relabelled a budget kill", async () => {
    silentUntilInterrupted();

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, maxWallMs: 5_000 },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 30,
        steerPollMs: 10,
      }
    );

    expect(result.status).toBe("interrupted");
    expect(result.result).toMatch(/no output within \d+s/i);
    expect(isBudgetExhausted(result.result)).toBe(false);
  });

  it("classifies a budget kill on the ONE-SHOT path too", async () => {
    coreMocks.runLaneTask.mockImplementation(
      async (input: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          input.signal?.addEventListener("abort", () =>
            resolve({ exitCode: 130, output: "partial", errorOutput: "" })
          );
        })
    );

    const result = await executeJob(
      baseClient(),
      { ...sessionJob, kind: "oneshot" as const, maxWallMs: 1_000 },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
      }
    );

    expect(result.status).toBe("failed");
    expect(isBudgetExhausted(result.result)).toBe(true);
  });

  it("classifies a budget kill on the LOOP path too", async () => {
    coreMocks.runLoop.mockImplementation(
      async (input: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          input.signal?.addEventListener("abort", () =>
            resolve({
              status: "aborted",
              stopReason: "runner authority lost",
              iterations: 1,
              lastChecks: [],
              finalOutput: "partial",
            })
          );
        })
    );

    const result = await executeJob(
      baseClient(),
      {
        ...sessionJob,
        kind: "loop" as const,
        checks: [{ name: "test", command: "true" }],
        maxIterations: 1,
        maxWallMs: 1_000,
      },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
      }
    );

    // The loop's own stopReason says "runner authority lost" — the generic
    // string that sent the diagnosis down the wrong path. The terminal record
    // must not repeat it; it must state the budget and say so explicitly.
    expect(result.status).toBe("failed");
    expect(isBudgetExhausted(result.result)).toBe(true);
    expect(result.result).not.toMatch(/loop aborted|runner authority lost/i);
    expect(result.result).toMatch(/the runner did not lose authority/i);
  });
});

// ── F3: the stall watchdog must not execute a healthy coordinator ────────────
describe("stall watchdog windows", () => {
  it("gives the root coordinator a strictly longer no-first-output window", () => {
    const worker = resolveStallWindows({ capabilityMode: "worker" });
    const coordinator = resolveStallWindows({
      capabilityMode: "orchestrator",
    });

    expect(coordinator.startupStallMs).toBeGreaterThan(worker.startupStallMs);
    expect(coordinator.postOutputStallMs).toBeGreaterThan(
      worker.postOutputStallMs
    );
  });

  it("no longer kills anything at the 90s that killed the founder's coordinator", () => {
    // Orchestrator job 1815d211 died at exactly this boundary having produced
    // nothing, and the report named three causes MUON never observed.
    const KILLED_AT_MS = 90_000;
    for (const mode of ["worker", "delegate", "orchestrator"] as const) {
      expect(
        resolveStallWindows({ capabilityMode: mode }).startupStallMs
      ).toBeGreaterThan(KILLED_AT_MS);
    }
  });

  it("treats a delegated child as a worker, not as a coordinator", () => {
    expect(resolveStallWindows({ capabilityMode: "delegate" })).toEqual(
      resolveStallWindows({ capabilityMode: "worker" })
    );
  });

  it("still lets an explicit option win, for both modes and both windows", () => {
    expect(
      resolveStallWindows({
        capabilityMode: "orchestrator",
        startupTimeoutMs: 5,
        postOutputTimeoutMs: 7,
      })
    ).toEqual({ startupStallMs: 5, postOutputStallMs: 7 });
    // 0 means DISABLED and must survive the ?? (a `||` here would silently
    // re-arm the watchdog a caller explicitly turned off).
    expect(
      resolveStallWindows({
        capabilityMode: "worker",
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
      })
    ).toEqual({ startupStallMs: 0, postOutputStallMs: 0 });
  });

  it("keeps a stall watchdog armed — a hung vendor is still caught", () => {
    for (const mode of ["worker", "delegate", "orchestrator"] as const) {
      const windows = resolveStallWindows({ capabilityMode: mode });
      expect(windows.startupStallMs).toBeGreaterThan(0);
      expect(windows.postOutputStallMs).toBeGreaterThan(0);
      // Bounded well inside the 30-minute chat-turn budget, so a genuinely
      // hung run is still caught with most of the turn left.
      expect(windows.startupStallMs).toBeLessThan(30 * 60_000);
      expect(windows.postOutputStallMs).toBeLessThan(30 * 60_000);
    }
  });
});

// ── F4: the final report must survive the ledger ─────────────────────────────
describe("job result truncation", () => {
  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.runLaneTask.mockReset();
    coreMocks.runLoop.mockReset();
  });

  const baseClient = () =>
    ({
      listLanes: async () => [{ id: "lane-1", key: "claude-code" }],
      getTaskDetail: async () => undefined,
      getLaneProfile: async () => ({ profile: undefined }),
      recallRelatedToTask: async () => [],
      markMemoryUsed: async () => undefined,
      updateAgent: async () => ({}),
      recordEvent: async () => undefined,
      getDispatchJob: async () => null,
      getHarness: async () => ({ config: emptyHarnessConfig }),
      addMemoryNoteWithAction: async () => ({ action: "created" }),
    }) as unknown as MuonApiClient;

  const agent = { id: "agent-1", name: "claude-code-1" };
  const oneshotJob = {
    id: "job-1",
    kind: "oneshot" as const,
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    status: "running" as const,
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator" as const,
  };

  async function runWithOutput(
    output: string,
    overrides: Record<string, unknown> = {}
  ) {
    coreMocks.runLaneTask.mockResolvedValue({
      exitCode: 0,
      output,
      errorOutput: "",
      durationMs: 5,
    });
    return executeJob(
      baseClient(),
      { ...oneshotJob, ...overrides },
      agent,
      {
        apiBase: "http://127.0.0.1:4000",
        startupTimeoutMs: 0,
        postOutputTimeoutMs: 0,
      }
    );
  }

  it("keeps a whole closing report that the old 4 000-char cap would have cut", async () => {
    // Codex job 1becbe2c committed "[muon:truncated] 59 characters were dropped
    // from the START" — a verdict clipped for the sake of 59 characters.
    const report = `VERDICT: ${"x".repeat(4_058)}`;
    expect(report.length).toBeGreaterThan(4_000);

    const result = await runWithOutput(report);

    expect(result.status).toBe("done");
    expect(result.result).toBe(report);
    expect(result.result).not.toContain("[muon:truncated]");
  });

  it("keeps reports up to the assistant-output class the stream recorder already stores", async () => {
    const report = "y".repeat(STREAM_MESSAGE_CONTENT_CHARS);
    const result = await runWithOutput(report);

    expect(result.result).toBe(report);
    expect(result.result.length).toBe(STREAM_MESSAGE_CONTENT_CHARS);
  });

  it("still marks a genuinely huge output, and keeps the TAIL (where the verdict is)", async () => {
    const report = `${"a".repeat(10_000)}FINAL-VERDICT-AT-THE-END`;
    const oversized = `${"b".repeat(STREAM_MESSAGE_CONTENT_CHARS)}${report}`;

    const result = await runWithOutput(oversized);

    expect(result.result).toContain("[muon:truncated]");
    expect(result.result).toMatch(
      new RegExp(`kept the last ${STREAM_MESSAGE_CONTENT_CHARS}`)
    );
    // The end of the run is its verdict, so the tail is what survives.
    expect(result.result.endsWith("FINAL-VERDICT-AT-THE-END")).toBe(true);
  });

  it("leaves room for the completion-gate verdict without exceeding the bound", async () => {
    preflightMocks.verifyEditPreflightCoverage.mockResolvedValue({
      ok: false,
      reason: "uncovered edit",
      changedFiles: ["a.ts"],
      coveredFiles: [],
      uncoveredFiles: ["a.ts"],
    });

    // Only the edit harnesses run the completion gate.
    const result = await runWithOutput("z".repeat(STREAM_MESSAGE_CONTENT_CHARS), {
      harnessKey: "implement",
    });

    expect(result.status).toBe("failed");
    expect(result.result).toContain("MUON completion gate: uncovered edit");
    // The gated tail plus the appended verdict must still fit the class bound,
    // so the row never outgrows the limit its own marker just promised.
    expect(result.result.length).toBeLessThanOrEqual(
      STREAM_MESSAGE_CONTENT_CHARS
    );
  });
});

describe("ADR-0048 — an edit delegate earns a worktree, not a prompt", () => {
  /**
   * Measured 2026-08-10: a delegate with role `implementer` WON its edit
   * claim and then could not write one line — the vendor refused all three
   * write attempts, because the delegate profile stripped every native tool
   * and no approver exists to answer a prompt. The role layer already
   * admitted writing children; only the profile never followed through.
   *
   * The grant here is the ONLY widening a delegate can receive, and every
   * test drives the REAL pipeline: real manifest parse, real worktree
   * creation in a real git repo, real over-capability assertion.
   */
  const EDIT_TOOLS = ["Edit", "Write"];

  beforeEach(() => {
    coreMocks.startManagedSession.mockReset();
    coreMocks.runLoop.mockReset();
  });

  /**
   * An implement-shaped harness: worktree required, and a CHECK — the check
   * is not decoration, it is the danger the loop refusal exists for (a check
   * executes, host-side, whatever the child wrote). Session-kind tests never
   * run it.
   */
  const worktreeHarness = {
    ...emptyHarnessConfig,
    requires: { ...emptyHarnessConfig.requires, worktree: true },
    checks: [{ name: "tests", command: "true" }],
  };

  function gitRepo(): string {
    // realpath: mkdtemp answers /var/... which is a symlink to /private/var
    // on macOS, and the governed-workspace attestation compares canonical
    // paths — a symlinked fixture reads as "retargeted after dispatch".
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "muon-edit-delegate-"))
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"], { cwd: root });
    return root;
  }

  function delegateClient(harnessConfig: unknown) {
    return {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getHarness: vi.fn(async () => ({ config: harnessConfig })),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => ({})),
      drainDispatchSteer: vi.fn(async () => []),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
    } as unknown as MuonApiClient;
  }

  function editJob(workspace: string, overrides: Record<string, unknown> = {}) {
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const propagatedTools = MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
      (name) => name !== "delegate"
    );
    return {
      id: "job-edit",
      kind: "session" as const,
      vendor: "codex",
      taskId: "task-edit",
      brief: "append one line in the worktree",
      workspacePath: workspace,
      harnessKey: "implement",
      parentJobId: "job-parent",
      rootJobId: "job-root",
      delegationDepth: 1,
      maxDelegationDepth: 3,
      maxChildren: 3,
      maxTotalDescendants: 8,
      maxDelegationIterations: 2,
      maxWallMs: 120_000,
      delegationDeadline: deadlineAt,
      capabilityMode: "delegate",
      delegationManifest: {
        version: 1,
        rootJobId: "job-root",
        parentJobId: "job-parent",
        jobId: "job-edit",
        depth: 1,
        maxDepth: 3,
        maxChildrenPerParent: 3,
        maxTotalDescendants: 8,
        rootWorkspace: workspace,
        workspacePath: workspace,
        budget: { maxWallMs: 120_000 },
        deadlineAt,
        delegationIterationCap: 2,
        authority: "work",
        forbiddenAuthority: ["govern", "approve", "merge", "ship"],
        canDelegate: false,
        fileAuthority: "edit",
        propagatedTools,
        narrowingAttested: true,
      },
      status: "running",
      interruptRequested: false,
      steerMessages: [],
      dispatchedBy: "agent:delegate",
      ...overrides,
    };
  }

  it("grants exactly Edit and Write on top of the MCP set — and the assertion agrees", async () => {
    const workspace = gitRepo();
    try {
      coreMocks.startManagedSession.mockResolvedValue({
        sessionId: "session-edit",
        handle: {
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "diff produced" }),
        },
      });
      const result = await executeJob(
        delegateClient(worktreeHarness),
        editJob(workspace),
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
      );

      expect(result.status, JSON.stringify(result.result)).toBe("done");
      const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
      const native = profile.allowedTools.filter(
        (tool: string) => !tool.startsWith("mcp__")
      );
      // Exactly the named list — not Bash, not a mode, not "*".
      expect(native.sort()).toEqual(EDIT_TOOLS);
      // And the child's cwd is the ISOLATED WORKTREE, not the checkout: the
      // worktree is the write boundary the grant leans on.
      const cwd = coreMocks.startManagedSession.mock.calls.at(-1)![1].cwd;
      expect(cwd).not.toBe(workspace);
      expect(cwd).toContain("worktrees");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("a read manifest on the same harness grants NO native tool", async () => {
    const workspace = gitRepo();
    try {
      coreMocks.startManagedSession.mockResolvedValue({
        sessionId: "session-read",
        handle: {
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "read-only done" }),
        },
      });
      const job = editJob(workspace);
      (job.delegationManifest as { fileAuthority?: string }).fileAuthority =
        "read";
      const result = await executeJob(
        delegateClient(worktreeHarness),
        job,
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
      );
      expect(result.status).toBe("done");
      const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
      expect(
        profile.allowedTools.every((tool: string) => tool.startsWith("mcp__"))
      ).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("a hand-edited manifest cannot arm a read-shaped harness", async () => {
    // Defense in depth: the manifest says edit, but the harness the runner
    // resolved does not require a worktree — BOTH attestations must agree.
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "session-noworktree",
      handle: {
        send: async () => undefined,
        interrupt: async () => undefined,
        wait: async () => ({ exitCode: 0, output: "done" }),
      },
    });
    const workspace = process.cwd();
    const result = await executeJob(
      delegateClient(emptyHarnessConfig),
      editJob(workspace, { harnessKey: "research" }),
      { id: "agent-1", name: "codex-1" },
      { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
    );
    expect(result.status).toBe("done");
    const profile = coreMocks.startManagedSession.mock.calls.at(-1)![1].profile;
    expect(
      profile.allowedTools.every((tool: string) => tool.startsWith("mcp__"))
    ).toBe(true);
  });

  it("REFUSES the loop kind: host-side checks would execute what the child wrote", async () => {
    const workspace = gitRepo();
    try {
      const result = await executeJob(
        delegateClient(worktreeHarness),
        editJob(workspace, { kind: "loop" }),
        { id: "agent-1", name: "codex-1" },
        { apiBase: "http://127.0.0.1:4000", steerPollMs: 1 }
      );
      expect(result.status).toBe("failed");
      expect(String(result.result)).toMatch(/check loop|reviewer/i);
      expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
      expect(coreMocks.runLoop).not.toHaveBeenCalled();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
