import type { DiffImpact } from "@muon/client/diff-impact";

// Pure display projection for the governed-evidence review lane (ROADMAP 4.1b).
// Turns a DiffImpact into what the Changes tab renders — crucially, it makes the
// REVIEW-BLIND verdict STALENESS-AWARE: a fresh user whose index is behind (or
// absent) must NOT read the same alarm as genuinely-new files. Kept pure so the
// three-way blind distinction is unit-tested without a DOM.

export type ReviewDiffChipTone = "clear" | "blind" | "neutral";

export type ReviewDiffBlindReason = "unindexed" | "stale" | "new-files";

export type ReviewDiffSummary = {
  chip: { label: string; tone: ReviewDiffChipTone };
  /** One-line headline, e.g. "3 files → 2 flows affected". */
  headline: string;
  /** Present only when the verdict is review-blind. */
  blind: {
    reason: ReviewDiffBlindReason;
    message: string;
    files: string[];
    /** A reindex would clear it (stale/unindexed) vs it is genuinely new code. */
    canReindex: boolean;
  } | null;
  affectedProcesses: DiffImpact["affectedProcesses"];
};

function shortSha(sha: string | undefined): string {
  return (sha ?? "").slice(0, 7) || "unknown";
}

export function summarizeReviewDiff(impact: DiffImpact): ReviewDiffSummary {
  const { totals, verdict, indexFreshness } = impact;
  const flows = totals.affectedProcesses;
  const files = totals.changedFiles;

  if (verdict === "no-op") {
    return {
      chip: { label: "No changes", tone: "neutral" },
      headline: "No changed files to review.",
      blind: null,
      affectedProcesses: [],
    };
  }

  if (verdict === "flows-resolved") {
    return {
      chip: { label: "Reviewed", tone: "clear" },
      headline:
        flows > 0
          ? `${files} file${files === 1 ? "" : "s"} → ${flows} execution flow${flows === 1 ? "" : "s"} affected`
          : `${files} file${files === 1 ? "" : "s"} changed → no execution flow affected`,
      blind: null,
      affectedProcesses: impact.affectedProcesses,
    };
  }

  // review-blind — distinguish WHY, so it doesn't cry wolf on a stale/absent index.
  const blindCount = totals.blindFiles;
  let reason: ReviewDiffBlindReason;
  let message: string;
  let canReindex: boolean;
  if (!indexFreshness.graphCommit) {
    reason = "unindexed";
    message = `This workspace isn't indexed yet — ${blindCount} changed file${blindCount === 1 ? "" : "s"} can't be checked against the graph. Index it to review them.`;
    canReindex = true;
  } else if (indexFreshness.stale) {
    reason = "stale";
    message = `The code graph is behind HEAD (indexed ${shortSha(indexFreshness.graphCommit)} vs ${shortSha(indexFreshness.headCommit)}) — ${blindCount} file${blindCount === 1 ? "" : "s"} unreviewed until you re-index.`;
    canReindex = true;
  } else {
    reason = "new-files";
    message = `${blindCount} new/unindexed file${blindCount === 1 ? "" : "s"} — the graph can't map their flows. Review them manually; "0 flows affected" is not a pass when files are blind.`;
    canReindex = false;
  }

  return {
    chip: { label: "Review blind", tone: "blind" },
    headline:
      flows > 0
        ? `${files} files → ${flows} flow${flows === 1 ? "" : "s"} (coverage INCOMPLETE)`
        : `${files} files → coverage INCOMPLETE`,
    blind: { reason, message, files: impact.blindFiles, canReindex },
    affectedProcesses: impact.affectedProcesses,
  };
}
