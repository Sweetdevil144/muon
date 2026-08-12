// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ApprovalRequest,
  DispatchJobRecord,
  VendorReadiness,
  WorkflowRunRecord,
  RecordedEvent,
} from "@muon/client";
import { buildCapabilityPreflight } from "@muon/client/capability-preflight";
import {
  ControlRail,
  DispatchHero,
  DiagnosticsStrip,
  SystemsStatusButton,
} from "../src/renderer/cockpit.js";

afterEach(cleanup);

const approval: ApprovalRequest = {
  id: "approval-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "command",
  reason: "Apply the proposed workflow",
  status: "pending",
  gateTag: "[gate:dispatch_action vendor=codex action=full-auto]",
};

const proposal = {
  id: "workflow-1",
  request: "Ship the cockpit",
  proposal: {
    summary: "Implement, verify, and review the cockpit",
    steps: [
      {
        stepKey: "implement",
        title: "Implement cockpit",
        brief: "Build the evidence-rich desktop cockpit.",
        role: "implement",
        laneKey: "codex",
        laneReason: "Focused implementation lane",
        priority: "high",
        harnessKey: "implement",
        gate: "merge",
        onFail: "escalate",
      },
    ],
  },
  status: "proposed",
  proposedBy: "codex",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
} as unknown as WorkflowRunRecord;

const job = {
  id: "job-1",
  taskId: "task-1",
  brief: "Coordinate the parser repair",
  kind: "session",
  vendor: "codex",
  status: "running",
  dispatchedBy: "human:desktop",
  interruptRequested: false,
  steerMessages: [],
  capabilityMode: "orchestrator",
  maxDelegationDepth: 3,
  maxChildren: 3,
  maxTotalDescendants: 8,
  delegationChildrenIssued: 1,
  delegationDescendantsIssued: 1,
  delegationBudgetReservedMs: 120_000,
  maxWallMs: 600_000,
  createdAt: "2026-07-15T00:00:00.000Z",
} as DispatchJobRecord;

const childJob = {
  ...job,
  id: "job-child",
  taskId: "task-child",
  brief: "Implement the bounded parser fix",
  vendor: "claude-code",
  capabilityMode: "delegate",
  parentJobId: "job-1",
  rootJobId: "job-1",
  delegationDepth: 1,
} as DispatchJobRecord;

const auditEvents: RecordedEvent[] = [
  {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.started",
    message: "Running the parser repair",
    metadata: {},
    timestamp: "2026-07-15T00:01:00.000Z",
  },
];

/**
 * The dock card and the evidence dialog can be on screen at the same time (the
 * dialog is an overlay ON the rail), and BOTH now carry the three actions.
 * Dialog-specific assertions must say so explicitly.
 */
const inDialog = () =>
  within(screen.getByRole("dialog", { name: /approval review/i }));

