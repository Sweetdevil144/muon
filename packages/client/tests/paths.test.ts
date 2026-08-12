import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrainLock,
  isProcessAlive,
  lockfilePath,
  probeBrainHealth,
  readLiveLockfile,
  readLockfile,
  readProbedLiveLockfile,
  removeLockfile,
  writeLockfile,
} from "../src/paths.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-paths-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lock = (pid: number): BrainLock => ({
  port: 5000,
  token: "t",
  pid,
  dbPath: "/x",
  startedAt: "t",
});

describe("lockfile read/write", () => {
  it("round-trips a written lockfile", () => {
    writeLockfile(lock(process.pid), dir);
    expect(readLockfile(dir)).toMatchObject({ port: 5000, pid: process.pid });
  });

  it("returns null for a corrupt lockfile", () => {
    writeFileSync(lockfilePath(dir), "{ not json");
    expect(readLockfile(dir)).toBeNull();
  });
});

describe("liveness (F1)", () => {
  it("readLiveLockfile ignores a dead-pid lockfile but readLockfile still reads it", () => {
    writeLockfile(lock(999999), dir);
    expect(readLockfile(dir)).not.toBeNull();
    expect(readLiveLockfile(dir)).toBeNull();
  });

  it("readLiveLockfile returns a lockfile whose pid is alive", () => {
    writeLockfile(lock(process.pid), dir);
    expect(readLiveLockfile(dir)?.pid).toBe(process.pid);
  });

  it("isProcessAlive is true for self, false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe("health probe + probe-variant lockfile read", () => {
  it("probeBrainHealth is true on an ok response, false on non-ok, false on reject", async () => {
    await expect(
      probeBrainHealth("http://127.0.0.1:5000", {
        fetcher: async () => ({ ok: true }),
      })
    ).resolves.toBe(true);
    await expect(
      probeBrainHealth("http://127.0.0.1:5000", {
        fetcher: async () => ({ ok: false }),
      })
    ).resolves.toBe(false);
    await expect(
      probeBrainHealth("http://127.0.0.1:5000", {
        fetcher: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      })
    ).resolves.toBe(false);
  });

  it("readProbedLiveLockfile: live pid + healthy port returns the lock", async () => {
    writeLockfile(lock(process.pid), dir);
    const fetcher = vi.fn(async () => ({ ok: true }));

    const result = await readProbedLiveLockfile(dir, { fetcher });

    expect(result?.port).toBe(5000);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/health",
      expect.anything()
    );
  });

  it("readProbedLiveLockfile: live pid + DEAD port returns null (the case pid alone misses)", async () => {
    writeLockfile(lock(process.pid), dir);
    // pid is alive (readLiveLockfile would accept it), but the port never answers.
    const result = await readProbedLiveLockfile(dir, {
      fetcher: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5000");
      },
    });
    expect(result).toBeNull();
  });

  it("readProbedLiveLockfile: dead pid returns null without probing", async () => {
    writeLockfile(lock(999999), dir);
    const fetcher = vi.fn(async () => ({ ok: true }));

    const result = await readProbedLiveLockfile(dir, { fetcher });

    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("pid-safe removal (F7)", () => {
  it("won't delete a lockfile owned by a different pid", () => {
    writeLockfile(lock(process.pid + 1), dir);
    removeLockfile(dir, process.pid); // not the owner → leave it
    expect(existsSync(lockfilePath(dir))).toBe(true);
    removeLockfile(dir); // unconditional → gone
    expect(existsSync(lockfilePath(dir))).toBe(false);
  });

  it("removes our own lockfile when the pid matches", () => {
    writeLockfile(lock(process.pid), dir);
    removeLockfile(dir, process.pid);
    expect(existsSync(lockfilePath(dir))).toBe(false);
  });
});
