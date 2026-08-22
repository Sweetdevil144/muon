import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsCiting, queryDocs } from "../src/api.js";
import {
  buildDocsIndex,
  clearDocsIndexCache,
  ensureDocsIndex,
} from "../src/index-build.js";

// §7.5. REGRESSION ALARMS, NOT BENCHMARKS.
//
// Measured SERIALLY on this repository (179-file / 3.36 MB corpus, 2,758
// sections) on 2026-08-17: cold build ~460 ms, warm revalidation ~21 ms, warm
// `docsQuery` ~33 ms. Under the full suite these same numbers reach ~2.6 s and
// ~120 ms, because ten test files fork in parallel and each of the git-backed
// ones is spawning subprocesses — so the ABSOLUTE ceilings below are set to
// absorb that contention, and the load-bearing assertions are the RELATIVE ones
// (warm ≪ cold, query ≪ cold), which contention cancels out of.
//
// The cold number is what the no-persistence decision rests on: a rebuild that
// costs a fifth of a second serially is why revalidation runs unconditionally,
// and why this index can END staleness where the code-graph tools can only
// report it.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

beforeEach(() => {
  clearDocsIndexCache();
});

afterEach(() => {
  clearDocsIndexCache();
});

/** A cold build's wall time, used as the scale for the relative assertions. */
async function coldBuildMs(): Promise<number> {
  const started = performance.now();
  const index = await buildDocsIndex(REPO_ROOT);
  const elapsed = performance.now() - started;
  expect(index.files.size).toBeGreaterThan(100);
  expect(index.sections.size).toBeGreaterThan(2_000);
  return elapsed;
}

describe("performance on this repository's real corpus", () => {
  it("a COLD build of the whole corpus stays well inside a rebuild-per-read budget", async () => {
    expect(await coldBuildMs()).toBeLessThan(5_000);
  });

  it("a WARM revalidation is at least 3x cheaper than a rebuild", async () => {
    const cold = await coldBuildMs();
    await ensureDocsIndex(REPO_ROOT, { force: true });
    const started = performance.now();
    await ensureDocsIndex(REPO_ROOT);
    const warm = performance.now() - started;
    // Two subprocesses plus ~180 `stat` calls, against reading and parsing
    // 3.36 MB. If this ratio collapses, revalidation has started rebuilding.
    expect(warm).toBeLessThan(cold / 3);
    expect(warm).toBeLessThan(1_000);
  });

  it("a warm `docsQuery` p95 is a small fraction of a rebuild", async () => {
    const cold = await coldBuildMs();
    const index = await ensureDocsIndex(REPO_ROOT, { force: true });
    const queries = [
      "memory retrieval is flat",
      "governed mcp fabric tool inventory",
      "anchor resolution tracked file set",
      "local code graph derived index",
      "human gate fails closed",
      "vendor adapter launch cursor codex",
      "worktree delegate edit authority",
      "markdown docs graph canon precedence",
      "budget cap lower bound dollar",
      "session ownership round trip",
      "desktop terminal substrate pty",
      "institutional context confirmed ambient",
      "packages/graph/src/memory-ranking.ts",
      "docs/README.md canonical current documents",
      "refusal explains itself typed",
      "citation does not launder trust",
      "flaky check is still a failure",
      "one machine one ledger",
      "peer message never authority",
      "reconcile loop engine",
    ];
    const timings: number[] = [];
    for (const query of queries) {
      const started = performance.now();
      const result = queryDocs(index, query);
      timings.push(performance.now() - started);
      expect(result.results.length).toBeGreaterThan(0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))];
    // Section terms are tokenized ONCE at build time; a query that re-tokenized
    // the corpus would land at cold-build scale and fail here.
    expect(p95).toBeLessThan(cold / 3);
    expect(p95).toBeLessThan(500);
  });

  it("`docsCiting` is a map lookup, not a scan", async () => {
    const index = await ensureDocsIndex(REPO_ROOT, { force: true });
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      docsCiting(index, "packages/mcp/src/gitnexus-tools.ts");
    }
    const perCall = (performance.now() - started) / 200;
    expect(perCall).toBeLessThan(5);
  });
});
