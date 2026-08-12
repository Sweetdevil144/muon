import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CODEX_GUARD_ENV_KEY } from "./lane-guard-env.js";
import { readCodexActiveCustomProvider } from "./provider-credentials.js";

/**
 * AMBIENT-CONFIG ISOLATION FOR A MUON-DISPATCHED CODEX CHILD (`codex` 0.145).
 *
 * Until this file existed, a MUON-dispatched Codex worker inherited the
 * operator's entire personal `~/.codex/config.toml`. On the founder's own
 * machine that meant a read-only `scout` was handed a **Node REPL** and
 * **desktop control**, neither of which is in MUON's grant, neither of which
 * appears in the capability preflight, and neither of which the MUON MCP
 * readiness gate could ever catch — that gate asserts MUON's tools are PRESENT
 * and never that nothing ELSE is.
 *
 * Every claim below was verified against the installed 0.145.0 binary using
 * `codex mcp list --json`, `codex doctor --json`, and a real `codex app-server`
 * `mcpServerStatus/list` handshake. NO model turn was spent.
 *
 * 1. MEASURED AMBIENT INHERITANCE. Through the app-server surface a governed
 *    child saw SEVEN servers and 206 tools: `codex_apps` (169 tools,
 *    bearerToken), `node_repl` (3, arbitrary code execution), `gitnexus` (16,
 *    bearerToken), `cubic` (13, OAuth), `supabase` (OAuth), `computer-use`,
 *    `openaiDeveloperDocs`. `mcpServerStatus/list` took 5.6s and stderr carried
 *    `failed to refresh OAuth tokens for server supabase` — the exact line the
 *    founder saw before an exit-130 with no output.
 *
 * 2. `-c` OVERRIDES CANNOT SUBTRACT. `-c mcp_servers={}` left all seven in
 *    place: `-c` merges at the LEAF, so a table-level override deletes nothing.
 *    Worse, `-c mcp_servers.<plugin-provided>.enabled=false` makes the whole
 *    config load FAIL (`invalid transport`), because the override creates a
 *    partial table for a server that has no `mcp_servers` entry. So the
 *    compiler ADDING `mcp_servers.muon.*` can never be a boundary, and
 *    per-server disabling is not a usable narrowing either. This is Codex's
 *    version of OpenCode's specificity-first surprise: assume nothing.
 *
 * 3. THERE IS NO PROJECT-LEVEL CONFIG. Neither `<cwd>/.codex/config.toml` nor
 *    `<cwd>/config.toml` contributed a server. Unlike OpenCode — which needed
 *    `OPENCODE_DISABLE_PROJECT_CONFIG` as a load-bearing second lever — Codex
 *    reads config from exactly one root, so `CODEX_HOME` is the whole lever.
 *
 * 4. `CODEX_HOME` IS THE LEVER, AND IT IS TOTAL. Pointed at a directory with no
 *    `config.toml`, the configured-server inventory is `[]`: MCP servers,
 *    plugins, marketplaces, `hooks.json`, `<name>.config.toml` profiles and the
 *    ambient `[features]` table all resolve under it and all disappear at once.
 *    That is why `CODEX_HOME` belongs in the guard and NOT in the registry's
 *    `credentials.envKeys`, where it was being treated as a credential to
 *    forward — i.e. MUON was forwarding the operator's ambient config root to
 *    the child as though it were a secret the child needed.
 *
 * 5. `CODEX_HOME` ALONE IS NOT ENOUGH. A built-in `codex_apps` bridge — 169
 *    tools, bearerToken auth — survives an empty guard home. `codex mcp list`
 *    never shows it (that command lists only externally CONFIGURED servers);
 *    only the app-server inventory does, which is what the model actually gets.
 *    `-c features.apps=false` removes it. Measured end state with both levers:
 *    exactly `[{muon}]`, answered in 33ms instead of 5.6s. See
 *    `CODEX_AMBIENT_SUPPRESSION_ARGS`.
 *
 * 6. AUTH SURVIVES, AND NO TOKEN IS COPIED. `auth.json` lives under
 *    `CODEX_HOME`, so an empty guard home reports `Not logged in`. The guard
 *    therefore SYMLINKS the operator's own `auth.json` into it: MUON never
 *    reads, copies, or custodies the token (BYO-auth, ADR-0019 §2.10). Verified
 *    live — under the guard home `codex login status` answers
 *    `Logged in using ChatGPT` and `codex doctor --json` reports
 *    `auth.credentials: ok`, `stored auth mode: chatgpt`. Verified separately
 *    that codex REWRITES `auth.json` THROUGH the symlink rather than replacing
 *    it, so an OAuth refresh updates the operator's real file and no refreshed
 *    credential is ever stranded inside MUON's guard directory.
 *
 * WHAT THIS DOES NOT DO, stated so nobody reads more into it. The guard home
 * carries no `config.toml`, so an operator's `[model_providers.*]` block is NOT
 * in effect for a governed run and a custom-provider lane falls back to the
 * built-in `openai` provider. That is deliberate — importing it would be exactly
 * the silent ambient import ADR-0019 §2.1 requires operator consent for — but it
 * is a real behaviour change, and `CODEX_GUARD_NOTICE` states it to the operator
 * rather than leaving it to be discovered.
 */

