import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P5 — NO READ OUTSIDE THE ROOT.
//
// `node:fs` is mocked for this whole file so every `readFileSync` the index
// issues is recorded. A behavioural assertion alone ("the escaping link resolves
// external") would not prove the file was never OPENED, and that is the claim
// ADR-0053's non-goals actually make. Mirrors the code-graph tools' workspace
// fence.

const spy = vi.hoisted(() => ({
  reads: [] as string[],
  stats: [] as string[],
  lstats: [] as string[],
  readlinks: [] as string[],
  realpaths: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync: typeof actual.readFileSync = ((...args: unknown[]) => {
    spy.reads.push(String(args[0]));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
  }) as never;
  const statSync: typeof actual.statSync = ((...args: unknown[]) => {
    spy.stats.push(String(args[0]));
    return (actual.statSync as (...a: unknown[]) => unknown)(...args);
  }) as never;
  // The three calls the SYMLINK fence makes are recorded too, because its claim
  // is stronger than "nothing outside is read": nothing outside is TOUCHED, not
  // even to decide whether to refuse it.
  const lstatSync: typeof actual.lstatSync = ((...args: unknown[]) => {
    spy.lstats.push(String(args[0]));
    return (actual.lstatSync as (...a: unknown[]) => unknown)(...args);
  }) as never;
  const readlinkSync: typeof actual.readlinkSync = ((...args: unknown[]) => {
    spy.readlinks.push(String(args[0]));
    return (actual.readlinkSync as (...a: unknown[]) => unknown)(...args);
  }) as never;
  const realpathSync = Object.assign(
    ((...args: unknown[]) => {
      spy.realpaths.push(String(args[0]));
      return (actual.realpathSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.realpathSync,
    { native: actual.realpathSync.native }
  );
  // The DEFAULT export is patched too: `node:fs` is consumed both ways in this
  // workspace, and a mock that only replaced the named exports would let a
  // `fs.readFileSync` call through unrecorded — which is exactly the read this
  // test exists to prove never happens.
  const asRecord = actual as unknown as Record<string, unknown>;
  const defaultExport = (asRecord.default ?? actual) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync,
    statSync,
    lstatSync,
    readlinkSync,
    realpathSync,
    default: {
      ...defaultExport,
      readFileSync,
      statSync,
      lstatSync,
      readlinkSync,
      realpathSync,
    },
  };
});

const { clearDocsIndexCache, ensureDocsIndex } = await import("../src/index-build.js");
const { docsCiting, docsStatus } = await import("../src/api.js");
const { makeRepo, seedCorpus } = await import("./fixture-repo.js");
const { mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const nodePath = await import("node:path");

let repo: Awaited<ReturnType<typeof makeRepo>>;
/** Directories created OUTSIDE the fixture repository, removed after each test. */
const outsideDirs: string[] = [];

function forgetCalls(): void {
  spy.reads.length = 0;
  spy.stats.length = 0;
  spy.lstats.length = 0;
  spy.readlinks.length = 0;
  spy.realpaths.length = 0;
}

beforeEach(() => {
  clearDocsIndexCache();
  forgetCalls();
  repo = makeRepo();
  seedCorpus(repo);
});

afterEach(() => {
  repo.cleanup();
  while (outsideDirs.length > 0) {
    rmSync(outsideDirs.pop() as string, { force: true, recursive: true });
  }
  clearDocsIndexCache();
});

describe("P5 — no read outside the resolved repository root", () => {
  it("issues NO readFileSync outside provenance.root, escaping link and all", async () => {
    // `docs/adr/0001-a.md` carries `[passwd](../../../../etc/passwd)`.
    spy.reads.length = 0;
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.size).toBeGreaterThan(5);

    const outside = spy.reads.filter((read) => !read.startsWith(`${index.root}/`));
    expect(outside).toEqual([]);
    expect(spy.reads.some((read) => read.includes("/etc/passwd"))).toBe(false);
  });

  it("issues NO statSync outside the root either", async () => {
    spy.stats.length = 0;
    const index = await ensureDocsIndex(repo.root, { force: true });
    const outside = spy.stats.filter((stat) => !stat.startsWith(`${index.root}/`));
    expect(outside).toEqual([]);
  });

  it("the escaping link target resolves `external` — a STRING decision, not a stat", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    const link = index.sections
      .get("docs/adr/0001-a.md#consequences")
      ?.links.find((entry) => entry.href.includes("etc/passwd"));
    expect(link).toBeDefined();
    expect(link?.resolution).toBe("external");
    expect(link?.target).toBeNull();
    expect(link?.resolvedPath).toBeNull();
  });

  it("an absolute-path citation is never indexed as a repository coordinate", async () => {
    repo.write(
      "docs/design/absolute.md",
      "# Absolute\n\nIt reads `/etc/shadow.conf` and `../../../outside/thing.ts`.\n"
    );
    clearDocsIndexCache();
    spy.reads.length = 0;
    const index = await ensureDocsIndex(repo.root, { force: true });

    expect(spy.reads.some((read) => read.includes("/etc/shadow.conf"))).toBe(false);
    expect(docsCiting(index, "/etc/shadow.conf").citedBy).toEqual([]);
    for (const key of index.citations.keys()) {
      expect(key.startsWith("/")).toBe(false);
      expect(key.startsWith("../")).toBe(false);
    }
  });

  it("every indexed document path is repo-relative and inside the root", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    for (const docPath of index.files.keys()) {
      expect(docPath.startsWith("/")).toBe(false);
      expect(docPath.includes("..")).toBe(false);
    }
  });
});

// P5, THE SYMLINK HALF.
//
// `git` tracks a symlink as an ORDINARY index entry, so
// `git ls-files -- '*.md'` names `docs/design/escape.md → /elsewhere/secret.md`
// exactly like a file, and a fence that compares resolved paths as STRINGS reads
// straight through it. These are the four answers that fence owes: refuse the
// escape and SAY SO, still follow a link that stays inside, leave an ordinary file
// alone, and give the same verdict when the swap happens under a RUNNING index.

const SECRET = "OUTSIDE-CORPUS-SENTINEL-9f2c";

/** A directory OUTSIDE the fixture repository, holding one markdown file. */
function makeOutside(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "muon-docgraph-out-")));
  const file = nodePath.join(dir, "secret.md");
  writeFileSync(file, `# Not ours\n\n${SECRET}\n`, "utf8");
  outsideDirs.push(dir);
  return { dir, file };
}

