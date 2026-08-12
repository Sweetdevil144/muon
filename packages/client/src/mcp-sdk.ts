/**
 * ROADMAP P14 — a thin, typed SDK over MUON's loopback MCP Streamable HTTP
 * transport (`packages/mcp/src/http-transport.ts`). Wraps the official
 * `@modelcontextprotocol/sdk` client so a script or another same-host process
 * can drive `muon-mcp-http` without hand-rolling JSON-RPC.
 *
 * Deliberately small: `connect`, `listTools`, `callTool`, and a handful of
 * typed helpers for the cheapest reads in the base tool inventory
 * (`@muon/protocol`'s `MUON_CONTEXT_TOOL_NAMES` / `MUON_COORDINATION_TOOL_NAMES`).
 * It does not attempt to type every tool's input/output — the tool
 * `inputSchema`s returned by `listTools()` remain the source of truth for
 * anything beyond these helpers.
 *
 * A token is REQUIRED. `connect()` throws before any network call if it is
 * missing or empty — this SDK only ever speaks to a transport that itself
 * fails closed without one (see `http-transport.ts`'s invariant #2), and an
 * empty-string "token" would otherwise silently produce a confusing 401 from
 * the far end instead of a clear local error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
} from "@muon/protocol";

/** Every tool name the base (Tier A) MCP session can see — the ONLY tier this
 *  transport ever grants (see `http-transport.ts` invariant #3). */
export type MuonMcpBaseToolName =
  | (typeof MUON_CONTEXT_TOOL_NAMES)[number]
  | (typeof MUON_COORDINATION_TOOL_NAMES)[number];

export type MuonMcpTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];

export type MuonMcpCallResult = Awaited<ReturnType<Client["callTool"]>>;

export type MuonMcpConnectOptions = {
  /** The `muon-mcp-http` endpoint, e.g. `http://127.0.0.1:4100/mcp`. */
  baseUrl: string;
  /** The agent/job bearer. Required — see the file header. */
  token: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Client identity advertised during MCP `initialize`. */
  clientInfo?: { name: string; version: string };
};

/**
 * A connected session against MUON's loopback MCP HTTP transport. Every
 * instance holds exactly one bearer and one underlying transport; there is no
 * token-swap method, matching the server's per-session binding.
 */
export class MuonMcpClient {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport
  ) {}

  static async connect(options: MuonMcpConnectOptions): Promise<MuonMcpClient> {
    const token = options.token?.trim();
    if (!token) {
      throw new Error(
        "MuonMcpClient.connect requires a non-empty agent/job token; " +
          "MUON's MCP HTTP transport never accepts an unauthenticated session."
      );
    }
    const transport = new StreamableHTTPClientTransport(new URL(options.baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: options.fetch,
    });
    const client = new Client(
      options.clientInfo ?? { name: "muon-mcp-sdk", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    return new MuonMcpClient(client, transport);
  }

  /** The session id the server assigned this connection, once initialized. */
  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async listTools(): Promise<MuonMcpTool[]> {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: MuonMcpBaseToolName | (string & {}),
    args: Record<string, unknown> = {}
  ): Promise<MuonMcpCallResult> {
    return this.client.callTool({ name, arguments: args });
  }

  /** `memory_search` — the hero context read: shared work memory in this
   *  workspace. */
  async memorySearch(
    query: string,
    filter?: Record<string, unknown>
  ): Promise<MuonMcpCallResult> {
    return this.callTool("memory_search", {
      query,
      ...(filter ? { filter } : {}),
    });
  }

  /** `task_context` — the current task's brief, defaulting server-side when
   *  no coordinate is given. */
  async taskContext(args: Record<string, unknown> = {}): Promise<MuonMcpCallResult> {
    return this.callTool("task_context", args);
  }

  /** `code_query` — GitNexus concept search, process-grouped results. */
  async codeQuery(query: string): Promise<MuonMcpCallResult> {
    return this.callTool("code_query", { query });
  }

  /** `crew_roles` — the read side of role assignment; carries no authority. */
  async crewRoles(): Promise<MuonMcpCallResult> {
    return this.callTool("crew_roles", {});
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
