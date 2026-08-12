import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

const prismaMock = vi.hoisted(() => ({
  lane: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  task: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  approvalRequest: {
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  harness: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  workflowTemplate: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  workflowRun: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  loopRun: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  streamChunk: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  orchestratorChat: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const graphMock = vi.hoisted(() => ({
  suggestLanes: vi.fn(),
}));

const workflowPlannerMock = vi.hoisted(() => ({
  planWorkflowViaAvailableLane: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  mirrorToGraph: () => undefined,
}));

vi.mock("../src/lib/workflow-planner.js", () => workflowPlannerMock);

const PROPOSAL = {
  summary: "Fix the login rate limiting bug",
  templateKey: "bugfix",
  steps: [
    {
      stepKey: "reproduce",
      title: "Reproduce with a failing test",
      brief: "Reproduce the bug with a failing test.",
      role: "suggest",
      priority: "high",
      harnessKey: "implement",
      handoffTo: "fix",
      onFail: "escalate",
    },
    {
      stepKey: "fix",
      title: "Fix until checks pass",
      brief: "Make the failing test pass.",
      role: "suggest",
      priority: "high",
      harnessKey: "repair",
      loop: { kind: "check_repair", maxIterations: 3, onExhaust: "escalate" },
      onFail: "escalate",
    },
  ],
};

const LOOP_PROGRESS = {
  iteration: 1,
  shell: [{ name: "tests", ok: true, exitCode: 0 }],
  evaluator: null,
  repairSeed: "",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

describe("orchestration API (harness / workflow / loop)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.event.create.mockResolvedValue({ id: "event-1" });
    prismaMock.harness.findMany.mockResolvedValue([]);
    prismaMock.workflowTemplate.findMany.mockResolvedValue([]);
    prismaMock.harness.upsert.mockResolvedValue({
      id: "harness-1",
      key: "review",
      name: "Review",
      config: {},
      version: 1,
    });
    prismaMock.workflowRun.create.mockResolvedValue({
      id: "run-1",
      templateKey: "bugfix",
      status: "proposed",
      createdAt: new Date("2026-07-10T10:00:00.000Z"),
    });
    prismaMock.loopRun.create.mockResolvedValue({
      id: "loop-1",
      taskId: "task-1",
      status: "running",
      iterations: 0,
    });
    prismaMock.loopRun.findUnique.mockResolvedValue({
      taskId: "task-1",
      dispatchJobId: null,
    });
    prismaMock.loopRun.update.mockResolvedValue({
      id: "loop-1",
      status: "escalated",
    });
    prismaMock.orchestratorChat.findMany.mockResolvedValue([{ id: "chat-1" }]);
    prismaMock.orchestratorChat.findFirst.mockResolvedValue({ id: "chat-1" });
    prismaMock.$transaction.mockImplementation(
      async (
        input:
          | Promise<unknown>[]
          | ((tx: typeof prismaMock) => Promise<unknown>)
      ) =>
        typeof input === "function"
          ? input(prismaMock)
          : Promise.all(input)
    );
    graphMock.suggestLanes.mockResolvedValue([]);
    prismaMock.lane.findMany.mockResolvedValue([]);
    workflowPlannerMock.planWorkflowViaAvailableLane.mockResolvedValue({
      proposal: structuredClone(PROPOSAL),
      plannerLaneKey: "codex",
    });
  });

  it("upserts a harness and records provenance with a first-class event kind", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/harnesses/review",
      payload: {
        name: "Review",
        config: {
          description: "Read-only review",
          profileOverlay: { sandbox: "read-only" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.harness.upsert).toHaveBeenCalled();
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "harness.updated" }),
      })
    );
    await app.close();
  });

  it("rejects an invalid harness config instead of storing it", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/harnesses/bad",
      payload: {
        name: "Bad",
        config: { profileOverlay: { permissionMode: "yolo" } },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(prismaMock.harness.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("proposes a workflow from raw request text (browser instruct path)", async () => {
    prismaMock.lane.findMany.mockResolvedValue([
      { id: "l1", key: "claude-code" },
      { id: "l2", key: "codex" },
      { id: "l3", key: "cursor" },
    ]);
    prismaMock.harness.findMany.mockResolvedValue([
      { key: "implement" },
      { key: "review" },
    ]);
    prismaMock.workflowTemplate.findMany.mockResolvedValue([{ key: "bugfix" }]);
    graphMock.suggestLanes.mockResolvedValue([
      {
        laneId: "l1",
        laneKey: "codex",
        laneName: "Codex",
        score: 2,
        reason: "2/2 assignments completed",
      },
    ]);

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/propose",
      payload: {
        request: "fix the login bug then document the rate limiter",
        workspacePath: "/Users/dev/my-project",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(
      workflowPlannerMock.planWorkflowViaAvailableLane
    ).toHaveBeenCalledWith({
      request: "fix the login bug then document the rate limiter",
      workspacePath: "/Users/dev/my-project",
      taskId: expect.stringMatching(/^planner:/),
      laneKeys: ["claude-code", "codex", "cursor"],
      harnessKeys: ["implement", "review"],
      templateKeys: ["bugfix"],
    });
    expect(prismaMock.workflowRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspacePath: "/Users/dev/my-project",
          proposedBy: "planner:codex",
          proposal: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({ laneKey: "codex" }),
            ]),
          }),
        }),
      })
    );
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "workflow.proposed",
          metadata: expect.objectContaining({
            proposedBy: "planner:codex",
            plannerLaneKey: "codex",
          }),
        }),
      })
    );
    await app.close();
  });

  it("surfaces planner degradation instead of silently falling back to regex", async () => {
    workflowPlannerMock.planWorkflowViaAvailableLane.mockRejectedValue(
      new Error("No dispatch-ready planner lane is available.")
    );

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/propose",
      payload: { request: "plan a safe release workflow" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().message).toMatch(/planner unavailable/i);
    expect(prismaMock.workflowRun.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("stores a workflow proposal and records workflow.proposed", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      payload: {
        templateKey: "bugfix",
        request: "fix the login rate limiting bug",
        proposal: PROPOSAL,
        proposedBy: "heuristic",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().run.status).toBe("proposed");
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "workflow.proposed" }),
      })
    );
    await app.close();
  });

  it("applies a proposed run: steps become tasks, status flips, provenance recorded", async () => {
    prismaMock.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "proposed",
      proposal: PROPOSAL,
      templateKey: "bugfix",
      workspacePath: "/Users/dev/my-project",
      createdAt: new Date("2026-07-10T10:00:00.000Z"),
    });
    const createdTasks: unknown[] = [];
    const currentRun = {
      id: "run-1",
      status: "proposed",
      proposal: PROPOSAL,
      templateKey: "bugfix",
      workspacePath: "/Users/dev/my-project",
      createdAt: new Date("2026-07-10T10:00:00.000Z"),
    };
    const appliedRun = {
      ...currentRun,
      status: "applied",
      appliedBy: "human",
    };
    const tx = {
      task: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          const task = { id: `task-${createdTasks.length + 1}`, status: "backlog", ...args.data };
          createdTasks.push(task);
          return task;
        }),
      },
      workflowRun: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(currentRun)
          .mockResolvedValueOnce(appliedRun),
      },
    };
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)
    );

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/run-1/apply",
      payload: { appliedBy: "human" },
    });

    expect(response.statusCode).toBe(201);
    expect(tx.task.create).toHaveBeenCalledTimes(2);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workflowRunId: "run-1",
          stepKey: "reproduce",
          // Steps inherit the run's target repo (workspace concept).
          workspacePath: "/Users/dev/my-project",
        }),
      })
    );
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "workflow.applied" }),
      })
    );
    await app.close();
  });

  it("refuses to apply a run that is not proposed (409)", async () => {
    prismaMock.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "applied",
      proposal: PROPOSAL,
    });

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/run-1/apply",
      payload: { appliedBy: "human" },
    });

    expect(response.statusCode).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("claims a proposed run atomically before creating tasks", async () => {
    prismaMock.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "proposed",
      proposal: PROPOSAL,
      templateKey: "bugfix",
      workspacePath: "/Users/dev/my-project",
      createdAt: new Date("2026-07-10T10:00:00.000Z"),
    });
    const createTask = vi.fn();
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          task: { create: createTask },
          workflowRun: {
            updateMany: vi.fn(async () => ({ count: 0 })),
            findUnique: vi.fn(async () => ({
              id: "run-1",
              status: "proposed",
              proposal: PROPOSAL,
              templateKey: "bugfix",
              workspacePath: "/Users/dev/my-project",
              createdAt: new Date("2026-07-10T10:00:00.000Z"),
            })),
          },
        })
    );

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/run-1/apply",
      payload: { appliedBy: "human" },
    });

    expect(response.statusCode).toBe(409);
    expect(createTask).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to edit the proposal of an applied run (409)", async () => {
    prismaMock.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "applied",
    });

    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/workflow-runs/run-1",
      payload: { proposal: PROPOSAL },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("creates and closes loop runs, stamping endedAt on terminal states", async () => {
    const app = buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/loops",
      payload: {
        taskId: "task-1",
        kind: "check_repair",
        budget: { maxIterations: 3 },
      },
    });
    expect(created.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/loops/loop-1",
      payload: { status: "escalated", iterations: 3, stopReason: "budget exhausted" },
    });
    expect(updated.statusCode).toBe(200);
    expect(prismaMock.loopRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "escalated",
          endedAt: expect.any(Date),
        }),
      })
    );
    await app.close();
  });

  it("persists typed loop progress in the same PATCH as its iteration", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/loops/loop-1",
      payload: { iterations: 1, progress: LOOP_PROGRESS },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.loopRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          iterations: 1,
          progress: LOOP_PROGRESS,
        }),
      })
    );
    await app.close();
  });

  it("accepts the new event kinds and the gate approval kind", async () => {
    prismaMock.event.create.mockResolvedValue({
      id: "event-1",
      laneId: "codex",
      taskId: "task-1",
      kind: "loop.iteration",
      message: "iteration 1/3",
      metadata: {},
      timestamp: new Date("2026-07-10T10:00:00.000Z"),
    });
    prismaMock.approvalRequest.create.mockResolvedValue({
      id: "approval-1",
      taskId: "task-1",
      status: "pending",
    });
    prismaMock.task.update.mockResolvedValue({ id: "task-1", status: "review" });

    const app = buildApp();

    const event = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        laneId: "codex",
        taskId: "task-1",
        kind: "loop.iteration",
        message: "iteration 1/3",
      },
    });
    expect(event.statusCode).toBe(201);

    const approval = await app.inject({
      method: "POST",
      url: "/api/approvals",
      payload: {
        taskId: "task-1",
        requestedBy: "muon-loop",
        kind: "gate",
        reason: "loop exhausted after 3 iterations",
      },
    });
    expect(approval.statusCode).toBe(201);
    await app.close();
  });

  it("records and replays agent stream chunks with a seq cursor", async () => {
    prismaMock.streamChunk.createMany.mockResolvedValue({ count: 4 });
    prismaMock.streamChunk.findMany.mockResolvedValue([
      {
        seq: 41,
        taskId: "task-1",
        laneId: "lane-cx",
        sessionId: null,
        runId: "run-1",
        kind: "output",
        content: "Reading src/auth/limiter.ts",
        timestamp: new Date("2026-07-10T10:00:00.000Z"),
      },
    ]);

    const app = buildApp();

    const recorded = await app.inject({
      method: "POST",
      url: "/api/streams",
      payload: {
        chunks: [
          {
            taskId: "task-1",
            laneId: "lane-cx",
            runId: "run-1",
            content: "Reading src/auth/limiter.ts",
          },
          {
            taskId: "task-1",
            laneId: "lane-cx",
            runId: "run-1",
            kind: "milestone",
            content: "[task.completed] Command completed",
          },
          {
            taskId: "task-1",
            laneId: "lane-cx",
            runId: "run-1",
            kind: "activity",
            content: "Read started",
          },
          {
            taskId: "task-1",
            laneId: "lane-cx",
            runId: "run-1",
            kind: "output.message",
            content: "I inspected the file.",
          },
        ],
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().recorded).toBe(4);

    const replayed = await app.inject({
      method: "GET",
      url: "/api/streams?taskId=task-1&afterSeq=40",
    });
    expect(replayed.statusCode).toBe(200);
    // seq is a plain Int cursor, serialized directly as a JSON number.
    expect(replayed.json().chunks[0].seq).toBe(41);
    expect(prismaMock.streamChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          taskId: "task-1",
          seq: { gt: 40 },
        }),
      })
    );

    const missingFilter = await app.inject({
      method: "GET",
      url: "/api/streams",
    });
    expect(missingFilter.statusCode).toBe(400);
    await app.close();
  });

  it("atomically claims one task-scoped stream milestone", async () => {
    prismaMock.streamChunk.create.mockResolvedValue({ seq: 42 });
    const app = buildApp();

    const claimed = await app.inject({
      method: "POST",
      url: "/api/streams/claim",
      payload: {
        taskId: "chat-1",
        laneId: "muon-chat",
        claimKey: "terminal-job:w1",
        kind: "milestone",
        content: "[event] job w1 terminal",
      },
    });

    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toEqual({ claimed: true });
    expect(prismaMock.streamChunk.create).toHaveBeenCalledWith({
      data: {
        taskId: "chat-1",
        laneId: "muon-chat",
        dedupeKey: "terminal-job:w1",
        kind: "milestone",
        content: "[event] job w1 terminal",
      },
    });

    prismaMock.streamChunk.create.mockRejectedValueOnce({ code: "P2002" });
    const lost = await app.inject({
      method: "POST",
      url: "/api/streams/claim",
      payload: {
        taskId: "chat-1",
        laneId: "muon-chat",
        claimKey: "terminal-job:w1",
        kind: "milestone",
        content: "[event] job w1 terminal",
      },
    });
    expect(lost.statusCode).toBe(200);
    expect(lost.json()).toEqual({ claimed: false });
    await app.close();
  });

  it("returns the newest chunks first when latest=true", async () => {
    prismaMock.streamChunk.findMany.mockResolvedValue([
      {
        seq: 9,
        taskId: "task-1",
        laneId: "lane-cx",
        agentId: null,
        sessionId: null,
        runId: null,
        kind: "output",
        content: "newest",
        timestamp: new Date("2026-07-10T10:00:00.000Z"),
      },
    ]);

    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/streams?taskId=task-1&latest=true&limit=200",
    });
    expect(response.statusCode).toBe(200);
    expect(prismaMock.streamChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { seq: "desc" }, take: 200 })
    );
    await app.close();
  });

  it("passes request text through to routing suggestions", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/routing/suggest?text=fix%20the%20rate%20limiter",
    });

    expect(response.statusCode).toBe(200);
    expect(graphMock.suggestLanes).toHaveBeenCalledWith(
      undefined,
      "fix the rate limiter"
    );
    await app.close();
  });
});
