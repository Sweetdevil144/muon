import { GOVERNED_MCP_SERVER_NAME, type McpServerConfig } from "@muon/protocol";

/**
 * The governed MUON MCP server's env is delivered to the vendor as a TWO-SIDED
 * contract, and nothing used to check that both sides agree.
 *
 *   side A — the NAME list the vendor-native config carries:
 *              claude  `env: {"VAR": "${VAR}"}`
 *              cursor  `env: {"VAR": "${env:VAR}"}`
 *              codex   `mcp_servers.muon.env_vars = ["VAR", …]`
 *   side B — the VALUE, delivered only through the vendor child's process env
 *            (`CompiledProfile.env`), because a secret must never reach argv or
 *            a workspace file (see profile-compiler.ts S2).
 *
 * Between the two sides sits `buildLaneEnvironment`, a DENY-FIRST filter: it
 * starts from an empty env and copies only allowlisted names. Any name it drops
 * still appears on side A, so the vendor forwards nothing and `muon-mcp` starts
 * BLIND to it. When the missing name is lineage (`MUON_JOB_ID` /
 * `MUON_DELEGATION_TOKEN`) the server does the correct thing — it refuses to
 * serve an orchestrator/delegate toolset without job lineage and exits during
 * `initialize` — but the vendor swallows its stderr and reports only
 * "MCP client for `muon` failed to start … connection closed: initialize
 * response". The operator gets a sub-second death with no cause.
 *
 * So we assert the contract on THIS side of the vendor, where the real names
 * are still in hand, and fail with the missing names instead. Values are never
 * read, compared, or reported here — only presence.
 */

/** Lineage `muon-mcp` requires per capability mode (packages/mcp/src/index.ts). */
const MODE_REQUIRED_ENV: Record<string, readonly string[]> = {
  orchestrator: ["MUON_JOB_ID", "MUON_DELEGATION_TOKEN"],
  delegate: ["MUON_JOB_ID"],
};

/** A delegate that may spawn children additionally needs the job-bound token. */
const DELEGATE_SPAWN_REQUIRED_ENV = ["MUON_DELEGATION_TOKEN"] as const;

function isDelivered(
  env: Record<string, string | undefined> | Record<string, string>,
  name: string
): boolean {
  const value = env[name];
  // `muon-mcp` reads every coordinate as `?.trim() || undefined`, so an empty
  // or whitespace-only value is indistinguishable from an absent one there.
  // Judge delivery by the same rule the server judges it by.
  return typeof value === "string" && value.trim().length > 0;
}

export type MuonMcpEnvContractViolations = {
  /** Declared on the governed server but never reached the delivered env. */
  undelivered: string[];
  /** Required by the declared MUON_MCP_MODE but absent from the delivered env. */
  missingLineage: string[];
  /** The declared capability mode, when the profile set one. */
  mode?: string;
};

/**
 * Compare what the governed MUON MCP server DECLARES it needs against what the
 * environment it will actually be started with DELIVERS. Pure and exported so
 * the contract is unit-testable without a vendor binary.
 */
export function findMuonMcpEnvContractViolations(
  servers: readonly McpServerConfig[],
  deliveredEnv: Record<string, string | undefined>
): MuonMcpEnvContractViolations {
  const server = servers.find(
    (entry) => entry.name === GOVERNED_MCP_SERVER_NAME
  );
  if (!server) {
    return { undelivered: [], missingLineage: [] };
  }
  const declared = server.env ?? {};
  // Only a value LOST IN TRANSIT is a contract violation. A coordinate the
  // profile itself left unset (an optional field like MUON_CHAT_ID on a
  // non-chat dispatch) is an upstream composition choice, not a delivery
  // failure — flagging it would refuse launches that work today. What
  // muon-mcp genuinely CANNOT run without is covered by the lineage rule
  // below, which does not care whether the value was ever declared.
  const undelivered = Object.keys(declared).filter(
    (name) => isDelivered(declared, name) && !isDelivered(deliveredEnv, name)
  );

  const mode = declared.MUON_MCP_MODE?.trim() || undefined;
  const required = mode ? (MODE_REQUIRED_ENV[mode] ?? []) : [];
  const spawnRequired =
    mode === "delegate" && declared.MUON_DELEGATE_CAN_SPAWN?.trim() === "true"
      ? DELEGATE_SPAWN_REQUIRED_ENV
      : [];
  const missingLineage = [
    ...new Set([...required, ...spawnRequired]),
  ].filter((name) => !isDelivered(deliveredEnv, name));

  return {
    undelivered,
    missingLineage,
    ...(mode ? { mode } : {}),
  };
}

/**
 * Fail-closed launch assertion for the governed MCP server's env delivery.
 *
 * Refusing here is strictly safer than launching: a vendor that starts without
 * the brain cannot govern, dispatch, or record anything, so the run would fail
 * anyway — just opaquely, minutes or milliseconds later, with the cause hidden
 * inside a vendor process MUON does not own. Only NAMES appear in the message;
 * a value never does.
 */
export function assertMuonMcpEnvContract(
  servers: readonly McpServerConfig[],
  deliveredEnv: Record<string, string | undefined>
): void {
  const violations = findMuonMcpEnvContractViolations(servers, deliveredEnv);
  const missing = [
    ...new Set([...violations.missingLineage, ...violations.undelivered]),
  ];
  if (missing.length === 0) {
    return;
  }
  const scope = violations.mode
    ? `the '${violations.mode}' capability`
    : "this lane";
  throw new Error(
    `governed MUON MCP server env is incomplete for ${scope}: ${missing.join(
      ", "
    )} never reached the environment muon-mcp will be started with, so it would exit during initialize with no recoverable reason; refusing vendor launch`
  );
}
