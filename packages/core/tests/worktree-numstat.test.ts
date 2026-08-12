import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeNumstat } from "../src/worktree.js";

// Live-git proof of per-file +/- counts: real `git diff --numstat HEAD` with
// the intent-to-add-then-rollback discipline so untracked files count without
// mutating the worktree.
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

let repo: string | null = null;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
  repo = null;
});

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muon-numstat-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "t@muon.test");
  await git(dir, "config", "user.name", "muon test");
  await writeFile(join(dir, "app.ts"), "a\nb\nc\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "base", "--no-verify");
  return dir;
}

describe("worktreeNumstat — live git", () => {
  it("reports per-file additions/deletions for a modified tracked file", async () => {
    repo = await initRepo();
    // b -> B, and append d,e: 3 additions (B, d, e), 1 deletion (b).
    await writeFile(join(repo, "app.ts"), "a\nB\nc\nd\ne\n");

    const stats = await worktreeNumstat(repo);
    const app = stats.find((s) => s.path === "app.ts");
    expect(app).toBeDefined();
    expect(app!.additions).toBe(3);
    expect(app!.deletions).toBe(1);
    expect(app!.binary).toBe(false);
  });

  it("counts an untracked new file (intent-to-add) and leaves it untracked", async () => {
    repo = await initRepo();
    await writeFile(join(repo, "new.ts"), "x\ny\n");

    const stats = await worktreeNumstat(repo);
    const created = stats.find((s) => s.path === "new.ts");
    expect(created).toBeDefined();
    expect(created!.additions).toBe(2);
    expect(created!.deletions).toBe(0);

    // The rollback left the file UNTRACKED (not staged) — worktree unchanged.
    const status = (await git(repo, "status", "--porcelain")).stdout;
    expect(status).toContain("?? new.ts");
  });

  it("flags a binary file (git emits -\\t-) as binary with zero counts", async () => {
    repo = await initRepo();
    // A NUL byte makes git treat the file as binary.
    await writeFile(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));

    const stats = await worktreeNumstat(repo);
    const bin = stats.find((s) => s.path === "blob.bin");
    expect(bin).toBeDefined();
    expect(bin!.binary).toBe(true);
    expect(bin!.additions).toBe(0);
    expect(bin!.deletions).toBe(0);
  });

  it("is empty for a clean worktree", async () => {
    repo = await initRepo();
    expect(await worktreeNumstat(repo)).toEqual([]);
  });

  it("preserves a literal '=>' in a non-rename filename (joins to the file list)", async () => {
    repo = await initRepo();
    // A valid filename containing '=>' is NOT a rename; git emits it unquoted,
    // so the numstat path must match what `git diff --name-only` reports.
    await writeFile(join(repo, "weird=>name.txt"), "x\n");
    const stats = await worktreeNumstat(repo);
    const f = stats.find((s) => s.path === "weird=>name.txt");
    expect(f).toBeDefined();
    expect(f!.additions).toBe(1);
  });
});
