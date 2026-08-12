import type { ObjectiveLoopControl } from "@muon/client";

/**
 * P9 — conversational objective loop entry copy. Fills the composer; the human
 * still sends deliberately. The orchestrator dispatches with loop:true.
 */
export const OBJECTIVE_LOOP_ENTRY_PROMPT =
  "Run an objective loop on this task: dispatch a crew worker with loop enabled and keep going until the harness checks pass or the loop escalates. Report iteration progress and any evaluator missing items after each check.";

export function objectiveLoopComposerActivity(
  status: ObjectiveLoopControl | null | undefined
): string | null {
  if (!status) {
    return null;
  }
  if (status.status === "running") {
    return status.headline;
  }
  if (status.canResume) {
    return `${status.headline} · paused — resume from Orchestration`;
  }
  return status.headline;
}
