import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Initialize MUON's environment before constructing PrismaClient. Otherwise
// Prisma may auto-load backend/.env first and leak a developer-only hosted URL
// into an embedded launch whose cwd intentionally has no env file.
import "./env.js";
import { PrismaClient } from "@prisma/client";

// SQLite can't express `Json @default("{}")`/`@default("[]")` (Prisma emits
// invalid DDL), so the schema drops those 7 defaults and we re-apply them here
// in ONE place, a Client `$extends` hook covering EVERY write path that can
// omit the field (`create`, `createMany`, and the `create` side of `upsert`),
// so no write site can regress to a NOT NULL violation (review finding F3).
// steerMessages defaults to []; every other Json field to {}. Keyed by the
// PascalCase model name the `$allModels` hook reports. See
// docs/adr/0008-embedded-brain-sqlite.md.
const JSON_DEFAULTS: Record<string, Record<string, unknown>> = {
  LaneProfile: { config: {} },
  Event: { metadata: {} },
  Harness: { config: {} },
  WorkflowTemplate: { definition: {} },
  WorkflowRun: { proposal: {} },
  DispatchJob: { steerMessages: [] },
  LoopRun: { budget: {} },
  // Memory ledger (KG-1): the anchor arrays default to [] the same way, no
  // SQLite `Json @default("[]")`, so no create site can regress to NOT NULL.
  // symbols (ADR-0012) joins modules/topics with the identical [] default.
  MemoryNote: { modules: [], topics: [], symbols: [] },
};

function applyJsonDefaults(model: string | undefined, data: unknown): unknown {
  const defaults = model ? JSON_DEFAULTS[model] : undefined;
  if (!defaults || typeof data !== "object" || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((row) => applyJsonDefaults(model, row));
  }
  const record = data as Record<string, unknown>;
  const patched: Record<string, unknown> = { ...record };
  for (const [field, fallback] of Object.entries(defaults)) {
    if (patched[field] === undefined) {
      patched[field] = fallback;
    }
  }
  return patched;
}

export const prisma = new PrismaClient().$extends({
  query: {
    $allModels: {
      create({ model, args, query }) {
        args.data = applyJsonDefaults(model, args.data) as typeof args.data;
        return query(args);
      },
      createMany({ model, args, query }) {
        args.data = applyJsonDefaults(model, args.data) as typeof args.data;
        return query(args);
      },
      upsert({ model, args, query }) {
        args.create = applyJsonDefaults(model, args.create) as typeof args.create;
        return query(args);
      },
    },
  },
});

/**
 * Enable WAL once at boot for the embedded SQLite brain: ~1.7x writes / ~3x
 * reads-under-write-burst, matching MUON's constant TUI/desktop/stream polling.
 * Uses `$queryRawUnsafe`, `PRAGMA journal_mode` RETURNS a row, which
 * `$executeRawUnsafe` rejects. No-op for a hosted (Postgres) DATABASE_URL.
 */
export async function enableWal(): Promise<void> {
  if (process.env.DATABASE_URL?.startsWith("file:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  }
}

function migrationsDir(): string {
  // dist/lib/db.js -> ../../prisma/migrations (the schema + baseline migration
  // ship alongside the backend; a packaged app bundles prisma/ too).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "prisma", "migrations");
}

/** Split a Prisma migration.sql into individual statements (drops comments). */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Schema materialization for the embedded SQLite brain: applies any committed
 * migrations that haven't run yet, tracked in a `_muon_migrations` table, so a
 * downloaded app "just works" on first launch AND a later app update that ships
 * a `0002_*` migration actually applies to an EXISTING install (review finding
 * F2, the old first-launch-only check would silently skip it). No Prisma CLI at
 * runtime. Idempotent; a no-op for a hosted (Postgres) DATABASE_URL, where the
 * schema is managed out-of-band via `prisma migrate deploy`.
 */
export async function ensureSchema(): Promise<void> {
  if (!process.env.DATABASE_URL?.startsWith("file:")) {
    return;
  }
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "_muon_migrations" ("version" TEXT PRIMARY KEY NOT NULL, "appliedAt" TEXT NOT NULL)`
  );

  const versions = readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const applied = new Set(
    (
      await prisma.$queryRawUnsafe<{ version: string }[]>(
        `SELECT "version" FROM "_muon_migrations"`
      )
    ).map((row) => row.version)
  );

  // Adopt an install created by an older build (baseline applied, no bookkeeping
  // table yet): if the schema is clearly present but nothing is recorded, mark
  // the baseline as applied so we don't try to re-CREATE existing tables.
  if (applied.size === 0 && versions[0]) {
    const hasBaselineTables = await prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='Lane'"
    );
    if (hasBaselineTables.length > 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_muon_migrations" ("version","appliedAt") VALUES (?, ?)`,
        versions[0],
        new Date().toISOString()
      );
      applied.add(versions[0]);
    }
  }

  for (const version of versions) {
    if (applied.has(version)) {
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir(), version, "migration.sql"), "utf8");
    // One transaction per migration, statements + the bookkeeping insert commit
    // together, so a crash mid-migration leaves it un-applied and retryable.
    await prisma.$transaction([
      ...splitStatements(sql).map((statement) =>
        prisma.$executeRawUnsafe(statement)
      ),
      prisma.$executeRawUnsafe(
        `INSERT INTO "_muon_migrations" ("version","appliedAt") VALUES (?, ?)`,
        version,
        new Date().toISOString()
      ),
    ]);
  }
}
