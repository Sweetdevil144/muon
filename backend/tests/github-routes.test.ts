import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGitHubRoutes } from "../src/routes/github.js";

const OPERATOR = "operator-github-route-token";
const AGENT = "agent-github-route-token";
const LANDED_MERGE_COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function buildTieredApp(options: {
  fetcher: typeof fetch;
  now?: () => number;
  authorizePublishedJob?: (
    jobId: string
  ) => Promise<{ mergeCommit: string } | null>;
  recordPublishAudit?: (input: {
    jobId: string;
    operation: "created" | "merged";
    owner: string;
    repo: string;
    branch: string;
    pullNumber: number;
    headSha: string;
  }) => Promise<void>;
}) {
  const app = Fastify();
  await app.register(sensible);
  app.decorateRequest("tier", "operator");
  app.addHook("onRequest", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token === OPERATOR) {
      request.tier = "operator";
      return;
    }
    if (token === AGENT) {
      request.tier = "agent";
      return;
    }
    reply.code(401).send({ error: "unauthorized" });
  });
  await app.register(registerGitHubRoutes, {
    clientId: "Iv1.muon-device-client",
    fetcher: options.fetcher,
    now: options.now,
    authorizePublishedJob:
      options.authorizePublishedJob ??
      (async () => ({ mergeCommit: LANDED_MERGE_COMMIT })),
    recordPublishAudit: options.recordPublishAudit ?? (async () => undefined),
  });
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub operator routes", () => {
  it("returns 403 to the agent tier before any credential or upstream work", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("must not reach GitHub");
    }) as unknown as typeof fetch;
    const app = await buildTieredApp({ fetcher });
    try {
      const requests = [
        app.inject({
          method: "GET",
          url: "/status",
          headers: auth(AGENT),
        }),
        app.inject({
          method: "POST",
          url: "/device/start",
          headers: auth(AGENT),
        }),
        app.inject({
          method: "POST",
          url: "/device/poll",
          headers: auth(AGENT),
          payload: { flowId: "not-even-a-valid-id" },
        }),
        app.inject({
          method: "PUT",
          url: "/credential",
          headers: auth(AGENT),
          payload: { accessToken: "ghu_agent_must_not_set" },
        }),
        app.inject({
          method: "GET",
          url: "/review?owner=muon&repo=muon&branch=codex%2Fwave-5",
          headers: auth(AGENT),
        }),
        app.inject({
          method: "POST",
          url: "/pull-request/authorize",
          headers: auth(AGENT),
          payload: { jobId: "job-1", owner: "muon", repo: "muon" },
        }),
        app.inject({
          method: "POST",
          url: "/pull-request",
          headers: auth(AGENT),
          payload: {
            jobId: "job-1",
            owner: "muon",
            repo: "muon",
            branch: "codex/wave-5",
            title: "Must not publish",
          },
        }),
        app.inject({
          method: "POST",
          url: "/pull-request/merge",
          headers: auth(AGENT),
          payload: {
            jobId: "job-1",
            owner: "muon",
            repo: "muon",
            branch: "codex/wave-5",
            pullNumber: 42,
            expectedHeadSha: "abcdef1",
          },
        }),
        app.inject({
          method: "DELETE",
          url: "/credential",
          headers: auth(AGENT),
        }),
      ];
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([
        403, 403, 403, 403, 403, 403, 403, 403, 403,
      ]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps the device code server-side and exposes a token-free status", async () => {
    let current = Date.parse("2026-07-21T12:00:00.000Z");
    let tokenPolls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return json({
          device_code: "device-code-server-only",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        tokenPolls += 1;
        return tokenPolls === 1
          ? json({ error: "authorization_pending" })
          : json({
              access_token: "test-operator-access-token",
              expires_in: 28_800,
              refresh_token: "test-operator-refresh-token",
              refresh_token_expires_in: 15_897_600,
              token_type: "bearer",
            });
      }
      if (url.endsWith("/user")) {
        return json({ login: "operator" });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;
    const app = await buildTieredApp({
      fetcher,
      now: () => current,
    });
    try {
      const start = await app.inject({
        method: "POST",
        url: "/device/start",
        headers: auth(OPERATOR),
      });
      expect(start.statusCode).toBe(200);
      expect(start.body).toContain("ABCD-EFGH");
      expect(start.body).not.toContain("device-code-server-only");
      expect(start.body).not.toContain("access_token");
      const flowId = start.json().flowId as string;

      const early = await app.inject({
        method: "POST",
        url: "/device/poll",
        headers: auth(OPERATOR),
        payload: { flowId },
      });
      expect(early.json()).toEqual({
        status: "pending",
        retryAfterMs: 5_000,
      });
      expect(tokenPolls).toBe(0);

      current += 5_000;
      const pending = await app.inject({
        method: "POST",
        url: "/device/poll",
        headers: auth(OPERATOR),
        payload: { flowId },
      });
      expect(pending.json()).toEqual({
        status: "pending",
        retryAfterMs: 5_000,
      });

      current += 5_000;
      const connected = await app.inject({
        method: "POST",
        url: "/device/poll",
        headers: auth(OPERATOR),
        payload: { flowId },
      });
      expect(connected.statusCode).toBe(200);
      expect(connected.json()).toMatchObject({
        status: "connected",
        login: "operator",
        credential: {
          accessToken: "test-operator-access-token",
          refreshToken: "test-operator-refresh-token",
        },
      });

      const status = await app.inject({
        method: "GET",
        url: "/status",
        headers: auth(OPERATOR),
      });
      expect(status.json()).toMatchObject({
        configured: true,
        connected: true,
        login: "operator",
      });
      expect(status.body).not.toContain("test-operator-access-token");
      expect(status.body).not.toContain("test-operator-refresh-token");
    } finally {
      await app.close();
    }
  });

  it("refreshes an expiring device credential and returns bounded PR/check evidence", async () => {
    const current = Date.parse("2026-07-21T12:00:00.000Z");
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) {
          expect(String(init?.body)).toContain("grant_type=refresh_token");
          return json({
            access_token: "test-rotated-access-token",
            expires_in: 28_800,
            refresh_token: "test-rotated-refresh-token",
            refresh_token_expires_in: 15_897_600,
            token_type: "bearer",
          });
        }
        expect(
          new Headers(init?.headers).get("authorization")
        ).toBe("Bearer test-rotated-access-token");
        if (url.includes("/pulls?")) {
          return json([
            {
              number: 42,
              title: "Ship governed GitHub review",
              html_url: "https://github.com/muon/muon/pull/42",
              draft: false,
              updated_at: "2026-07-21T11:59:00.000Z",
              user: { login: "operator" },
              head: {
                sha: "abcdef1234567890",
                ref: "codex/wave-5",
              },
            },
          ]);
        }
        if (url.endsWith("/status")) {
          return json({
            state: "success",
            statuses: [
              {
                state: "success",
                context: "lint",
                description: "passed",
                target_url: "https://github.com/muon/muon/actions",
              },
            ],
          });
        }
        if (url.includes("/check-runs?")) {
          return json({
            check_runs: [
              {
                name: "unit",
                status: "completed",
                conclusion: "success",
                details_url: "https://github.com/muon/muon/actions/runs/1",
              },
              {
                name: "integration",
                status: "in_progress",
                conclusion: null,
                details_url: "https://github.com/muon/muon/actions/runs/2",
              },
            ],
          });
        }
        throw new Error(`unexpected GitHub request: ${url}`);
      }
    ) as unknown as typeof fetch;
    const app = await buildTieredApp({
      fetcher,
      now: () => current,
    });
    try {
      const seeded = await app.inject({
        method: "PUT",
        url: "/credential",
        headers: auth(OPERATOR),
        payload: {
          accessToken: "test-expired-access-token",
          expiresAt: "2026-07-21T11:59:00.000Z",
          refreshToken: "test-valid-refresh-token",
          refreshExpiresAt: "2027-01-01T00:00:00.000Z",
          login: "operator",
        },
      });
      expect(seeded.statusCode).toBe(200);

      const review = await app.inject({
        method: "GET",
        url:
          "/review?owner=muon&repo=muon&headOwner=muon&branch=" +
          encodeURIComponent("codex/wave-5"),
        headers: auth(OPERATOR),
      });
      expect(review.statusCode).toBe(200);
      expect(review.json()).toMatchObject({
        review: {
          status: "available",
          pullRequest: {
            number: 42,
            url: "https://github.com/muon/muon/pull/42",
          },
          checks: {
            state: "pending",
            total: 3,
            passed: 2,
            pending: 1,
            failed: 0,
            unavailable: false,
          },
        },
        credential: {
          accessToken: "test-rotated-access-token",
          refreshToken: "test-rotated-refresh-token",
        },
      });
      const safeReview = JSON.stringify(review.json().review);
      expect(safeReview).not.toContain("test-rotated-access-token");
      expect(safeReview).not.toContain("test-rotated-refresh-token");
    } finally {
      await app.close();
    }
  });

  it("refuses every remote publish before GitHub when the exact job has not landed", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("must not reach GitHub");
    }) as unknown as typeof fetch;
    const authorizePublishedJob = vi.fn().mockResolvedValue(null);
    const app = await buildTieredApp({ fetcher, authorizePublishedJob });
    try {
      const create = await app.inject({
        method: "POST",
        url: "/pull-request",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-unlanded",
          owner: "muon",
          repo: "muon",
          branch: "codex/wave-5",
          title: "Must remain local",
        },
      });
      const merge = await app.inject({
        method: "POST",
        url: "/pull-request/merge",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-unlanded",
          owner: "muon",
          repo: "muon",
          branch: "codex/wave-5",
          pullNumber: 42,
          expectedHeadSha: "abcdef1",
        },
      });
      const authorize = await app.inject({
        method: "POST",
        url: "/pull-request/authorize",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-unlanded",
          owner: "muon",
          repo: "muon",
        },
      });

      expect(create.statusCode).toBe(409);
      expect(merge.statusCode).toBe(409);
      expect(authorize.statusCode).toBe(409);
      expect(create.body).toMatch(/governed merge gate lands successfully/i);
      expect(merge.body).toMatch(/governed merge gate lands successfully/i);
      expect(authorizePublishedJob).toHaveBeenNthCalledWith(1, "job-unlanded");
      expect(authorizePublishedJob).toHaveBeenNthCalledWith(2, "job-unlanded");
      expect(authorizePublishedJob).toHaveBeenNthCalledWith(3, "job-unlanded");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("creates a pull request from trusted coordinates after the durable gate", async () => {
    let pullReads = 0;
    const recordPublishAudit = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-publish-access-token"
        );
        if (url.includes("/pulls?") && init?.method === undefined) {
          pullReads += 1;
          return pullReads === 1
            ? json([])
            : json([
                {
                  number: 42,
                  title: "Ship governed publishing",
                  html_url: "https://github.com/muon/muon/pull/42",
                  draft: false,
                  updated_at: "2026-07-21T12:00:00.000Z",
                  user: { login: "operator" },
                  head: { sha: LANDED_MERGE_COMMIT, ref: "codex/wave-5" },
                },
              ]);
        }
        if (url.endsWith("/repos/muon/muon") && init?.method === undefined) {
          return json({ default_branch: "main" });
        }
        if (url.includes("/git/ref/heads/")) {
          return json({ object: { sha: LANDED_MERGE_COMMIT } });
        }
        if (url.endsWith("/repos/muon/muon/pulls") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            title: "Ship governed publishing",
            head: "operator:codex/wave-5",
            base: "main",
            body: "Bound to the landed dispatch.",
          });
          return json({
            number: 42,
            html_url: "https://github.com/muon/muon/pull/42",
          });
        }
        if (url.endsWith("/status")) {
          return json({ state: "success", statuses: [] });
        }
        if (url.includes("/check-runs?")) {
          return json({ check_runs: [] });
        }
        throw new Error(`unexpected GitHub request: ${url}`);
      }
    ) as unknown as typeof fetch;
    const app = await buildTieredApp({ fetcher, recordPublishAudit });
    try {
      await app.inject({
        method: "PUT",
        url: "/credential",
        headers: auth(OPERATOR),
        payload: { accessToken: "test-publish-access-token" },
      });
      const authorized = await app.inject({
        method: "POST",
        url: "/pull-request/authorize",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
        },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.json()).toEqual({
        authorized: true,
        mergeCommit: LANDED_MERGE_COMMIT,
      });
      const response = await app.inject({
        method: "POST",
        url: "/pull-request",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
          headOwner: "operator",
          branch: "codex/wave-5",
          title: "Ship governed publishing",
          body: "Bound to the landed dispatch.",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        operation: "created",
        review: {
          status: "available",
          pullRequest: { number: 42, headSha: LANDED_MERGE_COMMIT },
          checks: { state: "none", unavailable: false },
        },
      });
      expect(pullReads).toBe(2);
      expect(recordPublishAudit).toHaveBeenCalledWith({
        jobId: "job-landed",
        operation: "created",
        owner: "muon",
        repo: "muon",
        branch: "codex/wave-5",
        pullNumber: 42,
        headSha: LANDED_MERGE_COMMIT,
      });
    } finally {
      await app.close();
    }
  });

  it("merges only the reviewed head after re-reading green checks", async () => {
    const recordPublishAudit = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/pulls?")) {
          return json([
            {
              number: 42,
              title: "Ship governed publishing",
              html_url: "https://github.com/muon/muon/pull/42",
              draft: false,
              updated_at: "2026-07-21T12:00:00.000Z",
              user: { login: "operator" },
              head: { sha: LANDED_MERGE_COMMIT, ref: "codex/wave-5" },
            },
          ]);
        }
        if (url.endsWith("/status")) {
          return json({
            state: "success",
            statuses: [
              { state: "success", context: "required", description: "passed" },
            ],
          });
        }
        if (url.includes("/check-runs?")) {
          return json({ check_runs: [] });
        }
        if (url.endsWith("/pulls/42/merge") && init?.method === "PUT") {
          expect(JSON.parse(String(init.body))).toEqual({
            sha: LANDED_MERGE_COMMIT,
            merge_method: "squash",
          });
          return json({
            sha: "1234567890abcdef",
            merged: true,
            message: "Pull Request successfully merged",
          });
        }
        throw new Error(`unexpected GitHub request: ${url}`);
      }
    ) as unknown as typeof fetch;
    const app = await buildTieredApp({ fetcher, recordPublishAudit });
    try {
      await app.inject({
        method: "PUT",
        url: "/credential",
        headers: auth(OPERATOR),
        payload: { accessToken: "test-publish-access-token" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/pull-request/merge",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
          headOwner: "operator",
          branch: "codex/wave-5",
          pullNumber: 42,
          expectedHeadSha: LANDED_MERGE_COMMIT,
          method: "squash",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        operation: "merged",
        pullNumber: 42,
        sha: "1234567890abcdef",
        message: "Pull Request successfully merged",
      });
      expect(recordPublishAudit).toHaveBeenCalledWith({
        jobId: "job-landed",
        operation: "merged",
        owner: "muon",
        repo: "muon",
        branch: "codex/wave-5",
        pullNumber: 42,
        headSha: LANDED_MERGE_COMMIT,
      });
    } finally {
      await app.close();
    }
  });

  it("refuses a changed head before issuing the merge mutation", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pulls?")) {
        return json([
          {
            number: 42,
            title: "Changed since review",
            html_url: "https://github.com/muon/muon/pull/42",
            draft: false,
            updated_at: "2026-07-21T12:00:00.000Z",
            user: { login: "operator" },
            head: { sha: "fedcba9876543210", ref: "codex/wave-5" },
          },
        ]);
      }
      if (url.endsWith("/status")) {
        return json({ state: "success", statuses: [] });
      }
      if (url.includes("/check-runs?")) {
        return json({ check_runs: [] });
      }
      throw new Error(`unexpected GitHub mutation: ${url}`);
    }) as unknown as typeof fetch;
    const app = await buildTieredApp({ fetcher });
    try {
      await app.inject({
        method: "PUT",
        url: "/credential",
        headers: auth(OPERATOR),
        payload: { accessToken: "test-publish-access-token" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/pull-request/merge",
        headers: auth(OPERATOR),
        payload: {
          jobId: "job-landed",
          owner: "muon",
          repo: "muon",
          branch: "codex/wave-5",
          pullNumber: 42,
          expectedHeadSha: "abcdef1234567890",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatch(/head changed after review/i);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
});
