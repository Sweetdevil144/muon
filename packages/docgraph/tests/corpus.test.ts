import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsStatus } from "../src/api.js";
import {
  DOCS_EXCLUDED_PREFIXES,
  containedPath,
  exclusionFor,
  knownFileSet,
  listMarkdownPaths,
  normalizeCitationPath,
  normalizeLinkTarget,
  repoProbe,
  withinRoot,
} from "../src/corpus.js";
import { clearDocsIndexCache, ensureDocsIndex } from "../src/index-build.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// P6: ONE selector. The corpus selector, the anchor known-file set and
// `scripts/check-docs.mjs`'s selector must produce identical path sets on this
// repository, modulo the named exclusion set — the guard against the three
// forking before the `check:docs` refactor (blueprint §8 step 7).


/** `scripts/check-docs.mjs:47-58`, run verbatim, as the independent oracle. */
function checkDocsSelector(): string[] {
  const stdout = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "*.md"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return [...new Set(stdout.split("\n").filter(Boolean))].sort();
}

describe("P6 — one selector", () => {
  it("the corpus selector equals `scripts/check-docs.mjs`'s, path for path", async () => {
    const { root } = await repoProbe(REPO_ROOT);
    const ours = await listMarkdownPaths(root);
    expect(ours).toEqual(checkDocsSelector());
  });

  it("the ANCHOR known-file set is a superset that agrees on every `*.md`", async () => {
    // A resolver narrower than the corpus selector manufactures false
    // `unresolved` for work in flight. The two must not fork.
    const { root } = await repoProbe(REPO_ROOT);
    const known = await knownFileSet(root);
    expect(known).not.toBeNull();
    const markdownFromKnown = [...(known ?? [])]
      .filter((file) => file.endsWith(".md"))
      .sort();
    expect(markdownFromKnown).toEqual(checkDocsSelector());
  });

  it("the corpus is the selector MINUS the named exclusion set, and nothing else", async () => {
    const index = await realCorpus();
    const selector = checkDocsSelector();
    const expected = selector.filter((relPath) => exclusionFor(relPath) === null);
    expect([...index.files.keys()].sort()).toEqual(expected);
    expect(index.excluded.map((entry) => entry.path).sort()).toEqual(
      selector.filter((relPath) => exclusionFor(relPath) !== null)
    );
  });

  it("the corpus and exclusion counts are within the ADR's measured band", async () => {
    const status = docsStatus(await realCorpus());
    // ADR-0053 measured 195 in / 177 corpus on 2026-08-17. Bounds, not exact
    // counts: the tree moves under this test.
    expect(status.corpus.selector).toBeGreaterThanOrEqual(150);
    expect(status.corpus.corpus).toBeGreaterThanOrEqual(140);
    expect(status.corpus.corpus).toBeLessThan(status.corpus.selector);
    expect(status.corpus.sections).toBeGreaterThan(2000);
    expect(status.corpus.fences).toBeGreaterThan(300);
    expect(status.corpus.skipped).toEqual([]);
  });

  it("excludes exactly the four named prefixes, and reports the reason", () => {
    expect([...DOCS_EXCLUDED_PREFIXES]).toEqual([
      ".claude/",
      ".kiro/",
      ".github/",
      "packaging/oss/",
    ]);
    expect(exclusionFor(".claude/agents/backend-engineer.md")).toBe(".claude/");
    expect(exclusionFor("packaging/oss/README.md")).toBe("packaging/oss/");
    expect(exclusionFor("packaging/install-registry/README.md")).toBeNull();
    expect(exclusionFor("docs/README.md")).toBeNull();
  });

  it("`.muon/` worktree copies are excluded BY CONSTRUCTION, via .gitignore", async () => {
    // The worktree copies that trap agents are full copies of the repository
    // INSIDE the repository. They are gitignored, so `--exclude-standard`
    // removes them without a rule anyone has to remember.
    const index = await realCorpus();
    for (const docPath of index.files.keys()) {
      expect(docPath.startsWith(".muon/")).toBe(false);
    }
  });
});

