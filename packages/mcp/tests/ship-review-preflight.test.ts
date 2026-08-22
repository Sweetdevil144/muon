import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { createGitNexusToolDefinitions, type GitNexusRunner } from "../src/gitnexus-tools.js";
import { createOrchestratorToolDefinitions } from "../src/orchestrator-tools.js";
import {
  blindRecoveryActions,
  computeReviewDiffId,
  createReviewDiffLedger,
  reviewDiffKey,
  type ReviewDiffLedger,
} from "../src/review-session.js";

// A4 — `ship` must not file a merge gate for a change nobody in this session
// has looked at. A6 — when the look came back REVIEW BLIND, the way out is a
// named sequence of lawful actions, and "file it anyway" is not among them.
//
// The property under test is the refusal, not the happy path: before this,
// `ship` checked nothing at all and a coordinator could put a merge in front of
// a human on the strength of its own prose summary.

const WS = process.cwd();
const env = (markdown: string, rowCount: number) =>
  JSON.stringify({ markdown, row_count: rowCount });

/** One indexed file and one brand-new (unindexed) one — the blind case. */
function fakeRun(changed: string[]): GitNexusRunner {
  return async (binary, args) => {
    if (binary === "git") {
      if (args.includes("--name-only")) {
        return { stdout: `${changed.join("\n")}\n`, stderr: "" };
      }
      if (args.includes("rev-parse")) return { stdout: "7ed0bbdCAFE\n", stderr: "" };
      return {
        stdout: changed
          .map((path) => `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -10,2 +10,4 @@`)
          .join("\n"),
        stderr: "",
      };
    }
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
        // Only src/gate.ts resolves; anything else in `changed` stays BLIND.
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
        stdout: env(
          "| file | name | kind | startLine | endLine |\n| --- |\n| src/gate.ts | redeemGate | Function | 8 | 20 |",
          1
        ),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
}

function reviewDiffTool(
  reviewLedger: ReviewDiffLedger,
  changed = ["src/gate.ts"]
) {
  return createGitNexusToolDefinitions({
    workspacePath: WS,
    binary: "/fake/node",
    run: fakeRun(changed),
    reviewLedger,
  }).find((tool) => tool.name === "review_diff")!;
}

function shipTool(reviewLedger: ReviewDiffLedger, client: MuonApiClient) {
  const tool = createOrchestratorToolDefinitions(client, {
    jobId: "job-root",
    delegationToken: "root-job-token",
    chatId: "chat-1",
    chatTaskId: "task-shadow",
    apiBase: "http://localhost:4000",
    reviewLedger,
  }).find((entry) => entry.name === "ship");
  if (!tool) throw new Error("ship not found");
  return tool;
}

function approvalClient() {
  return {
    requestApproval: vi.fn(async () => ({
      id: "approval-merge-1",
      kind: "merge",
      status: "pending",
    })),
  } as unknown as MuonApiClient;
}

describe("A4: review_diff stamps a stable id and records what it proved", () => {
  it("returns a 24-hex reviewDiff.id and records the verdict for the session", async () => {
    const ledger = createReviewDiffLedger();
    const result = await reviewDiffTool(ledger).handler({ scope: "all" });
    const payload = result.structuredContent as {
      reviewDiff: { id: string; verdict: string };
    };
    expect(payload.reviewDiff.id).toMatch(/^[0-9a-f]{24}$/);
    // Recorded under the caller's OWN-TREE key, because no taskId was named.
    const record = ledger.get(reviewDiffKey({ workspacePath: WS }));
    expect(record).toMatchObject({
      id: payload.reviewDiff.id,
      verdict: "flows-resolved",
    });
  });

  it("derives the id from the evidence, so the same diff answers with the same id", async () => {
    const ledger = createReviewDiffLedger();
    const first = await reviewDiffTool(ledger).handler({ scope: "all" });
    const second = await reviewDiffTool(ledger).handler({ scope: "all" });
    const idOf = (r: typeof first) =>
      (r.structuredContent as { reviewDiff: { id: string } }).reviewDiff.id;
    expect(idOf(first)).toBe(idOf(second));
    // …and a DIFFERENT change is a different id, so an id can never be quoted
    // as evidence for a diff it does not describe.
    const other = await reviewDiffTool(ledger, [
      "src/gate.ts",
      "src/new.ts",
    ]).handler({ scope: "all" });
    expect(idOf(other)).not.toBe(idOf(first));
  });

  it("records a sibling-task review under that task, not under the caller's tree", async () => {
    const ledger = createReviewDiffLedger();
    const tool = createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: fakeRun(["src/gate.ts"]),
      reviewLedger: ledger,
      fetchTaskDiff: async () => ({
        status: "ok" as const,
        changedFiles: ["src/gate.ts"],
        diff: { text: "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@", truncated: false },
        baseCommit: "7ed0bbdCAFE",
      }),
    }).find((entry) => entry.name === "review_diff")!;
    await tool.handler({ taskId: "task-impl" });
    expect(ledger.has(reviewDiffKey({ taskId: "task-impl" }))).toBe(true);
    expect(ledger.has(reviewDiffKey({ workspacePath: WS }))).toBe(false);
  });
});

