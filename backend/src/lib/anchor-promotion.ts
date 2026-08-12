import {
  MAX_ENTITIES_PER_NOTE,
  MAX_ENTITY_SCAN_CHARS,
  pathShapedTokens,
} from "@muon/graph";
import type { CoordinateResolver } from "./anchor-resolution.js";

// ── D15: the entity namespace becomes the coordinate namespace ────────────────
//
// `docs/design/memory-index-decisions.md` §D15, option **B**. Two namespaces
// already described the same files, differently: the ANCHOR namespace is fed by
// the caller and was nearly empty (9 `Module`, 37 `ANCHORED_TO`, and the flagship
// confirmed-only gate returning 0 notes), while the ENTITY namespace is fed by the
// note's own text at ingest and is populated (60 path-shaped `Entity` keys of 481).
// 63 active notes named a TRACKED repo file in their prose and carried no module
// anchor at all; 33 carried one. So the coordinate layer fills itself from prose:
// a path-shaped token the tracked-file set CONFIRMS becomes a module anchor.
//
// Three rules, each load-bearing:
//
//   1. GATED ON D1'S RESOLVER. Only a path `trackedFileSet` confirms is promoted.
//      Promoting an unvalidated path entity "would fill the coordinate layer with
//      junk faster than any agent ever could" — 37 of the 60 live path-shaped
//      entity keys are ANOTHER repository's paths, and there is no version of this
//      that is safe without the resolver. A NULL tracked set promotes NOTHING, ever;
//      it is never a guess.
//      WHICH WRITES THAT LEAVES UNPROMOTED, stated exactly, because it moved once
//      already: any write with no workspace — today's operator-tier write (ADR-0026
//      step 2 derives none) and an import whose route was given none. A pack import
//      that IS stamped with a receiving workspace (ADR-0026 step 5) DOES promote,
//      from the foreign note's own prose, into the receiving partition. That follows
//      step 5's rule rather than bending it — the stamp is what says the note belongs
//      to this partition, and the pack's own `modules` array is already labelled
//      against the receiving tracked set the same way. It is bounded by the same two
//      things that bound the rest of an import: the note lands `trust:"low"` and
//      `proposalOnly`, and NO Confirmation row is written, so nothing promoted from
//      foreign prose can reach the confirmed-only gate until a human HERE admits the
//      note. The residual hazard is named in §D3's terms: if the pack's prose names
//      `src/index.ts` and this repo has that file, the anchor is `resolved` and reads
//      as local. A pack cannot declare coordinates (`plannedCoordinates` is refused
//      on that path) and this does not change that; it infers one, from text a human
//      has to confirm before it counts.
//   2. THE ANCHOR VALUE IS THE TRACKED FILE'S OWN SPELLING. See
//      {@link canonicalTrackedSpelling}: this is the case trap, it is measured, and
//      getting it wrong silently defeats the whole change.
//   3. A PROMOTED ANCHOR IS INFERRED, NOT ASSERTED BY THE CALLER — and it is NOT
//      distinguishable from a caller-supplied one at the row level. That is a
//      choice, defended below.
//
// WHY NO `promoted` FLAG ON THE ROW, since a reviewer will ask. Three reasons, and
// the third is the one that decides it:
//   • Every promoted anchor is `resolution:'resolved'` BY CONSTRUCTION — the
//     promotion gate IS `resolutionOf(...) === 'resolved'`. So a promoted anchor
//     can never be an unvalidated guess, a typo, or another repo's path; the
//     coordinate layer's validity claim is exactly as strong as before. D1's column
//     had to land first for precisely this reason, and it is what makes the
//     inferred coordinate safe rather than what labels it.
//   • The claim is still the NOTE AUTHOR'S. A promoted anchor is derived from the
//     note's own text, in the note's own workspace, so nothing here attributes a
//     coordinate to a principal that did not write it. It confers no visibility:
//     confirmation, trust, chat and workspace partitions are untouched, so a
//     promoted anchor can only surface a note through a coordinate that note's text
//     already named, under the same governed gate.
//   • IT IS RECOMPUTABLE, so the flag would be a cache. `promoteResolvedPathEntities`
//     is pure: "was this anchor promoted?" is answerable at any time from data
//     already stored (the note's text plus the tracked set), which a column is not
//     needed to record. A column would also need a migration, and this change is
//     deliberately schema-free and reversible.
//     THAT RECOMPUTATION IS NOW A REAL CALLER, not a hypothetical — see
//     {@link successorModules}. The argument was written for an INGEST, where it
//     holds unconditionally, and it was FALSE for a SUCCESSOR until that function
//     existed: `updateMemoryNote`'s text edit passed the predecessor's module
//     scalar (which already carried its promoted coordinates) straight back into
//     `noteCreateOps`, which unioned the NEW text's promoted set on top. The set
//     was therefore MONOTONE — editing a note to remove a path mention kept the
//     anchor forever, and every edit could add up to `MAX_PROMOTED_MODULES` more.
//     The bullet above is what made the fix cheap: recompute the PREDECESSOR's
//     promoted set from its own text and subtract it, then let the successor's own
//     text speak.
//   The cost, stated plainly: an operator reading `MemoryAnchor` cannot tell which
//   coordinates the caller typed. If that turns out to matter, the honest fix is a
//   `derivation` column (D8's shape) and not a boolean here. {@link successorModules}
//   pays that cost in one specific, bounded way, and names it there.
//
// REJECTED, recorded so nobody re-buys them:
//   • §D15-C, teaching anchor recall to ALSO consult the entity namespace. Two
//     indexes answering one question with different case rules.
//   • Widening the DEDUP comparison set with promoted modules. See the call site in
//     `memory-ledger.ts` — a supersede is destructive, and D15 is a decision about
//     the coordinate layer, not about which notes are duplicates.
//   • Promoting a path-shaped token that is `unresolved`, or one whose tracked
//     spelling is AMBIGUOUS. Both are guesses. See below.

