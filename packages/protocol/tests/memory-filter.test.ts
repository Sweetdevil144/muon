import { describe, expect, it } from "vitest";
import {
  matchesMemoryFilter,
  parseMemoryFilter,
  parseMemoryFilterJson,
  MEMORY_FILTER_MAX_BRANCHES,
  MEMORY_FILTER_MAX_DEPTH,
  MEMORY_FILTER_MAX_JSON_LENGTH,
  MEMORY_FILTER_MAX_LIST_LENGTH,
  MEMORY_FILTER_MAX_PREDICATES,
  MEMORY_FILTER_MAX_VALUE_LENGTH,
  MEMORY_FILTER_OPERATORS,
  type MemoryFilter,
  type MemoryFilterRecord,
} from "../src/memory-filter.js";

/** A representative note record, shaped exactly like the ledger's. */
const note: MemoryFilterRecord = {
  kind: "decision",
  text: "We chose SQLite for the embedded brain",
  trust: "medium",
  status: "active",
  scope: "project",
  createdBy: "agent:codex",
  chatId: "chat-1",
  taskId: "task-1",
  laneId: null,
  confirmed: false,
  stale: false,
  accessCount: 3,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  validFrom: "2026-07-01T00:00:00.000Z",
  validTo: null,
  expiresAt: "2026-08-01T00:00:00.000Z",
  modules: ["backend/src/lib/db.ts", "backend/src/index.ts"],
  topics: ["storage"],
  symbols: [],
};

function parsed(value: unknown): MemoryFilter {
  const result = parseMemoryFilter(value);
  if (!result.ok) {
    throw new Error(`expected a valid filter, got: ${result.reason}`);
  }
  return result.filter;
}

function matches(value: unknown, record: MemoryFilterRecord = note): boolean {
  return matchesMemoryFilter(record, parsed(value));
}

describe("memory filter grammar — operators", () => {
  it("covers every mem0 operator on the field type it is legal for", () => {
    // Guards against an operator being added to the vocabulary but never wired.
    const exercised = new Set<string>();
    const cases: { filter: unknown; expected: boolean }[] = [
      { filter: { field: "kind", op: "eq", value: "decision" }, expected: true },
      { filter: { field: "kind", op: "eq", value: "attempt" }, expected: false },
      { filter: { field: "kind", op: "ne", value: "attempt" }, expected: true },
      {
        filter: { field: "accessCount", op: "gt", value: 2 },
        expected: true,
      },
      {
        filter: { field: "accessCount", op: "gte", value: 3 },
        expected: true,
      },
      { filter: { field: "accessCount", op: "lt", value: 3 }, expected: false },
      { filter: { field: "accessCount", op: "lte", value: 3 }, expected: true },
      {
        filter: { field: "trust", op: "in", value: ["medium", "high"] },
        expected: true,
      },
      {
        filter: { field: "trust", op: "nin", value: ["medium"] },
        expected: false,
      },
      {
        filter: { field: "text", op: "contains", value: "SQLite" },
        expected: true,
      },
      {
        filter: { field: "text", op: "contains", value: "sqlite" },
        expected: false,
      },
      {
        filter: { field: "text", op: "icontains", value: "sqlite" },
        expected: true,
      },
    ];
    for (const testCase of cases) {
      exercised.add((testCase.filter as { op: string }).op);
      expect(matches(testCase.filter)).toBe(testCase.expected);
    }
    expect([...exercised].sort()).toEqual([...MEMORY_FILTER_OPERATORS].sort());
  });

  it("orders dates chronologically, not lexically", () => {
    expect(
      matches({ field: "createdAt", op: "lt", value: "2026-07-02T00:00:00Z" })
    ).toBe(true);
    // A non-canonical but equal instant must compare equal, so a caller cannot
    // get a different answer by choosing a different ISO spelling.
    expect(
      matches({ field: "createdAt", op: "eq", value: "2026-06-30T20:00:00-04:00" })
    ).toBe(true);
  });

  it("evaluates list fields element-wise", () => {
    expect(
      matches({
        field: "modules",
        op: "in",
        value: ["backend/src/index.ts", "other.ts"],
      })
    ).toBe(true);
    expect(
      matches({ field: "modules", op: "contains", value: "lib/db" })
    ).toBe(true);
    expect(
      matches({ field: "modules", op: "icontains", value: "LIB/DB" })
    ).toBe(true);
    // An empty list is an empty list, never a missing value.
    expect(matches({ field: "symbols", op: "nin", value: ["x"] })).toBe(true);
    expect(matches({ field: "symbols", op: "in", value: ["x"] })).toBe(false);
  });

  it("treats a missing scalar as matching only the negative operators", () => {
    expect(matches({ field: "laneId", op: "eq", value: "lane-1" })).toBe(false);
    expect(matches({ field: "laneId", op: "ne", value: "lane-1" })).toBe(true);
    expect(matches({ field: "validTo", op: "lt", value: "2030-01-01T00:00:00Z" })).toBe(
      false
    );
    // A note whose text was withheld (coordinates-only surfaces) can never be
    // matched by a text predicate — this is what makes a gated field inert.
    const gated: MemoryFilterRecord = { ...note, text: undefined };
    expect(matches({ field: "text", op: "contains", value: "SQLite" }, gated)).toBe(
      false
    );
    expect(matches({ field: "text", op: "icontains", value: "sqlite" }, gated)).toBe(
      false
    );
  });

  it("combines with and / or / not", () => {
    expect(
      matches({
        and: [
          { field: "kind", op: "eq", value: "decision" },
          { field: "confirmed", op: "eq", value: false },
        ],
      })
    ).toBe(true);
    expect(
      matches({
        or: [
          { field: "kind", op: "eq", value: "attempt" },
          { field: "trust", op: "eq", value: "medium" },
        ],
      })
    ).toBe(true);
    expect(matches({ not: { field: "kind", op: "eq", value: "decision" } })).toBe(
      false
    );
  });
});

