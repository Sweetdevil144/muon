import path from "node:path";
import {
  type PathExists,
  resolvePythonImport,
  toLogicalLines,
} from "./adapters/python.js";
import { toSymbolId, toWorkspaceRelativePosix } from "./paths.js";
import type { SymbolReference, SymbolReferenceResult } from "./symbol-refs.js";

/**
 * PYTHON SYMBOL-REFERENCE EXTRACTION (REC-010, ADR-0015 parity for the ADR-0016
 * Python adapter). Given ONE Python source file `B`, attribute each unambiguous
 * static usage of an imported binding to its ENCLOSING top-level declaration,
 * yielding reverse edges `{ callee: M#foo, caller: B#bar }` — the exact shape
 * `extractSymbolReferences` produces for TS. Pure LEXICAL, built entirely on
 * `toLogicalLines` (strings/f-strings/comments are pre-blanked to the `\x00`
 * sentinel; continuations are pre-joined) — NO AST, NO native/WASM deps
 * (ADR-0016), NO egress, and NEVER throws (`{ edges: [] }` on any doubt, the
 * `LanguageContext.extractReferences` contract).
 *
 * A SYMBOL EDGE IS NEVER WRONG (ADR-0015 §4 / the ADR-0016 cardinal rule). Every
 * emitted edge is backed by (i) a resolved INTRA-REPO import binding to a PLAIN
 * module file (never an `__init__.py`), (ii) an unambiguous STATIC name usage,
 * (iii) a SINGLE enclosing top-level declaration. Any ambiguity DEGRADES to no
 * symbol edge — the already-correct module import edge covers it:
 *   - `from X import *`, a `;` multi-statement line, `exec(` / `globals()` →
 *     the WHOLE file degrades (unknown names / broken line-scope model);
 *   - a from-import resolving to an `__init__.py` (barrel / `__all__` re-export /
 *     submodule-vs-attribute ambiguity) → no binding;
 *   - unaliased `import a.b` → no binding (dotted-chain attribution is ambiguous
 *     between package attributes and submodules, the TS namespace analog);
 *   - a NON-column-0 import (`if TYPE_CHECKING:`, `try/except ImportError`,
 *     function-local) binds conditionally/locally → no binding, and it POISONS a
 *     same-named top-level binding;
 *   - SHADOWING — `def`/`class` names at ANY indent, any word left of a depth-0
 *     `=` (assignment / tuple / chained / annotated / subscript / monkey-patch
 *     LHS), walrus targets, `as N`, `for N in`, def/lambda params, `global` /
 *     `nonlocal` / `del` — poisons the binding MODULE-WIDE (coarser than the TS
 *     scoped poison, recall-only loss, never a wrong edge);
 *   - duplicate local bindings, external/unresolvable imports, dynamic attribute
 *     access (bare alias, `getattr(m, …)`, `m["k"]`), `#` in either module path
 *     → no edge.
 *
 * ID-NAMING CONTRACT (there is no Python `extractSymbolDefs` yet — a future
 * Python capture MUST mirror this so referencer ids fuse against captured ids,
 * the TS agreement pin is `symbol-refs-eval.test.ts`):
 *   - `def name(...)` / `async def name(...)` → `<module>#name`;
 *   - `class Name(...)` → `<module>#Name`;
 *   - top-level single-target assignment `NAME = …` (optionally annotated) →
 *     `<module>#NAME`.
 * Nested defs / class methods / loop bodies attribute to the enclosing TOP-LEVEL
 * declaration (ADR-0012 Decision-1), tracked by column-0 lines only.
 *
 * F-1: BOTH sides of every edge are produced by the single
 * `toWorkspaceRelativePosix` canonicalizer (the caller `module` is passed in
 * pre-canonicalized; the callee module is canonicalized from the resolver hit).
 */

// ── lexical helpers ───────────────────────────────────────────────────────────

/** Python hard keywords — never a symbol name, never an assignment target we id. */
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const IDENT_RE = /^[A-Za-z_]\w*$/;
const DOTTED_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

type Tok = { text: string; start: number; end: number };

