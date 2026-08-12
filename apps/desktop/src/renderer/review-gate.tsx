// The review gate's decision surface — and the ONLY place the desktop renderer
// turns a human click into an approval decision.
//
// THREE ACTIONS, NOTHING ELSE:
//   1. Approve                  → resolve(approved)                 — this request only
//   2. Approve, don't ask again → resolve(approved, REMEMBER_TTL)   — standing consent
//   3. Reject                   → resolve(rejected)                 — always one click
//
// The third is deliberately not "smaller" than the approves: a deny surface a
// human has to hunt for is a deny surface that does not get used.
//
// NO SECOND CONSENT PATH. "Don't ask again" is not a new mechanism — it rides
// the existing content-bound receipt opt-in (`resolveApproval` with a
// `receiptTtlMs`), server-minted, server-clamped, server-bound to the exact
// tool + payload digest + resolved target + workspace + run. This component
// only chooses WHETHER to attach the receipt; it can never widen what the
// receipt covers, and it never decides anything on its own.
//
// FAIL-CLOSED, UNCHANGED: an undecided gate still blocks (no default action
// here), a timeout still denies (server-side), and Full Auto still resolves
// through the same governed path — surfaces render an auto-approving gate WITHOUT
// mounting these actions, so standing consent never gets a second click site.

import { useCallback, useId, useRef, useState } from "react";
import {
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
} from "@muon/client/approval-review";
import type { ApprovalReview } from "@muon/client/approval-review";

export {
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
};

/** The exact governed call every gate action makes. */
export type GateResolve = (
  status: "approved" | "rejected",
  receiptTtlMs?: number
) => void | Promise<void>;

/**
 * Busy/error plumbing shared by the inline gate and the dock card, so a failed
 * decision is never silent and a double-click can never send two decisions.
 * The dialog owns its own state (it also gates Close/Refresh on it) and passes
 * it in controlled.
 */
export function useGateDecision(onResolve: GateResolve) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const decide = useCallback<GateResolve>(
    (status, receiptTtlMs) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          await onResolve(status, receiptTtlMs);
        } catch (cause) {
          // The gate stays pending and says why. Never a blank failure.
          setError(
            cause instanceof Error ? cause.message : "The decision failed."
          );
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      })();
    },
    [onResolve]
  );
  return { busy, error, decide };
}

export function ReviewGateActions(props: {
  /** Server-stored status. Anything but `pending` renders NO actions at all. */
  status?: string | null;
  review: ApprovalReview;
  /** A decision is in flight; every action is inert until it settles. */
  busy?: boolean;
  /** Surfaced verbatim under the row — the server's own reason, never invented. */
  error?: string | null;
  /**
   * A surface-specific reason APPROVING is blocked right now (merge review
   * still loading, certification blocked). Reject is never blocked by it —
   * denying is always available, whatever the evidence says.
   */
  approveBlockedReason?: string | null;
  /** Renders the single-key shortcut badges (the dialog binds a/A/r). */
  shortcuts?: boolean;
  onDecide: GateResolve;
}) {
  const noteId = useId();
  const errorId = useId();
  // A decided gate is history, not a decision: render nothing rather than
  // actions that would 409 on the server.
  if (props.status && props.status !== "pending") {
    return null;
  }
  const busy = props.busy === true;
  const approveBlocked =
    !props.review.approvable || Boolean(props.approveBlockedReason);
  const rememberBlocked = approveBlocked || !props.review.receiptEligible;
  const scopeSentence = props.review.receiptEligible
    ? REMEMBER_ACTION_SCOPE_SENTENCE
    : REMEMBER_ACTION_INELIGIBLE_SENTENCE;

  return (
    <div className="gate-decision">
      <div className="gate-actions" role="group" aria-label="Decide this request">
        <button
          {...(props.shortcuts ? { "aria-keyshortcuts": "a" } : {})}
          aria-label="Approve"
          className="gate-action approve"
          data-approval-action="approve"
          disabled={approveBlocked || busy}
          onClick={() => props.onDecide("approved")}
          title={
            props.approveBlockedReason ??
            props.review.degradationReason ??
            "Approves this one request. Nothing is remembered."
          }
          type="button"
        >
          {busy ? "Deciding…" : "Approve"}
          {props.shortcuts ? <kbd aria-hidden="true">A</kbd> : null}
        </button>
        <button
          {...(props.shortcuts ? { "aria-keyshortcuts": "A" } : {})}
          aria-describedby={noteId}
          aria-label="Approve, don't ask again"
          className="gate-action approve-remember"
          data-approval-action="approve-remember"
          disabled={rememberBlocked || busy}
          onClick={() => props.onDecide("approved", REMEMBER_ACTION_TTL_MS)}
          title={scopeSentence}
          type="button"
        >
          Approve, don&rsquo;t ask again
          {props.shortcuts ? <kbd aria-hidden="true">⇧A</kbd> : null}
        </button>
        <button
          {...(props.shortcuts ? { "aria-keyshortcuts": "r" } : {})}
          aria-label="Reject"
          className="gate-action reject"
          data-approval-action="reject"
          // Never gated on evidence, never behind a confirm step: a human can
          // always deny in exactly one click.
          disabled={busy}
          onClick={() => props.onDecide("rejected")}
          type="button"
        >
          Reject
          {props.shortcuts ? <kbd aria-hidden="true">R</kbd> : null}
        </button>
      </div>
      {/* One short sentence, always present, telling the truth about how far
          "don't ask again" reaches — or why it cannot apply here. */}
      <small className="gate-consent-note" id={noteId}>
        {scopeSentence}
      </small>
      {/* Deliberately NOT repeating why Approve is unavailable: the surface
          that knows (the merge certification panel, the degraded-evidence
          warning) already says it in place, and saying it twice is the kind of
          copy that crowds a decision. The button carries it as its title. */}
      {props.error ? (
        <small className="gate-decision-error" id={errorId} role="alert">
          {props.error}
        </small>
      ) : null}
    </div>
  );
}
