import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-0071/0084 — the crash-window GC (D34's named "GC sweep candidate").
 *
 * The whole risk of this sweep is deleting the WRONG thing, so what is
 * pinned is the keep-set: the age gate (an in-flight capture is never
 * raced), the SANITIZED-name membership (`sanitizeTaskId` is not
 * invertible, so raw-id equality would fail open and delete a live task's
 * recorded state), and the skip of anything capture did not write. The
 * happy path — an aged, unreferenced stash disappears — is one pin among
 * them, not the point.
 */

const dbMock = vi.hoisted(() => ({
  prisma: {
    task: { findMany: vi.fn(async () => [] as Array<{ id: string }>) },
  },
}));
vi.mock("../src/lib/db.js", () => dbMock);

import { sweepOrphanedForkSeeds } from "../src/lib/fork-seed-gc.js";
import { forkSeedsRoot } from "@muon/core";

const HOUR = 60 * 60_000;
const previousDataDir = process.env.MUON_DATA_DIR;
const mintedDirs: string[] = [];
let dataDir: string;

function seedDir(name: string, ageMs: number): string {
  const dir = join(forkSeedsRoot(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "{}");
  const past = new Date(Date.now() - ageMs);
  // meta.json's mtime is the judged signal (capture writes it LAST); the
  // dir's own mtime rides along for realism.
  utimesSync(join(dir, "meta.json"), past, past);
  utimesSync(dir, past, past);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), "muon-fork-gc-"));
  mintedDirs.push(dataDir);
  process.env.MUON_DATA_DIR = dataDir;
  dbMock.prisma.task.findMany.mockResolvedValue([]);
});

afterAll(() => {
  // The suite restores the env it borrowed (D56's rule).
  if (previousDataDir === undefined) {
    delete process.env.MUON_DATA_DIR;
  } else {
    process.env.MUON_DATA_DIR = previousDataDir;
  }
  for (const dir of mintedDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sweepOrphanedForkSeeds", () => {
  it("a missing root is a stated empty result — most installs never forked", async () => {
    const result = await sweepOrphanedForkSeeds();
    expect(result).toEqual({ swept: [], kept: 0, skipped: 0 });
    // And the DB was never consulted: no candidates, no read.
    expect(dbMock.prisma.task.findMany).not.toHaveBeenCalled();
  });

  it("an aged stash NO task references is swept from disk", async () => {
    const orphan = seedDir("task-orphan", 25 * HOUR);
    const result = await sweepOrphanedForkSeeds();
    expect(result.swept).toEqual(["task-orphan"]);
    expect(existsSync(orphan)).toBe(false);
  });

  it("the age gate: a FRESH orphan is kept — an in-flight mint is never raced", async () => {
    const fresh = seedDir("task-inflight", 0);
    const result = await sweepOrphanedForkSeeds();
    expect(result).toEqual({ swept: [], kept: 1, skipped: 0 });
    expect(existsSync(fresh)).toBe(true);
    // No candidate aged out, so the task table was not even read.
    expect(dbMock.prisma.task.findMany).not.toHaveBeenCalled();
  });

  it("a referenced stash is kept — matched by SANITIZED name, never raw-id equality", async () => {
    // The live task's raw id differs from its directory name: sanitize maps
    // `a/b` → `a-b`. A raw-id membership test would read this stash as
    // orphaned and delete a live task's recorded state — the fail-open this
    // pin exists to make impossible.
    const referenced = seedDir("weird-id", 25 * HOUR);
    const orphan = seedDir("task-orphan", 25 * HOUR);
    dbMock.prisma.task.findMany.mockResolvedValue([{ id: "weird/id" }]);
    const result = await sweepOrphanedForkSeeds();
    expect(result.swept).toEqual(["task-orphan"]);
    expect(result.kept).toBe(1);
    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("a non-directory entry is skipped, never deleted — capture did not write it", async () => {
    mkdirSync(forkSeedsRoot(), { recursive: true });
    const stray = join(forkSeedsRoot(), "stray-file");
    writeFileSync(stray, "not a stash");
    const past = new Date(Date.now() - 25 * HOUR);
    utimesSync(stray, past, past);
    const result = await sweepOrphanedForkSeeds();
    expect(result).toEqual({ swept: [], kept: 0, skipped: 1 });
    expect(existsSync(stray)).toBe(true);
  });

  it("a meta-absent stash with ONE fresh deep write is in-flight — kept, however old its root looks", async () => {
    // Capture writes meta.json LAST, so a stash without it is mid-write or
    // a crash half. Deep writes never bump the root dir's mtime; the sweep
    // must judge by the NEWEST write anywhere in the subtree, or a long
    // capture could be deleted out from under the mint.
    const dir = join(forkSeedsRoot(), "task-midflight");
    mkdirSync(join(dir, "untracked", "deep"), { recursive: true });
    const past = new Date(Date.now() - 25 * HOUR);
    utimesSync(dir, past, past);
    writeFileSync(join(dir, "untracked", "deep", "file.txt"), "fresh write");
    const result = await sweepOrphanedForkSeeds();
    expect(result).toEqual({ swept: [], kept: 1, skipped: 0 });
    expect(existsSync(dir)).toBe(true);

    // And the crash HALF — every write old — is swept: exactly the
    // capture-crashed-before-meta artifact D34 names.
    const oldPast = new Date(Date.now() - 25 * HOUR);
    utimesSync(join(dir, "untracked", "deep", "file.txt"), oldPast, oldPast);
    utimesSync(join(dir, "untracked", "deep"), oldPast, oldPast);
    utimesSync(join(dir, "untracked"), oldPast, oldPast);
    const second = await sweepOrphanedForkSeeds();
    expect(second.swept).toEqual(["task-midflight"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("a custom minAge widens the keep-set, never the sweep-set", async () => {
    const halfAged = seedDir("task-halfway", 25 * HOUR);
    const result = await sweepOrphanedForkSeeds(48 * HOUR);
    expect(result).toEqual({ swept: [], kept: 1, skipped: 0 });
    expect(existsSync(halfAged)).toBe(true);
  });
});
