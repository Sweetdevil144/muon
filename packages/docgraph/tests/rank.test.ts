import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenize } from "@muon/graph/memory-ranking";
import { queryDocs } from "../src/api.js";
import { clearDocsIndexCache, ensureDocsIndex } from "../src/index-build.js";
import { buildSectionTerms, docTerms, rankSections } from "../src/rank.js";
import { priorFor } from "../src/tier.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// T10: retrieval is FLAT (ADR-0021). BM25 over sections, one bounded
// multiplicative tier prior in [0.5, 1.0] that may demote and may never
// exclude, and no traversal anywhere on this path.


let repo: FixtureRepo;

beforeEach(() => {
  clearDocsIndexCache();
  repo = makeRepo();
  seedCorpus(repo);
});

afterEach(() => {
  repo.cleanup();
  clearDocsIndexCache();
});

describe("the tokenizer is SHARED with memory ranking, not re-implemented", () => {
  it("is `@muon/graph`'s `tokenize`, reached through the narrow subpath export", () => {
    // Two tokenizers that drift are two retrieval systems wearing one name. The
    // subpath (not the barrel) keeps this package free of LadybugDB's native addon.
    expect(tokenize("Memory Retrieval, the `docs/README.md` file")).toEqual([
      "memory",
      "retrieval",
      "docs/readme.md",
      "file",
    ]);
  });

  it("trims a SENTENCE-FINAL full stop, symmetrically on body and query", () => {
    // `tokenize` keeps `.` so `docs/README.md` stays one term — which also glues
    // the full stop onto the last word of every sentence. Untrimmed, a query for
    // `flat` matches nothing in "…retrieval is flat." at all.
    expect(tokenize("retrieval is flat.")).toContain("flat.");
    expect(docTerms("retrieval is flat.")).toContain("flat");
    expect(docTerms("see docs/README.md.")).toContain("docs/README.md".toLowerCase());
    expect(docTerms("flat")).toEqual(docTerms("flat."));
    // A path's INTERNAL dots are untouched.
    expect(docTerms("`packages/graph/src/memory-ranking.ts`")).toEqual([
      "packages/graph/src/memory-ranking.ts",
    ]);
  });
});

describe("T10 — the bounded tier prior", () => {
  it("a HISTORICAL section that is the only lexical match is returned, ranked and LABELED", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "zzyzx protocol");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].sectionId).toBe("docs/research/old.md#the-zzyzx-protocol");
    expect(result.results[0].tier).toBe("historical");
    expect(result.results[0].historical).toBe(true);
    // A historical-only answer is a REAL answer and must not read as canon.
    expect(result.degradation.active).toBe(true);
    expect(result.degradation.entries.map((entry) => entry.code)).toContain(
      "historical-only"
    );
    expect(result.precedence).toContain("historical");
  });

  it("a canon section with ZERO query-term overlap is not returned at all", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "zzyzx protocol");
    expect(result.results.map((hit) => hit.docPath)).not.toContain("README.md");
    expect(result.results.map((hit) => hit.docPath)).not.toContain(
      "docs/testing/walkthrough.md"
    );
  });

  it("the prior DEMOTES an identical historical section below a canon one, and returns both", async () => {
    const body = "\n\nThe quernstone calibration procedure, described identically.\n";
    repo.write("docs/testing/walkthrough.md", `# The walkthrough${body}`);
    repo.write("docs/research/old.md", `# Old research${body}`);
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "quernstone calibration procedure");

    const ids = result.results.map((hit) => hit.sectionId);
    expect(ids).toContain("docs/testing/walkthrough.md#the-walkthrough");
    expect(ids).toContain("docs/research/old.md#old-research");
    expect(ids.indexOf("docs/testing/walkthrough.md#the-walkthrough")).toBeLessThan(
      ids.indexOf("docs/research/old.md#old-research")
    );
    // Demoted, NOT excluded, and never to zero.
    const historical = result.results.find(
      (hit) => hit.sectionId === "docs/research/old.md#old-research"
    );
    expect(historical?.score).toBeGreaterThan(0);
  });

  it("the prior never PROMOTES: a decisively better lexical match wins from the LOWEST tier", async () => {
    // The prior is multiplicative and bounded at 0.5, so it can reorder within a
    // factor of two and no further. A match on three query terms against a match
    // on one is well past that, and the historical section must lead.
    repo.write("docs/testing/walkthrough.md", "# The walkthrough\n\nA quernstone here.\n");
    repo.write(
      "docs/research/old.md",
      "# Old research\n\nThe quernstone calibration procedure, in full.\n"
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "quernstone calibration procedure");
    expect(result.results[0].sectionId).toBe("docs/research/old.md#old-research");
    expect(result.results[0].tier).toBe("historical");
  });

  it("the prior is EXACTLY lexical × prior, and the prior is never below 0.5", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const sections = [...index.sections.values()];
    const ranked = rankSections(sections, index.terms, "decision body gate protocol");
    expect(ranked.length).toBeGreaterThan(0);
    for (const entry of ranked) {
      const prior = priorFor(entry.section.tier, entry.section.adrStatus);
      expect(prior).toBeGreaterThanOrEqual(0.5);
      expect(prior).toBeLessThanOrEqual(1);
      expect(entry.score).toBeCloseTo(entry.lexical * prior, 12);
    }
  });

  it("`tier` as an ARGUMENT is a hard filter — a different thing from the prior", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const filtered = queryDocs(index, "zzyzx protocol", { tier: "canon" });
    expect(filtered.results).toEqual([]);
    const unfiltered = queryDocs(index, "zzyzx protocol");
    expect(unfiltered.results.length).toBeGreaterThan(0);
  });
});

