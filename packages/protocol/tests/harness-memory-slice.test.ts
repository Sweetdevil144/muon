import { describe, expect, it } from "vitest";
import {
  matchesMemoryFilter,
  memorySliceFilter,
  memorySliceSpecSchema,
  parseMemoryFilter,
} from "../src/index.js";

// ── TODO 0.4: `memorySlice.topics` / `.modules` stop being a no-op ───────────
//
// The defect: a harness author could write `topics: ["auth"]` and the runner
// read only `.k` — a silent no-op authority field. The fix compiles the spec
// into the ONE bounded filter grammar (R5). These tests pin the compilation,
// its bounds, and the narrower property.

describe("memorySliceFilter — spec → the one bounded grammar", () => {
  it("the default (empty) spec compiles to undefined — byte-identical reads", () => {
    const spec = memorySliceSpecSchema.parse({});
    expect(spec).toEqual({ topics: [], modules: [], k: 5 });
    expect(memorySliceFilter(spec)).toBeUndefined();
  });

  it("topics-only compiles to a single stringList `in` condition", () => {
    const spec = memorySliceSpecSchema.parse({ topics: ["auth", "memory"] });
    expect(memorySliceFilter(spec)).toEqual({
      field: "topics",
      op: "in",
      value: ["auth", "memory"],
    });
  });

  it("modules-only compiles to a single stringList `in` condition", () => {
    const spec = memorySliceSpecSchema.parse({ modules: ["src/index.ts"] });
    expect(memorySliceFilter(spec)).toEqual({
      field: "modules",
      op: "in",
      value: ["src/index.ts"],
    });
  });

  it("both lists compile to a UNION (or), never an intersection", () => {
    const spec = memorySliceSpecSchema.parse({
      topics: ["auth"],
      modules: ["src/db.ts"],
    });
    expect(memorySliceFilter(spec)).toEqual({
      or: [
        { field: "topics", op: "in", value: ["auth"] },
        { field: "modules", op: "in", value: ["src/db.ts"] },
      ],
    });
  });

  it("every compiled filter validates under the shared grammar — no second dialect", () => {
    for (const raw of [
      { topics: ["auth"] },
      { modules: ["src/index.ts"] },
      { topics: ["a", "b"], modules: ["c/d.ts", "e/f.ts"] },
    ]) {
      const filter = memorySliceFilter(memorySliceSpecSchema.parse(raw));
      expect(filter).toBeDefined();
      const parsed = parseMemoryFilter(filter);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    }
  });

  it("narrows exactly as a harness author expects: any listed coordinate keeps the note", () => {
    const filter = memorySliceFilter(
      memorySliceSpecSchema.parse({
        topics: ["auth"],
        modules: ["src/db.ts"],
      })
    )!;
    const byTopic = { topics: ["auth", "extra"], modules: [] };
    const byModule = { topics: [], modules: ["src/db.ts"] };
    const neither = { topics: ["ranking"], modules: ["src/other.ts"] };
    const bare = {}; // a note with no coordinate arrays at all
    expect(matchesMemoryFilter(byTopic, filter)).toBe(true);
    expect(matchesMemoryFilter(byModule, filter)).toBe(true);
    expect(matchesMemoryFilter(neither, filter)).toBe(false);
    expect(matchesMemoryFilter(bare, filter)).toBe(false);
  });

  it("exact element match, not substring: `auth` never matches `author`", () => {
    const filter = memorySliceFilter(
      memorySliceSpecSchema.parse({ topics: ["auth"] })
    )!;
    expect(matchesMemoryFilter({ topics: ["author"] }, filter)).toBe(false);
  });
});

describe("memorySliceSpecSchema — bounds mirror the grammar, refused at config time", () => {
  it("refuses more than 32 coordinates per list (the grammar's `in` cap)", () => {
    const topics = Array.from({ length: 33 }, (_, index) => `topic-${index}`);
    expect(memorySliceSpecSchema.safeParse({ topics }).success).toBe(false);
    expect(
      memorySliceSpecSchema.safeParse({ topics: topics.slice(0, 32) }).success
    ).toBe(true);
  });

  it("refuses an empty-string or over-length coordinate", () => {
    expect(memorySliceSpecSchema.safeParse({ modules: [""] }).success).toBe(
      false
    );
    expect(
      memorySliceSpecSchema.safeParse({ modules: ["x".repeat(257)] }).success
    ).toBe(false);
    expect(
      memorySliceSpecSchema.safeParse({ modules: ["x".repeat(256)] }).success
    ).toBe(true);
  });
});
