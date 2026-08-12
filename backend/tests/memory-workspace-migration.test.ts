import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// ADR-0026 §11 step 1 — `0041_memory_note_workspace`, exercised as REAL SQL
// against a real SQLite file, the way `0028_task_chat_scope` is
// (tests/task-chat-migration.test.ts). Nothing here is mocked: the assertions run
// against the shipped `migration.sql`, so a change to the backfill's witness
// logic, to the anchor emission, or to the MemoryImport guard fails here.

const MIGRATION_PATH = path.resolve(
  "prisma",
  "migrations",
  "0041_memory_note_workspace",
  "migration.sql"
);

const MUON = "/Users/dev/SWE/MUON-LABS";
const GITNEXUS = "/Users/dev/SWE/GitNexus";

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

/** The embedded migrator's own splitter (backend/src/lib/db.ts): comments are
 *  dropped and the file is split on `;`, then each statement is executed
 *  INDIVIDUALLY inside one transaction. A migration that only works when handed
 *  to sqlite as one blob would break on the real runner. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE "MemoryNote" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "kind" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "textHash" TEXT NOT NULL,
      "scope" TEXT NOT NULL DEFAULT 'project',
      "status" TEXT NOT NULL DEFAULT 'active',
      "taskId" TEXT,
      "chatId" TEXT
    );
    CREATE TABLE "MemoryAnchor" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "noteId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "value" TEXT NOT NULL
    );
    CREATE UNIQUE INDEX "MemoryAnchor_noteId_kind_value_key"
      ON "MemoryAnchor"("noteId", "kind", "value");
    CREATE TABLE "Task" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "workspacePath" TEXT
    );
    CREATE TABLE "OrchestratorChat" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "workspacePath" TEXT NOT NULL
    );
    CREATE TABLE "MemoryImport" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "originWorkspace" TEXT NOT NULL,
      "recordHash" TEXT NOT NULL
    );
    CREATE UNIQUE INDEX "MemoryImport_originWorkspace_recordHash_key"
      ON "MemoryImport"("originWorkspace", "recordHash");
    CREATE TABLE "Confirmation" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "noteId" TEXT NOT NULL
    );

    INSERT INTO "Task" ("id", "workspacePath") VALUES
      ('task-muon', '${MUON}'),
      ('task-gitnexus', '${GITNEXUS}'),
      ('task-no-workspace', NULL),
      ('task-disagrees', '${MUON}');
    INSERT INTO "OrchestratorChat" ("id", "workspacePath") VALUES
      ('chat-muon', '${MUON}'),
      ('chat-gitnexus', '${GITNEXUS}');

    INSERT INTO "MemoryNote" ("id","kind","text","textHash","taskId","chatId") VALUES
      ('note-both-agree',   'decision',   'both witnesses agree',      'h1', 'task-muon',          'chat-muon'),
      ('note-task-only',    'constraint', 'only the task witness',     'h2', 'task-gitnexus',      NULL),
      ('note-chat-only',    'convention', 'only the chat witness',     'h3', NULL,                 'chat-gitnexus'),
      ('note-disagree',     'attempt',    'the witnesses disagree',    'h4', 'task-disagrees',      'chat-gitnexus'),
      ('note-task-null-ws', 'question',   'task row has no workspace', 'h5', 'task-no-workspace',  NULL),
      ('note-pruned-task',  'decision',   'task row was pruned',       'h6', 'task-vanished',      NULL),
      ('note-orphan',       'decision',   'no witness at all',         'h7', NULL,                 NULL);
    INSERT INTO "Confirmation" ("id","noteId") VALUES ('conf-1','note-both-agree');
  `);
  return db;
}

function apply(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    for (const statement of splitStatements(readFileSync(MIGRATION_PATH, "utf8"))) {
      db.exec(statement);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type NoteRow = { id: string; workspacePath: string | null };

function notes(db: DatabaseSync): NoteRow[] {
  return db
    .prepare(`SELECT "id", "workspacePath" FROM "MemoryNote" ORDER BY "id"`)
    .all() as NoteRow[];
}

describe("0041 memory note workspace migration", () => {
  it("BACKFILL: writes only on witness agreement, and reports the three counts", () => {
    database = seed();
    apply(database);

    expect(notes(database)).toEqual([
      // Both witnesses agree → written.
      { id: "note-both-agree", workspacePath: MUON },
      // Only the chat witness resolves → written.
      { id: "note-chat-only", workspacePath: GITNEXUS },
      // The witnesses DISAGREE → left NULL on purpose. A disagreement is a fact
      // about the brain, not something to resolve by preferring one witness.
      { id: "note-disagree", workspacePath: null },
      // No witness at all → left NULL.
      { id: "note-orphan", workspacePath: null },
      // The Task row is gone (pruned on some other install) → left NULL.
      { id: "note-pruned-task", workspacePath: null },
      // The Task row exists but carries NULL workspacePath → no witness.
      { id: "note-task-null-ws", workspacePath: null },
      // Only the task witness resolves → written.
      { id: "note-task-only", workspacePath: GITNEXUS },
    ]);

    const written = notes(database).filter((row) => row.workspacePath !== null);
    const residue = notes(database).filter((row) => row.workspacePath === null);
    expect(written).toHaveLength(3);
    // 3 written / 3 left NULL for lack of a witness / 1 left NULL for disagreement.
    expect(residue).toHaveLength(4);
    expect(
      residue.filter((row) => row.id === "note-disagree")
    ).toHaveLength(1);
  });

  it("ANCHORS: one kind:workspace anchor per BACKFILLED note, and none for the residue", () => {
    database = seed();
    apply(database);

    const anchors = database
      .prepare(
        `SELECT "noteId", "value" FROM "MemoryAnchor" WHERE "kind" = 'workspace' ORDER BY "noteId"`
      )
      .all() as { noteId: string; value: string }[];
    expect(anchors).toEqual([
      { noteId: "note-both-agree", value: MUON },
      { noteId: "note-chat-only", value: GITNEXUS },
      { noteId: "note-task-only", value: GITNEXUS },
    ]);
  });

  it("NON-DESTRUCTIVE: nullable, no note deleted or retired, scope and Confirmation untouched", () => {
    database = seed();
    const before = database
      .prepare(`SELECT "id","scope","status" FROM "MemoryNote" ORDER BY "id"`)
      .all();
    const confirmationsBefore = database
      .prepare(`SELECT "id","noteId" FROM "Confirmation" ORDER BY "id"`)
      .all();
    apply(database);

    expect(
      database
        .prepare(`SELECT "id","scope","status" FROM "MemoryNote" ORDER BY "id"`)
        .all()
    ).toEqual(before);
    expect(
      database.prepare(`SELECT "id","noteId" FROM "Confirmation" ORDER BY "id"`).all()
    ).toEqual(confirmationsBefore);

    // The column must stay NULLABLE: a residue note has to be storable.
    const column = database
      .prepare(
        `SELECT "notnull", "dflt_value" FROM pragma_table_info('MemoryNote') WHERE "name" = 'workspacePath'`
      )
      .get() as { notnull: number; dflt_value: string | null };
    expect(column).toEqual({ notnull: 0, dflt_value: null });
  });

  it("INDEXES: the partition index and the (workspacePath, chatId) composite exist", () => {
    database = seed();
    apply(database);

    const indexed = (name: string) =>
      (
        database!
          .prepare(`SELECT "name" FROM pragma_index_info(?)`)
          .all(name) as { name: string }[]
      ).map((row) => row.name);
    expect(indexed("MemoryNote_workspacePath_idx")).toEqual(["workspacePath"]);
    expect(indexed("MemoryNote_workspacePath_chatId_idx")).toEqual([
      "workspacePath",
      "chatId",
    ]);
  });

  it("IDEMPOTENT: re-running the data statements changes nothing", () => {
    database = seed();
    apply(database);
    const notesAfterFirst = notes(database);
    const anchorsAfterFirst = database
      .prepare(`SELECT "id","noteId","kind","value" FROM "MemoryAnchor" ORDER BY "id"`)
      .all();

    for (const statement of splitStatements(readFileSync(MIGRATION_PATH, "utf8"))) {
      if (statement.startsWith("UPDATE") || statement.startsWith("INSERT OR IGNORE")) {
        database.exec(statement);
      }
    }

    expect(notes(database)).toEqual(notesAfterFirst);
    expect(
      database
        .prepare(`SELECT "id","noteId","kind","value" FROM "MemoryAnchor" ORDER BY "id"`)
        .all()
    ).toEqual(anchorsAfterFirst);
  });

  it("MEMORY IMPORT: the unique key widens, and the '' default keeps today's semantics", () => {
    database = seed();
    apply(database);

    expect(
      database
        .prepare(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'index' AND "name" LIKE 'MemoryImport%' ORDER BY "name"`
        )
        .all()
    ).toEqual([
      { name: "MemoryImport_originWorkspace_receivingWorkspace_recordHash_key" },
    ]);

    // NOT NULL DEFAULT '' — a nullable column would make every NULL distinct in
    // the UNIQUE index and silently disable the import idempotence key.
    expect(
      database
        .prepare(
          `SELECT "notnull","dflt_value" FROM pragma_table_info('MemoryImport') WHERE "name" = 'receivingWorkspace'`
        )
        .get()
    ).toEqual({ notnull: 1, dflt_value: "''" });

    database.exec(
      `INSERT INTO "MemoryImport" ("id","originWorkspace","recordHash") VALUES ('imp-1','ws-aaaa','hash-1')`
    );
    expect(() =>
      database!.exec(
        `INSERT INTO "MemoryImport" ("id","originWorkspace","recordHash") VALUES ('imp-2','ws-aaaa','hash-1')`
      )
    ).toThrow(/UNIQUE constraint failed/);
    // A DIFFERENT receiving workspace is a DIFFERENT import (§7): the same pack
    // re-imported into a second workspace must not be swallowed.
    database.exec(
      `INSERT INTO "MemoryImport" ("id","originWorkspace","receivingWorkspace","recordHash") VALUES ('imp-3','ws-aaaa','ws-bbbb','hash-1')`
    );
    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM "MemoryImport"`).get()
    ).toEqual({ n: 2 });
  });

  // ADR-0026 §11 called the `MemoryImport` unique-key widening "the one
  // non-additive step" and said to refuse it automatically on a populated table.
  // A CHECK-constraint guard was written to do exactly that, and then removed —
  // because `ensureSchema` runs the whole migration in ONE transaction, so the
  // abort took the *additive* `workspacePath` column down with it and an install
  // that had ever imported a pack could not boot at all.
  //
  // The refusal was protecting against nothing. `receivingWorkspace` lands
  // `NOT NULL DEFAULT ''`, so every pre-existing row widens to
  // `(originWorkspace, '', recordHash)` — byte-for-byte as restrictive as the old
  // `(originWorkspace, recordHash)`. No existing pair can collide under the new
  // key and no previously-distinct pair can fuse, which is why there is nothing
  // for an operator to adjudicate.
  //
  // This test is the one that pins that decision, in both halves: the migration
  // must APPLY on a populated table, and the widened key must still refuse the
  // duplicate the old key refused. If someone reinstates a guard, the first half
  // fails; if someone makes the column nullable (SQLite treats every NULL in a
  // UNIQUE index as distinct, which would silently DISABLE the idempotence key
  // `importMemoryPack` relies on via P2002), the second half fails.
  it("APPLIES over a populated MemoryImport, and the widened key keeps the old key's semantics", () => {
    database = seed();
    database.exec(
      `INSERT INTO "MemoryImport" ("id","originWorkspace","recordHash") VALUES
         ('imp-a','ws-aaaa','hash-1'),
         ('imp-b','ws-aaaa','hash-2'),
         ('imp-c','ws-bbbb','hash-1')`
    );

    expect(() => apply(database!)).not.toThrow();

    // Every row survives, and each carries the '' that makes the widening exact.
    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM "MemoryImport"`).get()
    ).toEqual({ n: 3 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM "MemoryImport" WHERE "receivingWorkspace" = ''`
        )
        .get()
    ).toEqual({ n: 3 });

    // The additive column landed — the thing the guard used to take down with it.
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM pragma_table_info('MemoryNote') WHERE "name" = 'workspacePath'`
        )
        .get()
    ).toEqual({ n: 1 });

    // The old index is gone and the widened one is in place.
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE "name" = 'MemoryImport_originWorkspace_recordHash_key'`
        )
        .get()
    ).toEqual({ n: 0 });

    // And the idempotence key still bites: re-importing the same record from the
    // same origin into the same (default) receiving workspace is still a
    // conflict, which is what `importMemoryPack` reads as "already imported".
    expect(() =>
      database!.exec(
        `INSERT INTO "MemoryImport" ("id","originWorkspace","recordHash","receivingWorkspace")
           VALUES ('imp-dupe','ws-aaaa','hash-1','')`
      )
    ).toThrow(/UNIQUE constraint failed/);
  });
});
