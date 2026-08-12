// ── Bounded memory filter grammar (R5, mem0 §6 parity) ──────────────────────
//
// mem0 exposes `eq ne gt gte lt lte in nin contains icontains` plus AND/OR/NOT
// over its memory reads. Ours was fixed-shape, so this module is the ONE typed,
// bounded grammar every MUON surface shares: the backend routes, the MCP tools,
// the client, and the CLI all import THIS validator and THIS evaluator. A second
// copy anywhere would be a second set of bounds, and a bounded surface with two
// definitions is a bounded surface with a hole (see the bounded-surface
// completeness lesson).
//
// Two properties are load-bearing and must survive every future edit:
//
//  1. NO QUERY LANGUAGE IS EVER BUILT FROM THESE VALUES. `matchesMemoryFilter`
//     compares already-materialized JS values with JS operators, and `contains`/
//     `icontains` use `String.includes`, never a RegExp. There is no SQL string,
//     no Cypher string, and no regex compiled from caller input, so there is
//     nothing to escape and nothing to inject into. Callers that want a
//     relational pre-filter must express it in their own parameterized builder.
//
//  2. THE FILTER IS A NARROWER, NEVER A SELECTOR. Callers apply it to a set the
//     caller was ALREADY authorized to receive (post-gate, post-partition). A
//     predicate can therefore only remove rows from a visible set; it can never
//     pull a row into one, and it can never distinguish a row that the caller
//     could not otherwise read. That is what keeps the grammar from becoming a
//     governance side channel: the answer to "did a hidden note match?" is
//     structurally unavailable because the hidden note is never evaluated.
//
// Everything here is PURE: no I/O, no clock, no ambient state.

/** Every leaf comparison operator, mem0's exact set. */
export const MEMORY_FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "contains",
  "icontains",
] as const;

export type MemoryFilterOperator = (typeof MEMORY_FILTER_OPERATORS)[number];

/**
 * The ALLOWLISTED field set with each field's type. A field absent from this
 * table is rejected outright — the grammar can never reach a column that was not
 * deliberately published here, so adding a sensitive field to `MemoryNote` never
 * silently becomes filterable.
 *
 * `text` is present ON PURPOSE and is safe for the same reason the whole grammar
 * is: a caller only ever evaluates predicates against the text it was already
 * handed. On surfaces where note text is gated (coordinates-only for an
 * unconfirmed note), the record the evaluator sees carries no text, so a
 * `text contains` predicate simply cannot match — it reveals nothing.
 */
export const MEMORY_FILTER_FIELDS = {
  kind: "string",
  trust: "string",
  status: "string",
  scope: "string",
  createdBy: "string",
  chatId: "string",
  taskId: "string",
  laneId: "string",
  text: "string",
  confirmed: "boolean",
  stale: "boolean",
  accessCount: "number",
  createdAt: "date",
  updatedAt: "date",
  validFrom: "date",
  validTo: "date",
  /** R3 TTL: the policy expiry stamped on a low-trust agent note at ingest. */
  expiresAt: "date",
  /** Substrate §3.4: structured result on `attempt` notes (`worked` | …). */
  outcome: "string",
  /** TODO 4.8 / D7: provenance tier (`authored` | `inferred`; NULL reads as authored). */
  derivation: "string",
  /** TODO 4.8: operator review stamp (`pending` | `reviewed` | `deferred`). */
  reviewStatus: "string",
  modules: "stringList",
  topics: "stringList",
  symbols: "stringList",
} as const;

export type MemoryFilterField = keyof typeof MEMORY_FILTER_FIELDS;
export type MemoryFilterFieldType =
  (typeof MEMORY_FILTER_FIELDS)[MemoryFilterField];

/**
 * Which operators are legal for which field type. Deliberately narrow:
 *  - strings get equality/membership/substring but NOT ordering (lexicographic
 *    `gt` on a kind or a principal id is a footgun, not a feature);
 *  - dates and numbers get ordering but NOT substring (a substring match over a
 *    timestamp is a bug looking for a place to happen);
 *  - booleans get equality only;
 *  - list fields get membership + substring over their ELEMENTS, never ordering.
 */
const OPERATORS_BY_TYPE: Record<
  MemoryFilterFieldType,
  readonly MemoryFilterOperator[]
