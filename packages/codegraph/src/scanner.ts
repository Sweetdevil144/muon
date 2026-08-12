import ts from "typescript";

/**
 * The import SCANNER, specifier extraction only, no `Program`, no typecheck
 * (ADR-0011 Decision 2). `ts.preProcessFile` is the sanctioned, dependency-free
 * extractor (`typescript` already ships in the tree). It pulls the string-literal
 * specifiers out of the import prologue of a `.ts/.tsx/.js/.jsx/.mjs/.cjs` file:
 *
 *   - `import x from "spec"` / `import "spec"` / `import type … from "spec"`
 *   - `export … from "spec"` / `export * from "spec"` (barrels)
 *   - `require("spec")` (with `detectJavaScriptImports`)
 *   - `import("spec")` DYNAMIC, but ONLY when the argument is a STRING LITERAL.
 *
 * A dynamic/computed import with a non-literal argument (`import(variable)`,
 * `require(expr)`) yields NO `importedFiles` entry, so it is skipped gracefully
 *, a documented residual (ADR-0011 §Honest residual). Type-only imports ARE
 * counted (safe over-inclusion). Pure function, never throws (→ [] on any error).
 */
export function extractImportSpecifiers(sourceText: string): string[] {
  try {
    // readImportFiles=true (collect import specifiers),
    // detectJavaScriptImports=true (also catch CommonJS `require(...)`).
    const info = ts.preProcessFile(sourceText, true, true);
    const out: string[] = [];
    for (const imported of info.importedFiles) {
      if (imported.fileName) {
        out.push(imported.fileName);
      }
    }
    return out;
  } catch {
    // Malformed source / unexpected TS error → no edges, never fail the scan.
    return [];
  }
}