describe("A4: ship refuses without current review evidence", () => {
  it("refuses when this session has run no review_diff for the task, and names the exact call", async () => {
    const client = approvalClient();
    const result = await shipTool(createReviewDiffLedger(), client).handler({
      taskId: "task-impl",
      summary: "did the thing",
    });
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as {
      error: string;
      _muon: { refusal?: { rule: string; nextAction?: { command?: string } } };
    };
    expect(payload._muon.refusal?.rule).toBe("ship.review_unavailable");
    // A prose warning is what this replaces: the refusal must carry the CALL.
    expect(payload._muon.refusal?.nextAction?.command).toBe(
      'review_diff({ taskId: "task-impl" })'
    );
    expect(payload.error).toContain('review_diff({ taskId: "task-impl" })');
    // And nothing may reach the human's inbox on the way to being refused.
    expect(client.requestApproval).not.toHaveBeenCalled();
  });

  it("a review of the caller's OWN tree does not satisfy a ship of a sibling task", async () => {
    // The dangerous near-miss: evidence about one worktree certifying another.
    // There is deliberately no workspace fallback in the ship lookup.
    const ledger = createReviewDiffLedger();
    await reviewDiffTool(ledger).handler({ scope: "all" });
    const client = approvalClient();
    const result = await shipTool(ledger, client).handler({
      taskId: "task-impl",
      summary: "did the thing",
    });
    expect(result.isError).toBe(true);
    expect(client.requestApproval).not.toHaveBeenCalled();
  });

  it("files the gate after a clean review, and records the review id ON the approval", async () => {
    const ledger = createReviewDiffLedger();
    ledger.set(reviewDiffKey({ taskId: "task-impl" }), {
      id: "abc123abc123abc123abc123",
      verdict: "flows-resolved",
      at: Date.parse("2026-08-17T10:00:00.000Z"),
      blindFiles: [],
      citedNoteIds: ["mem-r1", "mem-r2"],
    });
    const client = approvalClient();
    const result = await shipTool(ledger, client).handler({
      taskId: "task-impl",
      summary: "did the thing",
    });
    expect(result.isError).toBeFalsy();
    const filed = (client.requestApproval as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    expect(filed.kind).toBe("merge");
    expect(filed.evidence.details.reviewDiffId).toBe("abc123abc123abc123abc123");
    expect(filed.evidence.details.reviewVerdict).toBe("flows-resolved");
    // ADR-0065: the reviewer's structured citations ride the gate evidence.
    expect(filed.evidence.details.citedNoteIds).toBe('["mem-r1","mem-r2"]');
    // The honesty rail: a passed preflight is NOT a certification, and the
    // tool must not let a coordinator report it as one.
    expect(filed.evidence.details.preflight).toMatch(
      /certification at approval time is the authority/
    );
    const payload = result.structuredContent as {
      _muon: { nextActions: string[] };
    };
    expect(payload._muon.nextActions.join(" ")).toMatch(/not as 'certified'/);
  });

  it("a no-op review does NOT count — an empty-diff verdict is the cheapest costume", async () => {
    // Adversarial finding 4: review_diff records on EVERY success, including
    // the empty-diff branch — so a review run BEFORE the worker wrote
    // anything wore a "reviewed" badge for a tree that no longer exists.
    // A no-op verdict now refuses with the exact re-run to perform; a task
    // with genuinely nothing changed has nothing to merge either.
    const ledger = createReviewDiffLedger();
    ledger.set(reviewDiffKey({ taskId: "task-impl" }), {
      id: "0".repeat(24),
      verdict: "no-op",
      at: Date.now(),
      blindFiles: [],
      citedNoteIds: [],
    });
    const client = approvalClient();
    const result = await shipTool(ledger, client).handler({
      taskId: "task-impl",
      summary: "nothing to do",
    });
    expect(result.isError).toBe(true);
    expect(client.requestApproval).not.toHaveBeenCalled();
    expect(String(result.content[0]!.text)).toMatch(/EMPTY diff|no-op/);
  });
});

describe("A6: REVIEW BLIND names its recovery and never offers a merge", () => {
  it("review_diff's blind payload lists the blind files and the three lawful actions", async () => {
    const ledger = createReviewDiffLedger();
    const result = await reviewDiffTool(ledger, [
      "src/gate.ts",
      "src/new.ts",
    ]).handler({ scope: "all" });
    const payload = result.structuredContent as {
      reviewDiff: { verdict: string };
      recovery: { blindFiles: string[]; blindFilesOmitted: number; nextActions: string[] };
    };
    expect(payload.reviewDiff.verdict).toBe("review-blind");
    expect(payload.recovery.blindFiles).toEqual(["src/new.ts"]);
    expect(payload.recovery.blindFilesOmitted).toBe(0);
    // (a) re-index — named as the command this repo actually uses, not a
    // generic "reindex"; (b) bound the diff; (c) the OPERATOR attest path.
    const actions = payload.recovery.nextActions.join(" ");
    expect(actions).toContain("gitnexus analyze --index-only");
    expect(actions).toMatch(/re-run review_diff/);
    expect(actions).toMatch(/manual review attestation/);
    expect(actions).toMatch(/operator tier/);
    // The one thing a recovery list must never offer: a way to merge anyway.
    // "The orchestrator must never be told it can file merge while blind."
    expect(actions).not.toMatch(
      /file the merge anyway|proceed with the merge|approve the merge|ship anyway/i
    );
    expect(actions).toMatch(/cannot file the merge while blind/);
  });

  it("ship refuses a blind verdict with counts only — never the blind path list", async () => {
    const ledger = createReviewDiffLedger();
    ledger.set(reviewDiffKey({ taskId: "task-impl" }), {
      id: "b".repeat(24),
      verdict: "review-blind",
      at: Date.now(),
      citedNoteIds: [],
      blindFiles: ["src/secret/new.ts"],
    });
    const client = approvalClient();
    const result = await shipTool(ledger, client).handler({
      taskId: "task-impl",
      summary: "shipping anyway",
    });
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as {
      _muon: { refusal?: { rule: string; evidence: { label: string; value: unknown }[] }; nextActions: string[] };
    };
    expect(payload._muon.refusal?.rule).toBe("ship.review_blind");
    expect(client.requestApproval).not.toHaveBeenCalled();
    // ADR-0033: `ship.review_blind` publishes blindFiles to the AGENT as a
    // COUNT — a blind-file list is a workspace path set and is operator-only.
    expect(payload._muon.refusal?.evidence).toContainEqual({
      label: "blindFiles",
      value: 1,
    });
    expect(JSON.stringify(result)).not.toContain("src/secret/new.ts");
    // The same three recovery actions review_diff printed, from one source.
    expect(payload._muon.nextActions).toEqual(blindRecoveryActions("task-impl"));
  });
});

// An index MUON could not MEASURE is not a review. End-to-end through both real
// handlers and the real session ledger: before the fix the unmeasurable arm
// recorded `flows-resolved`, so `ship` filed a merge gate for a task whose
// evidence nobody had verified against any commit.
describe("an UNMEASURABLE index cannot become a review ship accepts", () => {
  /** A store whose `list` block carries no `Commit:` line: the indexed commit
   *  cannot be read, so freshness is UNKNOWN rather than current. */
  const noCommitRun = (): GitNexusRunner => {
    const base = fakeRun(["src/gate.ts"]);
    return async (binary, args, options) => {
      if (binary !== "git" && args.includes("list")) {
        return {
          stdout: `\n  Indexed Repositories (1)\n\n  muon\n    Path:    ${WS}\n    Indexed: now\n`,
          stderr: "",
        };
      }
      return base(binary, args, options);
    };
  };

  it("review_diff records review-blind, and ship refuses to file the gate", async () => {
    const ledger = createReviewDiffLedger();
    const reviewTool = createGitNexusToolDefinitions({
      workspacePath: WS,
      binary: "/fake/node",
      run: noCommitRun(),
      reviewLedger: ledger,
      fetchTaskDiff: async () => ({
        status: "ok" as const,
        changedFiles: ["src/gate.ts"],
        diff: {
          text: "diff --git a/src/gate.ts b/src/gate.ts\n+++ b/src/gate.ts\n@@ -10,2 +10,4 @@",
          truncated: false,
          totalBytes: 96,
        },
        baseCommit: "7ed0bbdCAFE",
      }),
    }).find((entry) => entry.name === "review_diff")!;
    const reviewed = await reviewTool.handler({ taskId: "task-impl" });
    expect(reviewed.isError, JSON.stringify(reviewed)).toBeFalsy();
    const payload = reviewed.structuredContent as {
      reviewDiff: {
        verdict: string;
        indexFreshness: { stale: boolean | null };
      };
    };
    // Every changed file resolved and no diff was truncated, so the ONLY reason
    // this cannot be certified is the index nobody could measure.
    expect(payload.reviewDiff.indexFreshness.stale).toBeNull();
    expect(payload.reviewDiff.verdict).toBe("review-blind");
    expect(ledger.get(reviewDiffKey({ taskId: "task-impl" }))?.verdict).toBe(
      "review-blind"
    );

    const client = approvalClient();
    const shipped = await shipTool(ledger, client).handler({
      taskId: "task-impl",
      summary: "shipping on an index nobody measured",
    });
    expect(shipped.isError).toBe(true);
    // Nothing reaches the human's inbox on the strength of an unmeasured look.
    expect(client.requestApproval).not.toHaveBeenCalled();
    expect(
      (
        shipped.structuredContent as {
          _muon: { refusal?: { rule: string } };
        }
      )._muon.refusal?.rule
    ).toBe("ship.review_blind");
  });
});

describe("A4: the id is computed from evidence, never supplied", () => {
  it("changes when any evidence field changes, and is stable otherwise", () => {
    const base = {
      scope: "all",
      verdict: "flows-resolved",
      changedFiles: ["b.ts", "a.ts"],
      graphCommit: "7ed0bbd",
    };
    const id = computeReviewDiffId(base);
    // Sorted internally: git's ordering must not change the id.
    expect(computeReviewDiffId({ ...base, changedFiles: ["a.ts", "b.ts"] })).toBe(id);
    expect(computeReviewDiffId({ ...base, verdict: "review-blind" })).not.toBe(id);
    expect(computeReviewDiffId({ ...base, graphCommit: "deadbee" })).not.toBe(id);
    expect(computeReviewDiffId({ ...base, baseRef: "main" })).not.toBe(id);
  });
});
