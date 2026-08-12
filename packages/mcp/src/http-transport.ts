/**
 * ROADMAP P14 — loopback-only Streamable HTTP/SSE transport for the MUON MCP
 * server. A companion listener (a separate opt-in binary, `http.ts`/
 * `muon-mcp-http`), never the stdio path's default. See
 * `docs/design/muon-mcp-external-coordinator.md` for why this is loopback +
 * existing-token-tier only, never OAuth-to-cloud.
 *
 * Three invariants this file enforces, all fail-closed:
 *
 * 1. LOOPBACK ONLY. `assertLoopbackHost` refuses to construct a listener bound
 *    to anything but 127.0.0.1 / ::1 / localhost, and the check runs BEFORE
 *    `listen()` — never a bind-then-check race.
 * 2. NO VALID AGENT TOKEN, NO SESSION. Every request (not just `initialize`)
 *    must present an AGENT-tier bearer that the control plane validates, or
 *    the request is refused before it reaches an MCP transport. Sessions are
 *    bound to the digest of the bearer that created them. There is no anonymous
 *    fallback, unlike stdio's `resolveMcpApiToken()`, which is allowed to run
 *    unauthenticated locally because a hand-registered vendor CLI has no
 *    network exposure at all — this transport does, so it never runs bare.
 * 3. NEVER OPERATOR-ON-MCP. A session created over this transport
 *    ALWAYS gets `createToolDefinitions(client, {})` — the same fixed base
 *    (context + coordination) tool list an unset-`MUON_MCP_MODE` stdio
 *    session gets. The presented bearer decides ONLY whether the client's
 *    calls to the control plane succeed; it never selects orchestrator or
 *    delegate mode. Operator-tier credentials are refused rather than
 *    downgraded, so human authority never enters an MCP process accidentally.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MuonApiClient } from "@muon/client";
import { createToolDefinitions, type ToolDefinition } from "./handlers.js";
import { buildMuonServer } from "./server-factory.js";

/** The only ADDRESSES this transport will ever bind. Positive list — never a
 *  "reject known-bad" filter, which a new hostname alias could slip past.
 *  Deliberately LITERALS only: "localhost" is a NAME the OS resolves at
 *  `listen()` time (an /etc/hosts edit or a resolver could point it anywhere),
 *  so accepting it guaranteed the host STRING, not the bound address. It is
 *  normalized to 127.0.0.1 below instead of refused, so existing callers keep
 *  working while the socket is pinned to a loopback literal. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

export function assertLoopbackHost(host: string): void {
  const cleaned = host.trim().toLowerCase();
  if (cleaned !== "localhost" && !LOOPBACK_ADDRESSES.has(cleaned)) {
    throw new Error(
      `muon-mcp HTTP transport refuses to bind '${host}': loopback only ` +
        "(127.0.0.1 / ::1 / localhost). This transport carries an agent/job " +
        "bearer over plain HTTP; it must never be reachable off-host."
    );
  }
}

/** The literal loopback address a caller-supplied host actually binds. */
export function loopbackBindAddress(host: string): string {
  assertLoopbackHost(host);
  const cleaned = host.trim().toLowerCase();
  return cleaned === "localhost" ? "127.0.0.1" : cleaned;
}

/** Minimal, local bearer-header parse. Deliberately NOT imported from the
 *  backend (a separate deployable) — this is the same three-line extraction
 *  as `backend/src/lib/auth.ts:bearerToken`, kept in sync by inspection
 *  rather than a cross-package dependency the backend does not otherwise
 *  need. */
function bearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_HTTP_SESSIONS = 32;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

type McpSession = {
  transport: StreamableHTTPServerTransport;
  tokenDigest: Buffer;
  /** Last time a request touched this session; drives idle eviction. */
  lastSeenAt: number;
};

type McpSessionRegistry = {
  sessions: Map<string, McpSession>;
  pendingInitializations: number;
  now: () => number;
};

