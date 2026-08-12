import { z } from "zod";
import {
  laneProfileSchema,
  type LaneProfile,
  type PermissionMode,
  type SandboxMode,
} from "./lane-profile.js";

/**
 * ROLE ASSIGNMENT (VISION §2, §4): MUON — not the vendor — decides what each
 * participating agent is FOR. A role is the crew-level answer to "who does
 * what", and it is enforced as a NARROWING of the lane profile, never a
 * widening.
 *
 * The bounded-surface rule that governs every other MUON authority surface
 * applies here in full: assigning a role may only remove tools, tighten the
 * sandbox, and lower the permission mode. There is no field on a role that can
 * grant an agent something its lane profile did not already have. A reviewer
 * that is handed a `full-auto` profile becomes a read-only reviewer; it never
 * becomes a writer because someone named it one.
 */
export const agentRoleSchema = z.enum([
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
  "qa",
  "scout",
  "docs",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const AGENT_ROLES = agentRoleSchema.options;

/**
 * What a role is allowed to DO with the workspace:
 * - `coordinate` — plans and dispatches; the existing bounded ORCHESTRATOR
 *   grant remains the authority backstop and this module does not touch it.
 * - `write` — may mutate its own governed worktree.
 * - `read-only` — may read and may run checks, but every write-class tool is
 *   denied and the vendor sandbox is forced read-only.
 */
export const roleAuthoritySchema = z.enum(["coordinate", "write", "read-only"]);
export type RoleAuthority = z.infer<typeof roleAuthoritySchema>;

/**
 * Write-class NATIVE tool names across the vendor vocabularies MUON drives
 * (Claude Code, Codex, Cursor). Matching is case-insensitive and exact: a
 * prefix rule would silently deny read tools that merely start with the same
 * letters, and a wildcard would be impossible to audit. Extend this list when a
 * vendor adds a write verb — an unknown tool is NOT assumed safe for read-only
 * roles, see `isWriteClassTool`.
 *
 * CASING IS LOAD-BEARING. These strings are not only compared (comparison
 * lowercases both sides in `isWriteClassTool`) — a read-only role also unions
 * them verbatim into `deniedTools`, which the compilers emit onto real vendor
 * argv (`claude --disallowedTools …`, cursor's permissions file). An all-
 * lowercase list produced an argv of 20 inert names that matched nothing in
 * Claude's vocabulary, leaving the sandbox clamp as the only actual enforcement.
 * So the canonical vendor spelling is what is stored, and the aliases below it
 * cover the other vocabularies.
 */
export const WRITE_CLASS_TOOL_NAMES = [
  // Claude Code's canonical spellings — these must survive verbatim to argv.
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "applypatch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "create_file",
  "createfile",
  "delete_file",
  "deletefile",
  "move_file",
  "movefile",
  "patch",
  "write_file",
  "writefile",
  "edit_file",
  "editfile",
  "update_file",
  "updatefile",
] as const;

/**
 * Comparison set. Lowercased ONCE here so `isWriteClassTool` stays
 * case-insensitive even though the exported list carries vendor casing.
 */
const WRITE_CLASS_TOOL_SET = new Set<string>(
  WRITE_CLASS_TOOL_NAMES.map((name) => name.toLowerCase())
);

/**
 * MUON's own governed write tools. These are NOT native filesystem writes —
 * they are ledger-backed, gated MCP calls — so a read-only role keeps the ones
 * that only propose (`memory_add` lands UNCONFIRMED and still faces the
 * confirmed-only gate) and loses the ones that mutate durable state.
 */
const GOVERNED_MUTATION_TOOL_NAMES = new Set<string>([
  "memory_delete",
  "memory_clone",
]);

/**
 * A tool is write-class when it is a known write verb OR a vendor-namespaced
 * variant of one (`mcp__fs__write_file`, `Bash(rm:*)`-style specifiers are left
 * to the sandbox, which a read-only role forces to `read-only` anyway).
 */
export function isWriteClassTool(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // Strip a tool-specifier suffix, `Write(src/**)` → `write`.
  const bare = normalized.split("(")[0]!.trim();
  if (WRITE_CLASS_TOOL_SET.has(bare) || GOVERNED_MUTATION_TOOL_NAMES.has(bare)) {
    return true;
  }
  // Namespaced MCP form: `mcp__server__write_file`, `mcp__muon__memory_delete`
  // — judge the last segment against BOTH sets. Checking only the bare name
  // here would flag `memory_delete` but wave through `mcp__muon__memory_delete`,
  // and profiles in practice carry the namespaced form.
  const segments = bare.split("__").filter(Boolean);
  const last = segments[segments.length - 1];
  if (
    last &&
    last !== bare &&
    (WRITE_CLASS_TOOL_SET.has(last) || GOVERNED_MUTATION_TOOL_NAMES.has(last))
  ) {
    return true;
  }
  return false;
}

/**
 * Vendor CLI flags that widen authority. A read-only role strips these from
 * `extraArgs` so a preset, harness, or vendor-native fragment cannot smuggle
 * write authority past the role narrowing. Values that follow a flag are
 * dropped with it (`--sandbox danger-full-access`).
 */
const AUTHORITY_WIDENING_FLAGS = new Set<string>([
  "--force",
  "-f",
  "--yolo",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--auto-edits",
  "--accept-edits",
  "--bypass-permissions",
  "--approve-mcps",
  "--auto-review",
]);

/**
 * Flags that take a VALUE, where the value decides whether the invocation
 * widens or tightens. These must be judged by value, never by name.
 *
 * Dropping them by name was a monotonicity INVERSION: Claude's `plan` vendor
 * action is `--permission-mode plan`, its TIGHTEST mode, and it arrives through
 * `extraArgs`. Stripping it left the compiler to emit the role's ceiling
 * (`default`) instead — so naming a job `reviewer` made it strictly LESS
 * restricted than the same job with no role at all, inside a function whose
 * contract is "never widened".
 *
 * The values below are the vendor-native spellings that are at least as tight as
 * any read-only role's ceiling, so keeping them can only narrow. Every other
 * value — including one we do not recognize — is dropped, which fails closed.
 * `packages/adapters/src/cursor-adapter.ts` already had this value-aware shape;
 * this is the general version of it.
 */
const TIGHTENING_FLAG_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [
    ["--sandbox", new Set(["read-only"])],
    ["--permission-mode", new Set(["plan"])],
    ["--ask-for-approval", new Set(["untrusted"])],
    ["-a", new Set(["untrusted"])],
  ]
);

/**
 * Codex's config channel. `-c key=value` is EXACTLY equivalent to a `rawConfig`
 * entry — `compileCodexProfile` compiles one into the other — so filtering
 * `rawConfig` by key while waving `-c` through left the same authority reachable
 * by its other spelling. That was a live defeat of this module's own guarantee:
 * `extraArgs: ["-c", 'sandbox_mode="danger-full-access"']` survived narrowing
 * AND passed the launch assertion, putting `sandbox_mode="read-only"` and
 * `sandbox_mode="danger-full-access"` on one reviewer's argv.
 */
const CONFIG_CHANNEL_FLAGS = new Set<string>(["-c", "--config"]);

/**
 * Vendor-native config keys that re-open the sandbox or approval posture.
 * Stripped from `rawConfig` for read-only roles for the same reason as the
 * flags above: `rawConfig` is an intentional passthrough, so the narrowing has
 * to cover it or the surface is not bounded.
 */
const AUTHORITY_WIDENING_CONFIG_KEYS = new Set<string>([
  "sandbox_mode",
  "sandbox",
  "approval_policy",
  "ask_for_approval",
  "permission_mode",
  "permissionmode",
  "bypass_approvals",
  "bypasspermissions",
  "dangerously_skip_permissions",
  "trust_level",
]);

function configKeyIsWidening(key: string): boolean {
  const leaf = key.split(".").pop() ?? key;
  return AUTHORITY_WIDENING_CONFIG_KEYS.has(leaf.trim().toLowerCase());
}

/**
 * ONE argv vocabulary, shared by the strip and the assert.
 *
 * `narrowProfileForRole` removes what this marks, and `assertProfileMatchesRole`
 * refuses on what this marks — reading the SAME classifier. When the two kept
 * separate copies of the rules, the assert's copy was the weaker one and the
 * launch backstop silently passed a profile the narrowing had failed to clean.
 * (The same producer/validator drift broke delegate launches earlier the same
 * day; enumerate once, consume twice.)
 *
 * Returns, for the token at `index`: how many tokens it spans, and whether it
 * widens authority.
 */
function classifyArg(
  args: readonly string[],
  index: number
): { span: number; widening: boolean } {
  const arg = args[index] ?? "";
  const [head = "", ...rest] = arg.split("=");
  const bare = head.trim().toLowerCase();
  const inlineValue = rest.length > 0 ? rest.join("=") : undefined;

  if (AUTHORITY_WIDENING_FLAGS.has(bare)) {
    return { span: 1, widening: true };
  }

  // Codex's `-c key=value` config channel — the other spelling of rawConfig.
  if (CONFIG_CHANNEL_FLAGS.has(bare)) {
    const payload = inlineValue ?? args[index + 1];
    const span = inlineValue === undefined ? 2 : 1;
    if (payload === undefined) {
      return { span, widening: false };
    }
    const configKey = payload.split("=")[0] ?? payload;
    return { span, widening: configKeyIsWidening(configKey) };
  }

  const tightening = TIGHTENING_FLAG_VALUES.get(bare);
  if (tightening) {
    const value = (inlineValue ?? args[index + 1] ?? "").trim().toLowerCase();
    const span = inlineValue === undefined ? 2 : 1;
    // Keep ONLY a recognized tightening value; an unrecognized one is treated
    // as widening, which fails closed.
    return { span, widening: !tightening.has(value.replace(/^["']|["']$/g, "")) };
  }

  return { span: 1, widening: false };
}

/** Every authority-widening token in `args`, using the shared classifier. */
function wideningArgs(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; ) {
    const { span, widening } = classifyArg(args, index);
    if (widening) {
      found.push(...args.slice(index, index + span));
    }
    index += span;
  }
  return found;
}

/**
 * Permission modes ordered from tightest to widest. A role declares the widest
 * mode it tolerates; `narrowProfileForRole` clamps down to it and never up.
 */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  strict: 0,
  default: 1,
  "auto-edits": 2,
  "full-auto": 3,
};

/** Sandbox modes ordered from tightest to widest, same clamping contract. */
const SANDBOX_MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "full-access": 2,
};

export type RoleSpec = {
  readonly role: AgentRole;
  readonly authority: RoleAuthority;
  /** Human-facing one-liner shown in the crew UI and routing reasons. */
  readonly summary: string;
  /** Lane capabilities a vendor MUST have to hold this role at all. */
  readonly requiredCapabilities: readonly (
    | "canStreamEvents"
    | "canInterrupt"
    | "canBackground"
    | "supportsApprovals"
    | "supportsWorktrees"
  )[];
  /** Widest sandbox this role tolerates. */
  readonly maxSandbox: SandboxMode;
  /** Widest permission mode this role tolerates. */
  readonly maxPermissionMode: PermissionMode;
  /** Whether the role may hold write-class native tools. */
  readonly allowsWriteTools: boolean;
  /** Default harness key when the crew planner has no better opinion. */
  readonly defaultHarnessKey?: string;
};

export const ROLE_SPECS: Readonly<Record<AgentRole, RoleSpec>> = Object.freeze({
  orchestrator: {
    role: "orchestrator",
    authority: "coordinate",
    summary: "Plans the mission, assigns roles, dispatches and reconciles the crew.",
    // A coordinator must be able to run in the background and be interrupted;
    // it is the seat the human panics-stops.
    requiredCapabilities: ["canStreamEvents", "canInterrupt", "canBackground"],
    maxSandbox: "workspace-write",
    maxPermissionMode: "default",
    allowsWriteTools: true,
  },
  architect: {
    role: "architect",
    authority: "read-only",
    summary: "Reads the graph and proposes the design; produces plans, not patches.",
    requiredCapabilities: ["canStreamEvents"],
    maxSandbox: "read-only",
    maxPermissionMode: "default",
    allowsWriteTools: false,
  },
  implementer: {
    role: "implementer",
    authority: "write",
    summary: "Makes the change in its own governed worktree.",
    requiredCapabilities: ["canStreamEvents", "supportsWorktrees"],
    maxSandbox: "workspace-write",
    maxPermissionMode: "auto-edits",
    allowsWriteTools: true,
  },
  reviewer: {
    role: "reviewer",
    authority: "read-only",
    summary: "Second opinion on someone else's diff; returns a verdict, never a patch.",
    requiredCapabilities: ["canStreamEvents"],
    maxSandbox: "read-only",
    maxPermissionMode: "default",
    allowsWriteTools: false,
  },
  qa: {
    role: "qa",
    authority: "read-only",
    summary: "Runs the checks and reports what actually failed.",
    requiredCapabilities: ["canStreamEvents"],
    maxSandbox: "read-only",
    maxPermissionMode: "default",
    allowsWriteTools: false,
  },
  scout: {
    role: "scout",
    authority: "read-only",
    summary: "Cheap reconnaissance: locates code, summarizes, answers bounded questions.",
    requiredCapabilities: [],
    maxSandbox: "read-only",
    maxPermissionMode: "strict",
    allowsWriteTools: false,
  },
  docs: {
    role: "docs",
    authority: "write",
    summary: "Writes and repairs documentation alongside a change.",
    requiredCapabilities: ["canStreamEvents"],
    maxSandbox: "workspace-write",
    maxPermissionMode: "auto-edits",
    allowsWriteTools: true,
  },
});

export function roleSpec(role: AgentRole): RoleSpec {
  return ROLE_SPECS[role];
}

export function isReadOnlyRole(role: AgentRole): boolean {
  return ROLE_SPECS[role].authority === "read-only";
}

/** Raised when a compiled profile is wider than the role it claims to run as. */
export class RoleAuthorityError extends Error {
  readonly role: AgentRole;
  readonly violations: string[];

  constructor(role: AgentRole, violations: string[]) {
    super(
      `Lane profile exceeds the authority of role '${role}': ${violations.join("; ")}`
    );
    this.name = "RoleAuthorityError";
    this.role = role;
    this.violations = violations;
  }
}

/**
 * An UNSET mode stays UNSET. Defaulting it to the role's ceiling would WIDEN
 * the profile, which is exactly what this module promises never to do:
 * `implementer`'s ceiling is `auto-edits`, so an unset profile would silently
 * acquire accept-edits authority its author never asked for. Unset means "the
 * vendor/harness default decides", which is the pre-role behavior and is by
 * definition no wider than what the caller already had.
 */
function clampPermissionMode(
  mode: PermissionMode | undefined,
  max: PermissionMode
): PermissionMode | undefined {
  if (!mode) {
    return undefined;
  }
  return PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[max] ? mode : max;
}

/**
 * Same rule, with ONE deliberate exception: a read-only role forces
 * `read-only` even when the sandbox was unset. That is sound because
 * `read-only` is the MINIMUM of the sandbox lattice — forcing the tightest
 * possible value can only narrow — and it is necessary, because the read-only
 * sandbox is the enforcement that makes a reviewer a reviewer rather than a
 * writer wearing a label.
 */
function clampSandbox(
  mode: SandboxMode | undefined,
  max: SandboxMode
): SandboxMode | undefined {
  if (!mode) {
    return max === "read-only" ? "read-only" : undefined;
  }
  return SANDBOX_MODE_RANK[mode] <= SANDBOX_MODE_RANK[max] ? mode : max;
}

function stripWideningArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; ) {
    const { span, widening } = classifyArg(args, index);
    if (!widening) {
      kept.push(...args.slice(index, index + span));
    }
    index += span;
  }
  return kept;
}

