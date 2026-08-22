import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A REAL temp git repository per test (blueprint §7.1).
 *
 * Real, not simulated: the corpus selector, the known-file set, HEAD, the git
 * index stamp and `worktreeDirty` are all `git` answers, and a fake would only
 * pin this package against its own assumptions about git. The real repository
 * lives under `mkdtemp` and the production tree is NEVER mutated by a test.
 *
 * `realpathSync` because macOS `mkdtemp` hands back `/var/folders/…` while
 * `git rev-parse --show-toplevel` answers the physical `/private/var/folders/…`,
 * and a root comparison against the wrong one fails for a reason that has
 * nothing to do with the code under test.
 */
export type FixtureRepo = {
  root: string;
  write(relPath: string, content: string): void;
  /**
   * A SYMLINK at `relPath` pointing at `target` (relative targets resolve from
   * the link's own directory, as they do on disk). Real, not simulated, because
   * the thing under test is that `git` tracks one as an ORDINARY index entry and
   * the corpus selector therefore names it exactly like a file.
   */
  link(relPath: string, target: string): void;
  remove(relPath: string): void;
  git(...args: string[]): string;
  add(...relPaths: string[]): void;
  commit(message: string): void;
  cleanup(): void;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "docgraph fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "docgraph fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function makeRepo(): FixtureRepo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-docgraph-")));
  const repo: FixtureRepo = {
    root,
    write(relPath, content) {
      const absolute = path.join(root, relPath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    },
    link(relPath, target) {
      const absolute = path.join(root, relPath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      rmSync(absolute, { force: true });
      symlinkSync(target, absolute);
    },
    remove(relPath) {
      rmSync(path.join(root, relPath), { force: true, recursive: true });
    },
    git(...args) {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: GIT_ENV,
      });
    },
    add(...relPaths) {
      repo.git("add", ...(relPaths.length > 0 ? ["--", ...relPaths] : ["-A"]));
    },
    commit(message) {
      repo.git("commit", "--no-gpg-sign", "-q", "-m", message);
    },
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
  };
  repo.git("init", "-q", "-b", "main");
  return repo;
}

const FENCE = "```";

/**
 * The six-document fixture corpus of blueprint §7.1, plus one seventh
 * (`docs/testing/walkthrough.md`) that exists to prove the derived canon set
 * captures a document a DIRECTORY rule would classify differently — the real
 * shape of `docs/README.md`, which lists `research/…` and `testing/…` files as
 * canon.
 *
 * Code spans across the corpus cite: a tracked file, an existing-but-uncommitted
 * file, an ambiguous tail (`src/index.ts` exists twice), a unique tail, and a
 * path that never existed.
 */
export function seedCorpus(repo: FixtureRepo): void {
  repo.write(
    "README.md",
    [
      "# Fixture repository",
      "",
      "The root readme is canon by CONVENTION, not because the index lists it.",
      "",
      "It cites `src/tracked.ts` and `src/uncommitted.ts` in prose.",
      "",
    ].join("\n")
  );

  repo.write(
    "docs/README.md",
    [
      "# Fixture documentation index",
      "",
      "Read this before treating a plan as the product boundary.",
      "",
      "## Canonical current documents",
      "",
      "- [`adr/0001-a.md`](adr/0001-a.md): the accepted decision.",
      "- [`testing/walkthrough.md`](testing/walkthrough.md): canon, in a directory no rule covers.",
      "",
      "## Historical plans and research",
      "",
      "Files in [`research/`](research/) are dated evidence, not instructions.",
      "",
    ].join("\n")
  );

  repo.write(
    "docs/adr/0001-a.md",
    [
      "# ADR-0001: The first decision",
      "",
      "- **Status:** Accepted (2026-08-17)",
      "",
      "## Context",
      "",
      "The gate lives in `src/tracked.ts:12-20`, and the helper in",
      "`lib/deep/unique-name.ts` is cited by its tail only.",
      "",
      "See [ADR-0002 section two](0002-b.md#section-two).",
      "",
      "### A nested heading",
      "",
      "Nested under Context, so its breadcrumb has three entries.",
      "",
      "## Consequences",
      "",
      "A path that never existed: `src/never-existed.ts`.",
      "An ambiguous tail: `src/index.ts`.",
      "An escape attempt: [passwd](../../../../etc/passwd).",
      "",
      "#### A skipped level",
      "",
      "Depth 4 directly under a depth-2, so no phantom depth-3 parent.",
      "",
    ].join("\n")
  );

  repo.write(
    "docs/adr/0002-b.md",
    [
      "# ADR-0002: The superseded decision",
      "",
      "- **Status:** Superseded by ADR-0001",
      "",
      "## Section one",
      "",
      "The first body.",
      "",
      "## Section two",
      "",
      "The second body, cited by ADR-0001.",
      "",
      "## Section one",
      "",
      "A repeated heading, so its slug is disambiguated.",
      "",
    ].join("\n")
  );

  repo.write(
    "docs/design/note.md",
    [
      "Bytes before the first heading, so the preamble section is not empty.",
      "",
      "# A design note",
      "",
      "## A fenced block",
      "",
      `${FENCE}md`,
      "# Not A Heading",
      "",
      "Neither is `## This One`.",
      `${FENCE}`,
      "",
      "Prose after the fence, in the same section.",
      "",
      "## A diagram",
      "",
      `${FENCE}mermaid`,
      "flowchart TD",
      "  A --> B",
      `${FENCE}`,
      "",
    ].join("\n")
  );

  repo.write(
    "docs/research/old.md",
    [
      "# Old research",
      "",
      "## The zzyzx protocol",
      "",
      "A dated note about the zzyzx protocol, preserved as evidence.",
      "",
    ].join("\n")
  );

  repo.write(
    "docs/testing/walkthrough.md",
    [
      "# The walkthrough",
      "",
      "Canon because `docs/README.md` links it, not because of its directory.",
      "",
    ].join("\n")
  );

  // Source files the citations above resolve (or fail to resolve) against.
  repo.write("src/tracked.ts", "export const tracked = true;\n");
  repo.write("src/renamed-me.ts", "export const renameMe = true;\n");
  repo.write("a/src/index.ts", "export const a = 1;\n");
  repo.write("b/src/index.ts", "export const b = 2;\n");
  repo.write("packages/lib/deep/unique-name.ts", "export const unique = 3;\n");

  repo.add();
  repo.commit("seed the fixture corpus");

  // Written AFTER the commit and deliberately never `git add`ed: this is the
  // in-flight case ADR-0053 §7 exists for.
  repo.write("src/uncommitted.ts", "export const inFlight = true;\n");
}
