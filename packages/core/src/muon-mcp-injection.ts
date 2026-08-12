import { laneProfileSchema, type LaneProfile } from "@muon/protocol";

export type McpInjectionContext = {
  taskId: string;
  laneKey: string;
  jobId?: string;
  workspacePath?: string;
  preflightNonce?: string;
  apiBase: string;
  /**
   * The runner-issued exact-job token (P3-A) for the dispatched sub-agent's /
   * orchestrator's MUON MCP server. It must never be the operator or shared
   * runner-agent token. The injected credential carries no govern authority and
   * is valid only for its active job's server-derived scope. Delivered as
   * MUON_API_TOKEN in the MCP env (the MCP binary reads that name).
   */
  apiToken?: string;
};

export const MUON_MCP_SERVER_NAME = "muon";

/**
 * Ensures every lane session carries the MUON MCP server, so the agent can
 * search/propose shared memory and read task context mid-run. User-defined
 * servers in the profile are preserved; an existing `muon` entry is replaced
 * so scope env (task/lane) is always current.
 */
export function withMuonMcpServer(
  profile: LaneProfile | undefined,
  context: McpInjectionContext
): LaneProfile {
  const base = profile ?? laneProfileSchema.parse({});

  const muonServer = {
    name: MUON_MCP_SERVER_NAME,
    command: "muon-mcp",
    args: [],
    env: {
      MUON_API_BASE: context.apiBase,
      // WHO IS THIS SESSION, declared rather than inferred from absence.
      //
      // The MCP server's `instructions` (cc-as-superagent-delivery §3.3) are the
      // first thing a session reads, and they must not describe a MUON-SPAWNED
      // worker as a human-started one. Absence used to mean both: the runner set
      // this only for `orchestrator` and `delegate`, so a plain worker — the
      // governed editing agent, the most common session MUON spawns — fell to the
      // attached-session voice and was told "MUON never spawned you", "MUON never
      // interposes on your tools", and "a human is at this terminal". All three
      // are false for a worker, in the direction that matters.
      //
      // "worker" is the BASE value on purpose: the orchestrator and delegate
      // branches spread this env and then override the key, so the narrowest
      // truthful label is the default and a richer one has to be asserted.
      // `muon mcp install` still writes NO mode, which is what now makes an
      // absent mode genuinely mean "a human attached this".
      MUON_MCP_MODE: "worker",
      MUON_TASK_ID: context.taskId,
      MUON_LANE_KEY: context.laneKey,
      ...(context.jobId ? { MUON_JOB_ID: context.jobId } : {}),
      ...(context.workspacePath
        ? { MUON_WORKSPACE: context.workspacePath }
        : {}),
      ...(context.preflightNonce
        ? { MUON_PREFLIGHT_NONCE: context.preflightNonce }
        : {}),
      ...(context.apiToken ? { MUON_API_TOKEN: context.apiToken } : {}),
    },
  };

  return {
    ...base,
    mcpServers: [
      ...base.mcpServers.filter((server) => server.name !== MUON_MCP_SERVER_NAME),
      muonServer,
    ],
  };
}
