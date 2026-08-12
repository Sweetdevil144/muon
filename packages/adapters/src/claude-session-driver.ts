import {
  boundToolActivityPaths,
  boundToolActivityText,
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
  type ToolActivityDetail,
} from "@muon/protocol";
import {
  makeSessionEvent,
  type LaneSessionDriver,
  type SessionHandle,
  type SessionHandlers,
  type SessionStartInput,
} from "./session-driver.js";
import { buildLaneEnvironment } from "./lane-runner.js";
import { assertMuonMcpEnvContract } from "./mcp-env-contract.js";
import { assertUniqueMcpServerNames } from "./mcp-server-validation.js";
import { CLAUDE_NATIVE_FAN_OUT_TOOLS } from "./profile-compiler.js";
import {
  grantedMuonToolNames,
  missingMuonToolsDetail,
  muonHandshakeFailure,
  MUON_MCP_POLL_MS,
  MUON_MCP_SERVER_NAME,
  MUON_MCP_TOOL_PREFIX,
} from "./muon-mcp-readiness.js";
import { boundedProviderFailure } from "./provider-failure.js";
import {
  extractClaudeTokenUsage,
  usageEventMetadata,
  type VendorTokenUsage,
} from "./token-usage.js";

type SdkMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  usage?: unknown;
  modelUsage?: unknown;
  tool_use_id?: string;
  tool_name?: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      is_error?: boolean;
      /** tool_use: the arguments the model called the tool with. UNTRUSTED. */
      input?: unknown;
      /** tool_result: what the tool returned. UNTRUSTED, and unbounded. */
      content?: unknown;
    }[];
  };
};

/** One `mcp_status` control-request row (SDK `McpServerStatus`). */
type SdkMcpServerStatus = {
  name?: string;
  status?: string;
  error?: string;
  tools?: { name?: string }[];
};

/** The SDK's streaming-input message shape (`SDKUserMessage`). */
type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

type SdkQuery = AsyncIterable<SdkMessage> & {
  interrupt?: () => Promise<void>;
  /**
   * `mcp_status` control request. Answered by the vendor process over the
   * control channel WITHOUT a turn, which is the only way to observe the MCP
   * handshake before the first user message exists (the `system`/`init` message
   * is emitted only once a turn starts, so it is far too late to gate on).
   */
  mcpServerStatus?: () => Promise<SdkMcpServerStatus[]>;
};

type SdkModule = {
  query: (options: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options: Record<string, unknown>;
  }) => SdkQuery;
};

/**
 * The EXACT vendor options a compiled Claude lane profile can express, and
 * nothing else. This is the one-shot path's authority surface, so it is a
 * whitelist by construction: a field the profile compiler cannot emit is not
 * representable here, and the interactive session's own options (notably
 * `canUseTool`) can never be reached through it.
 *
 * Every value is derived from `compileClaudeProfile`'s argv — the same bytes
 * the spawn path would have handed `claude -p` — so the two channels grant
 * identically. See `claudeVendorOptionsFromCompiledArgs` (claude-adapter.ts).
 */
export type ClaudeOneShotVendorOptions = {
  model?: string;
  permissionMode?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  additionalDirectories?: readonly string[];
  /** `{mcpServers}` from the compiled `--mcp-config`: env by NAME only (S2). */
  mcpServers?: Record<string, unknown>;
  /** The profile's own passthrough flags, already guard-sanitized. */
  extraArgs?: Record<string, string | null>;
};

/**
 * Configures this driver for MUON's ONE-SHOT contract (`muon run` /
 * `runLaneTask`) instead of an interactive managed session.
 *
 * Why the one-shot path runs here at all: the brief used to travel on argv
 * (`claude -p "<brief>"`), so the turn began at process launch and the MUON MCP
 * handshake could not be waited on — a run that needed `memory_add` or
 * `preflight_edit` was a coin flip. Streaming input makes the brief ours to
 * withhold, so the same readiness gate the session path uses applies here too.
 *
 * What it does NOT change: governance. A one-shot run has no operator watching
 * an approvals inbox, so it is governed exactly as `claude -p` is — by the
 * compiled permission mode and tool rules — and `canUseTool` is not installed.
 */
