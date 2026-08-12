import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_OPEN_QUESTIONS_PER_JOB,
  MIN_QUESTION_ASK_INTERVAL_MS,
} from "@muon/protocol";

// ── ADR-0043: blocking questions ─────────────────────────────────────────────
//
// Real temp-SQLite brain, real routes. The properties under proof:
//   1. IDENTITY IS AUTHENTICATED — the ask body is identity-free by schema;
//      job/task/vendor/role are derived from the exact-job bearer.
//   2. AUTHORITY IS SPLIT — agents ask and withdraw their OWN questions;
//      only the operator answers; an answered question is never re-answered.
//   3. NOTHING STOPS — filing a question changes no job state.
//   4. THE CAP IS REAL — the per-job open-question bound refuses at the route.

const OPERATOR = "operator-token-questions";
const AGENT = "agent-token-questions";
const IMPL = `impl-q-${"a".repeat(52)}`;
const OTHER = `other-q-${"b".repeat(51)}`;
const WORKSPACE = process.cwd();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

/** The 250ms anti-flood fence is real (pass-7 HIGH #2), so the helper spaces
 *  its own asks; the fence itself is exercised deliberately below. */
const lastAskAt = new Map<string, number>();

async function ask(token: string, payload: Record<string, unknown>) {
  const previous = lastAskAt.get(token);
  if (previous !== undefined) {
    const wait = MIN_QUESTION_ASK_INTERVAL_MS - (Date.now() - previous) + 10;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/questions",
    headers: auth(token),
    payload,
  });
  lastAskAt.set(token, Date.now());
  return response;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-questions-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.create({
    data: {
      id: "task-q",
      title: "Mission Q",
      description: "Blocking-question mission.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-q",
    },
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: "chat-q",
      title: "Chat Q",
      workspacePath: WORKSPACE,
      taskId: "task-q",
    },
  });
  // One active ROOT per chat is a real invariant (migration 0032's partial
  // unique index), so the two agent jobs are WORKERS under one root.
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-q",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-q",
        chatId: "chat-q",
        capabilityMode: "orchestrator",
        brief: "Coordinate mission Q.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-impl-q",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-q",
        chatId: "chat-q",
        parentJobId: "job-root-q",
        rootJobId: "job-root-q",
        role: "implementer",
        brief: "Implement mission Q.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-q",
      },
      {
        id: "job-other-q",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-q",
        chatId: "chat-q",
        parentJobId: "job-root-q",
        rootJobId: "job-root-q",
        brief: "A sibling job of the same task.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-q",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-impl-q", IMPL],
      ["job-other-q", OTHER],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("asking (agent tier, identity derived)", () => {
  it("files a question with server-derived identity and returns it", async () => {
    const res = await ask(IMPL, {
      subject: "Which auth provider?",
      body: "The brief names none; the repo has stubs for two.",
    });
    expect(res.statusCode).toBe(200);
    const question = res.json().question;
    expect(question).toMatchObject({
      taskId: "task-q",
      jobId: "job-impl-q",
      askedByVendor: "codex",
      askedByRole: "implementer",
      status: "open",
      subject: "Which auth provider?",
    });
  });

  it("rejects any identity or lever field in the body — strict, deny-first", async () => {
    for (const extra of [
      { jobId: "job-other-q" },
      { taskId: "task-elsewhere" },
      { deadline: "2026-01-01T00:00:00.000Z" },
    ]) {
      const res = await ask(IMPL, { subject: "s", body: "b", ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
  });

  it("filing a question stops no clock — the job row is untouched", async () => {
    const job = await db.prisma.dispatchJob.findUnique({
      where: { id: "job-impl-q" },
    });
    expect(job?.status).toBe("running");
    expect(job?.interruptRequested).toBe(false);
  });
});

describe("reading + answering (the split)", () => {
  it("an agent reads only its OWN questions", async () => {
    const own = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().questions).toHaveLength(1);

    const sibling = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(OTHER),
    });
    expect(sibling.statusCode).toBe(200);
    expect(sibling.json().questions).toHaveLength(0);
  });

  it("the agent tier cannot answer — answering is operator authority", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    const id = list.json().questions[0].id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(IMPL),
      payload: { taskId: "task-q", answer: "answering myself" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the operator answers once; the agent pulls the answer; re-answer refuses", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/questions/task/task-q",
      headers: auth(OPERATOR),
    });
    expect(list.statusCode).toBe(200);
    const id = list.json().questions[0].id as string;

    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "Use the OAuth stub." },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().question).toMatchObject({
      status: "answered",
      answer: "Use the OAuth stub.",
    });

    const pulled = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(pulled.json().questions[0]).toMatchObject({
      status: "answered",
      answer: "Use the OAuth stub.",
    });

    const again = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: "task-q", answer: "No — the other one." },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("withdrawal + the cap", () => {
  it("only the asking job may withdraw, and only while open", async () => {
    const filed = await ask(IMPL, { subject: "w?", body: "to withdraw" });
    const id = filed.json().question.id as string;

    const foreign = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(OTHER),
    });
    expect(foreign.statusCode).toBe(404);

    const own = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(IMPL),
    });
    expect(own.statusCode).toBe(200);

    const twice = await app.inject({
      method: "POST",
      url: `/api/questions/${id}/withdraw`,
      headers: auth(IMPL),
    });
    expect(twice.statusCode).toBe(409);
  });

  it("two immediate asks from one job hit the anti-flood fence", async () => {
    const first = await ask(OTHER, { subject: "fence 1", body: "b" });
    expect(first.statusCode).toBe(200);
    // Bypass the spacing helper: fire the second ask immediately.
    const second = await app.inject({
      method: "POST",
      url: "/api/questions",
      headers: auth(OTHER),
      payload: { subject: "fence 2", body: "b" },
    });
    expect(second.statusCode).toBe(429);
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_QUESTION_ASK_INTERVAL_MS + 10)
    );
    const cleanup = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(OTHER),
    });
    // Withdraw the fence question so the cap test below starts clean.
    const fenceQuestion = (
      cleanup.json().questions as { id: string; subject: string; status: string }[]
    ).find((q) => q.subject === "fence 1" && q.status === "open");
    if (fenceQuestion) {
      await app.inject({
        method: "POST",
        url: `/api/questions/${fenceQuestion.id}/withdraw`,
        headers: auth(OTHER),
      });
    }
  });

  it("an agent bearer is refused the operator task listing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/questions/task/task-q",
      headers: auth(IMPL),
    });
    expect(res.statusCode).toBe(403);
  });

  it("the per-job open cap refuses the ask past the bound", async () => {
    // job-other-q holds no questions yet; fill it to the cap.
    for (let index = 0; index < MAX_OPEN_QUESTIONS_PER_JOB; index += 1) {
      const res = await ask(OTHER, {
        subject: `q ${index}`,
        body: `body ${index}`,
      });
      expect(res.statusCode).toBe(200);
    }
    const overflow = await ask(OTHER, { subject: "one more", body: "past cap" });
    expect(overflow.statusCode).toBe(429);
  });
});

