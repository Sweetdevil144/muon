/**
 * The governed MUON MCP handshake, as ONE readiness pattern with two vendor
 * bindings.
 *
 * Both vendors connect `mcpServers` ASYNCHRONOUSLY, so a brief released at
 * launch reaches a model whose `muon` server is still starting and whose MUON
 * tools therefore do not exist yet. The agent gets no error — it simply has no
 * `dispatch`, no `memory_add`, no `preflight_edit`, and quietly does nothing.
 * That is the most damaging failure this codebase has: an orchestrator that
 * looks alive and orchestrates nothing.
 *
 * The fix is the same on both vendors and is stated once here: withhold the
 * brief until the vendor's own control channel says every GRANTED
 * `mcp__muon__*` tool is actually exposed, and refuse the run if it cannot say
 * so within a bound. What differs is only the channel:
 *
 *   claude  `Query.mcpServerStatus()`   (SDK control request, no turn needed)
 *   codex   `mcpServerStatus/list`      (app-server JSON-RPC, before turn/start)
 *
 * Only tool NAMES ever reach a message from here. The governed server's env is
 * a two-sided contract — NAMES on the vendor config, VALUES only in the
 * filtered child env (see ./mcp-env-contract.ts) — and a diagnostic that
 * printed a value would defeat it.
 */

/**
 * Mirrors `MUON_MCP_SERVER_NAME` in packages/core (muon-mcp-injection.ts) and
 * `GOVERNED_MCP_SERVER_NAME` in packages/protocol. Adapters must not import
 * core, so the literal is restated — once, here, instead of once per driver.
 */
export const MUON_MCP_SERVER_NAME = "muon";
export const MUON_MCP_TOOL_PREFIX = `mcp__${MUON_MCP_SERVER_NAME}__`;

/** How often either binding re-asks its control channel while it waits. */
export const MUON_MCP_POLL_MS = 250;

/**
 * The exact MUON MCP tool names this profile granted by name. Wildcard and
 * scoped rules are skipped: they name no specific tool, so their presence
 * cannot be asserted against the server's inventory.
 */
export function grantedMuonToolNames(
  allowedTools: readonly string[] | undefined
): string[] {
  return [
    ...new Set(
      (allowedTools ?? [])
        .map((rule) => rule.trim())
        .filter(
          (rule) =>
            rule.startsWith(MUON_MCP_TOOL_PREFIX) &&
            !rule.includes("*") &&
            !rule.includes("(")
        )
    ),
  ];
}

/**
 * `mcp__muon__dispatch` → `dispatch`. A vendor inventory lists the server's own
 * tool names; a MUON grant spells them with the vendor's server prefix. The two
 * only compare after one side is translated, and translating the GRANT (never
 * the inventory) keeps the comparison a subset test in the safe direction.
 */
export function bareMuonToolNames(
  grantedTools: readonly string[]
): string[] {
  return grantedTools.map((tool) =>
    tool.startsWith(MUON_MCP_TOOL_PREFIX)
      ? tool.slice(MUON_MCP_TOOL_PREFIX.length)
      : tool
  );
}

/**
 * Bound a tool name for a diagnostic. Same sanitizer the drivers apply to every
 * other vendor-supplied coordinate: an inventory is vendor output, so even a
 * tool name is untrusted text on the way into a message.
 */
export function boundedMuonToolName(value: unknown, maxLength = 64): string {
  if (typeof value !== "string") return "unknown";
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._:/-]/g, "_")
    .slice(0, maxLength);
  return sanitized || "unknown";
}

/**
 * The sentence every fail-closed readiness refusal ends with. Says what MUON
 * did (withheld the brief) and why refusing beats proceeding.
 */
export function muonHandshakeFailure(detail: string): string {
  return `${detail} MUON withheld the brief and ended the run: an orchestrator that starts its turn without the '${MUON_MCP_SERVER_NAME}' control tools cannot dispatch, gate, or record anything, and would silently run ungoverned.`;
}

/**
 * The detail for the "server is up, toolset is short" case — the one the founder
 * actually hit. Names the missing tools, and ONLY tool names.
 */
export function missingMuonToolsDetail(missing: readonly string[]): string {
  return `MUON MCP server '${MUON_MCP_SERVER_NAME}' connected but never exposed ${
    missing.length
  } granted tool(s): ${missing
    .map((tool) => boundedMuonToolName(tool))
    .join(", ")}.`;
}
