import type { ObjectiveLoopControl } from "@muon/client";

/**
 * P9 — live objective loop status above the mission composer.
 *
 * Shows iteration/max, evaluator `missing:` (control state only — never memory),
 * and stop/resume affordances wired to governed IPC.
 */
export function ObjectiveLoopStatusBar(props: {
  status: ObjectiveLoopControl | null;
  busy?: boolean;
  onStop?: () => Promise<void>;
  onResume?: () => Promise<void>;
}) {
  if (!props.status) {
    return null;
  }
  const { status } = props;
  const showStop = status.canStop && typeof props.onStop === "function";
  const showResume = status.canResume && typeof props.onResume === "function";

  return (
    <div
      className="objective-loop-status"
      role="status"
      aria-label="Objective loop status"
    >
      <div className="objective-loop-status-copy">
        <strong>{status.kind}</strong>
        <span>
          {status.status === "running"
            ? `iteration ${status.iteration}/${status.maxIterations}`
            : `${status.status} · ${status.iteration}/${status.maxIterations}`}
        </span>
        {status.missing ? (
          <span className="objective-loop-missing" title="Evaluator control state only">
            missing: {status.missing}
          </span>
        ) : null}
        {status.degraded ? (
          <span className="objective-loop-degraded">{status.degraded}</span>
        ) : null}
        {status.stopReason ? (
          <span className="objective-loop-stop-reason">{status.stopReason}</span>
        ) : null}
        {status.resumeBlockedReason && !showResume ? (
          <span className="objective-loop-note">{status.resumeBlockedReason}</span>
        ) : null}
      </div>
      <div className="objective-loop-status-actions">
        {showStop ? (
          <button
            type="button"
            className="ghost-btn objective-loop-stop"
            disabled={props.busy}
            onClick={() => void props.onStop?.()}
          >
            {props.busy ? "Stopping…" : "Stop loop"}
          </button>
        ) : null}
        {showResume ? (
          <button
            type="button"
            className="ghost-btn objective-loop-resume"
            disabled={props.busy}
            onClick={() => void props.onResume?.()}
          >
            {props.busy ? "Resuming…" : "Resume loop"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