/**
 * The guard home lives OUTSIDE the run workspace, unlike OpenCode's
 * `.muon/opencode/`, and the difference is load-bearing in both directions:
 *
 *  - it must not be in the workspace, because `CODEX_HOME` is where codex puts
 *    `auth.json`, `history.jsonl`, session rollouts and its log database (2.5GB
 *    on the founder's machine). A symlink to the operator's credential file
 *    inside a repo an agent may `git add` is a worse posture than the one we
 *    are fixing.
 *  - it must not be under MUON's data dir either: ADR-0010's Seatbelt profile
 *    deny-READS that subpath, so codex could not resolve the auth symlink there.
 *
 * `tmpdir()` is the one root that is already `(allow file-write*)` in
 * `buildSeatbeltProfile`, per-user on macOS, and outside both. It is STABLE
 * rather than per-run so codex's model catalogue cache survives between
 * dispatches instead of being refetched every time.
 */
export const CODEX_GUARD_HOME_NAME = "muon-codex-home";

/** Vendor-owned credential file the guard links rather than copies (finding 6). */
export const CODEX_AUTH_FILE = "auth.json";

/** Where the operator's real Codex configuration lives when nothing says otherwise. */
export const CODEX_DEFAULT_HOME_NAME = ".codex";

/**
 * Shown once per governed run. Says what MUON suppressed and what the operator
 * consequently should NOT expect to be in effect — including the provider
 * caveat in the header, which is the one honest cost of this isolation.
 */
export const CODEX_GUARD_NOTICE =
  "codex: MUON started this lane with an isolated CODEX_HOME, so your personal ~/.codex configuration — MCP servers, plugins, marketplaces, hooks, features, and model_providers — is not in effect for this run. MUON supplies the child's entire MCP server set; your Codex login is reused unchanged.";

/**
 * The ambient capability the guard home does NOT remove, removed here.
 *
 * `codex_apps` is BUILT IN, not configured, so it survives an empty
 * `CODEX_HOME` and contributed 169 ungranted tools to every governed child
 * (finding 5). `plugins` is stated alongside it rather than left to follow from
 * `apps`: they are separate stable feature flags, a plugin can install its own
 * MCP server and its own hooks, and "the other one happened to cover it" is not
 * a boundary. Both are `-c features.<name>=false`, i.e. the `--disable
 * <FEATURE>` spelling, which finding 2 shows IS effective for a leaf key even
 * though a table-level override is not.
 *
 * 7. VENDOR-NATIVE FAN-OUT, AND WHY IT IS SUPPRESSED HERE AND NOT PER-MODE.
 *    `codex features list` on the installed 0.145.0 reports `multi_agent
 *    stable true` — ON by default. A Codex child with it can spawn its own
 *    subagents, which MUON does not see, does not budget, does not lineage-track
 *    and cannot audit: their edits arrive with no job id, no worktree claim and
 *    no handoff evidence, so a worker that fans out is a worker whose file
 *    claims and evidence are all wrong. ADR-0022 records that this fan-out is
 *    ungovernable by MUON.
 *
 *    It WAS disabled, but only in the runner's `capabilityMode === "orchestrator"`
 *    branch, via that profile's `rawConfig`. The delegate branch resets
 *    `rawConfig: {}` — so the coordinator was locked down and the WORKERS below
 *    it, the ones that actually touch code, were not. That is the derive-by-
 *    subtraction shape this repo has been bitten by before: a boundary that
 *    lives in one mode's branch is not a boundary, because the next mode starts
 *    from a different base. Stating it in the one list that runs for EVERY
 *    governed Codex child regardless of capability mode is what makes it hold.
 *
 *    `multi_agent_v2` is named alongside it for exactly the reason `plugins` is
 *    named alongside `apps`: it is a separate stable flag (`stable false`
 *    today), and "it happens to be off right now" is not a boundary — a vendor
 *    default flip would silently re-open the hole.
 *
 *    MEASURED, not assumed. Against the installed binary, `codex features list`
 *    reports `multi_agent true`; with these overrides on the argv the same
 *    command reports `multi_agent false` and `multi_agent_v2 false` (with
 *    `apps`/`plugins` going true→false alongside as the known-good control).
 *    Both are leaf keys, so finding 2's "a `-c` override cannot subtract"
 *    limitation does not apply.
 *
 * Emitted by the LANE (see `CodexAdapter`/`CodexSessionDriver`) and never by
 * the profile compiler, for the same reason OpenCode's permission table is
 * written by its lane: a run that carries no profile at all must still be
 * isolated.
 *
 * This list only ever NARROWS. Everything in it is `features.<name>=false`, and
 * `stripCodexWideningArgs` guards the `features.` prefix in both directions, so
 * nothing downstream can turn one back on.
 */
