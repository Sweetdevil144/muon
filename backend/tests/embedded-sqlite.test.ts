import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A REAL SQLite integration test (no Prisma mock), the rest of the backend
// suite runs on prismaMock, so this is the only place the actual embedded-brain
// behavior is exercised in CI (review finding F9): migration tracking, the
// $extends Json defaults, and the atomic guarded-claim on SQLite.

let prisma: typeof import("../src/lib/db.js")["prisma"];
let ensureSchema: typeof import("../src/lib/db.js")["ensureSchema"];
let dir: string;

function splitMigration(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-sqlite-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  ensureSchema = db.ensureSchema;

  // Build an EXISTING pre-0009 install, including duplicate historical runner
  // rows, then let the real runtime migrator upgrade it. This is the packaged
  // update path—not merely a fresh-database schema test.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "_muon_migrations" ("version" TEXT PRIMARY KEY NOT NULL, "appliedAt" TEXT NOT NULL)`
  );
  const migrationsRoot = path.resolve("prisma", "migrations");
  const legacyVersions = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name < "0009_runner_host_lease"
    )
    .map((entry) => entry.name)
    .sort();
  for (const version of legacyVersions) {
    const sql = readFileSync(
      path.join(migrationsRoot, version, "migration.sql"),
      "utf8"
    );
    await prisma.$transaction([
      ...splitMigration(sql).map((statement) =>
        prisma.$executeRawUnsafe(statement)
      ),
      prisma.$executeRawUnsafe(
        `INSERT INTO "_muon_migrations" ("version","appliedAt") VALUES (?, ?)`,
        version,
        new Date().toISOString()
      ),
    ]);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Runner" ("id","host","pid","status","lastSeenAt","createdAt")
     VALUES
       ('runner-old','desktop-fixture',41,'online','2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z'),
       ('runner-new','desktop-fixture',42,'online','2026-07-13T00:01:00.000Z','2026-07-13T00:01:00.000Z')`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Agent"
       ("id","vendor","name","ordinal","status","currentTaskId","createdAt","updatedAt")
     VALUES
       ('agent-running','codex','codex-1',1,'working','task-running',
        '2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z')`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "DispatchJob"
       ("id","vendor","taskId","brief","status","agentId","host","createdAt","startedAt","updatedAt")
     VALUES
       ('job-running','codex','task-running','upgrade me','running',
        'agent-running','desktop-fixture',
        '2026-07-13T00:00:00.000Z','2026-07-13T00:00:30.000Z',
        '2026-07-13T00:00:30.000Z')`
  );
  await ensureSchema();
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("embedded SQLite brain", () => {
  it("ensureSchema upgrades an existing install through the runner-lease migration", async () => {
    const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Lane','DispatchJob','StreamChunk')"
    );
    expect(tables.map((t) => t.name).sort()).toEqual([
      "DispatchJob",
      "Lane",
      "StreamChunk",
    ]);
    const migrations = await prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT version FROM "_muon_migrations"`
    );
    expect(migrations.map((row) => row.version)).toContain(
      "0009_runner_host_lease"
    );
    const runnerColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("Runner")`
    );
    const jobColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("DispatchJob")`
    );
    const agentColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("Agent")`
    );
    expect(runnerColumns.map((column) => column.name)).toContain("leaseHash");
    expect(jobColumns.map((column) => column.name)).toContain(
      "runnerLeaseHash"
    );
    expect(agentColumns.map((column) => column.name)).toContain("currentJobId");
    const deduped = await prisma.$queryRawUnsafe<
      { id: string; host: string }[]
    >(`SELECT "id","host" FROM "Runner" WHERE "host"='desktop-fixture'`);
    expect(deduped).toEqual([
      { id: "runner-new", host: "desktop-fixture" },
    ]);
    const migratedAgent = await prisma.agent.findUnique({
      where: { id: "agent-running" },
    });
    expect(migratedAgent?.currentJobId).toBe("job-running");
  });

  it("the runtime migrator applies 0019 checkpoint columns on an existing DB", async () => {
    const migrations = await prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT version FROM "_muon_migrations"`
    );
    expect(migrations.map((row) => row.version)).toContain(
      "0019_checkpoint_resume"
    );
    const sessionColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("LaneSession")`
    );
    const approvalColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("ApprovalRequest")`
    );
    const dispatchColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("DispatchJob")`
    );
    expect(sessionColumns.map((column) => column.name)).toContain("jobId");
    expect(approvalColumns.map((column) => column.name)).toContain("jobId");
    expect(dispatchColumns.map((column) => column.name)).toContain(
      "resumedFromJobId"
    );
    // Append-once resume claim (P0.1 replay-safety): the same 0019 migration
    // also carries the fence columns.
    expect(dispatchColumns.map((column) => column.name)).toContain("resumedAt");
    expect(dispatchColumns.map((column) => column.name)).toContain(
      "resumedByJobId"
    );
    // The new columns are queryable (and the pre-existing row got NULLs).
    const rows = await prisma.$queryRawUnsafe<
      {
        id: string;
        resumedFromJobId: string | null;
        resumedAt: string | null;
        resumedByJobId: string | null;
      }[]
    >(
      `SELECT "id","resumedFromJobId","resumedAt","resumedByJobId" FROM "DispatchJob" WHERE "id"='job-running'`
    );
    expect(rows).toEqual([
      {
        id: "job-running",
        resumedFromJobId: null,
        resumedAt: null,
        resumedByJobId: null,
      },
    ]);
  });

  it("ensureSchema is idempotent (a second call is a clean no-op)", async () => {
    await expect(ensureSchema()).resolves.toBeUndefined();
  });

  it("0032 repairs legacy duplicate active-root lineages before adding its unique index", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`
        CREATE TABLE "DispatchJob" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "chatId" TEXT,
          "parentJobId" TEXT,
          "status" TEXT NOT NULL,
          "interruptRequested" INTEGER NOT NULL DEFAULT 0,
          "endedAt" TEXT,
          "result" TEXT,
          "delegationBudgetReservedMs" INTEGER NOT NULL DEFAULT 0,
          "updatedAt" TEXT NOT NULL
        );
        CREATE TABLE "Agent" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "status" TEXT NOT NULL,
          "currentTaskId" TEXT,
          "currentJobId" TEXT,
          "sessionId" TEXT,
          "updatedAt" TEXT NOT NULL
        );
        CREATE TABLE "LaneSession" (
          "id" TEXT PRIMARY KEY NOT NULL,
          "jobId" TEXT,
          "status" TEXT NOT NULL,
          "endedAt" TEXT,
          "updatedAt" TEXT NOT NULL
        );
        INSERT INTO "DispatchJob"
          ("id","chatId","parentJobId","status","delegationBudgetReservedMs","updatedAt")
        VALUES
          ('root-a','chat-duplicate',NULL,'running',60000,'2026-07-01T00:00:00.000Z'),
          ('root-b','chat-duplicate',NULL,'queued',60000,'2026-07-01T00:00:01.000Z'),
          ('child-a','chat-duplicate','root-a','running',0,'2026-07-01T00:00:02.000Z'),
          ('grandchild-a','chat-duplicate','child-a','queued',0,'2026-07-01T00:00:03.000Z'),
          ('root-safe','chat-safe',NULL,'running',1000,'2026-07-01T00:00:04.000Z');
        INSERT INTO "Agent"
          ("id","status","currentTaskId","currentJobId","sessionId","updatedAt")
        VALUES
          ('agent-doomed','working','task-a','child-a','session-a','2026-07-01T00:00:00.000Z'),
          ('agent-safe','working','task-safe','root-safe','session-safe','2026-07-01T00:00:00.000Z');
        INSERT INTO "LaneSession"
          ("id","jobId","status","updatedAt")
        VALUES
          ('session-a','child-a','running','2026-07-01T00:00:00.000Z'),
          ('session-safe','root-safe','running','2026-07-01T00:00:00.000Z');
      `);

      const migration = readFileSync(
        path.resolve(
          "prisma",
          "migrations",
          "0032_one_active_root_per_chat",
          "migration.sql"
        ),
        "utf8"
      );
      for (const statement of splitMigration(migration)) {
        legacy.exec(statement);
      }

      const jobs = legacy
        .prepare(
          `SELECT "id","status","interruptRequested","delegationBudgetReservedMs"
           FROM "DispatchJob" ORDER BY "id"`
        )
        .all();
      expect(jobs).toEqual([
        {
          id: "child-a",
          status: "interrupted",
          interruptRequested: 1,
          delegationBudgetReservedMs: 0,
        },
        {
          id: "grandchild-a",
          status: "interrupted",
          interruptRequested: 1,
          delegationBudgetReservedMs: 0,
        },
        {
          id: "root-a",
          status: "interrupted",
          interruptRequested: 1,
          delegationBudgetReservedMs: 0,
        },
        {
          id: "root-b",
          status: "interrupted",
          interruptRequested: 1,
          delegationBudgetReservedMs: 0,
        },
        {
          id: "root-safe",
          status: "running",
          interruptRequested: 0,
          delegationBudgetReservedMs: 1000,
        },
      ]);
      expect(
        legacy
          .prepare(
            `SELECT "status","currentTaskId","currentJobId","sessionId"
             FROM "Agent" WHERE "id"='agent-doomed'`
          )
          .get()
      ).toEqual({
        status: "idle",
        currentTaskId: null,
        currentJobId: null,
        sessionId: null,
      });
      expect(
        legacy
          .prepare(
            `SELECT "status","endedAt" IS NOT NULL AS "ended"
             FROM "LaneSession" WHERE "id"='session-a'`
          )
          .get()
      ).toEqual({ status: "interrupted", ended: 1 });
      expect(() =>
        legacy.exec(
          `INSERT INTO "DispatchJob"
            ("id","chatId","parentJobId","status","updatedAt")
           VALUES ('root-safe-2','chat-safe',NULL,'queued','2026-07-01T00:00:05.000Z')`
        )
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      legacy.close();
    }
  });

  it("the $extends hook defaults omitted Json fields on create (F3)", async () => {
    const job = await prisma.dispatchJob.create({
      data: { vendor: "claude-code", taskId: "t1", brief: "do the thing" },
    });
    // steerMessages was omitted → hook filled [] (not null / not a NOT NULL error).
    expect(job.steerMessages).toEqual([]);
  });

  it("the guarded updateMany claim is exactly-once under concurrency", async () => {
    const job = await prisma.dispatchJob.create({
      data: { vendor: "codex", taskId: "t2", brief: "claim me" },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.dispatchJob.updateMany({
          where: { id: job.id, status: "queued" },
          data: { status: "running" },
        })
      )
    );
    const winners = results.filter((r) => r.count === 1).length;
    expect(winners).toBe(1);
  });

  it("migrates and enforces the pending merge execution CAS on real SQLite", async () => {
    const migrations = await prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT version FROM "_muon_migrations"`
    );
    expect(migrations.map((row) => row.version)).toContain(
      "0031_merge_execution_recovery"
    );
    const approvalColumns = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("ApprovalRequest")`
    );
    expect(approvalColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "mergeExecutionStatus",
        "mergeExecutionAttemptId",
        "mergeExecutionLeaseExpiresAt",
        "mergeExecution",
      ])
    );

    const task = await prisma.task.create({
      data: {
        title: "Merge CAS",
        description: "Prove only one executor can claim a pending approval.",
      },
    });
    const approval = await prisma.approvalRequest.create({
      data: {
        taskId: task.id,
        requestedBy: "agent:test",
        kind: "merge",
        reason: "Ready for exact artifact merge review.",
      },
    });
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        prisma.approvalRequest.updateMany({
          where: {
            id: approval.id,
            status: "pending",
            mergeExecutionStatus: null,
          },
          data: {
            mergeExecutionStatus: "executing",
            mergeExecutionAttemptId: `attempt-${index}`,
            mergeExecutionLeaseExpiresAt: new Date(Date.now() + 60_000),
            mergeExecution: {
              version: 1,
              target: { taskId: task.id },
            },
          },
        })
      )
    );
    expect(claims.filter(({ count }) => count === 1)).toHaveLength(1);
    const claimed = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(claimed.status).toBe("pending");
    expect(claimed.mergeExecutionStatus).toBe("executing");

    const staleFinalize = await prisma.approvalRequest.updateMany({
      where: {
        id: approval.id,
        status: "pending",
        mergeExecutionStatus: "executing",
        mergeExecutionAttemptId: "not-the-winner",
      },
      data: { status: "approved" },
    });
    expect(staleFinalize.count).toBe(0);
    const final = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(final.status).toBe("pending");
  });
});
