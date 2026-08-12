import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskWorktreeCandidates } from "@muon/core";
import {
  harnessWorktreeProbe,
  resolveJobTree,
  type JobTreeDependencies,
} from "../src/lib/job-tree.js";
import { loadReviewDiff } from "../src/lib/review-diff.js";
import {
  defaultWorkspaceReviewDependencies,
  loadWorkspaceReview,
} from "../src/lib/workspace-review.js";

// A worktree-backed harness (`requires.worktree`) runs its agent in
// `<repoRoot>/.muon/worktrees/<taskId>`, but the dispatch record keeps naming
// the canonical checkout forever. Reading review evidence from the record was
// therefore reading a tree the agent never touched — and an empty diff of the
// wrong tree does not look broken, it looks CLEAN. These tests pin both halves:
// the real tree is found, and a tree that cannot be found is SAID, never
// silently downgraded to the workspace root.

function deps(over: Partial<JobTreeDependencies> = {}): JobTreeDependencies {
  return {
    repoRoot: async () => "/repo",
    exists: () => false,
    requiresWorktree: async () => null,
    ...over,
  };
}

const WORKTREE = path.join("/repo", ".muon", "worktrees", "task-7");
const CURRENT_WORKTREE = taskWorktreeCandidates("/repo", "task-7")[0];

describe("resolveJobTree", () => {
  it("resolves a worktree-backed job to its isolated tree, not the workspace root", async () => {
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "implement",
      },
      deps({
        requiresWorktree: async () => true,
        exists: (target) =>
          target === WORKTREE || target === path.join(WORKTREE, ".git"),
      })
    );

    expect(resolution).toEqual({
      status: "resolved",
      tree: { kind: "worktree", path: WORKTREE, taskId: "task-7" },
    });
  });

  it("says so when the harness ran in a worktree that is no longer on disk", async () => {
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "implement",
      },
      deps({ requiresWorktree: async () => true, exists: () => false })
    );

    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toContain(CURRENT_WORKTREE);
    expect(resolution.reason).toContain("not on disk");
    expect(resolution.action).toMatch(/merged or pruned/i);
  });

  // "Not there yet" and "gone" both mean nothing to diff — but a queued job
  // told the operator its worktree "was pruned" would be a lie on camera.
  it("says a queued dispatch has not made its worktree yet, not that it vanished", async () => {
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "implement",
        status: "queued",
      },
      deps({ requiresWorktree: async () => true, exists: () => false })
    );

    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toContain("still queued");
    expect(resolution.reason).toContain("does not exist yet");
    expect(resolution.reason).not.toMatch(/not on disk now/);
    expect(resolution.action).toMatch(/once the lane starts working/i);
  });

  it("refuses to fall back when the worktree's repo root cannot be resolved", async () => {
    const resolution = await resolveJobTree(
      { taskId: "task-7", workspacePath: "/nowhere", harnessKey: "repair" },
      deps({ requiresWorktree: async () => true, repoRoot: async () => null })
    );

    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toContain("not inside a git repository");
  });

  it("uses the workspace checkout for a harness that declares no worktree", async () => {
    const resolution = await resolveJobTree(
      { taskId: "task-7", workspacePath: "/repo", harnessKey: "review" },
      deps({ requiresWorktree: async () => false })
    );

    expect(resolution).toEqual({
      status: "resolved",
      tree: { kind: "workspace", path: "/repo" },
    });
  });

  // UNKNOWN intent is not "no". An unreadable harness may only be resolved by
  // disk evidence — it must never be able to assert the canonical checkout.
  it("still finds the tree from disk when the harness cannot be read", async () => {
    const resolution = await resolveJobTree(
      { taskId: "task-7", workspacePath: "/repo", harnessKey: "custom" },
      deps({
        requiresWorktree: async () => {
          throw new Error("harness route unavailable");
        },
        exists: (target) =>
          target === WORKTREE || target === path.join(WORKTREE, ".git"),
      })
    );

    expect(resolution).toMatchObject({
      status: "resolved",
      tree: { kind: "worktree", taskId: "task-7" },
    });
  });

  // A half-removed worktree leaves the directory behind. A bare folder is not a
  // checkout git can diff, so it must not be presented as one.
  it("does not treat a leftover directory without .git as the job's tree", async () => {
    const resolution = await resolveJobTree(
      { taskId: "task-7", workspacePath: "/repo", harnessKey: "implement" },
      deps({
        requiresWorktree: async () => true,
        exists: (target) => target === WORKTREE,
      })
    );

    expect(resolution.status).toBe("unresolved");
  });

  it("degrades a dispatch that has no workspace at all", async () => {
    const resolution = await resolveJobTree({ workspacePath: null }, deps());

    expect(resolution).toEqual({
      status: "unresolved",
      reason: "This dispatch has no workspace path.",
      action: "Re-dispatch the task with an explicit workspace.",
    });
  });
});

