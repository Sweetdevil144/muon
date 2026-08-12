import ts from "typescript";
import { toSymbolId, toWorkspaceRelativePosix } from "./paths.js";
import type { Resolver } from "./resolver.js";

/**
 * SYMBOL-REFERENCE EXTRACTION (ADR-0015 CG-1 §3) — the name-based, import-resolved
 * reverse-reference graph. Given ONE source file `B`, it attributes each static
 * usage of an imported binding to its ENCLOSING top-level declaration, yielding
 * reverse edges `{ callee: M#foo, caller: B#bar }` (read: "B#bar references
 * M#foo"). Like every other CG-1 primitive it is PURE JS via `ts.createSourceFile`
 * — NO `Program`, NO typecheck, NO native/WASM deps, NO egress — and NEVER throws
 * (`{ edges: [] }` on any parse error, the same contract as `extractSymbolDefs` /
 * `extractImportSpecifiers`).
 *
 * A SYMBOL EDGE IS NEVER WRONG (ADR-0015 §4). Every emitted edge is backed by
 * (i) a resolved INTRA-REPO import binding, (ii) an unambiguous STATIC name usage,
 * (iii) a SINGLE enclosing top-level declaration. Any ambiguity DEGRADES to no
 * symbol edge — the already-correct module import edge covers it. Concretely:
 *   - namespace/star import (`import * as m`) → no binding for `m.*` (member access
 *     is aliasable/computed) → no symbol edge;
 *   - re-export / barrel → the callee is keyed on the DIRECTLY-imported module, so a
 *     binding imported *from* a barrel never matches the DEFINING module's target id
 *     (degrades to module-level; re-export-chain resolution is a follow-on);
 *   - dynamic/computed `import(expr)` → no import declaration → no binding;
 *   - computed member `x["foo"]` → a StringLiteral, not an Identifier → never a name;
 *   - SHADOWING — any module-local declaration whose bare name collides with an
 *     import binding POISONS that binding (module-wide) so an ambiguous `foo` can
 *     never be mis-attributed;
 *   - same-name across modules — attribution keys on THIS file's `importBinding`
 *     only, so a bare `foo` not imported here is ignored;
 *   - a usage with no enclosing top-level declaration → no symbol edge;
 *   - `#` in the module path → declines (module-level only);
 *   - type-only references ARE attributed (a type reference is a real reference —
 *     safe over-inclusion). Over-skipping is under-inclusion, which is always safe.
 *
 * F-1 (namespace round-trip): BOTH sides of every edge are produced by the single
 * `toWorkspaceRelativePosix` canonicalizer — the caller `module` (passed in) and the
 * callee module (`toWorkspaceRelativePosix(root, resolvedFile)`) — so a referencer
 * id's prefix rides the anchor namespace by construction.
 */

/** A reverse symbol-reference edge: `caller` statically references `callee`. */
export type SymbolReference = {
  /** The referenced symbol id `<module>#<name>` (an intra-repo import binding). */
  callee: string;
  /** The referencing top-level declaration id `<module>#<name>` (this file). */
  caller: string;
};

export type SymbolReferenceResult = {
  edges: SymbolReference[];
};

/** Every declaration node whose `.name` introduces a BARE (identifier-reachable)
 *  binding that could SHADOW an import — the module-local names we poison against.
 *  Deliberately EXCLUDES member names (methods, fields, enum members, signatures):
 *  those are only reachable via `.member`/property access, so they can never shadow
 *  a bare imported identifier — poisoning on them would only cost recall. */
function isBareBindingName(id: ts.Identifier): boolean {
  const p = id.parent as ts.Node | undefined;
  if (!p) {
    return false;
  }
  if (ts.isVariableDeclaration(p) && p.name === id) return true;
  if (ts.isFunctionDeclaration(p) && p.name === id) return true;
  if (ts.isClassDeclaration(p) && p.name === id) return true;
  if (ts.isInterfaceDeclaration(p) && p.name === id) return true;
  if (ts.isTypeAliasDeclaration(p) && p.name === id) return true;
  if (ts.isEnumDeclaration(p) && p.name === id) return true;
  if (ts.isParameter(p) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.name === id) return true;
  if (ts.isFunctionExpression(p) && p.name === id) return true;
  if (ts.isClassExpression(p) && p.name === id) return true;
  if (ts.isTypeParameterDeclaration(p) && p.name === id) return true;
  if (ts.isModuleDeclaration(p) && p.name === id) return true;
  return false;
}

/** True when `id` is the NAME position of ANY declaration/member/key/specifier —
 *  i.e. NOT a value/type REFERENCE. The complement (plus the property/label skips
 *  below) is the "reference position" §3(c) attributes. Over-broad here = fewer
 *  edges = safe under-inclusion. */
