import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dataOnlyMcpError, toMcpToolDefinition } from "./agent-ui.js";
import type { SessionSurface, ToolDefinition } from "./handlers.js";
import { muonServerInstructions } from "./instructions.js";

/** Every mode this factory can be built as. Positive, ADR-0022 rule 2. */
const KNOWN_SERVER_MODES = [
  "worker",
  "observer",
  "delegate",
  "orchestrator",
  "attached-coordinator",
] as const;
type ServerMode = (typeof KNOWN_SERVER_MODES)[number];

/**
 * MCP-server telemetry: REMOVED.
 *
 * This used to hand the whole MCP server to `@posthog/mcp`'s `instrument()`.
 * A first pass gated that on an explicit `MUON_MCP_TELEMETRY=1` rather than
 * the mere presence of a token, which fixed *who could turn it on* and left
 * the actual problem untouched: **when it was on, the payload was unbounded.**
 *
 * `instrument()` wraps request and response handling for a server whose
 * traffic is governed memory text, task context, peer-message bodies and tool
 * arguments. There is no allowlist, no redaction, and no vocabulary anyone at
 * MUON has reviewed. ADR-0031 set the standard for MUON telemetry and it is
 * privacy-by-SHAPE — every field an enum, a number or a boolean, with nowhere
 * to put a prompt — and a third-party wrapper over arbitrary tool payloads
 * cannot meet that standard by being switched on more carefully.
 *
 * MUON captured no custom events through this client, so removing it loses
 * nothing that was being measured. If MCP analytics are wanted later they get
 * what the observatory got: a positive event vocabulary, a consent gate the
 * user can see, and an ADR — not a wrapper over everything.
 *
 * Nothing is exported in its place. The four `posthog.shutdown()` call sites
 * went with it — a shutdown for a client that never existed is the kind of
 * residue that makes the next reader think telemetry is still wired.
 */

export type BuildMuonServerOptions = {
  readonly mode?: string;
  /**
   * REPLACE the composed instructions entirely (ADR-0049).
   *
   * For a session that holds NOTHING and exists only to say why — a lapsed
   * attached seat. The ordinary voice describes a tier this session does not
   * have, so echoing it beside zero tools would be the overclaim the voice
   * exists to prevent.
   */
  readonly instructions?: string;
};

/**
 * P14: the ONE place that wires an MCP `Server`'s `tools/list` and
 * `tools/call` handlers against a fixed, already-composed tool list. Pulled
 * out of stdio's `main()` (`index.ts`) so the loopback HTTP/SSE transport
 * (`http-transport.ts`) shares this exact request-handling path instead of a
 * second copy that could drift.
 *
 * A session's authority is entirely decided by WHICH `tools` were composed
 * before this call — this function reads no token, no mode, no env. That is
 * what keeps the HTTP transport's "never operator-on-MCP widening" invariant
 * true by construction: whatever calls this always hands it the same fixed
 * base tool list, so there is nothing here to widen.
 */
export function buildMuonServer(
  tools: ToolDefinition[],
  options: BuildMuonServerOptions = {}
): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Feature #10: tell `whoami` what this session actually holds. Bound here
  // because this is the only place that sees the FINAL list — the base
  // definitions are extended by the observer/coordinator/orchestrator
  // composers after they are built, so anything computed earlier would
  // under-report. Every tool asking is offered the same surface; only the
  // identity tool implements the hook.
  //
  // `options.mode` originates in MUON_MCP_MODE, which the vendor process can
  // set. An unrecognised value must NOT be echoed back as this session's tier:
  // `MUON_MCP_MODE=ORCHESTRATOR` would otherwise have whoami answer
  // "ORCHESTRATOR" beside a worker's 27 tools. Positive list, and anything
  // else reports what was actually built.
  const surface: SessionSurface = {
    mode: KNOWN_SERVER_MODES.includes(options.mode as ServerMode)
      ? (options.mode as string)
      : "worker",
    toolNames: tools.map((tool) => tool.name),
  };
  for (const tool of tools) {
    tool.bindSessionSurface?.(surface);
  }

  const server = new Server(
    { name: "muon", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      // §3.3: the FIRST thing an attached session is told, mirrored verbatim
      // from stdio's main() — a session must read the same instructions
      // regardless of which transport carried it here.
      instructions:
        options.instructions ??
        muonServerInstructions({
          toolCount: tools.length,
          mode: options.mode,
        }),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpToolDefinition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return dataOnlyMcpError(
        request.params.name,
        `Unknown tool '${request.params.name}'`
      );
    }
    try {
      return await tool.handler(
        (request.params.arguments ?? {}) as Record<string, unknown>
      );
    } catch (error) {
      return dataOnlyMcpError(
        request.params.name,
        error instanceof Error ? error.message : "Tool failed"
      );
    }
  });

  return server;
}
