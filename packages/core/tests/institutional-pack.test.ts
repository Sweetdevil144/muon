import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_SLICE_MAX_NOTES,
  hasOwnershipTag,
  renderInstitutionalPack,
  selectOwnershipNotes,
  withInstitutionalPack,
  type OwnershipNote,
} from "../src/institutional-pack.js";

// ── ADR-0051 §3: the pack is confirmed-only, workspace-fenced, tag-selected ──
//
// These tests carry the ADR's own named obligations at the pure layer:
// an unconfirmed id cannot enter the pack, a foreign-workspace note cannot
// enter the pack, and an empty slice is explicit rather than invented.

function note(over: Partial<OwnershipNote> = {}): OwnershipNote {
  return {
    kind: "decision",
    text: "the payments module is owned by the billing crew",
    confirmed: true,
    stale: false,
    status: "active",
    topics: ["ownership"],
    workspacePath: "/repo",
    ...over,
  } as OwnershipNote;
}

describe("selectOwnershipNotes", () => {
  it("ADR-0091 D3: the ownership KIND qualifies without a tag; unconfirmed ownership notes still cannot enter", () => {
    const { selected } = selectOwnershipNotes(
      [
        note({ kind: "ownership", topics: [], text: "kind-first ownership note" }),
        // The 0051 obligation is kind-independent: unconfirmed never enters.
        note({
          kind: "ownership",
          topics: [],
          confirmed: false,
          text: "unconfirmed ownership-kind note",
        }),
        // The tag path stays readable for the D3 window.
        note({ text: "tagged decision, both-reads window" }),
      ],
      undefined,
      "/repo"
    );
    expect(selected.map((n) => n.text)).toEqual([
      "kind-first ownership note",
      "tagged decision, both-reads window",
    ]);
  });


  it("admits only confirmed, active, non-stale, ownership-tagged notes", () => {
    const { selected } = selectOwnershipNotes(
      [
        note(),
        // Unconfirmed: ADR-0051's first test obligation — the pack contains
        // zero unconfirmed ids, however plausible the note.
        note({ confirmed: false, text: "unconfirmed ownership claim" }),
        note({ stale: true, text: "stale ownership claim" }),
        note({ status: "paused", text: "paused ownership claim" }),
        // Untagged confirmed decision: standing canon's business, not ours.
        note({ topics: ["auth"], text: "untagged decision" }),
        note({ kind: "attempt", text: "attempts never carry ownership" }),
      ],
      undefined,
      "/repo"
    );
    expect(selected.map((n) => n.text)).toEqual([
      "the payments module is owned by the billing crew",
    ]);
  });

  it("drops a note whose own workspace disagrees with the pack's (ADR-0026)", () => {
    const { selected } = selectOwnershipNotes(
      [note({ workspacePath: "/other-repo" }), note()],
      undefined,
      "/repo"
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.workspacePath).toBe("/repo");
  });

  it("tags match case-insensitively across the ownership vocabulary", () => {
    expect(hasOwnershipTag({ topics: ["Ownership"] })).toBe(true);
    expect(hasOwnershipTag({ topics: ["WHY"] })).toBe(true);
    expect(hasOwnershipTag({ topics: ["rationale"] })).toBe(true);
    expect(hasOwnershipTag({ topics: ["owner"] })).toBe(true);
    expect(hasOwnershipTag({ topics: ["auth"] })).toBe(false);
    expect(hasOwnershipTag({ topics: [] })).toBe(false);
    expect(hasOwnershipTag({})).toBe(false);
  });

  it("caps the slice and reports what it left out", () => {
    const many = Array.from({ length: OWNERSHIP_SLICE_MAX_NOTES + 3 }, (_, i) =>
      note({ text: `owner fact ${i}` })
    );
    const { selected, omitted } = selectOwnershipNotes(many, undefined, "/repo");
    expect(selected).toHaveLength(OWNERSHIP_SLICE_MAX_NOTES);
    expect(omitted).toBe(3);
  });
});

describe("renderInstitutionalPack", () => {
  it("says an empty slice is empty rather than inventing or omitting it", () => {
    const section = renderInstitutionalPack({
      ownership: [],
      scope: { workspacePath: "/repo" },
    });
    // A3: absence recorded, not guessed — and the agent is told how to
    // propose what it learns.
    expect(section).toContain("no confirmed ownership or rationale notes");
    expect(section).toContain("memory_add");
  });

  it("names the slice, the notes, and the truncation", () => {
    const many = Array.from({ length: OWNERSHIP_SLICE_MAX_NOTES + 2 }, (_, i) =>
      note({ text: `owner fact ${i}` })
    );
    const section = renderInstitutionalPack({
      ownership: many,
      scope: { workspacePath: "/repo" },
    });
    expect(section).toContain("OWNERSHIP / WHY (human-confirmed):");
    expect(section).toContain("owner fact 0");
    expect(section).toContain("2 more confirmed ownership/why note(s)");
  });

  it("summarizes a fresh graph and points at repo_map instead of dumping it", () => {
    const section = renderInstitutionalPack({
      ownership: [note()],
      graphShape: {
        status: "fresh",
        indexedAt: "2026-08-14T05:30:27.292Z",
        files: 1801,
        nodes: 41434,
        processes: 300,
      },
    });
    expect(section).toContain("fresh index");
    expect(section).toContain("41434 symbols");
    expect(section).toContain("repo_map");
  });

  it("names a stale index and defers to the TOOL GAP block", () => {
    const section = renderInstitutionalPack({
      ownership: [],
      graphShape: { status: "stale" },
    });
    expect(section).toContain("STALE");
    expect(section).toContain("TOOL GAP");
  });
});

describe("withInstitutionalPack", () => {
  it("null pack leaves the brief byte-identical", () => {
    expect(withInstitutionalPack("Do X.", null)).toBe("Do X.");
  });

  it("prepends the pack ahead of the brief", () => {
    const out = withInstitutionalPack("Do X.", {
      ownership: [note()],
      scope: { workspacePath: "/repo" },
    });
    expect(out.endsWith("Do X.")).toBe(true);
    expect(out).toContain("Institutional context for /repo");
    expect(out.indexOf("Institutional context")).toBeLessThan(
      out.indexOf("Do X.")
    );
  });
});
