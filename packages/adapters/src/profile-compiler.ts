import {
  VENDOR_REGISTRY,
  isDefaultModel,
  isVendorId,
  serializeCursorHooksBoundary,
  type CompiledProfile,
  type LaneProfile,
  type McpServerConfig,
  type PermissionMode,
} from "@muon/protocol";
import { assertUniqueMcpServerNames } from "./mcp-server-validation.js";
import {
  isArgvSafeModelValue,
  modelIdMatchesShape,
  sanitizeGuardedArgs,
} from "./vendor-capabilities.js";

/**
 * S2 (HIGH): an MCP server's env, notably MUON's own `MUON_API_TOKEN`, must
 * never be serialized onto a vendor CLI's argv (readable via `ps` /
 * `/proc/<pid>/cmdline`) or written into the agent's workspace (a
 * prompt-injected agent could commit/exfiltrate it). Instead we deliver the
 * VALUES through the spawned vendor CLI's child-process env (base-lane-adapter
 * threads `CompiledProfile.env`), and put only a by-NAME reference in the
 * vendor-native config. Each vendor resolves the name from its own environment
 * when it spawns the MCP server subprocess:
 *   - claude:  `${VAR}`     expansion in --mcp-config env values
 *   - cursor:  `${env:VAR}` expansion in .cursor/mcp.json env values
 *   - codex:   `mcp_servers.<name>.env_vars = ["VAR", …]` forwards named vars
 * If a vendor doesn't resolve the reference, the MCP server just gets no token
 * from the config, in the embedded brain it can still authenticate via the
 * local 0600 lockfile, else the request 401s. No secret leaks off-machine and
 * the gate is never bypassed either way.
 *
 * SCOPE (review S2, finding 1): this closes the two named vectors, token on
 * argv (other local users via `ps`/`/proc`) and token in a workspace file (agent
 * commit/exfil). It does NOT hide the local loopback token from the sub-agent's
 * OWN shell: the value now lives in the vendor CLI's process env, and the
 * sub-agent runs as the SAME OS user, so it can still read it (env / `/proc`).
 * That is inherent to the local-first, same-uid model, the local token guards
 * only 127.0.0.1 (useless off-machine). The interactive-claude path scopes the
 * token tighter (only the in-process MCP server env, never the SDK global env).
 *
 * ADR-0010 Part A now blinds the DISPATCHED (untrusted) agent to the token's
 * on-disk home: an OS sandbox (macOS Seatbelt via `SandboxLauncher`, see
 * ./sandbox/) deny-reads the MUON data dir, so `cat brain.lock` ⇒ EPERM, the
 * agent can no longer lift the OPERATOR token even at the same uid (F2 read
 * vector closed). Because dispatched claude runs the Agent SDK IN-PROCESS in the
 * runner, the confinement is applied to the WHOLE runner (A2), which is handed
 * the AGENT token via env instead of a lockfile read; every child it spawns
 * inherits the sandbox. Residuals: the unsandboxed degradation path, network
 * exfil over the model channel, and full same-uid closure (separate uid / signed
 * app), tracked as ADR-0010 Phase A3.
 */
/**
 * Raised when two MCP servers in one lane profile declare the same env KEY.
 *
 * Every vendor delivers MCP env by NAME (`${VAR}` / `${env:VAR}` / codex's
 * `env_vars=[…]`) with the VALUE travelling in the child's environment — one
 * flat namespace shared by every server on the lane. So two servers declaring
 * the same key do not get one value each; the last writer wins and BOTH servers
 * are handed that single value.
 *
 * That is a credential hand-off, not a config quirk: MUON's own server is
 * appended last, so a third-party server that merely declares `MUON_API_TOKEN`
 * would receive MUON's job-bound token. Refusing is the only answer that cannot
 * leak — per-server env delivery would be the richer fix, but silently picking a
 * winner is the one option that is always wrong.
 */
export class McpEnvCollisionError extends Error {
  readonly key: string;
  readonly servers: string[];

  constructor(key: string, servers: string[]) {
    super(
      `MCP env key '${key}' is declared by more than one server on this lane (${servers.join(
        ", "
      )}). Vendors deliver MCP env by name through ONE shared child environment, so both servers would receive the same value — including MUON's own job-bound credentials. Rename the key on the third-party server, or drop it from the lane profile.`
    );
    this.name = "McpEnvCollisionError";
    this.key = key;
    this.servers = servers;
  }
}

function hoistMcpServerEnv(servers: McpServerConfig[]): Record<string, string> {
  const env: Record<string, string> = {};
  const declaredBy = new Map<string, string>();
  for (const server of servers) {
    for (const [key, value] of Object.entries(server.env)) {
      const previous = declaredBy.get(key);
      // Identical values are not a hand-off — the same secret reaching the same
      // place twice changes nothing. Only a genuine conflict is refused.
      if (previous !== undefined && previous !== server.name && env[key] !== value) {
        throw new McpEnvCollisionError(key, [previous, server.name]);
      }
      declaredBy.set(key, server.name);
      env[key] = value;
    }
  }
  return env;
}

/** Replace each env VALUE with a by-name reference (see hoistMcpServerEnv). */
function referenceEnv(
  env: Record<string, string>,
  toReference: (name: string) => string
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(env).map((name) => [name, toReference(name)])
  );
}

/**
 * S5: a `model` value must never smuggle a guarded flag (e.g.
 * `--strict-mcp-config`) onto the vendor CLI argv. Mirrors the claude
 * compiler's `safeFieldValues` guard (:compileClaudeProfile) so the codex and
 * cursor model fields fail closed to `unsupported` instead of reaching the
 * vendor as argv — closing the sanitize hole before the agent tier can set it.
 */
/**
 * TODO 3.6 / 3.7 — turn a profile's `model` into the id a compiler may put on
 * argv, or `null` meaning "emit no model flag" (vendor default).
 *
 * Behaviour for every PREVIOUSLY-LEGAL input is unchanged: a real id that
 * passes the guard still emits, a guarded id still becomes `unsupported`. The
 * only new input is `muon/default`, which is the operator's explicit "let the
 * CLI decide" and must not reach the vendor as a literal model name.
 */
export type ResolvedCompiledModel =
  | { kind: "emit"; model: string }
  | { kind: "omit" }
  | { kind: "refuse"; unsupported: string };

