import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyForkSeed,
  captureForkSeed,
  copyForkSeed,
  discardForkSeed,
  forkSeedDir,
  hasForkSeed,
} from "../src/fork-seed.js";
import { locateTaskWorktreePath } from "../src/worktree.js";

// ── ADR-0044/0071 D5 — capture at the GESTURE, apply at the CLAIM ────────────
//
// Real git, no mocks. What these pin (each a review finding):
//   • the recorded state is PINNED at capture: mutating the source worktree
//     AFTER the fork gesture changes nothing about what the fork receives;
//   • the fork detaches at the SOURCE's captured base commit, not today's
//     HEAD — a mainline that moved cannot shift the state under the diff;
//   • tracked modifications AND untracked files both travel;
//   • a vanished source refuses CAPTURE; a vanished stash refuses APPLY —
//     fail-closed at both halves, never a silent start-from-HEAD.

const scratch = mkdtempSync(join(tmpdir(), "muon-fork-seed-"));
const repoRoot = join(scratch, "repo");
const SOURCE_TASK = "task-fork-source";
const FORK_TASK = "task-fork-target";
let previousWorktreeRoot: string | undefined;
let previousDataDir: string | undefined;
let baseCommit = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(() => {
  previousWorktreeRoot = process.env.MUON_WORKTREE_ROOT;
  previousDataDir = process.env.MUON_DATA_DIR;
  // Two SEPARATE roots: the worktree-root override refuses to live inside
  // the data dir (assertOverrideOutsideDataDir).
  process.env.MUON_WORKTREE_ROOT = join(scratch, "worktrees");
  process.env.MUON_DATA_DIR = join(scratch, "data");

  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "--initial-branch=main");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "Test");
  writeFileSync(join(repoRoot, "a.txt"), "base content\n");
  git(repoRoot, "add", "a.txt");
  git(repoRoot, "commit", "-m", "commit A (the step's base)");
  baseCommit = git(repoRoot, "rev-parse", "HEAD").trim();

  // The SOURCE task worktree, detached at A, with the recorded state.
  const sourcePath = locateTaskWorktreePath(repoRoot, SOURCE_TASK);
  mkdirSync(dirname(sourcePath), { recursive: true });
  git(repoRoot, "worktree", "add", "--detach", sourcePath);
  writeFileSync(join(sourcePath, "a.txt"), "the step's edit\n");
  mkdirSync(join(sourcePath, "docs"), { recursive: true });
  writeFileSync(join(sourcePath, "docs", "new.md"), "untracked note\n");
  // An untracked symlink pointing OUTSIDE the repository — the capture must
  // carry the LINK verbatim, never the target's dereferenced content.
  writeFileSync(join(scratch, "secret.txt"), "host content the fork must not copy\n");
  symlinkSync(join(scratch, "secret.txt"), join(sourcePath, "link-out"));
});

