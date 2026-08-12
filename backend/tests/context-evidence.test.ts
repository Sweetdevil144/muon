import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-context-evidence";
const AGENT = "agent-context-evidence";
const HOST = "context-runner";
const LEASE = `lease-${"c".repeat(58)}`;
const OTHER_LEASE = `lease-${"d".repeat(58)}`;
const TASK_ID = "task-context-evidence";
const OTHER_TASK_ID = "task-context-other";
const JOB_ID = "job-context-evidence";
const OTHER_JOB_ID = "job-context-other";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");

type Db = typeof import("../src/lib/db.js");
let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

function beginFrame(
  jobId = JOB_ID,
  body: Record<string, unknown> = {}
) {
  return app.inject({
    method: "POST",
    url: `/api/dispatch/${jobId}/context/frames`,
    headers: auth(AGENT),
    payload: {
      host: HOST,
      leaseToken: LEASE,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      source: "dispatch",
      content: "exact prompt bytes",
      exposures: [
        {
          artifactKind: "memory_note",
          artifactId: "note-1",
          eligible: true,
          included: true,
          reason: "standing_memory",
          ordinal: 0,
          charCount: 19,
          trustTier: "human_confirmed",
        },
      ],
      ...body,
    },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-context-evidence-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dataDir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();

  await prisma.lane.create({
    data: {
      id: "lane-context-codex",
      key: "codex",
      name: "Codex",
      provider: "openai",
      role: "peer",
    },
  });
  await prisma.task.createMany({
    data: [
      {
        id: TASK_ID,
        title: "Record context",
        description: "primary context evidence fixture",
        status: "in_progress",
      },
      {
        id: OTHER_TASK_ID,
        title: "Other context",
        description: "partition fence fixture",
        status: "in_progress",
      },
    ],
  });
});

beforeEach(async () => {
  await prisma.contextCondensationMember.deleteMany({});
  await prisma.contextCondensation.deleteMany({});
  await prisma.contextFrameDelivery.deleteMany({});
  await prisma.contextExposure.deleteMany({});
  await prisma.contextFrame.deleteMany({});
  await prisma.delegationGrant.deleteMany({});
  await prisma.dispatchJob.deleteMany({});
  await prisma.runner.deleteMany({});
  await prisma.runner.create({
    data: {
      host: HOST,
      leaseHash: hashLease(LEASE),
      status: "online",
      lastSeenAt: new Date(),
    },
  });
  await prisma.dispatchJob.createMany({
    data: [
      {
        id: JOB_ID,
        kind: "session",
        vendor: "codex",
        taskId: TASK_ID,
        brief: "primary",
        status: "running",
        host: HOST,
        runnerLeaseHash: hashLease(LEASE),
        startedAt: new Date(),
        maxWallMs: 120_000,
        workspacePath: "/tmp/muon-context-primary",
        chatId: "chat-context-primary",
        capabilityMode: "worker",
        dispatchedBy: "human:operator",
      },
      {
        id: OTHER_JOB_ID,
        kind: "session",
        vendor: "codex",
        taskId: OTHER_TASK_ID,
        brief: "other",
        status: "running",
        host: HOST,
        runnerLeaseHash: hashLease(OTHER_LEASE),
        startedAt: new Date(),
        maxWallMs: 120_000,
        workspacePath: "/tmp/muon-context-other",
        chatId: "chat-context-other",
        capabilityMode: "worker",
        dispatchedBy: "human:operator",
      },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable context delivery evidence", () => {
  it("derives coordinates, hashes exact bytes, and appends one idempotent receipt", async () => {
    const created = await beginFrame();
    expect(created.statusCode).toBe(201);
    const frame = created.json().frame;
    expect(frame).toMatchObject({
      jobId: JOB_ID,
      taskId: TASK_ID,
      laneId: "lane-context-codex",
      workspacePath: "/tmp/muon-context-primary",
      chatId: "chat-context-primary",
      missionId: JOB_ID,
      turnSeq: 1,
      completeness: "muon_supplied",
      content: "exact prompt bytes",
      contentSha256: `sha256:${createHash("sha256")
        .update("exact prompt bytes")
        .digest("hex")}`,
      delivery: null,
    });
    expect(frame.exposures).toHaveLength(1);

    const deliveryBody = {
      host: HOST,
      leaseToken: LEASE,
      status: "delivered",
      sessionId: "session-1",
      vendorSessionId: "thread-7",
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/context/frames/${frame.id}/delivery`,
      headers: auth(AGENT),
      payload: deliveryBody,
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/context/frames/${frame.id}/delivery`,
      headers: auth(AGENT),
      payload: deliveryBody,
    });
    expect(replay.statusCode).toBe(200);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/context/frames/${frame.id}/delivery`,
      headers: auth(AGENT),
      payload: { ...deliveryBody, status: "failed", failure: "rewritten" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await prisma.contextFrameDelivery.count()).toBe(1);
  });

  it("fences the lease and refuses idempotency-key payload drift", async () => {
    expect(
      (
        await beginFrame(JOB_ID, {
          leaseToken: OTHER_LEASE,
        })
      ).statusCode
    ).toBe(409);
    const first = await beginFrame();
    expect(first.statusCode).toBe(201);
    const replay = await beginFrame();
    expect(replay.statusCode).toBe(200);
    const drift = await beginFrame(JOB_ID, { content: "different bytes" });
    expect(drift.statusCode).toBe(409);
    const otherJob = await beginFrame(OTHER_JOB_ID);
    expect(otherJob.statusCode).toBe(409);
  });

  it("stores vendor compaction only as a knowledge gap and enforces MUON replay members", async () => {
    const frameId = (await beginFrame()).json().frame.id as string;
    const outputFrameId = (
      await beginFrame(JOB_ID, {
        clientRequestId: "22222222-2222-4222-8222-222222222222",
        source: "loop",
        content: "🙂 exact replayable summary after",
      })
    ).json().frame.id as string;
    const endpoint = `/api/dispatch/${JOB_ID}/context/condensations`;
    const vendorLie = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "codex:item:compact-1",
        origin: "vendor_reported",
        inputFrameId: frameId,
        summary: "invented",
      },
    });
    expect(vendorLie.statusCode).toBe(400);
    const incompleteMuon = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "muon:compact-1",
        origin: "muon",
        inputFrameId: frameId,
        outputFrameId: frameId,
        summary: "exact",
        members: [],
      },
    });
    expect(incompleteMuon.statusCode).toBe(400);
    const marker = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "codex:item:compact-1",
        origin: "vendor_reported",
        inputFrameId: frameId,
      },
    });
    expect(marker.statusCode).toBe(201);
    expect(marker.json().condensation).toMatchObject({
      origin: "vendor_reported",
      summary: null,
      members: [],
    });
    const muon = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "muon:compact-2",
        origin: "muon",
        inputFrameId: frameId,
        outputFrameId,
        summary: "exact replayable summary",
        summaryOffset: 5,
        members: [
          { artifactKind: "memory_note", artifactId: "note-1" },
        ],
      },
    });
    expect(muon.statusCode).toBe(201);
    expect(muon.json().condensation).toMatchObject({
      origin: "muon",
      summary: "exact replayable summary",
      summaryOffset: 5,
      members: [
        { artifactKind: "memory_note", artifactId: "note-1" },
      ],
    });
    const falseReplay = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "muon:compact-false",
        origin: "muon",
        inputFrameId: frameId,
        outputFrameId,
        summary: "invented summary",
        summaryOffset: 5,
        members: [
          { artifactKind: "memory_note", artifactId: "note-1" },
        ],
      },
    });
    expect(falseReplay.statusCode).toBe(400);
    const drift = await app.inject({
      method: "POST",
      url: endpoint,
      headers: auth(AGENT),
      payload: {
        host: HOST,
        leaseToken: LEASE,
        sourceResponseId: "codex:item:compact-1",
        origin: "vendor_reported",
      },
    });
    expect(drift.statusCode).toBe(409);
  });

  it("gives an exact job capability bounded lookup and survives a fresh DB connection", async () => {
    const frameId = (await beginFrame()).json().frame.id as string;
    const issued = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/delegation-token`,
      headers: auth(AGENT),
      payload: { host: HOST, leaseToken: LEASE },
    });
    expect(issued.statusCode).toBe(200);
    const capability = issued.json().token as string;
    const own = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/context`,
      headers: auth(capability),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().frames[0].id).toBe(frameId);
    const foreign = await app.inject({
      method: "GET",
      url: `/api/dispatch/${OTHER_JOB_ID}/context`,
      headers: auth(capability),
    });
    expect(foreign.statusCode).toBe(403);

    const reopened = new PrismaClient();
    try {
      expect(await reopened.contextFrame.count({ where: { id: frameId } })).toBe(1);
      expect(
        await reopened.contextExposure.count({ where: { frameId } })
      ).toBe(1);
    } finally {
      await reopened.$disconnect();
    }
  });
});
