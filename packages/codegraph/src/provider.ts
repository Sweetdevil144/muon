import fs from "node:fs";
import path from "node:path";
import type { BlastRadius, CodeGraphProvider, EditTarget } from "@muon/graph";
import { type AdapterRegistry, defaultRegistry } from "./adapter.js";
import { reverseClosure, reverseSymbolClosure } from "./closure.js";
import {
  BudgetExceededError,
  type IndexBudget,
  type ReverseImportIndex,
  buildReverseImportIndex,
} from "./indexer.js";
import {
  deriveModulesFromSymbols,
  isRootAllowed,
  isWithin,
  moduleOfSymbol,
  toWorkspaceRelativePosix,
} from "./paths.js";

/**
 * `LocalCodeGraphProvider`, CG-1's in-process implementation of the existing
 * `CodeGraphProvider` seam (`packages/graph/src/code-graph.ts`). Given an
 * `EditTarget`, it returns the transitive reverse-import blast-radius as
 * WORKSPACE-RELATIVE POSIX module paths (`source: "codegraph"`), or `null` on
 * ANY doubt so the hero degrades to today's `target-only` behaviour.
 *
 * DEGRADE-TO-NULL (never fails a hero call): symbol-only target, an unresolvable
 * / unsupported-language target, a root outside the P3-B allowlist, an
 * over-budget scan, or any thrown error → `null`. `impact()` never throws.
 *
 * NAMESPACE INVARIANT (ADR-0011 #1 risk / F-1): the root the radius is emitted
 * relative to is chosen so the caller's OWN target string ROUND-TRIPS,
 * `toWorkspaceRelativePosix(root, absTarget) === target.module`. On a monorepo
 * (MUON: `backend/`, `packages/*` each carry a `package.json`) this means the
 * WORKSPACE root the anchors use, NOT the nearest inner package, so a governed
 * memory anchored to `backend/src/b.ts` is matched by an emitted
 * `backend/src/b.ts`, target and every neighbour live in ONE namespace.
 *
 * LAZY + CACHED: built on the first call that needs a root; cached per resolved
 * root. Invalidation in v1 (Phases 0–2) is TTL + a COARSE root-dir mtime check
 * (catches added/removed top-level entries cheaply); deep-change mtime and true
 * fs-watch incremental are a Phase-3 follow-on. Over-budget roots are
 * NEGATIVE-cached for the TTL so a heavy repo degrades cheaply, not per call (F-2).
 */

const MAX_DEPTH = 3;
const MAX_MODULES = 128;
/** Symbol-referencer cap for the reverse-symbol closure (ADR-0015). Higher than
 *  MAX_MODULES since a module can host several referencing symbols; still bounded. */
const MAX_SYMBOLS = 256;
const DEFAULT_TTL_MS = 5 * 60_000;

/** A per-root cache slot: a built index, or a negative "unavailable" sentinel. */
type CacheEntry =
  | { kind: "ok"; index: ReverseImportIndex; builtAt: number; rootMtimeMs: number }
  | { kind: "unavailable"; builtAt: number };

