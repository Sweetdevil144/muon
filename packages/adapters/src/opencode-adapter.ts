import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GOVERNED_MCP_SERVER_NAME,
  isReadOnlyRole,
  type AgentRole,
  type LaneCapabilities,
  type LaneEvent,
  type LaneHealth,
  type LaneProfile,
  type LaneSessionInput,
  type LaneTaskSubmission,
  type McpServerConfig,
} from "@muon/protocol";
import {
  BaseLaneAdapter,
  type LaneRunOptions,
  type LaneTaskContext,
} from "./base-lane-adapter.js";
import type { LaneCommandResult } from "./lane-runner.js";
import { assertUniqueMcpServerNames } from "./mcp-server-validation.js";
import { probeVendorReadiness } from "./vendor-readiness.js";

/**
 * MANAGED READ-ONLY OPENCODE (`opencode` 1.18.5).
 *
 * OpenCode replaced the Ollama lane. It is a genuine agent CLI with a
 * non-interactive `run` mode, so on paper it looked like an easier integration
 * than Cursor. LIVE PROBING SAID OTHERWISE, and the whole shape of this file is
 * a consequence of what the probe found. Every claim below was verified against
 * the installed binary with `opencode debug config` / `opencode debug agent`,
 * which resolve configuration WITHOUT spending a model turn.
 *
 * 1. THERE IS NO `--permissions` FLAG. `opencode run --help` lists exactly one
 *    permission-related option, `--auto`, and it WIDENS ("auto-approve
 *    permissions that are not explicitly denied"). Permissions are configurable
 *    only through a config FILE. So unlike Cursor — whose read-only posture is
 *    an argv fact (`--mode plan`) — opencode's posture is a FILE fact, and the
 *    guard has to own that file.
 *
 * 2. THE `plan` AGENT IS NOT READ-ONLY. Measured (1.18.7, 2026-07-31,
 *    `opencode debug agent plan`, operator config isolated out): the resolved
 *    table is `{permission:"*", action:"allow", pattern:"*"}` at POSITION 1 —
 *    `plan` denies NOTHING; only `doom_loop`, `external_directory`, and
 *    `question` differ from allow. (The earlier "edit denied, bash allowed"
 *    reading, and opencode's own docs claiming plan is read-only, are both
 *    wrong.) A `plan` agent shells out freely, and a shell writes files. It is
 *    a planning UX, not a security boundary, and MUON does not treat it as one.
 *
 * 3. DEFAULTS ARE PERMISSIVE. `opencode debug agent build` resolves to
 *    `{permission: "*", action: "allow", pattern: "*"}`. The opposite of MUON's
 *    posture, so nothing here may rely on a default.
 *
 * 4. AMBIENT AND WORKSPACE CONFIG RE-WIDEN. Proven: with a workspace
 *    `opencode.json` containing `{"permission":{"bash":"allow"}}`, launching
 *    with `OPENCODE_CONFIG` pointed at a config that says `{"bash":"deny"}`
 *    resolved to **allow**. Resolution is LAST-SOURCE-WINS, and the workspace is
 *    attacker-controlled input (a repo under review can simply check that file
 *    in). `OPENCODE_DISABLE_PROJECT_CONFIG=1` is what makes MUON's config the
 *    last word; with it set, the same experiment resolves to **deny**. That env
 *    var is therefore LOAD-BEARING, not belt-and-braces.
 *
 * 5. THE USER'S `~/.config/opencode/` SURVIVES BOTH. Even with (4) set and
 *    `OPENCODE_CONFIG` supplied, the ambient user config still merged in — on
 *    the founder's machine that meant a REMOTE MCP server (a hosted URL plus a
 *    bearer token) attached to every run. That is a data-egress vector.
 *    Relocating `XDG_CONFIG_HOME` is the only lever found that removes it.
 *    TODO 1.7 then puts MUON's *own* governed `muon-mcp` back through the
 *    guard config's `mcp` block (opencode schema: key `mcp`, `command` an
 *    array, env key `environment`, values as `{env:VAR}`), so a scout reaches
 *    the brain without re-attaching the operator's ambient servers.
 *
 * So the lane is guarded in THREE independent places, in the same shape as the
 * two Cursor nets and for the same reason — no single net is trusted:
 *   - `buildOpencodeGuardConfig` — deny-first permission table + optional
 *     governed `mcp` block (compile).
 *   - `opencodeGuardEnv`         — the env that makes that table the last word.
 *   - `stripOpencodeWideningArgs`— the categorical argv net (spawn).
 *
 * WHAT IS PROVEN vs INFERRED: the RESOLUTION above is proven — `opencode debug`
 * reports the effective table and MUON's denies win. ENFORCEMENT of a `deny` at
 * tool-call time is INFERRED from that table, not observed, because observing it
 * requires a real model turn. That gap is why this lane's registry ceiling is
 * `["scout"]` and not the wider read-only slice Cursor holds. The brain
 * injection (1.7) matches other read-only lanes: MUON's governed server stays
 * (narrowProfileForRole keeps `muon`); filesystem write stays denied; memory
 * proposals stay unconfirmed; never operator tier.
 */

