import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import {
  worktreeChangedFiles,
  worktreeDiff,
  worktreeDiffStat,
  worktreeNumstat,
  type WorktreeDiff,
  type WorktreeFileStat,
} from "@muon/core";
import type {
  WorkspaceReview,
  WorkspaceReviewQuery,
} from "../shared/ipc.js";
import {
  resolveJobTree,
  type JobTreeJob,
  type JobTreeResolution,
} from "./job-tree.js";

const MAX_REVIEW_DIFF_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

type WorktreeReviewContext = {
  branch: string;
  stagedFiles: string[];
  unstagedFiles: string[];
};

function fileList(output: string): string[] {
  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))]
    .sort();
}

async function git(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspacePath,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function loadWorktreeContext(
  workspacePath: string
): Promise<WorktreeReviewContext> {
  const [branchOutput, stagedOutput, unstagedOutput, untrackedOutput] =
    await Promise.all([
      git(workspacePath, ["branch", "--show-current"]),
      git(workspacePath, ["diff", "--cached", "--name-only", "--"]),
      git(workspacePath, ["diff", "--name-only", "--"]),
      git(workspacePath, ["ls-files", "--others", "--exclude-standard"]),
    ]);
  const branchName = branchOutput.trim();
  const branch = branchName
    ? branchName
    : `detached@${(await git(workspacePath, ["rev-parse", "--short", "HEAD"])).trim()}`;
  return {
    branch,
    stagedFiles: fileList(stagedOutput),
    unstagedFiles: fileList(`${unstagedOutput}\n${untrackedOutput}`),
  };
}

type WorkspaceReviewClient = {
  getDispatchJob(jobId: string): Promise<
    {
      id: string;
      workspacePath?: string | null;
    } & JobTreeJob
  >;
};

export type WorkspaceReviewDependencies = {
  /**
   * Which working tree this job ACTUALLY edited. A worktree-backed harness runs
   * in MUON's external worktree store while `workspacePath` keeps naming
   * the canonical checkout, so reading the raw diff from `workspacePath` shows a
   * confident EMPTY diff for the one job that changed code. Optional so existing
   * callers/tests keep compiling; it defaults to the real resolver.
   */
  resolveTree?: (job: JobTreeJob) => Promise<JobTreeResolution>;
  canonicalize: (path: string) => Promise<string>;
  context: (path: string) => Promise<WorktreeReviewContext>;
  changedFiles: (path: string) => Promise<string[]>;
  diffStat: (path: string) => Promise<string>;
  numstat: (path: string) => Promise<WorktreeFileStat[]>;
  diff: (
    path: string,
    options: { maxBytes: number }
  ) => Promise<WorktreeDiff>;
};

export const defaultWorkspaceReviewDependencies: WorkspaceReviewDependencies = {
  resolveTree: (job) => resolveJobTree(job),
  canonicalize: realpath,
  context: loadWorktreeContext,
  changedFiles: worktreeChangedFiles,
  diffStat: worktreeDiffStat,
  numstat: worktreeNumstat,
  diff: worktreeDiff,
};

export async function loadWorkspaceReview(
  client: WorkspaceReviewClient,
  query: WorkspaceReviewQuery,
  dependencies: WorkspaceReviewDependencies = defaultWorkspaceReviewDependencies
): Promise<WorkspaceReview> {
  const job = await client.getDispatchJob(query.jobId);
  // Resolve the tree the agent actually edited BEFORE reading any git evidence.
  // An unlocatable worktree degrades with its reason — it is never downgraded to
  // the canonical checkout, which would render as a clean, empty diff.
  const resolution = await (dependencies.resolveTree ?? resolveJobTree)(job);
  if (resolution.status === "unresolved") {
    return {
      status: "degraded",
      reason: resolution.reason,
      action: resolution.action,
    };
  }

  try {
    const workspacePath = await dependencies.canonicalize(resolution.tree.path);
    // The diff helpers temporarily mark untracked files intent-to-add so they
    // appear in bounded evidence. Keep these reads serialized: concurrent
    // add/reset operations can race on Git's index and make a transient
    // untracked path look staged.
    const context = await dependencies.context(workspacePath);
    const files = await dependencies.changedFiles(workspacePath);
    const stat = await dependencies.diffStat(workspacePath);
    const fileStats = await dependencies.numstat(workspacePath);
    const diff = await dependencies.diff(workspacePath, {
      maxBytes: MAX_REVIEW_DIFF_BYTES,
    });
    return {
      status: "available",
      workspacePath,
      // The tree this evidence was READ FROM (worktree vs canonical checkout)
      // — same contract as ReviewDiffResponse.tree; "Land this work" needs it.
      tree: resolution.tree,
      branch: context.branch,
      stagedFiles: context.stagedFiles,
      unstagedFiles: context.unstagedFiles,
      files,
      stat,
      fileStats,
      diffText: diff.text,
      truncated: diff.truncated,
      totalBytes: diff.totalBytes,
      maxBytes: MAX_REVIEW_DIFF_BYTES,
    };
  } catch (error) {
    return {
      status: "degraded",
      reason:
        error instanceof Error
          ? error.message.slice(0, 400)
          : "Workspace review is unavailable.",
      action:
        "Open the workspace in Git or inspect the session timeline and terminal artifact.",
    };
  }
}
