import type { MemoryNoteRecord } from "./types.js";

/**
 * D4 + D6, the ANCHOR TERM of the candidate query — stated once, in both
 * languages, in one file.
 *
 * D4 makes retrieval CONJUNCTIVE: anchors are a HARD FILTER on the candidate
 * query and the free-text `q` only ORDERS within it. D6 makes ONE batched graph
 * query per anchor NAMESPACE over `ANCHORED_TO` / `ABOUT_SYMBOL`, with a
 * LIST-VALUED parameter, the access path for that filter — replacing the
 * per-anchor fan-out (`preEditContext` used to spend ≥257 round trips on a
 * 128-module radius; measured 531 ms → 53 ms at 10 000 notes / 128 anchors on this
 * LadybugDB build). The cost is now flat in ANCHOR COUNT, which is the whole
 * decision.
 *
 * WHY THE EDGE IS THE ACCESS PATH AND THE ARRAY IS THE AUTHORITY (D6 mitigation
 * order, option 1). `n.modules` / `n.symbols` on the note node are projected from
 * the durable ledger and remain the authority; `Module(path)` / `Symbol(id)` are
 * primary-keyed nodes and the edge is what makes "any of these 128 anchors" a
 * single expressible query. So:
 *   • the CYPHER arms traverse the EDGE — `memoryAnchorArms`;
 *   • the JS net reads the AUTHORITY ARRAYS — `noteMatchesAnchors`;
 *   • `MuonGraph.reconcileAnchorEdges` asserts they agree
 *     (`count(ANCHORED_TO) == Σ size(n.modules)`) and reprojects on mismatch.
 * Two shapes of one rule, in one file, for the same reason `memory-expiry.ts`
 * keeps its predicate and its clause side by side: a mirror only stays honest if
 * both halves are read (and edited) together.
 *
 * ── WHY A PATTERN JOIN AND NOT AN `EXISTS` SUBQUERY. MEASURED, NOT ASSUMED. ──
 *
 * The obvious shape is a `WHERE … AND EXISTS { MATCH (n)-[:ANCHORED_TO]->(m)
 * WHERE list_contains($anchors, m.path) }`, because it composes into a candidate
 * query without touching its `MATCH`. It is WRONG on this build: when a BOUND
 * PARAMETER appears in a sibling disjunction, the planner DROPS the subquery
 * predicate and the query returns every row. Measured against a two-note store,
 * asking for one anchor, by growing the expiry disjunction one term at a time:
 *
 *   (n.expiresAt IS NULL OR n.expiresAt = '')                       → 1 row  ✓
 *   (… OR n.expiresAt > $now)                                       → 2 rows ✗
 *   … and every longer OR that contains a `$param`                  → 2 rows ✗
 *
 * `memoryNotExpiredClause` puts `$now` in exactly that disjunction on EVERY
 * candidate query, so the `EXISTS` form would have silently un-fenced every
 * anchored read — including the gate, and including ADR-0026's workspace fence had
 * it been written the same way. The pattern-join form below returns the correct
 * single row under the identical predicate, and so does an array-lambda form (see
 * the note in the decision follow-up). This is recorded here rather than in a
 * commit message because the next person to want a subquery predicate will reach
 * for `EXISTS` first.
 *
 * `RETURN DISTINCT` is not optional on a join arm: a note carrying THREE of the
 * requested anchors matches the pattern three times, so without it an enclosing
 * `LIMIT` counts (note, anchor) pairs and quietly returns fewer notes than asked
 * for. Verified both ways on a note anchored to two requested paths — 1 row with
 * `DISTINCT`, 2 without.
 *
 * OTHER REJECTED ALTERNATIVES, all measured on this build at 10 000 notes:
 *   • `list_intersect(n.modules, $anchors)` — `Catalog exception: function
 *     LIST_INTERSECT does not exist`. Confirms the decision's premise.
 *   • 128 OR'd `list_contains` clauses in one statement — 78 ms, correct, but the
 *     statement TEXT grows with the anchor count, so the prepared-statement cache
 *     never hits twice.
 *   • one statement for both namespaces via `UNION` — parses and dedupes, but the
 *     placement of a trailing `ORDER BY`/`LIMIT` relative to the union is not
 *     something this build documents, and a `LIMIT` that silently bound only the
 *     last arm would be exactly the truncation this decision exists to prevent.
 *     Two arms merged in JS is one round trip PER NAMESPACE (so ≤2, still flat in
 *     anchor count) and each arm's `LIMIT` provably applies to its own governed set.
 */

/** The two anchor namespaces a retrieval can be fenced to. Deliberately SEPARATE
 *  arrays, never one tagged list: a module path and a `<module>#<name>` symbol id
 *  key different primary-keyed node tables, and collapsing them would make a
 *  malformed symbol id silently read as a module path. */