export function resolveCompiledModel(
  model: string | undefined
): ResolvedCompiledModel {
  if (!model || isDefaultModel(model)) {
    return { kind: "omit" };
  }
  if (!isArgvSafeModelValue(model)) {
    return { kind: "refuse", unsupported: "guarded model value rejected" };
  }
  return { kind: "emit", model };
}

function mcpServersToClaudeConfig(servers: McpServerConfig[]) {
  assertUniqueMcpServerNames(servers);
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = server.command
      ? {
          command: server.command,
          args: server.args,
          // Env by NAME only ("${VAR}"), the value travels via the child
          // process env, never on argv (S2).
          ...(Object.keys(server.env).length > 0
            ? { env: referenceEnv(server.env, (name) => `\${${name}}`) }
            : {}),
        }
      : { type: "http", url: server.url };
  }
  return { mcpServers };
}

const CLAUDE_PERMISSION_MODES: Record<PermissionMode, string> = {
  strict: "dontAsk",
  default: "default",
  "auto-edits": "acceptEdits",
  "full-auto": "bypassPermissions",
};

/**
 * Compile a MUON lane profile to `claude` CLI flags. Everything the profile
 * can express maps to an official flag or a run-scoped config artifact,
 * user-global settings are never touched.
 */
/**
 * Claude's native sub-agent tools, denied on every governed claude run (TODO 1.16).
 * A set rather than a literal so a second spelling has one place to be added.
 */
export const CLAUDE_NATIVE_FAN_OUT_TOOLS: readonly string[] = ["Task"];

export function compileClaudeProfile(profile: LaneProfile): CompiledProfile {
  const args: string[] = ["--strict-mcp-config"];
  const configWrites: CompiledProfile["configWrites"] = [];
  const unsupported: string[] = [];
  let rejectedGuardedValue = false;
  const safeFieldValues = (values: string[]): string[] =>
    values.filter((value) => {
      const safe = sanitizeGuardedArgs([value]).removed.length === 0;
      rejectedGuardedValue ||= !safe;
      return safe;
    });

  {
    const resolved = resolveCompiledModel(profile.model);
    if (resolved.kind === "emit") {
      // Keep the local safeFieldValues path so a guarded value still flips the
      // rejectedGuardedValue bit the rest of this compiler reports on.
      const [model] = safeFieldValues([resolved.model]);
      if (model) {
        args.push("--model", model);
      }
    } else if (resolved.kind === "refuse") {
      // One aggregated "guarded Claude profile value rejected" below — do not
      // also push a model-specific unsupported, or the count doubles.
      rejectedGuardedValue = true;
    }
  }
  if (profile.permissionMode) {
    args.push("--permission-mode", CLAUDE_PERMISSION_MODES[profile.permissionMode]);
  }
  if (profile.sandbox && profile.sandbox !== "read-only") {
    // Claude Code has no sandbox flag; permission rules are the boundary.
    unsupported.push(`sandbox=${profile.sandbox}`);
  }
  for (const dir of safeFieldValues(profile.addDirs)) {
    args.push("--add-dir", dir);
  }
  const allowedTools = safeFieldValues(profile.allowedTools);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", ...allowedTools);
  }
  const deniedTools = safeFieldValues([
    ...new Set([
      ...profile.deniedTools,
      ...(profile.sandbox === "read-only"
        ? [
            "Bash",
            "Shell",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "apply_patch",
          ]
        : []),
      // TODO 1.16: `Task` is denied on EVERY claude lane, not only where the
      // allow-list happens to omit it.
      //
      // The previous suppression was an accident of the coordinator seat: that
      // profile grants an EXACT governed-MCP set, so `Task` was absent and the
      // launch-time over-capability assertion kept it absent. Neither fact reaches
      // a WORKER — a delegate profile with no allow-list, or a `bypassPermissions`
      // seat, gets claude's default inventory, and native `Task` subagents are in
      // it: unattributed children spending the parent's authority, outside MUON's
      // ledger and outside its concurrency budget. Governed fan-out is
      // `mcp__muon__dispatch`, which is a lane run with a job id.
      //
      // Additive and categorical, so it survives composition: deny beats allow in
      // claude's own resolution, both channels carry it (`--disallowedTools` on
      // argv, `disallowedTools` in the SDK session), and no profile field or
      // `extraArgs` path can subtract from a set the compiler unions in.
      ...CLAUDE_NATIVE_FAN_OUT_TOOLS,
    ]),
  ]);
  if (deniedTools.length > 0) {
    args.push("--disallowedTools", ...deniedTools);
  }
  if (profile.mcpServers.length > 0) {
    args.push("--mcp-config", JSON.stringify(mcpServersToClaudeConfig(profile.mcpServers)));
  }
  // TODO 1.15: strip before write, and report the strip. `rawConfig` lands
  // verbatim in a file that ANOTHER vendor executes (see
  // `CLAUDE_RAW_CONFIG_FORBIDDEN_KEYS`), so a `hooks` key here is command
  // execution that escapes the lane it was authored for. Dropped rather than
  // thrown: the rest of the profile is still governable, and `unsupported` is how
  // this compiler already tells the operator a field did not survive.
  const rawConfigEntries = Object.entries(profile.rawConfig);
  const forbiddenRawKeys = rawConfigEntries
    .map(([key]) => key)
    .filter((key) => CLAUDE_RAW_CONFIG_FORBIDDEN_KEYS.includes(key));
  if (forbiddenRawKeys.length > 0) {
    unsupported.push(
      `rawConfig.${forbiddenRawKeys.join("/")} refused: hooks in a claude settings file are ungoverned command execution, and cursor replays this file (TODO 1.15)`
    );
  }
  const safeRawConfig = Object.fromEntries(
    rawConfigEntries.filter(
      ([key]) => !CLAUDE_RAW_CONFIG_FORBIDDEN_KEYS.includes(key)
    )
  );
  if (Object.keys(safeRawConfig).length > 0) {
    configWrites.push({
      relativePath: CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH,
      contents: `${JSON.stringify(safeRawConfig, null, 2)}\n`,
    });
  }
  const extraArgs = sanitizeGuardedArgs(profile.extraArgs);
  rejectedGuardedValue ||= extraArgs.removed.length > 0;
  args.push(...extraArgs.args);
  if (rejectedGuardedValue) {
    unsupported.push("guarded Claude profile value rejected");
  }

  return {
    args,
    // MCP env values (incl. MUON_API_TOKEN) travel via the child env, not argv (S2).
    env: { ...profile.env, ...hoistMcpServerEnv(profile.mcpServers) },
    configWrites,
    unsupported,
  };
}

