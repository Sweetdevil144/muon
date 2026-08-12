// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalReview } from "@muon/client/approval-review";
import type { ApprovalRequest } from "@muon/client";
import {
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

describe("the review gate's three actions", () => {
  it("renders exactly three, in the founder's order, and nothing else", () => {
    const { view } = renderActions(EDIT_GATE);
    const buttons = actions(view.container);
    expect(buttons.map((button) => button.dataset.approvalAction)).toEqual([
      "approve",
      "approve-remember",
      "reject",
    ]);
    // Every control in the group is one of the three — no toggles, no picker,
    // no expandable option list.
    expect(view.container.querySelectorAll("button")).toHaveLength(3);
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.querySelector("select")).toBeNull();
    expect(view.container.querySelector("details")).toBeNull();
  });

  it("dispatches the exact governed call for each action", () => {
    const { onDecide, view } = renderActions(EDIT_GATE);
    const [approve, remember, reject] = actions(view.container);

    fireEvent.click(approve!);
    expect(onDecide).toHaveBeenLastCalledWith("approved");

    // Standing consent = the EXISTING content-bound receipt opt-in riding the
    // same resolve, with the one shared 15-minute lifetime.
    fireEvent.click(remember!);
    expect(onDecide).toHaveBeenLastCalledWith("approved", 900_000);
    expect(REMEMBER_ACTION_TTL_MS).toBe(900_000);

    fireEvent.click(reject!);
    expect(onDecide).toHaveBeenLastCalledWith("rejected");
  });

  it("states the exact scope of 'don't ask again' on screen and on the button", () => {
    const { view } = renderActions(EDIT_GATE);
    const remember = actions(view.container)[1]!;
    const sentence =
      "Auto-approves this exact action, in this run, for the next 15 minutes.";
    expect(remember.getAttribute("title")).toBe(sentence);
    expect(screen.getByText(sentence)).toBeTruthy();
    // The note is what the button points at, so a screen reader hears the
    // scope with the label.
    expect(remember.getAttribute("aria-describedby")).toBe(
      screen.getByText(sentence).id
    );
  });

  it("disables 'don't ask again' for an always-ask action, and says why — the row stays three-wide", () => {
    const { onDecide, view } = renderActions(NETWORK_GATE);
    const [approve, remember, reject] = actions(view.container);
    expect(actions(view.container)).toHaveLength(3);
    expect(approve!.hasAttribute("disabled")).toBe(false);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText(
        /this one always asks — only file reads, edits inside the task radius, and configured checks can be remembered\./i
      )
    ).toBeTruthy();
    fireEvent.click(remember!);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("keeps Reject alive when the evidence is too degraded to approve", () => {
    const { onDecide, view } = renderActions(MALFORMED_GATE);
    const [approve, remember, reject] = actions(view.container);
    expect(approve!.hasAttribute("disabled")).toBe(true);
    expect(remember!.hasAttribute("disabled")).toBe(true);
    expect(reject!.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reject!);
    expect(onDecide).toHaveBeenLastCalledWith("rejected");
  });

  it("blocks BOTH approves — never Reject — while an outer surface withholds approval", () => {
    const { onDecide, view } = renderActions(EDIT_GATE, {
      approveBlockedReason: "Merge review has not certified this artifact.",
    });
    const [approve, remember, reject] = actions(view.container);
    expect(approve!.hasAttribute("disabled")).toBe(true);
    expect(remember!.hasAttribute("disabled")).toBe(true);
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
    expect(actions(view.container)).toHaveLength(3);
  });
});
