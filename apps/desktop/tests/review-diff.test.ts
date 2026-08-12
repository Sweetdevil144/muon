import { describe, expect, it } from "vitest";
import {
  loadReviewDiff,
  type ReviewDiffDependencies,
} from "../src/lib/review-diff.js";

const env = (markdown: string, rowCount: number) =>
  JSON.stringify({ markdown, row_count: rowCount });

/** Deps whose git reports one indexed + one new file, and a cypher store that
 *  knows only the indexed file (+ a symbol in a process). */
function makeDeps(over: Partial<ReviewDiffDependencies> = {}): ReviewDiffDependencies {
  return {
    canonicalize: async (p) => p,
    git: async (args) => {
      if (args.includes("--name-only")) return "src/gate.ts\nsrc/new.ts\n";
      if (args.includes("rev-parse")) return "7ed0bbdCAFE\n";
      return [
        "diff --git a/src/gate.ts b/src/gate.ts",
        "+++ b/src/gate.ts",
        "@@ -10,2 +10,4 @@",
        "diff --git a/src/new.ts b/src/new.ts",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,30 @@",
      ].join("\n");
    },
    gnxExec: async (_binary, args) => {
      const command = args.find((a) => a === "list" || a === "cypher");
      if (command === "list") {
        return {
          stdout: "\n  Indexed Repositories (1)\n\n  muon\n    Path:    /ws\n    Indexed: now\n    Commit:  7ed0bbd\n",
          stderr: "",
        };
      }
      const query = args[args.length - 1] ?? "";
      if (query.includes("f:File")) {
        return { stdout: env("| fp |\n| --- |\n| src/gate.ts |", 1), stderr: "" };
      }
      if (query.includes("STEP_IN_PROCESS")) {
        return {
          stdout: env(
            "| file | symbol | startLine | endLine | process | processId | entryPointId | step |\n| --- |\n| src/gate.ts | redeemGate | 8 | 20 | RedeemGateAtRoute | proc_1 | ep_1 | 3 |",
            1
          ),
          stderr: "",
        };
      }
      return {
        stdout: env("| file | name | kind | startLine | endLine |\n| --- |\n| src/gate.ts | redeemGate | Function | 8 | 20 |", 1),
        stderr: "",
      };
    },
    resolveCli: () => ({ binary: "/fake/node", commandPrefix: ["/cli.js"] }),
    ...over,
  };
}

describe("loadReviewDiff — fail-closed coverage", () => {
  it("surfaces the unindexed file as REVIEW BLIND, not a false all-clear", async () => {
    const result = await loadReviewDiff("/ws", { scope: "all" }, makeDeps());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.verdict).toBe("review-blind");
    expect(result.impact.blindFiles).toEqual(["src/new.ts"]);
    expect(result.impact.affectedProcesses[0]?.process).toBe("RedeemGateAtRoute");
  });

  it("a repo with NO index (resolveCli null) → all files blind, review-blind", async () => {
    const result = await loadReviewDiff(
      "/ws",
      { scope: "all" },
      makeDeps({ resolveCli: () => null })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.verdict).toBe("review-blind");
    expect(result.impact.totals.blindFiles).toBe(2); // nothing resolved
    // freshness has no graphCommit → the UI reads this as "not indexed", not "stale"
    expect(result.impact.indexFreshness.graphCommit).toBeUndefined();
  });

  it("a STALE index (graph commit != HEAD) forces review-blind with a stale note", async () => {
    const result = await loadReviewDiff(
      "/ws",
      { scope: "all" },
      makeDeps({
        git: async (args) => {
          if (args.includes("--name-only")) return "src/gate.ts\n";
          if (args.includes("rev-parse")) return "deadbeef9999\n"; // HEAD moved past graph's 7ed0bbd
          return "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@";
        },
      })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.verdict).toBe("review-blind");
    expect(result.impact.indexFreshness.stale).toBe(true);
    expect(result.impact.notes.join(" ")).toMatch(/stale/i);
  });

  // TODO 5.14 moved governed task worktrees OUT of the source repository, so a
  // linked worktree is neither the indexed repo's path nor a descendant of it —
  // and repo-name resolution matches only those two shapes. Every review of
  // agent work then degraded to "workspace not indexed" / REVIEW BLIND even
  // though the repository was indexed and fresh (observed live 2026-08-05).
  // The index lookup must resolve the worktree back to its primary repository.
  it("resolves a linked worktree to its primary repo for the index lookup", async () => {
    const worktree =
      "/Users/x/Library/Application Support/@muon/desktop-worktrees/MUON-abc/task-1";
    const result = await loadReviewDiff(
      worktree,
      { scope: "all" },
      makeDeps({
        git: async (args) => {
          if (args.includes("--git-common-dir")) return "/ws/.git\n";
          if (args.includes("--name-only")) return "src/gate.ts\n";
          if (args.includes("rev-parse")) return "7ed0bbdCAFE\n";
          return "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@";
        },
      })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The graph WAS consulted: a commit resolved and the changed file is not
    // blind. Before the fix this returned blindFiles: ["src/gate.ts"].
    expect(result.impact.indexFreshness.graphCommit).toBe("7ed0bbd");
    expect(result.impact.blindFiles).toEqual([]);
    expect(result.impact.affectedProcesses[0]?.process).toBe("RedeemGateAtRoute");
  });

  it("a non-repository path still resolves to itself (no git, no throw)", async () => {
    const result = await loadReviewDiff(
      "/ws",
      { scope: "all" },
      makeDeps({
        git: async (args) => {
          if (args.includes("--git-common-dir")) throw new Error("not a git repository");
          if (args.includes("--name-only")) return "src/gate.ts\n";
          if (args.includes("rev-parse")) return "7ed0bbdCAFE\n";
          return "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@";
        },
      })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.blindFiles).toEqual([]);
  });

  // The stale rail must fire on the DEFAULT scope too. It used to exclude
  // `unstaged`/`staged`, and `unstaged` is the default — so the default path
  // could never report a stale index and a stale-but-complete file set rendered
  // as an explicit all-clear on the surface that gates a merge.
  it("reports a stale index on the DEFAULT scope, not just on 'all'", async () => {
    const result = await loadReviewDiff(
      "/ws",
      {},
      makeDeps({
        git: async (args) => {
          if (args.includes("--name-only")) return "src/gate.ts\n";
          if (args.includes("rev-parse")) return "deadbeef9999\n"; // HEAD past graph's 7ed0bbd
          return "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@";
        },
      })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.indexFreshness.stale).toBe(true);
    expect(result.impact.verdict).toBe("review-blind");
  });

  it("no changed files → no-op verdict", async () => {
    const result = await loadReviewDiff(
      "/ws",
      { scope: "all" },
      makeDeps({ git: async (args) => (args.includes("rev-parse") ? "abc\n" : "") })
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.impact.verdict).toBe("no-op");
  });

  it("degrades (not throws) on a bad compare baseRef", async () => {
    const result = await loadReviewDiff(
      "/ws",
      { scope: "compare", baseRef: "bad;rm -rf" },
      makeDeps()
    );
    expect(result.status).toBe("degraded");
  });
});