export type MemoryAnchorSet = {
  modules: string[];
  symbols: string[];
  /**
   * Did the caller ASK to be fenced to anchors at all?
   *
   * THE THREE STATES ARE NOT TWO, and conflating two of them fails OPEN. This is
   * the third: a caller that supplied an anchor ARRAY which turned out to be
   * EMPTY has fenced the read to nothing, and must get NOTHING — not the whole
   * governed corpus. That is what the per-anchor fan-out did by construction
   * (zero anchors ran zero queries), and it is what a gate on a target with no
   * resolvable module must keep doing: a gate that widens when it finds no anchor
   * is the D14-C failure mode, arrived at from the other side.
   *
   *   requested=false, size=0 → NO fence. The pre-D4 unanchored read.
   *   requested=true,  size=0 → fenced to nothing. Zero rows, no query.
   *   size>0                  → fenced to those anchors.
   */
  requested: boolean;
};

/**
 * One namespace's contribution to a candidate query: the extra `MATCH` hop, the
 * `WHERE` term that bounds it to the requested values, and the list parameter,
 * as ONE inseparable value — the same posture `memoryNotExpiredClause` takes, and
 * for a sharper reason here. An anchor `condition` whose `$anchorModules` binding
 * went missing is not a looser predicate: with an EMPTY list it matches NOTHING,
 * which is a silently empty gate. Handing the three back together makes that
 * unrepresentable, and `memoryAnchorArms` never emits an arm for an empty list.
 */
export type MemoryAnchorArm = {
  /** Appended to the `(n:MemoryNote)` pattern, e.g.
   *  `-[:ANCHORED_TO]->(anchorModule:Module)`. */
  pattern: string;
  condition: string;
  params: Record<string, string[]>;
  /** Which namespace this arm reads, for the caller's own diagnostics. */
  kind: "module" | "symbol";
};

/**
 * Defence-in-depth cap on how many anchor VALUES reach one query. This is NOT the
 * product bound — `MAX_ANCHOR_MODULES` (128) in `backend/src/lib/preedit.ts` is,
 * and the gate reports its own post-cap radius so a caller can see the slice. This
 * exists only so a direct library caller cannot hand the store an unbounded list
 * parameter, mirroring the `limit` clamps every other read in `MuonGraph` applies.
 */
export const MAX_ANCHOR_VALUES = 512;

/** The names the arms bind their lists under; callers must not reuse them. */
export const MEMORY_ANCHOR_MODULE_PARAM = "anchorModules";
export const MEMORY_ANCHOR_SYMBOL_PARAM = "anchorSymbols";

/** Dedupe, drop empties, and cap. Insertion order is preserved so a truncation is
 *  the caller's own tail rather than an arbitrary subset. */
function normalizeValues(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed !== "") {
      seen.add(trimmed);
    }
    if (seen.size >= MAX_ANCHOR_VALUES) {
      break;
    }
  }
  return [...seen];
}

/**
 * Fold every anchor coordinate a caller may state — the singular `module` /
 * `symbol` of the pre-D4 `MemoryRecallFilter` and the plural `modules` /
 * `symbols` of a batched request — into ONE normalized set.
 *
 * Singular and plural UNION rather than override, because they mean the same
 * thing and a caller that sets both means both. That is also what keeps the
 * façades backward-compatible: `{ module: X }` normalizes to `{ modules: [X] }`
 * and produces the same one-anchor query it always did.
 */
export function normalizeAnchorSet(input?: {
  module?: string;
  symbol?: string;
  modules?: readonly string[];
  symbols?: readonly string[];
}): MemoryAnchorSet {
  // An ARRAY (even empty) or a non-empty string is a REQUEST to be fenced; an
  // `undefined` key is not. That is the distinction `requested` exists for, and it
  // is keyed on what the caller SUPPLIED rather than on what survived
  // normalization, because `{ modules: [] }` and `{}` mean opposite things and a
  // trimmed-to-nothing `{ module: "  " }` means the former.
  const requested =
    Array.isArray(input?.modules) ||
    Array.isArray(input?.symbols) ||
    typeof input?.module === "string" ||
    typeof input?.symbol === "string";
  return {
    modules: normalizeValues([
      ...(input?.module ? [input.module] : []),
      ...(input?.modules ?? []),
    ]),
    symbols: normalizeValues([
      ...(input?.symbol ? [input.symbol] : []),
      ...(input?.symbols ?? []),
    ]),
    requested,
  };
}

/** How many anchors this set fences on. */
export function anchorSetSize(anchors: MemoryAnchorSet): number {
  return anchors.modules.length + anchors.symbols.length;
}

