import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { taskWorktreePath } from "@muon/core";
import {
  canonicalPathCase,
  canonicalWorkspacePath,
  clearWorkspaceIdentityCaches,
  repoRootOf,
} from "../src/lib/workspace-identity.js";

// ADR-0026 §3 + §4 — what identifies a workspace. Two measured defects are on
// the critical path once memory is keyed by a path, and this file pins both:
//
//   • CASE. `realpathSync` does NOT normalize case on APFS, so
//     `/users/…/muon-labs` and `/Users/…/MUON-LABS` are the same inode and two
//     keys, and a case-variant `--workspace` would mint a second memory island.
//   • WORKTREES. A governed `.muon/worktrees/<taskId>` tree AND a human-created
//     linked worktree are both the same repository and must resolve to one key.
//
// Real filesystem, real `git worktree add`. Nothing is stubbed, because the
// defect being closed is a property of the filesystem and of git, not of our code.

let root: string;

/** Is this filesystem case-insensitive? Decided by probing, not assumed: the
 *  founder's APFS volume is, a Linux CI ext4 volume is not, and the two demand
 *  DIFFERENT correct answers from `canonicalPathCase`. */
let caseInsensitive = false;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "muon",
      GIT_AUTHOR_EMAIL: "muon@example.invalid",
      GIT_COMMITTER_NAME: "muon",
      GIT_COMMITTER_EMAIL: "muon@example.invalid",
    },
  });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-ws-identity-")));
  mkdirSync(path.join(root, "CaseProbe"));
  try {
    realpathSync(path.join(root, "caseprobe"));
    caseInsensitive = true;
  } catch {
    caseInsensitive = false;
  }
});

afterAll(() => {
  // `git worktree add` may leave a just-closed filesystem handle behind on
  // macOS. Node retries ENOTEMPTY only when maxRetries is non-zero; without
  // this bounded grace period the full serial backend suite flakes after all
  // eight behavioral assertions have passed.
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

beforeEach(() => {
  clearWorkspaceIdentityCaches();
});

describe("ADR-0026 workspace identity: case canonicalization", () => {
  it("resolves a case-variant spelling to the ON-DISK spelling (the measured APFS defect)", () => {
    const onDisk = path.join(root, "CaseProbe");
    // The exact shape §3 measured: realpath leaves the wrong-case path alone.
    if (caseInsensitive) {
      expect(realpathSync(path.join(root, "caseprobe"))).toBe(
        path.join(root, "caseprobe")
      );
      expect(canonicalPathCase(path.join(root, "caseprobe"))).toBe(onDisk);
      expect(canonicalPathCase(path.join(root, "CASEPROBE"))).toBe(onDisk);
      // One workspace, ONE key — which is the whole point.
      expect(canonicalWorkspacePath(path.join(root, "caseprobe"))).toBe(
        canonicalWorkspacePath(onDisk)
      );
    } else {
      // On a case-SENSITIVE filesystem `caseprobe` simply does not exist, and
      // rewriting it to `CaseProbe` would be a mis-identification, not a fix.
      expect(canonicalPathCase(path.join(root, "caseprobe"))).toBe(
        path.join(root, "caseprobe")
      );
    }
  });

  it("never merges two DIFFERENT directories that differ only in case", () => {
    if (caseInsensitive) {
      // The filesystem itself cannot hold both, so there is nothing to merge.
      return;
    }
    const lower = path.join(root, "twin");
    const upper = path.join(root, "TWIN");
    mkdirSync(lower, { recursive: true });
    mkdirSync(upper, { recursive: true });
    expect(canonicalPathCase(lower)).toBe(lower);
    expect(canonicalPathCase(upper)).toBe(upper);
  });

  it("is idempotent, and keeps an unresolvable tail verbatim", () => {
    const onDisk = path.join(root, "CaseProbe");
    expect(canonicalPathCase(canonicalPathCase(onDisk))).toBe(onDisk);
    // A workspace directory may not exist yet; an unknown spelling degrades to
    // the caller's, never to a guess.
    const missing = path.join(root, "CaseProbe", "Not", "Here");
    expect(canonicalPathCase(missing)).toBe(missing);
  });
});

describe("ADR-0026 workspace identity: repoRootOf", () => {
  it("strips MUON's own .muon/worktrees/<taskId> tail", async () => {
    const repo = path.join(root, "muon-strip");
    const worktree = path.join(repo, ".muon", "worktrees", "task-abc");
    mkdirSync(worktree, { recursive: true });
    expect(await repoRootOf(worktree)).toBe(repo);
  });

  it("reduces a HUMAN-created linked git worktree to its main worktree", async () => {
    const repo = path.join(root, "linked-main");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");
    // Deliberately OUTSIDE `.muon/worktrees/`, so a string-strip cannot see it.
    const linked = path.join(root, "linked-elsewhere");
    git(repo, "worktree", "add", "--detach", linked);

    expect(await repoRootOf(linked)).toBe(repo);
    // And the main worktree is its own root, not its parent directory.
    clearWorkspaceIdentityCaches();
    expect(await repoRootOf(repo)).toBe(repo);
  });

  it("reduces MUON's current external task tree to the same memory partition", async () => {
    const repo = path.join(root, "managed-main");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--initial-branch=main");
    writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");
    const previous = process.env.MUON_WORKTREE_ROOT;
    process.env.MUON_WORKTREE_ROOT = path.join(root, "managed-store");
    try {
      const linked = taskWorktreePath(repo, "task-managed");
      mkdirSync(path.dirname(linked), { recursive: true });
      git(repo, "worktree", "add", "--detach", linked);

      expect(linked.startsWith(`${repo}${path.sep}`)).toBe(false);
      expect(await repoRootOf(linked)).toBe(repo);
    } finally {
      if (previous === undefined) delete process.env.MUON_WORKTREE_ROOT;
      else process.env.MUON_WORKTREE_ROOT = previous;
    }
  });

  it("does NOT walk up to an enclosing repository (the $HOME-dotfiles collapse)", async () => {
    // A user with a git repo at $HOME would otherwise see every non-repo
    // workspace under home collapse into the single partition $HOME, FUSING
    // repositories that are correctly separate today.
    const outer = path.join(root, "outer-repo");
    mkdirSync(outer, { recursive: true });
    git(outer, "init", "--initial-branch=main");
    const inner = path.join(outer, "not-a-repo");
    mkdirSync(inner, { recursive: true });

    expect(await repoRootOf(inner)).toBe(inner);
  });

  it("returns a non-git directory unchanged (a real, in-use MUON workspace shape)", async () => {
    const plain = path.join(root, "no-git-here");
    mkdirSync(plain, { recursive: true });
    expect(await repoRootOf(plain)).toBe(plain);
  });

  it("canonicalizes case on the way out, so one repo is one key", async () => {
    const repo = path.join(root, "CaseRepo");
    mkdirSync(repo, { recursive: true });
    const viaLowercase = await repoRootOf(path.join(root, "caserepo"));
    clearWorkspaceIdentityCaches();
    const viaOnDisk = await repoRootOf(repo);
    if (caseInsensitive) {
      expect(viaLowercase).toBe(repo);
    }
    expect(viaOnDisk).toBe(repo);
  });
});
