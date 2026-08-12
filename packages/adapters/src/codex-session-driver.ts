import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  boundToolActivityPaths,
  boundToolActivityText,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type ToolActivityDetail,
} from "@muon/protocol";
import { commandExists } from "./command-check.js";
import {
  runCodexCapabilityPreflight,
  type CodexCapabilityPreflight,
  type CodexCapabilityMethod,
} from "./codex-capability-preflight.js";
import {
  codexGuardEnv,
  codexSandboxOverrideArgs,
  codexStartupExitDetail,
  effectiveCodexApprovalPolicy,
  effectiveCodexSandboxMode,
  guardedCodexArgs,
  prepareCodexGuardHome,
  ungrantedCodexServersDetail,
  CODEX_AMBIENT_SUPPRESSION_ARGS,
  CODEX_GUARD_NOTICE,
  CODEX_NESTED_SANDBOX_NOTICE,
  type CodexStartupPhase,
} from "./codex-guard.js";
import { buildProviderAwareLaneEnvironment } from "./lane-runner.js";
import { assertMuonMcpEnvContract } from "./mcp-env-contract.js";
import { readMuonMcpStartupFailure } from "./muon-mcp-diagnostic.js";
import {
  bareMuonToolNames,
  grantedMuonToolNames,
  missingMuonToolsDetail,
  muonHandshakeFailure,
  MUON_MCP_POLL_MS,
  MUON_MCP_SERVER_NAME,
  MUON_MCP_TOOL_PREFIX,
} from "./muon-mcp-readiness.js";
import {
  codexCapabilityNotice,
  compileCodexProfile,
  compileCodexToolPolicy,
} from "./profile-compiler.js";
import { boundedProviderFailure } from "./provider-failure.js";
import {
  makeSessionEvent,
  type LaneSessionDriver,
  type SessionHandle,
  type SessionHandlers,
  type SessionStartInput,
} from "./session-driver.js";
import {
  extractCodexTokenUsage,
  usageEventMetadata,
  type VendorTokenUsage,
} from "./token-usage.js";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type RpcTransport = {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  close(): Promise<void>;
  /** Resolves when the underlying process/stream ends. */
  waitForExit(): Promise<number>;
};

/**
 * Codex app-server method names (v2 protocol). Centralized so a vendor
 * protocol bump is a one-file change.
 */
export const CODEX_RPC = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  accountRead: "account/read",
  configRead: "config/read",
  configRequirementsRead: "configRequirements/read",
  mcpServerStatusList: "mcpServerStatus/list",
  pluginList: "plugin/list",
  // Server-initiated notifications/requests:
  agentMessageDelta: "item/agentMessage/delta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  mcpToolCallProgress: "item/mcpToolCall/progress",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  turnCompleted: "turn/completed",
  mcpStartupStatus: "mcpServer/startupStatus/updated",
  /**
   * Codex's approval channel for MCP TOOL CALLS under `approvalPolicy:
   * "untrusted"` (measured, 0.145.0). It is NOT an `item/…/requestApproval`
   * method: it rides the MCP elicitation vocabulary, expects `{action:
   * "accept" | "decline"}` (a reply without `action` fails to deserialize and
   * codex rejects the call — fail closed on the vendor side too), and carries
   * the SERVER name but not the tool name; the tool is on the `mcpToolCall`
   * item codex starts immediately before asking.
   */
  mcpElicitation: "mcpServer/elicitation/request",
} as const;

const MUON_MCP_READY_MS = 20_000;
const CODEX_TURN_IDLE_MS = 5 * 60_000;
const CODEX_TRANSPORT_CLOSE_MS = 2_000;
const CODEX_TRANSPORT_EXIT_MS = 3_000;
const CODEX_INTERRUPT_RPC_MS = 1_000;
const CODEX_TRANSPORT_STDERR_TAIL_CHARS = 800;

function boundedCodexFailure(value: unknown, maxLength = 500): string {
  return boundedProviderFailure(value, maxLength);
}

/**
 * The app-server child's stderr, kept as a BOUNDED rolling tail with an optional
 * live forward.
 *
 * Two consumers, one buffer: `send()` quotes `read()` when the child died before
 * RPC, and `observe()` forwards each chunk to a caller that must diagnose the
 * child WHILE it is still alive (the runner's liveness watchdog). A provider
 * that rejects on a workspace spend cap can take minutes to answer, and this
 * stderr is the only vendor-side evidence available inside the watchdog window.
 * Each chunk is bounded BEFORE it is concatenated, so a single huge write is
 * never materialized.
 *
 * Exported so the bounding and forwarding rules are unit-testable:
 * `spawnCodexTransport` cannot run without the real `codex` binary, so this seam
 * would otherwise go unproven.
 */
export function createCodexStderrTail(onDiagnostic?: (chunk: string) => void): {
  observe: (text: string) => void;
  append: (text: string) => void;
  read: () => string;
} {
  let tail = "";
  const append = (text: string): void => {
    if (text.length === 0) return;
    const bounded =
      text.length > CODEX_TRANSPORT_STDERR_TAIL_CHARS
        ? text.slice(-CODEX_TRANSPORT_STDERR_TAIL_CHARS)
        : text;
    tail = `${tail}${bounded}`.slice(-CODEX_TRANSPORT_STDERR_TAIL_CHARS);
  };
  return {
    /** Vendor stderr: recorded AND forwarded live. */
    observe: (text) => {
      if (text.length === 0) return;
      append(text);
      onDiagnostic?.(text);
    },
    /**
     * MUON-side failure text (a spawn error, not the vendor's own output):
     * recorded for `send()`, never forwarded — the watchdog labels the forwarded
     * tail as the vendor's own stderr and that label must stay true.
     */
    append,
    read: () => tail,
  };
}

function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true)
    );
  });
}

/** Codex 0.145+ approval vocab is accept/decline, not approved/denied. */
function codexApprovalResult(
  method: string,
  decision: { behavior: "allow" | "deny"; message?: string },
  params: Record<string, unknown>
): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  if (method === "item/permissions/requestApproval") {
    if (decision.behavior === "allow") {
      return {
        result: {
          permissions: params.permissions ?? {},
          scope: "turn",
        },
      };
    }
    return {
      error: {
        code: -32000,
        message: decision.message ?? "MUON denied the permission grant.",
      },
    };
  }
  return {
    result: {
      decision: decision.behavior === "allow" ? "accept" : "decline",
      ...(decision.behavior === "deny" && decision.message
        ? { message: decision.message }
        : {}),
    },
  };
}

function agentMessageTextFromItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const record = item as Record<string, unknown>;
  if (record.type !== "agentMessage") return "";
  return typeof record.text === "string" ? record.text : "";
}

export type CodexActivity = {
  itemId: string;
  itemType: "mcpToolCall" | "commandExecution" | "fileChange" | "collabAgentToolCall";
  label: string;
  status?: string;
  server?: string;
  tool?: string;
  /** Vendor-reported file coordinates; still untrusted until runner+git proof. */
  paths?: string[];
  /**
   * Bounded, still-untrusted payload of THIS call. Kept off the coordinate
   * record the call sites emit as `codexActivity` and carried on the
   * vendor-neutral `toolActivity.detail` instead, so exactly one copy of a
   * vendor payload ever rides an event.
   */
  detail?: ToolActivityDetail;
};

function boundedCodexCoordinate(
  value: unknown,
  fallback: string,
  maxLength = 96
): string {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._:/-]/g, "_")
    .slice(0, maxLength);
  return sanitized || fallback;
}

/**
 * The subject of ONE approval request, bounded for the human who has to decide.
 *
 * Scoped deliberately to the APPROVAL path: an operator asked to allow or deny
 * a call must be able to read what the call is, and a decision recorded without
 * its subject is not a reviewable decision. The item-lifecycle extractor below
 * keeps its coordinates-only posture untouched.
 *
 * Bounded here; redacted by @muon/core's `redactedTail` on the way into the
 * ledger (adapters cannot import core — core depends on adapters).
 */
function codexApprovalDetail(
  params: Record<string, unknown>
): ToolActivityDetail | undefined {
  // Prefer the concrete subject fields Codex sends; fall back to the whole
  // param bag so an unfamiliar approval method still shows the human something.
  const subject =
    params.command ?? params.arguments ?? params.input ?? params.path ?? params;
  const args = boundToolActivityText(subject, TOOL_ACTIVITY_ARGS_CHARS, "head");
  if (!args) return undefined;
  return { args: args.text, argsTruncated: args.truncated };
}

