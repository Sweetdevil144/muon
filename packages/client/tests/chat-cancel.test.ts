import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";
import {
  cancelChatJobs,
  describeChatStopBlockers,
  summarizeChatCancel,
  type CancelChatJobsResult,
} from "../src/api-client.js";

// ── The shared chat-level cancel ─────────────────────────────────────────────
//
// Two properties are load-bearing and are pinned here:
//
//  1. It enumerates a chat's live work the way the archive precondition COUNTS
//     it — `?chatId=&status=queued|running`, newest-first — not by paging the
//     chat's job history. `GET /api/dispatch` caps `limit` at 200 and defaults
//     to `createdAt: asc`, so a history page on a busy chat can contain no live
//     job at all, and the stop then silently misses it.
//  2. It only ever calls a job stopped when the ledger showed it leave the
//     queued/running set. An accepted interrupt is NOT a stopped job: for a
//     running job the backend records the request and the runner terminalizes
//     it later (or never, with no runner live).

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Conflict",
    json: async () => payload,
  } as Response;
}

function jobRow(id: string, status: string, vendor = "claude-code") {
  return {
    id,
    kind: "session",
    vendor,
    taskId: "task-1",
    brief: "work",
    chatId: "chat-1",
    status,
    dispatchedBy: "operator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

/** A fake control plane: one in-memory ledger behind the real client. */
function harness(rows: ReturnType<typeof jobRow>[]) {
  const ledger = new Map(rows.map((row) => [row.id, { ...row }]));
  const urls: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    urls.push(parsed.pathname + parsed.search);
    const interrupt = parsed.pathname.match(
      /^\/api\/dispatch\/([^/]+)\/interrupt$/
    );
    if (interrupt && init?.method === "POST") {
      const row = ledger.get(interrupt[1]!);
      if (!row) return mockResponse({ message: "gone" }, 404);
      row.interruptRequested = true;
      if (row.status === "queued") row.status = "interrupted";
      return mockResponse({ job: row });
    }
    if (parsed.pathname === "/api/dispatch") {
      const status = parsed.searchParams.get("status");
      const chatId = parsed.searchParams.get("chatId");
      const jobs = [...ledger.values()].filter(
        (row) =>
          (!chatId || row.chatId === chatId) &&
          (!status || row.status === status)
      );
      return mockResponse({ jobs });
    }
    if (parsed.pathname === "/api/runner") {
      return mockResponse({ runner: null, live: false });
    }
    throw new Error(`unexpected request: ${parsed.pathname}`);
  }) as unknown as typeof fetch;
  const client = new MuonApiClient("http://localhost:4000", fetcher, "op-token");
  return { client, ledger, urls };
}

describe("cancelChatJobs", () => {
  it("reads the SAME set the archive precondition counts (status-scoped, newest first)", async () => {
    const { client, urls } = harness([jobRow("root", "queued")]);

    await cancelChatJobs(client, "chat-1", {
      settleMs: 0,
      probeRunner: false,
    });

    expect(urls).toContain(
      "/api/dispatch?status=queued&chatId=chat-1&latest=true&limit=200"
    );
    expect(urls).toContain(
      "/api/dispatch?status=running&chatId=chat-1&latest=true&limit=200"
    );
    // The history read that exists only for per-job UI teardown asks for the
    // NEWEST rows, never the oldest page.
    expect(urls).toContain("/api/dispatch?chatId=chat-1&latest=true&limit=200");
  });

  it("stops queued work and reports it verified-stopped", async () => {
    const { client, ledger } = harness([
      jobRow("root", "queued"),
      jobRow("child", "queued", "codex"),
      jobRow("old", "done"),
    ]);

    const result = await cancelChatJobs(client, "chat-1", {
      settleMs: 0,
      probeRunner: false,
    });

    expect(result.found).toBe(2);
    expect(result.requested).toBe(2);
    expect(result.blocked).toEqual([]);
    expect(result.stopped.map((state) => state.jobId).sort()).toEqual([
      "child",
      "root",
    ]);
    expect(ledger.get("old")?.status).toBe("done");
    expect(summarizeChatCancel(result)).toBe("Stopped 2 jobs in this chat.");
  });

  it("does NOT call a running job stopped just because the interrupt was accepted", async () => {
    const { client, ledger } = harness([jobRow("live", "running")]);

    const result = await cancelChatJobs(client, "chat-1", { settleMs: 0 });

    expect(result.stopped).toEqual([]);
    expect(result.blocked).toEqual([
      {
        jobId: "live",
        vendor: "claude-code",
        status: "running",
        reason: "stopping",
      },
    ]);
    // The request IS on the ledger — the job just is not terminal yet.
    expect(ledger.get("live")?.interruptRequested).toBe(true);
    expect(result.runnerLive).toBe(false);
    expect(describeChatStopBlockers(result)).toContain("No runner is online");
  });

  it("keeps polling within the settle window and reports the drained job", async () => {
    const { client, ledger } = harness([jobRow("live", "running")]);
    let clock = 0;

    const result = await cancelChatJobs(client, "chat-1", {
      settleMs: 500,
      pollMs: 50,
      now: () => clock,
      // The "runner" finishes draining the vendor during the settle window.
      sleep: async () => {
        clock += 50;
        const row = ledger.get("live")!;
        row.status = "interrupted";
      },
      probeRunner: false,
    });

    expect(result.blocked).toEqual([]);
    expect(result.stopped.map((state) => state.jobId)).toEqual(["live"]);
  });

  it("has nothing to summarize for an idle chat", () => {
    const idle: CancelChatJobsResult = {
      chatId: "chat-1",
      found: 0,
      requested: 0,
      stopped: [],
      blocked: [],
      observedJobIds: [],
      runnerLive: null,
    };
    expect(describeChatStopBlockers(idle)).toBeNull();
    expect(summarizeChatCancel(idle)).toMatch(/Nothing to stop/);
  });
});
