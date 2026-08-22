import { useCallback, useEffect, useState } from "react";
import type { ReviewThreadDigest, ReviewThreadTarget } from "../shared/ipc.js";
import {
  summarizeReviewDigest,
  type ReviewDigestSummary,
} from "./lib/review-digest.js";

/**
 * H1 — "since you last looked", at the top of the review dock.
 *
 * Opening a review used to be archaeology: the dock showed the full dump every
 * time, and "what changed since I last looked" lived in the operator's memory
 * (the old seen-set was a React ref that died on reload). This strip is the
 * bounded answer, and its rules are the point of the feature:
 *
 *  * OPENING NEVER ADVANCES THE CURSOR. Mounting this component reads and only
 *    reads. That is what makes closing without deciding leave the thread bound
 *    — the next open resumes the SAME digest instead of starting over.
 *  * The cursor moves on exactly two acts: a merge DECISION (the parent wires
 *    that after the governed resolve succeeds) and the explicit "Mark reviewed"
 *    button below. Both are things a human did on purpose.
 *  * IDS ARE THE EVIDENCE. Packet / gate / question ids are listed verbatim;
 *    no agent prose is shown here, because a paraphrase of a claim is not proof
 *    of the claim.
 *
 * Every state is named: reading, unreadable (with the reason and a retry),
 * unavailable-on-this-build, no bound thread, and an empty delta. None of them
 * is a blank strip.
 */

export type ReviewDigestStripProps = {
  /** The thread the dock is showing, or null when nothing is bound. */
  target: ReviewThreadTarget | null;
  /**
   * The ONE read leg. `undefined` = a preload older than the bound review
   * thread; the strip says exactly that rather than rendering an empty delta,
   * which would be a false "nothing changed".
   */
  read?: (input: ReviewThreadTarget) => Promise<ReviewThreadDigest>;
  /**
   * The ONE advance leg. `undefined` hides the acknowledge button.
   *
   * `digestAt` is the timestamp of the digest THIS STRIP RENDERED FROM, echoed
   * straight back. The cursor stamps that moment instead of the server's now,
   * so a packet filed while the operator was reading is not marked seen by an
   * acknowledge of a digest that never contained it.
   */
  advance?: (
    input: ReviewThreadTarget & { digestAt?: string }
  ) => Promise<{ lastLookedAt: string }>;
  /**
   * Bumped by the parent when something ELSE advanced the cursor (a merge
   * decision), so the strip re-reads and shows the shrunk delta.
   */
  refreshKey?: number;
  /** Fired after this strip's own advance succeeds. */
  onAdvanced?: () => void;
};

function IdList(props: { label: string; ids: string[] }) {
  if (props.ids.length === 0) return null;
  return (
    <p className="review-digest-ids">
      <span>{props.label}</span>
      {props.ids.map((id) => (
        <code key={id}>{id}</code>
      ))}
    </p>
  );
}

