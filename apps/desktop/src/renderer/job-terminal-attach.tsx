import { useEffect, useRef, useState } from "react";
import {
  INITIAL_JOB_TERMINAL_ATTACH_STATE,
  applyJobTerminalPoll,
  type JobTerminalAttachState,
} from "../lib/job-terminal-attach.js";
import type { TerminalView } from "./lib/terminal-wire.js";
import type {
  JobTerminalQuery,
  JobTerminalResponse,
} from "../shared/ipc.js";

/**
 * U1 LIVE — the agent tab's Terminal when MUON actually owns the vendor
 * child's console: the job's REAL output, byte-for-byte, as it is printed.
 *
 * WHAT IT IS. A read-only ATTACH. It polls the operator-tier
 * `GET /api/dispatch/:jobId/terminal` through trusted main (the renderer holds
 * no token), writes the returned frames into an XTerm view, and reports every
 * hole it detects. It starts nothing: the session id it displays names a
 * process the runner already owns, and the spawn door refuses that shape.
 *
 * WHY IT POLLS INSTEAD OF STREAMING. Same reason the brain's route is
 * cursor-based rather than SSE: every request settles in a bounded window, so
 * a wedged transport shows up as an error the human can read instead of a pane
 * that hangs forever looking alive.
 *
 * NO INPUT. `wireTerminal` is deliberately NOT used here — that helper's whole
 * job is to carry keystrokes back to a pty, and there is no channel back to a
 * dispatched agent. The view is created read-only, nothing subscribes to its
 * input, and steering stays in the mission composer where it passes the
 * approval gate.
 *
 * EVERY STATE IS SAID OUT LOUD. Attaching, attached-but-silent, gap, transport
 * error, ended, and "there is no live console after all" each have their own
 * words. A consumer never sees a blank black rectangle.
 */

/** Matches the recorded stream's cadence, so the two panes feel the same. */
const ATTACH_POLL_MS = 1_000;
/** A page that filled the cap is followed up fast rather than at the next tick. */
const ATTACH_DRAIN_MS = 60;

export function JobTerminalAttach(props: {
  jobId: string;
  /** Owning chat, so main can authorize without the mission staying selected. */
  chatId?: string | null;
  /** `pty:job:<jobId>:<epoch>` — displayed, never spawned. */
  sessionId: string;
  /** The bridge read. Injected so this is testable without Electron. */
  read: (query: JobTerminalQuery) => Promise<JobTerminalResponse>;
  /** Builds the XTerm-backed view (or a fake in tests). */
  createView: (container: HTMLElement) => TerminalView;
  /**
   * There is no live console after all (never one, or gone before a byte was
   * shown). The parent must stop labelling this tab live and fall back to the
   * recorded stream WITH this reason — never a blank pane titled "Live".
   */
  onDegrade: (reason: string) => void;
  pollMs?: number;
}) {
  const { jobId, chatId, sessionId, read, createView, onDegrade } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"connecting" | "attached" | "ended">(
    "connecting"
  );
  const [applied, setApplied] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const view = createView(container);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let state: JobTerminalAttachState = INITIAL_JOB_TERMINAL_ATTACH_STATE;

    const schedule = (delay: number) => {
      if (disposed) return;
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const tick = async (): Promise<void> => {
      let response: JobTerminalResponse;
      try {
        response = await read({
          jobId,
          ...(chatId ? { chatId } : {}),
          afterSeq: state.cursor,
        });
      } catch (failure: unknown) {
        // A transport failure is TRANSIENT by assumption — say so and retry.
        // Silence here is how a permanently broken pane would look identical to
        // a quiet agent.
        if (disposed) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "MUON could not read this job's live console."
        );
        schedule(props.pollMs ?? ATTACH_POLL_MS);
        return;
      }
      if (disposed) return;

      if (response.status !== "ok") {
        if (response.retryable === true) {
          // Might pass on its own (5xx, timeout, refused socket): keep the pane,
          // state the problem, ask again.
          setError(response.reason);
          schedule(props.pollMs ?? ATTACH_POLL_MS);
          return;
        }
        // It will not pass. Hand the tab back to the recorded stream with the
        // reason rather than holding a pane that can never fill.
        onDegrade(response.reason);
        return;
      }

      setError(null);
      const outcome = applyJobTerminalPoll(state, response);
      state = outcome.state;
      for (const chunk of outcome.writes) {
        view.write(chunk);
      }
      setApplied(state.applied);
      setNotice(outcome.notice);
      if (outcome.degrade) {
        onDegrade(outcome.degrade);
        return;
      }
      setPhase(state.phase === "ended" ? "ended" : "attached");
      if (outcome.ended) {
        setEnded(outcome.ended);
      }
      if (outcome.stop) {
        return;
      }
      schedule(outcome.more ? ATTACH_DRAIN_MS : (props.pollMs ?? ATTACH_POLL_MS));
    };

    void tick();

    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      // Tearing down the VIEWER never touches the job: there is no session to
      // close, because MUON never opened one — the runner owns that child.
      view.dispose();
    };
    // Re-attach only when the console identity changes. A new epoch means the
    // job restarted, and splicing two runs into one pane would be a lie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, sessionId]);

  return (
    <div className="job-terminal-live">
      {error ? (
        <div className="session-callout degraded" role="alert">
          <strong>This job's live console could not be read</strong>
          <p>{error}</p>
          <p>
            MUON keeps retrying. The agent is unaffected — this is the viewer,
            not the run. The Timeline still holds its recorded stream.
          </p>
        </div>
      ) : null}

      {notice ? (
        <p className="job-terminal-gap" role="status">
          {notice}
        </p>
      ) : null}

      <div
        aria-label="Live console for this agent, read-only"
        aria-readonly="true"
        className="terminal-tab job-terminal-live-view"
        data-session={sessionId}
        ref={containerRef}
        role="log"
      />

      {phase === "connecting" && !error ? (
        <p className="job-terminal-note" role="status">
          Attaching to this job's console…
        </p>
      ) : null}
      {phase !== "connecting" && applied === 0 && !error ? (
        <p className="job-terminal-note" role="status">
          Attached. This agent has not printed anything yet — this pane fills
          the moment it does.
        </p>
      ) : null}
      {ended ? (
        <p className="job-terminal-note" role="status">
          {ended}
        </p>
      ) : null}
    </div>
  );
}