function stripWideningConfig(
  rawConfig: Record<string, unknown>
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (configKeyIsWidening(key)) {
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

/**
 * The ONLY MCP server a read-only role keeps.
 *
 * An MCP server is a tool surface, and `deniedTools` is not a reliable brake on
 * it. `compileCodexProfile` now does compile MCP-namespaced denials into
 * codex's per-server `disabled_tools`, but that reaches only the servers it is
 * told about; codex has no deny table for its OWN shell/patch tools, so there
 * the sandbox remains the sole enforcement — and the sandbox does not govern a
 * stdio MCP server codex spawns. A profile carrying, say, a filesystem MCP
 * server would still hand a "read-only" reviewer an unbounded `write_file`.
 * Dropping the server is what holds; a deny list is defence in depth.
 *
 * MUON's own governed server stays because it is the brain: memory, graph, and
 * the coordination tools, all individually gated server-side. Everything else is
 * dropped for a read-only role.
 *
 * Must equal `MUON_MCP_SERVER_NAME` in `@muon/core`; protocol cannot import core
 * (core depends on protocol), so a test in core asserts the two agree.
 */
export const GOVERNED_MCP_SERVER_NAME = "muon";

/**
 * Narrow a lane profile to the authority its role permits.
 *
 * Contract (asserted by tests, relied on by the runner):
 * - MONOTONE — the result's allowedTools is a subset of the input's; sandbox and
 *   permission mode are never widened; deniedTools only grows; mcpServers is a
 *   subset.
 * - IDEMPOTENT — `narrow(narrow(p, r), r)` deep-equals `narrow(p, r)`.
 * - COVERS EVERY AUTHORITY FIELD, enumerated rather than claimed:
 *   `permissionMode`, `sandbox`, `allowedTools`, `deniedTools`, `extraArgs`
 *   (including codex's `-c key=value` config channel, which is `rawConfig` by
 *   another spelling), `rawConfig`, and `mcpServers`.
 *   Deliberately NOT narrowed, because none of them grants write authority:
 *   `model` (which model, not what it may do), `contextFiles` (read-only
 *   context), `addDirs` (widens what is READABLE; a read-only role's sandbox
 *   still forbids writing there), and `env` (the credential channel — stripping
 *   it would break vendor auth, and the sandboxed-runner env allowlist is what
 *   bounds it). An earlier version of this comment claimed to be "TOTAL" over
 *   passthrough surfaces while `mcpServers` and the `-c` channel were both
 *   uncovered; enumerate what is true instead of asserting completeness.
 */
export function narrowProfileForRole(
  profile: LaneProfile,
  role: AgentRole
): LaneProfile {
  const spec = ROLE_SPECS[role];
  const parsed = laneProfileSchema.parse(profile);

  const permissionMode = clampPermissionMode(
    parsed.permissionMode,
    spec.maxPermissionMode
  );
  const sandbox = clampSandbox(parsed.sandbox, spec.maxSandbox);

  if (spec.allowsWriteTools) {
    return laneProfileSchema.parse({
      ...parsed,
      permissionMode,
      sandbox,
    });
  }

  const allowedTools = parsed.allowedTools.filter(
    (tool) => !isWriteClassTool(tool)
  );
  const deniedTools = Array.from(
    new Set([
      ...parsed.deniedTools,
      ...parsed.allowedTools.filter((tool) => isWriteClassTool(tool)),
      ...WRITE_CLASS_TOOL_NAMES,
    ])
  );

  return laneProfileSchema.parse({
    ...parsed,
    permissionMode,
    sandbox,
    allowedTools,
    deniedTools,
    extraArgs: stripWideningArgs(parsed.extraArgs),
    rawConfig: stripWideningConfig(parsed.rawConfig),
    mcpServers: parsed.mcpServers.filter(
      (server) => server.name === GOVERNED_MCP_SERVER_NAME
    ),
  });
}

/**
 * Fail-closed launch assertion. The runner calls this immediately before
 * spawning a role-bound vendor child: if anything between assignment and launch
 * re-widened the profile (a preset merge, a harness overlay, a vendor-native
 * fragment), we refuse to launch rather than run a "reviewer" that can write.
 */
export function assertProfileMatchesRole(
  profile: LaneProfile,
  role: AgentRole
): void {
  const spec = ROLE_SPECS[role];
  const parsed = laneProfileSchema.parse(profile);
  const violations: string[] = [];

  if (
    parsed.permissionMode &&
    PERMISSION_MODE_RANK[parsed.permissionMode] >
      PERMISSION_MODE_RANK[spec.maxPermissionMode]
  ) {
    violations.push(
      `permissionMode '${parsed.permissionMode}' exceeds '${spec.maxPermissionMode}'`
    );
  }
  if (
    parsed.sandbox &&
    SANDBOX_MODE_RANK[parsed.sandbox] > SANDBOX_MODE_RANK[spec.maxSandbox]
  ) {
    violations.push(`sandbox '${parsed.sandbox}' exceeds '${spec.maxSandbox}'`);
  }
  if (!spec.allowsWriteTools) {
    const writeTools = parsed.allowedTools.filter(isWriteClassTool);
    if (writeTools.length > 0) {
      violations.push(`write-class tools allowed: ${writeTools.join(", ")}`);
    }
    // Same classifier the narrowing uses — see `classifyArg`. Two copies of
    // these rules is exactly how the assert became the weaker one before.
    const offendingArgs = wideningArgs(parsed.extraArgs);
    if (offendingArgs.length > 0) {
      violations.push(`authority-widening args: ${offendingArgs.join(" ")}`);
    }
    const wideningKeys = Object.keys(parsed.rawConfig).filter(configKeyIsWidening);
    if (wideningKeys.length > 0) {
      violations.push(`authority-widening config: ${wideningKeys.join(", ")}`);
    }
    const foreignServers = parsed.mcpServers
      .filter((server) => server.name !== GOVERNED_MCP_SERVER_NAME)
      .map((server) => server.name);
    if (foreignServers.length > 0) {
      // An MCP server is a tool surface the sandbox does not reach and codex
      // ignores `deniedTools` for entirely, so a foreign server is a write
      // surface a read-only role must not carry.
      violations.push(`non-governed MCP servers: ${foreignServers.join(", ")}`);
    }
  }

  if (violations.length > 0) {
    throw new RoleAuthorityError(role, violations);
  }
}

/**
 * A role binding is MUON's answer to "who is this agent, and what is it for".
 * `assignedBy` records whether the human or the orchestrator made the call, so
 * the crew view can show provenance rather than an anonymous label.
 */
export const roleBindingSchema = z.object({
  vendor: z.string().min(1).max(64),
  role: agentRoleSchema,
  /** Deterministic 0..1 fit score from the assignment engine. */
  fit: z.number().min(0).max(1),
  /** Human-readable justification, safe to render verbatim. */
  reason: z.string().min(1).max(400),
  assignedBy: z.enum(["human", "muon"]).default("muon"),
  /** Present when the lane cannot currently hold the role it was assigned. */
  blocked: z.boolean().default(false),
  blockedReason: z.string().max(400).optional(),
});
export type RoleBinding = z.infer<typeof roleBindingSchema>;

export const crewRolePlanSchema = z.object({
  version: z.literal(1),
  chatId: z.string().min(1),
  bindings: z.array(roleBindingSchema).max(32),
  /** Roles the mission wanted but no available lane could hold. */
  unfilled: z.array(agentRoleSchema).max(8).default([]),
});
export type CrewRolePlan = z.infer<typeof crewRolePlanSchema>;
