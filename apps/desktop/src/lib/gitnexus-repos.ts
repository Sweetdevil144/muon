import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Auto Repository Detection. GitNexus `analyze` operates on ONE git work-tree;
// pointed at a non-git parent (a monorepo of separate repos, e.g. ATLAS/
// {operations/backend, operations/frontend, wealth}) its git plumbing fails and
// the process exits non-zero. This module resolves an opened folder to the
// actual repo root(s) to index BEFORE we ever spawn analyze — so we never run it
// on a non-repo, and a multi-repo workspace indexes each member. OSS-safe: no
// GitNexus "groups" required — just per-repo indexing.

/** Minimal injectable filesystem seam (real fs by default; a fake in tests). */
export type RepoFs = {
  existsSync: (path: string) => boolean;
  readdirSync: (
    path: string
  ) => Array<{ name: string; isDirectory: () => boolean }>;
};

const realFs: RepoFs = {
  existsSync,
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
};

// Never descend into these — .git internals, dependency/build outputs, VCS/IDE
// metadata, and our own index dir. Pruning is what makes the walk cheap AND
// keeps it from ever recursing into a repo's own tree.
const PRUNE = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".gitnexus",
  "coverage",
  ".idea",
  ".vscode",
  "vendor",
  ".pnpm",
]);

export type DiscoverOptions = {
  /** Max directory depth to descend from the root (default 3). */
  maxDepth?: number;
  /** Safety cap on repos found (default 50). */
  maxRepos?: number;
  fs?: RepoFs;
};

/**
 * Deterministically discover the git repositories at/under `root`, WITHOUT
 * recursion errors. A directory containing a `.git` entry (a dir for normal
 * clones, a FILE for worktrees/submodules) IS a repo → it is recorded and we do
 * NOT descend into it (its whole subtree belongs to that repo). We prune .git
 * internals, node_modules, build outputs and dot-dirs, and bound the depth — so
 * the walk always terminates and can never recurse into a repo or into .git.
 *
 * Returns repo roots in a stable, sorted order (deterministic across runs).
 */
export function discoverGitRepos(
  root: string,
  opts: DiscoverOptions = {}
): string[] {
  const fs = opts.fs ?? realFs;
  const maxDepth = opts.maxDepth ?? 3;
  const maxRepos = opts.maxRepos ?? 50;
  const found: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (found.length >= maxRepos) return;
    let hasGit = false;
    try {
      hasGit = fs.existsSync(join(dir, ".git"));
    } catch {
      return; // unreadable dir → skip, never throw
    }
    if (hasGit) {
      found.push(dir); // a repo — record and STOP (do not descend into it)
      return;
    }
    if (depth >= maxDepth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxRepos) return;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || PRUNE.has(entry.name)) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };

  visit(root, 0);
  return found.sort();
}

export type IsGitRepo = (dir: string) => boolean;

/**
 * Git's own answer to "is this a work-tree?" — deterministic and correct for the
 * edge cases (worktrees, submodules, and being INSIDE a repo's subdirectory).
 * Mirrors GitNexus's own `isGitRepo` (storage/git.ts).
 */
export const defaultIsGitRepo: IsGitRepo = (dir) => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: "ignore",
      windowsHide: true,
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
};

export type ResolveTargetsOptions = DiscoverOptions & {
  isGitRepo?: IsGitRepo;
};

/**
 * The repos to index for an opened folder:
 *  - the folder itself is a git work-tree → `[folder]` (the single-repo path;
 *    also covers "opened a subdirectory of a repo" — gitnexus resolves the root);
 *  - otherwise → the git repos discovered inside it (a monorepo of separate
 *    repos, each indexed on its own);
 *  - neither → `[]` — nothing to index, a CLEAN non-error state (no more
 *    "analyze exited (code 1)").
 */
export function resolveIndexTargets(
  root: string,
  opts: ResolveTargetsOptions = {}
): string[] {
  const isRepo = opts.isGitRepo ?? defaultIsGitRepo;
  if (isRepo(root)) return [root];
  return discoverGitRepos(root, opts);
}