/** Run-scoped directory (under the run cwd) MUON owns for this lane. */
export const OPENCODE_GUARD_DIR = path.join(".muon", "opencode");

/** The config file MUON writes and points `OPENCODE_CONFIG` at. */
export const OPENCODE_GUARD_CONFIG_FILE = "config.json";

export const OPENCODE_GUARD_CONFIG_PATH = path.join(
  OPENCODE_GUARD_DIR,
  OPENCODE_GUARD_CONFIG_FILE
);

/** The read-only crew roles managed OpenCode may hold. */
export const OPENCODE_READ_ONLY_ROLES = ["scout"] as const satisfies
  readonly AgentRole[];

const OPENCODE_ROLE_SET: ReadonlySet<string> = new Set(OPENCODE_READ_ONLY_ROLES);

/** Shown in health, and the refusal message for any role outside the slice. */
export const OPENCODE_READ_ONLY_SCOPE =
  "Managed for read-only reconnaissance only (scout): MUON runs `opencode run` under a deny-first permission config (bash and edit refused), with the governed MUON brain injected through the guard config's mcp block.";

export const OPENCODE_INSTALL_HINT =
  "Install OpenCode (`curl -fsSL https://opencode.ai/install | bash`).";

/**
 * BYO-auth: MUON never custodies an OpenCode credential, so this is a human
 * action. `opencode auth login` writes the vendor's own `auth.json`, which MUON
 * neither reads nor relocates.
 */
export const OPENCODE_AUTH_REQUIRED =
  "OpenCode is not authenticated. Run `opencode auth login`.";

/** Fail-closed text when the auth probe itself could not run. */
export const OPENCODE_AUTH_UNKNOWN =
  "OpenCode authentication could not be confirmed; refusing to report this lane as ready.";

/** Bounded budget for the auth probe: short, it is a status command. */
export const OPENCODE_AUTH_PROBE_TIMEOUT_MS = 2500;

/**
 * The permission tokens a read-only scout may hold, stated POSITIVELY and
 * exhaustively. Every one is a pure reader:
 *   read/glob/grep/list — the reconnaissance itself
 *   lsp                 — read-only code intelligence over the same files
 *   todowrite           — an in-memory task list; writes nothing to disk
 *   `${GOVERNED_MCP_SERVER_NAME}_*` — the governed brain's tools (TODO 1.7).
 *     Measured against opencode 1.18.7: `"*": "deny"` removes MCP tools from
 *     the model's inventory even when the server is connected and spawned —
 *     `mcp list` connectivity ≠ tool availability. A specific
 *     `muon_*: allow` restores the tools while bash/edit stay denied. The
 *     key is derived from `GOVERNED_MCP_SERVER_NAME`, not a literal, and
 *     `narrowOpencodeProfile` keeps only that named server so a hostile
 *     profile cannot mint a matching `muon_x` server to ride the same grant.
 *
 * Deliberately ABSENT (and therefore denied by the wildcard below), each for a
 * stated reason rather than by being forgotten:
 *   bash               — a shell is a write primitive
 *   edit               — the whole point
 *   task               — spawns a sub-agent MUON does not govern
 *   webfetch/websearch — network egress from inside the lane
 *   external_directory — reads outside the workspace MUON handed it
 *   skill              — loads instructions from outside the governed prompt
 *   question           — would block a headless run forever
 *
 * MCP tool authority itself is NOT this table: whatever the brain can do is
 * bounded by `muon-mcp`'s agent tier (never operator; memory proposals stay
 * unconfirmed). This grant only stops the deny-wildcard from erasing them.
 */
export const OPENCODE_ALLOWED_PERMISSIONS = [
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "todowrite",
  `${GOVERNED_MCP_SERVER_NAME}_*`,
] as const;

