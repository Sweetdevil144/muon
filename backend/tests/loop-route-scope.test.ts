import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const OPERATOR = "operator-token-loop-route";
const AGENT = "agent-token-loop-route";
const LOOP_A_TOKEN = `loop-a-${"a".repeat(58)}`;
const LOOP_B_TOKEN = `loop-b-${"b".repeat(58)}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-loop-route-scope-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
  await db.prisma.task.createMany({
    data: [
      {
        id: "task-loop-a",
        title: "Loop A",
        description: "First isolated loop task.",
        status: "in_progress",
        workspacePath: process.cwd(),
      },
      {
        id: "task-loop-b",
        title: "Loop B",
        description: "Second isolated loop task.",
        status: "in_progress",
        workspacePath: process.cwd(),
      },
    ],
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-loop-a",
        kind: "loop",
        vendor: "codex",
        taskId: "task-loop-a",
        brief: "Run loop A.",
        workspacePath: process.cwd(),
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-loop-b",
        kind: "loop",
        vendor: "codex",
        taskId: "task-loop-b",
        brief: "Run loop B.",
        workspacePath: process.cwd(),
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-loop-a", LOOP_A_TOKEN],
      ["job-loop-b", LOOP_B_TOKEN],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  rmSync(dir, { recursive: true, force: true });
});

describe("loop run dispatch identity and exact-job scope", () => {
  it("binds a loop to its exact dispatch and makes a retried create idempotent", async () => {
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/loops",
        // Loop writes stay on the trusted runner's shared agent client. Vendor
        // exact-job bearers are denied by the outer route matrix.
        headers: auth(AGENT),
        payload: {
          dispatchJobId: "job-loop-a",
          taskId: "task-loop-a",
          budget: { maxIterations: 3 },
        },
      });

    const first = await request();
    const replay = await request();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(first.json().loop.dispatchJobId).toBe("job-loop-a");
    expect(replay.json().loop.id).toBe(first.json().loop.id);
    await expect(
      db.prisma.loopRun.count({ where: { dispatchJobId: "job-loop-a" } })
    ).resolves.toBe(1);
  });

  it("refuses unbound, foreign-task, and mismatched dispatch coordinates", async () => {
    const unbound = await app.inject({
      method: "POST",
      url: "/api/loops",
      headers: auth(LOOP_B_TOKEN),
      payload: {
        taskId: "task-loop-b",
        budget: { maxIterations: 3 },
      },
    });
    expect(unbound.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "POST",
      url: "/api/loops",
      headers: auth(LOOP_B_TOKEN),
      payload: {
        dispatchJobId: "job-loop-a",
        taskId: "task-loop-a",
        budget: { maxIterations: 3 },
      },
    });
    expect(foreign.statusCode).toBe(403);

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/loops",
      headers: auth(AGENT),
      payload: {
        dispatchJobId: "job-loop-b",
        taskId: "task-loop-a",
        budget: { maxIterations: 3 },
      },
    });
    expect(mismatched.statusCode).toBe(400);
  });

  it("keeps loop updates on the trusted runner route while exact jobs are denied", async () => {
    const loop = await db.prisma.loopRun.findUniqueOrThrow({
      where: { dispatchJobId: "job-loop-a" },
    });
    const exactJob = await app.inject({
      method: "PATCH",
      url: `/api/loops/${loop.id}`,
      headers: auth(LOOP_A_TOKEN),
      payload: { iterations: 1 },
    });
    expect(exactJob.statusCode).toBe(403);

    const trustedRunner = await app.inject({
      method: "PATCH",
      url: `/api/loops/${loop.id}`,
      headers: auth(AGENT),
      payload: { iterations: 1 },
    });
    expect(trustedRunner.statusCode).toBe(200);
    expect(trustedRunner.json().loop.iterations).toBe(1);
  });
});
