import {
  GOVERNED_MCP_SERVER_NAME,
  isWriteClassTool,
  isReadOnlyRole,
  type AgentRole,
  type LaneCapabilities,
  type LaneEvent,
  type LaneHealth,
  type LaneProfile,
  type LaneSessionInput,
  type LaneTaskSubmission,
} from "@muon/protocol";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { BaseLaneAdapter, type LaneTaskContext } from "./base-lane-adapter.js";
import { buildLaneEnvironment, type LaneCommandResult } from "./lane-runner.js";
import {
  cursorForeignHookExposure,
  cursorMandatoryConfigWrites,
} from "./profile-compiler.js";
import { boundedProviderFailure } from "./provider-failure.js";
import {
  probeVendorReadiness,
  runBoundedVendorCommand,
  type ProbeExec,
} from "./vendor-readiness.js";

/**
 * MANAGED READ-ONLY CURSOR.
 *
 * `docs/` deferred managed Cursor execution until it could meet MUON's
 * ownership / attestation / approval / cancellation / artifact standards. A
 * READ-ONLY REVIEWER is the exact slice that meets them, because it cannot
 * mutate the workspace at all:
 *  - ownership     — MUON owns the argv and the cwd (`--workspace`), not the IDE.
 *  - attestation   — the run is a normal lane run: `task.started` → stdout →
 *                    `task.completed`, recorded like every other lane.
 *  - approval      — nothing to approve: the invocation is `--mode plan`, which
 *                    Cursor itself defines as "read-only/planning, no edits".
 *  - cancellation  — the run is an ordinary child process, so the AbortSignal
 *                    the runner already threads terminates it.
 *  - artifact      — a verdict on stdout, never a patch.
 *
 * Anything WIDER is still refused. A write role is refused up front, and the
 * argv is guarded categorically so no composition path can smuggle a
 * permission-widening Cursor flag past the boundary.
 */

/** The read-only crew roles managed Cursor may hold. */
export const CURSOR_READ_ONLY_ROLES = [
  "reviewer",
  "qa",
  "architect",
  "scout",
] as const satisfies readonly AgentRole[];

const CURSOR_ROLE_SET: ReadonlySet<string> = new Set(CURSOR_READ_ONLY_ROLES);

/** Shown in health, and the refusal message for any role outside the slice. */
export const CURSOR_READ_ONLY_SCOPE =
  "Managed for read-only review roles only (reviewer, qa, architect, scout): MUON runs `cursor-agent --print --mode plan`, which never edits the workspace.";

/** The exact recovery when no agent CLI is on PATH. */
export const CURSOR_INSTALL_HINT =
  "Install the Cursor agent CLI (`curl https://cursor.com/install -fsS | bash`).";

/**
 * The exact recovery when the CLI is installed but signed out. BYO-auth: MUON
 * never custodies a Cursor token, so this is a human action, never something the
 * adapter performs.
 */
export const CURSOR_AUTH_REQUIRED =
  "Cursor is not authenticated. Run `cursor-agent login`, or set CURSOR_API_KEY.";

/** Fail-closed text when the auth probe itself could not run. */
export const CURSOR_AUTH_UNKNOWN =
  "Cursor authentication could not be confirmed; refusing to report this lane as ready.";

/** Bounded budget for the auth probe: short, it is a status command. */
export const CURSOR_AUTH_PROBE_TIMEOUT_MS = 2500;

/**
 * Bounded budget for the targeted MCP approval (TODO 1.12). Measured at 0.48s
 * on cursor-agent 2026.07.23 for both the first approval and the idempotent
 * re-approval, so this is ~10× headroom. It is deliberately NOT generous: the
 * approval is best-effort and a slow one must not hold up the review.
 */
export const CURSOR_MCP_APPROVE_TIMEOUT_MS = 5000;

/**
 * One bounded line of a vendor CLI's own output, for a control-plane message.
 * Bounded because the text lands in an event a human reads and a parser scans.
 */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "")
    .trim()
    .slice(0, 200);
}

/**
 * Cursor flags that WIDEN authority past the read-only slice. `--force`/`-f` and
 * its `--yolo` alias run everything unless explicitly denied; `--auto-review`
 * hands the decision to a server-side classifier; `--approve-mcps` blanket-
 * approves every MCP server. None of them may ever appear on a MUON-managed
 * Cursor argv, from ANY source: the invocation, a compiled profile
 * (`compileCursorProfile` still emits `--force` for the unmanaged paths),
 * `extraArgs`, or a per-run argv override.
 *
 * Kept in sync with `VENDOR_REGISTRY.cursor.execution.guards.wideningFlags` by
 * `packages/adapters/tests/cursor-adapter.test.ts` (protocol cannot import
 * adapters, so agreement is asserted rather than shared). EXPORTED for that
 * assertion's benefit only: the check used to run in one direction (declared ⇒
 * stripped) over a registry list that had fallen twelve flags behind this set,
 * and a one-directional drift-lock is how the two drifted in the first place.
 * Nothing outside the guard and its test should read it — `stripCursorWideningArgs`
 * is the behaviour.
 */
