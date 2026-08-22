import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  DOCS_INDEX_TTL_MS,
  DOCS_MAX_CORPUS_FILES,
  DOCS_MAX_FILE_BYTES,
} from "./bounds.js";
import {
  KnownFiles,
  resolveCodeAnchors,
  resolveLink,
  type AnchorResolution,
  type CodeAnchor,
  type DocLink,
} from "./anchors.js";
import {
  containedPath,
  exclusionFor,
  gitIndexStamp,
  knownFileSet,
  listMarkdownPaths,
  repoProbe,
  trackedFileSet,
  worktreeDirty,
  type RepoProbe,
} from "./corpus.js";
import { parseMarkdown, type DocFence, type ParsedDoc } from "./parse.js";
import { buildSectionTerms, type SectionTerms } from "./rank.js";
import {
  adrStatusOf,
  deriveCanonSet,
  isHistorical,
  tierOf,
  type AdrStatus,
  type CanonSet,
  type DocTier,
} from "./tier.js";

/**
 * The in-memory `DocsIndex`, its provenance, and the revalidate-then-answer
 * contract (ADR-0053 §3 and §6, blueprint §4).
 *
 * NOTHING IS PERSISTED. The docs graph is derived from the repository on disk,
 * exactly like the code graph, and it is deliberately NOT co-stored in the
 * LadybugDB `.lbug` graph: ADR-0011 §D3 settled that the relational ledger is
 * the source of truth and LadybugDB is derived FROM the ledger, so the
 * corrupt-store quarantine would destroy a corpus the ledger cannot replay. No
 * table, no migration, no route, no artifact.
 *
 * THE INDEX CANNOT LAG THE TREE. A full rebuild of this repository's corpus is
 * ~415 ms, which is what makes unconditional revalidation affordable and what
 * separates this from the code-graph tools: they can only REPORT staleness
 * because a re-index costs minutes, this one can END it. Where it cannot check —
 * no git — it says so and reports `builtAtCommit: null`, never a claim of
 * currency.
 */

/** A named, fail-closed refusal. Phase 2's MCP tools map this to the typed
 *  refusal envelope; the core throws it rather than answering partially. */
export class DocsRefusal extends Error {
  constructor(
    readonly code: "corpus-over-cap" | "target-not-found",
    readonly reason: string,
    readonly action: string,
    readonly nextActions: string[] = []
  ) {
    super(reason);
    this.name = "DocsRefusal";
  }
}

/** A degradation carried on EVERY response for as long as it is true. */
export type DocsDegradationEntry = {
  code:
    | "git-unreadable"
    | "canon-unreadable"
    | "anchors-unresolvable"
    | "files-skipped"
    /** Response-scoped, added by `queryDocs` — see `api.ts`. */
    | "historical-only";
  reason: string;
  action: string;
};

/** The composed block every payload carries. `active: false` ⇒ nothing degraded. */
export type DocsDegradation = {
  active: boolean;
  reason: string;
  action: string;
  entries: DocsDegradationEntry[];
};

export type DocFile = {
  path: string;
  title: string | null;
  tier: DocTier;
  /** Present for `docs/adr/**` only; `null` everywhere else. */
  adrStatus: AdrStatus | null;
  contentHash: string;
  bytes: number;
  lines: number;
  sectionIds: string[];
  /** `false` ⇒ the doc exists but has never been `git add`ed. */
  tracked: boolean | null;
};

export type DocSection = {
  id: string;
  docPath: string;
  depth: number;
  heading: string | null;
  headingPath: string[];
  anchor: string;
  startLine: number;
  endLine: number;
  bytes: number;
  contentHash: string;
  /** The ranking body: fences removed, inline-code markers stripped. */
  text: string;
  fences: DocFence[];
  links: DocLink[];
  codeAnchors: CodeAnchor[];
  /** How many path-shaped code spans the per-section cap dropped. */
  codeAnchorsOmitted: number;
  tier: DocTier;
  adrStatus: AdrStatus | null;
  /** `historical` tier OR a superseded ADR — a real answer that must not read as canon. */
  historical: boolean;
};

