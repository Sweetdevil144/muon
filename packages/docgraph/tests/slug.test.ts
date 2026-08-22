import { describe, expect, it } from "vitest";
import type { DocsIndex } from "../src/index-build.js";
import { parseMarkdown } from "../src/parse.js";
import { SlugDeduper, slugify } from "../src/slug.js";
import { realCorpus } from "./real-corpus.js";

// T3, THE HALF A COMMENT CANNOT ASSERT. A section id IS the `#anchor` this
// repository's own links already point at, so the slugger is only correct if it
// reproduces GITHUB's algorithm — not a paraphrase of it. Every claim below is
// either a case from GitHub's own behaviour or a link harvested from the LIVE
// corpus, and the corpus half is what makes this a pin rather than a restatement
// of the implementation.

const FENCE = "```";

/** Heading text → its slug, through the parser, so `marked` flattens the inline
 *  markdown exactly as it does in production. */
function anchorOf(headingText: string): string {
  const doc = parseMarkdown("s.md", `# ${headingText}\n\nBody.\n`);
  return doc.sections[1].anchor;
}

describe("slugify is GitHub's algorithm", () => {
  it("deletes punctuation and lowercases, keeping `-` and `_`", () => {
    expect(slugify("4. Consequences")).toBe("4-consequences");
    expect(slugify("Status: Accepted (2026-08-17)")).toBe("status-accepted-2026-08-17");
    expect(slugify("snake_case and kebab-case")).toBe("snake_case-and-kebab-case");
    expect(slugify("What's the plan?!")).toBe("whats-the-plan");
  });

  it("leaves the spaces a deleted `&` or em dash was surrounded by", () => {
    // The whole finding in one line: a deleted character is NOT a deleted space,
    // so the id carries a DOUBLE hyphen. This repository's own README links
    // `#status--evidence`, copied out of GitHub's rendered page.
    expect(slugify("Status & evidence")).toBe("status--evidence");
    expect(slugify("GitNexus — Code Intelligence")).toBe("gitnexus--code-intelligence");
    expect(slugify("Human (15) — daily driver")).toBe("human-15--daily-driver");
  });

  it("never collapses a run of spaces and never trims the result", () => {
    expect(slugify("a  b")).toBe("a--b");
    expect(slugify("a   b")).toBe("a---b");
    expect(slugify(" leading and trailing ")).toBe("-leading-and-trailing-");
    expect(slugify("- dash bracketed -")).toBe("--dash-bracketed--");
  });

  it("deletes an emoji and keeps the hyphen it leaves behind", () => {
    // GitHub's own well-known artifact: `## 📦 Installation` is `#-installation`,
    // which is why so many READMEs link an anchor starting with a hyphen.
    expect(slugify("📦 Installation")).toBe("-installation");
    expect(slugify("Wave 0 — Spine stability 🔴")).toBe("wave-0--spine-stability-");
    expect(slugify("🎉")).toBe("");
  });

  it("keeps letters, marks and numbers outside ASCII", () => {
    expect(slugify("Café résumé")).toBe("café-résumé");
    expect(slugify("日本語の見出し")).toBe("日本語の見出し");
    expect(slugify("Слово")).toBe("слово");
    // `½` is a NUMBER (`\p{No}`), not a symbol: this exact heading is live in
    // `docs/research/memory-crew-coordination-gap-2026-08-10.md`.
    expect(slugify("shape ½ day")).toBe("shape-½-day");
  });

  it("slugs a numbers-only heading, and an empty one, without inventing text", () => {
    expect(slugify("42")).toBe("42");
    expect(slugify("1.2.3")).toBe("123");
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("slugs the RENDERED heading: a backticked code span contributes its text", () => {
    expect(anchorOf("`docs_query` and `docs_impact`")).toBe("docs_query-and-docs_impact");
    expect(anchorOf("**Status:** and _emphasis_")).toBe("status-and-emphasis");
    expect(anchorOf("`packages/mcp/src/docs-tools.ts` is the consumer")).toBe(
      "packagesmcpsrcdocs-toolsts-is-the-consumer"
    );
    // An entity is decoded before slugging, so `&amp;` behaves like `&`.
    expect(anchorOf("Tips &amp; tricks")).toBe("tips--tricks");
  });
});

describe("SlugDeduper numbers duplicates the way GitHub does", () => {
  it("appends -1, -2 in document order and leaves the first bare", () => {
    const deduper = new SlugDeduper();
    expect(["Foo", "Foo", "Foo"].map((heading) => deduper.next(heading))).toEqual([
      "foo",
      "foo-1",
      "foo-2",
    ]);
  });

  it("SKIPS a suffix already taken by a real heading, rather than colliding", () => {
    // The collision a bare counter produces: `Foo 1` slugs to `foo-1` on its own,
    // so the second `Foo` must become `foo-2`.
    const deduper = new SlugDeduper();
    expect(["Foo", "Foo 1", "Foo"].map((heading) => deduper.next(heading))).toEqual([
      "foo",
      "foo-1",
      "foo-2",
    ]);
  });

  it("dedups a real heading against a SYNTHETIC id too, in either order", () => {
    const deduper = new SlugDeduper();
    expect(["Foo", "Foo", "Foo 1"].map((heading) => deduper.next(heading))).toEqual([
      "foo",
      "foo-1",
      "foo-1-1",
    ]);
  });

  it("a document with the colliding shape keeps FIVE addressable sections", () => {
    // The consequence, at the level that matters: a section id is the key of
    // `DocsIndex.sections`, so a collision does not warn — it overwrites, and one
    // section of the document stops existing.
    const doc = parseMarkdown(
      "d.md",
      ["# Title", "", "## Foo", "a", "", "## Foo 1", "b", "", "## Foo", "c", ""].join("\n")
    );
    expect(doc.sections.map((section) => section.id)).toEqual([
      "d.md#",
      "d.md#title",
      "d.md#foo",
      "d.md#foo-1",
      "d.md#foo-2",
    ]);
    expect(new Set(doc.sections.map((section) => section.id)).size).toBe(
      doc.sections.length
    );
  });

  it("an all-punctuation heading does not take the PREAMBLE's `#` coordinate", () => {
    // `## !!!` slugs empty, and so does the synthetic preamble. Two sections with
    // one id is the same silent overwrite.
    const doc = parseMarkdown("d.md", ["Intro.", "", "## !!!", "", "Body.", ""].join("\n"));
    expect(doc.sections.map((section) => section.id)).toEqual(["d.md#", "d.md#-1"]);
    expect(doc.sections[0].heading).toBeNull();
    expect(doc.sections[1].heading).toBe("!!!");
  });

  it("numbering is per DOCUMENT, so two documents sharing a heading do not interact", () => {
    const a = parseMarkdown("a.md", ["# Shared", "", "# Shared", ""].join("\n"));
    const b = parseMarkdown("b.md", ["# Shared", ""].join("\n"));
    expect(a.sections.map((section) => section.anchor)).toEqual(["", "shared", "shared-1"]);
    expect(b.sections.map((section) => section.anchor)).toEqual(["", "shared"]);
  });

  it("a heading inside a FENCE takes no slug at all", () => {
    const doc = parseMarkdown(
      "d.md",
      ["# Real", "", `${FENCE}md`, "# Real", `${FENCE}`, ""].join("\n")
    );
    expect(doc.sections.map((section) => section.anchor)).toEqual(["", "real"]);
  });
});

// ── the corpus pin ───────────────────────────────────────────────────────────

/** An `#anchor` THIS repository already points at, and the document it names. */
type AnchorCitation = { from: string; docPath: string; anchor: string; href: string };

/**
 * Every intra-repository `#anchor` link in the corpus.
 *
 * A bare `#anchor` names a heading of the SAME document — that is what most of
 * this corpus writes, and `resolveLink` deliberately treats it as `external`
 * (`scripts/check-docs.mjs:78-84`), so it carries the fragment and no target.
 * `path.md#anchor` names another document's. Both are anchors GitHub resolves
 * today, which makes them the oracle for the slugger.
 */
function anchorCitations(index: DocsIndex): AnchorCitation[] {
  const out: AnchorCitation[] = [];
  for (const section of index.sections.values()) {
    for (const link of section.links) {
      if (!link.anchor) {
        continue;
      }
      const docPath =
        link.target === null
          ? link.href.startsWith("#")
            ? section.docPath
            : null
          : link.target;
      if (docPath === null || !index.files.has(docPath)) {
        continue;
      }
      out.push({ from: section.id, docPath, anchor: link.anchor, href: link.href });
    }
  }
  return out;
}

/** The paraphrase this replaced: trim, strip to ASCII, collapse whitespace. */
function paraphraseSlug(headingText: string): string {
  return headingText
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 _-]+/gu, "")
    .replace(/\s+/g, "-");
}

