import {
  DOCS_EXCERPT_CHARS,
  DOCS_MAX_ANCHORS_PER_SECTION,
  DOCS_MAX_BACKLINKS,
  DOCS_MAX_RESPONSE_CHARS,
  DOCS_MAX_RESULTS,
  evidenceFor,
  type DocsEvidence,
} from "./bounds.js";
import type { CodeAnchor, DocLink } from "./anchors.js";
import { normalizeCitationPath } from "./corpus.js";
import {
  DocsRefusal,
  degradationOf,
  provenanceOf,
  type DocSection,
  type DocsDegradation,
  type DocsDegradationEntry,
  type DocsIndex,
  type DocsProvenance,
} from "./index-build.js";
import type { DocFence } from "./parse.js";
import { rankSections } from "./rank.js";
import { editDistance, parseSectionId } from "./slug.js";
import { DOCS_PRECEDENCE, type AdrStatus, type DocTier } from "./tier.js";

/**
 * The four read shapes an agent surface consumes: `status`, `query`, `context`
 * and `impact` (blueprint §5, §6).
 *
 * These live in the core rather than in the MCP tools so that the CLI and the
 * MCP surface assemble the SAME payload from the SAME code — a defect must
 * reproduce identically on both, which is the cross-surface parity rule this
 * repository has already been bitten by. Phase 2's `packages/mcp/src/docs-tools.ts`
 * and `apps/cli/src/commands/docs.ts` are thin adapters over these functions;
 * neither re-derives anything.
 *
 * EVERY SHAPE CARRIES `provenance` AND `degradation`. A response that cannot say
 * which commit it describes says `builtAtCommit: null`, and a response built
 * with a degraded canon set says so on every call, not once.
 */

export type DocsQueryOptions = {
  /** A caller-chosen HARD FILTER — a different thing from the tier prior. */
  tier?: DocTier;
  pathPrefix?: string;
  fenceLang?: string;
  limit?: number;
};

export type DocsQueryHit = {
  sectionId: string;
  docPath: string;
  title: string | null;
  headingPath: string[];
  tier: DocTier;
  adrStatus: AdrStatus | null;
  historical: boolean;
  lines: { start: number; end: number };
  excerpt: string;
  excerptTruncated: boolean;
  fenceLangs: string[];
  score: number;
};

export type DocsQueryResult = {
  results: DocsQueryHit[];
  precedence: string;
  provenance: DocsProvenance;
  degradation: DocsDegradation;
  evidence: DocsEvidence[];
};

export type DocsOutlineEntry = {
  sectionId: string;
  depth: number;
  headingPath: string[];
  lines: { start: number; end: number };
  bytes: number;
  contentHash: string;
};

export type DocsFenceView = {
  /** `sectionId#fence[n]` — addressable, but never a node (blueprint §3.1). */
  id: string;
  lang: string | null;
  lines: { start: number; end: number };
  bytes: number;
  sha256: string;
};

export type DocsDocumentContext = {
  kind: "document";
  docPath: string;
  title: string | null;
  tier: DocTier;
  adrStatus: AdrStatus | null;
  tracked: boolean | null;
  bytes: number;
  lines: number;
  outline: DocsOutlineEntry[];
  backlinks: string[];
  provenance: DocsProvenance;
  degradation: DocsDegradation;
  evidence: DocsEvidence[];
};

export type DocsSectionContext = {
  kind: "section";
  sectionId: string;
  docPath: string;
  title: string | null;
  tier: DocTier;
  adrStatus: AdrStatus | null;
  historical: boolean;
  depth: number;
  headingPath: string[];
  lines: { start: number; end: number };
  bytes: number;
  contentHash: string;
  fences: DocsFenceView[];
  links: DocLink[];
  codeAnchors: CodeAnchor[];
  backlinks: string[];
  text: string | null;
  textTruncated: boolean;
  provenance: DocsProvenance;
  degradation: DocsDegradation;
  evidence: DocsEvidence[];
};

export type DocsContextResult = DocsDocumentContext | DocsSectionContext;