export function ReviewDigestStrip(props: ReviewDigestStripProps) {
  const { target, read, advance, onAdvanced } = props;
  const targetKind = target?.targetKind ?? null;
  const targetId = target?.targetId ?? null;
  // The thread a loaded/failed result is ABOUT, carried WITH the result.
  //
  // Untagged, this strip would show the previous mission's delta under the new
  // mission's name for as long as the new read takes: the operator switches
  // chats, the target changes, and the old summary is still on screen claiming
  // to describe the thread now in front of them. Same trap `MissionCapState`
  // documents for the cap. Everything below renders only when the tag matches.
  const key = targetKind && targetId ? `${targetKind}:${targetId}` : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    summary: ReviewDigestSummary;
  } | null>(null);
  const [failed, setFailed] = useState<{ key: string; reason: string } | null>(
    null
  );
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const summary = loaded && loaded.key === key ? loaded.summary : null;
  const error = failed && failed.key === key ? failed.reason : null;
  // The read stamp of the digest ON SCREEN for THIS thread — the value the
  // acknowledge echoes back. Hoisted out of the callback's dep list because it
  // must be the summary tagged for the current key, never a stale thread's.
  const renderedDigestAt = summary?.digestAt;

  useEffect(() => {
    if (!key || !targetKind || !targetId || !read) return;
    let active = true;
    setMarkError(null);
    // READ ONLY. There is deliberately no advance call anywhere in this effect:
    // an advance on open would silently consume the delta the operator came
    // here to see, and would make "I closed it without deciding" indistinguishable
    // from "I reviewed it".
    void read({ targetKind, targetId })
      .then((digest) => {
        if (!active) return;
        setLoaded({ key, summary: summarizeReviewDigest(digest) });
        setFailed((current) => (current?.key === key ? null : current));
      })
      .catch((failure) => {
        if (!active) return;
        // A digest that could not be READ is not an empty digest. Say which,
        // and drop any stale summary for this thread rather than leaving a
        // count on screen that the failed read cannot vouch for.
        setLoaded((current) => (current?.key === key ? null : current));
        setFailed({
          key,
          reason:
            failure instanceof Error && failure.message.trim().length > 0
              ? failure.message
              : "Could not read what changed since you last looked.",
        });
      });
    return () => {
      active = false;
    };
  }, [key, targetKind, targetId, read, props.refreshKey, retry]);

  const markReviewed = useCallback(() => {
    if (!targetKind || !targetId || !advance || marking) return;
    setMarking(true);
    setMarkError(null);
    // The digest ON SCREEN is what the operator is acknowledging, so its read
    // stamp — not the click's — is the cursor.
    void advance({
      targetKind,
      targetId,
      ...(renderedDigestAt ? { digestAt: renderedDigestAt } : {}),
    })
      .then(() => {
        // Re-read so the strip shows the delta the operator just consumed
        // being consumed, rather than a stale count.
        setRetry((count) => count + 1);
        onAdvanced?.();
      })
      .catch((failure) => {
        setMarkError(
          failure instanceof Error && failure.message.trim().length > 0
            ? failure.message
            : "Could not mark this thread reviewed."
        );
      })
      .finally(() => setMarking(false));
  }, [targetKind, targetId, advance, marking, onAdvanced, renderedDigestAt]);

  const body = () => {
    if (!targetKind || !targetId) {
      return (
        <p className="right-panel-empty">
          No mission is bound to this dock yet, so there is no review thread to
          bound.
        </p>
      );
    }
    if (!read) {
      return (
        <p className="right-panel-empty">
          This build cannot read the bound review thread. Restart MUON; if it
          persists, update the app. Nothing is hidden — the full inbox below is
          unaffected.
        </p>
      );
    }
    if (!summary && !error) {
      // No result is tagged for THIS thread yet — either the first read is in
      // flight or the operator just switched missions. Both are honestly
      // "reading", and neither may show the previous thread's counts.
      return (
        <p className="right-panel-empty loading-line">
          Reading what changed since you last looked…
        </p>
      );
    }
    if (error) {
      return (
        <div className="right-panel-callout degraded" role="alert">
          <strong>Could not read this review thread</strong>
          <p>{error}</p>
          <p>
            This is an outage, not an all-clear. It does not mean nothing
            changed.
          </p>
          <div className="merge-actions">
            <button
              type="button"
              className="ghost-btn"
              data-review-look="retry"
              onClick={() => setRetry((count) => count + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    if (!summary) return null;
    return (
      <>
        <p
          className={
            // H2 rank: a packet that declared itself degraded AND one whose
            // evidence could not be read both sit at attention rank. Only a
            // delta of packets that actually vouched for themselves is quiet.
            summary.degradedPackets > 0 || summary.unknownPackets > 0
              ? "review-digest-headline degraded"
              : "review-digest-headline"
          }
        >
          {summary.headline}
        </p>
        {summary.neverLooked && !summary.empty ? (
          <p className="right-panel-bound">
            You have not marked this thread reviewed yet, so this is everything
            on the ledger for it.
          </p>
        ) : null}
        <IdList label="packets" ids={summary.packetIds} />
        <IdList label="gates" ids={summary.gateIds} />
        <IdList label="open questions" ids={summary.questionIds} />
        {summary.truncated ? (
          <p className="right-panel-bound">
            The brain capped this digest, so the counts above are a floor, not a
            total.
          </p>
        ) : null}
        {markError ? (
          <p className="ship-gate-block" role="alert">
            {markError}
          </p>
        ) : null}
      </>
    );
  };

  const canMark = Boolean(
    targetKind && targetId && advance && summary && !(summary.empty && !summary.neverLooked)
  );

  return (
    <section className="right-panel-section review-digest-strip">
      <header>
        <strong>Since you last looked</strong>
        <span>bound review thread</span>
      </header>
      <div aria-live="polite">{body()}</div>
      {canMark ? (
        <div className="merge-actions">
          <button
            type="button"
            className="ghost-btn"
            data-review-look="mark"
            disabled={marking}
            onClick={markReviewed}
          >
            {marking ? "Marking reviewed…" : "Mark reviewed"}
          </button>
          <span className="right-panel-bound">
            Moves your cursor to the digest above — the one you are looking at,
            not the moment you click, so nothing filed while you read is marked
            seen. It decides nothing, approves nothing, and cannot clear a
            blocker. A packet that declared itself degraded, or that carried a
            degraded flag MUON could not read at all, stays here until a LATER
            packet on that task reads clean. A wrap that declared nothing stays
            while that task has no clean reading to stand on — an earlier clean
            packet is what settles that one, never this button. A gate stays
            until it is decided; a question until it is answered or withdrawn.
            Finishing the task is not one of those acts.
          </span>
        </div>
      ) : null}
    </section>
  );
}