/** One doc section naming one repository path. */
export type CitationRef = {
  sectionId: string;
  via: "codespan" | "link";
  resolution: AnchorResolution;
  inferred: boolean;
  /** The lines the citation itself named, e.g. `file.ts:1040-1977`. */
  mentionLines: number[];
};

export type DocsProvenance = {
  /** Absolute, from `git rev-parse --show-toplevel` (or the start directory). */
  root: string;
  builtAt: string;
  /** `null` ⇒ git could not be read; the corpus came off the filesystem. */
  builtAtCommit: string | null;
  worktreeDirty: boolean | null;
  files: number;
  sections: number;
  /** Exclusions are REPORTED, never silent. */
  excluded: number;
  corpusHash: string;
  tierSource: CanonSet["source"];
  /** Where the corpus path list came from. */
  corpusSource: "git" | "filesystem";
};

export type DocsIndex = {
  root: string;
  builtAtMs: number;
  builtAt: string;
  builtAtCommit: string | null;
  worktreeDirty: boolean | null;
  corpusSource: "git" | "filesystem";
  /** Whole-corpus `*.md` list from the selector, exclusions included. */
  selectorPaths: string[];
  excluded: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  files: Map<string, DocFile>;
  sections: Map<string, DocSection>;
  sectionOrder: string[];
  /** section id → term frequencies, tokenized once at build time (see `rank.ts`). */
  terms: Map<string, SectionTerms>;
  parsed: Map<string, ParsedDoc>;
  stats: Map<string, { size: number; mtimeMs: number }>;
  /** repository path → the doc sections that name it. */
  citations: Map<string, CitationRef[]>;
  /** doc path or section id → the doc sections that link to it. */
  backlinks: Map<string, string[]>;
  canon: CanonSet;
  known: KnownFiles;
  gitIndexStamp: number | null;
  corpusHash: string;
  /**
   * Set once at build time, from what git could and could not answer. Kept apart
   * from the DERIVED degradations so a per-file refresh recomposes the block
   * without ever losing (or duplicating) the build-time half.
   */
  baseDegradations: DocsDegradationEntry[];
  degradations: DocsDegradationEntry[];
};

type IndexDegradationCode = Exclude<DocsDegradationEntry["code"], "historical-only">;

const DEGRADE_ACTIONS: Record<IndexDegradationCode, DocsDegradationEntry> = {
  "git-unreadable": {
    code: "git-unreadable",
    reason:
      "The corpus was read from the filesystem; the commit it describes is unknown.",
    action: "Run this from inside a git worktree so the index can name its commit.",
  },
  "canon-unreadable": {
    code: "canon-unreadable",
    reason:
      "The canon precedence set could not be read from docs/README.md; canon tier is limited to the root supplement.",
    action:
      "Restore docs/README.md's '## Canonical current documents' section, then retry.",
  },
  "anchors-unresolvable": {
    code: "anchors-unresolvable",
    reason:
      "The repository's known-file set could not be obtained, so no doc-to-code anchor was resolved.",
    action:
      "Run this from inside a git worktree; until then every anchor reports a null resolution rather than a guess.",
  },
  "files-skipped": {
    code: "files-skipped",
    reason: "One or more corpus files were skipped and are listed in `skipped`.",
    action:
      "Inspect the listed files; each carries its own reason — over the size cap, unreadable, resolving outside the repository root, or a parse failure.",
  },
};

/**
 * A git worktree that HAS no commit yet. Distinct wording from
 * `git-unreadable`'s, which claims the corpus came off the filesystem — here the
 * selector answered perfectly well and there is simply no commit to name.
 */
const NO_COMMIT_YET: DocsDegradationEntry = {
  code: "git-unreadable",
  reason:
    "This worktree has no commit yet, so the index cannot name the commit it describes.",
  action: "Commit the corpus; until then `builtAtCommit` is null rather than a guess.",
};

