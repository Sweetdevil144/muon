// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";

/**
 * U2 — switching workspace tabs must never stop a live vendor session.
 *
 * The old center rendered exactly ONE tabpanel, so selecting another tab
 * unmounted the terminal. Everything downstream of that unmount was a real
 * defect and not merely a re-render:
 *
 *   • the renderer port closed, so the host DETACHED — and PtyHost pauses the
 *     driver once a detached session's unacked bytes cross its high-water
 *     mark, which is OS flow control stopping the vendor CLI mid-work;
 *   • the XTerm was disposed, so returning replayed a BOUNDED byte ring into a
 *     brand-new terminal — for a full-screen TUI that is a replay from
 *     wherever the ring was trimmed to, quite possibly mid-escape-sequence.
 *
 * These tests pin the contract the founder asked for: pure show/hide, one open
 * per session for its whole life, no close, no re-attach.
 */

const xtermViews: Array<{ disposed: boolean; refits: number }> = [];
vi.mock("../src/renderer/lib/xterm-view.js", () => ({
  createXtermView: () => {
    const record = { disposed: false, refits: 0 };
    xtermViews.push(record);
    return {
      write: () => undefined,
      onInput: () => ({ dispose: () => undefined }),
      onResize: () => ({ dispose: () => undefined }),
      refit: () => {
        record.refits += 1;
      },
      size: () => ({ cols: 120, rows: 40 }),
      markExited: () => undefined,
      markError: () => undefined,
      dispose: () => {
        record.disposed = true;
      },
    };
  },
}));

import { App } from "../src/renderer/app.js";

function baseState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    realPty: "real",
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    gitnexus: { status: "ready", workspacePath: "/repo", symbolCount: 1 },
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-a",
        title: "Mission",
        workspacePath: "/repo",
        taskId: "task-a",
        status: "active",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
    ],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    workflowProposals: [],
    auditEvents: [],
    activeReceipts: [],
    readiness: [],
  } as unknown as DesktopState;
}

function installMuon() {
  const opened: string[] = [];
  const closed: string[] = [];
  const muon = {
    getState: vi.fn().mockResolvedValue(baseState()),
    on: vi.fn(() => () => undefined),
    selectChat: vi.fn().mockResolvedValue(undefined),
    streams: vi.fn().mockResolvedValue([]),
    gitnexusGraph: vi.fn().mockResolvedValue({
      nodes: [],
      relationships: [],
      truncated: false,
    }),
    terminal: {
      open: vi.fn(async (sessionId: string) => {
        opened.push(sessionId);
        return {
          post: () => undefined,
          onFrame: () => undefined,
          close: () => undefined,
        };
      }),
      close: vi.fn(async (sessionId: string) => {
        closed.push(sessionId);
      }),
    },
  };
  Object.assign(window, { muon });
  return { muon, opened, closed };
}

/** Spawning now goes through the strip's single "+" menu: open it, then pick
 *  the "New <Vendor> session" entry. */
async function openTerminal(label: string) {
  const trigger = await screen.findByRole("button", {
    name: "Open a terminal in this workspace",
  });
  fireEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: label });
  fireEvent.click(item);
}

function panel(sessionId: string): HTMLElement | null {
  return document.getElementById(`workspace-panel-${sessionId}`);
}

beforeEach(() => {
  localStorage.setItem("muon.onboarded", "1");
  xtermViews.length = 0;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("U2 — backgrounding a terminal tab never stops the session", () => {
  it("keeps the pane MOUNTED and the channel OPEN across a switch to Mission chat", async () => {
    const { opened, closed } = installMuon();
    render(React.createElement(App));

    await openTerminal("New Claude session");
    await waitFor(() => expect(opened).toHaveLength(1));
    const sessionId = opened[0]!;
    expect(sessionId).toMatch(/^terminal-chat:chat-a:claude-code\.1$/);
    expect(panel(sessionId)?.hasAttribute("hidden")).toBe(false);

    // Switch to Mission chat — the demo's own move.
    fireEvent.click(screen.getByRole("tab", { name: "Mission chat" }));
    await waitFor(() =>
      expect(panel(sessionId)?.hasAttribute("hidden")).toBe(true)
    );
    // Still there. Still open. Never closed. Never re-opened.
    expect(panel(sessionId)).toBeTruthy();
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(xtermViews).toHaveLength(1);
    expect(xtermViews[0]!.disposed).toBe(false);

    // Back again: shown, re-measured, and STILL the same session.
    // T2 may append " · Idle/Working/…" to the accessible name via aria-label.
    fireEvent.click(screen.getByRole("tab", { name: /^Claude/ }));
    await waitFor(() =>
      expect(panel(sessionId)?.hasAttribute("hidden")).toBe(false)
    );
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(xtermViews[0]!.disposed).toBe(false);
    expect(xtermViews[0]!.refits).toBeGreaterThan(0);
  });

  it("runs two vendor sessions at once; switching between them opens neither again", async () => {
    const { opened, closed } = installMuon();
    render(React.createElement(App));

    await openTerminal("New Claude session");
    await waitFor(() => expect(opened).toHaveLength(1));
    await openTerminal("New Codex session");
    await waitFor(() => expect(opened).toHaveLength(2));

    const claude = opened[0]!;
    const codex = opened[1]!;
    expect(panel(claude)?.hasAttribute("hidden")).toBe(true);
    expect(panel(codex)?.hasAttribute("hidden")).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: /^Claude/ }));
    await waitFor(() =>
      expect(panel(claude)?.hasAttribute("hidden")).toBe(false)
    );
    // The backgrounded Codex session is untouched: mounted, attached, alive.
    expect(panel(codex)?.hasAttribute("hidden")).toBe(true);
    expect(panel(codex)).toBeTruthy();
    expect(opened).toHaveLength(2);
    expect(closed).toHaveLength(0);
    expect(xtermViews.every((view) => !view.disposed)).toBe(true);
  });

  it("CLOSING a terminal tab still kills its pty — background is not immortality", async () => {
    const { muon, opened, closed } = installMuon();
    render(React.createElement(App));

    await openTerminal("New Claude session");
    await waitFor(() => expect(opened).toHaveLength(1));
    const sessionId = opened[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Close Claude tab" }));
    await waitFor(() => expect(panel(sessionId)).toBeNull());
    expect(muon.terminal.close).toHaveBeenCalledWith(sessionId);
    expect(closed).toEqual([sessionId]);
    expect(xtermViews[0]!.disposed).toBe(true);
  });
});
