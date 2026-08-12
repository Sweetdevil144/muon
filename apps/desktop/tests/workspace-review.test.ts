import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadWorkspaceReview } from "../src/lib/workspace-review.js";

describe("loadWorkspaceReview", () => {
  it("reads the branch plus staged and unstaged files from one workspace", async () => {
    const workspacePath = mkdtempSync(
      path.join(tmpdir(), "muon-workspace-review-")
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspacePath, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "tests@muon.local");
      git("config", "user.name", "MUON Tests");
      writeFileSync(path.join(workspacePath, "staged.ts"), "export const n = 1;\n");
      git("add", "staged.ts");
      git("commit", "-qm", "seed");
      git("switch", "-qc", "codex/review-test");
      writeFileSync(path.join(workspacePath, "staged.ts"), "export const n = 2;\n");
      git("add", "staged.ts");
      writeFileSync(
        path.join(workspacePath, "unstaged.ts"),
        "export const pending = true;\n"
      );

      const result = await loadWorkspaceReview(
        {
          getDispatchJob: vi.fn().mockResolvedValue({
            id: "job-1",
            workspacePath,
          }),
        },
        { jobId: "job-1" }
      );

      expect(result).toMatchObject({
        status: "available",
        branch: "codex/review-test",
        stagedFiles: ["staged.ts"],
        unstagedFiles: ["unstaged.ts"],
        files: ["staged.ts", "unstaged.ts"],
      });
      expect(git("diff", "--cached", "--name-only").trim()).toBe("staged.ts");
      expect(git("status", "--short", "unstaged.ts").trim()).toBe(
        "?? unstaged.ts"
      );
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("returns bounded changed files, stat, and diff for the job workspace", async () => {
    const result = await loadWorkspaceReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: "/repo",
        }),
      },
      { jobId: "job-1" },
      {
        canonicalize: vi.fn().mockResolvedValue("/real/repo"),
        context: vi.fn().mockResolvedValue({
          branch: "codex/wave-2",
          stagedFiles: ["src/auth.ts"],
          unstagedFiles: ["src/session.ts"],
        }),
        changedFiles: vi.fn().mockResolvedValue([
          "src/auth.ts",
          "src/session.ts",
        ]),
        diffStat: vi.fn().mockResolvedValue(
          "2 files changed, 12 insertions(+), 3 deletions(-)"
        ),
        numstat: vi.fn().mockResolvedValue([
          { path: "src/auth.ts", additions: 9, deletions: 1, binary: false },
          { path: "src/session.ts", additions: 3, deletions: 2, binary: false },
        ]),
        diff: vi.fn().mockResolvedValue({
          text: "diff --git a/src/auth.ts b/src/auth.ts\n+authorize();",
          truncated: false,
          totalBytes: 54,
        }),
      }
    );

    expect(result).toEqual({
      status: "available",
      workspacePath: "/real/repo",
      // WHICH tree the evidence was read from — the "Land this work" panel
      // needs it to tell a task worktree from the canonical checkout.
      tree: { kind: "workspace", path: "/repo" },
      branch: "codex/wave-2",
      stagedFiles: ["src/auth.ts"],
      unstagedFiles: ["src/session.ts"],
      files: ["src/auth.ts", "src/session.ts"],
      stat: "2 files changed, 12 insertions(+), 3 deletions(-)",
      fileStats: [
        { path: "src/auth.ts", additions: 9, deletions: 1, binary: false },
        { path: "src/session.ts", additions: 3, deletions: 2, binary: false },
      ],
      diffText: "diff --git a/src/auth.ts b/src/auth.ts\n+authorize();",
      truncated: false,
      totalBytes: 54,
      maxBytes: 262_144,
    });
  });

  it("degrades explicitly when no workspace or git diff is available", async () => {
    const missing = await loadWorkspaceReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-1",
          workspacePath: null,
        }),
      },
      { jobId: "job-1" }
    );
    expect(missing).toMatchObject({
      status: "degraded",
      reason: "This dispatch has no workspace path.",
      action: "Re-dispatch the task with an explicit workspace.",
    });

    const failed = await loadWorkspaceReview(
      {
        getDispatchJob: vi.fn().mockResolvedValue({
          id: "job-2",
          workspacePath: "/repo",
        }),
      },
      { jobId: "job-2" },
      {
        canonicalize: vi.fn().mockResolvedValue("/repo"),
        context: vi.fn(),
        changedFiles: vi.fn().mockRejectedValue(new Error("not a git repo")),
        diffStat: vi.fn(),
        numstat: vi.fn(),
        diff: vi.fn(),
      }
    );
    expect(failed).toMatchObject({
      status: "degraded",
      reason: "not a git repo",
      action:
        "Open the workspace in Git or inspect the session timeline and terminal artifact.",
    });
  });
});
