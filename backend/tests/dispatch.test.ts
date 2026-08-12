import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_DESCENDANTS,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
} from "@muon/protocol";
import { buildApp } from "../src/app.js";

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  runner: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  agent: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  delegationGrant: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  laneSession: {
    updateMany: vi.fn(),
  },
  approvalRequest: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  harness: {
    findUnique: vi.fn(),
  },
  crewRoleBinding: {
    findMany: vi.fn(),
  },
  orchestratorChat: {
    findUnique: vi.fn(),
  },
  streamChunk: {
    create: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  // A terminal write now also files the job's handoff row. This mocked world
  // has no Lane or Task rows (both `findUnique`s resolve undefined), so
  // `fileTerminalHandoff` declines to write and every assertion in this file
  // stays about the dispatch state machine, exactly as before. The filing
  // itself is proven end-to-end against real SQLite in
  // dispatch-terminal-handoff.test.ts.
  lane: {
    findUnique: vi.fn(),
  },
  task: {
    findUnique: vi.fn(),
  },
  handoff: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const JOB = {
  id: "job-1",
  kind: "auto",
  vendor: "claude-code",
  taskId: "task-1",
  brief: "fix the thing",
  status: "queued",
  agentId: null,
  host: null,
  runnerLeaseHash: null,
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  result: null,
  exitCode: null,
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  startedAt: null,
  endedAt: null,
};

const LEASE_TOKEN = `lease-${"a".repeat(58)}`;
const NEXT_LEASE_TOKEN = `lease-${"b".repeat(58)}`;
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const LEASE_HASH = hashLease(LEASE_TOKEN);
const NEXT_LEASE_HASH = hashLease(NEXT_LEASE_TOKEN);
const DELEGATION_TOKEN = `delegate-${"c".repeat(55)}`;
const DELEGATION_TOKEN_HASH = hashLease(DELEGATION_TOKEN);
const delegationHeaders = {
  "x-muon-delegation-token": DELEGATION_TOKEN,
};
const TEST_WORKSPACE = process.cwd();
function rootParent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const workspacePath = String(
    overrides.workspacePath ?? TEST_WORKSPACE
  );
  const delegationDeadline =
    (overrides.delegationDeadline as Date | undefined) ??
    new Date(Date.now() + 600_000);
  const id = String(overrides.id ?? "job-parent");
  return {
    ...JOB,
    id,
    kind: "session",
    chatId: "chat-1",
    status: "running",
    workspacePath,
    maxWallMs: 600_000,
    startedAt: new Date(),
    capabilityMode: "orchestrator",
    delegationDepth: 0,
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 2,
    delegationChildrenIssued: 0,
    delegationDescendantsIssued: 0,
    delegationBudgetReservedMs: 0,
    delegationDeadline,
    delegationManifest: {
      version: 1,
      jobId: id,
      workspacePath,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      maxIterations: 2,
      deadlineAt: delegationDeadline.toISOString(),
      authority: "orchestrator",
      childAuthority: "work",
      narrowingRequired: true,
    },
    ...overrides,
  };
}
const LIVE_RUNNER = {
  id: "r1",
  host: "desktop-mac",
  pid: 41,
  leaseHash: LEASE_HASH,
  status: "online",
  lastSeenAt: new Date(),
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
};
const AGENT = {
  id: "agent-1",
  vendor: "claude-code",
  name: "claude-code-1",
  ordinal: 1,
  status: "idle",
  currentTaskId: null,
  currentJobId: null,
  sessionId: null,
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  updatedAt: new Date("2026-07-10T00:00:00.000Z"),
};

