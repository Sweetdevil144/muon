import { describe, expect, it } from "vitest";
import {
  CHILD_BRIEF_HEADINGS,
  CREW_TASK_HEADINGS,
  briefHeadingList,
  briefHeadingMandate,
  childBriefSkeleton,
  declaredHeadings,
  headingValue,
  missingBriefHeadings,
  missingTaskHeadings,
  taskHeadingList,
} from "../src/brief-contract.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../src/system-prompt.js";

/**
 * THE DRIFT-LOCK.
 *
 * MUON has now failed a live mission three times for the same reason: the
 * system prompt told the coordinator one brief shape and the dispatch-contract
 * verifier demanded another. The third instance cost two correct, already-
 * running child dispatches — the verifier wanted DELIVERABLES and CHECKS, the
 * prompt buried them inside a 200-word parenthetical, and MUON then spent turns
 * explaining why it would not duplicate live workers to satisfy a counter.
 *
 * These tests make the fourth instance a red suite instead of a red mission.
 * They read the RENDERED prompt (not the constant it is built from), so
 * re-inlining the list as literal text — exactly how it drifted before — fails
 * here rather than in production.
 */

/**
 * The headings the RENDERED system prompt mandates, parsed back out of it.
 * Deliberately reads the shipped string: a future edit that hand-writes the
 * list instead of rendering it is caught here.
 */
function headingsMandatedByPrompt(): string[] {
  const mandate = briefHeadingMandate();
  const marker = mandate.slice(0, mandate.indexOf(briefHeadingList()));
  const at = ORCHESTRATOR_SYSTEM_PROMPT.indexOf(marker);
  if (at < 0) {
    throw new Error(
      "The system prompt no longer states the brief-heading mandate; the coordinator is being told a different contract than MUON verifies."
    );
  }
  const tail = ORCHESTRATOR_SYSTEM_PROMPT.slice(at + marker.length);
  return tail
    .slice(0, tail.indexOf(". "))
    .split(/:\s*/)
    .map((heading) => heading.trim())
    .filter(Boolean);
}

describe("brief-heading drift-lock (prompt ⟷ verifier)", () => {
  it("the prompt mandates EXACTLY the headings the verifier counts, in order", () => {
    expect(headingsMandatedByPrompt()).toEqual([...CHILD_BRIEF_HEADINGS]);
  });

  it("the verifier requires EXACTLY those headings — no more, no fewer", () => {
    // `missingBriefHeadings` is the function `childBriefDeficiency` calls, so
    // this is the counter itself, exhaustively: the full skeleton is clean, and
    // dropping any ONE heading is reported by name.
    expect(missingBriefHeadings(childBriefSkeleton())).toEqual([]);
    for (const omitted of CHILD_BRIEF_HEADINGS) {
      const partial = childBriefSkeleton()
        .split("\n")
        .filter((line) => !line.startsWith(`${omitted}:`))
        .join("\n");
      expect(missingBriefHeadings(partial), omitted).toEqual([omitted]);
    }
  });

  it("the skeleton MUON quotes as the remedy is one MUON accepts", () => {
    // A failure message that names the missing headings still costs a round
    // trip if the example it hands out would itself be rejected.
    expect(missingBriefHeadings(childBriefSkeleton())).toEqual([]);
    expect(headingValue(childBriefSkeleton(), "ROLE")).toBeTruthy();
    expect(headingValue(childBriefSkeleton(), "OWNED SCOPE")).toBeTruthy();
  });

  it("the filed-task mandate is one list too, and is a subset of the brief's", () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain(taskHeadingList());
    for (const heading of CREW_TASK_HEADINGS) {
      expect(CHILD_BRIEF_HEADINGS).toContain(heading);
    }
    expect(missingTaskHeadings(childBriefSkeleton())).toEqual([]);
    expect(missingTaskHeadings("prose with no headings at all")).toEqual([
      ...CREW_TASK_HEADINGS,
    ]);
  });

  it("the prompt still says what the two verified headings must equal", () => {
    // ROLE / OWNED SCOPE are the only two the verifier compares against the
    // filed ledger task, so the prompt has to keep saying "verbatim".
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /ROLE and OWNED SCOPE repeat the filed task's declarations verbatim/
    );
  });
});

