import { buildApprovalReview, terminalSafe } from "@muon/client";
import type { ApprovalRequest, BlockingQuestion } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, red, yellow } from "./theme.js";

/**
 * The inbox rail — pending approvals, on the desk that hosts the agents
 * asking for them (matrix row I1).
 *
 * WHAT MAKES A ROW USEFUL is not the approval's `kind`. The classic desk
 * printed exactly that (`approval.kind`) and it is the least informative
 * field on the record: "tool-call" tells a human nothing about what is about
 * to happen to their machine. Rows here are derived with the SAME
 * `buildApprovalReview` the desktop's review gate uses, so the row names the
 * bound ACTION and its SCOPE — one derivation, two surfaces, and a human
 * reading the TUI sees the sentence they would have seen in the app.
 *
 * FOLDING: agents ask in bursts, and twenty rows from one job is a wall, not
 * an inbox. Same-job siblings fold under the first, which then says how many
 * decisions follow it. The count is the honest part — a folded row that hid
 * its siblings silently would understate what the human is agreeing to next.
 */

export type InboxRow = {
  readonly approval: ApprovalRequest;
  readonly action: string;
  readonly scope: string;
  readonly risk: string | undefined;
  readonly degraded: boolean;
  /** Same-job approvals folded under this row. */
  readonly foldedBehind: number;
};

export type InboxState = {
  readonly rows: readonly InboxRow[];
  readonly cursor: number;
  readonly focused: boolean;
  /**
   * OPEN blocking questions (ADR-0043) — the surface-parity item: agents
   * asked and the TUI showed nothing. VIEW-ONLY here by design, not by
   * accident: answering needs composed prose, and this rail's key model is
   * single-key decisions. The rows say exactly where the answer lives, so
   * nothing advertised is inert.
   */
  readonly questions: readonly BlockingQuestion[];
};

export const INBOX_WIDTH = 34;

/** Rows the rail shows at once; the cursor is always inside this window. */
export const INBOX_VIEWPORT_ROWS = 8;

/** Group by job, keep the first of each, and count what folds behind it. */
export function buildInboxRows(
  approvals: readonly ApprovalRequest[]
): InboxRow[] {
  // PENDING ONLY. `GET /api/approvals` returns every approval ever created,
  // newest first, with no status filter — every other surface filters here
  // (`CockpitPanels.tsx`, desktop `main.ts`, the approvals monitor) and this
  // rail did not. The header counted history, the fold counted decided
  // siblings, and pressing `a` on the newest row hit a 409 because it had
  // already been answered.
  const byJob = new Map<string, ApprovalRequest[]>();
  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    // An approval with no job is its OWN group — folding those together would
    // hide unrelated decisions behind one another.
    const key = approval.jobId ?? `solo:${approval.id}`;
    const bucket = byJob.get(key);
    if (bucket) bucket.push(approval);
    else byJob.set(key, [approval]);
  }
  const rows: InboxRow[] = [];
  for (const group of byJob.values()) {
    // The list arrives newest-first, so `group[0]` was the LAST decision filed
    // while the row said "+N behind it" — backwards. Oldest first is the
    // queue's own order.
    const ordered = [...group].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    );
    const reviews = ordered.map((approval) => ({
      approval,
      review: buildApprovalReview(approval),
    }));
    const head = reviews[0]!;
    // A fold must never hide a SHARPER decision than the one it shows. The
    // risk and the degradation reported are the worst in the group, not the
    // head's — otherwise a `rm -rf` gate folded behind a file read rendered
    // as a file read with no risk line at all.
    const risk =
      reviews.find((entry) => entry.review.risk)?.review.risk ?? undefined;
    rows.push({
      approval: head.approval,
      action: head.review.action,
      scope: head.review.scope,
      risk,
      degraded: reviews.some((entry) => entry.review.degraded),
      foldedBehind: ordered.length - 1,
    });
  }
  return rows;
}

