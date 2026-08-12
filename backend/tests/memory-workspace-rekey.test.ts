import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ── ADR-0026 §11: 0041's MIS-KEYED partition, and the repair ─────────────────
//
// `0041_memory_note_workspace` backfilled `MemoryNote.workspacePath` by copying
// `Task.workspacePath` / `OrchestratorChat.workspacePath` VERBATIM, because raw
// SQL cannot call `repoRootOf`. Every read derives its key THROUGH `repoRootOf`,
// which strips a `.muon/worktrees/<taskId>` tail, resolves symlinks, normalizes a
// trailing separator and case-corrects against the filesystem.
//
// So a witness value in any of those spellings produced a stored partition that no
// read coordinate can name: the note is invisible to every agent read and
// non-exportable by every pack, SILENTLY, and the residue backfill could not repair
// it either — its query is `where: { workspacePath: null }` and 0041 had already
// assigned these rows.
//
// The founder's own install is UNAFFECTED (all six witness values are already
// canonical, measured), so the case is CONSTRUCTED here rather than reproduced:
// three raw spellings that a real `Task.workspacePath` can genuinely hold, seeded
// exactly as the migration seeded them — raw SQL, plus the `kind:"workspace"`
// anchor row step 4 of the migration mints.
//
// Every assertion is a PAIR. A repair that made everything visible would pass a
// one-sided test just as well as a correct one, so the already-canonical partition
// is asserted UNTOUCHED beside every re-keyed one.

const OPERATOR = "operator-token-ws-rekey";
const AGENT = "agent-token-ws-rekey";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let repoA: string;
let repoB: string;
/** The exact shape `execute.ts` hands a worker under an editing harness. */
let worktreeInA: string;
/** `repoA` with a trailing separator — `path.resolve` normalizes it away. */
let trailingSlashA: string;
/** A symlink whose target is `repoB` — `realpathOfNearestExisting` resolves it. */
let symlinkToB: string;

let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let identity: typeof import("../src/lib/workspace-identity.js");
let app: FastifyInstance;

/** Seeded the way 0041 seeded: the RAW witness value, by raw SQL, with the derived
 *  anchor id the migration mints (`0041-ws-<noteId>`). */
async function seedAsMigration(
  noteId: string,
  text: string,
  rawWorkspace: string
): Promise<void> {
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "MemoryNote"
       ("id","kind","text","textHash","scope","trust","status","createdBy",
        "modules","topics","symbols","workspacePath","updatedAt")
     VALUES (?,?,?,?,'project','medium','active','human','[]','[]','[]',?,CURRENT_TIMESTAMP)`,
    noteId,
    "decision",
    text,
    createHash("sha256").update(text).digest("hex"),
    rawWorkspace
  );
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "MemoryAnchor" ("id","noteId","kind","value")
     VALUES (?,?,'workspace',?)`,
    `0041-ws-${noteId}`,
    noteId,
    rawWorkspace
  );
}

const ids = {
  worktree: "mem-rekey-worktree",
  slash: "mem-rekey-slash",
  symlink: "mem-rekey-symlink",
  canonical: "mem-rekey-canonical",
};

async function partitionOf(noteId: string): Promise<string | null> {
  const row = await db.prisma.memoryNote.findUniqueOrThrow({
    where: { id: noteId },
    select: { workspacePath: true },
  });
  return row.workspacePath;
}

async function workspaceAnchorsOf(noteId: string): Promise<string[]> {
  const rows = await db.prisma.memoryAnchor.findMany({
    where: { noteId, kind: "workspace" },
    select: { value: true },
    orderBy: { value: "asc" },
  });
  return rows.map((row) => row.value);
}

/** Note ids the OPERATOR library returns when it is asked for one workspace. The
 *  library's where-clause is SQL and never touches the graph — the one surface
 *  ADR-0026 §1 measured actually leaking, and the one that reduces the operator's
 *  coordinate through `repoRootOf` before comparing it. */
