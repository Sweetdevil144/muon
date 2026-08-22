import type { MuonApiClient } from "@muon/client";
import { MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES } from "@muon/protocol";
import type { ToolDefinition } from "./agent-ui.js";
import type { ReviewDiffLedger } from "./review-session.js";
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
 *
 * INVARIANT the factory cannot check: the `baseTools` handed in must have been
 * built with `seat: "attached-coordinator"` on their `ToolScope` (main() does
 * this in index.ts). The seat marker is diagnostic-only — it selects honest
 * refusal text for lane-scoped tools — so composing base tools built without
 * it loses no authority, only the correct diagnosis: the seat would be told it
 * "was hand-launched", the misdiagnosis measured live on 2026-08-13.
 */
export type AttachedCoordinatorScope = {
  jobId: string;
  delegationToken: string;
  chatId: string;
  chatTaskId: string;
  workspacePath: string;
  apiBase: string;
  apiToken: string;
  /**
   * A4: the SAME ledger object the `baseTools` above were built with, so this
   * seat's `ship` can see what its own `review_diff` proved. Optional for the
   * same reason every other A4 wiring point is: a composition that forgets it
   * gets a `ship` that refuses for want of evidence, never one that files a
   * merge gate it never looked at.
   */
  reviewLedger?: ReviewDiffLedger;
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
    // Tier C has a job and a delegation grant, and the workflow routes
    // authenticate BOTH. Without this the seat could call `propose_workflow`
    // (a granted control tool, which sends them) and then be refused 403 by
    // `workflow_status` reading back the run it had just created.
    workflowControl: {
      callerJobId: scope.jobId,
      delegationToken: scope.delegationToken,
    },
    // The seat's attach-minted root job IS this chat's mission job:
    // `budget_status` with no argument reads the seat's own mission budget.
    missionJobId: scope.jobId,
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
    // A4: forwarded, never re-created — a fresh Map here would be a different
    // object from the one review_diff writes, and `ship` would refuse forever.
    reviewLedger: scope.reviewLedger,
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
