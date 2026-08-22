import { z } from "zod";

// ── ADR-0056: graded durable approval grants ─────────────────────────────────
//
// "Always" is a sentence about an ACTION, never about an agent. The operator
// picks one of three GRADES on a decision they are already making; the grade
// decides how long that exact action stays answered, and nothing else about it
// widens. There is no vendor, lane, agent, principal or capability-mode
// dimension here, and none may be added as a widening one — "always approve
// this agent" stays unrepresentable (ROADMAP "Deliberately deferred").
//
// Fail-closed by construction: `once` is the default (mints nothing), every
// durable grade carries a server-computed absolute expiry, and every reader
// applies an independent horizon so a hand-edited row cannot buy an
// un-revocable grant — the `standingApproverIsWatching` discipline (approval.ts)
// applied to a second authority-bearing envelope.

/**
 * The three grades, written down literally. `once` is in the set even though it
 * mints nothing: a bounded surface names every member, and a grade that exists
 * in the product but not in the type is where a fourth meaning gets invented.
 */
export const APPROVAL_GRANT_DURATIONS = ["once", "session", "always"] as const;
export const approvalGrantDurationSchema = z.enum(APPROVAL_GRANT_DURATIONS);
export type ApprovalGrantDuration = z.infer<typeof approvalGrantDurationSchema>;

/**
 * The grades that mint durable authority — stated POSITIVELY as its own literal
 * array, never as `APPROVAL_GRANT_DURATIONS` minus `once`. A tier defined by
 * subtraction silently reclassifies whatever is added next, which this repo has
 * paid for twice.
 */
export const DURABLE_APPROVAL_GRANT_DURATIONS = ["session", "always"] as const;
export type DurableApprovalGrantDuration =
  (typeof DURABLE_APPROVAL_GRANT_DURATIONS)[number];

export function isDurableApprovalGrantDuration(
  duration: ApprovalGrantDuration
): duration is DurableApprovalGrantDuration {
  return (DURABLE_APPROVAL_GRANT_DURATIONS as readonly string[]).includes(
    duration
  );
}

/**
 * How long ONE grade buys, computed SERVER-SIDE. The operator picks a grade,
 * never a number, so a minting request body carries no authority-bearing
 * quantity at all — the same reason `renewStandingApproverLease` derives its
 * expiry from a fixed TTL instead of trusting a caller.
 *
 * `session` is one hour: the ceiling the shipped raw `receipt.ttlMs` dial
 * already allows, so the graded path can never buy more run-scoped time than
 * the ungraded one. `always` is seven days: long enough that a chat spanning a
 * week of dispatches stops re-asking, short enough that a grant an operator
 * forgot about lapses on its own.
 */
export const APPROVAL_GRANT_DURATION_TTL_MS = {
  session: 60 * 60 * 1_000,
  always: 7 * 24 * 60 * 60 * 1_000,
} as const satisfies Record<DurableApprovalGrantDuration, number>;

/**
 * The longest a durable grant may still be believed, measured from the moment
 * it is read. Every issuer above mints far shorter, so this is the independent
 * ceiling a reader applies to a row it did not mint: a corrupted or hand-edited
 * `expiresAt` far in the future can never buy an un-revocable grant.
 */
export const APPROVAL_GRANT_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * The approval kinds a durable grant may EVER cover — an allow-list, not
 * "every kind except merge". A `command` approval is the only one that binds an
 * exact tool + payload + target, so it is the only one a content-bound grant
 * can describe. `merge`, `deploy`, `dangerous_action` and `gate` are
 * authority-shaped rather than content-shaped and stay human-decided every
 * time; an approval kind added tomorrow is human-decided by default, because it
 * is not in this list.
 */
export const GRANTABLE_APPROVAL_KINDS = ["command"] as const;
export type GrantableApprovalKind = (typeof GRANTABLE_APPROVAL_KINDS)[number];

export function isGrantableApprovalKind(kind: string): boolean {
  return (GRANTABLE_APPROVAL_KINDS as readonly string[]).includes(kind);
}

/**
 * Is a durable grant still spendable at `now`?
 *
 * Stated positively, every clause must affirm it: the grant has to exist, it
 * has to be un-revoked, its expiry has to parse, and that expiry has to be both
 * in the future AND inside the horizon a real issuer could have minted. A
 * missing row, a malformed instant, a revoked grant, a lapsed one and an
 * impossible one all resolve the same way — not spendable.
 *
 * Shared by the redeem route and every surface that renders "live", so the
 * brain and the operator can never disagree about which grants are alive.
 */
export function approvalGrantIsLive(
  grant:
    | {
        expiresAt: string | Date;
        revokedAt?: string | Date | null;
      }
    | undefined
    | null,
  now: number = Date.now()
): boolean {
  if (!grant || grant.revokedAt) {
    return false;
  }
  const expiresAt =
    grant.expiresAt instanceof Date
      ? grant.expiresAt.getTime()
      : Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt > now && expiresAt - now <= APPROVAL_GRANT_HORIZON_MS;
}