describe("filters narrow the corpus before ranking", () => {
  it("pathPrefix restricts the candidate set", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "decision body", { pathPrefix: "docs/adr/" });
    expect(result.results.length).toBeGreaterThan(0);
    for (const hit of result.results) {
      expect(hit.docPath.startsWith("docs/adr/")).toBe(true);
    }
  });

  it("fenceLang finds every section carrying a diagram", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "diagram", { fenceLang: "mermaid" });
    expect(result.results.map((hit) => hit.sectionId)).toEqual([
      "docs/design/note.md#a-diagram",
    ]);
    expect(result.results[0].fenceLangs).toContain("mermaid");
  });

  it("finds every mermaid diagram in THIS repository's corpus", async () => {
    const index = await realCorpus();
    let mermaidSections = 0;
    for (const section of index.sections.values()) {
      if (section.fences.some((fence) => fence.lang === "mermaid")) {
        mermaidSections += 1;
      }
    }
    // `check:docs` reports 37+ mermaid diagrams on this tree.
    expect(mermaidSections).toBeGreaterThan(30);
  });
});

describe("ranking is deterministic and carries no traversal", () => {
  it("two runs over the same sections produce identical ordering and scores", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const sections = [...index.sections.values()];
    const terms = buildSectionTerms(sections);
    const first = rankSections(sections, terms, "decision body gate");
    const second = rankSections(sections, terms, "decision body gate");
    expect(second.map((entry) => [entry.section.id, entry.score])).toEqual(
      first.map((entry) => [entry.section.id, entry.score])
    );
  });

  it("a query with no usable terms returns nothing rather than everything", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(queryDocs(index, "the a of in").results).toEqual([]);
    expect(queryDocs(index, "   ").results).toEqual([]);
  });

  it("a section that links to a high-scoring section does NOT inherit its rank", async () => {
    // ADR-0021 restated: `LINKS_TO` is provenance and navigation, never a
    // ranking input. `docs/adr/0001-a.md` links `0002-b.md#section-two`; a
    // query for a term only in the TARGET must not surface the referrer.
    repo.write(
      "docs/adr/0002-b.md",
      "# ADR-0002\n\n- **Status:** Superseded\n\n## Section two\n\nflibbertigibbet.\n"
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "flibbertigibbet");
    expect(result.results.map((hit) => hit.docPath)).toEqual(["docs/adr/0002-b.md"]);
  });
});

describe("querying the real corpus", () => {
  it("answers a decision question with the ADR that decided it", async () => {
    const index = await realCorpus();
    const result = queryDocs(index, "memory retrieval is flat traversal centrality");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].docPath).toBe("docs/adr/0021-memory-retrieval-is-flat.md");
    expect(result.results[0].adrStatus).toBe("accepted");
    expect(result.results[0].lines.start).toBeGreaterThan(0);
    expect(result.results[0].lines.end).toBeGreaterThanOrEqual(
      result.results[0].lines.start
    );
  });

  it("carries provenance and the precedence line on every response", async () => {
    const index = await realCorpus();
    const result = queryDocs(index, "governed mcp fabric tool inventory");
    expect(result.provenance.root).toBe(REPO_ROOT);
    expect(result.provenance.builtAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.provenance.tierSource).toBe("docs/README.md");
    expect(result.precedence).toContain("progress.md");
  });
});
