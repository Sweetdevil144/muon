// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

/**
 * ADR-0056 on the desktop: the `always` grade, end to end and REACHABLE.
 *
 * The component tests next door prove the button renders and what it hands its
 * callback. This file proves the App actually wires that callback to the typed
 * bridge — and, more importantly, that the two shipped decision paths (plain
 * Approve, "don't ask again") still send EXACTLY what they sent before, so a
 * new grade cannot quietly re-interpret a decision a human already knew how to
 * make.
 *
 * The main-process half is asserted at the source level, the same discipline
 * `resolve-approval-soft-skip.test.ts` uses: the handler is Electron-bound and
 * cannot be imported, but the properties that matter (one durable authority,
 * the shared builder, a visible mint) are all textual.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EDIT_EVIDENCE = {
  action: "Edit",
  scope: "File: src/pay/charge.ts",
  riskLevel: "medium",
  impactIfApproved: "Edits one file in the selected workspace.",
  payloadDigest: "d".repeat(64),
  details: { path: "src/pay/charge.ts", sessionId: "session-1" },
};

function desktopState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: { counts: { codex: 1 }, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Cap the retries",
        workspacePath: "/work/MUON-LABS",
        status: "active",
        taskId: "task-1",
        createdAt: "2026-08-17T08:00:00.000Z",
        updatedAt: "2026-08-17T08:00:00.000Z",
      },
    ],
    approvals: [
      {
        id: "approval-edit",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "command",
        reason: "session tool 'Edit' (session session-1)",
        status: "pending",
        createdAt: "2026-08-17T08:02:00.000Z",
        evidence: EDIT_EVIDENCE,
      },
      {
        id: "approval-merge",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "merge",
        reason: "ship requested from MUON desktop: 1 file changed",
        status: "pending",
        createdAt: "2026-08-17T08:03:00.000Z",
      },
    ],
    questions: [],
    questionsTruncated: false,
    questionsUnavailable: false,
    tasks: [
      {
        id: "task-1",
        title: "Cap the retries",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-root",
        kind: "session",
        vendor: "codex",
        taskId: "task-1",
        chatId: "chat-1",
        agentId: "agent-1",
        brief: "Cap the retries in the task worktree.",
        workspacePath: "/work/MUON-LABS",
        executionPath: "/work/MUON-LABS",
        status: "running",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-08-17T08:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const handlers = new Map<string, (payload: never) => void>();
  const resolveApproval = vi.fn().mockResolvedValue({});
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    streams: vi.fn().mockResolvedValue([]),
    workspaceReview: vi
      .fn()
      .mockResolvedValue({ status: "unavailable", reason: "not under test" }),
    taskHandoffs: vi.fn().mockResolvedValue({ omitted: 0, items: [] }),
    reviewApproval: vi.fn().mockResolvedValue({
      status: "certified",
      verdict: "graph-certified",
      changedFiles: ["src/pay/charge.ts"],
      artifactDigest: "b".repeat(64),
    }),
    reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "n/a" }),
    autoContext: vi.fn().mockResolvedValue(null),
    preEditContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    reconMap: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    answerQuestion: vi.fn().mockResolvedValue({ answered: true }),
    resolveApproval,
    shipTask: vi.fn(),
  };
  Object.assign(window, { muon });
  return {
    resolveApproval,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload as never);
    },
  };
}

async function openApproval(
  emit: (event: string, payload: unknown) => void,
  approvalId: string
) {
  emit("muon:open-approval", { approvalId });
  return screen.findByRole("dialog", { name: "Approval review" });
}

const action = (dialog: HTMLElement, name: string) =>
  dialog.querySelector<HTMLButtonElement>(`[data-approval-action="${name}"]`)!;

describe("ADR-0056 — the desktop can offer the `always` grade", () => {
  it("sends grant: always through the typed bridge, and no receipt with it", async () => {
    const { emit, resolveApproval } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    const dialog = await openApproval(emit, "approval-edit");

    const always = action(dialog, "approve-always");
    expect(always.hasAttribute("disabled")).toBe(false);
    fireEvent.click(always);

    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith({
        approvalId: "approval-edit",
        status: "approved",
        // A GRADE, never a number: the 7-day expiry is computed server-side.
        grantDuration: "always",
        // ADR-0056 D4 — one decision carries ONE durable authority. The
        // renderer holds a union, so this can only ever be absent here.
        receiptTtlMs: undefined,
        manualReview: undefined,
      })
    );
    const payload = resolveApproval.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.receiptTtlMs).toBeUndefined();
    expect(payload.grantDuration).toBe("always");
  });

  it("leaves plain Approve byte-identical: no receipt, no grade", async () => {
    const { emit, resolveApproval } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    const dialog = await openApproval(emit, "approval-edit");

    fireEvent.click(action(dialog, "approve"));
    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith({
        approvalId: "approval-edit",
        status: "approved",
        receiptTtlMs: undefined,
        grantDuration: undefined,
        manualReview: undefined,
      })
    );
  });

  it("leaves 'don't ask again' byte-identical: the shipped 15-minute receipt, no grade", async () => {
    const { emit, resolveApproval } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    const dialog = await openApproval(emit, "approval-edit");

    fireEvent.click(action(dialog, "approve-remember"));
    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith({
        approvalId: "approval-edit",
        status: "approved",
        receiptTtlMs: 900_000,
        grantDuration: undefined,
        manualReview: undefined,
      })
    );
  });

  // THE ONE THAT MATTERS. The backend answers a merge carrying a durable grade
  // with a 400 and leaves the approval PENDING. An operator who presses a
  // button that always fails learns the app is broken, so the affordance is
  // disabled and explains itself — and no click can reach the bridge.
  it("never dispatches a grade for a merge — disabled, explained, nothing sent", async () => {
    const { emit, resolveApproval } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    const dialog = await openApproval(emit, "approval-merge");

    const always = action(dialog, "approve-always");
    expect(always.hasAttribute("disabled")).toBe(true);
    // The TITLE is the proof that the KIND refused the grade, not the merge
    // dialog's certification block: `approveBlockedReason` never reaches this
    // button's title, so this exact sentence can only come from
    // `grantEligible === false`. (The same property with Approve fully live is
    // pinned in review-gate-actions.test.tsx.)
    expect(always.getAttribute("title")).toMatch(
      /no chat-wide grant here — merges, releases, capability changes/i
    );
    fireEvent.click(always);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveApproval).not.toHaveBeenCalled();
    // Denying is still one click — a grade the operator cannot take must never
    // cost them the decision they can.
    expect(action(dialog, "reject").hasAttribute("disabled")).toBe(false);
  });
});
