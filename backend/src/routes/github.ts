import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  GitHubConnectionStatus,
  GitHubCredential,
  GitHubDeviceFlowPoll,
  GitHubDeviceFlowStart,
  GitHubReview,
} from "@muon/client";
import { requireOperator } from "../lib/auth.js";
import { prisma } from "../lib/db.js";
import {
  buildEventAuditStamp,
  ensureEventPrincipals,
  eventAuditData,
} from "../lib/event-audit.js";

const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MAX_PENDING_FLOWS = 8;
const MAX_CHECK_ITEMS = 100;
const REFRESH_EARLY_MS = 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

type Fetcher = typeof fetch;
type Clock = () => number;

const credentialSchema = z.object({
  accessToken: z.string().min(8).max(4_096).refine((value) => !/\s/.test(value)),
  expiresAt: z.string().datetime().optional(),
  refreshToken: z
    .string()
    .min(8)
    .max(4_096)
    .refine((value) => !/\s/.test(value))
    .optional(),
  refreshExpiresAt: z.string().datetime().optional(),
  login: z.string().min(1).max(100).optional(),
});

const deviceStartSchema = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().min(1).max(64),
  verification_uri: z.string().url().max(500),
  expires_in: z.number().int().positive().max(3_600),
  interval: z.number().int().positive().max(120).default(5),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(8).max(4_096).optional(),
  expires_in: z.number().int().positive().max(86_400).optional(),
  refresh_token: z.string().min(8).max(4_096).optional(),
  refresh_token_expires_in: z
    .number()
    .int()
    .positive()
    .max(31_536_000)
    .optional(),
  token_type: z.string().optional(),
  error: z.string().max(100).optional(),
  error_description: z.string().max(500).optional(),
  interval: z.number().int().positive().max(120).optional(),
});

const reviewQuerySchema = z.object({
  owner: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
  repo: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/),
  headOwner: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/)
    .optional(),
  branch: branchNameSchema,
});

const publishBaseSchema = reviewQuerySchema.extend({
  jobId: z.string().min(1).max(200),
});

const publishAuthorizationSchema = reviewQuerySchema
  .pick({ owner: true, repo: true })
  .extend({ jobId: z.string().min(1).max(200) });

const createPullRequestSchema = publishBaseSchema.extend({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(16_000).optional(),
});

const mergePullRequestSchema = publishBaseSchema.extend({
  pullNumber: z.number().int().positive(),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  method: z.enum(["merge", "squash", "rebase"]).default("squash"),
});

const repositorySchema = z.object({
  default_branch: branchNameSchema,
});

const gitReferenceSchema = z.object({
  object: z.object({
    sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  }),
});

const pullRequestMutationSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});

const pullRequestMergeSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  merged: z.boolean(),
  message: z.string().min(1).max(500),
});

const landedMergeExecutionSchema = z.object({
  outcome: z
    .object({
      status: z.literal("merged"),
      mergeCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
    })
    .passthrough(),
});

type PublishedJobBinding = {
  mergeCommit: string;
};

type GitHubPublishAudit = {
  jobId: string;
  operation: "created" | "merged";
  owner: string;
  repo: string;
  branch: string;
  pullNumber: number;
  headSha: string;
};

const pullRequestListSchema = z
  .array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      html_url: z.string().url(),
      draft: z.boolean().default(false),
      updated_at: z.string().datetime(),
      user: z.object({ login: z.string() }).nullable().optional(),
      head: z.object({
        sha: z.string().min(7).max(64),
        ref: z.string(),
      }),
    })
  )
  .max(10);

const combinedStatusSchema = z.object({
  state: z.enum(["error", "failure", "pending", "success"]),
  statuses: z
    .array(
      z.object({
        state: z.enum(["error", "failure", "pending", "success"]),
        context: z.string(),
        description: z.string().nullable().optional(),
        target_url: z.string().url().nullable().optional(),
      })
    )
    .max(100),
});

const checkRunsSchema = z.object({
  check_runs: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["queued", "in_progress", "completed"]),
        conclusion: z.string().nullable().optional(),
        details_url: z.string().url().nullable().optional(),
      })
    )
    .max(100),
});

type PendingDeviceFlow = {
  deviceCode: string;
  expiresAtMs: number;
  intervalMs: number;
  nextPollAtMs: number;
  createdAtMs: number;
};

