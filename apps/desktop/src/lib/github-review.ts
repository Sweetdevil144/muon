import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  GitHubCredential,
  GitHubPullRequestAction,
  GitHubPullRequestActionEnvelope,
  GitHubReview,
  GitHubReviewEnvelope,
} from "@muon/client";
import type { WorkspaceReviewQuery } from "../shared/ipc.js";

const execFileAsync = promisify(execFile);
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/;

export type GitHubRepositoryCoordinate = {
  owner: string;
  repo: string;
};

type GitHubReviewClient = {
  getDispatchJob(jobId: string): Promise<{
    id: string;
    workspacePath?: string | null;
  }>;
  getGitHubReview(input: {
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
  }): Promise<GitHubReviewEnvelope>;
};

type GitHubPublishClient = GitHubReviewClient & {
  authorizeGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
  }): Promise<{
    mergeCommit: string;
    credential?: GitHubCredential;
  }>;
  createGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
    title: string;
    body?: string;
  }): Promise<GitHubPullRequestActionEnvelope>;
  mergeGitHubPullRequest(input: {
    jobId: string;
    owner: string;
    repo: string;
    headOwner?: string;
    branch: string;
    pullNumber: number;
    expectedHeadSha: string;
    method?: "merge" | "squash" | "rebase";
  }): Promise<GitHubPullRequestActionEnvelope>;
};

type GitHubReviewDependencies = {
  canonicalize: (path: string) => Promise<string>;
  git: (workspacePath: string, args: string[]) => Promise<string>;
  push: (
    workspacePath: string,
    commitSha: string,
    branch: string
  ) => Promise<void>;
  onCredential?: (credential: GitHubCredential) => void | Promise<void>;
};

async function git(workspacePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspacePath,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function pushExactCommit(
  workspacePath: string,
  commitSha: string,
  branch: string
): Promise<void> {
  await execFileAsync(
    "git",
    [
      "push",
      "--porcelain",
      "--set-upstream",
      "origin",
      `${commitSha}:refs/heads/${branch}`,
    ],
    {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }
  );
}

const defaultDependencies: GitHubReviewDependencies = {
  canonicalize: realpath,
  git,
  push: pushExactCommit,
};

type GitHubWorkspaceResolution =
  | {
      ok: true;
      workspacePath: string;
      owner: string;
      repo: string;
      headOwner: string;
      branch: string;
    }
  | { ok: false; review: Extract<GitHubReview, { status: "degraded" }> };

export function parseGitHubRemote(
  value: string
): GitHubRepositoryCoordinate | undefined {
  const remote = value.trim();
  let owner = "";
  let repo = "";
  const scp = remote.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scp) {
    owner = scp[1] ?? "";
    repo = scp[2] ?? "";
  } else {
    try {
      const url = new URL(remote);
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.password ||
        (url.protocol === "https:" && Boolean(url.username)) ||
        (url.protocol === "ssh:" &&
          Boolean(url.username) &&
          url.username !== "git") ||
        url.search ||
        url.hash
      ) {
        return undefined;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) {
        return undefined;
      }
      [owner = "", repo = ""] = parts;
    } catch {
      return undefined;
    }
  }
  repo = repo.replace(/\.git$/i, "");
  if (
    !GITHUB_OWNER.test(owner) ||
    owner.length > 39 ||
    !GITHUB_REPO.test(repo) ||
    repo.length > 100
  ) {
    return undefined;
  }
  return { owner, repo };
}

/**
 * Browser egress is fixed to the two operator-visible GitHub surfaces this
 * feature owns. The renderer can never turn the bridge into a general URL
 * opener.
 */
export function isAllowedGitHubExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    return (
      /^\/login\/device\/?$/.test(url.pathname) ||
      /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*\/?$/.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}

export async function loadGitHubReview(
  client: GitHubReviewClient,
  query: WorkspaceReviewQuery,
  dependencies: Partial<GitHubReviewDependencies> = {}
): Promise<GitHubReview> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const coordinate = await resolveGitHubWorkspace(client, query, resolved);
  if (!coordinate.ok) return coordinate.review;

  try {
    const envelope = await client.getGitHubReview({
      owner: coordinate.owner,
      repo: coordinate.repo,
      headOwner: coordinate.headOwner,
      branch: coordinate.branch,
    });
    if (envelope.credential) {
      await resolved.onCredential?.(envelope.credential);
    }
    return envelope.review;
  } catch (error) {
    return degradedReview(error);
  }
}

