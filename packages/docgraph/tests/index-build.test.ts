import { readFileSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docContext, docsStatus } from "../src/api.js";
import {
  DocsRefusal,
  buildDocsIndex,
  clearDocsIndexCache,
  ensureDocsIndex,
  type DocsIndex,
} from "../src/index-build.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";

// P1, P3, P4 and determinism: the data-pipeline assertions. Each one is a claim
// about what a REBUILD produces, not about a function having been called.

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

function hashes(index: DocsIndex, docPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of index.files.get(docPath)?.sectionIds ?? []) {
    const section = index.sections.get(id);
    if (section) {
      out.set(id, section.contentHash);
    }
  }
  return out;
}

function lineRanges(index: DocsIndex, docPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of index.files.get(docPath)?.sectionIds ?? []) {
    const section = index.sections.get(id);
    if (section) {
      out.set(id, `${section.startLine}-${section.endLine}`);
    }
  }
  return out;
}

const DOC = "docs/adr/0002-b.md";

describe("P1 — a section edit changes exactly its own content hash", () => {
  it("edits section B; A and C are byte-identical, the file and the corpus hash move", async () => {
    const before = await ensureDocsIndex(repo.root, { force: true });
    const beforeHashes = hashes(before, DOC);
    const beforeCorpus = before.corpusHash;
    const beforeFile = before.files.get(DOC)?.contentHash;

    const source = readFileSync(path.join(repo.root, DOC), "utf8");
    repo.write(DOC, source.replace("The second body, cited by ADR-0001.", "Rewritten body."));

    clearDocsIndexCache();
    const after = await ensureDocsIndex(repo.root, { force: true });
    const afterHashes = hashes(after, DOC);

    expect(afterHashes.get(`${DOC}#section-two`)).not.toBe(
      beforeHashes.get(`${DOC}#section-two`)
    );
    for (const id of [`${DOC}#`, `${DOC}#section-one`, `${DOC}#section-one-1`]) {
      expect([id, afterHashes.get(id)]).toEqual([id, beforeHashes.get(id)]);
    }
    expect(after.files.get(DOC)?.contentHash).not.toBe(beforeFile);
    expect(after.corpusHash).not.toBe(beforeCorpus);
  });

  it("the harder half: ADDING two lines leaves sibling hashes untouched and shifts only the LINES", async () => {
    // Content hashes are position-independent BY CONSTRUCTION (each is sha256
    // of the section's own bytes). This test is what keeps them so.
    const before = await ensureDocsIndex(repo.root, { force: true });
    const beforeHashes = hashes(before, DOC);
    const beforeLines = lineRanges(before, DOC);

    const source = readFileSync(path.join(repo.root, DOC), "utf8");
    repo.write(
      DOC,
      source.replace(
        "The second body, cited by ADR-0001.",
        "The second body, cited by ADR-0001.\nAn added line.\nAnother added line."
      )
    );

    clearDocsIndexCache();
    const after = await ensureDocsIndex(repo.root, { force: true });
    const afterHashes = hashes(after, DOC);
    const afterLines = lineRanges(after, DOC);

    // A (before the edit) is untouched in BOTH hash and position.
    expect(afterHashes.get(`${DOC}#section-one`)).toBe(beforeHashes.get(`${DOC}#section-one`));
    expect(afterLines.get(`${DOC}#section-one`)).toBe(beforeLines.get(`${DOC}#section-one`));
    // C (after the edit) keeps its hash and moves down exactly two lines.
    expect(afterHashes.get(`${DOC}#section-one-1`)).toBe(
      beforeHashes.get(`${DOC}#section-one-1`)
    );
    const [beforeStart, beforeEnd] = (beforeLines.get(`${DOC}#section-one-1`) ?? "")
      .split("-")
      .map(Number);
    const [afterStart, afterEnd] = (afterLines.get(`${DOC}#section-one-1`) ?? "")
      .split("-")
      .map(Number);
    expect(afterStart - beforeStart).toBe(2);
    expect(afterEnd - beforeEnd).toBe(2);
  });
});