/**
 * Every permission token MUON DENIES BY NAME, stated positively.
 *
 * WHY THIS LIST EXISTS AND IS NOT DERIVED. A wildcard alone is not enough:
 * opencode resolves permissions by SPECIFICITY FIRST, then by last-wins among
 * equal specificity. Proven live — with MUON's `{"*": "deny"}` sitting at
 * position 26 of the resolved table, the built-in `external_directory: ask`
 * (position 2) and `doom_loop: ask` (position 1) STILL WON, and `question` even
 * resolved to `allow`. A wildcard only catches tokens for which no specific
 * entry exists anywhere in the chain.
 *
 * So the guard needs BOTH halves, and they cover different things:
 *   - the `"*": "deny"` wildcard catches a token that does not exist yet (a
 *     FUTURE opencode release), which no enumeration could name; and
 *   - this list beats the built-in per-token entries that outrank the wildcard.
 *
 * It is written out by hand rather than computed as "all known tokens minus the
 * allowlist", because that subtraction is the exact anti-pattern that has broken
 * this codebase three times: a token added to the known set but forgotten in the
 * allowlist would silently land on the permitted side. Both lists are explicit,
 * and `opencode-adapter.test.ts` asserts they are disjoint and jointly cover
 * every token opencode documents.
 */
export const OPENCODE_DENIED_PERMISSIONS = [
  // Write and execute.
  "edit",
  "bash",
  // Spawns a sub-agent MUON does not govern.
  "task",
  // Network egress from inside the lane.
  "webfetch",
  "websearch",
  // Reads outside the workspace MUON handed it. Built-in default is `ask`.
  "external_directory",
  // Loads instructions from outside the governed prompt.
  "skill",
  // Would block a headless run forever — there is nobody to answer.
  "question",
  // Built-in default is `ask`; same headless problem.
  "doom_loop",
  // Runtime-only tokens observed in the resolved table, not in the published
  // schema. Named so they cannot be the one uncovered field.
  "plan_enter",
  "plan_exit",
] as const;

/**
 * The permission table MUON writes for a managed run.
 *
 * DENY-FIRST BY CONSTRUCTION, IN TWO LAYERS. `"*": "deny"` is the first key, so
 * a permission MUON has never heard of lands on `deny` without anyone having to
 * remember to enumerate it. Then every KNOWN token is stated by name — allow or
 * deny — because opencode resolves by specificity first and a built-in
 * per-token entry outranks the wildcard (see `OPENCODE_DENIED_PERMISSIONS`).
 *
 * This is the `bounded-surface completeness` rule applied twice over: the
 * surface constrains every field, including the ones that do not exist yet AND
 * the ones the vendor already decided for us.
 *
 * Neither list is derived by subtraction from the other — that is the
 * `tier derivation by subtraction` anti-pattern, and a new opencode tool would
 * land on the permitted side of it.
 */
/**
 * Map MUON's profile MCP servers into opencode's config schema (TODO 1.7).
 *
 * Schema differences vs Claude/Cursor, measured live against opencode 1.18.7:
 *   - top-level key is `mcp`, not `mcpServers`
 *   - `command` is an **array** (binary + args), not a string + separate args
 *   - env key is `environment`, not `env`
 *   - values are `{env:VAR}` references; the real values ride the child env
 *     (same S2 posture as other vendors — secrets never land in the config file)
 *
 * HTTP/url servers are refused here: finding 5 exists specifically to keep
 * remote MCP off a governed run. Only local stdio servers are emitted.
 */
export function mcpServersToOpencodeConfig(
  servers: readonly McpServerConfig[]
): Record<string, unknown> {
  assertUniqueMcpServerNames(servers);
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.command) {
      continue;
    }
    const environment = Object.fromEntries(
      Object.keys(server.env).map((name) => [name, `{env:${name}}`])
    );
    mcp[server.name] = {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  }
  return mcp;
}

/**
 * The one permission table, built once and consumed by BOTH levers that carry it
 * (`buildOpencodeGuardConfig` for the config file and inline content;
 * `OPENCODE_PERMISSION` for the top-level last word in `opencodeGuardEnv`).
 *
 * Shared rather than duplicated because the two levers have DIFFERENT precedence
 * and the higher one wins per key: two tables that drifted apart would resolve to
 * the union of the drift, with the weaker lever's denies silently replaced. One
 * builder makes that class of bug unrepresentable.
 */
