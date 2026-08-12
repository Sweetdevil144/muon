// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { McpProbeRow } from "../src/renderer/mcp-probe-row.js";
import type { McpProbeReport } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * Parity item 5. The point of the probe is that the line above it — "a session
 * gets N tools" — is computed from constants compiled into this build. On
 * 2026-08-10 it would have said 44 while the server a vendor actually spawned
 * served 27, and three shipped tools were callable by nobody.
 *
 * So every property here is about the probe REPORTING, never reassuring.
 */
function panel(
  probe?: (input?: { mode?: string }) => Promise<McpProbeReport>,
  configuredModes?: string[]
) {
  return <McpProbeRow probe={probe} configuredModes={configuredModes} />;
}

describe("the live MCP probe on the desk", () => {
  it("does not probe until an operator asks — it spawns a real server", () => {
    const probe = vi.fn(async () => report("ok"));
    render(panel(probe));
    expect(probe).not.toHaveBeenCalled();
    expect(
      screen.getByText(/comes from this build, not from the server/)
    ).toBeTruthy();
  });

  it("names the MISSING tools, not just a count", async () => {
    render(
      panel(async () =>
        report("stale", {
          missing: ["publish_finding", "question_ask", "question_status"],
        })
      )
    );
    fireEvent.click(screen.getByText("Probe live server"));
    // A count says "three fewer"; the operator needs to know WHICH, because
    // that is what tells them whether the tool they rely on exists.
    expect(await screen.findByText(/publish_finding/)).toBeTruthy();
    expect(screen.getByText("stale")).toBeTruthy();
  });

  it("an unprobeable server is UNEVALUATED, never a pass", async () => {
    render(
      panel(async () =>
        report("unevaluated", {
          detail: "the server could not be probed — this is not a pass",
          failure: "no MCP command resolved on this machine",
        })
      )
    );
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText(/not a pass/)).toBeTruthy();
    expect(screen.getByText(/no MCP command resolved/)).toBeTruthy();
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("a rejected bridge call becomes a sentence, not a stuck button", async () => {
    render(
      panel(async () => {
        throw new Error("probe crashed");
      })
    );
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText("probe crashed")).toBeTruthy();
    expect(screen.getByText("Probe live server")).toBeTruthy();
  });

  it("renders no probe control at all on a caller that cannot probe", () => {
    render(panel(undefined));
    expect(screen.queryByText("Probe live server")).toBeNull();
  });
});

describe("the mode is part of the measurement", () => {
  it("defaults to the mode the installed vendors DECLARE", async () => {
    const probe = vi.fn(async () => report("ok"));
    render(panel(probe, ["observer"]));
    fireEvent.click(screen.getByText("Probe live server"));
    // Probing `base` here would have measured a server this machine never
    // launches, and reported it clean.
    expect(probe).toHaveBeenCalledWith({ mode: "observer" });
  });

  it("falls back to base when vendors disagree, rather than picking one", async () => {
    const probe = vi.fn(async () => report("ok"));
    render(panel(probe, ["observer", "orchestrator"]));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(probe).toHaveBeenCalledWith({ mode: "base" });
  });

  it("names the mode it measured, in the verdict", async () => {
    render(panel(async () => ({ ...report("ok"), mode: "delegate" })));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText("delegate")).toBeTruthy();
  });

  it("drops a verdict when the mode changes — it was about the old one", async () => {
    render(panel(async () => report("stale", { missing: ["publish_finding"] })));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText(/publish_finding/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Server mode to probe"), {
      target: { value: "orchestrator" },
    });
    expect(screen.queryByText(/publish_finding/)).toBeNull();
    expect(screen.queryByText("stale")).toBeNull();
  });
});

function report(
  level: McpProbeReport["verdict"]["level"],
  overrides: {
    missing?: string[];
    extra?: string[];
    detail?: string;
    failure?: string;
  } = {}
): McpProbeReport {
  return {
    command: "/usr/local/bin/muon-mcp",
    mode: "base",
    verdict: {
      level,
      missing: overrides.missing ?? [],
      extra: overrides.extra ?? [],
      liveCount: 27,
      expectedCount: 30,
      detail: overrides.detail ?? "detail",
    },
    failure: overrides.failure ?? null,
  };
}
