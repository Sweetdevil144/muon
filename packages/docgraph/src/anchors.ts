import path from "node:path";
import { normalizeCitationPath, normalizeLinkTarget } from "./corpus.js";
import { DOCS_MAX_ANCHORS_PER_SECTION, evidenceFor, type DocsEvidence } from "./bounds.js";
import type { RawLink } from "./parse.js";

/**
 * Doc → code and doc → doc anchors, resolved against `git ls-files`, never the
 * filesystem, and never by guessing (ADR-0053 §7, blueprint §3.6).
 *
 * WHY NOT `stat`. Verbatim from `backend/src/lib/anchor-resolution.ts:22-28`:
 * macOS APFS is case-insensitive by default, so `stat("apps/cli/readme.md")`
 * SUCCEEDS and a filesystem check silently accepts the wrong spelling — and the
 * wrong spelling is a DIFFERENT anchor string. The known-file set also carries
 * the CANONICAL spelling, which is what a citation has to be compared against.
 *
 * WHY THE INLINE CODE SPAN IS THE CHANNEL. Measured on this corpus: 1,660
 * path-shaped code spans resolve exactly against `git ls-files`, against 21
 * relative markdown links to non-`.md` files. The dominant citation channel in
 * this repository is the code span, and an indexer that only followed links
 * would see under 2% of what the docs actually reference.
 *
 * `unresolved` IS AN ASSERTION ABOUT THE REPOSITORY and is never written without
 * the set. When the set could not be obtained every state is `null`.
 */

/** The five states of a code anchor. `null` ⇒ we could not obtain the known set. */
export type AnchorResolution =
  | "resolved"
  | "suffix-resolved"
  | "ambiguous"
  | "unresolved"
  | null;

/** A link's resolution. `external` covers `http(s):`, `mailto:`, a bare `#`, and
 *  any target that normalizes OUTSIDE the repository root. */
export type LinkResolution = "external" | "resolved" | "unresolved" | null;

export type CodeAnchor = {
  /** The code span verbatim, `:LINE` suffix included. */
  raw: string;
  /** The canonicalized repo-relative candidate path (no line suffix). */
  path: string;
  resolution: AnchorResolution;
  /** The full path the anchor names. `null` for `ambiguous` and `unresolved`. */
  resolvedPath: string | null;
  /** `true` only for `suffix-resolved` — an inference, and labeled as one. */
  inferred: boolean;
  /** How many known paths share this tail. Meaningful for `ambiguous`. */
  candidates: number;
  /** `false` ⇒ exists but never `git add`ed. `null` ⇒ nothing to ask about. */
  tracked: boolean | null;
  /** The line numbers the citation itself named (`file.ts:1040-1977`). */
  lines: number[] | null;
  via: "codespan";
};

export type DocLink = {
  text: string;
  href: string;
  /** Repo-relative POSIX target, or `null` when the link is external. */
  target: string | null;
  /** The `#fragment`, or `null`. */
  anchor: string | null;
  resolution: LinkResolution;
  resolvedPath: string | null;
  tracked: boolean | null;
  /** `${target}#${anchor}` when the target is a markdown file carrying one. */
  targetSectionId: string | null;
  /** Whether that section id exists. `null` when there is nothing to check. */
  anchorResolution: "resolved" | "unresolved" | null;
};

/**
 * The known-file set plus its ≤4-segment tail index, built once per rebuild.
 *
 * A `null` `known` set is the honest "we hold nothing" state and makes every
 * resolution `null` — the one rule this module has.
 */
export class KnownFiles {
  private readonly tails: Map<string, string[]> | null;
  /**
   * Every ancestor directory of a known file. `git ls-files` lists FILES, so
   * without this a real link like `docs/README.md`'s `[adr/](adr/)` reads
   * `unresolved` — a claim that this repository has no ADR directory.
   */
  private readonly directories: ReadonlySet<string> | null;

