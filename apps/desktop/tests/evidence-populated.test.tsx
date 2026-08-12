// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidencePanel } from "../src/renderer/brain.js";

/**
 * U3 — the Evidence tab used to open on a search box and the sentence "Enter a
 * symbol or file to review its evidence." That charges the human an entry fee
 * to see a record they already own. Evidence opens populated; search filters.
 */

function installBridge() {
  Object.defineProperty(window, "muon", {
    configurable: true,
    writable: true,
    value: {
      dataBoundaries: vi.fn(async () => ({
        status: "degraded",
        reason: "not under test",
      })),
      preEditContext: vi.fn(async () => null),
      getMemoryNote: vi.fn(async () => null),
      updateMemoryNote: vi.fn(async () => null),
      autoContext: vi.fn(async () => null),
    } as unknown as Window["muon"],
  });
}

const JOBS = [
  {
    id: "job-1",
    taskId: "task-1",
    vendor: "codex",
    status: "running",
    brief: "Research: GitNexus web frontend",
    capabilityMode: "delegate",
    workspacePath: "/repo/wt-1",
    createdAt: "2026-07-26T10:00:00.000Z",
    result: "Wrote docs/research/frontend.md",
  },
  {
    id: "job-2",
    taskId: "task-2",
    vendor: "claude-code",
    status: "done",
    brief: "Wire the mission composer",
    capabilityMode: "worker",
    workspacePath: "/repo/wt-2",
    createdAt: "2026-07-26T09:00:00.000Z",
  },
];

const EVENTS = [
  {
    id: "ev-1",
    taskId: "task-1",
    laneId: "lane-1",
    kind: "approval.requested",
    message: "session tool request: Bash",
    metadata: {},
    timestamp: "2026-07-26T10:05:00.000Z",
  },
  {
    id: "ev-2",
    taskId: "task-1",
    laneId: "lane-1",
    kind: "handoff.created",
    message: "handoff packet for the frontend research",
    metadata: {},
    timestamp: "2026-07-26T10:06:00.000Z",
  },
];

const TITLES = new Map([
  ["task-1", "Frontend research"],
  ["task-2", "Composer"],
]);

function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(
    React.createElement(EvidencePanel, {
      jobs: JOBS,
      events: EVENTS,
      taskTitles: TITLES,
      ...overrides,
    } as unknown as Parameters<typeof EvidencePanel>[0])
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "muon");
  vi.clearAllMocks();
});

describe("EvidencePanel — populated on open (U3)", () => {
  it("shows the mission's evidence immediately, with no query typed", () => {
    installBridge();
    renderPanel();

    expect(screen.getByLabelText("This mission's evidence")).toBeTruthy();
    expect(screen.getByText("Codex · Frontend research")).toBeTruthy();
    expect(screen.getByText("Claude Code · Composer")).toBeTruthy();
    expect(screen.getByText(/Research: GitNexus web frontend/)).toBeTruthy();
    // The old gate is gone.
    expect(
      screen.queryByText(/Enter a symbol or file to review its evidence/)
    ).toBeNull();
  });

  it("groups what the crew worked, cited, produced, and decided", () => {
    installBridge();
    renderPanel();
    for (const section of ["Worked", "Cited", "Produced", "Decided"]) {
      expect(screen.getByText(section)).toBeTruthy();
    }
    expect(screen.getByText(/Wrote docs\/research\/frontend.md/)).toBeTruthy();
    expect(screen.getByText(/session tool request: Bash/)).toBeTruthy();
  });

  it("uses the search box as a FILTER over what is already shown", () => {
    installBridge();
    renderPanel();

    const input = screen.getByPlaceholderText(
      /Filter evidence/
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "composer" } });

    expect(screen.getByText("Claude Code · Composer")).toBeTruthy();
    expect(screen.queryByText("Codex · Frontend research")).toBeNull();
    expect(screen.getByText(/1 of 5 records match/)).toBeTruthy();
  });

  it("says a filter matched nothing without claiming the mission is empty", () => {
    installBridge();
    renderPanel();

    const input = screen.getByPlaceholderText(
      /Filter evidence/
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzzznotpresent" } });

    expect(
      screen.getByText(/No record in this mission matches that filter/)
    ).toBeTruthy();
  });

  it("explains an empty mission instead of showing a blank page", () => {
    installBridge();
    renderPanel({ jobs: [], events: [] });
    expect(
      screen.getByText(/No agent has run in this mission yet/)
    ).toBeTruthy();
  });

  it("has a loading state and an error state, not silence", () => {
    installBridge();
    const { unmount } = renderPanel({
      jobs: [],
      events: [],
      missionLoading: true,
    });
    expect(screen.getByText(/Reading this mission's record…/)).toBeTruthy();
    unmount();

    installBridge();
    renderPanel({ missionError: "The brain is unreachable." });
    expect(screen.getByRole("alert").textContent).toContain(
      "The brain is unreachable."
    );
  });
});