describe("memory filter grammar — bounds", () => {
  it("rejects an unknown field or operator", () => {
    expect(parseMemoryFilter({ field: "textHash", op: "eq", value: "x" })).toEqual({
      ok: false,
      reason: expect.stringContaining("unknown filter field"),
    });
    expect(parseMemoryFilter({ field: "kind", op: "regex", value: "x" })).toEqual({
      ok: false,
      reason: expect.stringContaining("unknown filter operator"),
    });
  });

  it("rejects an operator that is illegal for the field type", () => {
    // Lexicographic ordering over a string field is a footgun, not a feature.
    expect(parseMemoryFilter({ field: "kind", op: "gt", value: "a" }).ok).toBe(false);
    // Substring matching over a timestamp is always a bug.
    expect(
      parseMemoryFilter({ field: "createdAt", op: "contains", value: "2026" }).ok
    ).toBe(false);
    expect(
      parseMemoryFilter({ field: "confirmed", op: "gt", value: true }).ok
    ).toBe(false);
  });

  it("rejects a value of the wrong type or an unparseable date", () => {
    expect(parseMemoryFilter({ field: "kind", op: "eq", value: 5 }).ok).toBe(false);
    expect(
      parseMemoryFilter({ field: "accessCount", op: "eq", value: "3" }).ok
    ).toBe(false);
    expect(
      parseMemoryFilter({ field: "createdAt", op: "gt", value: "not-a-date" }).ok
    ).toBe(false);
    expect(
      parseMemoryFilter({ field: "accessCount", op: "gt", value: Number.NaN }).ok
    ).toBe(false);
  });

  it("caps predicate count GLOBALLY, not per branch", () => {
    const leaf = { field: "kind", op: "eq", value: "decision" };
    const atCap = {
      or: Array.from({ length: MEMORY_FILTER_MAX_PREDICATES }, () => leaf),
    };
    expect(parseMemoryFilter(atCap).ok).toBe(true);
    const overCap = {
      or: [
        { and: Array.from({ length: MEMORY_FILTER_MAX_PREDICATES }, () => leaf) },
        leaf,
      ],
    };
    expect(parseMemoryFilter(overCap)).toEqual({
      ok: false,
      reason: expect.stringContaining("maximum of"),
    });
  });

  it("caps nesting depth and refuses on descent", () => {
    let node: unknown = { field: "kind", op: "eq", value: "decision" };
    for (let i = 1; i < MEMORY_FILTER_MAX_DEPTH; i += 1) {
      node = { not: node };
    }
    expect(parseMemoryFilter(node).ok).toBe(true);
    expect(parseMemoryFilter({ not: node })).toEqual({
      ok: false,
      reason: expect.stringContaining("depth"),
    });
    // A pathologically deep body is refused, not walked to the bottom.
    let deep: unknown = { field: "kind", op: "eq", value: "decision" };
    for (let i = 0; i < 5_000; i += 1) {
      deep = { not: deep };
    }
    expect(parseMemoryFilter(deep).ok).toBe(false);
  });

  it("caps value length, list length, branch count, and JSON size", () => {
    expect(
      parseMemoryFilter({
        field: "text",
        op: "contains",
        value: "a".repeat(MEMORY_FILTER_MAX_VALUE_LENGTH),
      }).ok
    ).toBe(true);
    expect(
      parseMemoryFilter({
        field: "text",
        op: "contains",
        value: "a".repeat(MEMORY_FILTER_MAX_VALUE_LENGTH + 1),
      }).ok
    ).toBe(false);
    expect(
      parseMemoryFilter({
        field: "trust",
        op: "in",
        value: Array.from({ length: MEMORY_FILTER_MAX_LIST_LENGTH + 1 }, () => "low"),
      }).ok
    ).toBe(false);
    expect(
      parseMemoryFilter({
        or: Array.from({ length: MEMORY_FILTER_MAX_BRANCHES + 1 }, () => ({
          field: "kind",
          op: "eq",
          value: "decision",
        })),
      }).ok
    ).toBe(false);
    expect(parseMemoryFilterJson("x".repeat(MEMORY_FILTER_MAX_JSON_LENGTH + 1))).toEqual(
      { ok: false, reason: expect.stringContaining("at most") }
    );
    expect(parseMemoryFilterJson("{not json").ok).toBe(false);
  });

  // F8: the seam. `parseMemoryFilter` (structural bounds) and
  // `parseMemoryFilterJson` (which added the JSON cap) disagreed, so a filter at
  // the grammar's own stated caps passed the pre-validating surface and then
  // died downstream — at ~130 KB on a GET query it does not even reach a
  // validator, it hits Node's 16 KB `maxHeaderSize` and the agent gets an opaque
  // transport error from the very check meant to explain itself.
  it("refuses a structurally-legal filter that could never survive the wire", () => {
    const atStructuralCaps = {
      and: Array.from({ length: MEMORY_FILTER_MAX_PREDICATES }, () => ({
        field: "text",
        op: "in",
        value: Array.from({ length: MEMORY_FILTER_MAX_LIST_LENGTH }, () =>
          "a".repeat(MEMORY_FILTER_MAX_VALUE_LENGTH)
        ),
      })),
    };
    // Every structural bound is respected…
    expect(
      JSON.stringify(atStructuralCaps).length
    ).toBeGreaterThan(MEMORY_FILTER_MAX_JSON_LENGTH);
    // …and it is refused anyway, with a reason that names the actual size.
    const refused = parseMemoryFilter(atStructuralCaps);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toMatch(
      new RegExp(`at most ${MEMORY_FILTER_MAX_JSON_LENGTH} characters of JSON`)
    );
    expect(refused.ok ? "" : refused.reason).toMatch(/serializes to \d+/);
  });

  it("still accepts a filter that fits the wire, so the cap is a bound and not a ban", () => {
    expect(
      parseMemoryFilter({
        and: [
          { field: "kind", op: "in", value: ["decision", "constraint"] },
          {
            field: "text",
            op: "icontains",
            value: "a".repeat(MEMORY_FILTER_MAX_VALUE_LENGTH),
          },
        ],
      }).ok
    ).toBe(true);
  });

  it("rejects structurally invalid nodes rather than ignoring them", () => {
    // Silently dropping an unrecognized key would let a caller widen a result
    // set by sending garbage, which is exactly the probe we must not allow.
    expect(parseMemoryFilter({ field: "kind", op: "eq", value: "x", or: [] }).ok).toBe(
      false
    );
    expect(parseMemoryFilter({ and: [] }).ok).toBe(false);
    expect(parseMemoryFilter({ or: "everything" }).ok).toBe(false);
    expect(parseMemoryFilter("kind = decision").ok).toBe(false);
    expect(parseMemoryFilter(null).ok).toBe(false);
    expect(parseMemoryFilter([{ field: "kind", op: "eq", value: "x" }]).ok).toBe(false);
  });
});

