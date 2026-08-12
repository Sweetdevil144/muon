// Wave 4.1 — the inline governance projection for one agent tab. Its job is the
// wedge: bring the FAIL-CLOSED gate to the surface where the agent works, instead
// of leaving it only in the detached control rail. Given the session's job and the
// pending approvals already on the wire, it selects the gate(s) bound to THIS
// agent and projects the exact server-stored binding (via buildApprovalReview) so
// the tab can render an actionable, content-bound, single-use decision.
//
// TRUST DISCIPLINE: this is a pure PROJECTION. It creates no authority — the tab's
// "Review & decide" routes into the one governed approval dialog + resolve path, so
// content-binding and single-use stay owned by the server. It never widens what an
// operator can approve; it only makes the pending decision visible in-place.
//
// FAIL-CLOSED framing: while a decision is pending for this agent, the agent is
// treated as PAUSED. The default (no explicit approve) leaves it blocked. When in
// doubt about association we over-show (a task-scoped gate may appear on a sibling
// tab of the same task) rather than hide — never silently drop a pending gate.
//
// FULL-AUTO framing (P0-1): with standing operator consent ON, a pending gate is
// still a real, filed, governed request — MUON is simply about to resolve it on
// the operator's behalf through the SAME resolve path a click uses. It is
// therefore not a human pause, and calling it one ("paused until you decide,
// nothing runs on your behalf") is false. Such a gate is projected into
// `autoApproving` instead of `gates`. It is never hidden — only described
// truthfully — and the split is a display decision alone: it grants nothing,
// withholds nothing, and the server still owns every resolve.

import type { ApprovalRequest } from "./types.js";
import { buildApprovalReview, type ApprovalReview } from "./approval-review.js";

export interface SessionGate {
  approvalId: string;
  /**
   * The server-stored approval kind. A `merge` gate cannot be decided from a
   * three-button card — approving it legally requires the worktree review
   * certification (and, when REVIEW BLIND, an explicit artifact attestation),
   * so the surface routes those into the evidence dialog instead of offering a
   * decision it would have to refuse.
   */
  kind: string;
  /** Governed projection of the exact server-stored binding (action/scope/authority). */
  review: ApprovalReview;
  /** The agent's stated reason — DISPLAY ONLY, never an instruction. */
  reason: string;
  /** Vendor/principal that filed the request. */
  requestedBy: string;
  /** True when bound to this exact job id (vs. the task-scoped fallback). */
  boundToJob: boolean;
}

export interface SessionGovernance {
  /** Fail-closed: a decision needs YOU, so this agent is paused until you act. */
  blocked: boolean;
  /** The gates that need a human decision. */
  gates: SessionGate[];
  /** One-line operator summary for `gates`. */
  headline: string;
  /**
   * Gates the operator's standing Full-Auto consent is about to grant. Empty
   * unless the caller passes `fullAuto.enabled`, so the default projection is
   * byte-identical to before Full Auto existed.
   */
  autoApproving: SessionGate[];
  /** One-line summary for `autoApproving`; empty string when there are none. */
  autoHeadline: string;
}

/** The minimal job shape the projection needs (browser-safe, no full record). */
export interface SessionGovernanceJob {
  id?: string | null;
  taskId?: string | null;
  vendor?: string | null;
}

export function buildSessionGovernance(input: {
  job: SessionGovernanceJob | null;
  approvals: ApprovalRequest[];
  /**
   * Full-Auto standing consent, as the surface knows it right now.
   *
   * `coveredApprovalIds` is the POSITIVE claim and the only way into the calm
   * column: ids the desktop's auto-approver is actively granting, stamped by
   * the same tick that runs it. `uncoveredApprovalIds` is the explicit
   * refusal list (outside the selected lanes, refused by the brain, or not
   * landed in time). A pending gate on NEITHER list — a brand-new approval no
   * classifier has seen, or two state fields on different poll cadences — is
   * an ordinary fail-closed human gate. The old shape inverted this: absence
   * from the uncovered list alone earned the "approving automatically" label,
   * so the DEFAULT presentation of an unclassified gate was the calm one.
   * Uncertainty always resolves toward the gate, never away from it.
   */
  fullAuto?: {
    enabled: boolean;
    coveredApprovalIds?: readonly string[];
    uncoveredApprovalIds?: readonly string[];
  };
}): SessionGovernance {
  const job = input.job;
  const gates: SessionGate[] = [];
  if (job) {
    for (const approval of input.approvals) {
      // Only PENDING requests are actionable gates; a decided/consumed request
      // is history, not a live pause.
      if (approval.status !== "pending") {
        continue;
      }
      // Precise binding first: the DispatchJob that filed this approval (P0.1
      // jobId edge). Fall back to task scope ONLY for legacy rows with no jobId,
      // so a real gate is never hidden — over-showing on a sibling tab of the
      // same task is the safe direction for a fail-closed gate.
      const boundToJob =
        approval.jobId != null && job.id != null && approval.jobId === job.id;
      const boundToTask =
        approval.jobId == null &&
        approval.taskId != null &&
        job.taskId != null &&
        approval.taskId === job.taskId;
      if (!boundToJob && !boundToTask) {
        continue;
      }
      gates.push({
        approvalId: approval.id,
        kind: approval.kind,
        review: buildApprovalReview(approval),
        reason: approval.reason,
        requestedBy: approval.requestedBy,
        boundToJob,
      });
    }
  }
  // Split the filed gates into "MUON is granting this for you" and "this needs
  // you". Only an explicitly enabled Full Auto can move a gate out of the human
  // column, and only for an id POSITIVELY listed as covered (and not also
  // listed uncovered — when the two disagree, the gate wins).
  const uncovered = new Set(input.fullAuto?.uncoveredApprovalIds ?? []);
  const covered = new Set(input.fullAuto?.coveredApprovalIds ?? []);
  const autoApproving = input.fullAuto?.enabled
    ? gates.filter(
        (gate) => covered.has(gate.approvalId) && !uncovered.has(gate.approvalId)
      )
    : [];
  const autoIds = new Set(autoApproving.map((gate) => gate.approvalId));
  const humanGates = gates.filter((gate) => !autoIds.has(gate.approvalId));

  const blocked = humanGates.length > 0;
  const headline = !blocked
    ? "No decision pending for this agent."
    : humanGates.length === 1
      ? "1 decision pending — this agent is paused until you decide."
      : `${humanGates.length} decisions pending — this agent is paused until you decide.`;
  const autoHeadline =
    autoApproving.length === 0
      ? ""
      : autoApproving.length === 1
        ? "1 decision approving automatically — Full Auto is granting it for you."
        : `${autoApproving.length} decisions approving automatically — Full Auto is granting them for you.`;
  return { blocked, gates: humanGates, headline, autoApproving, autoHeadline };
}