describe("desktop cockpit", () => {
  it("keeps Why this dispatch collapsed by default with a one-line hint", () => {
    const html = renderToStaticMarkup(
      React.createElement(DispatchHero, {
        summary: {
          target: "src/auth/guard.ts#authorize",
          memory: "2 notes",
          codeRadius: "4 modules",
          symbolImpact: "7 symbols · depth 2",
          coordinates: "codex-1 + claude-code-1",
          degraded: false,
        },
        onOpenBrain: vi.fn(),
      })
    );

    expect(html).toContain("Why this dispatch");
    expect(html).toContain("src/auth/guard.ts#authorize");
    expect(html).toContain("dispatch-hero-hint");
    expect(html).toContain("2 notes · 4 modules · 7 symbols · depth 2 · codex-1 + claude-code-1");
    // Full channel grid is progressive disclosure — absent until expanded.
    expect(html).not.toContain("dispatch-channels");
    expect(html).not.toContain(">Memory<");
    expect(html).toContain("Show dispatch rationale");
    expect(html).toContain("Open evidence");
  });

  it("reveals every dispatch evidence channel when the rationale is expanded", () => {
    const { container } = render(
      React.createElement(DispatchHero, {
        summary: {
          target: "src/auth/guard.ts#authorize",
          memory: "2 notes",
          codeRadius: "4 modules",
          symbolImpact: "7 symbols · depth 2",
          coordinates: "codex-1 + claude-code-1",
          degraded: false,
        },
        onOpenBrain: vi.fn(),
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show dispatch rationale" })
    );

    expect(container.querySelector("#dispatch-rationale")).not.toBeNull();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Code radius")).toBeTruthy();
    expect(screen.getByText("Symbol impact")).toBeTruthy();
    expect(screen.getByText("Crew activity")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Hide dispatch rationale" })
    ).toBeTruthy();
  });

  it("dims a channel's sub-phrase after a '·' in a <small>, only where the data carries one", () => {
    render(
      React.createElement(DispatchHero, {
        summary: {
          target: "backend/src/lib/preedit.ts",
          memory: "3 notes",
          codeRadius: "7 modules · impact-graph",
          symbolImpact: "12 refs · depth 2",
          coordinates: "1 peer nearby",
          degraded: false,
        },
        onOpenBrain: vi.fn(),
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show dispatch rationale" })
    );
    const html = document.body.innerHTML;

    // Bold lead + dimmed <small> sub-phrase, matching the prototype's
    // evidence-chip treatment ("3 confirmed notes · loads before edits").
    expect(html).toContain("<small>· impact-graph</small>");
    expect(html).toContain("<small>· depth 2</small>");
    // A channel value with no "·" never fabricates a sub-phrase.
    expect(html).not.toContain("3 notes <small>");
    expect(html).not.toContain("1 peer nearby <small>");
  });

  it("makes gates, proposals, memory review, and activity actionable", () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [proposal],
        jobs: [job, childJob],
        auditEvents,
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
      })
    );

    expect(html).toContain("Needs your decision");
    // The gate is decided WHERE it is shown: three actions, no navigation hop.
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).not.toContain('<button class="review"');
    expect(html).toContain("Workflow proposal");
    expect(html).toContain("Review workflow proposal");
    expect(html).toContain("Build the evidence-rich desktop cockpit.");
    expect(html).toContain("Open memory");
    expect(html).toContain(">Mission<");
    expect(html).toContain("Depth 1 / 3");
    expect(html).toContain("1 / 8 descendants");
    expect(html).toContain("work only");
    expect(html).toContain("Implement the bounded parser fix");
    expect(html).toContain(">Activity<");
    expect(html).toContain("Codex · Started work");
    expect(html).toContain("Running the parser repair");
    expect(html).toContain("Reported by the agent · treated as data");
  });

  it("#9: renders a compact Changes readout in Review from workspaceReview — aggregate + top files, reusing .session-change-files/.numstat*", () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlRail, {
        approvals: [],
        proposals: [],
        jobs: [],
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        workspaceReview: {
          status: "available",
          workspacePath: "/repo",
          branch: "codex/wave-2",
          stagedFiles: ["src/a.ts"],
          unstagedFiles: ["src/b.ts"],
          files: ["src/a.ts", "src/b.ts"],
          stat: "2 files changed",
          fileStats: [
            { path: "src/a.ts", additions: 12, deletions: 3, binary: false },
            { path: "src/b.ts", additions: 1, deletions: 0, binary: false },
          ],
          diffText: "diff --git a/src/a.ts …",
          truncated: false,
          totalBytes: 200,
          maxBytes: 1024,
        },
      })
    );

    expect(html).toContain("dock-changes");
    expect(html).toContain("2 files");
    expect(html).toContain("session-change-files");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
    expect(html).toContain("numstat-add");
    expect(html).toContain("+13"); // aggregate additions (12 + 1)
    expect(html).toContain("−3"); // aggregate deletions
  });

  it("#9: renders nothing for the Changes readout when the review is degraded, empty, or absent (never a dead block)", () => {
    const base = {
      approvals: [],
      proposals: [],
      jobs: [],
      onResolveApproval: vi.fn(),
      onApplyProposal: vi.fn(),
      onDismissProposal: vi.fn(),
      onOpenMemory: vi.fn(),
    };
    const degraded = renderToStaticMarkup(
      React.createElement(ControlRail, {
        ...base,
        workspaceReview: { status: "degraded", reason: "no git", action: "retry" },
      })
    );
    expect(degraded).not.toContain("dock-changes");

    const empty = renderToStaticMarkup(
      React.createElement(ControlRail, {
        ...base,
        workspaceReview: {
          status: "available",
          workspacePath: "/repo",
          branch: "codex/wave-2",
          stagedFiles: [],
          unstagedFiles: [],
          files: [],
          stat: "",
          fileStats: [],
          diffText: "",
          truncated: false,
          totalBytes: 0,
          maxBytes: 1024,
        },
      })
    );
    expect(empty).not.toContain("dock-changes");

    const absent = renderToStaticMarkup(React.createElement(ControlRail, base));
    expect(absent).not.toContain("dock-changes");
  });

  it("Wave 4.2: the crew tree derives live state per node — a silent child lights amber (Stalled) before it dies, terminals read honestly", () => {
    // Pin the clock so 'launching' (within the startup window) and 'stalled'
    // (past it) are deterministic — DispatchTreeItem derives liveness from
    // Date.now() at render, so elapsed time alone moves launching → stalled.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
    try {
      const NOW = Date.parse("2026-07-19T12:00:00.000Z");
      const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
      // Root: running, no first output, in [warn, watchdog) → the exact
      // original-hang case, now visible as amber Stalled with an honest reason
      // BEFORE the runner's watchdog kills it.
      const root = { ...job, id: "m-root", createdAt: iso(60_000) } as DispatchJobRecord;
      const kid = (over: Partial<DispatchJobRecord>) =>
        ({
          ...childJob,
          parentJobId: "m-root",
          rootJobId: "m-root",
          createdAt: iso(120_000),
          ...over,
        }) as DispatchJobRecord;
      // Fresh delegate still inside the startup window → calm Launching.
      const launching = kid({
        id: "m-launch",
        brief: "Fresh delegate warming up",
        createdAt: iso(5_000),
      });
      // Failed delegate → red, with only the FIRST line of the tail as reason.
      const failed = kid({
        id: "m-failed",
        brief: "Broken delegate",
        status: "failed",
        result: "check failed: 3 tests red\ninternal stack trace here",
      });
      // Clean exit → calm Done, no attention affordance.
      const done = kid({
        id: "m-done",
        brief: "Finished delegate",
        status: "done",
        exitCode: 0,
      });
      const html = renderToStaticMarkup(
        React.createElement(ControlRail, {
          approvals: [],
          proposals: [],
          jobs: [root, launching, failed, done],
          auditEvents: [],
          onResolveApproval: vi.fn(),
          onApplyProposal: vi.fn(),
          onDismissProposal: vi.fn(),
          onOpenMemory: vi.fn(),
        })
      );

      // Root silent past the window → amber Stalled with the honest stall reason.
      expect(html).toContain("Stalled · depth 0");
      expect(html).toContain("activity-dot stalled attention");
      expect(html).toContain('class="mission-node-reason"');
      expect(html).toContain("startup watchdog");
      // Fresh child within the window stays calm — no premature alarm.
      expect(html).toContain("Launching · depth 1");
      // Failed child reads red; only the first line of the result is the reason.
      expect(html).toContain("Needs attention · depth 1");
      expect(html).toContain("activity-dot needs-attention attention");
      expect(html).toContain("check failed: 3 tests red");
      expect(html).not.toContain("internal stack trace here");
      // Clean exit stays calm — no attention class, no reason line.
      expect(html).toContain("Done · depth 1");
      expect(html).toContain("activity-dot done");
      expect(html).not.toContain("activity-dot done attention");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Wave 4.2 hardening: times the window from startedAt (not enqueue) and lets real output override a stale elapsed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
    try {
      const NOW = Date.parse("2026-07-19T12:00:00.000Z");
      const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
      // Enqueued 10min ago (past the watchdog) but only LAUNCHED 60s ago with no
      // output: timing from createdAt would read a false "Live"; timing from
      // startedAt correctly reads amber "Stalled".
      const queuedThenLaunched = {
        ...job,
        id: "m-late",
        createdAt: iso(600_000),
        startedAt: iso(60_000),
      } as DispatchJobRecord;
      // Same old launch, but it HAS produced output 2s ago → "Working", never a
      // false stall (real progress overrides the elapsed-time heuristic).
      const producing = {
        ...job,
        id: "m-producing",
        createdAt: iso(600_000),
        startedAt: iso(60_000),
        lastProgressAt: iso(2_000),
      } as DispatchJobRecord;

      const railFor = (jobs: DispatchJobRecord[]) =>
        renderToStaticMarkup(
          React.createElement(ControlRail, {
            approvals: [],
            proposals: [],
            jobs,
            auditEvents: [],
            onResolveApproval: vi.fn(),
            onApplyProposal: vi.fn(),
            onDismissProposal: vi.fn(),
            onOpenMemory: vi.fn(),
          })
        );

      const stalledHtml = railFor([queuedThenLaunched]);
      expect(stalledHtml).toContain("Stalled · depth 0");
      expect(stalledHtml).not.toContain("Live · depth 0");

      const workingHtml = railFor([producing]);
      expect(workingHtml).toContain("Working · depth 0");
      expect(workingHtml).not.toContain("Stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("approves in a single action, evidence visible, no acknowledgement gate", async () => {
    const onResolveApproval = vi.fn();
    const onReviewApproval = vi.fn();
    const props = {
      approvals: [approval],
      proposals: [proposal],
      jobs: [job],
      onResolveApproval,
      onApplyProposal: vi.fn(),
      onDismissProposal: vi.fn(),
      onOpenMemory: vi.fn(),
      onReviewApproval,
    };
    render(React.createElement(ControlRail, props));

    // Evidence is on the card, as context for the decision.
    expect(screen.getByText("Run full-auto vendor action")).toBeTruthy();
    expect(screen.getByText(approval.reason)).toBeTruthy();
    // No mandatory "I reviewed" checkbox anymore.
    expect(
      screen.queryByRole("checkbox", { name: /reviewed the exact action/i })
    ).toBeNull();
    // Approve is enabled immediately — single action, no navigation hop.
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approve);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenCalledWith("approval-1", "approved")
    );
    expect(onReviewApproval).not.toHaveBeenCalled();
  });

  // The founder's whole ask, pinned: Approve · Approve don't ask again · Reject.
  it("renders EXACTLY three actions on a pending gate, and each makes its own governed call", async () => {
    const onResolveApproval = vi.fn();
    const view = render(
      React.createElement(ControlRail, railProps(editApproval, {
        onResolveApproval,
        focusApprovalId: undefined,
      }))
    );

    const card = view.container.querySelector(".inbox-card.urgent");
    expect(card).toBeTruthy();
    const actions = Array.from(
      card!.querySelectorAll<HTMLButtonElement>("button")
    );
    expect(actions.map((button) => button.textContent)).toEqual([
      "Approve",
      "Approve, don’t ask again",
      "Reject",
    ]);

    fireEvent.click(actions[0]!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-edit",
        "approved"
      )
    );

    // The standing consent rides the EXISTING receipt opt-in: same governed
    // resolveApproval, one extra bound argument. No second consent path.
    await vi.waitFor(() =>
      expect(actions[1]!.hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(actions[1]!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-edit",
        "approved",
        900_000
      )
    );

    // Reject: one click, never behind a confirm step, never disabled.
    await vi.waitFor(() =>
      expect(actions[2]!.hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(actions[2]!);
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-edit",
        "rejected"
      )
    );
  });

  it("renders NO actions once the gate is decided", () => {
    const view = render(
      React.createElement(
        ControlRail,
        railProps(
          { ...editApproval, status: "approved" } as ApprovalRequest,
          { focusApprovalId: undefined }
        )
      )
    );
    expect(view.container.querySelector(".gate-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("under Full Auto the gate reads as auto-approving and offers NO second consent click", () => {
    const onResolveApproval = vi.fn();
    const view = render(
      React.createElement(ControlRail, {
        ...railProps(editApproval, { onResolveApproval }),
        focusApprovalId: undefined,
        fullAuto: true,
        // F7: the calm label needs POSITIVE coverage from main's approver
        // tick; enabled + not-uncovered alone must no longer earn it.
        fullAutoCoveredApprovalIds: ["approval-edit"],
        fullAutoUncoveredApprovalIds: [],
      })
    );
    expect(screen.getByText("Approving for you")).toBeTruthy();
    expect(view.container.querySelector(".gate-actions")).toBeNull();
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it("a merge gate routes to the evidence dialog instead of offering an approve it must refuse", () => {
    const onReviewApproval = vi.fn();
    const mergeApproval = {
      ...approval,
      id: "approval-merge-card",
      kind: "merge",
      gateTag: null,
      reason: "Ship reviewed worktree changes.",
    } as ApprovalRequest;
    const view = render(
      React.createElement(ControlRail, {
        ...railProps(mergeApproval, { onReviewApproval }),
        focusApprovalId: undefined,
      })
    );
    expect(view.container.querySelector(".gate-actions")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Review merge evidence" })
    );
    expect(onReviewApproval).toHaveBeenCalledWith("approval-merge-card");
  });

  it("approves on 'a' and rejects on 'r' from the dialog (single-key shortcuts, not Enter)", async () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [],
        jobs: [],
        focusApprovalId: approval.id,
        onResolveApproval,
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval: vi.fn(),
      })
    );
    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    fireEvent.keyDown(dialog, { key: "a" });
    expect(onResolveApproval).toHaveBeenCalledWith(approval.id, "approved");
    await vi.waitFor(() =>
      expect(
        inDialog()
          .getByRole("button", { name: "Approve" })
          .hasAttribute("disabled")
      ).toBe(false)
    );
    fireEvent.keyDown(dialog, { key: "r" });
    expect(onResolveApproval).toHaveBeenCalledWith(approval.id, "rejected");
  });

  // ---- approval-safety hardening: no accidental approve ----

  it("never approves from a stray Enter — there is no global 'Enter anywhere = approve'", () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [],
        jobs: [],
        focusApprovalId: approval.id,
        onResolveApproval,
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval: vi.fn(),
      })
    );
    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    // "Close" is the default on-open focus (see the dialog's own useEffect);
    // Enter landing there — or on the dialog container itself — must never
    // approve. Standard semantics: Enter only activates the FOCUSED button.
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(close, { key: "Enter" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onResolveApproval).not.toHaveBeenCalled();
    // Enter on the Approve button itself is a deliberate, single, focused
    // action — that is standard button activation, not a bypass, and stays
    // allowed (exercised by the native browser default, not this handler).
  });

  it("does not let 'a' approve while Reject is focused, or 'r' reject while Approve is focused", () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [],
        jobs: [],
        focusApprovalId: approval.id,
        onResolveApproval,
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval: vi.fn(),
      })
    );
    const reject = inDialog().getByRole("button", { name: "Reject" });
    const approveBtn = inDialog().getByRole("button", {
      name: "Approve",
    });
    fireEvent.keyDown(reject, { key: "a" });
    expect(onResolveApproval).not.toHaveBeenCalledWith(
      approval.id,
      "approved"
    );
    fireEvent.keyDown(approveBtn, { key: "r" });
    expect(onResolveApproval).not.toHaveBeenCalledWith(
      approval.id,
      "rejected"
    );
    expect(onResolveApproval).not.toHaveBeenCalled();
    // Sanity: the shortcuts still work from their own button / neutral focus.
    fireEvent.keyDown(reject, { key: "r" });
    expect(onResolveApproval).toHaveBeenCalledWith(approval.id, "rejected");
  });

  it("labels all three actions with visible, announced kbd shortcuts", () => {
    render(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [],
        jobs: [],
        focusApprovalId: approval.id,
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval: vi.fn(),
      })
    );
    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    const reject = dialog.querySelector<HTMLElement>('[data-approval-action="reject"]')!;
    const approveBtn = dialog.querySelector<HTMLElement>('[data-approval-action="approve"]')!;
    const remember = dialog.querySelector<HTMLElement>(
      '[data-approval-action="approve-remember"]'
    )!;
    expect(reject.getAttribute("aria-keyshortcuts")).toBe("r");
    expect(approveBtn.getAttribute("aria-keyshortcuts")).toBe("a");
    expect(remember.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(reject.querySelector("kbd")?.textContent).toBe("R");
    expect(approveBtn.querySelector("kbd")?.textContent).toBe("A");
    expect(remember.querySelector("kbd")?.textContent).toBe("⇧A");
  });

  it("shows structured command risk, digest, and safe payload details", () => {
    const commandApproval: ApprovalRequest = {
      ...approval,
      gateTag: null,
      reason: "session tool 'Write' (session session-1)",
      evidence: {
        action: "Write",
        scope: "File: src/parser.ts",
        riskLevel: "medium",
        impactIfApproved: "Writes content to one file in the selected workspace.",
        payloadDigest: "c".repeat(64),
        details: {
          path: "src/parser.ts",
          bytes: "421",
          sessionId: "session-1",
        },
      },
    };
    render(
      React.createElement(ControlRail, {
        approvals: [commandApproval],
        proposals: [],
        jobs: [],
        focusApprovalId: commandApproval.id,
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval: vi.fn(),
      })
    );

    const dialog = inDialog();
    expect(dialog.getByText("Write")).toBeTruthy();
    expect(dialog.getByText("medium")).toBeTruthy();
    expect(dialog.getAllByText("src/parser.ts").length).toBeGreaterThan(0);
    expect(dialog.getByText("421")).toBeTruthy();
    expect(dialog.getByText("c".repeat(64))).toBeTruthy();
  });

  // ---- P0.4 slice 3: content-bound receipt opt-in (never default) ----

  const editApproval: ApprovalRequest = {
    ...approval,
    id: "approval-edit",
    gateTag: null,
    reason: "session tool 'Edit' (session session-1)",
    evidence: {
      action: "Edit",
      scope: "File: src/parser.ts",
      riskLevel: "medium",
      impactIfApproved: "Edits one file in the selected workspace.",
      payloadDigest: "d".repeat(64),
      details: { path: "src/parser.ts", sessionId: "session-1" },
    },
  };

  const networkApproval: ApprovalRequest = {
    ...editApproval,
    id: "approval-network",
    reason: "session tool 'WebFetch' (session session-1)",
    evidence: {
      ...editApproval.evidence!,
      action: "WebFetch",
      scope: "https://example.com",
      details: { url: "https://example.com", sessionId: "session-1" },
    },
  };

  function railProps(target: ApprovalRequest, overrides = {}) {
    return {
      approvals: [target],
      proposals: [],
      jobs: [],
      focusApprovalId: target.id,
      onResolveApproval: vi.fn(),
      onApplyProposal: vi.fn(),
      onDismissProposal: vi.fn(),
      onOpenMemory: vi.fn(),
      onReviewApproval: vi.fn(),
      ...overrides,
    };
  }

  it("offers 'don't ask again' only where the action can actually be remembered, and says so either way", () => {
    const view = render(React.createElement(ControlRail, railProps(editApproval)));

    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    const remember = dialog.querySelector<HTMLButtonElement>(
      '[data-approval-action="approve-remember"]'
    )!;
    expect(remember.hasAttribute("disabled")).toBe(false);
    // The label promises "don't ask again"; the sentence next to it says
    // exactly how far that promise reaches — action, run, duration.
    expect(
      within(dialog).getByText(
        /auto-approves this exact action, in this run, for the next 15 minutes\./i
      )
    ).toBeTruthy();
    expect(remember.getAttribute("title")).toMatch(
      /this exact action, in this run, for the next 15 minutes/i
    );
    // No duration picker, no toggle: the operator chooses remember or not.
    expect(screen.queryByRole("combobox", { name: /receipt duration/i })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /also remember this exact action/i })
    ).toBeNull();
    // Exactly three, in the dialog too.
    expect(
      within(dialog)
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("data-approval-action"))
    ).toHaveLength(3);

    view.unmount();
    // A network action can never be remembered — the button stays in place (the
    // row never changes shape) but is disabled and explains itself.
    render(React.createElement(ControlRail, railProps(networkApproval)));
    const netDialog = screen.getByRole("dialog", { name: /approval review/i });
    const netRemember = netDialog.querySelector<HTMLButtonElement>(
      '[data-approval-action="approve-remember"]'
    )!;
    expect(netRemember.hasAttribute("disabled")).toBe(true);
    expect(
      within(netDialog).getByText(
        /this one always asks — only file reads, edits inside the task radius, and configured checks can be remembered\./i
      )
    ).toBeTruthy();
  });

  it("plain Approve sends no receipt TTL", async () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, railProps(editApproval, { onResolveApproval }))
    );

    fireEvent.click(inDialog().getByRole("button", { name: "Approve" }));
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenCalledWith("approval-edit", "approved")
    );
  });

  it("'don't ask again' rides the EXISTING receipt consent, one bound 15-minute TTL", async () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, railProps(editApproval, { onResolveApproval }))
    );

    fireEvent.click(
      inDialog().getByRole("button", { name: "Approve, don't ask again" })
    );
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenCalledWith(
        "approval-edit",
        "approved",
        900_000
      )
    );
  });

  it("keeps the dialog open and surfaces the server reason when the mint fails", async () => {
    const onResolveApproval = vi
      .fn()
      .mockRejectedValue(
        new Error("network, merge, and ship always ask; this action cannot be remembered.")
      );
    const onReviewApproval = vi.fn();
    render(
      React.createElement(
        ControlRail,
        railProps(editApproval, { onResolveApproval, onReviewApproval })
      )
    );

    fireEvent.click(
      inDialog().getByRole("button", { name: "Approve, don't ask again" })
    );
    await vi.waitFor(() =>
      expect(
        inDialog().getByText(/network, merge, and ship always ask/i)
      ).toBeTruthy()
    );
    expect(screen.getByRole("dialog", { name: /approval review/i })).toBeTruthy();
    expect(onReviewApproval).not.toHaveBeenCalledWith(null);
  });

  it("approves + remembers from the shifted 'A' key, and plain 'a' never remembers", async () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(ControlRail, railProps(editApproval, { onResolveApproval }))
    );
    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    fireEvent.keyDown(dialog, { key: "A" });
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-edit",
        "approved",
        900_000
      )
    );
    await vi.waitFor(() =>
      expect(
        inDialog()
          .getByRole("button", { name: "Approve" })
          .hasAttribute("disabled")
      ).toBe(false)
    );
    fireEvent.keyDown(dialog, { key: "a" });
    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenLastCalledWith(
        "approval-edit",
        "approved"
      )
    );
  });

  it("never remembers an always-ask action from the keyboard either", () => {
    const onResolveApproval = vi.fn();
    render(
      React.createElement(
        ControlRail,
        railProps(networkApproval, { onResolveApproval })
      )
    );
    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    fireEvent.keyDown(dialog, { key: "A" });
    expect(onResolveApproval).not.toHaveBeenCalled();
  });

  it("loads merge certification and requires exact-artifact attestation for REVIEW BLIND files", async () => {
    const mergeApproval: ApprovalRequest = {
      ...approval,
      id: "approval-merge",
      kind: "merge",
      gateTag: null,
      reason: "Ship reviewed worktree changes.",
    };
    const onResolveApproval = vi.fn().mockResolvedValue(undefined);
    render(
      React.createElement(
        ControlRail,
        railProps(mergeApproval, {
          onResolveApproval,
          onLoadMergeReview: vi.fn().mockResolvedValue({
            status: "blocked",
            blockCode: "review-blind",
            reason: "REVIEW BLIND: one new file is not indexed.",
            changedFiles: ["src/new.ts"],
            blindFiles: ["src/new.ts"],
            artifactDigest: "a".repeat(64),
          }),
        })
      )
    );

    const approve = inDialog().getByRole("button", {
      name: "Approve",
    });
    expect(approve.hasAttribute("disabled")).toBe(true);
    await vi.waitFor(() =>
      expect(
        screen.getByText("src/new.ts")
      ).toBeTruthy()
    );
    expect(approve.hasAttribute("disabled")).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /reviewed every blind file for this exact artifact/i,
      })
    );
    expect(approve.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approve);

    await vi.waitFor(() =>
      expect(onResolveApproval).toHaveBeenCalledWith(
        "approval-merge",
        "approved",
        undefined,
        {
          acknowledged: true,
          artifactDigest: "a".repeat(64),
          blindFiles: ["src/new.ts"],
        }
      )
    );
  });

  it("keeps stale merge evidence non-bypassable", async () => {
    const mergeApproval: ApprovalRequest = {
      ...approval,
      id: "approval-stale",
      kind: "merge",
      gateTag: null,
      reason: "Ship reviewed worktree changes.",
    };
    render(
      React.createElement(
        ControlRail,
        railProps(mergeApproval, {
          onLoadMergeReview: vi.fn().mockResolvedValue({
            status: "blocked",
            blockCode: "stale",
            reason: "GitNexus review evidence is stale.",
            changedFiles: ["src/a.ts"],
            artifactDigest: "b".repeat(64),
          }),
        })
      )
    );

    await vi.waitFor(() =>
      expect(
        screen.getByText("GitNexus review evidence is stale.")
      ).toBeTruthy()
    );
    expect(
      screen.queryByRole("checkbox", {
        name: /reviewed every blind file/i,
      })
    ).toBeNull();
    expect(
      inDialog()
        .getByRole("button", { name: "Approve" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("refreshes merge evidence in place after reindex or worktree repair", async () => {
    const mergeApproval: ApprovalRequest = {
      ...approval,
      id: "approval-refresh",
      kind: "merge",
      gateTag: null,
      reason: "Ship reviewed worktree changes.",
    };
    const onLoadMergeReview = vi
      .fn()
      .mockResolvedValueOnce({
        status: "blocked",
        blockCode: "stale",
        reason: "GitNexus review evidence is stale.",
        changedFiles: ["src/a.ts"],
        artifactDigest: "c".repeat(64),
      })
      .mockResolvedValueOnce({
        status: "certified",
        verdict: "graph-certified",
        changedFiles: ["src/a.ts"],
        artifactDigest: "d".repeat(64),
      });
    render(
      React.createElement(
        ControlRail,
        railProps(mergeApproval, { onLoadMergeReview })
      )
    );

    await vi.waitFor(() =>
      expect(
        screen.getByText("GitNexus review evidence is stale.")
      ).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await vi.waitFor(() =>
      expect(
        screen.getByText(/graph coverage is current for 1 changed file/i)
      ).toBeTruthy()
    );
    expect(onLoadMergeReview).toHaveBeenCalledTimes(2);
    expect(
      inDialog()
        .getByRole("button", { name: "Approve" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  it("annotates the inbox with active receipts and the last auto-approval", () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlRail, {
        approvals: [],
        proposals: [],
        jobs: [],
        auditEvents: [
          {
            id: "event-auto",
            laneId: "claude-code",
            taskId: "task-1",
            kind: "approval.auto",
            message: "policy allowed read: reads never change the workspace",
            metadata: { source: "policy" },
            timestamp: "2026-07-15T00:02:00.000Z",
          },
        ],
        receipts: [
          {
            id: "receipt-1",
            approvalId: "approval-edit",
            taskId: "task-1",
            jobId: "job-1",
            workspacePath: "/repo",
            actionClass: "edit",
            toolName: "Edit",
            payloadDigest: "d".repeat(64),
            expiresAt: "2026-07-15T01:00:00.000Z",
            useCount: 2,
          },
        ],
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
      })
    );

    expect(html).toContain("1 receipt active");
    expect(html).toContain("last auto-approval");
    expect(html).toContain("policy allowed read");
  });

  it("traps focus, closes on Escape, and names the exact approval action", async () => {
    const user = userEvent.setup();
    const onReviewApproval = vi.fn();
    render(
      React.createElement(ControlRail, {
        approvals: [approval],
        proposals: [],
        jobs: [],
        focusApprovalId: approval.id,
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
        onReviewApproval,
      })
    );

    const dialog = screen.getByRole("dialog", { name: /approval review/i });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      inDialog().getByRole("button", { name: "Approve" })
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(onReviewApproval).toHaveBeenCalledWith(null);
  });

  it("makes mission completion and the next human action obvious", () => {
    const html = renderToStaticMarkup(
      React.createElement(ControlRail, {
        approvals: [],
        proposals: [],
        jobs: [
          { ...job, status: "done", result: "Parser repair verified." },
          { ...childJob, status: "done", result: "Implementation complete." },
        ],
        auditEvents,
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
      })
    );

    expect(html).toContain("Mission complete");
    expect(html).toContain("All 2 lanes finished successfully");
    expect(html).toContain("Next: review captured memory and audit evidence");
  });

  it("renders independent mission limits without cross-root mixing", () => {
    const secondRoot = {
      ...job,
      id: "job-2",
      taskId: "task-2",
      brief: "Review the release notes",
      maxDelegationDepth: 1,
      maxTotalDescendants: 2,
      delegationChildrenIssued: 0,
      delegationDescendantsIssued: 0,
      delegationBudgetReservedMs: 0,
      maxWallMs: 120_000,
    } as DispatchJobRecord;
    const html = renderToStaticMarkup(
      React.createElement(ControlRail, {
        approvals: [],
        proposals: [],
        jobs: [job, childJob, secondRoot],
        onResolveApproval: vi.fn(),
        onApplyProposal: vi.fn(),
        onDismissProposal: vi.fn(),
        onOpenMemory: vi.fn(),
      })
    );

    expect(html).toContain("Coordinate the parser repair");
    expect(html).toContain("Depth 1 / 3");
    expect(html).toContain("Review the release notes");
    expect(html).toContain("Depth 0 / 1");
    expect(html).toContain("0 / 2 descendants");
  });

  // ---- DiagnosticsStrip renders the ONE P0.5 doctor contract ----

  const codexByok: VendorReadiness = {
    vendor: "codex",
    installed: true,
    authenticated: true,
    credentialMethod: "api-key",
    detail: "ready through selected API-key provider",
  };
  const cursorConnected: VendorReadiness = {
    vendor: "cursor",
    installed: true,
    authenticated: true,
    detail: "Cursor detected in the local fleet",
  };
  const runnerLive = {
    runner: { status: "online", lastSeenAt: "2026-07-15T00:00:00.000Z" },
    live: true,
  };

  it("shows readiness capability chips and visible degradation reasons", () => {
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: { vendors: [codexByok, cursorConnected] },
      runner: { runner: null, live: false },
    });
    const html = renderToStaticMarkup(
      React.createElement(DiagnosticsStrip, {
        preflight,
        runnerDetail: "runner sandbox unavailable",
      })
    );

    expect(html).toContain("Control plane ready");
    expect(html).toContain("Runner needs attention");
    expect(html).toContain("runner sandbox unavailable");
    expect(html).toContain(
      "Start `muon runner` or open the MUON desktop app."
    );
    expect(html).toContain("Crew 1 ready");
    expect(html).not.toContain("2 ready");
    expect(html).toContain("BYOK");
    expect(html).toContain(
      "Ready to dispatch through the selected API-key provider"
    );
    expect(html).toContain("Cursor");
    // Cursor is no longer "not integrated yet" — it is a managed lane whose
    // ceiling is read-only roles, so the copy must point at the ROLES it can
    // hold rather than promise future depth.
    expect(html).toContain("Dispatch Cursor under one of those roles");
    expect(html).not.toContain("Dispatch depth expands as the integration lands");
  });

  it("keeps a role-scoped Cursor out of the dispatch-ready crew count while keeping it visible", () => {
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: { vendors: [codexByok, cursorConnected] },
      runner: runnerLive,
    });
    const html = renderToStaticMarkup(
      React.createElement(DiagnosticsStrip, { preflight })
    );

    // Cursor is role-scoped (info), so nothing needs attention or setup — but
    // it must not inflate the dispatch-ready count, because the count answers
    // "who can take the WRITE work", and Cursor never can.
    expect(html).toContain("Systems ready");
    expect(html).toContain("BYOK");
    expect(html).toContain("Crew 1 ready");
    expect(html).not.toContain("2 ready");
    expect(html).toContain("Dispatch Cursor under one of those roles");
  });

  it("renders an honest unknown chip when the auth probe failed, never sign-in language", () => {
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: {
        vendors: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: false,
            authState: "unknown",
            detail: "readiness probe failed before a verdict",
          },
        ],
      },
      runner: runnerLive,
    });
    const html = renderToStaticMarkup(
      React.createElement(DiagnosticsStrip, { preflight })
    );

    expect(html).toContain("Claude Code · unknown");
    expect(html).toContain("Re-check readiness with refresh");
    expect(html).not.toMatch(/sign in/i);
  });

  it("distinguishes a hard offline/runner failure from a pure setup gap in the merged summary", () => {
    // Control plane offline: root-cause suppression → ONE actionable item,
    // and it is "attention" (broken), never "setup".
    const offline = buildCapabilityPreflight({
      brain: { reachable: false, detail: "fetch failed" },
      readiness: null,
      runner: null,
    });
    const offlineHtml = renderToStaticMarkup(
      React.createElement(DiagnosticsStrip, { preflight: offline })
    );
    expect(offlineHtml).toContain(
      "Systems · 1 needs attention</summary>"
    );
    expect(offlineHtml).toContain("systems-diagnostic bad");
    expect(offlineHtml).toContain("Control plane offline");
    expect(offlineHtml).toContain("Crew check unavailable");
    expect(offlineHtml).toContain(
      "Open Settings → Status and check providers again."
    );

    // Everything online and live; only a vendor readiness gap, keep "setup".
    const setupOnly = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: {
        vendors: [
          codexByok,
          {
            vendor: "claude-code",
            installed: false,
            authenticated: false,
            detail: "Claude Code is not installed",
          },
        ],
      },
      runner: runnerLive,
    });
    const setupOnlyHtml = renderToStaticMarkup(
      React.createElement(DiagnosticsStrip, { preflight: setupOnly })
    );
    expect(setupOnlyHtml).toContain(
      "Systems · 1 needs setup</summary>"
    );
    expect(setupOnlyHtml).not.toContain("attention");
    expect(setupOnlyHtml).not.toContain("systems-diagnostic bad");
    expect(setupOnlyHtml).toContain("Crew 1 ready · 1 needs setup");
  });

  it("offers an explicit provider re-check with in-progress feedback", () => {
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: { vendors: [codexByok] },
      runner: runnerLive,
    });
    const onRefresh = vi.fn();
    const { rerender } = render(
      React.createElement(DiagnosticsStrip, {
        preflight,
        onRefresh,
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Re-check providers" })
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      React.createElement(DiagnosticsStrip, {
        preflight,
        onRefresh,
        refreshing: true,
      })
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Checking providers…",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("SystemsStatusButton is a compact Settings entry (not the full strip)", () => {
    const preflight = buildCapabilityPreflight({
      brain: { reachable: true },
      readiness: { vendors: [codexByok] },
      runner: runnerLive,
    });
    const onOpenSettings = vi.fn();
    render(
      React.createElement(SystemsStatusButton, {
        preflight,
        onOpenSettings,
      })
    );
    const btn = screen.getByRole("button", { name: /ready/i });
    expect(btn.className).toContain("systems-status-btn");
    expect(btn.textContent).not.toContain("Control plane");
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