export const CODEX_AMBIENT_SUPPRESSION_ARGS: readonly string[] = [
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.multi_agent_v2=false",
];

/**
 * NESTED-SANDBOX LOCKOUT FIX (measured live, codex 0.145.0 / macOS Seatbelt).
 *
 * MUON's runner process is itself confined under `sandbox-exec` (ADR-0010,
 * `SeatbeltSandboxLauncher`), and macOS refuses to APPLY a second Seatbelt
 * profile from inside one: `sandbox-exec … pwd` under an outer
 * `(version 1)(allow default)` profile fails with
 * `sandbox-exec: sandbox_apply: Operation not permitted` (rc 71). Codex runs
 * EVERY shell command under its own per-command Seatbelt whenever
 * `sandbox_mode` is `read-only` or `workspace-write` — so a governed Codex
 * child inside the confined runner could not run ANYTHING, not even `pwd`:
 * the founder's live children reported "even a read-only `pwd` command is
 * rejected while applying the sandbox" and could neither read their skill
 * files nor run checks in their own worktree.
 *
 * The honest resolution is to state which sandbox is in force. When (and only
 * when) MUON's own confinement is active (`MUON_SANDBOX_ACTIVE=1`, set by the
 * launcher on the wrapped runner), the child's `sandbox_mode` is overridden to
 * `danger-full-access` so codex stops trying to nest a sandbox macOS will
 * never grant it. Verified live under the outer profile: `workspace-write` ⇒
 * every command fails; this override ⇒ rc 0, `pwd` answers, a file edit lands
 * in the worktree.
 *
 * WHAT THE OUTER PROFILE ACTUALLY STILL ENFORCES, stated precisely rather than
 * as "the outer sandbox remains in force": the runner is wrapped with
 * `buildSeatbeltProfile`'s DATA-DIR BLIND — its `deny file-read` and
 * `deny file-write` rules over `dataDir` — so the brain's operator token,
 * database, and graph stay unreachable to this child, and that is inherited.
 * It is NOT workspace write
 * confinement: the runner is wrapped without `writeRoots`, and the per-worktree
 * scoping that codex's own `workspace-write` provided is exactly what macOS
 * refuses to apply here. A confined write-authority codex child can therefore
 * write outside its worktree; that is the cost of the fix, and the follow-up is
 * per-child confinement at the A1 layer rather than a nested one.
 *
 * Appended AFTER the compiled profile args on purpose — codex applies `-c`
 * overrides in order and the LAST one wins (verified live) — and emitted by
 * the lanes, not the compiler, for the same reason the suppression args are:
 * a run with no profile at all must still work inside the confined runner.
 */
export const CODEX_NESTED_SANDBOX_OVERRIDE_ARGS: readonly string[] = [
  "-c",
  'sandbox_mode="danger-full-access"',
];

/**
 * Operator-facing statement of the override above. Loud, once per run, so
 * "codex ran unsandboxed-by-codex" is a stated fact, never a discovery.
 */
export const CODEX_NESTED_SANDBOX_NOTICE =
  "codex: MUON's runner is Seatbelt-confined and macOS forbids nesting a second sandbox, so codex's own per-command sandbox is disabled for this run (it could not even run 'pwd' otherwise). What MUON's outer Seatbelt profile still enforces for this child is specifically the DATA-DIR BLIND — the brain's directory stays unreadable and unwritable. It does not confine this child's writes to the worktree; codex's own workspace-write scoping was what did that, and it is what macOS refused to apply.";

