// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../src/renderer/graph-view.js";
import type { GitNexusIndexStatus } from "../src/shared/ipc.js";

// GraphView's repo-tab wiring, exercised WITHOUT ever touching Sigma/WebGL:
// gitnexusGraph() is mocked to resolve with an `error` + zero nodes, which is
// the exact condition graph-view.tsx checks before it lazy-imports "sigma" —
// so `renderGraph` (the only place that touches WebGL) never runs, and the
// component is safe to mount under jsdom. This mirrors the sigma-avoidance
// comment already at the top of graph-view.tsx.

function mockMuon() {
  const gitnexusGraph = vi.fn().mockResolvedValue({
    nodes: [],
    relationships: [],
    truncated: false,
    error: "not indexed yet",
  });
  Object.assign(window, { muon: { gitnexusGraph } });
  return gitnexusGraph;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GraphView (multi-repo tabs)", () => {
  it("single-repo status: no tab strip, gitnexusGraph called with no repoPath", async () => {
    const gitnexusGraph = mockMuon();
    const status: GitNexusIndexStatus = {
      status: "ready",
      repos: [{ path: "/ws", name: "ws", status: "ready" }],
    };
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status,
      })
    );

    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    expect(gitnexusGraph).toHaveBeenCalledWith(undefined, undefined);
    expect(screen.queryByRole("tablist", { name: /graph repositories/i })).toBeNull();
  });

  it("no repos array: no tab strip, gitnexusGraph called with no repoPath", async () => {
    const gitnexusGraph = mockMuon();
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "ready" },
      })
    );

    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    expect(gitnexusGraph).toHaveBeenCalledWith(undefined, undefined);
  });

  it("multi-repo status: renders a tab per repo, defaults to the first repo's path", async () => {
    const gitnexusGraph = mockMuon();
    const status: GitNexusIndexStatus = {
      status: "ready",
      repos: [
        { path: "/ws/backend", name: "backend", status: "ready" },
        { path: "/ws/frontend", name: "frontend", status: "indexing" },
        { path: "/ws/wealth", name: "wealth", status: "error" },
      ],
    };
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status,
      })
    );

    await waitFor(() =>
      expect(gitnexusGraph).toHaveBeenCalledWith("/ws/backend", undefined)
    );
    expect(screen.getByRole("tab", { name: "backend" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "frontend" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "wealth" })).toBeTruthy();
  });

  it("switching tabs re-fetches the graph for the newly selected repo", async () => {
    const gitnexusGraph = mockMuon();
    const status: GitNexusIndexStatus = {
      status: "ready",
      repos: [
        { path: "/ws/backend", name: "backend", status: "ready" },
        { path: "/ws/frontend", name: "frontend", status: "indexing" },
      ],
    };
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status,
      })
    );

    await waitFor(() =>
      expect(gitnexusGraph).toHaveBeenCalledWith("/ws/backend", undefined)
    );
    fireEvent.click(screen.getByRole("tab", { name: "frontend" }));
    await waitFor(() =>
      expect(gitnexusGraph).toHaveBeenCalledWith("/ws/frontend", undefined)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Re-index from the graph page.
//
// The operator most likely to need a re-index is the one already staring at an
// empty or broken graph. "Refresh" re-reads the SAME store and hands back the
// same broken picture, so the page needs the button that actually changes the
// answer — reachable even when the graph failed to render at all.
// ─────────────────────────────────────────────────────────────────────────────

function mockMuonWithReindex(
  result: Awaited<ReturnType<Window["muon"]["gitnexusReindex"]>> = {
    accepted: true,
    targets: ["/ws"],
    forced: true,
    note: "Rebuilding the code graph from scratch.",
  }
) {
  const gitnexusGraph = vi.fn().mockResolvedValue({
    nodes: [],
    relationships: [],
    truncated: false,
    error: "not indexed yet",
  });
  const gitnexusReindex = vi.fn().mockResolvedValue(result);
  const clearGitnexusGraphCache = vi.fn().mockResolvedValue(undefined);
  Object.assign(window, {
    muon: { gitnexusGraph, gitnexusReindex, clearGitnexusGraphCache },
  });
  return { gitnexusGraph, gitnexusReindex };
}

const reindexBtn = () =>
  screen.getByRole("button", { name: /re-index/i }) as HTMLButtonElement;

describe("GraphView — re-index", () => {
  it("is reachable even when the graph itself failed to load", async () => {
    const { gitnexusGraph } = mockMuonWithReindex();
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "error", note: "analyze exited (code 1)" },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    // Zoom/Fit/Refresh are all gated on a rendered graph; this one must not be.
    expect(screen.queryByRole("button", { name: /^Refresh$/ })).toBeNull();
    expect(reindexBtn().disabled).toBe(false);
  });

  it("targets the ACTIVE repo tab in a multi-repo workspace", async () => {
    const { gitnexusGraph, gitnexusReindex } = mockMuonWithReindex();
    const status: GitNexusIndexStatus = {
      status: "ready",
      repos: [
        { path: "/mono/a", name: "a", status: "ready" },
        { path: "/mono/b", name: "b", status: "error", note: "boom" },
      ],
    };
    render(
      React.createElement(GraphView, { open: true, onClose: vi.fn(), status })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: /b/ }));
    fireEvent.click(reindexBtn());
    await waitFor(() =>
      expect(gitnexusReindex).toHaveBeenCalledWith("/mono/b")
    );
  });

  it("single repo: re-indexes the bound workspace (no path)", async () => {
    const { gitnexusGraph, gitnexusReindex } = mockMuonWithReindex();
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "ready", repos: [{ path: "/ws", name: "ws", status: "ready" }] },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    fireEvent.click(reindexBtn());
    await waitFor(() => expect(gitnexusReindex).toHaveBeenCalledWith(undefined));
  });

  it("shows a refusal verbatim — never as if it worked", async () => {
    const { gitnexusGraph } = mockMuonWithReindex({
      accepted: false,
      reason: "already-running",
      note: "An index run is already in progress — waiting for it to finish.",
    });
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "ready", repos: [{ path: "/ws", name: "ws", status: "ready" }] },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    fireEvent.click(reindexBtn());
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/already in progress/i);
  });

  it("is disabled while an index run is in flight (no second run from here)", async () => {
    const { gitnexusGraph, gitnexusReindex } = mockMuonWithReindex();
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "indexing" },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    const button = reindexBtn();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/re-indexing/i);
    fireEvent.click(button);
    expect(gitnexusReindex).not.toHaveBeenCalled();
  });

  it("is disabled with an explanation when the CLI is missing", async () => {
    const { gitnexusGraph } = mockMuonWithReindex();
    render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "unknown", reason: "cli-missing", note: "CLI not found" },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    const button = reindexBtn();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/cannot re-index/i);
  });

  it("re-reads the store bypassing cache once the index finishes", async () => {
    const { gitnexusGraph } = mockMuonWithReindex();
    const view = render(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "indexing" },
      })
    );
    await waitFor(() => expect(gitnexusGraph).toHaveBeenCalled());
    const before = gitnexusGraph.mock.calls.length;

    // main pushes the completion; the graph on screen was built from the
    // PREVIOUS index and is now stale by construction.
    view.rerender(
      React.createElement(GraphView, {
        open: true,
        onClose: vi.fn(),
        status: { status: "ready", symbolCount: 9 },
      })
    );
    await waitFor(() =>
      expect(gitnexusGraph.mock.calls.length).toBeGreaterThan(before)
    );
    expect(gitnexusGraph).toHaveBeenLastCalledWith(undefined, { force: true });
  });
});