/**
 * MUON's permission modes in codex's approval vocabulary — and why every
 * must-ask mode now compiles to `untrusted`.
 *
 * `on-request` reads like "ask when needed" but is MEASURED (0.145.0, live
 * app-server session) to mean "the MODEL decides": a shell command under
 * `approvalPolicy: "on-request"` ran with zero approval requests. A must-ask
 * MUON mode compiled to it was therefore an ungated child wearing a gate's
 * name. `untrusted` is the mode that actually routes every command execution,
 * file change, and MCP tool call to the CLIENT — and on the app-server
 * transport that client is MUON's approval bridge, which is the gate
 * (`auto-edits` rides the same mode; the bridge, not the vendor, is where an
 * edit-class allowance belongs, and codex has no per-class approval axis).
 *
 * `codex exec` ignores this key entirely — it runs `approval: never` however
 * `approval_policy` is stated (measured; its banner says so) — which is why the
 * exec transport carries the loud "NO approval gate" notice instead of a
 * pretend policy.
 */
const CODEX_APPROVAL_POLICIES: Record<PermissionMode, string> = {
  strict: "untrusted",
  default: "untrusted",
  "auto-edits": "untrusted",
  "full-auto": "never",
};

const CODEX_SANDBOX_MODES: Record<string, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace-write",
  "full-access": "danger-full-access",
};

function tomlValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * One dotted segment of a codex config key. Deliberately narrow: a server or
 * tool name reaches the child as part of a `-c mcp_servers.<server>.…` KEY, and
 * a name carrying `.` or `=` would re-shape which key is being set. Anything
 * outside this alphabet is refused and reported rather than escaped — an
 * escaping rule for a key path is exactly the kind of cleverness that becomes
 * the next injection.
 */
const CODEX_CONFIG_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** How many tool names one `unsupported` sentence names before it summarizes. */
const CODEX_UNHONORED_TOOLS_NAMED = 5;

