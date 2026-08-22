import {
  describeHandoffDegradation,
  handoffContractIsDegraded,
} from "@muon/client/handoff-view";
import type { DispatchJobRecord } from "@muon/client";
import type { TaskHandoffView, WorkspaceReview } from "../../shared/ipc.js";
import type { ShipTarget } from "../right-panel.js";

/**
 * WHAT THE DOCK'S "Land this work" BUTTON IS ALLOWED TO KNOW (ROADMAP H2/H3).
 *
 * Extracted from `app.tsx` where it was an inline ternary, for one reason: the
 * fact it now has to fold in — whether the newest handoff packet DECLARES its
 * own missing evidence — is a decision, and a decision that can refuse a ship
 * needs a test that does not have to mount the whole App.
 *
 * Everything here is a projection of records the dock already holds. No fetch,
 * no authority: the merge gate is still filed through the governed
 * `POST /api/approvals` path and still decided at the approval, where the
 * backend re-derives certification fail-closed.
 */

/**
 * The ship refusal owed to a DEGRADED wrap packet.
 *
 * H2's rule, on the desktop's ship control: a `typed_degraded` or
 * `packet_parse_failed` packet is not a yellow footnote next to a live button —
 * it disables the button, and the sentence NAMES the evidence that is missing.
 * "Looks fine" is exactly what the operator must not be told, so the reason is
 * built from the packet's own declared reasons (or, when it declared none, from
 * that fact).
 *
 * NEWEST ONLY. `projectHandoffPage` returns newest-first, so the packet that
 * describes the state of the work is `items[0]`. An older clean packet cannot
 * un-degrade a newer dirty one — that would be the reader choosing the
 * evidence that suits the button.
 *
 * @returns the refusal sentence, or `null` when the newest packet raises no
 *   objection (including when there is no packet at all — a task that never
 *   wrapped is governed by the merge gate, not by this line).
 */
export function handoffShipBlockReason(
  newest: TaskHandoffView | null | undefined
): string | null {
  if (!newest) return null;
  if (!handoffContractIsDegraded(newest.contract)) return null;
  const missing = describeHandoffDegradation(newest);
  return (
    `Can't land this work — the newest handoff packet is degraded, so what it claims is unverified. ` +
    `${missing ?? "Missing evidence: the packet declares itself degraded."} ` +
    `Re-run the checks and wrap again, or decide it at the merge gate where a blind review can be attested.`
  );
}

/**
 * Build the Changes panel's ship target from the dock's own facts.
 *
 * `job` null (no dispatch bound to the shown review) yields `null`, and the
 * panel then says so in words rather than rendering a dead button.
 */
export function buildDockShipTarget(input: {
  job: DispatchJobRecord | null | undefined;
  review: WorkspaceReview | null | undefined;
  fullAuto: boolean;
  /**
   * The task's handoff page, newest-first, when the dock has read it. `null` =
   * NOT READ YET, which is deliberately NOT a block: an unread packet is not
   * evidence of degradation, and blocking on it would make the button flicker
   * on every task switch. The merge gate remains the fail-closed backstop.
   */
  handoffs?: readonly TaskHandoffView[] | null;
}): ShipTarget | null {
  const job = input.job;
  if (!job) return null;
  const review = input.review;
  return {
    jobId: job.id,
    taskId: job.taskId ?? null,
    laneKey: job.vendor ?? null,
    status: job.status ?? "",
    tree:
      // The truthiness guard is deliberate: a review from an older main
      // carries no `tree`, and "which tree is this" must then read as
      // unknown — never crash, never assume the canonical checkout.
      review?.status === "available" && review.tree
        ? {
            status: "resolved",
            kind: review.tree.kind,
            path: review.tree.path,
          }
        : review?.status === "degraded"
          ? {
              status: "unresolved",
              reason: review.reason,
              action: review.action,
            }
          : {
              status: "unresolved",
              reason: "This dispatch's tree has not been read yet.",
              action: "Landing unlocks once the workspace review loads.",
            },
    gateBlockReason: handoffShipBlockReason(input.handoffs?.[0]),
    fullAuto: input.fullAuto,
  };
}
