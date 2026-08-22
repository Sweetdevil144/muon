import {
  githubIdentityGateDoorMissing,
  githubIdentityGateDoorMissingWarning,
  githubIdentityGateMisconfigured,
  githubIdentityGateRequired,
  identityGateRefusalFor,
  identityGateStateOf,
  resolveGateArming,
  type IdentityGateState,
} from "@muon/client/github-identity-gate";

/**
 * ADR-0052 — the TUI half of the identity gate.
 *
 * THIS SURFACE SHIPPED UNGATED and nobody noticed, which is worth writing down
 * rather than quietly fixing. `bundle-release.mjs` declares three bins beside
 * one `muonDistributed` manifest — `muon`, `muon-mcp` and `muon-tui` — and two
 * of them read the gate. `muon-tui` never mentioned it. An operator who
 * installed the release tarball and typed `muon-tui` got the whole desk:
 * dispatch, crew, memory, governed decisions, a live PTY in their workspace,
 * with no identity verified and no install recorded. The gate was a hard gate
 * with a door standing open beside it.
 *
 * The policy still lives once in `@muon/client`; this file is only the TUI's
 * boundary, and its boundary is simpler than the CLI's because there is nothing
 * to exempt: the desk has no diagnostic subcommand and no self-maintenance
 * verb, so there is no positive list here — the desk opens or it does not. The
 * commands that stay reachable while locked are the CLI's, and the refusal
 * names them.
 *
 * A DEV CHECKOUT IS NEVER GATED, byte for byte. `distributed` comes from a bake
 * only `bundle-release.mjs` writes, so `npm run tui`, `tsx src/...` and a
 * workspace link have nothing to arm — `required` is false, the guard returns
 * before it reads a file, and the entry proceeds exactly as it did.
 */

/** Same code the CLI exits with. A script wrapping either surface reads one
 *  number for "not signed in", distinct from 1 (failed) and 2 (refused). */
export const TUI_IDENTITY_GATE_EXIT_CODE = 12;

/** What the CLI still runs while locked, named here so the desk's refusal is
 *  never a dead end. Kept as literal command strings rather than imported from
 *  `@muon/cli`: apps/tui does not depend on apps/cli, and inventing that
 *  dependency to share six words would be the worse trade. Pinned against the
 *  CLI's own set by `tests/identity-gate.test.ts`. */
export const TUI_LOCKED_STILL_AVAILABLE: readonly string[] = [
  "muon login",
  "muon doctor",
  "muon version",
  "muon update",
  "muon uninstall",
  "muon mcp status",
  "muon mcp probe",
];

export type TuiIdentityGate = {
  readonly required: boolean;
  readonly state: IdentityGateState;
  /** A distributed build that SHOULD gate but has no client id: it degrades
   *  UNGATED and the entry says so once, because it is a release defect. */
  readonly misconfigured: boolean;
  /** Armed by flag with no client id — the gate is on and has no door. */
  readonly doorMissing: boolean;
};

/**
 * Resolve this run's gate.
 *
 * `resolveGateArming` is the CLI's mechanism, shared rather than retyped: it
 * reads the bake AND republishes the baked client id into `env`. This surface
 * read the bake and skipped the republish, so a brain the DESK spawned had no
 * `MUON_GITHUB_CLIENT_ID` at all — `muon login` from a locked desk had no device
 * flow to run, which made the one remedy the refusal names a dead end. Sharing
 * the step is what keeps the two surfaces provably in step; both call one
 * function, and `tests/identity-gate.test.ts` drives this one for real.
 */
export function resolveTuiIdentityGate(
  env: NodeJS.ProcessEnv = process.env,
  importMetaUrl: string = import.meta.url
): TuiIdentityGate {
  const arming = resolveGateArming(env, importMetaUrl);
  const required = githubIdentityGateRequired(arming);
  return {
    required,
    state: required ? identityGateStateOf() : "unarmed",
    misconfigured: githubIdentityGateMisconfigured(arming),
    doorMissing: githubIdentityGateDoorMissing(arming),
  };
}

/**
 * The desk's refusal, chosen by state.
 *
 * `what` is "the MUON desk" rather than a command name because that is what
 * this bin is: there is no sub-verb to name, and telling a person "muon-tui is
 * gated" restates the thing they just typed.
 */
export function tuiIdentityGateRefusal(
  state: IdentityGateState = "locked"
): string {
  const input = {
    what: "the MUON desk",
    // `cli` is the SURFACE this refusal belongs to and the one the install
    // record will carry: `muon-tui` ships inside the CLI tarball and is opened
    // by the same `muon login`. Naming a `tui` surface here would promise a
    // record nothing files.
    surface: "cli" as const,
    stillAvailable: TUI_LOCKED_STILL_AVAILABLE,
  };
  // The shared selector, never a ternary written here: `open`/`unarmed` have
  // nothing to refuse, and the guard below never asks in those states.
  return identityGateRefusalFor(state, input) ?? "";
}

export type TuiGateGuardIo = {
  readonly write: (text: string) => void;
  readonly exit: (code: number) => never;
};

/**
 * THE WHOLE DECISION, before anything starts.
 *
 * Called first in both TUI entries — ahead of `ensureBrain`, ahead of the
 * client, ahead of Ink or the alt-screen engine. A locked desk must not spawn a
 * brain, mint a token or take the terminal on its way to refusing: a refusal
 * printed into an alt screen that is then torn down is a refusal nobody reads.
 *
 * Returns normally when the desk may open. Otherwise it writes plainly and
 * leaves.
 */
export function guardTuiIdentityGate(
  gate: TuiIdentityGate = resolveTuiIdentityGate(),
  io: TuiGateGuardIo = {
    write: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code) as never,
  }
): void {
  if (gate.misconfigured) {
    io.write(
      "muon-tui: RELEASE DEFECT — this distributed build has no GitHub client id, so the identity gate cannot arm and is DISABLED for this run.\n"
    );
  }
  if (gate.doorMissing) {
    io.write(`${githubIdentityGateDoorMissingWarning("tui")}\n`);
  }
  if (!gate.required || gate.state === "open") return;
  io.write(`${tuiIdentityGateRefusal(gate.state)}\n`);
  io.exit(TUI_IDENTITY_GATE_EXIT_CODE);
}