function namedTools(tools: readonly string[]): string {
  const shown = tools.slice(0, CODEX_UNHONORED_TOOLS_NAMED).join(", ");
  const rest = tools.length - CODEX_UNHONORED_TOOLS_NAMED;
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/**
 * Split an MCP-namespaced tool name into the coordinates codex's config
 * addresses: `mcp__muon__memory_delete` → `{ server: "muon", tool:
 * "memory_delete" }`. Returns null for anything else — a native tool name
 * (`Write`, `Bash`), a tool specifier (`Bash(rm:*)`), or a name whose segments
 * are not safe to place in a config key.
 */
function codexMcpToolCoordinate(
  name: string
): { server: string; tool: string } | null {
  const segments = name.trim().split("__").filter(Boolean);
  // `mcp` + server + tool. A deeper name is not a coordinate this can address.
  if (segments.length !== 3 || segments[0]!.toLowerCase() !== "mcp") {
    return null;
  }
  const [, server, tool] = segments as [string, string, string];
  if (!CODEX_CONFIG_SEGMENT.test(server) || !CODEX_CONFIG_SEGMENT.test(tool)) {
    return null;
  }
  return { server, tool };
}

/**
 * What codex CAN and CANNOT be told about a profile's tool policy.
 *
 * The message this replaces — `allowedTools/deniedTools (use rawConfig approval
 * tables)` — named the mechanism and then did not use it, so a harness that
 * intended to bound a child's tools produced a child with no tool bounds and a
 * debug line nobody reads. Measured against codex 0.145.0, the honest split is:
 *
 *  - DENY, per MCP tool: real. `mcp_servers.<server>.disabled_tools` is a
 *    genuine, MONOTONE narrowing — the tool is removed from the child's
 *    inventory, so it cannot be called at all. Emitted here for every denied
 *    name that resolves to a server this profile actually grants.
 *  - DENY, native tools (`Write`, `Bash`, `apply_patch`): NOT expressible.
 *    Codex has no per-tool deny table for its own tools; `sandbox_mode` and
 *    `approval_policy` are the only boundary, which is why a read-only role
 *    also clamps the sandbox. Reported, never silently dropped.
 *  - ALLOW / pre-authorize: NOT mirrored, deliberately. Codex's per-tool
 *    `approval_mode = "auto"` would WIDEN the vendor's own gate, and MUON's
 *    pre-authorization means "MUON will not ask", not "the vendor must not".
 *    Reported so the caller knows the pre-auth did not become a vendor grant.
 *
 * Exported so the lanes can state the SAME degradation to the operator without
 * compiling the profile a second time (see `CodexAdapter`/`CodexSessionDriver`).
 */
export function compileCodexToolPolicy(profile: LaneProfile): {
  args: string[];
  /** `server.tool` coordinates this lane genuinely removes from the child. */
  honoredDenials: string[];
  /** Capabilities the profile declared that codex cannot hold, in words. */
  unsupported: string[];
} {
  const grantedServers = new Set(profile.mcpServers.map((server) => server.name));
  const disabledByServer = new Map<string, Set<string>>();
  const honoredDenials: string[] = [];
  const unhonoredDenials: string[] = [];

  for (const denied of profile.deniedTools) {
    const coordinate = codexMcpToolCoordinate(denied);
    if (!coordinate || !grantedServers.has(coordinate.server)) {
      unhonoredDenials.push(denied);
      continue;
    }
    const tools = disabledByServer.get(coordinate.server) ?? new Set<string>();
    tools.add(coordinate.tool);
    disabledByServer.set(coordinate.server, tools);
    honoredDenials.push(`${coordinate.server}.${coordinate.tool}`);
  }

  const args: string[] = [];
  // Sorted so the same profile always compiles to the same argv — a config
  // override that reordered between runs would make argv comparisons useless.
  for (const server of [...disabledByServer.keys()].sort()) {
    const tools = [...disabledByServer.get(server)!].sort();
    args.push("-c", `mcp_servers.${server}.disabled_tools=${tomlValue(tools)}`);
  }

  const unsupported: string[] = [];
  if (unhonoredDenials.length > 0) {
    unsupported.push(
      `deniedTools: ${unhonoredDenials.length} name(s) codex cannot deny per-tool (${namedTools(
        unhonoredDenials
      )}) — codex has no deny table for its own tools, so only sandbox_mode + approval_policy bound them`
    );
  }
  if (profile.allowedTools.length > 0) {
    unsupported.push(
      `allowedTools: ${profile.allowedTools.length} name(s) not pre-authorized on this lane (${namedTools(
        profile.allowedTools
      )}) — codex has no pre-authorization table; every tool it runs is governed by approval_policy`
    );
  }

  return { args, honoredDenials, unsupported };
}

/**
 * What actually bounds ONE governed Codex child, in words, once per run.
 *
 * A capability a lane cannot honor used to leave a single `task.progress` line
 * (`profile: '…' is not supported by this lane`) that the event recorder
 * coalesces into an anonymous progress blob — a runner-log whisper. The
 * founder's mission is what that costs: the `implement` harness's tool policy
 * was dropped, its `workspace-write` sandbox was overridden to
 * `danger-full-access` by the nested-sandbox fix, and `codex exec` runs
 * non-interactively — so a child ran with no tool bounds, no vendor sandbox and
 * no approval gate, and nothing said so in one place.
 *
 * This is that one place. It states the boundary that IS in force before it
 * lists what was lost, because "what is this child actually allowed to do" is
 * the question an operator has; the losses are the evidence for the answer.
 * Returns undefined when nothing was lost AND the gate is intact — a run with
 * no degradation must not narrate itself.
 */
export function codexCapabilityNotice(input: {
  /** `CompiledProfile.unsupported` for this run. */
  unsupported: readonly string[];
  /** `server.tool` coordinates this run genuinely removed from the child. */
  honoredDenials: readonly string[];
  /** The `sandbox_mode` the composed argv actually states, if any. */
  sandboxMode: string | undefined;
  /**
   * Whether a tool call on this transport can reach a human at all. False for
   * `codex exec`: it is non-interactive and reports `approval: never` however
   * `approval_policy` was compiled (measured, codex 0.145.0), so the profile's
   * permissionMode does not gate a single call on that path.
   */
  canAskApproval: boolean;
}): string | undefined {
  if (input.unsupported.length === 0 && input.canAskApproval) {
    return undefined;
  }
  const parts = [
    `codex: this child's effective boundary is sandbox_mode=${
      input.sandboxMode ?? "workspace-write (codex's own default; MUON stated none)"
    }, and ${
      input.canAskApproval
        ? "MUON's own approval bridge gates its tool calls"
        : "NO approval gate — `codex exec` is non-interactive and runs with approval_policy=never however the profile was compiled, so not one tool call on this run was put to a human"
    }.`,
  ];
  if (input.honoredDenials.length > 0) {
    parts.push(
      `MUON removed ${input.honoredDenials.length} denied tool(s) from the child's inventory: ${input.honoredDenials.join(", ")}.`
    );
  }
  if (input.unsupported.length > 0) {
    parts.push(
      `Declared capabilities this lane could NOT hold: ${input.unsupported.join("; ")}.`
    );
  }
  return parts.join(" ");
}

/**
 * Compile to `codex` CLI `-c key=value` overrides, every config.toml key is
 * reachable this way, so rawConfig gives full passthrough without file writes.
 */
export function compileCodexProfile(profile: LaneProfile): CompiledProfile {
  assertUniqueMcpServerNames(profile.mcpServers);
  const args: string[] = [];
  const unsupported: string[] = [];

  {
    const resolved = resolveCompiledModel(profile.model);
    if (resolved.kind === "emit") {
      // Codex `app-server` (interactive sessions) rejects `--model` /
      // `-m` and exits immediately — that left MUON hung on initialize
      // until the 90s startup stall. `-c model=…` is accepted by both
      // `app-server` and `exec`, so one compile path covers both.
      args.push("-c", `model=${JSON.stringify(resolved.model)}`);
    } else if (resolved.kind === "refuse") {
      unsupported.push("guarded codex model value rejected");
    }
  }
  if (profile.permissionMode) {
    args.push("-c", `approval_policy=${JSON.stringify(CODEX_APPROVAL_POLICIES[profile.permissionMode])}`);
  }
  if (profile.sandbox) {
    args.push("-c", `sandbox_mode=${JSON.stringify(CODEX_SANDBOX_MODES[profile.sandbox])}`);
  }
  if (profile.addDirs.length > 0) {
    args.push(
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(profile.addDirs)}`
    );
  }
  for (const server of profile.mcpServers) {
    const key = `mcp_servers.${server.name}`;
    if (server.command) {
      args.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
      if (server.args.length > 0) {
        args.push("-c", `${key}.args=${JSON.stringify(server.args)}`);
      }
      const envNames = Object.keys(server.env);
      if (envNames.length > 0) {
        // Codex has no ${VAR} expansion; `env_vars` forwards named vars from
        // codex's own process env into the MCP server, the value stays off
        // argv, delivered via the child env instead (S2).
        args.push("-c", `${key}.env_vars=${JSON.stringify(envNames)}`);
      }
    } else if (server.url) {
      args.push("-c", `${key}.url=${JSON.stringify(server.url)}`);
    }
  }
  // Mirror what codex CAN hold — a per-MCP-tool denial is a real inventory
  // removal (measured: the child then reports the tool "unavailable in this
  // session") — and report by name what it cannot. Stated AFTER each server is
  // declared so the narrowing always lands on a server the child already has.
  const toolPolicy = compileCodexToolPolicy(profile);
  args.push(...toolPolicy.args);
  unsupported.push(...toolPolicy.unsupported);
  for (const [key, value] of Object.entries(profile.rawConfig)) {
    args.push("-c", `${key}=${tomlValue(value)}`);
  }
  args.push(...profile.extraArgs);

  return {
    args,
    // MCP env values (incl. MUON_API_TOKEN) travel via the child env, not argv (S2).
    env: { ...profile.env, ...hoistMcpServerEnv(profile.mcpServers) },
    configWrites: [],
    unsupported,
  };
}

/**
 * Compile to `opencode run` flags.
 *
 * DELIBERATELY THIN, and the thinness is the design. OpenCode has no
 * `--permissions` flag — verified against 1.18.5, where the only permission
 * option is `--auto`, which WIDENS. Everything that bounds this lane therefore
 * lives in a config FILE plus the env that makes that file the last word, and
 * `OpencodeAdapter` owns both (see `buildOpencodeGuardConfig` /
 * `opencodeGuardEnv`). Nothing about the boundary is expressible here.
 *
 * So this compiler only maps the fields that are genuinely argv-shaped, and
 * reports the rest as `unsupported` rather than silently dropping them. In
 * particular it emits NO permission/sandbox flag at all: inventing one would
 * imply a boundary opencode's CLI does not actually have.
 */
export function compileOpencodeProfile(profile: LaneProfile): CompiledProfile {
  assertUniqueMcpServerNames(profile.mcpServers);
  const args: string[] = [];
  const unsupported: string[] = [];

  {
    // TODO 3.6: the Default sentinel degrades to no flag BEFORE the form check —
    // `muon/default` is not provider-qualified and must not be reported as a
    // malformed opencode id. TODO 3.4's bare-slug refusal is unchanged for every
    // real id.
    const resolved = resolveCompiledModel(profile.model);
    if (resolved.kind === "refuse") {
      unsupported.push("guarded opencode model value rejected");
    } else if (resolved.kind === "emit") {
      if (!modelIdMatchesShape("provider-qualified", resolved.model)) {
        unsupported.push(
          `model=${resolved.model} (opencode ids are 'provider/model'; run \`opencode models\` for this machine's list)`
        );
      } else {
        args.push("--model", resolved.model);
      }
    }
  }
  if (profile.permissionMode) {
    // Not a silent drop: the permission table is the guard config, and a caller
    // who set a mode here needs to know it did not become a flag.
    unsupported.push(
      `permissionMode=${profile.permissionMode} (opencode permissions are config-only; MUON's deny-first guard config governs this lane)`
    );
  }
  if (profile.sandbox && profile.sandbox !== "read-only") {
    unsupported.push(`sandbox=${profile.sandbox} (opencode has no sandbox flag)`);
  }
  if (profile.addDirs.length > 0) {
    // `external_directory` is denied by the guard config, so an extra root
    // would be unreadable anyway. Say so instead of pretending.
    unsupported.push("addDirs (single --dir only; external_directory is denied)");
  }
  if (profile.allowedTools.length > 0 || profile.deniedTools.length > 0) {
    unsupported.push(
      "allowedTools/deniedTools (opencode gates tools through its own permission tokens, which MUON states in the guard config)"
    );
  }
  // TODO 1.7: opencode still has no per-run MCP *flag*. Local stdio servers
  // ride through `OpencodeAdapter`'s guard config (`mcp` block on the file +
  // `OPENCODE_CONFIG_CONTENT`), not argv — so they are NOT unsupported. Env
  // values are hoisted into the child process; the config only carries
  // `{env:VAR}` references (S2). Ambient operator MCP stays blocked by
  // `XDG_CONFIG_HOME` redirection. HTTP/url servers stay refused: finding 5
  // exists to keep remote MCP off a governed run.
  const localMcpServers = profile.mcpServers.filter((server) => server.command);
  const remoteMcpServers = profile.mcpServers.filter((server) => server.url);
  if (remoteMcpServers.length > 0) {
    unsupported.push(
      `mcpServers url (${remoteMcpServers
        .map((s) => s.name)
        .join(", ")}) — opencode managed runs only inject local stdio MCP; remote URLs are refused`
    );
  }
  if (Object.keys(profile.rawConfig).length > 0) {
    unsupported.push("rawConfig (opencode has no `-c key=value` override)");
  }
  args.push(...profile.extraArgs);

  return {
    args,
    env: { ...profile.env, ...hoistMcpServerEnv(localMcpServers) },
    configWrites: [],
    unsupported,
  };
}