/**
 * The value a composed codex argv ACTUALLY states for one config key, or
 * undefined when it states none (codex then applies its own default).
 *
 * Read from the ARGV rather than from any single profile field, because a
 * config key is reachable through three independent channels that all converge
 * here: the compiled profile (`-c key=…`), `profile.rawConfig`, and
 * `profile.extraArgs` passthrough. A gate that reads only one silently
 * reverses an operator's explicit rawConfig/extraArgs tightening — the
 * derive-from-one-channel shape this repo has been bitten by before. The LAST
 * statement wins, matching codex's own `-c` precedence (verified live).
 */
function effectiveCodexConfigValue(
  args: readonly string[],
  key: string
): string | undefined {
  let value: string | undefined;
  const read = (override: string | undefined): void => {
    if (override === undefined) return;
    const trimmed = override.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) return;
    if (trimmed.slice(0, separator).trim().toLowerCase() !== key) {
      return;
    }
    // Values arrive quoted (`tomlValue` JSON-stringifies) or bare (extraArgs).
    value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const bare = arg.split("=")[0]!.trim().toLowerCase();
    if (bare !== "-c" && bare !== "--config") continue;
    if (arg.includes("=")) {
      read(arg.slice(arg.indexOf("=") + 1));
      continue;
    }
    read(args[index + 1]);
    index += 1;
  }
  return value;
}

/**
 * The sandbox mode a composed codex argv ACTUALLY states, or undefined when it
 * states none (codex then applies its own default, `workspace-write`).
 */
export function effectiveCodexSandboxMode(
  args: readonly string[]
): string | undefined {
  return effectiveCodexConfigValue(args, "sandbox_mode");
}

/**
 * The approval policy a composed codex argv ACTUALLY states, or undefined when
 * it states none.
 *
 * Exists for the app-server driver's `thread/start` params: the RPC param WINS
 * over an argv `-c` statement (measured, 0.145.0 — a `thread/start` sandbox of
 * `read-only` defeated an argv `danger-full-access`), so a driver that derives
 * the param from `profile.permissionMode` alone silently overrides an
 * operator's rawConfig/extraArgs statement. Deriving the param from the SAME
 * composed argv every other channel converges on keeps the two channels from
 * ever disagreeing.
 */
export function effectiveCodexApprovalPolicy(
  args: readonly string[]
): string | undefined {
  return effectiveCodexConfigValue(args, "approval_policy");
}

/**
 * The nested-sandbox override, iff MUON's own confinement is active in THIS
 * process. Empty otherwise: an unconfined runner (MUON_SANDBOX=0, non-macOS)
 * keeps codex's native sandbox, which there is both functional and wanted.
 *
 * NEVER when the composed argv already states `read-only`. A `reviewer`/`scout`
 * role narrows the lane that way, and so may an operator through rawConfig or
 * extraArgs; rewriting any of them to `danger-full-access` would hand a
 * read-only run write authority as a side effect of a RENDERING fix — the
 * exact bounded-surface defeat this repo keeps closing. Under confinement such
 * a child's SHELL commands stay refused (fail closed, as today), while its
 * in-process file reads — which never pass through codex's command sandbox —
 * keep working, which is what a read-only role actually needs.
 *
 * `workspace-write` is codex exec's own default (measured, 0.145.0), so an argv
 * that states NOTHING is write-authority by vendor default and is overridden.
 */
export function codexSandboxOverrideArgs(
  env: NodeJS.ProcessEnv = process.env,
  composedArgs: readonly string[] = []
): readonly string[] {
  if (effectiveCodexSandboxMode(composedArgs) === "read-only") {
    return [];
  }
  return env.MUON_SANDBOX_ACTIVE === "1"
    ? CODEX_NESTED_SANDBOX_OVERRIDE_ARGS
    : [];
}

