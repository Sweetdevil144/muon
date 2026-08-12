// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDiffEvidence } from "../src/renderer/review-diff-evidence.js";
import type { ReviewDiffResponse } from "../src/shared/ipc.js";
import type { DiffImpact } from "@muon/client/diff-impact";

// The impact panel is the headline review surface, and a verdict a human cannot
// locate is a verdict they cannot check. A worktree-backed job edits an isolated
// checkout, so the panel names WHICH tree the verdict came from — quietly, in
// the normal case as well as the surprising one.

afterEach(cleanup);

const impact: DiffImpact = {
  scope: "all",
  totals: {
    changedFiles: 1,
    resolvedFiles: 1,
    blindFiles: 0,
    changedSymbols: 1,
    affectedProcesses: 1,
  },
  blindFiles: [],
  changedSymbols: [{ file: "src/gate.ts", name: "redeemGate", kind: "Function" }],
  affectedProcesses: [
    {
      process: "RedeemGateAtRoute",
      processId: "proc_1",
      steps: [3],
      via: ["redeemGate"],
    },
  ],
  coverage: 1,
  verdict: "flows-resolved",
  notes: [],
  indexFreshness: { stale: false },
} as unknown as DiffImpact;

const WORKTREE = "/repo/.muon/worktrees/task-7";

describe("ReviewDiffEvidence — which tree the verdict came from", () => {
  it("names the task's isolated worktree when that is what was read", () => {
    const review: ReviewDiffResponse = {
      status: "ok",
      impact,
      tree: { kind: "worktree", path: WORKTREE, taskId: "task-7" },
    };
    render(<ReviewDiffEvidence review={review} loading={false} />);

    expect(
      screen.getByText(new RegExp(`isolated worktree · ${WORKTREE}`))
    ).toBeTruthy();
  });

  it("names the workspace checkout for a job that ran there", () => {
    const review: ReviewDiffResponse = {
      status: "ok",
      impact,
      tree: { kind: "workspace", path: "/repo" },
    };
    render(<ReviewDiffEvidence review={review} loading={false} />);

    expect(screen.getByText(/workspace checkout · \/repo/)).toBeTruthy();
    expect(screen.queryByText(/isolated worktree/)).toBeNull();
  });

  it("renders the unresolvable-tree state as a reason, never as a clean verdict", () => {
    const review: ReviewDiffResponse = {
      status: "degraded",
      reason: `This dispatch ran in the isolated worktree '${WORKTREE}', which is not on disk now.`,
      action:
        "A merged or pruned worktree is removed after it lands. Review the landed commit on the branch, or re-dispatch to rebuild it.",
    };
    render(
      <ReviewDiffEvidence
        review={review}
        loading={false}
        rawDiffAvailable={false}
      />
    );

    expect(screen.getByText("Impact evidence unavailable")).toBeTruthy();
    expect(screen.getByText(new RegExp(WORKTREE))).toBeTruthy();
    expect(screen.getByText(/merged or pruned worktree/i)).toBeTruthy();
    // No verdict chip, and no promise of a raw diff that also failed to load.
    expect(document.querySelector(".review-verdict-chip")).toBeNull();
    expect(screen.queryByText("Showing the raw diff below.")).toBeNull();
  });

  it("still points at the raw diff when only the impact map failed", () => {
    const review: ReviewDiffResponse = {
      status: "degraded",
      reason: "Could not compute review evidence: the index is missing.",
    };
    render(<ReviewDiffEvidence review={review} loading={false} />);

    expect(screen.getByText("Showing the raw diff below.")).toBeTruthy();
  });

  it("has a loading state rather than a blank panel", () => {
    render(<ReviewDiffEvidence review={null} loading />);
    expect(
      screen.getByText("Mapping the change to affected execution flows…")
    ).toBeTruthy();
  });
});
