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

// Traced defect: the desktop builds its OWN IndexFreshness and used to spell
// "could not measure" as `stale: false`, so an unreadable commit pair fell
// through to the new-files arm — a confident, wrong diagnosis on the surface
// that gates a merge, pointing the operator at reviewing files instead of at
// the index.
describe("summarizeReviewDiff — freshness that could not be measured", () => {
  it("does not blame new files for an unreadable index", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 2, resolvedFiles: 2, blindFiles: 0, changedSymbols: 0, affectedProcesses: 0 },
        indexFreshness: { graphCommit: "abc1234", stale: null },
      })
    );
    expect(s.blind?.reason).toBe("unknown-freshness");
    expect(s.blind?.message).not.toMatch(/new\/unindexed/);
    expect(s.blind?.message).toMatch(/could not be read/);
    // Re-indexing IS the remedy here, unlike the new-files arm where it is not.
    expect(s.blind?.canReindex).toBe(true);
  });

  it("names blind files when there are some, without misattributing the cause", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 3, resolvedFiles: 1, blindFiles: 2, changedSymbols: 0, affectedProcesses: 0 },
        indexFreshness: { graphCommit: "abc1234", stale: null },
      })
    );
    expect(s.blind?.reason).toBe("unknown-freshness");
    expect(s.blind?.message).toMatch(/2 files is blind/);
  });

  it("keeps the STALE arm for a freshness that was measured and is behind", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 1, resolvedFiles: 1, blindFiles: 0, changedSymbols: 0, affectedProcesses: 0 },
        indexFreshness: { graphCommit: "abc1234", headCommit: "def5678", stale: true },
      })
    );
    expect(s.blind?.reason).toBe("stale");
  });

  it("keeps the NEW-FILES arm for a measured-current index with blind files", () => {
    const s = summarizeReviewDiff(
      impact({
        verdict: "review-blind",
        totals: { changedFiles: 2, resolvedFiles: 1, blindFiles: 1, changedSymbols: 0, affectedProcesses: 0 },
        indexFreshness: { graphCommit: "abc1234", headCommit: "abc1234", stale: false },
      })
    );
    expect(s.blind?.reason).toBe("new-files");
    expect(s.blind?.canReindex).toBe(false);
  });
});
