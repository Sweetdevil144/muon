import fs from "node:fs";
import path from "node:path";
import type { ImportRef, LanguageAdapter, LanguageContext } from "../adapter.js";
import { isWithin, toWorkspaceRelativePosix } from "../paths.js";
import { extractPythonSymbolReferences } from "../python-symbol-refs.js";

/**
 * The Python `LanguageAdapter` (ADR-0016 §5), a MODULE-LEVEL reverse-import graph
 * built from a bounded line/text scanner, PLUS (REC-010, ADR-0015 parity) the
 * OPTIONAL symbol layer: `createContext` exposes `extractReferences`, delegating
 * to `extractPythonSymbolReferences` (`../python-symbol-refs.ts`), so a `.py`
 * symbol target now refines to its symbol-level referencers exactly like TS.
 * NO AST, NO deps, NO egress (pure string + fs). The symbol layer degrades to
 * module-level on ANY ambiguity. TWO DISTINCT off-switches, do not conflate:
 *   - `maxSymbolScanMs <= 0` disables ONLY the symbol layer, the module-level
 *     reverse-import graph is untouched, so `.py` impact restores the echo-only
 *     behavior byte-for-byte;
 *   - `MUON_CODEGRAPH_LANGS=ts` removes the Python adapter ENTIRELY, so a `.py`
 *     file is unindexed and its impact returns `null` (no adapter), NOT echo-only.
 * LOW-2: `maxSymbolScanMs` is a SINGLE budget SHARED across adapters (accumulated
 * in one indexer loop). A Python-heavy repo that exhausts the sub-budget flips
 * `symbolLayerAvailable` off for the remaining files, so later TS files degrade to
 * module-level too, gracefully and never throwing (the module floor is intact).
 *
 * CARDINAL RULE (ADR-0016 §9): a WRONG module edge is worse than a missing one.
 * The scanner tracks triple-quote/comment/continuation state so an import-like line
 * inside a docstring never fabricates an edge, and the resolver degrades to `null`
 * on any doubt (package/name ambiguity → resolve to the imported module ONLY, never
 * a speculative `X/n.py`; root escape → the shared `isWithin` + F-1 self-guard).
 */

// ── §5.1 the bounded logical-line scanner ────────────────────────────────────

/**
 * Reduce Python source to LOGICAL lines (ADR-0016 §5.1): join `\`- and open-paren
 * continuations, and, MANDATORY, track triple-quote (`"""`/`'''`) and single-line
 * string state so a `#`/`import` inside a string is NEVER seen as code. String
 * bodies collapse to a single space; `#` comments (outside strings) are dropped.
 * A statement that spans a docstring emits no spurious logical line because the
 * docstring's contents are consumed WITHOUT ever ending a logical line.
 */
export function toLogicalLines(source: string): string[] {
  const out: string[] = [];
  const n = source.length;
  let buf = "";
  let paren = 0; // () [] {} nesting → implicit line continuation
  let i = 0;

  while (i < n) {
    const c = source[i];

    // Triple- or single-quoted string literal → consume the body, blank it out.
    if (c === '"' || c === "'") {
      const triple = source.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const quote = triple;
        i += 3;
        while (i < n) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source.slice(i, i + 3) === quote) {
            i += 3;
            break;
          }
          i += 1;
        }
      } else {
        const quote = c;
        i += 1;
        while (i < n) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === quote) {
            i += 1;
            break;
          }
          if (source[i] === "\n") {
            break; // unterminated single-line string → bail (degrade-safe)
          }
          i += 1;
        }
      }
      // Hardening (review LOW-1): blank a consumed string to a NON-whitespace
      // sentinel, not a space. A logical line whose leading token is a string
      // (`""" a """ import x`, invalid Python) would otherwise `trim()` to start
      // with `import`; the sentinel leaves a non-whitespace leading token so the
      // `startsWith("import ")`/`from ` match fails. Genuine imports carry no
      // preceding string, so they are unaffected.
      buf += "\x00";
      continue;
    }

    // `#` comment (outside any string) → skip to end of the physical line.
    if (c === "#") {
      while (i < n && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    // Bracket nesting → newlines inside are implicit continuations.
    if (c === "(" || c === "[" || c === "{") {
      paren += 1;
      buf += c;
      i += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (paren > 0) {
        paren -= 1;
      }
      buf += c;
      i += 1;
      continue;
    }

    // Explicit `\`-newline continuation.
    if (c === "\\" && (source[i + 1] === "\n" || source[i + 1] === "\r")) {
      i += 1;
      if (source[i] === "\r") {
        i += 1;
      }
      if (source[i] === "\n") {
        i += 1;
      }
      buf += " ";
      continue;
    }

    if (c === "\n") {
      if (paren > 0) {
        buf += " "; // implicit continuation inside brackets
        i += 1;
        continue;
      }
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }
  if (buf.length > 0) {
    out.push(buf);
  }
  return out;
}

/** A valid dotted module path: `a`, `a.b.c` (no leading/trailing dot, ASCII-ish). */
function isDottedModule(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name);
}

