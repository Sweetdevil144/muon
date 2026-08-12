import ts from "typescript";
import { toSymbolId } from "./paths.js";

/**
 * SYMBOL DEFINITION EXTRACTION (ADR-0012 Decision 4, Phase 2), collect the
 * EXPORTED / top-level named declarations of one source file as `<module>#<name>`
 * symbol ids. Like the import scanner (`ts.preProcessFile`), this is PURE JS with
 * NO `Program`, NO typecheck, NO native/WASM deps, just `ts.createSourceFile`
 * with `setParentNodes=false`. It never throws (→ `[]` on any parse error, the
 * same contract as `extractImportSpecifiers`).
 *
 * v1 collects only cross-module-relevant, cheaply-extractable definitions:
 *   - `export function` / `export class` / `export interface` / `export type` /
 *     `export enum` (and their top-level non-exported siblings, a local symbol
 *     degrades to its module, so including top-level names is harmless).
 *   - `export const/let/var` binding names (incl. simple destructuring names).
 *   - `export { a, b as c }` re-export specifiers (the EXPORTED name).
 *   - default exports collapse to the name `default`.
 *
 * OVERLOADS collapse to ONE id (name-based), two `function foo` overload
 * signatures yield a single `module#foo` (ADR-0012 §Overloads). METHODS are NOT
 * emitted as top-level symbols in v1 (a method edit degrades to its class/module);
 * the `#Class.method` form is reserved for the explicit-capture / GitNexus paths.
 */

export type SymbolDef = {
  /** The workspace-relative POSIX module the symbol is defined in (the caller
   *  supplies it, ALREADY canonicalized by `toWorkspaceRelativePosix`). */
  module: string;
  /** The bare symbol name (may be `default`). */
  name: string;
  /** A coarse kind tag (function|class|interface|type|enum|variable|reexport). */
  kind: string;
  /** The composed `<module>#<name>` id. */
  id: string;
};

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: readonly ts.ModifierLike[] }).modifiers;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

/** Collect binding names from a (possibly destructured) VariableDeclaration name. */
function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  // Array/object binding pattern → each element's name (best-effort, top level).
  const elements = (name as ts.BindingPattern).elements;
  for (const element of elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, out);
    }
  }
}

/**
 * Extract the exported/top-level symbol definitions of `sourceText`, mapped into
 * the `module` namespace (the caller passes the workspace-relative POSIX module).
 * Deduplicated by name (overloads collapse). Never throws.
 */
export function extractSymbolDefs(
  sourceText: string,
  module: string
): SymbolDef[] {
  // A module path with `#` (a legal POSIX filename char AND our id delimiter)
  // cannot host well-formed symbol ids → emit NO symbol anchors (the file degrades
  // to MODULE-level). Guard once for the whole file (mirrors toSymbolId's decline).
  if (module.includes("#")) {
    return [];
  }
  const defs = new Map<string, SymbolDef>();
  const add = (name: string, kind: string) => {
    if (!name || defs.has(name)) {
      return;
    }
    const id = toSymbolId(module, name);
    if (id === null) {
      return; // defensive, the module was already guarded above
    }
    defs.set(name, { module, name, kind, id });
  };

  try {
    const sf = ts.createSourceFile(
      "f.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      ts.ScriptKind.TSX
    );
    for (const statement of sf.statements) {
      // A `default` export declaration → the `default` name.
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)
      ) {
        const kind = ts.isFunctionDeclaration(statement)
          ? "function"
          : "class";
        if (statement.name) {
          add(statement.name.text, kind);
        } else if (hasExportModifier(statement)) {
          add("default", kind); // `export default function/class () {}`
        }
        continue;
      }
      if (ts.isInterfaceDeclaration(statement)) {
        add(statement.name.text, "interface");
        continue;
      }
      if (ts.isTypeAliasDeclaration(statement)) {
        add(statement.name.text, "type");
        continue;
      }
      if (ts.isEnumDeclaration(statement)) {
        add(statement.name.text, "enum");
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          const names: string[] = [];
          collectBindingNames(decl.name, names);
          for (const name of names) {
            add(name, "variable");
          }
        }
        continue;
      }
      // `export { a, b as c }` / `export { x } from "./m"` → the EXPORTED names.
      if (ts.isExportDeclaration(statement) && statement.exportClause) {
        if (ts.isNamedExports(statement.exportClause)) {
          for (const spec of statement.exportClause.elements) {
            add(spec.name.text, "reexport");
          }
        }
        continue;
      }
      // `export default <expr>` (identifier/other) → the `default` name.
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        add("default", "reexport");
      }
    }
  } catch {
    return [];
  }
  return [...defs.values()];
}
