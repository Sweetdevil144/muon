import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskWorktreePath } from "@muon/core";
import { attestGovernedWorkspace } from "../src/execute.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });
const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;

describe("governed external worktree attestation — live git", () => {
  let repo: string;
  let storage: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "muon-attest-repo-")));
    storage = await realpath(
      await mkdtemp(join(tmpdir(), "muon-attest-worktrees-"))
    );
    process.env.MUON_WORKTREE_ROOT = storage;
    await git(repo, "init", "--initial-branch=main");
    await git(repo, "config", "user.email", "tests@muon.local");
    await git(repo, "config", "user.name", "MUON Tests");
    await writeFile(join(repo, "app.ts"), "export const value = 1;\n");
    await git(repo, "add", "app.ts");
    await git(repo, "commit", "-m", "seed");
  });

  afterEach(async () => {
    if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
    else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
    await rm(storage, { recursive: true, force: true }).catch(() => {});
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it("accepts only the exact task tree outside the repository", async () => {
    const own = taskWorktreePath(repo, "task-1");
    const sibling = taskWorktreePath(repo, "task-2");
    await mkdir(dirname(own), { recursive: true });
    await git(repo, "worktree", "add", "--detach", own);
    await git(repo, "worktree", "add", "--detach", sibling);

    expect(own.startsWith(`${repo}/`)).toBe(false);
    expect(
      attestGovernedWorkspace({
        rootWorkspace: repo,
        workspacePath: repo,
        executionCwd: own,
        managedTaskId: "task-1",
      })
    ).toBeNull();
    expect(
      attestGovernedWorkspace({
        rootWorkspace: repo,
        workspacePath: repo,
        executionCwd: sibling,
        managedTaskId: "task-1",
      })
    ).toMatch(/outside the canonical workspace boundary/);
  });
});