describe("memory filter grammar — hostile values", () => {
  it("treats SQL, Cypher, and regex payloads as literal text", () => {
    const payloads = [
      "' OR 1=1 --",
      "'; DROP TABLE MemoryNote; --",
      "\") RETURN n MATCH (m:MemoryNote) RETURN m //",
      "%' UNION SELECT text FROM MemoryNote WHERE '%",
      ".*",
      "(a+)+$",
      "${process.env.MUON_OPERATOR_TOKEN}",
      "__proto__",
    ];
    for (const payload of payloads) {
      // Each parses as an ordinary string value...
      const filter = parsed({ field: "text", op: "contains", value: payload });
      // ...and matches NOTHING, because comparison is String.includes over an
      // already-materialized value: no query is built, no regex is compiled.
      expect(matchesMemoryFilter(note, filter)).toBe(false);
      // The same payload matches only a note whose text literally contains it.
      expect(
        matchesMemoryFilter({ ...note, text: `prefix ${payload} suffix` }, filter)
      ).toBe(true);
    }
  });

  it("cannot reach a field outside the allowlist, however it is spelled", () => {
    for (const field of [
      "textHash",
      "episodeId",
      "supersededBy",
      "__proto__",
      "constructor",
      "toString",
      "modules.0",
      "TEXT",
    ]) {
      expect(parseMemoryFilter({ field, op: "eq", value: "x" }).ok).toBe(false);
    }
  });

  it("never throws while evaluating a hostile record shape", () => {
    const hostile = {
      text: 42,
      modules: "not-an-array",
      accessCount: "seven",
      createdAt: {},
      confirmed: "yes",
    } as unknown as MemoryFilterRecord;
    for (const filter of [
      { field: "text", op: "contains", value: "x" },
      { field: "modules", op: "in", value: ["x"] },
      { field: "accessCount", op: "gt", value: 1 },
      { field: "createdAt", op: "lt", value: "2026-01-01T00:00:00Z" },
      { field: "confirmed", op: "eq", value: true },
    ]) {
      expect(() => matchesMemoryFilter(hostile, parsed(filter))).not.toThrow();
    }
  });
});