/**
 * What one note's text yields, as coordinates.
 *
 * `ambiguous` is reported rather than swallowed because a refusal is a fact about
 * the repository (two tracked paths differing only by case), and the one-shot
 * backfill has to be able to say how many coordinates it declined to guess at.
 */
export type PromotedCoordinates = {
  /** Tracked-file spellings to anchor: deduped, text order, capped. */
  readonly modules: string[];
  /** Case-folded keys REFUSED because two tracked paths differ only by case. */
  readonly ambiguous: string[];
};

const EMPTY: PromotedCoordinates = { modules: [], ambiguous: [] };

/**
 * Coordinates one note may mint from its own prose. Deliberately the entity
 * namespace's own per-note bound: the promoted set IS the entity namespace's path
 * arm, so a note that can mint at most {@link MAX_ENTITIES_PER_NOTE} entities must
 * not be able to mint an unbounded number of anchors. Note text is agent-authored
 * and never reviewed before ingest; a pasted `git ls-files` dump is a realistic
 * input, and without this bound it would anchor a note to the whole repository.
 */
const MAX_PROMOTED_MODULES = MAX_ENTITIES_PER_NOTE;

/**
 * Case-folded views of a tracked set, keyed by the SET ITSELF.
 *
 * The fold is a property of the tracked set and costs one pass over ~1,300 strings
 * (measured `git ls-files` size for this repository), so it is built once per set
 * instance rather than once per note: D1's memo hands back the SAME `Set` object
 * for a 30 s window, so an ingest BURST folds once. A `WeakMap` keyed on the set —
 * rather than on the repo root — is what keeps this correct when the memo expires
 * and a genuinely new set arrives, and it needs no invalidation hook of its own:
 * when the set is collectable, so is its fold. A resolver a TEST constructed by
 * hand works identically, which a repo-root-keyed cache could not promise.
 */