type GitHubServiceOptions = {
  clientId?: string;
  fetcher?: Fetcher;
  now?: Clock;
  initialCredential?: GitHubCredential;
  authorizePublishedJob?: (
    jobId: string
  ) => Promise<PublishedJobBinding | null>;
  recordPublishAudit?: (input: GitHubPublishAudit) => Promise<void>;
};

class GitHubServiceError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "not_connected"
      | "blocked"
      | "upstream",
    message: string
  ) {
    super(message);
  }
}

function isoAfter(now: number, seconds: number | undefined): string | undefined {
  return seconds === undefined
    ? undefined
    : new Date(now + seconds * 1_000).toISOString();
}

function future(value: string | undefined, now: number): boolean {
  return value === undefined || Date.parse(value) > now;
}

function verifiedGitHubUrl(value: string, path: RegExp): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !path.test(url.pathname)
  ) {
    throw new GitHubServiceError(
      "upstream",
      "GitHub returned an unexpected URL."
    );
  }
  return url.toString();
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubServiceError(
      "upstream",
      "GitHub returned an unreadable response."
    );
  }
}

function githubHeaders(accessToken?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "muon-desktop",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof GitHubServiceError
    ? error.message.slice(0, 500)
    : fallback;
}

function mapServiceError(
  app: FastifyInstance,
  error: unknown
): never {
  if (error instanceof GitHubServiceError) {
    if (error.code === "not_configured") {
      throw app.httpErrors.conflict(error.message);
    }
    if (error.code === "not_connected") {
      throw app.httpErrors.conflict(error.message);
    }
    if (error.code === "blocked") {
      throw app.httpErrors.conflict(error.message);
    }
  }
  throw app.httpErrors.badGateway(
    "GitHub is temporarily unavailable. Try again."
  );
}