/** Whole-word identifier tokens of one logical line. A token is skipped when a
 *  NEIGHBOURING char is a word char (`1e5` → `e5` is not a word start) OR is
 *  non-ASCII (MEDIUM-1: the ASCII regex fragments a unicode identifier, so
 *  `Ωhelper`/`helperΩ` would otherwise surface a bare `helper` — any char with
 *  code > 127 is treated as a word char for boundary purposes; skip = no edge). */
function tokensOf(line: string): Tok[] {
  const out: Tok[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const before = m.index > 0 ? line[m.index - 1] : "";
    const after = line[m.index + m[0].length] ?? "";
    if (before && (/\w/.test(before) || before.charCodeAt(0) > 127)) {
      continue;
    }
    // The greedy regex already consumed trailing ASCII word chars, so `after`
    // can only break a word when it is non-ASCII.
    if (after && after.charCodeAt(0) > 127) {
      continue;
    }
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Bracket depth BEFORE consuming each char (an open bracket sits at its outer
 *  depth; its matching close is assigned the same depth). Clamped at 0. */
function depthsOf(line: string): number[] {
  const depths = new Array<number>(line.length);
  let d = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "(" || c === "[" || c === "{") {
      depths[i] = d;
      d += 1;
    } else if (c === ")" || c === "]" || c === "}") {
      d = Math.max(0, d - 1);
      depths[i] = d;
    } else {
      depths[i] = d;
    }
  }
  return depths;
}

function nextNonSpace(line: string, i: number): number {
  let j = i;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) {
    j += 1;
  }
  return j;
}

function prevNonSpace(line: string, i: number): number {
  let j = i;
  while (j >= 0 && (line[j] === " " || line[j] === "\t")) {
    j -= 1;
  }
  return j;
}

/** Is this trimmed logical line an import statement (the same anchoring as
 *  `extractImports`, so a binding can only exist where a module edge exists)? */
function importKind(trimmed: string): "import" | "from" | null {
  if (trimmed.startsWith("import ") || trimmed.startsWith("import\t")) {
    return "import";
  }
  if (trimmed.startsWith("from ") || trimmed.startsWith("from\t")) {
    return "from";
  }
  return null;
}

type FromMember = { imported: string; local: string };
type FromParse =
  | { kind: "none" }
  | {
      kind: "members";
      relativeLevel: number;
      specifier: string;
      members: FromMember[];
    };

/**
 * Self-contained from-import binding parser (deliberately NOT `parseFrom` /
 * `parseMembers`, which drop `as` aliases). A member token that does not match
 * `name` / `name as alias` contributes no binding (skip = no edge, safe).
 * `*` members are handled by the whole-file degrade BEFORE this runs.
 */
function parseFromBinding(trimmed: string): FromParse {
  const rest = trimmed.slice("from".length).replace(/^[ \t]+/, "");
  const sep = /\bimport\b/.exec(rest);
  if (!sep) {
    return { kind: "none" };
  }
  const head = rest.slice(0, sep.index).trim();
  let memberPart = rest.slice(sep.index + "import".length).trim();
  const dots = /^(\.*)([\s\S]*)$/.exec(head)!;
  const relativeLevel = dots[1].length;
  const specifier = dots[2].trim();
  if (relativeLevel === 0 && !specifier) {
    return { kind: "none" };
  }
  if (specifier && !DOTTED_RE.test(specifier)) {
    return { kind: "none" };
  }
  if (memberPart.startsWith("(")) {
    memberPart = memberPart.slice(1);
  }
  if (memberPart.endsWith(")")) {
    memberPart = memberPart.slice(0, -1);
  }
  const members: FromMember[] = [];
  for (const raw of memberPart.split(",")) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const m = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(token);
    if (!m) {
      continue; // malformed member → no binding for it (never a wrong edge)
    }
    members.push({ imported: m[1], local: m[2] ?? m[1] });
  }
  return { kind: "members", relativeLevel, specifier, members };
}

type PlainImportItem = { dotted: string; alias: string | null };

