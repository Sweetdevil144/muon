import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareWorktreeDependencies,
  summarizeWorktreePreparation,
} from "../src/worktree-prep.js";
import { ensureTaskWorktree } from "../src/worktree.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await run("git", args, { cwd });
}

async function write(path: string, contents: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

// ── P0: a governed worktree that cannot run a test is worthless ───────────────
//
// `git worktree add` produces a checkout with NO node_modules (it is gitignored)
// and NO build output, so a worker dispatched into one cannot resolve a single
// module — it burns its whole run discovering that. These tests pin the two
// properties that make preparation safe rather than merely convenient: the
// worktree resolves its OWN workspace packages (never the primary checkout's),
// and preparation never dirties git status.

describe("prepareWorktreeDependencies", () => {
  let source: string;
  let worktree: string;

  beforeEach(async () => {
    source = await realpath(await mkdtemp(join(tmpdir(), "muon-prep-source-")));
    worktree = await realpath(await mkdtemp(join(tmpdir(), "muon-prep-tree-")));
  });

  afterEach(async () => {
    for (const path of [source, worktree]) {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }).catch(() => {});
    }
  });

  it("points workspace packages at the WORKTREE and third-party at the checkout", async () => {
    await write(join(source, "packages", "lib", "src", "index.ts"), "export {};\n");
    await write(
      join(source, "apps", "cli", "node_modules", "left-pad", "index.js"),
      "module.exports = 1;\n"
    );
    await mkdir(join(source, "apps", "cli", "node_modules", "@acme"), {
      recursive: true,
    });
    await symlink(
      join(source, "packages", "lib"),
      join(source, "apps", "cli", "node_modules", "@acme", "lib"),
      "dir"
    );
    await mkdir(join(worktree, "apps", "cli"), { recursive: true });
    await mkdir(join(worktree, "packages", "lib"), { recursive: true });

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(prepared.problems).toEqual([]);
    // The wrong-tree trap: a scope directory holding a workspace package can
    // NEVER be linked whole, or the worker tests the primary checkout's code.
    expect(
      await readlink(
        join(worktree, "apps", "cli", "node_modules", "@acme", "lib")
      )
    ).toBe(join(worktree, "packages", "lib"));
    // Third-party is shared, so no install is needed.
    expect(
      await readlink(join(worktree, "apps", "cli", "node_modules", "left-pad"))
    ).toBe(join(source, "apps", "cli", "node_modules", "left-pad"));
    expect(prepared.links).toEqual([
      { packageDir: join("apps", "cli"), shared: 1, workspace: 1, mirroredOutputs: [] },
    ]);
  });

  it("resolves an unscoped workspace link into the worktree too", async () => {
    await write(join(source, "packages", "lib", "index.js"), "module.exports = 1;\n");
    await mkdir(join(source, "app", "node_modules"), { recursive: true });
    await symlink(
      join(source, "packages", "lib"),
      join(source, "app", "node_modules", "lib"),
      "dir"
    );
    await mkdir(join(worktree, "app"), { recursive: true });
    await mkdir(join(worktree, "packages", "lib"), { recursive: true });

    await prepareWorktreeDependencies({ sourceRoot: source, worktreePath: worktree });

    expect(await readlink(join(worktree, "app", "node_modules", "lib"))).toBe(
      join(worktree, "packages", "lib")
    );
  });

  it("links .bin shims per entry so a workspace bin stays in the worktree", async () => {
    await write(join(source, "packages", "lib", "cli.js"), "#!/usr/bin/env node\n");
    await write(
      join(source, "app", "node_modules", "vitest", "vitest.mjs"),
      "// runner\n"
    );
    await mkdir(join(source, "app", "node_modules", ".bin"), { recursive: true });
    await symlink(
      "../vitest/vitest.mjs",
      join(source, "app", "node_modules", ".bin", "vitest")
    );
    await symlink(
      join(source, "packages", "lib", "cli.js"),
      join(source, "app", "node_modules", ".bin", "lib")
    );
    await mkdir(join(worktree, "app"), { recursive: true });
    await mkdir(join(worktree, "packages", "lib"), { recursive: true });

    await prepareWorktreeDependencies({ sourceRoot: source, worktreePath: worktree });

    const bin = join(worktree, "app", "node_modules", ".bin");
    expect((await lstat(bin)).isDirectory()).toBe(true);
    expect(await readlink(join(bin, "vitest"))).toBe(
      join(source, "app", "node_modules", "vitest", "vitest.mjs")
    );
    expect(await readlink(join(bin, "lib"))).toBe(
      join(worktree, "packages", "lib", "cli.js")
    );
  });

  it("leaves per-install caches and the npm ledger out of the worktree", async () => {
    await write(join(source, "app", "node_modules", ".package-lock.json"), "{}\n");
    await write(join(source, "app", "node_modules", ".vite", "deps", "x.js"), "//\n");
    await write(join(source, "app", "node_modules", "ok", "index.js"), "//\n");
    await mkdir(join(worktree, "app"), { recursive: true });

    await prepareWorktreeDependencies({ sourceRoot: source, worktreePath: worktree });

    const modules = join(worktree, "app", "node_modules");
    expect(existsSync(join(modules, "ok"))).toBe(true);
    // Sharing these would let the worktree's tooling write back into the
    // operator's checkout.
    expect(existsSync(join(modules, ".package-lock.json"))).toBe(false);
    expect(existsSync(join(modules, ".vite"))).toBe(false);
  });

  it("is idempotent: re-points a stale link, never clobbers worker content", async () => {
    await write(join(source, "app", "node_modules", "dep", "index.js"), "//\n");
    await write(join(source, "app", "node_modules", "own", "index.js"), "//\n");
    const modules = join(worktree, "app", "node_modules");
    await mkdir(modules, { recursive: true });
    await symlink("/nowhere/stale", join(modules, "dep"));
    await write(join(modules, "own", "index.js"), "// the worker's own copy\n");

    const first = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });
    const second = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(first.problems).toEqual([]);
    expect(second).toEqual(first);
    expect(await readlink(join(modules, "dep"))).toBe(
      join(source, "app", "node_modules", "dep")
    );
    // A real directory is something the worktree owns; the mirror defers to it.
    expect((await lstat(join(modules, "own"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(modules, "own", "index.js"), "utf8")).toBe(
      "// the worker's own copy\n"
    );
  });

  it("skips a package the worktree's commit does not have", async () => {
    await write(join(source, "app", "node_modules", "dep", "index.js"), "//\n");

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(prepared.links).toEqual([]);
    expect(prepared.problems).toEqual([]);
    expect(existsSync(join(worktree, "app"))).toBe(false);
  });

  it("is a clean no-op for a repo with nothing installed", async () => {
    await write(join(source, "main.py"), "print(1)\n");

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(prepared).toMatchObject({ links: [], problems: [] });
    expect(summarizeWorktreePreparation(prepared)).toBe(
      "no installed dependencies to mirror"
    );
  });

  it("does not mark a tree whose repository would report the marker as a change", async () => {
    // No git repo here at all, so nothing can prove `.muon/` is ignored.
    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(prepared.problems).toEqual([]);
    expect(existsSync(join(worktree, ".muon"))).toBe(false);
  });

  it("reports a problem instead of leaving a half-linked tree", async () => {
    await write(join(source, "app", "node_modules", "dep", "index.js"), "//\n");
    // The worktree already has a FILE where its installed tree must go.
    await write(join(worktree, "app", "node_modules"), "not a directory\n");

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: worktree,
    });

    expect(prepared.links).toEqual([]);
    expect(prepared.problems).toHaveLength(1);
    expect(prepared.problems[0]).toContain("'app' could not be linked");
  });

  it("prepares nothing when asked to prepare the primary checkout itself", async () => {
    await write(join(source, "app", "node_modules", "dep", "index.js"), "//\n");

    const prepared = await prepareWorktreeDependencies({
      sourceRoot: source,
      worktreePath: source,
    });

    expect(prepared).toEqual({ links: [], problems: [] });
  });
});

