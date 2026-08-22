import {
  githubIdentityGateDoorMissing,
  githubIdentityGateDoorMissingWarning,
  githubIdentityGateMisconfigured,
  githubIdentityGateRequired,
  identityGateRefusalFor,
  identityGateStateOf,
  readDistributionBake,
} from "@muon/client/github-identity-gate";
import {
  MCP_IDENTITY_GATE_EXEMPT_TOOLS,
  type McpIdentityGate,
} from "./server-factory.js";

/**
 * ADR-0052 — the `muon-mcp` half of the identity gate.
 *
 * Enforcement is at `tools/call` and nowhere else: `initialize` and
 * `tools/list` still answer, because reading the instructions and the tool list
 * is not work, and a vendor that cannot complete a handshake reports `-32000`
 * and nothing a human can act on (ADR-0049's lesson, paid for once already).
 *
 * HOW `distributed` IS RESOLVED HERE. `bundle-release.mjs` publishes
 * `muon.mjs`, `muon-tui.mjs` and `muon-mcp.mjs` beside ONE manifest, so the
 * same `muonDistributed` bake the CLI reads sits next to this entry too and
 * this gate arms on exactly the same fact — no second switch, no code path
 * that only the MCP half takes. A dev checkout or a workspace link carries no
 * bake and stays ungated; `MUON_REQUIRE_GITHUB_LOGIN=1` arms it anywhere.
 *
 * Written as an assertion about the bundler, so it is worth saying how it is
 * checked rather than believed: the release entry is pinned by
 * `apps/cli/tests/bundle-release-bins.test.ts`, and the arming was measured on
 * 2026-08-17 against a real bundled `muon-mcp.mjs` — bake present, a
 * non-exempt `tools/call` refused while `initialize`, `tools/list` and
 * `whoami` answered. Until the third entry existed, `muon-mcp` reached a
 * machine only through a dev checkout, and this arming had never run.
 */
export function resolveMcpIdentityGate(
  env: NodeJS.ProcessEnv = process.env,
  importMetaUrl: string = import.meta.url
): McpIdentityGate | undefined {
  const bake = readDistributionBake(importMetaUrl);
  const arming = {
    env,
    distributed: bake.distributed,
    ...(bake.clientId ? { clientId: bake.clientId } : {}),
  };
  if (githubIdentityGateMisconfigured(arming)) {
    process.stderr.write(
      "muon-mcp: RELEASE DEFECT — this distributed build has no GitHub client id, so the identity gate cannot arm and is DISABLED for this run.\n"
    );
  }
  if (githubIdentityGateDoorMissing(arming)) {
    process.stderr.write(`${githubIdentityGateDoorMissingWarning("mcp")}\n`);
  }
  if (!githubIdentityGateRequired(arming)) {
    // UNDEFINED, not an inert gate object: an ungated session must take the
    // exact code path it took before ADR-0052, with no per-call predicate.
    return undefined;
  }
  const refusalInput = {
    what: "every MUON tool",
    surface: "mcp" as const,
    // FROM the enforced set, never a second copy of it. This is the refusal
    // an agent actually receives, and the `initialize` instructions and
    // `whoami` both already render the same list this way — a third exempt
    // tool must not leave exactly one of the three naming two.
    stillAvailable: [...MCP_IDENTITY_GATE_EXEMPT_TOOLS],
  };
  return {
    // Read per call — a `muon login` in another terminal opens this live
    // session without a restart.
    state: () => identityGateStateOf(),
    /**
     * THE REFUSAL AN AGENT RECEIVES, chosen by the LIVE state (ADR-0052 F3).
     *
     * This was a string computed once at server construction, and it always
     * said "Run `muon login`". On a machine whose FIRST sign-in happened
     * offline — the desktop is satisfied by a credential alone, so the app
     * works — every dispatched agent's MCP session refused with that sentence,
     * naming the one action that had already succeeded and would not help. A
     * function, so the copy tracks the state instead of a snapshot of it.
     */
    refusal: () =>
      // The shared selector. `open` refuses nothing, and this is only ever read
      // after `gateClosed` has already said the session is closed.
      identityGateRefusalFor(identityGateStateOf(), refusalInput) ?? "",
  };
}