/**
 * Idle TTL. The registry had NO eviction: a session only left it via an
 * explicit DELETE or a transport close, so 32 abandoned initializes (a
 * crash-looping client, a curl script) filled the capacity table and the
 * listener answered 429 forever. Idle sessions are swept on every
 * new-session attempt — before the capacity check, so an abandoned session
 * can never wedge a live one out.
 */
export const MCP_HTTP_SESSION_IDLE_MS = 30 * 60_000;

function evictIdleSessions(registry: McpSessionRegistry): void {
  const cutoff = registry.now() - MCP_HTTP_SESSION_IDLE_MS;
  for (const [sid, session] of registry.sessions) {
    if (session.lastSeenAt < cutoff) {
      registry.sessions.delete(sid);
      // Close AFTER unmapping so the transport's own onclose delete is a no-op.
      void session.transport.close().catch(() => undefined);
    }
  }
}

export type LoopbackMcpHttpServerOptions = {
  /** The MUON control-plane base this transport forwards tool calls to — the
   *  same value `resolveApiBase()` gives the stdio binary. */
  apiBase: string;
  /** Bind host. MUST be loopback (127.0.0.1 / ::1 / localhost); anything else
   *  throws before `listen()` is ever called. Defaults to "127.0.0.1". */
  host?: string;
  /** Bind port. 0 (default) asks the OS for an ephemeral port. */
  port?: number;
  /** URL path this transport answers on. Default "/mcp". */
  path?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the idle-eviction tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Injectable tool-definition factory for tests. Defaults to
   * `createToolDefinitions(client, {})` — the fixed base (context +
   * coordination) tool set. Overriding this is a TEST-ONLY escape hatch;
   * production callers must never widen it (see the file header).
   */
  createTools?: (client: MuonApiClient) => ToolDefinition[];
};

export type LoopbackMcpHttpServer = {
  readonly server: NodeHttpServer;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    error: "unauthorized",
    message: "Missing or invalid API token.",
  });
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function sessionTokenMatches(session: McpSession, token: string): boolean {
  const presented = tokenDigest(token);
  return (
    presented.length === session.tokenDigest.length &&
    timingSafeEqual(presented, session.tokenDigest)
  );
}

type AuthProbeResult = "agent" | "operator" | "invalid" | "unavailable";

