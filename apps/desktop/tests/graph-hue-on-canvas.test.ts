/**
 * Graph hues encode MEANING, so they are pushed, never replaced.
 *
 * The node and edge palettes came over verbatim from GitNexus OSS and are tuned
 * for its near-black canvas. Re-hueing them for the light desk would fork a
 * palette that is meant to stay in step with OSS, and would break the one thing
 * the palette is for: the same kind is the same colour everywhere. But several
 * are invisible on white — the `#9ca3af` node fallback sits at 2.2:1 — and a
 * WebGL canvas is unreachable from the stylesheet, so CSS could not fix it.
 *
 * `hueOnCanvas` therefore keeps the hue and moves it away from the canvas only
 * until it clears WCAG 1.4.11's 3:1 floor for graphical objects. The dark desk
 * must come back byte-identical; the light desk must become legible.
 */
import { describe, expect, it } from "vitest";
import {
  GRAPHIC_CONTRAST_FLOOR,
  contrastRatio,
  hueOnCanvas,
} from "../src/renderer/desk-tokens.js";
import { edgeColor, nodeColor } from "../src/renderer/lib/graph-adapter.js";

const DARK = "#141414";
const LIGHT = "#FFFFFF";

// The kinds the palette actually distinguishes, plus the two fallbacks.
const NODE_KINDS = [
  "Project", "Package", "Module", "Folder", "File", "Class", "Interface",
  "Enum", "Method", "Function", "Macro", "Variable", "SomethingUnmapped",
];
const EDGE_KINDS = ["CALLS", "FETCHES", "ENTRY_POINT_OF", "WRAPS", "QUERIES", "UNMAPPED"];

describe("the dark desk keeps the OSS palette untouched", () => {
  it("returns every node hue unchanged on the dark canvas", () => {
    for (const kind of NODE_KINDS) {
      const hue = nodeColor(kind);
      expect(hueOnCanvas(hue, DARK), kind).toBe(hue);
    }
  });

  it("returns every edge hue unchanged on the dark canvas", () => {
    for (const kind of EDGE_KINDS) {
      const hue = edgeColor(kind);
      // An edge hue may be adjusted if it genuinely fails on near-black; assert
      // the RULE (unchanged iff already legible), not a blanket "never moves".
      const moved = hueOnCanvas(hue, DARK) !== hue;
      expect(moved, `${kind} moved despite ${contrastRatio(hue, DARK).toFixed(2)}:1`).toBe(
        contrastRatio(hue, DARK) < GRAPHIC_CONTRAST_FLOOR
      );
    }
  });
});

describe("the light desk becomes legible without losing the hue", () => {
  it("every node kind clears the graphical-object floor on white", () => {
    for (const kind of NODE_KINDS) {
      const got = hueOnCanvas(nodeColor(kind), LIGHT);
      expect(
        contrastRatio(got, LIGHT),
        `${kind}: ${nodeColor(kind)} -> ${got}`
      ).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST_FLOOR - 0.01);
    }
  });

  it("every edge kind clears the floor on white", () => {
    for (const kind of EDGE_KINDS) {
      const got = hueOnCanvas(edgeColor(kind), LIGHT);
      expect(contrastRatio(got, LIGHT), kind).toBeGreaterThanOrEqual(
        GRAPHIC_CONTRAST_FLOOR - 0.01
      );
    }
  });

  it("fixes the specific fallback that was disappearing", () => {
    // grey-400 on white: 2.2:1, a pale dot on a pale ground.
    expect(contrastRatio("#9ca3af", LIGHT)).toBeLessThan(GRAPHIC_CONTRAST_FLOOR);
    expect(contrastRatio(hueOnCanvas("#9ca3af", LIGHT), LIGHT)).toBeGreaterThanOrEqual(
      GRAPHIC_CONTRAST_FLOOR - 0.01
    );
  });

  it("keeps kinds distinguishable from each other after adjustment", () => {
    // Pushing everything toward black would satisfy contrast and destroy the
    // encoding. Distinct kinds must stay distinct colours.
    const adjusted = NODE_KINDS.map((k) => hueOnCanvas(nodeColor(k), LIGHT));
    const distinctBefore = new Set(NODE_KINDS.map((k) => nodeColor(k))).size;
    expect(new Set(adjusted).size).toBe(distinctBefore);
  });
});

describe("it never mangles a value it does not understand", () => {
  it("passes through non-hex colours untouched", () => {
    for (const v of ["currentColor", "var(--accent)", "rgb(1,2,3)", ""]) {
      expect(hueOnCanvas(v, LIGHT)).toBe(v);
    }
  });
});
