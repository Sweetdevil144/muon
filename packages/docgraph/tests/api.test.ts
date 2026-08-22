import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocsGraph } from "../src/index.js";
import { docContext, docsCiting, docsStatus, queryDocs } from "../src/api.js";
import {
  DocsRefusal,
  clearDocsIndexCache,
  ensureDocsIndex,
  provenanceOf,
} from "../src/index-build.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// The four payload shapes Phase 2's MCP tools and `muon docs` will consume. Each
// assertion is about the PAYLOAD, so a defect reproduces identically on both
// surfaces rather than only on the one that was tested.


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

describe("every payload carries provenance and a degradation block", () => {
  it("query / context / impact / status all carry the same provenance", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const provenance = provenanceOf(index);
    expect(queryDocs(index, "decision").provenance).toEqual(provenance);
    expect(docContext(index, "docs/adr/0001-a.md").provenance).toEqual(provenance);
    expect(docsCiting(index, "src/tracked.ts").provenance).toEqual(provenance);
    expect(docsStatus(index).provenance).toEqual(provenance);
  });

  it("`degradation.active` is false exactly when nothing is degraded", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    for (const block of [
      docContext(index, "docs/adr/0001-a.md").degradation,
      docsCiting(index, "src/tracked.ts").degradation,
      docsStatus(index).degradation,
    ]) {
      expect(block.active).toBe(false);
      expect(block.entries).toEqual([]);
      expect(block.reason).toBe("");
    }
  });

  it("provenance names the root, the commit, the counts and the tier source", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const provenance = provenanceOf(index);
    expect(provenance.root).toBe(repo.root);
    expect(provenance.builtAtCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(provenance.files).toBe(index.files.size);
    expect(provenance.sections).toBe(index.sections.size);
    expect(provenance.corpusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.tierSource).toBe("docs/README.md");
    expect(provenance.corpusSource).toBe("git");
  });
});

describe("docContext", () => {
  it("a DOCUMENT target returns tier, adrStatus, tracked and the section outline", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/adr/0001-a.md");
    expect(context.kind).toBe("document");
    if (context.kind !== "document") {
      return;
    }
    expect(context.title).toBe("ADR-0001: The first decision");
    expect(context.tier).toBe("canon");
    expect(context.adrStatus).toBe("accepted");
    expect(context.tracked).toBe(true);
    expect(context.outline.length).toBeGreaterThan(3);
    for (const entry of context.outline) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.lines.start).toBeGreaterThan(0);
    }
  });

  it("a SECTION target returns the breadcrumb, fences, links and anchors with states", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/adr/0001-a.md#context");
    expect(context.kind).toBe("section");
    if (context.kind !== "section") {
      return;
    }
    expect(context.headingPath).toEqual(["ADR-0001: The first decision", "Context"]);
    expect(context.depth).toBe(2);
    expect(context.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(context.codeAnchors.map((anchor) => anchor.resolution)).toEqual(
      expect.arrayContaining(["resolved", "suffix-resolved"])
    );
    expect(context.links[0].resolution).toBe("resolved");
    expect(context.text).toBeNull();
    expect(context.historical).toBe(false);
  });

  it("`sectionId#fence[n]` addresses a fence, filterable by language", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/design/note.md#a-diagram");
    expect(context.kind).toBe("section");
    if (context.kind !== "section") {
      return;
    }
    expect(context.fences).toHaveLength(1);
    expect(context.fences[0].id).toBe("docs/design/note.md#a-diagram#fence[0]");
    expect(context.fences[0].lang).toBe("mermaid");
    expect(context.fences[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("`includeText` adds the bounded body; omitting it keeps the payload lean", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const withText = docContext(index, "docs/research/old.md#the-zzyzx-protocol", {
      includeText: true,
    });
    expect(withText.kind).toBe("section");
    if (withText.kind === "section") {
      expect(withText.text).toContain("zzyzx");
      expect(withText.textTruncated).toBe(false);
    }
  });

  it("backlinks name the sections that link here", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/adr/0002-b.md#section-two");
    expect(context.kind).toBe("section");
    if (context.kind === "section") {
      expect(context.backlinks).toEqual(["docs/adr/0001-a.md#context"]);
      expect(context.evidence.find((entry) => entry.kind === "backlinks")).toEqual({
        bounded: true,
        limit: 50,
        included: 1,
        omitted: 0,
        kind: "backlinks",
      });
    }
  });

  it("opting OUT of backlinks emits no backlink evidence — `0 of 0` is a claim", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, "docs/adr/0002-b.md#section-two", {
      includeBacklinks: false,
    });
    expect(context.backlinks).toEqual([]);
    expect(context.evidence.find((entry) => entry.kind === "backlinks")).toBeUndefined();
  });

  it("an unresolvable target REFUSES with near matches, never an empty success", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(() => docContext(index, "docs/adr/0001-a.md#no-such-heading")).toThrow(
      DocsRefusal
    );
    try {
      docContext(index, "docs/adr/0001-a.md#contxt");
    } catch (error) {
      const refusal = error as DocsRefusal;
      expect(refusal.code).toBe("target-not-found");
      expect(refusal.reason).toContain("docs/adr/0001-a.md#contxt");
      expect(refusal.action).toContain("renamed heading");
      expect(refusal.nextActions).toContain("docs/adr/0001-a.md#context");
      expect(refusal.nextActions.length).toBeLessThanOrEqual(3);
    }
  });

  it("a target naming no document at all still refuses, not throws something else", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(() => docContext(index, "docs/nope.md")).toThrow(DocsRefusal);
    expect(() => docContext(index, "")).toThrow(DocsRefusal);
  });
});

