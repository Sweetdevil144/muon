import type { ReviewDiffResponse } from "../../shared/ipc.js";
import {
  buildRefusal,
  renderRefusalLine,
  type Refusal,
} from "@muon/client/refusal";

/**
 * The fail-closed SHIP gate, as a pure decision (ROADMAP 4.3).
 *
 * A `merge` approval is the moment a lane's work lands on the primary checkout.
 * MUON refuses to let a human approve that merge while the change is
 * REVIEW BLIND — at least one changed file is unindexed or the code index is
 * stale, so the affected-flow evidence is INCOMPLETE and "0 processes affected"
 * must NOT be read as an all-clear. This is the enforcement the orchestrator
 * prompt only asks for: here it is a Desktop gate the operator cannot click
 * past. Backend route-level certification remains the cross-surface backstop.
 *
 * Fail closed on both availability and verdict: a missing/degraded review is
 * not evidence that the change is safe. The operator receives a recovery action
 * and can retry after re-indexing or repairing the review integration.
 *
 * ADR-0033: the block is a typed `Refusal` — rule, evidence, lawful next action
 * — rather than a concatenated sentence, so the same decision can be rendered
 * for an operator (who is deciding this merge and needs the blind file) and for
 * an agent (which gets counts only; a blind-file list is a workspace path set).
 */

/** The typed refusal, or `null` when the merge may proceed. */
export function mergeShipRefusal(
  approval: { kind: string; jobId?: string | null } | undefined,
  status: "approved" | "rejected",
  review: ReviewDiffResponse | null | undefined,
  manualReviewAttested = false
): Refusal | null {
  if (status !== "approved") return null;
  if (!approval || approval.kind !== "merge") return null;

  if (!review) {
    return buildRefusal({
      rule: "ship.review_unavailable",
      summary: "Can't ship — graph review evidence is unavailable.",
      surface: "desktop merge approval",
      evidence: [{ label: "reason", value: "no review response" }],
      nextAction: {
        kind: "operator",
        action:
          "re-index the workspace or repair review_diff, then retry approval",
      },
    });
  }

  if (review.status !== "ok") {
    return buildRefusal({
      rule: "ship.review_unavailable",
      summary: "Can't ship — graph review evidence is unavailable.",
      surface: "desktop merge approval",
      evidence: [{ label: "reason", value: review.reason }],
      nextAction: {
        kind: "operator",
        action:
          review.action ??
          "re-index the workspace or repair review_diff, then retry approval",
      },
    });
  }

  if (review.impact.verdict !== "review-blind") return null;
  if (manualReviewAttested) return null;

  const blindFiles = review.impact.totals.blindFiles;
  const changedFiles = review.impact.totals.changedFiles;
  const firstBlind = review.impact.blindFiles[0];

  return buildRefusal({
    rule: "ship.review_blind",
    summary:
      "Can't ship — REVIEW BLIND: changed files are unindexed or the index is stale, so 0 affected flows is not a pass.",
    surface: "desktop merge approval",
    evidence: [
      // review_diff's own note first — it is the most specific thing anyone
      // knows about WHY this diff is blind.
      ...(review.impact.notes[0]
        ? [{ label: "note", value: review.impact.notes[0] }]
        : []),
      { label: "verdict", value: review.impact.verdict },
      { label: "changedFiles", value: changedFiles },
      { label: "blindFiles", value: blindFiles },
      ...(firstBlind ? [{ label: "firstBlindFile", value: firstBlind }] : []),
    ],
    nextAction: {
      kind: "operator",
      action:
        "re-index, or review every blind file and attest before approving",
    },
  });
}

/**
 * The operator-facing sentence, unchanged in spirit from what shipped before
 * this was typed. Kept as the name every existing caller already uses.
 *
 * @returns a human-facing block reason, or `null` when the merge may proceed.
 */
export function mergeShipBlockReason(
  approval: { kind: string; jobId?: string | null } | undefined,
  status: "approved" | "rejected",
  review: ReviewDiffResponse | null | undefined,
  manualReviewAttested = false
): string | null {
  const refusal = mergeShipRefusal(
    approval,
    status,
    review,
    manualReviewAttested
  );
  return refusal ? renderRefusalLine(refusal, "operator") : null;
}