export function buildOpencodePermissionTable(): Record<string, string> {
  const permission: Record<string, string> = { "*": "deny" };
  for (const token of OPENCODE_DENIED_PERMISSIONS) {
    permission[token] = "deny";
  }
  for (const token of OPENCODE_ALLOWED_PERMISSIONS) {
    permission[token] = "allow";
  }
  return permission;
}

export function buildOpencodeGuardConfig(
  mcpServers: readonly McpServerConfig[] = []
): string {
  const permission = buildOpencodePermissionTable();
  const mcp = mcpServersToOpencodeConfig(mcpServers);
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      permission,
      ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    },
    null,
    2
  )}\n`;
}

/**
 * The environment that makes MUON's config the LAST word. Each entry closes a
 * different re-widening vector proven live (opencode 1.18.7, 2026-07-31):
 *
 *  - `OPENCODE_DISABLE_PROJECT_CONFIG=1` stops the workspace's own
 *    `opencode.json` / `opencode.jsonc` / `.opencode/agent/*.md` from being read
 *    at all. Without it a repo under review re-widens `bash` to `allow` and
 *    MUON's deny is silently discarded (finding 4 in the header).
 *  - `OPENCODE_CONFIG` names MUON's own file explicitly rather than relying on
 *    discovery. It loads BELOW project config, so on its own it loses to an
 *    attacker `opencode.json` — which is why the next entry exists.
 *  - `OPENCODE_CONFIG_CONTENT` (TODO 1.8) carries the SAME deny table INLINE
 *    (and, after TODO 1.7, the governed `mcp` block when the profile asks for
 *    one) and loads ABOVE project config. Measured directly: with a project
 *    `opencode.json` saying `bash:allow` and NO `OPENCODE_DISABLE_PROJECT_CONFIG`,
 *    the inline `bash:deny` still won. So containment no longer rests on the
 *    single disable-project lever — two independent mechanisms now make MUON's
 *    deny the last word, and the file + content merge (file `{*:deny,read:allow}`
 *    ∪ content overrides), verified, rather than one shadowing the other.
 *  - `OPENCODE_PERMISSION` (TODO 1.9) carries the permission half of that same
 *    table as opencode's LAST word. Measured on 1.18.7: with a project
 *    `opencode.json` saying `bash:allow` and an inline `OPENCODE_CONFIG_CONTENT`
 *    saying `bash:deny`, adding `OPENCODE_PERMISSION={"bash":"allow"}` resolved
 *    to **allow** — it outranks BOTH. MUON therefore sets it, because the
 *    alternative is leaving the strongest lever to whoever set it last. Two
 *    properties of it are load-bearing and neither is obvious:
 *      (a) it MERGES per key, so an ambient `{"bash":"allow"}` would flip exactly
 *          one token and leave the other eighteen looking correct — which is why
 *          `lane-guard-env.ts` registers it as a guard key (no child inherits an
 *          ambient value; no other lane's profile may set it);
 *      (b) a malformed value is SILENTLY IGNORED — `OPENCODE_PERMISSION='{not
 *          json'` resolved back to the hostile project config with no error and
 *          exit 0. So this is defence-in-depth on top of the two levers above and
 *          must never become the only one.
 *    It sets TOP-LEVEL permission only: an AGENT-level block still out-ranks it
 *    (measured — a project `.opencode/agent/evil.md` declaring `bash: allow`
 *    resolved to allow at position 1 despite `OPENCODE_PERMISSION` denying it).
 *    That vector is closed by the first entry above, which makes a project-supplied
 *    agent not exist at all ("Agent evil not found"), plus `--agent` being a
 *    stripped widening flag.
 *  - `XDG_CONFIG_HOME` is redirected INTO the run-scoped dir so the operator's
 *    `~/.config/opencode/` — ambient MCP servers, provider overrides — cannot
 *    attach to a governed run (finding 5). It points at a directory that has no
 *    `opencode/` child, which is what neutralizes it. MUON's own `muon` entry
 *    is re-introduced only through the guard config's `mcp` block (1.7).
 *
 * `XDG_DATA_HOME` is deliberately NOT set: that is where `auth.json` lives, and
 * MUON must not break the operator's own login (BYO-auth).
 *
 * ONE vector this env does NOT close, and why `taskCommand` carries `--pure`:
 * a GLOBAL plugin under `~/.opencode/plugin/*.ts` loads even with all four vars
 * above set (measured 2026-07-31 — the operator's `gitnexus-enterprise.ts`
 * attached to a redirected run, because plugin discovery keys on `$HOME`, not
 * `XDG_CONFIG_HOME`). Redirecting `$HOME` would neutralize it but is a blunt
 * instrument that moves auth and much else; `--pure` ("run without external
 * plugins") drops exactly the plugins while leaving the config table and
 * `XDG_DATA_HOME` auth intact (both verified). It is the argv half of the same
 * finding-5 containment, so it lives on the invocation, not here.
 */
