import type { ApprovalRequest } from "./types.js";

/**
 * TODO 5.16 — the one-approvable-card rule, as data.
 *
 * "At most one approvable card, with everything it wants confirmed folded into
 * that single card rather than stacked into several." The Review rail used to
 * render up to four pending approvals as four separate decision surfaces —
 * which is exactly the stacked inbox the rule forbids. This selector is the
 * invariant: every surface that shows a gate asks it, so a second card cannot
 * appear by a renderer forgetting the rule.
 *
 * Related pending approvals that share the primary's `jobId` are FOLDED into
 * it (listed, not separately actionable). Everything else waits in the queue
 * and surfaces only as a count until the primary is decided.
 */

export type ApprovableInbox = {
  /** The single card the operator decides now, or null when nothing is pending. */
  primary: ApprovalRequest | null;
  /**
   * Other pending approvals for the SAME job as `primary`. Shown as context on
   * that card ("also waiting"), never as a second Approve/Reject surface.
   */
  folded: ApprovalRequest[];
  /** Pending approvals that are not the primary and not folded into it. */
  queued: ApprovalRequest[];
};

function isPending(approval: ApprovalRequest): boolean {
  return approval.status === "pending";
}

function createdMs(approval: ApprovalRequest): number {
  if (!approval.createdAt) return 0;
  const ms = Date.parse(approval.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Pick the one approvable card.
 *
 * `focusId`, when it still names a pending approval, wins — the operator asked
 * to review that one. Otherwise the oldest pending approval is the primary
 * (FIFO: the first ask is the first answer). Fail-closed: an empty or all-
 * decided list yields `primary: null`.
 */
export function selectOneApprovableCard(
  approvals: readonly ApprovalRequest[],
  focusId?: string | null
): ApprovableInbox {
  const pending = approvals.filter(isPending);
  if (pending.length === 0) {
    return { primary: null, folded: [], queued: [] };
  }

  const focused = focusId
    ? pending.find((approval) => approval.id === focusId)
    : undefined;
  const oldest = [...pending].sort((a, b) => {
    const byTime = createdMs(a) - createdMs(b);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  })[0];
  const primary = focused ?? oldest ?? null;
  if (!primary) {
    return { primary: null, folded: [], queued: [] };
  }

  const folded: ApprovalRequest[] = [];
  const queued: ApprovalRequest[] = [];
  for (const approval of pending) {
    if (approval.id === primary.id) continue;
    if (
      primary.jobId &&
      approval.jobId &&
      approval.jobId === primary.jobId
    ) {
      folded.push(approval);
    } else {
      queued.push(approval);
    }
  }
  folded.sort((a, b) => createdMs(a) - createdMs(b));
  queued.sort((a, b) => createdMs(a) - createdMs(b));
  return { primary, folded, queued };
}
