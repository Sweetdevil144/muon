import type { ReverseImportIndex } from "./indexer.js";

/**
 * The TRANSITIVE IMPACT CLOSURE (ADR-0011 Phase 2). Given target file(s), BFS
 * the REVERSE adjacency ("importers-of") to collect the transitive set of files
 * that import the target, the upstream module blast-radius.
 *
 *   - Bounded to depth `maxDepth` (=3, mirroring CLAUDE.md d1/d2/d3 and the
 *     hero's `neighbourProximity` depth falloff).
 *   - CYCLE-SAFE via a visited set (import cycles through barrels never loop).
 *   - Capped at `maxModules` (=128, the hero's `MAX_ANCHOR_MODULES`); because
 *     BFS visits in ASCENDING depth, truncation drops the FARTHEST neighbours
 *     first, closest importers are kept (ADR-0011 §impact step 4).
 *   - Target files themselves are EXCLUDED (the hero unions the target
 *     separately at `preedit.ts:213`).
 */

export type ClosureResult = {
  /** Affected files (absolute), nearest-first, target files excluded. */
  files: string[];
  /** The maximum depth actually traversed (a proximity-weighting hint). */
  depth: number;
};

export function reverseClosure(
  index: ReverseImportIndex,
  targets: string[],
  opts: { maxDepth: number; maxModules: number }
): ClosureResult {
  const { maxDepth, maxModules } = opts;
  // Seed visited with the targets so they are never emitted and cycles back to a
  // target terminate.
  const visited = new Set<string>(targets);
  const result: string[] = [];
  let frontier = [...new Set(targets)];
  let depth = 0;
  let maxDepthReached = 0;

  while (frontier.length > 0 && depth < maxDepth && result.length < maxModules) {
    depth += 1;
    const next: string[] = [];
    for (const file of frontier) {
      const importers = index.reverse.get(file);
      if (!importers) {
        continue;
      }
      for (const importer of importers) {
        if (visited.has(importer)) {
          continue;
        }
        visited.add(importer);
        result.push(importer);
        maxDepthReached = depth;
        next.push(importer);
        if (result.length >= maxModules) {
          break;
        }
      }
      if (result.length >= maxModules) {
        break;
      }
    }
    frontier = next;
  }

  return { files: result.slice(0, maxModules), depth: maxDepthReached };
}

export type SymbolClosureResult = {
  /** The transitively-referencing symbol ids (nearest-first, targets excluded). */
  symbols: string[];
  /** The maximum reference-depth actually traversed. */
  depth: number;
};

/**
 * The SYMBOL-REFERENCE closure (ADR-0015 §3(e)), the symbol-level twin of
 * `reverseClosure`. Given target symbol id(s), BFS the reverse SYMBOL-reference
 * adjacency (`symbolReverse`: callee id → the set of caller ids that reference it)
 * to collect the transitive set of symbols that reference the target. Identical
 * discipline to `reverseClosure`: bounded to `maxDepth`, CYCLE-SAFE via a visited
 * set, and capped at `maxSymbols` with ASCENDING-depth (nearest-first) truncation
 * so the closest referencers survive the cap. Target symbols are EXCLUDED from the
 * result (the provider unions the echo target separately).
 */
export function reverseSymbolClosure(
  symbolReverse: Map<string, Set<string>>,
  targets: string[],
  opts: { maxDepth: number; maxSymbols: number }
): SymbolClosureResult {
  const { maxDepth, maxSymbols } = opts;
  const visited = new Set<string>(targets);
  const result: string[] = [];
  let frontier = [...new Set(targets)];
  let depth = 0;
  let maxDepthReached = 0;

  while (frontier.length > 0 && depth < maxDepth && result.length < maxSymbols) {
    depth += 1;
    const next: string[] = [];
    for (const symbol of frontier) {
      const callers = symbolReverse.get(symbol);
      if (!callers) {
        continue;
      }
      for (const caller of callers) {
        if (visited.has(caller)) {
          continue;
        }
        visited.add(caller);
        result.push(caller);
        maxDepthReached = depth;
        next.push(caller);
        if (result.length >= maxSymbols) {
          break;
        }
      }
      if (result.length >= maxSymbols) {
        break;
      }
    }
    frontier = next;
  }

  return { symbols: result.slice(0, maxSymbols), depth: maxDepthReached };
}