/**
 * TODO 1.16 — what actually stops cursor's native subagents, and what does not.
 *
 * THE PROBLEM. Cursor ships real subagents behind a `Task` tool. A child spawned
 * that way is outside MUON's job lineage, budget, worktree, and token gates, and
 * measurement made it worse than that: a spawned subagent's own tool list came
 * back as `Shell, Glob, Grep, AwaitShell, Read, Delete, StrReplace, Write,
 * EditNotebook, TodoWrite, WebSearch, WebFetch, GenerateImage, Task, GetMcpTools,
 * FetchMcpResource, SwitchMode, CallMcpTool` — write and shell tools included,
 * from a parent running `--mode plan`. Cursor's plan mode is a behavioural
 * instruction to the parent, not an enforced ceiling on its children.
 *
 * WHAT DOES NOT WORK, MEASURED, so nobody re-derives it from the docs.
 * `permissions.deny` in `.cursor/cli.json` cannot express this. All three
 * spellings — `Task(**)`, `Task(*)`, and bare `Task` — left the spawn working, in
 * plan mode and in default mode, on cursor-agent 2026.07.23-e383d2b (2026-07-31,
 * real turns). It is not that the file was ignored: in the SAME fixture
 * `Write(**)` blocked a write that an empty table allowed, and `Shell(echo *)`
 * denied a command an allow entry had just granted. The permission table simply
 * has no `Task` kind — the shipped bundle's own entry parsers recognize
 * `Shell`/`Bash`, `Mcp`, `WebFetch`, `WebSearch`, and `GenerateImage`, and nothing
 * else. A `Task(**)` deny would therefore be a DECORATIVE line in the one file a
 * human audits to learn this lane's posture, which is worse than an honest gap.
 *
 * `subagentStart`, the hook cursor's docs point at for exactly this, also does not
 * fire on a `cursor-agent --print` run: the hook script was never executed (no
 * log line) while the very same hooks file's `beforeShellExecution` entry fired
 * and blocked a command.
 *
 * WHAT WORKS. A `preToolUse` hook matched on `Task`, in the run-scoped
 * `.cursor/hooks.json` MUON writes. Measured in the same fixture: `Error: Task
 * blocked by preToolUse hook: <MUON's message>`, with zero subagents started, and
 * a `Read` in the same turn unaffected. Project hooks load with no trust prompt
 * and no extra flag, so this needs nothing from the operator.
 *
 * `failClosed: true` is the load-bearing half: hook failures (crash, timeout,
 * invalid JSON) default to ALLOWING the action through, which would turn every
 * transient hook error into an ungoverned subagent.
 *
 * The command is inline shell rather than a script path so the whole suppression
 * is one `configWrites` entry with no executable bit to get wrong. It drains stdin
 * first — hooks are handed JSON on stdin, and a command that exits without reading
 * it can take SIGPIPE and be scored as a hook FAILURE.
 */
export const CURSOR_NATIVE_FAN_OUT_DENIAL_MESSAGE =
  "MUON: vendor-native subagents are not permitted on a governed run. Governed fan-out is mcp__muon__dispatch.";

export const CURSOR_HOOKS_RELATIVE_PATH = ".cursor/hooks.json";
export const CURSOR_PERMISSIONS_RELATIVE_PATH = ".cursor/cli.json";

