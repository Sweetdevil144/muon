import {
  githubIdentityGateDoorMissing,
  githubIdentityGateMisconfigured,
  githubIdentityGateRequired,
  identityGateRefusalFor,
  identityGateStateOf,
  resolveGateArming,
  type IdentityGateState,
} from "@muon/client/github-identity-gate";
import type { Command } from "commander";

/**
 * ADR-0052 — the CLI half of the identity gate.
 *
 * The policy itself lives once in `@muon/client` (`github-identity-gate.ts`);
 * this file is only the CLI's boundary: where the gate is checked (the
 * `preAction` hook), which commands stay reachable while locked, and how the
 * refusal reads in a terminal.
 *
 * A DEV CHECKOUT IS NEVER GATED. `distributed` comes from a bake that only
 * `bundle-release.mjs` writes, so a repo run and an `npm link` install have
 * nothing to arm — there is no file to add, no flag to unset, and no way for a
 * working tree to accidentally lock the person working in it.
 */

/**
 * The commands a GATED CLI still runs. POSITIVE list (ADR-0022); everything
 * absent refuses. Four families:
 *
 *  1. The gate's own door — `login` opens it, `logout` closes it.
 *  2. Self-maintenance — `version`, `update`, `uninstall` and `mcp uninstall`
 *     are how a stuck install fixes itself or leaves, and none of them starts
 *     work. `uninstall` was absent, which made a locked install one a person
 *     could not even remove with the tool that put it there. `mcp uninstall`
 *     was absent for longer and is the worse half of the same bug: `mcp
 *     install` writes an entry into a file MUON does not own — the user's
 *     ~/.claude.json, ~/.codex/config.toml, ~/.cursor/mcp.json — and gating its
 *     removal meant a locked MUON left its own row in a THIRD PARTY's config
 *     with no supported way to take it out. Leaving a trace behind in someone
 *     else's file is not something a failed sign-in may hold hostage.
 *  3. Diagnostics — `doctor`, `mcp status` and `mcp probe` answer "is this
 *     machine wired up", which is exactly what a person who cannot get in needs
 *     to be able to ask. All three read local files and a local socket; none
 *     dispatches. `doctor` is the command every other refusal and every doc
 *     points at, so a gated CLI refusing it was a dead end pointing at itself.
 *
 * `--version` never reaches here at all: commander answers it during parse,
 * before any action hook runs.
 */
export const CLI_IDENTITY_GATE_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  "login",
  // The guided setup's FIRST step is the sign-in itself; gating it behind
  // "run `muon login` first" made the wizard unreachable on exactly the
  // locked machines it exists to onboard. The wizard runs the same login
  // flow, and every later step's authority is its own (install writes local
  // files; attach re-checks identity policy where the seat is minted).
  "setup",
  "logout",
  "version",
  "update",
  "uninstall",
  "mcp uninstall",
  "doctor",
  "mcp status",
  "mcp probe",
]);

/** Exit code for a gate refusal: distinct from 1 (failed) and 2 (authz
 *  refused by the brain) so a script can tell "not signed in" from either. */
export const CLI_IDENTITY_GATE_EXIT_CODE = 12;

/**
 * WHERE A RELEASE-SIDE DEFECT IS REPORTED — the commands a user runs to ask
 * "is this install healthy?".
 *
 * A POSITIVE set, and deliberately not "the exempt set minus login/logout":
 * exemption answers "may this run while locked", health-reporting answers
 * "does this command explain the install". They overlap today and will drift
 * the moment either question gains a member (the standing rule against
 * deriving one bounded set by subtracting from another).
 */
export const CLI_DIAGNOSTIC_COMMANDS: ReadonlySet<string> = new Set([
  "doctor",
  "version",
  "mcp status",
  "mcp probe",
]);

/** Does THIS command owe the user an account of the install's health? */
export function isCliDiagnosticCommand(actionCommand: Command): boolean {
  return CLI_DIAGNOSTIC_COMMANDS.has(cliCommandPath(actionCommand));
}

