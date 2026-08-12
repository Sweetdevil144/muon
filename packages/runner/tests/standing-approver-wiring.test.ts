import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHarnessConfig, type MuonApiClient } from "@muon/client";
import type { StandingApproverGrant } from "@muon/protocol";

// The runner half of the Full Auto fix.
//
// The founder's live mission ran with every gate deliberately off and the
// coordinator's `Bash` was still denied, because `noInteractiveApprover` was
// derived purely from capabilityMode and nothing in the runner could learn that
// a standing operator approver existed. These lock the wiring: the coordinator
// gets a resolver that reads the lease on MUON's OWN control client, a worker
// gets none, and every way the read can go wrong resolves to "nobody watching".

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
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
  verifyEditPreflightCoverage: vi.fn(async () => ({
    ok: true,
    changedFiles: [],
    coveredFiles: [],
    uncoveredFiles: [],
  })),
}));

import { executeJob } from "../src/execute.js";

type SessionInput = {
  noInteractiveApprover?: boolean;
  resolveStandingApprover?: () => Promise<StandingApproverGrant | undefined>;
};

function client(
  getStandingApprover: () => Promise<StandingApproverGrant> = async () => ({
    active: false,
  })
) {
  const spy = vi.fn(getStandingApprover);
  return {
    api: {
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getHarness: vi.fn(async () => ({ config: emptyHarnessConfig })),
      getTaskDetail: vi.fn(async () => undefined),
      getLaneProfile: vi.fn(async () => ({ profile: undefined })),
      recallRelatedToTask: vi.fn(async () => []),
      markMemoryUsed: vi.fn(async () => undefined),
      recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
      recordEvent: vi.fn(async () => undefined),
      updateAgent: vi.fn(async () => undefined),
      getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
      drainDispatchSteer: vi.fn(async () => []),
      getStandingApprover: spy,
    } as unknown as MuonApiClient,
    getStandingApprover: spy,
  };
}

const WORKSPACE = process.cwd();

function coordinatorJob() {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  return {
    id: "job-standing",
    kind: "session",
    vendor: "codex",
    taskId: "task-standing",
    chatId: "chat-standing",
    brief: "coordinate",
    workspacePath: WORKSPACE,
    capabilityMode: "orchestrator",
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 2,
    delegationDeadline: deadlineAt,
    delegationManifest: {
      version: 1,
      jobId: "job-standing",
      workspacePath: WORKSPACE,
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
  };
}

function workerJob() {
  return {
    id: "job-worker",
    kind: "session",
    vendor: "codex",
    taskId: "task-worker",
    brief: "do the bounded task",
    workspacePath: WORKSPACE,
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

let seen: SessionInput | undefined;

beforeEach(() => {
  seen = undefined;
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLoop.mockReset();
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockImplementation(
    async (_ledger: unknown, input: SessionInput) => {
      seen = input;
      return {
        sessionId: "session-standing",
        handle: {
          send: async () => undefined,
          interrupt: async () => undefined,
          wait: async () => ({ exitCode: 0, output: "done" }),
        },
      };
    }
  );
});

describe("executeJob — standing-approver wiring", () => {
  it("a COORDINATOR session is flagged AND handed a resolver that reads the lease", async () => {
    const live: StandingApproverGrant = {
      active: true,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const { api, getStandingApprover } = client(async () => live);

    await executeJob(api, coordinatorJob() as never, {
      id: "agent-1",
      name: "codex-1",
    }, {
      apiBase: "http://127.0.0.1:4000",
      delegationToken: "root-job-token",
      steerPollMs: 1,
    });

    expect(seen?.noInteractiveApprover).toBe(true);
    expect(typeof seen?.resolveStandingApprover).toBe("function");
    // The seam resolves at DECISION time; nothing was read at session start.
    expect(getStandingApprover).not.toHaveBeenCalled();
    await expect(seen!.resolveStandingApprover!()).resolves.toEqual(live);
    expect(getStandingApprover).toHaveBeenCalledTimes(1);
  });

  it("the resolver FAILS CLOSED when control refuses or cannot answer", async () => {
    // Widening on an unreadable answer would hand a coordinator an ungated shell
    // the moment the brain hiccuped; `undefined` is what the seam treats as
    // today's fast-deny.
    const { api } = client(async () => {
      throw new Error("control offline");
    });

    await executeJob(api, coordinatorJob() as never, {
      id: "agent-1",
      name: "codex-1",
    }, {
      apiBase: "http://127.0.0.1:4000",
      delegationToken: "root-job-token",
      steerPollMs: 1,
    });

    await expect(seen!.resolveStandingApprover!()).resolves.toBeUndefined();
  });

  it("a WORKER session gets NEITHER the flag nor a resolver — its human gate is untouched", async () => {
    const { api, getStandingApprover } = client();

    await executeJob(api, workerJob() as never, {
      id: "agent-1",
      name: "codex-1",
    }, {
      apiBase: "http://127.0.0.1:4000",
      steerPollMs: 1,
    });

    expect(seen?.noInteractiveApprover).toBe(false);
    expect(seen?.resolveStandingApprover).toBeUndefined();
    expect(getStandingApprover).not.toHaveBeenCalled();
  });
});
