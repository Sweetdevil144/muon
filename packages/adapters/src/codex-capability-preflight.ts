import {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
} from "@muon/protocol";
import { boundedMuonToolName } from "./muon-mcp-readiness.js";
import {
  resolveVendorCredentialEvidence,
  type VendorCredentialEvidence,
} from "./provider-credentials.js";

export type CodexCapabilityMethod =
  | "account/read"
  | "config/read"
  | "configRequirements/read"
  | "mcpServerStatus/list"
  | "plugin/list";

export type CodexCapabilityPreflight = {
  version: 1;
  vendor: "codex";
  vendorVersion?: string;
  posture: "governed" | "compatibility-import";
  decision: "proceed" | "block";
  blockReason?:
    | "unsafe-policy"
    | "provider-credential-missing"
    | "mcp-inventory-error"
    | "mcp-inventory-unsupported"
    | "mcp-inventory-timeout"
    | "required-muon-missing"
    /**
     * The inventory carried MCP servers MUON did not grant. Added last on
     * purpose: every reason above it keeps its exact previous message, so this
     * one only ever fires where a governed run used to PROCEED — which is the
     * hole it closes. See `ungrantedCodexMcpServers` in ./codex-guard.ts.
     */
    | "ungranted-mcp-servers"
    /**
     * The thread reported a native multi-agent mode that lets the model fan out
     * into vendor-owned subagents on its own initiative. Those children are
     * invisible to MUON: no job id, no lineage, no budget, no worktree claim and
     * no handoff evidence, so a worker that fans out is a worker whose file
     * claims and evidence are all wrong. See `codexMultiAgentMode`.
     */
    | "native-multi-agent";
  account: {
    state:
      | "native-api-key"
      | "native-chatgpt"
      | "native-bedrock"
      | "provider-owned"
      | "signed-out"
      | "unknown";
    provider: "openai" | "custom" | "unknown";
    credential: "none" | "api-key" | "custom-provider" | "local-provider";
  };
  policy: {
    source: "thread" | "config" | "unknown";
    approvalPolicy:
      | "untrusted"
      | "on-request"
      | "never"
      | "granular"
      | "unknown";
    sandboxMode:
      | "read-only"
      | "workspace-write"
      | "danger-full-access"
      | "unknown";
    unsafeFullAccess: boolean;
    requirementsObserved: boolean;
    requirementsConflict: boolean;
    /**
     * The vendor's own `thread/start` answer for native fan-out, recorded rather
     * than discarded. Codex 0.145 volunteers this on every thread and MUON was
     * mining only the thread id from that payload — so the one place the vendor
     * states whether the child can spawn ungoverned subagents was being thrown
     * away. `unknown` when the field is absent (an older app-server), never
     * assumed safe.
     */
    multiAgentMode:
      | "none"
      | "explicitRequestOnly"
      | "custom"
      | "proactive"
      | "unknown";
  };
  mcp: {
    /**
     * `timeout` means the enumeration RPC never answered inside the gate's
     * bound. Codex answers `mcpServerStatus/list` only once EVERY configured
     * MCP server has settled, so one hanging third-party server in the
     * operator's `~/.codex` zoo can stall it indefinitely — an unbounded wait
     * here used to hang session start until the runner's startup stall fired.
     */
    inventory: "verified" | "unsupported" | "error" | "timeout";
    requiredMuon: "verified" | "missing" | "unknown";
    missingTools: readonly string[];
    serverCount: number;
    toolCount: number;
    authenticatedServerCount: number;
    /**
     * Servers in the effective inventory that MUON's manifest did not grant.
     * The COUNT has always been observed; it only ever downgraded `posture` and
     * never refused. The NAMES are new, because a refusal the operator cannot
     * act on is not much better than no refusal — and because MUON now chooses
     * the child's server set, so a name here is a governance fact rather than
     * a report on the operator's personal configuration.
     */
    unexpectedServers: readonly string[];
    unexpectedServerCount: number;
    truncated: boolean;
  };
  apps: {
    source: "effective-config" | "unsupported" | "error";
    configuredCount: number;
    enabledCount: number;
  };
  plugins: {
    source: "local-only" | "unsupported" | "error";
    installedCount: number;
    enabledCount: number;
    availableCount: number;
  };
  unsupportedMethods: readonly CodexCapabilityMethod[];
  erroredMethods: readonly CodexCapabilityMethod[];
};

