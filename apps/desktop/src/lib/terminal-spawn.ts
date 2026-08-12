import type { PtySpawnOptions } from "@muon/runner";
import {
  OPERATOR_TOKEN_ENV_VARS,
  codexGuardEnv,
  codexGuardHomePath,
} from "@muon/adapters";
import {
  findCustomAgentById,
  isUngovernedAgentId,
  terminalSafe,
  type UngovernedAgentEntry,
} from "@muon/client";
import {
  terminalTakeoverVendorIds,
  type VendorId,
} from "@muon/client/vendors";
import {
  TERMINAL_FAST_EXIT_MS,
  VENDOR_TERMINAL_COMMANDS,
  type TerminalCommand,
} from "./terminal-vendor-tabs.js";

// Wave 4 review finding 7 (P5 security) — for a REAL pty, the command, args, and
// env must be constructed HOST-side, NEVER taken from renderer input. A renderer
// is untrusted (prompt injection from repo files), so if it could name the
// file/args/env it would be an arbitrary-command surface the moment the echo
// driver is swapped for node-pty. The renderer only sends a KIND (a vendor/shell
// key); the host resolves the rest from this allowlist + its own environment.
//
// This intentionally stays a small allowlist. The host separately maps the
// session id to a chat workspace or dispatch worktree before calling this
// resolver, so no renderer-provided path or command reaches node-pty.