/**
 * One in-flight Codex item, remembered so an approval request can name its
 * subject. Two of codex's approval channels arrive without one (measured,
 * 0.145.0): `item/fileChange/requestApproval` carries only coordinates — the
 * paths and diff live on the `fileChange` item started just before it — and
 * the MCP elicitation carries the server name but not the tool. A decision
 * recorded without its subject is not a reviewable decision, so the driver
 * keeps a BOUNDED map of started items and correlates by itemId (fileChange)
 * or by server name (mcpToolCall; codex runs one tool call at a time within a
 * turn, so the most recent in-flight call for that server is the subject).
 */
type CodexInFlightItem = {
  type: "mcpToolCall" | "fileChange";
  server?: string;
  tool?: string;
  /** Absolute changed paths for a fileChange, in item order. */
  paths?: string[];
  detail?: ToolActivityDetail;
};

/** Hard cap on remembered in-flight items; oldest-first eviction. */
const CODEX_IN_FLIGHT_ITEM_CAP = 64;

/**
 * The subject of ONE approval request, in the gate's OWN action vocabulary.
 *
 * The bridge (core's `bridgeApproval`) classifies, digests, and mints receipts
 * from `{toolName, input}` — one vocabulary for every vendor. Handing it
 * codex's raw method names would make codex actions unclassifiable: no policy
 * simulation, no test-receipt redemption, and evidence whose `action` is a
 * JSON-RPC method. So:
 *
 *  - a command execution is named `Bash` — the protocol's canonical
 *    shell-action name (`classifyToolAction`) — with the UNWRAPPED command
 *    (codex wraps every command in `/bin/zsh -lc '…'`; the wrapper is
 *    transport, not intent, and receipt redemption is byte-equality against
 *    the harness's rendered check line, which the wrapped form can never
 *    match);
 *  - a single-file change is named `Edit` with its `file_path`, so an
 *    edit-class policy radius applies to codex exactly as it does to Claude;
 *  - a multi-file change is named `apply_patch` (codex's own tool) with the
 *    path list — multi-target, so it deliberately matches no auto-allow class
 *    and always gates;
 *  - anything unrecognized keeps today's shape (the raw params), which can
 *    only gate. Fail closed, never fail open.
 */
function codexApprovalSubject(
  method: string,
  params: Record<string, unknown>,
  inFlight: ReadonlyMap<string, CodexInFlightItem>
): { toolName: string; input: unknown; detail?: ToolActivityDetail } {
  if (method === "item/commandExecution/requestApproval") {
    const actions = Array.isArray(params.commandActions)
      ? (params.commandActions as Record<string, unknown>[])
      : [];
    const inner =
      actions.length === 1 && typeof actions[0]?.command === "string"
        ? (actions[0].command as string)
        : typeof params.command === "string"
          ? params.command
          : undefined;
    const input = {
      ...(inner !== undefined ? { command: inner } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    };
    return {
      toolName: "Bash",
      input,
      detail: codexApprovalDetail(
        inner !== undefined ? { command: inner } : params
      ),
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const item =
      typeof params.itemId === "string"
        ? inFlight.get(params.itemId)
        : undefined;
    if (item?.type === "fileChange" && item.paths && item.paths.length > 0) {
      if (item.paths.length === 1) {
        return {
          toolName: "Edit",
          input: { file_path: item.paths[0] },
          ...(item.detail ? { detail: item.detail } : {}),
        };
      }
      return {
        toolName: "apply_patch",
        input: { paths: item.paths },
        ...(item.detail ? { detail: item.detail } : {}),
      };
    }
    // No started item to correlate: the change's subject is unknown, so the
    // request keeps its coordinates and can only gate.
    return {
      toolName: "apply_patch",
      input: params,
      detail: codexApprovalDetail(params),
    };
  }
  return {
    toolName: String(params.tool ?? params.command ?? method),
    input: params,
    detail: codexApprovalDetail(params),
  };
}

/**
 * Remember a started item this driver may need as an approval subject; forget
 * it on completion. Bounded: beyond the cap the OLDEST entry is evicted —
 * losing a subject only degrades an approval card to coordinates, never the
 * gate itself.
 */
function trackCodexInFlightItem(
  inFlight: Map<string, CodexInFlightItem>,
  phase: "started" | "completed",
  item: unknown
): void {
  if (!item || typeof item !== "object") return;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return;
  if (phase === "completed") {
    inFlight.delete(record.id);
    return;
  }
  const type =
    typeof record.type === "string" ? CODEX_ITEM_TYPES[record.type] : undefined;
  if (type !== "mcpToolCall" && type !== "fileChange") return;
  const entry: CodexInFlightItem = { type };
  if (type === "mcpToolCall") {
    if (typeof record.server === "string") entry.server = record.server;
    if (typeof record.tool === "string") entry.tool = record.tool;
  } else {
    const changes = Array.isArray(record.changes)
      ? (record.changes as Record<string, unknown>[])
      : [];
    const paths = changes
      .map((change) => change.path)
      .filter((path): path is string => typeof path === "string");
    if (paths.length > 0) entry.paths = paths;
  }
  const detail = codexItemDetail(record);
  if (detail) entry.detail = detail;
  if (inFlight.size >= CODEX_IN_FLIGHT_ITEM_CAP) {
    const oldest = inFlight.keys().next().value;
    if (oldest !== undefined) inFlight.delete(oldest);
  }
  inFlight.set(record.id, entry);
}

/**
 * The most recent in-flight MCP tool call for one server — the subject of an
 * elicitation request, which names the server but not the tool.
 */
function latestInFlightMcpToolCall(
  inFlight: ReadonlyMap<string, CodexInFlightItem>,
  server: string
): CodexInFlightItem | undefined {
  let match: CodexInFlightItem | undefined;
  for (const entry of inFlight.values()) {
    if (entry.type === "mcpToolCall" && entry.server === server) {
      match = entry;
    }
  }
  return match;
}

/**
 * What ONE Codex item actually DID: the call it was, and what it returned.
 *
 * This path used to copy nothing at all off an item lifecycle. That posture is
 * reopened DELIBERATELY, and for the same reason it was reopened on the Claude
 * path: a tool card whose body is empty tells the human nothing, and a product
 * where one vendor's cards are readable and the other's are blank is worse than
 * either choice made consistently.
 *
 * What made the old posture safe was never "capture nothing" — it was the
 * controls, and every one of them still applies. The payload is UNTRUSTED: it is
 * bounded HERE (so nothing larger than the bound is ever retained on an event),
 * redacted by @muon/core's `redactedTail` on the way into the ledger (the single
 * redactor — adapters cannot import core, since core depends on adapters), and
 * rendered as data behind a human expand, never as MUON's own words. The
 * activity LINE stays coordinates-only; the payload lives only in `detail`.
 *
 * Args are HEAD-kept — the command is the identity of the call. Results are
 * TAIL-kept — the end of an output is where the error is.
 */
function codexItemDetail(
  record: Record<string, unknown>
): ToolActivityDetail | undefined {
  // Prefer the concrete subject fields Codex sends per item type (command for
  // an exec, changes/diff for a patch, arguments for an MCP call, prompt for a
  // native sub-agent); an unfamiliar item simply yields nothing rather than
  // guessing at a field.
  //
  // BOTH SPELLINGS. `codex app-server` (v2 RPC) sends camelCase and
  // `codex exec --json` sends snake_case for the SAME item — measured against
  // 0.145.0. Listing both here is what lets one extractor serve both
  // transports, instead of the exec path growing a second, drifting copy.
  const argsSource =
    record.command ??
    record.changes ??
    record.diff ??
    record.arguments ??
    record.args ??
    record.input ??
    record.prompt;
  const resultSource =
    record.aggregatedOutput ??
    record.aggregated_output ??
    record.output ??
    record.result ??
    // A failed MCP call carries its cause here and nowhere else; without it a
    // failed tool card would render as an empty box.
    (record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).message
      : record.error);
  const args =
    argsSource === undefined
      ? undefined
      : boundToolActivityText(argsSource, TOOL_ACTIVITY_ARGS_CHARS, "head");
  const result =
    resultSource === undefined
      ? undefined
      : boundToolActivityText(resultSource, TOOL_ACTIVITY_RESULT_CHARS, "tail");
  if (!args && !result) return undefined;
  return {
    ...(args ? { args: args.text, argsTruncated: args.truncated } : {}),
    ...(result
      ? { result: result.text, resultTruncated: result.truncated }
      : {}),
  };
}

/** Extract file-change paths from both app-server and `exec --json` shapes. */
function codexFileChangePaths(record: Record<string, unknown>): string[] {
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const fromChanges = changes.flatMap((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) return [];
    const entry = change as Record<string, unknown>;
    return [entry.path, entry.file_path, entry.filePath];
  });
  return boundToolActivityPaths([
    ...fromChanges,
    record.path,
    record.file_path,
    record.filePath,
    ...(Array.isArray(record.paths) ? record.paths : []),
  ]);
}

