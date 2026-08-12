import { describe, expect, it, vi } from "vitest";
import {
  mergeTaskWorktree,
  verifyDurableWorktreeArtifact,
  verifyDurableWorktreeMerge,
  type MergeGitRunner,
} from "../src/worktree.js";

const base = {
  repoRoot: "/repo",
  worktreePath: "/repo/.wt/task-1",
  message: "merge task-1",
  expectedBase: { ref: "refs/heads/main", head: "ba5e1234" },
};

function baseCoordinate(cwd: string, key: string): string | undefined {
  if (cwd !== "/repo") return undefined;
  if (key === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
  if (key === "rev-parse HEAD") return "ba5e1234\n";
  if (key === "rev-parse --verify refs/heads/main") return "ba5e1234\n";
  return undefined;
}

describe("mergeTaskWorktree — the fail-safe governed merge executor", () => {
  it("commits worktree changes and merges them into a clean base", async () => {
    const calls: string[][] = [];
    let repoHead = "ba5e1234";
    // Precise per-cwd control:
    const gitByCwd: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      if (cwd === "/repo" && key === "symbolic-ref --quiet HEAD") {
        return "refs/heads/main\n";
      }
      if (cwd === "/repo" && key === "rev-parse HEAD") {
        return `${repoHead}\n`;
      }
      if (
        cwd === "/repo" &&
        key === "rev-parse --verify refs/heads/main"
      ) {
        return `${repoHead}\n`;
      }
      if (key === "status --porcelain") return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key === "merge-base --is-ancestor abc1234 HEAD") {
        throw new Error("not ancestor");
      }
      if (key === "merge --no-ff --no-gpg-sign --no-verify -m merge task-1 abc1234") {
        repoHead = "c0ffee9";
        return "";
      }
      if (key === "merge-base --is-ancestor abc1234 c0ffee9") return "";
      if (key === "rev-list --parents -n 1 c0ffee9") {
        return "c0ffee9 ba5e1234 abc1234\n";
      }
      return ""; // add, commit, merge all succeed
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: gitByCwd });
    expect(result.status).toBe("merged");
    if (result.status !== "merged") return;
    expect(result.sha).toBe("abc1234");
    expect(result.mergeCommit).toBe("c0ffee9");
    expect(result.changedFiles).toBe(1);
    // it committed in the worktree and merged in the repo root
    expect(calls.some(([cwd, a]) => cwd.includes(".wt") && a === "commit")).toBe(true);
    expect(calls.some(([cwd, a, b]) => cwd === "/repo" && a === "merge" && b === "--no-ff")).toBe(true);
  });

  it("REFUSES + aborts on a merge conflict, leaving the base untouched", async () => {
    const calls: string[][] = [];
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key.startsWith("merge-base --is-ancestor")) throw new Error("not ancestor");
      if (key.startsWith("merge --no-ff")) throw new Error("CONFLICT");
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result.status).toBe("conflict");
    // it aborted the merge so the base is clean
    expect(calls.some(([cwd, a, b]) => cwd === "/repo" && a === "merge" && b === "--abort")).toBe(true);
  });

  it("surfaces a failed merge abort as repository corruption", async () => {
    const git: MergeGitRunner = async (cwd, ...args) => {
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key.startsWith("merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      if (key.startsWith("merge --no-ff")) throw new Error("CONFLICT");
      if (key === "merge --abort") throw new Error("MERGE_HEAD stuck");
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/may remain in a merge state/i);
      expect(result.reason).toMatch(/MERGE_HEAD stuck/);
    }
  });

  it("BLOCKS when the primary checkout is dirty (never entangle the human's edits)", async () => {
    const git: MergeGitRunner = async (cwd, ...args) => {
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") return cwd === "/repo" ? " M other.ts\n" : "";
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toMatch(/uncommitted/i);
  });

  it("ignores only untracked MUON storage, not tracked .muon edits", async () => {
    const git: MergeGitRunner = async (cwd, ...args) => {
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain" && cwd === "/repo") {
        return "?? .muon/worktrees/\n M .muon/policy.json\n";
      }
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result).toMatchObject({ status: "blocked" });
    if (result.status === "blocked") {
      expect(result.reason).toMatch(/uncommitted/i);
    }
  });

  it("blocks before mutating the base when final captured-artifact verification fails", async () => {
    const calls: string[][] = [];
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "captured123\n";
      if (key.startsWith("merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      return "";
    };
    const result = await mergeTaskWorktree({
      ...base,
      gitRun: git,
      verifyCapturedArtifact: async ({ worktreeHead }) => {
        expect(worktreeHead).toBe("captured123");
        return { ok: false, reason: "artifact digest changed" };
      },
    });
    expect(result).toEqual({
      status: "blocked",
      reason: "artifact digest changed",
    });
    expect(
      calls.some(
        ([cwd, action]) => cwd === "/repo" && action === "merge"
      )
    ).toBe(false);
  });

  it("no-op when the worktree has no changes beyond the base", async () => {
    const verifyCapturedArtifact = vi.fn(async () => ({ ok: true as const }));
    const git: MergeGitRunner = async (_cwd, ...args) => {
      const cwd = _cwd;
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") return ""; // both clean
      if (key === "rev-parse HEAD") return "sameHEAD\n";
      if (key.startsWith("merge-base --is-ancestor")) return ""; // IS an ancestor (exit 0)
      return "";
    };
    const result = await mergeTaskWorktree({
      ...base,
      gitRun: git,
      verifyCapturedArtifact,
    });
    expect(result.status).toBe("no-op");
    expect(verifyCapturedArtifact).toHaveBeenCalledOnce();
  });

  it("blocks if the reviewed base advances after final artifact verification", async () => {
    const calls: string[][] = [];
    let repoHeadReads = 0;
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      if (cwd === "/repo" && key === "symbolic-ref --quiet HEAD") {
        return "refs/heads/main\n";
      }
      if (cwd === "/repo" && key === "rev-parse HEAD") {
        repoHeadReads += 1;
        return repoHeadReads === 1 ? "ba5e1234\n" : "feed999\n";
      }
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "ca97ed123\n";
      if (key.startsWith("merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      return "";
    };
    const result = await mergeTaskWorktree({
      ...base,
      gitRun: git,
      verifyCapturedArtifact: async () => ({ ok: true }),
    });
    expect(result).toEqual({
      status: "blocked",
      reason:
        "The primary branch changed during final merge verification. No reviewed artifact was merged.",
    });
    expect(
      calls.some(([cwd, action]) => cwd === "/repo" && action === "merge")
    ).toBe(false);
  });

  it("does not mutate when the final attempt lease checkpoint is stale", async () => {
    const calls: string[][] = [];
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key.startsWith("merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      return "";
    };
    const result = await mergeTaskWorktree({
      ...base,
      gitRun: git,
      verifyCapturedArtifact: async () => ({ ok: true }),
      beforeBaseMutation: async () => {
        throw new Error("attempt lease expired");
      },
    });
    expect(result).toEqual({
      status: "failed",
      reason: "attempt lease expired",
    });
    expect(calls.some(([, action]) => action === "merge")).toBe(false);
  });

  it("does not merge when the reviewed ref compare-and-swap loses", async () => {
    const calls: string[][] = [];
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      const coordinate = baseCoordinate(cwd, key);
      if (coordinate !== undefined) return coordinate;
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key.startsWith("merge-base --is-ancestor")) {
        throw new Error("not ancestor");
      }
      if (key.startsWith("update-ref refs/heads/main")) {
        throw new Error("cannot lock ref: expected ba5e1234");
      }
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/cannot lock ref/);
    }
    expect(calls.some(([, action]) => action === "merge")).toBe(false);
  });

  it("rolls back only its merge commit when the ref advances after preflight CAS", async () => {
    const calls: string[][] = [];
    let repoHead = "ba5e1234";
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      if (cwd === "/repo" && key === "symbolic-ref --quiet HEAD") {
        return "refs/heads/main\n";
      }
      if (cwd === "/repo" && key === "rev-parse HEAD") {
        return `${repoHead}\n`;
      }
      if (
        cwd === "/repo" &&
        key === "rev-parse --verify refs/heads/main"
      ) {
        return `${repoHead}\n`;
      }
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key === "merge-base --is-ancestor abc1234 HEAD") {
        throw new Error("not ancestor");
      }
      if (key.startsWith("merge --no-ff")) {
        repoHead = "c0ffee9";
        return "";
      }
      if (key === "rev-list --parents -n 1 c0ffee9") {
        return "c0ffee9 dead999 abc1234\n";
      }
      if (key === "update-ref refs/heads/main dead999 c0ffee9") {
        repoHead = "dead999";
        return "";
      }
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result).toEqual({
      status: "blocked",
      reason:
        "The primary ref changed immediately before merge. MUON rolled back only the exact unintended merge ref and preserved the concurrent commit; refresh the primary checkout before retrying.",
    });
    expect(repoHead).toBe("dead999");
    expect(calls).toContainEqual([
      "/repo",
      "update-ref",
      "refs/heads/main",
      "dead999",
      "c0ffee9",
    ]);
    expect(calls.some(([, action]) => action === "reset")).toBe(false);
  });

  it("postchecks the expected ref and never rolls back a concurrently checked-out branch", async () => {
    const calls: string[][] = [];
    let ambientRef = "refs/heads/main";
    let mainHead = "ba5e1234";
    const otherHead = "other999";
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      if (cwd === "/repo" && key === "symbolic-ref --quiet HEAD") {
        return `${ambientRef}\n`;
      }
      if (cwd === "/repo" && key === "rev-parse HEAD") {
        return `${ambientRef === "refs/heads/main" ? mainHead : otherHead}\n`;
      }
      if (key === "rev-parse --verify refs/heads/main") {
        return `${mainHead}\n`;
      }
      if (key === "status --porcelain") {
        return cwd.includes(".wt") ? " M src/a.ts\n" : "";
      }
      if (key === "rev-parse HEAD") return "abc1234\n";
      if (key === "merge-base --is-ancestor abc1234 HEAD") {
        throw new Error("not ancestor");
      }
      if (key.startsWith("merge --no-ff")) {
        mainHead = "mainmerge7";
        ambientRef = "refs/heads/other";
        return "";
      }
      if (key === "rev-list --parents -n 1 mainmerge7") {
        return "mainmerge7 ba5e1234 abc1234\n";
      }
      if (
        key === "merge-base --is-ancestor abc1234 mainmerge7" ||
        key === "merge-base --is-ancestor mainmerge7 mainmerge7"
      ) {
        return "";
      }
      return "";
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result).toMatchObject({
      status: "merged",
      sha: "abc1234",
      mergeCommit: "mainmerge7",
    });
    expect(
      calls.some(
        ([, action, ref]) =>
          action === "update-ref" && ref === "refs/heads/other"
      )
    ).toBe(false);
  });

  it("recovers a captured reviewed commit already landed before the DB finalized", async () => {
    const calls: string[][] = [];
    const git: MergeGitRunner = async (cwd, ...args) => {
      calls.push([cwd, ...args]);
      const key = args.join(" ");
      if (cwd === "/repo" && key === "symbolic-ref --quiet HEAD") {
        return "refs/heads/main\n";
      }
      if (cwd === "/repo" && key === "rev-parse HEAD") {
        return "abc9999\n";
      }
      if (cwd.includes(".wt") && key === "rev-parse HEAD") {
        return "ca97ed123\n";
      }
      if (key === "rev-parse --verify refs/heads/main") {
        return "abc9999\n";
      }
      if (
        key ===
        "rev-list --parents --merges --ancestry-path ba5e1234..abc9999"
      ) {
        return "abc9999 ba5e1234 ca97ed123\n";
      }
      if (key === "rev-list --parents -n 1 abc9999") {
        return "abc9999 ba5e1234 ca97ed123\n";
      }
      return "";
    };
    const result = await mergeTaskWorktree({
      ...base,
      gitRun: git,
      expectedWorktreeHead: "ca97ed123",
    });
    expect(result).toEqual({
      status: "merged",
      sha: "ca97ed123",
      message: "merge task-1",
      changedFiles: 0,
      recovered: true,
      mergeCommit: "abc9999",
    });
    expect(calls.some(([, action]) => action === "merge")).toBe(false);
  });

  it("verifies a stored exact merge commit against its ref and clean governed worktree", async () => {
    const git: MergeGitRunner = async (cwd, ...args) => {
      const key = args.join(" ");
      if (cwd.includes(".wt") && key === "rev-parse HEAD") {
        return "ca97ed123\n";
      }
      if (cwd.includes(".wt") && key === "status --porcelain") return "";
      if (key === "rev-parse --verify refs/heads/main") return "later777\n";
      if (key === "rev-list --parents -n 1 merge555") {
        return "merge555 ba5e1234 ca97ed123\n";
      }
      if (key === "merge-base --is-ancestor merge555 later777") return "";
      throw new Error(`unexpected git call: ${cwd} ${key}`);
    };
    await expect(
      verifyDurableWorktreeMerge({
        repoRoot: base.repoRoot,
        worktreePath: base.worktreePath,
        expectedBase: base.expectedBase,
        verifiedWorktreeHead: "ca97ed123",
        mergeCommit: "merge555",
        gitRun: git,
      })
    ).resolves.toEqual({
      ok: true,
      mergeCommit: "merge555",
      currentRefHead: "later777",
    });
  });

  it("rejects a stored merge outcome when its governed worktree is dirty", async () => {
    const git: MergeGitRunner = async (cwd, ...args) => {
      const key = args.join(" ");
      if (cwd.includes(".wt") && key === "rev-parse HEAD") {
        return "ca97ed123\n";
      }
      if (cwd.includes(".wt") && key === "status --porcelain") {
        return " M src/after-review.ts\n";
      }
      if (key === "rev-parse --verify refs/heads/main") return "merge555\n";
      if (key === "rev-list --parents -n 1 merge555") {
        return "merge555 ba5e1234 ca97ed123\n";
      }
      return "";
    };
    const result = await verifyDurableWorktreeMerge({
      repoRoot: base.repoRoot,
      worktreePath: base.worktreePath,
      expectedBase: base.expectedBase,
      verifiedWorktreeHead: "ca97ed123",
      mergeCommit: "merge555",
      gitRun: git,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/uncommitted changes/i);
  });

  it("rejects a durable no-op artifact when the clean worktree HEAD drifted", async () => {
    let headReads = 0;
    const git: MergeGitRunner = async (_cwd, ...args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") {
        headReads += 1;
        return headReads === 1 ? "ca97ed123\n" : "different456\n";
      }
      if (key === "status --porcelain") return "";
      throw new Error(`unexpected git call: ${key}`);
    };

    const result = await verifyDurableWorktreeArtifact({
      worktreePath: base.worktreePath,
      verifiedWorktreeHead: "ca97ed123",
      gitRun: git,
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/HEAD no longer matches/i);
  });

  it("accepts a durable no-op artifact only at its exact clean worktree HEAD", async () => {
    const git: MergeGitRunner = async (_cwd, ...args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return "ca97ed123\n";
      if (key === "status --porcelain") return "";
      throw new Error(`unexpected git call: ${key}`);
    };

    await expect(
      verifyDurableWorktreeArtifact({
        worktreePath: base.worktreePath,
        verifiedWorktreeHead: "ca97ed123",
        gitRun: git,
      })
    ).resolves.toEqual({
      ok: true,
      currentWorktreeHead: "ca97ed123",
    });
  });

  it("fails safe (never throws) on an unexpected git error", async () => {
    const git: MergeGitRunner = async () => {
      throw new Error("git exploded");
    };
    const result = await mergeTaskWorktree({ ...base, gitRun: git });
    expect(result.status).toBe("failed");
  });
});
