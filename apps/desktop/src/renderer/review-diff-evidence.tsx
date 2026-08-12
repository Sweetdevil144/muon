import type { JobTree, ReviewDiffResponse } from "../shared/ipc.js";
import { summarizeReviewDiff } from "./lib/review-diff-summary.js";

// ROADMAP 4.1b — the governance wedge made visible. Instead of a prettier diff,
// the review lane shows what the change BREAKS (affected execution flows) and
// refuses to call an unindexed/stale change clean (the fail-closed REVIEW-BLIND
// panel, staleness-aware). Presentational only; all logic is in the pure
// summarizeReviewDiff.

const BLIND_TITLE: Record<string, string> = {
  unindexed: "Review blind — workspace not indexed",
  stale: "Review blind — code graph is stale",
  "new-files": "Review blind — new code the graph can't map",
};

/**
 * WHICH tree the verdict above was computed from. A worktree-backed job edits an
 * isolated checkout, so a verdict with no tree named is a verdict a human cannot
 * check. Rendered as one quiet caption line, never as a warning: reading the
 * right tree is the normal case.
 */
function ReviewDiffTree(props: { tree: JobTree }) {
  return (
    <p className="review-diff-tree" title={props.tree.path}>
      {props.tree.kind === "worktree"
        ? `Read from this task's isolated worktree · ${props.tree.path}`
        : `Read from the workspace checkout · ${props.tree.path}`}
    </p>
  );
}

export function ReviewDiffEvidence(props: {
  review: ReviewDiffResponse | null;
  loading: boolean;
  /**
   * Is the raw diff below actually going to render? When the job's tree could
   * not be resolved at all, BOTH reads degrade — and pointing at a raw diff that
   * is not there would be the same false reassurance this panel exists to stop.
   * Defaults to true so every existing render keeps today's copy.
   */
  rawDiffAvailable?: boolean;
}) {
  if (props.loading && !props.review) {
    return (
      <p className="session-empty loading-line">
        Mapping the change to affected execution flows…
      </p>
    );
  }
  if (!props.review) return null;
  if (props.review.status === "degraded") {
    return (
      <article className="review-diff-evidence degraded">
        <strong>Impact evidence unavailable</strong>
        <p>{props.review.reason}</p>
        {props.review.action ? <p>{props.review.action}</p> : null}
        {props.rawDiffAvailable ?? true ? (
          <p className="review-diff-fallback">Showing the raw diff below.</p>
        ) : null}
      </article>
    );
  }

  const summary = summarizeReviewDiff(props.review.impact);
  return (
    <article className={`review-diff-evidence tone-${summary.chip.tone}`}>
      <header className="review-diff-head">
        <span className={`review-verdict-chip ${summary.chip.tone}`}>
          {summary.chip.label}
        </span>
        <span className="review-diff-headline">{summary.headline}</span>
      </header>

      <ReviewDiffTree tree={props.review.tree} />

      {summary.blind ? (
        <div className={`review-blind-panel ${summary.blind.reason}`}>
          <strong>{BLIND_TITLE[summary.blind.reason]}</strong>
          <p>{summary.blind.message}</p>
          {summary.blind.files.length > 0 ? (
            <ul className="review-blind-files">
              {summary.blind.files.slice(0, 20).map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
              {summary.blind.files.length > 20 ? (
                <li className="review-blind-more">
                  …and {summary.blind.files.length - 20} more
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {summary.affectedProcesses.length > 0 ? (
        <div className="review-flows">
          <strong>Affected execution flows — verify each</strong>
          <ul>
            {summary.affectedProcesses.map((process) => (
              <li key={process.processId}>
                <code>{process.process}</code>
                <span className="review-flow-steps">
                  step{process.steps.length === 1 ? "" : "s"}{" "}
                  {process.steps.join(", ")}
                </span>
                {process.via.length > 0 ? (
                  <span className="review-flow-via">
                    via {process.via.slice(0, 4).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
