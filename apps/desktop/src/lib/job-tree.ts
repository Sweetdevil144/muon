import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { taskWorktreeCandidates } from "@muon/core";

// ─── WHICH GIT TREE DID THIS DISPATCH ACTUALLY EDIT? ─────────────────────────
//
// A job's `workspacePath` is the CANONICAL checkout it was dispatched against,
// and it is never rewritten afterwards. But a harness that declares
// `requires.worktree` runs its agent in an ISOLATED tree —
// MUON's per-repository external worktree store — so reading the human's review
// evidence out of `workspacePath` reads a tree the agent never touched. That
// renders as a confident EMPTY diff on the one job that actually changed code,
// which is the worst possible failure mode for a review surface: it does not
// look broken, it looks clean.
//
// The worktree path is deterministic, and the desktop already holds the taskId,
// so the human's view can resolve the same tree the runner chose WITHOUT any
// new backend field. Two rules keep it honest:
//
//   1. Positive evidence wins. A worktree that EXISTS on disk for this exact
//      task is the tree the agent edited; use it.
//   2. A missing tree is never downgraded to the workspace root. If the job's
//      harness says it ran in a worktree and that worktree cannot be located,
//      the caller degrades with a reason — it must never fall through and
//      render the canonical checkout as if it were the agent's work.
//
// `requiresWorktree` returning `null` means UNKNOWN (no harness on the job, or
// the harness could not be read), which is deliberately NOT the same as `false`:
// unknown intent may only be resolved by disk evidence, never by assertion.

/** The exact working tree a review surface read its evidence from. */
export type JobTree = {
  /**
   * `worktree` — the task's isolated checkout in MUON's worktree store.
   * `workspace` — the canonical checkout the dispatch was bound to.
   */
  kind: "worktree" | "workspace";
  path: string;
  /** Set only for `worktree`: the task whose isolated tree this is. */
  taskId?: string;
};

export type JobTreeResolution =
  | { status: "resolved"; tree: JobTree }
  | { status: "unresolved"; reason: string; action: string };

/** The dispatch-record fields tree resolution needs. Structural, so both the
 *  full `DispatchJobRecord` and a test double satisfy it. */
export type JobTreeJob = {
  taskId?: string | null;
  workspacePath?: string | null;
  harnessKey?: string | null;
  /**
   * Dispatch status, used ONLY to phrase a missing worktree honestly. A queued
   * job has not created its tree yet; a finished one had it removed. Same
   * outcome either way (no tree to read), but "it is not there yet" and "it is
   * gone" are different facts and the operator is owed the right one.
   */
  status?: string | null;
  /**
   * The cwd the lease-holding runner ACTUALLY handed the vendor (0039). Absent
   * or null means UNKNOWN — a pre-0039 row, or a job that never reached tree
   * preparation — and must fall through to the derivation below, never be read
   * as "ran in the workspace root". A fact column with a guessed value is worse
   * than an honest null, which is why the migration deliberately did not
   * backfill one.
   */
  executionPath?: string | null;
};

/** Statuses where the runner has not necessarily reached worktree creation. */
const PRE_EXECUTION_STATUSES = new Set(["queued"]);

export type JobTreeDependencies = {
  /** `git rev-parse --show-toplevel`, or null when the path is not in a repo. */
  repoRoot: (cwd: string) => Promise<string | null>;
  exists: (path: string) => boolean;
  /**
   * Does this harness run its dispatch in an isolated worktree?
   * `true`/`false` = the harness said so; `null` = UNKNOWN (unreadable, or the
   * job names no harness). Never collapse `null` into `false`.
   */
  requiresWorktree: (harnessKey: string) => Promise<boolean | null>;
};

const REPO_ROOT_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

async function defaultRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: REPO_ROOT_TIMEOUT_MS, windowsHide: true }
    );
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

export const defaultJobTreeDependencies: JobTreeDependencies = {
  repoRoot: defaultRepoRoot,
  exists: existsSync,
  // No harness reader wired in: unknown intent, resolved from disk alone.
  requiresWorktree: async () => null,
};

/**
 * Build a `requiresWorktree` probe over the operator-tier harness read. Any
 * failure (route absent, harness deleted, timeout) resolves UNKNOWN rather than
 * a false `false` — an unreadable harness must not be able to assert that a
 * dispatch ran in the canonical checkout.
 */
export function harnessWorktreeProbe(client: {
  getHarness(key: string): Promise<{ config: { requires: { worktree: boolean } } }>;
}): (harnessKey: string) => Promise<boolean | null> {
  const cache = new Map<string, Promise<boolean | null>>();
  return (harnessKey: string) => {
    const cached = cache.get(harnessKey);
    if (cached) return cached;
    const probe = client
      .getHarness(harnessKey)
      .then((harness) => harness.config.requires.worktree === true)
      .catch(() => null);
    cache.set(harnessKey, probe);
    return probe;
  };
}

/** `taskWorktreeCandidates` throws for a task id that cannot be mapped to a directory
 *  name. That is a "cannot locate", not a crash. */
