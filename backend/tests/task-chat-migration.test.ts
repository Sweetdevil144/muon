import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("0028 task chat scope migration", () => {
  it("backfills only unambiguous dispatch ownership and preserves the chat shadow authority", () => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE "Task" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "DispatchJob" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "taskId" TEXT NOT NULL,
        "chatId" TEXT
      );
      CREATE TABLE "OrchestratorChat" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "taskId" TEXT NOT NULL
      );

      INSERT INTO "Task" ("id") VALUES
        ('task-unambiguous'),
        ('task-ambiguous'),
        ('task-shadow'),
        ('task-unowned');

      INSERT INTO "DispatchJob" ("id", "taskId", "chatId") VALUES
        ('job-u-1', 'task-unambiguous', 'chat-a'),
        ('job-u-2', 'task-unambiguous', 'chat-a'),
        ('job-a-1', 'task-ambiguous', 'chat-a'),
        ('job-a-2', 'task-ambiguous', 'chat-b'),
        ('job-s-1', 'task-shadow', 'chat-old'),
        ('job-s-2', 'task-shadow', 'chat-new');

      INSERT INTO "OrchestratorChat" ("id", "taskId")
      VALUES ('chat-shadow', 'task-shadow');
    `);

    const migration = readFileSync(
      path.resolve(
        "prisma",
        "migrations",
        "0028_task_chat_scope",
        "migration.sql",
      ),
      "utf8",
    );
    database.exec(migration);

    const rows = database
      .prepare(`SELECT "id", "chatId" FROM "Task" ORDER BY "id"`)
      .all() as Array<{ id: string; chatId: string | null }>;
    expect(rows).toEqual([
      { id: "task-ambiguous", chatId: null },
      { id: "task-shadow", chatId: "chat-shadow" },
      { id: "task-unambiguous", chatId: "chat-a" },
      { id: "task-unowned", chatId: null },
    ]);
  });
});
