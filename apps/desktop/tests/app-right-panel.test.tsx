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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WORKSPACE_REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: "/work/MUON-LABS",
  branch: "codex/wave-2",
  files: ["apps/desktop/src/renderer/right-panel.tsx"],
  fileStats: [
    {
      path: "apps/desktop/src/renderer/right-panel.tsx",
      additions: 12,
      deletions: 2,
    },
  ],
  additions: 12,
  deletions: 2,
  stat: "1 file changed, 12 insertions(+), 2 deletions(-)",
  diffText: "diff --git a/apps/desktop/src/renderer/right-panel.tsx",
  truncated: false,
  maxBytes: 200_000,
  totalBytes: 1200,
};

function desktopState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: {
      counts: { codex: 1 },
      agents: [
        {
          id: "agent-1",
          vendor: "codex",
          name: "Codex 1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-1",
          currentJobId: "job-root",
        },
      ],
    },
    chats: [
      {
        id: "chat-1",
        title: "Ship the right panel",
        workspacePath: "/work/MUON-LABS",
        status: "active",
        createdAt: "2026-07-21T08:00:00.000Z",
        updatedAt: "2026-07-21T08:00:00.000Z",
      },
    ],
    approvals: [
      {
        id: "approval-1",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "command",
        reason: "Apply the reviewed workspace change.",
        status: "pending",
        createdAt: "2026-07-21T08:02:00.000Z",
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Ship the right panel",
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
        brief: "Implement the renderer-only A2 panel.",
        workspacePath: "/work/MUON-LABS",
        status: "running",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-07-21T08:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        credentialMethod: "vendor-login",
        detail: "Codex native login is ready",
      },
    ],
  } as unknown as DesktopState;
}

function mockMuon(
  state: DesktopState,
  workspaceReview = vi.fn().mockResolvedValue(WORKSPACE_REVIEW)
) {
  const handlers = new Map<string, (payload: never) => void>();
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    streams: vi.fn().mockResolvedValue([]),
    workspaceReview,
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
    resolveApproval: vi.fn().mockResolvedValue({}),
  };
  Object.assign(window, { muon });
  return {
    muon,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload as never);
    },
  };
}

describe("App A2 right-panel wiring", () => {
  it("reuses the status-keyed workspaceReview poll and keeps focused approvals on the existing ControlRail path", async () => {
    const { muon, emit } = mockMuon(desktopState());
    render(React.createElement(App));

    await screen.findByText("Ship the right panel", { selector: ".chat-title" });
    await waitFor(() =>
      expect(muon.workspaceReview).toHaveBeenCalledWith({
        jobId: "job-root",
        chatId: "chat-1",
      })
    );
    expect(muon.workspaceReview).toHaveBeenCalledTimes(1);

    // Left-nav Control is a CENTER tab; the Review dock opens via approval
    // deep-link (Quiet UI).
    emit("muon:open-approval", { approvalId: "approval-1" });
    expect(
      await screen.findByRole("tab", { name: "Review" }, { timeout: 5_000 })
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(
      await screen.findByRole("dialog", { name: "Approval review" })
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Files" }).hasAttribute("disabled")
    ).toBe(true);
    expect(muon.workspaceReview).toHaveBeenCalledTimes(1);
    expect(muon.resolveApproval).not.toHaveBeenCalled();
  });

  it("settles to an honest unavailable state when the existing poll rejects", async () => {
    const workspaceReview = vi
      .fn()
      .mockRejectedValue(new Error("workspace review failed"));
    mockMuon(desktopState(), workspaceReview);
    render(React.createElement(App));

    await screen.findByText("Ship the right panel", { selector: ".chat-title" });
    await waitFor(() =>
      expect(workspaceReview).toHaveBeenCalledWith({
        jobId: "job-root",
        chatId: "chat-1",
      })
    );

    await waitFor(() =>
      expect(screen.queryByText("Reading workspace…")).toBeNull()
    );
    // Sidebar diff readout stays empty — no stale loading or fake totals.
    expect(screen.queryByLabelText(/additions/)).toBeNull();
  });

  it("binds GitHub review to the active chat job and opens the discovered PR", async () => {
    const state = desktopState();
    state.github = {
      configured: true,
      connected: true,
      login: "operator",
    };
    const { muon, emit } = mockMuon(state);
    const githubReview = vi.fn().mockResolvedValue({
      status: "available",
      repository: { owner: "muon", repo: "muon" },
      branch: "codex/wave-2",
      pullRequest: {
        number: 42,
        title: "Ship the right panel",
        url: "https://github.com/muon/muon/pull/42",
        headSha: "abcdef1234567890",
        author: "operator",
        draft: false,
        updatedAt: "2026-07-21T12:00:00.000Z",
      },
      checks: {
        state: "success",
        total: 1,
        passed: 1,
        pending: 0,
        failed: 0,
        neutral: 0,
        unavailable: false,
        items: [
          {
            name: "unit",
            source: "check-run",
            state: "success",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    });
    const openGitHubUrl = vi.fn().mockResolvedValue(undefined);
    Object.assign(muon, { githubReview, openGitHubUrl });

    render(React.createElement(App));
    await screen.findByText("Ship the right panel", { selector: ".chat-title" });
    // GitHub evidence lives on the right Control dock (approval deep-link).
    emit("muon:open-approval", { approvalId: "approval-1" });

    await waitFor(() =>
      expect(githubReview).toHaveBeenCalledWith({
        jobId: "job-root",
        chatId: "chat-1",
      })
    );
    expect(await screen.findByText("unit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    expect(openGitHubUrl).toHaveBeenCalledWith(
      "https://github.com/muon/muon/pull/42"
    );
  });
});