  constructor(
    readonly known: ReadonlySet<string> | null,
    readonly tracked: ReadonlySet<string> | null
  ) {
    if (!known) {
      this.tails = null;
      this.directories = null;
      return;
    }
    const directories = new Set<string>();
    const tails = new Map<string, string[]>();
    for (const file of known) {
      const segments = file.split("/");
      for (let cut = 1; cut < segments.length; cut += 1) {
        directories.add(segments.slice(0, cut).join("/"));
      }
      // Two segments minimum: a candidate must contain `/` to be path-shaped at
      // all, so a basename-only index would only add ambiguity nobody can query.
      for (let k = 2; k <= Math.min(4, segments.length); k += 1) {
        const tail = segments.slice(segments.length - k).join("/");
        const bucket = tails.get(tail);
        if (bucket) {
          bucket.push(file);
        } else {
          tails.set(tail, [file]);
        }
      }
    }
    for (const bucket of tails.values()) {
      bucket.sort();
    }
    this.tails = tails;
    this.directories = directories;
  }

  trackedFor(file: string | null): boolean | null {
    if (file === null || !this.tracked) {
      return null;
    }
    return this.tracked.has(file);
  }

  /** Does the repository hold a DIRECTORY at this path? */
  hasDirectory(candidate: string): boolean {
    return this.directories?.has(candidate.replace(/\/+$/, "")) ?? false;
  }

  /** Exact match, then a UNIQUE ≤4-segment tail, then the assertion. */
  resolve(candidate: string): {
    resolution: AnchorResolution;
    resolvedPath: string | null;
    candidates: number;
  } {
    if (!this.known || !this.tails) {
      return { resolution: null, resolvedPath: null, candidates: 0 };
    }
    if (this.known.has(candidate)) {
      return { resolution: "resolved", resolvedPath: candidate, candidates: 1 };
    }
    const matches = this.tails.get(candidate) ?? [];
    if (matches.length === 1) {
      return {
        resolution: "suffix-resolved",
        resolvedPath: matches[0],
        candidates: 1,
      };
    }
    if (matches.length > 1) {
      // NEVER RESOLVED BY PICKING. `src/index.ts` matches twelve tracked files
      // in this repository; choosing one would be a confidently wrong citation.
      return { resolution: "ambiguous", resolvedPath: null, candidates: matches.length };
    }
    return { resolution: "unresolved", resolvedPath: null, candidates: 0 };
  }
}

/**
 * A code span is a path CANDIDATE when it contains `/`, carries a 1–6 character
 * extension, and is made only of `[A-Za-z0-9._@/-]` plus an optional trailing
 * line reference.
 *
 * The line grammar is `:12`, `:12-40` and — an EXTENSION over blueprint §3.6,
 * which named only the first two — a comma-separated list of either
 * (`scripts/check-docs.mjs:72,83-86`). That spelling is real in this corpus and
 * under the stricter grammar the whole span fails the character class and the
 * citation is lost, which is a worse answer than a slightly wider parser.
 */
const CODE_SPAN_CANDIDATE =
  /^([A-Za-z0-9._@/-]+?)(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,6}$/;

export type CodeSpanCandidate = { path: string; lines: number[] | null };

/**
 * Split a code span into a repo-relative candidate path and the lines it named,
 * or `null` when the span is not path-shaped.
 *
 * Canonicalized BEFORE lookup — backslashes to `/`, a leading `./` dropped, and
 * a span beginning `../` resolved against the referring document's directory —
 * the same normalization `packages/mcp/src/gitnexus-tools.ts:1783` applies to a
 * caller-supplied path. Both spellings are real citations in this corpus
 * (`./build.sh`, `../design/markdown-docs-index.md`) and a raw lookup reports
 * them `unresolved`, which is the wrong answer rather than a cautious one.
 */
export function codeSpanCandidate(
  span: string,
  docPath: string
): CodeSpanCandidate | null {
  const text = span.trim();
  if (!text.includes("/")) {
    return null;
  }
  const match = CODE_SPAN_CANDIDATE.exec(text);
  if (!match) {
    return null;
  }
  const [, rawPath, rawLines] = match;
  if (!HAS_EXTENSION.test(rawPath)) {
    return null;
  }
  const normalized = normalizeCitationPath(path.posix.dirname(docPath), rawPath);
  if (!normalized) {
    return null;
  }
  const lines = rawLines
    ? [
        ...new Set(
          rawLines
            .split(",")
            .flatMap((part) => part.split("-"))
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isFinite(value))
        ),
      ].sort((a, b) => a - b)
    : null;
  return { path: normalized, lines };
}

