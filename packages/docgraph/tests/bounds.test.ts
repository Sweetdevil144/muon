import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docContext, docsCiting, docsStatus, queryDocs } from "../src/api.js";
import {
  DOCS_EXCERPT_CHARS,
  DOCS_INDEX_TTL_MS,
  DOCS_MAX_ANCHORS_PER_SECTION,
  DOCS_MAX_BACKLINKS,
  DOCS_MAX_CORPUS_FILES,
  DOCS_MAX_FILE_BYTES,
  DOCS_MAX_RESPONSE_CHARS,
  DOCS_MAX_RESULTS,
  evidenceFor,
} from "../src/bounds.js";
import {
  DocsRefusal,
  clearDocsIndexCache,
  ensureDocsIndex,
} from "../src/index-build.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// T11: every cap in `bounds.ts` is exercised, `omitted > 0` whenever something
// was dropped, and an over-cap corpus REFUSES BY NAME rather than answering from
// a partial one.


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

describe("the evidence record", () => {
  it("reports included/omitted honestly at, below, and above the cap", () => {
    expect(evidenceFor("k", 3, 10)).toEqual({
      bounded: true,
      limit: 10,
      included: 3,
      omitted: 0,
      kind: "k",
    });
    expect(evidenceFor("k", 10, 10).omitted).toBe(0);
    expect(evidenceFor("k", 43, 10)).toEqual({
      bounded: true,
      limit: 10,
      included: 10,
      omitted: 33,
      kind: "k",
    });
  });
});

describe("DOCS_MAX_RESULTS", () => {
  it("caps `docsQuery` at 10 and reports what it omitted", async () => {
    const index = await realCorpus();
    const result = queryDocs(index, "memory graph agent governed brain");
    expect(result.results.length).toBeLessThanOrEqual(DOCS_MAX_RESULTS);
    const sections = result.evidence.find((entry) => entry.kind === "sections");
    expect(sections?.bounded).toBe(true);
    expect(sections?.omitted).toBeGreaterThan(0);
  });

  it("a caller cannot raise `limit` past the cap", async () => {
    const index = await realCorpus();
    const result = queryDocs(index, "memory graph agent governed brain", {
      limit: 500,
    });
    expect(result.results.length).toBeLessThanOrEqual(DOCS_MAX_RESULTS);
  });

  it("a caller CAN lower `limit`, and the omission is reported", async () => {
    const index = await realCorpus();
    const result = queryDocs(index, "memory graph agent governed brain", { limit: 2 });
    expect(result.results).toHaveLength(2);
    expect(result.evidence.find((entry) => entry.kind === "sections")?.omitted).toBeGreaterThan(
      0
    );
  });
});

describe("DOCS_EXCERPT_CHARS and DOCS_MAX_RESPONSE_CHARS", () => {
  it("truncates a long section body and SAYS it truncated", async () => {
    repo.write(
      "docs/design/long.md",
      `# Long\n\n## Body\n\n${"quernstone ".repeat(400)}\n`
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "quernstone");
    const hit = result.results.find((entry) => entry.docPath === "docs/design/long.md");
    expect(hit?.excerpt.length).toBe(DOCS_EXCERPT_CHARS);
    expect(hit?.excerptTruncated).toBe(true);
  });

  it("the three caps COMPOSE, so a maximal query response cannot reach the ceiling", async () => {
    // FOUND WHILE WRITING THIS TEST: with the shipped numbers the whole-response
    // guard in `queryDocs` cannot fire — 10 results × 1,200 chars = 12,000,
    // half the 24,000 ceiling. The guard stays as defence-in-depth for a future
    // cap change; this test pins the arithmetic that makes it inert today, so
    // raising either cap past the ceiling fails HERE rather than in production.
    expect(DOCS_MAX_RESULTS * DOCS_EXCERPT_CHARS).toBeLessThanOrEqual(
      DOCS_MAX_RESPONSE_CHARS
    );

    for (let i = 0; i < 12; i += 1) {
      repo.write(
        `docs/design/long-${i}.md`,
        `# Long ${i}\n\n## Body\n\n${"quernstone calibration ".repeat(400)}\n`
      );
    }
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const result = queryDocs(index, "quernstone calibration");
    const total = result.results.reduce((sum, hit) => sum + hit.excerpt.length, 0);
    expect(total).toBeLessThanOrEqual(DOCS_MAX_RESPONSE_CHARS);
    // The result cap is what actually bound, and it says so.
    expect(result.results).toHaveLength(DOCS_MAX_RESULTS);
    expect(
      result.evidence.find((entry) => entry.kind === "sections")?.omitted
    ).toBeGreaterThan(0);
  });

  it("`includeText` is bounded too, and reports the character evidence", async () => {
    repo.write(
      "docs/design/long.md",
      `# Long\n\n## Body\n\n${"quernstone ".repeat(4000)}\n`
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/design/long.md#body", { includeText: true });
    expect(context.kind).toBe("section");
    if (context.kind === "section") {
      expect(context.text?.length).toBe(DOCS_MAX_RESPONSE_CHARS);
      expect(context.textTruncated).toBe(true);
      const chars = context.evidence.find((entry) => entry.kind === "textChars");
      expect(chars?.omitted).toBeGreaterThan(0);
    }
  });
});

describe("DOCS_MAX_ANCHORS_PER_SECTION", () => {
  it("caps a citation-dense section and REPORTS what it dropped", async () => {
    const spans = Array.from({ length: 90 }, (_, i) => `\`src/gen-${i}.ts\``).join(" ");
    repo.write("docs/design/dense.md", `# Dense\n\n## Citations\n\n${spans}\n`);
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const section = index.sections.get("docs/design/dense.md#citations");
    expect(section?.codeAnchors.length).toBe(DOCS_MAX_ANCHORS_PER_SECTION);
    expect(section?.codeAnchorsOmitted).toBe(90 - DOCS_MAX_ANCHORS_PER_SECTION);

    // A cap that does not report is a truncated answer that reads as complete.
    const context = docContext(index, "docs/design/dense.md#citations");
    const evidence = context.evidence.find((entry) => entry.kind === "codeAnchors");
    expect(evidence).toEqual({
      bounded: true,
      limit: DOCS_MAX_ANCHORS_PER_SECTION,
      included: DOCS_MAX_ANCHORS_PER_SECTION,
      omitted: 90 - DOCS_MAX_ANCHORS_PER_SECTION,
      kind: "codeAnchors",
    });
  });

  it("a section under the anchor cap carries no `codeAnchors` evidence at all", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/adr/0001-a.md#context");
    expect(context.evidence.find((entry) => entry.kind === "codeAnchors")).toBeUndefined();
  });
});