type CallResult =
  | { status: "ok"; value: unknown }
  | { status: "unsupported" }
  | { status: "error" };

/**
 * The Codex binding of MUON's MUON-MCP readiness gate (see
 * ./muon-mcp-readiness.ts for the pattern and the Claude binding).
 *
 * Present ⇒ this lane was given the governed `muon` server, so the run depends
 * on those tools existing and the inventory read becomes a GATE rather than
 * mere evidence: it is bounded, it re-polls while the toolset is short, and an
 * inventory MUON cannot read fails the run closed instead of proceeding into a
 * turn with a partial toolset. Absent ⇒ every behavior below is exactly what it
 * was before the gate existed.
 */
type MuonToolGate = {
  /**
   * The BARE `muon` tool names this profile granted (`dispatch`, not
   * `mcp__muon__dispatch`). Asserted in ADDITION to the mode-derived inventory,
   * never instead of it — this gate only ever refuses, so a union is the one
   * combination that cannot quietly drop a required tool.
   */
  requiredTools: readonly string[];
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type PreflightInput = {
  call: (
    method: CodexCapabilityMethod,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  threadId: string;
  cwd?: string;
  childEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  initializeResult?: unknown;
  threadStartResult?: unknown;
  resolveCredentials?: (env: NodeJS.ProcessEnv) => VendorCredentialEvidence;
  muonToolGate?: MuonToolGate;
  /**
   * Every MCP server MUON's manifest granted this run, by name. Omitted means
   * "the governed server and nothing else", which is exactly what every caller
   * before the ambient-config guard meant — so the default preserves the
   * previous `unexpectedServerCount` arithmetic verbatim.
   */
  grantedMcpServers?: readonly string[];
};

const MAX_MCP_PAGES = 4;
const MCP_PAGE_SIZE = 50;
const MAX_TOOLS_PER_SERVER = 256;
const ACCOUNT_READ: CodexCapabilityMethod = "account/read";
const CONFIG_READ: CodexCapabilityMethod = "config/read";
const REQUIREMENTS_READ: CodexCapabilityMethod = "configRequirements/read";
const MCP_STATUS_LIST: CodexCapabilityMethod = "mcpServerStatus/list";
const PLUGIN_LIST: CodexCapabilityMethod = "plugin/list";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error.code === "number"
    ? error.code
    : undefined;
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function parseVendorVersion(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.userAgent !== "string") {
    return undefined;
  }
  return value.userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0];
}

function approvalPolicy(value: unknown): CodexCapabilityPreflight["policy"]["approvalPolicy"] {
  if (
    value === "untrusted" ||
    value === "on-request" ||
    value === "never"
  ) {
    return value;
  }
  if (isRecord(value) && isRecord(value.granular)) {
    return "granular";
  }
  return "unknown";
}

/**
 * The thread's native fan-out mode, taken from the vendor's own `thread/start`
 * answer.
 *
 * The vocabulary is the binary's, not a guess: asking for an invalid value makes
 * codex 0.145 reply `unknown variant 'disabled', expected one of 'none',
 * 'custom', 'explicitRequestOnly', 'proactive'`.
 *
 * Anything unrecognized is `unknown` and is treated as NOT proven safe by the
 * caller — a mode Codex adds later must not read as "fine" merely because this
 * list predates it.
 */
function multiAgentMode(
  value: unknown
): CodexCapabilityPreflight["policy"]["multiAgentMode"] {
  return value === "none" ||
    value === "explicitRequestOnly" ||
    value === "custom" ||
    value === "proactive"
    ? value
    : "unknown";
}

