import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnownFiles, codeSpanCandidate } from "../src/anchors.js";
import { docsCiting, docsStatus } from "../src/api.js";
import { clearDocsIndexCache, ensureDocsIndex } from "../src/index-build.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// T8 + T9 + P2 + P7: five anchor states, `tracked` orthogonal to all of them,
// and the one rule this module has — `unresolved` is an ASSERTION about the
// repository and is never written without the set.


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

function anchorFor(
  sections: Iterable<{ docPath: string; codeAnchors: { path: string }[] }>,
  wanted: string,
  inDoc?: string
) {
  for (const section of sections) {
    if (inDoc && section.docPath !== inDoc) {
      continue;
    }
    const hit = section.codeAnchors.find((anchor) => anchor.path === wanted);
    if (hit) {
      return hit as never as {
        path: string;
        resolution: string | null;
        resolvedPath: string | null;
        inferred: boolean;
        candidates: number;
        tracked: boolean | null;
        lines: number[] | null;
      };
    }
  }
  return undefined;
}

describe("code-span candidate detection", () => {
  it("accepts a path-shaped span and strips its line reference", () => {
    expect(codeSpanCandidate("packages/mcp/src/gitnexus-tools.ts", "docs/adr/x.md")).toEqual({
      path: "packages/mcp/src/gitnexus-tools.ts",
      lines: null,
    });
    expect(codeSpanCandidate("backend/src/lib/anchor-resolution.ts:22-35", "docs/x.md")).toEqual({
      path: "backend/src/lib/anchor-resolution.ts",
      lines: [22, 35],
    });
  });

  it("accepts the COMMA form this corpus really uses, which a stricter grammar loses", () => {
    // `scripts/check-docs.mjs:72,83-86` is a real citation in docs/design/.
    expect(codeSpanCandidate("scripts/check-docs.mjs:72,83-86", "docs/x.md")).toEqual({
      path: "scripts/check-docs.mjs",
      lines: [72, 83, 86],
    });
  });

  it("is REPO-ROOT-relative by default and document-relative only when spelled so", () => {
    // Joining a root-relative citation against the referring directory turns
    // every exact resolution in this corpus into a false `unresolved`.
    expect(codeSpanCandidate("packages/x/src/a.ts", "docs/adr/0053.md")?.path).toBe(
      "packages/x/src/a.ts"
    );
    expect(codeSpanCandidate("./build.sh", "docs/adr/0053.md")?.path).toBe(
      "docs/adr/build.sh"
    );
    expect(codeSpanCandidate("../design/note.md", "docs/adr/0053.md")?.path).toBe(
      "docs/design/note.md"
    );
    expect(codeSpanCandidate("./build.sh", "README.md")?.path).toBe("build.sh");
  });

  it("rejects a span that is not path-shaped", () => {
    expect(codeSpanCandidate("tokenize", "d.md")).toBeNull();
    expect(codeSpanCandidate("git ls-files -co --exclude-standard '*.md'", "d.md")).toBeNull();
    expect(codeSpanCandidate("a/b", "d.md")).toBeNull(); // no extension
    expect(codeSpanCandidate("src/a.verylongextension", "d.md")).toBeNull();
  });

  it("treats a RANGE NOTATION as a path candidate, which then lands `unresolved`", () => {
    // `.claude/agents/system-architect.md` cites `docs/adr/0007..0012`, which is
    // a range and not a path. It is extension-shaped, so it becomes a candidate
    // and resolves to nothing — the honest answer, and the ADR names it as such.
    expect(codeSpanCandidate("docs/adr/0007..0012", "d.md")).toEqual({
      path: "docs/adr/0007..0012",
      lines: null,
    });
    const known = new KnownFiles(new Set(["docs/adr/0007-acp-interop.md"]), new Set());
    expect(known.resolve("docs/adr/0007..0012").resolution).toBe("unresolved");
  });

  it("refuses a span that folds ABOVE the repository root", () => {
    expect(codeSpanCandidate("../../../../etc/passwd.conf", "docs/adr/x.md")).toBeNull();
  });
});

