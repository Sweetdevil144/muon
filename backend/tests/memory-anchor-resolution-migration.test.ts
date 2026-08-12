import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

// D1 (docs/design/memory-index-decisions.md §D1) — `0042_memory_anchor_resolution`
// exercised as REAL SQL against a real SQLite file, the same way
// `0041_memory_note_workspace` is (tests/memory-workspace-migration.test.ts).
// Nothing here is mocked: the assertions run against the shipped `migration.sql`.
//
// What this file exists to catch is not "does ALTER TABLE work" — it is the three
// things the migration deliberately does NOT do. Each has a named failure mode:
//
//   • A BACKFILL would have to assert a resolution for a row nobody resolved.
//   • NOT NULL / a DEFAULT would destroy the NULL state, which is a real state
//     (legacy, non-coordinate, or "we could not read the tracked set") and not an
//     absence to be filled.
//   • A statement that can ABORT takes the additive column down with it, because
//     `ensureSchema` runs the whole migration in ONE transaction. 0041 already paid
//     for that lesson by removing its own CHECK-constraint guard.

const MIGRATION_PATH = path.resolve(
  "prisma",
  "migrations",
  "0042_memory_anchor_resolution",
  "migration.sql"
);

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

/** The embedded migrator's own splitter (backend/src/lib/db.ts): comments are
 *  dropped and the file is split on `;`, then each statement is executed
 *  INDIVIDUALLY inside one transaction. A migration that only works when handed to
 *  sqlite as one blob would break on the real runner. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** A pre-0042 `MemoryAnchor`, populated the way a live brain's is: coordinate rows
 *  (module/symbol) alongside rows that are not coordinates at all. */
function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE "MemoryAnchor" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "noteId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "value" TEXT NOT NULL
    );
    CREATE UNIQUE INDEX "MemoryAnchor_noteId_kind_value_key"
      ON "MemoryAnchor"("noteId", "kind", "value");
    CREATE INDEX "MemoryAnchor_kind_value_idx" ON "MemoryAnchor"("kind", "value");
    CREATE INDEX "MemoryAnchor_noteId_idx" ON "MemoryAnchor"("noteId");

    INSERT INTO "MemoryAnchor" ("id","noteId","kind","value") VALUES
      ('a1','note-1','module',   'apps/cli/README.md'),
      ('a2','note-1','symbol',   'apps/cli/README.md#README.md'),
      ('a3','note-1','task',     'task-legacy'),
      ('a4','note-1','chat',     'chat-legacy'),
      ('a5','note-2','module',   'operations/backend/app/constants'),
      ('a6','note-2','topic',    'retries'),
      ('a7','note-2','workspace','/Users/dev/SWE/MUON-LABS');
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

type AnchorRow = {
  id: string;
  kind: string;
  value: string;
  resolution: string | null;
};

function anchors(db: DatabaseSync): AnchorRow[] {
  return db
    .prepare(
      `SELECT "id","kind","value","resolution" FROM "MemoryAnchor" ORDER BY "id"`
    )
    .all() as AnchorRow[];
}

describe("0042 memory anchor resolution migration", () => {
  it("is EXACTLY ONE additive statement", () => {
    const statements = splitStatements(readFileSync(MIGRATION_PATH, "utf8"));
    expect(statements).toEqual([
      `ALTER TABLE "MemoryAnchor" ADD COLUMN "resolution" TEXT`,
    ]);
  });

  it("NO BACKFILL: every pre-existing anchor lands NULL, coordinate or not", () => {
    database = seed();
    apply(database);

    // NULL for all seven, including the two module rows and the symbol row. This
    // is the honest answer: nobody resolved them, and a migration cannot — it has
    // no workspace to resolve against and cannot spawn `git ls-files` inside
    // `ensureSchema`'s single transaction. `unresolved` here would assert that
    // `apps/cli/README.md` is not in its repository, which is FALSE (it is a
    // measured, tracked path); D1's whole rule is that we never assert that
    // without the set.
    expect(anchors(database).every((row) => row.resolution === null)).toBe(true);
    expect(anchors(database)).toHaveLength(7);
  });

  it("NULLABLE, no default: the NULL state has to be storable and must not be minted", () => {
    database = seed();
    apply(database);

    const column = database
      .prepare(
        `SELECT "notnull","dflt_value" FROM pragma_table_info('MemoryAnchor') WHERE "name" = 'resolution'`
      )
      .get() as { notnull: number; dflt_value: string | null };
    // NOT NULL would make a legacy row unstorable and a non-coordinate anchor
    // claim a resolution it never had; a DEFAULT would silently do the same.
    expect(column).toEqual({ notnull: 0, dflt_value: null });
  });

  it("NO INDEX on resolution: the only reader is keyed on noteId, which is already indexed", () => {
    database = seed();
    // Captured rather than hard-coded: `id TEXT PRIMARY KEY` also mints an
    // implicit `sqlite_autoindex_…`, and spelling the expected set out by hand got
    // that wrong first time round. What the assertion should say is "0042 adds
    // none", which is a BEFORE/AFTER comparison, not a literal.
    const indexes = () =>
      (
        database!
          .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'index' AND "tbl_name" = 'MemoryAnchor' ORDER BY "name"`
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
    const before = indexes();
    apply(database);

    // The one query that reads the column is the `planned`-declaration inheritance
    // lookup a clone / text-edit successor performs — `WHERE noteId = ? AND
    // resolution = 'planned'` — which `MemoryAnchor_noteId_idx` already serves.
    // Nothing filters on `resolution` ACROSS notes yet (that is D15 and D4+D6), and
    // an index justified by a query nobody wrote is an index nobody can remove.
    expect(indexes()).toEqual(before);
    expect(before).toContain("MemoryAnchor_noteId_idx");
    expect(indexes().some((name) => name.includes("resolution"))).toBe(false);
  });

  it("NON-DESTRUCTIVE: no row, key or value changes", () => {
    database = seed();
    const before = database
      .prepare(`SELECT "id","noteId","kind","value" FROM "MemoryAnchor" ORDER BY "id"`)
      .all();
    apply(database);

    expect(
      database
        .prepare(`SELECT "id","noteId","kind","value" FROM "MemoryAnchor" ORDER BY "id"`)
        .all()
    ).toEqual(before);
    // And the dedup identity is untouched: `(noteId, kind, value)` still bites, so
    // the write-path candidate lookup 0042 rides on cannot have drifted.
    expect(() =>
      database!.exec(
        `INSERT INTO "MemoryAnchor" ("id","noteId","kind","value") VALUES ('dupe','note-1','module','apps/cli/README.md')`
      )
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("APPLIES over a populated table, and accepts all three named states afterwards", () => {
    database = seed();
    expect(() => apply(database!)).not.toThrow();

    database.exec(
      `INSERT INTO "MemoryAnchor" ("id","noteId","kind","value","resolution") VALUES
         ('n1','note-3','module','src/exists.ts','resolved'),
         ('n2','note-3','module','src/typo.ts','unresolved'),
         ('n3','note-3','module','src/future.ts','planned'),
         ('n4','note-3','task','task-3',NULL)`
    );
    expect(
      database
        .prepare(
          `SELECT "resolution", COUNT(*) AS n FROM "MemoryAnchor" WHERE "noteId" = 'note-3' GROUP BY "resolution" ORDER BY "resolution"`
        )
        .all()
    ).toEqual([
      { resolution: null, n: 1 },
      { resolution: "planned", n: 1 },
      { resolution: "resolved", n: 1 },
      { resolution: "unresolved", n: 1 },
    ]);
  });
});