const LOGIN_SHELL =
  process.env.SHELL?.trim() ||
  (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");

// The vendor half of the allowlist now lives in terminal-vendor-tabs.ts
// (renderer-safe), so the vendor tab bar the human clicks and the table this
// host spawns from are ONE record. Its invariants (total over VendorId,
// commandCandidates-only binaries) are documented there.

const TERMINAL_COMMANDS: Readonly<Record<string, TerminalCommand>> = {
  // Trusted main calls fixSpawnPath() before registering terminal IPC, so these
  // fixed allowlisted commands resolve through Homebrew/local/mise paths without
  // sourcing a login profile that could reintroduce stripped authority tokens.
  //
  // WAVE C5 / ADR-0022 G6: which VENDORS appear here is now gated on
  // `authority.terminalTakeover`, and the entry is dropped entirely when that is
  // false. This is a renderer-DRIVEN binary spawn and the renderer is untrusted
  // (prompt injection from repo files), so the gate is an authority read and not
  // a label lookup. Declaring a command above without the authority grants
  // nothing; both must agree.
  ...Object.fromEntries(
    terminalTakeoverVendorIds().flatMap((id) => {
      const command = VENDOR_TERMINAL_COMMANDS[id];
      return command ? [[id, command] as const] : [];
    })
  ),
  // `shell` is NOT a vendor. A plain terminal is the operator's own login shell,
  // which is why it lives outside the registry-gated block above.
  shell: { file: LOGIN_SHELL, args: ["-l"] },
};

/**
 * MUON'S OWN CONTROL-PLANE ENVIRONMENT, NAMED — never derived by a pattern.
 *
 * This used to be `key.startsWith("MUON_") && key.endsWith("_TOKEN")` and
 * nothing else: a forbidden set defined by a SHAPE, over the whole of
 * `process.env`. It happened to be complete, and nothing pinned that. Every
 * neighbouring boundary in this repo states its set positively —
 * `OPERATOR_TOKEN_ENV_VARS` (packages/adapters/src/sandbox/credential-policy.ts)
 * is an explicit list, and `RUNNER_ENV_ALLOWLIST` is a positive allowlist whose
 * own comment says process.env "commonly carries deployment, cloud,
 * package-registry, and database credentials that have nothing to do with a
 * local vendor CLI" — and this repo has broken itself twice on a tier derived
 * by subtraction. `MUON_OPERATOR_TOKEN_KEYCHAIN` (packages/client/src/keychain.ts)
 * is the standing proof the shape rule is not the set: it starts with `MUON_`,
 * it names MUON's own operator-token custody mode, and it does not end in
 * `_TOKEN`.
 *
 * WHY THIS IS A DENY LIST AND NOT AN ALLOWLIST, unlike the runner. ADR-0023 §5
 * decides that a human-owned terminal gets the operator's own ambient
 * environment: it is the same trust boundary as the user opening their own
 * shell, and the vendor CLI must be able to find the credentials the user
 * already has (BYO-auth). An allowlist here would break that posture by
 * design. What must be complete is the set MUON's OWN control plane
 * contributes, and that set is small, ours, and enumerable — so it is
 * enumerated.
 */
const MUON_CONTROL_PLANE_ENV_VARS = [
  // Operator/human authority.
  "MUON_API_TOKEN",
  "MUON_OPERATOR_TOKEN",
  // Where the operator token is custodied. Not a secret itself; it is a
  // pointer at one, it is MUON's own control plane, and a vendor CLI has no
  // use for it. THE NAME THE OLD SHAPE RULE MISSED.
  "MUON_OPERATOR_TOKEN_KEYCHAIN",
  // Agent-tier and delegation capabilities.
  "MUON_AGENT_TOKEN",
  "MUON_DELEGATION_TOKEN",
  // The runner's lease bearer.
  "MUON_RUNNER_LEASE_TOKEN",
  // Operator-owned integration credentials MUON minted or stored.
  "MUON_GITHUB_TOKEN",
  "MUON_GITHUB_REFRESH_TOKEN",
] as const;

/**
 * The names a human terminal NEVER inherits, whatever the kind.
 *
 * PINNED to the shared credential policy: every `MUON_`-prefixed name in
 * `OPERATOR_TOKEN_ENV_VARS` is folded in, so a name added there cannot be
 * missed here. The unprefixed members of that list (`GITHUB_TOKEN`, `GH_TOKEN`)
 * are deliberately NOT folded in — they are the operator's own ambient GitHub
 * authority, which a plain login shell keeps and a vendor kind does not (see
 * `GITHUB_TOKEN_ENV` below). Union, never subtraction: this can only ever
 * strip more.
 */
export const TERMINAL_STRIPPED_ENV_VARS: readonly string[] = [
  ...new Set<string>([
    ...MUON_CONTROL_PLANE_ENV_VARS,
    ...OPERATOR_TOKEN_ENV_VARS.filter((key) => key.startsWith("MUON_")),
  ]),
];

const TERMINAL_STRIPPED_ENV = new Set(TERMINAL_STRIPPED_ENV_VARS);

function isInternalControlPlaneToken(key: string): boolean {
  return (
    // POSITIVE FIRST: the named set is what this boundary claims.
    TERMINAL_STRIPPED_ENV.has(key) ||
    // BACKSTOP, not the rule: a future `MUON_*_TOKEN` that nobody added above
    // is still stripped. It can only ever strip MORE than the list, so it can
    // never be the thing a missing name is quietly judged by.
    (key.startsWith("MUON_") && key.endsWith("_TOKEN"))
  );
}

const GITHUB_TOKEN_ENV = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);

/**
 * How a `custom:<id>` kind resolves to its registered entry. Production
 * always reads the real on-disk store (`findCustomAgentById`, host-side, the
 * SAME read `muon custom-agents list` makes); tests override this seam so
 * they never touch a real `~/.muon`-adjacent data dir.
 */
type CustomAgentLookup = (id: string) => UngovernedAgentEntry | null;
let customAgentLookup: CustomAgentLookup = (id) => findCustomAgentById(id);

/** Test seam: override (or reset with `null`) custom-agent resolution. */
export function setCustomAgentLookup(lookup: CustomAgentLookup | null): void {
  customAgentLookup = lookup ?? ((id) => findCustomAgentById(id));
}