describe("dispatch + runner API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchJob.create.mockResolvedValue(JOB);
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.findMany.mockResolvedValue([JOB]);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(JOB);
    prismaMock.dispatchJob.update.mockResolvedValue(JOB);
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.dispatchJob.count.mockReset().mockResolvedValue(0);
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: TEST_WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: null,
      vendorSessionVendor: null,
      vendorSessionRootJobId: null,
    });
    prismaMock.agent.findFirst.mockResolvedValue(AGENT);
    prismaMock.agent.findUnique.mockResolvedValue({
      ...AGENT,
      status: "working",
      currentTaskId: JOB.taskId,
      currentJobId: JOB.id,
    });
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.runner.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.laneSession.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.approvalRequest.findMany.mockResolvedValue([]);
    prismaMock.streamChunk.findMany.mockResolvedValue([]);
    prismaMock.streamChunk.create.mockResolvedValue({ seq: 1 });
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-parent",
      tokenHash: DELEGATION_TOKEN_HASH,
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    prismaMock.delegationGrant.upsert.mockResolvedValue({});
    // Wave 0: harnessKey existence check — default to "exists" so the many tests
    // that pass a real harnessKey ("repair") still reach 201; the unknown-key
    // test overrides this to null.
    prismaMock.harness.findUnique.mockResolvedValue({ key: "repair" });
    // VISION §2 role resolution: no crew plan bound by default, so a dispatch
    // falls through to its harness (or the `implementer` default).
    prismaMock.crewRoleBinding.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(
      async (
        work:
          | ((tx: typeof prismaMock) => unknown)
          | Promise<unknown>[]
      ) =>
        Array.isArray(work) ? Promise.all(work) : work(prismaMock)
    );
  });

  it("enqueues a job (queued) and lists queued jobs oldest-first", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: { vendor: "claude-code", taskId: "task-1", brief: "fix the thing" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().job.status).toBe("queued");

    const listed = await app.inject({
      method: "GET",
      url: "/api/dispatch?status=queued",
    });
    expect(listed.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } })
    );
    await app.close();
  });

  it("enriches each job from its exact run stream and pending approval state", async () => {
    const producing = {
      ...JOB,
      id: "job-live",
      status: "running",
      agentId: "agent-a",
      startedAt: "2026-07-19T11:59:00.000Z",
    };
    const silent = {
      ...JOB,
      id: "job-silent",
      status: "running",
      agentId: "agent-b",
      startedAt: "2026-07-19T11:59:00.000Z",
    };
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([producing, silent]);
    prismaMock.streamChunk.findMany.mockResolvedValueOnce([
      {
        runId: "job-live",
        timestamp: new Date("2026-07-19T12:00:00.000Z"),
        kind: "milestone",
        content: "[task.progress] muon.dispatch started",
      },
    ]);
    prismaMock.approvalRequest.findMany.mockResolvedValueOnce([
      { jobId: "job-live" },
    ]);

    const app = buildApp();
    const listed = await app.inject({
      method: "GET",
      url: "/api/dispatch?activeOnly=true",
    });
    expect(listed.statusCode).toBe(200);
    const jobs = listed.json().jobs as Array<{
      id: string;
      lastProgressAt: string | null;
      waitingApproval: boolean;
      currentActivity: string | null;
    }>;
    const byId = Object.fromEntries(jobs.map((j) => [j.id, j.lastProgressAt]));
    expect(byId["job-live"]).toBe("2026-07-19T12:00:00.000Z");
    expect(byId["job-silent"]).toBeNull();
    expect(jobs.find((job) => job.id === "job-live")).toMatchObject({
      waitingApproval: true,
      currentActivity: "[task.progress] muon.dispatch started",
    });
    expect(prismaMock.streamChunk.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["job-live", "job-silent"] } },
      orderBy: { seq: "desc" },
      distinct: ["runId"],
      select: {
        runId: true,
        timestamp: true,
        kind: true,
        content: true,
      },
    });
    expect(prismaMock.approvalRequest.findMany).toHaveBeenCalledWith({
      where: {
        jobId: { in: ["job-live", "job-silent"] },
        status: "pending",
      },
      select: { jobId: true },
    });
    await app.close();
  });

  it("does not attribute a reused agent's predecessor output to a fresh run", async () => {
    const reusedSilent = {
      ...JOB,
      id: "job-reused",
      status: "running",
      agentId: "agent-a",
      startedAt: "2026-07-19T12:05:00.000Z",
    };
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([reusedSilent]);

    const app = buildApp();
    const listed = await app.inject({ method: "GET", url: "/api/dispatch?activeOnly=true" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs[0].lastProgressAt).toBeNull();
    await app.close();
  });

  it("queries exact run coordinates even before a fleet agent is assigned", async () => {
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([{ ...JOB, agentId: null }]);
    const app = buildApp();
    const listed = await app.inject({ method: "GET", url: "/api/dispatch?status=queued" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs[0].lastProgressAt).toBeNull();
    expect(prismaMock.streamChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: { in: [JOB.id] } },
      })
    );
    await app.close();
  });

  it("persists bounded task-scoped execution budgets on the dispatch job", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "loop",
        vendor: "codex",
        taskId: "task-budget",
        brief: "repair until green",
        harnessKey: "repair",
        maxIterations: 3,
        maxWallMs: 45_000,
        checks: [{ name: "lint", command: "npm run lint" }],
        iterationTimeoutMs: 30_000,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "loop",
        vendor: "codex",
        taskId: "task-budget",
        maxIterations: 3,
        maxWallMs: 45_000,
        checks: [{ name: "lint", command: "npm run lint" }],
        iterationTimeoutMs: 30_000,
      }),
    });
    await app.close();
  });

  it("rejects an unknown harnessKey with a 400 and enqueues nothing (Wave 0)", async () => {
    prismaMock.harness.findUnique.mockResolvedValue(null); // "custom" is not registered
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-x",
        brief: "explore the codebase",
        harnessKey: "custom",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Unknown harnessKey 'custom'/);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("issues a delegation capability only to the exact lease-holding runner", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent({
        status: "running",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      })
    );
    const app = buildApp();
    const issued = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegation-token",
      payload: {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(issued.statusCode).toBe(200);
    expect(issued.json().token).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.json().canDelegate).toBe(true);
    expect(prismaMock.delegationGrant.upsert).toHaveBeenCalledWith({
      where: { jobId: "job-parent" },
      create: expect.objectContaining({
        jobId: "job-parent",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      update: expect.objectContaining({
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    await app.close();
  });

  it("persists session resume and fail-closed approval timing", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "task-session",
        brief: "continue the repair",
        resumeVendorSessionId: "claude-session-42",
        approvalTimeoutMs: 90_000,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "session",
        resumeVendorSessionId: "claude-session-42",
        approvalTimeoutMs: 90_000,
      }),
    });
    await app.close();
  });

  it("atomically refuses a second active root dispatch for the same chat", async () => {
    prismaMock.dispatchJob.findFirst.mockResolvedValue({
      id: "job-existing-root",
      status: "running",
    });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "codex",
        taskId: "task-chat",
        chatId: "chat-1",
        brief: "start a duplicate root",
        humanMessage: "start a duplicate root",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(
      /already has active root dispatch 'job-existing-root'/i
    );
    expect(prismaMock.dispatchJob.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: "chat-1",
        parentJobId: null,
        status: { in: ["queued", "running"] },
      },
      select: { id: true, status: true },
    });
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    expect(prismaMock.streamChunk.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("commits the trusted human turn in the same transaction as its root", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "task-chat",
        chatId: "chat-1",
        brief: "investigate the parser",
        humanMessage: "investigate the parser",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prismaMock.streamChunk.create).toHaveBeenCalledWith({
      data: {
        taskId: "chat-1",
        laneId: "muon-chat",
        runId: JOB.id,
        kind: "user.message",
        content: "[you] investigate the parser",
      },
    });
    await app.close();
  });

  it("derives a root dispatch task partition from the owning chat", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "codex",
        taskId: "attacker-selected-task",
        chatId: "chat-1",
        brief: "inspect the canonical chat task",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: "chat-1",
        taskId: "task-chat-canonical",
      }),
    });
    await app.close();
  });

  it("rejects a root resume session not bound to the owning chat and vendor", async () => {
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: TEST_WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: "owned-claude-session",
      vendorSessionVendor: "claude-code",
      vendorSessionRootJobId: "job-original-root",
    });
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "task-chat-canonical",
        chatId: "chat-1",
        brief: "resume a foreign provider session",
        resumeVendorSessionId: "foreign-claude-session",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(
      /not the exact server-bound continuity handle/i
    );
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("admits the exact provider session bound to the owning chat and vendor", async () => {
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: TEST_WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: "owned-claude-session",
      vendorSessionVendor: "claude-code",
      vendorSessionRootJobId: "job-original-root",
    });
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "attacker-selected-task",
        chatId: "chat-1",
        brief: "resume the owned provider session",
        resumeVendorSessionId: "owned-claude-session",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task-chat-canonical",
        resumeVendorSessionId: "owned-claude-session",
      }),
    });
    await app.close();
  });

  it("maps the active-root database race to an actionable conflict", async () => {
    prismaMock.dispatchJob.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["chatId"] },
    });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: { authorization: "Bearer operator-token" },
      payload: {
        kind: "session",
        vendor: "codex",
        taskId: "task-chat-race",
        chatId: "chat-1",
        brief: "race another root",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(
      /acquired another active root dispatch concurrently/i
    );
    await app.close();
  });

  it("refuses to resume a chat-bound job outside its exact chat partition", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValueOnce({
      status: "interrupted",
      chatId: "chat-owned",
    });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "task-attacker-selected",
        brief: "replay without the owning chat fence",
        workspacePath: TEST_WORKSPACE,
        resumedFromJobId: "job-chat-interrupted",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(
      /exact owning chat partition/i
    );
    expect(prismaMock.orchestratorChat.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates a bounded work-only child with server-derived lineage", async () => {
    const parent = rootParent();
    prismaMock.dispatchJob.findUnique.mockResolvedValue(parent);
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        parentJobId: "job-parent",
        rootJobId: "job-parent",
        delegationDepth: 1,
        capabilityMode: "delegate",
        chatId: "chat-1",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
        delegationManifest: expect.objectContaining({
          authority: "work",
          forbiddenAuthority: ["govern", "approve", "merge", "ship"],
          narrowingAttested: true,
        }),
      }),
    });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "job-parent",
        delegationChildrenIssued: { lt: 3 },
        delegationDescendantsIssued: { lt: 8 },
      }),
      data: {
        delegationChildrenIssued: { increment: 1 },
        delegationDescendantsIssued: { increment: 1 },
        delegationBudgetReservedMs: { increment: 120_000 },
      },
    });
    await app.close();
  });

  it("rejects delegation after the owning chat is archived", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      status: "archived",
      workspacePath: TEST_WORKSPACE,
    });
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "must not start",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("S6 delegates a child with a validated model, persisting ONLY {model} in actionProfilePatch", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
        model: "gpt-5-codex",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        capabilityMode: "delegate",
        actionProfilePatch: { model: "gpt-5-codex" },
      }),
    });
    await app.close();
  });

  it("S6 refuses a guarded model on delegate (400); nothing enqueued", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
        model: "--strict-mcp-config",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/model/i);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("S6 surfaces an unverified-but-allowed model warning on delegate", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
        model: "opus",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().warnings?.length).toBeGreaterThan(0);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actionProfilePatch: { model: "opus" } }),
    });
    await app.close();
  });

  it("S6 rejects a wider action patch on the strict delegate schema (400); nothing enqueued", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
        actionProfilePatch: { permissionMode: "full-auto" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["depth", { delegationDepth: 3 }, {}, /depth/i],
    ["child count", {}, { firstCount: 3 }, /child/i],
    ["root capacity", {}, { secondCount: 8 }, /descendant|capacity/i],
  ])("rejects delegation beyond the %s limit", async (
    _label,
    parentPatch,
    counts,
    reason
  ) => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent(parentPatch)
    );
    prismaMock.dispatchJob.count.mockReset().mockResolvedValue(0);
    if (Object.keys(counts).length > 0) {
      prismaMock.dispatchJob.count
        .mockResolvedValueOnce(
          (counts as { firstCount?: number }).firstCount ?? 0
        )
        .mockResolvedValueOnce(
          (counts as { secondCount?: number }).secondCount ?? 0
        );
    }
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: `${TEST_WORKSPACE}/packages/parser`,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(reason);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      "workspace escape",
      { workspacePath: "/tmp/outside-muon", maxWallMs: 120_000 },
      /workspace/i,
    ],
    [
      "wall budget widening",
      { workspacePath: TEST_WORKSPACE, maxWallMs: 700_000 },
      /budget|wall/i,
    ],
    [
      "authority injection",
      {
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
        authority: "govern",
      },
      /unrecognized|authority/i,
    ],
  ])("fails closed on delegated %s", async (_label, payload, reason) => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        ...payload,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(reason);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a shared agent credential without the exact parent job capability", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-parent",
      tokenHash: DELEGATION_TOKEN_HASH,
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: {
        "x-muon-delegation-token": `foreign-${"d".repeat(56)}`,
      },
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("inherits the parent iteration cap when a loop child omits it", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "loop",
        vendor: "codex",
        taskId: "task-child",
        brief: "Repair the parser",
        harnessKey: "repair",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        maxIterations: 2,
        maxDelegationIterations: 2,
      }),
    });
    await app.close();
  });

  it("cannot widen a nested loop beyond its immediate parent budget", async () => {
    const root = rootParent({
      id: "job-root",
      maxDelegationIterations: 10,
      delegationManifest: {
        version: 1,
        jobId: "job-root",
        workspacePath: TEST_WORKSPACE,
        maxDepth: 3,
        maxChildrenPerParent: 3,
        maxTotalDescendants: 8,
        maxIterations: 10,
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
        authority: "orchestrator",
        childAuthority: "work",
        narrowingRequired: true,
      },
    });
    const deadline = root.delegationDeadline as Date;
    root.delegationManifest = {
      ...(root.delegationManifest as Record<string, unknown>),
      deadlineAt: deadline.toISOString(),
    };
    const parent = {
      ...rootParent(),
      id: "job-parent",
      kind: "loop",
      rootJobId: "job-root",
      parentJobId: "job-root",
      delegationDepth: 1,
      capabilityMode: "delegate",
      maxIterations: 2,
      maxDelegationIterations: 10,
      delegationDeadline: deadline,
      delegationManifest: {
        version: 1,
        rootJobId: "job-root",
        parentJobId: "job-root",
        jobId: "job-parent",
        depth: 1,
        maxDepth: 3,
        maxChildrenPerParent: 3,
        maxTotalDescendants: 8,
        rootWorkspace: TEST_WORKSPACE,
        workspacePath: TEST_WORKSPACE,
        budget: { maxWallMs: 600_000, maxIterations: 2 },
        deadlineAt: deadline.toISOString(),
        delegationIterationCap: 10,
        authority: "work",
        forbiddenAuthority: ["govern", "approve", "merge", "ship"],
        canDelegate: true,
        // Must equal the bounded delegate policy the manifest validator checks,
        // or the route rejects this parent's stored manifest as malformed (409)
        // before it can reach the iteration-cap check this test is about.
        propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
        narrowingAttested: true,
      },
    };
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(root);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "loop",
        vendor: "codex",
        taskId: "task-grandchild",
        brief: "Repair the parser again",
        maxIterations: 3,
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/iteration|parent/i);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses new descendants after cancellation has begun", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent({ interruptRequested: true })
    );
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Escape the cancellation snapshot",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/interrupt|cancel/i);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when an atomic capacity reservation loses a concurrent race", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatch(/concurrent|capacity/i);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a symlink that escapes the canonical delegated root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "muon-delegate-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "muon-delegate-outside-"));
    const link = path.join(root, "escape");
    mkdirSync(path.join(outside, "work"));
    symlinkSync(path.join(outside, "work"), link);
    try {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(
        rootParent({ workspacePath: root })
      );
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: "task-child",
          brief: "Work outside by symlink",
          workspacePath: link,
          maxWallMs: 120_000,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/workspace|root|symlink/i);
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("claims the fleet agent and job in one lease-fenced transaction", async () => {
    const app = buildApp();
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-1",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    const first = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().agent).toMatchObject({
      id: "agent-1",
      status: "working",
      currentTaskId: "task-1",
    });
    expect(prismaMock.agent.updateMany).toHaveBeenCalledWith({
      where: { id: "agent-1", status: "idle" },
      data: {
        status: "working",
        currentTaskId: "task-1",
        currentJobId: "job-1",
        sessionId: null,
      },
    });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1", status: "queued" },
        data: expect.objectContaining({
          agentId: "agent-1",
          host: "desktop-mac",
          runnerLeaseHash: LEASE_HASH,
        }),
      })
    );
    await app.close();
  });

  it("replays a response-lost claim idempotently for the same runner lease", async () => {
    const running = {
      ...JOB,
      status: "running",
      agentId: "agent-1",
      host: "desktop-mac",
      runnerLeaseHash: LEASE_HASH,
    };
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(running);
    prismaMock.agent.findUnique.mockResolvedValue({
      ...AGENT,
      status: "working",
      currentTaskId: JOB.taskId,
      currentJobId: JOB.id,
    });
    const app = buildApp();

    const replay = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(replay.statusCode).toBe(201);
    expect(replay.json().job).toMatchObject({
      id: "job-1",
      status: "running",
      agentId: "agent-1",
    });
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a claim without an active secret runner lease", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(null);
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: {
        host: "desktop-mac",
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("steer queues a message; drain returns and clears it", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      // codex accepts live steer (canSend:true); claude-code is rejected below.
      vendor: "codex",
      status: "running",
      host: "desktop-mac",
      runnerLeaseHash: LEASE_HASH,
      steerMessages: ["first"],
    });
    const app = buildApp();

    const steer = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer",
      payload: { message: "second" },
    });
    expect(steer.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        steerMessages: { equals: ["first"] },
      },
      data: { steerMessages: ["first", "second"] },
    });

    const drain = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer/drain",
      payload: {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });
    expect(drain.statusCode).toBe(200);
    expect(drain.json().messages).toEqual(["first"]);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        status: "running",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
        steerMessages: { equals: ["first"] },
      },
      data: { steerMessages: [] },
    });
    await app.close();
  });

  it("retries a steer append when a concurrent writer wins the snapshot", async () => {
    prismaMock.dispatchJob.findUnique
      // #1 is requireJobControl's fetch → the steer capability gate reads its
      // vendor; codex accepts live steer.
      .mockResolvedValueOnce({ ...JOB, vendor: "codex" })
      .mockResolvedValueOnce({
        ...JOB,
        steerMessages: ["first"],
      })
      .mockResolvedValueOnce({
        ...JOB,
        steerMessages: ["first", "concurrent"],
      });
    prismaMock.dispatchJob.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const app = buildApp();

    const steer = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer",
      payload: { message: "second" },
    });

    expect(steer.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "job-1",
        steerMessages: { equals: ["first", "concurrent"] },
      },
      data: { steerMessages: ["first", "concurrent", "second"] },
    });
    await app.close();
  });

  it("rejects a live steer to a canSend:false vendor (claude-code) with an honest reason", async () => {
    // JOB.vendor === "claude-code" (canSend:false): its SDK session driver's
    // send() throws, so a queued steer could never be delivered. The route must
    // reject honestly instead of advertising an interactive steer that no-ops.
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      status: "running",
    });
    const app = buildApp();

    const steer = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer",
      payload: { message: "focus on the API" },
    });

    expect(steer.statusCode).toBe(400);
    expect(steer.json().message).toMatch(/cannot accept a live steer/i);
    await app.close();
  });

  it("lets only the lease-holding runner requeue a drained steer", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      status: "running",
      host: "desktop-mac",
      runnerLeaseHash: LEASE_HASH,
      steerMessages: [],
    });
    const app = buildApp();

    const requeue = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer/requeue",
      payload: {
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        message: "try again",
      },
    });

    expect(requeue.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-1",
        status: "running",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
        steerMessages: { equals: [] },
      },
      data: { steerMessages: ["try again"] },
    });
    await app.close();
  });

  it("does not let a shared agent credential drain another runner's steer queue", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const drain = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/steer/drain",
      payload: {
        host: "desktop-mac",
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });

    expect(drain.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("interrupt flags the job", async () => {
    prismaMock.dispatchJob.update.mockResolvedValue({
      ...JOB,
      interruptRequested: true,
    });
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/interrupt",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.interruptRequested).toBe(true);
    await app.close();
  });

  it("interrupts only the selected job subtree and terminalizes queued descendants", async () => {
    const parent = {
      ...JOB,
      id: "job-child",
      status: "running",
      rootJobId: "job-root",
      parentJobId: "job-root",
    };
    prismaMock.dispatchJob.findUnique.mockResolvedValue(parent);
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([
      parent,
      {
        ...JOB,
        id: "job-grandchild",
        status: "queued",
        rootJobId: "job-root",
        parentJobId: "job-child",
      },
      {
        ...JOB,
        id: "job-sibling",
        status: "running",
        rootJobId: "job-root",
        parentJobId: "job-root",
      },
    ]);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-child/interrupt",
    });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["job-child", "job-grandchild"] },
        status: "queued",
      },
      data: expect.objectContaining({
        status: "interrupted",
        interruptRequested: true,
      }),
    });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["job-child", "job-grandchild"] },
        status: "running",
      },
      data: { interruptRequested: true },
    });
    expect(
      prismaMock.dispatchJob.updateMany.mock.calls.some((call) =>
        JSON.stringify(call).includes("job-sibling")
      )
    ).toBe(false);
    await app.close();
  });

  it("reclaim interrupts a prior lease's orphaned running jobs instead of replaying them", async () => {
    prismaMock.runner.findFirst.mockResolvedValue({
      ...LIVE_RUNNER,
      pid: 99,
      leaseHash: NEXT_LEASE_HASH,
    });
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([
      {
        ...JOB,
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      },
    ]);
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/reclaim",
      payload: { host: "desktop-mac", leaseToken: NEXT_LEASE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reclaimed).toBe(1);
    // Only prior incarnations on this host are scanned.
    expect(prismaMock.dispatchJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "running",
          host: "desktop-mac",
          OR: [
            { runnerLeaseHash: null },
            { runnerLeaseHash: { not: NEXT_LEASE_HASH } },
          ],
        },
      })
    );
    // Terminal interruption + guarded agent release happen in one transaction.
    // The successor must never replay work whose old vendor process may still
    // be mutating the workspace.
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job-1",
          status: "running",
          runnerLeaseHash: LEASE_HASH,
        }),
        data: {
          status: "interrupted",
          result:
            "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
          exitCode: null,
          endedAt: expect.any(Date),
        },
      })
    );
    expect(prismaMock.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "agent-7",
          currentTaskId: "task-1",
          currentJobId: "job-1",
          status: "working",
        },
        data: {
          status: "idle",
          currentTaskId: null,
          currentJobId: null,
          sessionId: null,
        },
      })
    );
    // Checkpoint edge (P0.1 Slice A): the dead incarnation's live sessions
    // (running or gate-paused) are marked interrupted IN THE SAME transaction,
    // so a later resume can prove a pre-death approval was never deliverable.
    expect(prismaMock.laneSession.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: "job-1",
        status: { in: ["running", "waiting_approval"] },
      },
      data: { status: "interrupted", endedAt: expect.any(Date) },
    });
    // Pending ApprovalRequests are NOT touched: the exact pending gate survives
    // for the human (REC-025: reclaim never requeues, never decides).
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects stale terminal writes and atomically releases the active lease's agent", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      })
      .mockResolvedValueOnce({
        ...JOB,
        status: "done",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    const app = buildApp();

    const allowed = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "ok",
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(allowed.statusCode).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "job-1",
          status: "running",
          runnerLeaseHash: LEASE_HASH,
        },
      })
    );
    expect(prismaMock.agent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "agent-7",
          currentTaskId: "task-1",
          currentJobId: "job-1",
          status: "working",
        },
      })
    );

    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (work: (tx: typeof prismaMock) => unknown) => work(prismaMock)
    );
    prismaMock.runner.findFirst.mockResolvedValue(null);
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "stale",
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });
    expect(denied.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts an exact-lease terminal commit after heartbeat freshness lapses, unless a successor changed the lease", async () => {
    const staleRunner = {
      ...LIVE_RUNNER,
      lastSeenAt: new Date(Date.now() - 60_000),
    };
    prismaMock.runner.findFirst.mockImplementation(
      async (args?: { where?: Record<string, unknown> }) =>
        args?.where && "lastSeenAt" in args.where ? null : staleRunner
    );
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      })
      .mockResolvedValueOnce({
        ...JOB,
        status: "done",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "completed while the brain was briefly unavailable",
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.runner.findFirst).toHaveBeenCalledWith({
      where: {
        host: "desktop-mac",
        leaseHash: LEASE_HASH,
      },
    });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledOnce();
    await app.close();
  });

  it("keeps the claimed agent immutable on terminal updates", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      status: "running",
      agentId: "agent-7",
      host: "desktop-mac",
      runnerLeaseHash: LEASE_HASH,
    });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "attempted reassignment",
        agentId: "agent-attacker",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/agent assignment/i);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("treats an exact terminal retry as a no-op and never releases a reassigned agent", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      status: "done",
      agentId: "agent-7",
      host: "desktop-mac",
      runnerLeaseHash: LEASE_HASH,
      result: "ok",
      exitCode: 0,
      endedAt: new Date("2026-07-13T12:00:00.000Z"),
    });
    const app = buildApp();

    const replay = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(replay.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists a typed terminal handoff packet on the dispatch job (P0.3)", async () => {
    const V2_PACKET = {
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
      checks: [{ name: "tests", outcome: "passed", summary: "12 passed" }],
      artifacts: [],
      uncertainties: [],
      unresolvedDecisions: [],
      recommendedNextAction: "Continue in the review lane.",
      memoryProposals: [],
      degraded: { flag: false, reasons: [] },
    };
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      })
      .mockResolvedValueOnce({
        ...JOB,
        status: "done",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        packet: V2_PACKET,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "done",
          packetJson: V2_PACKET,
        }),
      })
    );
    await app.close();
  });

  it("keeps the v1 terminal wire parsing and persists nothing extra without a packet", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      })
      .mockResolvedValueOnce({
        ...JOB,
        status: "failed",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "failed",
        result: "vendor exited 1",
        exitCode: 1,
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    const data = prismaMock.dispatchJob.updateMany.mock.calls[0]![0]
      .data as Record<string, unknown>;
    expect("packetJson" in data).toBe(false);
    await app.close();
  });

  it("rejects a malformed terminal packet with 400 before any write", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "ok",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        packet: { taskGoal: "x" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an oversized terminal packet measured in bytes, not UTF-16 units", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    const app = buildApp();

    // "€" is one UTF-16 code unit but three UTF-8 bytes: ~100k of them stay
    // under the 262,144 *code-unit* count yet blow past the 262,144-*byte* wire
    // backstop. A `.length` check would wave this through; `Buffer.byteLength`
    // rejects it.
    const multibytePacket = {
      taskGoal: "Fix the parser crash",
      whatChanged: "€".repeat(100_000),
      whatFailed: "Nothing reported failing.",
      nextLaneRequest: "Review the run result and continue.",
      commandsRun: ["(command not captured)"],
      checksStatus: ["run: completed"],
      openQuestions: [],
      provenance: { lane: "codex", createdAt: "2026-07-16T00:00:00.000Z" },
      schemaVersion: 2,
      changedFiles: [],
      diffVerified: false,
      checks: [],
      artifacts: [],
      uncertainties: [],
      unresolvedDecisions: [],
      memoryProposals: [],
      degraded: { flag: false, reasons: [] },
    };
    const serialized = JSON.stringify(multibytePacket);
    // Intent guard: under the code-unit count, over the byte bound.
    expect(serialized.length).toBeLessThan(262_144);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(262_144);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-1",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
        packet: multibytePacket,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("runner heartbeat upserts by host; GET reports live within 15s", async () => {
    prismaMock.runner.findFirst.mockResolvedValueOnce(null);
    prismaMock.runner.create.mockResolvedValue({
      id: "r1",
      host: "mac",
      pid: 42,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    const app = buildApp();

    const hb = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: { host: "mac", pid: 42, leaseToken: LEASE_TOKEN },
    });
    expect(hb.statusCode).toBe(200);
    expect(prismaMock.runner.create).toHaveBeenCalledWith({
      data: { host: "mac", pid: 42, leaseHash: LEASE_HASH },
    });
    expect(hb.json().runner).not.toHaveProperty("leaseHash");

    prismaMock.runner.findFirst.mockResolvedValueOnce({
      id: "r1",
      host: "mac",
      pid: 42,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    const get = await app.inject({ method: "GET", url: "/api/runner" });
    expect(get.json().live).toBe(true);
    expect(get.json().runner).not.toHaveProperty("leaseHash");
    expect(prismaMock.runner.findFirst).toHaveBeenLastCalledWith({
      where: undefined,
      orderBy: { lastSeenAt: "desc" },
    });

    prismaMock.runner.findFirst.mockResolvedValueOnce({
      id: "r1",
      host: "mac",
      pid: 42,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    });
    const stale = await app.inject({ method: "GET", url: "/api/runner" });
    expect(stale.json().live).toBe(false);
    await app.close();
  });

  it("requires both a positive PID and a secret launch token for heartbeat", async () => {
    const app = buildApp();

    const missingPid = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: { host: "desktop-mac", leaseToken: LEASE_TOKEN },
    });
    const missingLease = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: { host: "desktop-mac", pid: 42 },
    });

    expect(missingPid.statusCode).toBe(400);
    expect(missingLease.statusCode).toBe(400);
    expect(prismaMock.runner.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("fences a second live runner PID from stealing the same host lease", async () => {
    prismaMock.runner.findFirst.mockResolvedValueOnce({
      id: "r1",
      host: "desktop-mac",
      pid: 41,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    prismaMock.runner.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: {
        host: "desktop-mac",
        pid: 99,
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(prismaMock.runner.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "r1" }),
      })
    );
    expect(prismaMock.runner.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows a new PID to take a host lease only after the prior heartbeat is stale", async () => {
    prismaMock.runner.findFirst.mockResolvedValueOnce({
      id: "r1",
      host: "desktop-mac",
      pid: 41,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    });
    prismaMock.runner.updateMany.mockResolvedValueOnce({ count: 1 });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: {
        host: "desktop-mac",
        pid: 99,
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().runner).toMatchObject({
      id: "r1",
      host: "desktop-mac",
      pid: 99,
    });
    expect(response.json().runner).not.toHaveProperty("leaseHash");
    await app.close();
  });

  it("maps a simultaneous first-heartbeat unique race to lease conflict", async () => {
    prismaMock.runner.findFirst.mockResolvedValueOnce(null);
    prismaMock.runner.create.mockRejectedValueOnce({ code: "P2002" });
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/runner/heartbeat",
      payload: {
        host: "desktop-mac",
        pid: 99,
        leaseToken: NEXT_LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/lease/i);
    await app.close();
  });

  it("filters runner status to the requested host", async () => {
    const runner = {
      id: "r-desktop-a",
      host: "desktop-a",
      pid: 43,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(),
      createdAt: new Date(),
    };
    prismaMock.runner.findFirst.mockResolvedValueOnce(runner);
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/runner?host=desktop-a",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runner: { id: "r-desktop-a", host: "desktop-a" },
      live: true,
    });
    expect(prismaMock.runner.findFirst).toHaveBeenCalledWith({
      where: { host: "desktop-a" },
      orderBy: { lastSeenAt: "desc" },
    });
    await app.close();
  });

  it("does not let another host's fresh heartbeat make the requested host live", async () => {
    const freshOtherHost = {
      id: "r-desktop-b",
      host: "desktop-b",
      pid: 44,
      leaseHash: NEXT_LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(),
      createdAt: new Date(),
    };
    const staleRequestedHost = {
      id: "r-desktop-a",
      host: "desktop-a",
      pid: 43,
      leaseHash: LEASE_HASH,
      status: "online",
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    };
    prismaMock.runner.findFirst.mockImplementation(
      async (args?: { where?: { host?: string } }) =>
        args?.where?.host === "desktop-a"
          ? staleRequestedHost
          : freshOtherHost
    );
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/runner?host=desktop-a",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runner: { id: "r-desktop-a", host: "desktop-a" },
      live: false,
    });
    await app.close();
  });

  it("returns the existing empty response for an unknown host", async () => {
    prismaMock.runner.findFirst.mockResolvedValueOnce(null);
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/runner?host=desktop-missing",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runner: null, live: false });
    expect(prismaMock.runner.findFirst).toHaveBeenCalledWith({
      where: { host: "desktop-missing" },
      orderBy: { lastSeenAt: "desc" },
    });
    await app.close();
  });

  it("rejects empty and oversized runner host filters", async () => {
    const app = buildApp();

    const empty = await app.inject({
      method: "GET",
      url: "/api/runner?host=%20%20",
    });
    const oversized = await app.inject({
      method: "GET",
      url: `/api/runner?host=${"x".repeat(201)}`,
    });

    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("validation_error");
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error).toBe("validation_error");
    expect(prismaMock.runner.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  // ── S1: budget release + right-sized child default ────────────────────────
  // `delegationBudgetReservedMs` was increment-only, so the first default child
  // reserved the whole 30-min pool and every sibling 409'd. These cover the
  // matching release on every terminal path and the right-sized default.

  const rootChild = (
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    ...JOB,
    id: "job-child",
    rootJobId: "job-root",
    parentJobId: "job-root",
    maxWallMs: 120_000,
    ...overrides,
  });

  it("releases a child's reservation to the root pool on its first terminal transition", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(
        rootChild({
          status: "running",
          agentId: "agent-7",
          host: "desktop-mac",
          runnerLeaseHash: LEASE_HASH,
          startedAt: new Date(Date.now() - 60_000),
        })
      )
      .mockResolvedValueOnce(
        rootChild({
          status: "done",
          agentId: "agent-7",
          host: "desktop-mac",
          runnerLeaseHash: LEASE_HASH,
        })
      );
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-child",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    // Guarded decrement (gte the child's own reservation → never negative) plus
    // the recorded spend, both against the ROOT, in one atomic updateMany.
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-root",
        delegationBudgetReservedMs: { gte: 120_000 },
      },
      data: {
        delegationBudgetReservedMs: { decrement: 120_000 },
        delegationBudgetConsumedMs: { increment: expect.any(Number) },
      },
    });
    await app.close();
  });

  it("does not release again on an exact-replay terminal retry", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootChild({
        status: "done",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
        result: "ok",
        exitCode: 0,
        endedAt: new Date("2026-07-16T00:00:00.000Z"),
      })
    );
    const app = buildApp();

    const replay = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-child",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    // Exact replay short-circuits before any write, so reserved is never
    // double-released (which would widen the fail-closed cap).
    expect(replay.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("a guarded release can never drive the root reserved counter negative", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(
        rootChild({
          status: "running",
          agentId: "agent-7",
          host: "desktop-mac",
          runnerLeaseHash: LEASE_HASH,
          startedAt: new Date(Date.now() - 5_000),
        })
      )
      .mockResolvedValueOnce(
        rootChild({
          status: "done",
          agentId: "agent-7",
          host: "desktop-mac",
          runnerLeaseHash: LEASE_HASH,
        })
      );
    // Transition commits (count 1); the guarded release loses its gte race
    // (count 0) — a would-be-negative decrement simply no-ops, and the terminal
    // commit still succeeds.
    prismaMock.dispatchJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    const app = buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/dispatch/job-child",
      payload: {
        status: "done",
        result: "ok",
        exitCode: 0,
        agentId: "agent-7",
        host: "desktop-mac",
        leaseToken: LEASE_TOKEN,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "job-root",
        delegationBudgetReservedMs: { gte: 120_000 },
      },
      data: {
        delegationBudgetReservedMs: { decrement: 120_000 },
        delegationBudgetConsumedMs: { increment: expect.any(Number) },
      },
    });
    await app.close();
  });

  it("releases queued descendants' reservations when an interrupt terminalizes them", async () => {
    const root = {
      ...JOB,
      id: "job-root",
      status: "running",
      delegationBudgetReservedMs: 120_000,
    };
    const queuedChild = rootChild({ status: "queued", startedAt: null });
    prismaMock.dispatchJob.findUnique.mockResolvedValue(root);
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([root, queuedChild]);
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-root/interrupt",
    });

    expect(res.statusCode).toBe(200);
    // The queued child never ran, so its full reservation returns (consumed 0);
    // the root itself has no rootJobId and is skipped.
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-root",
        delegationBudgetReservedMs: { gte: 120_000 },
      },
      data: {
        delegationBudgetReservedMs: { decrement: 120_000 },
        delegationBudgetConsumedMs: { increment: 0 },
      },
    });
    await app.close();
  });

  it("releases an orphaned child's reservation when the runner reclaims it", async () => {
    prismaMock.runner.findFirst.mockResolvedValue({
      ...LIVE_RUNNER,
      pid: 99,
      leaseHash: NEXT_LEASE_HASH,
    });
    prismaMock.dispatchJob.findMany.mockResolvedValueOnce([
      rootChild({
        status: "running",
        agentId: "agent-7",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
        startedAt: new Date(Date.now() - 30_000),
      }),
    ]);
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/reclaim",
      payload: { host: "desktop-mac", leaseToken: NEXT_LEASE_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reclaimed).toBe(1);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: "job-root",
        delegationBudgetReservedMs: { gte: 120_000 },
      },
      data: {
        delegationBudgetReservedMs: { decrement: 120_000 },
        delegationBudgetConsumedMs: { increment: expect.any(Number) },
      },
    });
    await app.close();
  });

  it("still 409s with the verbatim message when the aggregate pool is fully reserved", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent({ delegationBudgetReservedMs: 600_000 })
    );
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      "The root aggregate descendant wall-clock budget is exhausted."
    );
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("defaults an omitted child budget to the right-sized share, not deadline−now", async () => {
    const poolDeadline = new Date(Date.now() + 1_800_000);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent({ maxWallMs: 1_800_000, delegationDeadline: poolDeadline })
    );
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(res.statusCode).toBe(201);
    // A 30-min pool + a 30-min deadline would previously give the child the
    // whole ~1.8M ms; the right-sized default caps it at DEFAULT_CHILD_WALL_MS.
    expect(res.json().job.maxWallMs).toBe(DEFAULT_CHILD_WALL_MS);
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          delegationBudgetReservedMs: { increment: DEFAULT_CHILD_WALL_MS },
        }),
      })
    );
    await app.close();
  });

  it("lets three sequential default children enqueue against the fleet-scaled pool", async () => {
    // The pool is the DECOUPLED v2 descendant budget, so three default children
    // fit inside it by construction (3 × DEFAULT_CHILD_WALL_MS ≤ 8 ×
    // DEFAULT_CHILD_WALL_MS) whatever the child default is set to. Written as
    // an expression rather than a literal: this test exists to prove sibling
    // children ENQUEUE instead of 409-ing, and a hardcoded pool made it a test
    // of one particular number instead.
    const poolDeadline = new Date(Date.now() + 1_800_000);
    const pool = DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS;
    const rootWithReserved = (reservedMs: number) =>
      rootParent({
        maxWallMs: 1_800_000,
        maxDescendantWallMs: pool,
        delegationDeadline: poolDeadline,
        delegationBudgetReservedMs: reservedMs,
        delegationManifest: {
          version: 2,
          jobId: "job-parent",
          workspacePath: TEST_WORKSPACE,
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 2,
          maxDescendantWallMs: pool,
          deadlineAt: poolDeadline.toISOString(),
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
      });
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(rootWithReserved(0))
      .mockResolvedValueOnce(rootWithReserved(DEFAULT_CHILD_WALL_MS))
      .mockResolvedValueOnce(rootWithReserved(2 * DEFAULT_CHILD_WALL_MS));
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: `task-child-${i}`,
          brief: "Implement the parser fix",
          workspacePath: TEST_WORKSPACE,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().job.maxWallMs).toBe(DEFAULT_CHILD_WALL_MS);
    }
    await app.close();
  });

  // ---- S3: coordinator topology + fleet-scaled descendant pool ----

  it("mints a v2 chat root with a fleet-scaled descendant pool decoupled from the turn budget", async () => {
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: "chat-turn",
        brief: "orchestrate the fleet",
        chatId: "chat-42",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(created.statusCode).toBe(201);
    // Turn timeout stays 30 min; the descendant pool is DECOUPLED and sized to
    // the fleet (DELEGATION_MAX_DESCENDANTS × DEFAULT_CHILD_WALL_MS).
    const pool = DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS;
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        capabilityMode: "orchestrator",
        maxWallMs: 1_800_000,
        maxDescendantWallMs: pool,
        delegationManifest: expect.objectContaining({
          version: 2,
          maxDescendantWallMs: pool,
        }),
      }),
    });
    // The pool must stay inside the v2 schema ceiling (every descendant at the
    // per-child hard cap), or the root policy it is written into stops
    // validating and delegation dies at the manifest check.
    expect(pool).toBeLessThanOrEqual(DELEGATION_MAX_DESCENDANTS * 1_800_000);
    // …and a single child must never be able to consume a whole 30-min turn,
    // or the coordinator has no time left to report on the wave it launched.
    expect(DEFAULT_CHILD_WALL_MS).toBeLessThan(1_800_000);
    await app.close();
  });

  it("delegates against the decoupled fleet pool when the turn budget is fully reserved (v2 root)", async () => {
    const deadline = new Date(Date.now() + 1_800_000);
    const v2Root = rootParent({
      // 30-min turn timeout, fully reserved under the OLD pool (= maxWallMs)...
      maxWallMs: 1_800_000,
      delegationBudgetReservedMs: 1_800_000,
      // ...but the v2 fleet pool is 80 min, decoupled from the turn budget.
      maxDescendantWallMs: 4_800_000,
      delegationDeadline: deadline,
      delegationManifest: {
        version: 2,
        jobId: "job-parent",
        workspacePath: TEST_WORKSPACE,
        maxDepth: 3,
        maxChildrenPerParent: 3,
        maxTotalDescendants: 8,
        maxDescendantWallMs: 4_800_000,
        maxIterations: 2,
        deadlineAt: deadline.toISOString(),
        authority: "orchestrator",
        childAuthority: "work",
        narrowingRequired: true,
      },
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue(v2Root);
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
        maxWallMs: 120_000,
      },
    });

    // Under v1 (pool = maxWallMs, fully reserved) this 409s; the v2 pool leaves
    // ample room, so the sibling worker enqueues against the fleet-scaled budget.
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("keeps a v1 in-flight root on the fallback pool (its own turn budget), not the v2 fleet pool", async () => {
    // rootParent() is a v1 root with NO maxDescendantWallMs, so the pool falls
    // back to maxWallMs (600k). With 500k already reserved, the default child is
    // capped to the 100k of remaining POOL — proving a v1 root never silently
    // gains the 80-min v2 fleet pool.
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent({ delegationBudgetReservedMs: 500_000 })
    );
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: TEST_WORKSPACE,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().job.maxWallMs).toBe(100_000);
    await app.close();
  });

  it("an orchestrator chat root claims only the coordinator lane (ordinal 0)", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    const orchestratorJob = {
      ...JOB,
      capabilityMode: "orchestrator",
      chatId: "chat-1",
    };
    const coordinator = {
      ...AGENT,
      id: "coordinator-1",
      name: "claude-code-coordinator",
      ordinal: 0,
    };
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(orchestratorJob)
      .mockResolvedValueOnce({
        ...orchestratorJob,
        status: "running",
        agentId: "coordinator-1",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    prismaMock.agent.findFirst.mockResolvedValue(coordinator);
    prismaMock.agent.findUnique.mockResolvedValue({
      ...coordinator,
      status: "working",
      currentTaskId: JOB.taskId,
      currentJobId: JOB.id,
    });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: { host: "desktop-mac", leaseToken: LEASE_TOKEN },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().agent).toMatchObject({ id: "coordinator-1", ordinal: 0 });
    // The claim is scoped to the reserved coordinator ordinal, never a worker.
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vendor: "claude-code",
          status: "idle",
          ordinal: 0,
        }),
      })
    );
    await app.close();
  });

  it("never falls an orchestrator root through to a worker lane when no coordinator is idle", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      ...JOB,
      capabilityMode: "orchestrator",
      chatId: "chat-1",
    });
    // No coordinator available. Workers (ordinal >= 1) may be idle, but an
    // orchestrator must NOT claim one — it 409s instead.
    prismaMock.agent.findFirst.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: { host: "desktop-mac", leaseToken: LEASE_TOKEN },
    });

    expect(res.statusCode).toBe(409);
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ordinal: 0 }),
      })
    );
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("a worker job claims a worker lane (ordinal >= 1), never the coordinator", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findUnique
      .mockResolvedValueOnce(JOB)
      .mockResolvedValueOnce({
        ...JOB,
        status: "running",
        agentId: "agent-1",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-1/claim",
      payload: { host: "desktop-mac", leaseToken: LEASE_TOKEN },
    });

    expect(res.statusCode).toBe(201);
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vendor: "claude-code",
          status: "idle",
          ordinal: { gte: 1 },
        }),
      })
    );
    await app.close();
  });

  // ── CREW ROLE ON DISPATCH (VISION §2) ──────────────────────────────────────
  //
  // `DispatchJob.role` is what the runner narrows against and what A2A derives
  // peer identity from, so it is resolved SERVER-SIDE on every dispatch and
  // admitted fail-closed against the vendor's declared ceiling and the harness.
  describe("crew role resolution", () => {
    /** The harness row the route reads back, keyed as the caller asked. */
    function harnessRows(config?: unknown) {
      prismaMock.harness.findUnique.mockImplementation(
        async ({ where }: { where: { key: string } }) => ({
          key: where.key,
          config,
        })
      );
    }
    const createdRole = () =>
      prismaMock.dispatchJob.create.mock.calls.at(-1)?.[0]?.data?.role;

    it("1: an explicit role outranks the harness and is persisted", async () => {
      harnessRows();
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "codex",
          taskId: "task-1",
          brief: "look around",
          harnessKey: "research",
          role: "qa",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createdRole()).toBe("qa");
      await app.close();
    });

    it("2: a root chat job takes the coordinator seat", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          kind: "session",
          vendor: "claude-code",
          taskId: "task-chat-canonical",
          brief: "run the mission",
          chatId: "chat-1",
          workspacePath: TEST_WORKSPACE,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createdRole()).toBe("orchestrator");
      // The coordinator seat is authenticated by capability mode, so the crew
      // plan is never consulted for it.
      expect(prismaMock.crewRoleBinding.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("3: a delegate child inherits the chat's crew binding for its vendor", async () => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
      prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
      prismaMock.crewRoleBinding.findMany.mockResolvedValue([
        { role: "qa", fit: 0.9 },
        { role: "reviewer", fit: 0.4 },
      ]);
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: "task-child",
          brief: "check the fix",
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().job.role).toBe("qa");
      expect(prismaMock.crewRoleBinding.findMany).toHaveBeenCalledWith({
        where: { chatId: "chat-1", vendor: "codex", blocked: false },
        select: { role: true, fit: true },
      });
      await app.close();
    });

    it("3: the binding that agrees with the harness wins over a higher fit", async () => {
      harnessRows();
      prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
      prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
      prismaMock.crewRoleBinding.findMany.mockResolvedValue([
        { role: "qa", fit: 0.9 },
        { role: "reviewer", fit: 0.4 },
      ]);
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: "task-child",
          brief: "adjudicate the diff",
          harnessKey: "review",
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().job.role).toBe("reviewer");
      await app.close();
    });

    it("4: an un-planned dispatch takes the role its harness implies", async () => {
      harnessRows();
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "codex",
          taskId: "task-1",
          brief: "audit the auth path",
          harnessKey: "security-audit",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createdRole()).toBe("reviewer");
      await app.close();
    });

    it("5: a harness-less, plan-less dispatch falls back to implementer", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: { vendor: "codex", taskId: "task-1", brief: "fix the thing" },
      });
      expect(res.statusCode).toBe(201);
      expect(createdRole()).toBe("implementer");
      await app.close();
    });

    it("a delegate NEVER resolves to orchestrator, even from a binding", async () => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
      prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
      prismaMock.crewRoleBinding.findMany.mockResolvedValue([
        { role: "orchestrator", fit: 1 },
      ]);
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: "task-child",
          brief: "do the bounded work",
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json().job.role).toBe("implementer");
      await app.close();
    });

    it("refuses an explicit orchestrator role on a delegate (400); nothing enqueued", async () => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          vendor: "codex",
          taskId: "task-child",
          brief: "try to become the coordinator",
          role: "orchestrator",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/can never hold the 'orchestrator' role/i);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("admits cursor for a review-class role and refuses it for a write one", async () => {
      const app = buildApp();
      const reviewer = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "cursor",
          kind: "oneshot",
          taskId: "task-1",
          brief: "second opinion on the diff",
          role: "reviewer",
        },
      });
      expect(reviewer.statusCode).toBe(201);
      expect(createdRole()).toBe("reviewer");

      const implementer = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "cursor",
          kind: "oneshot",
          taskId: "task-1",
          brief: "write the fix",
          role: "implementer",
        },
      });
      expect(implementer.statusCode).toBe(400);
      expect(implementer.json().message).toMatch(/managed READ-ONLY lane/i);
      expect(prismaMock.dispatchJob.create).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("refuses opencode for implementer", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "must not enqueue",
          role: "implementer",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(
        /Vendor 'opencode' cannot hold the crew role 'implementer'/i
      );
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses opencode the coordinator seat, from either direction", async () => {
      const app = buildApp();
      // Asked for directly on a plain job: the seat is not claimable at all.
      const claimed = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "must not enqueue",
          role: "orchestrator",
        },
      });
      expect(claimed.statusCode).toBe(400);
      expect(claimed.json().message).toMatch(
        /'orchestrator' role belongs to a chat's root coordinator job/i
      );

      // And as the resolved role of a real chat root: opencode cannot hold it.
      const seated = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          kind: "session",
          vendor: "opencode",
          taskId: "task-chat-canonical",
          brief: "run the mission",
          chatId: "chat-1",
          workspacePath: TEST_WORKSPACE,
        },
      });
      expect(seated.statusCode).toBe(400);
      expect(seated.json().message).toMatch(
        /Vendor 'opencode' cannot hold the crew role 'orchestrator'/i
      );
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    // ── DELEGATION NARROWS ───────────────────────────────────────────────────
    //
    // The child's role drives `narrowProfileForRole` at launch, so a child that
    // could name a WIDER role than its parent would reach the vendor with write
    // authority its parent never held. Only `role` matters to these cases; the
    // rest of the parent fixture is the ordinary delegating parent.
    const parentRunningAs = (role: string | null) => {
      const parent = rootParent({ role });
      prismaMock.dispatchJob.findUnique.mockResolvedValue(parent);
      prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
      return parent;
    };
    const delegateAs = (
      app: ReturnType<typeof buildApp>,
      payload: Record<string, unknown>
    ) =>
      app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: { vendor: "codex", taskId: "task-child", ...payload },
      });

    it("refuses a read-only parent spawning a write-role child", async () => {
      parentRunningAs("scout");
      const app = buildApp();
      const res = await delegateAs(app, {
        brief: "write the fix for me",
        role: "implementer",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(
        /cannot hold more authority than its parent/i
      );
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("allows a read-only parent to spawn another read-only child", async () => {
      parentRunningAs("scout");
      const app = buildApp();
      const res = await delegateAs(app, {
        brief: "adjudicate this diff",
        role: "reviewer",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().job.role).toBe("reviewer");
      await app.close();
    });

    it("defaults a read-only parent's child to the parent's own role, never implementer", async () => {
      parentRunningAs("scout");
      const app = buildApp();
      const res = await delegateAs(app, { brief: "find the caller of this" });

      expect(res.statusCode).toBe(201);
      expect(res.json().job.role).toBe("scout");
      await app.close();
    });

    it("refuses a read-only parent handing its child a write harness", async () => {
      harnessRows();
      parentRunningAs("scout");
      const app = buildApp();
      const res = await delegateAs(app, {
        brief: "go implement this",
        harnessKey: "implement",
      });

      expect(res.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("lets a write parent narrow its child to a read-only role", async () => {
      parentRunningAs("implementer");
      const app = buildApp();
      const res = await delegateAs(app, {
        brief: "second opinion please",
        role: "reviewer",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().job.role).toBe("reviewer");
      await app.close();
    });

    it("leaves a role-less parent unconstrained (pre-role delegation is unchanged)", async () => {
      parentRunningAs(null);
      const app = buildApp();
      const res = await delegateAs(app, {
        brief: "implement the parser fix",
        role: "implementer",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().job.role).toBe("implementer");
      await app.close();
    });

    it("admits opencode for the scout slice it declares", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "locate the parser",
          role: "scout",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(createdRole()).toBe("scout");
      await app.close();
    });

    it("refuses a read-only role running a write harness (400)", async () => {
      harnessRows();
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "codex",
          taskId: "task-1",
          brief: "review, but with edit authority",
          harnessKey: "implement",
          role: "reviewer",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/read-only role 'reviewer' cannot do/i);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("refuses a read-only role on an unreadable custom harness (fail-closed)", async () => {
      harnessRows("this row's config is corrupt");
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "codex",
          taskId: "task-1",
          brief: "review under a harness nobody can read",
          harnessKey: "custom-thing",
          role: "reviewer",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("TODO 3.4: takes a well-formed opencode model override, and says what it could not verify", async () => {
      // This used to be a flat 400 for the whole vendor ("no managed model
      // catalog"). opencode's catalogue is unenumerable, not uncheckable — the
      // ids are `provider/model` — so the override is now admitted on FORM with
      // a warning naming the residual risk (membership in THIS operator's
      // configured providers), rather than refused outright.
      prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "locate the parser",
          role: "scout",
          model: "anthropic/claude-sonnet-5",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().warnings?.join(" ")).toMatch(/configured providers/i);
      expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actionProfilePatch: { model: "anthropic/claude-sonnet-5" },
        }),
      });
      await app.close();
    });

    it("TODO 3.4: refuses a BARE slug for opencode on form, before anything is enqueued", async () => {
      // The half of the lift that is not a widening: `sonnet` is a plausible
      // claude id and NOT an opencode one. Waving it through would spawn the
      // lane and fail inside the vendor, long after a job row existed.
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "locate the parser",
          role: "scout",
          model: "sonnet",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/provider\/model/);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("names the real reason when an action is asked of an action-less vendor", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor: "opencode",
          kind: "oneshot",
          taskId: "task-1",
          brief: "locate the parser",
          role: "scout",
          action: "plan",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/has no vendor-native action set/i);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    });
  });
});

describe("ADR-0048 — the route mints fileAuthority from the harness contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Same world as the main suite: the tx callback runs against prismaMock,
    // so `tx.dispatchJob.create` IS `prismaMock.dispatchJob.create`.
    prismaMock.$transaction.mockImplementation(
      async (
        work: ((tx: typeof prismaMock) => unknown) | Promise<unknown>[]
      ) => (Array.isArray(work) ? Promise.all(work) : work(prismaMock))
    );
    prismaMock.crewRoleBinding.findMany.mockResolvedValue([]);
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.dispatchJob.findMany.mockResolvedValue([]);
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.count.mockReset().mockResolvedValue(0);
    prismaMock.agent.findFirst.mockResolvedValue(AGENT);
    prismaMock.lane.findUnique.mockResolvedValue(undefined);
    prismaMock.task.findUnique.mockResolvedValue(undefined);
    // The delegate route authenticates the PARENT's delegation grant before
    // anything else; without this row every request 409s.
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-parent",
      tokenHash: DELEGATION_TOKEN_HASH,
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    prismaMock.delegationGrant.upsert.mockResolvedValue({});
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: TEST_WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: null,
      vendorSessionVendor: null,
      vendorSessionRootJobId: null,
    });
  });

  /** The harness row the route reads back, keyed as the caller asked. */
  function harnessRows(config?: unknown) {
    prismaMock.harness.findUnique.mockImplementation(
      async ({ where }: { where: { key: string } }) => ({
        key: where.key,
        config,
      })
    );
  }
  const mintedManifest = () =>
    prismaMock.dispatchJob.create.mock.calls.at(-1)?.[0]?.data
      ?.delegationManifest as { fileAuthority?: string } | undefined;

  it("a worktree-requiring harness mints edit", async () => {
    harnessRows({
      description: "implement-shaped",
      requires: { interactive: false, worktree: true, tools: [] },
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-edit-child",
        brief: "build the change in a worktree",
        harnessKey: "implement",
        role: "implementer",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mintedManifest()?.fileAuthority).toBe("edit");
    await app.close();
  });

  it("a harness that works in place mints read", async () => {
    harnessRows({
      description: "research-shaped",
      requires: { interactive: false, worktree: false, tools: [] },
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-read-child",
        brief: "investigate only",
        harnessKey: "research",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mintedManifest()?.fileAuthority).toBe("read");
    await app.close();
  });

  it("no harness at all mints read — omission is not permission", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-bare-child",
        brief: "no harness named",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mintedManifest()?.fileAuthority).toBe("read");
    await app.close();
  });

  it("a MALFORMED harness config mints read, never a throw", async () => {
    // config is a JSON column; a corrupted row must degrade to the
    // conservative authority rather than failing an otherwise-valid dispatch.
    harnessRows("not-an-object");
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(async ({ data }) => data);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        vendor: "codex",
        taskId: "task-corrupt-child",
        brief: "corrupted harness row",
        harnessKey: "implement",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mintedManifest()?.fileAuthority).toBe("read");
    await app.close();
  });
});
