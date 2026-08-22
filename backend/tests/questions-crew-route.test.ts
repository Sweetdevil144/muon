import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MIN_QUESTION_ASK_INTERVAL_MS } from "@muon/protocol";

// A13 — GET /api/questions/crew: the coordinator-tier read of what its OWN
// crew is blocked on.
//
// It exists because the two reads that already existed both fail this job:
// `GET /api/questions/open` is the operator's machine-wide inbox (operator
// tier, so an MCP coordinator holding a job capability cannot call it at all),
// and `GET /api/questions` answers only for the CALLER's own job. A coordinator
// could therefore watch a crew that was blocked on a human and see nothing.
//
// The properties under proof are the fences, in both directions: only a chat
// coordinator reaches it, it answers with that chat's questions and no other's,
// and it hands back coordinates rather than another job's authored text.

const OPERATOR = "operator-token-crew-q";
const AGENT = "agent-token-crew-q";
const ROOT_A = `root-a-${"a".repeat(52)}`;
const ROOT_B = `root-b-${"b".repeat(52)}`;
const IMPL_A = `impl-a-${"c".repeat(52)}`;
const WORKSPACE = process.cwd();
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const SUBJECT = "CREW-QUESTION-SUBJECT-oscar-mike";
const BODY = "CREW-QUESTION-BODY-lima-charlie";

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

async function ask(token: string, subject: string, body: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/questions",
    headers: auth(token),
    payload: { subject, body },
  });
  await new Promise((resolve) =>
    setTimeout(resolve, MIN_QUESTION_ASK_INTERVAL_MS + 10)
  );
  return response;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-crew-questions-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.createMany({
    data: [
      {
        id: "task-crew-a",
        title: "Mission A",
        description: "Chat A mission.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-crew-a",
      },
      {
        id: "task-crew-b",
        title: "Mission B",
        description: "Chat B mission.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-crew-b",
      },
    ],
  });
  await db.prisma.orchestratorChat.createMany({
    data: [
      {
        id: "chat-crew-a",
        title: "Chat A",
        workspacePath: WORKSPACE,
        taskId: "task-crew-a",
      },
      {
        id: "chat-crew-b",
        title: "Chat B",
        workspacePath: WORKSPACE,
        taskId: "task-crew-b",
      },
    ],
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-a",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-crew-a",
        chatId: "chat-crew-a",
        capabilityMode: "orchestrator",
        brief: "Coordinate A.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-crew-a",
        chatId: "chat-crew-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        role: "implementer",
        brief: "Implement A.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        id: "job-root-b",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-crew-b",
        chatId: "chat-crew-b",
        capabilityMode: "orchestrator",
        brief: "Coordinate B.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-root-a", ROOT_A],
      ["job-root-b", ROOT_B],
      ["job-impl-a", IMPL_A],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();

  // The child in chat A asks a human something. Nothing stops (ADR-0043).
  const filed = await ask(IMPL_A, SUBJECT, BODY);
  expect(filed.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function crew(token: string) {
  return app.inject({
    method: "GET",
    url: "/api/questions/crew",
    headers: auth(token),
  });
}

describe("A13 GET /api/questions/crew", () => {
  it("answers a coordinator with its own crew's open question, as coordinates", async () => {
    const response = await crew(ROOT_A);
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0]).toMatchObject({ taskId: "task-crew-a" });
    expect(payload.questions[0].id).toEqual(expect.any(String));
    expect(payload.questions[0].askedAt).toEqual(expect.any(String));
    // Coordinates only: the subject and body are another job's authored text.
    // A coordinator needs to know a human is blocking, not to read the ask.
    expect(response.body).not.toContain(SUBJECT);
    expect(response.body).not.toContain(BODY);
  });

  it("does not show another chat's question, and does not name that chat", async () => {
    // ADR-0026/0033: the fence is the coordinator's OWN chat, and a foreign
    // question is absent rather than refused by name.
    const response = await crew(ROOT_B);
    expect(response.statusCode).toBe(200);
    expect(response.json().questions).toEqual([]);
    expect(response.body).not.toContain("task-crew-a");
    expect(response.body).not.toContain("chat-crew-a");
  });

  it("refuses a plain WORKER capability — this is a coordinator read", async () => {
    // TWO positive fences, and the outer one fires first: the deny-first route
    // matrix (`agentJobRouteAllowed`) admits this path only for the two
    // coordinator capability modes, so a worker never reaches the handler's
    // own `requireAgentOrchestratorCapability`. Both are asserted — a worker
    // must not read its crew's inbox even if one of them is ever relaxed.
    const response = await crew(IMPL_A);
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(
      /not authorized for this control-plane route/i
    );
  });

  it("refuses a bare agent bearer with no job capability", async () => {
    expect((await crew(AGENT)).statusCode).toBe(403);
  });

  it("refuses the operator tier, whose inbox is /api/questions/open", async () => {
    // Not an oversight: `/open` is the machine-wide human inbox and is the
    // right read for an operator. This one is scoped to one coordinator's crew.
    expect((await crew(OPERATOR)).statusCode).toBe(403);
  });

  it("stops reporting the question once a human answers it", async () => {
    const before = (await crew(ROOT_A)).json().questions[0];
    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${before.id}/answer`,
      headers: auth(OPERATOR),
      payload: { answer: "Use the first stub.", taskId: "task-crew-a" },
    });
    expect(answered.statusCode).toBe(200);
    expect((await crew(ROOT_A)).json().questions).toEqual([]);
  });
});