/**
 * The environment forwarded to a CUSTOM (ungoverned) agent's pty — STRICTER
 * than `hostEnv(true)`, the vendor-shell path.
 *
 * A vendor is a registry entry: reviewed, given a `commandCandidates` binary
 * this file resolves against a fixed table, and stripped by the NAMED
 * `TERMINAL_STRIPPED_ENV_VARS` list. A custom agent is an operator-typed
 * binary + argv this host has verified NOTHING about beyond the strings
 * themselves (ROADMAP P7 — no adapter, no readiness probe, no reviewed argv).
 * So it loses EVERY `MUON_`-prefixed name, not only the control-plane subset a
 * vendor CLI keeps clear of — a strictly WIDER strip than the vendor path,
 * never narrower, matching the "the ungoverned tier gets less, never more"
 * rule this whole feature exists to hold. GitHub tokens are stripped for the
 * same reason a vendor shell strips them: an ungoverned binary is not the
 * operator's own login shell.
 */
function hostEnvForCustomAgent(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !key.startsWith("MUON_") &&
      !GITHUB_TOKEN_ENV.has(key)
    ) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The environment forwarded to a real pty: the HOST's env (BYO-auth — the
 * vendor CLI reads its own credentials, exactly as it would in the operator's
 * own shell, ADR-0023 §5), with undefined values and MUON's own control-plane
 * names dropped — `TERMINAL_STRIPPED_ENV_VARS` above, which is a NAMED set and
 * not a pattern. NEVER the renderer-supplied env, and never an
 * operator/agent/delegation/lease bearer.
 */
