import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

// ── ADR-0028 Tier C: attach/heartbeat/detach client method shapes ───────────
//
// These are pure request/response-shape tests against a mocked fetcher — no
// real HTTP, no real backend. They pin the request URL/method/body/headers
// and the parsed return shape, matching the pattern already used throughout
// api-client.test.ts.

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

function minimalJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-attached-root",
    kind: "attached-coordinator",
    vendor: "codex",
    taskId: "task-1",
    brief: "attached coordinator root",
    status: "running",
    dispatchedBy: "operator",
    interruptRequested: false,
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function minimalChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chat-attached",
    title: "Attached session",
    workspacePath: "/repo",
    status: "active",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("MuonApiClient ADR-0028 Tier C methods", () => {
  it("attachCoordinator: POSTs to /api/dispatch/attached with the operator bearer, and parses job/chat/capability/attestation", async () => {
    const payload = {
      job: minimalJob(),
      chat: minimalChat(),
      capability: {
        token: "c".repeat(64),
        expiresAt: "2026-08-02T00:05:00.000Z",
      },
      attestation: {
        posture: "non-hermetic",
        claim: "external, human-started session",
      },
    };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    const client = new MuonApiClient(
      "http://localhost:4000",
      fetcher,
      "operator-token"
    );

    const result = await client.attachCoordinator({
      vendor: "codex",
      chatId: "chat-attached",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/attached",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ vendor: "codex", chatId: "chat-attached" }),
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
          "Content-Type": "application/json",
        }),
      })
    );
    expect(result.job.id).toBe("job-attached-root");
    expect(result.chat.id).toBe("chat-attached");
    expect(result.capability).toEqual(payload.capability);
    expect(result.attestation).toEqual(payload.attestation);
  });

  it("attachCoordinator: rejects a capability token shorter than the schema's floor", async () => {
    const payload = {
      job: minimalJob(),
      chat: minimalChat(),
      capability: { token: "too-short", expiresAt: "2026-08-02T00:05:00.000Z" },
      attestation: { posture: "non-hermetic", claim: "x" },
    };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    const client = new MuonApiClient("http://localhost:4000", fetcher, "operator-token");

    await expect(
      client.attachCoordinator({ vendor: "codex", chatId: "chat-attached" })
    ).rejects.toThrow();
  });

  it("heartbeatAttachedCoordinator: POSTs to the exact-job heartbeat route with the JOB bearer (never the operator token)", async () => {
    const payload = { job: minimalJob(), expiresAt: "2026-08-02T00:10:00.000Z" };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    // Constructed with the CAPABILITY token, exactly as
    // packages/mcp/src/index.ts's runAttachedCoordinator() does — never the
    // operator token attachCoordinator used.
    const client = new MuonApiClient(
      "http://localhost:4000",
      fetcher,
      "capability-token"
    );

    const result = await client.heartbeatAttachedCoordinator("job-attached-root");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/attached/job-attached-root/heartbeat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer capability-token",
        }),
      })
    );
    expect(result.job.id).toBe("job-attached-root");
    expect(result.expiresAt).toBe("2026-08-02T00:10:00.000Z");
  });

  it("heartbeatAttachedCoordinator: URL-encodes a jobId with special characters", async () => {
    const payload = { job: minimalJob({ id: "job/with space" }), expiresAt: "2026-08-02T00:10:00.000Z" };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    const client = new MuonApiClient("http://localhost:4000", fetcher, "capability-token");

    await client.heartbeatAttachedCoordinator("job/with space");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/attached/job%2Fwith%20space/heartbeat",
      expect.anything()
    );
  });

  it("detachCoordinator: DELETEs the exact-job route with the operator bearer, and parses {detached, jobId}", async () => {
    const payload = { detached: true, jobId: "job-attached-root" };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    const client = new MuonApiClient(
      "http://localhost:4000",
      fetcher,
      "operator-token"
    );

    const result = await client.detachCoordinator("job-attached-root");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/attached/job-attached-root",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
        }),
      })
    );
    expect(result).toEqual(payload);
  });
});
