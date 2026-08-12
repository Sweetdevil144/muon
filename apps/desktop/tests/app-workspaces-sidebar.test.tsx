// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState, WorkspaceReview } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "muon");
});

const review: WorkspaceReview = {
  status: "available",
  workspacePath: "/work/MUON-LABS",
  branch: "codex/wave-3",
  stagedFiles: ["src/renderer/sidebar.tsx"],
  unstagedFiles: ["src/renderer/presets-bar.tsx"],
  files: ["src/renderer/sidebar.tsx", "src/renderer/presets-bar.tsx"],
  stat: "2 files changed, 44 insertions(+), 3 deletions(-)",
  fileStats: [
    {
      path: "src/renderer/sidebar.tsx",
      additions: 12,
      deletions: 3,
      binary: false,
    },
    {
      path: "src/renderer/presets-bar.tsx",
      additions: 32,
      deletions: 0,
      binary: false,
    },
  ],
  diffText: "diff --git a/src/renderer/sidebar.tsx b/src/renderer/sidebar.tsx",
  truncated: false,
  totalBytes: 1_024,
  maxBytes: 262_144,
};

function desktopState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-1",
        taskId: "task-1",
        title: "Ship Wave 3",
        workspacePath: "/work/MUON-LABS",
        status: "active",
        createdAt: "2026-07-21T09:00:00.000Z",
        updatedAt: "2026-07-21T09:00:00.000Z",
      },
    ],
    approvals: [],
    tasks: [
      {
        id: "task-1",
        title: "Ship Wave 3",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-root",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-1",
        chatId: "chat-1",
        brief: "Ship renderer Wave 3",
        workspacePath: "/work/MUON-LABS",
        status: "running",
        dispatchedBy: "human",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-07-21T09:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

describe("App Workspaces sidebar", () => {
  it("shares one workspaceReview result with A2 and shows diff plus running-job badges", async () => {
    const workspaceReview = vi.fn().mockResolvedValue(review);
    Object.assign(window, {
      muon: {
        getState: vi.fn().mockResolvedValue(desktopState()),
        on: vi.fn(() => () => {}),
        streams: vi.fn().mockResolvedValue([]),
        workspaceReview,
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
      },
    });

    render(<App />);

    // Session-desk IA (spec R1/R6): the rail is
    // PROJECTS → SESSIONS. The workspace leaf is now the GROUP header, the
    // running state is the card's status row — the invariants this test
    // defends (one shared review, visible diff, visible running state) are
    // unchanged, only their chrome moved.
    expect(
      await screen.findByText("MUON-LABS", { selector: ".rail-group-name" })
    ).toBeTruthy();
    expect(
      await screen.findByLabelText("44 additions, 3 deletions")
    ).toBeTruthy();
    expect(
      screen.getByText("Working", { selector: ".session-card-status" })
    ).toBeTruthy();
    await waitFor(() =>
      expect(workspaceReview).toHaveBeenCalledWith({
        jobId: "job-root",
        chatId: "chat-1",
      })
    );
    expect(workspaceReview).toHaveBeenCalledTimes(1);
    // Shared poll already painted the sidebar +44/−3 readout above — one IPC.
    expect(screen.getByText("+44")).toBeTruthy();
  });
});

describe("the blocked-at-gate badge (spec R7)", () => {
  /**
   * The badge that exists to shout "this mission is blocked" never appeared:
   * the count read `approval.chatId`, a field ApprovalRequest does not have,
   * so every approval was skipped. The chat is resolved through the JOB that
   * filed the gate, with taskId as the fallback.
   */
  function stateWithGate(
    approval: Record<string, unknown>
  ): DesktopState {
    const base = desktopState() as unknown as Record<string, unknown>;
    return { ...base, approvals: [approval] } as unknown as DesktopState;
  }

  function mountWith(state: DesktopState) {
    Object.assign(window, {
      muon: {
        getState: vi.fn().mockResolvedValue(state),
        on: vi.fn(() => () => {}),
        streams: vi.fn().mockResolvedValue([]),
        workspaceReview: vi.fn().mockResolvedValue(review),
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
      },
    });
    render(<App />);
  }

  it("counts a gate against the chat of the JOB that filed it", async () => {
    mountWith(
      stateWithGate({
        id: "ap-1",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "merge",
        reason: "ship it",
        status: "pending",
      })
    );
    expect(await screen.findByText(/Blocked — 1 gate/)).toBeTruthy();
  });

  it("falls back to the task when the gate names no job", async () => {
    mountWith(
      stateWithGate({
        id: "ap-2",
        taskId: "task-1",
        requestedBy: "codex",
        kind: "command",
        reason: "rm -rf",
        status: "pending",
      })
    );
    expect(await screen.findByText(/Blocked — 1 gate/)).toBeTruthy();
  });

  it("counts an unattributable gate NOWHERE, rather than against a guess", async () => {
    mountWith(
      stateWithGate({
        id: "ap-3",
        taskId: "task-elsewhere",
        requestedBy: "codex",
        kind: "command",
        reason: "from another machine's task",
        status: "pending",
      })
    );
    // The chat card must not claim a gate it cannot place. Working, not blocked.
    expect(await screen.findByText("Working")).toBeTruthy();
    expect(screen.queryByText(/Blocked —/)).toBeNull();
  });
});
