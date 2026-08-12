import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { worktreeRepoRoot } from "./approval-containment.js";
import { realpathOfNearestExisting } from "./workspace.js";

const execFileAsync = promisify(execFile);

// ── ADR-0026: what identifies a workspace ────────────────────────────────────
//
// A memory note belongs to exactly ONE workspace, and that workspace is the
// CANONICAL ABSOLUTE PATH of its repository root. It is the identity every
// neighbouring model already uses (Task, WorkflowRun, OrchestratorChat,
// DispatchJob, WorkspacePolicyProfile, ApprovalReceipt), the one MUON already
// symlink-resolves at every trust boundary, and the only candidate that has a
// value for 100% of the observed corpus — a git remote does not (§3 measured a
// real, in-use MUON workspace that is not a git repository at all).
//
// A path-keyed partition promotes two latent defects in the existing helper from
// cosmetic to LOAD-BEARING, and this module is where both are answered:
//
//   1. CASE (§3, measured). `fs.realpathSync('/users/dev/code/muon')`
//      returns that path unchanged on APFS, while `/Users/dev/code/muon`
//      is the SAME directory (same device + inode). So `validateWorkspacePath`
//      yields two distinct keys for one workspace today, and a case-variant
//      `--workspace` would silently mint a second memory island.
//   2. WORKTREES (§4). A governed job executes in
//      `<repoRoot>/.muon/worktrees/<taskId>`, and a human may create a linked
//      worktree anywhere with `git worktree add`. Either one is the same
//      repository and must resolve to the same partition.
//
// Both reductions are IDEMPOTENT and only ever collapse two keys into one, so
// they can never split a workspace that was previously whole.

// Bounded memos. Both reductions sit on the memory write path — and, after step
// 3, on EVERY memory read, including the pre-edit hero gate that fans out one
// recall per anchor module. Uncached, each call would cost a `git` subprocess plus
// one `readdir` per path segment. A workspace neither moves nor changes its
// on-disk spelling under a live process, and the whole cache is dropped rather
// than evicted per-entry, so the bound is trivially safe.
const repoRootCache = new Map<string, string>();
const canonicalCache = new Map<string, string>();
const IDENTITY_CACHE_MAX = 256;
const GIT_TIMEOUT_MS = 5_000;

/** Test seam: drop the memos so a test can observe the probes themselves. */
export function clearWorkspaceIdentityCaches(): void {
  repoRootCache.clear();
  canonicalCache.clear();
}

function memoize(
  cache: Map<string, string>,
  key: string,
  value: string
): string {
  if (cache.size >= IDENTITY_CACHE_MAX) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

/**
 * The on-disk spelling of an existing path, segment by segment.
 *
 * Only substitutes a case-variant when THREE things hold: the literal spelling
 * is absent from the parent's listing, exactly one entry matches
 * case-insensitively, and that entry is the SAME inode on the SAME device. The
 * inode check is what makes this safe on a case-SENSITIVE filesystem, where
 * `foo` and `Foo` are two different directories and rewriting one to the other
 * would be a genuine mis-identification rather than a normalization.
 *
 * A segment that cannot be resolved (missing, unreadable) is kept verbatim
 * together with the whole remaining tail: an unknown spelling degrades to
 * today's behaviour, never to a guess.
 */
export function canonicalPathCase(target: string): string {
  const absolute = path.resolve(target);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const literal = path.join(current, segment);
    let onDisk: string;
    try {
      const literalStat = statSync(literal);
      const entries = readdirSync(current);
      if (entries.includes(segment)) {
        onDisk = segment;
      } else {
        const matches = entries.filter(
          (entry) => entry.toLowerCase() === segment.toLowerCase()
        );
        const sameInode = matches.filter((entry) => {
          try {
            const candidate = statSync(path.join(current, entry));
            return (
              candidate.ino === literalStat.ino &&
              candidate.dev === literalStat.dev
            );
          } catch {
            return false;
          }
        });
        onDisk = sameInode.length === 1 ? sameInode[0]! : segment;
      }
    } catch {
      // Unresolvable from here down: keep the caller's spelling for the tail.
      return path.join(current, ...segments.slice(index));
    }
    current = path.join(current, onDisk);
  }
  return current;
}

/**
 * The canonical key for a workspace path: absolute, `..`-normalized,
 * symlink-resolved (reusing `realpathOfNearestExisting`, so there is exactly ONE
 * evaluator of that rule), then case-corrected against the filesystem.
 *
 * Deliberately does NOT validate containment — `validateWorkspacePath` owns the
 * allowlist and stays the trust boundary for caller-supplied paths. This is the
 * identity function applied to a value that is already trusted (a server-side
 * `DispatchJob.workspacePath`).
 */
export function canonicalWorkspacePath(input: string): string {
  const cached = canonicalCache.get(input);
  if (cached !== undefined) {
    return cached;
  }
  return memoize(
    canonicalCache,
    input,
    canonicalPathCase(realpathOfNearestExisting(input))
  );
}

/**
 * Reduce a path to the repository that OWNS it, then canonicalize.
 *
 * Two reducers, in order, and the first is MUON's own:
 *
 *   • `worktreeRepoRoot` (promoted, not re-implemented — this repo has been
 *     bitten twice by a second evaluator of one rule) strips a
 *     `/.muon/worktrees/<taskId>` tail. It needs no subprocess and works on a
 *     path whose tree has already been pruned.
 *   • `git rev-parse --git-dir --git-common-dir` catches what a string-strip
 *     cannot: a HUMAN-created linked worktree, which lives at an arbitrary path
 *     with no MUON marker in it. The two values DIFFER exactly when the path is
 *     inside a linked worktree, and `dirname(--git-common-dir)` is then the main
 *     worktree — the shared partition both trees belong to.
 *
 * NARROW ON PURPOSE: when the two git values are EQUAL the path is kept as-is
 * rather than promoted to `--show-toplevel`. Promoting it would look tidier and
 * is wrong: a user with a dotfiles repository at `$HOME` would see every
 * non-repo workspace under home (`~/SWE/ATLAS`, measured as a real, in-use,
 * non-git MUON workspace) collapse into the single partition `$HOME`, fusing
 * repositories that today are correctly separate. The git probe exists to detect
 * a linked WORKTREE, which is the hazard §4 names, and it does only that.
 *
 * A bare-repo common dir (`…/foo.git`, whose parent may hold several bare repos)
 * is refused for the same reason. Any git failure — not a repository, git
 * missing, timeout — degrades to the worktree-stripped path, which is exactly
 * today's identity.
 */
export async function repoRootOf(input: string): Promise<string> {
  const canonical = canonicalWorkspacePath(input);
  const stripped = worktreeRepoRoot(canonical);
  const base = stripped ? canonicalWorkspacePath(stripped) : canonical;
  const cached = repoRootCache.get(base);
  if (cached !== undefined) {
    return cached;
  }
  return memoize(
    repoRootCache,
    base,
    canonicalWorkspacePath(await linkedWorktreeParent(base))
  );
}

/** `base` itself unless it sits inside a linked worktree, in which case the main
 *  worktree that owns the shared `.git` directory. */
async function linkedWorktreeParent(base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      {
        cwd: base,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      }
    );
    const [gitDir, gitCommonDir] = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      !gitDir ||
      !gitCommonDir ||
      gitDir === gitCommonDir ||
      path.basename(gitCommonDir) !== ".git"
    ) {
      return base;
    }
    return path.dirname(gitCommonDir);
  } catch {
    return base;
  }
}
