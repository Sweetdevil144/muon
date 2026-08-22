import { describe, expect, it } from "vitest";
import {
  childBriefSkeleton,
  headingValue,
  missingBriefHeadings,
  missingTaskHeadings,
} from "../src/brief-contract.js";

/**
 * A BRIEF MUST NOT ORDER A WORKER TO DO SOMETHING THE INSTALL CANNOT DO.
 *
 * The canonical GRAPH DISCIPLINE line names `code_query`, `code_context`,
 * `code_impact` and `preflight_edit` and then says STOP on unavailable evidence.
 * On the install the release tarball produces — `muon-mcp` bundled WITHOUT the
 * `gitnexus` CLI — all four are registered and all four refuse, so that line is
 * a contract every worker fails by obeying: reach for the tools, receive the
 * "unavailable" it was guaranteed, stop. Permanently, on every dispatch.
 *
 * Which pathway this governs was investigated rather than assumed: a dispatched
 * worker's code tools come from a `muon-mcp` the runner injects as a stdio MCP
 * server, so they resolve through that process's BUNDLED-CLI resolver — not
 * through a brain-side GitNexus gateway. So the honest signal is the same
 * bundled resolution the coordinator's own `muon-mcp` performed, and the MCP
 * surfaces pass it in.
 *
 * Nothing here weakens a gate. `preflight_edit` still composes `code_impact` and
 * fails closed, `review_diff` still goes review-blind, `ship` still refuses
 * without review evidence. This is the brief-side echo of those gates, and an
 * echo of a gate that cannot run has to say so.
 */

const graphDiscipline = (text: string): string =>
  headingValue(text, "GRAPH DISCIPLINE") ?? "";

describe("childBriefSkeleton: the code-graph state it was rendered for", () => {
  it("defaults to the canonical mandate, byte-identical to an explicit available", () => {
    // The default must not change for any existing caller — the orchestrator
    // prompt and both MCP tool descriptions render this and the drift locks
    // parse it back out.
    expect(childBriefSkeleton()).toBe(
      childBriefSkeleton({ codeGraph: "available" })
    );
    expect(graphDiscipline(childBriefSkeleton())).toContain(
      "code_query the flows"
    );
    expect(graphDiscipline(childBriefSkeleton())).toContain(
      "STOP on HIGH/CRITICAL, stale, or unavailable evidence"
    );
  });

  it("still satisfies its own verifier in BOTH states", () => {
    // The skeleton is the remedy MUON quotes at a coordinator whose brief was
    // refused. A degraded remedy that fails the same verifier would send the
    // coordinator round the loop it was quoted to break.
    for (const codeGraph of ["available", "unavailable"] as const) {
      const skeleton = childBriefSkeleton({ codeGraph });
      expect(missingBriefHeadings(skeleton), codeGraph).toEqual([]);
      expect(missingTaskHeadings(skeleton), codeGraph).toEqual([]);
      expect(headingValue(skeleton, "GRAPH DISCIPLINE"), codeGraph).toBeTruthy();
    }
  });

  it("names a TOOL GAP instead of ordering the worker into refusals", () => {
    const degraded = graphDiscipline(
      childBriefSkeleton({ codeGraph: "unavailable" })
    );
    // A10's vocabulary, on purpose: the runner already raises a `TOOL GAP` block
    // for a stale index, and a worker that has learned to read those blocks
    // should recognise this one.
    expect(degraded.startsWith("TOOL GAP")).toBe(true);
    expect(degraded).toContain("REFUSE");
    // The impossible order is gone: no "run these first", no STOP keyed on the
    // unavailability the worker is guaranteed to hit.
    expect(degraded).not.toContain("code_query the flows");
    expect(degraded).not.toContain("before any edit");
    expect(degraded).not.toMatch(/STOP on[^.]*unavailable/);
    // What replaces it: the substitution ban, the work that IS possible, and
    // the reporting duty — the same three moves `toolGapBlock` makes.
    expect(degraded).toMatch(/do NOT report a text search as if it were a graph query/i);
    expect(degraded).toMatch(/read and grep the files/i);
    expect(degraded).toMatch(/rests? on file reads alone/i);
    // The judgment gate is NOT relaxed by the degrade.
    expect(degraded).toContain("HIGH/CRITICAL");
    // UNKNOWN risk, never an implicit clear — the property the fail-closed
    // gates enforce, restated for a worker that cannot reach them.
    expect(degraded).toMatch(/UNKNOWN risk/);
    // And it tells the worker who to escalate to rather than to keep retrying.
    expect(degraded).toMatch(/tell the human/i);
  });

  it("keeps the degraded value on ONE line, so heading parsing is unchanged", () => {
    // A newline inside a value can introduce a section boundary and empty the
    // block above it — the exact false-conviction shape `headingValues` exists
    // to prevent. Asserted rather than trusted.
    const skeleton = childBriefSkeleton({ codeGraph: "unavailable" });
    const lines = skeleton.split("\n");
    expect(lines).toHaveLength(childBriefSkeleton().split("\n").length);
    expect(
      lines.filter((line) => line.startsWith("GRAPH DISCIPLINE: "))
    ).toHaveLength(1);
  });
});