describe("T8 — the five anchor states", () => {
  it("resolved: an exactly-spelled tracked path", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const anchor = anchorFor(
      index.sections.values(),
      "src/tracked.ts",
      "docs/adr/0001-a.md"
    );
    expect(anchor?.resolution).toBe("resolved");
    expect(anchor?.resolvedPath).toBe("src/tracked.ts");
    expect(anchor?.inferred).toBe(false);
    expect(anchor?.tracked).toBe(true);
    expect(anchor?.lines).toEqual([12, 20]);
  });

  it("suffix-resolved: a UNIQUE tail, returned inferred and with the full path", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const anchor = anchorFor(index.sections.values(), "lib/deep/unique-name.ts");
    expect(anchor?.resolution).toBe("suffix-resolved");
    expect(anchor?.resolvedPath).toBe("packages/lib/deep/unique-name.ts");
    expect(anchor?.inferred).toBe(true);
  });

  it("ambiguous: a tail matching more than one file is NEVER resolved by picking", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const anchor = anchorFor(index.sections.values(), "src/index.ts");
    expect(anchor?.resolution).toBe("ambiguous");
    expect(anchor?.resolvedPath).toBeNull();
    expect(anchor?.candidates).toBe(2);
    expect(anchor?.inferred).toBe(false);
  });

  it("unresolved: we HELD the set and the path is not in it", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const anchor = anchorFor(index.sections.values(), "src/never-existed.ts");
    expect(anchor?.resolution).toBe("unresolved");
    expect(anchor?.resolvedPath).toBeNull();
    expect(anchor?.tracked).toBeNull();
  });

  it("`src/index.ts` really is ambiguous in THIS repository too", async () => {
    const known = new KnownFiles(
      new Set(["a/src/index.ts", "b/src/index.ts", "c/src/index.ts"]),
      new Set(["a/src/index.ts"])
    );
    const verdict = known.resolve("src/index.ts");
    expect(verdict.resolution).toBe("ambiguous");
    expect(verdict.candidates).toBe(3);
    expect(verdict.resolvedPath).toBeNull();
  });

  it("a tail deeper than four segments is not inferred at all", () => {
    const known = new KnownFiles(new Set(["w/x/y/z/deep/file.ts"]), new Set());
    expect(known.resolve("x/y/z/deep/file.ts").resolution).toBe("unresolved");
    expect(known.resolve("y/z/deep/file.ts").resolution).toBe("suffix-resolved");
  });
});

describe("T9 — the known set could not be obtained", () => {
  it("every anchor is `null`, NO anchor is `unresolved`, and builtAtCommit is null", async () => {
    rmSync(path.join(repo.root, ".git"), { force: true, recursive: true });
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });

    expect(index.builtAtCommit).toBeNull();
    expect(index.worktreeDirty).toBeNull();
    expect(index.corpusSource).toBe("filesystem");
    expect(index.known.known).toBeNull();

    let anchors = 0;
    for (const section of index.sections.values()) {
      for (const anchor of section.codeAnchors) {
        anchors += 1;
        // NEVER an assertion about a repository we learned nothing about.
        expect([anchor.path, anchor.resolution]).toEqual([anchor.path, null]);
        expect(anchor.tracked).toBeNull();
      }
    }
    expect(anchors).toBeGreaterThan(0);

    const status = docsStatus(index);
    expect(status.anchors.unresolved).toBe(0);
    expect(status.anchors.unknown).toBe(anchors);
    expect(status.degradation.active).toBe(true);
    expect(status.degradation.entries.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["git-unreadable", "anchors-unresolvable"])
    );
    // The corpus was still read — it just cannot claim a commit.
    expect(status.corpus.corpus).toBeGreaterThan(5);
  });
});