export type DocsCitation = {
  sectionId: string;
  docPath: string;
  tier: DocTier;
  headingPath: string[];
  lines: { start: number; end: number };
  resolution: CodeAnchor["resolution"];
  inferred: boolean;
  via: "codespan" | "link";
  /** The lines the citation named in the TARGET file, e.g. `file.ts:1040-1977`. */
  mentionLines: number[];
};

export type DocsImpactResult = {
  path: string;
  citedBy: DocsCitation[];
  totals: {
    sections: number;
    documents: number;
    canon: number;
    historical: number;
  };
  /** Present only for an empty result — an empty result is a FACT, not a silence. */
  reason?: string;
  provenance: DocsProvenance;
  degradation: DocsDegradation;
  evidence: DocsEvidence[];
};

export type DocsStatusResult = {
  provenance: DocsProvenance;
  degradation: DocsDegradation;
  precedence: string;
  corpus: {
    selector: number;
    corpus: number;
    sections: number;
    fences: number;
    excluded: { path: string; reason: string }[];
    skipped: { path: string; reason: string }[];
  };
  tiers: Record<DocTier, number>;
  adrStatuses: Record<AdrStatus, number>;
  anchors: {
    resolved: number;
    suffixResolved: number;
    ambiguous: number;
    unresolved: number;
    unknown: number;
    total: number;
  };
  links: { external: number; resolved: number; unresolved: number; unknown: number };
  /** The human-facing hygiene report — CLI-only by design, never a fourth tool. */
  drift: {
    unresolvedAnchors: { path: string; sectionId: string }[];
    ambiguousAnchors: { path: string; candidates: number; sectionId: string }[];
    unclassifiedDocs: string[];
  };
  evidence: DocsEvidence[];
};

const HISTORICAL_ONLY: DocsDegradationEntry = {
  code: "historical-only",
  reason:
    "Every result returned is historical or superseded; a historical-only answer is a real answer and must not read as canon.",
  action:
    "Check `progress.md`, `ROADMAP.md` or an accepted ADR before treating any of these as current.",
};

/** Compose the index's standing degradations with any this response added. */
function degradationWith(
  index: DocsIndex,
  extra: DocsDegradationEntry[]
): DocsDegradation {
  const base = degradationOf(index);
  if (extra.length === 0) {
    return base;
  }
  const entries = [...base.entries, ...extra];
  return {
    active: true,
    reason: entries.map((entry) => entry.reason).join(" "),
    action: entries.map((entry) => entry.action).join(" "),
    entries,
  };
}

function excerptOf(section: DocSection): { excerpt: string; truncated: boolean } {
  const body = section.text.replace(/\n{3,}/g, "\n\n").trim();
  return body.length <= DOCS_EXCERPT_CHARS
    ? { excerpt: body, truncated: false }
    : { excerpt: body.slice(0, DOCS_EXCERPT_CHARS), truncated: true };
}

function fenceLangsOf(fences: readonly DocFence[]): string[] {
  return [...new Set(fences.map((fence) => fence.lang).filter((lang): lang is string => lang !== null))].sort();
}

/**
 * Flat BM25 over sections, bounded on results and on total characters.
 *
 * `tier`, `pathPrefix` and `fenceLang` narrow the CORPUS before ranking, so the
 * corpus statistics describe what the caller actually asked about. The tier
 * PRIOR then applies inside that corpus and can only demote.
 */