function hostEnv(stripGitHubTokens: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !isInternalControlPlaneToken(key) &&
      !(stripGitHubTokens && GITHUB_TOKEN_ENV.has(key))
    ) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * THE TWO WAYS A HUMAN TAKES OVER A MUON-DISPATCHED VENDOR SESSION, and the
 * one fact that decides which: whether the governed child is still driving it.
 *
 *  - `resume` — the job has STOPPED. Nothing else holds that transcript, so
 *    the human reopens THE session (`claude --resume <id>`, `codex resume
 *    <id>`) and continues it.
 *  - `fork`   — the job is still RUNNING. Reopening the same session would put
 *    two writers on one transcript, which is why this used to be refused
 *    outright. A FORK is the vendor's own answer to that: `claude --resume
 *    <id> --fork-session` and `codex fork <id>` open the vendor's real
 *    interactive TUI on a COPY of the history so far, under a NEW session id.
 *    The governed child keeps sole ownership of the original, and nothing
 *    typed into the fork can reach it — which is what makes a live takeover a
 *    second, human-owned session rather than a hole in the dispatch gate.
 *
 * MEASURED, not assumed (claude 2.1.220 / codex 0.145.0, this machine): each
 * argv launches the vendor's real TUI, and `codex fork` taken against a
 * session whose `codex exec` child was mid-turn left that child running and
 * its rollout intact.
 *
 * Same trust posture as everything else in this file: the renderer only ever
 * NAMES a takeover kind (`<vendor>:resume`); the session id and the MODE both
 * come from the job record via a HOST-side lookup, the id is re-validated here
 * against the vendors' uuid shape, and the argv is composed from this table —
 * no renderer string ever reaches a command line.
 *
 * TOTAL IN BOTH DIMENSIONS — every VendorId, and every mode within it — for
 * the ADR-0022 §3.4 reason the rest of this codebase keeps its tables total:
 * `null` is a STATEMENT ("this vendor cannot be taken over this way"), so
 * neither a new vendor nor a new mode can acquire argv by being forgotten.
 * Nothing here is derived by subtraction from the other.
 */
export type TerminalTakeoverMode = "resume" | "fork";

const VENDOR_TAKEOVER_COMMANDS: Readonly<
  Record<
    VendorId,
    Readonly<
      Record<TerminalTakeoverMode, ((sessionId: string) => TerminalCommand) | null>
    >
  >
> = {
  "claude-code": {
    resume: (sessionId) => ({ file: "claude", args: ["--resume", sessionId] }),
    // `--fork-session` is claude's own "resume, but under a new session id"
    // (`claude --help`): the original transcript is read, never continued.
    fork: (sessionId) => ({
      file: "claude",
      args: ["--resume", sessionId, "--fork-session"],
    }),
  },
  codex: {
    resume: (sessionId) => ({ file: "codex", args: ["resume", sessionId] }),
    // A separate SUBCOMMAND for codex, not a flag: `codex fork <SESSION_ID>`.
    fork: (sessionId) => ({ file: "codex", args: ["fork", sessionId] }),
  },
  // `cursor-agent` has no session store MUON can name on an argv.
  cursor: { resume: null, fork: null },
  // opencode HAS `--session`/`--continue`/`--fork`, but MUON does not record
  // an opencode session id to hand them (its ids are `ses_…`, outside the
  // uuid contract the backlink column carries). See docs/adr/0025.
  opencode: { resume: null, fork: null },
  fake: { resume: null, fork: null },
};

/**
 * Whether this vendor's dispatched session can be taken over in `mode`.
 *
 * Exported so the ONE decision — "is there a real door here" — is read from
 * the same table the spawn is composed from. The lookup that decides whether
 * to OFFER the affordance (terminal-workspace-resolver.ts) asks this; the
 * spawn resolver below re-derives the command from the same row. A vendor
 * this host has never heard of answers false.
 */
export function vendorSupportsTakeover(
  vendor: string,
  mode: TerminalTakeoverMode
): boolean {
  return (VENDOR_TAKEOVER_COMMANDS[vendor as VendorId]?.[mode] ?? null) !== null;
}

/**
 * The renderer's KIND as it may appear inside a host-authored refusal.
 *
 * `kind` is `spawn.file` — arbitrary renderer text, unbounded, and free to
 * carry ANSI, a bare CR, or a C1 introducer. It is echoed back so the human can
 * see WHICH kind was refused, which is worth keeping; what is not worth keeping
 * is echoing it verbatim into an error frame and into Electron main's stderr,
 * where control bytes repaint the operator's real terminal. `terminalSafe` is
 * the repo's one sanitizer for agent/untrusted text; the length bound is the
 * half it does not do. The refusal PROSE is still entirely the host's.
 */
const MAX_KIND_LABEL_CHARS = 40;

function terminalKindLabel(kind: string): string {
  const flattened = terminalSafe(kind);
  return flattened.length > MAX_KIND_LABEL_CHARS
    ? `${flattened.slice(0, MAX_KIND_LABEL_CHARS)}…`
    : flattened;
}

/** The vendors' actual session-id shape (codex rollout id / claude uuid). */
const VENDOR_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Renderer hint suffix for a resume open: `<vendor>:resume`. */
export const TERMINAL_RESUME_KIND_SUFFIX = ":resume";

export type TerminalResume = {
  /** The job's execution vendor, from the HOST's own job lookup. */
  vendor: string;
  /** The vendor session id, from the job record — never the renderer. */
  sessionId: string;
  /**
   * Continue THE session, or open a fork of it. Required, never defaulted: the
   * mode is an authority statement derived HOST-side from the job's own status
   * (terminal-workspace-resolver.ts), and a default would let a caller that
   * forgot to state it reopen a session a governed child is still driving.
   */
  mode: TerminalTakeoverMode;
};

/**
 * Resolve a validated PtySpawnOptions from an untrusted renderer request. Throws
 * on an unknown kind. `cwd` is host-provided (the resolved worktree), never the
 * renderer's — callers pass the workspace they already validated. `resume` is
 * likewise host-provided (looked up from the job record, MODE included); when
 * present the spawn takes over that exact vendor session — continuing it, or
 * opening a fork of it — instead of starting a fresh one.
 */
export function resolveTerminalSpawn(
  kind: string,
  cwd: string,
  overrides: { cols?: number; rows?: number } = {},
  resume?: TerminalResume
): PtySpawnOptions {
  // ROADMAP P7 — the ungoverned custom-agent tier. `kind` is STILL opaque: the
  // renderer names an id (`custom:<slug>`), the host resolves `command`/`args`
  // from its OWN read of the persisted registry, exactly like every vendor
  // below — never from the IPC payload. Checked before the vendor table
  // because `custom:` ids are never vendor keys (disjoint by construction,
  // `isUngovernedAgentId`/`isVendorId` in `@muon/protocol`), so this branch and
  // the one below can never both claim the same kind.
  if (isUngovernedAgentId(kind)) {
    if (resume) {
      // POSITIVELY no session driver, no vendor session store, and no
      // takeover affordance — a custom agent is terminal-tab-only, one
      // fresh session per click, never resumed or forked.
      throw new Error(
        `terminal kind '${terminalKindLabel(kind)}' is a custom agent and has no resumable/forkable session`
      );
    }
    const entry = customAgentLookup(kind);
    if (!entry) {
      throw new Error(
        `terminal kind '${terminalKindLabel(kind)}' is not a registered custom agent (host resolves the command, never the renderer)`
      );
    }
    return {
      file: entry.command,
      args: [...entry.args],
      cwd,
      env: hostEnvForCustomAgent(),
      ...(overrides.cols !== undefined ? { cols: overrides.cols } : {}),
      ...(overrides.rows !== undefined ? { rows: overrides.rows } : {}),
    };
  }
  if (resume) {
    // The takeover authority gate is the SAME as for a fresh session: resume
    // only resolves for a kind the fresh-session allowlist already admits.
    if (!TERMINAL_COMMANDS[kind]) {
      throw new Error(
        `terminal kind '${terminalKindLabel(kind)}' is not allowed (host resolves the command, never the renderer)`
      );
    }
    if (resume.vendor !== kind) {
      throw new Error(
        `terminal resume vendor '${terminalKindLabel(resume.vendor)}' does not match kind '${terminalKindLabel(kind)}'`
      );
    }
    const buildTakeover =
      VENDOR_TAKEOVER_COMMANDS[kind as VendorId]?.[resume.mode] ?? null;
    if (!buildTakeover) {
      // Named per mode: "cannot be resumed" and "cannot be forked" are
      // different facts about a vendor, and collapsing them would report the
      // wrong one for a job that is still running.
      throw new Error(
        resume.mode === "fork"
          ? `terminal kind '${terminalKindLabel(kind)}' has no forkable vendor session`
          : `terminal kind '${terminalKindLabel(kind)}' has no resumable vendor session`
      );
    }
    if (!VENDOR_SESSION_ID.test(resume.sessionId)) {
      throw new Error(
        "stored vendor session id is not the vendor's uuid shape; refusing to place it on an argv"
      );
    }
    const command = buildTakeover(resume.sessionId.toLowerCase());
    return {
      file: command.file,
      args: [...command.args],
      cwd,
      env: {
        ...hostEnv(true),
        // A MUON-dispatched codex session's rollout lives under the ISOLATED
        // guard home (codex-guard.ts), not ~/.codex — `codex resume` AND
        // `codex fork` both read that store, so both must look where the
        // dispatch actually wrote. Claude sessions key off the cwd, which is
        // already the job's own worktree here.
        ...(kind === "codex" ? codexGuardEnv(codexGuardHomePath()) : {}),
      },
      ...(overrides.cols !== undefined ? { cols: overrides.cols } : {}),
      ...(overrides.rows !== undefined ? { rows: overrides.rows } : {}),
    };
  }
  const command = TERMINAL_COMMANDS[kind];
  if (!command) {
    throw new Error(
      `terminal kind '${terminalKindLabel(kind)}' is not allowed (host resolves the command, never the renderer)`
    );
  }
  return {
    file: command.file,
    args: [...command.args],
    cwd,
    // A plain terminal is the operator's native shell. Vendor terminals are
    // agent processes and must never inherit ambient GitHub authority.
    env: hostEnv(kind !== "shell"),
    ...(overrides.cols !== undefined ? { cols: overrides.cols } : {}),
    ...(overrides.rows !== undefined ? { rows: overrides.rows } : {}),
  };
}

export const TERMINAL_KINDS = Object.keys(TERMINAL_COMMANDS);

/**
 * THE RESPAWN GUARD — a spawn must never be able to re-trigger itself.
 *
 * The hole it closes is structural, not cosmetic. `PtyHost.detach()` REAPS a
 * session whose pty has already exited once its last consumer goes away, and
 * `PtyRelay.open()` is only idempotent while the host still HAS the session.
 * So "the child died, then the port closed" leaves the id unowned, and the
 * very next open of that same id — a tab switch back, a chat switch back, a
 * window reload, any remount of the same pane — silently SPAWNS A SECOND
 * PROCESS under the identity of the first. For a vendor CLI that dies on
 * startup (a missing binary, an unusable cwd, `cursor-agent` exiting 0 because
 * it is signed out) that is a launcher that re-arms its own trigger: every
 * look at the pane starts another one.
 *
 * The rule: a session id whose child exited within `TERMINAL_FAST_EXIT_MS` of
 * its spawn is never spawned again under that id. It is REFUSED, with a
 * sentence, because a process that dies on startup dies the same way the
 * second time and the human deserves to be told rather than to watch it
 * happen again. An explicit close (`forget`) clears the record — deliberately
 * opening a fresh session is always allowed; it is the AUTOMATIC re-open that
 * is not.
 *
 * Deliberately NOT a policy about exit codes: a fast exit 0 is the same defect
 * as a fast exit 1 here (that is exactly how a signed-out `cursor-agent`
 * fails). Only "did it live long enough to be a session" is judged.
 *
 * THIS GUARD HAS NO CLOCK, on purpose. It used to time the death itself, from
 * the moment `noteExit` ran — which is the moment a CONSUMER observed the exit
 * frame, not the moment the child died. Unmount the pane, let the vendor die
 * unwatched, come back a minute later, and the replayed frame timed a
 * minute-long "session" that had actually failed to launch in 300ms. The
 * lifetime now arrives measured, from the one place that can measure it (the
 * PtyHost, at the OS-level exit), and this guard only compares it.
 */
export type TerminalRespawnGuard = {
  /** Record a real pty spawn for this id (never a reconnect/re-attach). */
  noteSpawn(sessionId: string): void;
  /**
   * Record the child's exit. `lifetimeMs` is the HOST's measurement of how
   * long the child lived (PtyHost stamps it at the driver's exit report) —
   * never elapsed time at the call site. A second call for the same run is
   * ignored.
   */
  noteExit(
    sessionId: string,
    exit: { exitCode: number; lifetimeMs: number }
  ): void;
  /** A host-authored refusal sentence, or null when this open may proceed. */
  refuseRespawn(sessionId: string): string | null;
  /** Drop the record — the human closed this session deliberately. */
  forget(sessionId: string): void;
};

export function createTerminalRespawnGuard(): TerminalRespawnGuard {
  const runs = new Map<
    string,
    { exited: boolean; diedFast: boolean; exitCode: number }
  >();
  return {
    noteSpawn(sessionId) {
      runs.set(sessionId, { exited: false, diedFast: false, exitCode: 0 });
    },
    noteExit(sessionId, exit) {
      const run = runs.get(sessionId);
      // No record ⇒ this host never spawned it (echo-driver path, or an id
      // already forgotten). Already exited ⇒ a duplicate report for the same
      // run, not a second death.
      if (!run || run.exited) {
        return;
      }
      run.exited = true;
      run.exitCode = exit.exitCode;
      run.diedFast = exit.lifetimeMs <= TERMINAL_FAST_EXIT_MS;
    },
    refuseRespawn(sessionId) {
      const run = runs.get(sessionId);
      if (!run || !run.diedFast) {
        return null;
      }
      return `the last process in this session exited immediately (code ${run.exitCode}) without becoming a session, so MUON did not start another one — a command that fails on startup fails the same way the second time. Read what it printed above, fix it (installing the CLI, or signing in through its own login), then open a new session.`;
    },
    forget(sessionId) {
      runs.delete(sessionId);
    },
  };
}