/** Compose the always-present degradation block. */
export function degradationOf(index: DocsIndex): DocsDegradation {
  const entries = index.degradations;
  return {
    active: entries.length > 0,
    reason: entries.map((entry) => entry.reason).join(" "),
    action: entries.map((entry) => entry.action).join(" "),
    entries,
  };
}

export function provenanceOf(index: DocsIndex): DocsProvenance {
  return {
    root: index.root,
    builtAt: index.builtAt,
    builtAtCommit: index.builtAtCommit,
    worktreeDirty: index.worktreeDirty,
    files: index.files.size,
    sections: index.sections.size,
    excluded: index.excluded.length,
    corpusHash: index.corpusHash,
    tierSource: index.canon.source,
    corpusSource: index.corpusSource,
  };
}

/**
 * Directories the FILESYSTEM FALLBACK never descends into.
 *
 * Reached only when git cannot enumerate the corpus, which is precisely when
 * `.gitignore` cannot be honoured either — so the skip list is named rather than
 * derived, and the response says `corpusSource: "filesystem"` so nobody mistakes
 * this for the selector.
 */
const FS_FALLBACK_SKIP = new Set([
  ".git",
  ".muon",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
]);

function walkMarkdown(root: string, dir: string, into: string[]): void {
  if (into.length > DOCS_MAX_CORPUS_FILES) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (FS_FALLBACK_SKIP.has(entry.name)) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(root, absolute, into);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      into.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

/**
 * Every `*.md` under `root`, and where the list came from.
 *
 * ONE function for the cold build AND the revalidator, so a filesystem-mode
 * workspace notices a new or deleted document exactly the way a git-mode one
 * does. A revalidator that could not enumerate would have to either rebuild on
 * every call (~415 ms per read) or wait out the 60 s TTL, and neither is what
 * "the index cannot lag the tree" means.
 */
async function enumerateCorpus(
  root: string,
  gitAvailable: boolean
): Promise<{ paths: string[]; source: DocsIndex["corpusSource"] }> {
  const fromGit = gitAvailable ? await listMarkdownPaths(root) : null;
  if (fromGit !== null) {
    return { paths: fromGit, source: "git" };
  }
  const found: string[] = [];
  walkMarkdown(root, root, found);
  return { paths: found.sort(), source: "filesystem" };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Build the whole index from disk. Measured ~415 ms steady-state on this
 * repository's 179-file / 3.36 MB / 2,758-section corpus, which is the number the
 * no-persistence decision rests on: nothing this cheap needs a store, and a read
 * that can afford to re-derive can never be stale.
 */
export async function buildDocsIndex(
  startDir: string,
  probed?: RepoProbe
): Promise<DocsIndex> {
  const probe = probed ?? (await repoProbe(startDir));
  const root = probe.root;
  const baseDegradations: DocsDegradationEntry[] = [];

  const { paths: selectorPaths, source: corpusSource } = await enumerateCorpus(
    root,
    probe.gitAvailable
  );
  if (!probe.gitAvailable) {
    baseDegradations.push(DEGRADE_ACTIONS["git-unreadable"]);
  } else if (probe.head === null) {
    baseDegradations.push(NO_COMMIT_YET);
  }

  const excluded: DocsIndex["excluded"] = [];
  const corpusPaths: string[] = [];
  for (const relPath of selectorPaths) {
    const reason = exclusionFor(relPath);
    if (reason) {
      excluded.push({ path: relPath, reason });
    } else {
      corpusPaths.push(relPath);
    }
  }

  if (corpusPaths.length > DOCS_MAX_CORPUS_FILES) {
    // REFUSE BY NAME rather than index a prefix of the corpus: an answer built
    // from a truncated corpus reads exactly like one built from the whole.
    throw new DocsRefusal(
      "corpus-over-cap",
      `The markdown corpus holds ${corpusPaths.length} files, past the ${DOCS_MAX_CORPUS_FILES}-file cap; no partial index was built.`,
      `Narrow the workspace, or raise DOCS_MAX_CORPUS_FILES deliberately after measuring the rebuild cost.`
    );
  }

  const parsed = new Map<string, ParsedDoc>();
  const stats = new Map<string, { size: number; mtimeMs: number }>();
  const skipped: DocsIndex["skipped"] = [];
  for (const relPath of corpusPaths) {
    const absolute = path.join(root, relPath);
    // THE READ FENCE (blueprint §7.3 P5). `git ls-files` never emits a path with
    // `..` in it — but it does emit a TRACKED SYMLINK, which is an ordinary index
    // entry whose bytes live wherever it points. A string prefix cannot tell the
    // two apart, so containment is decided on the resolved path and an escape is
    // REPORTED in `skipped` rather than read.
    const contained = containedPath(root, absolute);
    if (!contained.contained) {
      skipped.push({ path: relPath, reason: contained.reason });
      continue;
    }
    // Read the LOCATION THE FENCE CLEARED, never the nominal path: re-resolving
    // through the link a second time would be a second, unchecked decision.
    const cleared = contained.path;
    let stat;
    try {
      stat = statSync(cleared);
    } catch {
      skipped.push({ path: relPath, reason: "unreadable" });
      continue;
    }
    if (stat.size > DOCS_MAX_FILE_BYTES) {
      skipped.push({
        path: relPath,
        reason: `over the ${DOCS_MAX_FILE_BYTES}-byte per-file cap`,
      });
      continue;
    }
    let source: string;
    try {
      source = readFileSync(cleared, "utf8");
    } catch {
      skipped.push({ path: relPath, reason: "unreadable" });
      continue;
    }
    try {
      parsed.set(relPath, parseMarkdown(relPath, source));
      stats.set(relPath, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      // A single file `marked` throws on is skipped and LISTED, never dropped
      // silently and never allowed to fail the whole corpus.
      skipped.push({
        path: relPath,
        reason: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const known = new KnownFiles(
    probe.gitAvailable ? await knownFileSet(root) : null,
    probe.gitAvailable ? await trackedFileSet(root) : null
  );
  if (!known.known) {
    baseDegradations.push(DEGRADE_ACTIONS["anchors-unresolvable"]);
  }

  const index: DocsIndex = {
    root,
    builtAtMs: 0,
    builtAt: "",
    builtAtCommit: probe.head,
    worktreeDirty: probe.gitAvailable ? await worktreeDirty(root) : null,
    corpusSource,
    selectorPaths,
    excluded,
    skipped,
    files: new Map(),
    sections: new Map(),
    sectionOrder: [],
    terms: new Map(),
    parsed,
    stats,
    citations: new Map(),
    backlinks: new Map(),
    canon: { paths: new Set(), source: "root-supplement-only" },
    known,
    gitIndexStamp: gitIndexStamp(root),
    corpusHash: "",
    baseDegradations,
    degradations: [],
  };
  deriveIndex(index);
  return index;
}

/**
 * Everything downstream of parsing: link and anchor resolution, the canon set,
 * tiers, the reverse indexes, the corpus hash.
 *
 * SHARED BY THE FULL BUILD AND THE PER-FILE REFRESH, deliberately. An
 * incremental revalidation that re-derived through a different code path would
 * be a second implementation of the index, and the determinism test would only
 * be pinning one of them.
 */
function deriveIndex(index: DocsIndex): void {
  index.files = new Map();
  index.sections = new Map();
  index.sectionOrder = [];
  index.citations = new Map();
  index.backlinks = new Map();

  const docPaths = [...index.parsed.keys()].sort();

  // Pass A: links, which the canon derivation reads before any tier exists.
  const linksBySection = new Map<string, DocLink[]>();
  const anchorsBySection = new Map<string, CodeAnchor[]>();
  const anchorsOmitted = new Map<string, number>();
  for (const docPath of docPaths) {
    const doc = index.parsed.get(docPath);
    if (!doc) {
      continue;
    }
    for (const section of doc.sections) {
      const links = section.links.map((link) =>
        resolveLink(link, docPath, index.known)
      );
      linksBySection.set(section.id, links);
      const resolved = resolveCodeAnchors(
        section.codeSpans,
        docPath,
        links,
        index.known
      );
      anchorsBySection.set(section.id, resolved.anchors);
      anchorsOmitted.set(section.id, resolved.evidence.omitted);
    }
  }

  // Pass B: the canon set, from `docs/README.md`'s own link edges.
  index.canon = deriveCanonSet(
    index.parsed.get("docs/README.md"),
    (sectionId) => linksBySection.get(sectionId) ?? []
  );
  index.degradations = [...index.baseDegradations];
  if (index.canon.source === "root-supplement-only") {
    index.degradations.push(DEGRADE_ACTIONS["canon-unreadable"]);
  }
  if (index.skipped.length > 0) {
    index.degradations.push(DEGRADE_ACTIONS["files-skipped"]);
  }

  // Pass C: files, sections, tiers.
  for (const docPath of docPaths) {
    const doc = index.parsed.get(docPath);
    if (!doc) {
      continue;
    }
    const tier = tierOf(docPath, index.canon);
    const adrStatus = docPath.startsWith("docs/adr/")
      ? adrStatusOf(sourceHeadOf(index, docPath))
      : null;
    const sectionIds: string[] = [];
    for (const section of doc.sections) {
      const built: DocSection = {
        id: section.id,
        docPath,
        depth: section.depth,
        heading: section.heading,
        headingPath: section.headingPath,
        anchor: section.anchor,
        startLine: section.startLine,
        endLine: section.endLine,
        bytes: section.bytes,
        contentHash: section.contentHash,
        text: section.text,
        fences: section.fences,
        links: linksBySection.get(section.id) ?? [],
        codeAnchors: anchorsBySection.get(section.id) ?? [],
        codeAnchorsOmitted: anchorsOmitted.get(section.id) ?? 0,
        tier,
        adrStatus,
        historical: isHistorical(tier, adrStatus),
      };
      index.sections.set(built.id, built);
      index.sectionOrder.push(built.id);
      sectionIds.push(built.id);
    }
    index.files.set(docPath, {
      path: docPath,
      title: doc.title,
      tier,
      adrStatus,
      contentHash: doc.contentHash,
      bytes: doc.bytes,
      lines: doc.lines,
      sectionIds,
      tracked: index.known.trackedFor(docPath),
    });
  }

  // Pass D: the reverse indexes, and the `#anchor` half of every doc→doc link,
  // which can only be checked once every section id exists.
  for (const sectionId of index.sectionOrder) {
    const section = index.sections.get(sectionId);
    if (!section) {
      continue;
    }
    for (const anchor of section.codeAnchors) {
      // Indexed under the path the anchor NAMES when it did not resolve, so
      // `docsCiting("gone.ts")` still reports who cites it — carrying the
      // `unresolved` state rather than hiding the citation.
      const key = anchor.resolvedPath ?? anchor.path;
      pushCitation(index, key, {
        sectionId,
        via: "codespan",
        resolution: anchor.resolution,
        inferred: anchor.inferred,
        mentionLines: anchor.lines ?? [],
      });
    }
    for (const link of section.links) {
      if (link.target === null) {
        continue;
      }
      if (link.target.endsWith(".md")) {
        pushBacklink(index, link.target, sectionId);
        if (link.targetSectionId) {
          pushBacklink(index, link.targetSectionId, sectionId);
          link.anchorResolution = index.files.has(link.target)
            ? index.sections.has(link.targetSectionId)
              ? "resolved"
              : "unresolved"
            : null;
        }
      } else {
        // The 21 relative non-`.md` links: a real, if minor, citation channel.
        pushCitation(index, link.target, {
          sectionId,
          via: "link",
          resolution: link.resolution === "external" ? null : link.resolution,
          inferred: false,
          mentionLines: [],
        });
      }
    }
  }

  index.terms = buildSectionTerms(index.sections.values());
  index.builtAtMs = Date.now();
  index.builtAt = new Date(index.builtAtMs).toISOString();
  index.corpusHash = sha256(
    docPaths
      .map((docPath) => `${docPath}\0${index.files.get(docPath)?.contentHash ?? ""}`)
      .join("\n")
  );
}

/** The first 200 lines of a doc, for the ADR `Status:` scan. */
function sourceHeadOf(index: DocsIndex, docPath: string): string {
  const doc = index.parsed.get(docPath);
  if (!doc) {
    return "";
  }
  // The status always sits in the preamble or the depth-1 section, which are the
  // first two sections; reading them beats re-opening the file.
  return doc.sections
    .slice(0, 2)
    .map((section) => section.text)
    .join("\n");
}

function pushCitation(index: DocsIndex, key: string, ref: CitationRef): void {
  const bucket = index.citations.get(key);
  if (bucket) {
    const existing = bucket.find(
      (entry) => entry.sectionId === ref.sectionId && entry.via === ref.via
    );
    if (existing) {
      existing.mentionLines = [
        ...new Set([...existing.mentionLines, ...ref.mentionLines]),
      ].sort((a, b) => a - b);
      return;
    }
    bucket.push(ref);
  } else {
    index.citations.set(key, [ref]);
  }
}

function pushBacklink(index: DocsIndex, key: string, sectionId: string): void {
  const bucket = index.backlinks.get(key);
  if (bucket) {
    if (!bucket.includes(sectionId)) {
      bucket.push(sectionId);
    }
  } else {
    index.backlinks.set(key, [sectionId]);
  }
}

// ── revalidation ─────────────────────────────────────────────────────────────

type Verdict = "fresh" | "files" | "rebuild";

/**
 * Revalidate before answering, CHEAPEST FIRST — which is also the order the code
 * runs in, so a stale index never pays for the probes below it:
 *
 * 1. older than the TTL        → rebuild (arithmetic, free)
 * 2. the git INDEX moved       → rebuild (one `statSync`; this is what makes a
 *                                `git add` of a CITED source file visible, so an
 *                                anchor's `tracked` flag can flip)
 * 3. HEAD moved                → rebuild (the probe the caller already made)
 * 4. the corpus path set moved → rebuild (one `git ls-files`, ~14 ms)
 * 5. a file's (size, mtimeMs)  → re-parse THAT file, re-derive everything
 *
 * Step 1 is listed first because it is the BACKSTOP for what 2–5 structurally
 * cannot see: a non-git workspace, two writes inside one mtime tick, and an
 * untracked NON-markdown file appearing or vanishing (which changes the
 * known-file set without touching the git index or the markdown corpus). Same
 * role `TRACKED_TTL_MS` plays at
 * `backend/src/lib/anchor-resolution.ts:106-123`.
 *
 * Warm cost on this repository: one `statSync`, one `git ls-files`, and ~180
 * more `statSync` calls — measured ~22 ms, against a ~415 ms rebuild. That ratio
 * is why this runs on EVERY call.
 */
async function revalidate(index: DocsIndex, probe: RepoProbe): Promise<Verdict> {
  if (Date.now() - index.builtAtMs > DOCS_INDEX_TTL_MS) {
    return "rebuild";
  }
  if (probe.head !== index.builtAtCommit) {
    return "rebuild";
  }
  if (gitIndexStamp(index.root) !== index.gitIndexStamp) {
    return "rebuild";
  }
  const selector = await enumerateCorpus(index.root, probe.gitAvailable);
  if (
    selector.source !== index.corpusSource ||
    selector.paths.length !== index.selectorPaths.length ||
    selector.paths.some((value, i) => value !== index.selectorPaths[i])
  ) {
    return "rebuild";
  }
  for (const [docPath, previous] of index.stats) {
    // FENCED BEFORE THE `stat`, not after: a doc swapped for a symlink out of the
    // workspace would otherwise have its size and mtime read from outside the
    // root. `files` hands it to the refresh, which refuses it BY NAME.
    const contained = containedPath(index.root, path.join(index.root, docPath));
    if (!contained.contained) {
      return "files";
    }
    let stat;
    try {
      stat = statSync(contained.path);
    } catch {
      return "rebuild";
    }
    if (stat.size !== previous.size || stat.mtimeMs !== previous.mtimeMs) {
      return "files";
    }
  }
  return "fresh";
}

/** Re-parse only the files whose `(size, mtimeMs)` moved, then re-derive. */
async function refreshChangedFiles(
  index: DocsIndex,
  probe: RepoProbe
): Promise<void> {
  for (const [docPath, previous] of index.stats) {
    const absolute = path.join(index.root, docPath);
    // A doc REPLACED by an escaping symlink under the running index: dropped,
    // LISTED, and never opened — the same verdict the cold build gives it.
    const contained = containedPath(index.root, absolute);
    if (!contained.contained) {
      index.parsed.delete(docPath);
      index.stats.delete(docPath);
      if (!index.skipped.some((entry) => entry.path === docPath)) {
        index.skipped.push({ path: docPath, reason: contained.reason });
      }
      continue;
    }
    const cleared = contained.path;
    let stat;
    try {
      stat = statSync(cleared);
    } catch {
      continue;
    }
    if (stat.size === previous.size && stat.mtimeMs === previous.mtimeMs) {
      continue;
    }
    try {
      index.parsed.set(docPath, parseMarkdown(docPath, readFileSync(cleared, "utf8")));
      index.stats.set(docPath, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      index.parsed.delete(docPath);
      index.stats.delete(docPath);
      if (!index.skipped.some((entry) => entry.path === docPath)) {
        index.skipped.push({ path: docPath, reason: "parse failed on refresh" });
      }
    }
  }
  // An edit to a tracked doc makes the WORKTREE dirty, and a refresh that kept
  // the previous answer would report a clean tree it no longer describes.
  index.worktreeDirty = probe.gitAvailable ? await worktreeDirty(index.root) : null;
  deriveIndex(index);
}

/**
 * ONE entry per repository root, PROMISE-valued so two concurrent callers share
 * one build instead of racing to spawn two — the same memo shape
 * `backend/src/lib/anchor-resolution.ts:91-100` uses.
 */
const indexCache = new Map<string, Promise<DocsIndex>>();

/** Test seam, and what `muon docs index` will call: drop every memoized index. */
export function clearDocsIndexCache(): void {
  indexCache.clear();
}

/**
 * The one entry point. Revalidates, rebuilds when it must, and answers from an
 * index that describes the tree as it is right now.
 */
export async function ensureDocsIndex(
  startDir: string,
  options: { force?: boolean } = {}
): Promise<DocsIndex> {
  const probe = await repoProbe(startDir);
  const root = probe.root;
  if (options.force) {
    indexCache.delete(root);
  }
  const cached = indexCache.get(root);
  if (cached) {
    let index: DocsIndex | null = null;
    try {
      index = await cached;
    } catch {
      indexCache.delete(root);
    }
    if (index) {
      const verdict = await revalidate(index, probe);
      if (verdict === "fresh") {
        return index;
      }
      if (verdict === "files") {
        await refreshChangedFiles(index, probe);
        return index;
      }
      indexCache.delete(root);
    }
  }
  const building = buildDocsIndex(root, probe);
  indexCache.set(root, building);
  try {
    return await building;
  } catch (error) {
    indexCache.delete(root);
    throw error;
  }
}