describe("harnessWorktreeProbe", () => {
  it("reports the harness's own requires.worktree and asks once per key", async () => {
    const getHarness = vi
      .fn()
      .mockResolvedValue({ config: { requires: { worktree: true } } });
    const probe = harnessWorktreeProbe({ getHarness });

    expect(await probe("implement")).toBe(true);
    expect(await probe("implement")).toBe(true);
    expect(getHarness).toHaveBeenCalledTimes(1);
  });

  it("resolves UNKNOWN (null), never false, when the harness cannot be read", async () => {
    const probe = harnessWorktreeProbe({
      getHarness: vi.fn().mockRejectedValue(new Error("404")),
    });

    expect(await probe("gone")).toBeNull();
  });
});

// ── End-to-end over a REAL git worktree ──────────────────────────────────────

describe("review evidence reads the job's real tree", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    }
  });

  function seedRepoWithWorktree(taskId: string) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "muon-job-tree-"));
    created.push(repoRoot);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "tests@muon.local");
    git("config", "user.name", "MUON Tests");
    writeFileSync(path.join(repoRoot, "root.ts"), "export const root = 1;\n");
    git("add", "root.ts");
    git("commit", "-qm", "seed");

    const worktree = path.join(repoRoot, ".muon", "worktrees", taskId);
    mkdirSync(path.dirname(worktree), { recursive: true });
    git("worktree", "add", "-q", "--detach", worktree);
    // The agent's edit lives ONLY in the isolated tree. The canonical checkout
    // stays clean — which is exactly what made the bug render as "no changes".
    writeFileSync(
      path.join(worktree, "root.ts"),
      "export const root = 2; // edited by the lane\n"
    );
    return { repoRoot, worktree };
  }

  it("finds the worktree a real dispatch edited", async () => {
    const { repoRoot, worktree } = seedRepoWithWorktree("task-live");

    const resolution = await resolveJobTree(
      {
        taskId: "task-live",
        workspacePath: repoRoot,
        harnessKey: "implement",
      },
      {
        repoRoot: async () => repoRoot,
        exists: existsSync,
        requiresWorktree: async () => true,
      }
    );

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.tree.kind).toBe("worktree");
    expect(resolution.tree.path).toBe(worktree);

    // The impact lane reads the tree main hands it — the agent's change is
    // visible there and invisible in the canonical checkout.
    const inWorktree = await loadReviewDiff(resolution.tree.path, {
      scope: "all",
    });
    const inWorkspace = await loadReviewDiff(repoRoot, { scope: "all" });
    expect(inWorktree.status).toBe("ok");
    expect(inWorkspace.status).toBe("ok");
    if (inWorktree.status !== "ok" || inWorkspace.status !== "ok") return;
    expect(inWorktree.impact.totals.changedFiles).toBe(1);
    expect(inWorktree.impact.blindFiles).toEqual(["root.ts"]);
    // The canonical checkout the job record names has NOTHING in it — the exact
    // "clean" reading this bug produced.
    expect(inWorkspace.impact.verdict).toBe("no-op");
    expect(inWorkspace.impact.totals.changedFiles).toBe(0);
  });

  it("shows the raw diff from the worktree instead of the empty workspace root", async () => {
    const { repoRoot, worktree } = seedRepoWithWorktree("task-raw");

    const review = await loadWorkspaceReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          taskId: "task-raw",
          workspacePath: repoRoot,
          harnessKey: "implement",
        }),
      },
      { jobId: "job-1" },
      {
        // Everything except tree resolution stays REAL git, so this proves the
        // whole raw-diff read, not just the path arithmetic.
        ...defaultWorkspaceReviewDependencies,
        canonicalize: async (target: string) => target,
        resolveTree: (job) =>
          resolveJobTree(job, {
            repoRoot: async () => repoRoot,
            exists: existsSync,
            requiresWorktree: async () => true,
          }),
      }
    );

    expect(review.status).toBe("available");
    if (review.status !== "available") return;
    expect(review.workspacePath).toBe(worktree);
    expect(review.files).toEqual(["root.ts"]);
    expect(review.diffText).toContain("edited by the lane");
  });

  it("degrades the raw diff when the expected worktree is gone", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "muon-job-tree-"));
    created.push(repoRoot);

    const review = await loadWorkspaceReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-2",
          taskId: "task-pruned",
          workspacePath: repoRoot,
          harnessKey: "implement",
        }),
      },
      { jobId: "job-2" },
      {
        canonicalize: async (target: string) => target,
        context: vi.fn(),
        changedFiles: vi.fn(),
        diffStat: vi.fn(),
        numstat: vi.fn(),
        diff: vi.fn(),
        resolveTree: (job) =>
          resolveJobTree(job, {
            repoRoot: async () => repoRoot,
            exists: () => false,
            requiresWorktree: async () => true,
          }),
      }
    );

    expect(review.status).toBe("degraded");
    if (review.status !== "degraded") return;
    expect(review.reason).toContain("not on disk");
    // Nothing was read: the panel must not render a confident empty diff.
    expect(review.reason).not.toBe("");
  });
});