/** Parse the member list of a `from … import (a, b as c, *)` clause → bare names. */
function parseMembers(rawPart: string): string[] {
  let part = rawPart.trim();
  if (part.startsWith("(")) {
    part = part.slice(1);
  }
  if (part.endsWith(")")) {
    part = part.slice(0, -1);
  }
  const out: string[] = [];
  for (const raw of part.split(",")) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const name = token.split(/\s+/)[0]; // `x as y` → x
    if (name === "*") {
      continue; // star import contributes no named member (module edge still kept)
    }
    if (/^[A-Za-z_]\w*$/.test(name)) {
      out.push(name);
    }
  }
  return out;
}

/** `import a` / `import a.b as c` / `import a, b.c` → one ImportRef per comma item. */
function parseImport(rest: string, refs: ImportRef[]): void {
  for (const raw of rest.split(",")) {
    const item = raw.trim();
    if (!item) {
      continue;
    }
    const name = item.split(/\s+/)[0]; // strip `as alias`
    if (isDottedModule(name)) {
      refs.push({ specifier: name, relativeLevel: 0 });
    }
  }
}

/**
 * `from a.b import (x, y)` / `from . import c` / `from ..pkg.mod import e` → one
 * ImportRef with the post-dot dotted `specifier`, `relativeLevel` = leading-dot
 * count, and the imported `members`. Anchored on the `import` KEYWORD (a `\b`-word
 * match, so `importlib`/`from a.importmod` never split wrong).
 */
function parseFrom(rest: string, refs: ImportRef[]): void {
  const trimmed = rest.replace(/^\s+/, "");
  const sep = /\bimport\b/.exec(trimmed);
  if (!sep) {
    return;
  }
  const head = trimmed.slice(0, sep.index).trim(); // `<dots><dotted-name>`
  const memberPart = trimmed.slice(sep.index + "import".length).trim();
  if (!memberPart) {
    return;
  }
  const dotsMatch = /^(\.*)(.*)$/.exec(head)!;
  const relativeLevel = dotsMatch[1].length;
  const name = dotsMatch[2].trim();
  if (relativeLevel === 0 && !name) {
    return; // `from  import x`, malformed
  }
  if (name && !isDottedModule(name)) {
    return; // junk module path → degrade to no edge
  }
  refs.push({ specifier: name, relativeLevel, members: parseMembers(memberPart) });
}

/**
 * §5.1 `extractImports`, pure, NEVER throws (→ `[]` on any doubt). Reduces the
 * source to logical lines, then matches `import …` / `from … import …` ONLY at a
 * logical-line start (after indentation). Everything else (assignments, f-strings,
 * `importlib.import_module`, dynamic `__import__`) is ignored.
 */
export function extractImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  try {
    for (const logical of toLogicalLines(source)) {
      const line = logical.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("import ") || line.startsWith("import\t")) {
        parseImport(line.slice("import".length), refs);
      } else if (line.startsWith("from ") || line.startsWith("from\t")) {
        parseFrom(line.slice("from".length), refs);
      }
    }
  } catch {
    return [];
  }
  return refs;
}

// ── §5.2 the package/`__init__.py`/relative resolver ─────────────────────────

/** Pure existence predicate, the real adapter checks the fs; the eval a Set. */
export type PathExists = (absPath: string) => boolean;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The importing file's PACKAGE ROOT: walk UP from its directory while a sibling
 * `__init__.py` exists; the base is the first ancestor that is NOT a package (the
 * directory that CONTAINS the top-level package). Absolute `a.b.c` imports resolve
 * relative to this base (so `src/`-layout repos work) AND to the repo root.
 */