afterAll(() => {
  for (const [key, value] of [
    ["MUON_WORKTREE_ROOT", previousWorktreeRoot],
    ["MUON_DATA_DIR", previousDataDir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("captureForkSeed → applyForkSeed", () => {
  it("pins the gesture-time state: later source mutations and a moved mainline change nothing", async () => {
    const captured = await captureForkSeed({
      repoRoot,
      sourceTaskId: SOURCE_TASK,
      forkTaskId: FORK_TASK,
    });
    expect(captured.baseCommit).toBe(baseCommit);
    expect(captured.hasDiff).toBe(true);
    expect(captured.untrackedCount).toBe(1);
    expect(captured.symlinkCount).toBe(1);
    expect(hasForkSeed(FORK_TASK)).toBe(true);

    // AFTER the gesture: the source mutates (files AND the symlink's
    // target) and the mainline moves on. The fork must receive the
    // CAPTURED state regardless (review finding: the first draft read the
    // live tree at claim time).
    const sourcePath = locateTaskWorktreePath(repoRoot, SOURCE_TASK);
    writeFileSync(join(sourcePath, "a.txt"), "a LATER edit the fork must not see\n");
    writeFileSync(join(sourcePath, "docs", "new.md"), "later untracked content\n");
    unlinkSync(join(sourcePath, "link-out"));
    symlinkSync(join(scratch, "elsewhere.txt"), join(sourcePath, "link-out"));
    writeFileSync(join(repoRoot, "a.txt"), "later mainline content\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-m", "commit B (after the step)");

    // The target, created the way ensureTaskWorktree does — detached at
    // today's HEAD (B), exactly the wrong base the apply must correct.
    const targetPath = locateTaskWorktreePath(repoRoot, "task-apply-target");
    mkdirSync(dirname(targetPath), { recursive: true });
    git(repoRoot, "worktree", "add", "--detach", targetPath);

    // The stash must agree with the claiming job's persisted provenance
    // (review finding: the stash and the provenance columns must not be
    // able to drift silently). The guard runs before any mutation.
    await expect(
      applyForkSeed({
        forkTaskId: FORK_TASK,
        targetPath,
        expectedSourceTaskId: "task-somebody-else",
      })
    ).rejects.toThrow(/mismatched materialization/);

    const applied = await applyForkSeed({
      forkTaskId: FORK_TASK,
      targetPath,
      expectedSourceTaskId: SOURCE_TASK,
    });
    expect(applied.baseCommit).toBe(baseCommit);
    expect(applied.appliedDiff).toBe(true);
    expect(applied.untrackedCopied).toBe(1);
    expect(applied.symlinksRestored).toBe(1);
    expect(git(targetPath, "rev-parse", "HEAD").trim()).toBe(baseCommit);
    expect(readFileSync(join(targetPath, "a.txt"), "utf8")).toBe(
      "the step's edit\n"
    );
    expect(readFileSync(join(targetPath, "docs", "new.md"), "utf8")).toBe(
      "untracked note\n"
    );
    // The symlink arrived as a LINK with its GESTURE-TIME target — never a
    // regular file holding the target's dereferenced content, and not the
    // retargeted link the source now holds.
    const restored = join(targetPath, "link-out");
    expect(lstatSync(restored).isSymbolicLink()).toBe(true);
    expect(readlinkSync(restored)).toBe(join(scratch, "secret.txt"));
  });

  it("ADR-0084: copyForkSeed inherits the stash under the NEW task's key — applied marker excluded, provenance preserved", async () => {
    // SELF-CONTAINED fixture (review finding: depending on the previous
    // test's stash breaks name-filtered runs): capture fresh, then stamp
    // the applied marker by hand — exactly the state a coordinator's
    // stash is in when it delegates.
    const COORD_TASK = "task-copy-fixture";
    await captureForkSeed({
      repoRoot,
      sourceTaskId: SOURCE_TASK,
      forkTaskId: COORD_TASK,
    });
    writeFileSync(join(forkSeedDir(COORD_TASK), "applied.json"), "{}");
    const sourceA = readFileSync(
      join(locateTaskWorktreePath(repoRoot, SOURCE_TASK), "a.txt"),
      "utf8"
    );
    const WORKER_TASK = "task-worker-inherited";
    const copied = await copyForkSeed({
      fromTaskId: COORD_TASK,
      toTaskId: WORKER_TASK,
    });
    // The ORIGINAL source task rides along — the new task's provenance
    // column carries this, so applyForkSeed's stash/column agreement check
    // keeps holding on the inherited copy.
    expect(copied.sourceTaskId).toBe(SOURCE_TASK);
    expect(hasForkSeed(WORKER_TASK)).toBe(true);
    // The marker records the SOURCE task's materialisation, never the
    // copy's — a never-materialised tree must not read as healthy.
    expect(
      existsSync(join(forkSeedDir(WORKER_TASK), "applied.json"))
    ).toBe(false);

    const targetPath = locateTaskWorktreePath(repoRoot, "task-worker-tree");
    mkdirSync(dirname(targetPath), { recursive: true });
    git(repoRoot, "worktree", "add", "--detach", targetPath);
    const applied = await applyForkSeed({
      forkTaskId: WORKER_TASK,
      targetPath,
      expectedSourceTaskId: SOURCE_TASK,
    });
    expect(applied.baseCommit).toBe(baseCommit);
    // The worker's tree holds whatever the CAPTURE recorded from the
    // source — compared dynamically, so this pin is order-independent.
    expect(readFileSync(join(targetPath, "a.txt"), "utf8")).toBe(sourceA);

    // A missing source stash refuses with nothing left behind — a crew
    // task without the recorded state would stand on today's HEAD.
    await expect(
      copyForkSeed({ fromTaskId: "task-that-never-ran", toTaskId: "task-nope" })
    ).rejects.toThrow(/recorded state is gone/);
    expect(existsSync(forkSeedDir("task-nope"))).toBe(false);
  });

  it("a vanished source refuses CAPTURE; a vanished stash refuses APPLY; discard removes the stash", async () => {
    await expect(
      captureForkSeed({
        repoRoot,
        sourceTaskId: "task-that-never-ran",
        forkTaskId: "task-x",
      })
    ).rejects.toThrow(/recorded state is gone/);

    await discardForkSeed(FORK_TASK);
    expect(hasForkSeed(FORK_TASK)).toBe(false);
    expect(existsSync(forkSeedDir(FORK_TASK))).toBe(false);
    const targetPath = locateTaskWorktreePath(repoRoot, "task-apply-target-2");
    mkdirSync(dirname(targetPath), { recursive: true });
    git(repoRoot, "worktree", "add", "--detach", targetPath);
    await expect(
      applyForkSeed({ forkTaskId: FORK_TASK, targetPath })
    ).rejects.toThrow(/captured seed is gone/);
  });
});
