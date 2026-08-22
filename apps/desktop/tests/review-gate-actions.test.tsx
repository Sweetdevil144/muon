// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalReview } from "@muon/client/approval-review";
import type { ApprovalRequest } from "@muon/client";
import {
  ALWAYS_ACTION_GRANT_DURATION,
  REMEMBER_ACTION_TTL_MS,
  ReviewGateActions,
} from "../src/renderer/review-gate.js";

afterEach(cleanup);

const EDIT_GATE: ApprovalRequest = {
  id: "approval-edit",
  taskId: "task-1",
  jobId: "job-1",
  requestedBy: "codex",
  kind: "command",
  reason: "session tool 'Edit' (session session-1)",
  status: "pending",
  gateTag: null,
  evidence: {
    action: "Edit",
    scope: "File: src/parser.ts",
    riskLevel: "medium",
    impactIfApproved: "Edits one file in the selected workspace.",
    payloadDigest: "d".repeat(64),
    details: { path: "src/parser.ts", sessionId: "session-1" },
  },
} as unknown as ApprovalRequest;

const NETWORK_GATE = {
  ...EDIT_GATE,
  id: "approval-network",
  evidence: {
    ...EDIT_GATE.evidence!,
    action: "WebFetch",
    scope: "https://example.com",
    details: { url: "https://example.com", sessionId: "session-1" },
  },
} as ApprovalRequest;

// ADR-0056 D6: `merge` is NOT on `GRANTABLE_APPROVAL_KINDS`, and the backend
// answers a merge carrying a durable grade with a 400 that leaves the approval
// PENDING. This fixture is the one the "always" button must never be live for.
const MERGE_GATE = {
  ...EDIT_GATE,
  id: "approval-merge",
  kind: "merge",
  reason: "land the worktree",
  evidence: undefined,
} as unknown as ApprovalRequest;

const MALFORMED_GATE = {
  ...EDIT_GATE,
  id: "approval-malformed",
  evidence: undefined,
} as ApprovalRequest;

function renderActions(
  approval: ApprovalRequest,
  over: Partial<React.ComponentProps<typeof ReviewGateActions>> = {}
) {
  const onDecide = vi.fn();
  const view = render(
    React.createElement(ReviewGateActions, {
      review: buildApprovalReview(approval),
      status: approval.status,
      onDecide,
      ...over,
    })
  );
  return { onDecide, view };
}

const actions = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-approval-action]")
  );