export const CURSOR_WIDENING_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "--force",
  "--yolo",
  "--auto-review",
  "--approve-mcps",
  // TODO 1.16 added the rest. The first audit read `cursor-agent --help` and
  // missed most of them, because this vendor `hideHelp()`s several of its most
  // dangerous options — including the one flag that turns off the very file the
  // rest of MUON's cursor posture is written into. The list below was re-derived
  // from the shipped bundle's own option registrations (2026.07.23-e383d2b), which
  // is the only complete source.
  //
  // ATTACH surface — widen by relocating or extending the run, not by loosening a
  // permission, which is why they read like preferences:
  //  - `--plugin-dir <path>` "Load a local plugin directory": arbitrary local code
  //    inside the governed review, the same class of hole finding 1.8 closed for
  //    opencode's global plugin dir. Read-only mode constrains the AGENT's tools;
  //    it says nothing about what a plugin does in-process.
  //  - `-w`/`--worktree [name]` starts the run in
  //    `~/.cursor/worktrees/<repo>/<name>` instead of the cwd MUON prepared. Cursor
  //    resolves `.cursor/cli.json` by walking UP FROM CWD, so relocating the run
  //    walks away from MUON's permission table and lands on whatever policy that
  //    other tree carries. It does not lose isolation, it DISARMS the deny table.
  //  - `--worktree-base <branch>` only ever accompanies the above; listed so a
  //    stripped pair can never leave its value behind.
  "--plugin-dir",
  "-w",
  "--worktree",
  "--worktree-base",
  // HIDDEN (`.hideHelp()`), and the reason the audit method changed:
  //  - `--disable-project-configs` is literally "Ignore .cursor/cli.json files in
  //    the current project" — the undo of MUON's own permission write. It is read
  //    straight off `process.argv` (not through the option parser), and it accepts
  //    `=true`/`=false`, so the inline spelling has to be caught too.
  //  - `-e`/`--endpoint`, `--agent-endpoint` and `--base-url` retarget the run at
  //    another server: unreviewed egress of the whole diff.
  //  - `--auth-token`, `--api-key` put a credential ON ARGV, readable by any local
  //    process via `ps`, which is the exact vector S2 exists to close.
  //  - `-H`/`--header` injects arbitrary headers into agent requests.
  //  - `-k`/`--insecure` ("Allow insecure HTTPS connections") and `--http-version`
  //    weaken the transport under it.
  "--disable-project-configs",
  "-e",
  "--endpoint",
  "--agent-endpoint",
  "--base-url",
  "--auth-token",
  "--api-key",
  // `-H`, capital, is cursor's short for `--header`. `-h` is help and is NOT here.
  "-H",
  "--header",
  "-k",
  "--insecure",
  "--http-version",
  // TODO 2.6 — `--trust` IS DELIBERATELY ABSENT, and this is the note that keeps
  // it from being re-opened off the help text a third time. See the answered
  // question at `taskCommand` for the measurements; the short version is that
  // stripping it would not narrow this lane, it would DELETE it: a
  // non-interactive cursor run in an untrusted directory refuses to start at
  // all, and MUON's own managed argv is where the flag comes from.
]);

/**
 * The widening flags that CONSUME THE FOLLOWING TOKEN.
 *
 * A stray value token is not cosmetic: Cursor reads bare positionals as PROMPT
 * TEXT, so a dropped flag whose value survived would splice a path — or a
 * credential — into the prompt.
 *
 * `--disable-project-configs`, `--network` and `-k`/`--insecure` are booleans and
 * are deliberately absent.
 *
 * `--skip-worktree-setup` is not stripped at all: declining to run a repo's own
 * setup SCRIPTS is the safe direction, the same asymmetry as `--sandbox enabled`
 * vs `disabled`.
 */
const CURSOR_VALUE_TAKING_WIDENING_FLAGS: ReadonlySet<string> = new Set([
  "--plugin-dir",
  "-w",
  "--worktree",
  "--worktree-base",
  "-e",
  "--endpoint",
  "--agent-endpoint",
  "--base-url",
  "--auth-token",
  "--api-key",
  "-H",
  "--header",
  "--http-version",
]);

/**
 * THE SHORT FLAGS, AND WHY THIS SET IS NOT DERIVED FROM THE ONE ABOVE.
 *
 * Cursor's argv parser is commander with `combineFlagAndOptionalValue` left on,
 * which means a single-dash token is a CLUSTER, not a name. Measured against the
 * shipped bundle's own expansion: `-fw` becomes `--force` AND `--worktree`;
 * `-wescape` becomes `--worktree escape`; `-fp` becomes `--force --print`. A guard
 * that compares whole tokens sees none of those — `-fw` is not `-f` — so the
 * widening list was bypassable by three characters until this existed.
 *
 * So the guard expands clusters the way the vendor does. Two rules follow from
 * commander's own behaviour:
 *  - a cluster containing ANY widening short is removed WHOLE. Its benign
 *    companions go with it, which is a narrowing and therefore always safe; MUON
 *    never emits a clustered short itself, so nothing legitimate is in one.
 *  - the following token is consumed only when the cluster ENDS with a
 *    value-taking widening short. If the short sits earlier, commander has already
 *    read the remainder as its inline value (`-wescape`), and the next token
 *    belongs to whatever comes after.
 */
const CURSOR_WIDENING_SHORT_FLAGS: ReadonlySet<string> = new Set([
  "f",
  "w",
  "e",
  "k",
  "H",
]);

/**
 * Commander treats a token as a possible option when it is longer than one
 * character and starts with `-`. A LONE `-` is therefore a VALUE to it, and so it
 * must be to MUON: leaving it behind after stripping `-w` would hand cursor a
 * stray positional, i.e. prompt text. `-5` is flag-shaped by the same rule and is
 * left alone.
 */
function cursorTokenIsOptionShaped(token: string): boolean {
  return token.length > 1 && token.startsWith("-");
}

/**
 * The widening decision for one raw argv token, expanded the way cursor expands
 * it. `consumesNext` is only ever true when the flag takes a value and none was
 * supplied inline.
 */