describe("the open inbox (surface-parity audit 2026-08-11)", () => {
  /**
   * Agents could ask (ADR-0043) and only the CLI — with a --task-id the human
   * had to already know — could see. `GET /api/questions/open` is the inbox
   * read the desk and TUI mount: every OPEN question on the machine, derived
   * by the SAME fold as the per-task read, newest-asked first.
   */
  it("lists open questions across tasks, operator tier only", async () => {
    const asked = await ask(IMPL, {
      subject: "inbox probe: which retry policy?",
      body: "Blocked on choosing between fixed and exponential backoff.",
    });
    expect(asked.statusCode).toBe(200);
    const questionId = asked.json().question.id;

    const denied = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(IMPL),
    });
    expect(denied.statusCode).toBe(403);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(OPERATOR),
    });
    expect(inbox.statusCode).toBe(200);
    const body = inbox.json();
    const mine = body.questions.find(
      (question: { id: string }) => question.id === questionId
    );
    expect(mine, "the fresh question is in the inbox").toBeTruthy();
    expect(mine.status).toBe("open");
    expect(mine.taskId, "taskId rides along for the answer call").toBeTruthy();
    expect(body.truncated).toBe(false);
  });

  it("an ANSWERED question leaves the inbox", async () => {
    const asked = await ask(IMPL, {
      subject: "inbox probe: answered questions vanish?",
      body: "This one gets answered immediately.",
    });
    expect(asked.statusCode).toBe(200);
    const question = asked.json().question;

    const answered = await app.inject({
      method: "POST",
      url: `/api/questions/${question.id}/answer`,
      headers: auth(OPERATOR),
      payload: { taskId: question.taskId, answer: "Exponential, capped at 30s." },
    });
    expect(answered.statusCode).toBe(200);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/questions/open",
      headers: auth(OPERATOR),
    });
    const ids = inbox
      .json()
      .questions.map((entry: { id: string }) => entry.id);
    expect(ids).not.toContain(question.id);
  });
});