describe("P5 — a TRACKED SYMLINK does not read through the fence", () => {
  it("refuses a tracked symlink pointing outside the root, and REPORTS it", async () => {
    const outside = makeOutside();
    repo.link("docs/design/escape.md", outside.file);
    repo.add();
    repo.commit("track a symlink that leaves the workspace");

    clearDocsIndexCache();
    forgetCalls();
    const index = await ensureDocsIndex(repo.root, { force: true });

    // The selector DID name it — that is the whole point of the finding.
    expect(index.selectorPaths).toContain("docs/design/escape.md");
    // …and the index refused it BY NAME rather than reading it.
    expect(index.files.has("docs/design/escape.md")).toBe(false);
    expect(index.skipped).toContainEqual({
      path: "docs/design/escape.md",
      reason: "a symlink on this path resolves outside the repository root",
    });
    const status = docsStatus(index);
    expect(status.degradation.active).toBe(true);
    expect(status.degradation.entries.map((entry) => entry.code)).toContain(
      "files-skipped"
    );

    // Nothing outside the root was read, stat'd, lstat'd — or realpath'd, which
    // is how this fence decides WITHOUT resolving the escaping target.
    for (const touched of [...spy.reads, ...spy.stats, ...spy.lstats]) {
      expect([touched, touched.startsWith(`${index.root}/`)]).toEqual([touched, true]);
    }
    expect(spy.realpaths).toEqual([]);
    expect(spy.readlinks).toContain(nodePath.join(index.root, "docs/design/escape.md"));
    expect(spy.reads.some((read) => read.startsWith(outside.dir))).toBe(false);

    // And the bytes never entered the corpus by any other door.
    for (const section of index.sections.values()) {
      expect(section.text).not.toContain(SECRET);
    }
  });

  it("still follows a tracked symlink that stays INSIDE the root", async () => {
    // The over-refusal case. A repository may legitimately alias one document at
    // a second path, and refusing every symlink would silently drop it.
    repo.link("docs/design/mirror.md", "../adr/0001-a.md");
    repo.add();
    repo.commit("track an in-tree symlink");

    clearDocsIndexCache();
    forgetCalls();
    const index = await ensureDocsIndex(repo.root, { force: true });

    expect(index.skipped).toEqual([]);
    expect(index.files.has("docs/design/mirror.md")).toBe(true);
    expect(index.files.get("docs/design/mirror.md")?.title).toBe(
      "ADR-0001: The first decision"
    );
    // Sections are addressed by the path the SELECTOR named, not by the target's.
    expect(index.sections.has("docs/design/mirror.md#context")).toBe(true);
    // The read landed on the resolved location — the one the fence cleared.
    expect(spy.reads).toContain(nodePath.join(index.root, "docs/adr/0001-a.md"));
    expect(docsStatus(index).degradation.entries.map((entry) => entry.code)).not.toContain(
      "files-skipped"
    );
  });

  it("leaves an ORDINARY file exactly as it was", async () => {
    const outside = makeOutside();
    repo.link("docs/design/escape.md", outside.file);
    repo.add();
    repo.commit("one escape, one ordinary file");

    clearDocsIndexCache();
    const index = await ensureDocsIndex(repo.root, { force: true });
    // The refusal is scoped to the one entry: every other document is indexed,
    // parsed and addressable.
    expect(index.files.has("docs/design/note.md")).toBe(true);
    expect(index.sections.get("docs/design/note.md#a-diagram")?.fences[0]?.lang).toBe(
      "mermaid"
    );
    expect(index.files.size).toBeGreaterThan(5);
  });

  it("refuses a doc SWAPPED for an escaping symlink under the running index", async () => {
    // Revalidation is the second door. The corpus path set does not move when a
    // file becomes a link, so only the per-file fence can catch this one.
    const outside = makeOutside();
    repo.add();
    repo.commit("clean the tree");
    clearDocsIndexCache();
    const first = await ensureDocsIndex(repo.root);
    expect(first.files.has("docs/research/old.md")).toBe(true);

    repo.link("docs/research/old.md", outside.file);
    forgetCalls();
    // No force and no cache clear: the refresh path must refuse on its own.
    const second = await ensureDocsIndex(repo.root);

    expect(second.files.has("docs/research/old.md")).toBe(false);
    expect(second.skipped).toContainEqual({
      path: "docs/research/old.md",
      reason: "a symlink on this path resolves outside the repository root",
    });
    expect(docsStatus(second).degradation.entries.map((entry) => entry.code)).toContain(
      "files-skipped"
    );
    expect(spy.reads.some((read) => read.startsWith(outside.dir))).toBe(false);
    expect(spy.stats.some((stat) => stat.startsWith(outside.dir))).toBe(false);
    for (const section of second.sections.values()) {
      expect(section.text).not.toContain(SECRET);
    }
  });
});
