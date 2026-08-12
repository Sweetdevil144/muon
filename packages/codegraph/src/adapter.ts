import type { SymbolReferenceResult } from "./symbol-refs.js";
import { typescriptAdapter } from "./adapters/typescript.js";
import { pythonAdapter } from "./adapters/python.js";

/**
 * The `LanguageAdapter` SEAM (ADR-0016 §3). The shared indexer/provider depend on
 * ONLY this module and never import `typescript` or any language module directly.
 * A language contributes exactly two required concerns, per-file `extractImports`
 * and per-root `resolveImport`, plus an OPTIONAL symbol layer (`extractReferences`,
 * TS + Python). Selection is per-file by extension via a registry; extensions are
 * disjoint across adapters, so `select` is deterministic. Edges are intra-language
 * by construction (each resolver probes only its own extensions), so a mixed repo
 * indexes each file with its own adapter and cross-language imports degrade to null.
 */

export interface ImportRef {
  /** Raw specifier as written (dotted for Python, a path/bare id for TS). OPAQUE
   *  to the shared loop, only the emitting adapter's `resolveImport` interprets it. */
  readonly specifier: string;
  /** Dot-relative depth (Python `from ..pkg import x` → 2); 0/undefined = absolute. */
  readonly relativeLevel?: number;
  /** `from X import a, b` names, optional submodule-probing hint (unused in v1). */
  readonly members?: readonly string[];
}

export interface LanguageContext {
  /** Resolve one `ImportRef` (imported from `fromFile`) to an intra-repo absolute
   *  file, or null (external / unresolvable / out-of-root). */
  resolveImport(fromFile: string, ref: ImportRef): string | null;
  /**
   * OPTIONAL symbol-reference layer (ADR-0015). Its ABSENCE is the "module-level
   * only" signal: the indexer skips the symbol block, no file populates
   * `symbolReverse`, and a target returns echo-only `symbols`, no provider branch.
   */
  extractReferences?(
    source: string,
    module: string,
    absFile: string
  ): SymbolReferenceResult;
}

export interface LanguageAdapter {
  /** Stable id: "ts" | "python" | "go". */
  readonly id: string;
  /** Extension gate (replaces the historic `isSupportedSourceFile`). */
  supports(file: string): boolean;
  /** REQUIRED; pure, never throws (→ `[]` on doubt). */
  extractImports(source: string, absFile: string): ImportRef[];
  /** Build the per-ROOT resolution (+ optional symbol) context. */
  createContext(root: string): LanguageContext;
}

export interface AdapterRegistry {
  /** First adapter whose `supports` matches `file`, or null. */
  select(file: string): LanguageAdapter | null;
  /** True when any adapter supports `file`. */
  isSupported(file: string): boolean;
}

class ListRegistry implements AdapterRegistry {
  constructor(private readonly adapters: readonly LanguageAdapter[]) {}

  select(file: string): LanguageAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.supports(file)) {
        return adapter;
      }
    }
    return null;
  }

  isSupported(file: string): boolean {
    return this.select(file) !== null;
  }
}

/** Build a registry over an explicit, ordered adapter list (test injection). */
export function createRegistry(
  adapters: readonly LanguageAdapter[]
): AdapterRegistry {
  return new ListRegistry(adapters);
}

/** The default language order (R1): TS + Python. Extensions are disjoint. */
export const DEFAULT_LANGS = ["ts", "python"] as const;

/**
 * The name→adapter table, resolved LAZILY (at call time, not module-eval) so the
 * `paths.ts` ↔ `adapters/typescript.ts` re-export cycle never hits a TDZ.
 */
function knownAdapters(): Record<string, LanguageAdapter> {
  return { ts: typescriptAdapter, python: pythonAdapter };
}

/**
 * The default registry: `[ts, python]`, overridable via `MUON_CODEGRAPH_LANGS`
 * (comma-separated ids, the reversible rollback lever, mirroring
 * `MUON_CODEGRAPH_DISABLE`). `MUON_CODEGRAPH_LANGS=ts` → TS-only, byte-for-byte
 * today. Unknown ids are ignored.
 */
export function defaultRegistry(
  env: NodeJS.ProcessEnv = process.env
): AdapterRegistry {
  const known = knownAdapters();
  const raw = env.MUON_CODEGRAPH_LANGS?.trim();
  const ids = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_LANGS];
  const seen = new Set<string>();
  const adapters: LanguageAdapter[] = [];
  for (const id of ids) {
    const adapter = known[id];
    if (adapter && !seen.has(id)) {
      seen.add(id);
      adapters.push(adapter);
    }
  }
  return new ListRegistry(adapters);
}