const EXTERNAL_HREF = /^(https?:|mailto:|#|<)/i;

/**
 * Resolve a markdown link, relative to the referring file's directory, with the
 * `#anchor` split off first — exactly as `scripts/check-docs.mjs:96-109` does.
 *
 * A target that normalizes outside the repository root is `external`: this index
 * describes ONE repository and will not make a claim about a path beyond it. It
 * is a string decision — nothing is stat'd and nothing is opened.
 */
export function resolveLink(
  link: RawLink,
  docPath: string,
  known: KnownFiles
): DocLink {
  const href = link.href.trim();
  const base: DocLink = {
    text: link.text,
    href,
    target: null,
    anchor: null,
    resolution: "external",
    resolvedPath: null,
    tracked: null,
    targetSectionId: null,
    anchorResolution: null,
  };
  if (!href || EXTERNAL_HREF.test(href)) {
    // A bare `#anchor` is EXTERNAL to the resolver, per
    // `scripts/check-docs.mjs:78-84`, but the fragment is still carried so a
    // reader can see which heading a same-document link points at.
    return href.startsWith("#") ? { ...base, anchor: href.slice(1) } : base;
  }
  const hash = href.indexOf("#");
  const rawTarget = hash < 0 ? href : href.slice(0, hash);
  const anchor = hash < 0 ? null : href.slice(hash + 1);
  if (!rawTarget) {
    return { ...base, anchor };
  }
  const target = normalizeLinkTarget(path.posix.dirname(docPath), rawTarget);
  if (!target) {
    return { ...base, anchor };
  }
  const resolution: LinkResolution = !known.known
    ? null
    : known.known.has(target) || known.hasDirectory(target)
      ? "resolved"
      : "unresolved";
  const resolvedPath = resolution === "resolved" ? target : null;
  return {
    ...base,
    target,
    anchor,
    resolution,
    resolvedPath,
    // A DIRECTORY is never in the tracked set, and reporting `false` there would
    // read as "exists but never git add'ed", which is a different claim.
    tracked: known.known?.has(target) ? known.trackedFor(target) : null,
    targetSectionId:
      anchor !== null && target.endsWith(".md") ? `${target}#${anchor}` : null,
    anchorResolution: null,
  };
}

/**
 * Turn a section's code spans into anchors, dropping any that merely repeat a
 * markdown link the same section already carries (blueprint §3.6) and bounding
 * the result at {@link DOCS_MAX_ANCHORS_PER_SECTION}.
 */
export function resolveCodeAnchors(
  codeSpans: readonly string[],
  docPath: string,
  links: readonly DocLink[],
  known: KnownFiles
): { anchors: CodeAnchor[]; evidence: DocsEvidence } {
  const linkedTargets = new Set(
    links.map((link) => link.target).filter((value): value is string => value !== null)
  );
  const anchors: CodeAnchor[] = [];
  const seen = new Set<string>();
  for (const span of codeSpans) {
    const candidate = codeSpanCandidate(span, docPath);
    if (!candidate) {
      continue;
    }
    if (candidate.path.endsWith(".md") && linkedTargets.has(candidate.path)) {
      continue;
    }
    const key = `${candidate.path}::${candidate.lines?.join(",") ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const { resolution, resolvedPath, candidates } = known.resolve(candidate.path);
    anchors.push({
      raw: span.trim(),
      path: candidate.path,
      resolution,
      resolvedPath,
      inferred: resolution === "suffix-resolved",
      candidates,
      tracked: known.trackedFor(resolvedPath),
      lines: candidate.lines,
      via: "codespan",
    });
  }
  const evidence = evidenceFor(
    "codeAnchors",
    anchors.length,
    DOCS_MAX_ANCHORS_PER_SECTION
  );
  return { anchors: anchors.slice(0, DOCS_MAX_ANCHORS_PER_SECTION), evidence };
}
