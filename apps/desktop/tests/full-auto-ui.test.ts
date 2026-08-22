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
import { Sidebar } from "../src/renderer/sidebar.js";
import { FLEET_VENDORS, FLEET_VENDOR_LABELS } from "../src/lib/fleet.js";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

// ── Full-Auto ("Auto Approve all") renderer wiring ───────────────────────────
//
// The backend + IPC (window.muon.setFullAuto, DesktopState.fullAuto,
// RendererSettings.fullAuto) already shipped; this slice is the UI: a
// deliberately DANGEROUS toggle in the sidebar Setup drawer (it disables
// every approval gate app-wide) and a persistent, unmissable titlebar band
// while it's armed. Both must be wired to the REAL IPC call, never a
// local-only flag — a "no dead controls" requirement.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sidebarProps(
  fullAuto: boolean,
  onSetFullAutoVendors = vi.fn(),
  // P0-1: a SUBSET is representable (IPC + persisted state accept one), so
  // the panel's honesty under it is pinned with an explicit override.
  fullAutoVendors?: string[]
) {
  const state = {
    chats: [],
    fleet: { counts: {}, agents: [] },
    fullAuto,
    // Vendor-scoped consent: the boolean helper keeps the legacy meaning —
    // true == every lane selected, false == none.
    fullAutoVendors: fullAutoVendors ?? (fullAuto ? [...FLEET_VENDORS] : []),
  } as unknown as DesktopState;
  return {
    state,
    activeChatId: null,
    taskTitles: new Map<string, string>(),
    onSelectChat: vi.fn(),
    onArchiveChat: vi.fn(),
    navActive: "mission" as const,
    navPendingDecisions: 0,
    navCrewActive: false,
    navFleet: [],
    onNavigate: vi.fn(),
    onNewChat: vi.fn(),
    onStepFleet: vi.fn(),
    onOpenAgent: vi.fn(),
    onSetFullAutoVendors,
  };
}

