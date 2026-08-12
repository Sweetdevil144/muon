// @vitest-environment jsdom

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "@muon/client";
import { AgentPanes } from "../src/renderer/agent-panes.js";

afterEach(cleanup);

function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent-1",
    vendor: "codex",
    ordinal: 1,
    name: "Codex 1",
    status: "idle",
    currentTaskId: null,
    currentJobId: null,
    ...overrides,
  } as AgentRecord;
}

describe("AgentPanes collapsed band summary", () => {
  it("counts only working agents, not done/failed panes left open", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPanes, {
        agents: [
          agent({ id: "a1", name: "Codex 1", status: "done" }),
          agent({ id: "a2", name: "Claude 1", status: "failed" }),
          agent({ id: "a3", name: "Codex 2", status: "working" }),
        ],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Crew streams · 1 working");
  });

  it("falls back to a neutral stream count when nothing is working", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPanes, {
        agents: [
          agent({ id: "a1", name: "Codex 1", status: "done" }),
          agent({ id: "a2", name: "Claude 1", status: "failed" }),
        ],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Crew streams · 2 streams");
    expect(html).not.toContain("working<");
  });

  it("uses the singular for a single non-working stream", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentPanes, {
        agents: [agent({ id: "a1", name: "Codex 1", status: "done" })],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(html).toContain("Crew streams · 1 stream<");
  });

  it("opens and closes from an explicit button without crushing the workspace", () => {
    render(
      React.createElement(AgentPanes, {
        agents: [agent({ id: "a1", status: "working" })],
        defaultOpen: false,
        taskTitles: new Map(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
      })
    );

    const toggle = screen.getByRole("button", { name: /Crew streams/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Live crew streams")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Live crew streams")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Live crew streams")).toBeNull();
  });

  it("loads a pane by dispatch id so a reused agent cannot mix job streams", async () => {
    const streams = vi.fn().mockResolvedValue([]);
    Object.assign(window, { muon: { streams } });
    render(
      React.createElement(AgentPanes, {
        agents: [
          agent({
            id: "agent-reused",
            status: "working",
            currentJobId: "job-current",
          }),
        ],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: vi.fn(),
        onClose: vi.fn(),
      })
    );

    await waitFor(() =>
      expect(streams).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "job-current" })
      )
    );
  });

  it("routes Open and Close to the exact pane job when an agent slot is reused", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    Object.assign(window, {
      muon: { streams: vi.fn().mockResolvedValue([]) },
    });
    render(
      React.createElement(AgentPanes, {
        agents: [
          agent({
            id: "agent-reused",
            currentJobId: "job-history",
            status: "done",
          }),
        ],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen,
        onClose,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "×" }));

    expect(onOpen).toHaveBeenCalledWith("agent-reused", "job-history");
    expect(onClose).toHaveBeenCalledWith("job-history");
  });
});

// ── TODO 7.11: the five-wide desk ──────────────────────────────────────────

describe("AgentPanes five-wide desk (TODO 7.11)", () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    agent({
      id: `agent-${i + 1}`,
      name: `Agent ${i + 1}`,
      ordinal: i + 1,
      status: "working",
      currentJobId: `job-${i + 1}`,
    })
  );

  it("lays five lanes out five-wide with explicit columns (no auto-fit reflow)", () => {
render(
      React.createElement(AgentPanes, {
        agents: five,
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: () => undefined,
        onClose: () => undefined,
      })
    );
    const grid = document.getElementById("crew-stream-grid")!;
    expect(grid.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
  });

  it("caps the desk at five columns even with a sixth agent", () => {
render(
      React.createElement(AgentPanes, {
        agents: [...five, agent({ id: "agent-6", currentJobId: "job-6" })],
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: () => undefined,
        onClose: () => undefined,
      })
    );
    const grid = document.getElementById("crew-stream-grid")!;
    expect(grid.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
  });

  it("Cmd+3 focuses lane 3 without unmounting any pane (instant switch)", () => {
render(
      React.createElement(AgentPanes, {
        agents: five,
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: () => undefined,
        onClose: () => undefined,
      })
    );
    const before = document.querySelectorAll(".pane").length;
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    const panes = [...document.querySelectorAll(".pane")];
    expect(panes[2]!.classList.contains("pane-focused")).toBe(true);
    // Switching is a class flip: every pane is still mounted.
    expect(panes.length).toBe(before);
  });

  it("ignores a lane shortcut beyond the crew size", () => {
render(
      React.createElement(AgentPanes, {
        agents: five.slice(0, 2),
        defaultOpen: true,
        taskTitles: new Map(),
        onOpen: () => undefined,
        onClose: () => undefined,
      })
    );
    fireEvent.keyDown(window, { key: "5", metaKey: true });
    // Review finding 9: no phantom default ring — nothing focused until the
    // user actually picks a lane, and an out-of-range pick changes nothing.
    expect(document.querySelector(".pane-focused")).toBeNull();
  });
});
