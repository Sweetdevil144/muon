import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GITNEXUS_INDEX_LOCK_FILE,
  GITNEXUS_STORE_DIR,
  acquireGitNexusIndexLock,
  gitnexusIndexLockPath,
  readGitNexusIndexLock,
  type GitNexusIndexLockAttempt,
} from "../src/gitnexus-index-lock.js";

// Two MUON processes must never index one store at once. The forced rebuild
// path deletes the store's DB files, so a lost race is a destroyed graph.

let repo: string;
const aliases: string[] = [];

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "muon-gnx-lock-"));
});
afterEach(() => {
  for (const alias of aliases.splice(0)) rmSync(alias, { force: true });
  rmSync(repo, { recursive: true, force: true });
});

const acquire = (owner: "desktop" | "mcp" = "desktop", pid?: number) =>
  acquireGitNexusIndexLock(repo, { owner, ...(pid ? { pid } : {}) });

/** A pid that is certainly not running: spawn a true(1) and wait for it. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = done.pid!;
  expect(pid).toBeGreaterThan(0);
  return pid;
}

/** Publish a lock record by hand (as a crashed/foreign holder would leave it). */
function plantLock(record: Record<string, unknown>): string {
  const lockPath = gitnexusIndexLockPath(repo);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(record));
  return lockPath;
}

describe("two MUON processes must never index one store at once", () => {
  it("the first acquire wins and the second is REFUSED, not thrown at", () => {
    const first = acquire("desktop");
    expect(first.acquired).toBe(true);

    const second = acquire("mcp");
    // A value, not an exception: both callers route on it (the operator sees a
    // refusal, the MCP freshness path degrades) and neither may hang.
    expect(second).toMatchObject({ acquired: false, reason: "held" });
    expect(second.acquired === false && second.holder?.owner).toBe("desktop");
    expect(second.acquired === false && second.note).toMatch(/already/i);

    if (first.acquired) first.lock.release();
    expect(acquire("mcp").acquired).toBe(true);
  });

  it("never lets two acquirers both believe they hold it, over many rounds", () => {
    for (let round = 0; round < 50; round++) {
      const attempts: GitNexusIndexLockAttempt[] = [
        acquire("desktop"),
        acquire("mcp"),
        acquire("desktop"),
      ];
      expect(attempts.filter((a) => a.acquired)).toHaveLength(1);
      for (const attempt of attempts) {
        if (attempt.acquired) attempt.lock.release();
      }
    }
  });

  it("acquiring creates ONLY the lock file — it never touches store data", () => {
    const store = path.join(repo, GITNEXUS_STORE_DIR);
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, "lbug"), "GRAPH-BYTES");
    writeFileSync(path.join(store, "meta.json"), '{"stats":{"nodes":42}}');

    const held = acquire();
    expect(held.acquired).toBe(true);
    expect(readFileSync(path.join(store, "lbug"), "utf8")).toBe("GRAPH-BYTES");
    expect(readFileSync(path.join(store, "meta.json"), "utf8")).toContain("42");
    if (held.acquired) held.lock.release();
    // Release removes the lock and nothing else.
    expect(existsSync(path.join(store, "lbug"))).toBe(true);
    expect(existsSync(gitnexusIndexLockPath(repo))).toBe(false);
  });

  it("names the lock so the CLI's own forced rebuild cannot delete it", () => {
    // `analyze --force` rm's `lbug`, `lbug.wal` and `lbug.lock` before it
    // rebuilds. A lock living at any of those names would evaporate mid-run.
    expect(GITNEXUS_INDEX_LOCK_FILE).not.toMatch(/^lbug/);
    expect(gitnexusIndexLockPath(repo)).toBe(
      path.join(
        realpathSync(repo),
        GITNEXUS_STORE_DIR,
        GITNEXUS_INDEX_LOCK_FILE
      )
    );
  });

  it("says UNAVAILABLE, not 'held', when the store dir cannot be written", () => {
    // Reporting contention here would tell the operator to wait for an index
    // run that does not exist. Only EEXIST means "someone else holds it".
    const store = path.join(repo, GITNEXUS_STORE_DIR);
    mkdirSync(store, { recursive: true });
    chmodSync(store, 0o500);
    try {
      expect(acquire()).toMatchObject({
        acquired: false,
        reason: "unavailable",
      });
    } finally {
      chmodSync(store, 0o700);
    }
  });

  it("canonicalizes the store path, so two spellings are ONE lock", () => {
    // macOS hands `/tmp` out as `/private/tmp`; the desktop and the MCP server
    // arrive with different spellings of the same repo. Two spellings would be
    // two lock files and no exclusion at all.
    const viaSymlink = `${repo}-alias`;
    symlinkSync(repo, viaSymlink, "dir");
    aliases.push(viaSymlink);
    expect(gitnexusIndexLockPath(viaSymlink)).toBe(gitnexusIndexLockPath(repo));

    const held = acquireGitNexusIndexLock(repo, { owner: "desktop" });
    expect(held.acquired).toBe(true);
    expect(
      acquireGitNexusIndexLock(viaSymlink, { owner: "mcp" })
    ).toMatchObject({ acquired: false, reason: "held" });
    if (held.acquired) held.lock.release();
  });
});

