import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { VendorReadiness } from "@muon/client";
import { OnboardingPanel } from "../src/components/OnboardingPanel.js";

function frameOf(
  readiness: VendorReadiness[] | null,
  hasCompletedTask = false
): string {
  const { lastFrame } = render(
    React.createElement(OnboardingPanel, {
      readiness,
      hasCompletedTask,
      width: 76,
    })
  );
  return lastFrame() ?? "";
}

const ready: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  detail: "logged in as dev@example.com",
};

const installedNotAuth: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into Codex first: `codex login`",
};

const notInstalled: VendorReadiness = {
  vendor: "cursor",
  installed: false,
  authenticated: false,
  detail: "Cursor CLI not found",
  fixHint: "install the Cursor agent CLI, then `cursor-agent login`",
};

const cursorReady: VendorReadiness = {
  vendor: "cursor",
  installed: true,
  authenticated: true,
  detail: "logged in as dev@example.com",
};

describe("TUI OnboardingPanel", () => {
  it("does not present a connected role-scoped lane as dispatch-ready", () => {
    // Same truth as the desktop wizard and `muon onboard`: connected, but
    // managed for a subset of the crew roles, so it cannot unlock a first task.
    const frame = frameOf([cursorReady]);
    expect(frame).toContain("Cursor");
    expect(frame).toContain("role-scoped");
    expect(frame).toContain("reviewer, qa, architect, scout");
    expect(frame).not.toContain("Run first task");
  });

  it("connect state: renders each vendor's fix hint and the get-started header", () => {
    const frame = frameOf([notInstalled, installedNotAuth]);
    expect(frame).toContain("GET STARTED");
    expect(frame).toContain("Codex");
    expect(frame).toContain("codex login");
    expect(frame).toContain("cursor-agent login");
  });

  it("ready state: shows the vendor as ready and the dispatch path", () => {
    const frame = frameOf([ready, installedNotAuth]);
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("ready");
    expect(frame).toContain("Run first task");
    expect(frame).toContain("completed task");
    expect(frame).toContain("captured memory");
  });

  it("degraded (null): shows manual steps, never a false ready", () => {
    const frame = frameOf(null);
    expect(frame).toContain("check agent readiness");
    expect(frame).toMatch(/codex login|cursor-agent login|Claude/);
  });

  it("always shows the never-stores-token trust line, never a token", () => {
    for (const input of [[ready], [installedNotAuth], null] as const) {
      const frame = frameOf(input);
      expect(frame).toContain("never stores, logs, or displays vendor");
      expect(frame).not.toMatch(/sk-|bearer|secret/i);
    }
  });
});