describe("Sidebar full-auto ('Auto-approve') control", () => {
  it("shows the Auto-approve button without opening any drawer (always visible)", () => {
    const { container } = render(
      React.createElement(Sidebar, sidebarProps(false))
    );
    expect(
      screen.getByRole("button", { name: /^auto-approve$/i })
    ).toBeTruthy();
    expect(
      container.querySelector(".side-setup .full-auto-panel")
    ).toBeNull();
    expect(
      container.querySelector(".full-auto-section .full-auto-panel")
    ).toBeTruthy();
    expect(container.querySelector(".full-auto-lanes")).toBeNull();
  });

  it("reflects state.fullAuto === true as the button's pressed state", () => {
    render(React.createElement(Sidebar, sidebarProps(true)));
    expect(
      screen.getByRole("button", { name: /^auto-approve$/i }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("reflects state.fullAuto === false as not pressed", () => {
    render(React.createElement(Sidebar, sidebarProps(false)));
    expect(
      screen.getByRole("button", { name: /^auto-approve$/i }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("switching ON selects every managed lane", () => {
    const onSetFullAutoVendors = vi.fn();
    render(
      React.createElement(Sidebar, sidebarProps(false, onSetFullAutoVendors))
    );
    fireEvent.click(screen.getByRole("button", { name: /^auto-approve$/i }));
    expect(onSetFullAutoVendors).toHaveBeenCalledTimes(1);
    expect(onSetFullAutoVendors).toHaveBeenCalledWith([...FLEET_VENDORS]);
  });

  it("switching OFF clears the selection", () => {
    const onSetFullAutoVendors = vi.fn();
    render(
      React.createElement(Sidebar, sidebarProps(true, onSetFullAutoVendors))
    );
    fireEvent.click(screen.getByRole("button", { name: /^auto-approve$/i }));
    expect(onSetFullAutoVendors).toHaveBeenCalledWith([]);
  });

  it("P0-1: a SUBSET is pressed and dangerous but NEVER says 'every lane' — it names its lanes", () => {
    const subset = [FLEET_VENDORS[0]!];
    const { container } = render(
      React.createElement(Sidebar, sidebarProps(false, vi.fn(), subset))
    );
    // Armed: any lane with gates off deserves the danger rail...
    expect(
      screen
        .getByRole("button", { name: /^auto-approve$/i })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(container.querySelector(".full-auto-panel.armed")).toBeTruthy();
    // ...but the COPY tells the truth: named lanes, others still ask.
    const copy = container.querySelector("#full-auto-copy")!.textContent!;
    expect(copy).not.toMatch(/every lane/i);
    expect(copy).toMatch(/only — other lanes still ask/i);
    // The DISCLOSURE itself: the armed lane is named (cubic: without this,
    // "On for  only —" would pass while naming nothing).
    expect(copy).toContain(FLEET_VENDOR_LABELS[FLEET_VENDORS[0]!]);
  });

  it("P0-1: clicking while a subset is armed only NARROWS (clears), never widens", () => {
    const onSetFullAutoVendors = vi.fn();
    render(
      React.createElement(
        Sidebar,
        sidebarProps(false, onSetFullAutoVendors, [FLEET_VENDORS[0]!])
      )
    );
    fireEvent.click(screen.getByRole("button", { name: /^auto-approve$/i }));
    expect(onSetFullAutoVendors).toHaveBeenCalledWith([]);
  });

  it("styles the control as dangerous when armed", () => {
    const { container: onContainer } = render(
      React.createElement(Sidebar, sidebarProps(true))
    );
    expect(onContainer.querySelector(".full-auto-panel.armed")).toBeTruthy();
    cleanup();

    const { container: offContainer } = render(
      React.createElement(Sidebar, sidebarProps(false))
    );
    expect(offContainer.querySelector(".full-auto-panel.armed")).toBeFalsy();
  });
});

// ── App-level: real IPC + the persistent titlebar indicator ─────────────────

function baseState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fullAuto: false,
    fleet: { counts: {}, agents: [] },
    chats: [],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    auditEvents: [],
    readiness: [],
    ...overrides,
  } as unknown as DesktopState;
}

function mockMuon(initialState: DesktopState) {
  let state = initialState;
  const muon = {
    getState: vi.fn(async () => state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
    workspaceReview: vi.fn().mockResolvedValue({
      status: "degraded",
      reason: "n/a",
      action: "n/a",
    }),
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
    preEditContext: vi.fn().mockResolvedValue(null),
    setFullAuto: vi.fn(async (enabled: boolean) => {
      state = { ...state, fullAuto: enabled };
    }),
    setFullAutoVendors: vi.fn(async (vendors: string[]) => {
      state = {
        ...state,
        fullAuto: vendors.length > 0,
        fullAutoVendors: vendors,
      };
    }),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App full-auto: real IPC wiring + titlebar indicator", () => {
  it("shows no 'safety gates off' band while fullAuto is off", async () => {
    mockMuon(baseState({ fullAuto: false }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    // role="status" is unique to the titlebar band (the sidebar's own danger
    // copy also contains the phrase "safety gates off", so this must target
    // the titlebar element specifically, not just any matching text).
    expect(screen.queryByRole("status")).toBeFalsy();
  });

  it("shows the persistent titlebar band the instant fullAuto is on", async () => {
    mockMuon(baseState({ fullAuto: true }));
    render(React.createElement(App));
    const indicator = await screen.findByRole("status");
    expect(indicator.textContent).toMatch(/full auto.*safety gates off/i);
  });

  it("flipping Auto-approve ON calls window.muon.setFullAutoVendors with every lane", async () => {
    const muon = mockMuon(baseState({ fullAuto: false }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");

    fireEvent.click(screen.getByRole("button", { name: /^auto-approve$/i }));

    await waitFor(() => {
      expect(muon.setFullAutoVendors).toHaveBeenCalledWith([...FLEET_VENDORS]);
    });
  });

  it("the titlebar band appears after the toggle round-trips through the real IPC + a state refresh", async () => {
    const muon = mockMuon(baseState({ fullAuto: false }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    expect(screen.queryByRole("status")).toBeFalsy();

    fireEvent.click(screen.getByRole("button", { name: /^auto-approve$/i }));

    await waitFor(() => {
      expect(muon.setFullAutoVendors).toHaveBeenCalledWith([...FLEET_VENDORS]);
    });
    const indicator = await screen.findByRole("status");
    expect(indicator.textContent).toMatch(/full auto.*safety gates off/i);
  });
});