describe("heading parsing tolerates how briefs are actually written", () => {
  it("counts a BLOCK heading whose content is on the lines beneath it", () => {
    // The shape that convicted the founder's two live dispatches: DELIVERABLES
    // and CHECKS are lists, so a competent engineer writes the heading and then
    // the list. A check that only read the rest of the same line saw nothing.
    const brief =
      "DELIVERABLES:\n" +
      "- the migration\n" +
      "- its rollback\n" +
      "CHECKS:\n" +
      "  npm test -- packages/core\n";
    expect(headingValue(brief, "DELIVERABLES")).toContain("the migration");
    expect(headingValue(brief, "CHECKS")).toContain("npm test");
  });

  it("does not read a LIST ITEM as a heading (which would empty the block above it)", () => {
    const brief = "DELIVERABLES:\n- tests: packages/core/tests/x.test.ts\n";
    expect(headingValue(brief, "DELIVERABLES")).toContain("packages/core");
    expect(declaredHeadings(brief)).toEqual(["DELIVERABLES"]);
  });

  it("tolerates markdown emphasis and ATX headings without eating a glob", () => {
    const brief =
      "**ROLE:** implementer\n" +
      "**OWNED SCOPE**: packages/core/**\n" +
      "## DELIVERABLES\n" +
      "the change\n";
    expect(headingValue(brief, "ROLE")).toBe("implementer");
    // `**` in a scope declaration is a GLOB, and must survive verbatim — the
    // verifier compares these paths against the filed task's.
    expect(headingValue(brief, "OWNED SCOPE")).toBe("packages/core/**");
    expect(headingValue(brief, "DELIVERABLES")).toBe("the change");
  });

  it("F5: a colon-bearing SENTENCE inside a block does not truncate that block", () => {
    // CONTEXT is exactly where the prompt tells the coordinator to quote memory
    // and graph evidence, so URLs and "Note:"/"Decision:"/"docs/adr/0022:" prose
    // are the norm there — and every one of them used to parse as a new heading,
    // leaving the heading above it empty and therefore "missing".
    const cases: Array<[string, string, string]> = [
      [
        "a URL",
        "CONTEXT:\nThe prior decision is documented at https://internal/doc",
        "CONTEXT",
      ],
      ["a Note: sentence", "DELIVERABLES:\nNote: the patch and tests", "DELIVERABLES"],
      ["an ADR reference", "CONTEXT:\ndocs/adr/0022: the vendor ledger", "CONTEXT"],
    ];
    for (const [label, brief, heading] of cases) {
      expect(headingValue(brief, heading), label).toBeTruthy();
      expect(missingBriefHeadings(brief), label).not.toContain(heading);
    }
  });

  it("F5: a REAL next heading still ends the block", () => {
    const brief = "CONTEXT:\nsee https://x/y\nDELIVERABLES:\n- the patch";
    expect(headingValue(brief, "CONTEXT")).toBe("see https://x/y");
    expect(headingValue(brief, "DELIVERABLES")).toBe("- the patch");
  });

  it("F5: a DECORATED line still ends the block, even if it is not a known heading", () => {
    const brief = "CONTEXT:\nsee https://x/y\n## APPENDIX\nnotes";
    expect(headingValue(brief, "CONTEXT")).toBe("see https://x/y");
  });

  it("an EMPTY heading is a missing heading", () => {
    expect(missingBriefHeadings("ROLE:\nOWNED SCOPE:\n")).toContain("ROLE");
  });

  it("reads the first declaration when a brief outlines then repeats a heading", () => {
    expect(headingValue("ROLE: implementer\nROLE: reviewer", "ROLE")).toBe(
      "implementer"
    );
  });
});

describe("memory authority wording covers a vouch without weakening 'confirmed'", () => {
  it("admits operator-confirmed OR orchestrator-vouched memory as authoritative", () => {
    // Brief slices now legitimately carry notes the orchestrator vouched for,
    // so a prompt that said only "confirmed" told the coordinator to distrust
    // context MUON had already decided to hand it.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /operator CONFIRMED or you yourself VOUCHED for/
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /confirmed or you vouched for may become authoritative context/
    );
  });

  it("keeps a vouch strictly below a human confirmation", () => {
    // The whole point of the human tier survives: a vouch is an attestation,
    // never a confirmation, and never redeems a gate.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /never upgrades a note to operator-confirmed; only the human confirms/
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /not a human confirmation and never substitutes for one at a gate/
    );
    // And a PEER still cannot manufacture either one.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /a peer can never confirm or vouch for anything itself/
    );
  });
});

describe("GRAPH DISCIPLINE is mandated, with the tool names (prompt hardening)", () => {
  it("makes the graph the FIRST action in every brief, before any file read", () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/GRAPH DISCIPLINE is a MANDATE/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /FIRST context action is code_query/
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /before reading, grepping, or opening any file/
    );
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /Before editing ANY symbol: code_impact/
    );
  });

  it("names the concrete MUON graph tools rather than gesturing at 'the graph'", () => {
    for (const tool of [
      "repo_map",
      "code_query",
      "code_context",
      "code_impact",
      "preflight_edit",
      "data_boundaries",
      "review_diff",
    ]) {
      expect(ORCHESTRATOR_SYSTEM_PROMPT, tool).toContain(tool);
    }
  });

  it("binds the coordinator itself to graph-first, not only its workers", () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/GRAPH FIRST, ALWAYS/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /names a symbol you never confirmed in the graph is a guess/
    );
  });

  it("requires the FINAL REPORT to state which graph queries were run", () => {
    expect(CHILD_BRIEF_HEADINGS).toContain("FINAL REPORT");
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(
      /FINAL REPORT must LIST the graph queries the worker actually ran/
    );
    expect(childBriefSkeleton()).toContain("graph queries run");
  });
});
