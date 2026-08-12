import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWorktreeEvidence } from "../src/handoff-evidence.js";
import { ensureTaskWorktree, worktreeDiff } from "../src/worktree.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await run("git", args, { cwd });
}

const EMPTY_SHA256 = `sha256:${createHash("sha256").digest("hex")}`;

describe("collectWorktreeEvidence", () => {
  let repoRoot: string;
  let worktreeStorage: string;
  const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;

  beforeEach(async () => {
    worktreeStorage = await mkdtemp(join(tmpdir(), "muon-evidence-worktrees-"));
    process.env.MUON_WORKTREE_ROOT = worktreeStorage;
    repoRoot = await mkdtemp(join(tmpdir(), "muon-handoff-evidence-test-"));
    await git(repoRoot, "init", "--initial-branch=main");
    await git(repoRoot, "config", "user.email", "test@example.com");
    await git(repoRoot, "config", "user.name", "Muon Test");
    await writeFile(join(repoRoot, "hello.txt"), "hello\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-m", "initial commit");
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

  it("refuses to hash the primary checkout and reports it honestly", async () => {
    const evidence = await collectWorktreeEvidence(repoRoot);

    expect(evidence.diff).toEqual({
      unavailableReason: "workspace_not_worktree",
    });
    expect(evidence.changedFiles).toBeUndefined();
  });

  it("hashes the full diff stream of a linked worktree and lists changed files", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "evidence-diff",
    });
    await writeFile(join(linked.path, "hello.txt"), "changed by lane\n");
    await writeFile(join(linked.path, "fresh.ts"), "export const x = 1;\n");

    const full = await worktreeDiff(linked.path, { maxBytes: 10_000_000 });
    expect(full.truncated).toBe(false);
    const expectedHash = `sha256:${createHash("sha256")
      .update(Buffer.from(full.text, "utf8"))
      .digest("hex")}`;

    const evidence = await collectWorktreeEvidence(linked.path);

    expect(evidence.diff).toEqual({
      hash: expectedHash,
      totalBytes: full.totalBytes,
    });
    expect(evidence.changedFiles).toEqual(["fresh.ts", "hello.txt"]);
  });

  it("verifies the empty diff of an untouched worktree", async () => {
    const linked = await ensureTaskWorktree({
      repoRoot,
      taskId: "evidence-empty",
    });

    const evidence = await collectWorktreeEvidence(linked.path);

    expect(evidence.diff).toEqual({ hash: EMPTY_SHA256, totalBytes: 0 });
    expect(evidence.changedFiles).toEqual([]);
  });
});
