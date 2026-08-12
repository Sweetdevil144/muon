import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Round-3 #5 — "revoke this identity NOW". The property under proof: a live,
// working exact-job credential is DEAD at the auth boundary on the very next
// call after the operator revokes, and only the operator holds the verb.

const OPERATOR = "operator-token-revoke";
const AGENT = "agent-token-revoke";
const IMPL = `impl-r-${"a".repeat(52)}`;
const WORKSPACE = process.cwd();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-revoke-"));
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
      id: "task-r",
      title: "Mission R",
      description: "Revocation mission.",
      status: "in_progress",
      workspacePath: WORKSPACE,
      chatId: "chat-r",
    },
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: "chat-r",
      title: "Chat R",
      workspacePath: WORKSPACE,
      taskId: "task-r",
    },
  });
  await db.prisma.dispatchJob.create({
    data: {
      id: "job-impl-r",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-r",
      chatId: "chat-r",
      brief: "Implement mission R.",
      workspacePath: WORKSPACE,
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-impl-r",
      tokenHash: createHash("sha256").update(IMPL).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
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

describe("POST /api/dispatch/:jobId/revoke-grants", () => {
  it("the agent tier cannot revoke — it is an operator verb", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-impl-r/revoke-grants",
      headers: auth(IMPL),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("an unknown job is a 404, not a silent zero", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-ghost/revoke-grants",
      headers: auth(OPERATOR),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("a live credential works, dies on revoke, and the death is audited", async () => {
    // The credential is LIVE first — this is what makes the kill observable.
    const before = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-impl-r/revoke-grants",
      headers: auth(OPERATOR),
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ jobId: "job-impl-r", revoked: 1 });

    // The very next call with the same bearer fails closed — 401, because
    // the identity no longer EXISTS at the auth boundary (stronger than a
    // 403's "known but forbidden").
    const after = await app.inject({
      method: "GET",
      url: "/api/questions",
      headers: auth(IMPL),
    });
    expect(after.statusCode).toBe(401);

    // The job itself was NOT interrupted — identity death is not process death.
    const job = await db.prisma.dispatchJob.findUnique({
      where: { id: "job-impl-r" },
    });
    expect(job?.status).toBe("running");
    expect(job?.interruptRequested).toBe(false);

    const audit = await db.prisma.event.findFirst({
      where: { kind: "identity.revoked", taskId: "task-r" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.principalKind).toBe("human");
  });
});