async function recordGitHubPublishAudit(
  input: GitHubPublishAudit
): Promise<void> {
  try {
    const approval = await prisma.approvalRequest.findFirst({
      where: {
        jobId: input.jobId,
        kind: "merge",
        status: "approved",
        mergeExecutionStatus: "succeeded",
      },
      orderBy: { decidedAt: "desc" },
      select: { id: true, taskId: true },
    });
    if (!approval) return;
    const actor = "human";
    const stamp = buildEventAuditStamp({
      actor,
      accountable: actor,
      requestId: approval.id,
      payloadDiff: {
        pullRequest: {
          operation: input.operation,
          repository: `${input.owner}/${input.repo}`,
          branch: input.branch,
          number: input.pullNumber,
          headSha: input.headSha,
        },
      },
    });
    await ensureEventPrincipals(stamp, actor, actor);
    await prisma.event.create({
      data: {
        laneId: "muon",
        taskId: approval.taskId,
        kind: `github.pull_request.${input.operation}`,
        message: `pull request #${input.pullNumber} ${input.operation}`,
        metadata: {
          jobId: input.jobId,
          repository: `${input.owner}/${input.repo}`,
          branch: input.branch,
          pullNumber: input.pullNumber,
          headSha: input.headSha,
        },
        ...eventAuditData(stamp),
      },
    });
  } catch (error) {
    console.error(
      `[audit] github.pull_request.${input.operation} failed for ${input.jobId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function createGitHubService(options: GitHubServiceOptions = {}) {
  const clientId =
    options.clientId?.trim() ??
    process.env.MUON_GITHUB_CLIENT_ID?.trim() ??
    "";
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingDeviceFlow>();
  const recordPublishAudit =
    options.recordPublishAudit ?? recordGitHubPublishAudit;
  const authorizePublishedJob =
    options.authorizePublishedJob ??
    (async (jobId: string): Promise<PublishedJobBinding | null> => {
      const approval = await prisma.approvalRequest.findFirst({
        where: {
          jobId,
          kind: "merge",
          status: "approved",
          mergeExecutionStatus: "succeeded",
        },
        orderBy: { decidedAt: "desc" },
        select: { mergeExecution: true },
      });
      const execution = landedMergeExecutionSchema.safeParse(
        approval?.mergeExecution
      );
      return execution.success
        ? { mergeCommit: execution.data.outcome.mergeCommit }
        : null;
    });
  let credential = options.initialCredential
    ? credentialSchema.parse(options.initialCredential)
    : undefined;

  function configured(): boolean {
    return clientId.length >= 8 && clientId.length <= 200;
  }

  function connectionStatus(): GitHubConnectionStatus {
    const current = now();
    const refreshUsable = Boolean(
      credential?.refreshToken &&
        future(credential.refreshExpiresAt, current) &&
        configured()
    );
    const accessUsable = Boolean(
      credential && future(credential.expiresAt, current)
    );
    return {
      configured: configured(),
      connected: accessUsable || refreshUsable,
      ...(credential?.login ? { login: credential.login } : {}),
      ...(credential?.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    };
  }

  function setCredential(next: GitHubCredential): GitHubConnectionStatus {
    credential = credentialSchema.parse(next);
    return connectionStatus();
  }

  function disconnect(): GitHubConnectionStatus {
    credential = undefined;
    pending.clear();
    return connectionStatus();
  }

  function cleanupPending(): void {
    const current = now();
    for (const [id, flow] of pending) {
      if (flow.expiresAtMs <= current) {
        pending.delete(id);
      }
    }
  }

  async function tokenExchange(
    params: URLSearchParams
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    const response = await fetcher(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "muon-desktop",
      },
      body: params,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new GitHubServiceError(
        "upstream",
        "GitHub rejected the authorization exchange."
      );
    }
    return tokenResponseSchema.parse(await responseJson(response));
  }

  async function readLogin(accessToken: string): Promise<string | undefined> {
    try {
      const response = await fetcher(`${GITHUB_API_URL}/user`, {
        headers: githubHeaders(accessToken),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return undefined;
      }
      return z
        .object({ login: z.string().min(1).max(100) })
        .parse(await responseJson(response)).login;
    } catch {
      return undefined;
    }
  }

  async function startDeviceFlow(): Promise<GitHubDeviceFlowStart> {
    if (!configured()) {
      throw new GitHubServiceError(
        "not_configured",
        "GitHub connection is unavailable until MUON_GITHUB_CLIENT_ID is configured."
      );
    }
    cleanupPending();
    if (pending.size >= MAX_PENDING_FLOWS) {
      const oldest = [...pending.entries()].sort(
        (left, right) => left[1].createdAtMs - right[1].createdAtMs
      )[0];
      if (oldest) pending.delete(oldest[0]);
    }

    const response = await fetcher(GITHUB_DEVICE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "muon-desktop",
      },
      body: new URLSearchParams({ client_id: clientId }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new GitHubServiceError(
        "upstream",
        "GitHub device authorization could not start."
      );
    }
    const payload = deviceStartSchema.parse(await responseJson(response));
    const current = now();
    const intervalMs = Math.max(5_000, payload.interval * 1_000);
    const expiresAtMs = current + payload.expires_in * 1_000;
    const flowId = randomUUID();
    pending.set(flowId, {
      deviceCode: payload.device_code,
      expiresAtMs,
      intervalMs,
      nextPollAtMs: current + intervalMs,
      createdAtMs: current,
    });
    return {
      flowId,
      userCode: payload.user_code,
      verificationUri: verifiedGitHubUrl(
        payload.verification_uri,
        /^\/login\/device\/?$/
      ),
      expiresAt: new Date(expiresAtMs).toISOString(),
      intervalMs,
    };
  }

  async function pollDeviceFlow(flowId: string): Promise<GitHubDeviceFlowPoll> {
    cleanupPending();
    const flow = pending.get(flowId);
    const current = now();
    if (!flow || flow.expiresAtMs <= current) {
      pending.delete(flowId);
      return {
        status: "expired",
        message: "The GitHub code expired. Start a new connection.",
      };
    }
    if (current < flow.nextPollAtMs) {
      return {
        status: "pending",
        retryAfterMs: Math.max(1_000, flow.nextPollAtMs - current),
      };
    }
    flow.nextPollAtMs = current + flow.intervalMs;

    try {
      const payload = await tokenExchange(
        new URLSearchParams({
          client_id: clientId,
          device_code: flow.deviceCode,
          grant_type: DEVICE_GRANT,
        })
      );
      if (payload.error) {
        if (payload.error === "authorization_pending") {
          return { status: "pending", retryAfterMs: flow.intervalMs };
        }
        if (payload.error === "slow_down") {
          flow.intervalMs = Math.max(
            flow.intervalMs + 5_000,
            (payload.interval ?? 0) * 1_000
          );
          flow.nextPollAtMs = current + flow.intervalMs;
          return { status: "pending", retryAfterMs: flow.intervalMs };
        }
        pending.delete(flowId);
        if (
          payload.error === "expired_token" ||
          payload.error === "token_expired"
        ) {
          return {
            status: "expired",
            message: "The GitHub code expired. Start a new connection.",
          };
        }
        if (payload.error === "access_denied") {
          return {
            status: "denied",
            message: "GitHub authorization was canceled.",
          };
        }
        return {
          status: "error",
          message:
            payload.error === "device_flow_disabled"
              ? "Device flow is not enabled for the configured GitHub App."
              : "GitHub could not complete authorization. Start again.",
        };
      }
      if (!payload.access_token) {
        throw new GitHubServiceError(
          "upstream",
          "GitHub returned no access token."
        );
      }
      const login = await readLogin(payload.access_token);
      const nextCredential: GitHubCredential = {
        accessToken: payload.access_token,
        ...(isoAfter(current, payload.expires_in)
          ? { expiresAt: isoAfter(current, payload.expires_in) }
          : {}),
        ...(payload.refresh_token
          ? { refreshToken: payload.refresh_token }
          : {}),
        ...(isoAfter(current, payload.refresh_token_expires_in)
          ? {
              refreshExpiresAt: isoAfter(
                current,
                payload.refresh_token_expires_in
              ),
            }
          : {}),
        ...(login ? { login } : {}),
      };
      credential = credentialSchema.parse(nextCredential);
      pending.delete(flowId);
      return {
        status: "connected",
        ...(login ? { login } : {}),
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        credential,
      };
    } catch (error) {
      return {
        status: "error",
        message: safeMessage(
          error,
          "GitHub authorization is temporarily unavailable."
        ),
      };
    }
  }

  async function refreshCredential(): Promise<GitHubCredential> {
    const current = now();
    if (
      !credential?.refreshToken ||
      !future(credential.refreshExpiresAt, current) ||
      !configured()
    ) {
      credential = undefined;
      throw new GitHubServiceError(
        "not_connected",
        "Connect GitHub in Setup before reviewing pull requests."
      );
    }
    const payload = await tokenExchange(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      })
    );
    if (payload.error || !payload.access_token) {
      credential = undefined;
      throw new GitHubServiceError(
        "not_connected",
        "The GitHub connection expired. Connect again in Setup."
      );
    }
    credential = credentialSchema.parse({
      accessToken: payload.access_token,
      ...(isoAfter(current, payload.expires_in)
        ? { expiresAt: isoAfter(current, payload.expires_in) }
        : {}),
      refreshToken: payload.refresh_token ?? credential.refreshToken,
      ...(isoAfter(current, payload.refresh_token_expires_in)
        ? {
            refreshExpiresAt: isoAfter(
              current,
              payload.refresh_token_expires_in
            ),
          }
        : credential.refreshExpiresAt
          ? { refreshExpiresAt: credential.refreshExpiresAt }
          : {}),
      ...(credential.login ? { login: credential.login } : {}),
    });
    return credential;
  }

  async function accessCredential(): Promise<{
    credential: GitHubCredential;
    rotated: boolean;
  }> {
    const current = now();
    if (!credential) {
      throw new GitHubServiceError(
        "not_connected",
        "Connect GitHub in Setup before reviewing pull requests."
      );
    }
    if (
      credential.expiresAt === undefined ||
      Date.parse(credential.expiresAt) > current + REFRESH_EARLY_MS
    ) {
      return { credential, rotated: false };
    }
    return { credential: await refreshCredential(), rotated: true };
  }

  async function apiJson(
    path: string,
    accessToken: string
  ): Promise<unknown> {
    const response = await fetcher(`${GITHUB_API_URL}${path}`, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      credential = undefined;
      throw new GitHubServiceError(
        "not_connected",
        "The GitHub connection expired. Connect again in Setup."
      );
    }
    if (!response.ok) {
      throw new GitHubServiceError(
        "upstream",
        "GitHub repository data is unavailable."
      );
    }
    return responseJson(response);
  }

  async function mutateApiJson(
    path: string,
    accessToken: string,
    method: "POST" | "PUT",
    body: unknown
  ): Promise<unknown> {
    const response = await fetcher(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        ...githubHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      credential = undefined;
      throw new GitHubServiceError(
        "not_connected",
        "The GitHub connection expired. Connect again in Setup."
      );
    }
    if (!response.ok) {
      throw new GitHubServiceError(
        response.status === 409 || response.status === 422
          ? "blocked"
          : "upstream",
        response.status === 409 || response.status === 422
          ? "GitHub refused the pull-request operation because the branch or pull request changed. Refresh and try again."
          : "GitHub could not complete the pull-request operation."
      );
    }
    return responseJson(response);
  }

  async function optionalApiJson(
    path: string,
    accessToken: string
  ): Promise<unknown | undefined> {
    try {
      return await apiJson(path, accessToken);
    } catch (error) {
      if (
        error instanceof GitHubServiceError &&
        error.code === "not_connected"
      ) {
        throw error;
      }
      return undefined;
    }
  }

  async function review(
    input: z.infer<typeof reviewQuerySchema>
  ): Promise<{ review: GitHubReview; credential?: GitHubCredential }> {
    const parsed = reviewQuerySchema.parse(input);
    const auth = await accessCredential();
    const headOwner = parsed.headOwner ?? parsed.owner;
    const pulls = pullRequestListSchema.parse(
      await apiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/pulls?state=open&head=${encodeURIComponent(
          `${headOwner}:${parsed.branch}`
        )}&per_page=10`,
        auth.credential.accessToken
      )
    );
    const pull = pulls[0];
    if (!pull) {
      return {
        review: {
          status: "no_pull_request",
          repository: { owner: parsed.owner, repo: parsed.repo },
          branch: parsed.branch,
        },
        ...(auth.rotated ? { credential: auth.credential } : {}),
      };
    }
    const pullUrl = verifiedGitHubUrl(
      pull.html_url,
      new RegExp(
        `^/${parsed.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${parsed.repo.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}/pull/${pull.number}/?$`,
        "i"
      )
    );
    const [statusRaw, checksRaw] = await Promise.all([
      optionalApiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/commits/${encodeURIComponent(pull.head.sha)}/status`,
        auth.credential.accessToken
      ),
      optionalApiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/commits/${encodeURIComponent(
          pull.head.sha
        )}/check-runs?per_page=100`,
        auth.credential.accessToken
      ),
    ]);
    const status = statusRaw
      ? combinedStatusSchema.safeParse(statusRaw)
      : undefined;
    const checkRuns = checksRaw ? checkRunsSchema.safeParse(checksRaw) : undefined;
    const items: Extract<
      GitHubReview,
      { status: "available" }
    >["checks"]["items"] = [];
    if (status?.success) {
      for (const entry of status.data.statuses) {
        items.push({
          name: entry.context.slice(0, 200) || "Commit status",
          source: "status",
          state:
            entry.state === "success"
              ? "success"
              : entry.state === "pending"
                ? "pending"
                : "failure",
          status: entry.state,
          ...(entry.description
            ? { conclusion: entry.description.slice(0, 80) }
            : {}),
          ...(entry.target_url ? { detailsUrl: entry.target_url } : {}),
        });
      }
    }
    if (checkRuns?.success) {
      for (const run of checkRuns.data.check_runs) {
        const conclusion = run.conclusion ?? undefined;
        const state =
          run.status !== "completed" || conclusion === undefined
            ? "pending"
            : conclusion === "success"
              ? "success"
              : conclusion === "neutral" || conclusion === "skipped"
                ? "neutral"
                : "failure";
        items.push({
          name: run.name.slice(0, 200) || "Check run",
          source: "check-run",
          state,
          status: run.status,
          ...(conclusion ? { conclusion: conclusion.slice(0, 80) } : {}),
          ...(run.details_url ? { detailsUrl: run.details_url } : {}),
        });
      }
    }
    const boundedItems = items.slice(0, MAX_CHECK_ITEMS);
    const passed = boundedItems.filter((item) => item.state === "success").length;
    const pendingCount = boundedItems.filter(
      (item) => item.state === "pending"
    ).length;
    const failed = boundedItems.filter((item) => item.state === "failure").length;
    const neutral = boundedItems.filter((item) => item.state === "neutral").length;
    const unavailable = !status?.success && !checkRuns?.success;
    const state =
      unavailable
        ? "unknown"
        : failed > 0
          ? "failure"
          : pendingCount > 0
            ? "pending"
            : boundedItems.length === 0
              ? "none"
              : passed > 0
                ? "success"
                : "neutral";
    return {
      review: {
        status: "available",
        repository: { owner: parsed.owner, repo: parsed.repo },
        branch: parsed.branch,
        pullRequest: {
          number: pull.number,
          title: pull.title.slice(0, 1_000),
          url: pullUrl,
          headSha: pull.head.sha,
          ...(pull.user?.login
            ? { author: pull.user.login.slice(0, 100) }
            : {}),
          draft: pull.draft,
          updatedAt: pull.updated_at,
        },
        checks: {
          state,
          total: boundedItems.length,
          passed,
          pending: pendingCount,
          failed,
          neutral,
          unavailable,
          items: boundedItems,
        },
      },
      ...(auth.rotated ? { credential: auth.credential } : {}),
    };
  }

  async function requirePublishedJob(
    jobId: string
  ): Promise<PublishedJobBinding> {
    const binding = await authorizePublishedJob(jobId);
    if (!binding) {
      throw new GitHubServiceError(
        "blocked",
        "Remote publish is locked until this exact dispatch's governed merge gate lands successfully."
      );
    }
    return binding;
  }

  async function createPullRequest(
    input: z.infer<typeof createPullRequestSchema>
  ) {
    const parsed = createPullRequestSchema.parse(input);
    const binding = await requirePublishedJob(parsed.jobId);
    const existing = await review(parsed);
    if (existing.review.status === "available") {
      return {
        operation: "existing" as const,
        review: existing.review,
        ...(existing.credential ? { credential: existing.credential } : {}),
      };
    }
    if (existing.review.status === "degraded") {
      throw new GitHubServiceError("blocked", existing.review.reason);
    }

    const auth = await accessCredential();
    const repository = repositorySchema.parse(
      await apiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}`,
        auth.credential.accessToken
      )
    );
    if (repository.default_branch === parsed.branch) {
      throw new GitHubServiceError(
        "blocked",
        "The governed branch is the repository default branch, so there is no base branch to open a pull request into."
      );
    }
    const remoteRef = gitReferenceSchema.parse(
      await apiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/git/ref/heads/${encodeURIComponent(parsed.branch)}`,
        auth.credential.accessToken
      )
    );
    if (
      remoteRef.object.sha.toLowerCase() !== binding.mergeCommit.toLowerCase()
    ) {
      throw new GitHubServiceError(
        "blocked",
        "The remote branch does not match this dispatch's governed merge commit. Publish the exact landed commit before creating its pull request."
      );
    }
    const createdPull = pullRequestMutationSchema.parse(
      await mutateApiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/pulls`,
        auth.credential.accessToken,
        "POST",
        {
          title: parsed.title,
          head: `${parsed.headOwner ?? parsed.owner}:${parsed.branch}`,
          base: repository.default_branch,
          ...(parsed.body ? { body: parsed.body } : {}),
        }
      )
    );
    await recordPublishAudit({
      jobId: parsed.jobId,
      operation: "created",
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      pullNumber: createdPull.number,
      headSha: binding.mergeCommit,
    });
    const created = await review(parsed);
    if (created.review.status !== "available") {
      throw new GitHubServiceError(
        "upstream",
        "GitHub accepted the pull request, but MUON could not read it back. Refresh Review before taking another action."
      );
    }
    return {
      operation: "created" as const,
      review: created.review,
      ...(existing.credential
        ? { credential: existing.credential }
        : auth.rotated
          ? { credential: auth.credential }
          : created.credential
            ? { credential: created.credential }
            : {}),
    };
  }

  async function authorizePullRequestPublication(
    input: z.infer<typeof publishAuthorizationSchema>
  ) {
    const parsed = publishAuthorizationSchema.parse(input);
    const binding = await requirePublishedJob(parsed.jobId);
    const auth = await accessCredential();
    repositorySchema.parse(
      await apiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}`,
        auth.credential.accessToken
      )
    );
    return {
      authorized: true as const,
      mergeCommit: binding.mergeCommit,
      ...(auth.rotated ? { credential: auth.credential } : {}),
    };
  }

  async function mergePullRequest(
    input: z.infer<typeof mergePullRequestSchema>
  ) {
    const parsed = mergePullRequestSchema.parse(input);
    const binding = await requirePublishedJob(parsed.jobId);
    const current = await review(parsed);
    if (current.review.status !== "available") {
      throw new GitHubServiceError(
        "blocked",
        "The pull request is no longer open. Refresh Review before merging."
      );
    }
    const pull = current.review.pullRequest;
    if (
      pull.number !== parsed.pullNumber ||
      pull.headSha.toLowerCase() !== parsed.expectedHeadSha.toLowerCase() ||
      pull.headSha.toLowerCase() !== binding.mergeCommit.toLowerCase()
    ) {
      throw new GitHubServiceError(
        "blocked",
        "The pull request head changed after review. Refresh checks and review the new head before merging."
      );
    }
    if (pull.draft) {
      throw new GitHubServiceError(
        "blocked",
        "Draft pull requests cannot be merged from MUON. Mark it ready for review first."
      );
    }
    if (
      current.review.checks.unavailable ||
      !["success", "none"].includes(current.review.checks.state)
    ) {
      throw new GitHubServiceError(
        "blocked",
        "Required pull-request checks are not green. Refresh and resolve pending or failed checks before merging."
      );
    }
    const auth = await accessCredential();
    const merged = pullRequestMergeSchema.parse(
      await mutateApiJson(
        `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
          parsed.repo
        )}/pulls/${parsed.pullNumber}/merge`,
        auth.credential.accessToken,
        "PUT",
        { sha: parsed.expectedHeadSha, merge_method: parsed.method }
      )
    );
    if (!merged.merged) {
      throw new GitHubServiceError("blocked", merged.message);
    }
    await recordPublishAudit({
      jobId: parsed.jobId,
      operation: "merged",
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      pullNumber: parsed.pullNumber,
      headSha: parsed.expectedHeadSha,
    });
    return {
      operation: "merged" as const,
      pullNumber: parsed.pullNumber,
      sha: merged.sha,
      message: merged.message,
      ...(current.credential
        ? { credential: current.credential }
        : auth.rotated
          ? { credential: auth.credential }
          : {}),
    };
  }

  return {
    connectionStatus,
    disconnect,
    pollDeviceFlow,
    authorizePullRequestPublication,
    createPullRequest,
    mergePullRequest,
    review,
    setCredential,
    startDeviceFlow,
  };
}