describe("stale-lock recovery", () => {
  it("reclaims a lock whose holder pid is DEAD", () => {
    plantLock({
      pid: deadPid(),
      startedAt: new Date().toISOString(),
      owner: "desktop",
      target: repo,
      nonce: "dead-holder",
    });
    const attempt = acquire("mcp");
    expect(attempt.acquired).toBe(true);
    expect(readGitNexusIndexLock(repo)?.owner).toBe("mcp");
  });

  it("RESPECTS a lock whose holder pid is alive", () => {
    plantLock({
      pid: process.pid, // this very test process
      startedAt: new Date().toISOString(),
      owner: "desktop",
      target: repo,
      nonce: "live-holder",
    });
    expect(acquire("mcp")).toMatchObject({ acquired: false, reason: "held" });
  });

  it("a dead holder whose DETACHED analyze child still runs is still held", async () => {
    // The desktop's analyze child outlives a killed supervisor. Freeing the
    // lock on the holder's death alone would hand a second process a store
    // that is being written right now.
    const sleeper = startSleeper();
    try {
      plantLock({
        pid: deadPid(),
        childPid: sleeper.pid,
        startedAt: new Date().toISOString(),
        owner: "desktop",
        target: repo,
        nonce: "dead-holder-live-child",
      });
      expect(acquire("mcp")).toMatchObject({ acquired: false, reason: "held" });
    } finally {
      sleeper.kill();
    }
    // Once the child is gone too, the lock is free.
    await sleeper.waitForExit();
    expect(acquire("mcp").acquired).toBe(true);
  });

  it("respects an unreadable lock until it is impossibly old, then reclaims", () => {
    const lockPath = gitnexusIndexLockPath(repo);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, ""); // a torn file: no pid to judge
    expect(
      acquireGitNexusIndexLock(repo, { owner: "mcp" })
    ).toMatchObject({ acquired: false, reason: "held" });
    // Same file, judged from far enough in the future: reclaimed, not wedged.
    const later = Date.now() + 31 * 60_000;
    expect(
      acquireGitNexusIndexLock(repo, { owner: "mcp", now: () => later })
    ).toMatchObject({ acquired: true });
  });
});

describe("release", () => {
  it("is idempotent and never removes a successor's lock", () => {
    const first = acquire("desktop");
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    first.lock.release();
    first.lock.release(); // idempotent

    const second = acquire("mcp");
    expect(second.acquired).toBe(true);
    first.lock.release(); // the stale handle must not evict the new holder
    expect(readGitNexusIndexLock(repo)?.owner).toBe("mcp");
  });

  it("records the analyze child so a killed holder does not free the store", () => {
    const held = acquire("desktop");
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    held.lock.adoptChild(4242);
    expect(readGitNexusIndexLock(repo)?.childPid).toBe(4242);
    held.lock.release();
    expect(readGitNexusIndexLock(repo)).toBeNull();
  });
});

/** A real, live child process to stand in for a running `analyze`. */
function startSleeper(): {
  pid: number;
  kill: () => void;
  waitForExit: () => Promise<void>;
} {
  const child = execFileSync(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const c = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
         detached: true, stdio: "ignore",
       });
       c.unref();
       process.stdout.write(String(c.pid));`,
    ],
    { encoding: "utf8" }
  );
  const pid = Number(child.trim());
  expect(Number.isInteger(pid)).toBe(true);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pid,
    kill: () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
    // SIGKILL is delivered asynchronously; the pid stays visible for a beat.
    waitForExit: async () => {
      const deadline = Date.now() + 5_000;
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(alive()).toBe(false);
    },
  };
}