> = {
  string: ["eq", "ne", "in", "nin", "contains", "icontains"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"],
  boolean: ["eq", "ne"],
  date: ["eq", "ne", "gt", "gte", "lt", "lte"],
  stringList: ["in", "nin", "contains", "icontains"],
};

/** Operators whose `value` is a LIST; every other operator takes a scalar. */
const LIST_VALUE_OPERATORS: readonly MemoryFilterOperator[] = ["in", "nin"];

// ── Bounds ──────────────────────────────────────────────────────────────────
//
// An agent reaches this grammar, so the bounds are hard caps enforced during
// validation, never advisory. Depth is checked ON DESCENT (before recursing), so
// a hostile deeply-nested body is refused at depth 5 rather than after the
// parser has already walked it.

/** Maximum number of LEAF comparisons in one filter. */
export const MEMORY_FILTER_MAX_PREDICATES = 16;
/** Maximum nesting depth; the root node is depth 1. */
export const MEMORY_FILTER_MAX_DEPTH = 4;
/** Maximum characters in any single string value (scalar or list element). */
export const MEMORY_FILTER_MAX_VALUE_LENGTH = 256;
/** Maximum elements in an `in` / `nin` list. */
export const MEMORY_FILTER_MAX_LIST_LENGTH = 32;
/** Maximum branches under one `and` / `or`. */
export const MEMORY_FILTER_MAX_BRANCHES = 16;
/** Maximum serialized size of a filter on the wire. Enforced on the RAW string
 *  before `JSON.parse` (`parseMemoryFilterJson`) AND on the canonical
 *  serialization of an already-decoded filter (`parseMemoryFilter`), so a
 *  structurally-legal filter that could never survive the GET-query transport is
 *  refused by every surface with the same reason. */
export const MEMORY_FILTER_MAX_JSON_LENGTH = 4_096;

export type MemoryFilterScalar = string | number | boolean;

export type MemoryFilterCondition = {
  field: MemoryFilterField;
  op: MemoryFilterOperator;
  value: MemoryFilterScalar | MemoryFilterScalar[];
};

export type MemoryFilter =
  | MemoryFilterCondition
  | { and: MemoryFilter[] }
  | { or: MemoryFilter[] }
  | { not: MemoryFilter };

export type MemoryFilterParse =
  | { ok: true; filter: MemoryFilter }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** Counter threaded through validation so the predicate cap is GLOBAL to the
 *  filter, not per-branch (16 branches of 16 predicates is not 16 predicates). */
type Budget = { predicates: number };

function validateNode(
  node: unknown,
  depth: number,
  budget: Budget
): MemoryFilterParse {
  if (depth > MEMORY_FILTER_MAX_DEPTH) {
    return {
      ok: false,
      reason: `filter nesting exceeds the maximum depth of ${MEMORY_FILTER_MAX_DEPTH}`,
    };
  }
  if (!isPlainObject(node)) {
    return { ok: false, reason: "each filter node must be an object" };
  }
  const keys = Object.keys(node);

  // ── Boolean combinators ───────────────────────────────────────────────────
  if (keys.length === 1 && (keys[0] === "and" || keys[0] === "or")) {
    const key = keys[0] as "and" | "or";
    const branches = node[key];
    if (!Array.isArray(branches) || branches.length === 0) {
      return { ok: false, reason: `"${key}" requires a non-empty array` };
    }
    if (branches.length > MEMORY_FILTER_MAX_BRANCHES) {
      return {
        ok: false,
        reason: `"${key}" accepts at most ${MEMORY_FILTER_MAX_BRANCHES} branches`,
      };
    }
    const parsed: MemoryFilter[] = [];
    for (const branch of branches) {
      const result = validateNode(branch, depth + 1, budget);
      if (!result.ok) {
        return result;
      }
      parsed.push(result.filter);
    }
    return { ok: true, filter: { [key]: parsed } as MemoryFilter };
  }
  if (keys.length === 1 && keys[0] === "not") {
    const result = validateNode(node.not, depth + 1, budget);
    return result.ok ? { ok: true, filter: { not: result.filter } } : result;
  }

  // ── Leaf comparison ───────────────────────────────────────────────────────
  const extra = keys.filter(
    (key) => key !== "field" && key !== "op" && key !== "value"
  );
  if (extra.length > 0) {
    return {
      ok: false,
      reason: `unknown filter key "${extra[0]}"; expected field/op/value, and/or/not`,
    };
  }
  budget.predicates += 1;
  if (budget.predicates > MEMORY_FILTER_MAX_PREDICATES) {
    return {
      ok: false,
      reason: `filter exceeds the maximum of ${MEMORY_FILTER_MAX_PREDICATES} predicates`,
    };
  }

  const field = node.field;
  if (
    typeof field !== "string" ||
    !Object.prototype.hasOwnProperty.call(MEMORY_FILTER_FIELDS, field)
  ) {
    return {
      ok: false,
      reason: `unknown filter field; allowed: ${Object.keys(MEMORY_FILTER_FIELDS).join(", ")}`,
    };
  }
  const fieldType = MEMORY_FILTER_FIELDS[field as MemoryFilterField];

  const op = node.op;
  if (
    typeof op !== "string" ||
    !MEMORY_FILTER_OPERATORS.includes(op as MemoryFilterOperator)
  ) {
    return {
      ok: false,
      reason: `unknown filter operator; allowed: ${MEMORY_FILTER_OPERATORS.join(", ")}`,
    };
  }
  const operator = op as MemoryFilterOperator;
  if (!OPERATORS_BY_TYPE[fieldType].includes(operator)) {
    return {
      ok: false,
      reason: `operator "${operator}" is not valid for ${fieldType} field "${field}"`,
    };
  }

  const valueResult = validateValue(fieldType, operator, node.value);
  if (!valueResult.ok) {
    return valueResult;
  }
  return {
    ok: true,
    filter: {
      field: field as MemoryFilterField,
      op: operator,
      value: valueResult.value,
    },
  };
}

type ValueResult =
  | { ok: true; value: MemoryFilterScalar | MemoryFilterScalar[] }
  | { ok: false; reason: string };

function validateScalar(
  fieldType: MemoryFilterFieldType,
  value: unknown
): { ok: true; value: MemoryFilterScalar } | { ok: false; reason: string } {
  // A list field's ELEMENTS are strings, so element-wise comparisons take the
  // string rules; the field type only decides which operators were legal above.
  const expected = fieldType === "stringList" ? "string" : fieldType;
  if (expected === "boolean") {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { ok: false, reason: "boolean fields accept only true/false" };
  }
  if (expected === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, reason: "numeric fields accept only finite numbers" };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: `${expected} fields accept only string values` };
  }
  if (value.length > MEMORY_FILTER_MAX_VALUE_LENGTH) {
    return {
      ok: false,
      reason: `filter values are limited to ${MEMORY_FILTER_MAX_VALUE_LENGTH} characters`,
    };
  }
  if (expected === "date" && Number.isNaN(Date.parse(value))) {
    return {
      ok: false,
      reason: "date fields accept only a parseable ISO-8601 date-time",
    };
  }
  return { ok: true, value };
}