function candidateWorktree(
  repoRoot: string,
  taskId: string,
  exists: (path: string) => boolean
): string | null {
  try {
    // Iterate EVERY candidate, never a fixed pair: the list grew a third entry
    // when the default worktree root moved (a tree created by an earlier MUON
    // must stay reviewable), and a two-element destructure silently skipped the
    // pre-5.14 nested layout the moment a middle candidate appeared.
    const candidates = taskWorktreeCandidates(repoRoot, taskId);
    return (
      candidates.find(
        (candidate) => exists(candidate) && exists(join(candidate, ".git"))
      ) ??
      candidates[0] ??
      null
    );
  } catch {
    return null;
  }
}

const LOCATE_ACTION =
  "Open the workspace in Git and inspect the branch, or re-dispatch the task from its repository root.";

/**
 * Resolve the working tree a job's review evidence must be read from.
 *
 * Always resolves; the `unresolved` branch carries the human-readable reason a
 * caller renders instead of a diff. It never returns the canonical checkout as
 * a stand-in for a worktree it could not find.
 */
export async function resolveJobTree(
  job: JobTreeJob,
  dependencies: JobTreeDependencies = defaultJobTreeDependencies
): Promise<JobTreeResolution> {
  const workspacePath = job.workspacePath?.trim();
  if (!workspacePath) {
    return {
      status: "unresolved",
      reason: "This dispatch has no workspace path.",
      action: "Re-dispatch the task with an explicit workspace.",
    };
  }

  const taskId = job.taskId?.trim();

  // FACT BEATS INFERENCE. The runner now records the cwd it actually handed the
  // vendor (`executionPath`, lease-fenced, realpath'd by the brain). Everything
  // below this block INFERS that path from the harness plus a disk probe, which
  // is what the desktop had to do before the field existed. Prefer the fact.
  //
  // `null`/absent means UNKNOWN — a pre-0039 row, or a job that never reached
  // tree preparation — NOT "no worktree". So it falls through to the derivation
  // rather than being read as a workspace-root answer.
  const recorded = job.executionPath?.trim();
  if (recorded) {
    // The field states WHERE, never WHICH KIND, so classify it here. Both sides
    // are realpath'd through the same normalization, so they compare cleanly.
    if (taskId && recorded !== workspacePath) {
      return {
        status: "resolved",
        tree: { kind: "worktree", path: recorded, taskId },
      };
    }
    return { status: "resolved", tree: { kind: "workspace", path: recorded } };
  }

  const expectsWorktree = job.harnessKey
    ? await dependencies
        .requiresWorktree(job.harnessKey)
        .catch(() => null)
    : null;
  const repoRoot = taskId
    ? await dependencies.repoRoot(workspacePath).catch(() => null)
    : null;
  const candidate =
    repoRoot && taskId
      ? candidateWorktree(repoRoot, taskId, dependencies.exists)
      : null;
  // A bare directory is not proof: a half-removed worktree leaves the folder
  // behind. The `.git` file/dir is what makes it a checkout git can diff.
  const present =
    candidate !== null &&
    dependencies.exists(candidate) &&
    dependencies.exists(join(candidate, ".git"));

  if (present && candidate && taskId) {
    return {
      status: "resolved",
      tree: { kind: "worktree", path: candidate, taskId },
    };
  }

  if (expectsWorktree === true) {
    // "Has not started yet" and "was removed after it landed" are different
    // facts. Both mean there is nothing to diff, and neither may be rendered as
    // a clean workspace.
    const pending = PRE_EXECUTION_STATUSES.has(job.status ?? "");
    const ran = pending ? "runs" : "ran";
    if (!taskId) {
      return {
        status: "unresolved",
        reason: `This dispatch ${ran} in an isolated worktree, but it records no task, so that tree cannot be located.`,
        action: LOCATE_ACTION,
      };
    }
    if (!repoRoot) {
      return {
        status: "unresolved",
        reason: `This dispatch ${ran} in an isolated worktree, but '${workspacePath}' is not inside a git repository, so that tree cannot be located.`,
        action: LOCATE_ACTION,
      };
    }
    if (!candidate) {
      return {
        status: "unresolved",
        reason: `This dispatch ${ran} in an isolated worktree for task '${taskId}', whose path cannot be derived.`,
        action: LOCATE_ACTION,
      };
    }
    return pending
      ? {
          status: "unresolved",
          reason: `This dispatch is still queued, so its isolated worktree '${candidate}' does not exist yet.`,
          action:
            "Changes appear here once the lane starts working in its own tree.",
        }
      : {
          status: "unresolved",
          reason: `This dispatch ran in the isolated worktree '${candidate}', which is not on disk now.`,
          action:
            "A merged or pruned worktree is removed after it lands. Review the landed commit on the branch, or re-dispatch to rebuild it.",
        };
  }

  return {
    status: "resolved",
    tree: { kind: "workspace", path: workspacePath },
  };
}
