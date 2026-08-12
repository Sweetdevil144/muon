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
import { App } from "../src/renderer/app.js";
import { SettingsPanel } from "../src/renderer/settings-panel.js";
import type { DesktopState } from "../src/shared/ipc.js";

// ── S4 auto-continue: the control that never existed ─────────────────────────
//
// `window.muon.setAutoContinue`, the IPC handler, and the persisted preference
// all shipped with ZERO call sites in the renderer. The default is on, so the
// behaviour was right — but turning it OFF meant setting MUON_AUTO_CONTINUE=0
// and relaunching the app. These tests pin that the Settings control exists, is
// wired to the REAL IPC (no local-only flag), and round-trips: the checkbox
// follows the CONFIRMED persisted state, not an optimistic guess.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { muon?: unknown }).muon;
});

function settingsProps(
  autoContinue: boolean | undefined,
  onToggleAutoContinue = vi.fn()
) {
  return {
    state: {
      settings: { apiBase: "http://localhost:4000", autoContinue },
    } as unknown as DesktopState,
    onSaveSettings: vi.fn(),
    onStartGitHub: vi.fn(),
    onPollGitHub: vi.fn(),
    onDisconnectGitHub: vi.fn(),
    onOpenGitHubUrl: vi.fn(),
    updateStatus: { state: "idle" } as never,
    onCheckUpdates: vi.fn(),
    onToggleAutoUpdate: vi.fn(),
    onToggleAutoContinue,
    onDownloadUpdate: vi.fn(),
    onInstallUpdate: vi.fn(),
  };
}

const CONTROL = /continue orchestration automatically/i;

describe("Settings — auto-continue posture control", () => {
  it("renders the control in Settings alongside the other posture toggles", () => {
    const { container } = render(
      React.createElement(SettingsPanel, settingsProps(true))
    );
    expect(screen.getByRole("checkbox", { name: CONTROL })).toBeTruthy();
    expect(container.querySelector("#settings-orchestration")).toBeTruthy();
  });

  it("explains what it does in operator language", () => {
    render(React.createElement(SettingsPanel, settingsProps(true)));
    expect(
      screen.getByText(
        /MUON continues an idle chat by itself when a worker finishes/i
      )
    ).toBeTruthy();
  });

  it("reflects the persisted preference in both directions", () => {
    render(React.createElement(SettingsPanel, settingsProps(true)));
    expect(
      (screen.getByRole("checkbox", { name: CONTROL }) as HTMLInputElement)
        .checked
    ).toBe(true);
    cleanup();

    render(React.createElement(SettingsPanel, settingsProps(false)));
    expect(
      (screen.getByRole("checkbox", { name: CONTROL }) as HTMLInputElement)
        .checked
    ).toBe(false);
  });

  // An older persisted settings literal has no `autoContinue` field at all. The
  // desktop default is ON, so an absent field must not render as "off" — that
  // would tell the operator auto-continue is disabled while it is running.
  it("treats an absent preference as ON, matching the desktop default", () => {
    render(React.createElement(SettingsPanel, settingsProps(undefined)));
    expect(
      (screen.getByRole("checkbox", { name: CONTROL }) as HTMLInputElement)
        .checked
    ).toBe(true);
  });

  it("calls the toggle handler with the right value in both directions", () => {
    const off = vi.fn();
    render(React.createElement(SettingsPanel, settingsProps(true, off)));
    fireEvent.click(screen.getByRole("checkbox", { name: CONTROL }));
    expect(off).toHaveBeenCalledWith(false);
    cleanup();

    const on = vi.fn();
    render(React.createElement(SettingsPanel, settingsProps(false, on)));
    fireEvent.click(screen.getByRole("checkbox", { name: CONTROL }));
    expect(on).toHaveBeenCalledWith(true);
  });
});

// ── App level: the real IPC, and the round trip back into the checkbox ───────

function baseState(autoContinue: boolean): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    settings: {
      apiBase: "http://localhost:4000",
      apiTokenSet: false,
      autoContinue,
    },
    fullAuto: false,
    fleet: { counts: {}, agents: [] },
    chats: [],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

function mockMuon(autoContinue: boolean) {
  let state = baseState(autoContinue);
  const muon = {
    getState: vi.fn(async () => state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    reviewDiff: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    workspaceReview: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "n/a", action: "n/a" }),
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    preEditContext: vi.fn().mockResolvedValue(null),
    // The main process is the source of truth: the handler persists, and the
    // next getState is what the checkbox must follow.
    setAutoContinue: vi.fn(async (enabled: boolean) => {
      state = {
        ...state,
        settings: { ...state.settings, autoContinue: enabled },
      };
    }),
  };
  Object.assign(window, { muon });
  return muon;
}

async function openSettings() {
  render(React.createElement(App));
  await screen.findAllByText("MUON");
  fireEvent.click(screen.getAllByRole("button", { name: /settings/i })[0]);
  return screen.findByRole("checkbox", { name: CONTROL });
}

describe("App auto-continue: real IPC wiring", () => {
  it("turning it off calls window.muon.setAutoContinue(false) — no dead control", async () => {
    const muon = mockMuon(true);
    const checkbox = await openSettings();
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(muon.setAutoContinue).toHaveBeenCalledWith(false);
    });
  });

  it("round-trips: the checkbox settles on the state the main process confirmed", async () => {
    const muon = mockMuon(true);
    const checkbox = await openSettings();

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(muon.setAutoContinue).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", { name: CONTROL }) as HTMLInputElement)
          .checked
      ).toBe(false);
    });

    // ...and back on again, through the same confirmed path.
    fireEvent.click(screen.getByRole("checkbox", { name: CONTROL }));
    await waitFor(() => {
      expect(muon.setAutoContinue).toHaveBeenLastCalledWith(true);
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("checkbox", { name: CONTROL }) as HTMLInputElement)
          .checked
      ).toBe(true);
    });
  });
});
