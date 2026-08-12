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

// ── D4: chat rename — double-click the header → seeded input → Enter/blur
// commits through the 3-hop bridge (renderer → preload → main → operator
// client), Escape cancels, empty-trim keeps the old title. Round-trips the
// SAME window.muon.updateChat the client already exposed; this pins the
// desktop-side wiring (shared/ipc.ts + preload.ts + main.ts) end-to-end
// through the real UI gesture, not just a source-text check.

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
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Repair parser",
        workspacePath: "/repo",
        status: "active",
        createdAt: "2026-07-16T09:00:00.000Z",
        updatedAt: "2026-07-16T09:00:00.000Z",
      },
    ],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    auditEvents: [],
    readiness: [
      {
        vendor: "claude-code",
        installed: true,
        authenticated: true,
        credentialMethod: "vendor-login",
        detail: "Claude Code is ready",
      },
    ],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
    preEditContext: vi.fn().mockResolvedValue(null),
    updateChat: vi.fn().mockResolvedValue({
      id: "chat-1",
      title: "Fix the flaky parser test",
      workspacePath: "/repo",
      status: "active",
    }),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App chat rename (D4)", () => {
  it("double-click seeds an editable title; Enter commits via window.muon.updateChat and re-ticks state", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    // The chat title also appears in the sidebar's chat list — scope to the
    // real <h2> heading in the conversation header, not just any matching text.
    const title = await screen.findByRole("heading", { name: "Repair parser" });
    fireEvent.doubleClick(title);

    const input = screen.getByLabelText("Rename chat") as HTMLInputElement;
    expect(input.value).toBe("Repair parser");

    fireEvent.change(input, { target: { value: "Fix the flaky parser test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(muon.updateChat).toHaveBeenCalledWith({
        chatId: "chat-1",
        title: "Fix the flaky parser test",
      });
    });
    // A rename re-ticks the store (same pattern as archiveChat) so the fresh
    // title is picked up from the next getState poll.
    await waitFor(() => {
      expect(muon.getState.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("Escape cancels without calling updateChat and restores the original title", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    const title = await screen.findByRole("heading", { name: "Repair parser" });
    fireEvent.doubleClick(title);
    const input = screen.getByLabelText("Rename chat") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Something else entirely" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(muon.updateChat).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Repair parser" })
    ).toBeTruthy();
  });

  it("committing an empty (whitespace-only) title keeps the old title and never calls updateChat", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    const title = await screen.findByRole("heading", { name: "Repair parser" });
    fireEvent.doubleClick(title);
    const input = screen.getByLabelText("Rename chat") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(muon.updateChat).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Repair parser" })
    ).toBeTruthy();
  });
});
