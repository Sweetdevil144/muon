// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

function stateWithChats(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    gitnexus: {
      status: "ready",
      workspacePath: "/repo-a",
      symbolCount: 123,
    },
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-a",
        title: "Chat A",
        workspacePath: "/repo-a",
        taskId: "task-a",
        status: "active",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:02.000Z",
      },
      {
        id: "chat-b",
        title: "Chat B",
        workspacePath: "/repo-b",
        taskId: "task-b",
        status: "active",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:01.000Z",
      },
    ],
    approvals: [
      {
        id: "approval-b",
        taskId: "task-b",
        requestedBy: "codex",
        kind: "gate",
        reason: "Review B",
        status: "pending",
        createdAt: "2026-07-22T00:00:03.000Z",
      },
    ],
    tasks: [],
    dispatchJobs: [],
    workflowProposals: [],
    auditEvents: [],
    activeReceipts: [],
    readiness: [],
  } as unknown as DesktopState;
}

function installMuon(state: DesktopState) {
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn(() => () => undefined),
    selectChat: vi.fn().mockResolvedValue(undefined),
    archiveChat: vi.fn().mockResolvedValue({
      id: "chat-a",
      status: "archived",
    }),
    streams: vi.fn().mockResolvedValue([]),
    memoryLibrary: vi.fn().mockResolvedValue({
      notes: [],
      edges: [],
      confirmations: [],
      imports: [],
      analytics: {
        noteScores: [],
        hotModules: [],
        communities: [],
        source: { notes: 0, modules: 0, edges: 0, truncated: false },
      },
      total: 0,
      truncated: false,
    }),
    getAutoConfirmAgentMemory: vi.fn().mockResolvedValue(false),
    gitnexusGraph: vi.fn().mockResolvedValue({
      nodes: [],
      relationships: [],
      truncated: false,
      error: "No indexed graph yet.",
    }),
    terminal: {
      open: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    },
  };
  Object.assign(window, { muon });
  return muon;
}

beforeEach(() => {
  localStorage.setItem("muon.onboarded", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("App per-chat integration lifecycle", () => {
  it("clears stale navigation and GitNexus state when there is no chat", async () => {
    const state = {
      ...stateWithChats(),
      chats: [],
      approvals: [],
      gitnexus: {
        status: "ready",
        workspacePath: "/archived-repo",
        symbolCount: 999,
      },
    } as DesktopState;
    const muon = installMuon(state);
    render(React.createElement(App));

    expect(await screen.findByText("Pick a chat or start a new one.")).toBeTruthy();
    await waitFor(() => expect(muon.selectChat).toHaveBeenCalledWith(null));
    expect(
      screen.getByRole("button", { name: "Mission" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("button", { name: "Memory" }).getAttribute("aria-current")
    ).toBeNull();
    expect(screen.getByText("Select a chat to bind a workspace.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Open Graph" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(screen.queryByLabelText("Memory workspace")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Mission" }).getAttribute("aria-current")
    ).toBe("page");
  });

  it("resets panels on chat switch and scopes Memory and Control to the selected chat", async () => {
    const muon = installMuon(stateWithChats());
    render(React.createElement(App));

    await screen.findByText("Chat A", { selector: ".chat-title" });
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(await screen.findByLabelText("Memory workspace")).toBeTruthy();
    expect(muon.memoryLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-a" })
    );
    expect(
      screen.getByRole("button", { name: "Control" }).querySelector(".nav-badge")
    ).toBeNull();

    const chatBTitle = screen.getByText("Chat B", { selector: ".chat-title" });
    fireEvent.click(chatBTitle.closest("button")!);

    await waitFor(() => expect(muon.selectChat).toHaveBeenCalledWith("chat-b"));
    expect(screen.queryByLabelText("Memory workspace")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Mission" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen
        .getByRole("button", { name: /^Control/ })
        .querySelector(".nav-badge")
        ?.textContent
    ).toBe("1");
  });

  it("keeps navigation available while Graph owns only the center workspace", async () => {
    installMuon(stateWithChats());
    render(React.createElement(App));

    await screen.findByText("Chat A", { selector: ".chat-title" });
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(
      await screen.findByRole("region", {
        name: "GitNexus knowledge graph",
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Workspace navigation" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(
      screen.queryByRole("region", { name: "GitNexus knowledge graph" })
    ).toBeNull();
    expect(await screen.findByLabelText("Memory workspace")).toBeTruthy();
  });

  it("selects the next surviving chat without reopening the archived snapshot row", async () => {
    const muon = installMuon(stateWithChats());
    render(React.createElement(App));

    await screen.findByText("Chat A", { selector: ".chat-title" });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Archive chat" })[0]!
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive" })
    );

    await waitFor(() => expect(muon.archiveChat).toHaveBeenCalledWith("chat-a"));
    await waitFor(() => expect(muon.selectChat).toHaveBeenCalledWith("chat-b"));
    expect(screen.getByText("Chat B", { selector: "h2" })).toBeTruthy();
  });
});