function classifyCursorWideningArg(arg: string): {
  widening: boolean;
  consumesNext: boolean;
  /** What survives, for a CLUSTER that mixed widening and innocent shorts. */
  rewritten?: string;
} {
  const inline = arg.includes("=");
  const bare = arg.split("=")[0]!.trim();
  // Long flags are matched case-insensitively; SHORT flags are not, because
  // cursor's own short vocabulary is case-SIGNIFICANT (`-H` is `--header`, `-h` is
  // help). So both spellings are tried and neither is normalized away.
  const named = (set: ReadonlySet<string>, token: string) =>
    set.has(token) || set.has(token.toLowerCase());
  if (named(CURSOR_WIDENING_FLAGS, bare)) {
    return {
      widening: true,
      consumesNext:
        !inline && named(CURSOR_VALUE_TAKING_WIDENING_FLAGS, bare),
    };
  }
  // A CLUSTER (`-fw`), which is how a set lookup on the whole token was bypassed:
  // commander expands `-fw` into `-f -w`, so `-fw` matched nothing, was kept, and
  // handed cursor both `--force` and a relocating `--worktree`.
  //
  // Scanned on the RAW token, `=` included. Excluding inline forms was a second,
  // narrower version of the same bug: cursor's bundle sets
  // `_combineFlagAndOptionalValue`, so `-fw=escape` really does parse as
  // `{force: true, worktree: "=escape"}` — a four-character token delivering both
  // a blanket allow and a relocation out of the cwd whose `.cursor/` holds MUON's
  // entire posture.
  //
  // Commander's grammar decides where the scan STOPS: at the first short that
  // takes a value, the remainder of the token IS that value, so nothing after it
  // is a flag and nothing after it may be read as one.
  //
  // The shape is deliberately tighter than `/^-[^-]/`: a markdown bullet brief
  // (`- fix the parser`) starts with `-` + space and must remain prompt text,
  // not a short-flag cluster. Only contiguous alphanumerics (optionally with an
  // inline `=value`) are clusters commander would expand.
  if (/^-[A-Za-z0-9]+(?:=.*)?$/.test(arg) && arg.length > 2) {
    // Only the FLAG part is scanned. Everything from `=` on is a value bound to
    // whichever flag preceded it, and a cluster carrying an inline value is dropped
    // whole rather than rebuilt: there is no way to hand the value to the surviving
    // flag without guessing which one owned it, and `-fp=1` rebuilt as `-p=1` would
    // be an argv commander rejects outright. The long form (`--print
    // --worktree=x`) is unaffected, so nothing legitimate needs this.
    const chars = [...(inline ? bare : arg).slice(1)];
    const survivors: string[] = [];
    let dropped = false;
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      const widening = CURSOR_WIDENING_SHORT_FLAGS.has(char);
      const takesValue = named(CURSOR_VALUE_TAKING_WIDENING_FLAGS, `-${char}`);
      if (widening && takesValue) {
        // The rest of the token is this flag's value, so the flag and its value
        // both go. `consumesNext` only when the value was NOT supplied inline.
        return {
          widening: true,
          consumesNext: !inline && index === chars.length - 1,
          ...(survivors.length > 0 && !inline
            ? { rewritten: `-${survivors.join("")}` }
            : {}),
        };
      }
      if (widening) {
        dropped = true;
        continue;
      }
      if (takesValue) {
        // An innocent value-taking short: everything from here on belongs to it,
        // so it is carried through verbatim rather than re-scanned.
        const tail = chars.slice(index).join("");
        return dropped
          ? {
              widening: true,
              consumesNext: false,
              rewritten: `-${survivors.join("")}${tail}`,
            }
          : { widening: false, consumesNext: false };
      }
      survivors.push(char);
    }
    if (dropped) {
      // The cluster is REBUILT without the widening characters rather than dropped
      // whole: dropping it would silently take the innocent shorts with it (`-pf`
      // would lose `--print`, turning a governed one-shot into something else), and
      // a guard that breaks legitimate runs is a guard someone turns off.
      return {
        widening: true,
        consumesNext: false,
        ...(survivors.length > 0 && !inline
          ? { rewritten: `-${survivors.join("")}` }
          : {}),
      };
    }
  }
  return { widening: false, consumesNext: false };
}

/**
 * `--sandbox` is only widening when it DISABLES the sandbox; `--sandbox enabled`
 * is the safe direction and is kept. The value may arrive inline (`--sandbox=x`)
 * or as the following token, so both forms are handled.
 */
const CURSOR_SANDBOX_FLAG = "--sandbox";
const CURSOR_FORBIDDEN_SANDBOX_VALUE = "disabled";

/**
 * Strip every authority-widening Cursor flag from an argv. Categorical by
 * construction: a new path into the argv is covered without a new call site.
 */
