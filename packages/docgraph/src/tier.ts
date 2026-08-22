import type { DocLink } from "./anchors.js";
import type { ParsedDoc } from "./parse.js";

/**
 * Tier is DATA, derived from the repository's own precedence declaration
 * (ADR-0053 §4, blueprint §3.5).
 *
 * `docs/README.md` exists solely to stop a reader treating a historical plan as
 * the current product boundary, and it states the precedence order in prose. So
 * the canon set is read from that document's own outbound link edges rather than
 * transcribed into a TypeScript constant that would drift from it the first time
 * someone edits the index and not the code.
 *
 * TWO RULES MAKE THIS SAFE.
 *
 * NEVER DERIVE CANON BY SUBTRACTION. A new directory must not become canon by
 * not being listed; everything unmatched is `unclassified`, which is a real,
 * honest tier and never the top one. (`tier-derivation-by-subtraction` is a
 * mistake this repository has already paid for twice.)
 *
 * AN EMPTY CANON SET IS A LOUD DEGRADATION ON EVERY RESPONSE, never a quiet
 * reclassification. `scripts/check-docs.mjs:144-158` is the precedent: a
 * validator that could not validate used to print a friendly SKIP and report
 * success, and twelve files with broken diagrams passed that way.
 */

export type DocTier = "canon" | "adr" | "proposal" | "historical" | "unclassified";

export type AdrStatus = "accepted" | "proposed" | "superseded" | "unknown";

/**
 * Canon by repository CONVENTION, not by the index — these five are not linked
 * from `docs/README.md` and would otherwise read as `unclassified`.
 *
 * The constant exists so that gap is VISIBLE rather than accidental, and a test
 * asserts every entry is in the corpus, so a rename fails loudly instead of
 * silently demoting the repository's front door.
 */
export const ROOT_CANON: readonly string[] = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "VISION.md",
  "docs/README.md",
];

/** The precedence declaration, and the heading whose links ARE the canon set. */
export const CANON_INDEX_PATH = "docs/README.md";
export const CANON_HEADING = "Canonical current documents";

/** Directory rules, in order. Deliberately positive — nothing becomes canon here. */
const DIRECTORY_RULES: ReadonlyArray<{ prefix: string; tier: DocTier }> = [
  { prefix: "docs/adr/", tier: "adr" },
  { prefix: "docs/design/", tier: "proposal" },
  { prefix: "docs/plans/", tier: "historical" },
  { prefix: "docs/research/", tier: "historical" },
  { prefix: "docs/superpowers/", tier: "historical" },
];

export type CanonSet = {
  paths: ReadonlySet<string>;
  /** Where the canon tier came from — carried on every response's provenance. */
  source: "docs/README.md" | "root-supplement-only";
};

/**
 * The canon set: {@link ROOT_CANON} plus the link targets under
 * `docs/README.md`'s `## Canonical current documents` heading.
 *
 * `source: "root-supplement-only"` means the index was absent, its heading did
 * not match, or the section yielded no resolvable link — each of which raises a
 * degradation on every response rather than quietly narrowing canon to five
 * files nobody asked it to narrow.
 */
export function deriveCanonSet(
  index: ParsedDoc | undefined,
  linksOf: (sectionId: string) => readonly DocLink[]
): CanonSet {
  const paths = new Set<string>(ROOT_CANON);
  if (!index) {
    return { paths, source: "root-supplement-only" };
  }
  const wanted = CANON_HEADING.toLowerCase();
  const section = index.sections.find(
    (candidate) => (candidate.heading ?? "").trim().toLowerCase() === wanted
  );
  if (!section) {
    return { paths, source: "root-supplement-only" };
  }
  let derived = 0;
  for (const link of linksOf(section.id)) {
    // The TARGET, resolved relative to `docs/`, not the raw href — the index
    // links `../ROADMAP.md` and `research/…` in the same list.
    if (link.target && link.target.endsWith(".md")) {
      paths.add(link.target);
      derived += 1;
    }
  }
  return {
    paths,
    source: derived > 0 ? "docs/README.md" : "root-supplement-only",
  };
}

/**
 * The tier of one document. First match wins, and the order is the ADR's:
 * root supplement, then the derived canon set, then the POSITIVE directory
 * rules, then `unclassified`.
 */
export function tierOf(docPath: string, canon: CanonSet): DocTier {
  if (canon.paths.has(docPath)) {
    return "canon";
  }
  for (const rule of DIRECTORY_RULES) {
    if (docPath.startsWith(rule.prefix)) {
      return rule.tier;
    }
  }
  return "unclassified";
}

/**
 * The ADR's declared status, parsed from the FIRST `Status:` line above the
 * first `##` heading — which is where every one of this corpus's four header
 * styles puts it (`- **Status:** Accepted (2026-08-17)`,
 * `**Status:** Accepted (P0) · **Date:** …`, `Status: accepted`,
 * `Status: accepted · 2026-08-11`).
 *
 * `superseded` is tested FIRST so an ADR that says "Accepted, later superseded"
 * reads as superseded; `\b` word boundaries keep "supersedes ADR-0007" from
 * retiring a live decision. Anything that does not name one of the three is
 * `unknown` — NEVER `accepted`. Two ADRs in this corpus say "IMPLEMENTED" and
 * nothing else, and calling those accepted would be inventing a verdict.
 */
export function adrStatusOf(rawSource: string): AdrStatus {
  for (const line of rawSource.split("\n")) {
    if (/^\s{0,3}##\s/.test(line)) {
      break;
    }
    if (!/status\s*:/i.test(line)) {
      continue;
    }
    if (/\bsuperseded\b/i.test(line)) {
      return "superseded";
    }
    if (/\bproposed\b/i.test(line)) {
      return "proposed";
    }
    if (/\baccepted\b/i.test(line)) {
      return "accepted";
    }
    return "unknown";
  }
  return "unknown";
}

/**
 * The BOUNDED multiplicative tier prior, in [0.5, 1.0] (ADR-0053 §5).
 *
 * IT MAY DEMOTE; IT MAY NEVER EXCLUDE. A historical section that is the only
 * lexical answer still returns, labeled `historical`. `tier` as a caller
 * ARGUMENT is a hard filter and is a different thing entirely.
 */
export const TIER_PRIOR: Readonly<Record<DocTier, number>> = {
  canon: 1.0,
  adr: 1.0,
  proposal: 0.8,
  unclassified: 0.7,
  historical: 0.6,
};

const ADR_STATUS_PRIOR: Readonly<Record<AdrStatus, number>> = {
  accepted: 1.0,
  proposed: 0.9,
  unknown: 0.9,
  superseded: 0.5,
};

export function priorFor(tier: DocTier, adrStatus: AdrStatus | null): number {
  if (tier === "adr" && adrStatus) {
    return ADR_STATUS_PRIOR[adrStatus];
  }
  return TIER_PRIOR[tier];
}

/** A section is HISTORICAL when its tier says so, or its ADR was superseded. */
export function isHistorical(tier: DocTier, adrStatus: AdrStatus | null): boolean {
  return tier === "historical" || adrStatus === "superseded";
}

/** The one-line precedence statement carried on every `docsQuery` response. */
export const DOCS_PRECEDENCE =
  "progress.md → ROADMAP.md → Future.md → accepted ADRs; plans/ and research/ are historical.";
