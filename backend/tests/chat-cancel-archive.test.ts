import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── Regression: archiving a chat mid-session must never surface a bare 409 ────
//
// The founder's stack trace was `archiveChatAfterStopping` → 409 Conflict
// "Stop every queued or running chat job before archiving." The function DID
// stop the jobs, and the archive still failed, because:
//
//   1. `POST /api/dispatch/:id/interrupt` only TERMINALIZES a queued job. For a
//      RUNNING job it records `interruptRequested` and returns; the runner
//      terminalizes it later, once the vendor has actually drained (up to ~3s
//      for Claude Code, and NEVER if no runner is live). The desktop flow
//      treated its 1.5s settle deadline as permission to "soft-archive anyway"
//      — but the backend never permitted that, so the DELETE hit a precondition
//      that could not yet be true and threw a raw 409 into devtools.
//   2. The stop enumerated the chat's jobs with `?chatId=&limit=200` and NO
//      `latest`, and the route orders `createdAt: asc` — so on a chat with more
//      than 200 rows the window holds the OLDEST 200 (all terminal) and the
//      live job is invisible: never interrupted, and the archive 409s instantly.
//
// These drive the REAL routes through the REAL client (app.inject-backed
// fetcher), so the fix is proven at the same seam the desktop uses.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-chat-cancel";
const AGENT = "agent-token-chat-cancel";

type Db = typeof import("../src/lib/db.js");
type Client = InstanceType<typeof import("@muon/client").MuonApiClient>;