export type ClaudeOneShotSession = {
  vendorOptions: ClaudeOneShotVendorOptions;
  /**
   * The deny-first lane environment the vendor child must run with
   * (`buildProviderAwareLaneEnvironment`), carrying the MCP env VALUES the
   * vendor config references by name. Supplied by the caller so this path
   * builds the identical environment `runLaneCommand` would have spawned with.
   */
  env: NodeJS.ProcessEnv;
};

export type ClaudeSessionDriverOptions = {
  interruptSettleTimeoutMs?: number;
  muonMcpReadyTimeoutMs?: number;
  muonMcpPollIntervalMs?: number;
  /**
   * Present ⇒ this driver instance executes MUON's one-shot contract. Reachable
   * only by whoever CONSTRUCTS the driver, so `startManagedSession` (which
   * constructs it with no options) cannot reach it even by accident.
   */
  oneShot?: ClaudeOneShotSession;
};

/** Thrown when the Agent SDK itself could not be loaded. */
export class ClaudeSdkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSdkUnavailableError";
  }
}

/** The compiled profile projected onto the SDK's option names. */
function oneShotVendorSdkOptions(
  vendorOptions: ClaudeOneShotVendorOptions
): Record<string, unknown> {
  return {
    ...(vendorOptions.model ? { model: vendorOptions.model } : {}),
    // `bypassPermissions` is passed through verbatim WITHOUT the SDK's
    // `allowDangerouslySkipPermissions`, so the argv the CLI receives stays
    // byte-identical to today's `--permission-mode bypassPermissions`. A
    // one-shot run must not gain authority by changing channel.
    ...(vendorOptions.permissionMode
      ? { permissionMode: vendorOptions.permissionMode }
      : {}),
    ...(vendorOptions.allowedTools?.length
      ? { allowedTools: [...vendorOptions.allowedTools] }
      : {}),
    ...(vendorOptions.disallowedTools?.length
      ? { disallowedTools: [...vendorOptions.disallowedTools] }
      : {}),
    ...(vendorOptions.additionalDirectories?.length
      ? { additionalDirectories: [...vendorOptions.additionalDirectories] }
      : {}),
    ...(vendorOptions.extraArgs &&
    Object.keys(vendorOptions.extraArgs).length > 0
      ? { extraArgs: { ...vendorOptions.extraArgs } }
      : {}),
  };
}

const CLAUDE_INTERRUPT_SETTLE_MS = 3_000;

/**
 * How long the brief is withheld while the MUON MCP server completes its
 * handshake inside the Agent SDK. Matches the Codex driver's
 * `MUON_MCP_READY_MS` budget, plus headroom for the SDK's extra process hop
 * (the SDK spawns `claude`, which then spawns the MCP server).
 */
const MUON_MCP_READY_MS = 25_000;

/** MCP statuses from which the handshake can never recover. */
const TERMINAL_MCP_STATUSES = new Set(["failed", "needs-auth", "disabled"]);

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

