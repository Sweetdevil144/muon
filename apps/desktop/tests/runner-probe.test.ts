import { describe, expect, it, vi } from "vitest";
import { probeRunnerHost } from "../src/lib/runner-probe.js";
import type { RunnerCoords } from "../src/lib/runner-supervisor.js";

const coords: RunnerCoords = {
  apiBase: "http://127.0.0.1:43123",
  agentToken: "agent-secret",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("probeRunnerHost", () => {
  it("queries the exact host with the agent token and rejects redirects", async () => {
    const host = "desktop-a/b c";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        runner: {
          id: "runner-1",
          host,
          pid: 42,
          status: "online",
          lastSeenAt: "2026-07-13T12:00:00.000Z",
        },
        live: true,
      })
    ) as unknown as typeof fetch;

    await expect(probeRunnerHost(coords, host, 42, fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe("http://127.0.0.1:43123");
    expect(url.pathname).toBe("/api/runner");
    expect(url.searchParams.get("host")).toBe(host);
    expect(url.href).not.toContain(coords.agentToken!);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer agent-secret" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns true only for a live response from the exact requested host", async () => {
    const wrongHost = vi.fn(async () =>
      jsonResponse({
        runner: { host: "desktop-b" },
        live: true,
      })
    ) as unknown as typeof fetch;
    const staleHost = vi.fn(async () =>
      jsonResponse({
        runner: { host: "desktop-a" },
        live: false,
      })
    ) as unknown as typeof fetch;

    await expect(probeRunnerHost(coords, "desktop-a", 42, wrongHost)).resolves.toBe(
      false
    );
    await expect(probeRunnerHost(coords, "desktop-a", 42, staleHost)).resolves.toBe(
      false
    );

    const wrongPid = vi.fn(async () =>
      jsonResponse({
        runner: { host: "desktop-a", pid: 41 },
        live: true,
      })
    ) as unknown as typeof fetch;
    await expect(
      probeRunnerHost(coords, "desktop-a", 42, wrongPid)
    ).resolves.toBe(false);
  });

  it("distinguishes confirmed staleness from redirects, auth failures, invalid payloads, and network outages", async () => {
    const redirected = vi.fn(async () => ({
      ok: true,
      redirected: true,
      json: async () => ({
        runner: { host: "desktop-a" },
        live: true,
      }),
    })) as unknown as typeof fetch;
    const denied = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }, { status: 401 })
    ) as unknown as typeof fetch;
    const invalid = vi.fn(async () =>
      jsonResponse({ runner: { host: "desktop-a" }, live: "yes" })
    ) as unknown as typeof fetch;
    const malformed = vi.fn(async () =>
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    const offline = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    for (const fetchImpl of [
      redirected,
      denied,
      invalid,
      malformed,
      offline,
    ]) {
      await expect(
        probeRunnerHost(coords, "desktop-a", 42, fetchImpl)
      ).rejects.toThrow();
    }
  });

  it("allows a legacy unauthenticated loopback probe but rejects invalid targets", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const legacyFetch = vi.fn(async () =>
      jsonResponse({
        runner: { host: "desktop-a", pid: 42 },
        live: true,
      })
    ) as unknown as typeof fetch;

    await expect(
      probeRunnerHost(
        { apiBase: coords.apiBase },
        "desktop-a",
        42,
        legacyFetch
      )
    ).resolves.toBe(true);
    expect(legacyFetch.mock.calls[0]![1]?.headers).toEqual({});
    await expect(
      probeRunnerHost(coords, "   ", 42, fetchImpl)
    ).resolves.toBe(false);
    await expect(
      probeRunnerHost(coords, "x".repeat(201), 42, fetchImpl)
    ).resolves.toBe(false);
    await expect(
      probeRunnerHost(coords, "desktop-a", 0, fetchImpl)
    ).resolves.toBe(false);
    await expect(
      probeRunnerHost(
        { apiBase: "https://example.com", agentToken: "agent-secret" },
        "desktop-a",
        42,
        fetchImpl
      )
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
