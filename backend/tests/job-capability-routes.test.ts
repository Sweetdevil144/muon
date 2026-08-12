import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const OPERATOR = "operator-token-job-routes";
const AGENT = "agent-token-job-routes";
const ROOT_A_TOKEN = `root-a-${"a".repeat(58)}`;
const WORKER_A_TOKEN = `worker-a-${"b".repeat(56)}`;
const DELEGATE_A_TOKEN = `delegate-a-${"c".repeat(54)}`;
const ROOT_B_TOKEN = `root-b-${"d".repeat(58)}`;
const WORKSPACE = process.cwd();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

it("lets an active exact-job bearer prove agent tier without exposing coordinates", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/auth/session",
    headers: auth(ROOT_A_TOKEN),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    authenticated: true,
    tier: "agent",
    jobScoped: true,
  });
});

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-job-route-scope-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  await db.prisma.task.createMany({
    data: [
      {
        id: "task-root-a",
        title: "Chat A root",
        description: "Root task for chat A capability tests.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
      },
      {
        id: "task-child-a",
        title: "Chat A child",
        description: "Child task inside chat A capability tests.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
      },
      {
        id: "task-root-b",
        title: "Chat B root",
        description: "Root task for chat B capability tests.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
      },
      {
        id: "task-child-b",
        title: "Chat B child",
        description: "Child task inside chat B capability tests.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
      },
    ],
  });
  await db.prisma.orchestratorChat.createMany({
    data: [
      {
        id: "chat-a",
        title: "Chat A",
        workspacePath: WORKSPACE,
        taskId: "task-root-a",
      },
      {
        id: "chat-b",
        title: "Chat B",
        workspacePath: WORKSPACE,
        taskId: "task-root-b",
      },
    ],
  });
  await db.prisma.lane.create({
    data: {
      id: "lane-codex",
      key: "codex",
      name: "Codex",
      provider: "openai",
      role: "implementer",
    },
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-a",
        kind: "session",
        vendor: "codex",
        taskId: "task-root-a",
        chatId: "chat-a",
        brief: "Coordinate chat A.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
        maxWallMs: 1_800_000,
        maxDescendantWallMs: 4_800_000,
      },
      {
        id: "job-worker-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        brief: "Implement chat A child.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        id: "job-delegate-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        brief: "Delegate inside chat A.",
        workspacePath: WORKSPACE,
        capabilityMode: "delegate",
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      // An EARLIER turn of chat A: its own root, and the children it filed.
      // Every turn enqueues a new root, so these are a different delegation
      // tree from `job-root-a` while belonging to the same chat and the same
      // coordinator seat.
      {
        id: "job-root-a-prior",
        kind: "session",
        vendor: "codex",
        taskId: "task-root-a",
        chatId: "chat-a",
        brief: "Coordinate chat A, previous turn.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "done",
        dispatchedBy: "human",
        maxWallMs: 1_800_000,
        maxDescendantWallMs: 4_800_000,
      },
      {
        id: "job-prior-child-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child-a",
        chatId: "chat-a",
        parentJobId: "job-root-a-prior",
        rootJobId: "job-root-a-prior",
        brief: "Prior-turn worker still running against chat A's files.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a-prior",
      },
      {
        id: "job-prior-child-a2",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child-a",
        chatId: "chat-a",
        parentJobId: "job-root-a-prior",
        rootJobId: "job-root-a-prior",
        brief: "A second prior-turn worker, for the refusal cases.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a-prior",
      },
      {
        id: "job-prior-child-a-done",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-child-a",
        chatId: "chat-a",
        parentJobId: "job-root-a-prior",
        rootJobId: "job-root-a-prior",
        brief: "A prior-turn worker that already finished.",
        workspacePath: WORKSPACE,
        status: "done",
        dispatchedBy: "agent:job:job-root-a-prior",
      },
      {
        id: "job-root-b",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-root-b",
        chatId: "chat-b",
        brief: "Coordinate chat B.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
        maxWallMs: 1_800_000,
        maxDescendantWallMs: 4_800_000,
      },
      {
        id: "job-worker-b",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-child-b",
        chatId: "chat-b",
        parentJobId: "job-root-b",
        rootJobId: "job-root-b",
        brief: "Implement chat B child.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-b",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-root-a", ROOT_A_TOKEN],
      ["job-worker-a", WORKER_A_TOKEN],
      ["job-delegate-a", DELEGATE_A_TOKEN],
      ["job-root-b", ROOT_B_TOKEN],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });
  await db.prisma.streamChunk.createMany({
    data: [
      {
        taskId: "task-child-a",
        laneId: "codex",
        runId: "job-worker-a",
        content: "chat A output",
      },
      {
        taskId: "task-child-b",
        laneId: "claude-code",
        runId: "job-worker-b",
        content: "chat B secret output",
      },
    ],
  });
  await db.prisma.memoryNote.create({
    data: {
      id: "memory-stale-sentinel",
      kind: "decision",
      text: "A trusted module decision.",
      textHash: "memory-stale-sentinel",
      createdBy: "human",
      chatId: "chat-a",
      // ADR-0026: the fixture jobs all carry `workspacePath: WORKSPACE`, so this
      // note is stamped with it too — that is exactly what the real write path does
      // (derived from the capability). Left NULL it would be the §8 residue, which
      // is invisible to EVERY agent read, and this note's whole job is to be the
      // one an agent CAN see.
      workspacePath: WORKSPACE,
      modules: ["src/secure.ts"],
      topics: [],
      symbols: [],
      validFrom: new Date(Date.now() - 60_000),
    },
  });
  await db.prisma.memoryAnchor.create({
    data: {
      noteId: "memory-stale-sentinel",
      kind: "module",
      value: "src/secure.ts",
    },
  });
  await db.prisma.confirmation.create({
    data: {
      noteId: "memory-stale-sentinel",
      principal: "human:operator",
      decision: "confirm",
    },
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("job-scoped backend capability routes", () => {
  it("binds chat continuity only to the exact Claude root capability", async () => {
    const accepted = await app.inject({
      method: "PATCH",
      url: "/api/chats/chat-b",
      headers: auth(ROOT_B_TOKEN),
      payload: {
        vendorSessionId: "claude-root-session",
        vendorSessionVendor: "claude-code",
        vendorSessionRootJobId: "job-root-b",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().chat).toMatchObject({
      vendorSessionId: "claude-root-session",
      vendorSessionVendor: "claude-code",
      vendorSessionRootJobId: "job-root-b",
    });

    const oversized = await app.inject({
      method: "PATCH",
      url: "/api/chats/chat-b",
      headers: auth(ROOT_B_TOKEN),
      payload: {
        vendorSessionId: "s".repeat(513),
        vendorSessionVendor: "claude-code",
        vendorSessionRootJobId: "job-root-b",
      },
    });
    expect(oversized.statusCode).toBe(400);
    expect(
      await db.prisma.orchestratorChat.findUnique({ where: { id: "chat-b" } })
    ).toMatchObject({ vendorSessionId: "claude-root-session" });

    const childOverwrite = await app.inject({
      method: "PATCH",
      url: "/api/chats/chat-a",
      headers: auth(WORKER_A_TOKEN),
      payload: {
        vendorSessionId: "worker-session",
        vendorSessionVendor: "claude-code",
        vendorSessionRootJobId: "job-worker-a",
      },
    });
    expect(childOverwrite.statusCode).toBe(403);
    expect(
      await db.prisma.orchestratorChat.findUnique({ where: { id: "chat-a" } })
    ).toMatchObject({ vendorSessionId: null });
  });

  it("applies the task-chat migration and keeps each worker on its exact task", async () => {
    const applied = await db.prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT "version" FROM "_muon_migrations" WHERE "version" = '0028_task_chat_scope'`
    );
    expect(applied).toHaveLength(1);
    const capabilityIndex = await db.prisma.$queryRawUnsafe<
      { name: string }[]
    >(`PRAGMA index_list('DelegationGrant')`);
    expect(capabilityIndex.map((index) => index.name)).toContain(
      "DelegationGrant_tokenHash_idx"
    );

    const listed = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: auth(WORKER_A_TOKEN),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks.map((task: { id: string }) => task.id)).toEqual([
      "task-child-a",
    ]);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/tasks/task-child-b",
      headers: auth(WORKER_A_TOKEN),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("does not recover task authority from ambiguous legacy job linkage", async () => {
    await db.prisma.task.create({
      data: {
        id: "task-legacy-shared",
        title: "Legacy shared task",
        description: "A historical task reused across chat jobs.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
      },
    });
    await db.prisma.dispatchJob.create({
      data: {
        id: "job-legacy-chat-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-legacy-shared",
        chatId: "chat-a",
        brief: "Historical ambiguous linkage.",
        workspacePath: WORKSPACE,
        status: "done",
        dispatchedBy: "human",
      },
    });

    const direct = await app.inject({
      method: "GET",
      url: "/api/tasks/task-legacy-shared",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(direct.statusCode).toBe(403);

    const listed = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(
      listed.json().tasks.map((task: { id: string }) => task.id)
    ).not.toContain("task-legacy-shared");
  });

  it("lets the root orchestrator use same-chat tasks and binds new tasks before dispatch", async () => {
    const sameChat = await app.inject({
      method: "GET",
      url: "/api/tasks/task-child-a",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(sameChat.statusCode).toBe(200);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/tasks/task-child-b",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(foreign.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(ROOT_A_TOKEN),
      payload: {
        title: "Review auth boundary",
        description: "Review the job-scoped backend authorization boundary.",
        priority: "high",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().task).toMatchObject({
      chatId: "chat-a",
      workspacePath: WORKSPACE,
    });

    const visibleIds = (
      await app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: auth(ROOT_A_TOKEN),
      })
    )
      .json()
      .tasks.map((task: { id: string }) => task.id);
    expect(visibleIds).toContain(created.json().task.id);
    expect(visibleIds).not.toContain("task-child-b");
  });

  it("denies generic control-plane routes and root dispatch to a vendor job bearer", async () => {
    for (const [method, url] of [
      ["POST", "/api/dispatch"],
      ["GET", "/api/github/status"],
      ["GET", "/api/sessions"],
      ["GET", "/api/lanes"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth(WORKER_A_TOKEN),
        ...(method === "POST"
          ? {
              payload: {
                vendor: "codex",
                taskId: "task-child-a",
                brief: "Bypass bounded delegation.",
              },
            }
          : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    const preflightRunner = await app.inject({
      method: "GET",
      url: "/api/runner",
      headers: auth(WORKER_A_TOKEN),
    });
    expect(preflightRunner.statusCode).toBe(200);
  });

  it("scopes dispatch status and streams to the orchestrator chat", async () => {
    await db.prisma.dispatchJob.update({
      where: { id: "job-root-a" },
      data: {
        runnerLeaseHash: "a".repeat(64),
        result: "untrusted terminal result text",
        packetJson: { whatChanged: "untrusted packet text" },
        steerMessages: ["private operator steer"],
      },
    });
    const jobs = await app.inject({
      method: "GET",
      url: "/api/dispatch",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(jobs.statusCode).toBe(200);
    const ids = jobs.json().jobs.map((job: { id: string }) => job.id);
    expect(ids).toEqual(
      expect.arrayContaining(["job-root-a", "job-worker-a", "job-delegate-a"])
    );
    expect(ids).not.toContain("job-root-b");
    expect(ids).not.toContain("job-worker-b");
    const rootView = jobs
      .json()
      .jobs.find((job: { id: string }) => job.id === "job-root-a");
    expect(rootView).toMatchObject({
      brief: "",
      agentId: null,
      result: null,
      packetJson: null,
      steerMessages: [],
    });
    expect(rootView.runnerLeaseHash).toBeUndefined();

    const foreignJob = await app.inject({
      method: "GET",
      url: "/api/dispatch/job-worker-b",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(foreignJob.statusCode).toBe(403);

    const ownStream = await app.inject({
      method: "GET",
      url: "/api/streams?runId=job-worker-a",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(ownStream.statusCode).toBe(200);
    expect(ownStream.json().chunks[0].content).toBe("chat A output");

    const foreignStream = await app.inject({
      method: "GET",
      url: "/api/streams?runId=job-worker-b",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(foreignStream.statusCode).toBe(403);
  });

  it("keeps raw activity and foreign fleet coordinates out of job capabilities", async () => {
    const recent = await app.inject({
      method: "GET",
      url: "/api/events?limit=10",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(recent.statusCode).toBe(403);

    await db.prisma.event.create({
      data: {
        laneId: "codex",
        taskId: "task-child-a",
        kind: "task.progress",
        message: "untrusted free-text activity",
        metadata: { privateText: "must not reach task_context" },
      },
    });
    const taskEvents = await app.inject({
      method: "GET",
      url: "/api/tasks/task-child-a/events",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(taskEvents.statusCode).toBe(200);
    expect(taskEvents.json().events.at(-1)).toMatchObject({
      laneId: "codex",
      taskId: "task-child-a",
      kind: "task.progress",
      message: "activity: task.progress",
      metadata: {},
    });

    const seat = await db.prisma.agent.create({
      data: {
        vendor: "claude-code",
        ordinal: 3,
        name: "foreign-chat-seat",
        status: "working",
        currentTaskId: "task-child-b",
        currentJobId: "foreign-job-secret",
        sessionId: "foreign-session-secret",
      },
    });
    try {
      const fleet = await app.inject({
        method: "GET",
        url: "/api/fleet",
        headers: auth(ROOT_A_TOKEN),
      });
      expect(fleet.statusCode).toBe(200);
      const row = fleet
        .json()
        .agents.find((agent: { id: string }) => agent.id === seat.id);
      expect(row).toMatchObject({
        status: "working",
        currentTaskId: null,
        currentJobId: null,
        sessionId: null,
      });
    } finally {
      await db.prisma.agent.delete({ where: { id: seat.id } });
    }
  });

  it("keeps provider account identity out of job readiness diagnostics", async () => {
    const { setReadinessProber } = await import("../src/routes/fleet.js");
    setReadinessProber(async () => [
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        authState: "confirmed",
        credentialMethod: "vendor-login",
        detail: "logged in as private@example.com",
      },
    ]);
    try {
      const operator = await app.inject({
        method: "GET",
        url: "/api/fleet/readiness",
        headers: auth(OPERATOR),
      });
      expect(operator.statusCode).toBe(200);
      expect(operator.json().vendors[0].detail).toContain(
        "private@example.com",
      );

      const job = await app.inject({
        method: "GET",
        url: "/api/fleet/readiness",
        headers: auth(WORKER_A_TOKEN),
      });
      expect(job.statusCode).toBe(200);
      expect(job.json().vendors[0]).toMatchObject({
        authenticated: true,
        detail: "ready",
      });
      expect(JSON.stringify(job.json())).not.toContain("private@example.com");
    } finally {
      setReadinessProber(null);
    }
  });

  it("derives event identity and prevents a vendor job from staling arbitrary modules", async () => {
    const event = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: auth(WORKER_A_TOKEN),
      payload: {
        laneId: "forged-human-lane",
        taskId: "task-child-a",
        kind: "task.progress",
        message: "declared work coordinates",
        metadata: {
          modules: ["src/secure.ts"],
          intentModules: ["src/intent.ts"],
          symbols: ["src/secure.ts#change"],
        },
      },
    });
    expect(event.statusCode).toBe(201);
    expect(event.json().event).toMatchObject({
      laneId: "codex",
      message: "job activity: task.progress",
      metadata: {
        symbols: ["src/secure.ts#change"],
        intentModules: ["src/intent.ts"],
      },
    });
    expect(event.json().event.metadata.modules).toBeUndefined();

    const note = await db.prisma.memoryNote.findUnique({
      where: { id: "memory-stale-sentinel" },
    });
    expect(note?.staleSince).toBeNull();

    const foreign = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: auth(WORKER_A_TOKEN),
      payload: {
        laneId: "codex",
        taskId: "task-child-b",
        kind: "task.progress",
        message: "foreign write",
      },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("reinforces only notes visible inside the authenticated partition", async () => {
    await db.prisma.memoryNote.createMany({
      data: [
        {
          id: "memory-foreign-reinforcement",
          kind: "decision",
          text: "A chat B decision that chat A must not reinforce.",
          textHash: "memory-foreign-reinforcement",
          createdBy: "human",
          chatId: "chat-b",
          workspacePath: WORKSPACE,
          modules: [],
          topics: [],
          symbols: [],
          validFrom: new Date(Date.now() - 60_000),
        },
        // ADR-0026 — the WORKSPACE axis, isolated from the chat axis: SAME chat as
        // the capability, different repo. `/used` holds a SECOND, independently
        // written copy of the visibility rule (`OR: [{chatId}, {scope:"global"}]`),
        // so without the workspace term this note would accrue `accessCount` — and
        // `usageNorm` feeds the calibrated ranker, so it would land PRE-BOOSTED in
        // the repo it does belong to the moment a human confirmed it.
        {
          id: "memory-foreign-workspace-reinforcement",
          kind: "decision",
          text: "Another repo's decision, in this very chat.",
          textHash: "memory-foreign-workspace-reinforcement",
          createdBy: "human",
          chatId: "chat-a",
          workspacePath: "/tmp/muon-some-other-repo",
          modules: [],
          topics: [],
          symbols: [],
          validFrom: new Date(Date.now() - 60_000),
        },
        // And the §8 residue: an UNASSIGNED note is invisible to every agent read,
        // so reinforcement must refuse it too.
        {
          id: "memory-unassigned-reinforcement",
          kind: "decision",
          text: "An unassigned note, in this very chat.",
          textHash: "memory-unassigned-reinforcement",
          createdBy: "human",
          chatId: "chat-a",
          modules: [],
          topics: [],
          symbols: [],
          validFrom: new Date(Date.now() - 60_000),
        },
      ],
    });

    const used = await app.inject({
      method: "POST",
      url: "/api/memory/used",
      headers: auth(WORKER_A_TOKEN),
      payload: {
        noteIds: [
          "memory-stale-sentinel",
          "memory-foreign-reinforcement",
          "memory-foreign-workspace-reinforcement",
          "memory-unassigned-reinforcement",
        ],
      },
    });
    expect(used.statusCode).toBe(202);
    // Exactly one of the four: same chat AND same workspace.
    expect(used.json()).toEqual({ buffered: 1 });
  });

  it("derives approval provenance and never exposes another chat's inbox", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: auth(ROOT_A_TOKEN),
      payload: {
        taskId: "task-child-a",
        requestedBy: "human:forged",
        kind: "merge",
        reason: "Review the completed chat A child work.",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().approval).toMatchObject({
      requestedBy: "agent:job:job-root-a",
      jobId: "job-root-a",
    });

    await db.prisma.approvalRequest.create({
      data: {
        taskId: "task-child-b",
        requestedBy: "agent:job:job-root-b",
        kind: "merge",
        reason: "Chat B private review request.",
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: auth(ROOT_A_TOKEN),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().approvals.map((approval: { taskId: string }) => approval.taskId)
    ).not.toContain("task-child-b");

    const foreign = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: auth(ROOT_A_TOKEN),
      payload: {
        taskId: "task-child-b",
        requestedBy: "muon-orchestrator",
        kind: "merge",
        reason: "Try to govern another chat.",
      },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("binds workflow provenance and legacy control headers to the authenticated orchestrator job", async () => {
    const proposal = {
      summary: "Coordinate the authenticated chat",
      steps: [
        {
          stepKey: "inspect",
          title: "Inspect the scoped code",
          brief: "Inspect only the owning chat workspace.",
        },
      ],
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      headers: {
        ...auth(ROOT_A_TOKEN),
        "x-muon-caller-job-id": "job-root-a",
        "x-muon-delegation-token": ROOT_A_TOKEN,
      },
      payload: {
        request: "Plan chat A work",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
        proposal,
        proposedBy: "human:forged",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().run.proposedBy).toBe("agent:job:job-root-a");

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/workflow-runs",
      headers: {
        ...auth(ROOT_A_TOKEN),
        "x-muon-caller-job-id": "job-root-b",
        "x-muon-delegation-token": ROOT_B_TOKEN,
      },
      payload: {
        request: "Try to cross into chat B",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
        proposal,
        proposedBy: "codex",
      },
    });
    expect(mismatched.statusCode).toBe(403);
  });

  describe("a coordinator can stop the crew it started in an earlier turn", () => {
    // C2. Every turn enqueues a NEW root job, so the delegation tree — the
    // coordinate job control keys on — changes with every message. A
    // coordinator that dispatched in turn 1 and tried to clean up in turn 2 was
    // refused with "a job capability cannot control another delegation tree",
    // could not stop its own children, and both rounds ran concurrently over
    // the same files. The mission is the CHAT; the refusal that must survive is
    // the one across chats.
    it("interrupts its own prior-turn child in the same chat", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-prior-child-a/interrupt",
        headers: {
          ...auth(ROOT_A_TOKEN),
          "x-muon-caller-job-id": "job-root-a",
          "x-muon-delegation-token": ROOT_A_TOKEN,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.interruptRequested).toBe(true);
      const row = await db.prisma.dispatchJob.findUnique({
        where: { id: "job-prior-child-a" },
        select: { interruptRequested: true },
      });
      expect(row?.interruptRequested).toBe(true);
    });

    it("is still refused across chats — the invariant", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-prior-child-a2/interrupt",
        headers: {
          ...auth(ROOT_B_TOKEN),
          "x-muon-caller-job-id": "job-root-b",
          "x-muon-delegation-token": ROOT_B_TOKEN,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/another delegation tree/i);
      const row = await db.prisma.dispatchJob.findUnique({
        where: { id: "job-prior-child-a2" },
        select: { interruptRequested: true },
      });
      expect(row?.interruptRequested).toBe(false);
    });

    it("gives a delegate child nothing: only the coordinator seat reaches across turns", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-prior-child-a2/interrupt",
        headers: {
          ...auth(DELEGATE_A_TOKEN),
          "x-muon-caller-job-id": "job-delegate-a",
          "x-muon-delegation-token": DELEGATE_A_TOKEN,
        },
      });
      // Refused one layer EARLIER than the tree check, by the delegate route
      // allowlist — which is the stronger answer, and the reason this is a
      // coordinator-seat allowance rather than a job-capability one.
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/not authorized for this control-plane route/i);
    });

    it("reaches live work only — a finished prior child is not its to touch", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-prior-child-a-done/interrupt",
        headers: {
          ...auth(ROOT_A_TOKEN),
          "x-muon-caller-job-id": "job-root-a",
          "x-muon-delegation-token": ROOT_A_TOKEN,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("does not widen STEER: the allowance is termination, not a new write", async () => {
      // Stopping work you started is recovery. Sending a fresh instruction into
      // another turn's live session is a content-bearing write into a job this
      // caller does not own, so `/steer` never took the allowance.
      const res = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-prior-child-a2/steer",
        headers: {
          ...auth(ROOT_A_TOKEN),
          "x-muon-caller-job-id": "job-root-a",
          "x-muon-delegation-token": ROOT_A_TOKEN,
        },
        payload: { message: "change course" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/another delegation tree/i);
    });
  });

  it("lets a restricted delegate read only its own numeric mission budget", async () => {
    const own = await app.inject({
      method: "GET",
      url: "/api/dispatch/job-delegate-a/budget",
      headers: auth(DELEGATE_A_TOKEN),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().budget.jobId).toBe("job-root-a");

    const foreign = await app.inject({
      method: "GET",
      url: "/api/dispatch/job-root-b/budget",
      headers: auth(DELEGATE_A_TOKEN),
    });
    expect(foreign.statusCode).toBe(403);
  });
});