/**
 * The FAIL-CLOSED case: the caller asked to be fenced to anchors and named none
 * that survived. Every reader must answer this BEFORE building a query — an empty
 * `list_contains($anchors, …)` parses on this build and matches nothing, but the
 * unanchored shape it would otherwise fall back to matches EVERYTHING, and that is
 * the fence silently inverting.
 */
export function anchorFenceIsEmpty(anchors: MemoryAnchorSet): boolean {
  return anchors.requested && anchorSetSize(anchors) === 0;
}

/**
 * The anchor filter as ONE candidate-query arm PER NON-EMPTY NAMESPACE.
 *
 * `[]` — never one arm matching everything — when the set is empty, so a caller
 * must decide explicitly what an unanchored read means rather than inheriting a
 * pattern that quietly returns zero rows (an empty `list_contains($anchors, …)`
 * DOES parse on this build and matches nothing; that is exactly the silent-empty
 * gate this shape forecloses).
 *
 * Multiple arms are UNIONED BY THE CALLER (merge by note id), mirroring the
 * fan-out this replaces: `preEditContext` merged its per-module and per-symbol
 * recalls by id, so a note anchored to either namespace is in the answer. Each arm
 * carries the caller's FULL predicate, so each arm's `LIMIT` applies to its own
 * governed, visible, anchored set — no arm can contribute an ungoverned row for a
 * later filter to remove.
 */
export function memoryAnchorArms(anchors: MemoryAnchorSet): MemoryAnchorArm[] {
  const arms: MemoryAnchorArm[] = [];
  if (anchors.modules.length > 0) {
    arms.push({
      kind: "module",
      pattern: `-[:ANCHORED_TO]->(anchorModule:Module)`,
      condition: `list_contains($${MEMORY_ANCHOR_MODULE_PARAM}, anchorModule.path)`,
      params: {
        [MEMORY_ANCHOR_MODULE_PARAM]: [...anchors.modules],
      },
    });
  }
  if (anchors.symbols.length > 0) {
    arms.push({
      kind: "symbol",
      pattern: `-[:ABOUT_SYMBOL]->(anchorSymbol:Symbol)`,
      condition: `list_contains($${MEMORY_ANCHOR_SYMBOL_PARAM}, anchorSymbol.id)`,
      params: {
        [MEMORY_ANCHOR_SYMBOL_PARAM]: [...anchors.symbols],
      },
    });
  }
  return arms;
}

/**
 * The SAME rule as `memoryAnchorArms`, over a note the store already returned,
 * read off the AUTHORITY arrays.
 *
 * THIS IS THE FTS/SEMANTIC INTERSECTION (D4). `QUERY_FTS_INDEX` takes no `WHERE`
 * predicate and the semantic arm ranks vectors in JS, so neither arm can carry
 * the anchor term in its candidate query. Their output is therefore INTERSECTED
 * with the anchor set here — a set intersection, NOT a wider `top :=` / `LIMIT`
 * that is filtered afterwards. Widening the FTS `top` is explicitly rejected: it
 * would make the arm's own bound meaningless while still not guaranteeing the
 * anchored hits are in it, and it is the shape that breaks the completeness
 * property `governedConditions` exists to hold (a `LIMIT` must apply to the set
 * the caller asked for, never to a wider one that is then narrowed).
 *
 * What the intersection COSTS, stated rather than hidden: under an anchor filter
 * the FTS arm can contribute fewer candidates than its `pool`, because its top-N
 * was chosen without the anchor term. That is a RANKING effect and never a
 * completeness one — the LEXICAL arm's candidate query carries the anchor, the
 * governed and the visibility terms with its `LIMIT` applied to exactly that set,
 * so no anchored governed note can be excluded by this filter, only ranked lower
 * than it would have been.
 *
 * Reads `modules`/`symbols` and nothing else, so any row-shaped value satisfies
 * it structurally and no read path has to hydrate a full record to be filtered.
 */
export function noteMatchesAnchors(
  note: Pick<MemoryNoteRecord, "modules" | "symbols">,
  anchors: MemoryAnchorSet
): boolean {
  if (anchorFenceIsEmpty(anchors)) {
    // Fenced to nothing admits nothing — the same fail-closed answer the cypher
    // side gives by not running a query at all.
    return false;
  }
  if (anchorSetSize(anchors) === 0) {
    // No anchor term = no narrowing, matching `memoryAnchorArms`' empty list.
    return true;
  }
  if (anchors.modules.length > 0) {
    const wanted = new Set(anchors.modules);
    if ((note.modules ?? []).some((module) => wanted.has(module))) {
      return true;
    }
  }
  if (anchors.symbols.length > 0) {
    const wanted = new Set(anchors.symbols);
    if ((note.symbols ?? []).some((symbol) => wanted.has(symbol))) {
      return true;
    }
  }
  return false;
}