/**
 * The modes a GOVERNED child may not run under.
 *
 * `proactive` lets the model fan out on its own initiative and `custom` is an
 * operator-defined policy MUON cannot read, so neither can be bounded. Both are
 * refused rather than reported.
 *
 * `explicitRequestOnly` is NOT here, and that is a deliberate, stated gap rather
 * than an oversight: it is what codex 0.145 reports for every thread on this
 * machine — measured identical with and without
 * `CODEX_AMBIENT_SUPPRESSION_ARGS`, and unchanged even when the client declares
 * `experimentalApi` and asks for `none` at `thread/start`. Listing it would
 * refuse EVERY interactive Codex run, which is a product outage, not a boundary.
 * It is surfaced on the preflight instead so the exposure is named and visible
 * rather than silently discarded, and closing it needs a vendor lever that
 * 0.145 does not appear to expose.
 */
const UNGOVERNABLE_MULTI_AGENT_MODES: ReadonlySet<string> = new Set([
  "proactive",
  "custom",
]);

function sandboxMode(value: unknown): CodexCapabilityPreflight["policy"]["sandboxMode"] {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return "unknown";
  }
  if (value.type === "readOnly") {
    return "read-only";
  }
  if (value.type === "workspaceWrite") {
    return "workspace-write";
  }
  if (value.type === "dangerFullAccess") {
    return "danger-full-access";
  }
  return "unknown";
}

function parseEffectiveConfig(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.config)) {
    return undefined;
  }
  return value.config;
}

function parseApps(
  configResult: CallResult,
  config: Record<string, unknown> | undefined,
  markMalformed: () => void
): CodexCapabilityPreflight["apps"] {
  if (configResult.status === "unsupported") {
    return { source: "unsupported", configuredCount: 0, enabledCount: 0 };
  }
  if (configResult.status === "error" || !config) {
    return { source: "error", configuredCount: 0, enabledCount: 0 };
  }
  if (config.apps === null || config.apps === undefined) {
    return {
      source: "effective-config",
      configuredCount: 0,
      enabledCount: 0,
    };
  }
  if (!isRecord(config.apps)) {
    markMalformed();
    return { source: "error", configuredCount: 0, enabledCount: 0 };
  }
  let configuredCount = 0;
  let enabledCount = 0;
  for (const [name, app] of Object.entries(config.apps)) {
    if (name === "_default") {
      continue;
    }
    if (!isRecord(app) || typeof app.enabled !== "boolean") {
      markMalformed();
      return { source: "error", configuredCount: 0, enabledCount: 0 };
    }
    configuredCount += 1;
    enabledCount += app.enabled ? 1 : 0;
  }
  return { source: "effective-config", configuredCount, enabledCount };
}

function parsePlugins(
  result: CallResult,
  markMalformed: () => void
): CodexCapabilityPreflight["plugins"] {
  if (result.status === "unsupported") {
    return {
      source: "unsupported",
      installedCount: 0,
      enabledCount: 0,
      availableCount: 0,
    };
  }
  if (result.status === "error" || !isRecord(result.value)) {
    return {
      source: "error",
      installedCount: 0,
      enabledCount: 0,
      availableCount: 0,
    };
  }
  if (!Array.isArray(result.value.marketplaces)) {
    markMalformed();
    return {
      source: "error",
      installedCount: 0,
      enabledCount: 0,
      availableCount: 0,
    };
  }
  let installedCount = 0;
  let enabledCount = 0;
  let availableCount = 0;
  for (const marketplace of result.value.marketplaces) {
    if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) {
      markMalformed();
      return {
        source: "error",
        installedCount: 0,
        enabledCount: 0,
        availableCount: 0,
      };
    }
    for (const plugin of marketplace.plugins) {
      if (
        !isRecord(plugin) ||
        typeof plugin.installed !== "boolean" ||
        typeof plugin.enabled !== "boolean" ||
        (plugin.availability !== "AVAILABLE" &&
          plugin.availability !== "DISABLED_BY_ADMIN")
      ) {
        markMalformed();
        return {
          source: "error",
          installedCount: 0,
          enabledCount: 0,
          availableCount: 0,
        };
      }
      installedCount += plugin.installed ? 1 : 0;
      enabledCount += plugin.enabled ? 1 : 0;
      availableCount += plugin.availability === "AVAILABLE" ? 1 : 0;
    }
  }
  return {
    source: "local-only",
    installedCount,
    enabledCount,
    availableCount,
  };
}