/**
 * Codex flags that widen authority, defeat the guard, or send the run
 * off-machine. None may appear on a MUON-managed argv from ANY source — the
 * invocation, the compiled profile, `extraArgs`, or a per-run argv override.
 *
 *  --oss / --local-provider    re-reads ambient provider config and will
 *                              auto-download a missing default model
 *  --profile / -p              layers `$CODEX_HOME/<name>.config.toml`; harmless
 *                              under the guard home only by accident, and an
 *                              accident is not a boundary
 *  --enable                    re-enables a feature MUON disabled, which is the
 *                              exact undo of `CODEX_AMBIENT_SUPPRESSION_ARGS`
 *  --dangerously-bypass-approvals-and-sandbox
 *                              skips every confirmation AND the sandbox
 *  --dangerously-bypass-hook-trust
 *                              runs unvetted hooks without persisted trust
 *  --remote / --remote-auth-token-env
 *                              points the run at a remote app server: egress
 *  --search                    live web search with no per-call approval
 *
 * `--disable` is deliberately ABSENT: it can only narrow.
 */
export const CODEX_WIDENING_FLAGS: readonly string[] = [
  "--oss",
  "--local-provider",
  "--profile",
  "-p",
  "--enable",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--remote",
  "--remote-auth-token-env",
  "--search",
];

const CODEX_WIDENING_FLAG_SET: ReadonlySet<string> = new Set(
  CODEX_WIDENING_FLAGS
);

/**
 * The subset above that takes a VALUE, so the value token is dropped with its
 * flag. Split out for the reason `stripOpencodeWideningArgs` documents: listing
 * a boolean flag here eats the next token (for Codex that next token is the
 * BRIEF), and omitting a valued flag leaves its value behind as a stray
 * positional, which `codex exec` reads as the prompt. Taken from
 * `codex --help`: `--oss`, `--search` and both `--dangerously-*` are boolean.
 */
const CODEX_VALUED_WIDENING_FLAGS: ReadonlySet<string> = new Set([
  "--local-provider",
  "--profile",
  "-p",
  "--enable",
  "--remote",
  "--remote-auth-token-env",
]);

/**
 * A `-c key=value` override that would undo the guard. `-c` itself must survive
 * — it is how MUON states the model, the approval policy, the sandbox mode and
 * the governed `muon` server — so this matches on the KEY, not the flag.
 *
 * `features.` is prefix-matched, so `features.apps`, `features.plugins`, and
 * any feature Codex adds later are covered without an enumeration to keep in
 * sync. Both DIRECTIONS are refused: a guard that only stripped `=true` would
 * be defeated by the next spelling of "on".
 *
 * `mcp_servers.*` is deliberately NOT here. MUON's own compiler emits
 * `mcp_servers.muon.*`, and an argv-level strip cannot tell that apart from an
 * injected third-party server without knowing the grant. That case is caught
 * one layer down instead, by `ungrantedCodexMcpServers` against the EFFECTIVE
 * inventory — which is strictly stronger, because it also catches a server that
 * never appeared on an argv at all.
 */
const CODEX_GUARDED_CONFIG_KEY_PREFIX = "features.";

/**
 * The exact overrides MUON itself emits. Kept as an allowance rather than by
 * exempting a whole key space: MUON states these exact strings and nothing
 * else, so anything else under a guarded key — including the same key with
 * different casing or a different value — is somebody else's.
 *
 * The nested-sandbox override is registered here even though `sandbox_mode` is
 * NOT currently a guarded key. That is the point: if a later hardening pass
 * adds it to {@link CODEX_GUARDED_CONFIG_KEY_PREFIX}, MUON's own fix must
 * survive MUON's own strip — otherwise the hardening would silently restore
 * the nested-sandbox lockout that left governed codex children unable to run
 * even `pwd`, and every test would still pass.
 */
export const MUON_OWNED_CONFIG_OVERRIDES: ReadonlySet<string> = new Set(
  [
    ...CODEX_AMBIENT_SUPPRESSION_ARGS,
    ...CODEX_NESTED_SANDBOX_OVERRIDE_ARGS,
  ].filter((arg) => arg !== "-c")
);

function isGuardedConfigOverride(value: string): boolean {
  const trimmed = value.trim();
  if (MUON_OWNED_CONFIG_OVERRIDES.has(trimmed)) {
    return false;
  }
  const key = trimmed.split("=")[0]!.trim().toLowerCase();
  return key.startsWith(CODEX_GUARDED_CONFIG_KEY_PREFIX);
}

/**
 * Strip every authority-widening Codex flag from an argv. Categorical by
 * construction, exactly as `stripOpencodeWideningArgs` is: a NEW path into the
 * argv is covered without a new call site. MUON's own invocation emits none of
 * these, which is what makes the strip unconditional.
 *
 * `CODEX_AMBIENT_SUPPRESSION_ARGS` is MUON-owned and survives, because it is
 * `-c features.*=false`; a caller-supplied `-c features.apps=true` does not,
 * because the KEY is guarded regardless of the value. Refusing both directions
 * is the point — a guard that only refused `=true` would be defeated by the
 * next spelling of "on".
 */
