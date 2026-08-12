// ADR-0032 D3/D4 — the desk's attention model.
//
// Folds the shared nine-state `CrewLiveness` machine plus a per-lane `seen` bit
// into the seven display states the rail orders by. Pure and free of Ink so the
// ordering rules are testable as arithmetic rather than as pixels.
//
// The one rule that makes this a governance module rather than a formatting
// one: `seen` may clear a COMPLETION state and nothing else. Looking at a lane
// that is waiting on a gate must never make it look answered — see
// `isSeenClearable`, which is total over the enum and names the clearable state
// positively (ADR-0022 rule 2: a set defined by subtraction silently admits
// whatever is added later).

import type { CrewLiveness } from "@muon/client/crew-liveness";

export type AttentionState =
  /** A human decision is pending. Never cleared by looking. */
  | "blocked"
  /** Failed / interrupted / non-zero exit. Never cleared by looking. */
  | "failed"
  /** Running but degrading: stalled past the startup window, or budget-low. */
  | "warning"
  /** Finished cleanly and NOT yet looked at. Clears to `idle` on focus. */
  | "done"
  /** Running normally; wants nothing from the operator. */
  | "working"
  /** Finished and acknowledged, or simply nothing happening. */
  | "idle"
  /** No signal at all. */
  | "unknown";

/**
 * Rail ordering (ADR-0032 D4). Two orderings are deliberate and easy to get
 * wrong later, so they are stated here rather than only in the ADR:
 *
 *   - `done` outranks `working`: a finished-but-unseen result wants the
 *     operator; a healthy running lane does not.
 *   - `warning` outranks `done`: a stalled lane is burning budget it will not
 *     get back, which is worth interrupting a result-review for.
 */
export const ATTENTION_PRIORITY: Readonly<Record<AttentionState, number>> = {
  blocked: 6,
  failed: 5,
  warning: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/**
 * The states a `seen` bit may clear — named POSITIVELY and exhaustively.
 *
 * `done` is the only one. A pending gate (`blocked`) and a failure (`failed`)
 * persist until the underlying state actually changes, because looking at
 * something is not deciding it and not fixing it. `working`/`warning` are not
 * "clearable" in any sense — they end on their own.
 */
const SEEN_CLEARABLE: Readonly<Record<AttentionState, boolean>> = {
  done: true,
  blocked: false,
  failed: false,
  warning: false,
  working: false,
  idle: false,
  unknown: false,
};

export function isSeenClearable(state: AttentionState): boolean {
  return SEEN_CLEARABLE[state];
}

/**
 * The nine `CrewLiveness` states folded to their attention meaning, BEFORE the
 * `seen` bit is applied. Total by construction: a new liveness state fails to
 * compile here rather than defaulting into a benign bucket.
 */
const LIVENESS_ATTENTION: Readonly<Record<CrewLiveness, AttentionState>> = {
  "waiting-approval": "blocked",
  "needs-attention": "failed",
  stalled: "warning",
  "budget-low": "warning",
  done: "done",
  queued: "working",
  launching: "working",
  live: "working",
  progressing: "working",
};

/**
 * Resolve one lane's display state.
 *
 * `seen` means "the operator has looked at this lane since it last changed".
 * It is applied ONLY through `isSeenClearable`, so this function cannot be the
 * place a pending gate gets quietly downgraded.
 */
export function resolveAttentionState(
  liveness: CrewLiveness | null | undefined,
  seen: boolean
): AttentionState {
  if (!liveness) return "unknown";
  const base = LIVENESS_ATTENTION[liveness];
  if (base === undefined) return "unknown";
  return seen && isSeenClearable(base) ? "idle" : base;
}

export function attentionPriority(state: AttentionState): number {
  return ATTENTION_PRIORITY[state];
}

/**
 * A parent row (workspace / mission) reports its most-demanding child, so the
 * operator never expands a row to discover something needed them. An empty
 * child set is `unknown`, never `idle` — "nothing here" and "everything here is
 * finished" are different facts and the rail should not conflate them.
 */
export function rollUpAttention(
  children: readonly AttentionState[]
): AttentionState {
  let worst: AttentionState = "unknown";
  for (const child of children) {
    if (attentionPriority(child) > attentionPriority(worst)) worst = child;
  }
  return worst;
}

/**
 * Stable attention ordering for a rail: most-demanding first, ties broken by
 * the caller's original order so rows do not shuffle under a poll refresh
 * (a rail that reorders itself while being read is its own defect).
 */
export function sortByAttention<T>(
  rows: readonly T[],
  stateOf: (row: T) => AttentionState
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta =
        attentionPriority(stateOf(b.row)) - attentionPriority(stateOf(a.row));
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Does this state want the operator right now? Drives the NEEDS YOU count. */
export function wantsOperator(state: AttentionState): boolean {
  return state === "blocked" || state === "failed" || state === "done";
}

/**
 * The single scalar the header/footer shows. Counts lanes wanting the operator;
 * pending approvals are added by the caller because a gate can exist with no
 * lane attached to it (a ship gate filed from the CLI, for instance).
 */
export function countWantsOperator(
  states: readonly AttentionState[]
): number {
  return states.filter(wantsOperator).length;
}
