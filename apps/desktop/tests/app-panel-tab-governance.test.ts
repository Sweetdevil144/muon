// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

// Task #130 GOVERNANCE REGRESSION — a `panel:` (Memory/Evidence) workspace
// tab must NEVER resolve a DispatchJobRecord. app.tsx's `activeSessionJob`
// fails to null for a panel tab exactly like it does for "chat"
// (`activeWorkspaceTab === "chat" || isPanelTab(activeWorkspaceTab)`), so
// SessionWorkspace — and therefore its inline fail-closed
// SessionGovernanceBanner — can never mount from a panel tab, even while a
// real approval is pending on the running job whose OWN tab would show it.

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
    fleet: {
      counts: { codex: 1 },
      agents: [
        {
          id: "agent-1",
          vendor: "codex",
          name: "Codex 1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-b",
          currentJobId: "job-b",
        },
      ],
    },
    chats: [
      {
        id: "chat-b",
        title: "Chat B — flaky test triage",
        workspacePath: "/repo-b",
        status: "active",
        createdAt: "2026-07-16T09:30:00.000Z",
        updatedAt: "2026-07-16T09:30:00.000Z",
      },
    ],
    approvals: [
      {
        id: "appr-1",
        taskId: "task-b",
        requestedBy: "codex",
        kind: "gate",
        reason: "Confirm before running the migration.",
        status: "pending",
        jobId: "job-b",
        createdAt: "2026-07-16T09:32:00.000Z",
      },
    ],
    tasks: [
      {
        id: "task-b",
        title: "Investigate flaky test",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-b",
        kind: "session",
        vendor: "codex",
        taskId: "task-b",
        chatId: "chat-b",
        agentId: "agent-1",
        brief: "Investigate the flaky test",
        status: "running",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "delegate",
        createdAt: "2026-07-16T09:31:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        credentialMethod: "vendor-login",
        detail: "Codex native login is ready",
      },
    ],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
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
    memoryLibrary: vi.fn().mockResolvedValue({
      notes: [],
      edges: [],
      confirmations: [],
      imports: [],
      total: 0,
      truncated: false,
    }),
    crewRoles: vi.fn().mockResolvedValue({
      status: "unavailable",
      reason: "not under test",
    }),
    coordination: vi.fn().mockResolvedValue({
      status: "unavailable",
      reason: "not under test",
    }),
  };
  Object.assign(window, { muon });
  return muon;
}

const GATE_REGION_NAME = "Pending decision for this agent";

describe("App — panel tabs never resolve a DispatchJobRecord (task #130 governance guard)", () => {
  it("shows the fail-closed governance banner on the job's own tab, but NEVER on the Evidence panel tab — even with the same approval pending", async () => {
    mockMuon(baseState());
    render(React.createElement(App));

    await screen.findByText("Chat B — flaky test triage", {
      selector: ".chat-title",
    });

    // Baseline: opening the running agent's OWN tab surfaces the fail-closed
    // gate — proves the banner CAN render for this exact pending approval.
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    const crewRow = await screen.findByRole("button", {
      name: /open this agent's stream/i,
    });
    fireEvent.click(crewRow);
    expect(
      await screen.findByRole("region", { name: GATE_REGION_NAME })
    ).toBeTruthy();

    // Now open the Evidence workspace tab (titlebar "Pre-edit context" —
    // task #130's replacement for the old brain modal).
    fireEvent.click(screen.getByRole("button", { name: "Pre-edit context" }));

    // The Evidence tab is now active and rendered as a `panel:` tabpanel...
    expect(
      screen.getByRole("tab", { name: "Evidence" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(
      await screen.findByRole("textbox", { name: "Filter this mission's evidence" })
    ).toBeTruthy();

    // ...and the SAME pending approval's governance banner is GONE — a panel
    // tab must never resolve activeSessionJob, so SessionWorkspace (and its
    // SessionGovernanceBanner) never mounts from it.
    expect(screen.queryByRole("region", { name: GATE_REGION_NAME })).toBeNull();

    // The job's own tab is still in the strip (untouched), just not active —
    // proves this is a routing guard, not a data loss.
    const jobTab = screen.getByRole("tab", { name: /codex permission/i });
    expect(jobTab.getAttribute("aria-selected")).toBe("false");

    // Round-trip: selecting the job tab again brings the banner right back.
    fireEvent.click(jobTab);
    expect(
      await screen.findByRole("region", { name: GATE_REGION_NAME })
    ).toBeTruthy();
  });

  it("also fails activeSessionJob to null for the Memory panel tab", async () => {
    mockMuon(baseState());
    render(React.createElement(App));

    await screen.findByText("Chat B — flaky test triage", {
      selector: ".chat-title",
    });
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    const crewRow = await screen.findByRole("button", {
      name: /open this agent's stream/i,
    });
    fireEvent.click(crewRow);
    await screen.findByRole("region", { name: GATE_REGION_NAME });

    // ControlRail's "Open memory" isn't reachable without the Control dock
    // open; the left-nav Memory item is the simplest deterministic entrypoint.
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));

    expect(
      screen.getByRole("tab", { name: "Memory" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(await screen.findByLabelText("Memory workspace")).toBeTruthy();
    expect(screen.queryByRole("region", { name: GATE_REGION_NAME })).toBeNull();
  });

  it("opens Topology as a first-class CENTER tab and never resolves a job from its panel: id", async () => {
    mockMuon(baseState());
    render(React.createElement(App));

    await screen.findByText("Chat B — flaky test triage", {
      selector: ".chat-title",
    });
    // Baseline: the running agent's own tab does surface the fail-closed gate.
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /open this agent's stream/i })
    );
    await screen.findByRole("region", { name: GATE_REGION_NAME });

    // The left-nav Topology row opens a CENTER tab (never an overlay).
    fireEvent.click(screen.getByRole("button", { name: "Topology" }));
    const tab = screen.getByRole("tab", { name: "Topology" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("aria-controls")).toBe("workspace-panel-panel:topology");
    expect(
      await screen.findByRole("region", { name: "Crew topology" })
    ).toBeTruthy();

    // The same pending approval's governance banner is GONE — `panel:topology`
    // fails activeSessionJob to null exactly like every other panel tab.
    expect(screen.queryByRole("region", { name: GATE_REGION_NAME })).toBeNull();
  });
});