describe("resolveJobTree — executionPath (0039) is fact, not inference", () => {
  // The runner records the cwd it ACTUALLY handed the vendor. Everything else in
  // this resolver INFERS that path from the harness plus a disk probe. When the
  // fact is present it must win, and the inference must not even be consulted.
  const neverProbe = {
    repoRoot: async () => {
      throw new Error("repoRoot must not be consulted when executionPath is present");
    },
    exists: () => {
      throw new Error("exists must not be consulted when executionPath is present");
    },
    requiresWorktree: async () => {
      throw new Error("requiresWorktree must not be consulted when executionPath is present");
    },
  };

  it("uses the recorded worktree path without probing the harness or disk", async () => {
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "implement",
        executionPath: "/repo/.muon/worktrees/task-7",
      },
      neverProbe
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.tree).toEqual({
      kind: "worktree",
      path: "/repo/.muon/worktrees/task-7",
      taskId: "task-7",
    });
  });

  it("classifies a recorded path equal to the workspace as the workspace itself", async () => {
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "research",
        executionPath: "/repo",
      },
      neverProbe
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.tree.kind).toBe("workspace");
    expect(resolution.tree.path).toBe("/repo");
  });

  it("treats a NULL executionPath as unknown and falls back to derivation", async () => {
    // A pre-0039 row. Reading null as "ran in the workspace root" would be the
    // exact wrong-tree bug this whole resolver exists to prevent.
    const resolution = await resolveJobTree(
      {
        taskId: "task-7",
        workspacePath: "/repo",
        harnessKey: "implement",
        executionPath: null,
      },
      {
        repoRoot: async () => "/repo",
        exists: () => true,
        requiresWorktree: async () => true,
      }
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.tree.kind).toBe("worktree");
  });
});
