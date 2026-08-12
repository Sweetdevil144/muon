import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureMergeBaseTarget,
  ensureTaskWorktree,
  mergeTaskWorktree,
  taskWorktreePath,
  verifyDurableWorktreeArtifact,
} from "../src/worktree.js";

// A REAL-git integration proof that the governed loop closes: a change made in a
// task worktree actually lands on the primary checkout via mergeTaskWorktree.
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

let repo: string | null = null;
let worktreeStorage: string | null = null;
const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;
beforeEach(async () => {
  worktreeStorage = await mkdtemp(join(tmpdir(), "muon-merge-worktrees-"));
  process.env.MUON_WORKTREE_ROOT = worktreeStorage;
});
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
  if (worktreeStorage) {
    await rm(worktreeStorage, { recursive: true, force: true }).catch(() => {});
  }
  if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
  else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
  repo = null;
  worktreeStorage = null;
});

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muon-merge-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "t@muon.test");
  await git(dir, "config", "user.name", "muon test");
  await writeFile(join(dir, "app.ts"), "export const v = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "base", "--no-verify");
  return dir;
}

describe("mergeTaskWorktree — live git", () => {
  it("lands a worktree edit on the primary checkout", async () => {
    repo = await initRepo();
    const taskId = "task-live-1";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    // The lane edits a file in its worktree.
    await writeFile(join(wt, "app.ts"), "export const v = 2; // changed\n");

    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "MUON: land task-live-1",
      expectedBase: await captureMergeBaseTarget({ repoRoot: repo }),
    });

    expect(result.status).toBe("merged");
    // The change is now on main in the PRIMARY checkout.
    const landed = await readFile(join(repo, "app.ts"), "utf8");
    expect(landed).toContain("v = 2");
    const log = (await git(repo, "log", "--oneline")).stdout;
    expect(log).toContain("land task-live-1");
  });

  it("no-ops when the worktree has no changes", async () => {
    repo = await initRepo();
    const taskId = "task-live-2";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: taskWorktreePath(repo, taskId),
      message: "noop",
      expectedBase: await captureMergeBaseTarget({ repoRoot: repo }),
    });
    expect(result.status).toBe("no-op");
  });

  it("rejects a clean no-op worktree after its exact verified commit changes", async () => {
    repo = await initRepo();
    const taskId = "task-live-noop-drift";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    const verifiedWorktreeHead = (
      await git(wt, "rev-parse", "HEAD")
    ).stdout.trim();

    await git(
      wt,
      "commit",
      "--allow-empty",
      "-m",
      "same tree, different provenance",
      "--no-verify"
    );
    expect((await git(wt, "status", "--porcelain")).stdout).toBe("");

    const verification = await verifyDurableWorktreeArtifact({
      worktreePath: wt,
      verifiedWorktreeHead,
    });

    expect(verification).toMatchObject({ ok: false });
    if (!verification.ok) {
      expect(verification.reason).toMatch(/HEAD no longer matches/i);
    }
  });

  it("BLOCKS (leaves base untouched) when the primary checkout is dirty", async () => {
    repo = await initRepo();
    const taskId = "task-live-3";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    await writeFile(join(taskWorktreePath(repo, taskId), "app.ts"), "export const v = 9;\n");
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    // Dirty the primary checkout.
    await writeFile(join(repo, "app.ts"), "export const v = 1; // human edit\n");

    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: taskWorktreePath(repo, taskId),
      message: "should not land",
      expectedBase,
    });
    expect(result.status).toBe("blocked");
    // The human's edit is intact; nothing was merged over it.
    expect(await readFile(join(repo, "app.ts"), "utf8")).toContain("human edit");
  });

  it("blocks a tracked .muon edit while still ignoring untracked worktree storage", async () => {
    repo = await initRepo();
    await mkdir(join(repo, ".muon"), { recursive: true });
    await writeFile(join(repo, ".muon", "policy.json"), '{"mode":"safe"}\n');
    await git(repo, "add", ".muon/policy.json");
    await git(repo, "commit", "-m", "track MUON policy", "--no-verify");

    const taskId = "task-live-tracked-muon";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    await writeFile(join(wt, "app.ts"), "export const v = 21;\n");
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    await writeFile(join(repo, ".muon", "policy.json"), '{"mode":"human-edit"}\n');

    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "must preserve tracked MUON edit",
      expectedBase,
    });
    expect(result.status).toBe("blocked");
    expect(await readFile(join(repo, ".muon", "policy.json"), "utf8")).toContain(
      "human-edit"
    );
  });

  it("postchecks main after an adversarial branch switch and never rolls back the ambient ref", async () => {
    repo = await initRepo();
    const taskId = "task-live-branch-switch";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    await writeFile(join(wt, "app.ts"), "export const v = 22;\n");
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    let otherMerge = "";

    const gitRun = async (cwd: string, ...args: string[]): Promise<string> => {
      const result = await git(cwd, ...args);
      if (cwd === repo && args[0] === "merge" && args.includes("--no-ff")) {
        await git(repo!, "switch", "other");
      }
      return result.stdout;
    };
    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "MUON: expected-ref postcheck",
      expectedBase,
      gitRun,
      onArtifactCaptured: async ({ worktreeHead }) => {
        const tree = (
          await git(wt, "rev-parse", `${worktreeHead}^{tree}`)
        ).stdout.trim();
        otherMerge = (
          await git(
            repo!,
            "commit-tree",
            tree,
            "-p",
            expectedBase.head,
            "-p",
            worktreeHead,
            "-m",
            "unrelated merge on other"
          )
        ).stdout.trim();
        await git(repo!, "update-ref", "refs/heads/other", otherMerge);
      },
    });

    expect(result).toMatchObject({ status: "merged" });
    expect((await git(repo, "symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe(
      "other"
    );
    expect(
      (await git(repo, "rev-parse", "refs/heads/other")).stdout.trim()
    ).toBe(otherMerge);
    expect(
      (await git(repo, "show", "refs/heads/main:app.ts")).stdout
    ).toContain("v = 22");
  });

  it("blocks live Git when the reviewed primary commit advanced", async () => {
    repo = await initRepo();
    const taskId = "task-live-drift";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    await writeFile(join(wt, "app.ts"), "export const v = 11;\n");
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });

    await writeFile(join(repo, "base.ts"), "export const base = 2;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "human advanced base", "--no-verify");

    const result = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "must not land stale review",
      expectedBase,
    });
    expect(result.status).toBe("blocked");
    expect(await readFile(join(repo, "app.ts"), "utf8")).toContain("v = 1");
  });

  it("recognizes a durably verified commit after merge succeeded before DB finalization", async () => {
    repo = await initRepo();
    const taskId = "task-live-recover";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    await writeFile(join(wt, "app.ts"), "export const v = 12;\n");
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    let verifiedWorktreeHead: string | undefined;

    const first = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "MUON: recovery fixture",
      expectedBase,
      verifyCapturedArtifact: async () => ({ ok: true }),
      onArtifactVerified: async ({ worktreeHead }) => {
        verifiedWorktreeHead = worktreeHead;
      },
    });
    expect(first.status).toBe("merged");
    expect(verifiedWorktreeHead).toMatch(/^[0-9a-f]{40}$/);
    if (first.status !== "merged") return;
    const exactMergeCommit = first.mergeCommit;
    expect(exactMergeCommit).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(repo, "after-merge.ts"), "export const later = true;\n");
    await git(repo, "add", "after-merge.ts");
    await git(repo, "commit", "-m", "later main commit", "--no-verify");
    const laterHead = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    expect(laterHead).not.toBe(exactMergeCommit);

    const recovered = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "MUON: recovery fixture",
      expectedBase,
      expectedWorktreeHead: verifiedWorktreeHead,
    });
    expect(recovered).toMatchObject({
      status: "merged",
      sha: verifiedWorktreeHead,
      recovered: true,
      mergeCommit: exactMergeCommit,
    });
  });

  it("rejects fast-forwarded reviewed work as crash recovery", async () => {
    repo = await initRepo();
    const taskId = "task-live-recover-fast-forward";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    await writeFile(join(wt, "app.ts"), "export const v = 30;\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-m", "reviewed worker", "--no-verify");
    const worktreeHead = (await git(wt, "rev-parse", "HEAD")).stdout.trim();
    await git(repo, "reset", "--hard", worktreeHead);

    const recovered = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "must require exact merge",
      expectedBase,
      expectedWorktreeHead: worktreeHead,
    });
    expect(recovered.status).toBe("blocked");
  });

  it("rejects a cherry-pick of reviewed work as crash recovery", async () => {
    repo = await initRepo();
    const taskId = "task-live-recover-cherry-pick";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    await writeFile(join(wt, "app.ts"), "export const v = 31;\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-m", "reviewed worker", "--no-verify");
    const worktreeHead = (await git(wt, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "human.ts"), "export const human = true;\n");
    await git(repo, "add", "human.ts");
    await git(repo, "commit", "-m", "human base advance", "--no-verify");
    await git(repo, "cherry-pick", worktreeHead);

    const recovered = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "must reject cherry-pick",
      expectedBase,
      expectedWorktreeHead: worktreeHead,
    });
    expect(recovered.status).toBe("blocked");
  });

  it("rejects a merge with the wrong first parent as crash recovery", async () => {
    repo = await initRepo();
    const taskId = "task-live-recover-wrong-parent";
    await ensureTaskWorktree({ repoRoot: repo, taskId });
    const wt = taskWorktreePath(repo, taskId);
    const expectedBase = await captureMergeBaseTarget({ repoRoot: repo });
    await writeFile(join(wt, "app.ts"), "export const v = 32;\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-m", "reviewed worker", "--no-verify");
    const worktreeHead = (await git(wt, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "human.ts"), "export const human = true;\n");
    await git(repo, "add", "human.ts");
    await git(repo, "commit", "-m", "human base advance", "--no-verify");
    await git(
      repo,
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "wrong parent merge",
      worktreeHead
    );

    const recovered = await mergeTaskWorktree({
      repoRoot: repo,
      worktreePath: wt,
      message: "must reject wrong parent",
      expectedBase,
      expectedWorktreeHead: worktreeHead,
    });
    expect(recovered.status).toBe("blocked");
  });
});
