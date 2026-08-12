/**
 * Env keys MUON's own LANE GUARDS set on a vendor child.
 *
 * These are NOT credentials, and the distinction is the whole reason this file
 * exists. `CODEX_HOME` sat in the registry's `credentials.envKeys` — i.e. it was
 * treated as a secret to forward — which meant every dispatched Codex child
 * inherited the operator's personal config root and, with it, every MCP server,
 * plugin, and hook in it (see codex-guard.ts). It is a config ROOT, and MUON
 * owns it.
 *
 * But moving it out of that list would have silently dropped two properties the
 * list was providing, so both are restated here, positively:
 *
 *  1. THE RUNNER MAY READ IT. `sandbox/launcher.ts` spreads these into
 *     `RUNNER_ENV_ALLOWLIST` so an operator who relocated their own
 *     `CODEX_HOME` is still FOUND — that is where their `auth.json` and their
 *     provider configuration live, and losing it would break BYO-auth for
 *     exactly the people who customized their install.
 *  2. NO CHILD MAY INHERIT IT. `lane-runner.ts` keeps these out of
 *     `COMMON_LANE_ENV_KEYS` so the AMBIENT value reaches nobody, and refuses a
 *     profile override that would set one lane's guard key on another lane's
 *     child. Only MUON's own explicit per-lane override may set it.
 *
 * A separate module rather than a constant inside `lane-runner.ts` because
 * `sandbox/launcher.ts` needs it too and `lane-runner.ts` imports the launcher.
 * It deliberately imports NOTHING, so it can sit at the bottom of that graph.
 */

/** Codex's config root. See `codexGuardEnv` for the value MUON sets. */
export const CODEX_GUARD_ENV_KEY = "CODEX_HOME";

/**
 * OpenCode's permission levers. See `opencodeGuardEnv` for the values MUON sets.
 *
 * Codex's guard is ONE config root; opencode's is four keys, because opencode's
 * read-only posture is a config fact rather than an argv fact. `OPENCODE_PERMISSION`
 * is the reason this list exists at all: measured against 1.18.7 it is the LAST
 * word on the top-level permission table — it beats `OPENCODE_CONFIG_CONTENT`,
 * which already beats project config — and it MERGES per key, so an ambient
 * `{"bash":"allow"}` would flip exactly one token of MUON's deny table and leave
 * the rest looking correct. A key that outranks MUON's own deny table is a key
 * MUON must OWN rather than leave to whoever set it last.
 *
 * `XDG_CONFIG_HOME` is deliberately NOT here even though `opencodeGuardEnv`
 * redirects it. It is a SHARED, non-vendor key that every lane legitimately
 * inherits; registering it would strip the operator's ambient value from the
 * claude, codex, and cursor children too. opencode's own redirect still wins for
 * the opencode child because the guard env is merged last. Ownership of a shared
 * key is a wider decision than this file gets to make.
 */
export const OPENCODE_GUARD_ENV_KEYS = [
  "OPENCODE_PERMISSION",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
] as const;

/**
 * Per lane, stated positively — never derived by subtracting from a wider set,
 * which is the anti-pattern that has broken this codebase repeatedly. A lane
 * absent from this map has no guard keys, which is the correct default: it
 * receives nothing extra and can grant nothing extra.
 *
 * The map key is the ADAPTER ID (`BaseLaneAdapter.id`, which `runLaneCommand`
 * passes as `laneId`), because that is what `lane-runner.ts` looks up. A key
 * registered under a name no adapter answers to would refuse MUON's OWN guard
 * override and silently leave the child unguarded.
 */
export const LANE_GUARD_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  codex: [CODEX_GUARD_ENV_KEY],
  opencode: [...OPENCODE_GUARD_ENV_KEYS],
};

/** The deny side: every guard key, whoever owns it. */
export const ALL_LANE_GUARD_ENV_KEYS: ReadonlySet<string> = new Set<string>(
  Object.values(LANE_GUARD_ENV_KEYS).flat()
);