function isDeclarationNameAny(id: ts.Identifier): boolean {
  const p = id.parent as ts.Node | undefined;
  if (!p) {
    return false;
  }
  if (isBareBindingName(id)) return true;
  // Member / signature / accessor NAMES — reachable only via property access, so
  // never a bare-identifier reference to the import binding.
  if (ts.isPropertyDeclaration(p) && p.name === id) return true;
  if (ts.isMethodDeclaration(p) && p.name === id) return true;
  if (ts.isGetAccessorDeclaration(p) && p.name === id) return true;
  if (ts.isSetAccessorDeclaration(p) && p.name === id) return true;
  if (ts.isPropertySignature(p) && p.name === id) return true;
  if (ts.isMethodSignature(p) && p.name === id) return true;
  if (ts.isEnumMember(p) && p.name === id) return true;
  // BindingElement `.propertyName` is the SOURCE key of `{ a: b }`, not a value ref.
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  return false;
}

/**
 * True when `id` (whose text is a known import binding) sits in a genuine
 * value/type REFERENCE position — the §3(c) inclusion rule. Skips: the property
 * side of a `PropertyAccessExpression` / qualified type name (member access is
 * NOT a reference to the binding); object-literal / JSX-attribute KEYS; every
 * declaration/member/specifier NAME; and statement labels. Object-SHORTHAND
 * `{ foo }` DOES count (the shorthand name IS a value reference).
 */
function isReferencePosition(id: ts.Identifier): boolean {
  const p = id.parent as ts.Node | undefined;
  if (!p) {
    return false;
  }
  // `x.foo` → the `.foo` (name) side is a property, not the binding. The `x`
  // (expression) side falls through and DOES count when `x` is the binding.
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  // Qualified type name `A.B` → the right side is a member, not the binding.
  if (ts.isQualifiedName(p) && p.right === id) return false;
  // Object-literal property KEY `{ foo: ... }` → the key is not a reference.
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  // Object SHORTHAND `{ foo }` → the shorthand name IS a value reference. COUNT.
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return true;
  // JSX attribute name → not a reference to a value binding.
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  // import/export specifiers & clauses (defensive — those subtrees are skipped).
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p)
  ) {
    return false;
  }
  // Any declaration/member NAME is a binding introduction, not a reference.
  if (isDeclarationNameAny(id)) return false;
  // Statement labels are not value references.
  if (ts.isLabeledStatement(p) && p.label === id) return false;
  if (
    (ts.isBreakStatement(p) || ts.isContinueStatement(p)) &&
    p.label === id
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve a single import specifier's bound local names to their `<module>#<name>`
 * callee ids, mutating `importBinding`. ONLY intra-repo, statically-resolvable
 * NAMED / DEFAULT bindings are recorded — namespace (`* as m`) imports contribute
 * NO binding (member access is aliasable), and an external/unresolved specifier is
 * absent (never attributed).
 */
function collectImportBindings(
  node: ts.ImportDeclaration,
  resolver: Resolver,
  fromFile: string,
  root: string,
  importBinding: Map<string, string>
): void {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return; // computed/odd specifier → no binding
  }
  const clause = node.importClause;
  if (!clause) {
    return; // bare `import "./m"` → side-effect only, no binding
  }
  const resolved = resolver.resolve(fromFile, node.moduleSpecifier.text);
  if (!resolved) {
    return; // external / unresolved → never attributed
  }
  const calleeModule = toWorkspaceRelativePosix(root, resolved);
  if (calleeModule === null || calleeModule.includes("#")) {
    return; // outside root / `#` in path → module-level only
  }
  const bind = (localName: string, importedName: string) => {
    if (!localName) {
      return;
    }
    const callee = toSymbolId(calleeModule, importedName);
    if (callee !== null) {
      importBinding.set(localName, callee);
    }
  };
  // `import Def from "./m"` → local `Def` → `M#default`.
  if (clause.name) {
    bind(clause.name.text, "default");
  }
  const named = clause.namedBindings;
  if (named && ts.isNamedImports(named)) {
    for (const spec of named.elements) {
      // `import { foo }` → foo→M#foo; `import { foo as f }` → f→M#foo.
      const importedName = (spec.propertyName ?? spec.name).text;
      bind(spec.name.text, importedName);
    }
  }
  // `import * as m` (NamespaceImport) contributes NO binding — degrade to module.
}