/**
 * TODO 1.15 — CURSOR EXECUTES CLAUDE'S HOOK FILES, SO MUON HAS TO OWN THEM TOO.
 *
 * `.cursor/hooks.json` was believed to be THE hook net for a cursor run. It is
 * one of seven, and three of the seven belong to a different vendor: cursor-agent
 * 2026.07.23-e383d2b builds `claudeUserConfigPath`, `claudeProjectConfigPath` and
 * `claudeProjectLocalConfigPath` alongside its own, parses each with a
 * `parseClaudeConfig` that maps claude's event names onto cursor's
 * (`PreToolUse`→`preToolUse`, `UserPromptSubmit`→`beforeSubmitPrompt`, `Stop`→
 * `stop`, `SessionStart`/`SessionEnd`/`PreCompact`/`PostToolUse`/`SubagentStop`
 * likewise; `PermissionRequest` and `Notification` map to null), and runs them
 * merged with its own.
 *
 * PROVEN LIVE, on MUON's exact argv (`--print --output-format json --mode plan
 * --trust --skip-worktree-setup`), 2026-07-31: a fixture repo committing
 * `.claude/settings.json` had both its `SessionStart` and its `PreToolUse`
 * commands EXECUTED, and removing the file made them stop. `--mode plan` is no
 * defence — it bounds what the MODEL may call, while a hook is spawned by the
 * VENDOR before any tool call is judged — and neither is `.cursor/cli.json`,
 * because a hook is not a tool call. This is the same class as the
 * repo-controlled shell in §2.12, live today, on the lane MUON already ships.
 *
 * WHAT IS NOT AT RISK, measured, so the fix is not over-sold: hook decisions
 * merge deny > ask > allow, so a repo-supplied `allow` cannot out-vote MUON's
 * `Task` deny. The exposure is arbitrary command execution and `additional_context`
 * injection, not a widened permission table.
 *
 * Both PROJECT paths are written even though only `.claude/settings.json` was
 * observed firing — `.claude/settings.local.json` is named by the loader and
 * declared in its source list but did not execute on this version, with or
 * without a sibling `settings.json`. A path the vendor's own loader names is not
 * a path to leave to a repo on the strength of one version's behaviour.
 *
 * The USER-GLOBAL `~/.claude/settings.json` is out of reach and that is recorded
 * rather than papered over: see `cursorForeignHookExposure`.
 */
export const CLAUDE_SETTINGS_RELATIVE_PATH = ".claude/settings.json";
export const CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH = ".claude/settings.local.json";

/**
 * The hook-free claude document MUON writes over a repo's own on a cursor run.
 *
 * `{"hooks": {}}` rather than `{}` because the empty object is the POSITIVE form:
 * cursor's `parseClaudeConfig` returns `{}` for a document with no hooks either
 * way, but a human opening this file mid-run should read MUON's intent, not
 * infer it from an absence. Measured to leave a clean run (rc 0, valid JSON
 * result, no parse warning) rather than tripping the loader's error path.
 */
export function buildNeutralClaudeSettings(): string {
  return `${JSON.stringify({ hooks: {} }, null, 2)}\n`;
}

/**
 * Keys MUON refuses inside a claude lane profile's `rawConfig`.
 *
 * `rawConfig` is operator-authored data written VERBATIM to
 * `.claude/settings.local.json`, and `hooks` there is arbitrary command
 * execution that no MUON gate ever sees — it is not a permission, so
 * `permissionMode`, the deny table and the sandbox all have nothing to say about
 * it. That was already true before TODO 1.15 and would have been worth refusing
 * on its own.
 *
 * 1.15 is what makes it load-bearing: cursor executes this exact file, so a hook
 * placed here does not stay in the lane it was written for. It also settles the
 * one race in `writeRunScopedConfig` that would otherwise matter — a claude lane
 * and a cursor lane in the same checkout contend for
 * `.claude/settings.local.json`, and the ref-counted hold deliberately does NOT
 * rewrite for the second holder, so whichever lane arrives first owns the bytes.
 * With this refusal that race has no bad outcome to pick: the claude lane's
 * document is hook-free by construction and MUON's cursor document is hook-free
 * by definition, so the path is hook-free whoever wins.
 */
export const CLAUDE_RAW_CONFIG_FORBIDDEN_KEYS: readonly string[] = ["hooks"];

/**
 * ANCHORED, and that is the whole point.
 *
 * Cursor applies this with `new RegExp(matcher).test(tool_name)` — unanchored and
 * flagless — and for an MCP call it sets `tool_name` to `MCP:<toolName>`. An
 * unanchored `[Tt]ask` therefore matched `MCP:task_context`, which is in
 * `MUON_CONTEXT_TOOL_NAMES`: the base tier EVERY worker is granted. MUON's own
 * fan-out hook was denying MUON's own brain tool, and telling the operator the
 * reason was "vendor-native subagents are not permitted" — a governance product
 * blocking its own governance and misreporting why. `create_task` and `list_tasks`
 * collided the same way.
 *
 * The character class stays: the field is compiled with NO flags, so there is no
 * case-insensitivity to ask for, and while the event carries `Task` on
 * 2026.07.23-e383d2b (measured) the shipped bundle contains `toolName:"task"` too,
 * so a rename to the lowercase spelling would disarm this in silence.
 */
export const CURSOR_NATIVE_FAN_OUT_MATCHER = "^[Tt]ask$";

/** The run-scoped hooks document that suppresses cursor's native fan-out. */
export function buildCursorHooksConfig(): string {
  // `printf '%s' '<json>'` — the JSON is DATA, never printf's format string. As a
  // format it would be corrupted by a `%` in the message and made syntactically
  // invalid by a `"`, `\`, or tab, and while `failClosed` turns invalid JSON into a
  // block rather than a bypass, the operator would see a hook malfunction instead
  // of MUON's reason. Single-quoted with `'\''` escaping so no character in the
  // message can end the quote and reach the shell.
  const verdict = JSON.stringify({
    permission: "deny",
    user_message: CURSOR_NATIVE_FAN_OUT_DENIAL_MESSAGE,
  }).replace(/'/g, "'\\''");
  return serializeCursorHooksBoundary({
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: "command",
          // Drains stdin first: hooks are handed JSON on stdin, and a command
          // that exits without reading it can take SIGPIPE and be scored as a
          // hook FAILURE rather than a deny.
          command: `cat >/dev/null; printf '%s' '${verdict}'`,
          matcher: CURSOR_NATIVE_FAN_OUT_MATCHER,
          failClosed: true,
        },
      ],
    },
  });
}

