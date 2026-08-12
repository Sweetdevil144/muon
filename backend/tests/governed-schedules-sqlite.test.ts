import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-schedules";
const AGENT = "agent-token-schedules";
let app: FastifyInstance;
let prisma: typeof import("../src/lib/db.js")["prisma"];
let dataDir: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-schedules-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("T3 governed schedules on real SQLite", () => {
  it("migration 0050 materializes the durable schedule and occurrence tables", async () => {
    const migrations = await prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT version FROM "_muon_migrations"`
    );
    expect(migrations.map((row) => row.version)).toContain(
      "0050_governed_schedules"
    );
    const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('GovernedSchedule','ScheduleOccurrence')`
    );
    expect(tables.map((row) => row.name).sort()).toEqual([
      "GovernedSchedule",
      "ScheduleOccurrence",
    ]);
  });

  it("operator-gates creation and validates the coordinator vendor", async () => {
    const body = {
      title: "One safe turn",
      objective: "Inspect the repository and report findings",
      workspacePath: process.cwd(),
      vendor: "codex",
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      maxWallMs: 60_000,
      maxDescendantWallMs: 120_000,
    };
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: auth(AGENT),
      payload: body,
    });
    expect(forbidden.statusCode).toBe(403);
    const wrongVendor = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: auth(OPERATOR),
      payload: { ...body, vendor: "opencode" },
    });
    expect(wrongVendor.statusCode).toBe(400);
  });

  it("atomically claims a due one-shot once and keeps its terminal audit", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: auth(OPERATOR),
      payload: {
        title: "Atomic turn",
        objective: "Inspect the repository and report findings",
        workspacePath: process.cwd(),
        vendor: "codex",
        nextRunAt: new Date(Date.now() - 1_000).toISOString(),
        maxWallMs: 60_000,
        maxDescendantWallMs: 120_000,
      },
    });
    expect(created.statusCode).toBe(201);
    const scheduleId = created.json().schedule.id as string;

    const [left, right] = await Promise.all([
      app.inject({ method: "POST", url: "/api/schedules/claim-due", headers: auth(OPERATOR) }),
      app.inject({ method: "POST", url: "/api/schedules/claim-due", headers: auth(OPERATOR) }),
    ]);
    const claims = [left.json().claim, right.json().claim].filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0].schedule).toMatchObject({
      id: scheduleId,
      runCount: 1,
      status: "completed",
      maxWallMs: 60_000,
      maxDescendantWallMs: 120_000,
    });
    const occurrenceId = claims[0].occurrence.id as string;

    const started = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${scheduleId}/occurrences/${occurrenceId}`,
      headers: auth(OPERATOR),
      payload: { status: "running", chatId: "chat-scheduled" },
    });
    expect(started.statusCode).toBe(200);
    const done = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${scheduleId}/occurrences/${occurrenceId}`,
      headers: auth(OPERATOR),
      payload: {
        status: "done",
        chatId: "chat-scheduled",
        rootJobId: "job-root",
      },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().occurrence).toMatchObject({
      status: "done",
      chatId: "chat-scheduled",
      rootJobId: "job-root",
    });

    const replay = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${scheduleId}/occurrences/${occurrenceId}`,
      headers: auth(OPERATOR),
      payload: { status: "failed", error: "late overwrite" },
    });
    expect(replay.statusCode).toBe(409);
    const listed = await app.inject({
      method: "GET",
      url: "/api/schedules",
      headers: auth(OPERATOR),
    });
    const row = listed.json().schedules.find(
      (entry: { id: string }) => entry.id === scheduleId
    );
    expect(row.occurrences[0]).toMatchObject({ status: "done", rootJobId: "job-root" });
  });
});