let app: FastifyInstance;
let prisma: Db["prisma"];
let client: Client;
let dataDir: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function makeChat(title: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth(OPERATOR),
    payload: { title, workspacePath: process.cwd() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().chat as { id: string; taskId: string };
}

/** Dispatch a chat-bound root through the real route (leaves it `queued`). */
async function dispatchChatJob(chat: { id: string; taskId: string }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/dispatch",
    headers: auth(OPERATOR),
    payload: {
      kind: "session",
      vendor: "claude-code",
      taskId: chat.taskId,
      chatId: chat.id,
      brief: "orchestrate this chat",
      workspacePath: process.cwd(),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().job.id as string;
}

/** What the runner does once the vendor has actually drained. */
async function runnerTerminalizes(jobId: string) {
  await prisma.dispatchJob.update({
    where: { id: jobId },
    data: {
      status: "interrupted",
      interruptRequested: true,
      endedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-chat-cancel-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  const { MuonApiClient } = await import("@muon/client");
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: parsed.pathname + parsed.search,
      headers: init?.headers
        ? Object.fromEntries(new Headers(init.headers).entries())
        : undefined,
      payload: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      statusText: response.statusMessage ?? "",
      json: async () => response.json(),
    } as Response;
  }) as typeof fetch;
  client = new MuonApiClient("http://localhost", fetcher, OPERATOR);
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("cancel-then-archive (the 409 the founder hit)", () => {
  it("archives a chat whose only job is QUEUED — the interrupt terminalizes it in the same pass", async () => {
    const { stopThenArchiveChat } = await import("@muon/client");
    const chat = await makeChat("queued job archives cleanly");
    const jobId = await dispatchChatJob(chat);

    const result = await stopThenArchiveChat(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });

    expect(result.chat.status).toBe("archived");
    expect(result.cancel.stopped.map((state) => state.jobId)).toEqual([jobId]);
    expect(result.cancel.blocked).toEqual([]);
    // The ledger agrees: the job is terminal, not merely flagged.
    expect(
      await prisma.dispatchJob.findUnique({ where: { id: jobId } })
    ).toMatchObject({ status: "interrupted", interruptRequested: true });
  });

  it("REGRESSION: a RUNNING job blocks the archive with a named job, never a raw 409", async () => {
    const { ChatStopBlockedError, stopThenArchiveChat } = await import(
      "@muon/client"
    );
    const chat = await makeChat("running job blocks archive");
    const jobId = await dispatchChatJob(chat);
    // The runner claimed it: interrupt can now only REQUEST a stop.
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: { status: "running", startedAt: new Date() },
    });

    const failure = await stopThenArchiveChat(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatStopBlockedError);
    const message = (failure as Error).message;
    // The human is told WHICH job and WHY — and never sees the bare status line.
    expect(message).toContain(jobId.slice(0, 8));
    expect(message).toContain("claude-code");
    expect(message).toContain("running");
    expect(message).not.toMatch(/^409\b/);
    // Fail-closed: the stop was still requested, and the chat stays usable.
    expect(
      await prisma.dispatchJob.findUnique({ where: { id: jobId } })
    ).toMatchObject({ status: "running", interruptRequested: true });
    expect(
      await prisma.orchestratorChat.findUnique({ where: { id: chat.id } })
    ).toMatchObject({ status: "active" });

    // Once the runner drains the vendor and terminalizes the row, the SAME call
    // archives: the precondition is genuinely satisfied, not worked around.
    await runnerTerminalizes(jobId);
    const archived = await stopThenArchiveChat(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });
    expect(archived.chat.status).toBe("archived");
  });

  it("REGRESSION: finds the live job on a chat with more than 200 rows of history", async () => {
    const { cancelChatJobs, listActiveChatJobs } = await import("@muon/client");
    const chat = await makeChat("long history hides live work");
    // 220 terminal rows created BEFORE the live one, so an oldest-first page of
    // 200 sees nothing live at all.
    await prisma.dispatchJob.createMany({
      data: Array.from({ length: 220 }, (_, index) => ({
        kind: "task",
        vendor: "codex",
        taskId: chat.taskId,
        chatId: chat.id,
        brief: `history ${index}`,
        status: "done",
        dispatchedBy: "orchestrator",
      })),
    });
    const liveJobId = await dispatchChatJob(chat);

    // The naive read the old flow used cannot see it…
    const oldestWindow = await client.listDispatchJobs({
      chatId: chat.id,
      limit: 200,
    });
    expect(
      oldestWindow.some((job) => job.id === liveJobId)
    ).toBe(false);
    // …the status-scoped read the precondition mirrors always can.
    expect(
      (await listActiveChatJobs(client, chat.id)).map((job) => job.id)
    ).toEqual([liveJobId]);

    const cancelled = await cancelChatJobs(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });
    expect(cancelled.stopped.map((state) => state.jobId)).toEqual([liveJobId]);
    expect(cancelled.blocked).toEqual([]);
  });

  it("cancel leaves the chat usable and is safe to press twice", async () => {
    const { cancelChatJobs } = await import("@muon/client");
    const chat = await makeChat("cancel is not archive");
    const jobId = await dispatchChatJob(chat);

    const first = await cancelChatJobs(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });
    expect(first.found).toBe(1);
    expect(first.requested).toBe(1);
    expect(first.stopped.map((state) => state.jobId)).toEqual([jobId]);

    // Idempotent: nothing left to stop, no second act, no error.
    const second = await cancelChatJobs(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });
    expect(second.found).toBe(0);
    expect(second.requested).toBe(0);
    expect(second.blocked).toEqual([]);

    // The chat itself is untouched — cancel is not archive and not delete.
    const after = await prisma.orchestratorChat.findUnique({
      where: { id: chat.id },
    });
    expect(after).toMatchObject({ status: "active" });
    // And it can take new work immediately.
    expect(await dispatchChatJob(chat)).toBeTruthy();
  });

  it("cancels the whole delegated subtree, not just the root", async () => {
    const { cancelChatJobs } = await import("@muon/client");
    const chat = await makeChat("subtree cancel");
    const rootId = await dispatchChatJob(chat);
    // A delegated child inherits chatId, so it is inside the precondition's set.
    const child = await prisma.dispatchJob.create({
      data: {
        kind: "task",
        vendor: "codex",
        taskId: chat.taskId,
        chatId: chat.id,
        brief: "delegated worker",
        status: "queued",
        parentJobId: rootId,
        rootJobId: rootId,
        dispatchedBy: "orchestrator",
      },
    });

    const result = await cancelChatJobs(client, chat.id, {
      settleMs: 0,
      probeRunner: false,
    });
    expect(result.stopped.map((state) => state.jobId).sort()).toEqual(
      [rootId, child.id].sort()
    );
    expect(
      await prisma.dispatchJob.findUnique({ where: { id: child.id } })
    ).toMatchObject({ status: "interrupted" });
  });
});

describe("the archive precondition still refuses — it just says why", () => {
  it("names the blocking jobs in the 409 instead of a bare status line", async () => {
    const chat = await makeChat("409 names the blocker");
    const jobId = await dispatchChatJob(chat);
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: { status: "running" },
    });

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
    });
    expect(blocked.statusCode).toBe(409);
    const message = blocked.json().message as string;
    expect(message).toContain(
      "Stop every queued or running chat job before archiving."
    );
    expect(message).toContain(jobId.slice(0, 8));
    expect(message).toContain("claude-code");
    // Precondition strength is unchanged: nothing was archived.
    expect(
      await prisma.orchestratorChat.findUnique({ where: { id: chat.id } })
    ).toMatchObject({ status: "active" });

    // The PATCH archive path enforces (and explains) exactly the same thing.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: auth(OPERATOR),
      payload: { status: "archived" },
    });
    expect(patched.statusCode).toBe(409);
    expect(patched.json().message as string).toContain(jobId.slice(0, 8));
  });
});
