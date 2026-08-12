/**
 * ⚠️ NOT WIRED. NOTHING CALLS THIS IN PRODUCTION.
 *
 * This module decides WHEN an unattended daemon should be reaped. Nothing
 * persists attach state, nothing invokes the verdict, and nothing terminalises
 * expired work — so real detached execution is currently UNBOUNDED, and the
 * exported contract below must not be read as a live safety guarantee.
 *
 * It ships ahead of its consumer because ADR-0040 is *Proposed*: the horizon
 * VALUE and the quit-path behaviour are founder decisions, and building the
 * sweeper on a guessed number would decide them by default. That was a
 * deliberate call, but shipping a safety-shaped export with no enforcer is how
 * a reader (or a later agent) comes to believe a bound exists.
 *
 * TO MAKE IT REAL, two owners are needed:
 *   1. a writer that records `detachedAt` / `lastAttachedAt` when a surface
 *      attaches or detaches, and
 *   2. the brain-side sweeper (ADR-0028 §4's, reused) calling
 *      `evaluateUnattendedHorizon` and terminalising on `expired`.
 *
 * ADR-0040 D3 — the bound on a detached crew daemon (feature #2).
 *
 * Closing the MUON window may leave the crew running. That removes the
 * compensating fact MUON's whole posture rests on: that a human is reachable
 * when a gate fires. So an unattended daemon is BOUNDED — when no surface has
 * attached within the horizon, the brain-side sweeper terminalises in-flight
 * work through the same reclaim transaction body ADR-0028 §4 already uses for
 * a lapsed attach lease.
 *
 * A crew running for three days on a laptop nobody opened is not resilience;
 * it is an unsupervised process spending money.
 *
 * This module is the DECISION only — pure, injectable clock, no I/O. The
 * sweeper that acts on it lives brain-side, and reusing that existing sweeper
 * rather than adding a second one is deliberate: two liveness models in one
 * brain is how one of them rots, and the rotted one would be the one holding
 * the safety bound.
 */

/**
 * Conservative default: survives a lunch break and an overnight-adjacent run,
 * and bounds spend well short of "I forgot for a week".
 *
 * ADR-0040 leaves the exact value to the founder and recommends exactly this —
 * ship a conservative default, make it configurable, and record the value that
 * was actually in force. `terminalisedByHorizon` carries `horizonMs` for that
 * reason: the number must never be implicit in an audit row.
 */
export const UNATTENDED_HORIZON_DEFAULT_MS = 3 * 60 * 60 * 1000;

/** A configured horizon may never exceed this, whatever a setting says. */
export const UNATTENDED_HORIZON_MAX_MS = 24 * 60 * 60 * 1000;

/** Nor be shorter than this — a horizon under a minute would reap a restart. */
export const UNATTENDED_HORIZON_MIN_MS = 60 * 1000;

/**
 * Clamp a configured horizon into the range MUON will actually honour.
 *
 * A value MUON cannot parse resolves to the DEFAULT, never to "no bound" and
 * never to `UNATTENDED_HORIZON_MAX_MS`: an unreadable setting is an unknown,
 * and the safe reading of an unknown here is the conservative one. This is the
 * same fail-closed-on-uncertainty property ADR-0028 §3 lists.
 */
export function clampUnattendedHorizon(configuredMs: unknown): number {
  if (typeof configuredMs !== "number" || !Number.isFinite(configuredMs)) {
    return UNATTENDED_HORIZON_DEFAULT_MS;
  }
  if (configuredMs <= 0) return UNATTENDED_HORIZON_DEFAULT_MS;
  return Math.min(
    UNATTENDED_HORIZON_MAX_MS,
    Math.max(UNATTENDED_HORIZON_MIN_MS, Math.floor(configuredMs))
  );
}

