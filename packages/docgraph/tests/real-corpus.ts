import path from "node:path";
import { buildDocsIndex, type DocsIndex } from "../src/index-build.js";

/** This repository's own root, resolved from the test file's location. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

let built: Promise<DocsIndex> | null = null;

/**
 * THIS repository's corpus, indexed ONCE per test file.
 *
 * Deliberately built through `buildDocsIndex` rather than `ensureDocsIndex`, so
 * it holds its own instance and a `clearDocsIndexCache()` in a fixture test's
 * `beforeEach` cannot force a ~460 ms rebuild of the real corpus. Read-only by
 * convention: a test that needs to observe a rebuild builds its own.
 */
export function realCorpus(): Promise<DocsIndex> {
  built ??= buildDocsIndex(REPO_ROOT);
  return built;
}