describe("P7 — an uncommitted file is not a missing file", () => {
  it("resolves with tracked:false, and `git add` flips ONLY that flag", async () => {
    repo.write(
      "docs/design/inflight.md",
      "# In flight\n\nThe gate lives in `src/uncommitted.ts`.\n"
    );
    let index = await ensureDocsIndex(repo.root, { force: true });
    let anchor = anchorFor(index.sections.values(), "src/uncommitted.ts");
    expect(anchor?.resolution).toBe("resolved");
    expect(anchor?.tracked).toBe(false);
    const before = { ...anchor };

    // `docs_impact` finds it under the uncommitted path, because the corpus
    // selector and the anchor set are the SAME selector.
    expect(docsCiting(index, "src/uncommitted.ts").totals.sections).toBeGreaterThan(0);

    repo.add("src/uncommitted.ts");
    clearDocsIndexCache();
    index = await ensureDocsIndex(repo.root, { force: true });
    anchor = anchorFor(index.sections.values(), "src/uncommitted.ts");
    expect(anchor?.resolution).toBe("resolved");
    expect(anchor?.tracked).toBe(true);
    expect({ ...anchor, tracked: before.tracked }).toEqual(before);
  });

  it("the git-index stamp makes `git add` visible WITHOUT forcing a rebuild", async () => {
    repo.write(
      "docs/design/inflight.md",
      "# In flight\n\nThe gate lives in `src/uncommitted.ts`.\n"
    );
    let index = await ensureDocsIndex(repo.root, { force: true });
    expect(anchorFor(index.sections.values(), "src/uncommitted.ts")?.tracked).toBe(false);

    repo.add("src/uncommitted.ts");
    // No force, no cache clear: revalidation alone must notice.
    index = await ensureDocsIndex(repo.root);
    expect(anchorFor(index.sections.values(), "src/uncommitted.ts")?.tracked).toBe(true);
  });
});

describe("P2 — a renamed file re-resolves or degrades MARKED, never silently", () => {
  it("git mv turns every citing anchor `unresolved`, and impact on the new path is an explicit empty", async () => {
    repo.write(
      "docs/design/rename.md",
      "# Rename\n\nThe helper is `src/renamed-me.ts`.\n"
    );
    repo.add();
    repo.commit("cite the file about to move");

    let index = await ensureDocsIndex(repo.root, { force: true });
    expect(anchorFor(index.sections.values(), "src/renamed-me.ts")?.resolution).toBe(
      "resolved"
    );

    repo.git("mv", "src/renamed-me.ts", "src/renamed-you.ts");
    repo.commit("rename it");
    clearDocsIndexCache();
    index = await ensureDocsIndex(repo.root, { force: true });

    const stale = anchorFor(index.sections.values(), "src/renamed-me.ts");
    // NOT absent, and NOT silently repointed at the new file.
    expect(stale).toBeDefined();
    expect(stale?.resolution).toBe("unresolved");
    expect(stale?.resolvedPath).toBeNull();

    const impact = docsCiting(index, "src/renamed-you.ts");
    expect(impact.citedBy).toEqual([]);
    expect(impact.reason).toBe("no documentation cites this path");
    expect(impact.totals).toEqual({ sections: 0, documents: 0, canon: 0, historical: 0 });
  });

  it("a UNIQUE-tail citation of the new path re-resolves, inferred and labeled", async () => {
    repo.git("mv", "src/renamed-me.ts", "packages/lib/deep/renamed-you.ts");
    repo.commit("move it somewhere unique");
    repo.write(
      "docs/design/rename.md",
      "# Rename\n\nCited by its tail: `deep/renamed-you.ts`.\n"
    );
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });

    const anchor = anchorFor(index.sections.values(), "deep/renamed-you.ts");
    expect(anchor?.resolution).toBe("suffix-resolved");
    expect(anchor?.inferred).toBe(true);
    expect(anchor?.resolvedPath).toBe("packages/lib/deep/renamed-you.ts");
  });
});

describe("the real corpus resolves the way the ADR measured", () => {
  it("resolves the overwhelming majority of its path-shaped code spans", async () => {
    const index = await realCorpus();
    const status = docsStatus(index);
    // Bounds, not exact counts — the tree moves under this test. The ADR
    // measured 1,660 exact / 117 unique-tail / 9 ambiguous.
    expect(status.anchors.total).toBeGreaterThan(1500);
    expect(status.anchors.resolved).toBeGreaterThan(1200);
    expect(status.anchors.suffixResolved).toBeGreaterThan(20);
    expect(status.anchors.unknown).toBe(0);
    expect(status.anchors.resolved / status.anchors.total).toBeGreaterThan(0.6);
  });

  it("resolves every relative markdown link, matching `check:docs`'s 0 broken links", async () => {
    const index = await realCorpus();
    expect(docsStatus(index).links.unresolved).toBe(0);
  });
});
