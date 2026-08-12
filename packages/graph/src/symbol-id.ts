/**
 * SYMBOL IDENTITY (ADR-0012 Decision 1), the two pure helpers + one derivation
 * that make a symbol anchor a strict REFINEMENT inside the module namespace, not
 * a new namespace. The id is `<module>#<symbolName>`, where `<module>` is the
 * EXACT workspace-relative POSIX module path memory anchors already use (CG-1's
 * F-1 namespace, produced by the SINGLE `toWorkspaceRelativePosix` canonicalizer
 * in `@muon/codegraph`). Because the prefix IS the module anchor:
 *   - `moduleOfSymbol("M#N") === "M"`, a symbol-anchored note trivially derives
 *     its module anchor (the degrade guarantee: symbol-anchored ⇒ module-anchored).
 *   - the F-1 round-trip test extends one level deeper with NO new namespace.
 *
 * `#` is chosen over `:` because `:` is already overloaded (Windows drive letters,
 * `principal:` strings, GitNexus `Kind:path:name`), while `#` (the URL-fragment
 * "the symbol WITHIN this module") cannot appear in a POSIX module path.
 *
 * THE #1 BINDING REQUIREMENT: the module prefix must round-trip byte-identically
 * across capture → CG-1 → the gate. These helpers only join/split on the FIRST
 * `#`; the namespace correctness lives entirely in `toWorkspaceRelativePosix`,
 * which produces the prefix on both the capture and CG-1 sides. A merge-gating
 * end-to-end round-trip test pins the agreement (backend/tests/codegraph.test.ts).
 */

/** Compose a symbol id from an ALREADY-canonicalized module + a symbol name. The
 *  module MUST have been produced by `toWorkspaceRelativePosix` (the single
 *  canonicalizer) so the prefix lives in the anchor namespace by construction.
 *
 *  `#` is a LEGAL POSIX filename char AND our module|symbol delimiter, so a module
 *  path containing `#` (e.g. `src/weird#name.ts`) cannot form a well-formed id,
 *  `moduleOfSymbol` would split on that `#` and mis-derive the module. We DECLINE
 *  (return null): the file gets NO symbol anchor and degrades cleanly to
 *  MODULE-level (its raw `#`-containing path is still a valid module anchor). Only
 *  the MODULE side is guarded, ES private-field symbol NAMES like `#priv` are
 *  fine, since the id only ever splits on the FIRST `#` (the module delimiter). */
export function toSymbolId(module: string, name: string): string | null {
  if (module.includes("#")) {
    return null;
  }
  return `${module}#${name}`;
}

/** The module PREFIX of a symbol id, everything before the FIRST `#`. A value
 *  with no `#` (a plain module path, or a malformed id) passes through UNCHANGED,
 *  so a module-only anchor degrades cleanly. `moduleOfSymbol(toSymbolId(m,n))===m`. */
export function moduleOfSymbol(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/** The symbol NAME of a symbol id, everything after the FIRST `#` (may itself
 *  contain `.` for `Class.method`). Empty string when there is no `#`. */
export function symbolNameOf(id: string): string {
  const hash = id.indexOf("#");
  return hash === -1 ? "" : id.slice(hash + 1);
}

/**
 * Map a GitNexus symbol uid to this repo's local `<module>#<name>` id (ADR-0012
 * Decision 1's "GitNexus FK, optional enrichment"): `Kind:<path>:<qualifiedName>
 * #<overload>` → `<path>#<qualifiedName>`. Overloads COLLAPSE to one id in v1
 * (`#<overload>` is dropped), matching the local namespace's own overload
 * collapse — the disambiguation stays in the cached uid itself, not the id.
 *
 * Split on the FIRST `:` (drops `Kind`) then the LAST `:` (drops `path` from
 * `qualifiedName#overload`), so a path containing extra colons (unlikely on
 * POSIX, possible on a Windows drive) still resolves correctly — only the
 * uid's OWN two delimiters are load-bearing, not colon-freedom in the path.
 * Returns undefined for anything that does not parse into a non-empty
 * path + name pair, or whose path cannot form a well-formed local id (the same
 * `#`-in-module guard `toSymbolId` applies) — callers degrade to "no cache
 * entry", never a malformed one.
 */
export function gitnexusUidToLocalSymbolId(uid: string): string | undefined {
  if (typeof uid !== "string" || uid.length === 0) {
    return undefined;
  }
  const firstColon = uid.indexOf(":");
  if (firstColon === -1) {
    return undefined;
  }
  const rest = uid.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) {
    return undefined;
  }
  const path = rest.slice(0, lastColon);
  const qualifiedWithOverload = rest.slice(lastColon + 1);
  const overloadIndex = qualifiedWithOverload.indexOf("#");
  const name =
    overloadIndex === -1
      ? qualifiedWithOverload
      : qualifiedWithOverload.slice(0, overloadIndex);
  if (!path || !name) {
    return undefined;
  }
  return toSymbolId(path, name) ?? undefined;
}

/** Union the module prefixes of a set of symbol ids (deduped, order-preserving),
 *  the module auto-derivation that keeps a symbol-anchored note also module-
 *  anchored (ADR-0012 Decision 2 "the degrade guarantee"). */
export function deriveModulesFromSymbols(symbols: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const mod = moduleOfSymbol(symbol);
    if (mod && !seen.has(mod)) {
      seen.add(mod);
      out.push(mod);
    }
  }
  return out;
}
