import { describe, expect, it } from "vitest";
import {
  isUsableTerminalSize,
  spawnWithMeasuredSize,
} from "../src/renderer/lib/terminal-geometry.js";
import { boundTerminalGeometry } from "../src/lib/terminal-host.js";

// U1/U3 — the two halves of "a pty is born at the size it will be read at",
// each tested where it lives: the renderer decides whether it has an honest
// measurement, and the host decides whether to believe the numbers it is sent.
// Neither trusts the other, on purpose.

const SPAWN = { file: "codex", cwd: "/ws" };

describe("the renderer only reports a grid it actually measured", () => {
  it("carries a real measurement onto the spawn", () => {
    expect(
      spawnWithMeasuredSize(SPAWN, { size: () => ({ cols: 214, rows: 57 }) })
    ).toEqual({ file: "codex", cwd: "/ws", cols: 214, rows: 57 });
  });

  it("returns the ORIGINAL spawn when the pane has no box (mounted hidden)", () => {
    const view = { size: () => null };
    // Identity, not just equality: an unmeasured pane must produce a
    // byte-identical open to the one this app already sent.
    expect(spawnWithMeasuredSize(SPAWN, view)).toBe(SPAWN);
  });

  it("returns the ORIGINAL spawn for a view that cannot measure at all", () => {
    expect(spawnWithMeasuredSize(SPAWN, {})).toBe(SPAWN);
  });

  it.each([
    [{ cols: 0, rows: 40 }],
    [{ cols: 80, rows: 0 }],
    [{ cols: 80.5, rows: 24 }],
    [{ cols: Number.NaN, rows: 24 }],
    [{ cols: 80, rows: 99_999 }],
  ])("refuses %o as a measurement", (size) => {
    expect(isUsableTerminalSize(size)).toBe(false);
    expect(spawnWithMeasuredSize(SPAWN, { size: () => size })).toBe(SPAWN);
  });
});

describe("the host bounds whatever geometry the renderer sends", () => {
  it("accepts a plausible pane grid", () => {
    expect(boundTerminalGeometry({ cols: 214, rows: 57 })).toEqual({
      cols: 214,
      rows: 57,
    });
  });

  it.each([
    ["nothing at all", {}],
    ["a zero", { cols: 0, rows: 24 }],
    ["a negative", { cols: 80, rows: -1 }],
    ["a fraction", { cols: 80.25, rows: 24 }],
    ["NaN", { cols: Number.NaN, rows: 24 }],
    ["past the ceiling", { cols: 4000, rows: 24 }],
    ["a string", { cols: "200", rows: 24 }],
    ["a width with no height", { cols: 200 }],
    ["a height with no width", { rows: 50 }],
    ["nulls", { cols: null, rows: null }],
  ])("drops %s and states no geometry", (_label, input) => {
    expect(boundTerminalGeometry(input as { cols?: unknown; rows?: unknown })).toEqual(
      {}
    );
  });

  it("takes both or neither — half a geometry is not a geometry", () => {
    // Pairing a measured width with a defaulted height is a shape no pane has,
    // and it is the one that would silently letterbox a vendor TUI.
    expect(boundTerminalGeometry({ cols: 200, rows: 0 })).toEqual({});
  });
});
