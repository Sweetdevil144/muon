import { tokenize } from "@muon/graph/memory-ranking";
import type { DocSection } from "./index-build.js";
import { priorFor } from "./tier.js";

/**
 * Ranking is FLAT (ADR-0021, restated by ADR-0053 §5): a single lexical BM25
 * pass over SECTIONS. No traversal, no expansion, no centrality. `CONTAINS`,
 * `LINKS_TO` and `MENTIONS_CODE` exist for context, impact and human
 * navigation; wiring any of them into ranking requires overturning ADR-0021
 * with evidence, not an intuition.
 *
 * THE TOKENIZER IS IMPORTED, not re-implemented. `tokenize` is
 * `packages/graph/src/memory-ranking.ts:26` — the same function memory
 * retrieval ranks with — reached through a NARROW subpath export
 * (`@muon/graph/memory-ranking`) rather than the barrel, because the barrel
 * transitively loads LadybugDB's native addon and this package is pure JS by
 * design. Sharing it is the point: two tokenizers that drift are two different
 * retrieval systems wearing one name.
 */

/** Okapi BM25's standard operating point. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * `tokenize`, plus ONE normalization applied SYMMETRICALLY to bodies and to
 * queries: a trailing `.`, `-` or `_` is trimmed.
 *
 * MEASURED, not stylistic. `tokenize`'s character class deliberately keeps `.`
 * so `docs/README.md` survives as one term — which also means a SENTENCE-FINAL
 * word keeps its full stop. "…retrieval is flat." tokenizes to `flat.`, and a
 * query for `flat` then matches nothing, silently, for every term that happens
 * to end a sentence. Prose is the one corpus where that is the common case.
 *
 * The fix lives HERE and not in `tokenize` on purpose: `tokenize` is shared with
 * memory ranking (upstream impact: HIGH, 9 symbols, 2 direct callers) and
 * changing it would silently re-rank the memory graph. This is a normalization of
 * the tokenizer's INPUT and OUTPUT on both sides of the comparison, so the two
 * systems still agree on what a token IS.
 */
export function docTerms(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    const trimmed = token.replace(/[.\-_]+$/, "");
    if (trimmed.length > 1) {
      out.push(trimmed);
    }
  }
  return out;
}

export type RankedSection = {
  section: DocSection;
  /** BM25 × the bounded tier prior. */
  score: number;
  /** BM25 before the prior, so a caller can see what the prior did. */
  lexical: number;
};

/** One section's term frequencies and token length, computed once per build. */
export type SectionTerms = { tf: Map<string, number>; length: number };

/**
 * Tokenize every section ONCE, at build time.
 *
 * Doing this per query re-tokenized 3.3 MB of prose on every call and put a warm
 * `docs_query` at 138 ms, past the blueprint's 50 ms ceiling. Hoisted into the
 * build it costs nothing extra (the build already reads every byte) and the
 * query drops to a term lookup per candidate.
 */
export function buildSectionTerms(
  sections: Iterable<DocSection>
): Map<string, SectionTerms> {
  const out = new Map<string, SectionTerms>();
  for (const section of sections) {
    const terms = docTerms(section.text);
    const tf = new Map<string, number>();
    for (const term of terms) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    out.set(section.id, { tf, length: terms.length });
  }
  return out;
}

/**
 * BM25 over the sections given, then the BOUNDED multiplicative tier prior.
 *
 * The prior lives in [0.5, 1.0]: it MAY DEMOTE, it MAY NEVER EXCLUDE. A
 * `historical` section that is the only lexical match is still returned, ranked
 * and labeled — which is the whole difference between a prior and a filter. A
 * section with no query term at all scores 0 and is dropped, because a zero
 * lexical match is an absence of evidence, not a weak one.
 *
 * Document frequency and average length are computed over the sections PASSED
 * IN, so a caller-chosen hard filter (`tier`, `pathPrefix`, `fenceLang`)
 * genuinely narrows the corpus rather than re-weighting the whole of it. Only
 * the QUERY's terms are counted, so that pass is O(sections × query terms).
 */
export function rankSections(
  sections: readonly DocSection[],
  terms: ReadonlyMap<string, SectionTerms>,
  query: string
): RankedSection[] {
  const unique = [...new Set(docTerms(query))];
  if (unique.length === 0 || sections.length === 0) {
    return [];
  }

  const df = new Map<string, number>();
  let totalLength = 0;
  for (const section of sections) {
    const entry = terms.get(section.id);
    if (!entry) {
      continue;
    }
    totalLength += entry.length;
    for (const term of unique) {
      if (entry.tf.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }
  const averageLength = totalLength / sections.length;

  const ranked: RankedSection[] = [];
  for (const section of sections) {
    const entry = terms.get(section.id);
    if (!entry || entry.length === 0) {
      continue;
    }
    let lexical = 0;
    for (const term of unique) {
      const frequency = entry.tf.get(term);
      if (!frequency) {
        continue;
      }
      const seen = df.get(term) ?? 0;
      const idf = Math.log(1 + (sections.length - seen + 0.5) / (seen + 0.5));
      const norm =
        averageLength === 0
          ? 1
          : 1 - BM25_B + BM25_B * (entry.length / averageLength);
      lexical += (idf * (frequency * (BM25_K1 + 1))) / (frequency + BM25_K1 * norm);
    }
    if (lexical <= 0) {
      continue;
    }
    ranked.push({
      section,
      lexical,
      score: lexical * priorFor(section.tier, section.adrStatus),
    });
  }
  // Deterministic: equal scores fall back to the section id, so two builds of
  // the same corpus produce byte-identical result lists.
  ranked.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id));
  return ranked;
}
