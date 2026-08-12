import { buildApprovalReview, terminalSafe } from "@muon/client";
import type { ApprovalRequest, ApprovalReview } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * The review — what a second press acts on (matrix rows I1/I2, A26).
 *
 * EVIDENCE-FIRST IS THE RULE, and this pane exists because the first version
 * of the inbox rail broke it: `a` and `r` decided straight off a row showing
 * only an action and a scope. The classic desk, the desktop gate and the
 * palette all use the same two-press shape, and its docstring says why —
 * a decision must be bound to the approval a human just READ, not to a list
 * index that a 2-second poll may have moved underneath them.
 *
 * So: the first press OPENS this, showing the evidence the review builder
 * derived (consequence, binding, authority, risk, digest, details). Only the
 * second press decides, and it decides on THIS approval's id, captured when
 * the review opened.
 *
 * DEGRADED evidence is stated, never hidden. A review the builder could not
 * fully derive is exactly when a human most needs to know they are being
 * asked to agree to something MUON cannot fully describe.
 */

export type ReviewState = {
  readonly approval: ApprovalRequest;
  readonly review: ApprovalReview;
  /** True while the decision is in flight — a second press must not double-send. */
  readonly resolving: boolean;
};

export function openReview(approval: ApprovalRequest): ReviewState {
  return { approval, review: buildApprovalReview(approval), resolving: false };
}

export class ReviewPane implements Component {
  private state: ReviewState;

  constructor(state: ReviewState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { review, resolving } = this.state;
    const lines: string[] = [
      bold(" review ") + dim(terminalSafe(this.state.approval.id)),
      "",
      cyan(" action  ") + terminalSafe(review.action),
      dim(" scope   ") + terminalSafe(review.scope),
    ];

    // The four sentences the gate is built around. Each is rendered even when
    // empty-ish, because a MISSING consequence is itself information.
    lines.push(dim(" effect  ") + terminalSafe(review.consequence));
    lines.push(dim(" bound   ") + terminalSafe(review.binding));
    lines.push(dim(" author  ") + terminalSafe(review.authority));
    if (review.risk) {
      lines.push(red(" risk    ") + terminalSafe(review.risk));
    }
    if (review.payloadDigest) {
      lines.push(dim(" digest  ") + terminalSafe(review.payloadDigest));
    }
    for (const detail of review.details ?? []) {
      lines.push(
        dim(`   ${terminalSafe(detail.label)}: `) + terminalSafe(detail.value)
      );
    }

    if (review.degraded) {
      lines.push(
        "",
        yellow(
          ` ⚠ evidence incomplete${
            review.degradationReason
              ? `: ${terminalSafe(review.degradationReason)}`
              : ""
          }`
        )
      );
    }

    lines.push("");
    if (resolving) {
      lines.push(dim(" deciding…"));
    } else if (review.approvable) {
      lines.push(
        green(" a approve") +
          dim(" · ") +
          red("r reject") +
          dim(" · esc back — this is the second press")
      );
    } else {
      // Not approvable HERE is a statement, not a dead end: say where it can
      // be answered rather than leaving an inert screen.
      lines.push(
        yellow(" this approval cannot be decided from this desk") +
          dim(" — use the desktop or `npm run tui:ink`")
      );
    }

    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