const foldedByTrackedSet = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, string | null>
>();

/**
 * `lowercased path → the tracked spelling`, or `null` when TWO tracked paths fold
 * to it.
 *
 * `toLowerCase`, never `toLocaleLowerCase`: the entity key normalisation
 * (`normalizeEntity`) uses the locale-independent fold, and the two must agree
 * exactly or the reverse mapping misses. A locale-sensitive fold would also make
 * the anchor namespace depend on the operator's locale — under a Turkish locale
 * `I` folds to `ı`, so the same repository would produce different anchors on two
 * machines.
 */
function caseFoldedTracked(
  tracked: ReadonlySet<string>
): ReadonlyMap<string, string | null> {
  const cached = foldedByTrackedSet.get(tracked);
  if (cached) {
    return cached;
  }
  const folded = new Map<string, string | null>();
  for (const path of tracked) {
    const key = path.toLowerCase();
    // A second DISTINCT tracked path folding to the same key poisons the entry to
    // `null` — permanently, for this set. Order of iteration therefore cannot
    // decide the answer, which matters because `git ls-files` order is not ours.
    folded.set(key, folded.has(key) ? null : path);
  }
  foldedByTrackedSet.set(tracked, folded);
  return folded;
}

/**
 * The tracked file a path-shaped token names, spelled the way the REPOSITORY
 * spells it — or `undefined` (not tracked) / `null` (tracked, but ambiguously).
 *
 * THE CASE TRAP, and it is measured. `apps/cli/readme.md` (a lowercased `Entity`
 * key) and `apps/cli/README.md` (a `Module` anchor) are the same file. An anchor
 * minted in the entity namespace's spelling forks the anchor namespace by case, and
 * `preEditContext`'s EXACT-STRING membership test (`backend/src/lib/preedit.ts`,
 * `recallForGate({ module })` per anchor) then misses every promoted anchor — the
 * change would measure as a success (row 22 empties, row 4 grows) while the gate it
 * exists to fill stays at 0. So the anchor value is always the tracked spelling.
 *
 * Two steps, in this order:
 *   1. The token AS WRITTEN is in the tracked set → that, verbatim. This is D1's
 *      `resolved` predicate unchanged, and it involves no case reasoning at all: a
 *      note that spelled the path exactly right is not a case question.
 *   2. Otherwise, fold it and look the fold up. Exactly one tracked path folds to
 *      it → the REPOSITORY's spelling wins over the note's.
 *
 * AN AMBIGUOUS FOLD IS REFUSED, NEVER GUESSED. On a case-SENSITIVE filesystem two
 * tracked paths can differ only by case (`a/Case.ts` and `a/case.ts` are two files,
 * and both can sit in the git INDEX even on APFS), so picking one would be a
 * genuine mis-identification: an anchor pointing at a file the note did not name,
 * inside the layer the pre-edit gate trusts. Step 1 still wins over an ambiguous
 * fold, because an exact tracked spelling is evidence rather than a guess.
 */
function canonicalTrackedSpelling(
  token: string,
  tracked: ReadonlySet<string>
): string | null | undefined {
  if (tracked.has(token)) {
    return token;
  }
  return caseFoldedTracked(tracked).get(token.toLowerCase());
}

/**
 * Promote the RESOLVABLE path-shaped tokens of `text` into module-anchor values.
 *
 * Pure and synchronous, so it composes into the one atomic `$transaction` every
 * note write already builds (`noteCreateOps`), and so the one-shot backfill and the
 * ingest path can never disagree about what a note's prose anchors it to.
 *
 * A resolver of `undefined`, or one with a NULL tracked set, promotes NOTHING —
 * the same "this caller does not resolve" direction `resolutionOf` takes, for the
 * same reason: an inferred coordinate we could not validate is exactly the junk
 * §D15 refuses to admit.
 */
