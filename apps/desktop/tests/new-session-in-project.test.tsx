// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/renderer/sidebar.js";
import { App } from "../src/renderer/app.js";
import type { DesktopState, OrchestratorChatRecord } from "../src/shared/ipc.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "muon");
});

function stateWithTwoProjects(): DesktopState {
  return {
    chats: [
      {
        id: "chat-a",
        title: "Mission A",
        workspacePath: "/Users/dev/alpha-api",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "chat-b",
        title: "Mission B",
        workspacePath: "/Users/dev/beta-ui",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    fleet: { counts: {}, agents: [] },
    fullAuto: false,
    fullAutoVendors: [],
    dispatchJobs: [],
    approvals: [],
  } as unknown as DesktopState;
}

describe("per-project + creates in that workspace", () => {
  it("passes the group's workspacePath and never opens a picker path", () => {
    const onNewChat = vi.fn();
    render(
      <Sidebar
        state={stateWithTwoProjects()}
        activeChatId={null}
        taskTitles={new Map()}
        onSelectChat={vi.fn()}
        onArchiveChat={vi.fn()}
        navActive="mission"
        navPendingDecisions={0}
        navCrewActive={false}
        navFleet={[]}
        onNavigate={vi.fn()}
        onNewChat={onNewChat}
        onStepFleet={vi.fn()}
        onOpenAgent={vi.fn()}
        onSetFullAutoVendors={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "New session in alpha-api" })
    );
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith("/Users/dev/alpha-api");

    fireEvent.click(
      screen.getByRole("button", { name: "New session in beta-ui" })
    );
    expect(onNewChat).toHaveBeenLastCalledWith("/Users/dev/beta-ui");
  });

  it("keeps the rail New chat control pathless (picker stays on the parent)", () => {
    const onNewChat = vi.fn();
    render(
      <Sidebar
        state={stateWithTwoProjects()}
        activeChatId={null}
        taskTitles={new Map()}
        onSelectChat={vi.fn()}
        onArchiveChat={vi.fn()}
        navActive="mission"
        navPendingDecisions={0}
        navCrewActive={false}
        navFleet={[]}
        onNavigate={vi.fn()}
        onNewChat={onNewChat}
        onStepFleet={vi.fn()}
        onOpenAgent={vi.fn()}
        onSetFullAutoVendors={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith();
  });
});

describe("end to end: the group + button never opens the folder picker", () => {
  function appState(): DesktopState {
    return {
      online: true,
      lastError: null,
      runnerLive: true,
      fullAuto: false,
      settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
      fleet: { counts: {}, agents: [] },
      chats: [
        {
          id: "chat-a",
          title: "Mission A",
          workspacePath: "/Users/dev/alpha-api",
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      approvals: [],
      tasks: [],
      dispatchJobs: [],
      auditEvents: [],
      readiness: [],
    } as unknown as DesktopState;
  }

  function mockMuon() {
    const newChat: OrchestratorChatRecord = {
      id: "chat-new",
      title: "New chat",
      workspacePath: "/Users/dev/alpha-api",
      status: "active",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as unknown as OrchestratorChatRecord;
    const muon = {
      getState: vi.fn().mockResolvedValue(appState()),
      on: vi.fn(() => () => {}),
      streams: vi.fn().mockResolvedValue([]),
      pickFolder: vi.fn().mockResolvedValue(null),
      createChat: vi.fn().mockResolvedValue(newChat),
    };
    Object.assign(window, { muon });
    return muon;
  }

  it("creates the session in the named project without ever calling pickFolder", async () => {
    const muon = mockMuon();
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "New session in alpha-api" })
    );

    await waitFor(() =>
      expect(muon.createChat).toHaveBeenCalledWith({
        workspacePath: "/Users/dev/alpha-api",
      })
    );
    expect(muon.pickFolder).not.toHaveBeenCalled();
  });
});
