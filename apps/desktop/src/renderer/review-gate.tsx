// The review gate's decision surface — and the ONLY place the desktop renderer
// turns a human click into an approval decision.
//
// FOUR ACTIONS, NOTHING ELSE — three approves graded by how long they last
// (ADR-0056: `once` / `session` / `always`), and one deny:
//   1. Approve                    → resolve(approved)                — `once`, this request only
//   2. Approve, don't ask again   → resolve(approved, session choice) — this RUN, 15 min
//   3. Approve, always in this chat → resolve(approved, always choice) — this CHAT, 7 days
//   4. Reject                     → resolve(rejected)                — always one click
//
// The deny is deliberately not "smaller" than the approves: a deny surface a
// human has to hunt for is a deny surface that does not get used.
//
// NO SECOND CONSENT PATH. Neither durable action is a new mechanism — each is
// the SAME governed `resolveApproval`, carrying the one opt-in the server
// already owns: `receipt.ttlMs` (run-scoped) or `grant.duration` (chat-scoped).
// Both are server-minted, server-clamped and server-bound to the exact tool +
// payload digest + resolved target + workspace, and `always` additionally to
// the policy fingerprint. This component only chooses WHICH ONE to attach; it
// can never widen what either covers, and it never decides anything on its own.
//
// ONE DURABLE AUTHORITY PER DECISION, BY CONSTRUCTION. The choice is a single
// optional `GateDurableChoice` union, never two independent optionals — so the
// shared builder's "receipt and grade together" refusal is unreachable from any
// UI rather than merely untriggered by today's call sites.
//
// A GRANT IS ONLY OFFERED WHERE ONE CAN EXIST. `review.grantEligible` comes off
// the protocol's own positive allow-list (`GRANTABLE_APPROVAL_KINDS`); a merge
// carrying a durable grade is a hard 400 that leaves the approval PENDING, and
// a button that always fails teaches the operator the app is broken.
//
// FAIL-CLOSED, UNCHANGED: an undecided gate still blocks (no default action
// here), a timeout still denies (server-side), and Full Auto still resolves
// through the same governed path — surfaces render an auto-approving gate WITHOUT
// mounting these actions, so standing consent never gets a second click site.

import { useCallback, useId, useRef, useState } from "react";
import {
  ALWAYS_ACTION_GRANT_DURATION,
  ALWAYS_ACTION_INELIGIBLE_SENTENCE,
  ALWAYS_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
} from "@muon/client/approval-review";
import type {
  ApprovalGrantDuration,
  ApprovalReview,
} from "@muon/client/approval-review";

export {
  ALWAYS_ACTION_GRANT_DURATION,
  ALWAYS_ACTION_INELIGIBLE_SENTENCE,
  ALWAYS_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_SCOPE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
};

/**
 * ADR-0056: the ONE durable authority a single decision may carry, modelled as
 * a UNION rather than two optional arguments.
 *
 * `buildApprovalDecision` (@muon/client) throws when a caller supplies both a
 * `receiptTtlMs` and a `grantDuration`. Making the UI's vocabulary a union
 * means no click site — present or future — can express that state, so the
 * builder's error is unreachable from the surface instead of merely avoided by
 * the call sites that happen to exist today.
 *
 * A plain approve is the ABSENCE of this value (the `once` grade), never a
 * third member: `once` mints nothing, so there is nothing for it to carry.
 */
export type GateDurableChoice =
  | { readonly grade: "session"; readonly receiptTtlMs: number }
  | { readonly grade: "always"; readonly grantDuration: ApprovalGrantDuration };

/** "Don't ask again" — the shipped receipt opt-in, at the one shared TTL. */
export const REMEMBER_ACTION_CHOICE: GateDurableChoice = {
  grade: "session",
  receiptTtlMs: REMEMBER_ACTION_TTL_MS,
};

/** "Always in this chat" — the graded opt-in; the expiry is server-computed. */
export const ALWAYS_ACTION_CHOICE: GateDurableChoice = {
  grade: "always",
  grantDuration: ALWAYS_ACTION_GRANT_DURATION,
};

/** The exact governed call every gate action makes. */
export type GateResolve = (
  status: "approved" | "rejected",
  durable?: GateDurableChoice
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
    (status, durable) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          await onResolve(status, durable);
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
  const alwaysNoteId = useId();
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
  // ADR-0056. DISABLED, never hidden: a control that vanishes teaches nothing,
  // and the operator who wonders why "always" is missing on a merge has no way
  // to find out. `grantEligible` is the protocol's positive allow-list, so a
  // merge / deploy / dangerous_action / gate — the kinds whose durable grade
  // the server 400s — can never reach a click here.
  const alwaysBlocked = approveBlocked || !props.review.grantEligible;
  const alwaysSentence = props.review.grantEligible
    ? ALWAYS_ACTION_SCOPE_SENTENCE
    : ALWAYS_ACTION_INELIGIBLE_SENTENCE;

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
          onClick={() => props.onDecide("approved", REMEMBER_ACTION_CHOICE)}
          title={scopeSentence}
          type="button"
        >
          Approve, don&rsquo;t ask again
          {props.shortcuts ? <kbd aria-hidden="true">⇧A</kbd> : null}
        </button>
        {/* ADR-0056's `always`: the same opt-in, one scope wider — the CHAT
            rather than the run — and one order of magnitude longer. It is
            NOT keyboard-bound even where the other three are: a decision that
            outlives the run it was made in should cost a deliberate click, and
            the desktop must not grow a shortcut the TUI has no grade for. */}
        <button
          aria-describedby={alwaysNoteId}
          aria-label="Approve, always in this chat"
          className="gate-action approve-always"
          data-approval-action="approve-always"
          disabled={alwaysBlocked || busy}
          onClick={() => props.onDecide("approved", ALWAYS_ACTION_CHOICE)}
          title={alwaysSentence}
          type="button"
        >
          Approve, always in this chat
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
      {/* One short sentence PER durable action, always present, telling the
          truth about how far each promise reaches — or why it cannot apply
          here. Two grades mean two different promises, and a single merged
          sentence would have to be vague about at least one of them. */}
      <small className="gate-consent-note" id={noteId}>
        {scopeSentence}
      </small>
      <small className="gate-consent-note" id={alwaysNoteId}>
        {alwaysSentence}
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