export function queryDocs(
  index: DocsIndex,
  query: string,
  options: DocsQueryOptions = {}
): DocsQueryResult {
  const limit = Math.max(1, Math.min(options.limit ?? DOCS_MAX_RESULTS, DOCS_MAX_RESULTS));
  const fenceLang = options.fenceLang?.trim().toLowerCase();
  const candidates: DocSection[] = [];
  for (const sectionId of index.sectionOrder) {
    const section = index.sections.get(sectionId);
    if (!section) {
      continue;
    }
    if (options.tier && section.tier !== options.tier) {
      continue;
    }
    if (options.pathPrefix && !section.docPath.startsWith(options.pathPrefix)) {
      continue;
    }
    if (fenceLang && !section.fences.some((fence) => fence.lang === fenceLang)) {
      continue;
    }
    candidates.push(section);
  }

  const ranked = rankSections(candidates, index.terms, query);
  const results: DocsQueryHit[] = [];
  let characters = 0;
  let charBounded = false;
  for (const entry of ranked) {
    if (results.length >= limit) {
      break;
    }
    const { excerpt, truncated } = excerptOf(entry.section);
    // DEFENCE IN DEPTH, inert with the shipped numbers: 10 results × 1,200 chars
    // is 12,000, half the 24,000 ceiling, so the result cap always binds first.
    // The guard stays because it is the only thing standing between a raised
    // `DOCS_MAX_RESULTS`/`DOCS_EXCERPT_CHARS` and an unbounded response;
    // `tests/bounds.test.ts` pins the arithmetic that keeps it inert.
    if (characters + excerpt.length > DOCS_MAX_RESPONSE_CHARS && results.length > 0) {
      charBounded = true;
      break;
    }
    characters += excerpt.length;
    results.push({
      sectionId: entry.section.id,
      docPath: entry.section.docPath,
      title: index.files.get(entry.section.docPath)?.title ?? null,
      headingPath: entry.section.headingPath,
      tier: entry.section.tier,
      adrStatus: entry.section.adrStatus,
      historical: entry.section.historical,
      lines: { start: entry.section.startLine, end: entry.section.endLine },
      excerpt,
      excerptTruncated: truncated,
      fenceLangs: fenceLangsOf(entry.section.fences),
      score: entry.score,
    });
  }

  const evidence: DocsEvidence[] = [
    {
      bounded: true,
      limit,
      included: results.length,
      omitted: ranked.length - results.length,
      kind: "sections",
    },
  ];
  if (charBounded) {
    evidence.push({
      bounded: true,
      limit: DOCS_MAX_RESPONSE_CHARS,
      included: characters,
      omitted: ranked.length - results.length,
      kind: "responseChars",
    });
  }

  const historicalOnly =
    results.length > 0 && results.every((result) => result.historical);
  return {
    results,
    precedence: DOCS_PRECEDENCE,
    provenance: provenanceOf(index),
    degradation: degradationWith(index, historicalOnly ? [HISTORICAL_ONLY] : []),
    evidence,
  };
}

/** The three nearest section ids by slug edit distance — a renamed heading is
 *  the most likely cause of a citation that no longer lands (blueprint §5.2). */