/**
 * How many questions the rail NAMES.
 *
 * Shared with `/answer`, which picks by position off this list: the command
 * must not accept a number the rail never showed, because answering a question
 * you cannot see is answering blind — and the failure it produces is telling
 * the wrong agent the wrong thing. The rail says "… N more" when it caps, and
 * the way to reach those is to answer the ones on screen first.
 */
export const INBOX_NAMED_QUESTIONS = 3;

export class Inbox implements Component {
  private state: InboxState;

  constructor(state: InboxState) {
    this.state = state;
  }

  update(state: InboxState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const count = this.state.rows.length;
    const questionCount = this.state.questions.length;
    lines.push(
      count === 0 && questionCount === 0
        ? dim(" inbox")
        : bold(` inbox `) +
            yellow(
              `${count + questionCount} need${count + questionCount === 1 ? "s" : ""} you`
            )
    );

    // Agents' blocking questions FIRST: a blocked agent outranks a gate the
    // runner is already holding closed. Subjects are UNTRUSTED agent text —
    // terminalSafe, like every transcript surface.
    if (questionCount > 0) {
      lines.push(
        red(` ? ${questionCount} question${questionCount === 1 ? "" : "s"} from agents`)
      );
      this.state.questions
        .slice(0, INBOX_NAMED_QUESTIONS)
        .forEach((question, index) => {
        // NUMBERED, because `/answer` picks by position: an unnumbered list
        // beside a command that takes a number is a puzzle, not an affordance.
        lines.push(
          dim(`   ${index + 1}. ${terminalSafe(question.askedByVendor)}: `) +
            terminalSafe(question.subject)
        );
      });
      if (questionCount > INBOX_NAMED_QUESTIONS) {
        lines.push(
          dim(`   … ${questionCount - INBOX_NAMED_QUESTIONS} more, after these`)
        );
      }
      // ADVERTISED = WORKS: `/answer` runs here now. It used to send the human
      // to another surface, which is how the terminal stopped being the hero
      // for the one thing that blocks a crew.
      lines.push(dim("   /answer <n> to unblock — they are numbered above"));
    }

    if (count === 0) {
      if (questionCount === 0) {
        lines.push(dim(" nothing waiting on you"));
      }
      return lines.map((line) => clip(line, width));
    }

    // A VIEWPORT: the cursor is the binding target for the review, so it must
    // be ON SCREEN. Without this it slid off the bottom while still selecting
    // the approval a press would open.
    const first = Math.max(
      0,
      Math.min(
        this.state.cursor - Math.floor(INBOX_VIEWPORT_ROWS / 2),
        this.state.rows.length - INBOX_VIEWPORT_ROWS
      )
    );
    const window = this.state.rows.slice(first, first + INBOX_VIEWPORT_ROWS);
    if (first > 0) lines.push(dim(`   ↑ ${first} above`));
    window.forEach((row, offset) => {
      const index = first + offset;
      const active = this.state.focused && index === this.state.cursor;
      const marker = active ? cyan("›") : " ";
      const action = terminalSafe(row.action);
      lines.push(` ${marker} ${active ? bold(action) : action}`);
      lines.push(dim(`   ${terminalSafe(row.scope)}`));
      if (row.degraded) {
        // The review builder could not derive full evidence. Say so on the
        // ROW: a human should not have to open it to learn it is degraded.
        lines.push(yellow("   ⚠ evidence incomplete"));
      }
      if (row.risk) {
        lines.push(red(`   ${terminalSafe(row.risk)}`));
      }
      if (row.foldedBehind > 0) {
        lines.push(
          dim(`   +${row.foldedBehind} more from this job behind it`)
        );
      }
    });

    const below = this.state.rows.length - (first + window.length);
    if (below > 0) lines.push(dim(`   ↓ ${below} below`));

    return lines.map((line) => clip(line, width));
  }
}

function clip(line: string, width: number): string {
  return line.length > width * 4 ? line.slice(0, width * 4) : line;
}
