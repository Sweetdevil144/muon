import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const harness = {
  id: "h-1",
  key: "review",
  name: "Review",
  config: {
    description: "Read-only review",
    profileOverlay: { sandbox: "read-only" },
    checks: [],
    requires: { interactive: false, worktree: false },
    preauthorizedTools: [],
    budget: {},
    memorySlice: { topics: [], modules: [], k: 5 },
  },
  version: 1,
  createdBy: "muon",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const run = {
  id: "run-1",
  templateKey: "bugfix",
  templateVersion: 1,
  request: "fix the login bug",
  chatId: "chat-1",
  proposal: {
    summary: "bugfix: login",
    templateKey: "bugfix",
    steps: [
      {
        stepKey: "fix",
        title: "Fix the login bug",
        brief: "Fix it.",
        role: "suggest",
        priority: "high",
        onFail: "escalate",
      },
    ],
  },
  status: "proposed",
  proposedBy: "heuristic",
  appliedBy: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const LOOP_PROGRESS = {
  iteration: 1,
  shell: [{ name: "tests", ok: true, exitCode: 0 }],
  evaluator: null,
  repairSeed: "",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

describe("MuonApiClient orchestration methods", () => {
  it("fetches and upserts harnesses", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ harness }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const fetched = await client.getHarness("review");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/harnesses/review",
      expect.anything()
    );
    expect(fetched.config.profileOverlay.sandbox).toBe("read-only");

    await client.putHarness("review", {
      name: "Review",
      config: fetched.config,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/harnesses/review",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("creates, lists, and applies workflow runs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ run }))
      .mockResolvedValueOnce(mockResponse({ runs: [run] }))
      .mockResolvedValueOnce(
        mockResponse({
          run: { ...run, status: "applied", appliedBy: "human" },
          tasks: [
            {
              id: "task-1",
              title: "Fix the login bug",
              description: "Fix it.",
              status: "backlog",
              priority: "high",
              workflowRunId: "run-1",
              stepKey: "fix",
              assignments: [],
              approvals: [],
            },
          ],
        })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const control = {
      callerJobId: "job-root",
      delegationToken: "d".repeat(64),
    };

    const created = await client.createWorkflowRun(
      {
        templateKey: "bugfix",
        request: "fix the login bug",
        chatId: "chat-1",
        proposal: run.proposal as never,
      },
      control
    );
    expect(created.status).toBe("proposed");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/api/workflow-runs",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-muon-caller-job-id": "job-root",
          "x-muon-delegation-token": "d".repeat(64),
        }),
      })
    );
    expect(
      JSON.parse(
        String(
          (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body
        )
      )
    ).toMatchObject({ chatId: "chat-1" });

    const listed = await client.listWorkflowRuns({
      status: "proposed",
      chatId: "chat-1",
    }, control);
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/workflow-runs?status=proposed&chatId=chat-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-muon-caller-job-id": "job-root",
        }),
      })
    );
    expect(listed).toHaveLength(1);

    const applied = await client.applyWorkflowRun(
      "run-1",
      "human",
      "approval-1",
      control
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/workflow-runs/run-1/apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-muon-caller-job-id": "job-root",
        }),
      })
    );
    expect(applied.tasks[0].stepKey).toBe("fix");
  });

  it("tracks loop runs", async () => {
    const loop = {
      id: "loop-1",
      taskId: "task-1",
      kind: "check_repair",
      budget: { maxIterations: 3 },
      iterations: 0,
      status: "running",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ loop }))
      .mockResolvedValueOnce(
        mockResponse({
          loop: {
            ...loop,
            iterations: 1,
            status: "running",
            progress: LOOP_PROGRESS,
          },
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const created = await client.createLoopRun({
      taskId: "task-1",
      budget: { maxIterations: 3 },
    });
    expect(created.status).toBe("running");

    const updated = await client.updateLoopRun({
      loopId: "loop-1",
      iterations: 1,
      progress: LOOP_PROGRESS,
    });
    expect(updated.progress).toEqual(LOOP_PROGRESS);
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/loops/loop-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          iterations: 1,
          progress: LOOP_PROGRESS,
        }),
      })
    );
  });

  it("reads the fleet and releases an agent instance", async () => {
    const agent = {
      id: "agent-1",
      vendor: "codex",
      name: "codex-1",
      ordinal: 1,
      status: "idle",
      currentTaskId: null,
      sessionId: null,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ counts: { "claude-code": 0, codex: 1, cursor: 0 }, agents: [agent] })
      )
      .mockResolvedValueOnce(mockResponse({ agent }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const fleet = await client.getFleet();
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/fleet",
      expect.anything()
    );
    expect(fleet.counts.codex).toBe(1);
    expect(fleet.agents).toHaveLength(1);

    const released = await client.updateAgent({ agentId: "agent-1", status: "idle" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/fleet/agents/agent-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "idle" }),
      })
    );
    expect(released.status).toBe("idle");
  });

  it("passes text to routing suggestions for pre-task planning", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ suggestions: [] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.suggestLanes(undefined, "fix the rate limiter");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/routing/suggest?text=fix+the+rate+limiter",
      expect.anything()
    );

    await client.suggestLanes("task-1");
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/routing/suggest?taskId=task-1",
      expect.anything()
    );
  });
});

/**
 * Surface-parity audit §C: methods with no consumer on any surface are debt —
 * each was either converged or deleted, and the deletions are pinned HERE so
 * the absence is a stated decision rather than something a future reader
 * re-adds by reflex.
 */
describe("the client offers no superseded path", () => {
  const client = new MuonApiClient("http://localhost:4000", vi.fn());

  it("cannot claim a fleet seat: the backend does it inside the dispatch txn", () => {
    // A client-side claim was a second place a lane could be taken from,
    // racing the transaction that actually assigns one. Its only in-tree
    // caller (`withClaimedAgent` in @muon/core) had no callers of its own.
    expect(
      (client as unknown as Record<string, unknown>).claimAgent
    ).toBeUndefined();
  });

  it("cannot author a workflow template: no surface offers authoring", () => {
    // Templates are seeded; `muon workflow` runs them. A writer with no
    // author is an untested write path waiting to be discovered.
    expect(
      (client as unknown as Record<string, unknown>).putWorkflowTemplate
    ).toBeUndefined();
  });

  it("reads context frames as a PAGE, never one at a time", () => {
    // `listJobContext` is what `muon trajectory` consumes; the single-frame
    // read had no consumer and no bound of its own.
    expect(
      (client as unknown as Record<string, unknown>).getContextFrame
    ).toBeUndefined();
    expect(typeof client.listJobContext).toBe("function");
  });
});
