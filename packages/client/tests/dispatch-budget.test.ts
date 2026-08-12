import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

function response(payload: unknown, status = 201): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? "Created" : "Error",
    json: async () => payload,
  } as Response;
}

describe("MuonApiClient dispatch budgets", () => {
  it("sends and parses task-scoped iteration and wall-clock limits", async () => {
    const fetcher = vi.fn(async () =>
      response({
        job: {
          id: "job-1",
          kind: "loop",
          vendor: "codex",
          taskId: "task-1",
          brief: "repair",
          harnessKey: "repair",
          maxIterations: 2,
          maxWallMs: 45_000,
          checks: [{ name: "lint", command: "npm run lint" }],
          iterationTimeoutMs: 30_000,
          status: "queued",
          dispatchedBy: "human",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-15T12:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const job = await client.enqueueDispatch({
      kind: "loop",
      vendor: "codex",
      taskId: "task-1",
      brief: "repair",
      harnessKey: "repair",
      maxIterations: 2,
      maxWallMs: 45_000,
      checks: [{ name: "lint", command: "npm run lint" }],
      iterationTimeoutMs: 30_000,
    });

    expect(job).toMatchObject({
      maxIterations: 2,
      maxWallMs: 45_000,
      checks: [{ name: "lint", command: "npm run lint" }],
      iterationTimeoutMs: 30_000,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "loop",
          vendor: "codex",
          taskId: "task-1",
          brief: "repair",
          harnessKey: "repair",
          maxIterations: 2,
          maxWallMs: 45_000,
          checks: [{ name: "lint", command: "npm run lint" }],
          iterationTimeoutMs: 30_000,
        }),
      })
    );
  });

  it("sends and parses session resume and approval bounds", async () => {
    const fetcher = vi.fn(async () =>
      response({
        job: {
          id: "job-session",
          kind: "session",
          vendor: "claude-code",
          taskId: "task-session",
          brief: "continue",
          resumeVendorSessionId: "claude-session-42",
          approvalTimeoutMs: 90_000,
          status: "queued",
          dispatchedBy: "human",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-15T12:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const job = await client.enqueueDispatch({
      kind: "session",
      vendor: "claude-code",
      taskId: "task-session",
      brief: "continue",
      resumeVendorSessionId: "claude-session-42",
      approvalTimeoutMs: 90_000,
    });

    expect(job).toMatchObject({
      resumeVendorSessionId: "claude-session-42",
      approvalTimeoutMs: 90_000,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "session",
          vendor: "claude-code",
          taskId: "task-session",
          brief: "continue",
          resumeVendorSessionId: "claude-session-42",
          approvalTimeoutMs: 90_000,
        }),
      })
    );
  });

  it("sends bounded child work through the dedicated delegate route", async () => {
    const fetcher = vi.fn(async () =>
      response({
        job: {
          id: "job-child",
          kind: "auto",
          vendor: "codex",
          taskId: "task-child",
          brief: "fix parser",
          parentJobId: "job-parent",
          rootJobId: "job-root",
          delegationDepth: 2,
          maxDelegationDepth: 3,
          maxChildren: 3,
          maxTotalDescendants: 8,
          capabilityMode: "delegate",
          status: "queued",
          dispatchedBy: "agent:delegate",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-15T12:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );

    const job = await client.delegateDispatch(
      "job-parent",
      {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "fix parser",
        workspacePath: "/repo/packages/parser",
        maxWallMs: 120_000,
      },
      "parent-job-token"
    );

    expect(job).toMatchObject({
      id: "job-child",
      parentJobId: "job-parent",
      rootJobId: "job-root",
      delegationDepth: 2,
      capabilityMode: "delegate",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch/job-parent/delegate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-muon-delegation-token": "parent-job-token",
        }),
        body: JSON.stringify({
          kind: "auto",
          vendor: "codex",
          taskId: "task-child",
          brief: "fix parser",
          workspacePath: "/repo/packages/parser",
          maxWallMs: 120_000,
        }),
      })
    );
  });

  it("S6 forwards the model override on enqueue and delegate", async () => {
    const enqueueFetcher = vi.fn(async () =>
      response({
        job: {
          id: "job-m",
          kind: "auto",
          vendor: "claude-code",
          taskId: "task-1",
          brief: "build",
          status: "queued",
          dispatchedBy: "human",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-15T12:00:00.000Z",
        },
      })
    );
    const enqueueClient = new MuonApiClient(
      "http://127.0.0.1:4000",
      enqueueFetcher,
      "operator-token"
    );
    await enqueueClient.enqueueDispatch({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "build",
      model: "opus",
    });
    expect(enqueueFetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          vendor: "claude-code",
          taskId: "task-1",
          brief: "build",
          model: "opus",
        }),
      })
    );

    const delegateFetcher = vi.fn(async () =>
      response({
        job: {
          id: "job-child",
          kind: "auto",
          vendor: "codex",
          taskId: "task-child",
          brief: "fix",
          status: "queued",
          dispatchedBy: "agent:delegate",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-15T12:00:00.000Z",
        },
      })
    );
    const delegateClient = new MuonApiClient(
      "http://127.0.0.1:4000",
      delegateFetcher,
      "agent-token"
    );
    await delegateClient.delegateDispatch(
      "job-parent",
      { vendor: "codex", taskId: "task-child", brief: "fix", model: "gpt-5-codex" },
      "parent-job-token"
    );
    expect(delegateFetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch/job-parent/delegate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          vendor: "codex",
          taskId: "task-child",
          brief: "fix",
          model: "gpt-5-codex",
        }),
      })
    );
  });
});