export function opencodeGuardEnv(
  cwd: string,
  mcpServers: readonly McpServerConfig[] = []
): Record<string, string> {
  const guardDir = path.resolve(cwd, OPENCODE_GUARD_DIR);
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG: path.join(guardDir, OPENCODE_GUARD_CONFIG_FILE),
    // TODO 1.8 + 1.7: above-project lever — deny table and optional governed mcp.
    OPENCODE_CONFIG_CONTENT: buildOpencodeGuardConfig(mcpServers),
    // TODO 1.9: the last word. Permission only — this channel carries no `mcp`
    // block, so it strengthens the table above without weakening the brain.
    OPENCODE_PERMISSION: JSON.stringify(buildOpencodePermissionTable()),
    XDG_CONFIG_HOME: guardDir,
  };
}

/**
 * OpenCode flags that widen authority or leak the run off-machine. None of them
 * may ever appear on a MUON-managed argv, from ANY source: the invocation, the
 * compiled profile, `extraArgs`, or a per-run argv override.
 *
 *  --auto      auto-approves every permission that is not explicitly denied
 *  --share     publishes the session, i.e. DATA EGRESS
 *  --attach    sends the whole run to a remote opencode server
 *  --agent     selects a different permission table than the one MUON compiled
 *              (`build` is full-access); MUON's own invocation names no agent,
 *              so any occurrence came from a caller
 *  --port/--hostname/--cors/--mdns/--mdns-domain
 *              turn a one-shot into a network listener
 *
 * MUON's own `taskCommand` emits NONE of these, which is what makes the strip
 * unconditional and therefore categorical.
 */
const OPENCODE_WIDENING_FLAGS: ReadonlySet<string> = new Set([
  "--auto",
  "--share",
  "--attach",
  "--agent",
  "--port",
  "--hostname",
  "--cors",
  "--mdns",
  "--mdns-domain",
]);

/**
 * The subset above that takes a VALUE, so the value token is dropped with the
 * flag. Split from the set above because getting it wrong is a REAL bug in both
 * directions, and both directions were hit while writing this:
 *   - listing a boolean flag here eats the next token, which for MUON's argv is
 *     the BRIEF (`--mdns` is `[boolean]` in `opencode --help`, and treating it
 *     as valued silently truncated the prompt);
 *   - omitting a valued flag leaves its value behind as a stray positional, and
 *     opencode reads positionals as the message.
 * Taken from `opencode --help` verbatim: `[string]`/`[number]`/`[array]` take a
 * value, `[boolean]` does not.
 */
const OPENCODE_VALUED_WIDENING_FLAGS: ReadonlySet<string> = new Set([
  "--attach",
  "--agent",
  "--port",
  "--hostname",
  "--cors",
  "--mdns-domain",
]);

/**
 * Strip every authority-widening OpenCode flag from an argv. Categorical by
 * construction: a new path into the argv is covered without a new call site.
 * Mirrors `stripCursorWideningArgs`, deliberately — two vendors, one shape.
 */
export function stripOpencodeWideningArgs(args: readonly string[]): {
  args: string[];
  removed: string[];
} {
  const kept: string[] = [];
  const removed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const bare = arg.split("=")[0]!.trim().toLowerCase();
    if (!OPENCODE_WIDENING_FLAGS.has(bare)) {
      kept.push(arg);
      continue;
    }
    removed.push(arg);
    // Drop the value token with its flag; leaving it behind would become a
    // stray positional, and opencode reads positionals as the message.
    if (!arg.includes("=") && OPENCODE_VALUED_WIDENING_FLAGS.has(bare)) {
      removed.push(args[index + 1] ?? "");
      index += 1;
    }
  }
  return { args: kept, removed };
}

/** Raised when a role outside the read-only slice is pointed at this lane. */
export class OpencodeRoleRefusedError extends Error {
  readonly role: AgentRole;

