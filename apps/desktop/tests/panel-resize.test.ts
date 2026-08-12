// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
} from "../src/renderer/lib/panel-resize.js";

// ── Task 3 (resizable panels) — the pure width clamp/persist helpers ────────
// These back the sidebar + context-dock splitters. Kept pure and tested in
// isolation (no component mount needed) per the task's own requirement.

afterEach(() => {
  window.localStorage.clear();
});

describe("clampPanelWidth", () => {
  it("passes a value already inside [min, max] through unchanged", () => {
    expect(clampPanelWidth(300, 200, 420)).toBe(300);
  });

  it("clamps below min up to min", () => {
    expect(clampPanelWidth(50, 200, 420)).toBe(200);
  });

  it("clamps above max down to max", () => {
    expect(clampPanelWidth(9999, 200, 420)).toBe(420);
  });

  it("falls back to min for non-finite input (NaN, Infinity)", () => {
    expect(clampPanelWidth(NaN, 200, 420)).toBe(200);
    expect(clampPanelWidth(Infinity, 200, 420)).toBe(200);
    expect(clampPanelWidth(-Infinity, 200, 420)).toBe(200);
  });

  it("treats min===max as a fixed width", () => {
    expect(clampPanelWidth(300, 260, 260)).toBe(260);
  });
});

describe("loadPanelWidth", () => {
  it("returns the (clamped) fallback when nothing is persisted", () => {
    expect(loadPanelWidth("sidebar", 248, 200, 420)).toBe(248);
  });

  it("returns the (clamped) fallback when the fallback itself is out of range", () => {
    expect(loadPanelWidth("sidebar", 9999, 200, 420)).toBe(420);
  });

  it("reads back a persisted value, clamped to the CURRENT [min, max]", () => {
    window.localStorage.setItem("muon:panel-width:dock", "400");
    expect(loadPanelWidth("dock", 320, 260, 520)).toBe(400);
    // A width persisted under a looser range still clamps against a
    // narrower one passed later (e.g. a shipped min/max tightening).
    expect(loadPanelWidth("dock", 320, 260, 380)).toBe(380);
  });

  it("degrades to the fallback for a corrupt stored value, never throws", () => {
    window.localStorage.setItem("muon:panel-width:sidebar", "not-a-number");
    expect(loadPanelWidth("sidebar", 248, 200, 420)).toBe(248);
  });

  it("keys sidebar and dock widths independently", () => {
    window.localStorage.setItem("muon:panel-width:sidebar", "260");
    window.localStorage.setItem("muon:panel-width:dock", "340");
    expect(loadPanelWidth("sidebar", 248, 200, 420)).toBe(260);
    expect(loadPanelWidth("dock", 320, 260, 520)).toBe(340);
  });
});

describe("savePanelWidth", () => {
  it("persists a rounded width under the panel's own key", () => {
    savePanelWidth("sidebar", 301.6);
    expect(window.localStorage.getItem("muon:panel-width:sidebar")).toBe(
      "302"
    );
  });

  it("round-trips through loadPanelWidth", () => {
    savePanelWidth("dock", 350);
    expect(loadPanelWidth("dock", 320, 260, 520)).toBe(350);
  });

  it("does not throw when localStorage.setItem throws (quota / private mode)", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => savePanelWidth("sidebar", 300)).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