export function stripCodexWideningArgs(args: readonly string[]): {
  args: string[];
  removed: string[];
} {
  const kept: string[] = [];
  const removed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const bare = arg.split("=")[0]!.trim().toLowerCase();

    if (bare === "-c" || bare === "--config") {
      // `-c` takes its key=value as the NEXT token unless it was joined with
      // `=`. Judge the override the flag actually carries, then keep or drop
      // the pair together — a kept `-c` with a dropped value would turn the
      // brief into the override.
      const joined = arg.includes("=");
      const override = joined ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
      if (override !== undefined && isGuardedConfigOverride(override)) {
        removed.push(arg);
        if (!joined) {
          removed.push(override);
          index += 1;
        }
        continue;
      }
      kept.push(arg);
      continue;
    }

    if (!CODEX_WIDENING_FLAG_SET.has(bare)) {
      kept.push(arg);
      continue;
    }
    removed.push(arg);
    if (!arg.includes("=") && CODEX_VALUED_WIDENING_FLAGS.has(bare)) {
      removed.push(args[index + 1] ?? "");
      index += 1;
    }
  }
  return { args: kept, removed };
}

/**
 * MUON's own suppression args must survive its own strip. Asserted in tests
 * rather than assumed: `stripCodexWideningArgs` guards the `features.` prefix
 * in BOTH directions, and getting that wrong would silently re-admit the 169
 * ambient tools while every test still passed.
 */
export function guardedCodexArgs(args: readonly string[]): string[] {
  return stripCodexWideningArgs(args).args;
}

/** The operator's OWN Codex root — the one MUON reads auth from, never writes. */
export function resolveOperatorCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const configured = env.CODEX_HOME?.trim();
  // Same rule `codexEvidence` applies in ./provider-credentials.ts: a RELATIVE
  // value is ignored rather than resolved through an attacker-influenced cwd.
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(home, CODEX_DEFAULT_HOME_NAME);
}

/** The isolated root MUON hands the child. */
export function codexGuardHomePath(tmp: string = tmpdir()): string {
  return path.join(tmp, CODEX_GUARD_HOME_NAME);
}

/**
 * The env that makes MUON's empty root the child's ONLY configuration source.
 *
 * One variable, because finding 3 proved one is enough — stating a second lever
 * MUON had not verified would be the false claim of isolation this file exists
 * to avoid. `XDG_CONFIG_HOME` is deliberately NOT redirected: Codex does not
 * resolve configuration through it, and moving it would change behaviour MUON
 * has not measured.
 */
export function codexGuardEnv(guardHome: string): Record<string, string> {
  return { [CODEX_GUARD_ENV_KEY]: guardHome };
}

export type CodexGuardHome = {
  /** Absolute path handed to the child as `CODEX_HOME`. */
  home: string;
  /** True once the operator's own `auth.json` is reachable from the guard. */
  authLinked: boolean;
};

/**
 * Raised when the guard directory cannot be proven to be MUON's own.
 *
 * `mkdirSync(…, {recursive:true})` succeeds on a directory that ALREADY exists,
 * which on a shared `/tmp` means another local user could pre-create the guard
 * path, drop a `config.toml` in it, and re-widen every governed Codex run
 * through the exact mechanism this file removes. Ownership and mode are checked
 * AFTER creation for that reason, and a failure refuses the launch rather than
 * falling back to the ambient home — falling back would trade a detected hole
 * for the original one.
 */
export class CodexGuardHomeError extends Error {
  constructor(detail: string) {
    super(
      `MUON could not establish an isolated CODEX_HOME (${detail}). Refusing to launch Codex: without it the child would inherit every MCP server, plugin, and hook in the operator's personal ~/.codex configuration, none of which is in MUON's grant.`
    );
    this.name = "CodexGuardHomeError";
  }
}

