import { describe, expect, it } from "vitest";
import {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
} from "@muon/protocol";
import {
  compareLiveTools,
  expectedToolNamesForMode,
  probeVerdictIsProblem,
} from "../src/mcp-probe.js";

/**
 * The bug this scores for, stated once:
 *
 * On 2026-08-10 the attached MUON server served 27 tools — every context tool,
 * six of nine coordination tools. `publish_finding` had landed that morning;
 * `question_ask` and `question_status` days earlier with ADR-0043. All three
 * were in the inventory, handler-tested, and green. All three were callable by
 * nobody, because the vendor's symlink pointed at a `dist/` built on 7 August.
 *
 * `muon mcp status` said 44 the whole time, because it counted the inventory
 * compiled into the CLI rather than asking the process. Everything below is
 * about not repeating that: a number that describes the code is not evidence
 * about the server.
 */

const BASE = [...MUON_CONTEXT_TOOL_NAMES, ...MUON_COORDINATION_TOOL_NAMES];

describe("the live surface is scored against this tree", () => {
  it("an exact match is ok", () => {
    const verdict = compareLiveTools(BASE, "base");
    expect(verdict.level).toBe("ok");
    expect(verdict.missing).toEqual([]);
    expect(verdict.extra).toEqual([]);
    expect(probeVerdictIsProblem(verdict)).toBe(false);
  });

  it("order is not part of the match — tools/list may return any order", () => {
    // Canonical ORDER is pinned at the source by the inventory test in
    // @muon/protocol. Re-asserting it here would fail a server that is
    // perfectly current, which is a false alarm, and false alarms are how a
    // real one gets ignored.
    expect(compareLiveTools([...BASE].reverse(), "base").level).toBe("ok");
  });

  it("reproduces the 2026-08-10 surface: three tools shipped, none reachable", () => {
    const stale = BASE.filter(
      (name) =>
        name !== "publish_finding" &&
        name !== "question_ask" &&
        name !== "question_status"
    );
    expect(stale).toHaveLength(27);

    const verdict = compareLiveTools(stale, "base");
    expect(verdict.level).toBe("stale");
    expect(verdict.missing).toEqual([
      "publish_finding",
      "question_ask",
      "question_status",
    ]);
    expect(verdict.liveCount).toBe(27);
    expect(verdict.expectedCount).toBe(30);
    // The operator has to be told what to DO, not merely that something is off.
    expect(verdict.detail).toMatch(/npm run build/);
    expect(verdict.detail).toMatch(/publish_finding/);
  });

  it("a server built from another tree is 'ahead', not 'stale'", () => {
    // Different fix entirely: a rebuild here changes nothing, because the
    // binary on PATH does not come from this checkout.
    const verdict = compareLiveTools([...BASE, "some_future_tool"], "base");
    expect(verdict.level).toBe("ahead");
    expect(verdict.extra).toEqual(["some_future_tool"]);
    expect(verdict.missing).toEqual([]);
  });

  it("disagreement in both directions is 'diverged'", () => {
    const live = [...BASE.filter((n) => n !== "publish_finding"), "ghost_tool"];
    const verdict = compareLiveTools(live, "base");
    expect(verdict.level).toBe("diverged");
    expect(verdict.missing).toEqual(["publish_finding"]);
    expect(verdict.extra).toEqual(["ghost_tool"]);
  });

  it("counts alone cannot pass a server that serves the WRONG tools", () => {
    // Same count, different set. A count comparison — the shape `mcp status`
    // already had — calls this a match.
    const swapped = [
      ...BASE.filter((n) => n !== "publish_finding"),
      "impostor_tool",
    ];
    expect(swapped).toHaveLength(BASE.length);
    expect(compareLiveTools(swapped, "base").level).toBe("diverged");
  });
});

describe("silence is never a pass", () => {
  it("a probe that could not reach the server is unevaluated, not ok", () => {
    const verdict = compareLiveTools(null, "base");
    expect(verdict.level).toBe("unevaluated");
    expect(verdict.liveCount).toBeNull();
    expect(verdict.detail).toMatch(/not a pass/i);
    expect(probeVerdictIsProblem(verdict)).toBe(true);
  });

  it("an EMPTY tool list is a real measurement, and a damning one", () => {
    // Distinct from the above: the server answered, and answered with nothing.
    // That is not "unevaluated" — it is the worst possible surface.
    const verdict = compareLiveTools([], "base");
    expect(verdict.level).toBe("stale");
    expect(verdict.liveCount).toBe(0);
    expect(verdict.missing).toHaveLength(BASE.length);
  });

  it("…except in attached-coordinator, the one mode entitled to serve nothing", () => {
    // A lapsed seat completes the handshake and holds no tools ON PURPOSE
    // (ADR-0049), and this probe supplies no capability file — so zero here
    // measures nothing about the build. Scored as a set difference it told the
    // operator their tree was BEHIND and to rebuild it, on a healthy tree, and
    // by DEFAULT on exactly the machines that hold a coordinator seat.
    const verdict = compareLiveTools([], "attached-coordinator");
    expect(verdict.level).toBe("unevaluated");
    expect(verdict.missing, "no tool is claimed missing").toHaveLength(0);
    expect(verdict.detail).toMatch(/not a stale build/);
    expect(verdict.detail).toMatch(/muon mcp attach/);
  });

  it("a PARTIAL attached-coordinator surface is still scored, not excused", () => {
    // The excuse is for ZERO, which is the shape of "no seat". A server that
    // holds some tools has a surface, and a missing one there is real.
    const verdict = compareLiveTools(["whoami"], "attached-coordinator");
    expect(verdict.level).toBe("stale");
    expect(verdict.missing.length).toBeGreaterThan(0);
  });

  it("an unknown mode is unevaluated rather than scored against base", () => {
    // Guessing the inventory for a mode we cannot name would turn "we did not
    // check" into a green tick — the exact substitution this file exists to
    // stop (ADR-0022 rule 2: positive lists, no defaulting).
    const verdict = compareLiveTools(BASE, "some-new-mode");
    expect(verdict.level).toBe("unevaluated");
    expect(verdict.expectedCount).toBeNull();
    expect(verdict.detail).toMatch(/nothing was checked/);
  });
});

describe("each mode is scored against its OWN inventory", () => {
  it("an absent mode means the sub-agent seat, which is what most servers are", () => {
    expect(expectedToolNamesForMode(undefined)).toEqual(BASE);
    expect(expectedToolNamesForMode(null)).toEqual(BASE);
    expect(expectedToolNamesForMode("")).toEqual(BASE);
    expect(expectedToolNamesForMode("  ")).toEqual(BASE);
  });

  it("observer is scored as observer — not as a deficient base", () => {
    // An observer server serves FEWER tools by design. Scoring it against base
    // would report a healthy server as stale every single time.
    expect(compareLiveTools(MUON_OBSERVER_TOOL_NAMES, "observer").level).toBe(
      "ok"
    );
    expect(compareLiveTools(MUON_OBSERVER_TOOL_NAMES, "base").level).not.toBe(
      "ok"
    );
  });

  it("every declared mode resolves to a non-empty inventory", () => {
    for (const mode of [
      "base",
      "observer",
      "orchestrator",
      "delegate",
      "attached-coordinator",
    ]) {
      const names = expectedToolNamesForMode(mode);
      expect(names, mode).not.toBeNull();
      expect(names!.length, mode).toBeGreaterThan(0);
    }
  });
});