async function libraryIds(workspace: string): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/memory/library?workspace=${encodeURIComponent(workspace)}&limit=200`,
    headers: auth(OPERATOR),
  });
  expect(response.statusCode).toBe(200);
  return (response.json().notes as { id: string }[])
    .map((note) => note.id)
    .filter((id) => id.startsWith("mem-rekey-"))
    .sort();
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-ws-rekey-")));
  repoA = path.join(dir, "repo-a");
  repoB = path.join(dir, "repo-b");
  worktreeInA = path.join(repoA, ".muon", "worktrees", "task-rekey");
  trailingSlashA = `${repoA}${path.sep}`;
  symlinkToB = path.join(dir, "link-to-repo-b");
  mkdirSync(worktreeInA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  symlinkSync(repoB, symlinkToB, "dir");

  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  // The temp dir is under neither cwd nor $HOME on every platform, and the
  // operator read path validates through `validateWorkspacePath` first.
  process.env.MUON_WORKSPACE_ROOTS = dir;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  identity = await import("../src/lib/workspace-identity.js");
  await db.ensureSchema();

  await seedAsMigration(ids.worktree, "worktree tail alpha-mike", worktreeInA);
  await seedAsMigration(ids.slash, "trailing slash bravo-mike", trailingSlashA);
  await seedAsMigration(ids.symlink, "symlinked spelling charlie-mike", symlinkToB);
  // The control: a partition that ALREADY is its own `repoRootOf`.
  await seedAsMigration(ids.canonical, "already canonical delta-mike", repoB);

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.awaitGraphMirrors();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("ADR-0026 §11: the partition 0041 stored that no read can name", () => {
  it("the seeded raw spellings really do reduce to a DIFFERENT key", async () => {
    // The premise, asserted rather than assumed. If any of these three ever stopped
    // differing from its stored value, every test below would pass vacuously.
    expect(await identity.repoRootOf(worktreeInA)).toBe(repoA);
    expect(await identity.repoRootOf(trailingSlashA)).toBe(repoA);
    expect(await identity.repoRootOf(symlinkToB)).toBe(repoB);
    expect(await identity.repoRootOf(repoB)).toBe(repoB);
    for (const raw of [worktreeInA, trailingSlashA, symlinkToB]) {
      expect(raw).not.toBe(await identity.repoRootOf(raw));
    }
  });

  it("BEFORE the repair: the mis-keyed notes are invisible to the read that names their repo", async () => {
    // The control note IS returned, so this is a fence rather than an empty read.
    expect(await libraryIds(repoB)).toEqual([ids.canonical]);
    // …and repo A, which genuinely owns the worktree and the trailing-slash notes,
    // sees nothing at all. That is the defect, in one assertion.
    expect(await libraryIds(repoA)).toEqual([]);
  });

  it("DRY RUN reports the mis-keyed class SEPARATELY from the NULL class, and writes nothing", async () => {
    const result = await ledger.backfillMemoryNoteWorkspace();
    expect(result.applied).toBe(false);
    // The NULL class is untouched by this: none of these notes is unassigned.
    expect(result.scanned).toBe(0);
    expect(result.written).toBe(0);
    expect(result.noWitness).toBe(0);
    expect(result.disagreed).toBe(0);

    // Four distinct stored partitions, three of which are not their own repo root.
    expect(result.rekeyed.partitionsScanned).toBe(4);
    expect(result.rekeyed.partitionsMisKeyed).toBe(3);
    expect(result.rekeyed.notes).toBe(3);
    expect(
      result.rekeyed.moves.map((move) => [move.from, move.to, move.notes]).sort()
    ).toEqual(
      [
        [worktreeInA, repoA, 1],
        [trailingSlashA, repoA, 1],
        [symlinkToB, repoB, 1],
      ].sort()
    );

    // A dry run writes NOTHING — not the column, not the anchor.
    expect(await partitionOf(ids.worktree)).toBe(worktreeInA);
    expect(await workspaceAnchorsOf(ids.worktree)).toEqual([worktreeInA]);
  });

  it("APPLY re-keys the column AND the anchor, and drops the stale coordinate", async () => {
    const result = await ledger.backfillMemoryNoteWorkspace({ apply: true });
    expect(result.applied).toBe(true);
    expect(result.rekeyed.notes).toBe(3);

    expect(await partitionOf(ids.worktree)).toBe(repoA);
    expect(await partitionOf(ids.slash)).toBe(repoA);
    expect(await partitionOf(ids.symlink)).toBe(repoB);
    // The control never moved.
    expect(await partitionOf(ids.canonical)).toBe(repoB);

    // The STALE anchor is GONE, not merely joined by a canonical sibling.
    // `kind:"workspace"` is an indexed coordinate; leaving 0041's raw value behind
    // would keep the note reachable through a key it no longer belongs to.
    expect(await workspaceAnchorsOf(ids.worktree)).toEqual([repoA]);
    expect(await workspaceAnchorsOf(ids.slash)).toEqual([repoA]);
    expect(await workspaceAnchorsOf(ids.symlink)).toEqual([repoB]);
    expect(await workspaceAnchorsOf(ids.canonical)).toEqual([repoB]);
  });

  it("AFTER the repair: the notes are visible to exactly the repo that owns them", async () => {
    expect(await libraryIds(repoA)).toEqual([ids.slash, ids.worktree].sort());
    expect(await libraryIds(repoB)).toEqual([ids.canonical, ids.symlink].sort());
  });

  it("is IDEMPOTENT: a second apply finds nothing to move", async () => {
    const again = await ledger.backfillMemoryNoteWorkspace({ apply: true });
    // Two stored partitions remain (repoA, repoB) and both are their own repo root.
    expect(again.rekeyed.partitionsScanned).toBe(2);
    expect(again.rekeyed.partitionsMisKeyed).toBe(0);
    expect(again.rekeyed.notes).toBe(0);
    expect(again.rekeyed.moves).toEqual([]);
    expect(await partitionOf(ids.worktree)).toBe(repoA);
    expect(await workspaceAnchorsOf(ids.worktree)).toEqual([repoA]);
  });

  it("never deletes or retires a note — retire-never-delete holds through the repair", async () => {
    const rows = await db.prisma.memoryNote.findMany({
      where: { id: { in: Object.values(ids) } },
      select: { id: true, status: true, retiredAt: true, supersededBy: true },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.retiredAt).toBeNull();
      expect(row.supersededBy).toBeNull();
    }
  });
});
