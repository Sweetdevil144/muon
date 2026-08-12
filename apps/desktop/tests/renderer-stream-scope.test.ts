import { describe, expect, it, vi } from "vitest";
import {
  listRendererStreamChunks,
  readRendererJobTerminal,
} from "../src/lib/renderer-stream-scope.js";

describe("listRendererStreamChunks", () => {
  it("reads only the selected chat's durable history", async () => {
    const listStreamChunks = vi.fn(async () => []);
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(),
      listStreamChunks,
    };

    await listRendererStreamChunks(client as never, "chat-a", {
      taskId: "chat-a",
      afterSeq: 4,
      limit: 100,
      latest: true,
    });

    expect(listStreamChunks).toHaveBeenCalledWith({
      taskId: "chat-a",
      afterSeq: 4,
      limit: 100,
      latest: true,
    });
  });

  it("reads an exact dispatch only when it belongs to the selected chat", async () => {
    const listStreamChunks = vi.fn(async () => []);
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-a",
        chatId: "chat-a",
      })),
      listStreamChunks,
    };

    await listRendererStreamChunks(client as never, "chat-a", {
      runId: "job-a",
      afterSeq: 9,
    });

    expect(listStreamChunks).toHaveBeenCalledWith({
      runId: "job-a",
      afterSeq: 9,
    });
  });

  it("returns no bytes for a foreign job or task coordinate", async () => {
    const listStreamChunks = vi.fn(async () => []);
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-b",
        chatId: "chat-b",
      })),
      listStreamChunks,
    };

    await expect(
      listRendererStreamChunks(client as never, "chat-a", {
        runId: "job-b",
      })
    ).resolves.toEqual([]);
    await expect(
      listRendererStreamChunks(client as never, "chat-a", {
        taskId: "chat-b",
      })
    ).resolves.toEqual([]);
    expect(listStreamChunks).not.toHaveBeenCalled();
  });

  it("returns no bytes with no selected chat", async () => {
    const client = {
      getChat: vi.fn(),
      getDispatchJob: vi.fn(),
      listStreamChunks: vi.fn(),
    };

    await expect(
      listRendererStreamChunks(client as never, null, {
        runId: "job-a",
      })
    ).resolves.toEqual([]);
    expect(client.getDispatchJob).not.toHaveBeenCalled();
    expect(client.listStreamChunks).not.toHaveBeenCalled();
  });
});

/**
 * 0038 — the LIVE console read. Operator tier, so it lives in main; chat-bound,
 * like every other renderer-initiated read; and fail-soft, because the viewer
 * must degrade to the recorded stream with a reason rather than reject into a
 * blank pane.
 */
describe("readRendererJobTerminal", () => {
  const VIEW = {
    sessionId: "pty:job:job-a:a1b2c3d4",
    available: true,
    jobStatus: "running",
    frames: [{ seq: 1, data: "hello\r\n" }],
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
  };

  it("reads a job owned by the named chat, carrying the cursor through", async () => {
    const readJobTerminal = vi.fn(async () => VIEW);
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({ id: "job-a", chatId: "chat-a" })),
      readJobTerminal,
    };

    await expect(
      readRendererJobTerminal(client as never, "chat-a", {
        jobId: "job-a",
        afterSeq: 12,
      })
    ).resolves.toEqual({ status: "ok", ...VIEW });
    expect(readJobTerminal).toHaveBeenCalledWith("job-a", { afterSeq: 12 });
  });

  it("refuses another chat's job without saying whether it exists", async () => {
    const readJobTerminal = vi.fn();
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({ id: "job-b", chatId: "chat-b" })),
      readJobTerminal,
    };

    const result = await readRendererJobTerminal(client as never, "chat-a", {
      jobId: "job-b",
    });
    expect(result).toMatchObject({ status: "unavailable", retryable: false });
    expect(readJobTerminal).not.toHaveBeenCalled();
  });

  it("degrades instead of rejecting when the brain is unreachable — and asks again", async () => {
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({ id: "job-a", chatId: "chat-a" })),
      readJobTerminal: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
      }),
    };

    const result = await readRendererJobTerminal(client as never, "chat-a", {
      jobId: "job-a",
    });
    expect(result).toMatchObject({ status: "unavailable", retryable: true });
    if (result.status === "unavailable") {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("does not re-ask a brain that has no such route", async () => {
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({ id: "job-a", chatId: "chat-a" })),
      readJobTerminal: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
    };

    await expect(
      readRendererJobTerminal(client as never, "chat-a", { jobId: "job-a" })
    ).resolves.toMatchObject({ status: "unavailable", retryable: false });
  });

  it("reads nothing with no chat in scope at all", async () => {
    const client = {
      getChat: vi.fn(),
      getDispatchJob: vi.fn(),
      readJobTerminal: vi.fn(),
    };

    await expect(
      readRendererJobTerminal(client as never, null, { jobId: "job-a" })
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(client.getDispatchJob).not.toHaveBeenCalled();
    expect(client.readJobTerminal).not.toHaveBeenCalled();
  });
});