/** `import a.b as c, d` → per-item `{dotted, alias}`; malformed items skipped. */
function parseImportBinding(trimmed: string): PlainImportItem[] {
  const rest = trimmed.slice("import".length);
  const out: PlainImportItem[] = [];
  for (const raw of rest.split(",")) {
    const item = raw.trim();
    if (!item) {
      continue;
    }
    const toks = item.split(/\s+/);
    if (!DOTTED_RE.test(toks[0])) {
      continue;
    }
    if (toks.length === 3 && toks[1] === "as" && IDENT_RE.test(toks[2])) {
      out.push({ dotted: toks[0], alias: toks[2] });
    } else if (toks.length === 1) {
      out.push({ dotted: toks[0], alias: null });
    }
    // anything else (e.g. `a as`) → malformed → skip (no binding, no edge)
  }
  return out;
}

/** The local names a (possibly indented) import line binds at runtime — used for
 *  duplicate detection and for poisoning from conditional/local imports. */
function importBoundLocals(kind: "import" | "from", trimmed: string): string[] {
  if (kind === "from") {
    const parsed = parseFromBinding(trimmed);
    return parsed.kind === "members" ? parsed.members.map((m) => m.local) : [];
  }
  return parseImportBinding(trimmed).map((it) =>
    it.alias !== null ? it.alias : it.dotted.split(".")[0]
  );
}

/** Column-0 = a top-level statement (the whole line-shaped scope model keys on
 *  this). The blanked-string sentinel can never lead an import/def/class line. */
function isColumnZero(line: string): boolean {
  return line.length > 0 && line[0] !== " " && line[0] !== "\t";
}

/** Valid Python string-prefix letters; a prefix that contains `f`/`F` is an
 *  f-string (`f`, `rf`, `Rf`, `fr`, `FR`, …). */
const STRING_PREFIX_CHARS = new Set(["r", "R", "b", "B", "f", "F", "u", "U"]);

/**
 * HIGH-1 (PEP 701, Python 3.12+): a SAME-QUOTE nested f-string (`f"{"x"}"`)
 * inverts `toLogicalLines`' quote pairing, so a string-literal interior can leak
 * out as CODE tokens and mint a wrong edge. Conservative detector over the RAW
 * source (comments/strings walked exactly as `toLogicalLines` does): flag ANY
 * f/F-prefixed string whose body contains a `{` before its closing quote. When
 * present the WHOLE file degrades to module level (the always-correct import edge
 * stands). Plain braced f-strings degrade too — precision over recall — while
 * plain f-strings with NO brace (`f"hello"`) and every non-f string are
 * untouched (recall-only, never a wrong edge).
 */
function hasFStringInterpolation(source: string): boolean {
  // Is the string opening at `quoteIndex` f/F-prefixed? Walk back over the (≤2)
  // prefix letters; a non-prefix letter or a word char hugging the run means it
  // is an identifier abutting a string (`if"x"`), not a prefix.
  const isFPrefixed = (quoteIndex: number): boolean => {
    let k = quoteIndex - 1;
    let letters = 0;
    let hasF = false;
    while (k >= 0 && /[A-Za-z]/.test(source[k])) {
      if (!STRING_PREFIX_CHARS.has(source[k])) {
        return false;
      }
      if (source[k] === "f" || source[k] === "F") {
        hasF = true;
      }
      letters += 1;
      k -= 1;
    }
    if (letters === 0 || letters > 2 || (k >= 0 && /\w/.test(source[k]))) {
      return false;
    }
    return hasF;
  };

  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "#") {
      while (i < n && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const isF = isFPrefixed(i);
      const triple = source.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        i += 3;
        while (i < n) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (isF && source[i] === "{") {
            return true;
          }
          if (source.slice(i, i + 3) === triple) {
            i += 3;
            break;
          }
          i += 1;
        }
      } else {
        i += 1;
        while (i < n) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (isF && source[i] === "{") {
            return true;
          }
          if (source[i] === c) {
            i += 1;
            break;
          }
          if (source[i] === "\n") {
            break; // unterminated single-line string → bail (degrade-safe)
          }
          i += 1;
        }
      }
      continue;
    }
    i += 1;
  }
  return false;
}

// ── the extractor ─────────────────────────────────────────────────────────────

