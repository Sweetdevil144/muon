// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "muon");
});

function gatedState(gate: { required: boolean; satisfied: boolean }): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    github: { configured: true, connected: false },
    githubGate: gate,
    fleet: { counts: {}, agents: [] },
    chats: [],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

function installBridge(state: DesktopState) {
  Object.assign(window, {
    muon: {
      getState: vi.fn().mockResolvedValue(state),
      on: vi.fn(() => () => {}),
      streams: vi.fn().mockResolvedValue([]),
      workspaceReview: vi.fn().mockResolvedValue({ status: "degraded", reason: "n/a" }),
      autoContext: vi.fn().mockResolvedValue(null),
      preEditContext: vi.fn().mockResolvedValue(null),
      dataBoundaries: vi
        .fn()
        .mockResolvedValue({ status: "degraded", reason: "not under test" }),
      reconMap: vi
        .fn()
        .mockResolvedValue({ status: "degraded", reason: "not under test" }),
      startGitHubDeviceFlow: vi.fn(),
      pollGitHubDeviceFlow: vi.fn(),
      disconnectGitHub: vi.fn(),
      openGitHubUrl: vi.fn(),
    },
  });
}

// P0-2 — the gate SCREEN. Presentation only (enforcement is main-side IPC
// wrapping), but the screen is what tells the operator the way through.
describe("GitHub identity gate screen", () => {
  it("required + unsatisfied → the gate replaces the app, with the connect flow inside", async () => {
    installBridge(gatedState({ required: true, satisfied: false }));
    render(<App />);
    expect(
      await screen.findByRole("dialog", { name: "Sign in with GitHub" })
    ).toBeTruthy();
    expect(screen.getByText("Verify your GitHub identity")).toBeTruthy();
    // The actual device-flow control is present — the gate is a door, not a
    // wall. Matched EXACTLY: the label is "Connect" since the connect-panel
    // refactor, and a loose /Connect/ would also match the "Connecting…" busy
    // state, so a gate stuck mid-flow would read as a working door.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    // …and the app's own chrome did not mount behind it.
    expect(screen.queryByText("Workspaces")).toBeNull();
  });

  it("satisfied → the normal app mounts, no gate", async () => {
    installBridge(gatedState({ required: true, satisfied: true }));
    render(<App />);
    expect(// The desk chrome mounted: the Sessions tab is unconditional in the
      // Session-desk titlebar (the old "Workspaces" heading became project groups).
      await screen.findByRole("tab", { name: "Sessions" })).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Sign in with GitHub" })
    ).toBeNull();
  });

  it("not required (development) → no gate either", async () => {
    installBridge(gatedState({ required: false, satisfied: false }));
    render(<App />);
    expect(// The desk chrome mounted: the Sessions tab is unconditional in the
      // Session-desk titlebar (the old "Workspaces" heading became project groups).
      await screen.findByRole("tab", { name: "Sessions" })).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Sign in with GitHub" })
    ).toBeNull();
  });
});
