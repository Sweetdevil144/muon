import fs from "node:fs";
import path from "node:path";

/**
 * ADR-0059 — memory cold-start seeds from disk, AS PROPOSALS.
 *
 * The extractors here are deliberately CONSERVATIVE and typed per source kind
 * (a POSITIVE list — D2): ADRs become decision candidates, CLAUDE.md/AGENTS.md
 * rule bullets become constraints, and a recognizable postmortem directory
 * becomes incident lessons. Nothing else. Extraction is lossy on purpose — a
 * candidate is a POINTER to its source plus a bounded summary, and the human's
 * review (the same confirm gate as every proposal) is what makes any of it
 * institutional.
 *
 * Idempotence rides the ledger's own content dedup: an unchanged source
 * yields byte-identical candidate text, which the ingest NOOPs as a
 * duplicate; a changed source yields new text, which is proposed. That is
 * D3's "re-running proposes only what is new or changed" without a second
 * bookkeeping store that could drift from the ledger.
 */

export type SeedCandidate = {
  readonly kind: "decision" | "constraint" | "attempt";
  readonly text: string;
  /** The file this was extracted from — the note's module anchor, so
   *  ADR-0058's anchor-existence check covers seeded notes from birth. */
  readonly sourcePath: string;
  readonly topics: readonly string[];
};

const MAX_TEXT = 480;

function bounded(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_TEXT
    ? collapsed
    : `${collapsed.slice(0, MAX_TEXT - 1)}…`;
}

/** One decision candidate per ADR: title + status + its "Decides" line.
 *  `displayPrefix` is the REPO-RELATIVE path of `adrDir` — it becomes each
 *  candidate's module anchor, so it must be the path `memory_ground` (and a
 *  human) can resolve from the repository root. The first version used the
 *  directory's basename ("adr/…"), which made every seeded ADR note fail its
 *  own birth-time anchor check (review finding). */
export function extractAdrSeeds(
  adrDir: string,
  displayPrefix: string = path.basename(adrDir)
): SeedCandidate[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(adrDir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const seeds: SeedCandidate[] = [];
  for (const name of entries.sort()) {
    const filePath = path.join(adrDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (!title) continue;
    const status = raw
      .match(/^\s*-\s+\*\*Status:\*\*\s*(.+)$/m)?.[1]
      ?.trim()
      ?.replace(/\s*\(.*$/, "");
    const decides = raw.match(/^\s*-\s+\*\*Decides:\*\*\s*([\s\S]+?)(?=^\s*-\s+\*\*|^##)/m)?.[1];
    const relative = path.join(displayPrefix, name);
    seeds.push({
      kind: "decision",
      text: bounded(
        `${title}${status ? ` [${status}]` : ""}${
          decides ? ` — decides: ${decides}` : ""
        } (seeded from ${relative})`
      ),
      sourcePath: relative,
      topics: ["seed", "adr"],
    });
  }
  return seeds;
}

/**
 * Constraint candidates from a rules file (CLAUDE.md / AGENTS.md): top-level
 * bullets under a heading whose name signals RULES ("Always", "Never",
 * "Rules", "Do", "Don't"), plus any bullet leading with bold MUST/NEVER.
 * Conservative on purpose: prose paragraphs never become constraints.
 */
export function extractRuleSeeds(
  filePath: string,
  displayPath: string = filePath
): SeedCandidate[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const seeds: SeedCandidate[] = [];
  const lines = raw.split("\n");
  let underRuleHeading = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      underRuleHeading = /\b(always|never|rules?|do\b|don'?t)\b/i.test(
        heading[1]!
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const body = bullet[1]!.trim();
    const imperative = /^\*\*(MUST|NEVER|ALWAYS|DO NOT|DON'T)/i.test(body);
    if (!underRuleHeading && !imperative) continue;
    if (body.length < 12) continue; // a link or a fragment, not a rule
    seeds.push({
      kind: "constraint",
      text: bounded(`${body} (seeded from ${displayPath})`),
      sourcePath: displayPath,
      topics: ["seed", "rules-file"],
    });
  }
  return seeds;
}

/** Incident-lesson candidates: one per file in a recognizable postmortem dir. */
export function extractPostmortemSeeds(repoRoot: string): SeedCandidate[] {
  const candidates = ["docs/postmortems", "docs/incidents", "postmortems"];
  for (const relative of candidates) {
    const dir = path.join(repoRoot, relative);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      continue;
    }
    return entries.sort().map((name) => {
      const filePath = path.join(dir, name);
      let title = name;
      try {
        title =
          fs.readFileSync(filePath, "utf8").match(/^#\s+(.+)$/m)?.[1]?.trim() ??
          name;
      } catch {
        // the filename stands in
      }
      const display = path.join(relative, name);
      return {
        kind: "attempt" as const,
        text: bounded(`Incident lesson: ${title} (seeded from ${display})`),
        sourcePath: display,
        topics: ["seed", "postmortem"],
      };
    });
  }
  return [];
}

export type SeedPlan = {
  readonly decisions: SeedCandidate[];
  readonly constraints: SeedCandidate[];
  readonly lessons: SeedCandidate[];
};

/** The whole plan, from a repo root. Reported BEFORE anything is staged (D4). */
export function buildSeedPlan(repoRoot: string): SeedPlan {
  const decisions = extractAdrSeeds(
    path.join(repoRoot, "docs", "adr"),
    path.join("docs", "adr")
  );
  const constraints = [
    ...extractRuleSeeds(path.join(repoRoot, "CLAUDE.md"), "CLAUDE.md"),
    ...extractRuleSeeds(path.join(repoRoot, "AGENTS.md"), "AGENTS.md"),
  ];
  const lessons = extractPostmortemSeeds(repoRoot);
  return { decisions, constraints, lessons };
}
