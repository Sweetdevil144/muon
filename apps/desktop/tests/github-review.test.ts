import { describe, expect, it, vi } from "vitest";
import {
  createWorkspacePullRequest,
  isAllowedGitHubExternalUrl,
  loadGitHubReview,
  mergeWorkspacePullRequest,
  parseGitHubRemote,
} from "../src/lib/github-review.js";

describe("GitHub workspace review binding", () => {
  it("parses only github.com HTTPS/SSH remotes", () => {
    expect(parseGitHubRemote("git@github.com:operator/muon.git")).toEqual({
      owner: "operator",
      repo: "muon",
    });
    expect(
      parseGitHubRemote("https://github.com/operator/muon.git")
    ).toEqual({
      owner: "operator",
      repo: "muon",
    });
    expect(
      parseGitHubRemote("ssh://git@github.com/operator/muon.git")
    ).toEqual({
      owner: "operator",
      repo: "muon",
    });
    expect(parseGitHubRemote("https://example.com/operator/muon.git")).toBe(
      undefined
    );
    expect(
      parseGitHubRemote("https://github.com/operator/muon/extra")
    ).toBe(undefined);
    expect(
      parseGitHubRemote("https://secret@github.com/operator/muon.git")
    ).toBe(undefined);
    expect(parseGitHubRemote("file:///tmp/muon")).toBe(undefined);
  });

  it("binds the PR lookup to the dispatch workspace branch and persists rotations in main", async () => {
    const onCredential = vi.fn();
    const getGitHubReview = vi.fn().mockResolvedValue({
      review: {
        status: "no_pull_request",
        repository: { owner: "upstream", repo: "muon" },
        branch: "codex/wave-5",
      },
      credential: {
        accessToken: "ghu_rotated_access",
        refreshToken: "ghr_rotated_refresh",
      },
    });
    const git = vi.fn(async (_workspacePath: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "codex/wave-5\n";
      if (key === "config --get remote.origin.url") {
        return "git@github.com:operator/muon.git\n";
      }
      if (key === "config --get remote.upstream.url") {
        return "https://github.com/upstream/muon.git\n";
      }
      throw new Error(`unexpected git command: ${key}`);
    });

    const review = await loadGitHubReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: "/workspace",
        }),
        getGitHubReview,
      },
      { jobId: "job-1" },
      {
        canonicalize: vi.fn().mockResolvedValue("/real/workspace"),
        git,
        onCredential,
      }
    );

    expect(getGitHubReview).toHaveBeenCalledWith({
      owner: "upstream",
      repo: "muon",
      headOwner: "operator",
      branch: "codex/wave-5",
    });
    expect(onCredential).toHaveBeenCalledWith({
      accessToken: "ghu_rotated_access",
      refreshToken: "ghr_rotated_refresh",
    });
    expect(review).toMatchObject({
      status: "no_pull_request",
      branch: "codex/wave-5",
    });
  });

  it("degrades on detached/non-GitHub workspaces and restricts browser egress", async () => {
    const detached = await loadGitHubReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: "/workspace",
        }),
        getGitHubReview: vi.fn(),
      },
      { jobId: "job-1" },
      {
        canonicalize: vi.fn().mockResolvedValue("/workspace"),
        git: vi.fn(async (_path, args) =>
          args.join(" ") === "branch --show-current"
            ? ""
            : "git@github.com:operator/muon.git"
        ),
      }
    );
    expect(detached).toMatchObject({
      status: "degraded",
      reason: expect.stringMatching(/detached/i),
    });

    expect(
      isAllowedGitHubExternalUrl("https://github.com/login/device")
    ).toBe(true);
    expect(
      isAllowedGitHubExternalUrl("https://github.com/operator/muon/pull/42")
    ).toBe(true);
    expect(
      isAllowedGitHubExternalUrl("https://github.com/operator/muon/issues/42")
    ).toBe(false);
    expect(
      isAllowedGitHubExternalUrl("https://github.com.evil.test/login/device")
    ).toBe(false);
    expect(
      isAllowedGitHubExternalUrl(
        "https://github.com/operator/muon/pull/42?token=secret"
      )
    ).toBe(false);
  });

  it("derives PR creation coordinates and title from the trusted dispatch workspace", async () => {
    const onCredential = vi.fn();
    const authorizeGitHubPullRequest = vi.fn().mockResolvedValue({
      mergeCommit: "abcdef1234567890abcdef1234567890abcdef12",
    });
    const push = vi.fn().mockResolvedValue(undefined);
    const createGitHubPullRequest = vi.fn().mockResolvedValue({
      operation: "created",
      review: {
        status: "available",
        repository: { owner: "upstream", repo: "muon" },
        branch: "codex/wave-5",
        pullRequest: {
          number: 42,
          title: "Trusted commit subject",
          url: "https://github.com/upstream/muon/pull/42",
          headSha: "abcdef1234567890",
          draft: false,
          updatedAt: "2026-07-21T12:00:00.000Z",
        },
        checks: {
          state: "none",
          total: 0,
          passed: 0,
          pending: 0,
          failed: 0,
          neutral: 0,
          unavailable: false,
          items: [],
        },
      },
      credential: { accessToken: "test-rotated-access-token" },
    });
    const git = vi.fn(async (_workspacePath: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "codex/wave-5\n";
      if (key === "config --get remote.origin.url") {
        return "git@github.com:operator/muon.git\n";
      }
      if (key === "config --get remote.upstream.url") {
        return "https://github.com/upstream/muon.git\n";
      }
      if (key === "show -s --format=%s HEAD") return "Trusted commit subject\n";
      if (key === "rev-parse HEAD") {
        return "abcdef1234567890abcdef1234567890abcdef12\n";
      }
      throw new Error(`unexpected git command: ${key}`);
    });

    const action = await createWorkspacePullRequest(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: "/workspace",
        }),
        getGitHubReview: vi.fn(),
        authorizeGitHubPullRequest,
        createGitHubPullRequest,
        mergeGitHubPullRequest: vi.fn(),
      },
      { jobId: "job-1" },
      {
        canonicalize: vi.fn().mockResolvedValue("/real/workspace"),
        git,
        push,
        onCredential,
      }
    );

    expect(createGitHubPullRequest).toHaveBeenCalledWith({
      jobId: "job-1",
      owner: "upstream",
      repo: "muon",
      headOwner: "operator",
      branch: "codex/wave-5",
      title: "Trusted commit subject",
      body: "Created from MUON after the governed local merge.",
    });
    expect(authorizeGitHubPullRequest).toHaveBeenCalledWith({
      jobId: "job-1",
      owner: "upstream",
      repo: "muon",
    });
    expect(push).toHaveBeenCalledWith(
      "/real/workspace",
      "abcdef1234567890abcdef1234567890abcdef12",
      "codex/wave-5"
    );
    expect(authorizeGitHubPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0]!
    );
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(
      createGitHubPullRequest.mock.invocationCallOrder[0]!
    );
    expect(onCredential).toHaveBeenCalledWith({
      accessToken: "test-rotated-access-token",
    });
    expect(action).not.toHaveProperty("credential");
  });

  it("forwards the reviewed PR number and exact head SHA for merge", async () => {
    const mergeGitHubPullRequest = vi.fn().mockResolvedValue({
      operation: "merged",
      pullNumber: 42,
      sha: "1234567890abcdef",
      message: "Pull Request successfully merged",
    });
    const git = vi.fn(async (_workspacePath: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "codex/wave-5\n";
      if (key === "config --get remote.origin.url") {
        return "git@github.com:operator/muon.git\n";
      }
      if (key === "config --get remote.upstream.url") return "";
      throw new Error(`unexpected git command: ${key}`);
    });

    const action = await mergeWorkspacePullRequest(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: "/workspace",
        }),
        getGitHubReview: vi.fn(),
        authorizeGitHubPullRequest: vi.fn(),
        createGitHubPullRequest: vi.fn(),
        mergeGitHubPullRequest,
      },
      {
        jobId: "job-1",
        pullNumber: 42,
        expectedHeadSha: "abcdef1234567890",
        method: "squash",
      },
      {
        canonicalize: vi.fn().mockResolvedValue("/real/workspace"),
        git,
      }
    );

    expect(mergeGitHubPullRequest).toHaveBeenCalledWith({
      jobId: "job-1",
      owner: "operator",
      repo: "muon",
      headOwner: "operator",
      branch: "codex/wave-5",
      pullNumber: 42,
      expectedHeadSha: "abcdef1234567890",
      method: "squash",
    });
    expect(action).toEqual({
      operation: "merged",
      pullNumber: 42,
      sha: "1234567890abcdef",
      message: "Pull Request successfully merged",
    });
  });

  it("never pushes when the backend refuses the durable publish gate", async () => {
    const push = vi.fn();
    const createGitHubPullRequest = vi.fn();
    const git = vi.fn(async (_workspacePath: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "codex/wave-5\n";
      if (key === "config --get remote.origin.url") {
        return "git@github.com:operator/muon.git\n";
      }
      if (key === "config --get remote.upstream.url") return "";
      if (key === "show -s --format=%s HEAD") return "Trusted subject\n";
      if (key === "rev-parse HEAD") {
        return "abcdef1234567890abcdef1234567890abcdef12\n";
      }
      throw new Error(`unexpected git command: ${key}`);
    });

    await expect(
      createWorkspacePullRequest(
        {
          getDispatchJob: vi.fn().mockResolvedValue({
            id: "job-1",
            workspacePath: "/workspace",
          }),
          getGitHubReview: vi.fn(),
          authorizeGitHubPullRequest: vi
            .fn()
            .mockRejectedValue(new Error("governed merge gate has not landed")),
          createGitHubPullRequest,
          mergeGitHubPullRequest: vi.fn(),
        },
        { jobId: "job-1" },
        {
          canonicalize: vi.fn().mockResolvedValue("/real/workspace"),
          git,
          push,
        }
      )
    ).rejects.toThrow(/gate has not landed/i);
    expect(push).not.toHaveBeenCalled();
    expect(createGitHubPullRequest).not.toHaveBeenCalled();
  });

  it("refuses to publish later branch commits under an older job's gate", async () => {
    const push = vi.fn();
    const createGitHubPullRequest = vi.fn();
    const git = vi.fn(async (_workspacePath: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "branch --show-current") return "codex/wave-5\n";
      if (key === "config --get remote.origin.url") {
        return "git@github.com:operator/muon.git\n";
      }
      if (key === "config --get remote.upstream.url") return "";
      if (key === "show -s --format=%s HEAD") return "Later commit\n";
      if (key === "rev-parse HEAD") return "f".repeat(40) + "\n";
      throw new Error(`unexpected git command: ${key}`);
    });

    await expect(
      createWorkspacePullRequest(
        {
          getDispatchJob: vi.fn().mockResolvedValue({
            id: "job-1",
            workspacePath: "/workspace",
          }),
          getGitHubReview: vi.fn(),
          authorizeGitHubPullRequest: vi.fn().mockResolvedValue({
            mergeCommit: "a".repeat(40),
          }),
          createGitHubPullRequest,
          mergeGitHubPullRequest: vi.fn(),
        },
        { jobId: "job-1" },
        {
          canonicalize: vi.fn().mockResolvedValue("/real/workspace"),
          git,
          push,
        }
      )
    ).rejects.toThrow(/branch advanced/i);
    expect(push).not.toHaveBeenCalled();
    expect(createGitHubPullRequest).not.toHaveBeenCalled();
  });
});
