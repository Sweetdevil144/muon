/**
 * CFG attachment for Wave A (plan cfg-gate): after Phase 1 + D9-ii, the
 * brief-composition control-flow graph must keep stale vouched notes visible
 * and labelled — never silently thinned by markModulesStale.
 */
import { describe, expect, it } from "vitest";
import {
  renderMemorySlice,
  selectMemorySliceNotes,
} from "../src/memory-slice.js";

describe("CFG: D9-ii briefs do not thin on stale", () => {
  it("fresh + stale vouched set: k=fresh-count excludes stale; k+1 includes labelled stale", () => {
    const notes = [
      {
        id: "f1",
        kind: "decision",
        text: "fresh one",
        confirmed: true,
        stale: false,
      },
      {
        id: "f2",
        kind: "decision",
        text: "fresh two",
        confirmed: true,
        stale: false,
      },
      {
        id: "s1",
        kind: "decision",
        text: "stale but relevant",
        confirmed: true,
        stale: true,
      },
    ];
    expect(selectMemorySliceNotes(notes, 2).map((n) => n.id)).toEqual([
      "f1",
      "f2",
    ]);
    const withStale = selectMemorySliceNotes(notes, 3);
    expect(withStale.map((n) => n.id)).toEqual(["f1", "f2", "s1"]);
    const rendered = renderMemorySlice(notes, 3);
    expect(rendered).toContain("[decision|STALE]");
    expect(rendered).toContain("stale but relevant");
    // Dropping would make this assertion fail — the §5.7 briefs-do-not-thin probe.
    expect(rendered).not.toBe(renderMemorySlice(notes.filter((n) => !n.stale), 3));
  });
});