export type DaemonAttachState = {
  /**
   * Epoch ms this daemon began running unattended. REQUIRED, and the reason
   * the horizon binds at all: it is the one reference point that does not come
   * from an untrusted or absent timestamp, so `lastAttachedAt` can be missing
   * or corrupt without the bound going away.
   *
   * An earlier version of this type omitted it, and the result was a daemon
   * that had never been attended reporting `unattendedMs = 0` forever — the
   * horizon simply never fired. That is the single most common case (the
   * brain/runner pair auto-spawned by a `muon` command, which no surface ever
   * attaches to), so D3 was defeated in exactly the scenario it exists for.
   */
  readonly detachedAt: number;
  /** Epoch ms a surface was last attached, or null if one never has been. */
  readonly lastAttachedAt: number | null;
  /** True while any surface is attached right now. */
  readonly attached: boolean;
  /** Whether the daemon is running detached at all. */
  readonly detached: boolean;
};

export type HorizonVerdict =
  /** Attached, or not detached — the horizon does not apply. */
  | { readonly kind: "not-applicable" }
  /** Detached and inside the horizon. */
  | { readonly kind: "within"; readonly remainingMs: number }
  /** Detached past the horizon: the sweeper should terminalise. */
  | { readonly kind: "expired"; readonly unattendedMs: number; readonly horizonMs: number };

/**
 * Has this detached daemon outlived its horizon?
 *
 * The clock runs from `detachedAt`, and `lastAttachedAt` may only move it
 * FORWARD and only if it is a real past attach. Both of the ways that stamp
 * can be untrustworthy therefore fail CLOSED, which is ADR-0028 §3's fourth
 * property:
 *
 *   - **absent** (never attended) — the daemon still ages from `detachedAt`
 *     and still expires. Treating null as "zero elapsed" made it immortal.
 *   - **in the FUTURE** — ignored entirely rather than trusted. A clock saying
 *     a surface will attach in two hours is a clock to distrust, not a reason
 *     to keep spending; honouring it deferred the reap by exactly the
 *     corruption delta, so a stamp of 2099 bought decades.
 *   - **BEFORE the daemon detached** — ignored, because an attach that
 *     happened before this unattended run began says nothing about this one.
 */
export function evaluateUnattendedHorizon(
  state: DaemonAttachState,
  horizonMs: number,
  now: number
): HorizonVerdict {
  if (!state.detached || state.attached) {
    return { kind: "not-applicable" };
  }
  const horizon = clampUnattendedHorizon(horizonMs);
  const attached = state.lastAttachedAt;
  const trustworthyAttach =
    attached !== null && attached <= now && attached > state.detachedAt;
  const since = trustworthyAttach ? attached : state.detachedAt;
  const unattendedMs = Math.max(0, now - since);
  if (unattendedMs >= horizon) {
    return { kind: "expired", unattendedMs, horizonMs: horizon };
  }
  return { kind: "within", remainingMs: horizon - unattendedMs };
}

/**
 * ADR-0040 D4. A gate still pending when the horizon expires does NOT get
 * approved — the gated action does not happen and the job terminalises with
 * the gate recorded as unanswered.
 *
 * This is a named function rather than an inline `false` so the property is
 * greppable and testable: if it ever returns true for any input, an agent that
 * can cause a gate has found a way to be approved by waiting.
 */
export function horizonApprovesPendingGate(): false {
  return false;
}

/**
 * The audit reason a horizon reap records. Distinguishes "MUON ended this
 * because nobody came back" from an ordinary failure, and states the number
 * that was actually in force so it is never implicit.
 */
export function describeHorizonReap(verdict: {
  unattendedMs: number;
  horizonMs: number;
}): string {
  const hours = (ms: number) => (ms / 3_600_000).toFixed(1);
  return `terminalised by the unattended horizon: no MUON surface attached for ${hours(
    verdict.unattendedMs
  )}h, past the ${hours(
    verdict.horizonMs
  )}h bound. Work was stopped, not failed; any pending approval was left unanswered and NOT granted.`;
}
