// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ControlRail } from "../src/renderer/cockpit.js";
import type { ApprovalRequest, BlockingQuestion } from "@muon/client";

afterEach(cleanup);

/**
 * ROADMAP H15 residual — a blocking question is a pending human decision.
 *
 * The defect this pins: the rail's "needs you" count summed approvals and
 * proposals only, so a mission whose sole outstanding item was an agent's
 * question rendered "You're clear" over a worker that was sitting still. The
 * count is the fix; ANSWERING deliberately stays in QuestionsInbox, and these
 * tests assert the rail gained no answer path along with the count.
 */

const question = (over: Partial<BlockingQuestion> = {}): BlockingQuestion =>
  ({
    id: "q-1",
    taskId: "task-1",
    subject: "Which retry ceiling should charge() use?",
    body: "30s or 60s — the spec says both in different places.",
    askedByVendor: "codex",
    askedAt: "2026-08-17T09:00:00.000Z",
    status: "open",
    ...over,
  }) as BlockingQuestion;

const approval: ApprovalRequest = {
  id: "approval-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "command",
  reason: "Run the migration",
  status: "pending",
};

function railProps(overrides: Record<string, unknown> = {}) {
  return {
    approvals: [] as ApprovalRequest[],
    proposals: [],
    jobs: [],
    onResolveApproval: vi.fn(),
    onApplyProposal: vi.fn(),
    onDismissProposal: vi.fn(),
    onOpenMemory: vi.fn(),
    onReviewApproval: vi.fn(),
    sections: ["review"] as const,
    ...overrides,
  };
}

const railCount = () =>
  document.querySelector(".control-rail section header b")?.textContent;

const questionLine = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-rail-action="focus-questions"]'
  );

describe("H15 — the needs-you count includes blocking questions", () => {
  it("counts a question the same way it counts a gate", () => {
    render(
      React.createElement(
        ControlRail,
        railProps({ questions: [question()] })
      )
    );
    expect(railCount()).toBe("1");
  });

  it("sums questions WITH approvals and proposals", () => {
    render(
      React.createElement(
        ControlRail,
        railProps({
          approvals: [approval],
          questions: [question(), question({ id: "q-2" })],
        })
      )
    );
    expect(railCount()).toBe("3");
  });

  it("never says 'You're clear' while an agent is blocked on a question", () => {
    render(
      React.createElement(ControlRail, railProps({ questions: [question()] }))
    );
    expect(screen.queryByText(/You're clear/i)).toBeNull();
  });

  it("still says 'You're clear' when genuinely nothing waits", () => {
    render(React.createElement(ControlRail, railProps({ questions: [] })));
    expect(railCount()).toBe("0");
    expect(screen.getByText(/You're clear/i)).toBeTruthy();
  });

  it("refuses to claim you are clear when the questions read FAILED", () => {
    // An unread inbox is not an empty one — the exact overclaim ADR-0043's
    // desktop half exists to prevent.
    render(
      React.createElement(
        ControlRail,
        railProps({ questions: [], questionsUnavailable: true })
      )
    );
    expect(screen.queryByText(/You're clear/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /could not be read/i
    );
  });
});

describe("H15 — the rail names the blocked agent and routes to the answer surface", () => {
  it("renders one entry when a question is open", () => {
    render(
      React.createElement(ControlRail, railProps({ questions: [question()] }))
    );
    const line = questionLine();
    expect(line).toBeTruthy();
    expect(line!.textContent).toMatch(/1 question waiting on you/);
    expect(line!.textContent).toMatch(/Which retry ceiling/);
  });

  it("renders no entry when nothing is blocked", () => {
    render(React.createElement(ControlRail, railProps({ questions: [] })));
    expect(questionLine()).toBeNull();
  });

  it("focuses the QuestionsInbox rather than answering in place", () => {
    const onFocusQuestions = vi.fn();
    render(
      React.createElement(
        ControlRail,
        railProps({ questions: [question()], onFocusQuestions })
      )
    );
    const line = questionLine()!;
    fireEvent.click(line);
    expect(onFocusQuestions).toHaveBeenCalledTimes(1);
    // POWERLESS (ADR-0043): the rail gained a route, not an answer control.
    expect(within(line).queryByRole("textbox")).toBeNull();
    expect(document.querySelector(".control-rail textarea")).toBeNull();
  });

  it("bounds untrusted agent text and renders it as text, never as elements", () => {
    render(
      React.createElement(
        ControlRail,
        railProps({
          questions: [
            question({
              subject: `<img src=x onerror=alert(1)> ${"n".repeat(200)}`,
            }),
          ],
        })
      )
    );
    const line = questionLine()!;
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(line.textContent).toContain("<img src=x onerror=alert(1)>");
    // One agent's essay cannot push the rail around.
    expect(line.textContent!.length).toBeLessThan(200);
  });
});
