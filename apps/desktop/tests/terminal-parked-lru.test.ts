import { describe, expect, it } from "vitest";
import {
  computeParkedTerminalIds,
  reconcileTerminalMruOrder,
  touchTerminalMruOrder,
} from "../src/renderer/lib/terminal-parked-lru.js";

/**
 * ROADMAP T4 — the PARKED-RUNTIME LRU's eviction POLICY (which mounted
 * terminal panes should currently hold a live XTerm instance). Pure
 * bookkeeping math, exercised without React or app.tsx's actual state.
 */
describe("touchTerminalMruOrder", () => {
  it("moves an existing id to the front, keeping the rest in order", () => {
    expect(touchTerminalMruOrder(["a", "b", "c"], "b")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("prepends a new id not already in the order", () => {
    expect(touchTerminalMruOrder(["a", "b"], "z")).toEqual(["z", "a", "b"]);
  });

  it("is a no-op shape-wise for an id already at the front", () => {
    expect(touchTerminalMruOrder(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});

describe("reconcileTerminalMruOrder", () => {
  it("drops ids that are no longer mounted", () => {
    expect(reconcileTerminalMruOrder(["a", "b", "c"], ["a", "c"])).toEqual([
      "a",
      "c",
    ]);
  });

  it("appends newly-mounted ids to the LEAST-recently-used end", () => {
    expect(reconcileTerminalMruOrder(["a", "b"], ["a", "b", "new"])).toEqual([
      "a",
      "b",
      "new",
    ]);
  });

  it("preserves relative MRU order of survivors", () => {
    expect(
      reconcileTerminalMruOrder(["c", "a", "b"], ["a", "b", "c", "d"])
    ).toEqual(["c", "a", "b", "d"]);
  });
});

describe("computeParkedTerminalIds", () => {
  it("parks everything past the capacity", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect(computeParkedTerminalIds(order, null, 3)).toEqual(
      new Set(["d", "e"])
    );
  });

  it("parks nothing when mounted count is within the cap", () => {
    expect(computeParkedTerminalIds(["a", "b"], null, 6)).toEqual(new Set());
  });

  it("NEVER parks the active id, even if it fell outside the MRU window", () => {
    // A pane that is on screen right now must never be released — this is
    // the fail-safe on top of the caller always re-touching the active id
    // into MRU position before computing.
    const order = ["a", "b", "c", "active"];
    expect(computeParkedTerminalIds(order, "active", 2)).toEqual(
      new Set(["c"])
    );
  });

  it("treats a zero capacity as parking everything but the active pane", () => {
    expect(computeParkedTerminalIds(["a", "b"], "a", 0)).toEqual(
      new Set(["b"])
    );
  });
});