function validateValue(
  fieldType: MemoryFilterFieldType,
  operator: MemoryFilterOperator,
  value: unknown
): ValueResult {
  if (LIST_VALUE_OPERATORS.includes(operator)) {
    if (!Array.isArray(value) || value.length === 0) {
      return {
        ok: false,
        reason: `"${operator}" requires a non-empty array of values`,
      };
    }
    if (value.length > MEMORY_FILTER_MAX_LIST_LENGTH) {
      return {
        ok: false,
        reason: `"${operator}" accepts at most ${MEMORY_FILTER_MAX_LIST_LENGTH} values`,
      };
    }
    const items: MemoryFilterScalar[] = [];
    for (const entry of value) {
      const scalar = validateScalar(fieldType, entry);
      if (!scalar.ok) {
        return scalar;
      }
      items.push(scalar.value);
    }
    return { ok: true, value: items };
  }
  const scalar = validateScalar(fieldType, value);
  return scalar.ok ? { ok: true, value: scalar.value } : scalar;
}

/**
 * Validate an already-decoded filter. Refusals are EXPLICIT (the caller turns
 * them into a 400) and never silent: a silently-dropped predicate would let a
 * caller probe which parts of the grammar exist by watching result counts move.
 *
 * The SERIALIZED size is part of the grammar's bounds, not a transport detail of
 * one caller. A filter sitting at every structural cap (16 predicates × a
 * 32-element `in` × 250-char values) validates structurally and then serializes
 * to ~130 KB — which the GET-query transport rejects before ANY validator runs
 * (Node's 16 KB `maxHeaderSize`), so a pre-validating caller would hand back
 * "accepted" and the agent would then get an opaque transport error. Checking it
 * HERE, at the single shared definition, is what makes "one grammar, one set of
 * bounds" true: every surface refuses the same filters, with the same readable
 * reason. Cheap by construction — the walk already bounded the node count.
 */
export function parseMemoryFilter(value: unknown): MemoryFilterParse {
  const parsed = validateNode(value, 1, { predicates: 0 });
  if (!parsed.ok) {
    return parsed;
  }
  const wireLength = JSON.stringify(parsed.filter).length;
  if (wireLength > MEMORY_FILTER_MAX_JSON_LENGTH) {
    return {
      ok: false,
      reason: `filter must be at most ${MEMORY_FILTER_MAX_JSON_LENGTH} characters of JSON; this one serializes to ${wireLength}`,
    };
  }
  return parsed;
}

/**
 * Validate a filter arriving as a JSON STRING (the GET-query transport). The
 * length cap is applied BEFORE `JSON.parse`, so an oversized or deeply-nested
 * body is refused without ever being materialized.
 */
export function parseMemoryFilterJson(raw: string): MemoryFilterParse {
  if (raw.length > MEMORY_FILTER_MAX_JSON_LENGTH) {
    return {
      ok: false,
      reason: `filter must be at most ${MEMORY_FILTER_MAX_JSON_LENGTH} characters of JSON`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "filter must be valid JSON" };
  }
  return parseMemoryFilter(decoded);
}