  constructor(role: AgentRole) {
    super(`OpenCode cannot hold the '${role}' role. ${OPENCODE_READ_ONLY_SCOPE}`);
    this.name = "OpencodeRoleRefusedError";
    this.role = role;
  }
}

/** True when managed OpenCode may hold this role. */
export function opencodeSupportsRole(role: AgentRole): boolean {
  return OPENCODE_ROLE_SET.has(role);
}

/**
 * Fail closed on a NAMED role outside the slice. An UNNAMED role is not a write
 * role, and the invocation itself is unconditionally read-only (deny-first
 * config, widening flags stripped), so an unlabelled run still cannot mutate the
 * workspace — the enforcement is the config and the argv, not the label.
 */
function assertOpencodeRole(role: AgentRole | undefined): void {
  if (role === undefined) {
    return;
  }
  if (!opencodeSupportsRole(role) || !isReadOnlyRole(role)) {
    throw new OpencodeRoleRefusedError(role);
  }
}

/** The crew role a caller is running this lane as, when it knows one. */
type OpencodeRoleInput = { role?: AgentRole };

/**
 * `opencode run --format json` emits raw JSON events, one per line. The exact
 * shape is NOT contractually pinned by the vendor, so `parsed` means only
 * "stdout really was JSON" and `text` is filled in only when a text-bearing
 * field is recognised. We DEGRADE to raw stdout rather than invent a schema: an
 * unknown shape must never become a fabricated reconnaissance answer.
 */
export type OpencodeRunResult = {
  parsed: boolean;
  text?: string;
};

const OPENCODE_TEXT_FIELDS = ["text", "content", "result", "message"] as const;

/** The last text-bearing field across the JSON body (or JSONL stream). */
export function parseOpencodeRunResult(stdout: string): OpencodeRunResult {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") || line.startsWith("["));
  if (lines.length === 0) {
    return { parsed: false };
  }
  let parsed = false;
  let text: string | undefined;
  for (const line of lines) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    parsed = true;
    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const record = candidate as Record<string, unknown>;
      for (const field of OPENCODE_TEXT_FIELDS) {
        const value = record[field];
        if (typeof value === "string" && value.trim().length > 0) {
          text = value;
        }
      }
    }
  }
  return text === undefined ? { parsed } : { parsed, text };
}

/** Injectable seams so the adapter's tests never spawn the real OpenCode CLI. */
export type OpencodeAdapterOptions = {
  /** Resolves whether the installed CLI can authenticate. Never throws. */
  probeAuth?: () => Promise<{ authenticated: boolean }>;
  /** Bounded wall-clock budget for the auth probe. */
  authProbeTimeoutMs?: number;
};

export class OpencodeAdapter extends BaseLaneAdapter {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly provider = "opencode";
  readonly role = "worker" as const;
  readonly commandCandidates = ["opencode"];

  readonly laneCapabilities: LaneCapabilities = {
    // `--format json` emits a machine-readable event stream.
    canStreamEvents: true,
    // An ordinary child process: the runner's AbortSignal terminates it.
    canInterrupt: true,
    // `run` is fully non-interactive, so it can run unattended.
    canBackground: true,
    // No session driver and no approval interpose, so MUON cannot sit in front
    // of an opencode permission prompt. A scout never needs one — and the
    // deny-first config means there is nothing left to prompt ABOUT.
    supportsApprovals: false,
    // MUON worktrees are not wired for this lane, which is the second, capability
    // -level reason `implementer` is unreachable even if the ceiling changed.
    supportsWorktrees: false,
  };

  /** The read-only slice, and nothing wider. */
  readonly supportedRoles: readonly AgentRole[] = OPENCODE_READ_ONLY_ROLES;