export function stripCursorWideningArgs(args: readonly string[]): {
  args: string[];
  removed: string[];
} {
  const kept: string[] = [];
  const removed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    // Trailing prompt text is never a flag cluster. Bullet briefs (`- fix …`)
    // and any whitespace-bearing positional must survive intact — cursor reads
    // bare positionals as the prompt, and eating letters from them is a silent
    // corruption of MUON's own managed argv.
    if (index === args.length - 1 && (arg === "-" || /\s/.test(arg))) {
      kept.push(arg);
      continue;
    }
    const bare = arg.split("=")[0]!.trim().toLowerCase();
    const widening = classifyCursorWideningArg(arg);
    if (widening.widening) {
      removed.push(arg);
      if (widening.rewritten) kept.push(widening.rewritten);
      if (
        widening.consumesNext &&
        args[index + 1] !== undefined &&
        !cursorTokenIsOptionShaped(args[index + 1]!)
      ) {
        removed.push(args[index + 1]!);
        index += 1;
      }
      continue;
    }
    if (bare === CURSOR_SANDBOX_FLAG) {
      const inlineValue = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : undefined;
      const value = (inlineValue ?? args[index + 1] ?? "").trim().toLowerCase();
      if (value === CURSOR_FORBIDDEN_SANDBOX_VALUE) {
        removed.push(arg);
        if (inlineValue === undefined) {
          // Drop the value token with its flag; leaving it would become a
          // stray positional (Cursor reads positionals as the prompt).
          removed.push(args[index + 1] ?? "");
          index += 1;
        }
        continue;
      }
    }
    kept.push(arg);
  }
  return { args: kept, removed };
}

/** Raised when a write-class role is pointed at the read-only Cursor lane. */
export class CursorRoleRefusedError extends Error {
  readonly role: AgentRole;

  constructor(role: AgentRole) {
    super(`Cursor cannot hold the '${role}' role. ${CURSOR_READ_ONLY_SCOPE}`);
    this.name = "CursorRoleRefusedError";
    this.role = role;
  }
}

/** True when managed Cursor may hold this role. */
export function cursorSupportsRole(role: AgentRole): boolean {
  return CURSOR_ROLE_SET.has(role);
}

/**
 * Fail closed on a NAMED write role. An UNNAMED role is not a write role, and
 * the invocation itself is unconditionally read-only (`--mode plan`, widening
 * flags stripped), so an unlabelled run still cannot mutate the workspace —
 * the enforcement is the argv, not the label.
 */
function assertCursorRole(role: AgentRole | undefined): void {
  if (role === undefined) {
    return;
  }
  if (!cursorSupportsRole(role) || !isReadOnlyRole(role)) {
    throw new CursorRoleRefusedError(role);
  }
}

/** The crew role a caller is running this lane as, when it knows one. */
type CursorRoleInput = { role?: AgentRole };

/**
 * `cursor-agent --print --output-format json` returns a JSON body per run. The
 * exact shape is NOT contractually pinned by Cursor, so `parsed` means only
 * "stdout really was JSON" and `text` is filled in only when a text-bearing
 * field is recognised. We DEGRADE to raw stdout rather than invent a schema: an
 * unknown shape must never become a fabricated review verdict.
 */
export type CursorPrintResult = {
  /** stdout parsed as JSON — the shape `--output-format json` promises. */
  parsed: boolean;
  /** The reviewer's text, when a text-bearing field was recognised. */
  text?: string;
};

const CURSOR_TEXT_FIELDS = ["result", "text", "response", "content"] as const;

export function parseCursorPrintResult(stdout: string): CursorPrintResult {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { parsed: false };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { parsed: false };
  }
  // `--output-format json` may wrap the run in an array of messages; the last
  // text-bearing object is the final answer.
  const candidates = Array.isArray(payload) ? [...payload].reverse() : [payload];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    for (const field of CURSOR_TEXT_FIELDS) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return { parsed: true, text: value };
      }
    }
  }
  return { parsed: true };
}

/**
 * `cursor-agent --print` exits 0 EVEN WHEN IT FAILS — a signed-out run prints
 * `Error: Authentication required. …` and still returns rc=0 (verified against
 * the live CLI). Trusting the exit code would turn "logged out" into a silent,
 * empty review verdict, which for a governance product is the worst possible
 * failure mode. So a managed run is judged on its BODY: an `Error:` line, an
 * empty body, or a body that is not the JSON `--output-format json` promised is
 * a FAILED run. Returns the failure reason, or undefined when the run is sound.
 */
export function detectCursorRunFailure(result: {
  output: string;
  errorOutput: string;
}): string | undefined {
  const stdout = result.output.trim();
  // The verified signed-out failure prints `Error: …` on STDOUT and still exits
  // 0. Only stdout is scanned: a valid JSON body is a sound run no matter what
  // informational noise a vendor writes to stderr.
  const errorLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^error:/i.test(line));
  if (errorLine) {
    return errorLine.slice(0, 300);
  }
  if (stdout.length === 0) {
    // Nothing on stdout: surface stderr's first line so the reason is actionable.
    const stderrLine = result.errorOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return stderrLine
      ? `Cursor returned an empty result: ${stderrLine.slice(0, 240)}`
      : "Cursor returned an empty result; the review did not run.";
  }
  if (!parseCursorPrintResult(stdout).parsed) {
    return "Cursor returned a non-JSON body for `--output-format json`; refusing to read it as a review verdict.";
  }
  return undefined;
}

/** Injectable seams so the adapter's tests never spawn the real Cursor CLI. */
export type CursorAdapterOptions = {
  /** Resolves whether the installed CLI can authenticate. Never throws. */
  probeAuth?: () => Promise<{ authenticated: boolean }>;
  /** Bounded wall-clock budget for the auth probe. */
  authProbeTimeoutMs?: number;
  /**
   * Runs the targeted `mcp enable` (TODO 1.12). Injectable so tests never spawn
   * a vendor binary; defaults to the shared bounded runner.
   */
  execApprove?: ProbeExec;
  /** Bounded wall-clock budget for the targeted MCP approval. */
  mcpApproveTimeoutMs?: number;
  /**
   * TODO 1.15's disclosure seam. The user-global claude hook file cursor replays
   * lives under the operator's real home, so a test that read the true one would
   * pass or fail on whatever that machine happens to have installed.
   */
  homeDir?: string;
  readTextFile?: (path: string) => string;
};