/**
 * The record shape the evaluator reads. Every field is optional/nullable on
 * purpose: surfaces hand it partially-populated notes (a coordinates-only note
 * carries no `text`), and the null semantics below make that safe.
 */
export type MemoryFilterRecord = {
  [K in MemoryFilterField]?: unknown;
};

/**
 * NULL SEMANTICS, fixed and documented so every surface agrees: a field that is
 * absent, null, or undefined matches ONLY the negative operators (`ne`, `nin`).
 * Every positive comparison against a missing value is false. This is
 * deliberately total (no SQL three-valued logic) — an "unknown" outcome would
 * have to be resolved somewhere, and every resolution point is a place the
 * answer could differ between surfaces.
 */
function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

function toComparable(
  fieldType: MemoryFilterFieldType,
  value: unknown
): number | string | boolean | undefined {
  if (fieldType === "date") {
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? undefined : ms;
    }
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isNaN(ms) ? undefined : ms;
    }
    return undefined;
  }
  if (fieldType === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
  if (fieldType === "boolean") {
    return typeof value === "boolean" ? value : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function stringElements(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function scalarMatches(
  fieldType: MemoryFilterFieldType,
  operator: MemoryFilterOperator,
  actual: unknown,
  expected: MemoryFilterScalar | MemoryFilterScalar[]
): boolean {
  const left = toComparable(fieldType, actual);
  if (left === undefined) {
    return operator === "ne" || operator === "nin";
  }
  switch (operator) {
    case "eq":
      return left === toComparable(fieldType, expected);
    case "ne":
      return left !== toComparable(fieldType, expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const right = toComparable(fieldType, expected);
      if (typeof left !== "number" || typeof right !== "number") {
        return false;
      }
      if (operator === "gt") return left > right;
      if (operator === "gte") return left >= right;
      if (operator === "lt") return left < right;
      return left <= right;
    }
    case "in":
    case "nin": {
      const list = (Array.isArray(expected) ? expected : [expected]).map(
        (entry) => toComparable(fieldType, entry)
      );
      const hit = list.some((entry) => entry !== undefined && entry === left);
      return operator === "in" ? hit : !hit;
    }
    case "contains":
      return (
        typeof left === "string" &&
        typeof expected === "string" &&
        left.includes(expected)
      );
    case "icontains":
      return (
        typeof left === "string" &&
        typeof expected === "string" &&
        left.toLowerCase().includes(expected.toLowerCase())
      );
    default:
      return false;
  }
}

function listMatches(
  operator: MemoryFilterOperator,
  actual: unknown,
  expected: MemoryFilterScalar | MemoryFilterScalar[]
): boolean {
  const elements = stringElements(actual);
  switch (operator) {
    case "in":
    case "nin": {
      const wanted = new Set(
        (Array.isArray(expected) ? expected : [expected]).map(String)
      );
      const hit = elements.some((entry) => wanted.has(entry));
      return operator === "in" ? hit : !hit;
    }
    case "contains":
      return (
        typeof expected === "string" &&
        elements.some((entry) => entry.includes(expected))
      );
    case "icontains": {
      if (typeof expected !== "string") {
        return false;
      }
      const needle = expected.toLowerCase();
      return elements.some((entry) => entry.toLowerCase().includes(needle));
    }
    default:
      return false;
  }
}

function matchesCondition(
  record: MemoryFilterRecord,
  condition: MemoryFilterCondition
): boolean {
  const fieldType = MEMORY_FILTER_FIELDS[condition.field];
  const actual = record[condition.field];
  if (fieldType === "stringList") {
    // An absent list is an EMPTY list, not a missing value: "modules nin [x]"
    // is true for a note with no modules, which is what a reader expects.
    return listMatches(condition.op, actual ?? [], condition.value);
  }
  if (isMissing(actual)) {
    return condition.op === "ne" || condition.op === "nin";
  }
  return scalarMatches(fieldType, condition.op, actual, condition.value);
}

/**
 * Evaluate a VALIDATED filter against one record. Pure and total: it never
 * throws, so a caller can map it straight over an already-authorized result set
 * without a try/catch swallowing a governance decision by accident.
 */
export function matchesMemoryFilter(
  record: MemoryFilterRecord,
  filter: MemoryFilter
): boolean {
  if ("and" in filter) {
    return filter.and.every((branch) => matchesMemoryFilter(record, branch));
  }
  if ("or" in filter) {
    return filter.or.some((branch) => matchesMemoryFilter(record, branch));
  }
  if ("not" in filter) {
    return !matchesMemoryFilter(record, filter.not);
  }
  return matchesCondition(record, filter);
}
