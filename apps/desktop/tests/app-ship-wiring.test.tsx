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
import type { DesktopState, WorkspaceReview } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

// The desktop `muon ship` wiring, end-to-end at the App level: the Changes
// panel's "Land this work" files the governed merge gate through
// `window.muon.shipTask` with the job's OWN facts (task, lane, tree), never
// decides it locally, and reports the later decided merge outcome
// ("landed as <sha>") from `DesktopState.mergeOutcomes`.

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
  unstagedFiles: ["apps/desktop/src/renderer/right-panel.tsx"],
  files: ["apps/desktop/src/renderer/right-panel.tsx"],
  stat: "1 file changed, 12 insertions(+), 2 deletions(-)",
  fileStats: [
    {
      path: "apps/desktop/src/renderer/right-panel.tsx",
      additions: 12,
      deletions: 2,
      binary: false,
    },
  ],
  diffText: "diff --git a/apps/desktop/src/renderer/right-panel.tsx",
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
    // The decided-merge fact is present from the start, keyed by the approval
    // the ship call will file — the panel may only bind it AFTER filing.
    mergeOutcomes: {
      "approval-ship": { status: "merged", sha: "abc1234def99", changedFiles: 1 },
    },
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: { counts: { codex: 1 }, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Land the ship panel",
        workspacePath: "/work/MUON-LABS",
        status: "active",
        createdAt: "2026-07-27T08:00:00.000Z",
        updatedAt: "2026-07-27T08:00:00.000Z",
      },
    ],
    approvals: [
      {
        id: "approval-1",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "command",
        reason: "unrelated pending gate (opens the Review dock)",
        status: "pending",
        createdAt: "2026-07-27T08:02:00.000Z",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Land the ship panel",
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
        brief: "Do the work in the task worktree.",
        workspacePath: "/work/MUON-LABS",
        status: "done",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-07-27T08:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const handlers = new Map<string, (payload: never) => void>();
  const shipTask = vi
    .fn()
    .mockResolvedValue({ approvalId: "approval-ship", pending: true });
  const resolveApproval = vi.fn().mockResolvedValue({});
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    streams: vi.fn().mockResolvedValue([]),
    workspaceReview: vi.fn().mockResolvedValue(WORKSPACE_REVIEW),
    reviewDiff: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    autoContext: vi.fn().mockResolvedValue(null),
    getDispatchBudget: vi.fn().mockResolvedValue({
      maxDescendantWallMs: 1_800_000,
      reservedMs: 0,
      consumedMs: 0,
      remainingMs: 1_800_000,
    }),
    preEditContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    reconMap: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    resolveApproval,
    shipTask,
  };
  Object.assign(window, { muon });
  return {
    muon,
    shipTask,
    resolveApproval,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload as never);
    },
  };
}

describe("App ship wiring (governed desktop `muon ship`)", () => {
  it("files the merge gate from the Changes panel and reports the decided landing", async () => {
    const { shipTask, resolveApproval, emit } = mockMuon(desktopState());
    render(React.createElement(App));

    await screen.findByText("Land the ship panel", { selector: ".chat-title" });

    // The Review dock opens via the approval deep-link; closing the dialog
    // unlocks the panel tabs while the dock stays open.
    emit("muon:open-approval", { approvalId: "approval-1" });
    await screen.findByRole("dialog", { name: "Approval review" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Approval review" })
      ).toBeNull()
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const land = await screen.findByRole("button", {
      name: /Land this work/,
    });
    fireEvent.click(land);

    await waitFor(() =>
      expect(shipTask).toHaveBeenCalledWith({
        jobId: "job-root",
        taskId: "task-1",
        // The lane that RAN the work (lane keys are vendor ids).
        requestedBy: "codex",
        kind: "merge",
        reason: expect.stringContaining("no automated checks were run"),
      })
    );
    expect(shipTask).toHaveBeenCalledTimes(1);
    // Filing NEVER decides: the renderer resolves nothing on this path.
    expect(resolveApproval).not.toHaveBeenCalled();

    // The LATER, authoritative fact (Full Auto decided the gate; main kept the
    // merge outcome keyed by approval id) wins over the local "filed" line.
    expect(await screen.findByText(/Landed as/)).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();
  });
});
