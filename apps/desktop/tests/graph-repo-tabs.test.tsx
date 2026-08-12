// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRepoPath,
  GraphRepoTabs,
  repoDotClass,
} from "../src/renderer/graph-repo-tabs.js";
import type { GitNexusRepoStatus } from "../src/shared/ipc.js";

afterEach(cleanup);

const backend: GitNexusRepoStatus = {
  path: "/ws/backend",
  name: "backend",
  status: "ready",
};
const frontend: GitNexusRepoStatus = {
  path: "/ws/frontend",
  name: "frontend",
  status: "indexing",
};
const wealth: GitNexusRepoStatus = {
  path: "/ws/wealth",
  name: "wealth",
  status: "error",
  note: "GitNexus analyze failed",
};

describe("repoDotClass", () => {
  it("maps error → needs-attention", () => {
    expect(repoDotClass(wealth)).toBe("needs-attention");
  });

  it("maps indexing → live (the pulsing crew-liveness dot)", () => {
    expect(repoDotClass(frontend)).toBe("live");
  });

  it("maps ready (not stale) → done", () => {
    expect(repoDotClass(backend)).toBe("done");
  });

  it("maps ready + stale → stalled (a re-index is due)", () => {
    expect(repoDotClass({ ...backend, stale: true })).toBe("stalled");
  });

  it("maps idle/unknown → queued (not yet indexed)", () => {
    expect(repoDotClass({ ...backend, status: "idle" })).toBe("queued");
    expect(repoDotClass({ ...backend, status: "unknown" })).toBe("queued");
  });
});

describe("defaultRepoPath", () => {
  const repos = [backend, frontend, wealth];

  it("keeps the current selection when it still exists in the repo list", () => {
    expect(defaultRepoPath(repos, "/ws/frontend")).toBe("/ws/frontend");
  });

  it("falls back to the first repo when there is no current selection", () => {
    expect(defaultRepoPath(repos, undefined)).toBe("/ws/backend");
  });

  it("falls back to the first repo when the current selection no longer exists", () => {
    expect(defaultRepoPath(repos, "/ws/gone")).toBe("/ws/backend");
  });

  it("returns undefined for an empty repo list", () => {
    expect(defaultRepoPath([], "/ws/backend")).toBeUndefined();
  });
});

describe("GraphRepoTabs", () => {
  it("uses valid tab semantics and calls onSelect on click", () => {
    const onSelect = vi.fn();
    render(
      React.createElement(GraphRepoTabs, {
        repos: [backend, frontend, wealth],
        activePath: "/ws/backend",
        onSelect,
      })
    );

    const backendTab = screen.getByRole("tab", { name: "backend" });
    expect(backendTab.getAttribute("aria-selected")).toBe("true");
    const frontendTab = screen.getByRole("tab", { name: "frontend" });
    expect(frontendTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(frontendTab);
    expect(onSelect).toHaveBeenCalledWith("/ws/frontend");
  });

  it("supports keyboard arrow-key navigation, wrapping at the ends", () => {
    const onSelect = vi.fn();
    render(
      React.createElement(GraphRepoTabs, {
        repos: [backend, frontend, wealth],
        activePath: "/ws/wealth",
        onSelect,
      })
    );

    const wealthTab = screen.getByRole("tab", { name: "wealth" });
    fireEvent.keyDown(wealthTab, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("/ws/backend"); // wraps around

    const backendTab = screen.getByRole("tab", { name: "backend" });
    fireEvent.keyDown(backendTab, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith("/ws/wealth"); // wraps the other way
  });
});
