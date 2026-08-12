import fs from "node:fs";
import path from "node:path";
import {
  type AdapterRegistry,
  type LanguageAdapter,
  type LanguageContext,
  defaultRegistry,
} from "./adapter.js";
import { IGNORED_DIRS, toWorkspaceRelativePosix } from "./paths.js";

/**
 * The REVERSE-IMPORT INDEX (ADR-0011 Phase 1). Scans every in-allowlist TS/JS
 * source file under `root` ONCE, extracts import specifiers, resolves each to an
 * intra-repo file, and records the edge in BOTH directions. `reverse` maps a
 * file → the set of files that import it, the adjacency the transitive
 * blast-radius closure walks. Source of truth is the working-tree filesystem
 * (NOT the LadybugDB ledger, Decision 3).
 */

export type ReverseImportIndex = {
  /** The resolved repo root the index is rooted at (absolute). */
  root: string;
  /** file → the set of files that import it (the reverse adjacency). */
  reverse: Map<string, Set<string>>;
  /** file → the set of files it imports (kept for diagnostics / future use). */
  forward: Map<string, Set<string>>;
  /**
   * ADR-0015 CG-1 SYMBOL layer, callee symbol id (`<module>#<name>`) → the set of
   * caller symbol ids that transitively-directly reference it (one reverse edge per
   * import-resolved static usage). Populated in the SAME file loop as `reverse`,
   * under `symbolLayerBudgetMs` (over-budget → skipped, module index intact). Empty
   * (and `symbolLayerAvailable=false`) when the sub-budget was exhausted or disabled
   *, the provider then degrades to today's echo-only `symbols`.
   */
  symbolReverse: Map<string, Set<string>>;
  /** True when the symbol layer completed within its sub-budget (else the provider
   *  ignores `symbolReverse` and returns echo-only symbols, no-regression). */
  symbolLayerAvailable: boolean;
  /** All scanned source files (absolute paths). */
  files: string[];
  /** Count of scanned files. */
  fileCount: number;
  /** Wall-clock build timestamp (ms), used for the per-root TTL cache. */
  builtAt: number;
};

export type IndexBudget = {
  /** Hard cap on scanned source files; exceeding it → BudgetExceededError. */
  maxFiles?: number;
  /** Hard cap on TOTAL directory entries walked (dirs + files, incl. skipped),
   *  bounds an asset-heavy tree even when few are source files (F-2). */
  maxEntries?: number;
  /** Skip a single file larger than this many bytes (generated bundles). */
  maxFileBytes?: number;
  /** Wall-clock ceiling for the whole scan (walk + read); over → degrade. */
  maxScanMs?: number;
  /**
   * ADR-0015 SUB-BUDGET for the SYMBOL layer alone (the one extra deep parse per
   * file). When the cumulative symbol-extraction time exceeds this, the symbol
   * layer is SKIPPED for the remaining files and marked unavailable, the cheap
   * MODULE index is unaffected (it never regresses). `<= 0` disables the symbol
   * layer entirely (a deterministic off-switch for tests). Kept BELOW `maxScanMs`
   * so the deep parse can never blow the whole-scan budget and null the index.
   */
  maxSymbolScanMs?: number;
};

export const DEFAULT_BUDGET: Required<IndexBudget> = {
  maxFiles: 20000,
  maxEntries: 200_000,
  maxFileBytes: 1_500_000,
  maxScanMs: 15000,
  maxSymbolScanMs: 10000,
};

/** Thrown when a scan exceeds its budget → the provider degrades to `null`. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function upsert(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

/**
 * Collect all supported source files under `root`, skipping ignored/hidden dirs
 * and never following into `node_modules`/build outputs. "Supported" is decided by
 * the `AdapterRegistry` (ADR-0016), the union of every registered language's
 * extensions, not a hard-wired TS gate. Bounded on THREE axes so an asset-heavy or
 * huge tree degrades instead of pinning the pre-edit path (F-2): source-file count,
 * total entries walked, and wall-clock, any breach throws BudgetExceededError
 * (→ the provider degrades to null and negative-caches).
 */
function collectFiles(
  root: string,
  registry: AdapterRegistry,
  budget: Required<IndexBudget>,
  start: number
): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  let entriesWalked = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      entriesWalked += 1;
      if (entriesWalked > budget.maxEntries) {
        throw new BudgetExceededError(
          `code-graph scan exceeded maxEntries=${budget.maxEntries} under ${root}`
        );
      }
      // Amortised wall-clock check (cheap; ~every 1024 entries).
      if ((entriesWalked & 1023) === 0 && Date.now() - start > budget.maxScanMs) {
        throw new BudgetExceededError(
          `code-graph scan exceeded maxScanMs=${budget.maxScanMs} under ${root}`
        );
      }
      const name = entry.name;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        // Skip dependency/build/VCS dirs and dotfolders (never source of edges).
        if (IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".")) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && registry.isSupported(name)) {
        files.push(full);
        if (files.length > budget.maxFiles) {
          throw new BudgetExceededError(
            `code-graph scan exceeded maxFiles=${budget.maxFiles} under ${root}`
          );
        }
      }
    }
  }
  return files;
}