export function extractPythonSymbolReferences(
  source: string,
  module: string,
  fromFile: string,
  root: string,
  exists: PathExists
): SymbolReferenceResult {
  // A module path with `#` (our id delimiter) cannot host well-formed symbol ids
  // → this file degrades to MODULE-level (mirrors `extractSymbolReferences`).
  if (module.includes("#")) {
    return { edges: [] };
  }
  try {
    // HIGH-1 (PEP 701): a same-quote nested f-string can leak string interiors
    // as code tokens → if ANY f-string interpolates (`{` before its close),
    // degrade the WHOLE file (the module import edge is still correct).
    if (hasFStringInterpolation(source)) {
      return { edges: [] };
    }
    const lines = toLogicalLines(source);

    // ── WHOLE-FILE degrade triggers (module edges from `extractImports` stand) ──
    for (const line of lines) {
      // `;` multi-statement lines break the one-logical-line-per-statement model.
      if (line.includes(";")) {
        return { edges: [] };
      }
      // `exec(` / `globals()` can rebind module globals → attribution unsafe.
      if (/\bexec\s*\(/.test(line) || /\bglobals\s*\(\s*\)/.test(line)) {
        return { edges: [] };
      }
      const trimmed = line.trim();
      if (importKind(trimmed) === "from") {
        // Star import at ANY indent, ANY resolvability → unknown names in scope.
        const rest = trimmed.slice("from".length);
        const sep = /\bimport\b/.exec(rest);
        if (sep && rest.slice(sep.index + "import".length).includes("*")) {
          return { edges: [] };
        }
      }
    }

    // ── Phase A: bindings (column-0 imports only) + duplicate/poison sets ─────
    // local name → callee symbol id (`from X import y [as z]`, X a plain module).
    const fromBinding = new Map<string, string>();
    // alias → callee MODULE path (`import x.y as m`, x/y.py a plain module).
    const aliasBinding = new Map<string, string>();
    const poisoned = new Set<string>();
    const boundOnce = new Set<string>();

    // Register an import-bound local. Duplicate anywhere (from/alias/unaliased-
    // top-name, cross-map) → order/flow-sensitive rebinding → poison the name.
    const registerLocal = (local: string): boolean => {
      if (boundOnce.has(local)) {
        poisoned.add(local);
        return false;
      }
      boundOnce.add(local);
      return true;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const kind = importKind(trimmed);
      if (!kind) {
        continue;
      }
      if (!isColumnZero(line)) {
        // Conditional / local import: binds conditionally → NO symbol binding,
        // and it POISONS any same-named top-level binding (rebinding hazard).
        for (const local of importBoundLocals(kind, trimmed)) {
          poisoned.add(local);
        }
        continue;
      }
      if (kind === "from") {
        const parsed = parseFromBinding(trimmed);
        if (parsed.kind !== "members") {
          continue;
        }
        // Resolve the source module once for the whole member list.
        const abs = resolvePythonImport(
          root,
          fromFile,
          { specifier: parsed.specifier, relativeLevel: parsed.relativeLevel },
          exists
        );
        let calleeModule: string | null = null;
        // `__init__.py` = the barrel/`__all__`/submodule-vs-attribute ambiguity
        // → degrade (the resolver already conservatively returns the package).
        if (abs !== null && path.basename(abs) !== "__init__.py") {
          const mod = toWorkspaceRelativePosix(root, abs);
          if (mod !== null && !mod.includes("#")) {
            calleeModule = mod;
          }
        }
        for (const member of parsed.members) {
          const fresh = registerLocal(member.local);
          if (!fresh || calleeModule === null) {
            continue;
          }
          const callee = toSymbolId(calleeModule, member.imported);
          if (callee !== null) {
            fromBinding.set(member.local, callee);
          }
        }
      } else {
        for (const item of parseImportBinding(trimmed)) {
          if (item.alias !== null) {
            if (!registerLocal(item.alias)) {
              continue;
            }
            const abs = resolvePythonImport(
              root,
              fromFile,
              { specifier: item.dotted, relativeLevel: 0 },
              exists
            );
            if (abs === null || path.basename(abs) === "__init__.py") {
              continue; // package alias: `p.attr` may be a submodule → degrade
            }
            const mod = toWorkspaceRelativePosix(root, abs);
            if (mod === null || mod.includes("#")) {
              continue;
            }
            aliasBinding.set(item.alias, mod);
          } else {
            // Unaliased `import a.b` binds the TOP name `a` at runtime: no
            // symbol binding (dotted-chain ambiguity), but it participates in
            // duplicate detection so `from m import a` + `import a.b` poisons.
            registerLocal(item.dotted.split(".")[0]);
          }
        }
      }
    }

    // ── Phase A': the shadow-poison scan (every non-import logical line) ──────
    const isBound = (w: string): boolean =>
      fromBinding.has(w) || aliasBinding.has(w);

    if (fromBinding.size > 0 || aliasBinding.size > 0) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || importKind(trimmed)) {
          continue;
        }
        const toks = tokensOf(line);
        if (toks.length === 0) {
          continue;
        }
        const depths = depthsOf(line);

        // MEDIUM-3: bound the per-line quadratic poison work. Each depth-0 `=`,
        // walrus, `for`, or `lambda` trigger rescans EVERY token below; a
        // synthetic pathological logical line (thousands of each) could pin the
        // scan. If the worst-case (triggers × tokens) blows a generous ceiling,
        // degrade the WHOLE file rather than hang (the module edge stands).
        let triggers = 0;
        for (let i = 0; i < line.length; i += 1) {
          if (line[i] === "=" && depths[i] === 0) {
            triggers += 1;
          } else if (line[i] === ":" && line[i + 1] === "=") {
            triggers += 1;
          }
        }
        for (const _m of line.matchAll(/\b(?:for|lambda)\b/g)) {
          triggers += 1;
        }
        if (triggers * toks.length > 1_000_000) {
          return { edges: [] };
        }

        // HIGH-2 (PEP 634 match/case): `case <pattern>:` BINDS its capture names,
        // shadowing an imported binding. Coarsely poison every bound word on any
        // `case …:` logical line (recall-only; a `match` subject binds nothing).
        if (/^case\b.*:/.test(trimmed)) {
          for (const t of toks) {
            if (isBound(t.text)) {
              poisoned.add(t.text);
            }
          }
        }

        // def/class NAME at ANY indent (class-body vs method-body is unknowable
        // without scopes → deliberately coarser than the TS method rule).
        for (const m of line.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)) {
          if (isBound(m[1])) {
            poisoned.add(m[1]);
          }
        }

        // Every depth-0 `=` (not ==/!=/<=/>=; aug-assign INCLUDED) poisons every
        // bound word to its LEFT: assignment / tuple / chained / annotated /
        // subscript targets AND `alias.attr = x` monkey-patching.
        for (let i = 0; i < line.length; i += 1) {
          if (line[i] !== "=" || depths[i] !== 0) {
            continue;
          }
          if (line[i + 1] === "=") {
            i += 1; // `==` → skip both chars
            continue;
          }
          const prev = line[i - 1];
          if (prev === "=" || prev === "!") {
            continue; // `==` / `!=`
          }
          // `<=` / `>=` are comparisons (skip), but `<<=` / `>>=` are augmented
          // ASSIGNMENTS (MEDIUM-2) and MUST poison their target.
          if ((prev === "<" || prev === ">") && line[i - 2] !== prev) {
            continue;
          }
          for (const t of toks) {
            if (t.end <= i && isBound(t.text)) {
              poisoned.add(t.text);
            }
          }
        }

        // Walrus target (any depth): the word immediately before `:=`.
        for (let i = 0; i + 1 < line.length; i += 1) {
          if (line[i] === ":" && line[i + 1] === "=") {
            const p = prevNonSpace(line, i - 1);
            for (const t of toks) {
              if (t.end === p + 1 && isBound(t.text)) {
                poisoned.add(t.text);
              }
            }
          }
        }

        // `as NAME` on non-import lines (`with` / `except`).
        for (const m of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) {
          if (isBound(m[1])) {
            poisoned.add(m[1]);
          }
        }

        // Loop / comprehension targets: bound words between `for` and its `in`
        // (to end-of-line when no `in` follows — coarse, safe).
        for (const m of line.matchAll(/\bfor\b/g)) {
          const start = m.index! + "for".length;
          const inM = /\bin\b/.exec(line.slice(start));
          const end = inM ? start + inM.index : line.length;
          for (const t of toks) {
            if (t.start >= start && t.end <= end && isBound(t.text)) {
              poisoned.add(t.text);
            }
          }
        }

        // def PARAM names: each depth-relative-0 comma segment's leading
        // identifier (after `*`/`**`). Annotation/default words in the segment
        // stay eligible as references (`def bar(x: Helper)` captures Helper).
        for (const m of line.matchAll(/\bdef\s+[A-Za-z_]\w*\s*\(/g)) {
          const open = m.index! + m[0].length - 1;
          const base = depths[open];
          let close = line.length;
          for (let j = open + 1; j < line.length; j += 1) {
            if (line[j] === ")" && depths[j] === base) {
              close = j;
              break;
            }
          }
          let segStart = open + 1;
          const segments: string[] = [];
          for (let j = open + 1; j < close; j += 1) {
            if (line[j] === "," && depths[j] === base + 1) {
              segments.push(line.slice(segStart, j));
              segStart = j + 1;
            }
          }
          segments.push(line.slice(segStart, close));
          for (const seg of segments) {
            const pm = /^[\s*]*([A-Za-z_]\w*)/.exec(seg);
            if (pm && isBound(pm[1])) {
              poisoned.add(pm[1]);
            }
          }
        }

        // lambda params: ALL bound words between `lambda` and its `:` (coarse).
        for (const m of line.matchAll(/\blambda\b/g)) {
          const start = m.index! + "lambda".length;
          const base = depths[m.index!];
          let colon = line.length;
          for (let j = start; j < line.length; j += 1) {
            if (line[j] === ":" && depths[j] === base) {
              colon = j;
              break;
            }
          }
          for (const t of toks) {
            if (t.start >= start && t.end <= colon && isBound(t.text)) {
              poisoned.add(t.text);
            }
          }
        }

        // `global` / `nonlocal` / `del`: poison every bound word on the line.
        if (/^(?:global|nonlocal|del)\b/.test(trimmed)) {
          for (const t of toks) {
            if (isBound(t.text)) {
              poisoned.add(t.text);
            }
          }
        }
      }
    }

    for (const name of poisoned) {
      fromBinding.delete(name);
      aliasBinding.delete(name);
    }
    if (fromBinding.size === 0 && aliasBinding.size === 0) {
      return { edges: [] }; // nothing unambiguous to attribute
    }

    // ── Phase B: enclosing-declaration tracking + candidate collection ────────
    const candidates: SymbolReference[] = [];

    /** Collect the callee ids referenced on ONE logical line (bound names only,
     *  whole-word, sentinel-safe). */
    const collectCallees = (line: string): string[] => {
      const out: string[] = [];
      const toks = tokensOf(line);
      if (toks.length === 0) {
        return out;
      }
      const depths = depthsOf(line);
      for (const t of toks) {
        // A string PREFIX (`f"…"`, `r"…"`) sits flush against the blanked
        // sentinel — it is not a name reference.
        if (line[t.end] === "\x00") {
          continue;
        }
        // Attribute NAME-side (`x.foo` → foo) is not the binding.
        const pi = prevNonSpace(line, t.start - 1);
        if (pi >= 0 && line[pi] === ".") {
          continue;
        }
        if (fromBinding.has(t.text)) {
          // Keyword-argument NAME `f(N=1)` (a single `=` at depth > 0) is a
          // name position, not a reference (the TS object-key analog).
          const ni = nextNonSpace(line, t.end);
          if (
            ni < line.length &&
            line[ni] === "=" &&
            line[ni + 1] !== "=" &&
            depths[ni] > 0
          ) {
            continue;
          }
          out.push(fromBinding.get(t.text)!);
        } else if (aliasBinding.has(t.text)) {
          // Module alias: ONLY a static `.identifier` access is a symbol edge
          // (first segment). A bare alias / getattr / subscript emits nothing.
          const ni = nextNonSpace(line, t.end);
          if (ni >= line.length || line[ni] !== ".") {
            continue;
          }
          const ai = nextNonSpace(line, ni + 1);
          const am = /^[A-Za-z_]\w*/.exec(line.slice(ai));
          if (!am) {
            continue;
          }
          const callee = toSymbolId(aliasBinding.get(t.text)!, am[0]);
          if (callee !== null) {
            out.push(callee);
          }
        }
      }
      return out;
    };

    /** The enclosing id for a column-0 single-simple-target assignment, or null
     *  for tuple/chained/attribute/subscript targets and non-assignments. */
    const simpleAssignTarget = (line: string): string | null => {
      const m = /^([A-Za-z_]\w*)/.exec(line);
      if (!m || PY_KEYWORDS.has(m[1])) {
        return null;
      }
      const depths = depthsOf(line);
      let i = nextNonSpace(line, m[1].length);
      if (line[i] === ":") {
        if (line[i + 1] === "=") {
          return null; // statement-level walrus (invalid Python) → degrade
        }
        // Skip the annotation to the first depth-0 assignment `=`.
        let eq = -1;
        for (let j = i + 1; j < line.length; j += 1) {
          if (line[j] !== "=" || depths[j] !== 0) {
            continue;
          }
          if (line[j + 1] === "=") {
            j += 1;
            continue;
          }
          const prev = line[j - 1];
          if (prev === "=" || prev === "!") {
            continue;
          }
          if ((prev === "<" || prev === ">") && line[j - 2] !== prev) {
            continue; // `<=` / `>=` comparison (but `<<=` / `>>=` are aug-assign)
          }
          eq = j;
          break;
        }
        if (eq === -1) {
          return null; // bare annotation, no `=` → not a declaration we id
        }
        i = eq;
      }
      // MEDIUM-2: `NAME <<= …` / `NAME >>= …` (depth-0 shift-assign) targets NAME.
      if (
        (line[i] === "<" || line[i] === ">") &&
        line[i + 1] === line[i] &&
        line[i + 2] === "=" &&
        depths[i] === 0
      ) {
        return toSymbolId(module, m[1]);
      }
      if (line[i] !== "=" || line[i + 1] === "=" || depths[i] !== 0) {
        return null;
      }
      return toSymbolId(module, m[1]);
    };

    let enclosing: string | null = null;
    let pendingDecoratorCallees: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue; // blank / comment-only lines never change the scope model
      }
      const column0 = isColumnZero(line);
      if (importKind(trimmed)) {
        // Import lines are NEVER scanned for candidates; a top-level import is
        // a plain statement (resets the enclosing decl, drops pending decorators).
        if (column0) {
          enclosing = null;
          pendingDecoratorCallees = [];
        }
        continue;
      }
      if (!column0) {
        // Indented line: attribute to the current top-level decl (null → drop).
        if (enclosing !== null) {
          for (const callee of collectCallees(line)) {
            candidates.push({ callee, caller: enclosing });
          }
        }
        continue;
      }
      // Column-0 dispatch.
      if (trimmed.startsWith("@")) {
        // Decorator: buffer its references for the NEXT column-0 def/class.
        pendingDecoratorCallees.push(...collectCallees(line));
        enclosing = null;
        continue;
      }
      const declM = /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (declM) {
        const id = toSymbolId(module, declM[1]);
        enclosing = id;
        if (id !== null) {
          for (const callee of pendingDecoratorCallees) {
            candidates.push({ callee, caller: id });
          }
          // The decl line itself: base classes, metaclass values, annotations,
          // defaults — attributed to the declared id.
          for (const callee of collectCallees(line)) {
            candidates.push({ callee, caller: id });
          }
        }
        pendingDecoratorCallees = [];
        continue;
      }
      pendingDecoratorCallees = [];
      const assignId = simpleAssignTarget(line);
      if (assignId !== null) {
        // `NAME = …`: references on THIS line only attribute to module#NAME.
        for (const callee of collectCallees(line)) {
          candidates.push({ callee, caller: assignId });
        }
        enclosing = null;
        continue;
      }
      // Any other top-level statement: no enclosing id, no candidates.
      enclosing = null;
    }

    // ── Phase C: dedupe + emit ─────────────────────────────────────────────────
    const seen = new Set<string>();
    const edges: SymbolReference[] = [];
    for (const cand of candidates) {
      const key = `${cand.callee} ${cand.caller}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push(cand);
    }
    return { edges };
  } catch {
    // Anything unexpected → no symbol layer for this file (never throws).
    return { edges: [] };
  }
}