describe("the review gate's four actions", () => {
  it("renders exactly four, in the founder's order, and nothing else", () => {
    const { view } = renderActions(EDIT_GATE);
    const buttons = actions(view.container);
    // Three approves graded by how long they last (ADR-0056 once/session/
    // always), then the deny. The deny is last and full-size, never small.
    expect(buttons.map((button) => button.dataset.approvalAction)).toEqual([
      "approve",
      "approve-remember",
      "approve-always",
      "reject",
    ]);
    // Every control in the group is one of the four — no toggles, no picker,
    // no expandable option list, and above all no duration input: the operator
    // chooses a GRADE, never a number.
    expect(view.container.querySelectorAll("button")).toHaveLength(4);
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.querySelector("select")).toBeNull();
    expect(view.container.querySelector("details")).toBeNull();
  });

  it("dispatches the exact governed call for each action", () => {
    const { onDecide, view } = renderActions(EDIT_GATE);
    const [approve, remember, always, reject] = actions(view.container);

    fireEvent.click(approve!);
    expect(onDecide).toHaveBeenLastCalledWith("approved");

    // Standing consent = the EXISTING content-bound receipt opt-in riding the
    // same resolve, with the one shared 15-minute lifetime.
    fireEvent.click(remember!);
    expect(onDecide).toHaveBeenLastCalledWith("approved", {
      grade: "session",
      receiptTtlMs: 900_000,
    });
    expect(REMEMBER_ACTION_TTL_MS).toBe(900_000);

    // ADR-0056 `always` = a GRADE, never a number. Nothing about the 7-day
    // expiry crosses the wire from this click; the server computes it.
    fireEvent.click(always!);
    expect(onDecide).toHaveBeenLastCalledWith("approved", {
      grade: "always",
      grantDuration: "always",
    });
    expect(ALWAYS_ACTION_GRANT_DURATION).toBe("always");

    fireEvent.click(reject!);
    expect(onDecide).toHaveBeenLastCalledWith("rejected");
  });

  it("never lets one click carry both a receipt and a grade", () => {
    const { onDecide, view } = renderActions(EDIT_GATE);
    for (const button of actions(view.container)) {
      fireEvent.click(button);
    }
    // The durable choice is ONE union value, so "receipt + grade" is not a
    // state any click can produce — the shared builder's refusal of that pair
    // is unreachable from this surface, not merely untriggered.
    for (const call of onDecide.mock.calls) {
      const durable = call[1] as
        | Record<string, unknown>
        | undefined;
      if (durable === undefined) continue;
      const carriesReceipt = "receiptTtlMs" in durable;
      const carriesGrade = "grantDuration" in durable;
      expect(carriesReceipt && carriesGrade).toBe(false);
    }
  });

  it("states the exact scope of each remembering approve, on screen and on the button", () => {
    const { view } = renderActions(EDIT_GATE);
    const [, remember, always] = actions(view.container);

    const runSentence =
      "Auto-approves this exact action, in this run, for the next 15 minutes.";
    expect(remember!.getAttribute("title")).toBe(runSentence);
    expect(screen.getByText(runSentence)).toBeTruthy();
    expect(remember!.getAttribute("aria-describedby")).toBe(
      screen.getByText(runSentence).id
    );

    // The `always` promise is a DIFFERENT sentence, because it is a different
    // promise: the chat rather than the run, 7 days rather than 15 minutes,
    // and revocable. It never says "always" unqualified.
    const chatSentence =
      "Auto-approves this exact action, in this chat only, for the next 7 days. Revoke it any time.";
    expect(always!.getAttribute("title")).toBe(chatSentence);
    expect(screen.getByText(chatSentence)).toBeTruthy();
    expect(always!.getAttribute("aria-describedby")).toBe(
      screen.getByText(chatSentence).id
    );
    expect(always!.textContent).toContain("in this chat");
    // "always everywhere" is exactly what this grade is NOT.
    expect(always!.textContent).not.toMatch(/everywhere|all chats|any chat/i);
  });

  it("disables BOTH remembering approves for an always-ask action, and says why — the row stays four-wide", () => {
    const { onDecide, view } = renderActions(NETWORK_GATE);
    const [approve, remember, always, reject] = actions(view.container);
    expect(actions(view.container)).toHaveLength(4);
    expect(approve!.hasAttribute("disabled")).toBe(false);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(always!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText(
        /this one always asks — only file reads, edits inside the task radius, and configured checks can be remembered\./i
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        /no chat-wide grant here — merges, releases, capability changes and anything muon cannot classify are decided by a human every time\./i
      )
    ).toBeTruthy();
    fireEvent.click(remember!);
    fireEvent.click(always!);
    expect(onDecide).not.toHaveBeenCalled();
  });

  // THE ONE THAT MATTERS: a merge carrying a durable grade is a hard 400 that
  // leaves the approval PENDING. A button that always fails teaches the
  // operator the app is broken, so it is disabled and explains itself — while
  // the plain Approve and the Reject stay exactly as live as they were.
  it("refuses 'always' for a merge — disabled, explained, and still approvable once", () => {
    const { onDecide, view } = renderActions(MERGE_GATE);
    const [approve, remember, always, reject] = actions(view.container);
    expect(actions(view.container)).toHaveLength(4);
    expect(always!.hasAttribute("disabled")).toBe(true);
    expect(always!.getAttribute("title")).toMatch(
      /no chat-wide grant here — merges, releases, capability changes/i
    );
    expect(remember!.hasAttribute("disabled")).toBe(true);
    // The `once` grade is untouched: a merge is still decided, every time.
    expect(approve!.hasAttribute("disabled")).toBe(false);
    expect(reject!.hasAttribute("disabled")).toBe(false);

    fireEvent.click(always!);
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(approve!);
    expect(onDecide).toHaveBeenLastCalledWith("approved");
  });

  it("keeps Reject alive when the evidence is too degraded to approve", () => {
    const { onDecide, view } = renderActions(MALFORMED_GATE);
    const [approve, remember, always, reject] = actions(view.container);
    expect(approve!.hasAttribute("disabled")).toBe(true);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(always!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reject!);
    expect(onDecide).toHaveBeenLastCalledWith("rejected");
  });

  it("blocks ALL THREE approves — never Reject — while an outer surface withholds approval", () => {
    const { onDecide, view } = renderActions(EDIT_GATE, {
      approveBlockedReason: "Merge review has not certified this artifact.",
    });
    const [approve, remember, always, reject] = actions(view.container);
    expect(approve!.hasAttribute("disabled")).toBe(true);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(always!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reject!);
    expect(onDecide).toHaveBeenLastCalledWith("rejected");
  });

  it("renders NO actions for a decided gate — a decision is history, not a control", () => {
    for (const status of ["approved", "rejected", "expired"]) {
      const { view } = renderActions({
        ...EDIT_GATE,
        status,
      } as ApprovalRequest);
      expect(actions(view.container)).toHaveLength(0);
      cleanup();
    }
  });

  it("goes inert while a decision is in flight, so one gate can never send two", () => {
    const { onDecide, view } = renderActions(EDIT_GATE, { busy: true });
    for (const button of actions(view.container)) {
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
    }
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("surfaces a refused decision instead of failing silently", () => {
    const { view } = renderActions(EDIT_GATE, {
      error: "The selected chat changed before the decision.",
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "The selected chat changed before the decision."
    );
    expect(actions(view.container)).toHaveLength(4);
  });
});
