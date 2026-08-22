import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyCheckout } from "@muon/client/gitnexus-reindex";

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

/**
 * Git's two directory answers for a work-tree, absolute, or undefined when git
 * could not be reached. One call, two lines, in the order asked.
 */
export type ReadGitDirs = (
  dir: string
) => { gitDir?: string; gitCommonDir?: string } | undefined;

/** `.git`'s kind at a work-tree root. A linked worktree's marker is a FILE. */
export type DotGitKind = (path: string) => "dir" | "file" | null;

export const defaultDotGitKind: DotGitKind = (path) => {
  try {
    const info = statSync(path);
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
};

export const defaultReadGitDirs: ReadGitDirs = (dir) => {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true }
    );
    const [gitDir, gitCommonDir] = String(out)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      ...(gitDir ? { gitDir } : {}),
      ...(gitCommonDir ? { gitCommonDir } : {}),
    };
  } catch {
    return undefined;
  }
};

export type ResolveTargetsOptions = DiscoverOptions & {
  isGitRepo?: IsGitRepo;
  readGitDirs?: ReadGitDirs;
  dotGitKind?: DotGitKind;
};

/**
 * The repos to index for an opened folder:
 *  - the folder is a GOVERNED WORKTREE → `[]`, never itself (see below);
 *  - the folder itself is a git work-tree → `[folder]` (the single-repo path;
 *    also covers "opened a subdirectory of a repo" — gitnexus resolves the root);
 *  - otherwise → the git repos discovered inside it (a monorepo of separate
 *    repos, each indexed on its own);
 *  - neither → `[]` — nothing to index, a CLEAN non-error state (no more
 *    "analyze exited (code 1)").
 *
 * ADR-0054 — THE WORKTREE FENCE. `isRepo` answers yes for a linked worktree,
 * because a linked worktree IS a work-tree, so a chat bound to one used to make
 * the supervisor index a full COPY of the repository: a second `.gitnexus/`
 * store, at a commit no brain tool queries, built at the cost of a real index
 * run — while the primary store that every tool does query stayed stale. The
 * primary checkout is offered in its place, so binding a worktree still indexes
 * the right thing instead of nothing. Governed worktrees live outside the
 * checkout today, so the git-dir test (not a path-shape test) is what catches
 * them; `classifyCheckout` in `@muon/client` owns that rule for every surface.
 */
export function resolveIndexTargets(
  root: string,
  opts: ResolveTargetsOptions = {}
): string[] {
  const isRepo = opts.isGitRepo ?? defaultIsGitRepo;
  if (isRepo(root)) {
    // CHEAP PRE-FILTER, and it is load-bearing rather than an optimisation: a
    // linked worktree's `.git` is always a FILE while a normal clone's is a
    // DIRECTORY, so an ordinary checkout never pays for a `git rev-parse` on a
    // path the app re-enters whenever the bound workspace changes.
    const marker = (opts.dotGitKind ?? defaultDotGitKind)(join(root, ".git"));
    const shape = classifyCheckout({ path: root });
    if (marker === "dir" && !shape.governedShape) return [root];
    const dirs = (opts.readGitDirs ?? defaultReadGitDirs)(root);
    const checkout = classifyCheckout({ path: root, ...(dirs ?? {}) });
    if (checkout.linkedWorktree || checkout.governedShape) {
      // Substitute the primary checkout when git named one — that store is the
      // one the graph tools read, and it is the one a merge into this worktree's
      // repository makes stale. When git named none, index nothing rather than
      // guess: a wrong repo root is a worse answer than no answer.
      return checkout.primary ? [checkout.primary] : [];
    }
    return [root];
  }
  return discoverGitRepos(root, opts);
}
