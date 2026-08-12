import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectWorktreeCollisions,
  ensureTaskWorktree,
  isLinkedWorktree,
  legacyTaskWorktreePath,
  locateTaskWorktreePath,
  managedWorktreesRoot,
  taskWorktreeCandidates,
  resolveRepoRoot,
  taskWorktreePath,
  worktreeChangedFiles,
  worktreeDiff,
  worktreeDiffStat,
} from "../src/worktree.js";

const run = promisify(execFile);
const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;
let worktreeStorage: string;

beforeEach(async () => {
  worktreeStorage = await mkdtemp(join(tmpdir(), "muon-worktree-store-"));
  process.env.MUON_WORKTREE_ROOT = worktreeStorage;
});

afterEach(async () => {
  if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
  else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
  await rm(worktreeStorage, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...args: string[]) {
  await run("git", args, { cwd });
}

describe("worktree isolation", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-test-"));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
    await writeFile(join(repoRoot, "hello.txt"), "hello\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "initial commit");
  });

  afterEach(async () => {
    // Local git tooling can write into .git while we delete; retry and treat
    // leftover temp dirs as harmless rather than failing the suite.
    await rm(repoRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }).catch(() => {});
  });

  it("resolves the repo root from a nested directory", async () => {
    const nested = join(repoRoot, "src", "deep");
    await mkdir(nested, { recursive: true });

    const resolved = await resolveRepoRoot(nested);

    expect(resolved).toBe(await resolveRepoRoot(repoRoot));
  });

  it("creates a detached worktree outside the repository", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-1" });

    expect(worktree.created).toBe(true);
    expect(worktree.path).toBe(join(managedWorktreesRoot(repoRoot), "task-1"));
    expect(worktree.path.startsWith(`${repoRoot}/`)).toBe(false);
    expect(existsSync(join(worktree.path, "hello.txt"))).toBe(true);
    expect(existsSync(join(worktree.path, ".git"))).toBe(true);
  });

  it("distinguishes the primary checkout from a linked task worktree", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-linked",
    });

    expect(await isLinkedWorktree(repoRoot)).toBe(false);
    expect(await isLinkedWorktree(linked.path)).toBe(true);
  });

  it("does not treat a separate-git-dir primary checkout as linked", async () => {
    const separateRoot = await mkdtemp(
      join(tmpdir(), "muon-separate-git-test-")
    );
    const checkout = join(separateRoot, "checkout");
    const gitDir = join(separateRoot, "external.git");

    try {
      await run(
        "git",
        [
          "init",
          "--initial-branch=main",
          "--separate-git-dir",
          gitDir,
          checkout,
        ],
        { cwd: separateRoot }
      );

      expect(await isLinkedWorktree(checkout)).toBe(false);
    } finally {
      await rm(separateRoot, { recursive: true, force: true });
    }
  });

  it("returns false for invalid and non-git paths", async () => {
    const nonGitPath = await mkdtemp(join(tmpdir(), "muon-non-git-test-"));

    try {
      expect(await isLinkedWorktree(nonGitPath)).toBe(false);
      expect(await isLinkedWorktree(join(nonGitPath, "missing"))).toBe(false);
    } finally {
      await rm(nonGitPath, { recursive: true, force: true });
    }
  });

  it("reuses an existing worktree for the same task", async () => {
    const first = await ensureTaskWorktree({ repoRoot, taskId: "task-2" });
    const second = await ensureTaskWorktree({ repoRoot, taskId: "task-2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("sanitizes task ids so they cannot escape the worktree directory", async () => {
    const worktree = await ensureTaskWorktree({
      repoRoot,
      taskId: "../../evil task",
    });

    expect(worktree.path.startsWith(`${repoRoot}/`)).toBe(false);
    expect(worktree.path).not.toContain("..");
  });

  it("reports an empty diff stat for an untouched worktree", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-3" });

    const diffStat = await worktreeDiffStat(worktree.path);

    expect(diffStat).toBe("");
  });

  it("reports modified files in the diff stat", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-4" });
    await writeFile(join(worktree.path, "hello.txt"), "changed by a lane\n");

    const diffStat = await worktreeDiffStat(worktree.path);

    expect(diffStat).toContain("hello.txt");
    expect(diffStat).toContain("1 file changed");
  });

  it("reports newly created files in the diff stat without tracking them", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-5" });
    await writeFile(
      join(worktree.path, "brand-new.ts"),
      "export const fresh = true;\n"
    );

    const diffStat = await worktreeDiffStat(worktree.path);

    expect(diffStat).toContain("brand-new.ts");
    expect(diffStat).toContain("1 file changed");

    // The summary must not mutate the worktree: the file stays untracked.
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: worktree.path,
    });
    expect(stdout).toContain("?? brand-new.ts");
  });

  it("reports modified and newly created files together", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-6" });
    await writeFile(join(worktree.path, "hello.txt"), "changed\n");
    await writeFile(join(worktree.path, "added.txt"), "new file\n");

    const diffStat = await worktreeDiffStat(worktree.path);

    expect(diffStat).toContain("hello.txt");
    expect(diffStat).toContain("added.txt");
    expect(diffStat).toContain("2 files changed");
  });

  it("captures tracked modifications and untracked new files", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-diff",
    });
    await writeFile(join(linked.path, "hello.txt"), "changed\n");
    await writeFile(join(linked.path, "new.ts"), "export const x = 1;\n");

    const result = await worktreeDiff(linked.path, { maxBytes: 64_000 });

    expect(result.truncated).toBe(false);
    expect(result.text).toContain("hello.txt");
    expect(result.text).toContain("new.ts");
    expect(result.totalBytes).toBe(Buffer.byteLength(result.text, "utf8"));
  });

  it("fully rolls back intent-to-add state after capturing a diff", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-rollback",
    });
    await writeFile(join(linked.path, "brand-new.ts"), "export const x = 1;\n");

    await worktreeDiff(linked.path, { maxBytes: 64_000 });

    const [{ stdout: status }, { stdout: staged }] = await Promise.all([
      run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: linked.path,
      }),
      run("git", ["diff", "--cached", "--name-only"], {
        cwd: linked.path,
      }),
    ]);
    expect(status).toBe("?? brand-new.ts\n");
    expect(staged).toBe("");
  });

  it("preserves the exact staged index while rolling back untracked intent-to-add", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-index",
    });
    await writeFile(join(linked.path, "hello.txt"), "staged change\n");
    await git(linked.path, "add", "hello.txt");
    await writeFile(join(linked.path, "brand-new.ts"), "export const x = 1;\n");
    const { stdout: beforeTree } = await run("git", ["write-tree"], {
      cwd: linked.path,
    });

    await worktreeDiff(linked.path, { maxBytes: 64_000 });

    const [{ stdout: afterTree }, { stdout: status }] = await Promise.all([
      run("git", ["write-tree"], { cwd: linked.path }),
      run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: linked.path,
      }),
    ]);
    expect(afterTree).toBe(beforeTree);
    expect(status).toContain("M  hello.txt");
    expect(status).toContain("?? brand-new.ts");
  });

  it("does not execute configured textconv helpers and rolls back intent-to-add", async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), "muon-textconv-test-"));
    const markerPath = join(toolRoot, "textconv-ran");
    const scriptPath = join(toolRoot, "textconv.sh");

    try {
      await writeFile(
        scriptPath,
        '#!/bin/sh\n: > "$1"\ncat "$2"\n'
      );
      await chmod(scriptPath, 0o755);
      await writeFile(
        join(repoRoot, ".gitattributes"),
        "hello.txt diff=marker\n"
      );
      await git(repoRoot, "add", ".gitattributes");
      await git(repoRoot, "commit", "-m", "add marker diff driver");
      const linked = await ensureTaskWorktree({
        repoRoot,
        taskId: "eval-no-textconv",
      });
      await git(
        linked.path,
        "config",
        "diff.marker.textconv",
        `${scriptPath} ${markerPath}`
      );
      await writeFile(join(linked.path, "hello.txt"), "changed\n");
      await writeFile(
        join(linked.path, "brand-new.ts"),
        "export const x = 1;\n"
      );

      const result = await worktreeDiff(linked.path, { maxBytes: 64_000 });

      const [{ stdout: status }, { stdout: staged }] = await Promise.all([
        run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: linked.path,
        }),
        run("git", ["diff", "--cached", "--name-only"], {
          cwd: linked.path,
        }),
      ]);
      expect(result.text).toContain("hello.txt");
      expect(result.text).toContain("brand-new.ts");
      expect(status).toContain("?? brand-new.ts");
      expect(staged).toBe("");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it("enforces maxBytes by UTF-8 byte length and reports total bytes", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-cap",
    });
    await writeFile(join(linked.path, "hello.txt"), `${"é".repeat(4_000)}\n`);

    const full = await worktreeDiff(linked.path, { maxBytes: 64_000 });
    const firstMultibyteCharacter = full.text.indexOf("é");
    expect(firstMultibyteCharacter).toBeGreaterThanOrEqual(0);
    const maxBytes =
      Buffer.byteLength(
        full.text.slice(0, firstMultibyteCharacter),
        "utf8"
      ) + 1;

    const result = await worktreeDiff(linked.path, { maxBytes });

    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(Buffer.byteLength(full.text, "utf8"));
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(full.text.startsWith(result.text)).toBe(true);
  });

  it("streams diffs larger than execFile's default maxBuffer", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-large-diff",
    });
    await writeFile(
      join(linked.path, "hello.txt"),
      `${"x".repeat(1_200_000)}\n`
    );

    const result = await worktreeDiff(linked.path, { maxBytes: 512 });

    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBeGreaterThan(1_048_576);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
    expect(result.text).toContain("diff --git");
  });

  it("feeds the full diff byte stream to onChunk even when retention is capped", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-onchunk",
    });
    await writeFile(
      join(linked.path, "hello.txt"),
      `${"x".repeat(1_200_000)}\n`
    );

    let streamedBytes = 0;
    const result = await worktreeDiff(linked.path, {
      maxBytes: 64,
      onChunk: (chunk) => {
        streamedBytes += chunk.length;
      },
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64);
    expect(streamedBytes).toBe(result.totalBytes);
    expect(streamedBytes).toBeGreaterThan(1_048_576);
  });

  it("rejects once and tears down immediately on stdout stream errors", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill,
    });
    const spawnMock = vi.fn(() => fakeChild);
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });

    try {
      const isolated = await import("../src/worktree.js");
      await writeFile(join(repoRoot, "brand-new.ts"), "export const x = 1;\n");
      let settlementCount = 0;
      const observed = isolated
        .worktreeDiff(repoRoot, { maxBytes: 128 })
        .then(
          (value) => {
            settlementCount += 1;
            return { kind: "resolved" as const, value };
          },
          (error: unknown) => {
            settlementCount += 1;
            return { kind: "rejected" as const, error };
          }
        );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      stdout.emit("error", new Error("stdout exploded"));

      let timeout: NodeJS.Timeout | undefined;
      const immediate = await Promise.race([
        observed,
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timeout" }), 500);
        }),
      ]);
      if (timeout) {
        clearTimeout(timeout);
      }
      const teardown = {
        closeListeners: fakeChild.listenerCount("close"),
        stdoutDataListeners: stdout.listenerCount("data"),
        stderrDataListeners: stderr.listenerCount("data"),
        stdoutDestroyed: stdout.destroyed,
        stderrDestroyed: stderr.destroyed,
      };

      fakeChild.emit("close", 0, null);
      stdout.emit("data", Buffer.from("late stdout"));
      stderr.emit("data", Buffer.from("late stderr"));
      const finalOutcome = await observed;

      expect(immediate.kind).toBe("rejected");
      expect(finalOutcome.kind).toBe("rejected");
      if (finalOutcome.kind === "rejected") {
        expect(finalOutcome.error).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("stdout exploded"),
          })
        );
      }
      expect(settlementCount).toBe(1);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(teardown).toEqual({
        closeListeners: 0,
        stdoutDataListeners: 0,
        stderrDataListeners: 0,
        stdoutDestroyed: true,
        stderrDestroyed: true,
      });

      const [{ stdout: status }, { stdout: staged }] = await Promise.all([
        run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: repoRoot,
        }),
        run("git", ["diff", "--cached", "--name-only"], {
          cwd: repoRoot,
        }),
      ]);
      expect(status).toBe("?? brand-new.ts\n");
      expect(staged).toBe("");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("returns an empty diff for an untouched worktree", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-empty",
    });

    const result = await worktreeDiff(linked.path, { maxBytes: 128 });

    expect(result).toEqual({
      text: "",
      truncated: false,
      totalBytes: 0,
    });
  });

  it("rejects maxBytes values that are not positive integers", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "eval-invalid-cap",
    });

    for (const maxBytes of [0, -1, 1.5]) {
      await expect(worktreeDiff(linked.path, { maxBytes })).rejects.toThrow(
        "maxBytes must be a positive integer"
      );
    }
  });

  it("lists changed files including untracked ones", async () => {
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: "task-7" });
    await writeFile(join(worktree.path, "hello.txt"), "changed\n");
    await writeFile(join(worktree.path, "fresh.ts"), "new\n");

    const files = await worktreeChangedFiles(worktree.path);

    expect(files).toEqual(["fresh.ts", "hello.txt"]);
  });

  it("warns when two task worktrees claim the same file", async () => {
    const first = await ensureTaskWorktree({ repoRoot, taskId: "task-a" });
    const second = await ensureTaskWorktree({ repoRoot, taskId: "task-b" });
    await writeFile(join(first.path, "hello.txt"), "task-a edit\n");
    await writeFile(join(second.path, "hello.txt"), "task-b edit\n");

    const collisions = await detectWorktreeCollisions({
      repoRoot,
      taskId: "task-a",
    });

    expect(collisions).toEqual([{ taskId: "task-b", files: ["hello.txt"] }]);
  });

  it("detects overlap across the external and legacy stores during upgrade", async () => {
    const current = await ensureTaskWorktree({ repoRoot, taskId: "task-current" });
    const legacy = legacyTaskWorktreePath(repoRoot, "task-legacy");
    await mkdir(join(repoRoot, ".muon", "worktrees"), { recursive: true });
    await git(repoRoot, "worktree", "add", "--detach", legacy);
    await writeFile(join(current.path, "hello.txt"), "current edit\n");
    await writeFile(join(legacy, "hello.txt"), "legacy edit\n");

    expect(
      await detectWorktreeCollisions({ repoRoot, taskId: "task-current" })
    ).toEqual([{ taskId: "task-legacy", files: ["hello.txt"] }]);
  });

  it("merges overlap files when the same sibling id exists in both stores", async () => {
    await writeFile(join(repoRoot, "other.txt"), "other\n");
    await git(repoRoot, "add", "other.txt");
    await git(repoRoot, "commit", "-m", "add second collision target");
    const own = await ensureTaskWorktree({ repoRoot, taskId: "task-own" });
    const current = await ensureTaskWorktree({ repoRoot, taskId: "task-dup" });
    const legacy = legacyTaskWorktreePath(repoRoot, "task-dup");
    await mkdir(join(repoRoot, ".muon", "worktrees"), { recursive: true });
    await git(repoRoot, "worktree", "add", "--detach", legacy);
    await writeFile(join(own.path, "hello.txt"), "own hello\n");
    await writeFile(join(own.path, "other.txt"), "own other\n");
    await writeFile(join(current.path, "hello.txt"), "current hello\n");
    await writeFile(join(legacy, "other.txt"), "legacy other\n");

    expect(
      await detectWorktreeCollisions({ repoRoot, taskId: "task-own" })
    ).toEqual([
      { taskId: "task-dup", files: ["hello.txt", "other.txt"] },
    ]);
  });

  it("reports no collisions for disjoint file claims", async () => {
    const first = await ensureTaskWorktree({ repoRoot, taskId: "task-c" });
    const second = await ensureTaskWorktree({ repoRoot, taskId: "task-d" });
    await writeFile(join(first.path, "hello.txt"), "task-c edit\n");
    await writeFile(join(second.path, "other.txt"), "task-d new file\n");

    const collisions = await detectWorktreeCollisions({
      repoRoot,
      taskId: "task-c",
    });

    expect(collisions).toEqual([]);
  });

  it("returns no collisions when there are no sibling worktrees", async () => {
    const only = await ensureTaskWorktree({ repoRoot, taskId: "task-solo" });
    await writeFile(join(only.path, "hello.txt"), "solo edit\n");

    const collisions = await detectWorktreeCollisions({
      repoRoot,
      taskId: "task-solo",
    });

    expect(collisions).toEqual([]);
  });
});