describe("P3 — a moved heading breaks its citation loudly", () => {
  it("the old section id refuses with near matches, and the inbound link goes unresolved", async () => {
    const before = await ensureDocsIndex(repo.root, { force: true });
    // ADR-0001 links `0002-b.md#section-two`; that inbound link resolves today.
    const citing = before.sections.get("docs/adr/0001-a.md#context");
    const link = citing?.links.find((entry) => entry.targetSectionId);
    expect(link?.targetSectionId).toBe(`${DOC}#section-two`);
    expect(link?.anchorResolution).toBe("resolved");

    const source = readFileSync(path.join(repo.root, DOC), "utf8");
    repo.write(DOC, source.replace("## Section two", "## Section the second"));
    clearDocsIndexCache();
    const after = await ensureDocsIndex(repo.root, { force: true });

    // The stale coordinate does not silently land on a neighbour.
    let refusal: DocsRefusal | null = null;
    try {
      docContext(after, `${DOC}#section-two`);
    } catch (error) {
      refusal = error as DocsRefusal;
    }
    expect(refusal).toBeInstanceOf(DocsRefusal);
    expect(refusal?.code).toBe("target-not-found");
    expect(refusal?.nextActions).toContain(`${DOC}#section-the-second`);
    expect(refusal?.nextActions.length).toBeGreaterThan(0);

    const afterLink = after.sections
      .get("docs/adr/0001-a.md#context")
      ?.links.find((entry) => entry.targetSectionId);
    expect(afterLink?.anchorResolution).toBe("unresolved");
    // The FILE still resolves — only the anchor half broke, and they are
    // reported separately so a reader can tell which.
    expect(afterLink?.resolution).toBe("resolved");
  });

  it("a document target still resolves and lists its outline", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const context = docContext(index, DOC);
    expect(context.kind).toBe("document");
    if (context.kind === "document") {
      expect(context.outline.map((entry) => entry.sectionId)).toEqual([
        `${DOC}#`,
        `${DOC}#adr-0002-the-superseded-decision`,
        `${DOC}#section-one`,
        `${DOC}#section-two`,
        `${DOC}#section-one-1`,
      ]);
    }
  });
});

describe("P4 — revalidation is honest", () => {
  it("a clean commit reports HEAD and worktreeDirty:false", async () => {
    repo.add();
    repo.commit("clean the tree");
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.builtAtCommit).toBe(repo.git("rev-parse", "HEAD").trim());
    expect(index.worktreeDirty).toBe(false);
  });

  it("editing a doc rebuilds on the NEXT call and reports worktreeDirty:true", async () => {
    repo.add();
    repo.commit("clean the tree");
    clearDocsIndexCache();
    const first = await ensureDocsIndex(repo.root);
    expect(first.worktreeDirty).toBe(false);
    const firstHash = first.corpusHash;

    repo.write(
      "docs/research/old.md",
      "# Old research\n\n## The zzyzx protocol\n\nEdited under the running index.\n"
    );
    // No force, no cache clear: revalidation alone must notice the mtime move.
    const second = await ensureDocsIndex(repo.root);
    expect(second.corpusHash).not.toBe(firstHash);
    expect(second.worktreeDirty).toBe(true);
    expect(
      second.sections.get("docs/research/old.md#the-zzyzx-protocol")?.text
    ).toContain("Edited under the running index");
  });

  it("a NEW markdown file appears on the next call, via the corpus path set", async () => {
    const first = await ensureDocsIndex(repo.root);
    expect(first.files.has("docs/design/added-later.md")).toBe(false);
    repo.write("docs/design/added-later.md", "# Added later\n\nBody.\n");
    const second = await ensureDocsIndex(repo.root);
    expect(second.files.has("docs/design/added-later.md")).toBe(true);
  });

  it("a NEW COMMIT rebuilds even when no corpus file changed", async () => {
    repo.add();
    repo.commit("clean the tree");
    const first = await ensureDocsIndex(repo.root, { force: true });
    repo.write("src/unrelated.ts", "export const x = 1;\n");
    repo.add();
    repo.commit("an unrelated commit");
    const second = await ensureDocsIndex(repo.root);
    expect(second.builtAtCommit).not.toBe(first.builtAtCommit);
    expect(second.builtAtCommit).toBe(repo.git("rev-parse", "HEAD").trim());
  });

  it("deleting .git reports builtAtCommit:null with the degradation, and NO stale commit", async () => {
    const before = await ensureDocsIndex(repo.root, { force: true });
    expect(before.builtAtCommit).not.toBeNull();

    rmSync(path.join(repo.root, ".git"), { force: true, recursive: true });
    clearDocsIndexCache();
    const after = await ensureDocsIndex(repo.root, { force: true });
    expect(after.builtAtCommit).toBeNull();
    expect(after.worktreeDirty).toBeNull();

    const status = docsStatus(after);
    expect(status.provenance.builtAtCommit).toBeNull();
    expect(status.provenance.corpusSource).toBe("filesystem");
    expect(status.degradation.active).toBe(true);
    expect(status.degradation.reason).toContain("read from the filesystem");
  });

  it("a worktree with NO COMMIT says so, and does not claim a filesystem read", async () => {
    const fresh = makeRepo();
    try {
      fresh.write("README.md", "# Fresh\n\nNo commit yet.\n");
      clearDocsIndexCache();
      const index = await ensureDocsIndex(fresh.root, { force: true });
      expect(index.builtAtCommit).toBeNull();
      // The SELECTOR answered perfectly well; only the commit is unknown.
      expect(index.corpusSource).toBe("git");
      expect(index.files.has("README.md")).toBe(true);
      const status = docsStatus(index);
      expect(status.degradation.reason).toContain("no commit yet");
      expect(status.degradation.reason).not.toContain("read from the filesystem");
    } finally {
      fresh.cleanup();
    }
  });

  it("the TTL backstop rebuilds an index older than DOCS_INDEX_TTL_MS", async () => {
    const first = await ensureDocsIndex(repo.root, { force: true });
    const firstBuiltAt = first.builtAtMs;
    // Age the index past the backstop without touching the tree.
    first.builtAtMs -= 61_000;
    const second = await ensureDocsIndex(repo.root);
    expect(second.builtAtMs).toBeGreaterThan(firstBuiltAt);
  });

  it("a mtime-only touch re-parses without changing any hash", async () => {
    const first = await ensureDocsIndex(repo.root, { force: true });
    const firstHash = first.corpusHash;
    const target = path.join(repo.root, "docs/research/old.md");
    const future = new Date(Date.now() + 5_000);
    utimesSync(target, future, future);
    const second = await ensureDocsIndex(repo.root);
    expect(second.corpusHash).toBe(firstHash);
  });
});

