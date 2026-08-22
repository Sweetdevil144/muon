import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitScopeArgs, parseHunks } from "@muon/client/diff-impact";
import {
  createGitNexusToolDefinitions,
  repoCommitFromList,
  type GitNexusRunner,
  type SiblingTaskDiff,
} from "../src/gitnexus-tools.js";
import { createReviewDiffLedger } from "../src/review-session.js";

const env = (markdown: string, rowCount: number) =>
  JSON.stringify({ markdown, row_count: rowCount });
const WORKSPACE = process.cwd();

describe("gitScopeArgs", () => {
  it("maps each scope to git diff selectors", () => {
    expect(gitScopeArgs("unstaged")).toEqual({ args: [] });
    expect(gitScopeArgs("staged")).toEqual({ args: ["--cached"] });
    expect(gitScopeArgs("all")).toEqual({ args: ["HEAD"] });
    expect(gitScopeArgs("compare", "main")).toEqual({ args: ["main...HEAD"] });
  });

  it("rejects compare without a safe baseRef", () => {
    expect("error" in gitScopeArgs("compare")).toBe(true);
    expect("error" in gitScopeArgs("compare", "main; rm -rf /")).toBe(true);
    expect("error" in gitScopeArgs("compare", "feature/x")).toBe(false);
  });
});

describe("parseHunks", () => {
  it("extracts NEW-side changed line ranges per file", () => {
    const diff = [
      "diff --git a/src/gate.ts b/src/gate.ts",
      "--- a/src/gate.ts",
      "+++ b/src/gate.ts",
      "@@ -10,2 +10,3 @@ context",
      "@@ -40 +41 @@",
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -5,0 +6,4 @@",
    ].join("\n");
    const hunks = parseHunks(diff);
    expect(hunks.get("src/gate.ts")).toEqual([
      { start: 10, end: 12 }, // +10,3 → 10..12
      { start: 41, end: 41 }, // +41 (count defaults to 1)
    ]);
    expect(hunks.get("src/x.ts")).toEqual([{ start: 6, end: 9 }]); // +6,4 → 6..9
  });

  it("a deleted file (+++ /dev/null) yields no new-side hunks", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
    ].join("\n");
    expect(parseHunks(diff).size).toBe(0);
  });
});

describe("repoCommitFromList", () => {
  const LIST = `
  Indexed Repositories (2)

  muon
    Path:    /repo/muon
    Indexed: now
    Commit:  7ed0bbd

  other
    Path:    /repo/other
    Indexed: now
    Commit:  deadbee
`;
  it("extracts the right repo's indexed commit", () => {
    expect(repoCommitFromList(LIST, "muon")).toBe("7ed0bbd");
    expect(repoCommitFromList(LIST, "other")).toBe("deadbee");
    expect(repoCommitFromList(LIST, "nope")).toBeUndefined();
  });
});

