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

// ── S10: chat-level model — human-typed /model interception + threading ──────
//
// A HUMAN-typed literal `/model <id>` never becomes a chat turn: it sets the
// chat's own root model client-side (the super-agent may set WORKER models via
// dispatch(model=…) but must never rewrite its own root model through chat
// prose — payload-is-data). Every subsequent real turn then carries the chosen
// model as the validated override.

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
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App chat-level model (S10)", () => {
  it("intercepts /model, persists it per-chat, and threads it onto the next turn", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    const textarea = await screen.findByLabelText("Message to MUON");

    // Type the human /model command and send it.
    fireEvent.change(textarea, { target: { value: "/model opus" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Intercepted: the command NEVER reaches the orchestrator as a turn.
    expect(muon.sendMessage).not.toHaveBeenCalled();

    // The compact agent-config trigger reflects the chosen chat-level model.
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Claude Code · opus · Medium/i,
        })
      ).toBeTruthy();
    });

    // A real message now carries the chat-level model as the validated override.
    fireEvent.change(textarea, { target: { value: "plan the migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(muon.sendMessage).toHaveBeenCalledWith({
        chatId: "chat-1",
        message: "plan the migration",
        model: "opus",
      });
    });
  });

  it("does not attach a model when none is chosen (today's behavior)", async () => {
    const muon = mockMuon(baseState());
    render(React.createElement(App));

    const textarea = await screen.findByLabelText("Message to MUON");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(muon.sendMessage).toHaveBeenCalledWith({
        chatId: "chat-1",
        message: "hello",
        model: undefined,
      });
    });
  });

  it("unlocks the composer and surfaces an IPC rejection", async () => {
    const muon = mockMuon(baseState());
    muon.sendMessage.mockRejectedValueOnce(new Error("desktop IPC disconnected"));
    render(React.createElement(App));

    const textarea = await screen.findByLabelText("Message to MUON");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("✗ desktop IPC disconnected");
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
  });
});