async function resolveGitHubWorkspace(
  client: GitHubReviewClient,
  query: WorkspaceReviewQuery,
  resolved: GitHubReviewDependencies
): Promise<GitHubWorkspaceResolution> {
  const job = await client.getDispatchJob(query.jobId);
  if (!job.workspacePath) {
    return {
      ok: false,
      review: {
        status: "degraded",
        reason: "This dispatch has no workspace path.",
        action: "Re-dispatch the task with an explicit workspace.",
      },
    };
  }

  try {
    const workspacePath = await resolved.canonicalize(job.workspacePath);
    const [branchOutput, originOutput, upstreamOutput] = await Promise.all([
      resolved.git(workspacePath, ["branch", "--show-current"]),
      resolved.git(workspacePath, ["config", "--get", "remote.origin.url"]),
      resolved
        .git(workspacePath, ["config", "--get", "remote.upstream.url"])
        .catch(() => ""),
    ]);
    const branch = branchOutput.trim();
    if (!branch) {
      return {
        ok: false,
        review: {
          status: "degraded",
          reason: "The dispatch workspace is on a detached commit.",
          action: "Create or switch to a branch before opening a pull request.",
        },
      };
    }
    const origin = parseGitHubRemote(originOutput);
    if (!origin) {
      return {
        ok: false,
        review: {
          status: "degraded",
          reason: "The workspace origin is not a github.com repository.",
          action: "Configure a GitHub origin remote for this workspace.",
        },
      };
    }
    const upstream = parseGitHubRemote(upstreamOutput);
    const base =
      upstream && upstream.repo.toLowerCase() === origin.repo.toLowerCase()
        ? upstream
        : origin;
    return {
      ok: true,
      workspacePath,
      owner: base.owner,
      repo: base.repo,
      headOwner: origin.owner,
      branch,
    };
  } catch (error) {
    return { ok: false, review: degradedReview(error) };
  }
}

function degradedReview(
  error: unknown
): Extract<GitHubReview, { status: "degraded" }> {
  return {
    status: "degraded",
    reason:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "GitHub pull-request evidence is unavailable.",
    action: "Reconnect GitHub in Setup, then retry from Review.",
  };
}

function safeAction(
  envelope: GitHubPullRequestActionEnvelope
): GitHubPullRequestAction {
  const { credential: _credential, ...action } = envelope;
  return action;
}

export async function createWorkspacePullRequest(
  client: GitHubPublishClient,
  query: WorkspaceReviewQuery,
  dependencies: Partial<GitHubReviewDependencies> = {}
): Promise<GitHubPullRequestAction> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const coordinate = await resolveGitHubWorkspace(client, query, resolved);
  if (!coordinate.ok) {
    throw new Error(
      `${coordinate.review.reason}${
        coordinate.review.action ? ` ${coordinate.review.action}` : ""
      }`
    );
  }
  const [subjectOutput, commitOutput] = await Promise.all([
    resolved.git(coordinate.workspacePath, [
      "show",
      "-s",
      "--format=%s",
      "HEAD",
    ]),
    resolved.git(coordinate.workspacePath, ["rev-parse", "HEAD"]),
  ]);
  const subject = subjectOutput.trim();
  const commitSha = commitOutput.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
    throw new Error("The dispatch workspace HEAD is not a valid Git commit.");
  }
  const authorization = await client.authorizeGitHubPullRequest({
    jobId: query.jobId,
    owner: coordinate.owner,
    repo: coordinate.repo,
  });
  if (authorization.credential) {
    await resolved.onCredential?.(authorization.credential);
  }
  if (commitSha.toLowerCase() !== authorization.mergeCommit.toLowerCase()) {
    throw new Error(
      "The branch advanced after this dispatch landed. Select the dispatch whose governed merge is the current branch tip before publishing."
    );
  }
  await resolved.push(
    coordinate.workspacePath,
    authorization.mergeCommit,
    coordinate.branch
  );
  const envelope = await client.createGitHubPullRequest({
    jobId: query.jobId,
    owner: coordinate.owner,
    repo: coordinate.repo,
    headOwner: coordinate.headOwner,
    branch: coordinate.branch,
    title: (subject || `Publish ${coordinate.branch}`).slice(0, 256),
    body: "Created from MUON after the governed local merge.",
  });
  if (envelope.credential) await resolved.onCredential?.(envelope.credential);
  return safeAction(envelope);
}

export async function mergeWorkspacePullRequest(
  client: GitHubPublishClient,
  query: WorkspaceReviewQuery & {
    pullNumber: number;
    expectedHeadSha: string;
    method?: "merge" | "squash" | "rebase";
  },
  dependencies: Partial<GitHubReviewDependencies> = {}
): Promise<GitHubPullRequestAction> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const coordinate = await resolveGitHubWorkspace(client, query, resolved);
  if (!coordinate.ok) {
    throw new Error(
      `${coordinate.review.reason}${
        coordinate.review.action ? ` ${coordinate.review.action}` : ""
      }`
    );
  }
  const envelope = await client.mergeGitHubPullRequest({
    jobId: query.jobId,
    owner: coordinate.owner,
    repo: coordinate.repo,
    headOwner: coordinate.headOwner,
    branch: coordinate.branch,
    pullNumber: query.pullNumber,
    expectedHeadSha: query.expectedHeadSha,
    method: query.method,
  });
  if (envelope.credential) await resolved.onCredential?.(envelope.credential);
  return safeAction(envelope);
}