async function probeAgentBearer(
  apiBase: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<AuthProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBase.replace(/\/+$/, "")}/api/auth/session`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    return "unavailable";
  }
  if (response.status === 401) {
    return "invalid";
  }
  if (!response.ok) {
    return "unavailable";
  }
  const payload = (await response.json().catch(() => null)) as {
    authenticated?: unknown;
    tier?: unknown;
  } | null;
  if (payload?.authenticated !== true) {
    return "invalid";
  }
  return payload.tier === "agent"
    ? "agent"
    : payload.tier === "operator"
      ? "operator"
      : "invalid";
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: McpSessionRegistry,
  options: Required<Pick<LoopbackMcpHttpServerOptions, "apiBase" | "path">> &
    Pick<LoopbackMcpHttpServerOptions, "fetchImpl" | "createTools">
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== options.path) {
    sendJson(res, 404, { error: "not_found", message: "No such MCP endpoint." });
    return;
  }

  // Fail closed BEFORE touching any transport/session state (invariant #2).
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    unauthorized(res);
    return;
  }

  const auth = await probeAgentBearer(
    options.apiBase,
    token,
    options.fetchImpl ?? fetch
  );
  if (auth === "invalid") {
    unauthorized(res);
    return;
  }
  if (auth === "operator") {
    sendJson(res, 403, {
      error: "operator_token_refused",
      message: "The HTTP MCP transport accepts agent or active-job credentials only.",
    });
    return;
  }
  if (auth === "unavailable") {
    sendJson(res, 503, {
      error: "auth_unavailable",
      message: "The MUON control plane could not validate this MCP credential.",
    });
    return;
  }

  const sessionId = firstHeaderValue(req.headers["mcp-session-id"]);
  const method = req.method ?? "GET";

  try {
    if (method === "GET" || method === "DELETE") {
      const session = sessionId ? registry.sessions.get(sessionId) : undefined;
      if (!session) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }
      if (!sessionTokenMatches(session, token)) {
        unauthorized(res);
        return;
      }
      session.lastSeenAt = registry.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const parsedBody = await readJsonBody(req);

    if (sessionId) {
      const session = registry.sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      if (!sessionTokenMatches(session, token)) {
        unauthorized(res);
        return;
      }
      session.lastSeenAt = registry.now();
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!isInitializeRequest(parsedBody)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    // Sweep BEFORE the capacity check: abandoned sessions must never wedge a
    // live client out of the table.
    evictIdleSessions(registry);
    if (
      registry.sessions.size + registry.pendingInitializations >=
      MAX_MCP_HTTP_SESSIONS
    ) {
      // Still full after the TTL sweep: evict the LEAST-RECENTLY-SEEN session
      // rather than refusing. The SDK's client close() never sends DELETE, so
      // ordinary client exits (a killed CLI, a crash loop, a user restarting
      // their tool 32 times) fill the table with entries only the 30-minute
      // TTL would clear — and a fresh, real client would be locked out of the
      // listener for up to that long. Evicting the stalest session trades an
      // (almost certainly dead) old session for a live one; a genuinely live
      // evictee reconnects with a new initialize.
      const stalest = [...registry.sessions.entries()].sort(
        (left, right) => left[1].lastSeenAt - right[1].lastSeenAt
      )[0];
      if (stalest) {
        registry.sessions.delete(stalest[0]);
        void stalest[1].transport.close().catch(() => undefined);
      }
    }
    if (
      registry.sessions.size + registry.pendingInitializations >=
      MAX_MCP_HTTP_SESSIONS
    ) {
      // Only reachable when pendingInitializations alone saturates the table —
      // 32 SIMULTANEOUS in-flight initializes, which is a flood, not a queue.
      sendJson(res, 429, {
        error: "session_capacity",
        message: `The loopback MCP listener already has ${MAX_MCP_HTTP_SESSIONS} active or initializing sessions.`,
      });
      return;
    }

    // Invariant #3: exactly the fixed base tool set, built fresh from the
    // token THIS request presented. No mode, no job lineage, no widening.
    registry.pendingInitializations += 1;
    try {
      const client = new MuonApiClient(options.apiBase, options.fetchImpl ?? fetch, token);
      const tools = (options.createTools ?? ((c) => createToolDefinitions(c, {})))(client);
      const server = buildMuonServer(tools);
      const digest = tokenDigest(token);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          registry.sessions.set(sid, {
            transport,
            tokenDigest: digest,
            lastSeenAt: registry.now(),
          });
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          registry.sessions.delete(sid);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      registry.pendingInitializations -= 1;
    }
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
        id: null,
      });
    }
  }
}

/**
 * Starts the loopback Streamable HTTP transport. Refuses (throws, before any
 * socket is opened) unless `host` resolves to loopback. Every session's tool
 * list is the fixed base set (context + coordination) built from the exact
 * bearer that request presented — see the file header for the three
 * invariants this enforces.
 */
export async function startLoopbackMcpHttpServer(
  options: LoopbackMcpHttpServerOptions
): Promise<LoopbackMcpHttpServer> {
  // The socket binds a loopback LITERAL: a caller-supplied "localhost" is a
  // name the OS would resolve at listen() time, so it is normalized to
  // 127.0.0.1 rather than trusted.
  const host = loopbackBindAddress(options.host?.trim() || "127.0.0.1");
  const path = options.path?.trim() || "/mcp";
  const registry: McpSessionRegistry = {
    sessions: new Map<string, McpSession>(),
    pendingInitializations: 0,
    now: options.now ?? Date.now,
  };

  const server = createNodeHttpServer((req, res) => {
    void handleRequest(req, res, registry, {
      apiBase: options.apiBase,
      path,
      fetchImpl: options.fetchImpl,
      createTools: options.createTools,
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
  const displayHost = host === "::1" ? "[::1]" : host;

  return {
    server,
    host,
    port,
    url: `http://${displayHost}:${port}${path}`,
    async close() {
      for (const session of registry.sessions.values()) {
        await session.transport.close().catch(() => undefined);
      }
      registry.sessions.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