function nearestSectionIds(index: DocsIndex, target: string): string[] {
  const parsed = parseSectionId(target);
  if (!parsed) {
    return [];
  }
  const sameDoc = index.files.get(parsed.docPath)?.sectionIds ?? [];
  const pool = sameDoc.length > 0 ? sameDoc : index.sectionOrder;
  return pool
    .map((id) => ({ id, distance: editDistance(parseSectionId(id)?.slug ?? "", parsed.slug) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id);
}

/**
 * One document or one section, 360 degrees.
 *
 * An unresolvable target is a typed REFUSAL naming near matches, never an empty
 * success: a stale citation and an empty document must not read the same.
 */
export function docContext(
  index: DocsIndex,
  target: string,
  options: { includeText?: boolean; includeBacklinks?: boolean } = {}
): DocsContextResult {
  const wanted = target.trim();
  const provenance = provenanceOf(index);
  const degradation = degradationOf(index);
  const includeBacklinks = options.includeBacklinks !== false;

  const section = index.sections.get(wanted);
  if (section) {
    const backlinksAll = includeBacklinks ? (index.backlinks.get(wanted) ?? []) : [];
    // Evidence ONLY when backlinks were asked for: `{included: 0, omitted: 0}`
    // on an opted-out request reads as "nothing links here", which is a claim
    // this call never made.
    const evidence: DocsEvidence[] = includeBacklinks
      ? [evidenceFor("backlinks", backlinksAll.length, DOCS_MAX_BACKLINKS)]
      : [];
    if (section.codeAnchorsOmitted > 0) {
      evidence.push({
        bounded: true,
        limit: DOCS_MAX_ANCHORS_PER_SECTION,
        included: section.codeAnchors.length,
        omitted: section.codeAnchorsOmitted,
        kind: "codeAnchors",
      });
    }
    let text: string | null = null;
    let textTruncated = false;
    if (options.includeText) {
      const body = section.text.replace(/\n{3,}/g, "\n\n").trim();
      textTruncated = body.length > DOCS_MAX_RESPONSE_CHARS;
      text = textTruncated ? body.slice(0, DOCS_MAX_RESPONSE_CHARS) : body;
      evidence.push(
        evidenceFor("textChars", body.length, DOCS_MAX_RESPONSE_CHARS)
      );
    }
    return {
      kind: "section",
      sectionId: section.id,
      docPath: section.docPath,
      title: index.files.get(section.docPath)?.title ?? null,
      tier: section.tier,
      adrStatus: section.adrStatus,
      historical: section.historical,
      depth: section.depth,
      headingPath: section.headingPath,
      lines: { start: section.startLine, end: section.endLine },
      bytes: section.bytes,
      contentHash: section.contentHash,
      fences: section.fences.map((fence, position) => ({
        id: `${section.id}#fence[${position}]`,
        lang: fence.lang,
        lines: { start: fence.startLine, end: fence.endLine },
        bytes: fence.bytes,
        sha256: fence.sha256,
      })),
      links: section.links,
      codeAnchors: section.codeAnchors,
      backlinks: backlinksAll.slice(0, DOCS_MAX_BACKLINKS),
      text,
      textTruncated,
      provenance,
      degradation,
      evidence,
    };
  }

  const file = index.files.get(wanted);
  if (file) {
    const backlinksAll = includeBacklinks ? (index.backlinks.get(wanted) ?? []) : [];
    return {
      kind: "document",
      docPath: file.path,
      title: file.title,
      tier: file.tier,
      adrStatus: file.adrStatus,
      tracked: file.tracked,
      bytes: file.bytes,
      lines: file.lines,
      outline: file.sectionIds
        .map((id) => index.sections.get(id))
        .filter((entry): entry is DocSection => entry !== undefined)
        .map((entry) => ({
          sectionId: entry.id,
          depth: entry.depth,
          headingPath: entry.headingPath,
          lines: { start: entry.startLine, end: entry.endLine },
          bytes: entry.bytes,
          contentHash: entry.contentHash,
        })),
      backlinks: backlinksAll.slice(0, DOCS_MAX_BACKLINKS),
      provenance,
      degradation,
      evidence: includeBacklinks
        ? [evidenceFor("backlinks", backlinksAll.length, DOCS_MAX_BACKLINKS)]
        : [],
    };
  }

  throw new DocsRefusal(
    "target-not-found",
    `No document or section in this corpus is addressed by "${wanted}".`,
    "A renamed heading changes its section id. Check the nearest ids below, or call docs_context on the document path to list its outline.",
    nearestSectionIds(index, wanted)
  );
}

/**
 * The reverse index: which doc sections name this repository path.
 *
 * DELIBERATELY NOT A VERDICT. This reports citations; it never claims a doc is
 * wrong. ADR-0052 names `packages/client/src/github-identity-gate.ts` before it
 * was committed — that is a plan, not a defect, and a tool that called it
 * "drift" would be confidently wrong. The resolution state is reported and the
 * human decides.
 */
export function docsCiting(
  index: DocsIndex,
  filePath: string,
  options: { limit?: number } = {}
): DocsImpactResult {
  const limit = Math.max(1, Math.min(options.limit ?? DOCS_MAX_BACKLINKS, DOCS_MAX_BACKLINKS));
  const normalized = normalizeCitationPath("", filePath) ?? filePath.trim();
  const refs = index.citations.get(normalized) ?? [];
  const citedBy: DocsCitation[] = [];
  const documents = new Set<string>();
  let canon = 0;
  let historical = 0;
  for (const ref of refs) {
    const section = index.sections.get(ref.sectionId);
    if (!section) {
      continue;
    }
    documents.add(section.docPath);
    if (section.tier === "canon") {
      canon += 1;
    }
    if (section.historical) {
      historical += 1;
    }
    citedBy.push({
      sectionId: section.id,
      docPath: section.docPath,
      tier: section.tier,
      headingPath: section.headingPath,
      lines: { start: section.startLine, end: section.endLine },
      resolution: ref.resolution,
      inferred: ref.inferred,
      via: ref.via,
      mentionLines: ref.mentionLines,
    });
  }
  citedBy.sort((a, b) => a.sectionId.localeCompare(b.sectionId));
  const bounded = citedBy.slice(0, limit);
  return {
    path: normalized,
    citedBy: bounded,
    totals: {
      sections: citedBy.length,
      documents: documents.size,
      canon,
      historical,
    },
    ...(citedBy.length === 0
      ? { reason: "no documentation cites this path" }
      : {}),
    provenance: provenanceOf(index),
    degradation: degradationOf(index),
    evidence: [evidenceFor("citations", citedBy.length, limit)],
  };
}

/**
 * Corpus counts, tier distribution, the exclusion list WITH reasons, the
 * anchor-resolution histogram, and the human-facing drift report.
 *
 * The drift half is CLI-only by design (blueprint §6): it is a hygiene report
 * for a human, not a fourth agent tool.
 */
export function docsStatus(index: DocsIndex): DocsStatusResult {
  const tiers: Record<DocTier, number> = {
    canon: 0,
    adr: 0,
    proposal: 0,
    historical: 0,
    unclassified: 0,
  };
  const adrStatuses: Record<AdrStatus, number> = {
    accepted: 0,
    proposed: 0,
    superseded: 0,
    unknown: 0,
  };
  const unclassifiedDocs: string[] = [];
  for (const file of index.files.values()) {
    tiers[file.tier] += 1;
    if (file.adrStatus) {
      adrStatuses[file.adrStatus] += 1;
    }
    if (file.tier === "unclassified" && file.path.startsWith("docs/")) {
      unclassifiedDocs.push(file.path);
    }
  }

  const anchors = {
    resolved: 0,
    suffixResolved: 0,
    ambiguous: 0,
    unresolved: 0,
    unknown: 0,
    total: 0,
  };
  const links = { external: 0, resolved: 0, unresolved: 0, unknown: 0 };
  const unresolvedAnchors: { path: string; sectionId: string }[] = [];
  const ambiguousAnchors: { path: string; candidates: number; sectionId: string }[] = [];
  let fences = 0;
  for (const sectionId of index.sectionOrder) {
    const section = index.sections.get(sectionId);
    if (!section) {
      continue;
    }
    fences += section.fences.length;
    for (const anchor of section.codeAnchors) {
      anchors.total += 1;
      if (anchor.resolution === "resolved") {
        anchors.resolved += 1;
      } else if (anchor.resolution === "suffix-resolved") {
        anchors.suffixResolved += 1;
      } else if (anchor.resolution === "ambiguous") {
        anchors.ambiguous += 1;
        ambiguousAnchors.push({
          path: anchor.path,
          candidates: anchor.candidates,
          sectionId,
        });
      } else if (anchor.resolution === "unresolved") {
        anchors.unresolved += 1;
        unresolvedAnchors.push({ path: anchor.path, sectionId });
      } else {
        anchors.unknown += 1;
      }
    }
    for (const link of section.links) {
      if (link.resolution === "external") {
        links.external += 1;
      } else if (link.resolution === "resolved") {
        links.resolved += 1;
      } else if (link.resolution === "unresolved") {
        links.unresolved += 1;
      } else {
        links.unknown += 1;
      }
    }
  }

  return {
    provenance: provenanceOf(index),
    degradation: degradationOf(index),
    precedence: DOCS_PRECEDENCE,
    corpus: {
      selector: index.selectorPaths.length,
      corpus: index.files.size,
      sections: index.sections.size,
      fences,
      excluded: index.excluded,
      skipped: index.skipped,
    },
    tiers,
    adrStatuses,
    anchors,
    links,
    drift: {
      unresolvedAnchors: unresolvedAnchors.slice(0, DOCS_MAX_BACKLINKS),
      ambiguousAnchors: ambiguousAnchors.slice(0, DOCS_MAX_BACKLINKS),
      unclassifiedDocs,
    },
    evidence: [
      evidenceFor("unresolvedAnchors", unresolvedAnchors.length, DOCS_MAX_BACKLINKS),
      evidenceFor("ambiguousAnchors", ambiguousAnchors.length, DOCS_MAX_BACKLINKS),
    ],
  };
}