describe("review_diff tool (fail-closed, injected git + cypher)", () => {
  const WS = WORKSPACE;
  // One indexed file (src/gate.ts, has a File node + a symbol in a process) and
  // one BRAND-NEW file (src/new.ts, no graph node) — the coverage-guard case.
  const fakeRun: GitNexusRunner = async (binary, args) => {
    if (binary === "git") {
      if (args.includes("--name-only")) {
        return { stdout: "src/gate.ts\nsrc/new.ts\n", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { stdout: "7ed0bbdCAFE\n", stderr: "" };
      }
      // git diff --unified=0
      return {
        stdout: [
          "diff --git a/src/gate.ts b/src/gate.ts",
          "+++ b/src/gate.ts",
          "@@ -10,2 +10,4 @@",
          "diff --git a/src/new.ts b/src/new.ts",
          "+++ b/src/new.ts",
          "@@ -0,0 +1,30 @@",
        ].join("\n"),
        stderr: "",
      };
    }
    // gitnexus CLI
    const command = args.find((a) => a === "list" || a === "cypher");
    if (command === "list") {
      return {
        stdout: `\n  Indexed Repositories (1)\n\n  muon\n    Path:    ${WS}\n    Indexed: now\n    Commit:  7ed0bbd\n`,
        stderr: "",
      };
    }
    if (command === "cypher") {
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
      // symbols query
      return {
        stdout: env(
          "| file | name | kind | startLine | endLine |\n| --- |\n| src/gate.ts | redeemGate | Function | 8 | 20 |",
          1
        ),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };

  const tool = () =>
    createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: fakeRun,
    }).find((t) => t.name === "review_diff")!;

  it("is registered as a tool", () => {
    expect(tool()).toBeDefined();
  });

  // EVERY governed run happens in a linked task worktree that lives OUTSIDE the
  // source repository (TODO 5.14), so the worktree is neither an indexed repo's
  // path nor a descendant of one. review_diff — the ship-gate evidence tool —
  // hard-errored "No indexed git repository contains this workspace" for a repo
  // that is indexed and fresh, which made it unusable in the only place it is
  // ever called. No test covered the worktree branch, which is why it shipped.
  it("resolves the primary repo from inside a linked task worktree", async () => {
    // A REAL directory: the resolver canonicalizes the workspace before it can
    // match anything, so a synthetic path would fail for the wrong reason.
    const worktree = await mkdtemp(join(tmpdir(), "muon-governed-worktree-"));
    const worktreeRun: GitNexusRunner = async (binary, args) => {
      if (binary === "git") {
        if (args.includes("--git-common-dir")) {
          // git names `<primary>/.git`; its parent is the primary root.
          return { stdout: `${WS}/.git\n`, stderr: "" };
        }
        if (args.includes("--name-only")) {
          return { stdout: "src/gate.ts\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "7ed0bbdCAFE\n", stderr: "" };
        }
        return {
          stdout:
            "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@",
          stderr: "",
        };
      }
      return fakeRun(binary, args, {} as never);
    };
    const worktreeTool = createGitNexusToolDefinitions({
      workspacePath: worktree,
      binary: "/fake/node",
      run: worktreeRun,
    }).find((t) => t.name === "review_diff")!;

    const result = await worktreeTool.handler({ scope: "all" });
    // Before the fix this was `isError: true` with "No indexed git repository
    // contains this workspace." — a reviewer had no graph-backed path to a
    // verdict at all.
    expect(result.isError).toBeFalsy();
    const impact = (
      result.structuredContent as {
        reviewDiff: { blindFiles: string[]; affectedProcesses: unknown[] };
      }
    ).reviewDiff;
    expect(impact.blindFiles).toEqual([]);
    expect(impact.affectedProcesses).toHaveLength(1);
    await rm(worktree, { recursive: true, force: true });
  });

  it("surfaces the unindexed file as REVIEW BLIND (fail-closed), not a false all-clear", async () => {
    const result = await tool().handler({ scope: "all" });
    expect(result.isError).toBeFalsy();
    const impact = (result.structuredContent as { reviewDiff: {
      verdict: string;
      blindFiles: string[];
      affectedProcesses: { process: string; steps: number[] }[];
      totals: { changedFiles: number; blindFiles: number };
    } }).reviewDiff;
    expect(impact.verdict).toBe("review-blind");
    expect(impact.blindFiles).toEqual(["src/new.ts"]);
    expect(impact.totals.changedFiles).toBe(2);
    // the indexed file still resolves its affected flow
    expect(impact.affectedProcesses).toHaveLength(1);
    expect(impact.affectedProcesses[0]!.process).toBe("RedeemGateAtRoute");
    expect(impact.affectedProcesses[0]!.steps).toEqual([3]);
    // the ui envelope marks the degradation
    expect(result.isError).toBeFalsy();
    expect((result.ui as { degradation?: { active?: boolean } }).degradation?.active).toBe(true);
  });

  it("rejects compare scope without a baseRef", async () => {
    const result = await tool().handler({ scope: "compare" });
    expect(result.isError).toBe(true);
  });

  // ADR-0065: the STRUCTURED citation channel on review evidence — recorded
  // beside the verdict and echoed in the payload; a malformed list REFUSES
  // (stated provenance intent must not be silently dropped); never a grammar.
  it("carries cited_note_ids onto the review payload and the session ledger; malformed refuses", async () => {
    const ledger = createReviewDiffLedger();
    const citedTool = createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: fakeRun,
      reviewLedger: ledger,
    }).find((t) => t.name === "review_diff")!;

    const result = await citedTool.handler({
      scope: "all",
      cited_note_ids: ["mem-review-a", "mem-review-b", "mem-review-a"],
    });
    expect(result.isError).toBeFalsy();
    const payload = (
      result.structuredContent as {
        reviewDiff: { id: string; citedNoteIds?: string[] };
      }
    ).reviewDiff;
    // Deduped, order-preserving.
    expect(payload.citedNoteIds).toEqual(["mem-review-a", "mem-review-b"]);
    const record = [...ledger.values()].find((row) => row.id === payload.id);
    expect(record?.citedNoteIds).toEqual(["mem-review-a", "mem-review-b"]);

    const refused = await citedTool.handler({
      scope: "all",
      cited_note_ids: ["", "mem-x"],
    });
    expect(refused.isError).toBe(true);

    // Without the field, the record carries an EMPTY set — absence is
    // "cited nothing", never an invented citation.
    const bare = await citedTool.handler({ scope: "all" });
    expect(bare.isError).toBeFalsy();
    const bareId = (
      bare.structuredContent as { reviewDiff: { id: string; citedNoteIds?: string[] } }
    ).reviewDiff;
    expect(bareId.citedNoteIds).toBeUndefined();
  });

  // The review lane's sibling arm: review_diff({taskId}) maps the diff the
  // CONTROL PLANE serves (the implementer task's worktree) instead of the
  // caller's own tree — which is empty in a reviewer's fresh worktree, the
  // exact blind spot that BLOCKED both reviewers in mission 420c8bf4.
  describe("sibling taskId arm", () => {
    // Local `git diff` must never run on this path: the fake throws if the
    // handler falls back to the caller's own tree for changed files.
    const siblingRun: GitNexusRunner = async (binary, args, options) => {
      if (binary === "git" && args.includes("--name-only")) {
        throw new Error("sibling arm must not diff the caller's own tree");
      }
      return fakeRun(binary, args, options);
    };
    const siblingTool = (diff: SiblingTaskDiff) =>
      createGitNexusToolDefinitions({
        workspacePath: WS,
        binary: "/fake/node",
        run: siblingRun,
        fetchTaskDiff: async () => diff,
      }).find((t) => t.name === "review_diff")!;

    const OK_DIFF = {
      status: "ok" as const,
      changedFiles: ["src/gate.ts"],
      baseCommit: "7ed0bbdCAFE",
      diff: {
        text: [
          "diff --git a/src/gate.ts b/src/gate.ts",
          "+++ b/src/gate.ts",
          "@@ -10,2 +10,4 @@",
        ].join("\n"),
        truncated: false,
        totalBytes: 96,
      },
    };

    it("maps the SIBLING diff onto flows without touching the local tree", async () => {
      const result = await siblingTool(OK_DIFF).handler({ taskId: "task-impl" });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      const impact = (
        result.structuredContent as {
          reviewDiff: {
            verdict: string;
            blindFiles: string[];
            affectedProcesses: { process: string }[];
            indexFreshness: { stale: boolean };
          };
        }
      ).reviewDiff;
      expect(impact.blindFiles).toEqual([]);
      expect(impact.affectedProcesses).toHaveLength(1);
      expect(impact.affectedProcesses[0]!.process).toBe("RedeemGateAtRoute");
      // Freshness judged against the SIBLING's base commit, matching the index.
      expect(impact.indexFreshness.stale).toBe(false);
    });

    it("a truncated sibling diff FORCES review-blind — never a literal all-clear", async () => {
      const result = await siblingTool({
        ...OK_DIFF,
        diff: { ...OK_DIFF.diff, truncated: true },
      }).handler({ taskId: "task-impl" });
      expect(result.isError).toBeFalsy();
      // Truncation is a third incompleteness case beside blind files and a
      // stale index: files past the cut "resolve" with zero flows, which the
      // tool's own contract forbids reading as clear. The VERDICT carries it,
      // not only the degradation envelope.
      const impact = (
        result.structuredContent as {
          reviewDiff: { verdict: string; notes: string[] };
        }
      ).reviewDiff;
      expect(impact.verdict).toBe("review-blind");
      expect(impact.notes.join(" ")).toMatch(/truncated/);
      const ui = result.ui as {
        degradation?: { active?: boolean; reason?: string };
      };
      expect(ui.degradation?.active).toBe(true);
      expect(ui.degradation?.reason).toMatch(/truncated/);
    });

    it("no-worktree is an honest failure with a next step", async () => {
      const result = await siblingTool({
        status: "no-worktree" as const,
        reason: "No worktree exists for this task.",
      }).handler({ taskId: "task-impl" });
      expect(result.isError).toBe(true);
    });

    it("refuses taskId combined with scope/baseRef", async () => {
      const result = await siblingTool(OK_DIFF).handler({
        taskId: "task-impl",
        scope: "all",
      });
      expect(result.isError).toBe(true);
    });

    it("without a control-plane connection the arm fails plainly", async () => {
      const result = await tool().handler({ taskId: "task-impl" });
      expect(result.isError).toBe(true);
    });
  });
});

