import { describe, expect, it } from "vitest";
import { githubIdentityGateRefusal } from "@muon/client/github-identity-gate";
import type { McpProbeVerdict } from "@muon/client/mcp-probe";
import {
  parseProbeTimeout,
  probeExitCode,
  renderProbe,
} from "../src/commands/mcp.js";

/**
 * The CLI's own half of `mcp probe`: the spawn and the comparison live in
 * @muon/client (the desk probes with them too), but `--timeout` is this
 * command's flag and its refusal is this command's promise.
 */
describe("--timeout is refused rather than silently defaulted", () => {
  it("takes a whole number of milliseconds", () => {
    expect(parseProbeTimeout(undefined)).toBe(20_000);
    expect(parseProbeTimeout("5000")).toBe(5_000);
  });

  it("refuses anything that would make the measurement unreproducible", () => {
    // Silently falling back to the default would mean the command waited a
    // different length than the operator asked for — and the one number this
    // command produces is a measurement.
    for (const bad of ["", "abc", "-1", "1.5", "500", "1e3s"]) {
      expect(() => parseProbeTimeout(bad), bad).toThrow(/--timeout/);
    }
  });
});

/** A perfect verdict — the case that used to read `OK · 34 tools` about a
 *  server which would refuse every one of them. */
function healthy(): McpProbeVerdict {
  return {
    level: "ok",
    missing: [],
    extra: [],
    liveCount: 34,
    expectedCount: 34,
    detail: "the live surface matches this tree exactly (34 tools)",
  };
}

describe("ADR-0052: the probe says when the target is identity-locked", () => {
  it("names the lock, and names `muon login` as the opener", () => {
    const out = renderProbe(
      "/usr/local/bin/muon-mcp",
      "base",
      healthy(),
      undefined,
      "locked",
      null
    );
    expect(out).toContain("LOCKED");
    expect(out).toContain("muon login");
    // Reused, never retyped: every line of the shared refusal is present, so
    // an edit to the one copy reaches this surface too.
    for (const line of githubIdentityGateRefusal({
      what: "every MUON tool",
      surface: "mcp",
    }).split("\n")) {
      expect(out).toContain(line);
    }
  });

  it("does not wear an OK mark while locked, however clean the tool list is", () => {
    // The whole defect: a perfect inventory beside a server that serves none
    // of it read as a pass.
    expect(
      renderProbe("x", "base", healthy(), undefined, "locked", null)
    ).toMatch(/^!!/);
    expect(renderProbe("x", "base", healthy(), undefined, "open", null)).toMatch(
      /^OK/
    );
  });

  it("exits 1 on a lock, and never on an unknown", () => {
    expect(probeExitCode(healthy(), "locked", undefined, null)).toBe(1);
    expect(probeExitCode(healthy(), "open", undefined, null)).toBe(0);
    expect(probeExitCode(healthy(), "unarmed", undefined, null)).toBe(0);
    // An old build with no `whoami` to ask is not a locked one.
    expect(probeExitCode(healthy(), null, undefined, null)).toBe(0);
  });

  it("exits 1 when the server died mid-probe, however clean the list is", () => {
    // THE REGRESSION THE GATE QUESTION INTRODUCED. The probe keeps talking
    // after `tools/list` now, so a crash can arrive holding a complete,
    // perfectly-matching tool list — which scores `ok`. Before the gate
    // question the same crash was `toolNames: null` → `unevaluated` → exit 1.
    // Found by review, not by this suite; pinned here so it stays fixed.
    expect(
      probeExitCode(
        healthy(),
        null,
        "the server exited (code 7, signal null) before answering whether it is identity-locked",
        null
      )
    ).toBe(1);
  });

  it("says nothing about identity when the gate is open, unarmed, or unknown", () => {
    // Silence is the right answer for three different reasons — nothing is
    // gated, nothing arms, and nothing was measured — and none of them is a
    // line an operator has to read.
    for (const state of ["open", "unarmed", null] as const) {
      const out = renderProbe("x", "base", healthy(), undefined, state, null);
      expect(out, String(state)).not.toContain("LOCKED");
      expect(out, String(state)).not.toContain("muon login");
    }
  });
});

/**
 * THE THIRD GATE OUTCOME: the server answered, in a language this build does not
 * speak.
 *
 * An `identityGate` that was PRESENT but unrecognised arrived as `identityGate:
 * null` — indistinguishable from an older server that has no `whoami` to ask —
 * so `muon mcp probe` printed `ok` and exited 0 against a server that may refuse
 * every tool it just listed. All three cases are pinned here, because the fix is
 * only correct if the ABSENT one still passes.
 */
describe("a gate state this build cannot read is not health", () => {
  it("ABSENT stays exit 0 and stays silent — an older server is not a lock", () => {
    expect(probeExitCode(healthy(), null, undefined, null)).toBe(0);
    const out = renderProbe("x", "base", healthy(), undefined, null, null);
    expect(out).toMatch(/^OK/);
    expect(out).not.toContain("identity");
  });

  it("RECOGNISED-LOCKED exits 1 and names the lock", () => {
    expect(probeExitCode(healthy(), "locked", undefined, null)).toBe(1);
    const out = renderProbe("x", "base", healthy(), undefined, "locked", null);
    expect(out).toMatch(/^!!/);
    expect(out).toContain("identity LOCKED");
  });

  it("PRESENT-BUT-UNKNOWN exits 1, refuses the OK mark, and names the value", () => {
    expect(probeExitCode(healthy(), null, undefined, "quarantined")).toBe(1);
    const out = renderProbe(
      "x",
      "base",
      healthy(),
      undefined,
      null,
      "quarantined"
    );
    expect(out).toMatch(/^!!/);
    // It must not claim ok, must not claim a lock it did not read, and must name
    // the value — the operator's next move is to compare builds.
    expect(out).toContain("UNREADABLE");
    expect(out).toContain("quarantined");
    expect(out).toContain("does not understand");
    expect(out).toContain("muon update");
    // And it must not borrow the LOCKED sentence for a state it cannot read.
    expect(out).not.toContain("identity LOCKED");
  });

  it("an unknown gate outranks a clean verdict on its own", () => {
    // Belt and braces on the exit code: nothing else here is wrong, so this limb
    // is the only thing that can make the number 1.
    expect(probeExitCode(healthy(), null, undefined, "(empty)")).toBe(1);
  });
});
