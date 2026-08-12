import type { ImportRef, LanguageAdapter, LanguageContext } from "../adapter.js";
import { createResolver } from "../resolver.js";
import { extractImportSpecifiers } from "../scanner.js";
import { extractSymbolReferences } from "../symbol-refs.js";
import { loadTsconfigPaths } from "../tsconfig.js";

/**
 * The TS/JS `LanguageAdapter` (ADR-0016 §4), a STRICT no-behavior-change wrapper
 * around CG-1's existing TypeScript pipeline. It owns the only three
 * language-specific concerns the shared indexer/provider used to hard-wire:
 *   - the extension gate (`supports` = the historic `isSupportedSourceFile`);
 *   - import extraction (`ts.preProcessFile` via `extractImportSpecifiers`);
 *   - per-root resolution (`createResolver` + `loadTsconfigPaths`) and the OPTIONAL
 *     symbol-reference layer (`extractSymbolReferences`, ADR-0015, TS-only in v1).
 *
 * `scanner.ts`, `resolver.ts`, `symbol-refs.ts`, `symbols.ts` and `tsconfig.ts` get
 * NO logic change, they simply become this adapter's internals. The `ImportRef`
 * this adapter emits carries only `{ specifier }` (dot-relative levels/members are a
 * Python concern), and the shared loop treats it as OPAQUE, it never inspects the
 * specifier, only `ctx.resolveImport(file, ref)`. Byte-for-byte identical output is
 * the R0 merge gate.
 */

/**
 * Extensions CG-1 treats as intra-repo TS/JS source (scanned + edge targets). The
 * canonical home is the TS adapter (ADR-0016 §4); `paths.ts` RE-EXPORTS both this
 * constant and `isSupportedSourceFile` for back-compat, so every historic import
 * site keeps working unchanged.
 */
export const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** True when `file` looks like an intra-repo TS/JS source file by extension. */
export function isSupportedSourceFile(file: string): boolean {
  const lower = file.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const typescriptAdapter: LanguageAdapter = {
  id: "ts",

  supports(file: string): boolean {
    return isSupportedSourceFile(file);
  },

  extractImports(source: string): ImportRef[] {
    return extractImportSpecifiers(source).map((specifier) => ({ specifier }));
  },

  createContext(root: string): LanguageContext {
    // ONE resolver per root, captured here, shared by BOTH import resolution and
    // the symbol layer, exactly as the pre-ADR-0016 indexer did.
    const resolver = createResolver({ root, tsconfig: loadTsconfigPaths(root) });
    return {
      resolveImport(fromFile: string, ref: ImportRef): string | null {
        return resolver.resolve(fromFile, ref.specifier);
      },
      extractReferences(source: string, module: string, absFile: string) {
        return extractSymbolReferences(source, module, resolver, absFile, root);
      },
    };
  },
};