export class CursorAdapter extends BaseLaneAdapter {
  readonly id = "cursor";
  readonly displayName = "Cursor";
  readonly provider = "cursor";
  readonly role = "worker" as const;
  // The AGENT CLI only. The bare `cursor` IDE launcher has no headless agent
  // surface, so it must not satisfy a dispatchable lane's health check.
  readonly commandCandidates = ["cursor-agent", "agent"];

  readonly laneCapabilities: LaneCapabilities = {
    // `--output-format stream-json` streams; MUON's managed review takes the
    // one-shot `json` form, but the vendor capability is real either way.
    canStreamEvents: true,
    // An ordinary child process: the runner's AbortSignal terminates it.
    canInterrupt: true,
    // `--print` is fully non-interactive, so it can run unattended.
    canBackground: true,
    // No session driver and no `canUseTool` interpose, so MUON cannot interpose
    // on a Cursor approval prompt. Read-only roles do not require one.
    supportsApprovals: false,
    // TODO 2.1: MUON already points Cursor at a MUON-managed worktree via
    // `--workspace <cwd>` (see runTask argv below). That is the capability
    // `supportsWorktrees` names. Cursor's separate `-w/--worktree` (under
    // `~/.cursor/worktrees`) remains ungoverned and must stay off MUON's argv
    // — it is NOT what this boolean means. `implementer` still requires
    // `supportsWorktrees`; Cursor stays off that seat via `supportedRoles`
    // (governance decision 2.2), not via a false capability label.
    supportsWorktrees: true,
  };

  /** The read-only slice, and nothing wider. */
  readonly supportedRoles: readonly AgentRole[] = CURSOR_READ_ONLY_ROLES;

  /**
   * Cursor's strength is reading an existing codebase and judging a diff, which
   * is why the read-only reviewer is the slice worth managing at all. It ranks
   * just under the frontier lanes on adjudication because MUON cannot interpose
   * on its approvals, and highest of all lanes on `scout`, where a fast
   * repo-aware answer beats a deeper model.
   */
  readonly roleAffinity: Partial<Record<AgentRole, number>> = {
    reviewer: 0.78,
    qa: 0.7,
    architect: 0.72,
    scout: 0.8,
  };

  private readonly options: CursorAdapterOptions;

  constructor(options: CursorAdapterOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Three honest states, never two:
   *   1. no agent CLI on PATH          → unavailable + how to install it
   *   2. CLI present but signed out    → unavailable + how to sign in. NOT
   *      `degraded`: a dispatch would fail, so anything but `unavailable`
   *      would be a promise MUON cannot keep.
   *   3. CLI present and authenticated → healthy, scoped to read-only review
   * A probe that cannot run at all falls into (2)'s shape with the UNKNOWN text:
   * an adapter that is not sure it is available reports unavailable.
   *
   * The auth detail is deliberately generic. Job-facing readiness strips account
   * identity; the operator-only readiness surface owns provenance.
   */
  override async health(): Promise<LaneHealth> {
    const detected = await super.health();
    if (detected.status === "unavailable") {
      return {
        status: "unavailable",
        details: [...detected.details, CURSOR_INSTALL_HINT],
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
          probeFailed ? CURSOR_AUTH_UNKNOWN : CURSOR_AUTH_REQUIRED,
        ],
      };
    }

    return {
      status: "healthy",
      details: [
        ...detected.details,
        CURSOR_READ_ONLY_SCOPE,
        ...this.foreignHookDetails(),
      ],
    };
  }

  /**
   * TODO 1.15: the hook surface MUON cannot close, disclosed on the surface an
   * operator already reads to judge this lane.
   *
   * Still `healthy`, deliberately. The three states above are about whether a
   * dispatch would WORK, and this one would; downgrading to `degraded` for a
   * condition present on most developer machines would train the operator to
   * ignore the field. But it cannot be silent either: cursor executes
   * `~/.claude/settings.json`'s hooks on every governed run, MUON's run-scoped
   * write cannot reach a user-global path, and the only lever that would move it
   * is `$HOME` — which is where cursor's own credentials live, so redirecting it
   * trades a hook leak for a lane that cannot authenticate.
   *
   * The wording names the vendor confusion rather than just the file, because that
   * is the part an operator will not otherwise predict: the handlers found on this
   * machine were hardcoded to claude (`git-ai checkpoint claude`,
   * `SUPERSET_AGENT_ID=claude`), and cursor exports `CLAUDE_PROJECT_DIR` on every
   * hook exec, so the attribution is wrong in the tool's own records.
   */
  private foreignHookDetails(): string[] {
    const exposure = cursorForeignHookExposure(
      this.options.homeDir ?? homedir(),
      this.options.readTextFile ?? ((target) => readFileSync(target, "utf8"))
    );
    if (!exposure) return [];
    return [
      `cursor also runs Claude Code's hooks from ${exposure.path} (${exposure.events.join(", ")}) — MUON cannot scope a user-global file, and those handlers see this run as claude`,
    ];
  }

  /**
   * BYO-auth: we only READ the vendor CLI's own status (and any trusted
   * CURSOR_API_KEY provider evidence) through the shared readiness probe. No
   * token is returned, logged, or stored, and nothing is ever written.
   */
  private async probeAuth(): Promise<{ authenticated: boolean }> {
    if (this.options.probeAuth) {
      return this.options.probeAuth();
    }
    return probeVendorReadiness("cursor", {
      timeoutMs: this.options.authProbeTimeoutMs ?? CURSOR_AUTH_PROBE_TIMEOUT_MS,
    });
  }