export type BuildOptions = {
  root: string;
  budget?: IndexBudget;
  /** The language registry (ADR-0016). Defaults to `defaultRegistry()` ([ts,python]
   *  via `MUON_CODEGRAPH_LANGS`) so an omitted registry over a TS-only repo is
   *  byte-for-byte the pre-ADR-0016 index. */
  registry?: AdapterRegistry;
};

/**
 * Build the reverse-import index for `root`. Cycle- and cost-safe: over-budget
 * (too many files / too slow) throws BudgetExceededError so the caller degrades
 * to `null` rather than blocking. Pure filesystem I/O, NO network.
 *
 * ADR-0016: each file is dispatched to its `LanguageAdapter` by extension. Per-root
 * language contexts are built LAZILY and cached per `adapterId` (there is one root
 * here, so `id` keys the cache). Import edges use `ctx.resolveImport`; the ADR-0015
 * symbol block runs ONLY for a context that exposes `extractReferences` (TS +
 * Python); a module-level-only language never touches `symbolReverse`.
 */
export function buildReverseImportIndex(
  opts: BuildOptions
): ReverseImportIndex {
  const budget = { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) };
  const root = path.resolve(opts.root);
  const registry = opts.registry ?? defaultRegistry();
  const start = Date.now();

  const files = collectFiles(root, registry, budget, start);

  // Lazy per-adapter context (one root ⇒ keyed by adapter id).
  const contexts = new Map<string, LanguageContext>();
  const contextFor = (adapter: LanguageAdapter): LanguageContext => {
    let ctx = contexts.get(adapter.id);
    if (!ctx) {
      ctx = adapter.createContext(root);
      contexts.set(adapter.id, ctx);
    }
    return ctx;
  };

  const reverse = new Map<string, Set<string>>();
  const forward = new Map<string, Set<string>>();
  // ADR-0015 SYMBOL layer (populated in the SAME loop, under a sub-budget).
  const symbolReverse = new Map<string, Set<string>>();
  let symbolLayerAvailable = budget.maxSymbolScanMs > 0;
  let symbolMsSpent = 0;

  for (const file of files) {
    if (Date.now() - start > budget.maxScanMs) {
      throw new BudgetExceededError(
        `code-graph scan exceeded maxScanMs=${budget.maxScanMs} under ${root}`
      );
    }
    const adapter = registry.select(file);
    if (!adapter) {
      continue; // defensive, collectFiles already gated on registry.isSupported
    }
    const ctx = contextFor(adapter);
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > budget.maxFileBytes) {
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const refs = adapter.extractImports(text, file);
    for (const ref of refs) {
      const target = ctx.resolveImport(file, ref);
      if (!target || target === file) {
        continue;
      }
      upsert(forward, file).add(target);
      upsert(reverse, target).add(file);
    }

    // ADR-0015 (revises the ADR-0012 "don't parse for symbols" note now that a
    // consumer exists): the ONE extra deep parse per file, populating the reverse
    // SYMBOL-reference adjacency. Runs ONLY when the language context exposes the
    // OPTIONAL `extractReferences` (TS + Python; absent ⇒ module-level only). Bounded by
    // its OWN sub-budget: once the cumulative symbol-extraction time crosses
    // `maxSymbolScanMs`, the symbol layer is skipped for the rest of the files and
    // marked unavailable, the module index above is untouched (it stays the
    // always-correct floor). Degrade-safe: `#`-in-path or an out-of-root module
    // yields no edges; `extractReferences` never throws.
    if (symbolLayerAvailable && ctx.extractReferences) {
      if (symbolMsSpent > budget.maxSymbolScanMs) {
        symbolLayerAvailable = false;
      } else {
        const symStart = Date.now();
        const modB = toWorkspaceRelativePosix(root, file);
        if (modB !== null && !modB.includes("#")) {
          const { edges } = ctx.extractReferences(text, modB, file);
          for (const edge of edges) {
            upsert(symbolReverse, edge.callee).add(edge.caller);
          }
        }
        symbolMsSpent += Date.now() - symStart;
      }
    }
  }

  return {
    root,
    reverse,
    forward,
    symbolReverse,
    symbolLayerAvailable,
    files,
    fileCount: files.length,
    builtAt: Date.now(),
  };
}
