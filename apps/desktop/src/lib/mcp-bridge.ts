import { buildMcpStatusReport } from "@muon/client/mcp-status";
import {
  INSTALLABLE_VENDORS,
  defaultVendorIo,
  installMcpServer,
  muonMcpUnresolvedRefusal,
  resolveMuonMcpCommand,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
// ADR-0028 Tier C: the SAME attach/detach evaluator `muon mcp attach|detach`
// calls. See attachMcpCoordinator's header comment for why its result is
// re-narrowed before it reaches the shared IPC type.
import {
  attachCoordinatorFlow,
  detachCoordinatorFlow,
  type AttachCoordinatorApiClient,
  type DetachCoordinatorApiClient,
} from "@muon/client/attached-coordinator-flow";
import { compareLiveTools } from "@muon/client/mcp-probe";
import { probeMcpToolNames } from "@muon/client/mcp-probe-spawn";
import type { VendorId } from "@muon/client/vendors";
import type {
  McpAttachResult,
  McpDetachResult,
  McpInstallReport,
  McpProbeReport,
  McpStatusReport,
} from "../shared/ipc.js";

/**
 * The main-process side of Settings → Connections — S1 of
 * docs/design/cc-as-superagent-delivery.md §5.
 *
 * WHY THIS IS A MODULE AND NOT TWO INLINE `ipcMain.handle` BODIES: it was
 * inline first, and a mutation that replaced the shared `buildMcpStatusReport`
 * call with a hand-built report object passed the ENTIRE desktop suite — a
 * restated evaluator on the most important surface, invisible. `main.ts` is not
 * reachable from a test (it wires Electron at import time), so anything in it
 * that can be wrong silently must move down here beside `chat-lifecycle.ts` and
 * `job-tree.ts`, which are tested for exactly that reason.
 *
 * Both functions take an INJECTED `{ io, env }`, so a test drives them against a
 * temp root and a runner that throws instead of the operator's real `~/.claude`,
 * `~/.codex`, `~/.cursor` or `~/.config/opencode`.
 */

export type McpBridgeDeps = {
  /** Defaults to `defaultVendorIo()`, whose `redirectVendorConfigDirs` is
   *  hard-coded FALSE — a vendor process MUON launches never has its config
   *  directory moved out from under the human. */
  io?: McpVendorIo;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * "What would a vendor CLI the human starts THEMSELVES get from MUON."
 *
 * Delegates wholly to the ONE shared evaluator: the CLI's `muon mcp status`, the
 * TUI's `/mcp` panel and this handler must answer identically, and the only way
 * to guarantee that is for none of them to have a second opinion.
 *
 * Side-effect-free by construction. It spawns no vendor process (the evaluator
 * reads each config file directly, so it renders on exactly the broken machine
 * it exists to diagnose) and it starts NO BRAIN — a read that reports whether a
 * brain is running must not change that answer by running (§2.2 correction 8,
 * which is also why the CLI's whole `muon mcp` group is exempt from its own
 * brain-autospawn hook).
 */
export function readMcpStatus(deps: McpBridgeDeps = {}): McpStatusReport {
  return buildMcpStatusReport({
    io: deps.io ?? defaultVendorIo(),
    env: deps.env ?? process.env,
  });
}

/**
 * Register MUON's MCP server with ONE vendor, through the SHARED writer.
 *
 * Never rejects: a refusal is `outcome.kind === "refused"` carrying the reason,
 * because a disabled control with no sentence beside it is the dead end
 * first-run UX must not produce.
 *
 * Two decisions worth stating, because each is a thing this function
 * deliberately does NOT expose:
 *  - Always the vendor's DEFAULT scope. `--scope project` stays CLI-only: a
 *    settings row has nowhere to explain what a project-scoped entry means, and
 *    `local` is not an offered scope on any surface (a per-directory entry is
 *    invisible from every other repo, §2.2 correction 6).
 *  - No `--dry-run`. The desktop's equivalent of a dry run is the status read
 *    already on screen.
 */
/**
 * Ask the INSTALLED server what it actually serves (surface-parity item 5).
 *
 * `readMcpStatus` answers "is MUON registered and would a session get a
 * token", and its tool COUNT is a compile-time constant — which is exactly how
 * the desk could show a confident 44 while the process a vendor had spawned
 * served 27. Only the running process can answer what an agent holds.
 *
 * Every part of this is the CLI's: the same command resolver a vendor would
 * spawn, the same handshake (`@muon/client/mcp-probe-spawn`), the same
 * comparison (`compareLiveTools`). The desk must not be able to disagree with
 * `muon mcp probe` about the same server.
 */
export async function probeMcpServer(
  options: { mode?: string; timeoutMs?: number } = {},
  deps: McpBridgeDeps = {}
): Promise<McpProbeReport> {
  const io = deps.io ?? defaultVendorIo();
  const resolution = resolveMuonMcpCommand(io);
  const mode = options.mode?.trim() || "base";
  if (!resolution.ok) {
    return {
      command: null,
      mode,
      // NOT a failed probe with an empty toolset: nothing was measured, and
      // `unevaluated` is what the comparison calls that.
      verdict: compareLiveTools(null, mode),
      failure: muonMcpUnresolvedRefusal(resolution.searched),
    };
  }
  const outcome = await probeMcpToolNames({
    command: resolution.command,
    // The mode is the SERVER's switch. Probing `base` must not inherit a
    // MUON_MCP_MODE from the desktop's own environment, or the report
    // describes a server nobody launches. `deps.env` is the injectable host
    // boundary every other function in this module honours — reaching past it
    // to `process.env` would make this the one probe nobody can test without
    // the real environment.
    env: {
      ...(deps.env ?? process.env),
      MUON_MCP_MODE: mode === "base" ? "" : mode,
    },
    timeoutMs: options.timeoutMs,
  });
  return {
    command: resolution.command,
    mode,
    verdict: compareLiveTools(outcome.toolNames, mode),
    failure: outcome.failure ?? null,
  };
}

export function installMcpForVendor(
  vendor: VendorId,
  deps: McpBridgeDeps = {}
): McpInstallReport {
  // Resolved against the SHARED positive table, never against a string the
  // renderer chose: an unknown id is a refusal, not a write.
  const spec = INSTALLABLE_VENDORS.find((row) => row.id === vendor);
  if (!spec) {
    return {
      vendor,
      scope: "user",
      command: null,
      outcome: {
        kind: "refused",
        reason: `MUON does not install its MCP server into '${vendor}'.`,
      },
    };
  }

  const io = deps.io ?? defaultVendorIo();
  const resolution = resolveMuonMcpCommand(io);
  if (!resolution.ok) {
    return {
      vendor: spec.id,
      scope: spec.defaultScope,
      command: null,
      // The SAME words `muon mcp install` refuses with — one author for the
      // `.dmg`-only case (§1.4c), so the two surfaces cannot drift apart.
      outcome: {
        kind: "refused",
        reason: muonMcpUnresolvedRefusal(resolution.searched),
      },
    };
  }

  return {
    vendor: spec.id,
    scope: spec.defaultScope,
    command: resolution.command,
    outcome: installMcpServer(io, {
      spec,
      scope: spec.defaultScope,
      command: resolution.command,
      dryRun: false,
    }),
  };
}

/**
 * Mint an attached-coordinator seat for `vendor`, through the SAME
 * `attachCoordinatorFlow` `muon mcp attach` calls — no independent authority
 * lives here. `deps.client` must be the desktop's OWN operator-tier
 * `MuonApiClient` (`main.ts`'s module-level `client`), never a value built
 * from renderer input.
 *
 * TOKEN SECRECY: `attachCoordinatorFlow`'s success type has no token field to
 * begin with, but this function narrows even further — dropping
 * `capabilityFilePath`, `command`/`commandSource` and `vendorConfig`, which
 * are all local filesystem detail the renderer has no use for — so the IPC
 * payload is minimal by construction, not merely token-free.
 */
export async function attachMcpCoordinator(
  vendor: VendorId,
  input: { workspacePath: string; chatId?: string },
  deps: McpBridgeDeps & {
    client: AttachCoordinatorApiClient;
    apiBase: string;
    dataDir?: string;
  }
): Promise<McpAttachResult> {
  const spec = INSTALLABLE_VENDORS.find((row) => row.id === vendor);
  if (!spec) {
    return {
      kind: "refused",
      reason: `MUON does not manage an MCP entry for '${vendor}'.`,
    };
  }
  const result = await attachCoordinatorFlow({
    client: deps.client,
    io: deps.io ?? defaultVendorIo(),
    apiBase: deps.apiBase,
    dataDir: deps.dataDir,
    spec,
    chatId: input.chatId,
    workspacePath: input.workspacePath,
  });
  if (result.kind === "refused") {
    return result;
  }
  return {
    kind: "attached",
    vendor: result.vendor,
    jobId: result.jobId,
    chatId: result.chatId,
    workspacePath: result.workspacePath,
    expiresAt: result.expiresAt,
    attestation: result.attestation,
  };
}

/**
 * Revoke `vendor`'s attached-coordinator seat, through the SAME
 * `detachCoordinatorFlow` `muon mcp detach` calls. Idempotent — see that
 * function's header for why an already-clean seat is `not-attached`, not a
 * failure.
 */
export async function detachMcpCoordinator(
  vendor: VendorId,
  deps: McpBridgeDeps & { client: DetachCoordinatorApiClient; dataDir?: string }
): Promise<McpDetachResult> {
  const spec = INSTALLABLE_VENDORS.find((row) => row.id === vendor);
  if (!spec) {
    return {
      kind: "not-attached",
      jobId: null,
      notes: [`MUON does not manage an MCP entry for '${vendor}'.`],
    };
  }
  const result = await detachCoordinatorFlow({
    client: deps.client,
    io: deps.io ?? defaultVendorIo(),
    dataDir: deps.dataDir,
    spec,
  });
  return { kind: result.kind, jobId: result.jobId, notes: result.notes };
}