describe("determinism", () => {
  it("two independent builds of the same tree are identical", async () => {
    const a = await buildDocsIndex(repo.root);
    const b = await buildDocsIndex(repo.root);
    expect(b.corpusHash).toBe(a.corpusHash);
    expect(b.sectionOrder).toEqual(a.sectionOrder);
    expect([...b.files.keys()]).toEqual([...a.files.keys()]);
    for (const [id, section] of a.sections) {
      const other = b.sections.get(id);
      expect([id, other?.contentHash]).toEqual([id, section.contentHash]);
      expect([id, other?.codeAnchors]).toEqual([id, section.codeAnchors]);
      expect([id, other?.links]).toEqual([id, section.links]);
    }
  });

  it("an INCREMENTAL refresh produces the same index a full rebuild would", async () => {
    // The refresh path and the cold path share `deriveIndex`, deliberately: a
    // second derivation would be a second implementation of the index, and this
    // test would only be pinning one of them.
    const warm = await ensureDocsIndex(repo.root, { force: true });
    repo.write(
      "docs/research/old.md",
      "# Old research\n\n## The zzyzx protocol\n\nRewritten.\n"
    );
    const refreshed = await ensureDocsIndex(repo.root);
    expect(refreshed).toBe(warm); // same object, refreshed in place

    const cold = await buildDocsIndex(repo.root);
    expect(refreshed.corpusHash).toBe(cold.corpusHash);
    expect(refreshed.sectionOrder).toEqual(cold.sectionOrder);
    for (const [id, section] of cold.sections) {
      expect([id, refreshed.sections.get(id)?.contentHash]).toEqual([
        id,
        section.contentHash,
      ]);
    }
    expect([...refreshed.citations.keys()].sort()).toEqual(
      [...cold.citations.keys()].sort()
    );
  });
});

describe("the exclusion set is reported, never silent", () => {
  it("names each excluded file with the prefix that excluded it", async () => {
    repo.write(".claude/agents/persona.md", "# A persona\n\nMUST do the thing.\n");
    repo.write(".github/PULL_REQUEST_TEMPLATE.md", "# PR\n\nChecklist.\n");
    repo.write("packaging/oss/README.md", "# OSS\n\nExport template.\n");
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });

    // Agent-persona prompts are instructions AUTHORED FOR A MODEL; ranking them
    // as documentation is the one thing this design must not do.
    expect(index.files.has(".claude/agents/persona.md")).toBe(false);
    const status = docsStatus(index);
    expect(status.corpus.excluded).toEqual(
      expect.arrayContaining([
        { path: ".claude/agents/persona.md", reason: ".claude/" },
        { path: ".github/PULL_REQUEST_TEMPLATE.md", reason: ".github/" },
        { path: "packaging/oss/README.md", reason: "packaging/oss/" },
      ])
    );
    expect(status.provenance.excluded).toBe(3);
    expect(status.corpus.selector).toBe(status.corpus.corpus + 3);
  });
});
