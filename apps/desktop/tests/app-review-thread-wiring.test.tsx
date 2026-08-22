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
import { sessionSlug } from "@muon/client/session-slug";
import type { DesktopState, WorkspaceReview } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

/**
 * REACHABILITY at the App level for H1 and H12.
 *
 * Component tests prove the sections behave when handed the right props. They
 * prove nothing about whether the App hands them over — and a correct surface
 * nobody can reach is not shipped. So this file mounts the real App against one
 * desktop state and asserts, from the props the App itself computed:
 *
 *   H1  — the digest leads the Review tab, and OPENING IT ADVANCES NOTHING.
 *   H1  — a merge DECISION advances the cursor, best-effort, after it landed.
 *   H12 — "Continue on <lane>" is offered for the other ready lane, calls the
 *         one IPC with this dock's task, and reports slug + cited packet.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WORKTREE_PATH = "/work/MUON-LABS/.muon/worktrees/task-1";

const WORKSPACE_REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: WORKTREE_PATH,
  branch: "detached@abc1234",
  stagedFiles: [],
  unstagedFiles: ["src/pay/charge.ts"],
  files: ["src/pay/charge.ts"],
  stat: "1 file changed, 12 insertions(+), 2 deletions(-)",
  fileStats: [
    { path: "src/pay/charge.ts", additions: 12, deletions: 2, binary: false },
  ],
  diffText: "diff --git a/src/pay/charge.ts b/src/pay/charge.ts",
  truncated: false,
  totalBytes: 1200,
  maxBytes: 200_000,
  tree: { kind: "worktree", path: WORKTREE_PATH, taskId: "task-1" },
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
        id: "approval-open-dock",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "command",
        reason: "unrelated pending gate (opens the Review dock)",
        status: "pending",
        createdAt: "2026-08-17T08:02:00.000Z",
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
        executionPath: WORKTREE_PATH,
        status: "done",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-08-17T08:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [],
    // BOTH execution lanes are connected; the dock's job ran on codex, so
    // Claude Code is the lane a continuation may hand off to.
    preflight: {
      version: 1,
      generatedAt: "2026-08-17T08:05:00.000Z",
      status: "ready",
      headline: "Ready · 2 crew members ready",
      brainHealth: { state: "ok", detail: "reachable" },
      runnerHealth: { state: "live", live: true, detail: "live" },
      vendors: [],
      readiness: {
        source: "backend",
        anyDispatchReady: true,
        readyVendors: ["claude-code", "codex"],
      },
      degradations: [],
    },
  } as unknown as DesktopState;
}

function reviewThreadDigest() {
  return {
    target: { targetKind: "task", targetId: "task-1" },
    lastLookedAt: "2026-08-17T08:00:00.000Z",
    handoffs: [
      {
        id: "handoff-1",
        taskId: "task-1",
        status: "delivered",
        createdAt: "2026-08-17T08:02:30.000Z",
        degraded: true,
      },
    ],
    approvals: [
      {
        id: "approval-merge",
        taskId: "task-1",
        kind: "merge",
        status: "pending",
        gateTag: null,
        createdAt: "2026-08-17T08:03:00.000Z",
        decidedAt: null,
        reviewDigest: null,
      },
    ],
    openQuestionIds: [],
    truncated: false,
  };
}

function mockMuon(state: DesktopState) {
  const handlers = new Map<string, (payload: never) => void>();
  const reviewThread = vi.fn().mockResolvedValue(reviewThreadDigest());
  const advanceReviewLook = vi
    .fn()
    .mockResolvedValue({ lastLookedAt: "2026-08-17T09:00:00.000Z" });
  const continueOnLane = vi.fn().mockResolvedValue({
    ok: true,
    jobId: "job-successor",
    packetId: "handoff-1",
    vendor: "claude-code",
  });
  const resolveApproval = vi.fn().mockResolvedValue({});
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    streams: vi.fn().mockResolvedValue([]),
    workspaceReview: vi.fn().mockResolvedValue(WORKSPACE_REVIEW),
    taskHandoffs: vi.fn().mockResolvedValue({ omitted: 0, items: [] }),
    reviewApproval: vi.fn().mockResolvedValue({
      status: "certified",
      verdict: "graph-certified",
      changedFiles: ["src/pay/charge.ts"],
      artifactDigest: "b".repeat(64),
    }),
    reviewDiff: vi.fn().mockResolvedValue({
      status: "ok",
      impact: {
        scope: "all",
        totals: {
          changedFiles: 1,
          resolvedFiles: 1,
          blindFiles: 0,
          changedSymbols: 2,
          affectedProcesses: 1,
        },
        blindFiles: [],
        changedSymbols: [],
        affectedProcesses: [],
        coverage: 1,
        indexFreshness: {
          graphCommit: "abc1234",
          headCommit: "abc1234",
          stale: false,
        },
        verdict: "flows-resolved",
        notes: [],
      },
    }),
    autoContext: vi.fn().mockResolvedValue(null),
    getDispatchBudget: vi.fn().mockResolvedValue({
      jobId: "job-root",
      poolMs: 1_800_000,
      reservedMs: 0,
      consumedMs: 0,
      remainingMs: 1_800_000,
      deadlineAt: null,
      childrenIssued: 0,
      maxChildren: 3,
      descendantsIssued: 0,
      maxDescendants: 8,
      depth: 0,
      maxDepth: 3,
      rootWallMs: 1_800_000,
      maxDescendantWallMs: 1_800_000,
      children: [],
    }),
    preEditContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    reconMap: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    answerQuestion: vi.fn().mockResolvedValue({ answered: true }),
    resolveApproval,
    reviewThread,
    advanceReviewLook,
    continueOnLane,
    shipTask: vi.fn(),
  };
  Object.assign(window, { muon });
  return {
    reviewThread,
    advanceReviewLook,
    continueOnLane,
    resolveApproval,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload as never);
    },
  };
}

/** Open the Review dock the way the existing dock-wiring tests do. */
async function openDock(emit: (event: string, payload: unknown) => void) {
  emit("muon:open-approval", { approvalId: "approval-open-dock" });
  await screen.findByRole("dialog", { name: "Approval review" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Approval review" })).toBeNull()
  );
}

describe("App wiring — H1's bound thread and H12's continue gesture are REACHABLE", () => {
  it("H1: the digest leads the Review tab, and opening it advances NOTHING", async () => {
    const { emit, reviewThread, advanceReviewLook } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    const strip = await waitFor(() => {
      const found = document.querySelector(".review-digest-strip");
      if (!found?.textContent?.includes("Since you last looked (")) {
        throw new Error("no digest yet");
      }
      return found;
    });
    // The delta, with the packet's own degraded flag as loud as it deserves,
    // and the id that proves it.
    expect(strip.textContent).toMatch(/Still blocking: 1 degraded packet/);
    expect(strip.textContent).toContain("handoff-1");
    // Bound to the dock's TASK — the thread a merge decision belongs to.
    expect(reviewThread).toHaveBeenCalledWith({
      targetKind: "task",
      targetId: "task-1",
    });
    // THE INVARIANT: a look is not a decision.
    expect(advanceReviewLook).not.toHaveBeenCalled();
  });

  it("H1: a merge decision advances the cursor, after the decision landed", async () => {
    const { emit, resolveApproval, advanceReviewLook } = mockMuon(
      desktopState()
    );
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));

    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-merge" })
      )
    );
    await waitFor(() =>
      expect(advanceReviewLook).toHaveBeenCalledWith({
        targetKind: "task",
        targetId: "task-1",
      })
    );
  });

  it("H1: a failed advance never turns a landed decision into an error", async () => {
    const { emit, resolveApproval, advanceReviewLook } = mockMuon(
      desktopState()
    );
    advanceReviewLook.mockRejectedValue(new Error("cursor write failed"));
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));

    await waitFor(() => expect(resolveApproval).toHaveBeenCalled());
    await waitFor(() => expect(advanceReviewLook).toHaveBeenCalled());
    // The dock does NOT report the decision as refused: the merge landed.
    //
    // Asserted POSITIVELY on a node proven to exist. A bare
    // `querySelector(...)?.textContent).not.toMatch(...)` passes vacuously when
    // the node is missing — it would still "pass" if the whole section had
    // vanished, which is not the claim (adversarial review, 2026-08-17).
    const section = document.querySelector(".merge-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).not.toMatch(/Not decided/);
    // The refusal callout is the thing that must be absent, by role.
    expect(screen.queryByText(/cursor write failed/)).toBeNull();
  });

  it("H1: a bridge that throws SYNCHRONOUSLY still cannot fail the decision", async () => {
    // A rejected promise is not the only failure shape. An older or partial
    // preload can throw on the call itself, which no `.catch` would ever see.
    const { emit, resolveApproval, advanceReviewLook } = mockMuon(
      desktopState()
    );
    advanceReviewLook.mockImplementation(() => {
      throw new Error("bridge missing");
    });
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));

    await waitFor(() => expect(resolveApproval).toHaveBeenCalled());
    await waitFor(() => expect(advanceReviewLook).toHaveBeenCalled());
    const section = document.querySelector(".merge-section");
    expect(section).not.toBeNull();
    expect(section!.textContent).not.toMatch(/Not decided/);
    expect(screen.queryByText(/bridge missing/)).toBeNull();
  });

  it("H1: the ledger being unreadable shows an outage, not an empty inbox", async () => {
    const { emit, reviewThread } = mockMuon(desktopState());
    reviewThread.mockRejectedValue(new Error("brain unreachable"));
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    const strip = await waitFor(() => {
      const found = document.querySelector(".review-digest-strip");
      if (!found?.textContent?.includes("brain unreachable")) {
        throw new Error("no outage notice yet");
      }
      return found;
    });
    expect(strip.textContent).not.toMatch(/Nothing new since you last looked/);
  });

  it("H12: the other ready lane is offered, and one press continues the mission", async () => {
    const { emit, continueOnLane } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    // The dock's job ran on codex, so codex is NOT offered — Claude Code is.
    const button = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        '[data-continue-lane="claude-code"]'
      );
      if (!found) throw new Error("no continue control yet");
      return found;
    });
    expect(
      document.querySelector('[data-continue-lane="codex"]')
    ).toBeNull();

    fireEvent.click(button);
    await waitFor(() =>
      expect(continueOnLane).toHaveBeenCalledWith({
        taskId: "task-1",
        chatId: "chat-1",
        vendor: "claude-code",
      })
    );
    const outcome = await waitFor(() => {
      const found = document.querySelector(".continue-lane-outcome");
      if (!found?.textContent?.includes("continued")) {
        throw new Error("no outcome yet");
      }
      return found;
    });
    // Slug + job id + THE CITED PACKET.
    expect(outcome.textContent).toContain(sessionSlug("job-successor"));
    expect(outcome.textContent).toContain("handoff-1");
  });

  it("H12: a refusal reaches the operator verbatim, where they pressed", async () => {
    const { emit, continueOnLane } = mockMuon(desktopState());
    const refusal =
      "no typed wrap packet exists for this task, so there is nothing to seed the successor from. Finish the current session (its terminal write files the packet) or file a handoff first.";
    continueOnLane.mockResolvedValue({ ok: false, reason: refusal });
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    const button = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        '[data-continue-lane="claude-code"]'
      );
      if (!found) throw new Error("no continue control yet");
      return found;
    });
    fireEvent.click(button);
    expect(await screen.findByText(refusal)).toBeTruthy();
  });
});