/**
 * The cursor config a governed run gets EVEN WITH NO PROFILE AT ALL.
 *
 * Both documents are written for the same reason, and it is not about the profile:
 * a repo can COMMIT its own `.cursor/cli.json` and `.cursor/hooks.json`, cursor has
 * no `OPENCODE_DISABLE_PROJECT_CONFIG` equivalent, and it resolves both by walking
 * up from cwd. So MUON's write IS the net, and its ABSENCE hands a review worktree
 * to the repo's own policy — an attacker-supplied `allow`, or a `preToolUse` entry
 * that permits the very spawn MUON means to deny.
 *
 * That argument does not weaken when a caller omits the profile, so the writes
 * cannot live only on the profile path. `profile` is optional on both
 * `RunLaneTaskInput` and `LaneRunOptions`, and `compileRunProfile` returns early
 * without it — which left this suppression one omitted field away from silently not
 * existing. This is the same shape codex solved by putting
 * `CODEX_AMBIENT_SUPPRESSION_ARGS` in `taskCommand` rather than in its compiler.
 */
export function cursorMandatoryConfigWrites(): CompiledProfile["configWrites"] {
  return [
    {
      relativePath: CURSOR_PERMISSIONS_RELATIVE_PATH,
      contents: `${JSON.stringify(
        { permissions: { allow: [], deny: [] } },
        null,
        2
      )}\n`,
    },
    ...cursorHookSurfaceWrites(),
  ];
}

/**
 * EVERY hook file cursor reads that MUON can reach, identical on both paths.
 *
 * Shared by `cursorMandatoryConfigWrites` (no profile) and `compileCursorProfile`
 * (profile) because the two were previously two lists that a drift-lock test had
 * to keep married — and TODO 1.15 caught them apart, in the direction that
 * mattered: the claude paths were added to the mandatory list and the compiler
 * kept writing only `.cursor/hooks.json`, so every run WITH a profile — which is
 * every real dispatch — still handed the repo its own claude hooks. A test would
 * have found that; not being able to express it is better.
 *
 * `.cursor/cli.json` is deliberately NOT here: it is the one write whose contents
 * legitimately DIFFER between the two paths (the profile's allow/deny table
 * versus an empty one), and folding it in would mean inventing a shared value
 * that neither caller wants.
 */
function cursorHookSurfaceWrites(): CompiledProfile["configWrites"] {
  return [
    {
      relativePath: CURSOR_HOOKS_RELATIVE_PATH,
      contents: buildCursorHooksConfig(),
    },
    // TODO 1.15: cursor's hook net is SEVEN files, not one, and three of them are
    // claude's. These two are the reachable ones — the third is user-global. See
    // `CLAUDE_SETTINGS_RELATIVE_PATH` for the measurement.
    {
      relativePath: CLAUDE_SETTINGS_RELATIVE_PATH,
      contents: buildNeutralClaudeSettings(),
    },
    {
      relativePath: CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH,
      contents: buildNeutralClaudeSettings(),
    },
  ];
}

/**
 * The part of cursor's hook surface MUON cannot close, as a value a caller can
 * render — the residue named rather than left in a comment.
 *
 * Returns the user-global claude settings path when it currently declares hooks
 * that cursor's mapping table would replay, and `null` when it does not. A
 * governed cursor run inherits these: they are outside the workspace, so the
 * run-scoped write cannot reach them, and the only lever that would move the path
 * is `$HOME` — which is also where cursor keeps its credentials, so redirecting it
 * trades a hook leak for a broken lane.
 *
 * This is not hypothetical on the machine it was found on. `~/.claude/settings.json`
 * carried nine hook families, and the handlers were hardcoded to the WRONG vendor
 * (`git-ai checkpoint claude --hook-input stdin`, `SUPERSET_AGENT_ID=claude`), so a
 * governed CURSOR review was writing git checkpoints attributed to CLAUDE — which
 * is TODO 1.15's "mislabels session identity", measured. Cursor also exports
 * `CLAUDE_PROJECT_DIR` on every hook exec, so a handler that sniffs its
 * environment instead of trusting its argv agrees with the wrong answer.
 *
 * `readFileSync` rather than a cached probe: this is read at preflight, once per
 * run at most, and a stale answer about who is executing inside a governed review
 * is worse than a slow one.
 */
export function cursorForeignHookExposure(
  homeDir: string,
  readFile: (path: string) => string
): { path: string; events: readonly string[] } | null {
  const target = `${homeDir}/.claude/settings.json`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(target));
  } catch {
    // Absent, unreadable, or malformed all mean the same thing here: nothing to
    // report. Cursor's own loader treats a parse failure as "no hooks" too.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return null;
  // Only the events cursor actually MAPS. `PermissionRequest` and `Notification`
  // are in claude's vocabulary and map to null in cursor's table, so listing them
  // would overstate the exposure in the one place an operator reads to size it.
  const events = Object.keys(hooks).filter((event) =>
    CURSOR_REPLAYED_CLAUDE_HOOK_EVENTS.includes(event)
  );
  return events.length > 0 ? { path: target, events } : null;
}

/**
 * Claude hook events cursor maps onto its own, read off the 2026.07.23-e383d2b
 * mapping table. `PermissionRequest` and `Notification` are deliberately ABSENT:
 * they exist in claude's vocabulary and cursor maps both to null, so a hook
 * declared under either is inert on a cursor run.
 */
export const CURSOR_REPLAYED_CLAUDE_HOOK_EVENTS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
];

/**
 * Compile to `cursor-agent` flags plus run-scoped `.cursor/` config fragments.
 */
