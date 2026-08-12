import type { MuonApiClient } from "@muon/client";
import { MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES } from "@muon/protocol";
import type { ToolDefinition } from "./agent-ui.js";
import {
  createObserverModeToolDefinitions,
  type ObserverScope,
} from "./observer-tools.js";
import {
  createOrchestratorToolDefinitions,
  type OrchestratorScope,
} from "./orchestrator-tools.js";

/**
 * ADR-0028 Tier C: the attached (external, non-hermetic) coordinator.
 *
 * Every field is REQUIRED — unlike the orchestrator/observer scopes this
 * composes, an attached coordinator's whole authority comes from one
 * capability file (`@muon/client/attached-coordinator-capability`), so there
 * is no "absent lineage, degrade gracefully" branch here: main() refuses to
 * start rather than construct this scope partially.
 */
export type AttachedCoordinatorScope = {
  jobId: string;
  delegationToken: string;
  chatId: string;
  chatTaskId: string;
  workspacePath: string;
  apiBase: string;
  apiToken: string;
};

/**
 * Positively construct Tier C's tool inventory: Tier A + Tier B (via
 * `createObserverModeToolDefinitions`, which also overrides the base
 * `crew_roles` with its chat-scoped observer read) plus exactly the seven
 * `MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES` control tools, filtered out
 * of the full orchestrator inventory. This NEVER derives the grant by
 * subtracting from `MUON_CONTROL_TOOL_NAMES` — `set_fleet`, `raise_budget`,
 * and `apply_workflow` are absent because they are never selected, not
 * because they were removed.
 *
 * Composing with already-`withAgentUi`-wrapped tool sets (both
 * `createObserverModeToolDefinitions` and `createOrchestratorToolDefinitions`
 * wrap their own output) means the definitions returned here need no further
 * wrapping — re-wrapping would double-apply the agent-UI contract.
 */
export function createAttachedCoordinatorToolDefinitions(
  client: MuonApiClient,
  baseTools: ToolDefinition[],
  scope: AttachedCoordinatorScope
): ToolDefinition[] {
  const observerScope: ObserverScope = {
    apiBase: scope.apiBase,
    apiToken: scope.apiToken,
    chatId: scope.chatId,
    workspacePath: scope.workspacePath,
  };
  const withObserverReads = createObserverModeToolDefinitions(
    client,
    baseTools,
    observerScope
  );

  const orchestratorScope: OrchestratorScope = {
    jobId: scope.jobId,
    delegationToken: scope.delegationToken,
    chatId: scope.chatId,
    chatTaskId: scope.chatTaskId,
    workspacePath: scope.workspacePath,
    apiBase: scope.apiBase,
    apiToken: scope.apiToken,
  };
  const controlByName = new Map(
    createOrchestratorToolDefinitions(client, orchestratorScope, {
      principal: "orchestrator",
    }).map((tool) => [tool.name, tool] as const)
  );
  const grantedControl = MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES.map(
    (name) => {
      const tool = controlByName.get(name);
      if (!tool) {
        throw new Error(
          `Attached coordinator control tool '${name}' is missing from the orchestrator inventory.`
        );
      }
      return tool;
    }
  );

  return [...withObserverReads, ...grantedControl];
}
