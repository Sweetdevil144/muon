#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MuonApiClient,
  discoverLiveBrain,
  resolveAgentToken,
  resolveApiBase,
} from "@muon/client";
import {
  readAttachedCoordinatorCapabilityFile,
  renewAttachedCoordinatorCapabilityFile,
} from "@muon/client/attached-coordinator-capability";
import { ATTACHED_COORDINATOR_HEARTBEAT_MS } from "@muon/protocol";
import {
  createToolDefinitions,
  type ToolDefinition,
} from "./handlers.js";
import { createDelegateToolDefinitions } from "./delegate-tools.js";
import { createOrchestratorToolDefinitions } from "./orchestrator-tools.js";
import {
  createObserverModeToolDefinitions,
  createObserverToolDefinitions,
} from "./observer-tools.js";
import { createAttachedCoordinatorToolDefinitions } from "./attached-coordinator-tools.js";
import { buildMuonServer } from "./server-factory.js";

export { createToolDefinitions } from "./handlers.js";
export { createDelegateToolDefinitions } from "./delegate-tools.js";
export { createOrchestratorToolDefinitions } from "./orchestrator-tools.js";
export {
  createObserverModeToolDefinitions,
  createObserverToolDefinitions,
} from "./observer-tools.js";
export { createAttachedCoordinatorToolDefinitions } from "./attached-coordinator-tools.js";
export { toMcpToolDefinition } from "./agent-ui.js";
export { dataOnlyMcpError } from "./agent-ui.js";
export { buildMuonServer } from "./server-factory.js";
export type { BuildMuonServerOptions } from "./server-factory.js";
export type { ToolDefinition, ToolScope } from "./handlers.js";
export type { OrchestratorScope } from "./orchestrator-tools.js";
export type { ObserverScope } from "./observer-tools.js";
export type { AttachedCoordinatorScope } from "./attached-coordinator-tools.js";

export function createDelegateModeToolDefinitions(
  client: MuonApiClient,
  baseTools: ToolDefinition[],
  scope: {
    parentJobId: string;
    canDelegate: boolean;
    delegationToken?: string;
    workspacePath?: string;
  }
): ToolDefinition[] {
  if (!scope.canDelegate) {
    return baseTools;
  }
  if (!scope.delegationToken) {
    throw new Error(
      "delegate MCP mode requires a job-bound token when child spawning is allowed."
    );
  }
  return [
    ...baseTools,
    ...createDelegateToolDefinitions(client, {
      parentJobId: scope.parentJobId,
      delegationToken: scope.delegationToken,
      workspacePath: scope.workspacePath,
    }),
  ];
}

/**
 * The credential the MUON MCP server may present — and the one it must NEVER
 * pick up.
 *
 * `resolveApiToken()` is the LOCAL HUMAN surfaces' resolver: with no explicit
 * base configured it falls back to the running brain's lockfile `token`, which
 * is the OPERATOR credential (human / govern authority). Correct for the CLI,
 * TUI and desktop; wrong here. The governed path was safe only by ACCIDENT — the
 * runner injects MUON_API_BASE alongside the job-bound token, so `explicitBase()`
 * was true and the lockfile branch was never reached. Register `muon-mcp` by
 * hand in a vendor CLI (the "open a session with MUON's MCP on and it becomes
 * the superagent" path) and nothing is injected, so resolution fell through to
 * the operator token: a model holding govern tier over memory, able to
 * self-confirm, self-approve, and forge a human principal.
 *
 * Precedence, and there is deliberately no third step:
 *   1. MUON_API_TOKEN — the name the runner injects the exact-job token under
 *      (`withMuonMcpServer` in @muon/core; muon-mcp reads that name by contract).
 *      An operator who exports it by hand is making the same explicit choice
 *      `--api-token` already is.
 *   2. resolveAgentToken() — MUON_AGENT_TOKEN / the lockfile's `agentToken`:
 *      reads and agent-writes, NEVER govern.
 * No operator fallback. Absence must read as "no capability", not as "take the
 * strongest credential lying around" — the brain then answers 401, which is a
 * legible refusal rather than a silent tier escalation.
 */
