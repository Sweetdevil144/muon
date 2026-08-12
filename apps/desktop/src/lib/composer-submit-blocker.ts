import type { BudgetLineView } from "@muon/client/budget-view";
import type { GitNexusIndexStatus } from "./gitnexus-index.js";
import type { OrchestratorReadinessIssue } from "./orchestrator-readiness.js";

/** One inline reason the Mission composer cannot send yet. */
export type ComposerSubmitBlocker = {
  kind: "readiness" | "index-stale" | "budget-exhausted";
  message: string;
  detail?: string;
};

/** Block send when HEAD moved past the indexed commit. */
export function gitnexusIndexSubmitBlocker(
  status: GitNexusIndexStatus | null | undefined
): ComposerSubmitBlocker | null {
  if (!status || status.stale !== true) {
    return null;
  }
  return {
    kind: "index-stale",
    message: "Re-index the code graph to send.",
    detail:
      status.note ??
      "HEAD moved since the last index — graph evidence would be stale.",
  };
}

/** Block send when the active mission's descendant pool is exhausted. */
export function budgetExhaustedSubmitBlocker(
  budget: BudgetLineView | null | undefined
): ComposerSubmitBlocker | null {
  if (!budget || budget.status !== "exhausted") {
    return null;
  }
  return {
    kind: "budget-exhausted",
    message: "Mission pool exhausted — raise budget to send.",
    detail: budget.summaryLabel,
  };
}

/**
 * Priority: vendor readiness, then index staleness, then mission budget.
 * Readiness keeps its existing probe semantics (unknown auth stays non-blocking).
 */
export function resolveComposerSubmitBlocker(input: {
  running?: boolean;
  readinessIssue?: OrchestratorReadinessIssue | null;
  gitnexus?: GitNexusIndexStatus | null;
  budget?: BudgetLineView | null;
}): ComposerSubmitBlocker | null {
  if (input.running) {
    return null;
  }
  if (input.readinessIssue?.blocking) {
    return {
      kind: "readiness",
      message:
        input.readinessIssue.fixHint ??
        `Set up ${input.readinessIssue.label ?? "the selected provider"} to send.`,
      detail: input.readinessIssue.detail,
    };
  }
  return (
    gitnexusIndexSubmitBlocker(input.gitnexus) ??
    budgetExhaustedSubmitBlocker(input.budget)
  );
}
