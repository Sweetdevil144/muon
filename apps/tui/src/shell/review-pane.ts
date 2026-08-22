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

// The certification-state model lives with the merge-review POLICY (D3);
// re-exported here so the pane's consumers keep one import surface.
export type { ReviewCertificationState } from "./merge-review.js";
import type { ReviewCertificationState } from "./merge-review.js";

export type ReviewState = {
  readonly approval: ApprovalRequest;
  readonly review: ApprovalReview;
  /** True while the decision is in flight — a second press must not double-send. */
  readonly resolving: boolean;
  /** Null on every non-merge gate (no certification applies). */
  readonly certification: ReviewCertificationState | null;
};

export function openReview(approval: ApprovalRequest): ReviewState {
  return {
    approval,
    review: buildApprovalReview(approval),
    resolving: false,
    certification: approval.kind === "merge" ? { phase: "loading" } : null,
  };
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

    // Merge coverage certification (I4 shell side): the verdict, the
    // digest it binds to, and the blind files — BEFORE approve is offered.
    const certification = this.state.certification;
    if (certification) {
      lines.push("");
      if (certification.phase === "loading") {
        lines.push(dim(" merge review evidence loading…"));
      } else if (certification.phase === "error") {
        lines.push(red(` ✗ ${terminalSafe(certification.message)}`));
      } else {
        const cert = certification.value;
        if (cert.status === "certified") {
          lines.push(
            green(` coverage ${cert.verdict}`) +
              dim(` · digest ${cert.artifactDigest.slice(0, 12)}`)
          );
        } else {
          lines.push(
            yellow(` coverage BLOCKED (${cert.blockCode})`) +
              dim(` · digest ${cert.artifactDigest.slice(0, 12)}`)
          );
          lines.push(yellow(` ⚠ ${terminalSafe(cert.reason)}`));
          const blind = cert.blindFiles ?? [];
          for (const file of blind.slice(0, 12)) {
            lines.push(dim(`   blind: ${terminalSafe(file)}`));
          }
          if (blind.length > 12) {
            lines.push(
              dim(
                `   … and ${blind.length - 12} more — inspect the complete set on the desktop or with muon approve review`
              )
            );
          }
        }
      }
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
      // The affordance line matches what a press would DO (review finding:
      // advertising `a approve` while the merge evidence forbids it is an
      // action that cannot succeed). Reject stays live in every state.
      const approveBlocked =
        certification !== null &&
        !(
          certification.phase === "loaded" &&
          certification.value.status === "certified"
        );
      // Offered only when the press would SUCCEED: past 12 blind files
      // this desk refuses to attest (the list cannot be inspected here),
      // so the verb is not advertised either — the redirect renders above.
      const attestOffered =
        certification?.phase === "loaded" &&
        certification.value.status === "blocked" &&
        certification.value.blockCode === "review-blind" &&
        (certification.value.blindFiles ?? []).length <= 12;
      const verbs: string[] = [];
      if (!approveBlocked) {
        verbs.push(green(" a approve"));
        if (review.receiptEligible) verbs.push(green("A approve+remember"));
      } else if (certification?.phase === "loading") {
        verbs.push(dim(" approve unlocks when the evidence loads"));
      }
      if (attestOffered) verbs.push(yellow("m attest+approve"));
      verbs.push(red("r reject"));
      lines.push(
        verbs.join(dim(" · ")) +
          dim(" · esc back — this is the second press")
      );
    } else {
      // Not approvable HERE is a statement, not a dead end: say where it can
      // be answered rather than leaving an inert screen.
      lines.push(
        yellow(" this approval cannot be decided from this desk") +
          dim(" — use the desktop app")
      );
    }

    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