export function resolveMcpApiToken(): string | undefined {
  return process.env.MUON_API_TOKEN?.trim() || resolveAgentToken();
}

/**
 * ADR-0028 Tier C: run as the attached (external, non-hermetic) coordinator.
 *
 * This branch NEVER calls `resolveApiBase()`/`resolveMcpApiToken()` — the
 * capability file is the ONLY source of authority for this mode. Reading an
 * ambient `MUON_API_TOKEN`/`MUON_AGENT_TOKEN` or the brain lockfile's
 * `agentToken` here would let the SAME same-uid exposure `resolveMcpApiToken`
 * was written to close (ADR-0017 §1) mint a Tier C grant nobody attached.
 */
/**
 * ADR-0049 — SERVE THE HANDSHAKE, HOLD NOTHING, NAME THE REMEDY.
 *
 * Every way an attached seat can fail to start used to throw, which kills the
 * process before a transport exists; the vendor then reports only `-32000` and
 * the sentence that would have helped goes to a stderr nothing displays.
 * Measured 2026-08-11: an operator rebooted and looped for twenty minutes on
 * an error code that named nothing.
 *
 * This grants NOTHING — no client, no token read, no tool registered, no
 * heartbeat. It is the same refusal, moved somewhere a human and an agent can
 * both read it.
 */
async function serveLapsedSeat(detail: string): Promise<void> {
  process.stderr.write(`muon-mcp: ${detail}\n`);
  const vendor = process.env.MUON_ATTACHED_VENDOR?.trim() || "claude-code";
  const lapsed = buildMuonServer([], {
    mode: "attached-coordinator",
    instructions:
      `MUON IS NOT ATTACHED TO THIS SESSION, and no tool here can act.\n\n` +
      `${detail}\n\n` +
      `An attached coordinator seat is minted by a human and renewed by a ` +
      `heartbeat from this terminal. Once the terminal stops for longer than ` +
      `the lease, the seat is reaped on purpose — that is the mechanism that ` +
      `stops a dead terminal keeping authority.\n\n` +
      `THE REMEDY, which only the human can perform:\n` +
      `  muon mcp attach ${vendor}\n` +
      `then restart this terminal. Do not attempt to mint or repair this seat ` +
      `yourself; an agent granting itself authority is precisely what this ` +
      `tier exists to prevent. Say plainly that MUON is unattached, name the ` +
      `command above, and continue without MUON's tools.`,
  });
  await lapsed.connect(new StdioServerTransport());
}