function requirementsEvidence(
  result: CallResult,
  effectiveApproval: CodexCapabilityPreflight["policy"]["approvalPolicy"],
  effectiveSandbox: CodexCapabilityPreflight["policy"]["sandboxMode"],
  markMalformed: () => void
): Pick<
  CodexCapabilityPreflight["policy"],
  "requirementsObserved" | "requirementsConflict"
> {
  if (result.status !== "ok") {
    return { requirementsObserved: false, requirementsConflict: false };
  }
  if (!isRecord(result.value) || !("requirements" in result.value)) {
    markMalformed();
    return { requirementsObserved: false, requirementsConflict: false };
  }
  if (result.value.requirements === null) {
    return { requirementsObserved: false, requirementsConflict: false };
  }
  if (!isRecord(result.value.requirements)) {
    markMalformed();
    return { requirementsObserved: false, requirementsConflict: false };
  }
  const requirements = result.value.requirements;
  let requirementsConflict = false;
  if (requirements.allowedApprovalPolicies !== null &&
      requirements.allowedApprovalPolicies !== undefined) {
    if (!Array.isArray(requirements.allowedApprovalPolicies)) {
      markMalformed();
      return { requirementsObserved: true, requirementsConflict: false };
    }
    const allowed = requirements.allowedApprovalPolicies.map(approvalPolicy);
    requirementsConflict ||=
      effectiveApproval !== "unknown" && !allowed.includes(effectiveApproval);
  }
  if (requirements.allowedSandboxModes !== null &&
      requirements.allowedSandboxModes !== undefined) {
    if (!Array.isArray(requirements.allowedSandboxModes)) {
      markMalformed();
      return { requirementsObserved: true, requirementsConflict: false };
    }
    const allowed = requirements.allowedSandboxModes.map(sandboxMode);
    requirementsConflict ||=
      effectiveSandbox !== "unknown" && !allowed.includes(effectiveSandbox);
  }
  return { requirementsObserved: true, requirementsConflict };
}

function accountEvidence(
  accountResult: CallResult,
  providerValue: unknown,
  credentials: VendorCredentialEvidence,
  markMalformed: () => void
): CodexCapabilityPreflight["account"] {
  const provider =
    typeof providerValue === "string" && providerValue.trim().length > 0
      ? providerValue === "openai"
        ? "openai"
        : "custom"
      : credentials.method === "custom-provider" ||
          credentials.method === "local-provider"
        ? "custom"
        : "unknown";
  const credential =
    credentials.ready && credentials.method
      ? credentials.method
      : "none";

  if (provider === "custom") {
    return { state: "provider-owned", provider, credential };
  }
  if (accountResult.status !== "ok") {
    if (credentials.ready && credentials.method === "api-key") {
      return { state: "native-api-key", provider, credential };
    }
    return { state: "unknown", provider, credential };
  }
  if (!isRecord(accountResult.value) || !("account" in accountResult.value)) {
    markMalformed();
    return { state: "unknown", provider, credential };
  }
  const account = accountResult.value.account;
  if (account === null) {
    if (credentials.ready && credentials.method === "api-key") {
      return { state: "native-api-key", provider, credential };
    }
    return {
      state: accountResult.value.requiresOpenaiAuth === true
        ? "signed-out"
        : "unknown",
      provider,
      credential,
    };
  }
  if (!isRecord(account) || typeof account.type !== "string") {
    markMalformed();
    return { state: "unknown", provider, credential };
  }
  if (account.type === "apiKey") {
    return { state: "native-api-key", provider, credential };
  }
  if (account.type === "chatgpt") {
    return { state: "native-chatgpt", provider, credential };
  }
  if (account.type === "amazonBedrock") {
    return { state: "native-bedrock", provider, credential };
  }
  markMalformed();
  return { state: "unknown", provider, credential };
}

type McpEvidence = CodexCapabilityPreflight["mcp"];