describe("docsCiting", () => {
  it("names the citing sections, their tier, and the lines the citation named", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const impact = docsCiting(index, "src/tracked.ts");
    expect(impact.path).toBe("src/tracked.ts");
    expect(impact.totals.sections).toBeGreaterThanOrEqual(2);
    expect(impact.totals.documents).toBeGreaterThanOrEqual(2);
    expect(impact.totals.canon).toBeGreaterThanOrEqual(1);
    const withLines = impact.citedBy.find((entry) => entry.mentionLines.length > 0);
    expect(withLines?.mentionLines).toEqual([12, 20]);
    expect(withLines?.resolution).toBe("resolved");
    expect(withLines?.via).toBe("codespan");
    expect(impact.reason).toBeUndefined();
  });

  it("an uncited path returns an EXPLICIT empty — a fact, not a silence", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const impact = docsCiting(index, "src/nobody-mentions-me.ts");
    expect(impact.citedBy).toEqual([]);
    expect(impact.reason).toBe("no documentation cites this path");
    expect(impact.totals.sections).toBe(0);
  });

  it("is NOT a verdict: it reports the state and never calls a doc wrong", async () => {
    // ADR-0052 names a file before it exists; that is a PLAN, not a defect.
    repo.write(
      "docs/design/plan.md",
      "# Plan\n\nThe gate will live in `src/not-written-yet.ts`.\n"
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const impact = docsCiting(index, "src/not-written-yet.ts");
    expect(impact.citedBy).toHaveLength(1);
    expect(impact.citedBy[0].resolution).toBe("unresolved");
    // No `drift`, no `stale`, no `broken` — the state, and nothing else.
    expect(Object.keys(impact)).toEqual([
      "path",
      "citedBy",
      "totals",
      "provenance",
      "degradation",
      "evidence",
    ]);
  });

  it("normalizes a caller-supplied path before looking it up", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(docsCiting(index, "./src/tracked.ts").totals.sections).toBeGreaterThan(0);
    expect(docsCiting(index, "src\\tracked.ts").totals.sections).toBeGreaterThan(0);
  });

  it("works on THIS repository: a changed file names the doc sections describing it", async () => {
    const index = await realCorpus();
    const impact = docsCiting(index, "backend/src/lib/anchor-resolution.ts");
    expect(impact.totals.sections).toBeGreaterThan(0);
    expect(impact.citedBy.every((entry) => entry.sectionId.includes("#"))).toBe(true);
    expect(
      impact.citedBy.some((entry) => entry.mentionLines.length > 0)
    ).toBe(true);
  });
});

describe("docsStatus is the drift report", () => {
  it("names unresolved and ambiguous anchors with their citing section", async () => {
    const status = docsStatus(await ensureDocsIndex(repo.root, { force: true }));
    expect(status.drift.unresolvedAnchors).toEqual(
      expect.arrayContaining([
        { path: "src/never-existed.ts", sectionId: "docs/adr/0001-a.md#consequences" },
      ])
    );
    expect(status.drift.ambiguousAnchors).toEqual(
      expect.arrayContaining([
        {
          path: "src/index.ts",
          candidates: 2,
          sectionId: "docs/adr/0001-a.md#consequences",
        },
      ])
    );
  });

  it("lists every `unclassified` document under docs/, which is a docs fix not a code fix", async () => {
    repo.write("docs/whatever/new.md", "# New\n\nBody.\n");
    clearDocsIndexCache();
    const status = docsStatus(await ensureDocsIndex(repo.root, { force: true }));
    expect(status.drift.unclassifiedDocs).toContain("docs/whatever/new.md");
  });

  it("reports the hygiene gap ADR-0053 §9 predicted on THIS repository", async () => {
    const index = await realCorpus();
    const status = docsStatus(index);
    // Every `unclassified` document under docs/ is reported, rather than quietly
    // promoted — the honest output, and the fix is a docs edit, not a code change.
    const expected = [...index.files.values()]
      .filter((file) => file.tier === "unclassified" && file.path.startsWith("docs/"))
      .map((file) => file.path);
    expect(expected.length).toBeGreaterThan(0);
    expect(status.drift.unclassifiedDocs).toEqual(expected);
    // And no canon document is ever in that list.
    for (const docPath of status.drift.unclassifiedDocs) {
      expect(index.files.get(docPath)?.tier).toBe("unclassified");
    }
    expect(status.anchors.total).toBeGreaterThan(1500);
  });
});

describe("createDocsGraph", () => {
  it("exposes root / status / query / context / impact / rebuild over one root", async () => {
    const graph = createDocsGraph(repo.root);
    expect(await graph.root()).toBe(repo.root);
    expect((await graph.status()).corpus.corpus).toBeGreaterThan(5);
    expect((await graph.query("decision")).results.length).toBeGreaterThan(0);
    expect((await graph.context("docs/adr/0001-a.md")).kind).toBe("document");
    expect((await graph.impact("src/tracked.ts")).totals.sections).toBeGreaterThan(0);
    expect((await graph.rebuild()).root).toBe(repo.root);
  });

  it("revalidates on every call, so a caller never has to ask whether it is current", async () => {
    const graph = createDocsGraph(repo.root);
    const first = await graph.status();
    repo.write("docs/design/note.md", "# A design note\n\nRewritten entirely.\n");
    const second = await graph.status();
    expect(second.provenance.corpusHash).not.toBe(first.provenance.corpusHash);
  });

  it("resolves the root from a SUBDIRECTORY of the repository", async () => {
    const graph = createDocsGraph(path.join(repo.root, "docs/adr"));
    expect(await graph.root()).toBe(repo.root);
    expect((await graph.status()).corpus.corpus).toBeGreaterThan(5);
  });
});
