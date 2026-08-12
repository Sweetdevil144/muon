import { buildApprovalReview, terminalSafe } from "@muon/client";
import type { ApprovalRequest } from "@muon/client";
import { bold, dim, red, yellow } from "./theme.js";

/**
 * THE ARRIVING GATE — the moment MUON exists for.
 *
 * Everything else on this desk is furniture a terminal multiplexer could
 * offer. The one thing MUON knows that nothing else does is WHEN YOUR AGENTS
 * NEED YOU, and until now it whispered that in a badge: a pending approval
 * sat in the inbox until a human happened to press `ctrl+b i`. A governance
 * product whose governance waits to be discovered is a dashboard.
 *
 * So a gate ARRIVES. The moment one is pending, a band appears directly above
 * the footer — in the terminal a human is already looking at, without taking
 * a column, without stealing focus, and without covering their work. It names
 * the bound ACTION and SCOPE (from the shared review builder, so it says what
 * the desktop would say), how many are queued behind it, and the one chord
 * that answers it.
 *
 * WHAT IT REFUSES TO DO, and why each refusal matters:
 *
 *  - It does NOT steal a key. Answering is `ctrl+b ⏎` — the existing prefix,
 *    no third reserved chord. A vendor CLI keeps every key it had; the
 *    contract that only ctrl+q and ctrl+b are ever taken from a child
 *    survives an arriving gate, which is the whole reason a band was chosen
 *    over a modal that grabs the keyboard.
 *  - It does NOT decide. The chord opens the REVIEW; the decision is a second
 *    press against the evidence. Two presses, exactly as everywhere else.
 *  - It does NOT hide what is behind it. A queue of five says five.
 */

export type GateBandState = {
  /** The oldest pending approval — the one a human should answer next. */
  readonly next: ApprovalRequest;
  /** How many pending in total, including `next`. */
  readonly total: number;
};

/** The gate to announce, or null when nothing is waiting. Pure. */
export function buildGateBand(
  approvals: readonly ApprovalRequest[]
): GateBandState | null {
  // ANSWERABLE HERE, not merely pending. A legacy approval with no structured
  // evidence is `approvable: false`, and the review pane then refuses BOTH
  // keys — so announcing it produced a permanent banner promising an "answer"
  // the desk structurally cannot give, re-drawn on every paint for the rest
  // of the session. If this desk cannot act on it, it must not claim it can.
  const pending = approvals.filter(
    (approval) =>
      approval.status === "pending" && buildApprovalReview(approval).approvable
  );
  if (pending.length === 0) return null;
  // OLDEST first: the queue's own order. Announcing the newest would make a
  // human answer backwards, and the one that has been blocking an agent
  // longest is the one costing them time.
  const next = [...pending].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt))
  )[0]!;
  return { next, total: pending.length };
}

/** One line, rendered directly above the footer. */
export function renderGateBand(state: GateBandState, width: number): string {
  const review = buildApprovalReview(state.next);
  const behind = state.total - 1;
  const risky = review.risk !== undefined;
  const marker = risky ? red(" ⏵ GATE ") : yellow(" ⏵ GATE ");
  const line =
    marker +
    bold(` ${terminalSafe(review.action)}`) +
    dim(` · ${terminalSafe(review.scope)}`) +
    (review.risk ? red(` · ${terminalSafe(review.risk)}`) : "") +
    (behind > 0 ? dim(` · +${behind} waiting`) : "") +
    dim("   ctrl+b ⏎ answer");
  // Clip generously by BYTES here; the shell fits it to visible cells.
  return line.length > width * 4 ? line.slice(0, width * 4) : line;
}