describe("MuonApiClient S9 budget visibility + raise", () => {
  const BUDGET = {
    jobId: "job-root",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 4_800_000,
    poolMs: 4_800_000,
    reservedMs: 600_000,
    consumedMs: 0,
    remainingMs: 4_200_000,
    deadlineAt: "2026-07-16T00:30:00.000Z",
    childrenIssued: 1,
    maxChildren: 3,
    descendantsIssued: 1,
    maxDescendants: 8,
    depth: 0,
    maxDepth: 3,
    children: [
      {
        jobId: "child-a",
        vendor: "codex",
        status: "running",
        depth: 1,
        reservedMs: 600_000,
        consumedMs: 120_000,
      },
    ],
  };

  it("getDispatchBudget resolves and parses the mission budget", async () => {
    const fetcher = vi.fn(async () => response({ budget: BUDGET }, 200));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "agent-token"
    );

    const budget = await client.getDispatchBudget("job-child");
    expect(budget).toMatchObject({
      poolMs: 4_800_000,
      reservedMs: 600_000,
      remainingMs: 4_200_000,
    });
    expect(budget.children).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch/job-child/budget",
      expect.objectContaining({})
    );
  });

  it("raiseDispatchBudget PATCHes the new pool + gate id and parses the result", async () => {
    const raised = {
      ...BUDGET,
      maxDescendantWallMs: 6_000_000,
      poolMs: 6_000_000,
      remainingMs: 5_400_000,
    };
    const fetcher = vi.fn(async () => response({ budget: raised }, 200));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const budget = await client.raiseDispatchBudget("job-root", {
      maxDescendantWallMs: 6_000_000,
      gateApprovalId: "gate-1",
    });
    expect(budget.poolMs).toBe(6_000_000);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch/job-root/budget",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          maxDescendantWallMs: 6_000_000,
          gateApprovalId: "gate-1",
        }),
      })
    );
  });

  it("the dispatch job schema tolerates the S3/S9 pool + consumed columns", async () => {
    const fetcher = vi.fn(async () =>
      response(
        {
          job: {
            id: "job-root",
            kind: "session",
            vendor: "claude-code",
            taskId: "task-root",
            brief: "orchestrate",
            status: "running",
            dispatchedBy: "human",
            interruptRequested: false,
            steerMessages: [],
            createdAt: "2026-07-16T00:00:00.000Z",
            maxDescendantWallMs: 4_800_000,
            delegationBudgetReservedMs: 600_000,
            delegationBudgetConsumedMs: 120_000,
          },
        },
        200
      )
    );
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const job = await client.getDispatchJob("job-root");
    expect(job.maxDescendantWallMs).toBe(4_800_000);
    expect(job.delegationBudgetConsumedMs).toBe(120_000);
  });
});