// ── Index freshness is THREE states, and UNKNOWN is one of them ──────────────
//
// The defect this pins: `stale` fell back to `false` whenever the store's
// indexed commit OR the diff's own commit could not be read — byte-identical to
// a VERIFIED-CURRENT index, on the one tool whose verdict `ship`'s preflight and
// the desktop's merge lane both stand on. So an index MUON never measured
// reached `flows-resolved`, and "0 flows affected" became a pass. Driven through
// the real handler with injected git + CLI, one case per readable/unreadable
// combination, asserting the VERDICT and the emitted freshness — never source
// text.

describe("review_diff index freshness (fail-closed on UNKNOWN)", () => {
  const WS = WORKSPACE;
  type Freshness = {
    graphCommit?: string;
    headCommit?: string;
    stale: boolean | null;
    unmeasured?: string;
  };

  /** One indexed, resolvable changed file — so the ONLY thing that can force a
   *  blind verdict in these cases is the index freshness itself. */
  const freshnessRun = (input: {
    indexedCommit?: string;
    headCommit?: string;
  }): GitNexusRunner => {
    return async (binary, args) => {
      if (binary === "git") {
        if (args.includes("--git-common-dir")) {
          return { stdout: `${WS}/.git\n`, stderr: "" };
        }
        if (args.includes("--name-only")) {
          return { stdout: "src/gate.ts\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          // Empty stdout = git answered nothing: the diff's own commit is
          // unreadable (detached/broken checkout, git unavailable).
          return {
            stdout: input.headCommit ? `${input.headCommit}\n` : "\n",
            stderr: "",
          };
        }
        return {
          stdout:
            "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@",
          stderr: "",
        };
      }
      const command = args.find((a) => a === "list" || a === "cypher");
      if (command === "list") {
        // A block with NO `Commit:` line is a store whose indexed commit cannot
        // be read — a half-written or legacy meta, indistinguishable to the
        // caller from a current one before this fix.
        return {
          stdout: `\n  Indexed Repositories (1)\n\n  muon\n    Path:    ${WS}\n    Indexed: now\n${
            input.indexedCommit ? `    Commit:  ${input.indexedCommit}\n` : ""
          }`,
          stderr: "",
        };
      }
      if (command === "cypher") {
        const query = args[args.length - 1] ?? "";
        if (query.includes("f:File")) {
          return {
            stdout: env("| fp |\n| --- |\n| src/gate.ts |", 1),
            stderr: "",
          };
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
          stdout: env(
            "| file | name | kind | startLine | endLine |\n| --- |\n| src/gate.ts | redeemGate | Function | 8 | 20 |",
            1
          ),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
  };

  const review = async (input: {
    indexedCommit?: string;
    headCommit?: string;
  }) => {
    const tool = createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: freshnessRun(input),
    }).find((entry) => entry.name === "review_diff")!;
    const result = await tool.handler({ scope: "all" });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return {
      impact: (
        result.structuredContent as {
          reviewDiff: {
            verdict: string;
            notes: string[];
            indexFreshness: Freshness;
          };
        }
      ).reviewDiff,
      ui: result.ui as {
        degradation?: { active?: boolean; reason?: string; action?: string };
      },
    };
  };

  it("readable + current: the review resolves, and freshness says so", async () => {
    const { impact, ui } = await review({
      indexedCommit: "7ed0bbd",
      headCommit: "7ed0bbdCAFE",
    });
    expect(impact.verdict).toBe("flows-resolved");
    expect(impact.indexFreshness.stale).toBe(false);
    expect(impact.indexFreshness.unmeasured).toBeUndefined();
    expect(ui.degradation?.active).toBe(false);
  });

  it("readable + stale: review-blind, and the note names the staleness", async () => {
    const { impact, ui } = await review({
      indexedCommit: "deadbee",
      headCommit: "7ed0bbdCAFE",
    });
    expect(impact.verdict).toBe("review-blind");
    expect(impact.indexFreshness.stale).toBe(true);
    expect(impact.notes.join(" ")).toMatch(/Index is STALE/);
    expect(ui.degradation?.active).toBe(true);
  });

  it("UNREADABLE store commit: UNKNOWN, never `stale: false`, and never resolved", async () => {
    const { impact, ui } = await review({ headCommit: "7ed0bbdCAFE" });
    // The whole finding in one line: an unmeasurable index used to report the
    // value a verified-current one reports.
    expect(impact.indexFreshness.stale).not.toBe(false);
    expect(impact.indexFreshness.stale).toBeNull();
    expect(impact.verdict).toBe("review-blind");
    // The copy names WHAT could not be measured…
    expect(impact.indexFreshness.unmeasured).toMatch(/no indexed commit/);
    expect(impact.notes.join(" ")).toMatch(/could not be MEASURED/);
    // …and the remedy ADR-0054 shipped, not the destructive one.
    expect(impact.notes.join(" ")).toMatch(/muon graph reindex/);
    expect(ui.degradation?.active).toBe(true);
    expect(ui.degradation?.action).toMatch(/muon graph reindex/);
    // Nothing may claim a comparison MUON never made.
    expect(impact.notes.join(" ")).not.toMatch(/Index is STALE/);
  });

  it("UNREADABLE diff commit: same UNKNOWN state, and it says which fact was missing", async () => {
    const { impact, ui } = await review({ indexedCommit: "7ed0bbd" });
    expect(impact.indexFreshness.stale).toBeNull();
    expect(impact.indexFreshness.graphCommit).toBe("7ed0bbd");
    expect(impact.verdict).toBe("review-blind");
    expect(impact.indexFreshness.unmeasured).toMatch(
      /commit this diff applies to/
    );
    expect(ui.degradation?.active).toBe(true);
    expect(impact.notes.join(" ")).not.toMatch(/Index is STALE/);
  });

  it("an EMPTY diff stays no-op, but still reports the index it could not measure", async () => {
    const emptyRun: GitNexusRunner = async (binary, args, options) => {
      if (binary === "git" && args.includes("--name-only")) {
        return { stdout: "\n", stderr: "" };
      }
      return freshnessRun({ headCommit: "7ed0bbdCAFE" })(binary, args, options);
    };
    const tool = createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: emptyRun,
    }).find((entry) => entry.name === "review_diff")!;
    const result = await tool.handler({ scope: "all" });
    expect(result.isError).toBeFalsy();
    const impact = (
      result.structuredContent as {
        reviewDiff: {
          verdict: string;
          notes: string[];
          indexFreshness: Freshness;
        };
      }
    ).reviewDiff;
    // Nothing changed, so there is nothing to be blind about — and `ship`
    // refuses a no-op verdict regardless. What must NOT happen is the envelope
    // reading as an all-clear about the index.
    expect(impact.verdict).toBe("no-op");
    expect(impact.indexFreshness.stale).toBeNull();
    expect(impact.notes.join(" ")).toMatch(/could not be MEASURED/);
    expect(
      (result.ui as { degradation?: { active?: boolean } }).degradation?.active
    ).toBe(true);
  });
});

