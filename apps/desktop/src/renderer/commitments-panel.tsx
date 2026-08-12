import { useMemo, useState } from "react";
import {
  buildAutonomyCommitments,
  type AutonomyCommitment,
} from "@muon/client/autonomy-commitments";
import type { DesktopState } from "../shared/ipc.js";

/**
 * TODO 5.17 — "Nothing runs that you cannot find here."
 *
 * One list for loops, workflows, scheduled turns, and live dispatches.
 * Auto-continue lives in
 * the Orchestration toggle above this panel so the posture is findable here.
 */
export function CommitmentsPanel(props: {
  state: DesktopState | null;
  onPause: (commitment: AutonomyCommitment) => Promise<void>;
  onResume?: (commitment: AutonomyCommitment) => Promise<void>;
}) {
  const commitments = useMemo(
    () =>
      buildAutonomyCommitments({
        loops: props.state?.loopRuns ?? [],
        workflows: props.state?.workflowRuns ?? props.state?.workflowProposals ?? [],
        dispatches: props.state?.dispatchJobs ?? [],
        schedules: props.state?.schedules ?? [],
      }),
    [
      props.state?.loopRuns,
      props.state?.workflowRuns,
      props.state?.workflowProposals,
      props.state?.dispatchJobs,
      props.state?.schedules,
    ]
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoContinue = props.state?.settings?.autoContinue ?? true;
  const active = commitments.filter((c) => c.active);
  const recent = commitments.filter((c) => !c.active).slice(0, 12);

  async function pause(commitment: AutonomyCommitment) {
    setBusyId(commitment.id);
    setBusyAction("pause");
    setError(null);
    try {
      await props.onPause(commitment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pause failed.");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function resume(commitment: AutonomyCommitment) {
    if (!props.onResume) {
      return;
    }
    setBusyId(commitment.id);
    setBusyAction("resume");
    setError(null);
    try {
      await props.onResume(commitment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume failed.");
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  return (
    <div className="updates-panel commitments-panel">
      <div className="update-note" id="commitments-copy">
        Nothing runs that you cannot find here. Pause stops a commitment from
        advancing without deleting the record. Scheduled turns run only while
        live standing consent and hard budgets are both present.
      </div>
      <div className="commitment-row commitment-posture">
        <span className="commitment-title">Auto-continue</span>
        <span className="commitment-status">
          {autoContinue ? "on" : "off"}
        </span>
      </div>
      {error ? <div className="commitment-error">{error}</div> : null}
      {active.length === 0 && recent.length === 0 ? (
        <div className="update-note">No scheduled or autonomous commitments yet.</div>
      ) : null}
      {active.length > 0 ? (
        <ul className="commitment-list" aria-label="Active commitments">
          {active.map((c) => (
            <CommitmentRow
              key={c.id}
              commitment={c}
              busy={busyId === c.id}
              busyAction={busyAction}
              onPause={() => void pause(c)}
              onResume={
                c.resumable && props.onResume ? () => void resume(c) : undefined
              }
            />
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <>
          <div className="commitment-subhead">Recently ended</div>
          <ul className="commitment-list" aria-label="Recent commitments">
            {recent.map((c) => (
              <CommitmentRow
                key={c.id}
                commitment={c}
                busy={busyId === c.id}
                busyAction={busyAction}
                onPause={() => undefined}
                onResume={
                  c.resumable && props.onResume ? () => void resume(c) : undefined
                }
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function CommitmentRow(props: {
  commitment: AutonomyCommitment;
  busy: boolean;
  busyAction: "pause" | "resume" | null;
  onPause: () => void;
  onResume?: () => void;
}) {
  const { commitment } = props;
  return (
    <li className="commitment-row">
      <div className="commitment-meta">
        <span className="commitment-title">{commitment.title}</span>
        <span className="commitment-status">{commitment.status}</span>
      </div>
      <div className="commitment-actions">
        {commitment.pausable ? (
          <button
            type="button"
            className="ghost-btn commitment-pause"
            disabled={props.busy}
            onClick={props.onPause}
          >
            {props.busy && props.busyAction === "pause" ? "Pausing…" : "Pause"}
          </button>
        ) : null}
        {props.onResume ? (
          <button
            type="button"
            className="ghost-btn commitment-resume"
            disabled={props.busy}
            onClick={props.onResume}
          >
            {props.busy && props.busyAction === "resume" ? "Resuming…" : "Resume"}
          </button>
        ) : null}
      </div>
    </li>
  );
}
