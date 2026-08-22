/**
 * Every cap the docs graph enforces, in one file (ADR-0053 §10, blueprint §5.4).
 *
 * They live together for the same reason the memory gate's caps do: a bound that
 * is spelled at its call site is a bound nobody can audit, and a surface that
 * grows a new axis without a constant here is the one that silently returns
 * everything. Each cap is paired with a {@link DocsEvidence} record on the
 * response, so "10 results" and "10 results, 43 omitted" are different answers.
 */

/** `docsQuery` sections per response. */
export const DOCS_MAX_RESULTS = 10;
/** Characters of section body carried in one `docsQuery` result. */
export const DOCS_EXCERPT_CHARS = 1_200;
/** Characters across a whole response body. */
export const DOCS_MAX_RESPONSE_CHARS = 24_000;
/** `codeAnchors` retained per section. */
export const DOCS_MAX_ANCHORS_PER_SECTION = 64;
/** Backlinks / citing sections returned by `docContext` and `docsCiting`. */
export const DOCS_MAX_BACKLINKS = 50;
/**
 * Corpus ceiling. A repository past it is REFUSED BY NAME rather than indexed
 * partially: an answer assembled from a truncated corpus reads exactly like an
 * answer assembled from the whole one, and "no documentation cites this path"
 * would then be a claim about files we stopped reading. Same direction, and the
 * same reason, as `backend/src/lib/anchor-resolution.ts`'s `MAX_TRACKED_FILES`.
 */
export const DOCS_MAX_CORPUS_FILES = 2_000;
/** A single file larger than this is skipped — and LISTED in `provenance`. */
export const DOCS_MAX_FILE_BYTES = 2_000_000;
/** Revalidation backstop (blueprint §4 step 5). */
export const DOCS_INDEX_TTL_MS = 60_000;

/** `git` subprocess ceilings, mirroring `anchor-resolution.ts:130-134`. */
export const DOCS_GIT_TIMEOUT_MS = 5_000;
export const DOCS_GIT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Hard cap on the known-file set. Past it the set is refused OUTRIGHT (null)
 * rather than truncated, so `unresolved` is never asserted out of a partial set.
 */
export const DOCS_MAX_KNOWN_FILES = 200_000;

/**
 * The bounded-evidence record, structurally identical to `@muon/mcp`'s
 * `ToolEvidence` (`packages/mcp/src/agent-ui.ts:29-35`) and DELIBERATELY not
 * imported from it: `@muon/docgraph` is a leaf package with no MUON runtime
 * dependency beyond `@muon/graph`'s tokenizer, and the MCP tools (Phase 2) are
 * this package's consumer, never the other way round. A canary in the MCP
 * package can pin the two shapes together when that consumer lands.
 */
export type DocsEvidence = {
  bounded: boolean;
  limit: number;
  included: number;
  omitted: number;
  kind: string;
};

/** Build a {@link DocsEvidence} record from a total and the cap applied to it. */
export function evidenceFor(
  kind: string,
  total: number,
  limit: number
): DocsEvidence {
  const included = Math.min(total, limit);
  return {
    bounded: true,
    limit,
    included,
    omitted: Math.max(0, total - included),
    kind,
  };
}