/**
 * Raised when the operator's Codex is pointed at a custom model provider.
 *
 * THE HONEST COST OF THIS ISOLATION, made loud instead of silent. The guard home
 * carries no `config.toml`, so `[model_providers.*]` is not in effect and a
 * governed child would fall back to the built-in `openai` provider — a
 * DIFFERENT ACCOUNT than the operator configured, with different billing and
 * different data handling. Carrying the block forward would be an ambient
 * import, which ADR-0019 §2.1 requires explicit operator consent for; running
 * anyway would be a silent account switch. Refusing is the only answer that is
 * neither.
 *
 * This replaces, rather than removes, the driver's previous
 * `provider-credential-missing` block: the same "do not start a turn that will
 * surprise the operator about which account it used" rule, moved to the one
 * place that can still see both the operator's configuration and the child's.
 */
export class CodexGuardProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `Codex is configured to use the custom model provider '${provider}', but MUON isolates a governed Codex child from ~/.codex, so that provider is not in effect for this run. MUON refused rather than silently falling back to a different account. Governed Codex lanes use your ChatGPT login or OPENAI_API_KEY; set 'model_provider = "openai"' in ~/.codex/config.toml, or run this lane on another vendor.`
    );
    this.name = "CodexGuardProviderError";
    this.provider = provider;
  }
}

