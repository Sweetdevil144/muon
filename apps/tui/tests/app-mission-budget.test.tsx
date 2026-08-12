import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { MuonApiClient } from "@muon/client";
import type { BrainSnapshot, BrainStore } from "../src/lib/brain-store.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { App } from "../src/components/App.js";

function stubStore(snapshot: BrainSnapshot): BrainStore {
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

const snapshotWithTask: BrainSnapshot = {
  ...emptyBrainSnapshot(),
  health: {
    status: "ok",
    service: "muon-backend",
    timestamp: "2026-07-16T00:00:00.000Z",
  },
  tasks: [
    {
      id: "task-1",
      title: "Ship budget parity",
      description: "",
      status: "in_progress",
      priority: "high",
    },
  ],
  agents: [
    {
      id: "agent-1",
      vendor: "codex",
      name: "codex-1",
      ordinal: 1,
      status: "working",
      currentTaskId: "task-1",
    },
  ],
};

describe("App mission budget (S9 TUI parity, item 3)", () => {
  it("resolves the active mission root's budget through the shared client projection and renders it live", async () => {
    const store = stubStore(snapshotWithTask);
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([
      {
        id: "job-root",
        kind: "session",
        vendor: "codex",
        taskId: "task-1",
        brief: "ship it",
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
        interruptRequested: false,
        steerMessages: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    vi.spyOn(store.client, "getDispatchBudget").mockResolvedValue({
      jobId: "job-root",
      capabilityMode: "orchestrator",
      rootWallMs: 1_800_000,
      maxDescendantWallMs: 1_800_000,
      poolMs: 1_800_000,
      reservedMs: 300_000,
      consumedMs: 600_000,
      remainingMs: 900_000,
      deadlineAt: null,
      childrenIssued: 1,
      maxChildren: 3,
      descendantsIssued: 1,
      maxDescendants: 8,
      depth: 0,
      maxDepth: 3,
      children: [
        {
          jobId: "child-a",
          vendor: "codex",
          status: "running",
          depth: 1,
          reservedMs: 300_000,
          consumedMs: 120_000,
        },
      ],
    });

    const { lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("15m left of 30m pool")
    );
    unmount();
  });

  it("shows the honest unknown state, never a stale number, when no dispatch lineage exists yet", async () => {
    const store = stubStore(snapshotWithTask);
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([]);

    const { lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("no active mission")
    );
    unmount();
  });

  it("degrades to the honest poll-fail state, never a stale ready number, when the budget fetch errors", async () => {
    const store = stubStore(snapshotWithTask);
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([
      {
        id: "job-root",
        kind: "session",
        vendor: "codex",
        taskId: "task-1",
        brief: "ship it",
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
        interruptRequested: false,
        steerMessages: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ]);
    // Short message: the control-rail column is narrow (width 26) and the
    // line wraps with truncate-end, so keep the assertion inside that budget.
    vi.spyOn(store.client, "getDispatchBudget").mockRejectedValue(
      new Error("offline")
    );

    const { lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("budget: offline")
    );
    expect(lastFrame() ?? "").not.toContain("left of");
    unmount();
  });

  it("b opens the per-descendant breakdown from the crew view, Esc closes it", async () => {
    const store = stubStore(snapshotWithTask);
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([]);

    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, widthOverride: 140 })
    );

    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("no active mission")
    );

    stdin.write("\t"); // Tab: focus tasks -> lanes (the crew view)
    // Wait for the focus state to actually flush before sending "b" — sending
    // both synchronously races the Tab's setState against useInput's closure.
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("› ● codex-1")
    );
    stdin.write("b");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("Mission budget")
    );
    expect(lastFrame() ?? "").toContain("Esc close");

    stdin.write("\u001b"); // Escape closes the overlay
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").not.toContain("Mission budget")
    );
    unmount();
  });
});
