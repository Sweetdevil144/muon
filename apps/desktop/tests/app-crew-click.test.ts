// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

// ── S8: crew-click → live stream view (app-level wiring) ────────────────────
//
// The founder ask: clicking any running orchestrated agent in the crew rail
// opens the COMPLETE live view of that agent's session. Crew is now explicitly
// per-chat: another chat's reused fleet slot must not appear until that chat is
// selected, preventing cross-chat stream/control leakage.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function baseState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
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
          currentTaskId: "task-b",
          // Simulate the fleet row lagging one poll behind the dispatch ledger.
          // The stream band must still choose the active/newest job below, not
          // the completed predecessor that appears first in the array.
          currentJobId: null,
        },
      ],
    },
    chats: [
      {
        id: "chat-a",
        title: "Chat A — onboarding fix",
        workspacePath: "/repo-a",
        status: "active",
        createdAt: "2026-07-16T09:00:00.000Z",
        updatedAt: "2026-07-16T09:00:00.000Z",
      },
      {
        id: "chat-b",
        title: "Chat B — flaky test triage",
        workspacePath: "/repo-b",
        status: "active",
        createdAt: "2026-07-16T09:30:00.000Z",
        updatedAt: "2026-07-16T09:30:00.000Z",
      },
    ],
    approvals: [],
    tasks: [
      {
        id: "task-b",
        title: "Investigate flaky test",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-old",
        kind: "session",
        vendor: "codex",
        taskId: "task-b",
        chatId: "chat-b",
        agentId: "agent-1",
        brief: "A completed predecessor on the reused fleet slot",
        status: "done",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "delegate",
        createdAt: "2026-07-16T09:30:30.000Z",
      },
      {
        id: "job-b",
        kind: "session",
        vendor: "codex",
        taskId: "task-b",
        chatId: "chat-b",
        agentId: "agent-1",
        brief: "Investigate the flaky test",
        status: "running",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "delegate",
        createdAt: "2026-07-16T09:31:00.000Z",
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

function mockMuon(state: DesktopState) {
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
    workspaceReview: vi.fn().mockResolvedValue({
      status: "degraded",
      reason: "n/a",
      action: "n/a",
    }),
    // LiveDispatchHero fires once a task is active (chat-b's job carries one).
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
    preEditContext: vi.fn().mockResolvedValue(null),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App crew-click per-chat open (S8)", () => {
  it("shows the full fleet and switches chats when another chat's agent is opened", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    // Initial poll lands: chat-a (the newest-first default) is active,
    // chat-b is not yet highlighted. Scope to `.chat-title` — the sidebar row
    // label collides with the chat's own conversation-header h2 once it's
    // the active tab.
    await screen.findByText("Chat A — onboarding fix", {
      selector: ".chat-title",
    });
    const chatARow = () =>
      screen
        .getByText("Chat A — onboarding fix", { selector: ".chat-title" })
        .closest(".chat-row");
    const chatBRow = () =>
      screen
        .getByText("Chat B — flaky test triage", { selector: ".chat-title" })
        .closest(".chat-row");
    expect(chatARow()?.className).toContain("active");

    // Crew is a fleet configuration surface, so it names every seat even when
    // that seat's active dispatch belongs to another chat.
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /open this agent's stream/i,
      })
    );

    // Opening the seat follows its exact job into that job's chat; the rest of
    // the selected-chat integrations then rebind normally.
    await waitFor(() => {
      expect(chatBRow()?.className).toContain("active");
    });
    await waitFor(() => {
      expect(muon.streams).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "job-b" })
      );
    });
    expect(muon.streams).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "job-old" })
    );

    expect(chatARow()?.className).not.toContain("active");

    // ...and the full live SessionWorkspace renders, opened straight on the
    // Timeline section (S8's session-stream slot), not a blank/no-op screen.
    expect(
      await screen.findByRole("heading", { name: "Investigate flaky test" })
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")
    ).toBe("true");
  });
});