export type LocalCodeGraphOptions = {
  /** Base dir for resolving relative target paths. Default `process.cwd()`. */
  cwd?: string;
  /** Env used for workspace-root discovery + the default allowlist. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * P3-B allowlist predicate. The backend injects the canonical
   * `validateWorkspacePath` (workspace.ts). When omitted, a built-in
   * `isRootAllowed` mirrors P3-B so a standalone provider is still safe.
   */
  validateRoot?: (root: string) => boolean;
  /** Scan budget → over-budget degrades to `null`. */
  budget?: IndexBudget;
  /** Per-root cache TTL in ms. Default 5 min. */
  ttlMs?: number;
  /** Reverse-closure depth cap. Default 3. */
  maxDepth?: number;
  /** Blast-radius module cap. Default 128 (the hero's MAX_ANCHOR_MODULES). */
  maxModules?: number;
  /** Reverse SYMBOL-closure referencer cap (ADR-0015). Default 256. */
  maxSymbols?: number;
  /**
   * The `LanguageAdapter` registry (ADR-0016). For TEST INJECTION; when omitted the
   * provider builds `defaultRegistry(env)` ([ts, python], `MUON_CODEGRAPH_LANGS`-
   * overridable). The registry decides which target extensions are supported and
   * which per-file extractor/resolver the index uses.
   */
  adapters?: AdapterRegistry;
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export class LocalCodeGraphProvider implements CodeGraphProvider {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly validateRoot: (root: string) => boolean;
  private readonly budget: IndexBudget | undefined;
  private readonly ttlMs: number;
  private readonly maxDepth: number;
  private readonly maxModules: number;
  private readonly maxSymbols: number;
  private readonly registry: AdapterRegistry;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: LocalCodeGraphOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.validateRoot =
      options.validateRoot ??
      ((root: string) => isRootAllowed(root, { env: this.env, cwd: this.cwd }));
    this.budget = options.budget;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxDepth = options.maxDepth ?? MAX_DEPTH;
    this.maxModules = options.maxModules ?? MAX_MODULES;
    this.maxSymbols = options.maxSymbols ?? MAX_SYMBOLS;
    this.registry = options.adapters ?? defaultRegistry(this.env);
  }

  /**
   * Resolve the blast-radius for an edit target, or `null` when this provider
   * does no work (the hero then falls back to module-only). NEVER throws, any
   * error degrades to `null` so a hero gate can never fail on the code graph.
   */
  async impact(target: EditTarget): Promise<BlastRadius | null> {
    try {
      return this.computeImpact(target);
    } catch {
      return null;
    }
  }

  private computeImpact(target: EditTarget): BlastRadius | null {
    // ADR-0012: a symbol target `<module>#<name>` resolves to its DEFINING module
    // (the id prefix, produced by the SAME `toWorkspaceRelativePosix`
    // canonicalizer, so it rides the anchor namespace by construction, the #1
    // invariant) and runs the EXISTING module-level reverse-import closure, then
    // ECHOES the target symbol so the hero's on-symbol tier can fuse on it. This
    // closes the old bare-symbol→null gap. A bare symbol with NO `#` (no derivable
    // module) still degrades to null, byte-for-byte today's behaviour.
    const symbolModule =
      target.symbol && moduleOfSymbol(target.symbol) !== target.symbol
        ? moduleOfSymbol(target.symbol)
        : undefined;
    const echoSymbols = target.symbol ? [target.symbol] : undefined;
    // 1. Resolve target files from module/files plus a symbol's defining module.
    const rawFiles = uniq([
      ...(target.files ?? []),
      ...(target.module ? [target.module] : []),
      ...(symbolModule ? [symbolModule] : []),
    ]);
    if (rawFiles.length === 0) {
      return null;
    }

    // Unsupported language (e.g. a `.md` target, or a language the registry does
    // not carry) → null (degrade). With `[ts, python]` a `.py` target IS supported.
    if (!rawFiles.every((file) => this.registry.isSupported(file))) {
      return null;
    }

    // 2. Resolve the root + absolute targets in the CALLER'S namespace (F-1). The
    //    root is chosen so a caller-relative target string round-trips exactly to
    //    itself, so neighbours emit in the SAME namespace the anchors use, even
    //    on a monorepo (workspace root, not the nearest inner package).
    const resolved = this.resolveRoot(rawFiles, target);
    if (!resolved) {
      return null;
    }
    const { root, absTargets } = resolved;

    // P3-B allowlist on the resolved root.
    if (!this.validateRoot(root)) {
      return null;
    }
    const inRoot = uniq(absTargets.filter((abs) => isWithin(root, abs)));
    if (inRoot.length === 0) {
      return null;
    }

    // 3. Ensure the index (build-or-reuse; over-budget → null, negative-cached).
    const index = this.ensureIndex(root);
    if (!index) {
      return null;
    }

    // 4. Reverse transitive closure → canonicalize to the anchor namespace. The
    //    canonicalizer is self-guarding (F-6): any non-in-root result is dropped.
    const closure = reverseClosure(index, inRoot, {
      maxDepth: this.maxDepth,
      maxModules: this.maxModules,
    });
    const modules = closure.files
      .map((abs) => toWorkspaceRelativePosix(root, abs))
      .filter((mod): mod is string => mod !== null);

    // ADR-0015 SYMBOL REFINEMENT, when the symbol layer is present AND the target
    // resolves to a symbol id, replace the echo with the target PLUS the symbols
    // that transitively REFERENCE it. Strictly additive: `modules` is UNCHANGED
    // (the always-correct primary output), and every ambiguity already degraded to
    // "no symbol edge" inside `symbolReverse`, so this can only refine, never widen.
    const symbols =
      index.symbolLayerAvailable && target.symbol
        ? this.refineSymbols(index, target.symbol, modules)
        : echoSymbols;

    return {
      modules,
      symbols,
      depth: closure.depth,
      source: "codegraph",
    };
  }

  /**
   * ADR-0015 §3(e)/(f), the reverse SYMBOL closure + the NEVER-WIDEN safety filter.
   * Returns `uniq([target, ...referencers])` where each referencer transitively
   * references `targetSymbol` AND its module is already in the module closure
   * (`deriveModulesFromSymbols(referencers) ⊆ modules`, gate 2). The `⊆ modules`
   * filter can only DROP a name-based false edge; it can NEVER add a module the
   * reverse-import closure didn't already contain, so the radius never widens.
   */
  private refineSymbols(
    index: ReverseImportIndex,
    targetSymbol: string,
    modules: string[]
  ): string[] {
    const { symbols: referencers } = reverseSymbolClosure(
      index.symbolReverse,
      [targetSymbol],
      { maxDepth: this.maxDepth, maxSymbols: this.maxSymbols }
    );
    const moduleSet = new Set(modules);
    // NEVER WIDEN (gate 2): keep only referencers whose module is in the closure.
    const filtered = referencers.filter((sym) =>
      moduleSet.has(moduleOfSymbol(sym))
    );
    // Defence-in-depth: assert the invariant the filter enforces. A violation would
    // be a logic bug, not a data condition, degrade rather than widen.
    const widened = deriveModulesFromSymbols(filtered).filter(
      (mod) => !moduleSet.has(mod)
    );
    const safe = widened.length === 0 ? filtered : [];
    return uniq([targetSymbol, ...safe]);
  }

  /**
   * Resolve the emit-root + absolute targets so the caller's namespace is
   * preserved (F-1). For a RELATIVE target string, the root is the search base
   * it resolved against, guaranteeing `relative(root, absTarget) ===
   * callerString`. For an ABSOLUTE target (or one that can't round-trip), fall
   * back to the OUTERMOST allowlisted workspace root that contains it, NOT the
   * nearest inner package. Returns null when no target locates on disk.
   */
  private resolveRoot(
    rawFiles: string[],
    target: EditTarget
  ): { root: string; absTargets: string[] } | null {
    // The PRIMARY target defines the namespace: prefer `module`, else the first file.
    const primary = target.module ?? rawFiles[0];
    const primaryLoc = this.locate(primary);
    if (!primaryLoc) {
      return null;
    }
    const root = primaryLoc.base;
    // Locate the remaining targets (best-effort); keep those inside the root.
    const absTargets: string[] = [];
    for (const file of rawFiles) {
      const loc = this.locate(file);
      if (loc && isWithin(root, loc.abs)) {
        absTargets.push(loc.abs);
      }
    }
    if (!absTargets.includes(primaryLoc.abs)) {
      absTargets.push(primaryLoc.abs);
    }
    return { root, absTargets: uniq(absTargets) };
  }

  /**
   * Resolve a target path to an existing absolute file AND the base (emit-root)
   * that preserves the caller's namespace. Relative → the first search base it
   * resolves under (round-trips by construction). Absolute → the outermost
   * allowlisted workspace root that contains it.
   */
  private locate(file: string): { abs: string; base: string } | null {
    if (path.isAbsolute(file)) {
      const abs = path.resolve(file);
      if (!isFile(abs)) {
        return null;
      }
      const base = this.outermostRootFor(abs);
      return base ? { abs, base } : null;
    }
    for (const base of this.searchRoots()) {
      const resolvedBase = path.resolve(base);
      const candidate = path.resolve(resolvedBase, file);
      if (isFile(candidate)) {
        return { abs: candidate, base: resolvedBase };
      }
    }
    return null;
  }

  /** The OUTERMOST (shortest) allowlisted workspace root that contains `abs`, or null. */
  private outermostRootFor(abs: string): string | null {
    const containing = this.searchRoots()
      .map((root) => path.resolve(root))
      .filter((root) => isWithin(root, abs))
      .sort((a, b) => a.length - b.length);
    return containing[0] ?? null;
  }

  /** Candidate bases for a RELATIVE target: the cwd + configured workspace roots. */
  private searchRoots(): string[] {
    const roots = [path.resolve(this.cwd)];
    const configured = this.env.MUON_WORKSPACE_ROOTS;
    if (configured) {
      for (const raw of configured.split(",")) {
        const trimmed = raw.trim();
        if (trimmed) {
          roots.push(path.resolve(trimmed));
        }
      }
    }
    return uniq(roots);
  }

  /** Coarse freshness signal (F-4): the root dir's own mtime (0 on error). */
  private static rootMtimeMs(root: string): number {
    try {
      return fs.statSync(root).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Build-or-reuse the per-root index. Within the TTL, a cached OK entry is
   * reused only while the root-dir mtime is unchanged (F-4 coarse invalidation),
   * and a cached "unavailable" sentinel short-circuits to null so an over-budget
   * repo degrades cheaply instead of rebuilding every call (F-2). Over-budget →
   * null (negative-cached); any other error propagates to `impact`'s try/catch.
   */
  private ensureIndex(root: string): ReverseImportIndex | null {
    const now = Date.now();
    const cached = this.cache.get(root);
    if (cached && now - cached.builtAt < this.ttlMs) {
      if (cached.kind === "unavailable") {
        return null;
      }
      if (cached.rootMtimeMs === LocalCodeGraphProvider.rootMtimeMs(root)) {
        return cached.index;
      }
    }
    try {
      const index = buildReverseImportIndex({
        root,
        budget: this.budget,
        registry: this.registry,
      });
      this.cache.set(root, {
        kind: "ok",
        index,
        builtAt: now,
        rootMtimeMs: LocalCodeGraphProvider.rootMtimeMs(root),
      });
      return index;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.cache.set(root, { kind: "unavailable", builtAt: now });
        return null;
      }
      throw error;
    }
  }
}