/**
 * The ONE item vocabulary, stated once.
 *
 * `codex app-server` names an item `mcpToolCall`; `codex exec --json` names the
 * SAME item `mcp_tool_call` (measured, 0.145.0). Normalizing here is what lets
 * both transports share `codexActivityFromItem` — the alternative was a second
 * extractor on the exec path, which is how the two would drift.
 */
const CODEX_ITEM_TYPES: Readonly<Record<string, CodexActivity["itemType"]>> = {
  mcpToolCall: "mcpToolCall",
  mcp_tool_call: "mcpToolCall",
  commandExecution: "commandExecution",
  command_execution: "commandExecution",
  fileChange: "fileChange",
  file_change: "fileChange",
  collabAgentToolCall: "collabAgentToolCall",
  collab_agent_tool_call: "collabAgentToolCall",
};

/**
 * Extract bounded coordinates — and the bounded, still-untrusted detail above —
 * from Codex item lifecycle notifications.
 *
 * Exported for the `codex exec --json` translator (./codex-exec-stream.ts): the
 * one-shot lane must produce byte-identical activity shapes to the interactive
 * one, and sharing the extractor is the only way that stays true.
 */
export function codexActivityFromItem(item: unknown): CodexActivity | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const itemType =
    typeof record.type === "string" ? CODEX_ITEM_TYPES[record.type] : undefined;
  if (!itemType) return null;
  const itemId = boundedCodexCoordinate(record.id, "unknown", 128);
  const detail = codexItemDetail(record);
  const status =
    typeof record.status === "string"
      ? boundedCodexCoordinate(record.status, "unknown", 32)
      : undefined;
  if (
    itemType === "mcpToolCall" &&
    typeof record.server === "string" &&
    typeof record.tool === "string"
  ) {
    const server = boundedCodexCoordinate(record.server, "unknown");
    const tool = boundedCodexCoordinate(record.tool, "unknown");
    return {
      itemId,
      itemType: "mcpToolCall",
      server,
      tool,
      status,
      label: `${server}.${tool}`,
      ...(detail ? { detail } : {}),
    };
  }
  if (itemType === "commandExecution") {
    return {
      itemId,
      itemType: "commandExecution",
      status,
      label: "Codex command",
      ...(detail ? { detail } : {}),
    };
  }
  if (itemType === "fileChange") {
    const paths = codexFileChangePaths(record);
    return {
      itemId,
      itemType: "fileChange",
      status,
      label: "Codex file change",
      ...(paths.length > 0 ? { paths } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  if (itemType === "collabAgentToolCall") {
    return {
      itemId,
      itemType: "collabAgentToolCall",
      status,
      label: "Codex native sub-agent",
      ...(detail ? { detail } : {}),
    };
  }
  // An `mcpToolCall` whose server/tool coordinates are missing lands here: the
  // call happened, but MUON cannot name it, and inventing a label would be
  // worse than saying nothing.
  return null;
}

/**
 * The metadata ONE item lifecycle event carries.
 *
 * `codexActivity` stays exactly what it has always been — bounded coordinates,
 * no payload — because the runner's startup watchdog and every existing reader
 * key off it. `toolActivity` is the vendor-neutral shape @muon/core's stream
 * recorder reads (and redacts), byte-identical in shape to the one the Claude
 * driver emits, so a Codex tool card is built by the SAME path as a Claude one
 * rather than by a second mechanism. The payload rides `toolActivity.detail`
 * alone, so exactly one copy of it is ever retained on an event.
 *
 * A failed completion reports `failed`, matching both the event kind chosen at
 * the call site and the phase vocabulary the Claude driver uses.
 */
export function codexItemMetadata(
  phase: "started" | "completed",
  activity: CodexActivity
): Record<string, unknown> {
  const { detail, ...coordinates } = activity;
  return {
    codexActivity: { phase, ...coordinates },
    toolActivity: {
      provider: "codex",
      phase:
        phase === "completed" && activity.status === "failed"
          ? "failed"
          : phase,
      itemId: activity.itemId,
      tool: activity.label,
      ...(activity.itemType === "fileChange"
        ? { fileMutation: true, paths: activity.paths ?? [] }
        : {}),
      ...(detail ? { detail } : {}),
    },
  };
}

/**
 * Why the run was refused, in words the operator can act on.
 *
 * The MUON-MCP reasons are rendered through the SAME sentence the Claude gate
 * ends with (./muon-mcp-readiness.ts), so a withheld brief reads identically on
 * both vendors. Every one of them names TOOLS and never environment values: the
 * governed server's env is a two-sided contract whose values live only in the
 * filtered child env (./mcp-env-contract.ts), and a diagnostic that printed one
 * would defeat it.
 */
function codexPreflightBlockMessage(
  preflight: CodexCapabilityPreflight,
  readyTimeoutMs: number,
  grantedServers: readonly string[] = []
): string {
  const reason = preflight.blockReason;
  // Kept as the stable prefix of EVERY refusal from this seam, so a surface
  // that recognizes a blocked preflight today still recognizes one after the
  // MUON-MCP reasons below started carrying their own diagnosis.
  const blocked = (detail: string) =>
    `Codex capability preflight blocked the session: ${detail}`;
  if (reason === "provider-credential-missing") {
    return blocked(
      "the active custom provider credential is unavailable to MUON's Codex child. Launch MUON from an environment that provides the env_key declared in trusted user Codex configuration, then retry."
    );
  }
  if (reason === "required-muon-missing") {
    return blocked(
      muonHandshakeFailure(
        preflight.mcp.missingTools.length > 0
          ? missingMuonToolsDetail(
              preflight.mcp.missingTools.map(
                (tool) => `${MUON_MCP_TOOL_PREFIX}${tool}`
              )
            )
          : `MUON MCP server '${MUON_MCP_SERVER_NAME}' never appeared in Codex's tool inventory (${preflight.mcp.serverCount} server(s) reported), so its granted tools cannot be confirmed present.`
      )
    );
  }
  if (reason === "ungranted-mcp-servers") {
    return blocked(
      ungrantedCodexServersDetail(
        preflight.mcp.unexpectedServers,
        grantedServers
      )
    );
  }
  if (reason === "native-multi-agent") {
    return blocked(
      `Codex reported multiAgentMode '${preflight.policy.multiAgentMode}', which lets the model spawn vendor-native subagents on its own initiative. MUON cannot see, budget, lineage-track, or collect evidence from those children, so their edits would arrive with no job id and no worktree claim — this run's file claims and handoff evidence would both be wrong. MUON refused rather than dispatching a worker whose real fan-out it could not account for.`
    );
  }
  if (reason === "mcp-inventory-timeout") {
    return blocked(
      muonHandshakeFailure(
        // No longer "go edit your ~/.codex/config.toml". MUON isolates the
        // child from that file and supplies the server set itself, so a stall
        // here is a MUON-granted server failing to start — which is MUON's to
        // report, not the operator's to go hunting for.
        `Codex did not answer '${CODEX_RPC.mcpServerStatusList}' within ${readyTimeoutMs}ms, so MUON could not confirm which '${MUON_MCP_SERVER_NAME}' tools this turn would have. Codex answers that request only once every MCP server it was given has finished starting, and MUON granted exactly: ${
          grantedServers.length > 0 ? grantedServers.join(", ") : "(none)"
        }.`
      )
    );
  }
  if (reason === "mcp-inventory-unsupported") {
    return blocked(
      muonHandshakeFailure(
        `This 'codex app-server' build does not implement '${CODEX_RPC.mcpServerStatusList}', so MUON cannot enumerate the '${MUON_MCP_SERVER_NAME}' tools this turn would have. Upgrade the codex CLI (0.145 or newer) and retry.`
      )
    );
  }
  if (reason === "mcp-inventory-error") {
    return blocked(
      muonHandshakeFailure(
        `Codex returned an unreadable '${CODEX_RPC.mcpServerStatusList}' inventory, so MUON could not confirm which '${MUON_MCP_SERVER_NAME}' tools this turn would have.`
      )
    );
  }
  return blocked(`${reason ?? "policy"}.`);
}

function extractThreadId(result: Record<string, unknown> | undefined): string {
  if (!result) {
    return "thread-0";
  }
  const thread = result.thread as Record<string, unknown> | undefined;
  return String(
    thread?.id ?? result.threadId ?? result.thread_id ?? "thread-0"
  );
}

function spawnCodexTransport(
  cwd?: string,
  extraArgs: string[] = [],
  env?: Record<string, string>,
  onDiagnostic?: (chunk: string) => void
): RpcTransport {
  if (!commandExists("codex")) {
    throw new Error(
      "Codex interactive sessions need the 'codex' CLI (app-server surface). Install it or use `muon run` for one-shot execution."
    );
  }

  const child: ChildProcess = spawn("codex", ["app-server", ...extraArgs], {
    cwd,
    // Deliver the MCP server env (incl. MUON_API_TOKEN) via the child process
    // env so codex forwards it by name (env_vars) to the muon MCP server, the
    // token is never placed on argv (S2).
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const handlers: ((message: JsonRpcMessage) => void)[] = [];
  const exitWaiters: ((code: number) => void)[] = [];
  let exitCode: number | undefined;
  let productionClosePromise: Promise<void> | undefined;
  const stderr = createCodexStderrTail(onDiagnostic);
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.observe(chunk.toString());
  });
  const settleProcessExit = (code: number) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    for (const waiter of exitWaiters) {
      waiter(exitCode);
    }
    exitWaiters.length = 0;
  };
  child.on("error", (error) => {
    stderr.append(` ${boundedCodexFailure(error, 400)}`);
    settleProcessExit(1);
  });
  child.on("close", (code) => {
    settleProcessExit(code ?? 1);
  });
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      for (const handler of handlers) {
        handler(message);
      }
    } catch {
      // non-JSON output is ignored
    }
  });

  return {
    send: (message) => {
      // Fail fast when app-server died on bad argv (e.g. rejected `--model`)
      // instead of hanging until the runner's 90s startup stall.
      if (exitCode !== undefined) {
        const detail = boundedCodexFailure(stderr.read(), 800);
        throw new Error(
          detail
            ? `Codex app-server exited before RPC (${exitCode}): ${detail}`
            : `Codex app-server exited before RPC (${exitCode}).`
        );
      }
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    onMessage: (handler) => {
      handlers.push(handler);
    },
    close: () => {
      productionClosePromise ??= new Promise<void>((resolve) => {
        if (exitCode !== undefined) {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(hardKill);
          clearTimeout(finalBound);
          child.removeListener("close", finish);
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve();
        };
        const hardKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The bounded waiter below still settles even if the OS rejects kill.
          }
        }, Math.max(1, CODEX_TRANSPORT_CLOSE_MS - 500));
        const finalBound = setTimeout(finish, CODEX_TRANSPORT_CLOSE_MS);
        child.once("close", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      });
      return productionClosePromise;
    },
    waitForExit: () =>
      new Promise((resolve) => {
        if (exitCode !== undefined) {
          resolve(exitCode);
          return;
        }
        exitWaiters.push(resolve);
      }),
  };
}