describe("data_boundaries tool (injected cypher)", () => {
  const WS = WORKSPACE;
  const env2 = (markdown: string, rowCount: number) =>
    JSON.stringify({ markdown, row_count: rowCount });
  const fakeRun: GitNexusRunner = async (binary, args) => {
    if (binary === "git") return { stdout: "", stderr: "" };
    const command = args.find((a) => a === "list" || a === "cypher");
    if (command === "list") {
      return {
        stdout: `\n  Indexed Repositories (1)\n\n  muon\n    Path:    ${WS}\n    Indexed: now\n    Commit:  abc\n`,
        stderr: "",
      };
    }
    if (command === "cypher") {
      const query = args[args.length - 1] ?? "";
      if (query.includes("f.filePath =")) {
        // tables for the file
        return { stdout: env2("| tbl |\n| --- |\n| memoryNote |\n| memoryEdge |", 2), stderr: "" };
      }
      // writers for tables
      return {
        stdout: env2(
          "| tbl | file |\n| --- |\n| memoryNote | backend/src/lib/memory-ledger.ts |\n| memoryNote | backend/src/routes/memory.ts |\n| memoryEdge | backend/src/lib/memory-ledger.ts |",
          3
        ),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const tool = () =>
    createGitNexusToolDefinitions({ workspacePath: WS, binary: "/fake/node", run: fakeRun }).find(
      (t) => t.name === "data_boundaries"
    )!;

  it("projects the file's tables + co-writers, shared-first", async () => {
    const result = await tool().handler({ path: "backend/src/lib/memory-ledger.ts" });
    expect(result.isError).toBeFalsy();
    const b = (result.structuredContent as { dataBoundary: {
      hasDataBoundary: boolean;
      sharedTables: number;
      tables: { table: string; writerCount: number; otherWriters: string[] }[];
    } }).dataBoundary;
    expect(b.hasDataBoundary).toBe(true);
    expect(b.tables[0]!.table).toBe("memoryNote");
    expect(b.tables[0]!.writerCount).toBe(2);
    expect(b.tables[0]!.otherWriters).toEqual(["backend/src/routes/memory.ts"]);
    expect(b.sharedTables).toBe(1);
  });

  it("requires a path", async () => {
    const result = await tool().handler({});
    expect(result.isError).toBe(true);
  });
});

describe("flow_scope tool (injected cypher)", () => {
  const WS = WORKSPACE;
  const env3 = (markdown: string, rowCount: number) =>
    JSON.stringify({ markdown, row_count: rowCount });
  const fakeRun: GitNexusRunner = async (binary, args) => {
    if (binary === "git") return { stdout: "", stderr: "" };
    const command = args.find((a) => a === "list" || a === "cypher");
    if (command === "list") {
      return {
        stdout: `\n  Indexed Repositories (1)\n\n  muon\n    Path:    ${WS}\n    Indexed: now\n    Commit:  abc\n`,
        stderr: "",
      };
    }
    if (command === "cypher") {
      const query = args[args.length - 1] ?? "";
      if (query.includes("p.entryPointId AS entryPointId")) {
        return {
          stdout: env3(
            "| processId | label | entryPointId | stepCount |\n| --- |\n| proc_9 | RegisterRedeem → Foo | Function:backend/src/routes/redeem.ts:registerRedeem | 3 |",
            1
          ),
          stderr: "",
        };
      }
      // members
      return {
        stdout: env3(
          "| processId | symbol | file | step |\n| --- |\n| proc_9 | registerRedeem | backend/src/routes/redeem.ts | 1 |\n| proc_9 | redeemGateAtRoute | backend/src/routes/redeem.ts | 3 |",
          2
        ),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const tool = () =>
    createGitNexusToolDefinitions({ workspacePath: WS, binary: "/fake/node", run: fakeRun }).find(
      (t) => t.name === "flow_scope"
    )!;

  it("compiles the anchor's flow to file:symbol scope", async () => {
    const result = await tool().handler({ symbol: "redeemGateAtRoute" });
    expect(result.isError).toBeFalsy();
    const s = (result.structuredContent as { flowScope: {
      flows: { process: string; entryPoint: { file: string; symbol: string } }[];
      ownedPaths: string[];
      inScopeSymbols: string[];
    } }).flowScope;
    expect(s.flows[0]!.entryPoint).toEqual({
      file: "backend/src/routes/redeem.ts",
      symbol: "registerRedeem",
    });
    expect(s.ownedPaths).toContain("backend/src/routes/redeem.ts");
    expect(s.inScopeSymbols).toContain("backend/src/routes/redeem.ts::redeemGateAtRoute");
  });

  it("requires a symbol", async () => {
    expect((await tool().handler({})).isError).toBe(true);
  });
});
