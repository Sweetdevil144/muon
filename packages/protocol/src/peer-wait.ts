import { z } from "zod";

/**
 * ADR-0034 — a peer may be waited on.
 *
 * An agent that sends a question today cannot block on the reply: it either
 * finishes without the answer (so the question was pointless) or polls its
 * inbox, burning its own budget on latency it cannot see. This module is the
 * policy half of the fix — what may be waited for, for how long, and what the
 * wait is allowed to return.
 *
 * Three properties do the governance work, all enforced here rather than in a
 * route so every surface inherits them:
 *
 *  1. A wait is CLAMPED to the waiter's own remaining budget (D2). A waiting
 *     agent spends budget on nothing, and unbounded waits compose into
 *     deadlock — two peers each waiting on the other — which prompting does
 *     not reliably prevent.
 *  2. A wait resolves to COORDINATES AND COUNTS, never a peer's text (D3).
 *     The agent blocks on a fact MUON computed, then opens `peer_inbox`
 *     deliberately to read untrusted prose. That is what keeps the A2A
 *     contract's pull-based rule intact.
 *  3. A wait may not be used to satisfy a gate (D5). Crew consensus is not
 *     approval.
 */

/** How long a wait may be asked for before clamping. */
export const MAX_PEER_WAIT_MS = 120_000;
/** Below this a wait is not worth a round trip; callers get an immediate poll. */
export const MIN_PEER_WAIT_MS = 1_000;
/**
 * Budget kept back from any wait, so a lane that waits still has room to act on
 * what it learned. A wait that consumes the last millisecond of a budget has
 * bought the mission nothing.
 */
export const PEER_WAIT_BUDGET_MARGIN_MS = 30_000;

/**
 * What an agent may block on.
 *
 * `peer_state` waits for a named sibling to reach one of the given lifecycle
 * states; `inbox_kind` waits for any message of a kind to arrive. Both resolve
 * to a fact, never to content.
 */
export const peerWaitConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("peer_state"),
    /** The sibling's job id — must be in the caller's chat (checked server-side). */
    jobId: z.string().trim().min(1).max(128),
    /** Any one of these ends the wait. */
    states: z
      .array(z.enum(["working", "blocked", "done", "failed", "idle"]))
      .min(1)
      .max(5),
  }),
  z.object({
    kind: z.literal("inbox_kind"),
    /**
     * Deliberately NOT the full peer-message kind set: an agent waits for a
     * REPLY to something it asked, or for a review verdict. Waiting for
     * `status` or `constraint` chatter is a busy-loop with extra steps.
     */
    messageKind: z.enum(["answer", "review_verdict", "blocked"]),
  }),
]);
export type PeerWaitCondition = z.infer<typeof peerWaitConditionSchema>;

export const peerWaitRequestSchema = z.object({
  condition: peerWaitConditionSchema,
  timeoutMs: z.number().int().positive().max(MAX_PEER_WAIT_MS).optional(),
});
export type PeerWaitRequest = z.infer<typeof peerWaitRequestSchema>;

/** Why a wait ended. `satisfied` is the only outcome that saw the condition. */
export type PeerWaitOutcome = "satisfied" | "timeout" | "budget" | "unavailable";

/**
 * The result — coordinates and counts only (D3).
 *
 * There is no message body, no peer output and no brief anywhere in this shape,
 * and that absence is the contract rather than an omission to be filled in
 * later.
 */
export type PeerWaitResult = {
  readonly outcome: PeerWaitOutcome;
  readonly waitedMs: number;
  /** The state actually observed, when the condition was about a peer. */
  readonly observedState?: string;
  /** How many matching inbox items are now unread, when it was about the inbox. */
  readonly matchingUnread?: number;
  /** Set when the wait was cut short by the clamp rather than the request. */
  readonly clampedFrom?: number;
};

export type WaitClamp = {
  readonly timeoutMs: number;
  /** True when the caller asked for longer than it may have. */
  readonly clamped: boolean;
  /** Present when the clamp came from the budget rather than the ceiling. */
  readonly reason?: "ceiling" | "budget" | "floor";
};

/**
 * Resolve how long this wait may actually run.
 *
 * Order matters: the ceiling is a constant, but the BUDGET clamp is what stops
 * a wait outliving its waiter, so it is applied after and wins. A caller with
 * no known remaining budget gets the ceiling — the runner's own deadline is
 * still above it, so this cannot produce an unbounded wait.
 */
export function clampWaitTimeout(
  requestedMs: number | undefined,
  remainingBudgetMs: number | null | undefined
): WaitClamp {
  const asked = requestedMs ?? MAX_PEER_WAIT_MS;
  let timeoutMs = Math.min(asked, MAX_PEER_WAIT_MS);
  let reason: WaitClamp["reason"] = asked > MAX_PEER_WAIT_MS ? "ceiling" : undefined;

  if (typeof remainingBudgetMs === "number" && Number.isFinite(remainingBudgetMs)) {
    const usable = remainingBudgetMs - PEER_WAIT_BUDGET_MARGIN_MS;
    if (usable < timeoutMs) {
      timeoutMs = usable;
      reason = "budget";
    }
  }

  if (timeoutMs < MIN_PEER_WAIT_MS) {
    // Not enough room to be worth blocking. The caller still gets a single
    // immediate check — "no" now beats "no" in a second.
    return { timeoutMs: 0, clamped: true, reason: timeoutMs <= 0 ? "budget" : "floor" };
  }
  return { timeoutMs, clamped: timeoutMs < asked, reason };
}

/** Does an observed lifecycle state satisfy the condition? */
export function conditionSatisfied(
  condition: PeerWaitCondition,
  observed: { state?: string; matchingUnread?: number }
): boolean {
  if (condition.kind === "peer_state") {
    return Boolean(
      observed.state &&
        (condition.states as readonly string[]).includes(observed.state)
    );
  }
  return (observed.matchingUnread ?? 0) > 0;
}

/**
 * The escalation payload for D5: when a crew ask times out, the human's inbox
 * item says the CREW could not resolve it — which is a cheaper decision than
 * "an agent is stuck" — and carries the exchange as evidence.
 *
 * Coordinates only, consistent with D3: the question's subject is included
 * (the agent wrote it and it is bounded at 120 chars by the A2A caps) but no
 * message body is.
 */
export type CrewAskEscalation = {
  readonly askedJobIds: readonly string[];
  readonly askedRoles: readonly string[];
  readonly subject: string;
  readonly waitedMs: number;
  readonly answered: false;
};

export function buildCrewAskEscalation(input: {
  askedJobIds: readonly string[];
  askedRoles: readonly string[];
  subject: string;
  waitedMs: number;
}): CrewAskEscalation {
  return {
    askedJobIds: [...input.askedJobIds],
    askedRoles: [...input.askedRoles],
    subject: input.subject,
    waitedMs: input.waitedMs,
    answered: false,
  };
}

/**
 * One sentence for the human's inbox. Deliberately reports what MUON did — who
 * was asked and for how long — rather than paraphrasing the agent's question,
 * which is untrusted text the operator will read separately.
 */
export function describeCrewAsk(escalation: CrewAskEscalation): string {
  const who =
    escalation.askedRoles.length > 0
      ? escalation.askedRoles.join(", ")
      : `${escalation.askedJobIds.length} peer(s)`;
  const seconds = Math.round(escalation.waitedMs / 1000);
  return `The crew could not resolve this: asked ${who}, waited ${seconds}s, no answer. Subject: ${escalation.subject}`;
}
