import { describe, expect, it } from "vitest";
import {
  citationProvenanceLabel,
  citationProvenanceLine,
} from "../src/citation-view.js";

/**
 * ADR-0086 D2/D4 — the ONE statement of citation provenance.
 *
 * These pin the exact sentences (they are the ADR's own words — a surface
 * must not paraphrase them) and the fail-quiet rule: no verdict means NO
 * claim, never an accusation, and a flagged citation always yields a line.
 */
describe("citationProvenanceLabel", () => {
  const citations = [
    { noteId: "mem-offered", offered: true },
    { noteId: "mem-relay", offered: false },
  ];

  it("speaks the ADR's two sentences, verbatim", () => {
    expect(citationProvenanceLabel("mem-offered", citations)).toBe(
      "cited, offered to this job"
    );
    expect(citationProvenanceLabel("mem-relay", citations)).toBe(
      "cited, never offered — relay"
    );
  });

  it("no verdict is NO claim — an unreadable ledger must not accuse", () => {
    expect(citationProvenanceLabel("mem-offered", undefined)).toBeNull();
    expect(citationProvenanceLabel("mem-unaudited", citations)).toBeNull();
    expect(citationProvenanceLabel("mem-offered", [])).toBeNull();
  });
});

describe("citationProvenanceLine", () => {
  it("flagged never DROPS: every cited id yields a line, labelled or plain", () => {
    const citations = [{ noteId: "mem-relay", offered: false }];
    expect(citationProvenanceLine("mem-relay…", "mem-relay", citations)).toBe(
      "mem-relay… — cited, never offered — relay"
    );
    expect(
      citationProvenanceLine("mem-quiet…", "mem-quiet", undefined)
    ).toBe("mem-quiet… — cited");
  });
});