/** Every "we learned nothing" inventory outcome, so the shape is stated once. */
function unreadableMcpEvidence(
  inventory: "unsupported" | "error" | "timeout"
): McpEvidence {
  return {
    inventory,
    requiredMuon: "unknown",
    missingTools: [],
    serverCount: 0,
    toolCount: 0,
    authenticatedServerCount: 0,
    unexpectedServers: [],
    unexpectedServerCount: 0,
    truncated: false,
  };
}

/** The governed server, and nothing else, when a caller names no manifest. */
const DEFAULT_GRANTED_MCP_SERVERS: readonly string[] = ["muon"];

/** The gate's own outcome for "the RPC never answered inside the bound". */
const TIMED_OUT = { status: "timeout" } as const;
type InventoryCallResult = CallResult | typeof TIMED_OUT;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The tools this run must actually see. The mode-derived inventory is what the
 * governed server exposes for `MUON_MCP_MODE`; the gate's `requiredTools` is
 * what the PROFILE granted by name. They agree for an orchestrator and diverge
 * for a delegate (whose `delegate` / peer-coordination grant is not in the
 * context inventory), so the union is what "every granted tool is present"
 * actually means.
 */
function requiredMuonTools(input: PreflightInput): string[] {
  const modeTools =
    input.childEnv.MUON_MCP_MODE?.trim() === "orchestrator"
      ? MUON_ORCHESTRATOR_TOOL_NAMES
      : MUON_CONTEXT_TOOL_NAMES;
  return [
    ...new Set<string>([
      ...modeTools,
      ...(input.muonToolGate?.requiredTools ?? []),
    ]),
  ];
}

/**
 * Read the inventory ONCE. `remainingMs` bounds each page request — `undefined`
 * means "no gate on this lane, wait as long as it takes", which is what every
 * caller did before the gate existed. Without a bound, a hung third-party MCP
 * server in the operator's config stalls `mcpServerStatus/list` forever, and
 * session start with it.
 */