/**
 * Interactive Codex sessions over the official `codex app-server` JSON-RPC
 * surface (v2). Server-initiated approval requests bridge into MUON's inbox
 * and fail closed on deny/timeout.
 */
export class CodexSessionDriver implements LaneSessionDriver {
  readonly laneKey = "codex";
  readonly capabilities = { canSend: true, canInterrupt: true, canResume: false };
  /** The app-server runs as a child process, so MUON owns its stderr. */
  readonly forwardsVendorStderr = true;

  constructor(
    private readonly createTransport: (
      cwd?: string,
      extraArgs?: string[],
      env?: Record<string, string>,
      onDiagnostic?: (chunk: string) => void
    ) => RpcTransport = spawnCodexTransport,
    private readonly options: {
      turnIdleTimeoutMs?: number;
      transportCloseTimeoutMs?: number;
      transportExitTimeoutMs?: number;
      interruptRpcTimeoutMs?: number;
      /**
       * Bounds BOTH halves of the MUON-MCP readiness gate: the wait for
       * `muon` to report `ready`, and the wait for its granted tools to show up
       * in the inventory. Named to match `ClaudeSessionDriverOptions` — one
       * readiness pattern, one knob per vendor.
       */
      muonMcpReadyTimeoutMs?: number;
      muonMcpPollIntervalMs?: number;
      /**
       * Injection seam for the post-failure `muon-mcp` probe: the real one
       * spawns the real binary, which a unit test has no business doing.
       */
      readMuonMcpStartupFailure?: typeof readMuonMcpStartupFailure;
      /**
       * Injection seam for the ambient-config guard. The real one reads the
       * DEVELOPER's own `~/.codex` and creates a directory in their tmpdir —
       * a unit test that did either would pass or fail based on whose machine
       * it ran on, which is precisely the coupling this guard removes.
       */
      prepareCodexGuardHome?: typeof prepareCodexGuardHome;
    } = {}
  ) {}

  /**
   * Turn a MUON-MCP startup failure into the reason `muon-mcp` ITSELF gave.
   *
   * Codex reports "MCP client for `muon` failed to start … connection closed:
   * initialize response" — the shape of a server that exited during the
   * handshake, with the cause on a stderr codex does not forward. Re-run it
   * ourselves (bounded, failure path only) and append its own sentence. When the
   * probe finds nothing, the vendor's original error is returned UNCHANGED: a
   * cause MUON did not observe is never asserted.
   */
  private async explainMuonMcpFailure(
    error: unknown,
    input: SessionStartInput,
    childEnv: Record<string, string>,
    handlers: SessionHandlers
  ): Promise<unknown> {
    const server = input.profile?.mcpServers?.find(
      (entry) => entry.name === MUON_MCP_SERVER_NAME
    );
    if (!server?.command || input.signal?.aborted) {
      return error;
    }
    const probe =
      this.options.readMuonMcpStartupFailure ?? readMuonMcpStartupFailure;
    let detail = "";
    try {
      detail = await probe({
        command: server.command,
        args: server.args ?? [],
        env: childEnv,
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      // Diagnosis must never replace the failure it was trying to explain.
      return error;
    }
    if (!detail) {
      return error;
    }
    handlers.onDiagnostic?.(`\nmuon-mcp (governed MCP server) stderr: ${detail}\n`);
    const base = error instanceof Error ? error.message : String(error);
    return new Error(`${base} muon-mcp itself reported: ${detail}`);
  }

  async start(
    input: SessionStartInput,
    handlers: SessionHandlers
  ): Promise<SessionHandle> {
    // createTransport() starts the vendor process synchronously.
    input.signal?.throwIfAborted();
    if (
      input.profile?.permissionMode === "full-auto" &&
      input.profile.sandbox === "full-access"
    ) {
      throw new Error(
        "Codex capability preflight blocked: unsafe full-auto plus full-access policy."
      );
    }
    const compiled = input.profile ? compileCodexProfile(input.profile) : undefined;
    // Throws rather than degrading to the ambient home: see CodexGuardHomeError.
    // Established BEFORE the env is built so `CODEX_HOME` is present when
    // `buildProviderAwareLaneEnvironment` resolves provider evidence — it reads
    // `<CODEX_HOME>/config.toml`, and it must read the CHILD's root, not the
    // operator's, or the evidence would describe a configuration the child
    // cannot see.
    let guardHome;
    try {
      guardHome = (this.options.prepareCodexGuardHome ?? prepareCodexGuardHome)(
        {}
      );
    } catch (error) {
      // A guard refusal is a governance decision, so it reaches the operator on
      // the same `task.blocked` surface every other one does, instead of only
      // as a rejected promise. Rethrown unchanged: the event is additional
      // evidence, never a substitute for failing the launch.
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          "task.blocked",
          error instanceof Error ? error.message : String(error),
          { controlPlane: true, reason: "codex-guard" }
        )
      );
      throw error;
    }
    handlers.onEvent(
      makeSessionEvent(
        this.laneKey,
        input.taskId,
        "task.progress",
        CODEX_GUARD_NOTICE,
        {
          controlPlane: true,
          codexGuardHome: true,
          codexAuthLinked: guardHome.authLinked,
        }
      )
    );
    const laneEnvironment = buildProviderAwareLaneEnvironment(
      "codex",
      process.env,
      {
        ...compiled?.env,
        // The guard env wins over anything the profile supplied: a profile that
        // set CODEX_HOME itself would otherwise re-point the child at the
        // operator's own configuration, which is the breach this closes.
        ...codexGuardEnv(guardHome.home),
      }
    );
    const childEnv = Object.fromEntries(
      Object.entries(
        laneEnvironment
      ).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      )
    );
    // MUON_API_TOKEN here is the explicit runner-issued per-job bearer hoisted
    // from the governed MUON MCP profile. The runner's shared
    // MUON_AGENT_TOKEN is deliberately absent from every vendor environment.
    //
    // Codex resolves `mcp_servers.muon.env_vars` against ITS OWN env, so this
    // is the last point where MUON can still see whether every declared name
    // survived the lane env filter. Assert before the spawn: a missing lineage
    // var makes muon-mcp exit inside `initialize`, and codex reports only its
    // own opaque summary. See ./mcp-env-contract.ts.
    assertMuonMcpEnvContract(input.profile?.mcpServers ?? [], childEnv);

