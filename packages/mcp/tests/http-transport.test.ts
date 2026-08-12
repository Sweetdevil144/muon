import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  assertLoopbackHost,
  startLoopbackMcpHttpServer,
  type LoopbackMcpHttpServer,
} from "../src/http-transport.js";

const note = {
  id: "mem-1",
  kind: "decision",
  text: "Use fuzzy palette",
  taskId: null,
  laneId: null,
  modules: [],
  topics: [],
  trust: "medium",
  confirmed: false,
  stale: false,
  status: "active",
  createdBy: "codex",
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

function isAuthProbe(input: string | URL): boolean {
  return (typeof input === "string" ? input : input.toString()).endsWith(
    "/api/auth/session"
  );
}

function agentAuthResponse(): Response {
  return mockResponse({ authenticated: true, tier: "agent", jobScoped: false });
}

describe("assertLoopbackHost", () => {
  it("accepts loopback hosts", () => {
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHost("localhost")).not.toThrow();
    expect(() => assertLoopbackHost("::1")).not.toThrow();
  });

  it("refuses every non-loopback host", () => {
    for (const host of ["0.0.0.0", "192.168.1.5", "example.com", "::"]) {
      expect(() => assertLoopbackHost(host)).toThrow(/loopback only/);
    }
  });
});

describe("startLoopbackMcpHttpServer", () => {
  let running: LoopbackMcpHttpServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("refuses to bind a non-loopback host before opening any socket", async () => {
    await expect(
      startLoopbackMcpHttpServer({ apiBase: "http://localhost:4000", host: "0.0.0.0" })
    ).rejects.toThrow(/loopback only/);
  });

  it("401s every request with no Authorization header, and never touches the tool list", async () => {
    const fetchImpl = vi.fn();
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await fetch(running.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({
      error: "unauthorized",
      message: "Missing or invalid API token.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("round-trips: lists the fixed base tool set and calls memory_search with the presented bearer", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (isAuthProbe(input)) {
        return agentAuthResponse();
      }
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/api/memory/search");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer agent-token-abc"
      );
      return mockResponse({ notes: [note] });
    });

    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: "Bearer agent-token-abc" } },
    });
    const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    // The fixed base (Tier A) set: context + coordination tools only. Never
    // widened to control/orchestrator verbs regardless of the presented token.
    expect(names).toContain("memory_search");
    expect(names).toContain("crew_roles");
    expect(names).not.toContain("dispatch");
    expect(names).not.toContain("fleet_status");
    expect(names).not.toContain("set_fleet");

    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "palette" },
    });
    expect(result.isError).not.toBe(true);
    const memoryCalls = fetchImpl.mock.calls.filter(
      ([input]) => !isAuthProbe(input as string | URL)
    );
    expect(memoryCalls).toHaveLength(1);

    await client.close();
  });

  it("keeps sessions isolated: a second connection with a different token gets its own client", async () => {
    const seenTokens: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (isAuthProbe(_input)) {
        return agentAuthResponse();
      }
      seenTokens.push((init?.headers as Record<string, string>).Authorization);
      return mockResponse({ notes: [] });
    });

    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const token of ["token-one", "token-two"]) {
      const transport = new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      await client.callTool({ name: "memory_search", arguments: { query: "x" } });
      await client.close();
    }

    expect(seenTokens).toEqual(["Bearer token-one", "Bearer token-two"]);
  });

  it("refuses invalid and operator-tier bearers before allocating an MCP session", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(isAuthProbe(input)).toBe(true);
      const token = (init?.headers as Record<string, string>).Authorization;
      if (token === "Bearer operator-token") {
        return mockResponse({ authenticated: true, tier: "operator" });
      }
      return mockResponse({ error: "unauthorized" }, 401);
    });
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const [token, status] of [
      ["invalid-token", 401],
      ["operator-token", 403],
    ] as const) {
      const response = await fetch(running.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(status);
    }
  });

  it("binds a session id to the bearer that initialized it", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (isAuthProbe(input)) {
        return agentAuthResponse();
      }
      return mockResponse({ notes: [] });
    });
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: "Bearer creator-token" } },
    });
    const client = new Client(
      { name: "creator", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();

    const forged = await fetch(running.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer sibling-token",
        "Mcp-Session-Id": transport.sessionId!,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(forged.status).toBe(401);
    await client.close();
  });

  // MCP #6: "localhost" is a NAME the OS resolves at listen() time — an
  // /etc/hosts edit could point it anywhere — so accepting it as the bind
  // host guaranteed the string, not the address. It now normalizes to the
  // loopback literal.
  it("binds the 127.0.0.1 LITERAL when asked for 'localhost'", async () => {
    const fetchImpl = vi.fn();
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      host: "localhost",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(running.host).toBe("127.0.0.1");
    expect(running.url).toContain("http://127.0.0.1:");
  });

  // MCP #5: the registry had no eviction, so abandoned sessions (a
  // crash-looping client that only ever initializes) accumulated until the
  // capacity check answered 429 forever. Idle sessions are swept on every
  // new-session attempt.
  it("evicts an idle session after the TTL, freeing its capacity slot", async () => {
    // Raw fetches, not the SDK client: the SDK opens its standalone SSE GET
    // asynchronously after connect() resolves, which would touch the session
    // AFTER the fake clock advanced and mask the eviction under test.
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (isAuthProbe(input)) {
        return agentAuthResponse();
      }
      return mockResponse({ notes: [] });
    });
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    const init = (id: number) =>
      fetch(running!.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer agent-token-abc",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        }),
      });

    const first = await init(1);
    expect(first.status).toBe(200);
    const staleSessionId = first.headers.get("mcp-session-id");
    expect(staleSessionId).toBeTruthy();
    await first.text();

    // 31 minutes pass with no traffic; a NEW initialize sweeps the table.
    clock += 31 * 60_000;
    const second = await init(2);
    expect(second.status).toBe(200);
    await second.text();

    // The stale session is gone: its id no longer addresses anything.
    const reuse = await fetch(running.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer agent-token-abc",
        "Mcp-Session-Id": staleSessionId!,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(reuse.status).toBe(404);
  });

  it("a session that keeps talking is NOT evicted by the sweep", async () => {
    let clock = 5_000_000;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (isAuthProbe(input)) {
        return agentAuthResponse();
      }
      return mockResponse({ notes: [] });
    });
    running = await startLoopbackMcpHttpServer({
      apiBase: "http://localhost:4000",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: "Bearer agent-token-abc" } },
    });
    const client = new Client(
      { name: "busy-client", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);

    // Traffic every 20 minutes keeps lastSeenAt fresh across two TTL windows.
    for (let i = 0; i < 3; i += 1) {
      clock += 20 * 60_000;
      await client.listTools();
    }
    // A new initialize sweeps — and the busy session survives it.
    clock += 20 * 60_000;
    const second = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: "Bearer agent-token-abc" } },
    });
    const secondClient = new Client(
      { name: "sweeper", version: "0.1.0" },
      { capabilities: {} }
    );
    await secondClient.connect(second);
    await expect(client.listTools()).resolves.toBeTruthy();
    await secondClient.close();
    await client.close();
  });
});