export function compileCursorProfile(profile: LaneProfile): CompiledProfile {
  assertUniqueMcpServerNames(profile.mcpServers);
  const args: string[] = [];
  const configWrites: CompiledProfile["configWrites"] = [];
  const unsupported: string[] = [];

  {
    const resolved = resolveCompiledModel(profile.model);
    if (resolved.kind === "emit") {
      args.push("--model", resolved.model);
    } else if (resolved.kind === "refuse") {
      unsupported.push("guarded cursor model value rejected");
    }
  }
  if (profile.permissionMode === "full-auto") {
    args.push("--force");
  }
  if (profile.sandbox) {
    args.push(
      "--sandbox",
      profile.sandbox === "full-access" ? "disabled" : "enabled"
    );
    if (profile.sandbox === "read-only") {
      unsupported.push("sandbox=read-only (cursor supports enabled/disabled)");
    }
  }
  // TODO 2.5: Cursor's agent CLI accepts repeating `--add-dir <path>`
  // (verified `cursor-agent 2026.07.23-e383d2b --help`). `--workspace` remains
  // the single primary root MUON sets at launch; addDirs are extra roots.
  // Emit the `--add-dir=<path>` form so a later widening-flag strip cannot leave
  // an orphaned `--add-dir` that eats the next token as a path (and spills the
  // rest into the prompt — Cursor reads bare positionals as prompt text).
  // Flag-shaped / guarded values are refused to unsupported, never dropped
  // silently (same honesty class as the guarded model branch above).
  for (const dir of profile.addDirs) {
    const trimmed = dir.trim();
    const safe =
      trimmed.length > 0 &&
      !trimmed.startsWith("-") &&
      sanitizeGuardedArgs([trimmed]).removed.length === 0;
    if (safe) {
      args.push(`--add-dir=${trimmed}`);
    } else {
      unsupported.push(`guarded cursor addDirs value rejected: ${dir}`);
    }
  }
  {
    // `.cursor/cli.json` — NOT `.cursor/permissions.json`. Cursor resolves
    // project permissions from `<dir>/.cursor/cli.json` walked up the ancestor
    // chain from cwd (plus the global `G()/permissions.json`); a project-level
    // `permissions.json` is read by NOTHING, so the old filename silently
    // disarmed every deny MUON wrote. Proven with real turns on
    // `cursor-agent 2026.07.23-e383d2b` (2026-07-31, isolated fixtures):
    // an `allow` in the project cli.json executes a command the global config
    // never granted; `deny` beats `allow` AND survives `--force`; print mode
    // without an allow fails closed. Key shape confirmed:
    // top-level `permissions: { allow: [], deny: [] }`.
    //
    // WRITTEN UNCONDITIONALLY, even for an empty profile. Now that this file is
    // the one Cursor actually honours, its ABSENCE is load-bearing: a review
    // worktree whose repo checked in its own `.cursor/cli.json` would run under
    // THAT policy (an attacker-supplied allow) if MUON wrote nothing. Cursor
    // has no `OPENCODE_DISABLE_PROJECT_CONFIG` equivalent, so the write IS the
    // net — `{allow:[],deny:[]}` is a meaningful deny-nothing/allow-nothing
    // posture that clobbers the hostile file. `base-lane-adapter` overwrites
    // the path, so the checked-in document never survives the run.
    configWrites.push({
      relativePath: CURSOR_PERMISSIONS_RELATIVE_PATH,
      contents: `${JSON.stringify(
        { permissions: { allow: profile.allowedTools, deny: profile.deniedTools } },
        null,
        2
      )}\n`,
    });
  }
  // TODO 1.16: the fan-out hook, at the COMPILER and unconditionally — never left
  // to a caller's `deniedTools`, because a lane profile is operator-authored data
  // and a suppression that holds only when someone remembers to type it is not a
  // suppression.
  //
  // TODO 1.15: and not the fan-out hook ALONE. `cursorHookSurfaceWrites` is the
  // whole reachable hook surface, shared verbatim with the no-profile path, so
  // the two can no longer disagree about which files a governed cursor run owns.
  configWrites.push(...cursorHookSurfaceWrites());
  if (profile.mcpServers.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of profile.mcpServers) {
      mcpServers[server.name] = server.command
        ? {
            command: server.command,
            args: server.args,
            // Env by NAME only ("${env:VAR}"), no secret value is written into
            // the workspace file; the value travels via the child env (S2).
            ...(Object.keys(server.env).length > 0
              ? { env: referenceEnv(server.env, (name) => `\${env:${name}}`) }
              : {}),
          }
        : { url: server.url };
    }
    configWrites.push({
      relativePath: ".cursor/mcp.json",
      contents: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    });
    // TODO 1.12: NO `--approve-mcps` here. Writing the file is not enough — a
    // PROJECT-scoped server loads only once approved (measured on cursor-agent
    // 2026.07.23: a freshly written `.cursor/mcp.json` reports `muon: not loaded
    // (needs approval)`, while the same entry in `~/.cursor/mcp.json` loads
    // untouched) — but `--approve-mcps` is a BLANKET approval and is stripped as
    // widening from every source including this compiler, so emitting it here
    // produced a flag that could never survive and a brain that never attached.
    // The replacement is targeted and lives in the LANE, next to the run that
    // needs it: `cursor-agent mcp enable <name>`, for MUON's own governed server
    // only. See `CursorAdapter.approveGovernedMcpServer`.
  }
  if (Object.keys(profile.rawConfig).length > 0) {
    configWrites.push({
      relativePath: ".cursor/muon-raw-config.json",
      contents: `${JSON.stringify(profile.rawConfig, null, 2)}\n`,
    });
  }
  args.push(...profile.extraArgs);

  return {
    args,
    // MCP env values (incl. MUON_API_TOKEN) travel via the child env, not the
    // workspace file (S2).
    env: { ...profile.env, ...hoistMcpServerEnv(profile.mcpServers) },
    configWrites,
    unsupported,
  };
}

/**
 * WAVE C5: routed by the registry's `execution.compiler` rather than by the lane
 * id. The mapping is byte-identical for every registered vendor — the point is
 * that a NEW vendor now has to name its compiler in its registry entry instead
 * of silently landing in the degrade below (ADR-0022 G11).
 */
export function compileProfileForLane(
  laneId: string,
  profile: LaneProfile
): CompiledProfile {
  switch (isVendorId(laneId) ? VENDOR_REGISTRY[laneId].execution.compiler : null) {
    case "claude":
      return compileClaudeProfile(profile);
    case "codex":
      return compileCodexProfile(profile);
    case "opencode":
      return compileOpencodeProfile(profile);
    case "cursor":
      return compileCursorProfile(profile);
    // `passthrough` shares the unregistered-lane degrade DELIBERATELY. The only
    // vendor that declares it is the dev/test fake, which has no argv to compile
    // and never spawns a binary, so "typed profile fields ignored" is the true
    // and unchanged answer for it. Kept as a fallthrough rather than a copy so
    // the two can never diverge.
    case "passthrough":
    default:
      return {
        args: [...profile.extraArgs],
        env: { ...profile.env },
        configWrites: [],
        unsupported: ["unknown lane: typed profile fields ignored"],
      };
  }
}
