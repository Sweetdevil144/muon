import { useState } from "react";
import type { ForkMissionResult } from "../shared/ipc.js";

// ── ADR-0044/0071 — fork a NEW mission from the recorded step on screen ──────
//
// The third surface of one verb (CLI `muon fork`, the TUI's registry entry,
// now the dock): the desk names the step, the brief and the lane, NOTHING
// more — the latest-settled-step guard, gesture-time capture and authority
// re-derivation are the fork route's, and its refusals render VERBATIM here.
// Its own module so the review panel owns only placement and remount
// identity; the form, its lifecycle and its props contract live here.

export type ForkMissionProps = {
  /** The SETTLED job the dock is reviewing; the recorded step the fork names. */
  sourceJobId: string;
  /** Lane that produced the step — the fork's default lane (unlike
   *  continue-on-lane, forking onto the same lane is meaningful: a new
   *  mission, not a re-run). */
  sourceVendor: string | null;
  /** Dispatch-ready EXECUTION lanes, derived by the caller (never a pair
   *  hard-coded here). */
  vendors: ReadonlyArray<string>;
  laneLabel: (vendor: string) => string;
  /** Human-speakable slug for a job id (the ONE projection, `sessionSlug`). */
  slugOf: (jobId: string) => string;
  /** True when the readiness probe could not answer; the form says so. */
  readinessUnknown?: boolean;
  /** Resolves with the bridge's own result type — ONE contract, no
   *  renderer restatement to drift from it. */
  onFork: (input: {
    vendor: string;
    brief: string;
    title?: string;
  }) => Promise<ForkMissionResult>;
};

type ForkMissionState =
  | { phase: "idle" }
  | { phase: "forking" }
  | { phase: "refused"; reason: string }
  | { phase: "forked"; chatTitle: string; jobId: string; vendor: string };

export function ForkMissionSection(props: { forkMission: ForkMissionProps }) {
  const spec = props.forkMission;
  const [state, setState] = useState<ForkMissionState>({ phase: "idle" });
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [chosenVendor, setChosenVendor] = useState<string | null>(null);
  // The readiness snapshot can change while this section is mounted (the
  // source job's key does not change with it), so the lane is DERIVED every
  // render: an explicit choice holds only while its lane is still offered,
  // and the fallback re-resolves against the CURRENT vendor list. A stale or
  // empty lane can therefore never be submitted.
  const vendor = ((): string => {
    if (chosenVendor && spec.vendors.includes(chosenVendor)) {
      return chosenVendor;
    }
    if (spec.sourceVendor && spec.vendors.includes(spec.sourceVendor)) {
      return spec.sourceVendor;
    }
    return spec.vendors[0] ?? "";
  })();

  if (spec.vendors.length === 0) {
    // No lane, no dead button: the fork route needs a lane to queue the root.
    return null;
  }

  const submit = () => {
    const trimmed = brief.trim();
    if (!trimmed) {
      setState({
        phase: "refused",
        reason: "A fork carries a brief — say what the new mission is for.",
      });
      return;
    }
    setState({ phase: "forking" });
    void (async () => {
      try {
        const outcome = await spec.onFork({
          vendor,
          brief: trimmed,
          ...(title.trim() ? { title: title.trim() } : {}),
        });
        setState(
          outcome.ok
            ? {
                phase: "forked",
                chatTitle: outcome.chatTitle,
                jobId: outcome.jobId,
                vendor: outcome.vendor,
              }
            : // VERBATIM: the fork route's words, not a desk paraphrase.
              { phase: "refused", reason: outcome.reason }
        );
      } catch (error) {
        setState({
          phase: "refused",
          reason:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The fork was refused, and no reason was returned.",
        });
      }
    })();
  };

  return (
    <section className="right-panel-section fork-mission-section">
      <header>
        <strong>Fork a new mission from this step</strong>
        <span>{spec.slugOf(spec.sourceJobId)}&apos;s recorded state</span>
      </header>
      <p className="changes-honesty">
        Mints a NEW mission — its own chat, task and worktree, seeded from this
        settled step&apos;s recorded state — and queues its root turn on the
        chosen lane through the ordinary create path: authority and budgets are
        re-derived, nothing is copied from this mission. Only the task&apos;s
        latest settled step can be forked; the server refuses anything else and
        its reason is shown here unchanged.
      </p>
      {state.phase === "forked" ? (
        <p className="settings-saved" data-fork-mission-outcome="forked">
          Forked into mission <strong>{state.chatTitle}</strong> — root{" "}
          <strong>{spec.slugOf(state.jobId)}</strong> (
          <code>{state.jobId}</code>) queued on {spec.laneLabel(state.vendor)}.
        </p>
      ) : (
        <>
          <label className="fork-mission-field">
            Brief for the fork
            <textarea
              rows={2}
              value={brief}
              data-fork-mission-brief=""
              disabled={state.phase === "forking"}
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>
          <label className="fork-mission-field">
            Mission title (optional)
            <input
              type="text"
              value={title}
              data-fork-mission-title=""
              disabled={state.phase === "forking"}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="fork-mission-field">
            Lane
            <select
              value={vendor}
              data-fork-mission-lane=""
              disabled={state.phase === "forking"}
              onChange={(event) => setChosenVendor(event.target.value)}
            >
              {spec.vendors.map((lane) => (
                <option key={lane} value={lane}>
                  {spec.laneLabel(lane)}
                </option>
              ))}
            </select>
          </label>
          {spec.readinessUnknown ? (
            <p className="right-panel-bound">
              Lane readiness could not be checked just now, so these lanes are
              listed from the registry. MUON re-checks when you press.
            </p>
          ) : null}
          <div className="merge-actions fork-mission-actions">
            <button
              type="button"
              className="settings-save"
              data-fork-mission-submit=""
              disabled={state.phase === "forking"}
              onClick={submit}
            >
              {state.phase === "forking"
                ? "Forking…"
                : `Fork on ${spec.laneLabel(vendor)}`}
            </button>
          </div>
          <div aria-live="polite" className="fork-mission-outcome">
            {state.phase === "refused" ? (
              <div className="right-panel-callout" role="alert">
                <strong>Not forked</strong>
                <p>{state.reason}</p>
                <button
                  type="button"
                  className="ghost-btn"
                  data-fork-mission-retry=""
                  onClick={() => setState({ phase: "idle" })}
                >
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
