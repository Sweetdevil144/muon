import { describe, expect, it } from "vitest";
import {
  byAttention,
  fit,
  headline,
  layoutSections,
  railOwnsCursor,
  statusGlyph,
  type RowStatus,
} from "../src/next/sections.js";

// ADR-0042 D3/D7. The old screen stacked five regions at equal weight and let
// each print everything it held, so a 12-agent fleet pushed the work list off
// the bottom and load-bearing sentences truncated mid-word.

const row = (id: string) => ({ id });

describe("sections share height instead of starving each other", () => {
  it("gives a small section room even beside a huge one", () => {
    // The failure this prevents: 12 agents consuming the whole rail and the
    // inbox — the one thing that needs a person — getting zero lines.
    const [crew, inbox] = layoutSections(
      [
        { id: "crew", title: "crew", rows: Array.from({ length: 12 }, (_, i) => row(`a${i}`)) },
        { id: "inbox", title: "inbox", rows: [row("i1"), row("i2")] },
      ],
      10
    );
    expect(crew!.rows.length).toBeGreaterThan(0);
    expect(inbox!.rows.length).toBe(2);
  });

  it("REPORTS what did not fit rather than hiding it", () => {
    const [crew] = layoutSections(
      [{ id: "crew", title: "crew", rows: Array.from({ length: 20 }, (_, i) => row(`a${i}`)) }],
      8
    );
    expect(crew!.hidden).toBe(20 - crew!.rows.length);
    expect(crew!.hidden).toBeGreaterThan(0);
  });

  it("drops empty sections entirely — no headers over nothing", () => {
    const laid = layoutSections(
      [
        { id: "crew", title: "crew", rows: [row("a")] },
        { id: "empty", title: "empty", rows: [] },
      ],
      10
    );
    expect(laid.map((section) => section.id)).toEqual(["crew"]);
  });

  it("never returns more rows than it was given", () => {
    const [only] = layoutSections(
      [{ id: "crew", title: "crew", rows: [row("a"), row("b")] }],
      100
    );
    expect(only!.rows.length).toBe(2);
    expect(only!.hidden).toBe(0);
  });

  it("survives a height too small for even the titles", () => {
    const laid = layoutSections(
      [{ id: "crew", title: "crew", rows: [row("a")] }],
      0
    );
    expect(laid[0]!.rows.length).toBe(0);
    expect(laid[0]!.hidden).toBe(1);
  });
});

describe("labels fit the column budget", () => {
  it("truncates with an ellipsis that replaces, never overflows", () => {
    expect(fit("claude-code-1", 8)).toBe("claude-…");
    expect(fit("claude-code-1", 8).length).toBe(8);
  });

  it("leaves a label that already fits alone", () => {
    expect(fit("codex-1", 20)).toBe("codex-1");
  });

  it("degrades safely at tiny widths", () => {
    expect(fit("anything", 1)).toBe("…");
    expect(fit("anything", 0)).toBe("");
  });
});

describe("attention ordering", () => {
  const statusOf = (r: { s: RowStatus }) => r.s;

  it("puts what needs a person first", () => {
    const sorted = byAttention(
      [{ s: "idle" as RowStatus }, { s: "blocked" as RowStatus }, { s: "working" as RowStatus }],
      statusOf
    );
    expect(sorted.map((r) => r.s)).toEqual(["blocked", "working", "idle"]);
  });

  it("is STABLE, so the rail does not reshuffle on every poll", () => {
    // A list that moves under the cursor every 2s is one nobody can use.
    const rows = Array.from({ length: 6 }, (_, i) => ({ s: "idle" as RowStatus, i }));
    expect(byAttention(rows, statusOf).map((r) => r.i)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("gives each state its own glyph — twelve identical circles say nothing", () => {
    const glyphs = (["blocked", "failed", "working", "done", "idle", "unknown"] as RowStatus[]).map(
      statusGlyph
    );
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("the header replaces a five-line block with one line", () => {
  it("names only what is true", () => {
    expect(headline({ running: 2, blocked: 1, failed: 0, needsYou: 0 })).toBe(
      "2 running · 1 blocked"
    );
  });

  it("says idle rather than printing zeros", () => {
    expect(headline({ running: 0, blocked: 0, failed: 0, needsYou: 0 })).toBe("idle");
  });
});

describe("railOwnsCursor — only one cursor is ever live", () => {
  it("the rail owns the cursor only at the cockpit", () => {
    // Founder-reported: with the palette open, an arrow key stepped BOTH the
    // palette row and the crew rail row, because both cursors derive from the
    // same `selected` state. Two glowing rows leave it ambiguous what Enter
    // acts on.
    const cockpit = {
      paletteOpen: false,
      formOpen: false,
      reviewOpen: false,
      memoryOpen: false,
    };
    expect(railOwnsCursor(cockpit)).toBe(true);
    for (const scope of [
      "paletteOpen",
      "formOpen",
      "reviewOpen",
      "memoryOpen",
    ] as const) {
      expect(
        railOwnsCursor({ ...cockpit, [scope]: true }),
        `${scope} must take the cursor off the rail`
      ).toBe(false);
    }
  });
});
