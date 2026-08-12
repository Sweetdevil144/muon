import { trustRank } from "./memory-ranking.js";
import type { MemoryTrust } from "./types.js";

/**
 * R3 TTL, the GRAPH MIRROR of the ledger's expiry rule.
 *
 * The relational ledger (`backend/src/lib/memory-ledger.ts` → `isExpiredRow`) is
 * the SOURCE OF TRUTH and still post-filters every route response
 * (`applyMemoryExpiry`). This module exists so the GRAPH hides the same notes on
 * its own, rather than depending on a caller remembering to filter afterwards,
 * the graph is read directly by `preEditContext` and rebuilt by a wipe. Defence
 * in depth, never a replacement: a stale or wiped graph must never UN-hide a note
 * the ledger hides, so every uncertain path here resolves to "never expires"
 * (non-destructive) and the ledger's filter stays the last word.
 *
 * The TS predicate and the Cypher clause live in ONE file, side by side, because
 * the only way a mirror stays honest is if its two shapes are read (and edited)
 * together. `expired` is deliberately DERIVED here rather than stored on the node:
 * one clock, evaluated at query time, so a note that earns permanence after being
 * stamped can never stay hidden by a marker nobody cleared.
 */

/** The four columns hidden-ness is decided from. A `MemoryNoteRecord` satisfies
 *  it structurally, so read paths pass their rows straight through. */
export type MemoryExpiryFacts = {
  expiresAt?: string | null;
  trust: MemoryTrust;
  confirmed: boolean;
  createdBy: string;
};

/**
 * Mirror of the ledger's `parsePrincipal(createdBy).kind === "human"`. It is a
 * PREFIX convention, not a lookup: `human` / `human:<id>` (trimmed, case-
 * insensitive) is the human principal, and every other bare string ("codex",
 * "muon-capture") is an AGENT whose vendor IS that string. An empty/absent author
 * parses as the human principal there too, and it must here — mirroring it
 * anywhere less faithfully would hide, in the graph, a note the ledger shows.
 */
export function memoryAuthorIsHuman(createdBy: string): boolean {
  const principal = (createdBy ?? "").trim();
  const colon = principal.indexOf(":");
  if (colon > 0) {
    return principal.slice(0, colon).toLowerCase() === "human";
  }
  return principal === "" || principal.toLowerCase() === "human";
}

/**
 * Has this note EARNED PERMANENCE (the ledger's `ttlRedeemed`)? The three
 * never-expire invariants: human-authored, human-confirmed, high-trust. They are
 * re-applied at READ time rather than trusted to have cleared the column, so
 * confirming a stamped note redeems it here the instant the flag flips, whichever
 * write path set the deadline.
 */
export function memoryTtlRedeemed(facts: MemoryExpiryFacts): boolean {
  return (
    memoryAuthorIsHuman(facts.createdBy) ||
    facts.confirmed ||
    trustRank(facts.trust) >= trustRank("high")
  );
}

/**
 * Canonical ms-precision UTC-Z instant for the expiry comparison, or the current
 * time when absent/unparseable. Canonical BOTH sides is what lets the Cypher
 * clause compare `n.expiresAt > $now` as a raw lexicographic string compare
 * (ISO-8601 UTC sorts chronologically) and still agree with this module.
 */
export function resolveExpiryNow(now?: string | null): string {
  const ms = now ? Date.parse(now) : Number.NaN;
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/**
 * expired ⇔ a deadline is set AND already past AND the note has not earned
 * permanence. No deadline (null / '' / unreadable) → never expires.
 *
 * Deliberately independent of the bitemporal `asOf` view: expiry is evaluated
 * against the REAL clock (or an explicit, server-owned `now`), never against a
 * caller's as-of instant, otherwise "show me the brain at time T" would be a
 * bypass that reveals every expired note.
 */
export function isMemoryNoteExpired(
  facts: MemoryExpiryFacts,
  now: string = resolveExpiryNow()
): boolean {
  const deadline = Date.parse(facts.expiresAt ?? "");
  if (Number.isNaN(deadline)) {
    return false;
  }
  const at = Date.parse(now);
  if (deadline > (Number.isNaN(at) ? Date.now() : at)) {
    return false;
  }
  return !memoryTtlRedeemed(facts);
}

/**
 * The SAME rule as `isMemoryNoteExpired`, as a Cypher WHERE clause over a
 * `MemoryNote` bound to `n`, reading as "NOT expired". The evaluation instant is
 * the BOUND param `$now` (never interpolated).
 *
 * Term by term, against `isMemoryNoteExpired`:
 *   IS NULL / = ''                 → no deadline (a graph-native note leaves the
 *                                    column unset; a migrated store backfills '')
 *   > $now                         → stamped but not yet due
 *   confirmed / trust='high'       → `memoryTtlRedeemed` (trust is a 3-value enum,
 *                                    so `= 'high'` IS `trustRank >= high`)
 *   trim/lower on createdBy        → `memoryAuthorIsHuman`, including the bare
 *                                    '' and 'human' forms the ledger accepts
 *
 * DELIBERATELY NOT EXPORTED. A bare clause string is a footgun: pasted into a
 * query whose params miss `now`, `n.expiresAt > $now` is an unbound comparison and
 * every stamped-but-not-yet-due note silently reads as EXPIRED. The clause is
 * reachable only through `memoryNotExpiredClause()`, which hands back the
 * condition and its bound parameter together, so the two cannot be separated.
 */
const NOT_EXPIRED_CLAUSE = `(n.expiresAt IS NULL OR n.expiresAt = ''
        OR n.expiresAt > $now
        OR n.confirmed = true OR n.trust = 'high'
        OR trim(n.createdBy) = '' OR lower(trim(n.createdBy)) = 'human'
        OR lower(trim(n.createdBy)) STARTS WITH 'human:')`;

/** The name the clause binds its instant under; callers must not reuse it. */
export const MEMORY_EXPIRY_PARAM = "now";

/**
 * The "NOT expired" Cypher condition AND the parameter it requires, as one
 * inseparable value. This is the only way to obtain the clause: a caller that
 * spreads `params` gets `now` for free, and a caller that forgets `params`
 * cannot have gotten the condition either.
 */
export function memoryNotExpiredClause(now?: string | null): {
  condition: string;
  params: Record<typeof MEMORY_EXPIRY_PARAM, string>;
} {
  return {
    condition: NOT_EXPIRED_CLAUSE,
    params: { [MEMORY_EXPIRY_PARAM]: resolveExpiryNow(now) },
  };
}