function assertOwnedPrivateDir(dir: string): void {
  let stats;
  try {
    stats = statSync(dir);
  } catch (error) {
    throw new CodexGuardHomeError(
      `'${dir}' could not be inspected: ${(error as Error).message}`
    );
  }
  if (!stats.isDirectory()) {
    throw new CodexGuardHomeError(`'${dir}' is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new CodexGuardHomeError(`'${dir}' is owned by another user`);
  }
  // Windows has no meaningful POSIX mode; enforcing one there would fail closed
  // on every run for no gain.
  if (uid !== undefined && (stats.mode & 0o077) !== 0) {
    throw new CodexGuardHomeError(
      `'${dir}' is readable or writable by group/other; MUON did not create it in that state, so delete it and retry`
    );
  }
}

/**
 * Create (or reuse) the isolated Codex home and make the operator's own login
 * reachable from it.
 *
 * BYO-AUTH IS PRESERVED BY LINKING, NOT COPYING. MUON never opens `auth.json`,
 * so no vendor token enters MUON's address space, its logs, its events, or its
 * storage — and because codex rewrites the file in place through the link
 * (verified live), an OAuth refresh lands in the OPERATOR's file and never
 * strands a fresh credential inside MUON's directory.
 *
 * A missing `auth.json` is NOT an error: an operator on `OPENAI_API_KEY` has
 * none, and that key still reaches the child through the registry's
 * `credentials.envKeys`. `authLinked` reports which of the two happened so the
 * caller can say so rather than guess.
 */
export function prepareCodexGuardHome(
  options: {
    guardHome?: string;
    operatorHome?: string;
    env?: NodeJS.ProcessEnv;
    /** Injection seam so tests never read the operator's real config. */
    readActiveCustomProvider?: (codexHome: string) => string | undefined;
  } = {}
): CodexGuardHome {
  const home = options.guardHome ?? codexGuardHomePath();
  const operatorHome =
    options.operatorHome ?? resolveOperatorCodexHome(options.env);

  // Checked BEFORE anything is created: refusing is the outcome, so there is
  // nothing to build first.
  const customProvider = (
    options.readActiveCustomProvider ?? readCodexActiveCustomProvider
  )(operatorHome);
  if (customProvider !== undefined) {
    throw new CodexGuardProviderError(customProvider);
  }

  // `mode` is MASKED by the umask, never widened by it, so a directory MUON
  // creates is always at most 0700. It is IGNORED when the directory already
  // exists — which is the case that matters, and is why the check below runs
  // instead of a chmod: quietly narrowing a directory MUON did not create would
  // repair the symptom of a pre-created guard path and keep using it.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assertOwnedPrivateDir(home);

  const guardAuth = path.join(home, CODEX_AUTH_FILE);
  const operatorAuth = path.join(operatorHome, CODEX_AUTH_FILE);
  // A guard home that IS the operator's home would mean no isolation at all,
  // and the symlink below would point at itself.
  if (path.resolve(operatorHome) === path.resolve(home)) {
    throw new CodexGuardHomeError(
      "the operator's CODEX_HOME resolves to MUON's own guard directory"
    );
  }

  // Cleared and re-made every launch rather than created once. Three reasons,
  // and the first two were live bugs in the first draft of this file:
  //   - `symlinkSync` HAPPILY CREATES A DANGLING LINK, so "the call succeeded"
  //     is not evidence the operator has an `auth.json`. Existence is checked
  //     instead, or an API-key operator would be reported as linked.
  //   - a link made when the operator's `CODEX_HOME` was elsewhere would
  //     otherwise survive into a run where it has moved, pointing at the wrong
  //     login.
  //   - if a codex build ever REPLACED the file instead of writing through it,
  //     a refreshed credential would be sitting here as a real file; unlinking
  //     it every launch means MUON never accumulates one.
  rmSync(guardAuth, { force: true });
  let authLinked = false;
  if (existsSync(operatorAuth)) {
    try {
      symlinkSync(operatorAuth, guardAuth);
      authLinked = true;
    } catch {
      // Not fatal: an operator on `OPENAI_API_KEY` needs no `auth.json`, and
      // that key still reaches the child through `credentials.envKeys`.
      // `authLinked: false` is what the caller reports rather than guesses.
    }
  }

  return { home, authLinked };
}

/**
 * ASSERT THE NEGATIVE.
 *
 * The MUON MCP readiness gate asserts MUON's tools are PRESENT. It has never
 * asserted that nothing ELSE is, which is why nine ambient servers could ride
 * into a governed run without a single check firing. This is the other half:
 * the servers MUON did not grant, named.
 *
 * Reachable through the app-server protocol precisely because
 * `mcpServerStatus/list` enumerates the EFFECTIVE inventory rather than the
 * configured one — it is the only surface that reports `codex_apps` at all
 * (`codex mcp list` does not), so it is the only surface on which this
 * assertion is worth making.
 */
export function ungrantedCodexMcpServers(
  observed: readonly string[],
  granted: readonly string[]
): string[] {
  const grantedSet = new Set(granted);
  return [...new Set(observed.filter((name) => !grantedSet.has(name)))];
}

/**
 * The refusal detail for an inventory that carried servers MUON did not grant.
 * Names servers only — an inventory is vendor output, so the caller sanitizes
 * each name before it reaches a message.
 */
export function ungrantedCodexServersDetail(
  ungranted: readonly string[],
  granted: readonly string[]
): string {
  return `Codex exposed ${ungranted.length} MCP server(s) MUON did not grant: ${ungranted.join(
    ", "
  )}. MUON grants exactly: ${
    granted.length > 0 ? granted.join(", ") : "(none)"
  }. A governed run may not proceed with capabilities outside its manifest.`;
}

/**
 * Signal-derived exit codes, so a bare number becomes a cause.
 *
 * The founder hit `130` twice on the codex/scout lane with zero output, and the
 * coordinator correctly reported it as an unattributable external kill — it
 * could not see that MUON had handed the child a six-server startup with a
 * failing OAuth refresh. `128 + signo` is the shell convention every one of
 * these follows.
 */
const CODEX_EXIT_SIGNALS: Readonly<Record<number, string>> = {
  129: "SIGHUP",
  130: "SIGINT",
  131: "SIGQUIT",
  137: "SIGKILL",
  143: "SIGTERM",
};

/** Where the child was in its own lifecycle when it died. */
export type CodexStartupPhase = "mcp-startup" | "ready";

/**
 * Turn a bare Codex exit code into an attributable sentence.
 *
 * A child that dies DURING MCP startup must never surface as a naked number.
 * The three facts that make it actionable are all in MUON's hands at that
 * moment: which signal the code encodes, that the child had not finished
 * starting its MCP servers, and exactly which servers MUON granted — the last
 * being the one the old message could not have known, because before the guard
 * MUON did not choose the set.
 */
export function codexStartupExitDetail(input: {
  code: number;
  phase: CodexStartupPhase;
  grantedServers: readonly string[];
  stderrTail?: string;
}): string {
  const signal = CODEX_EXIT_SIGNALS[input.code];
  const cause = signal
    ? `code ${input.code}, i.e. ${signal}`
    : `code ${input.code}`;
  if (input.phase !== "mcp-startup") {
    return `Codex app-server exited before turn/completed (${cause}). Restart the provider session and retry; MUON ended this turn instead of leaving it running.${
      input.stderrTail ? ` Codex reported: ${input.stderrTail}` : ""
    }`;
  }
  const granted =
    input.grantedServers.length > 0
      ? input.grantedServers.join(", ")
      : "(none)";
  return `Codex app-server died while its MCP servers were still starting (${cause}), before it could report an inventory. MUON granted exactly: ${granted}, and isolates the child from ~/.codex, so an ambient third-party server can no longer stall or kill this startup.${
    input.stderrTail ? ` Codex reported: ${input.stderrTail}` : ""
  }`;
}