export function promoteResolvedPathEntities(
  text: string,
  resolver: CoordinateResolver | undefined
): PromotedCoordinates {
  const tracked = resolver?.tracked;
  if (!tracked) {
    return EMPTY;
  }
  const modules: string[] = [];
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  // Bounded at the entity namespace's scan window, so the coordinate layer never
  // reads text the entity layer would not have (and so untrusted input cannot make
  // `PATH_RE` backtrack over a megabyte).
  for (const token of pathShapedTokens(text, MAX_ENTITY_SCAN_CHARS)) {
    const canonical = canonicalTrackedSpelling(token, tracked);
    if (canonical === undefined) {
      continue; // D1's `unresolved`: a path-shaped token naming no tracked file.
    }
    if (canonical === null) {
      const folded = token.toLowerCase();
      if (!ambiguous.includes(folded)) {
        ambiguous.push(folded);
      }
      continue;
    }
    if (seen.has(canonical)) {
      continue; // two spellings of one file are one coordinate
    }
    seen.add(canonical);
    modules.push(canonical);
    if (modules.length >= MAX_PROMOTED_MODULES) {
      break;
    }
  }
  return { modules, ambiguous };
}

/**
 * The module scalar a TEXT-EDIT SUCCESSOR should inherit: the predecessor's, minus
 * what the PREDECESSOR's own prose promoted.
 *
 * A successor is a new note carrying the predecessor's coordinates and NEW text.
 * `noteCreateOps` unions the new text's promoted set onto whatever `modules` it is
 * handed, so handing it the predecessor's scalar verbatim made the coordinate set
 * MONOTONE: a note edited to remove a path mention kept the anchor for ever, and
 * each edit could add up to {@link MAX_PROMOTED_MODULES} more. Three things that
 * costs, as the review that found it named them: the note surfaces in the pre-edit
 * gate for files its current text does not mention; `anchorScopedCandidates` finds
 * it through every stale anchor, so a later ingest can SUPERSEDE it — a destructive
 * write — on the strength of a coordinate it no longer carries; and
 * `reconcileAnchorEdges` cannot notice, because the stale anchors ARE in
 * `n.modules` and the invariant it asserts is
 * `count(ANCHORED_TO) == Σ size(n.modules)`.
 *
 * Subtraction, not replacement, and the direction matters: only the coordinates the
 * PREDECESSOR's text can still mint are removed. Anything else the predecessor
 * carried — a caller-supplied module, a module `effectiveModules` auto-derives from
 * a symbol anchor, an anchor an operator added by hand — survives untouched, which
 * is the property that keeps a typo fix from quietly un-anchoring a note.
 *
 * A NULL tracked set (no workspace, not a git repo, `git` missing, timed out)
 * promotes nothing and therefore SUBTRACTS nothing, so the successor inherits the
 * predecessor's scalar exactly as it did before this function existed. The
 * degradation direction is deliberate: an unreadable set must never be able to
 * strip a coordinate, only to decline to add one.
 *
 * THE ONE COORDINATE THIS GETS WRONG, stated rather than discovered later: a module
 * that was BOTH caller-supplied AND promotable from the predecessor's text is
 * indistinguishable from a purely promoted one — no row records which — so it is
 * treated as promoted and drops out unless the successor's text names it too. That
 * is the exact cost the "why no `promoted` flag" note above accepts, and the exact
 * case its stated remedy (a `derivation` column, D8's shape) would fix. It is
 * bounded: the coordinate can only be one the predecessor's own prose already
 * named, and the successor's prose can restore it by naming it.
 */
export function successorModules(
  predecessorText: string,
  predecessorModules: readonly string[],
  resolver: CoordinateResolver | undefined
): string[] {
  const promoted = promoteResolvedPathEntities(predecessorText, resolver).modules;
  if (promoted.length === 0) {
    return [...predecessorModules];
  }
  const drop = new Set(promoted);
  return predecessorModules.filter((value) => !drop.has(value));
}
