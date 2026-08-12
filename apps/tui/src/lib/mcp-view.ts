import { resolveApiBase } from "@muon/client";
import type { MuonApiClient } from "@muon/client";
import {
  attachCoordinatorFlow,
  detachCoordinatorFlow,
  type AttachCoordinatorFlowResult,
  type DetachCoordinatorFlowResult,
} from "@muon/client/attached-coordinator-flow";
import { buildMcpStatusReport, type McpStatusReport } from "@muon/client/mcp-status";
import {
  defaultVendorIo,
  resolveInstallableVendor,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";

/**
 * MCP — the cockpit's window onto "what would a vendor CLI I start MYSELF get
 * from MUON", S1 of docs/design/cc-as-superagent-delivery.md §5.
 *
 * This module is DELIBERATELY thin, and that is the whole point. `muon mcp
 * status`, this panel and the desktop's Connections row must answer identically,
 * so all three call the ONE evaluator — `buildMcpStatusReport` in
 * `@muon/client/mcp-status` — and render its `McpStatusReport`. Nothing here
 * re-derives a check, a level, a reason id, a scope, a config path or a vendor
 * fact; if this panel ever needs something the report does not carry, the fix is
 * to widen the shared function, never to compute it a second time here. That
 * rule is what `workspaceCondition` and `memoryGateTier` already follow, and its
 * absence is how a TUI reject once drifted to an ungoverned call path while the
 * CLI and desktop were correct.
 *
 * Two other properties inherited from the shared evaluator, worth knowing here
 * because they are what make this panel safe to open on a broken machine:
 *  - it SPAWNS NO VENDOR PROCESS (it reads each config file directly), so it
 *    renders on exactly the machine it exists to diagnose; and
 *  - it starts NO BRAIN. `muon mcp …` is exempt from the CLI's autospawn hook
 *    for the same reason (§2.2 correction 8): a command that reports whether a
 *    brain is running must not change that answer by running.
 */

export type McpPanelLoad =
  | { status: "loading" }
  /** Honest one-liner, never a blank overlay. */
  | { status: "error"; reason: string }
  | { status: "ready"; report: McpStatusReport };

export type McpPanelInput = {
  /** Injected so a test never reads or writes the operator's real vendor configs. */
  io?: McpVendorIo;
  /** The env a hand-started vendor CLI would inherit. Injected for the same reason. */
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Build the panel's load. NEVER rejects — an unreadable data dir or a throwing
 * IO seam degrades to one honest line rather than blanking the cockpit, the same
 * fail-soft rule `loadCrewPanel` follows.
 *
 * Async even though the evaluator is synchronous: it does a handful of `which`
 * probes, and awaiting lets the panel paint its `loading` frame first instead of
 * appearing already-complete.
 */
export async function loadMcpPanel(
  input: McpPanelInput = {}
): Promise<McpPanelLoad> {
  try {
    return {
      status: "ready",
      report: buildMcpStatusReport({
        io: input.io ?? defaultVendorIo(),
        env: input.env ?? process.env,
      }),
    };
  } catch (error) {
    return {
      status: "error",
      reason:
        error instanceof Error
          ? error.message
          : "could not read the MCP registration status",
    };
  }
}

/**
 * Does this report contain a failing check? The CLI exits 1 on exactly this
 * predicate, so the cockpit's one-line status must agree with it rather than
 * inventing its own idea of "healthy".
 */
export function mcpReportFailing(report: McpStatusReport): boolean {
  return report.checks.some((check) => check.level === "fail");
}

/**
 * ADR-0028 Tier C — cockpit attach. Delegates wholly to the ONE shared
 * `attachCoordinatorFlow` (CLI + desktop use the same function). Never returns
 * a capability token; refusals are actionable strings for the status line.
 */
export async function attachMcpCoordinatorInTui(input: {
  client: MuonApiClient;
  vendorToken: string;
  workspacePath: string;
  /**
   * The base of the SAME brain `client` talks to (the store's current
   * target). The flow writes this into the 0600 capability file alongside the
   * bearer that `client` mints — re-resolving here could pair brain B's
   * capability token with brain A's base, handing one brain's credential to a
   * process pointed at another.
   */
  apiBase?: string;
  chatId?: string;
  io?: McpVendorIo;
}): Promise<AttachCoordinatorFlowResult> {
  const spec = resolveInstallableVendor(input.vendorToken);
  if (!spec) {
    return {
      kind: "refused",
      reason: `Unknown vendor '${input.vendorToken}'. Use claude or codex (coordinator-seat vendors only).`,
    };
  }
  return attachCoordinatorFlow({
    client: input.client,
    io: input.io ?? defaultVendorIo(),
    apiBase: input.apiBase ?? resolveApiBase(),
    spec,
    workspacePath: input.workspacePath,
    chatId: input.chatId,
  });
}

/** ADR-0028 Tier C — cockpit detach. Same shared flow as CLI/desktop. */
export async function detachMcpCoordinatorInTui(input: {
  client: MuonApiClient;
  vendorToken: string;
  io?: McpVendorIo;
}): Promise<DetachCoordinatorFlowResult | { kind: "refused"; reason: string }> {
  const spec = resolveInstallableVendor(input.vendorToken);
  if (!spec) {
    return {
      kind: "refused",
      reason: `Unknown vendor '${input.vendorToken}'.`,
    };
  }
  return detachCoordinatorFlow({
    client: input.client,
    io: input.io ?? defaultVendorIo(),
    spec,
  });
}

export type { McpStatusReport };