/**
 * Extract the reverse symbol-reference edges of ONE source file. `module` is this
 * file's ALREADY-canonicalized workspace-relative POSIX path (the caller side of
 * every edge); `fromFile` is its absolute path (for import resolution); `root` is
 * the repo root (for canonicalizing resolved callee files). Never throws.
 *
 * ONE PARSE feeds both the top-level decl/span extraction (a) and the usage
 * attribution (c): a single `ts.createSourceFile` with `setParentNodes=true`
 * (needed for the position checks). No `Program`, no native deps.
 */
export function extractSymbolReferences(
  sourceText: string,
  module: string,
  resolver: Resolver,
  fromFile: string,
  root: string
): SymbolReferenceResult {
  // A module path with `#` (our id delimiter) cannot host well-formed symbol ids →
  // this file emits NO symbol edges (it degrades to MODULE-level). Mirrors
  // `extractSymbolDefs` / `toSymbolId`.
  if (module.includes("#")) {
    return { edges: [] };
  }
  try {
    const sf = ts.createSourceFile(
      "f.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TSX
    );

    // (b) Resolve import bindings first (they drive both attribution AND the
    //     shadow-poison set).
    const importBinding = new Map<string, string>();
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) {
        collectImportBindings(
          statement,
          resolver,
          fromFile,
          root,
          importBinding
        );
      }
    }
    if (importBinding.size === 0) {
      return { edges: [] }; // nothing intra-repo to attribute
    }

    // (a) + (c) ONE descent: collect module-local bare-binding names (shadow set)
    //     AND candidate usages tagged with their ENCLOSING top-level decl id.
    const localNames = new Set<string>();
    const candidates: { name: string; caller: string }[] = [];

    const visit = (node: ts.Node, enclosing: string | null): void => {
      // Don't descend into import/export-from declarations: no value usages, and
      // their identifiers are bindings/specifiers (never references to attribute).
      if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isExportDeclaration(node)
      ) {
        return;
      }
      if (ts.isIdentifier(node)) {
        if (isBareBindingName(node)) {
          localNames.add(node.text);
        } else if (
          enclosing &&
          importBinding.has(node.text) &&
          isReferencePosition(node)
        ) {
          candidates.push({ name: node.text, caller: enclosing });
        }
        return;
      }
      ts.forEachChild(node, (child) => visit(child, enclosing));
    };

    for (const statement of sf.statements) {
      dispatchTopLevel(statement, module, visit);
    }

    // SHADOWING poison: any import binding whose bare name is ALSO declared
    // module-locally is ambiguous → drop it (module-wide) before emitting.
    for (const name of localNames) {
      importBinding.delete(name);
    }

    // Emit deduped edges for candidates whose binding SURVIVED the poison.
    const seen = new Set<string>();
    const edges: SymbolReference[] = [];
    for (const cand of candidates) {
      const callee = importBinding.get(cand.name);
      if (!callee) {
        continue; // poisoned / never bound
      }
      const key = `${callee} ${cand.caller}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ callee, caller: cand.caller });
    }
    return { edges };
  } catch {
    // Unsupported syntax / unexpected TS error → no symbol layer for this file.
    return { edges: [] };
  }
}

/**
 * Compute the ENCLOSING top-level declaration id for a statement and descend its
 * body with that enclosing set (nested/local symbols attribute to the top-level
 * decl — ADR-0012 Decision-1 edge rule). Naming MIRRORS `extractSymbolDefs` so a
 * referencer id equals the id capture would have produced for the same decl:
 *   - function/class → its name (anonymous `export default` → `default`);
 *   - interface/type/enum → its name;
 *   - `export const x = …` → the declarator's SINGLE identifier name (a
 *     DESTRUCTURED declarator is ambiguous → enclosing null → no edge);
 *   - `export default <expr>` → `default`;
 *   - anything else at module scope (bare expression, control flow) → null.
 */
function dispatchTopLevel(
  statement: ts.Statement,
  module: string,
  visit: (node: ts.Node, enclosing: string | null) => void
): void {
  if (ts.isVariableStatement(statement)) {
    // Per-declarator enclosing so `const a = foo, b = bar` attributes correctly.
    for (const decl of statement.declarationList.declarations) {
      const enclosing = ts.isIdentifier(decl.name)
        ? toSymbolId(module, decl.name.text)
        : null; // destructuring → ambiguous → degrade
      visit(decl, enclosing);
    }
    return;
  }
  visit(statement, topLevelEnclosingId(statement, module));
}

function topLevelEnclosingId(
  statement: ts.Statement,
  module: string
): string | null {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement)
  ) {
    if (statement.name) {
      return toSymbolId(module, statement.name.text);
    }
    return hasExportModifier(statement) ? toSymbolId(module, "default") : null;
  }
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return toSymbolId(module, statement.name.text);
  }
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    return toSymbolId(module, "default"); // `export default <expr>`
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: readonly ts.ModifierLike[] })
    .modifiers;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
