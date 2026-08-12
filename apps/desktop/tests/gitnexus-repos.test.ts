import { describe, expect, it } from "vitest";
import {
  discoverGitRepos,
  resolveIndexTargets,
  type RepoFs,
} from "../src/lib/gitnexus-repos.js";

// A tiny in-memory tree fake. Keys are dir paths; values are the child entries
// (each name + whether it's a directory). A `.git` child (dir or file) marks a
// repo.
type Tree = Record<string, Array<{ name: string; dir: boolean }>>;

function fakeFs(tree: Tree): RepoFs {
  return {
    existsSync: (p) => {
      // `.git` marker lookup: p ends with "/.git"; the parent must list a ".git".
      const slash = p.lastIndexOf("/");
      const parent = p.slice(0, slash);
      const name = p.slice(slash + 1);
      return (tree[parent] ?? []).some((e) => e.name === name);
    },
    readdirSync: (p) =>
      (tree[p] ?? []).map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
      })),
  };
}

// The exact ATLAS shape from the founder: a non-git parent, `operations`
// holding two repos, `wealth` a repo of its own.
const ATLAS: Tree = {
  "/q": [
    { name: "operations", dir: true },
    { name: "wealth", dir: true },
    { name: "README.md", dir: false },
  ],
  "/q/operations": [
    { name: "backend", dir: true },
    { name: "frontend", dir: true },
  ],
  "/q/operations/backend": [{ name: ".git", dir: true }],
  "/q/operations/frontend": [{ name: ".git", dir: true }],
  "/q/wealth": [
    { name: ".git", dir: true },
    { name: "backend", dir: true },
    { name: "frontend", dir: true },
  ],
  // wealth's own subdirs — must NOT be descended into (wealth is already a repo)
  "/q/wealth/backend": [{ name: ".git", dir: true }],
  "/q/wealth/frontend": [{ name: "src", dir: true }],
};

describe("discoverGitRepos — deterministic, no recursion errors", () => {
  it("finds every git repo in a monorepo of separate repos (the ATLAS case)", () => {
    const fs = fakeFs(ATLAS);
    expect(discoverGitRepos("/q", { fs })).toEqual([
      "/q/operations/backend",
      "/q/operations/frontend",
      "/q/wealth",
    ]);
  });

  it("STOPS at the first .git — never descends into a repo's own tree", () => {
    // /q/wealth is a repo AND contains /q/wealth/backend (also a .git). Because
    // we stop at wealth, its nested backend is NOT reported as a separate repo.
    const fs = fakeFs(ATLAS);
    const repos = discoverGitRepos("/q", { fs });
    expect(repos).not.toContain("/q/wealth/backend");
  });

  it("returns [root] when the root itself is a repo", () => {
    const fs = fakeFs({ "/r": [{ name: ".git", dir: true }] });
    expect(discoverGitRepos("/r", { fs })).toEqual(["/r"]);
  });

  it("returns [] for a plain folder with no repos (a clean, non-error state)", () => {
    const fs = fakeFs({ "/x": [{ name: "docs", dir: true }], "/x/docs": [] });
    expect(discoverGitRepos("/x", { fs })).toEqual([]);
  });

  it("bounds depth — deep repos past maxDepth are not found", () => {
    const fs = fakeFs({
      "/a": [{ name: "b", dir: true }],
      "/a/b": [{ name: "c", dir: true }],
      "/a/b/c": [{ name: ".git", dir: true }],
    });
    expect(discoverGitRepos("/a", { fs, maxDepth: 1 })).toEqual([]);
    expect(discoverGitRepos("/a", { fs, maxDepth: 2 })).toEqual(["/a/b/c"]);
  });

  it("a .git FILE (worktree/submodule) still marks a repo", () => {
    const fs = fakeFs({ "/w": [{ name: ".git", dir: false }] });
    expect(discoverGitRepos("/w", { fs })).toEqual(["/w"]);
  });

  it("never throws on an unreadable directory", () => {
    const fs: RepoFs = {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error("EACCES");
      },
    };
    expect(() => discoverGitRepos("/boom", { fs })).not.toThrow();
    expect(discoverGitRepos("/boom", { fs })).toEqual([]);
  });
});

describe("resolveIndexTargets — the repos to index for an opened folder", () => {
  it("a git work-tree → [folder] (single-repo path; covers opened-subdir)", () => {
    expect(
      resolveIndexTargets("/repo/src", { isGitRepo: () => true })
    ).toEqual(["/repo/src"]);
  });

  it("a non-git parent → the discovered member repos (monorepo)", () => {
    const fs = fakeFs(ATLAS);
    expect(
      resolveIndexTargets("/q", { isGitRepo: () => false, fs })
    ).toEqual([
      "/q/operations/backend",
      "/q/operations/frontend",
      "/q/wealth",
    ]);
  });

  it("neither a repo nor containing any → [] (nothing to index, no error)", () => {
    const fs = fakeFs({ "/empty": [] });
    expect(
      resolveIndexTargets("/empty", { isGitRepo: () => false, fs })
    ).toEqual([]);
  });
});