async function readMcpInventory(
  input: PreflightInput,
  invoke: (
    method: CodexCapabilityMethod,
    params: Record<string, unknown>
  ) => Promise<CallResult>,
  requiredTools: readonly string[],
  remainingMs: () => number | undefined
): Promise<McpEvidence> {
  const sleep = input.muonToolGate?.sleep ?? defaultSleep;
  const seenCursors = new Set<string>();
  const seenServers = new Set<string>();
  const granted = new Set<string>(
    input.grantedMcpServers ?? DEFAULT_GRANTED_MCP_SERVERS
  );
  let cursor: string | undefined;
  let serverCount = 0;
  let toolCount = 0;
  let authenticatedServerCount = 0;
  const unexpectedServers: string[] = [];
  let muonTools: Set<string> | undefined;

  for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
    const budget = remainingMs();
    // Out of budget BEFORE the request: don't send one whose answer could not
    // be waited for. A page request left unanswered in the driver's pending map
    // is pure cost.
    if (budget !== undefined && budget <= 0) {
      return unreadableMcpEvidence("timeout");
    }
    const pending = invoke(MCP_STATUS_LIST, {
      threadId: input.threadId,
      detail: "toolsAndAuthOnly",
      limit: MCP_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const result: InventoryCallResult =
      budget === undefined
        ? await pending
        : await Promise.race([pending, sleep(budget).then(() => TIMED_OUT)]);
    if (result.status === "timeout") {
      return unreadableMcpEvidence("timeout");
    }
    if (result.status === "unsupported") {
      return unreadableMcpEvidence("unsupported");
    }
    if (
      result.status === "error" ||
      !isRecord(result.value) ||
      !Array.isArray(result.value.data) ||
      result.value.data.length > MCP_PAGE_SIZE ||
      !(
        result.value.nextCursor === null ||
        result.value.nextCursor === undefined ||
        typeof result.value.nextCursor === "string"
      )
    ) {
      return unreadableMcpEvidence("error");
    }

    for (const server of result.value.data) {
      if (
        !isRecord(server) ||
        typeof server.name !== "string" ||
        server.name.length === 0 ||
        seenServers.has(server.name) ||
        !isRecord(server.tools) ||
        Object.keys(server.tools).length > MAX_TOOLS_PER_SERVER ||
        !(
          server.authStatus === "unsupported" ||
          server.authStatus === "notLoggedIn" ||
          server.authStatus === "bearerToken" ||
          server.authStatus === "oAuth"
        )
      ) {
        return unreadableMcpEvidence("error");
      }
      seenServers.add(server.name);
      serverCount += 1;
      authenticatedServerCount +=
        server.authStatus === "bearerToken" || server.authStatus === "oAuth"
          ? 1
          : 0;
      if (!granted.has(server.name)) {
        // Sanitized on the way in, not on the way out: an inventory is vendor
        // output, so the name is untrusted text from here on.
        unexpectedServers.push(boundedMuonToolName(server.name));
      }

      const tools = new Set<string>();
      for (const [mapName, tool] of Object.entries(server.tools)) {
        if (
          !isRecord(tool) ||
          typeof tool.name !== "string" ||
          tool.name !== mapName ||
          !isRecord(tool.inputSchema)
        ) {
          return unreadableMcpEvidence("error");
        }
        tools.add(tool.name);
        toolCount += 1;
      }
      if (server.name === "muon") {
        muonTools = tools;
      }
    }

    const nextCursor = result.value.nextCursor;
    if (typeof nextCursor !== "string" || nextCursor.length === 0) {
      const missingTools = muonTools
        ? requiredTools.filter((tool) => !muonTools!.has(tool))
        : [...requiredTools];
      return {
        inventory: "verified",
        requiredMuon: missingTools.length === 0 ? "verified" : "missing",
        missingTools,
        serverCount,
        toolCount,
        authenticatedServerCount,
        unexpectedServers,
        unexpectedServerCount: unexpectedServers.length,
        truncated: false,
      };
    }
    if (seenCursors.has(nextCursor)) {
      return unreadableMcpEvidence("error");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const missingTools = muonTools
    ? requiredTools.filter((tool) => !muonTools!.has(tool))
    : [];
  return {
    inventory: "verified",
    requiredMuon:
      muonTools && missingTools.length === 0 ? "verified" : "unknown",
    missingTools,
    serverCount,
    toolCount,
    authenticatedServerCount,
    unexpectedServers,
    unexpectedServerCount: unexpectedServers.length,
    truncated: true,
  };
}

/**
 * Read the inventory, and — when this lane depends on the governed brain —
 * keep reading until every required `muon` tool is exposed or the bound
 * expires.
 *
 * The re-poll exists for the same reason Claude's gate polls: `muon` reporting
 * `ready` on `mcpServer/startupStatus/updated` is a statement about the MCP
 * client's handshake, not a promise that the tool list is already published.
 * Without a gate the run proceeds anyway and the agent silently has no tools;
 * with an unbounded one it hangs. Both ends are closed here.
 *
 * Only a SHORT toolset is retried. An `unsupported`, `error`, or `timeout`
 * inventory is terminal — re-asking cannot change the answer — and each is
 * turned into a refusal by the caller.
 */
async function readMcpEvidence(
  input: PreflightInput,
  invoke: (
    method: CodexCapabilityMethod,
    params: Record<string, unknown>
  ) => Promise<CallResult>
): Promise<McpEvidence> {
  const requiredTools = requiredMuonTools(input);
  const gate = input.muonToolGate;
  if (!gate) {
    return readMcpInventory(input, invoke, requiredTools, () => undefined);
  }
  const now = gate.now ?? (() => Date.now());
  const sleep = gate.sleep ?? defaultSleep;
  const deadline = now() + gate.timeoutMs;
  const remainingMs = () => deadline - now();

  let evidence = await readMcpInventory(
    input,
    invoke,
    requiredTools,
    remainingMs
  );
  while (
    evidence.inventory === "verified" &&
    evidence.requiredMuon !== "verified" &&
    // Stop before a sleep that would land past the deadline: the read after it
    // could only run out of budget, and spending the last of it on a doomed
    // RPC delays the refusal without improving it.
    remainingMs() > gate.pollIntervalMs
  ) {
    await sleep(gate.pollIntervalMs);
    const next = await readMcpInventory(
      input,
      invoke,
      requiredTools,
      remainingMs
    );
    // A retry that could not read the inventory must never ERASE the verdict
    // already in hand. "muon is short these tools" names the missing tools;
    // "the RPC ran out of budget" does not, and the operator needs the names.
    if (next.inventory === "timeout") break;
    evidence = next;
  }
  return evidence;
}

export async function runCodexCapabilityPreflight(
  input: PreflightInput
): Promise<CodexCapabilityPreflight> {
  const unsupportedMethods: CodexCapabilityMethod[] = [];
  const erroredMethods: CodexCapabilityMethod[] = [];
  const invoke = async (
    method: CodexCapabilityMethod,
    params: Record<string, unknown>
  ): Promise<CallResult> => {
    try {
      return { status: "ok", value: await input.call(method, params) };
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? error;
      }
      if (errorCode(error) === -32601) {
        pushUnique(unsupportedMethods, method);
        return { status: "unsupported" };
      }
      pushUnique(erroredMethods, method);
      return { status: "error" };
    }
  };
  const markMalformed = (method: CodexCapabilityMethod) =>
    pushUnique(erroredMethods, method);

  const accountResult = await invoke(ACCOUNT_READ, { refreshToken: false });
  const configResult = await invoke(CONFIG_READ, {
    includeLayers: false,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  const requirementsResult = await invoke(REQUIREMENTS_READ, {});
  const pluginsResult = await invoke(PLUGIN_LIST, {
    cwds: input.cwd ? [input.cwd] : [],
    marketplaceKinds: ["local"],
  });

  const config =
    configResult.status === "ok"
      ? parseEffectiveConfig(configResult.value)
      : undefined;
  if (configResult.status === "ok" && !config) {
    markMalformed(CONFIG_READ);
  }

  const thread = isRecord(input.threadStartResult)
    ? input.threadStartResult
    : undefined;
  const threadApproval = approvalPolicy(thread?.approvalPolicy);
  const threadSandbox = sandboxMode(thread?.sandbox);
  const threadMultiAgent = multiAgentMode(thread?.multiAgentMode);
  const configApproval = approvalPolicy(config?.approval_policy);
  const configSandbox = sandboxMode(config?.sandbox_mode);
  const effectiveApproval =
    threadApproval !== "unknown" ? threadApproval : configApproval;
  const effectiveSandbox =
    threadSandbox !== "unknown" ? threadSandbox : configSandbox;
  const policySource =
    threadApproval !== "unknown" && threadSandbox !== "unknown"
      ? "thread"
      : configApproval !== "unknown" || configSandbox !== "unknown"
        ? "config"
        : "unknown";
  const requirements = requirementsEvidence(
    requirementsResult,
    effectiveApproval,
    effectiveSandbox,
    () => markMalformed(REQUIREMENTS_READ)
  );
  const unsafeFullAccess =
    effectiveApproval === "never" &&
    effectiveSandbox === "danger-full-access";

  const credentials = (input.resolveCredentials ??
    ((env) => resolveVendorCredentialEvidence("codex", { env })))(input.childEnv);
  const providerValue =
    typeof thread?.modelProvider === "string"
      ? thread.modelProvider
      : config?.model_provider;
  const account = accountEvidence(
    accountResult,
    providerValue,
    credentials,
    () => markMalformed(ACCOUNT_READ)
  );
  const apps = parseApps(configResult, config, () =>
    markMalformed(CONFIG_READ)
  );
  const plugins = parsePlugins(pluginsResult, () =>
    markMalformed(PLUGIN_LIST)
  );
  const mcp = await readMcpEvidence(input, invoke);
  if (mcp.inventory === "error" || mcp.inventory === "timeout") {
    markMalformed(MCP_STATUS_LIST);
  }

  let decision: CodexCapabilityPreflight["decision"] = "proceed";
  let blockReason: CodexCapabilityPreflight["blockReason"];
  if (unsafeFullAccess) {
    decision = "block";
    blockReason = "unsafe-policy";
  } else if (
    credentials.method === "custom-provider" &&
    !credentials.ready
  ) {
    // A trusted custom provider explicitly declared an env_key, but that exact
    // task child does not have a value. Starting the model turn can only fail,
    // so block here instead of reporting a successful preflight first.
    decision = "block";
    blockReason = "provider-credential-missing";
  } else if (mcp.inventory === "error") {
    decision = "block";
    blockReason = "mcp-inventory-error";
  } else if (mcp.inventory === "timeout") {
    // The enumeration never answered inside the bound, so MUON does not KNOW
    // which muon tools the turn would have. Same verdict as an unreadable
    // inventory: a gate that cannot verify must refuse, not assume.
    decision = "block";
    blockReason = "mcp-inventory-timeout";
  } else if (mcp.inventory === "unsupported" && input.muonToolGate) {
    // An app-server that does not implement `mcpServerStatus/list` cannot be
    // asked what it exposes. Proceeding here was the one remaining fail-OPEN
    // path on this driver: a governed lane would start its turn with the MUON
    // toolset entirely unverified, which is exactly the silent no-op the gate
    // exists to prevent. The Claude binding refuses for the identical reason
    // when the SDK exposes no `mcpServerStatus()` control request. A lane that
    // was never given the governed server has no gate and is unaffected.
    decision = "block";
    blockReason = "mcp-inventory-unsupported";
  } else if (mcp.requiredMuon === "missing") {
    decision = "block";
    blockReason = "required-muon-missing";
  } else if (
    // Truncated / paginated inventories used to return requiredMuon:"unknown"
    // and PROCEED — that let Codex turns "succeed" with zero assistant text
    // when the user's ~/.codex MCP zoo crowded muon off the first pages, or
    // when muon was still starting. Only the legacy unsupported-list path
    // (older app-server) may proceed without a verified muon inventory.
    mcp.inventory === "verified" &&
    mcp.requiredMuon !== "verified"
  ) {
    decision = "block";
    blockReason = "required-muon-missing";
  } else if (
    // ASSERT THE NEGATIVE — the last rung, so nothing above it changes.
    //
    // A governed lane (one that was given the MUON server, hence has a gate)
    // may hold only the capabilities in its manifest. Until now an ungranted
    // server merely made the posture `compatibility-import` and the run went
    // ahead, which is how a read-only scout came to hold a Node REPL and
    // desktop control. ADR-0019 §2.3 says an unexpected capability blocks
    // governed execution; this is that sentence, enforced.
    //
    // A lane with NO gate was never governed and is untouched.
    input.muonToolGate &&
    mcp.inventory === "verified" &&
    mcp.unexpectedServers.length > 0
  ) {
    decision = "block";
    blockReason = "ungranted-mcp-servers";
  } else if (UNGOVERNABLE_MULTI_AGENT_MODES.has(threadMultiAgent)) {
    // Checked for EVERY governed Codex child, not only a coordinator. The
    // `features.multi_agent=false` narrowing lived in the runner's
    // `capabilityMode === "orchestrator"` profile branch, and the delegate
    // branch resets `rawConfig: {}` — so the control plane was bounded and the
    // WORKERS below it, the ones that actually edit files, were not.
    decision = "block";
    blockReason = "native-multi-agent";
  }

  const posture =
    mcp.inventory !== "verified" ||
    mcp.truncated ||
    mcp.unexpectedServerCount > 0 ||
    unsupportedMethods.length > 0 ||
    erroredMethods.some((method) => method !== MCP_STATUS_LIST)
      ? "compatibility-import"
      : "governed";

  return {
    version: 1,
    vendor: "codex",
    ...(parseVendorVersion(input.initializeResult)
      ? { vendorVersion: parseVendorVersion(input.initializeResult) }
      : {}),
    posture,
    decision,
    ...(blockReason ? { blockReason } : {}),
    account,
    policy: {
      source: policySource,
      approvalPolicy: effectiveApproval,
      sandboxMode: effectiveSandbox,
      unsafeFullAccess,
      multiAgentMode: threadMultiAgent,
      ...requirements,
    },
    mcp,
    apps,
    plugins,
    unsupportedMethods,
    erroredMethods,
  };
}