export async function runAttachedCoordinator(): Promise<void> {
  const filePath = process.env.MUON_ATTACHED_CAPABILITY_FILE?.trim();
  if (!filePath) {
    // A vendor config in this mode with no capability path is broken rather
    // than lapsed, and `muon mcp attach` is what rewrites it correctly — so
    // the remedy is the same sentence.
    await serveLapsedSeat(
      "attached-coordinator MCP mode requires MUON_ATTACHED_CAPABILITY_FILE (an absolute path to the attached-coordinator capability file)."
    );
    return;
  }
  const read = readAttachedCoordinatorCapabilityFile(filePath);
  if (!read.ok) {
    // NEVER include the file's own contents (which hold apiToken/
    // delegationToken) — only the structural rejection reason and the
    // secret-free detail `readAttachedCoordinatorCapabilityFile` already
    // produces (path, mode, byte count — never a field value).
    await serveLapsedSeat(
      `attached-coordinator MCP mode refused its capability file (${read.reason}): ${read.detail}`
    );
    return;
  }
  let capability = read.capability;
  // ADR-0049 — THE PINNED ADDRESS CAN GO DEAD.
  //
  // `apiBase` is captured at ATTACH time and never revisited, so a brain that
  // restarts onto a new port silently invalidates every attached seat on the
  // machine. Measured 2026-08-11: a capability file pinned :55666 while the
  // live brain answered on :50598, and the seat could not have worked even
  // with a valid lease.
  //
  // Only the ADDRESS is re-resolved, and only from this machine's brain
  // lockfile. The TOKEN stays the capability file's — it is the operator-minted
  // exact-job bearer, and this mode's whole rule is that the file is the only
  // source of authority (reading a lockfile token here would mint a Tier C
  // grant nobody attached, the exposure ADR-0017 §1 closes).
  const client = new MuonApiClient(
    capability.apiBase,
    fetch,
    capability.apiToken,
    undefined,
    () => {
      const live = discoverLiveBrain()?.lock;
      return live
        ? { baseUrl: `http://127.0.0.1:${live.port}`, apiToken: capability.apiToken }
        : null;
    }
  );

  const baseTools = createToolDefinitions(client, {
    jobId: capability.jobId,
    chatId: capability.chatId,
    apiBase: capability.apiBase,
    apiToken: capability.apiToken,
  });
  const tools = createAttachedCoordinatorToolDefinitions(client, baseTools, {
    jobId: capability.jobId,
    delegationToken: capability.delegationToken,
    chatId: capability.chatId,
    chatTaskId: capability.chatTaskId,
    workspacePath: capability.workspacePath,
    apiBase: capability.apiBase,
    apiToken: capability.apiToken,
  });
  const server = buildMuonServer(tools, { mode: "attached-coordinator" });

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight = false;
  let stopped = false;
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  // Heartbeat failure is FAIL CLOSED: the lease's own independent horizon
  // (ADR-0028 §3) will reap this seat within one lease period regardless, but
  // exiting immediately means a coordinator that can no longer prove it is
  // alive stops offering tools rather than racing the reaper.
  const failClosed = (reason: string) => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    process.stderr.write(
      `muon-mcp: attached-coordinator heartbeat failed (${reason}); this seat's lease will lapse and MUON will terminalize it and its children. Exiting.\n`
    );
    process.exit(1);
  };
  heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    client
      .heartbeatAttachedCoordinator(capability.jobId)
      .then(({ expiresAt }) => {
        capability = renewAttachedCoordinatorCapabilityFile(
          filePath,
          capability,
          expiresAt
        );
      })
      .catch((error) => {
        failClosed(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, ATTACHED_COORDINATOR_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    stopped = true;
    stopHeartbeat();
  };
  await server.connect(transport);
}

async function main() {
  const mode = process.env.MUON_MCP_MODE?.trim();
  if (mode === "attached-coordinator") {
    await runAttachedCoordinator();
    return;
  }

  const apiBase = resolveApiBase();
  const apiToken = resolveMcpApiToken();
  // THE BRAIN CAN MOVE UNDER US. This process is spawned by a vendor and
  // lives as long as the human's session — hours, days. The brain restarts on
  // a fresh port with a fresh token, and every memory tool an attached agent
  // holds starts answering "fetch failed" against an address nobody is
  // listening on. Measured on 2026-08-10: an MCP server built when the
  // lockfile read :55036 was still calling :55036 two days later, while
  // `muon doctor` reached the live brain on :51834 without trouble.
  //
  // Both coordinates are re-read TOGETHER — a new brain has a new token, so
  // rebasing the port alone would trade "connection refused" for 401.
  const client = new MuonApiClient(apiBase, fetch, apiToken, undefined, () => ({
    baseUrl: resolveApiBase(),
    apiToken: resolveMcpApiToken(),
  }));
  const jobId = process.env.MUON_JOB_ID?.trim() || undefined;

  // Two modes, one binary: sub-agents get the shared-brain toolset;
  // MUON_MCP_MODE=orchestrator adds the crew-control toolset for the
  // conversational super-agent.
  const baseTools = createToolDefinitions(client, {
    taskId: process.env.MUON_TASK_ID?.trim() || undefined,
    laneKey: process.env.MUON_LANE_KEY?.trim() || undefined,
    jobId,
    preflightNonce:
      process.env.MUON_PREFLIGHT_NONCE?.trim() || undefined,
    // #126: the chat partition for EVERY MCP mode (worker/delegate/orchestrator),
    // set by the runner into the MUON MCP env from the trusted job.chatId. Absent
    // (a non-chat / plain-worker session) → the pre-#126 global memory behavior.
    chatId: process.env.MUON_CHAT_ID?.trim() || undefined,
    // A2A: the coordination tier calls the control plane directly with the
    // runner-issued EXACT-JOB bearer, which is what makes chat/mission/sender
    // derivable server-side. Absent → those tools refuse rather than coordinate
    // under an ambient identity.
    apiBase,
    apiToken,
  });
  const delegationToken = process.env.MUON_DELEGATION_TOKEN?.trim();
  const delegateCanSpawn =
    process.env.MUON_DELEGATE_CAN_SPAWN?.trim() === "true";
  if ((mode === "orchestrator" || mode === "delegate") && !jobId) {
    throw new Error(`${mode} MCP mode requires MUON_JOB_ID lineage.`);
  }
  if (mode === "observer" && !apiToken) {
    throw new Error(
      "observer MCP mode requires an agent credential (MUON_AGENT_TOKEN or the live brain lockfile); it will not fall back to the operator credential."
    );
  }
  // The authority-bearing modes refuse to start without a credential, exactly as
  // they already refuse without lineage: a server that cannot prove its tier
  // must not run at all rather than run at whatever tier it happens to get.
  if ((mode === "orchestrator" || mode === "delegate") && !apiToken) {
    throw new Error(
      `${mode} MCP mode requires the runner-injected job token (MUON_API_TOKEN) or an agent token (MUON_AGENT_TOKEN); it will not fall back to the operator credential.`
    );
  }
  if (!apiToken) {
    // A hand-registered server against a token-guarded brain: every call would
    // 401. Say so once, on stderr, instead of letting the tools fail namelessly.
    process.stderr.write(
      "muon-mcp: no agent credential found (MUON_API_TOKEN / MUON_AGENT_TOKEN unset, no agentToken in the brain lockfile). Running unauthenticated — MUON never presents the operator token from an MCP server.\n"
    );
  }
  if (
    (mode === "orchestrator" ||
      (mode === "delegate" && delegateCanSpawn)) &&
    !delegationToken
  ) {
    throw new Error(`${mode} MCP mode requires a job-bound delegation token.`);
  }
  const tools =
    mode === "orchestrator"
      ? [
          ...baseTools,
          ...createOrchestratorToolDefinitions(client, {
            jobId,
            delegationToken,
            chatId: process.env.MUON_CHAT_ID?.trim() || undefined,
            chatTaskId: process.env.MUON_CHAT_TASK_ID?.trim() || undefined,
            workspacePath: process.env.MUON_WORKSPACE?.trim() || undefined,
            apiBase,
            apiToken,
          }),
        ]
      : mode === "observer"
        ? createObserverModeToolDefinitions(client, baseTools, {
            apiBase,
            apiToken,
            chatId: process.env.MUON_CHAT_ID?.trim() || undefined,
            workspacePath: process.env.MUON_WORKSPACE?.trim() || undefined,
          })
      : mode === "delegate"
        ? createDelegateModeToolDefinitions(client, baseTools, {
            parentJobId: jobId!,
            canDelegate: delegateCanSpawn,
            delegationToken,
            workspacePath: process.env.MUON_WORKSPACE?.trim() || undefined,
          })
      : baseTools;
  const server = buildMuonServer(tools, { mode });

  process.on("SIGTERM", async () => {
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    process.exit(0);
  });

  await server.connect(new StdioServerTransport());
}

// Only start the stdio server when run as a binary, not when imported.
const isDirectRun =
  process.argv[1]?.endsWith("muon-mcp") ||
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts");

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(
      `muon-mcp failed: ${error instanceof Error ? error.message : error}\n`
    );
    process.exit(1);
  });
}