describe("path normalization refuses to leave the repository root", () => {
  it("withinRoot rejects an escape, the root itself, and an absolute sibling", () => {
    expect(withinRoot("/repo", "/repo/a/b.ts")).toBe(true);
    expect(withinRoot("/repo", "/repo")).toBe(false);
    expect(withinRoot("/repo", "/repo/../etc/passwd")).toBe(false);
    expect(withinRoot("/repo", "/etc/passwd")).toBe(false);
  });

  it("a link target that folds above the root is refused, not resolved", () => {
    expect(normalizeLinkTarget("docs/adr", "../../../../etc/passwd")).toBeNull();
    expect(normalizeLinkTarget("docs/adr", "../design/note.md")).toBe("docs/design/note.md");
  });

  it("a citation path folds `..` and strips `./`, and rejects a backslash escape", () => {
    // Two `..` from `docs/adr` land back at the root, which is INSIDE it; three
    // leave the repository and are refused.
    expect(normalizeCitationPath("docs/adr", "..\\..\\etc\\passwd")).toBe("etc/passwd");
    expect(normalizeCitationPath("docs/adr", "..\\..\\..\\etc\\passwd")).toBeNull();
    expect(normalizeCitationPath("docs", "./a/b.ts")).toBe("docs/a/b.ts");
    expect(normalizeCitationPath("docs", "packages\\mcp\\src\\a.ts")).toBe(
      "packages/mcp/src/a.ts"
    );
  });
});

describe("containment resolves symlinks before it answers", () => {
  let fixture: FixtureRepo;
  let outside: string;

  beforeEach(() => {
    fixture = makeRepo();
    fixture.write("docs/real.md", "# Real\n\nBody.\n");
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-docgraph-out-")));
    writeFileSync(path.join(outside, "secret.md"), "# Not ours\n", "utf8");
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(outside, { force: true, recursive: true });
  });

  const at = (relPath: string): string => path.join(fixture.root, relPath);

  it("an ordinary file is contained, at its own path", () => {
    expect(containedPath(fixture.root, at("docs/real.md"))).toEqual({
      contained: true,
      path: at("docs/real.md"),
    });
  });

  it("a symlink pointing OUT of the root is refused, naming the reason", () => {
    fixture.link("docs/escape.md", path.join(outside, "secret.md"));
    expect(containedPath(fixture.root, at("docs/escape.md"))).toEqual({
      contained: false,
      reason: "a symlink on this path resolves outside the repository root",
    });
  });

  it("a symlink pointing INSIDE the root resolves to its target", () => {
    fixture.link("docs/alias.md", "real.md");
    expect(containedPath(fixture.root, at("docs/alias.md"))).toEqual({
      contained: true,
      path: at("docs/real.md"),
    });
  });

  it("an INTERMEDIATE directory link is followed, and refused when it escapes", () => {
    // The segment walk exists for this: `withinRoot` sees a clean path and the
    // escape is one directory up the chain, not in the leaf.
    fixture.link("docs/inside", ".");
    expect(containedPath(fixture.root, at("docs/inside/real.md"))).toEqual({
      contained: true,
      path: at("docs/real.md"),
    });
    fixture.link("docs/elsewhere", outside);
    expect(containedPath(fixture.root, at("docs/elsewhere/secret.md")).contained).toBe(
      false
    );
  });

  it("a symlink CYCLE is bounded, not chased", () => {
    fixture.link("docs/a.md", "b.md");
    fixture.link("docs/b.md", "a.md");
    expect(containedPath(fixture.root, at("docs/a.md"))).toEqual({
      contained: false,
      reason: "too many symlink hops to resolve",
    });
  });

  it("a path that does not exist is CONTAINED — the caller reports the read", () => {
    // Answering "escaped the workspace" for a typo would put the two failures
    // under one word; a missing file is the caller's `unreadable`.
    expect(containedPath(fixture.root, at("docs/nope.md"))).toEqual({
      contained: true,
      path: at("docs/nope.md"),
    });
  });

  it("the root itself, and a path above it, are refused before any disk touch", () => {
    expect(containedPath(fixture.root, fixture.root).contained).toBe(false);
    expect(containedPath(fixture.root, path.join(outside, "secret.md"))).toEqual({
      contained: false,
      reason: "outside the resolved repository root",
    });
  });
});

describe("a directory link target is resolved, not called missing", () => {
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

  it("`[research/](research/)` resolves, and its `tracked` flag is null not false", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const section = index.sections.get("docs/README.md#historical-plans-and-research");
    const link = section?.links.find((entry) => entry.href === "research/");
    expect(link?.resolution).toBe("resolved");
    expect(link?.target).toBe("docs/research");
    // A directory is never in the tracked SET; reporting `false` here would read
    // as "exists but never git add'ed", which is a different claim.
    expect(link?.tracked).toBeNull();
  });

  it("a genuinely missing target is `unresolved`", async () => {
    repo.write("docs/design/broken.md", "# Broken\n\n[gone](./nowhere.md)\n");
    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    const link = index.sections
      .get("docs/design/broken.md#broken")
      ?.links.find((entry) => entry.href === "./nowhere.md");
    expect(link?.resolution).toBe("unresolved");
    expect(link?.resolvedPath).toBeNull();
  });
});
