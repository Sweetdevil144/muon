import { describe, expect, it } from "vitest";
import type { DiffImpact } from "@muon/client/diff-impact";
import { summarizeReviewDiff } from "../src/renderer/lib/review-diff-summary.js";

const impact = (over: Partial<DiffImpact> = {}): DiffImpact => ({
  scope: "all",
  totals: { changedFiles: 3, resolvedFiles: 3, blindFiles: 0, changedSymbols: 5, affectedProcesses: 2 },
  blindFiles: [],
  changedSymbols: [],
  affectedProcesses: [
    { process: "RedeemGateAtRoute", processId: "p1", steps: [3], via: ["redeemGate"] },
  ],
  coverage: 1,
  indexFreshness: { graphCommit: "abc1234", headCommit: "abc1234", stale: false },
  verdict: "flows-resolved",
  notes: [],
  ...over,
});

describe("summarizeReviewDiff", () => {
  it("flows-resolved → clear chip + files→flows headline", () => {
    const s = summarizeReviewDiff(impact());
    expect(s.chip.tone).toBe("clear");
    expect(s.headline).toMatch(/3 files → 2 execution flows affected/);
    expect(s.blind).toBeNull();
    expect(s.affectedProcesses).toHaveLength(1);
  });

  it("no-op → neutral chip", () => {
    const s = summarizeReviewDiff(
      impact({ verdict: "no-op", totals: { changedFiles: 0, resolvedFiles: 0, blindFiles: 0, changedSymbols: 0, affectedProcesses: 0 } })
    );
    expect(s.chip.tone).toBe("neutral");
    expect(s.blind).toBeNull();
  });

  // The critic's rider: the three blind reasons must be DISTINCT so a fresh/stale
  // index does not read like genuinely-new code.
  it("review-blind + no graphCommit → UNINDEXED (reindexable)", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 3, resolvedFiles: 0, blindFiles: 3, changedSymbols: 0, affectedProcesses: 0 },
        blindFiles: ["a.ts", "b.ts", "c.ts"],
        indexFreshness: { graphCommit: undefined, headCommit: "abc", stale: false },
      })
    );
    expect(s.chip.tone).toBe("blind");
    expect(s.blind?.reason).toBe("unindexed");
    expect(s.blind?.canReindex).toBe(true);
    expect(s.blind?.message).toMatch(/isn't indexed/i);
  });

  it("review-blind + stale index → STALE (reindexable), not 'new files'", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 2, resolvedFiles: 2, blindFiles: 0, changedSymbols: 4, affectedProcesses: 0 },
        indexFreshness: { graphCommit: "old1234", headCommit: "new5678", stale: true },
      })
    );
    expect(s.blind?.reason).toBe("stale");
    expect(s.blind?.canReindex).toBe(true);
    expect(s.blind?.message).toMatch(/behind HEAD|re-index/i);
  });

  it("review-blind + fresh index + new files → NEW-FILES (manual review, not reindexable)", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 2, resolvedFiles: 1, blindFiles: 1, changedSymbols: 3, affectedProcesses: 1 },
        blindFiles: ["src/brand-new.ts"],
        indexFreshness: { graphCommit: "abc1234", headCommit: "abc1234", stale: false },
      })
    );
    expect(s.blind?.reason).toBe("new-files");
    expect(s.blind?.canReindex).toBe(false);
    expect(s.blind?.message).toMatch(/not a pass when files are blind/i);
  });
});