/** Section ids the paraphrase (plus its bare counter) would have minted. */
function paraphraseIds(index: DocsIndex, docPath: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const section of index.parsed.get(docPath)?.sections ?? []) {
    if (section.heading === null) {
      continue;
    }
    const base = paraphraseSlug(section.heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

describe("the slugger is pinned to THIS repository's own anchors", () => {
  it("every intra-repository `#anchor` lands on a section", async () => {
    const index = await realCorpus();
    const citations = anchorCitations(index);
    expect(citations.length).toBeGreaterThanOrEqual(9);

    const missed = citations.filter(
      (citation) => !index.sections.has(`${citation.docPath}#${citation.anchor}`)
    );
    // ZERO, and the tolerance that used to sit here is gone on purpose. This
    // test was written allowing exactly one miss — a link in `docs/install.md`
    // naming a heading that had since been renamed. That was a real
    // documentation defect the slugger had surfaced, so it was fixed rather
    // than tolerated, and the bound came down with it. The assertion is now the
    // strongest available: a slug regression breaks several of these at once,
    // and a renamed heading breaks exactly one — either way this fails, and the
    // message names the anchor so the reader can tell which happened.
    expect(missed.map((citation) => `${citation.docPath}#${citation.anchor}`)).toEqual(
      []
    );
  });

  it("the anchor equals the SLUG OF THE HEADING it lands on, not merely some id", async () => {
    const index = await realCorpus();
    for (const citation of anchorCitations(index)) {
      const section = index.sections.get(`${citation.docPath}#${citation.anchor}`);
      if (!section || section.heading === null) {
        continue;
      }
      expect([citation.href, slugify(section.heading)]).toEqual([
        citation.href,
        citation.anchor,
      ]);
    }
  });

  it("two anchors copied out of GitHub's rendered page resolve", async () => {
    // The DIRECT evidence for the algorithm: nobody guessing at a slug writes a
    // double hyphen. `Status & evidence` and `Release cycle 2026-08 — 15 human +
    // 15 agent` were rendered by GitHub and their anchors pasted back into the
    // prose, so these two ids are GitHub's own output.
    const index = await realCorpus();
    expect(index.sections.has("README.md#status--evidence")).toBe(true);
    expect(
      index.sections.has("ROADMAP.md#release-cycle-2026-08--15-human--15-agent")
    ).toBe(true);
  });

  it("the paraphrase resolves STRICTLY FEWER of them — the regression this fixes", async () => {
    // Mutation-proof, and it names no heading: restore the paraphrase and the two
    // counts converge, so this fails.
    const index = await realCorpus();
    const citations = anchorCitations(index);
    const paraphrase = new Map<string, Set<string>>();
    let landed = 0;
    let wouldLand = 0;
    for (const citation of citations) {
      if (index.sections.has(`${citation.docPath}#${citation.anchor}`)) {
        landed += 1;
      }
      let ids = paraphrase.get(citation.docPath);
      if (!ids) {
        ids = paraphraseIds(index, citation.docPath);
        paraphrase.set(citation.docPath, ids);
      }
      if (ids.has(citation.anchor)) {
        wouldLand += 1;
      }
    }
    expect(wouldLand).toBeLessThan(landed);
  });

  it("no two sections of one document share an id, across the whole corpus", async () => {
    // The invariant the deduper's loop protects: `DocsIndex.sections` is keyed by
    // id, so a duplicate is a section that silently stopped existing.
    const index = await realCorpus();
    let total = 0;
    for (const file of index.files.values()) {
      total += file.sectionIds.length;
      expect([file.path, new Set(file.sectionIds).size]).toEqual([
        file.path,
        file.sectionIds.length,
      ]);
    }
    expect(index.sections.size).toBe(total);
    expect(index.sectionOrder.length).toBe(total);
  });
});
