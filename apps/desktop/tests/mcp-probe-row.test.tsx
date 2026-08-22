// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// The ONE refusal copy (ADR-0052 Decision 5). Imported HERE, in a node-side
// test, precisely because the renderer cannot import it — the assertions below
// compare what the desk shows against what this function returns, so a second
// sentence typed into the row would fail rather than quietly diverge from what
// `muon mcp probe` prints and what a gated tool call tells an agent.
import {
  githubIdentityGateRefusal,
  identityGateRefusalFor,
} from "@muon/client/github-identity-gate";
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

describe("a gate value this build cannot read is not a pass either", () => {
  // The CLI half of this was fixed first: `muon mcp probe` exits non-zero when
  // the server reports a state it does not recognise. The desk dropped the
  // field entirely, so the same server rendered as "ok, N tools" here — the
  // identical lie, one release-skew later.
  it("names the value, and does not wear the ok tone", async () => {
    render(
      panel(async () => ({
        ...report("ok"),
        identityGate: null,
        unknownIdentityGate: "locked-until-review",
      }))
    );
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText("identity unreadable")).toBeTruthy();
    expect(screen.getByText("locked-until-review")).toBeTruthy();
    // The measured level is still reported — that reading is true — but the
    // chip stops wearing its calm tone, exactly as the locked case does.
    const chip = screen.getByText("ok");
    expect(chip.className).toContain("locked");
    expect(chip.className).not.toContain("mcp-probe-chip ok");
  });

  it("does not claim the server is locked, because that is not known", async () => {
    render(
      panel(async () => ({
        ...report("ok"),
        identityGate: null,
        unknownIdentityGate: "something-new",
      }))
    );
    fireEvent.click(screen.getByText("Probe live server"));
    await screen.findByText("identity unreadable");
    expect(screen.queryByText("identity locked")).toBeNull();
    expect(screen.queryByText(/serves the list and refuses the work/)).toBeNull();
    expect(screen.queryByText(/Run `muon login`/)).toBeNull();
  });

  it("stays silent when the server reported a state this build knows", async () => {
    render(panel(async () => report("ok", { identityGate: "open" })));
    fireEvent.click(screen.getByText("Probe live server"));
    await screen.findByText(/Mode/);
    expect(screen.queryByText("identity unreadable")).toBeNull();
  });
});

describe("ADR-0052 — a LOCKED server is never rendered as a pass", () => {
  it("says so, in the ONE shared refusal copy, naming `muon login`", async () => {
    render(panel(async () => report("ok", { identityGate: "locked" })));
    fireEvent.click(screen.getByText("Probe live server"));
    // The desk must say what `muon mcp probe` says. BYTE-FOR-BYTE, located by
    // class rather than by a phrase retyped here: the copy has exactly one
    // author, and an editorial pass to it must not need a test edit — it must
    // reach this surface unchanged or fail.
    const refusal = githubIdentityGateRefusal({
      what: "every MUON tool",
      surface: "mcp",
    });
    expect(
      await screen.findByText(/serves the list and refuses the work/)
    ).toBeTruthy();
    expect(document.querySelector(".mcp-probe-refusal")?.textContent).toBe(
      refusal
    );
    // The one command that opens it, named — the property that makes the
    // refusal actionable rather than a dead end.
    expect(refusal).toContain("muon login");
  });

  it("is VISUALLY distinct from ok — the level chip stops wearing the ok tone", async () => {
    render(panel(async () => report("ok", { identityGate: "locked" })));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText("identity locked")).toBeTruthy();
    // A gated server answers `initialize` and `tools/list` in full, so its
    // verdict genuinely IS `ok`. The word stays (that reading is true); the
    // green does not, or the chip re-tells the "ok, 31 tools" lie.
    const chip = screen.getByText("ok");
    expect(chip.className).toContain("locked");
    expect(chip.className).not.toContain("mcp-probe-chip ok");
  });

  it("an OPEN or UNARMED gate says nothing about a lock", async () => {
    for (const gate of ["open", "unarmed"] as const) {
      const view = render(panel(async () => report("ok", { identityGate: gate })));
      fireEvent.click(screen.getByText("Probe live server"));
      expect(await screen.findByText(/detail/)).toBeTruthy();
      expect(screen.queryByText("identity locked")).toBeNull();
      expect(screen.queryByText(/muon login/)).toBeNull();
      expect(screen.getByText("ok").className).toContain("mcp-probe-chip ok");
      view.unmount();
    }
  });

  it("locked-unregistered is rendered DISTINCTLY, and still not as a pass", async () => {
    // F3 — the two locked states refuse identically and read completely
    // differently. An operator who sees "identity locked" here goes looking for
    // a sign-in they have already done.
    render(panel(async () => report("ok", { identityGate: "locked-unregistered" })));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText("registration pending")).toBeTruthy();
    expect(screen.queryByText("identity locked")).toBeNull();
    expect(
      screen.getByText(/not yet recorded centrally/)
    ).toBeTruthy();
    // Still not a pass: the chip drops the ok tone exactly as `locked` does.
    const chip = screen.getByText("ok");
    expect(chip.className).toContain("locked");
    // And the governed refusal is the DEFERRED one, byte for byte from its one
    // author — never the sign-in remedy.
    const refusal = document.querySelector(".mcp-probe-refusal")?.textContent;
    expect(refusal).toBe(
      identityGateRefusalFor("locked-unregistered", {
        what: "every MUON tool",
        surface: "mcp",
      })
    );
    // Composed for the `mcp` surface (that is what the probe is reporting on),
    // which does not retry — so the copy names `muon login` rather than telling
    // the operator to wait for a loop that only the desktop runs.
    expect(refusal).toContain("NOTHING here retries it");
    expect(refusal).not.toContain("Run `muon login` to open it");
  });

  it("an UNMEASURED gate is silent, not reassuring", async () => {
    // `null` is an old build with no `whoami`, or one that never answered. It
    // is an unknown — the row must neither claim a lock nor claim a sign-in.
    render(panel(async () => report("ok", { identityGate: null })));
    fireEvent.click(screen.getByText("Probe live server"));
    expect(await screen.findByText(/detail/)).toBeTruthy();
    expect(screen.queryByText("identity locked")).toBeNull();
    expect(screen.queryByText(/muon login/)).toBeNull();
  });
});

function report(
  level: McpProbeReport["verdict"]["level"],
  overrides: {
    missing?: string[];
    extra?: string[];
    detail?: string;
    failure?: string;
    identityGate?: McpProbeReport["identityGate"];
  } = {}
): McpProbeReport {
  const identityGate = overrides.identityGate ?? null;
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
    identityGate,
    // Composed the way MAIN composes it (`probeMcpServer`), so these fixtures
    // cannot describe a payload the bridge would never produce.
    identityGateRefusal: identityGate
      ? identityGateRefusalFor(identityGate, {
          what: "every MUON tool",
          surface: "mcp",
        })
      : null,
  };
}
