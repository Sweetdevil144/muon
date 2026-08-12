import { describe, expect, it } from "vitest";
import { reverseClosure, reverseSymbolClosure } from "../src/closure.js";
import type { ReverseImportIndex } from "../src/indexer.js";

// The transitive impact CLOSURE: BFS over the reverse adjacency, depth-bounded,
// cycle-safe, capped by depth-ordered truncation. Synthetic indexes (no fs).

function makeIndex(reverse: Record<string, string[]>): ReverseImportIndex {
  const rev = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(reverse)) {
    rev.set(k, new Set(v));
  }
  return {
    root: "/repo",
    reverse: rev,
    forward: new Map(),
    symbolReverse: new Map(),
    symbolLayerAvailable: true,
    files: [],
    fileCount: 0,
    builtAt: Date.now(),
  };
}

/** A synthetic symbol-reverse adjacency (callee id → caller ids). */
function makeSymbolReverse(
  adj: Record<string, string[]>
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(adj)) {
    m.set(k, new Set(v));
  }
  return m;
}

describe("reverseClosure", () => {
  it("collects transitive importers with ascending depth (a ← b ← c)", () => {
    // b imports a; c imports b. Editing a → {b (d1), c (d2)}.
    const index = makeIndex({ a: ["b"], b: ["c"] });
    const result = reverseClosure(index, ["a"], { maxDepth: 3, maxModules: 128 });
    expect(result.files).toEqual(["b", "c"]);
    expect(result.depth).toBe(2);
  });

  it("returns empty for a file nobody imports (a leaf)", () => {
    const index = makeIndex({ a: ["b"] });
    const result = reverseClosure(index, ["b"], { maxDepth: 3, maxModules: 128 });
    expect(result.files).toEqual([]);
    expect(result.depth).toBe(0);
  });

  it("is CYCLE-SAFE (a ↔ b), terminates and excludes the target", () => {
    const index = makeIndex({ a: ["b"], b: ["a"] });
    const result = reverseClosure(index, ["a"], { maxDepth: 3, maxModules: 128 });
    expect(result.files).toEqual(["b"]);
  });

  it("enforces the DEPTH bound (D=3): d4 importers are not reached", () => {
    const index = makeIndex({
      a: ["b"],
      b: ["c"],
      c: ["d"],
      d: ["e"], // e is at depth 4 from a
    });
    const result = reverseClosure(index, ["a"], { maxDepth: 3, maxModules: 128 });
    expect(result.files).toEqual(["b", "c", "d"]);
    expect(result.files).not.toContain("e");
    expect(result.depth).toBe(3);
  });

  it("CAPS at maxModules, truncating the FARTHEST neighbours first", () => {
    // a has 5 direct importers (depth 1); each of those has one depth-2 importer.
    const index = makeIndex({
      a: ["b1", "b2", "b3"],
      b1: ["c1"],
      b2: ["c2"],
      b3: ["c3"],
    });
    const result = reverseClosure(index, ["a"], { maxDepth: 3, maxModules: 3 });
    // BFS visits all depth-1 first → the cap keeps the 3 closest, drops c*.
    expect(result.files).toEqual(["b1", "b2", "b3"]);
    expect(result.files.length).toBe(3);
  });

  it("unions importers across multiple target files, excluding all targets", () => {
    const index = makeIndex({ a: ["x"], b: ["y"] });
    const result = reverseClosure(index, ["a", "b"], {
      maxDepth: 3,
      maxModules: 128,
    });
    expect(new Set(result.files)).toEqual(new Set(["x", "y"]));
  });
});

describe("reverseSymbolClosure (ADR-0015), mirrors reverseClosure over symbols", () => {
  it("collects transitive REFERENCING symbols in ascending depth", () => {
    // b#bar references m#foo; c#baz references b#bar. Editing m#foo → {bar(d1),baz(d2)}.
    const adj = makeSymbolReverse({ "m#foo": ["b#bar"], "b#bar": ["c#baz"] });
    const r = reverseSymbolClosure(adj, ["m#foo"], { maxDepth: 3, maxSymbols: 256 });
    expect(r.symbols).toEqual(["b#bar", "c#baz"]);
    expect(r.depth).toBe(2);
  });

  it("returns empty for a symbol nobody references", () => {
    const adj = makeSymbolReverse({ "m#foo": ["b#bar"] });
    const r = reverseSymbolClosure(adj, ["b#bar"], { maxDepth: 3, maxSymbols: 256 });
    expect(r.symbols).toEqual([]);
    expect(r.depth).toBe(0);
  });

  it("is CYCLE-SAFE and EXCLUDES the target(s)", () => {
    const adj = makeSymbolReverse({ "m#foo": ["b#bar"], "b#bar": ["m#foo"] });
    const r = reverseSymbolClosure(adj, ["m#foo"], { maxDepth: 3, maxSymbols: 256 });
    expect(r.symbols).toEqual(["b#bar"]);
  });

  it("enforces the DEPTH bound", () => {
    const adj = makeSymbolReverse({
      "m#foo": ["a#s1"],
      "a#s1": ["b#s2"],
      "b#s2": ["c#s3"],
      "c#s3": ["d#s4"],
    });
    const r = reverseSymbolClosure(adj, ["m#foo"], { maxDepth: 3, maxSymbols: 256 });
    expect(r.symbols).toEqual(["a#s1", "b#s2", "c#s3"]);
    expect(r.symbols).not.toContain("d#s4");
  });

  it("CAPS at maxSymbols, truncating the FARTHEST referencers first", () => {
    const adj = makeSymbolReverse({
      "m#foo": ["a#1", "a#2", "a#3"],
      "a#1": ["b#1"],
    });
    const r = reverseSymbolClosure(adj, ["m#foo"], { maxDepth: 3, maxSymbols: 3 });
    expect(r.symbols).toEqual(["a#1", "a#2", "a#3"]);
    expect(r.symbols).not.toContain("b#1");
  });
});