// ── The declared entry point must exist, or nothing resolves ──────────────────
//
// `@muon/protocol` resolves through `"main": "dist/index.js"`, and `dist/` is
// gitignored — a fresh worktree has none, so the links alone still resolve to a
// path that does not exist. These tests pin that the mirror is a COPY (a link
// would send an in-worktree rebuild into the operator's tree) and that it only
// ever lands on git-ignored, absent paths.

describe("ensureTaskWorktree preparation", () => {
  let repoRoot: string;
  let worktreeStorage: string;
  const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;

  beforeEach(async () => {
    worktreeStorage = await mkdtemp(join(tmpdir(), "muon-prep-worktrees-"));
    process.env.MUON_WORKTREE_ROOT = worktreeStorage;
    repoRoot = await realpath(await mkdtemp(join(tmpdir(), "muon-prep-repo-")));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
  });

  afterEach(async () => {
    if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
    else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
    await rm(worktreeStorage, { recursive: true, force: true }).catch(() => {});
    await rm(repoRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }).catch(() => {});
  });

  async function commitPackageRepo() {
    await write(
      join(repoRoot, ".gitignore"),
      "node_modules/\n/packages/*/dist/\n.muon/\n"
    );
    await write(
      join(repoRoot, "packages", "lib", "package.json"),
      JSON.stringify({ name: "lib", main: "dist/index.js" })
    );
    await write(join(repoRoot, "packages", "lib", "src", "index.ts"), "export {};\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "initial commit");
    // The installed + built state the operator's checkout is actually in.
    await write(
      join(repoRoot, "packages", "lib", "dist", "index.js"),
      "module.exports = 'from the checkout';\n"
    );
    await write(
      join(repoRoot, "packages", "lib", "node_modules", "dep", "index.js"),
      "//\n"
    );
  }

  it("mirrors a gitignored build output as a copy and leaves git status clean", async () => {
    await commitPackageRepo();

    const created = await ensureTaskWorktree({ repoRoot, taskId: "prep-1" });

    const mirrored = join(created.path, "packages", "lib", "dist", "index.js");
    expect(created.preparation.links).toEqual([
      { packageDir: join("packages", "lib"), shared: 1, workspace: 0, mirroredOutputs: ["dist"] },
    ]);
    // A COPY, not a link: rebuilding here must never reach the operator's tree.
    expect(
      (await lstat(join(created.path, "packages", "lib", "dist"))).isSymbolicLink()
    ).toBe(false);
    await writeFile(mirrored, "module.exports = 'rebuilt in the worktree';\n");
    expect(
      await readFile(join(repoRoot, "packages", "lib", "dist", "index.js"), "utf8")
    ).toBe("module.exports = 'from the checkout';\n");

    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: created.path,
    });
    expect(stdout.trim()).toBe("");
  });

  it("never mirrors an output path git would report as a change", async () => {
    await write(join(repoRoot, ".gitignore"), "node_modules/\n");
    await write(
      join(repoRoot, "packages", "lib", "package.json"),
      JSON.stringify({ name: "lib", main: "dist/index.js" })
    );
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "initial commit");
    await write(join(repoRoot, "packages", "lib", "dist", "index.js"), "//\n");
    await write(
      join(repoRoot, "packages", "lib", "node_modules", "dep", "index.js"),
      "//\n"
    );

    const created = await ensureTaskWorktree({ repoRoot, taskId: "prep-2" });

    expect(created.preparation.links[0]?.mirroredOutputs).toEqual([]);
    expect(existsSync(join(created.path, "packages", "lib", "dist"))).toBe(false);
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: created.path,
    });
    expect(stdout.trim()).toBe("");
  });

  // ── A worktree is a full repo copy OUTSIDE the primary repo ────────────────
  //
  // Nothing about walking into one announces it, which is how a governed child
  // ended up editing the operator's primary checkout while its own tree stayed
  // pristine. The marker says which tree you are in — but never at the cost of
  // a phantom changed file in the diff a human reviews.
  it("marks the tree as isolated, naming both roots, without dirtying git", async () => {
    await commitPackageRepo();

    const created = await ensureTaskWorktree({ repoRoot, taskId: "prep-mark" });

    const marker = await readFile(
      join(created.path, ".muon", "WORKTREE.md"),
      "utf8"
    );
    expect(marker).toContain("not the primary checkout");
    expect(marker).toContain(created.path);
    expect(marker).toContain(repoRoot);
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: created.path,
    });
    expect(stdout.trim()).toBe("");
  });

  it("prepares the REUSED worktree too, so an older tree is repaired", async () => {
    await commitPackageRepo();
    const created = await ensureTaskWorktree({ repoRoot, taskId: "prep-3" });
    await rm(join(created.path, "packages", "lib", "node_modules"), {
      recursive: true,
      force: true,
    });

    const reused = await ensureTaskWorktree({ repoRoot, taskId: "prep-3" });

    expect(reused.created).toBe(false);
    expect(
      existsSync(join(created.path, "packages", "lib", "node_modules", "dep"))
    ).toBe(true);
    expect(reused.preparation.problems).toEqual([]);
  });

  it("fails closed with a reason rather than handing over a broken tree", async () => {
    // A tracked FILE named node_modules: preparation cannot build the tree
    // there, and must say so before a worker is dispatched into it.
    await write(join(repoRoot, "node_modules"), "not a directory\n");
    await git(repoRoot, "add", "-f", "node_modules");
    await git(repoRoot, "commit", "-m", "initial commit");

    await expect(
      ensureTaskWorktree({ repoRoot, taskId: "prep-4" })
    ).rejects.toThrow(/this worktree is not test-capable/);
  });
});
