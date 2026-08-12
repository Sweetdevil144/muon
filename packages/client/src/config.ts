import { readOperatorToken } from "./keychain.js";
import { discoverLiveBrain } from "./paths.js";

const defaultApiBase = "http://localhost:4000";

// Resolution precedence (review finding F1, explicit ALWAYS beats auto-discovery):
//   per-call flag (--api-base) → MUON_API_BASE / NEXT_PUBLIC_MUON_API_BASE env
//   → the running embedded brain's LIVE lockfile → the hardcoded default.
// A user who points at a remote brain is never silently hijacked back to a
// (possibly dead) loopback lockfile, and this matches the CLI preAction hook,
// which treats an explicit env base as authoritative and does NOT auto-spawn.
// A lockfile whose brain process has died is ignored (readLiveLockfile). See
// docs/adr/0008-embedded-brain-sqlite.md.

function explicitBase(): string | undefined {
  return (
    process.env.MUON_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_MUON_API_BASE?.trim() ||
    undefined
  );
}

/**
 * ONE spelling for boolean env flags, shared by every surface: the desktop's
 * gate arming and the CLI's attach requirement must not accept different
 * vocabularies for the same switch (MUON_REQUIRE_GITHUB_LOGIN=true silently
 * not arming one of them is the tier-derivation-drift pattern).
 */
export function booleanEnvFlag(value: string | undefined): boolean | undefined {
  const cleaned = value?.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "true" || cleaned === "on") return true;
  if (cleaned === "0" || cleaned === "false" || cleaned === "off") return false;
  return undefined;
}

export function resolveApiBase(cliValue?: string): string {
  const explicit = cliValue?.trim() || explicitBase();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  // discoverLiveBrain, not readLiveLockfile: in development the desktop runs
  // its brain under a sibling profile, and targeting our own (empty) profile
  // would silently answer from a different ledger. Adoption only fires when
  // this profile has no live brain and MUON_DATA_DIR is unset.
  const lock = discoverLiveBrain()?.lock;
  const base = lock ? `http://127.0.0.1:${lock.port}` : defaultApiBase;
  return base.replace(/\/$/, "");
}

export function resolveApiToken(
  cliValue?: string,
  cliBase?: string
): string | undefined {
  // The OPERATOR token (P3-A): human / govern authority, for LOCAL HUMAN surfaces
  // (CLI/TUI/desktop), their own MuonApiClient. Pair the token with the base:
  // when a base is explicitly configured (flag/env), NEVER send the local brain's
  // lockfile token to it, use the explicit token or none. Only when we
  // auto-target the local brain do we use its lockfile `token`.
  //
  // `cliBase` is REQUIRED for that promise to hold. `explicitBase()` reads only
  // the env vars, so for a long time the `--api-base` half of "flag/env" was
  // stated in this comment and not implemented: `resolveApiBase(flag)` honoured
  // the flag while this function still fell through to the lockfile, and
  // `muon --api-base https://elsewhere …` sent the local brain's OPERATOR
  // bearer — full govern authority — to whatever host was named. Callers that
  // accept a base flag MUST pass it here.
  if (cliValue?.trim()) {
    return cliValue.trim();
  }
  if (cliBase?.trim() || explicitBase()) {
    return process.env.MUON_API_TOKEN?.trim() || undefined;
  }
  // Auto-targeting the local brain. Precedence (ADR-0017 §3), highest first:
  //   lockfile `token` if NON-EMPTY (legacy, a pre-ADR-0017 brain, or a brain
  //     running degraded, publishes the operator token here)
  //   → readOperatorToken() Keychain (NEW, a brain minted under Keychain custody
  //     writes token:"" to the lockfile and stores the operator token here instead)
  //   → MUON_API_TOKEN env → undefined.
  // This step is INERT until R2/R3 make a brain write "": a non-empty lockfile
  // token short-circuits the `||` chain, so the Keychain is never even read.
  return (
    discoverLiveBrain()?.lock.token ||
    readOperatorToken() ||
    process.env.MUON_API_TOKEN?.trim() ||
    undefined
  );
}

/**
 * The AGENT-tier token (P3-A): reads + agent-writes, NEVER govern. This is what
 * gets injected into DISPATCHED SUB-AGENTS and the orchestrator (via
 * withMuonMcpServer), so a sub-agent holding it cannot self-approve, self-confirm,
 * forge a human principal, or write harness commands. Mirrors resolveApiToken's
 * base-pairing precedence but binds to the lockfile's `agentToken` and
 * MUON_AGENT_TOKEN. Critically it NEVER falls back to the operator token, a
 * missing agent token yields undefined rather than silently granting govern
 * rights to an agent.
 */
export function resolveAgentToken(
  cliValue?: string,
  cliBase?: string
): string | undefined {
  if (cliValue?.trim()) {
    return cliValue.trim();
  }
  // Same base-pairing rule, same reason, as resolveApiToken: a flag-supplied
  // base must not receive the local brain's lockfile credential.
  if (cliBase?.trim() || explicitBase()) {
    return process.env.MUON_AGENT_TOKEN?.trim() || undefined;
  }
  return (
    discoverLiveBrain()?.lock.agentToken ||
    process.env.MUON_AGENT_TOKEN?.trim() ||
    undefined
  );
}