  override async startSession(
    input: LaneSessionInput & CursorRoleInput
  ): Promise<{ sessionId: string }> {
    assertCursorRole(input.role);
    return super.startSession(input);
  }

  override async submitTask(
    input: LaneTaskSubmission & CursorRoleInput
  ): Promise<void> {
    assertCursorRole(input.role);
    return super.submitTask(input);
  }

  override async runTask(
    input: LaneTaskSubmission & CursorRoleInput,
    onEvent: (event: LaneEvent) => void,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      profile?: LaneProfile;
      argvOverride?: { command?: string; args: string[] };
      /** Live stderr sink (see BaseLaneAdapter); forwarded with the options. */
      onDiagnostic?: (chunk: string) => void;
    }
  ): Promise<LaneCommandResult> {
    assertCursorRole(input.role);
    const narrowed = {
      ...options,
      ...(options?.profile
        ? { profile: narrowCursorProfile(options.profile) }
        : {}),
    };

    // Compile → APPROVE → spawn, rather than `super.runTask`, because the
    // targeted approval has to land BETWEEN the two: `compileRunProfile` is what
    // writes `.cursor/mcp.json`, and cursor resolves the approval from that file.
    const invocation = this.resolveInvocation(input, narrowed);
    this.assertLaneBinaryAvailable(invocation.command);
    const compiled = this.compileRunProfile(input, onEvent, narrowed);
    // The approval sits between the compile and the spawn, so anything it throws
    // is a throw AFTER the config was written. `withRestoredConfig` around both
    // keeps the human's checkout clean on that path too; `spawnCompiledRun`
    // restoring again is a no-op, since the hold is released once.
    const result = await this.withRestoredConfig(compiled.restoreConfig, async () => {
      await this.approveGovernedMcpServer(input, onEvent, narrowed, compiled.env);
      return this.spawnCompiledRun(
        input,
        onEvent,
        narrowed,
        invocation,
        compiled
      );
    });

    // Body-based verdict, only for OUR fixed invocation: an argv override may
    // legitimately ask for a different output format, and judging that body
    // against the JSON contract would be wrong.
    if (!options?.argvOverride) {
      const failure = detectCursorRunFailure(result);
      if (failure) {
        this.emit(onEvent, input.taskId, "task.blocked", failure, {
          cursorReviewFailed: true,
        });
        return {
          ...result,
          // rc=0 accompanies the auth failure, so the exit code is corrected
          // here rather than letting an empty review land as `done`.
          exitCode: result.exitCode === 0 ? 1 : result.exitCode,
          errorOutput: result.errorOutput || failure,
        };
      }
    }

    const parsed = parseCursorPrintResult(result.output);
    if (parsed.text) {
      this.emit(onEvent, input.taskId, "task.progress", parsed.text, {
        cursorReviewResult: true,
      });
    }
    return result;
  }

  /**
   * TODO 1.12: approve MUON's OWN governed MCP server, by name, for this run.
   *
   * WHY IT IS NEEDED AT ALL. `compileCursorProfile` writes `.cursor/mcp.json`
   * into the run cwd, and a PROJECT-scoped cursor MCP server does not load until
   * it is approved — measured on cursor-agent 2026.07.23: a freshly written
   * project file reports `muon: not loaded (needs approval)`, and after
   * `mcp enable muon` the same `mcp list` attempts the connection. (A USER-scope
   * entry in `~/.cursor/mcp.json` loads untouched, which is why `muon mcp
   * install` never had to discover this.) So without this call the managed lane
   * writes a brain it never gets.
   *
   * WHY TARGETED, NOT `--approve-mcps`. The blanket flag approves every server
   * in the file and is stripped as widening from every source, MUON's own
   * compiler included. `mcp enable <identifier>` is cursor's own first-class
   * targeted approval ("Add an MCP server to the local approved list").
   *
   * WHY ONLY THE GOVERNED NAME. `narrowCursorProfile` does not filter
   * `mcpServers`, so a caller-supplied profile can carry a third-party server,
   * and an MCP entry is arbitrary command execution. Approving whatever the
   * profile happens to name would make this call a widening. It approves exactly
   * `GOVERNED_MCP_SERVER_NAME` and says out loud which other servers were left
   * unapproved — they stay in the file and stay unloaded, which is the correct
   * outcome, but silence about it is not.
   *
   * WHY BEST-EFFORT. A review without the brain is degraded, not unsafe, so an
   * approval failure must not cost the whole dispatch. It IS reported as a
   * control-plane event: the 1.7 review's finding was that a silent drop is the
   * defect, not the drop.
   *
   * The rc is deliberately ignored as evidence: `mcp enable ghost` for a name
   * that is not in the file exits **0** while printing "not found in
   * configuration" (measured). The OUTPUT is the evidence, never the code.
   */
  private async approveGovernedMcpServer(
    input: LaneTaskSubmission,
    onEvent: (event: LaneEvent) => void,
    options: { cwd?: string; profile?: LaneProfile } | undefined,
    /** The compiled child env (S2-hoisted MCP values) — the connection probe
     *  below must start the governed server with the env the real run gets. */
    compiledEnv?: Record<string, string>
  ): Promise<void> {
    const servers = options?.profile?.mcpServers ?? [];
    if (servers.length === 0) return;

    const foreign = servers
      .map((server) => server.name)
      .filter((name) => name !== GOVERNED_MCP_SERVER_NAME);
    if (foreign.length > 0) {
      this.emit(
        onEvent,
        input.taskId,
        "task.progress",
        `profile: mcp server(s) ${foreign.join(", ")} are written to .cursor/mcp.json but NOT approved — cursor will not load them (MUON approves only its own governed '${GOVERNED_MCP_SERVER_NAME}' server, because an MCP entry is arbitrary command execution)`,
        { controlPlane: true, cursorMcpUnapproved: foreign.join(",") }
      );
    }
    if (!servers.some((server) => server.name === GOVERNED_MCP_SERVER_NAME)) {
      return;
    }

    const exec = this.options.execApprove ?? runBoundedVendorCommand;
    const timeoutMs =
      this.options.mcpApproveTimeoutMs ?? CURSOR_MCP_APPROVE_TIMEOUT_MS;
    // The LANE's own CLI, deliberately not `invocation.command`: a per-run
    // argvOverride may legitimately point the review at something else (the
    // tests use `echo`), and `mcp enable` is a cursor-agent subcommand — running
    // it on whatever the override named would be both meaningless and a second,
    // unnecessary place an override chooses a binary MUON spawns.
    const command = this.getAvailableCommand() ?? this.commandCandidates[0]!;
    // Deny-first lane filter — same control as the review child. Without this,
    // `runBoundedVendorCommand` inherits full `process.env` and the approval
    // spawn sees runner lease / agent / operator tokens plus foreign vendor keys.
    //
    // WITH the compiled S2 env, measured against ~/.cursor/projects/<slug>/
    // mcp-approvals.json (2026-08-06): cursor's approved list stores
    // `<name>-<content-hash>` over the RESOLVED server config — `${env:VAR}`
    // references expanded from the invoking process env. Approving with the
    // bare lane env resolved a different content than the session (which gets
    // the compiled values), so `mcp enable` reported "✓ Enabled and approved"
    // and `mcp list-tools` immediately answered "has not been approved" — the
    // reviewer ran 74s with a brain it was told it had. The approval must be
    // granted under the SAME identity the session will present.
    const env = buildLaneEnvironment(this.id, process.env, compiledEnv);
    let outcome: string;
    try {
      const result = await exec(
        command,
        ["mcp", "enable", GOVERNED_MCP_SERVER_NAME],
        timeoutMs,
        // The approvals file is keyed on the project root cursor resolves from
        // cwd, so this MUST run in the same cwd as the review itself.
        {
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          env,
        }
      );
      const said = firstLine(result.stdout) || firstLine(result.stderr);
      outcome =
        said ||
        `no output (exit ${result.status ?? "unknown"}${
          result.error ? `: ${result.error.message}` : ""
        })`;
    } catch (error) {
      // The bounded runner never rejects; this is belt-and-braces so a future
      // injected exec cannot turn an approval hiccup into a lost dispatch.
      outcome = error instanceof Error ? error.message : String(error);
    }
    // Vendor stdout is untrusted and can echo ambient state; shape-redact before
    // it lands in a durable control-plane event (adapters cannot import
    // @muon/core's redactSecrets — core depends on adapters).
    const safeOutcome = boundedProviderFailure(outcome, 200);
    this.emit(
      onEvent,
      input.taskId,
      "task.progress",
      `mcp: \`${command} mcp enable ${GOVERNED_MCP_SERVER_NAME}\` → ${safeOutcome}`,
      { controlPlane: true, cursorMcpApproval: safeOutcome }
    );

    // Mission 420c8bf4: approval alone is NOT evidence the brain is reachable.
    // The reviewer's server was "✓ Enabled and approved" and the session still
    // ran 74 seconds with ZERO governed tool calls, reporting the tools absent
    // — nothing on the control plane could say why. So ask cursor ITSELF
    // whether the governed server actually serves tools, in the same env the
    // approval above was granted under. Best-effort like the enable — a dead
    // brain degrades the review, it must not cost the dispatch — but the
    // answer is a durable event instead of a model's unverifiable prose.
    const verifyEnv = env;
    let connect: string;
    try {
      const result = await exec(
        command,
        ["mcp", "list-tools", GOVERNED_MCP_SERVER_NAME],
        timeoutMs,
        {
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          env: verifyEnv,
        }
      );
      const said = firstLine(result.stdout) || firstLine(result.stderr);
      connect =
        said ||
        `no output (exit ${result.status ?? "unknown"}${
          result.error ? `: ${result.error.message}` : ""
        })`;
    } catch (error) {
      connect = error instanceof Error ? error.message : String(error);
    }
    const safeConnect = boundedProviderFailure(connect, 200);
    this.emit(
      onEvent,
      input.taskId,
      "task.progress",
      `mcp: \`${command} mcp list-tools ${GOVERNED_MCP_SERVER_NAME}\` → ${safeConnect}`,
      { controlPlane: true, cursorMcpVerification: safeConnect }
    );
  }

  private emit(
    onEvent: (event: LaneEvent) => void,
    taskId: string,
    kind: LaneEvent["kind"],
    message: string,
    metadata: Record<string, unknown>
  ): void {
    onEvent({
      id: `cursor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      laneId: this.id,
      taskId,
      kind,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * The managed read-only review invocation. Deliberately fixed:
   *   --print               non-interactive (required by --output-format/--trust)
   *   --output-format json  a machine-readable body, not a TTY transcript
   *   --mode plan           Cursor's own read-only/planning mode: no edits
   *   --trust               see the answered question below.
   *   --skip-worktree-setup refuse the REVIEWED REPO's own setup scripts.
   *   --workspace <cwd>     MUON owns the workspace root, not the IDE's notion
   *                         of a "current" project.
   *
   * TODO 2.6 — IS `--trust` A WIDENING FLAG? MEASURED ANSWER: NO, IT IS A
   * PRECONDITION. It stays out of `CURSOR_WIDENING_FLAGS`, and the previous note
   * here ("avoids a prompt that would hang a non-interactive run") was right by
   * accident and too weak to defend the call, so here is what was actually
   * measured against cursor-agent 2026.07.23-e383d2b:
   *
   *  - WITHOUT it, a `--print` run in an *untrusted* directory does not hang and
   *    does not degrade — it REFUSES: "Workspace Trust Required … To proceed …
   *    Run 'agent' interactively to decide / Pass --trust, --yolo, or -f".
   *    Cursor's managed harnesses (`review`, `planner`, `research`,
   *    `security-audit`) are `worktree: false`, so the cwd is the human's real
   *    checkout — not a freshly created MUON worktree. That checkout is usually
   *    already trusted interactively; `--trust` is still required for the *first*
   *    non-interactive run in a folder that has never been trusted. The other two
   *    options cursor offers are `--yolo`/`-f`, which ARE widenings and stay
   *    refused — so `--trust` is precisely the narrow way to satisfy the
   *    precondition.
   *  - It grants no TOOL authority, which is the load-bearing half: the trust
   *    marker is not consulted when `.cursor/cli.json` is loaded (the trust check
   *    has two call sites in the whole bundle, both in worktree-setup), so MUON's
   *    deny table governs either way. `--force`/`--yolo` pass `sessionTrusted`
   *    and DO widen; they are refused.
   *  - It is not `--approve-mcps` in disguise, though the interactive dialog
   *    invites that reading ("This will also enable the MCP servers configured
   *    for this workspace"). Blanket MCP approval hangs off that prompt's
   *    `approved_with_mcp` branch only; the FLAG path never calls it. TODO 1.12's
   *    targeted `mcp enable muon` remains the only MCP grant MUON makes.
   *
   * TWO RESIDUES, named rather than filed away, because "no" here is a narrower
   * answer than "harmless":
   *  1. It writes a DURABLE, user-global marker: `~/.cursor/projects/<slug>/
   *     .workspace-trusted` = `{trustedAt, workspacePath, trustMethod:
   *     "cli-flag"}`, confirmed written by exactly this argv. It outlives the run
   *     and cannot be undone by a run-scoped config restore, so a governed review
   *     raises the trust posture of the human's *own* repository for later
   *     interactive sessions (including the desktop terminal pane — see
   *     `CURSOR_FIRST_RUN_HINT`). Accepted because the alternative is no cursor
   *     lane on first use in an untrusted folder — but it is the reason this flag
   *     is worth a paragraph instead of a word.
   *  2. On cursor's ACP path (which MUON does not use — the registry gives cursor
   *     no session driver) `--trust` additionally marks EVERY workspace directory
   *     trusted, `--add-dir` roots included, and that path does reach the
   *     worktree-setup runner. Latent, not live, and it is why `--add-dir` values
   *     are already fenced.
   *
   * `--skip-worktree-setup` is the new arg, and it is PRE-EMPTIVE rather than a
   * fix: trust gates the `setup-worktree-unix` script a reviewed repo declares in
   * its own `.cursor/worktrees.json`, and the workspace resolver hands the run a
   * setup path unconditionally — but a fixture repo shipping that pair was
   * measured NOT to execute under this exact argv. So the hole was not open. It
   * is asserted shut anyway because the cost is one always-accepted flag, the
   * exposure is arbitrary code from the material under review, and the guard
   * already refuses to strip this flag for exactly that reason.
   */
  /**
   * TODO 1.16: the fan-out hook is not optional, so it does not ride the profile.
   *
   * `cursorMandatoryConfigWrites` carries the SAME `.cursor/hooks.json` the
   * compiler writes, plus an empty `.cursor/cli.json`, so a run with no profile is
   * still a run whose native `Task` is denied and whose permissions are MUON's
   * rather than whatever the checked-out repo committed under `.cursor/`.
   */
  protected override mandatoryConfigWrites() {
    return cursorMandatoryConfigWrites();
  }

  override taskCommand(brief: string, context?: LaneTaskContext) {
    return {
      command: this.getAvailableCommand() ?? this.commandCandidates[0]!,
      args: [
        "--print",
        "--output-format",
        "json",
        "--mode",
        "plan",
        "--trust",
        "--skip-worktree-setup",
        "--workspace",
        context?.cwd ?? process.cwd(),
        brief,
      ],
    };
  }

  /** Categorical last-mile net; see `stripCursorWideningArgs`. */
  protected override guardFinalArgs(args: string[]): string[] {
    return stripCursorWideningArgs(args).args;
  }
}

/**
 * Narrow a caller-supplied profile to what a read-only Cursor review may carry.
 * A second, independent net alongside `guardFinalArgs`: this one stops the
 * widening flag being COMPILED at all, the other stops it being SPAWNED. Neither
 * relies on the other, and neither widens anything.
 */
export function narrowCursorProfile(profile: LaneProfile): LaneProfile {
  return {
    ...profile,
    // `full-auto` is what makes `compileCursorProfile` emit `--force`.
    ...(profile.permissionMode === "full-auto"
      ? { permissionMode: "default" as const }
      : {}),
    // `full-access` is what makes it emit `--sandbox disabled`.
    ...(profile.sandbox === "full-access"
      ? { sandbox: "read-only" as const }
      : {}),
    // Allowed tools are written into the run-scoped `.cursor/cli.json`; a
    // read-only review never needs a write verb there.
    allowedTools: profile.allowedTools.filter((tool) => !isWriteClassTool(tool)),
  };
}
