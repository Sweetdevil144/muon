import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

describe("MuonApiClient GitHub operator surface", () => {
  it("threads device flow, credential custody, and review coordinates without schema leaks", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          configured: true,
          connected: false,
          accessToken: "strip-me",
        })
      )
      .mockResolvedValueOnce(
        response({
          flowId: "73f851f5-17ea-4bfd-aab8-cd2100a1f415",
          userCode: "ABCD-EFGH",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2026-07-21T12:15:00.000Z",
          intervalMs: 5_000,
          deviceCode: "strip-me",
        })
      )
      .mockResolvedValueOnce(
        response({
          status: "connected",
          login: "operator",
          expiresAt: "2026-07-21T20:00:00.000Z",
          credential: {
            accessToken: "ghu_operator_access",
            expiresAt: "2026-07-21T20:00:00.000Z",
            refreshToken: "ghr_operator_refresh",
            refreshExpiresAt: "2027-01-21T12:00:00.000Z",
            login: "operator",
            extraSecret: "strip-me",
          },
          deviceCode: "strip-me",
        })
      )
      .mockResolvedValueOnce(
        response({
          configured: true,
          connected: true,
          login: "operator",
        })
      )
      .mockResolvedValueOnce(
        response({
          review: {
            status: "available",
            repository: { owner: "muon", repo: "muon" },
            branch: "codex/wave-5",
            pullRequest: {
              number: 42,
              title: "Ship GitHub review",
              url: "https://github.com/muon/muon/pull/42",
              headSha: "abcdef1234567890",
              author: "operator",
              draft: false,
              updatedAt: "2026-07-21T12:00:00.000Z",
              body: "strip untrusted body",
            },
            checks: {
              state: "success",
              total: 1,
              passed: 1,
              pending: 0,
              failed: 0,
              neutral: 0,
              unavailable: false,
              items: [
                {
                  name: "unit",
                  source: "check-run",
                  state: "success",
                  status: "completed",
                  conclusion: "success",
                  detailsUrl: "https://github.com/muon/muon/actions/runs/1",
                  logs: "strip-me",
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(
        response({ configured: true, connected: false })
      ) as unknown as typeof fetch;
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const status = await client.getGitHubStatus();
    const started = await client.startGitHubDeviceFlow();
    const polled = await client.pollGitHubDeviceFlow(started.flowId);
    await client.setGitHubCredential(
      polled.status === "connected"
        ? polled.credential
        : { accessToken: "ghu_unreachable" }
    );
    const review = await client.getGitHubReview({
      owner: "muon",
      repo: "muon",
      headOwner: "muon-fork",
      branch: "codex/wave-5",
    });
    const disconnected = await client.disconnectGitHub();

    expect(status).not.toHaveProperty("accessToken");
    expect(started).not.toHaveProperty("deviceCode");
    expect(polled).not.toHaveProperty("deviceCode");
    if (polled.status === "connected") {
      expect(polled.credential).not.toHaveProperty("extraSecret");
    }
    expect(review.review).not.toHaveProperty("body");
    if (review.review.status === "available") {
      expect(review.review.pullRequest).not.toHaveProperty("body");
      expect(review.review.checks.items[0]).not.toHaveProperty("logs");
    }
    expect(disconnected.connected).toBe(false);

    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:4000/api/github/device/poll",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
        }),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:4000/api/github/review?owner=muon&repo=muon&branch=codex%2Fwave-5&headOwner=muon-fork",
      expect.anything()
    );
  });

  it("publishes through the governed create and exact-head merge contracts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          authorized: true,
          mergeCommit: "abcdef1234567890abcdef1234567890abcdef12",
          credential: {
            accessToken: "test-preflight-rotated-access-token",
            extraSecret: "strip-me",
          },
          secret: "strip-me",
        })
      )
      .mockResolvedValueOnce(
        response({
          operation: "created",
          review: {
            status: "available",
            repository: { owner: "muon", repo: "muon" },
            branch: "codex/wave-5",
            pullRequest: {
              number: 42,
              title: "Ship governed publishing",
              url: "https://github.com/muon/muon/pull/42",
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
          upstreamSecret: "strip-me",
        })
      )
      .mockResolvedValueOnce(
        response({
          operation: "merged",
          pullNumber: 42,
          sha: "1234567890abcdef",
          message: "Pull Request successfully merged",
          upstreamSecret: "strip-me",
        })
      ) as unknown as typeof fetch;
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    const authorization = await client.authorizeGitHubPullRequest({
      jobId: "job-landed",
      owner: "muon",
      repo: "muon",
    });
    const created = await client.createGitHubPullRequest({
      jobId: "job-landed",
      owner: "muon",
      repo: "muon",
      headOwner: "operator",
      branch: "codex/wave-5",
      title: "Ship governed publishing",
    });
    const merged = await client.mergeGitHubPullRequest({
      jobId: "job-landed",
      owner: "muon",
      repo: "muon",
      headOwner: "operator",
      branch: "codex/wave-5",
      pullNumber: 42,
      expectedHeadSha: "abcdef1234567890",
      method: "squash",
    });

    expect(created).not.toHaveProperty("upstreamSecret");
    expect(authorization).toEqual({
      mergeCommit: "abcdef1234567890abcdef1234567890abcdef12",
      credential: {
        accessToken: "test-preflight-rotated-access-token",
      },
    });
    expect(created).toHaveProperty(
      "credential.accessToken",
      "test-rotated-access-token"
    );
    expect(merged).not.toHaveProperty("upstreamSecret");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:4000/api/github/pull-request/authorize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
        }),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:4000/api/github/pull-request",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
          headOwner: "operator",
          branch: "codex/wave-5",
          title: "Ship governed publishing",
        }),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:4000/api/github/pull-request/merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
          headOwner: "operator",
          branch: "codex/wave-5",
          pullNumber: 42,
          expectedHeadSha: "abcdef1234567890",
          method: "squash",
        }),
      })
    );
  });
});