function boundedClaudeCoordinate(
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

function boundedClaudeFailure(value: unknown, maxLength = 500): string {
  return boundedProviderFailure(value, maxLength);
}

/**
 * BOUNDED, still-untrusted detail for one tool call. MUON used to carry only
 * coordinates here; the desktop's tool cards need to show WHAT ran and WHAT it
 * returned (Cursor parity), so the payload is admitted deliberately — bounded
 * at this emission site so nothing bigger is ever retained on an event, and
 * redacted by @muon/core's `redactedTail` on the way into the ledger.
 *
 * Returns undefined when there is nothing to say, so the metadata shape is
 * byte-identical to today's for a tool call with no args and no output.
 */
function claudeToolDetail(input: {
  args?: unknown;
  result?: unknown;
}): ToolActivityDetail | undefined {
  const args =
    input.args === undefined
      ? undefined
      : boundToolActivityText(input.args, TOOL_ACTIVITY_ARGS_CHARS, "head");
  const result =
    input.result === undefined
      ? undefined
      : boundToolActivityText(input.result, TOOL_ACTIVITY_RESULT_CHARS, "tail");
  if (!args && !result) return undefined;
  return {
    ...(args ? { args: args.text, argsTruncated: args.truncated } : {}),
    ...(result
      ? { result: result.text, resultTruncated: result.truncated }
      : {}),
  };
}

/**
 * File coordinates from Claude's structured Edit/Write-family input.
 * The coordinate is not trusted here; the runner later resolves it inside the
 * governed worktree and requires an exact git-changed-file match.
 */
function claudeFileMutationPaths(toolName: string, input: unknown): string[] {
  if (
    !["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"].includes(
      toolName
    )
  ) {
    return [];
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return boundToolActivityPaths(
    record.file_path ?? record.path ?? record.notebook_path ?? record.paths
  );
}

/** Spread helper: emits nothing at all when there is no detail to carry. */
function withToolDetail(
  detail: ToolActivityDetail | undefined
): { detail: ToolActivityDetail } | Record<string, never> {
  return detail ? { detail } : {};
}

/**
 * The SDK's `allowedTools` option shadows `canUseTool`, so MUON evaluates only
 * safe name-level preauthorizations inside the callback. Scoped command rules
 * such as `Bash(npm test:*)` need input-aware parsing and therefore remain
 * human-gated rather than being broadened to every Bash call.
 */
function matchesPreauthorizedTool(rule: string, toolName: string): boolean {
  const normalized = rule.trim();
  if (!normalized || normalized.includes("(")) return false;
  if (normalized === toolName) return true;
  if (normalized.startsWith("mcp__") || toolName.startsWith("mcp__")) {
    return false;
  }
  return normalized.endsWith("*") &&
    toolName.startsWith(normalized.slice(0, -1));
}

function matchesDeniedTool(rule: string, toolName: string): boolean {
  const normalized = rule.trim();
  if (!normalized || normalized.includes("(")) return false;
  if (normalized === toolName) return true;
  return normalized.endsWith("*") &&
    toolName.startsWith(normalized.slice(0, -1));
}

/**
 * The lane profile's tool rules, snapshotted ONCE before the vendor session
 * exists. `canUseTool` reads only this, never the caller's live profile object,
 * so the same tool name cannot be allowed on one call and denied on the next
 * because something upstream re-shaped the profile mid-session. Narrowing a
 * running session is `interrupt()`, not array mutation.
 */
export type SessionToolRules = {
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
};

export function snapshotSessionToolRules(profile?: {
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
}): SessionToolRules {
  return Object.freeze({
    allowedTools: Object.freeze([...(profile?.allowedTools ?? [])]),
    // TODO 1.16: the native spawner is denied HERE, not only in the compiler.
    //
    // The interactive channel does not go through `compileRunProfile` at all —
    // `startManagedSession` hands the dispatch profile straight to the driver — so
    // the compiler's categorical `--disallowedTools Task` never reached claude's
    // DEFAULT transport. `Task` then arrived at `canUseTool`, where
    // `classifyToolAction` returns `null`, making it an ordinary approval: fast-
    // denied for a coordinator with no standing approver, but a human-approvable
    // gate for a worker. A gate is not a suppression, and the registry claimed one.
    //
    // Unioned into the SNAPSHOT rather than beside the SDK option so both readers
    // get it at once: the `disallowedTools` the SDK is given, and
    // `decideSessionToolPermission`, which now returns a local `deny` instead of
    // routing the call to an inbox.
    deniedTools: Object.freeze([
      ...new Set([
        ...(profile?.deniedTools ?? []),
        ...CLAUDE_NATIVE_FAN_OUT_TOOLS,
      ]),
    ]),
  });
}

/**
 * The session's own verdict on one tool call: a PURE function of the rules
 * snapshot, the lease state, and the tool name. `null` means "this session has
 * no local verdict" — the call must go to the operator's approvals inbox.
 *
 * Determinism is the point: identical calls must decide identically for the
 * whole session, so `allow` can never be a coin flip and a `deny` that is
 * correct on the second call was already correct on the first.
 */
export function decideSessionToolPermission(
  rules: SessionToolRules,
  toolName: string,
  leaseAborted: boolean
): { behavior: "allow" | "deny"; message?: string } | null {
  if (leaseAborted) {
    return {
      behavior: "deny",
      message: "MUON denied: the provider session is interrupted.",
    };
  }
  if (rules.deniedTools.some((rule) => matchesDeniedTool(rule, toolName))) {
    return {
      behavior: "deny",
      message: `MUON denied '${boundedClaudeCoordinate(
        toolName,
        "unknown"
      )}' by the governed lane profile.`,
    };
  }
  if (
    rules.allowedTools.some((rule) => matchesPreauthorizedTool(rule, toolName))
  ) {
    return { behavior: "allow" };
  }
  return null;
}

/**
 * Re-exported so this driver's public surface is unchanged; the definition now
 * lives beside the Codex binding of the same gate (./muon-mcp-readiness.ts).
 */
export { grantedMuonToolNames };

export type MuonMcpReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/**
 * Hold the first user message until the MUON MCP server has actually handed the
 * session its tools.
 *
 * The Agent SDK connects `mcpServers` ASYNCHRONOUSLY while the turn it was
 * asked for is already running, so a brief sent at `query()` time reaches a
 * model whose `muon` server is still `pending` and whose MUON tools therefore
 * do not exist. Gating on the `system`/`init` message is not an option — the
 * vendor emits it only once a turn has begun, i.e. strictly after the brief.
 * The `mcp_status` control request answers before any turn exists, which is why
 * readiness is polled over the control channel instead.
 *
 * Fails closed: an unverifiable handshake ends the run rather than starting an
 * ungoverned turn.
 */
export async function awaitMuonMcpReadiness(options: {
  probe: (() => Promise<SdkMcpServerStatus[]>) | undefined;
  requiredTools: readonly string[];
  timeoutMs: number;
  pollIntervalMs: number;
  isAborted: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<MuonMcpReadiness> {
  const {
    probe,
    requiredTools,
    timeoutMs,
    pollIntervalMs,
    isAborted,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    now = () => Date.now(),
  } = options;

  if (!probe) {
    return {
      ready: false,
      reason: muonHandshakeFailure(
        `MUON cannot verify the '${MUON_MCP_SERVER_NAME}' MCP handshake: this '@anthropic-ai/claude-agent-sdk' build exposes no mcpServerStatus() control request.`
      ),
    };
  }

  const deadline = now() + timeoutMs;
  let lastStatus = "not-reported";
  while (!isAborted()) {
    let statuses: SdkMcpServerStatus[];
    try {
      statuses = await probe();
    } catch (error) {
      return {
        ready: false,
        reason: muonHandshakeFailure(
          `MUON could not read the '${MUON_MCP_SERVER_NAME}' MCP server status from the Claude Agent SDK (last status '${lastStatus}'): ${boundedClaudeFailure(
            error,
            200
          )}.`
        ),
      };
    }
    const server = statuses.find(
      (entry) => entry.name === MUON_MCP_SERVER_NAME
    );
    lastStatus = boundedClaudeCoordinate(server?.status, "not-reported", 32);
    if (lastStatus === "connected") {
      const exposed = new Set(
        (server?.tools ?? [])
          .map((tool) => tool.name)
          .filter((name): name is string => typeof name === "string")
          .map((name) => `${MUON_MCP_TOOL_PREFIX}${name}`)
      );
      const missing = requiredTools.filter((tool) => !exposed.has(tool));
      if (missing.length === 0) return { ready: true };
      return {
        ready: false,
        reason: muonHandshakeFailure(missingMuonToolsDetail(missing)),
      };
    }
    if (TERMINAL_MCP_STATUSES.has(lastStatus)) {
      const detail = server?.error
        ? ` (${boundedClaudeFailure(server.error, 200)})`
        : "";
      return {
        ready: false,
        reason: muonHandshakeFailure(
          `MUON MCP server '${MUON_MCP_SERVER_NAME}' reported status '${lastStatus}'${detail}.`
        ),
      };
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  }
  if (isAborted()) {
    return {
      ready: false,
      reason: muonHandshakeFailure(
        `MUON lost authority over the session while the '${MUON_MCP_SERVER_NAME}' MCP server was '${lastStatus}'.`
      ),
    };
  }
  return {
    ready: false,
    reason: muonHandshakeFailure(
      `MUON MCP server '${MUON_MCP_SERVER_NAME}' did not reach 'connected' within ${timeoutMs}ms (last status '${lastStatus}').`
    ),
  };
}

/**
 * Interactive Claude Code sessions on the official Agent SDK (headless).
 * The `canUseTool` callback is the load-bearing piece: every un-preapproved
 * tool call pauses the agent and routes through MUON's approvals inbox,
 * fail closed. See docs/research/orchestrator-landscape-2026.md.
 *
 * The SDK is loaded dynamically so MUON installs (and CI) without it keep
 * working; starting a session without the SDK fails with an actionable error.
 */
export class ClaudeSessionDriver implements LaneSessionDriver {
  readonly laneKey = "claude-code";
  readonly capabilities = { canSend: false, canInterrupt: true, canResume: true };
  /**
   * The SDK owns the `claude` process but exposes its stderr through the
   * `stderr` option below, so MUON does observe it. Declared true ONLY because
   * that option is wired; it is what licenses a stall report to say the vendor
   * was silent on both streams.
   */
  readonly forwardsVendorStderr = true;

  constructor(
    private readonly loadSdk: () => Promise<SdkModule> = async () =>
      (await import(
        /* @vite-ignore */ "@anthropic-ai/claude-agent-sdk" as string
      )) as unknown as SdkModule,
    private readonly driverOptions: ClaudeSessionDriverOptions = {}
  ) {}

  async start(
    input: SessionStartInput,
    handlers: SessionHandlers
  ): Promise<SessionHandle> {
    input.signal?.throwIfAborted();
    let sdk: SdkModule;
    try {
      sdk = await this.loadSdk();
    } catch {
      input.signal?.throwIfAborted();
      // Typed so a caller can tell "the SDK is not installed" apart from every
      // other launch failure; the message is unchanged.
      throw new ClaudeSdkUnavailableError(
        "Claude interactive sessions need '@anthropic-ai/claude-agent-sdk'. Install it (npm i @anthropic-ai/claude-agent-sdk) or use `muon run` for one-shot execution."
      );
    }
    // SDK loading is asynchronous. Re-fence immediately before query() can
    // create the vendor session.
    input.signal?.throwIfAborted();
    let leaseAborted = input.signal?.aborted ?? false;
    let output = "";
    let approvalSequence = 0;
    const pendingApprovalIds = new Set<number>();

    // Profile → SDK options: MCP servers (incl. the injected MUON server)
    // and tool rules must reach the session, not just one-shot CLI flags.
    // MCP env (incl. MUON_API_TOKEN) reaches the in-process MUON MCP server via
    // `mcpServers[].env` below, in-memory, never on argv or in the workspace
    // (S2). We deliberately keep it out of the SDK's global `env` so the token
    // isn't broadcast to the agent's own tool subprocesses.
    const oneShot = this.driverOptions.oneShot;
    const profileMcpServers = input.profile?.mcpServers ?? [];
    assertUniqueMcpServerNames(profileMcpServers);
    // Interactive delivers VALUES directly (in-process, never by name), so the
    // delivery half of the contract is satisfied by construction — but the
    // lineage half is not: an orchestrator/delegate profile assembled without
    // MUON_JOB_ID / MUON_DELEGATION_TOKEN still makes muon-mcp fail closed
    // during initialize. Judge every surface by the same rule. One-shot keeps
    // the SPAWN path's delivery (name in the vendor config, value in the child
    // env), so it is judged against that env — exactly as `runLaneCommand` does.
    assertMuonMcpEnvContract(
      profileMcpServers,
      oneShot
        ? oneShot.env
        : (profileMcpServers.find((server) => server.name === "muon")?.env ?? {})
    );
    // Snapshotted before the vendor session exists so every `canUseTool` call
    // in this session decides against the SAME rules (see
    // `decideSessionToolPermission`). One-shot installs no `canUseTool`, but
    // the rules still name the MUON tools the readiness gate must see exposed.
    const toolRules = snapshotSessionToolRules(input.profile);
    const mcpServers = oneShot
      ? (oneShot.vendorOptions.mcpServers ?? {})
      : Object.fromEntries(
          profileMcpServers.map((server) => [
            server.name,
            server.url
              ? { type: "http", url: server.url }
              : {
                  command: server.command as string,
                  args: server.args ?? [],
                  env: server.env ?? {},
                },
          ])
        );

    const sdkAbortController = new AbortController();
    /**
     * The interactive session's gate. Hoisted out of the options literal so the
     * two channels' authority can be expressed as DISJOINT whitelists below: a
     * one-shot run must never reach an approvals inbox nobody watches, and the
     * interactive gate must never be lost by a channel that forgot to set it.
     */
    const canUseTool = async (toolName: string, toolInput: unknown) => {
      const safeToolName = boundedClaudeCoordinate(toolName, "unknown");
      const local = decideSessionToolPermission(
        toolRules,
        toolName,
        leaseAborted
      );
      if (local?.behavior === "deny") {
        return { behavior: "deny", message: local.message };
      }
      if (local?.behavior === "allow") {
        return { behavior: "allow", updatedInput: toolInput };
      }
      approvalSequence += 1;
      const approvalId = approvalSequence;
      pendingApprovalIds.add(approvalId);
      handlers.onEvent(
        makeSessionEvent(
          this.laneKey,
          input.taskId,
          "approval.requested",
          `session tool request: ${safeToolName}`,
          { toolName: safeToolName, controlPlane: true }
        )
      );
      let decision: { behavior: "allow" | "deny"; message?: string };
      try {
        decision = await handlers.onApprovalRequest({
          toolName,
          input: toolInput,
          taskId: input.taskId,
          laneKey: this.laneKey,
        });
      } catch {
        decision = {
          behavior: "deny",
          message: "MUON approval bridge failed closed.",
        };
      } finally {
        pendingApprovalIds.delete(approvalId);
      }
      if (leaseAborted) {
        return {
          behavior: "deny",
          message: "MUON denied: the provider session is interrupted.",
        };
      }
      const allApprovalsResolved = pendingApprovalIds.size === 0;
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
              : { approvalPendingCount: pendingApprovalIds.size }),
            toolActivity: {
              provider: "claude-code",
              phase:
                decision.behavior === "allow" ? "approved" : "denied",
              tool: safeToolName,
              // What the human actually just allowed or refused. A governance
              // decision whose subject the operator cannot read is not a
              // reviewable decision.
              ...withToolDetail(claudeToolDetail({ args: toolInput })),
            },
          }
        )
      );
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: toolInput }
        : {
            behavior: "deny",
            message: boundedClaudeFailure(
              decision.message ?? "MUON denied the tool request."
            ),
          };
    };

    const options: Record<string, unknown> = {
      cwd: input.cwd,
      abortController: sdkAbortController,
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      ...(input.resumeVendorSessionId
        ? { resume: input.resumeVendorSessionId }
        : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      // The SDK's own stderr callback for the `claude` process it spawns. This
      // is the ONLY vendor-side evidence available while a launch is still
      // hanging (a provider quota/billing rejection can take minutes to reach
      // the message stream). Added only when a sink was supplied, so a run
      // without one stays byte-identical.
      ...(handlers.onDiagnostic ? { stderr: handlers.onDiagnostic } : {}),
      // ── The channel's OWN authority, as two disjoint whitelists ────────────
      // Neither branch is "the other one minus a few keys": a key added to one
      // is inert in the other by construction, which is the only shape that
      // survives a future edit (a bounded surface defeated by a `{...spread}`
      // of a broader source is MUON's most repeated defect).
      ...(oneShot
        ? {
            // One-shot is governed exactly as `claude -p` is: by the COMPILED
            // permission mode and tool rules, with no `canUseTool` interpose
            // (there is no operator watching an inbox on this path) and no
            // `settingSources`/`skills` override, so the CLI's own settings
            // layers — including the run-scoped `.claude/settings.local.json`
            // the profile compiler just wrote — load exactly as they do today.
            ...oneShotVendorSdkOptions(oneShot.vendorOptions),
            env: oneShot.env,
          }
        : {
            settingSources: [],
            skills: [],
            ...(input.profile?.model ? { model: input.profile.model } : {}),
            ...(toolRules.deniedTools.length
              ? { disallowedTools: [...toolRules.deniedTools] }
              : {}),
            permissionMode: "default",
            canUseTool,
            env: buildLaneEnvironment(
              this.laneKey,
              process.env,
              input.profile?.env
            ),
          }),
    };

    // Streaming input, so the brief is OURS to withhold. `query()` used to take
    // the brief directly, which handed it to the model before the SDK had
    // finished connecting `mcpServers` — the turn then began with no MUON tools
    // at all. The generator blocks on `briefGate` until the handshake below is
    // verified, and yields nothing at all if it is not.
    let releaseBrief: (send: boolean) => void = () => undefined;
    const briefGate = new Promise<boolean>((resolve) => {
      releaseBrief = resolve;
    });
    async function* gatedPrompt(): AsyncGenerator<SdkUserMessage> {
      if (!(await briefGate)) return;
      yield {
        type: "user",
        message: { role: "user", content: input.brief },
        parent_tool_use_id: null,
      };
    }

    const stream = sdk.query({ prompt: gatedPrompt(), options });
    let interruptPromise: Promise<void> | undefined;
    const interruptStream = (): Promise<void> => {
      interruptPromise ??= Promise.resolve()
        .then(() => stream.interrupt?.())
        .then(() => undefined);
      return interruptPromise;
    };
    let doneSettled = false;
    let interruptionRequested = false;
    let resolveInterrupted: (result: {
      exitCode: number;
      output: string;
    }) => void = () => undefined;
    const interrupted = new Promise<{ exitCode: number; output: string }>(
      (resolve) => {
        resolveInterrupted = resolve;
      }
    );
    const requestInterrupt = (): boolean => {
      if (doneSettled) return false;
      if (interruptionRequested) return true;
      interruptionRequested = true;
      leaseAborted = true;
      // Release the input generator too: an abort while the brief is still
      // gated must not leave the SDK's input pump waiting on a promise that
      // nothing will ever resolve.
      releaseBrief(false);
      sdkAbortController.abort(input.signal?.reason);
      resolveInterrupted({ exitCode: 130, output });
      void interruptStream().catch(() => undefined);
      return true;
    };
    const onAbort = requestInterrupt;
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
    }

    // The final `result` message repeats the last assistant text; only
    // surface it when no assistant text streamed (tool-only/terse runs).
    let sawAssistantText = false;
    // Announce the vendor session id exactly once, at first knowledge, so the
    // resume handle can be persisted before the session ends (P0.1 Slice A).
    let sessionIdAnnounced = false;
    let lastUsage: VendorTokenUsage | null = null;
    const activeTools = new Map<string, string>();

    const interruptSettleTimeoutMs =
      this.driverOptions.interruptSettleTimeoutMs ??
      CLAUDE_INTERRUPT_SETTLE_MS;
    async function waitForInterruptedTeardown(): Promise<{
      exitCode: number;
      output: string;
    }> {
      const result = await interrupted;
      await settlesWithin(done, interruptSettleTimeoutMs);
      return result;
    }
    const handle: SessionHandle = {
      vendorSessionId: undefined,
      send: async () => {
        // The input stream carries exactly the gated brief and then closes, so
        // this driver stays `canSend: false`; resume with a new brief instead.
        throw new Error(
          "Send-into-running-session is not supported on this driver; resume the session with a new brief instead."
        );
      },
      interrupt: async () => {
        input.signal?.removeEventListener("abort", onAbort);
        if (!requestInterrupt()) return;
        await waitForInterruptedTeardown();
      },
      wait: async () => ({ exitCode: 1, output: "" }),
    };

    const done = (async () => {
      if (!leaseAborted) {
        handlers.onEvent(
          makeSessionEvent(
            this.laneKey,
            input.taskId,
            "task.started",
            "Claude session started"
          )
        );
      }
      let exitCode = 0;
      try {
        for await (const message of stream) {
          if (leaseAborted) break;
          if (message.type === "system" && message.session_id) {
            handle.vendorSessionId = message.session_id;
            if (!sessionIdAnnounced) {
              sessionIdAnnounced = true;
              // Announced UNVALIDATED on purpose: this callback has two
              // consumers with different contracts. Chat continuity persists
              // whatever handle the vendor gave (P0.1 Slice A) and must not
              // lose an id merely because it is not uuid-shaped; the BACKLINK
              // stamp is the one with a shape constraint, so it validates at
              // its own report site rather than starving this one.
              handlers.onVendorSessionId?.(message.session_id);
            }
          }
          if (message.type === "assistant") {
            const blocks = message.message?.content ?? [];
            const text = blocks
              .filter((block) => block.type === "text" && block.text)
              .map((block) => block.text)
              .join("\n");
            if (text) {
              sawAssistantText = true;
              output += `${text}\n`;
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
            for (const block of blocks) {
              if (block.type !== "tool_use") continue;
              const itemId = boundedClaudeCoordinate(block.id, "unknown", 128);
              const tool = boundedClaudeCoordinate(block.name, "unknown");
              if (activeTools.size >= 256) {
                activeTools.delete(activeTools.keys().next().value ?? "");
              }
              activeTools.set(itemId, tool);
              const mutationPaths = claudeFileMutationPaths(tool, block.input);
              handlers.onEvent(
                makeSessionEvent(
                  this.laneKey,
                  input.taskId,
                  "task.progress",
                  `${tool} started`,
                  {
                    controlPlane: true,
                    toolActivity: {
                      provider: "claude-code",
                      phase: "started",
                      itemId,
                      tool,
                      ...(mutationPaths.length > 0
                        ? { fileMutation: true, paths: mutationPaths }
                        : {}),
                      ...withToolDetail(
                        claudeToolDetail({ args: block.input })
                      ),
                    },
                  }
                )
              );
            }
          }
          if (message.type === "tool_progress") {
            const itemId = boundedClaudeCoordinate(
              message.tool_use_id,
              "unknown",
              128
            );
            const tool = boundedClaudeCoordinate(
              message.tool_name ?? activeTools.get(itemId),
              "unknown"
            );
            handlers.onEvent(
              makeSessionEvent(
                this.laneKey,
                input.taskId,
                "task.progress",
                `${tool} is still working`,
                {
                  controlPlane: true,
                  toolActivity: {
                    provider: "claude-code",
                    phase: "progress",
                    itemId,
                    tool,
                  },
                }
              )
            );
          }
          if (message.type === "user") {
            for (const block of message.message?.content ?? []) {
              if (block.type !== "tool_result") continue;
              const itemId = boundedClaudeCoordinate(
                block.tool_use_id,
                "unknown",
                128
              );
              const tool = activeTools.get(itemId) ?? "Claude tool";
              activeTools.delete(itemId);
              handlers.onEvent(
                makeSessionEvent(
                  this.laneKey,
                  input.taskId,
                  block.is_error ? "task.blocked" : "task.progress",
                  `${tool} ${block.is_error ? "failed" : "completed"}`,
                  {
                    controlPlane: true,
                    toolActivity: {
                      provider: "claude-code",
                      phase: block.is_error ? "failed" : "completed",
                      itemId,
                      tool,
                      ...withToolDetail(
                        claudeToolDetail({ result: block.content })
                      ),
                    },
                  }
                )
              );
            }
          }
          if (message.type === "result") {
            if (message.subtype && message.subtype !== "success") {
              exitCode = 1;
            }
            if (message.result && !sawAssistantText) {
              output += message.result;
            }
            const usage = extractClaudeTokenUsage(
              message as unknown as Record<string, unknown>
            );
            if (usage) lastUsage = usage;
          }
        }
        if (leaseAborted) {
          exitCode = 130;
        }
        if (!leaseAborted) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              exitCode === 0 ? "task.completed" : "task.blocked",
              exitCode === 0
                ? "Claude session completed"
                : "Claude session failed",
              lastUsage
                ? usageEventMetadata(this.laneKey, lastUsage)
                : {}
            )
          );
        }
      } catch (error) {
        exitCode = leaseAborted ? 130 : 1;
        if (!leaseAborted) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.blocked",
              `Claude session error: ${boundedClaudeFailure(error)}`
            )
          );
        }
      } finally {
        doneSettled = true;
        input.signal?.removeEventListener("abort", onAbort);
      }
      return { exitCode, output };
    })();

    handle.wait = () => Promise.race([done, waitForInterruptedTeardown()]);

    // Only sessions that were actually given the MUON server are gated; a lane
    // that never asked for it has nothing to wait on. `done` is already
    // consuming the stream, so the control channel is live while we poll.
    const expectsMuonMcp = profileMcpServers.some(
      (server) => server.name === MUON_MCP_SERVER_NAME
    );
    if (expectsMuonMcp) {
      const readiness = await awaitMuonMcpReadiness({
        probe: stream.mcpServerStatus
          ? () => stream.mcpServerStatus!()
          : undefined,
        requiredTools: grantedMuonToolNames(toolRules.allowedTools),
        timeoutMs:
          this.driverOptions.muonMcpReadyTimeoutMs ?? MUON_MCP_READY_MS,
        pollIntervalMs:
          this.driverOptions.muonMcpPollIntervalMs ?? MUON_MCP_POLL_MS,
        isAborted: () => leaseAborted,
      });
      if (!readiness.ready) {
        if (!leaseAborted) {
          handlers.onEvent(
            makeSessionEvent(
              this.laneKey,
              input.taskId,
              "task.blocked",
              readiness.reason,
              { controlPlane: true, reason: "muon-mcp-handshake-failed" }
            )
          );
        }
        // Withhold the brief, then tear the vendor session down through the
        // ordinary interrupt path so nothing is left running un-briefed.
        releaseBrief(false);
        requestInterrupt();
        input.signal?.removeEventListener("abort", onAbort);
        throw new Error(readiness.reason);
      }
    }
    releaseBrief(true);

    return handle;
  }
}
