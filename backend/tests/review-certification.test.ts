import { describe, expect, it } from "vitest";
import {
  collectWorktreeReviewState,
  certifyWorktreeReviewCoverage,
  type ReviewCertificationDependencies,
} from "../src/lib/review-certification.js";

function dependencies(
  overrides: Partial<ReviewCertificationDependencies> = {}
): ReviewCertificationDependencies {
  return {
    reviewState: async () => ({
      changedFiles: ["src/a.ts"],
      baselineCommit: "abc1234",
      repoHead: "abc1234",
      artifactDigest: "a".repeat(64),
    }),
    readMeta: async () => ({
      lastCommit: "abc1234",
      fileHashes: { "src/a.ts": "hash-a" },
    }),
    ...overrides,
  };
}

describe("merge review coverage certification", () => {
  it("includes committed, working-tree, and untracked changes from the merge-base", async () => {
    const calls: string[] = [];
    const output = new Map([
      ["/repo rev-parse HEAD", "base-head"],
      ["/worktree rev-parse HEAD", "worker-head"],
      ["/worktree merge-base base-head worker-head", "merge-base"],
      [
        "/worktree diff --name-only -z merge-base --",
        "src/committed.ts\0src/working.ts\0",
      ],
      [
        "/worktree ls-files --others --exclude-standard -z",
        "src/untracked.ts\0",
      ],
    ]);
    const state = await collectWorktreeReviewState(
      { repoRoot: "/repo", worktreePath: "/worktree" },
      async (cwd, args) => {
        const key = `${cwd} ${args.join(" ")}`;
        calls.push(key);
        return output.get(key) ?? "";
      },
      async (_worktreePath, relativePath) => ({
        kind: "file",
        content: Buffer.from(`contents:${relativePath}`),
        executable: false,
      })
    );
    expect(calls).toHaveLength(5);
    expect(state).toMatchObject({
      baselineCommit: "merge-base",
      repoHead: "base-head",
      changedFiles: [
        "src/committed.ts",
        "src/untracked.ts",
        "src/working.ts",
      ],
    });
    expect(state.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("certifies a fresh worktree whose changed paths are indexed", async () => {
    await expect(
      certifyWorktreeReviewCoverage(
        { repoRoot: "/repo", worktreePath: "/repo/.muon/worktrees/task" },
        dependencies()
      )
    ).resolves.toMatchObject({
      status: "certified",
      changedFiles: ["src/a.ts"],
    });
  });

  it("binds the digest to exact file contents, type, mode, path, and baseline", async () => {
    const outputs = new Map([
      ["/repo rev-parse HEAD", "base-head"],
      ["/worktree rev-parse HEAD", "worker-head"],
      ["/worktree merge-base base-head worker-head", "merge-base"],
      ["/worktree diff --name-only -z merge-base --", "src/a.ts\0"],
      ["/worktree ls-files --others --exclude-standard -z", ""],
    ]);
    const git = async (cwd: string, args: string[]) =>
      outputs.get(`${cwd} ${args.join(" ")}`) ?? "";
    const first = await collectWorktreeReviewState(
      { repoRoot: "/repo", worktreePath: "/worktree" },
      git,
      async () => ({
        kind: "file",
        content: Buffer.from("first"),
        executable: false,
      })
    );
    const second = await collectWorktreeReviewState(
      { repoRoot: "/repo", worktreePath: "/worktree" },
      git,
      async () => ({
        kind: "file",
        content: Buffer.from("second"),
        executable: false,
      })
    );
    expect(first.artifactDigest).not.toBe(second.artifactDigest);
  });

  it("fails closed when the index commit is stale", async () => {
    const result = await certifyWorktreeReviewCoverage(
      { repoRoot: "/repo", worktreePath: "/repo/.muon/worktrees/task" },
      dependencies({
        readMeta: async () => ({
          lastCommit: "def5678",
          fileHashes: { "src/a.ts": "hash-a" },
        }),
      })
    );
    expect(result).toMatchObject({ status: "blocked" });
    expect(result).toMatchObject({ blockCode: "stale" });
    expect(result.reason).toMatch(/stale/i);
  });

  it("fails closed when the primary checkout advanced beyond the reviewed worktree baseline", async () => {
    const result = await certifyWorktreeReviewCoverage(
      { repoRoot: "/repo", worktreePath: "/repo/.muon/worktrees/task" },
      dependencies({
        reviewState: async () => ({
          changedFiles: ["src/a.ts"],
          baselineCommit: "abc1234",
          repoHead: "def5678",
          artifactDigest: "c".repeat(64),
        }),
      })
    );
    expect(result).toMatchObject({
      status: "blocked",
      blockCode: "stale",
      baselineCommit: "abc1234",
      headCommit: "def5678",
    });
  });

  it("fails closed on new or otherwise unindexed changed files", async () => {
    const result = await certifyWorktreeReviewCoverage(
      { repoRoot: "/repo", worktreePath: "/repo/.muon/worktrees/task" },
      dependencies({
        reviewState: async () => ({
          changedFiles: ["src/a.ts", "src/new.ts"],
          baselineCommit: "abc1234",
          repoHead: "abc1234",
          artifactDigest: "b".repeat(64),
        }),
      })
    );
    expect(result).toMatchObject({
      status: "blocked",
      blindFiles: ["src/new.ts"],
    });
    expect(result.reason).toMatch(/REVIEW BLIND/);
  });

  it("fails closed when GitNexus evidence cannot be read", async () => {
    const result = await certifyWorktreeReviewCoverage(
      { repoRoot: "/repo", worktreePath: "/repo/.muon/worktrees/task" },
      dependencies({
        readMeta: async () => {
          throw new Error("missing meta");
        },
      })
    );
    expect(result).toMatchObject({ status: "blocked" });
    expect(result).toMatchObject({ blockCode: "unavailable" });
    expect(result.reason).toMatch(/unavailable/i);
  });
});
