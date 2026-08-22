import {
  docContext,
  docsCiting,
  docsStatus,
  queryDocs,
  type DocsContextResult,
  type DocsImpactResult,
  type DocsQueryOptions,
  type DocsQueryResult,
  type DocsStatusResult,
} from "./api.js";
import { ensureDocsIndex, type DocsIndex } from "./index-build.js";

/**
 * `@muon/docgraph` — the repository's own prose, indexed as a queryable
 * AST-derived graph (ADR-0053).
 *
 * DOCS ARE DATA. Every payload this package returns describes documentation; a
 * doc section is imperative prose and a consumer MUST carry it under the trust
 * envelope its surface already has (`treatPayloadAs: "data"`,
 * `payloadInstructionTrust: "none"`). A doc may DESCRIBE a rule; it never GRANTS
 * one. This package holds no write verb, opens nothing outside the resolved
 * repository root, and sends nothing anywhere.
 */

export {
  DOCS_EXCERPT_CHARS,
  DOCS_GIT_MAX_BUFFER,
  DOCS_GIT_TIMEOUT_MS,
  DOCS_INDEX_TTL_MS,
  DOCS_MAX_ANCHORS_PER_SECTION,
  DOCS_MAX_BACKLINKS,
  DOCS_MAX_CORPUS_FILES,
  DOCS_MAX_FILE_BYTES,
  DOCS_MAX_KNOWN_FILES,
  DOCS_MAX_RESPONSE_CHARS,
  DOCS_MAX_RESULTS,
  evidenceFor,
  type DocsEvidence,
} from "./bounds.js";

export {
  DOCS_EXCLUDED_PREFIXES,
  containedPath,
  exclusionFor,
  gitIndexStamp,
  knownFileSet,
  listMarkdownPaths,
  normalizeCitationPath,
  normalizeLinkTarget,
  repoProbe,
  trackedFileSet,
  withinRoot,
  worktreeDirty,
  type Containment,
  type RepoProbe,
} from "./corpus.js";

export {
  KnownFiles,
  codeSpanCandidate,
  resolveCodeAnchors,
  resolveLink,
  type AnchorResolution,
  type CodeAnchor,
  type DocLink,
  type LinkResolution,
} from "./anchors.js";

export {
  flattenLinkSyntax,
  parseMarkdown,
  topLevelRawSum,
  type DocFence,
  type ParsedDoc,
  type ParsedSection,
  type RawLink,
} from "./parse.js";

export {
  SlugDeduper,
  editDistance,
  parseSectionId,
  sectionIdOf,
  slugify,
} from "./slug.js";

export {
  CANON_HEADING,
  CANON_INDEX_PATH,
  DOCS_PRECEDENCE,
  ROOT_CANON,
  TIER_PRIOR,
  adrStatusOf,
  deriveCanonSet,
  isHistorical,
  priorFor,
  tierOf,
  type AdrStatus,
  type CanonSet,
  type DocTier,
} from "./tier.js";

export {
  BM25_B,
  BM25_K1,
  buildSectionTerms,
  docTerms,
  rankSections,
  type RankedSection,
  type SectionTerms,
} from "./rank.js";

export {
  DocsRefusal,
  buildDocsIndex,
  clearDocsIndexCache,
  degradationOf,
  ensureDocsIndex,
  provenanceOf,
  type CitationRef,
  type DocFile,
  type DocSection,
  type DocsDegradation,
  type DocsDegradationEntry,
  type DocsIndex,
  type DocsProvenance,
} from "./index-build.js";

export {
  docContext,
  docsCiting,
  docsStatus,
  queryDocs,
  type DocsCitation,
  type DocsContextResult,
  type DocsDocumentContext,
  type DocsFenceView,
  type DocsImpactResult,
  type DocsOutlineEntry,
  type DocsQueryHit,
  type DocsQueryOptions,
  type DocsQueryResult,
  type DocsSectionContext,
  type DocsStatusResult,
} from "./api.js";

/**
 * The surface Phase 2 (`packages/mcp/src/docs-tools.ts`, `muon docs`) consumes.
 *
 * Every method REVALIDATES before it answers — HEAD, the git index stamp, the
 * corpus path set, per-file `(size, mtimeMs)`, and a 60 s TTL backstop — so the
 * caller never has to ask whether the index is current, and never has to be told
 * that it is not. Bound to one repository root, resolved from `startDir` via
 * `git rev-parse --show-toplevel`; nothing outside that root is read.
 */
export type DocsGraph = {
  /** The absolute repository root this graph is bound to, once resolved. */
  root(): Promise<string>;
  /** Corpus counts, tier distribution, anchor histogram, and the drift report. */
  status(): Promise<DocsStatusResult>;
  /** Flat BM25 over sections, with a bounded tier prior that may only demote. */
  query(text: string, options?: DocsQueryOptions): Promise<DocsQueryResult>;
  /** One document path or one `docPath#slug` section id, 360 degrees. */
  context(
    target: string,
    options?: { includeText?: boolean; includeBacklinks?: boolean }
  ): Promise<DocsContextResult>;
  /** The reverse index: which doc sections name this repository path. */
  impact(filePath: string, options?: { limit?: number }): Promise<DocsImpactResult>;
  /** Force a rebuild and hand back the index itself (`muon docs index`). */
  rebuild(): Promise<DocsIndex>;
};

export function createDocsGraph(startDir: string): DocsGraph {
  const index = () => ensureDocsIndex(startDir);
  return {
    async root() {
      return (await index()).root;
    },
    async status() {
      return docsStatus(await index());
    },
    async query(text, options) {
      return queryDocs(await index(), text, options);
    },
    async context(target, options) {
      return docContext(await index(), target, options);
    },
    async impact(filePath, options) {
      return docsCiting(await index(), filePath, options);
    },
    async rebuild() {
      return ensureDocsIndex(startDir, { force: true });
    },
  };
}