export function registerGitHubRoutes(
  app: FastifyInstance,
  options: GitHubServiceOptions = {}
) {
  const service = createGitHubService(options);

  app.get("/status", (request) => {
    requireOperator(app, request);
    return service.connectionStatus();
  });

  app.post("/device/start", async (request) => {
    requireOperator(app, request);
    try {
      return await service.startDeviceFlow();
    } catch (error) {
      mapServiceError(app, error);
    }
  });

  app.post("/device/poll", async (request) => {
    requireOperator(app, request);
    const { flowId } = z
      .object({ flowId: z.string().uuid() })
      .parse(request.body);
    return service.pollDeviceFlow(flowId);
  });

  app.put("/credential", (request) => {
    requireOperator(app, request);
    return service.setCredential(credentialSchema.parse(request.body));
  });

  app.delete("/credential", (request) => {
    requireOperator(app, request);
    return service.disconnect();
  });

  app.get("/review", async (request: FastifyRequest) => {
    requireOperator(app, request);
    const query = reviewQuerySchema.parse(request.query);
    try {
      return await service.review(query);
    } catch (error) {
      return {
        review: {
          status: "degraded" as const,
          reason: safeMessage(
            error,
            "GitHub pull-request evidence is temporarily unavailable."
          ),
          action:
            error instanceof GitHubServiceError &&
            error.code === "not_connected"
              ? "Connect GitHub in Setup."
              : "Retry from the Review panel.",
        },
      };
    }
  });

  app.post("/pull-request/authorize", async (request) => {
    requireOperator(app, request);
    const input = publishAuthorizationSchema.parse(request.body);
    try {
      return await service.authorizePullRequestPublication(input);
    } catch (error) {
      mapServiceError(app, error);
    }
  });

  app.post("/pull-request", async (request) => {
    requireOperator(app, request);
    const input = createPullRequestSchema.parse(request.body);
    try {
      return await service.createPullRequest(input);
    } catch (error) {
      mapServiceError(app, error);
    }
  });

  app.post("/pull-request/merge", async (request) => {
    requireOperator(app, request);
    const input = mergePullRequestSchema.parse(request.body);
    try {
      return await service.mergePullRequest(input);
    } catch (error) {
      mapServiceError(app, error);
    }
  });
}