    /**
     * The three facts that turn a bare exit code into an attribution.
     *
     * `startupPhase` flips to `ready` only once the capability preflight has
     * read an inventory, so "died before it could tell us what it had" is a
     * state MUON can assert rather than infer. `grantedMcpServerNames` is
     * meaningful for the first time here: before the guard, MUON did not choose
     * the child's server set and could not have named it.
     */
    let startupPhase: CodexStartupPhase = "mcp-startup";
    const grantedMcpServerNames = (input.profile?.mcpServers ?? []).map(
      (server) => server.name
    );
    // The transport keeps its own tail for `send()`, but the driver cannot see
    // it. Tee the same stream the watchdog gets — bounded here too, because a
    // dying child can write a great deal on the way out.
    let startupStderrTail = "";
    const onDiagnostic = (chunk: string): void => {
      startupStderrTail = `${startupStderrTail}${chunk}`.slice(
        -CODEX_TRANSPORT_STDERR_TAIL_CHARS
      );
      handlers.onDiagnostic?.(chunk);
    };

    // Nested-sandbox lockout fix (see codex-guard.ts): inside MUON's own
    // Seatbelt-confined runner, macOS refuses codex's per-command sandbox, so
    // an app-server session could not run even `pwd`. Appended AFTER the
    // compiled args so the last `-c sandbox_mode` wins; loud, never silent;
    // never for a read-only profile.
    const sandboxOverride = codexSandboxOverrideArgs(process.env, [
      ...CODEX_AMBIENT_SUPPRESSION_ARGS,
      ...(compiled?.args ?? []),
    ]);
    // The ONE composed argv, post-strip — exactly what the transport receives.
    // Every "what does this child actually run under" question below (the
    // capability notice AND the thread/start params) reads THIS, because the
    // channels must never disagree about the boundary they describe.
    const composedArgs = guardedCodexArgs([
      ...CODEX_AMBIENT_SUPPRESSION_ARGS,
      ...(compiled?.args ?? []),
      ...sandboxOverride,
    ]);
    // F-A: what this child is ACTUALLY bounded by, once, where the operator
    // reads. `compiled.unsupported` was computed on the line above the
    // transport and then discarded on this path — a declared capability the
    // lane could not hold left no trace at all here. Unlike the one-shot lane,
    // an interactive session DOES have a gate: every tool call crosses MUON's
    // own approval bridge, so it says so.
    const capabilityNotice = codexCapabilityNotice({
      unsupported: compiled?.unsupported ?? [],
      honoredDenials: input.profile
        ? compileCodexToolPolicy(input.profile).honoredDenials
        : [],
      sandboxMode: effectiveCodexSandboxMode(composedArgs),
      canAskApproval: true,
    });
    if (capabilityNotice) {
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          "task.progress",
          capabilityNotice,
          {
            controlPlane: true,
            codexCapabilityDegraded: compiled?.unsupported ?? [],
            codexApprovalGate: "muon-bridge",
          }
        )
      );
    }
    if (sandboxOverride.length > 0) {
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          "task.progress",
          CODEX_NESTED_SANDBOX_NOTICE,
          { controlPlane: true, codexNestedSandboxOverride: true }
        )
      );
    }
    const transport = this.createTransport(
      input.cwd,
      // The suppression args lead, so MUON's own overrides are stated before any
      // profile passthrough, and the whole argv already went through the
      // categorical widening strip above — a caller cannot re-enable `apps`
      // through `extraArgs`, and a session that carries NO profile is still
      // isolated.
      composedArgs,
      childEnv,
      // Attached at spawn, so stderr produced while the RPC handshake or the
      // first turn is still hanging is already visible to the caller's watchdog.
      onDiagnostic
    );

    let requestId = 0;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (message: JsonRpcMessage) => void;
        reject: (error: unknown) => void;
      }
    >();
    let output = "";
    let turnExitCode = 0;
    let turnFailure: string | undefined;
    let turnStarted = false;
    let turnSettled = false;
    let lastTurnUsage:
      | { turnId?: string; usage: VendorTokenUsage }
      | undefined;
    const pendingApprovalCounts = new Map<string, number>();
    // Started-but-unfinished items, kept so an approval request that arrives
    // without its subject (fileChange, MCP elicitation) can still name it.
    const inFlightItems = new Map<string, CodexInFlightItem>();
    let transportExitCode: number | undefined;
    let turnIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn: () => void = () => undefined;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const settleTurn = () => {
      if (turnSettled) return;
      turnSettled = true;
      if (turnIdleTimer) {
        clearTimeout(turnIdleTimer);
        turnIdleTimer = undefined;
      }
      resolveTurn();
    };
    let resolveMuonReady: () => void = () => undefined;
    let rejectMuonReady: (error: Error) => void = () => undefined;
    let muonReadySettled = false;
    const muonReady = new Promise<void>((resolve, reject) => {
      resolveMuonReady = () => {
        muonReadySettled = true;
        resolve();
      };
      rejectMuonReady = (error) => {
        muonReadySettled = true;
        reject(error);
      };
    });
    // Transport death races the single muonReady awaiter; when the awaiter has
    // already been released by rejectPending, this rejection has no listener
    // left and surfaces as an unhandled rejection. Mark it observed — every
    // real consumer attaches before start() returns and still sees the error.
    muonReady.catch(() => undefined);
    const expectsMuonMcp = Boolean(
      input.profile?.mcpServers?.some(
        (server) => server.name === MUON_MCP_SERVER_NAME
      )
    );
    const muonMcpReadyTimeoutMs =
      this.options.muonMcpReadyTimeoutMs ?? MUON_MCP_READY_MS;
    let leaseAborted = input.signal?.aborted ?? false;
    let closePromise: Promise<void> | undefined;
    const closeTransport = (): Promise<void> => {
      closePromise ??= (async () => {
        const closeAttempt = Promise.resolve().then(() => transport.close());
        await settlesWithin(
          closeAttempt,
          this.options.transportCloseTimeoutMs ?? CODEX_TRANSPORT_CLOSE_MS
        );
      })();
      return closePromise;
    };
    const approvalKey = (id: number | string): string =>
      `${typeof id}:${String(id)}`;
    const beginApproval = (id: number | string) => {
      const key = approvalKey(id);
      pendingApprovalCounts.set(key, (pendingApprovalCounts.get(key) ?? 0) + 1);
      if (turnIdleTimer) {
        clearTimeout(turnIdleTimer);
        turnIdleTimer = undefined;
      }
      return key;
    };
    const finishApproval = (key: string): boolean => {
      const count = pendingApprovalCounts.get(key) ?? 0;
      if (count <= 1) {
        pendingApprovalCounts.delete(key);
      } else {
        pendingApprovalCounts.set(key, count - 1);
      }
      return pendingApprovalCounts.size === 0;
    };
    const rejectPending = (reason: unknown) => {
      for (const waiter of pending.values()) {
        waiter.reject(reason);
      }
      pending.clear();
    };
    /**
     * A bare exit code is not a diagnosis. The founder hit `130` twice on this
     * lane with zero output, and the coordinator could only call it an
     * unattributable external kill — nothing here knew that MUON had handed the
     * child a six-server MCP startup with a failing OAuth refresh. Now MUON
     * chooses the set, so it can name it, name the signal the code encodes, and
     * say which phase the child died in.
     */
    const transportExitError = (code: number) => {
      // Vendor stderr is untrusted text carrying vendor state: redact and bound
      // it through the same control every other codex failure string uses.
      const tail = boundedCodexFailure(startupStderrTail, 400);
      return new Error(
        codexStartupExitDetail({
          code,
          phase: startupPhase,
          grantedServers: grantedMcpServerNames,
          ...(tail ? { stderrTail: tail } : {}),
        })
      );
    };
    const armTurnIdleTimer = () => {
      if (!turnStarted || turnSettled) return;
      if (turnIdleTimer) clearTimeout(turnIdleTimer);
      if (pendingApprovalCounts.size > 0) {
        turnIdleTimer = undefined;
        return;
      }
      const idleMs =
        this.options.turnIdleTimeoutMs ?? CODEX_TURN_IDLE_MS;
      if (idleMs <= 0) return;
      turnIdleTimer = setTimeout(() => {
        turnExitCode = 1;
        turnFailure = `Codex produced no protocol activity for ${Math.round(
          idleMs / 1000
        )}s. MUON stopped the unresponsive provider turn; retry after checking Codex login, provider, and MCP health.`;
        handlers.onEvent(
          makeSessionEvent(
            this.laneKey,
            input.taskId,
            "task.blocked",
            turnFailure,
            { controlPlane: true, reason: "provider-idle-timeout" }
          )
        );
        settleTurn();
        void closeTransport().catch(() => undefined);
      }, idleMs);
      turnIdleTimer.unref?.();
    };
    // If app-server dies at any point, unblock both RPC waiters and the active
    // turn. The old pending.size===0 early return left handle.wait() unresolved
    // when the process exited after turn/start had already been acknowledged.
    const transportExitPromise = Promise.resolve().then(() =>
      transport.waitForExit()
    );
    void transportExitPromise.then(
      (code) => {
        transportExitCode = code;
        const error = transportExitError(code);
        rejectPending(error);
        if (!muonReadySettled) {
          if (expectsMuonMcp) {
            rejectMuonReady(error);
          } else {
            resolveMuonReady();
          }
        }
        if (turnStarted && !turnSettled) {
          turnExitCode = leaseAborted ? 130 : code === 0 ? 1 : code;
          turnFailure = error.message;
          if (!leaseAborted) {
            handlers.onEvent(
              makeSessionEvent(
                this.laneKey,
                input.taskId,
                "task.blocked",
                turnFailure,
                { controlPlane: true, reason: "provider-exit", exitCode: code }
              )
            );
          }
          settleTurn();
        }
      },
      () => {
        const error = new Error(
          "Codex app-server exit monitoring failed before the provider turn settled."
        );
        rejectPending(error);
        if (!muonReadySettled) {
          if (expectsMuonMcp) rejectMuonReady(error);
          else resolveMuonReady();
        }
        if (turnStarted && !turnSettled) {
          turnExitCode = leaseAborted ? 130 : 1;
          turnFailure = error.message;
          if (!leaseAborted) {
            handlers.onEvent(
              makeSessionEvent(
                this.laneKey,
                input.taskId,
                "task.blocked",
                turnFailure,
                { controlPlane: true, reason: "provider-exit-monitor" }
              )
            );
          }
          settleTurn();
        }
      }
    );
    const onAbort = () => {
      leaseAborted = true;
      const reason = input.signal?.reason;
      rejectPending(reason);
      settleTurn();
      void closeTransport().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<JsonRpcMessage>((resolve, reject) => {
        try {
          input.signal?.throwIfAborted();
        } catch (error) {
          reject(error);
          return;
        }
        requestId += 1;
        const id = requestId;
        if (transportExitCode !== undefined) {
          reject(transportExitError(transportExitCode));
          return;
        }
        pending.set(id, { method, resolve, reject });
        try {
          transport.send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });

    /**
     * ONE decision path for every server-initiated approval, whatever reply
     * vocabulary the method needs (`decision: accept/decline` for
     * `item/…/requestApproval`, `action: accept/decline` for the MCP
     * elicitation). The request, the verdict, and a fail-closed denial all
     * name the same bounded subject; a bridge failure or missing decision
     * denies — never allows, never leaves codex waiting.
     */
    const answerApproval = (
      requestId: number | string,
      bridge: { toolName: string; input: unknown },
      display: { safeToolName: string; detail?: ToolActivityDetail },
      buildReply: (decision: {
        behavior: "allow" | "deny";
        message?: string;
      }) => {
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      }
    ): void => {
      const { safeToolName, detail: approvalDetail } = display;
      const pendingApprovalKey = beginApproval(requestId);
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          "approval.requested",
          `session tool request: ${safeToolName}`,
          {
            controlPlane: true,
            approvalWaiting: true,
            toolActivity: {
              provider: "codex",
              phase: "waiting-approval",
              tool: safeToolName,
              ...(approvalDetail ? { detail: approvalDetail } : {}),
            },
          }
        )
      );
      void (async () => {
        let decision:
          | { behavior: "allow" | "deny"; message?: string }
          | undefined;
        let bridgeFailure: unknown;
        try {
          decision = await handlers.onApprovalRequest({
            toolName: bridge.toolName,
            input: bridge.input,
            taskId: input.taskId,
            laneKey: this.laneKey,
          });
        } catch (error) {
          bridgeFailure = error;
        }

        const allApprovalsResolved = finishApproval(pendingApprovalKey);
        if (turnSettled || transportExitCode !== undefined) {
          return;
        }

        if (bridgeFailure || !decision) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.blocked",
              `${safeToolName} approval failed closed`,
              {
                controlPlane: true,
                ...(allApprovalsResolved
                  ? { approvalResolved: true }
                  : {
                      approvalPendingCount: pendingApprovalCounts.size,
                    }),
                toolActivity: {
                  provider: "codex",
                  phase: "denied",
                  tool: safeToolName,
                  ...(approvalDetail ? { detail: approvalDetail } : {}),
                },
              }
            )
          );
          try {
            transport.send({
              id: requestId,
              error: {
                code: -32000,
                message: `MUON denied: ${boundedCodexCoordinate(
                  boundedCodexFailure(
                    bridgeFailure ?? "approval bridge failed",
                    160
                  ),
                  "approval_failed",
                  160
                )}`,
              },
            });
          } catch {
            turnExitCode = 1;
            turnFailure =
              "Codex approval denial could not be delivered to app-server.";
            settleTurn();
            void closeTransport();
            return;
          }
        } else {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.progress",
              `${safeToolName} ${decision.behavior === "allow" ? "approved" : "denied"}`,
              {
                controlPlane: true,
                ...(allApprovalsResolved
                  ? { approvalResolved: true }
                  : {
                      approvalPendingCount: pendingApprovalCounts.size,
                    }),
                toolActivity: {
                  provider: "codex",
                  phase:
                    decision.behavior === "allow" ? "approved" : "denied",
                  tool: safeToolName,
                  ...(approvalDetail ? { detail: approvalDetail } : {}),
                },
              }
            )
          );
          const reply = buildReply(decision);
          try {
            if (reply.error) {
              transport.send({ id: requestId, error: reply.error });
            } else {
              transport.send({ id: requestId, result: reply.result });
            }
          } catch {
            turnExitCode = 1;
            turnFailure =
              "Codex approval response could not be delivered to app-server.";
            settleTurn();
            void closeTransport();
            return;
          }
        }
        if (allApprovalsResolved) armTurnIdleTimer();
      })();
    };

    transport.onMessage((message) => {
      if (turnStarted && !turnSettled) {
        armTurnIdleTimer();
      }
      // Responses to our calls.
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(Number(message.id));
        if (waiter) {
          pending.delete(Number(message.id));
          if (message.error) {
            waiter.reject(
              Object.assign(new Error(message.error.message), {
                code: message.error.code,
                method: waiter.method,
              })
            );
          } else {
            waiter.resolve(message);
          }
        }
        return;
      }

      if (
        message.method === CODEX_RPC.mcpStartupStatus &&
        message.params?.name === MUON_MCP_SERVER_NAME &&
        !muonReadySettled
      ) {
        const status = String(message.params.status ?? "");
        if (status === "ready") {
          resolveMuonReady();
        } else if (status === "failed") {
          rejectMuonReady(
            new Error(
              String(
                message.params.error ??
                  "MUON MCP server failed to start inside Codex app-server."
              )
            )
          );
        }
      }

      // Dynamic client tools — answer so the turn cannot hang forever.
      if (message.method === "item/tool/call" && message.id !== undefined) {
        transport.send({
          id: message.id,
          result: {
            success: false,
            contentItems: [
              {
                type: "text",
                text: "MUON does not host Codex client-side dynamic tools; use the muon MCP server.",
              },
            ],
          },
        });
        return;
      }

      // MCP tool-call approvals under `approvalPolicy: "untrusted"` arrive on
      // the elicitation vocabulary, NOT as `item/*/requestApproval` (measured,
      // 0.145.0) — an unanswered one hangs its tool call until the idle
      // timeout. A call whose exact `mcp__<server>__<tool>` name is in the
      // profile's `allowedTools` is answered `accept` from the grant itself,
      // exactly as the Claude SDK pre-authorizes `allowedTools` before
      // `canUseTool`; everything else crosses MUON's approval bridge and fails
      // closed.
      if (
        message.method === CODEX_RPC.mcpElicitation &&
        message.id !== undefined
      ) {
        const params = message.params ?? {};
        const server =
          typeof params.serverName === "string" ? params.serverName : "";
        const subject = latestInFlightMcpToolCall(inFlightItems, server);
        const grantName =
          server && subject?.tool
            ? `mcp__${server}__${subject.tool}`
            : undefined;
        if (
          grantName !== undefined &&
          (input.profile?.allowedTools ?? []).includes(grantName)
        ) {
          try {
            transport.send({ id: message.id, result: { action: "accept" } });
          } catch {
            // The turn-level consequences surface through the transport-exit
            // path; a failed pre-authorization delivery needs no extra state.
          }
          return;
        }
        answerApproval(
          message.id,
          {
            toolName:
              grantName ??
              `mcp__${boundedCodexCoordinate(server, "unknown")}__unknown`,
            input: subject
              ? {
                  server,
                  ...(subject.tool ? { tool: subject.tool } : {}),
                  ...(subject.detail?.args !== undefined
                    ? { arguments: subject.detail.args }
                    : {}),
                }
              : params,
          },
          {
            safeToolName: boundedCodexCoordinate(
              grantName ?? server,
              "unknown"
            ),
            ...(subject?.detail
              ? { detail: subject.detail }
              : (() => {
                  const detail = codexApprovalDetail(params);
                  return detail ? { detail } : {};
                })()),
          },
          (decision) =>
            decision.behavior === "allow"
              ? { result: { action: "accept" } }
              : { result: { action: "decline" } }
        );
        return;
      }

      // Server-initiated approval-style requests: bridge to the MUON inbox.
      // Match Codex 0.145 method names (item/*/requestApproval), not the
      // obsolete approved/denied vocabulary.
      if (
        message.method &&
        message.id !== undefined &&
        (/requestApproval/i.test(message.method) ||
          /approval|exec/i.test(message.method))
      ) {
        const params = message.params ?? {};
        // The subject in the gate's own action vocabulary (Bash/Edit/…), so
        // core's classifier, policy simulation, and receipts see codex actions
        // exactly as they see Claude's.
        const subject = codexApprovalSubject(
          message.method,
          params,
          inFlightItems
        );
        answerApproval(
          message.id,
          { toolName: subject.toolName, input: subject.input },
          {
            safeToolName: boundedCodexCoordinate(
              params.tool ?? subject.toolName ?? message.method,
              "unknown"
            ),
            ...(subject.detail ? { detail: subject.detail } : {}),
          },
          (decision) => codexApprovalResult(message.method!, decision, params)
        );
        return;
      }

      if (message.method === CODEX_RPC.agentMessageDelta) {
        const text = String(message.params?.delta ?? "");
        if (text) {
          output += text;
          handlers.onEvent(
            makeSessionEvent(this.laneKey, input.taskId, "task.progress", text)
          );
        }
        return;
      }

      if (message.method === CODEX_RPC.itemStarted) {
        trackCodexInFlightItem(inFlightItems, "started", message.params?.item);
        const activity = codexActivityFromItem(message.params?.item);
        if (activity) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.progress",
              `${activity.label} started`,
              {
                controlPlane: true,
                ...codexItemMetadata("started", activity),
              }
            )
          );
        }
        return;
      }

      // Fallback when Codex emits the final agent message without deltas.
      if (message.method === CODEX_RPC.itemCompleted) {
        const completedItem = message.params?.item;
        const text = agentMessageTextFromItem(completedItem);
        if (text && !output.includes(text)) {
          const prior = output.trim();
          // A completed item may repeat the delta stream, partially contain it,
          // or carry a genuinely distinct final-answer block. Preserve only the
          // distinct case and mark its whole-message boundary for renderers.
          if (!prior || !text.includes(prior)) {
            output = prior ? `${output}\n${text}` : text;
            handlers.onEvent(
              makeSessionEvent(
                this.laneKey,
                input.taskId,
                "task.progress",
                text,
                { outputMode: "message" }
              )
            );
          }
        }
        trackCodexInFlightItem(
          inFlightItems,
          "completed",
          completedItem
        );
        if (
          typeof completedItem === "object" &&
          completedItem !== null &&
          (completedItem as { type?: unknown }).type === "contextCompaction" &&
          typeof (completedItem as { id?: unknown }).id === "string"
        ) {
          const itemId = boundedCodexCoordinate(
            (completedItem as { id: string }).id,
            "unknown",
            128
          );
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.progress",
              "Codex reported context compaction",
              {
                controlPlane: true,
                // Installed app-server v2 discloses the marker and id only. It
                // does NOT disclose the summary or forgotten members, so MUON
                // records a replayable knowledge gap instead of fabricating a
                // reconstructed context window.
                contextCondensation: {
                  origin: "vendor_reported",
                  sourceResponseId: `codex:item:${itemId}`,
                },
              }
            )
          );
        }
        const activity = codexActivityFromItem(completedItem);
        if (activity) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              activity.status === "failed" ? "task.blocked" : "task.progress",
              `${activity.label} ${activity.status ?? "completed"}`,
              {
                controlPlane: true,
                ...codexItemMetadata("completed", activity),
              }
            )
          );
        }
        return;
      }

      if (message.method === CODEX_RPC.mcpToolCallProgress) {
        const hasProgress =
          typeof message.params?.message === "string" &&
          message.params.message.trim().length > 0;
        if (hasProgress) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.progress",
              "Codex MCP tool is still working",
              {
                controlPlane: true,
                codexActivity: {
                  phase: "progress",
                  itemId: boundedCodexCoordinate(
                    message.params?.itemId,
                    "unknown",
                    128
                  ),
                  itemType: "mcpToolCall",
                },
              }
            )
          );
        }
        return;
      }

      if (message.method === CODEX_RPC.tokenUsageUpdated) {
        const usage = extractCodexTokenUsage(message.params ?? {});
        if (usage) {
          const turnId =
            typeof message.params?.turnId === "string"
              ? message.params.turnId
              : undefined;
          lastTurnUsage = {
            ...(turnId ? { turnId } : {}),
            usage,
          };
        }
        return;
      }

      if (message.method === CODEX_RPC.turnCompleted) {
        const turn = message.params?.turn as
          | {
              id?: string;
              status?: string;
              durationMs?: number | null;
              error?: { message?: string } | null;
            }
          | undefined;
        const status = turn?.status ?? "completed";
        const errorMessage =
          turn?.error && typeof turn.error === "object"
            ? String(turn.error.message ?? "Codex turn failed")
            : undefined;
        if (status !== "completed" || errorMessage) {
          turnExitCode = 1;
          turnFailure =
            (errorMessage
              ? boundedCodexFailure(errorMessage)
              : `Codex turn ended with status '${boundedCodexCoordinate(
                  status,
                  "unknown",
                  48
                )}' and no recoverable output.`);
        }
        const turnBoundUsage =
          lastTurnUsage &&
          (!lastTurnUsage.turnId ||
            !turn?.id ||
            lastTurnUsage.turnId === turn.id)
            ? lastTurnUsage.usage
            : null;
        const rawUsage =
          extractCodexTokenUsage(message.params ?? {}) ?? turnBoundUsage;
        const durationMs =
          typeof turn?.durationMs === "number" &&
          Number.isFinite(turn.durationMs) &&
          turn.durationMs >= 0
            ? Math.trunc(turn.durationMs)
            : undefined;
        const usage = rawUsage
          ? {
              ...rawUsage,
              ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
            }
          : null;
        lastTurnUsage = undefined;
        handlers.onEvent(
          makeSessionEvent(
            this.laneKey,
            input.taskId,
            turnExitCode === 0 ? "task.completed" : "task.blocked",
            turnExitCode === 0
              ? "Codex turn completed"
              : turnFailure ?? "Codex turn failed",
            usage ? usageEventMetadata(this.laneKey, usage) : {}
          )
        );
        settleTurn();
      }
    });

    handlers.onEvent(
      makeSessionEvent(this.laneKey, input.taskId, "task.started", "Codex session started")
    );

    let threadId: string;
    try {
      const initialized = await call(CODEX_RPC.initialize, {
        clientInfo: { name: "muon", version: "0.1.0" },
        capabilities: null,
      });
      transport.send({ method: CODEX_RPC.initialized });
      // Both policy params are derived from the SAME composed argv the child
      // was spawned with, because the RPC param WINS over an argv `-c`
      // statement (measured, 0.145.0: a thread/start sandbox of `read-only`
      // defeated an argv `danger-full-access`). Deriving them from
      // `profile.permissionMode`/`profile.sandbox` alone had two failure
      // shapes: an operator's rawConfig/extraArgs tightening was silently
      // overridden, and the ADR-0023 nested-sandbox override was silently
      // REVERSED for any profile that stated `workspace-write` — the child
      // then could not run even `pwd` inside MUON's confined runner.
      //
      // The approval fallback is `untrusted`, DELIBERATELY: this transport
      // always carries MUON's approval bridge (`handlers.onApprovalRequest` is
      // mandatory), and codex's own default (`on-request`) is measured to mean
      // "the model decides" — zero requests across a whole write-authority
      // session. A profile that states no policy gets the must-ask default,
      // not the ungated one; `never` is reachable only through explicit
      // full-auto.
      // NOT `ephemeral`, deliberately — the thread must PERSIST. Measured
      // (0.145.0): `ephemeral: true` makes app-server answer `path: null` and
      // write NO rollout under `$CODEX_HOME/sessions/`, so the thread id MUON
      // stamped as the job's resume backlink named a session codex never
      // saved — the desktop's "open this job's real Codex session" button then
      // died with `codex resume`'s own "No saved session found with ID …".
      // Without the flag the same call answers with the rollout path, the
      // rollout lands under the isolated guard home named by the SAME uuid as
      // the thread id, and `codex resume <threadId>` (with CODEX_HOME at the
      // guard home, which is how the desktop spawns it) reopens the dispatched
      // transcript — verified live end-to-end. The rollout stays inside
      // MUON's guard home (0700, operator-owned), exactly where the exec
      // lane's rollouts already live.
      const thread = await call(CODEX_RPC.threadStart, {
        cwd: input.cwd,
        ...(input.profile?.model ? { model: input.profile.model } : {}),
        approvalPolicy:
          effectiveCodexApprovalPolicy(composedArgs) ?? "untrusted",
        ...(() => {
          const sandbox = effectiveCodexSandboxMode(composedArgs);
          return sandbox ? { sandbox } : {};
        })(),
      });
      threadId = extractThreadId(thread.result);
      // Announce the thread id at first knowledge so the resume handle is
      // persisted before the session ends (P0.1 Slice A). The id names a
      // PERSISTED rollout (see the thread/start note above), so the human's
      // own `codex resume <id>` can reopen it. `canResume` stays false for
      // the DRIVER: MUON re-entering a codex thread through `thread/resume`
      // remains an explicit non-goal — the backlink drives the operator's own
      // binary, never a MUON-held session.
      handlers.onVendorSessionId?.(threadId);
      // Codex loads the operator's ~/.codex MCP zoo in parallel. Inventory
      // taken before `muon` is ready used to page-truncate as
      // requiredMuon:"unknown" and proceed into empty turns. Wait first.
      if (expectsMuonMcp) {
        try {
          await Promise.race([
            muonReady,
            new Promise<void>((_, reject) => {
              const timer = setTimeout(() => {
                reject(
                  new Error(
                    `MUON MCP did not become ready within ${muonMcpReadyTimeoutMs}ms inside Codex app-server. Check MUON_JOB_ID / MUON_DELEGATION_TOKEN lineage env forwarding.`
                  )
                );
              }, muonMcpReadyTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } catch (error) {
          // Codex owns muon-mcp's stderr and never forwards it, so its report
          // ("connection closed: initialize response") names no cause. Ask the
          // server itself, then surface its own words through the SAME
          // diagnostic sink the runner already tails for stall evidence, and in
          // the message that becomes this job's terminal result.
          throw await this.explainMuonMcpFailure(
            error,
            input,
            childEnv,
            handlers
          );
        }
      } else if (!muonReadySettled) {
        resolveMuonReady();
      }
      const capabilityPreflight = await runCodexCapabilityPreflight({
        call: async (method: CodexCapabilityMethod, params) =>
          (await call(method, params)).result,
        threadId,
        cwd: input.cwd,
        childEnv,
        signal: input.signal,
        initializeResult: initialized.result,
        threadStartResult: thread.result,
        // ASSERT THE NEGATIVE. The gate below proves MUON's tools are PRESENT;
        // this is what lets it also prove nothing ELSE is. MUON now supplies
        // the child's entire server set (isolated CODEX_HOME + suppressed
        // ambient features), so the grant is knowable and an inventory that
        // exceeds it is a governance failure rather than background noise.
        grantedMcpServers: grantedMcpServerNames,
        // `muon` reporting `ready` above says its MCP client handshake finished
        // — NOT that the model can see its tools. Assert the toolset itself
        // before the brief is released, exactly as the Claude driver does with
        // `Query.mcpServerStatus()`. Installed ONLY for a lane that was given
        // the governed server; every other lane keeps its previous behavior.
        ...(expectsMuonMcp
          ? {
              muonToolGate: {
                requiredTools: bareMuonToolNames(
                  grantedMuonToolNames(input.profile?.allowedTools)
                ),
                timeoutMs: muonMcpReadyTimeoutMs,
                pollIntervalMs:
                  this.options.muonMcpPollIntervalMs ?? MUON_MCP_POLL_MS,
              },
            }
          : {}),
      });
      // The child answered an inventory request, so it is past MCP startup —
      // a later death is no longer attributable to a server that never came up.
      startupPhase = "ready";
      const preflightMessage =
        capabilityPreflight.decision === "block"
          ? codexPreflightBlockMessage(
              capabilityPreflight,
              muonMcpReadyTimeoutMs,
              grantedMcpServerNames
            )
          : "Codex capability preflight completed";
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          capabilityPreflight.decision === "block"
            ? "task.blocked"
            : "task.progress",
          preflightMessage,
          { capabilityPreflight, controlPlane: true }
        )
      );
      if (capabilityPreflight.decision === "block") {
        throw new Error(preflightMessage);
      }
      await call(CODEX_RPC.turnStart, {
        threadId,
        input: [{ type: "text", text: input.brief }],
      });
      if (transportExitCode !== undefined) {
        throw transportExitError(transportExitCode);
      }
      turnStarted = true;
      armTurnIdleTimer();
      input.signal?.throwIfAborted();
    } catch (error) {
      input.signal?.removeEventListener("abort", onAbort);
      await closeTransport().catch(() => undefined);
      throw error;
    }

    return {
      vendorSessionId: threadId,
      send: async (message: string) => {
        await call(CODEX_RPC.turnStart, {
          threadId,
          input: [{ type: "text", text: message }],
        });
      },
      interrupt: async () => {
        const alreadyAborted = leaseAborted;
        leaseAborted = true;
        if (!alreadyAborted && !turnSettled) {
          const interruptAttempt = call(CODEX_RPC.turnInterrupt, { threadId });
          await settlesWithin(
            interruptAttempt,
            this.options.interruptRpcTimeoutMs ?? CODEX_INTERRUPT_RPC_MS
          );
        }
        rejectPending(new Error("Codex turn interrupted."));
        settleTurn();
        await closeTransport();
      },
      wait: async () => {
        try {
          await turnCompleted;
          const exitSettled = settlesWithin(
            transportExitPromise,
            this.options.transportExitTimeoutMs ?? CODEX_TRANSPORT_EXIT_MS
          );
          const [, didExit] = await Promise.all([
            closeTransport(),
            exitSettled,
          ]);
          if (
            !didExit &&
            !leaseAborted &&
            turnExitCode === 0
          ) {
            turnExitCode = 1;
            turnFailure =
              "Codex app-server did not exit after bounded shutdown; MUON released the turn instead of waiting indefinitely.";
          }
          if (leaseAborted) {
            return { exitCode: 130, output };
          }
          if (turnExitCode !== 0) {
            return {
              exitCode: turnExitCode,
              output: output.trim()
                ? `${output}\n\n${turnFailure ?? "Codex turn failed."}`
                : turnFailure ?? "Codex turn failed.",
            };
          }
          if (!output.trim()) {
            // Empty "success" is what the Mission chat was showing: activity
            // milestones with no assistant text, then auto-continue nudges.
            return {
              exitCode: 1,
              output:
                "Codex finished with no assistant output. Usually the MUON MCP server failed to start, an approval reply used the wrong vocabulary, or the model aborted without a reply.",
            };
          }
          return { exitCode: 0, output };
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
        }
      },
    };
  }
}