  /**
   * Below Cursor's 0.8 on purpose. Removing the Ollama lane already changed
   * which vendor wins `scout`; this entry must not change it a second time, so
   * Cursor stays the preferred scout and OpenCode is the fallback.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>> = { scout: 0.75 };

  private readonly options: OpencodeAdapterOptions;

  constructor(options: OpencodeAdapterOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Three honest states, never two — the same shape as Cursor, for the same
   * reason: a CLI that is installed but signed out would otherwise size a fleet
   * and then fail deep in the runner.
   *   1. no CLI on PATH             → unavailable + how to install it
   *   2. CLI present but signed out → unavailable + how to sign in
   *   3. CLI present + authed       → healthy, scoped to read-only recon
   */
  override async health(): Promise<LaneHealth> {
    const detected = await super.health();
    if (detected.status === "unavailable") {
      return {
        status: "unavailable",
        details: [...detected.details, OPENCODE_INSTALL_HINT],
      };
    }

    let authenticated = false;
    let probeFailed = false;
    try {
      const verdict = await this.probeAuth();
      authenticated = verdict.authenticated;
    } catch {
      // Fail closed: an auth probe outage is never read as "signed in".
      probeFailed = true;
    }

    if (!authenticated) {
      return {
        status: "unavailable",
        details: [
          ...detected.details,
          probeFailed ? OPENCODE_AUTH_UNKNOWN : OPENCODE_AUTH_REQUIRED,
        ],
      };
    }

    return {
      status: "healthy",
      details: [...detected.details, OPENCODE_READ_ONLY_SCOPE],
    };
  }

  /**
   * BYO-auth: we only READ the vendor CLI's own status through the shared
   * readiness probe. No token is returned, logged, or stored.
   */
  private async probeAuth(): Promise<{ authenticated: boolean }> {
    if (this.options.probeAuth) {
      return this.options.probeAuth();
    }
    return probeVendorReadiness("opencode", {
      timeoutMs:
        this.options.authProbeTimeoutMs ?? OPENCODE_AUTH_PROBE_TIMEOUT_MS,
    });
  }

  override async startSession(
    input: LaneSessionInput & OpencodeRoleInput
  ): Promise<{ sessionId: string }> {
    assertOpencodeRole(input.role);
    return super.startSession(input);
  }

  override async submitTask(
    input: LaneTaskSubmission & OpencodeRoleInput
  ): Promise<void> {
    assertOpencodeRole(input.role);
    return super.submitTask(input);
  }

  /**
   * Overridden to install the launch guard, which is the whole reason this lane
   * needs a `runTask` at all: the permission table lives in a FILE, so the env
   * that points at that file has to be merged into the compiled env, and the
   * directory has to exist before the child starts.
   */
  override async runTask(
    input: LaneTaskSubmission & OpencodeRoleInput,
    onEvent: (event: LaneEvent) => void,
    options?: LaneRunOptions
  ): Promise<LaneCommandResult> {
    assertOpencodeRole(input.role);

    const cwd = options?.cwd ?? process.cwd();
    // Name every non-governed MCP server we are about to drop — after
    // narrowOpencodeProfile the compiler never sees them, so without this
    // signal an operator who put a third-party server on the profile would
    // get silence instead of the honesty compileOpencodeProfile promises.
    const droppedMcp = (options?.profile?.mcpServers ?? [])
      .filter((server) => server.name !== GOVERNED_MCP_SERVER_NAME)
      .map((server) => server.name);
    for (const name of droppedMcp) {
      this.emit(
        onEvent,
        input.taskId,
        "task.progress",
        `profile: mcp server '${name}' dropped on opencode (only the governed '${GOVERNED_MCP_SERVER_NAME}' brain is injected; an MCP entry is arbitrary command execution and this lane refuses foreign ones)`,
        { controlPlane: true, profileUnsupported: `mcpServers:${name}` }
      );
    }
    const narrowed: LaneRunOptions | undefined = options
      ? {
          ...options,
          ...(options.profile
            ? { profile: narrowOpencodeProfile(options.profile) }
            : {}),
        }
      : undefined;

    const invocation = this.resolveInvocation(input, narrowed);
    this.assertLaneBinaryAvailable(invocation.command);
    const compiled = this.compileRunProfile(input, onEvent, narrowed);

    // The guard config is written HERE, by the lane, and not by the profile
    // compiler. It is a property of the LANE, not of the profile: a run that
    // carries no profile at all must still be denied `bash`. Writing it in the
    // compiler would also make `profile-compiler.ts` import this module, which
    // imports `base-lane-adapter.ts`, which imports the compiler — a cycle.
    // TODO 1.7: when the profile carries mcpServers (the runner injects `muon`
    // via withMuonMcpServer), the same file + OPENCODE_CONFIG_CONTENT also carry
    // the governed `mcp` block. Secrets stay out of the file — only `{env:VAR}`
    // references — and the hoisted values ride `compiled.env`.
    //
    // Not restored afterwards, unlike cursor's and claude's run-scoped writes, and
    // the difference is the PATH rather than an oversight: this lands under
    // `.muon/`, which MUON owns outright, so there is no human file to overwrite and
    // `checkMergeReadiness` already exempts untracked `.muon/` from the dirty-base
    // fence. The restore exists for paths a repository may legitimately commit
    // (`.cursor/cli.json`, `.claude/settings.local.json`); this is not one.
    const mcpServers = narrowed?.profile?.mcpServers ?? [];
    mkdirSync(path.resolve(cwd, OPENCODE_GUARD_DIR), { recursive: true });
    writeFileSync(
      path.resolve(cwd, OPENCODE_GUARD_CONFIG_PATH),
      buildOpencodeGuardConfig(mcpServers)
    );

    const result = await this.spawnCompiledRun(
      input,
      onEvent,
      narrowed,
      invocation,
      {
        ...compiled,
        // The guard env wins over anything the profile supplied: a profile that
        // set OPENCODE_CONFIG itself would otherwise re-point the lane at a file
        // MUON does not own. MCP credential values from `compiled.env` survive
        // because the guard env has no overlapping MUON_* keys.
        env: { ...compiled.env, ...opencodeGuardEnv(cwd, mcpServers) },
      }
    );

    const parsed = parseOpencodeRunResult(result.output);
    if (parsed.text) {
      this.emit(onEvent, input.taskId, "task.progress", parsed.text, {
        opencodeRunResult: true,
      });
    }
    return result;
  }