/** The space-joined command path, root name excluded (`mcp status`). */
export function cliCommandPath(actionCommand: Command): string {
  const names: string[] = [];
  for (
    let cmd: Command | undefined | null = actionCommand;
    cmd?.parent;
    cmd = cmd.parent
  ) {
    names.unshift(cmd.name());
  }
  return names.join(" ");
}

export type CliIdentityGate = {
  readonly required: boolean;
  readonly satisfied: boolean;
  /** WHY it is closed, when it is: `locked` (nothing verified here) or
   *  `locked-unregistered` (verified, the install record has not landed). The
   *  two refuse identically and read completely differently. */
  readonly state: IdentityGateState;
  /** A distributed build that SHOULD gate but has no client id: it degrades
   *  ungated, and the caller says so once because it is a release defect. */
  readonly misconfigured: boolean;
  /** Armed BY FLAG with no client id: the gate is on and its door does not
   *  exist. Not a misconfiguration (the operator asked for it), but it must
   *  not be silent. */
  readonly doorMissing: boolean;
};

let cached: CliIdentityGate | undefined;

/**
 * Resolve (and memoize) this run's gate.
 *
 * `resolveGateArming` reads the bake AND republishes the baked client id into
 * `env`, because the device flow runs through the local brain the CLI spawns with
 * `{...process.env}` — see @muon/client for why that step is shared with the TUI
 * rather than written out here (it was written out here, and the TUI's copy was
 * simply missing).
 */
export function resolveCliIdentityGate(
  env: NodeJS.ProcessEnv = process.env,
  importMetaUrl: string = import.meta.url
): CliIdentityGate {
  if (cached) return cached;
  const arming = resolveGateArming(env, importMetaUrl);
  const required = githubIdentityGateRequired(arming);
  // Only asked when it matters: reading the credential file on every command
  // of an ungated dev checkout would be a syscall for nothing.
  const state: IdentityGateState = required ? identityGateStateOf() : "unarmed";
  cached = {
    required,
    satisfied: !required || state === "open",
    state,
    misconfigured: githubIdentityGateMisconfigured(arming),
    doorMissing: githubIdentityGateDoorMissing(arming),
  };
  return cached;
}

/** Test seam: drop the memoized verdict. */
export function resetCliIdentityGate(): void {
  cached = undefined;
}

/**
 * The terminal rendering of the shared refusal copy, chosen by STATE.
 *
 * `locked-unregistered` gets the deferred copy, because the ordinary refusal's
 * remedy ("Run `muon login`") is the one instruction that does not apply to an
 * operator who has already run it successfully.
 */
export function cliIdentityGateRefusal(
  commandPath: string,
  state: IdentityGateState = "locked"
): string {
  const input = {
    what: `muon ${commandPath}`.trim(),
    surface: "cli" as const,
    stillAvailable: [...CLI_IDENTITY_GATE_EXEMPT_COMMANDS]
      .filter((name) => name !== "login" && name !== "logout")
      .map((name) => `muon ${name}`),
  };
  // The shared selector, never a ternary written here. `open`/`unarmed` refuse
  // nothing, and `checkCliIdentityGate` returns before it asks.
  return identityGateRefusalFor(state, input) ?? "";
}

export type CliIdentityGateVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly commandPath: string;
      readonly refusal: string;
      readonly exitCode: number;
    };

/**
 * The whole decision, in one testable place: does THIS command run?
 *
 * Extracted from the `preAction` hook so the positive exempt list is exercised
 * against a real command tree rather than asserted about in prose. The hook
 * itself is then two lines — write the refusal, exit — which is the part that
 * cannot be unit-tested without ending the process.
 */
export function checkCliIdentityGate(
  actionCommand: Command,
  gate: CliIdentityGate
): CliIdentityGateVerdict {
  if (!gate.required || gate.satisfied) return { allowed: true };
  const commandPath = cliCommandPath(actionCommand);
  if (CLI_IDENTITY_GATE_EXEMPT_COMMANDS.has(commandPath)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    commandPath,
    refusal: cliIdentityGateRefusal(commandPath, gate.state),
    exitCode: CLI_IDENTITY_GATE_EXIT_CODE,
  };
}
