// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPreset } from "../src/lib/presets.js";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "muon");
});

const balanced: DesktopPreset = {
  id: "balanced",
  name: "Balanced",
  vendor: "claude-code",
  model: "sonnet",
  effort: "medium",
  permission: "default",
};

function state(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: {
      apiBase: "http://localhost:4000",
      apiTokenSet: false,
      presets: [balanced],
    },
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Preset mission",
        workspacePath: "/repo",
        status: "active",
        createdAt: "2026-07-21T09:00:00.000Z",
        updatedAt: "2026-07-21T09:00:00.000Z",
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
        detail: "ready",
      },
    ],
  } as unknown as DesktopState;
}

function mockMuon() {
  const muon = {
    getState: vi.fn().mockResolvedValue(state()),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    applyPreset: vi.fn().mockResolvedValue({
      preset: balanced,
      laneProfileVersion: 2,
    }),
    savePresets: vi.fn().mockResolvedValue(state()),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App presets", () => {
  it("configures the persisted lane in one click and threads the model onto the next dispatch", async () => {
    const muon = mockMuon();
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /apply balanced preset/i,
      })
    );

    await waitFor(() => {
      expect(muon.applyPreset).toHaveBeenCalledWith("balanced");
      expect(
        screen.getByRole("button", {
          name: /Claude Code · sonnet · Medium/i,
        })
      ).toBeTruthy();
    });

    const textarea = screen.getByLabelText("Message to MUON");
    fireEvent.change(textarea, { target: { value: "review the parser" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(muon.sendMessage).toHaveBeenCalledWith({
        chatId: "chat-1",
        message: "review the parser",
        model: "sonnet",
      })
    );
  });
});