  private emit(
    onEvent: (event: LaneEvent) => void,
    taskId: string,
    kind: LaneEvent["kind"],
    message: string,
    metadata: Record<string, unknown>
  ): void {
    onEvent({
      id: `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      laneId: this.id,
      taskId,
      kind,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * The managed read-only reconnaissance invocation. Deliberately fixed:
   *   run                  the non-interactive one-shot mode
   *   --format json        a machine-readable body, not a TTY transcript
   *   --dir <cwd>          MUON owns the workspace root, not opencode's notion
   *                        of a current project
   * NO `--agent`: the agent is left at the default so there is exactly ONE
   * permission table in play — the one MUON compiled. Naming `plan` here would
   * look safer and be worse, because `plan` allows EVERYTHING (see header).
   *
   * `--pure` closes the global-plugin egress vector (finding 5): a plugin under
   * `~/.opencode/plugin/` loads even under MUON's redirected env, so a governed
   * scout would otherwise run the operator's ambient plugins. `--pure` drops
   * them and nothing else — the deny table and BYO auth both survive (measured).
   */
  override taskCommand(brief: string, context?: LaneTaskContext) {
    return {
      command: this.getAvailableCommand() ?? this.commandCandidates[0]!,
      args: [
        "run",
        "--pure",
        "--format",
        "json",
        "--dir",
        context?.cwd ?? process.cwd(),
        brief,
      ],
    };
  }

  /** Categorical last-mile net; see `stripOpencodeWideningArgs`. */
  protected override guardFinalArgs(args: string[]): string[] {
    return stripOpencodeWideningArgs(args).args;
  }
}

/**
 * Narrow a caller-supplied profile to what a read-only OpenCode run may carry.
 * A second, independent net alongside `guardFinalArgs`: this one stops the
 * widening being COMPILED at all, the other stops it being SPAWNED. Neither
 * relies on the other, and neither widens anything.
 *
 * Lives here rather than in the compiler so both nets sit beside the vendor lore
 * that justifies them, and so the compiler never has to import this module (see
 * the cycle note in `runTask`). It is applied in `runTask`, exactly as
 * `narrowCursorProfile` is.
 */
export function narrowOpencodeProfile(profile: LaneProfile): LaneProfile {
  return {
    ...profile,
    // A read-only recon lane never runs unattended-with-approvals-off.
    ...(profile.permissionMode === "full-auto"
      ? { permissionMode: "default" as const }
      : {}),
    ...(profile.sandbox === "full-access"
      ? { sandbox: "read-only" as const }
      : {}),
    // TODO 1.7 P1: an MCP entry is arbitrary command execution, and the
    // permission table cannot touch server *spawn* (only tool visibility).
    // Before 1.7, mcpServers were inert here; now they become a `command`
    // array in the guard config. Keep only MUON's governed server — same
    // filter `narrowProfileForRole` applies — as a lane-local net that does
    // not depend on the caller having named a role.
    mcpServers: profile.mcpServers.filter(
      (server) => server.name === GOVERNED_MCP_SERVER_NAME
    ),
  };
}