function packageRoot(startDir: string, exists: PathExists): string {
  let dir = startDir;
  while (exists(path.join(dir, "__init__.py"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // hit the filesystem root
    }
    dir = parent;
  }
  return dir;
}

/**
 * Probe a dotted module under `base`: the deepest of `<base>/a/b/c.py` (a module
 * file) then `<base>/a/b/c/__init__.py` (a package). Empty `parts` (a bare `from .
 * import x`) resolves to `<base>/__init__.py` only. `null` when neither exists.
 */
function probeModule(
  base: string,
  parts: string[],
  exists: PathExists
): string | null {
  if (parts.length === 0) {
    const init = path.join(base, "__init__.py");
    return exists(init) ? init : null;
  }
  const joined = path.join(base, ...parts);
  const asFile = `${joined}.py`;
  if (exists(asFile)) {
    return asFile;
  }
  const asPackage = path.join(joined, "__init__.py");
  return exists(asPackage) ? asPackage : null;
}

/**
 * §5.2 resolve one `ImportRef` to an intra-repo absolute `.py` file, or `null`.
 * Pure over `exists` (fs for the adapter, an in-memory Set for the eval). Every hit
 * passes the SHARED `isWithin(root)` + `toWorkspaceRelativePosix` self-guard, so an
 * out-of-root / `..`-escaping relative import (`from ...... import x`) → `null`.
 *
 * `from X import n` package-vs-name ambiguity: resolves to X's file ONLY
 * (`X/__init__.py` | `X.py`), an always-correct edge. It does NOT speculatively add
 * `X/n.py` (the conservative v1 recall lever the reviewer note keeps out).
 */
export function resolvePythonImport(
  root: string,
  fromFile: string,
  ref: ImportRef,
  exists: PathExists
): string | null {
  const realRoot = path.resolve(root);
  const fromDir = path.dirname(path.resolve(fromFile));
  const level = ref.relativeLevel ?? 0;
  const parts = ref.specifier
    ? ref.specifier.split(".").filter(Boolean)
    : [];

  let hit: string | null = null;
  if (level > 0) {
    // Relative import: start at the file's dir, up `level-1` packages, then apply
    // the dotted specifier. `from X import n` still resolves to X only.
    let base = fromDir;
    for (let up = 0; up < level - 1; up += 1) {
      const parent = path.dirname(base);
      if (parent === base) {
        return null; // walked past the filesystem root → escape → null
      }
      base = parent;
    }
    // Hardening (review LOW-2): a relative import that over-walks ABOVE the root and
    // re-enters (`from ...root.x import y`, invalid Python, "beyond top-level
    // package") must NOT resolve. A valid relative import always keeps `base`
    // at/below the root; an escaped `base` would let `parts` re-enter into a
    // same-named path inside the root and fabricate an edge.
    if (!isWithin(realRoot, base)) {
      return null;
    }
    hit = probeModule(base, parts, exists);
  } else {
    // Absolute import: probe against the repo root AND the file's package root.
    const bases = uniq([realRoot, packageRoot(fromDir, exists)]);
    for (const base of bases) {
      hit = probeModule(base, parts, exists);
      if (hit) {
        break;
      }
    }
  }
  if (!hit) {
    return null;
  }
  const abs = path.resolve(hit);
  // Shared F-1 self-guard: intra-root + canonicalizable, else degrade to null.
  if (!isWithin(realRoot, abs) || toWorkspaceRelativePosix(realRoot, abs) === null) {
    return null;
  }
  return abs;
}

// ── the adapter ──────────────────────────────────────────────────────────────

export const PYTHON_EXTENSIONS = [".py"] as const;

export const pythonAdapter: LanguageAdapter = {
  id: "python",

  supports(file: string): boolean {
    return file.toLowerCase().endsWith(".py");
  },

  extractImports(source: string): ImportRef[] {
    return extractImports(source);
  },

  createContext(root: string): LanguageContext {
    const realRoot = path.resolve(root);
    const exists: PathExists = (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    return {
      resolveImport(fromFile: string, ref: ImportRef): string | null {
        return resolvePythonImport(realRoot, fromFile, ref, exists);
      },
      // REC-010 (ADR-0015 parity): the OPTIONAL symbol layer. Never throws;
      // every ambiguity degrades to `{ edges: [] }` (module-level stands).
      extractReferences(source: string, module: string, absFile: string) {
        return extractPythonSymbolReferences(
          source,
          module,
          absFile,
          realRoot,
          exists
        );
      },
    };
  },
};