// ── P0.1 checkpoint+resume (Slice C3): pure worktree path computation ─────────
//
// Resume verification must LOCATE a task worktree without ever creating one
// (read-only re-hash of packet diff evidence). The path math is the exact
// computation ensureTaskWorktree uses, promoted to a pure export.
describe("taskWorktreePath", () => {
  it("computes the governed worktree path without touching the filesystem", () => {
    const path = taskWorktreePath("/repo", "task-1");
    expect(path).toBe(join(managedWorktreesRoot("/repo"), "task-1"));
    expect(path.startsWith("/repo/")).toBe(false);
    expect(existsSync(path)).toBe(false); // pure computation, nothing created
  });

  it("sanitizes hostile task ids exactly like ensureTaskWorktree", () => {
    expect(taskWorktreePath("/repo", "a/b\\c d")).toBe(
      join(managedWorktreesRoot("/repo"), "a-b-c-d")
    );
    expect(() => taskWorktreePath("/repo", "../..")).toThrow(/worktree name/);
  });

  it("default storage is outside the data dir AND contains no space", () => {
    // Two constraints, both learned from real failures:
    //  1. The sandboxed runner is Seatbelt-blinded to the entire data-dir
    //     subpath, so a root under it is one the tree-CREATING runner cannot
    //     touch.
    //  2. NO SPACES. Both previous defaults sat under `~/Library/Application
    //     Support/…`; ordinary repo tooling mishandles a space in an absolute
    //     path (MUON's own vitest alias used `URL.pathname`, which
    //     percent-encodes), so a governed run failed its whole suite for a
    //     reason the agent did not cause. MUON picks where work happens, so
    //     MUON must not pick a path that breaks it.
    delete process.env.MUON_WORKTREE_ROOT;
    const previousDataDir = process.env.MUON_DATA_DIR;
    process.env.MUON_DATA_DIR = join(worktreeStorage, "Application Support", "profile");
    try {
      const root = managedWorktreesRoot("/repo");
      // Not inside the (space-bearing) data dir…
      expect(root.startsWith(process.env.MUON_DATA_DIR!)).toBe(false);
      // …and MUON contributed no space of its own. Only the home directory,
      // which MUON does not choose, could introduce one.
      expect(root.slice(homedir().length).includes(" ")).toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.MUON_DATA_DIR;
      else process.env.MUON_DATA_DIR = previousDataDir;
      process.env.MUON_WORKTREE_ROOT = worktreeStorage;
    }
  });

  it("keeps an earlier layout's tree locatable so an upgrade strands nothing", async () => {
    // A tree created by a previous MUON (sibling-of-data-dir layout) must
    // still be found, reviewed and landed after the default moves.
    delete process.env.MUON_WORKTREE_ROOT;
    const previousDataDir = process.env.MUON_DATA_DIR;
    const dataDir = join(worktreeStorage, "profile-data");
    process.env.MUON_DATA_DIR = dataDir;
    try {
      const candidates = taskWorktreeCandidates("/repo", "task-1");
      // Current root first…
      expect(candidates[0]).toBe(join(managedWorktreesRoot("/repo"), "task-1"));
      // …then the 2026-08-04 sibling root, then the pre-5.14 nested one.
      expect(
        candidates.some((c) => c.includes("profile-data-worktrees"))
      ).toBe(true);
      expect(candidates[candidates.length - 1]).toBe(
        join("/repo", ".muon", "worktrees", "task-1")
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.MUON_DATA_DIR;
      else process.env.MUON_DATA_DIR = previousDataDir;
      process.env.MUON_WORKTREE_ROOT = worktreeStorage;
    }
  });

  it("refuses an override that would put new worktrees back inside the repo", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-bad-root-"));
    process.env.MUON_WORKTREE_ROOT = join(repoRoot, ".muon", "worktrees");
    try {
      expect(() => taskWorktreePath(repoRoot, "task-1")).toThrow(
        /outside the repository/i
      );
    } finally {
      process.env.MUON_WORKTREE_ROOT = worktreeStorage;
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses an override inside the Seatbelt-denied data dir", async () => {
    // Constraint 2: the sandboxed runner is blinded to the whole data dir, so
    // an override under it names a root the tree-CREATING process cannot read
    // — every governed dispatch would fail deep inside `git worktree add`
    // with a permissions error the operator never connects to this env var.
    const previousDataDir = process.env.MUON_DATA_DIR;
    const dataDir = join(worktreeStorage, "denied-profile");
    await mkdir(dataDir, { recursive: true });
    process.env.MUON_DATA_DIR = dataDir;
    process.env.MUON_WORKTREE_ROOT = join(dataDir, "worktrees");
    try {
      expect(() => taskWorktreePath("/repo", "task-1")).toThrow(
        /outside the data dir/i
      );
      expect(() => taskWorktreeCandidates("/repo", "task-1")).toThrow(
        /outside the data dir/i
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.MUON_DATA_DIR;
      else process.env.MUON_DATA_DIR = previousDataDir;
      process.env.MUON_WORKTREE_ROOT = worktreeStorage;
    }
  });

  it("refuses a symlinked override that resolves back inside the repo", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-link-root-"));
    const alias = join(worktreeStorage, "inside-alias");
    await mkdir(join(repoRoot, ".hidden-store"), { recursive: true });
    await symlink(join(repoRoot, ".hidden-store"), alias, "dir");
    process.env.MUON_WORKTREE_ROOT = alias;
    try {
      expect(() => taskWorktreePath(repoRoot, "task-1")).toThrow(
        /outside the repository/i
      );
    } finally {
      process.env.MUON_WORKTREE_ROOT = worktreeStorage;
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("ensureTaskWorktree creates at exactly the computed path (behavior identical)", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-path-"));
    try {
      await git(repoRoot, "init", "--initial-branch=main");
      await git(repoRoot, "config", "user.email", "test@example.com");
      await git(repoRoot, "config", "user.name", "Muon Test");
      await writeFile(join(repoRoot, "hello.txt"), "hello\n");
      await git(repoRoot, "add", ".");
      await git(repoRoot, "commit", "-m", "initial commit");
      const created = await ensureTaskWorktree({ repoRoot, taskId: "task-x" });
      expect(created.path).toBe(taskWorktreePath(repoRoot, "task-x"));
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("locates a legacy nested tree without using it for new tasks", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-legacy-"));
    try {
      await git(repoRoot, "init", "--initial-branch=main");
      await git(repoRoot, "config", "user.email", "test@example.com");
      await git(repoRoot, "config", "user.name", "Muon Test");
      await writeFile(join(repoRoot, "hello.txt"), "hello\n");
      await git(repoRoot, "add", ".");
      await git(repoRoot, "commit", "-m", "initial commit");
      const legacy = legacyTaskWorktreePath(repoRoot, "legacy-task");
      await mkdir(join(repoRoot, ".muon", "worktrees"), { recursive: true });
      await git(repoRoot, "worktree", "add", "--detach", legacy);

      expect(locateTaskWorktreePath(repoRoot, "legacy-task")).toBe(legacy);
      expect(taskWorktreePath(repoRoot, "new-task").startsWith(`${repoRoot}/`)).toBe(
        false
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not reuse a legacy tree owned by a different repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "muon-worktree-owner-"));
    const otherRoot = await mkdtemp(join(tmpdir(), "muon-worktree-impostor-"));
    try {
      for (const root of [repoRoot, otherRoot]) {
        await git(root, "init", "--initial-branch=main");
        await git(root, "config", "user.email", "test@example.com");
        await git(root, "config", "user.name", "Muon Test");
        await writeFile(join(root, "hello.txt"), `${root}\n`);
        await git(root, "add", ".");
        await git(root, "commit", "-m", "initial commit");
      }
      const impostor = legacyTaskWorktreePath(repoRoot, "legacy-task");
      await mkdir(join(repoRoot, ".muon", "worktrees"), { recursive: true });
      await git(otherRoot, "worktree", "add", "--detach", impostor);

      expect(locateTaskWorktreePath(repoRoot, "legacy-task")).toBe(
        taskWorktreePath(repoRoot, "legacy-task")
      );
      const created = await ensureTaskWorktree({
        repoRoot,
        taskId: "legacy-task",
      });
      expect(created.created).toBe(true);
      expect(created.path).not.toBe(impostor);
    } finally {
      await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(otherRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
