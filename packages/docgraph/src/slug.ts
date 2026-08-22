/**
 * GitHub-compatible heading slugs, with per-document `-1`/`-2` disambiguation
 * (blueprint §3.3).
 *
 * WHY THIS AND NOT AN ORDINAL OR A CONTENT HASH. The slug is what every
 * `[x](../adr/0021-….md#4-consequences)` link in this corpus already points at,
 * so a doc→section edge resolves with no extra machinery; it is stable across
 * CONTENT edits (an ordinal is not — inserting one section renumbers every later
 * one); it is human-quotable in a refusal; and it CHANGES when the heading is
 * renamed, which is correct — a renamed section is a different coordinate and a
 * stale citation must fail loudly rather than land on the neighbour.
 */

/**
 * Everything GitHub DELETES from a heading: any character that is not a letter
 * (`\p{L}`), a mark (`\p{M}`), a number (`\p{N}`), a space, `-` or `_`.
 *
 * Stated as the complement on purpose. `github-slugger` ships a generated class
 * of every Unicode punctuation and symbol range, which nobody can audit by
 * reading; the complement says the same thing about this corpus in one
 * expression — punctuation and symbols go, the two ASCII connectors stay, and
 * letters/marks/numbers of any script survive.
 */
const NOT_SLUG_SAFE = /[^\p{L}\p{M}\p{N} _-]/gu;

/**
 * Slugify one heading's PLAIN TEXT (inline markdown already flattened — GitHub
 * slugs the rendered text, so `**Status:**` slugs as `status`).
 *
 * GITHUB'S ALGORITHM, NOT A PARAPHRASE OF IT: lowercase, delete
 * {@link NOT_SLUG_SAFE}, then turn each remaining SPACE into a hyphen. Three
 * consequences a paraphrase gets wrong, all three live in this corpus:
 *
 * - RUNS OF SPACES ARE NOT COLLAPSED and the result is NOT TRIMMED. Deleting the
 *   `&` from `Status & evidence` leaves the two spaces that surrounded it, so the
 *   id is `status--evidence`; the same holds for the em dash this repository's
 *   headings are full of (`Wave 0 — Spine stability` → `wave-0--spine-stability`).
 *   `README.md` links `#status--evidence` and `ROADMAP.md` links
 *   `#release-cycle-2026-08--15-human--15-agent` — anchors copied out of GitHub's
 *   own rendered page, and a collapse-and-trim slug resolved NEITHER. Measured on
 *   2026-08-17: it gave 661 of this corpus's 2,776 sections an id that no link
 *   written against GitHub can address.
 * - A LEADING OR TRAILING EMOJI leaves a leading or trailing hyphen (`## 📦
 *   Installation` → `-installation`). That is GitHub's own well-known artifact,
 *   not untidiness to fix here.
 * - LETTERS, MARKS AND NUMBERS OUTSIDE ASCII SURVIVE (`… shape ½ day` keeps its
 *   `½`). Stripping them mints an id no `#anchor` in the corpus points at.
 *
 * Pinned against the real thing rather than against this comment: every
 * intra-repository `#anchor` that resolves must equal the slug of the heading it
 * names, driven off the live corpus in `tests/slug.test.ts`.
 */
export function slugify(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(NOT_SLUG_SAFE, "")
    .replace(/ /g, "-");
}

/**
 * Per-document slug disambiguator. Repeated headings inside ONE document get
 * `-1`, `-2`… appended in document order, exactly as GitHub numbers them; the
 * first occurrence keeps the bare slug.
 *
 * A COUNTER IS NOT EQUIVALENT TO THE LOOP, and the difference is a lost section.
 * In a document holding `## Foo`, `## Foo 1`, `## Foo`, the third heading must be
 * `foo-2`, because `foo-1` is ALREADY TAKEN by a real heading; a bare counter
 * hands out `foo-1` twice, and since a section id is the key of
 * `DocsIndex.sections`, the second occurrence silently OVERWRITES the first and
 * one section of that document becomes unaddressable — no refusal, no
 * degradation, just a coordinate that answers about the wrong prose. So every
 * slug this class emits is registered, synthetic suffix or real heading alike,
 * and a taken suffix is skipped rather than reused. That is `github-slugger`'s
 * own loop, which is also why a link copied from GitHub still lands.
 *
 * Scoped to one document on purpose: a section id is `${docPath}#${slug}`, so
 * two documents sharing a heading are already distinct ids and must not perturb
 * each other's numbering.
 */
export class SlugDeduper {
  private readonly occurrences = new Map<string, number>();

  next(headingText: string): string {
    const base = slugify(headingText);
    let slug = base;
    while (this.occurrences.has(slug)) {
      const count = (this.occurrences.get(base) ?? 0) + 1;
      this.occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    this.occurrences.set(slug, 0);
    return slug;
  }
}

/** A section id is `${docPath}#${slug}`; the synthetic preamble uses an empty slug. */
export function sectionIdOf(docPath: string, slug: string): string {
  return `${docPath}#${slug}`;
}

/**
 * Split a section id back into its two halves, or `null` when the value carries
 * no `#` at all (i.e. it is a document path, not a section id).
 *
 * Splits on the LAST `#`: a POSIX path may legally contain `#`, and the slug
 * never can (`slugify` strips it), so the last `#` is unambiguously the
 * delimiter. Splitting on the first would mis-address `docs/weird#name.md#intro`.
 */
export function parseSectionId(
  value: string
): { docPath: string; slug: string } | null {
  const cut = value.lastIndexOf("#");
  if (cut < 0) {
    return null;
  }
  return { docPath: value.slice(0, cut), slug: value.slice(cut + 1) };
}

/**
 * Levenshtein distance, capped — the "nearest section ids" a typed refusal offers
 * when a citation names a heading that has since been renamed (blueprint §5.2).
 * Iterative two-row form; the inputs are slugs, so they are short by construction.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0 || b.length === 0) {
    return Math.max(a.length, b.length);
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}