describe("DOCS_MAX_BACKLINKS", () => {
  it("caps `docsCiting` and reports the omission", async () => {
    for (let i = 0; i < 60; i += 1) {
      repo.write(`docs/design/cite-${i}.md`, `# Cite ${i}\n\nSee \`src/tracked.ts\`.\n`);
    }
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const impact = docsCiting(index, "src/tracked.ts");
    expect(impact.citedBy.length).toBe(DOCS_MAX_BACKLINKS);
    // `totals` describes the TRUTH; `citedBy` is the bounded view of it.
    expect(impact.totals.sections).toBeGreaterThan(DOCS_MAX_BACKLINKS);
    expect(impact.evidence[0].omitted).toBeGreaterThan(0);
  });

  it("caps the drift report in `docsStatus`", async () => {
    const spans = Array.from({ length: 80 }, (_, i) => `\`src/absent-${i}.ts\``).join(" ");
    repo.write("docs/design/drift.md", `# Drift\n\n## Missing\n\n${spans}\n`);
    clearDocsIndexCache();
    const status = docsStatus(await ensureDocsIndex(repo.root, { force: true }));
    expect(status.drift.unresolvedAnchors.length).toBeLessThanOrEqual(DOCS_MAX_BACKLINKS);
    expect(
      status.evidence.find((entry) => entry.kind === "unresolvedAnchors")?.omitted
    ).toBeGreaterThan(0);
  });
});

describe("DOCS_MAX_FILE_BYTES", () => {
  it("skips an oversized file, LISTS it, and degrades", async () => {
    repo.write(
      "docs/design/huge.md",
      `# Huge\n\n${"x".repeat(DOCS_MAX_FILE_BYTES + 10)}\n`
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.has("docs/design/huge.md")).toBe(false);
    const status = docsStatus(index);
    // Never dropped SILENTLY.
    expect(status.corpus.skipped).toEqual([
      {
        path: "docs/design/huge.md",
        reason: `over the ${DOCS_MAX_FILE_BYTES}-byte per-file cap`,
      },
    ]);
    expect(status.degradation.entries.map((entry) => entry.code)).toContain(
      "files-skipped"
    );
  });
});

describe("DOCS_MAX_CORPUS_FILES", () => {
  it("an over-cap corpus REFUSES BY NAME rather than indexing a prefix", async () => {
    // The refusal direction matters: an answer assembled from a truncated corpus
    // reads exactly like one assembled from the whole, and "no documentation
    // cites this path" would become a claim about files we stopped reading.
    for (let i = 0; i < 40; i += 1) {
      repo.write(`docs/bulk/f-${i}.md`, `# F ${i}\n\nBody.\n`);
    }
    clearDocsIndexCache();
    // Exercised against the real constant by lowering nothing: instead assert
    // the guard's arithmetic and its message, since 2,000 real files would make
    // this test a minute long.
    expect(DOCS_MAX_CORPUS_FILES).toBe(2_000);
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.size).toBeLessThan(DOCS_MAX_CORPUS_FILES);

    const refusal = new DocsRefusal(
      "corpus-over-cap",
      `The markdown corpus holds 2001 files, past the ${DOCS_MAX_CORPUS_FILES}-file cap; no partial index was built.`,
      "Narrow the workspace, or raise DOCS_MAX_CORPUS_FILES deliberately after measuring the rebuild cost."
    );
    expect(refusal.code).toBe("corpus-over-cap");
    expect(refusal.reason).toContain("no partial index was built");
    expect(refusal).toBeInstanceOf(Error);
  });

  it("the refusal path is reachable: the guard fires on the corpus count, pre-parse", async () => {
    // A corpus of DOCS_MAX_CORPUS_FILES + 1 tiny files, written once, so the
    // guard is proven to fire rather than argued about.
    const bulk = makeRepo();
    try {
      for (let i = 0; i <= DOCS_MAX_CORPUS_FILES; i += 1) {
        bulk.write(`d/${i}.md`, "# x\n");
      }
      clearDocsIndexCache();
      await expect(ensureDocsIndex(bulk.root, { force: true })).rejects.toThrow(
        /past the 2000-file cap/
      );
    } finally {
      bulk.cleanup();
    }
  }, 60_000);
});

describe("DOCS_INDEX_TTL_MS", () => {
  it("is the 60 s backstop the blueprint specifies", () => {
    expect(DOCS_INDEX_TTL_MS).toBe(60_000);
  });
});
