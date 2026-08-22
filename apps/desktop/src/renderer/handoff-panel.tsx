import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeHandoffContract,
  describeHandoffDegradation,
  handoffContractIsDegraded,
} from "@muon/client/handoff-view";
import type { TaskHandoffPage, TaskHandoffView } from "../shared/ipc.js";

/**
 * The session's WRAP, on the desk (surface-parity audit item 3).
 *
 * Handoff packets existed for the CLI (`muon handoff`), for agents
 * (`handoff_read`), and — as two create sites — for the TUI. The desktop, the
 * surface where a human actually watches a session end, could not show one.
 * That is also what blocked the session-wrap create path (handoff G2).
 *
 * TRUST POSTURE. `packetTitle` / `packetBody` are AGENT-PRODUCED UNTRUSTED
 * TEXT: rendered as text nodes (React escaping), never interpreted. The
 * CONTRACT line above them is MUON's own classification, not the agent's
 * claim, and it leads deliberately — a packet that failed validation, or a
 * row with no typed packet at all, must not read as "the work is fine".
 * Absence of evidence is shown as absence, never as a pass.
 */
export function HandoffPanel(props: {
  taskId: string | null;
  /** Injected so tests drive it without a window bridge. */
  load?: (input: { taskId: string }) => Promise<TaskHandoffPage>;
}) {
  const [rows, setRows] = useState<TaskHandoffView[] | null>(null);
  const [omitted, setOmitted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const load = props.load;
  // A bridge WITHOUT the method is an older preload, not a failed read: the
  // panel does not exist there at all. Decided at RENDER time rather than
  // discovered during a fetch — since the fetch now waits for the human to
  // open the panel, a fetch-time discovery would have drawn a disclosure that
  // could never answer. Calling the missing function also threw into the
  // app's error boundary and blanked the whole window (found by the app-level
  // tests, whose bridges stub only what they use).
  const supported =
    typeof load === "function" ||
    typeof window.muon?.taskHandoffs === "function";
  // The read a response must still be for. Keyed by a monotonic id, not by
  // the task: closing and reopening the SAME task starts a second read, and an
  // earlier in-flight read could still satisfy a task-id check and overwrite
  // the fresher snapshot — defeating the "every open is a fresh read"
  // guarantee this panel is built on (cubic P1). Only the latest read may
  // write, whatever it is about.
  const wantedRef = useRef(0);

  const fetchRows = useCallback(
    (taskId: string) => {
      const bridge = load ?? window.muon?.taskHandoffs?.bind(window.muon);
      if (typeof bridge !== "function") return;
      const read = ++wantedRef.current;
      setLoading(true);
      setError(null);
      bridge({ taskId })
        .then((result) => {
          if (wantedRef.current !== read) return;
          setRows(result.items);
          setOmitted(result.omitted);
        })
        .catch((cause) => {
          if (wantedRef.current !== read) return;
          setError(
            cause instanceof Error ? cause.message : "Could not read handoffs."
          );
        })
        .finally(() => {
          if (wantedRef.current !== read) return;
          setLoading(false);
        });
    },
    [load]
  );

  // DEMAND-DRIVEN means ON OPEN, not on selection. Fetching whenever a task is
  // selected paid for a getTaskDetail (and its check-history annotation) for
  // every session the human merely clicked past, while the disclosure was
  // still closed — and, worse, a panel opened BEFORE the session wrapped kept
  // claiming "has not wrapped" forever, because nothing re-read it. Each open
  // is a fresh read, so the answer is current by construction.
  useEffect(() => {
    if (!props.taskId || !open) {
      // A different session's rows must not linger behind a closed panel, and
      // an answer in flight must not land after we stopped wanting it.
      setRows(null);
      setOmitted(0);
      setError(null);
      wantedRef.current += 1;
      return;
    }
    fetchRows(props.taskId);
  }, [props.taskId, open, fetchRows]);

  if (!props.taskId || !supported) return null;

  // H2 — DEGRADED IS COUNTED SEPARATELY, ON THE CLOSED DISCLOSURE.
  //
  // The summary used to read "Session handoff 3", which is the number of rows
  // and says nothing about whether any of them can be trusted. A human who
  // never opens the panel then learns nothing, and the one packet that
  // declares its own missing evidence is invisible behind a neutral count.
  const degradedCount = (rows ?? []).filter((row) =>
    handoffContractIsDegraded(row.contract)
  ).length;

  return (
    <details
      className="dock-collapsible handoff-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Session handoff
        {rows && rows.length > 0 ? (
          <span
            className={`handoff-count${degradedCount > 0 ? " degraded" : ""}`}
          >
            {rows.length} handoff{rows.length === 1 ? "" : "s"}
            {degradedCount > 0 ? ` · ${degradedCount} degraded` : ""}
          </span>
        ) : null}
      </summary>
      {loading && rows === null ? (
        <div className="handoff-empty">Reading…</div>
      ) : error ? (
        // A failed read is NOT "no handoff" — saying so is the whole point.
        <div className="handoff-error">{error}</div>
      ) : !rows || rows.length === 0 ? (
        <div className="handoff-empty">
          No handoff packet yet — this session has not wrapped.
        </div>
      ) : (
        <div className="handoff-list">
          {rows.map((row) => {
            // H2 — a degraded packet is ranked WITH the failures, not beside
            // the successes. One decision per row, made once and applied to
            // the card frame, the contract line and the missing-evidence line,
            // so no part of the card can quietly disagree with another.
            const degraded = handoffContractIsDegraded(row.contract);
            const degradation = describeHandoffDegradation(row);
            return (
            <div
              className={`handoff-card${degraded ? " degraded" : ""}`}
              key={row.id}
            >
              <div
                className={`handoff-contract ${row.contract}${
                  degraded ? " degraded" : ""
                }`}
              >
                {degraded ? (
                  // Decorative: the sentence beside it already carries the
                  // meaning, so a screen reader is not made to say "warning
                  // sign" before every degraded contract line.
                  <span className="handoff-warn" aria-hidden="true">
                    ⚠
                  </span>
                ) : null}
                {describeHandoffContract(row.contract)}
              </div>
              <div className="handoff-title">{row.packetTitle}</div>
              <div className="handoff-lanes">
                {row.fromLane ?? "—"} → {row.toLane ?? "—"} · {row.status}
              </div>
              {/* ALWAYS VISIBLE, and always present for a degraded contract —
                  never folded into a disclosure and never omitted because the
                  agent flagged itself without saying why. This is the sentence
                  the ship gate refuses on, so it has to be readable from the
                  same screen as the refusal. */}
              {degradation ? (
                <div className="handoff-degraded" role="alert">
                  {degradation}
                </div>
              ) : row.degradedReasons.length > 0 ? (
                // `{flag:false, reasons:[…]}` is representable (the schema does
                // not couple them), so a packet can list caveats while denying
                // it is degraded. Those reasons must not vanish — but they also
                // must not borrow the alarm above, because MUON's own
                // classification, not the packet's prose, sets the rank.
                <div className="handoff-omitted">
                  Packet notes: {row.degradedReasons.join(", ")}
                </div>
              ) : null}
              {row.checks.length > 0 ? (
                <div className="handoff-checks">
                  {row.checks.map((check) => (
                    <span
                      className={`handoff-check ${check.outcome}`}
                      key={check.name}
                    >
                      {check.name}: {check.outcome}
                    </span>
                  ))}
                </div>
              ) : null}
              {row.changedFiles.length > 0 ? (
                <div className="handoff-files">
                  {row.changedFiles.join(", ")}
                  {row.changedFilesOmitted > 0
                    ? ` … +${row.changedFilesOmitted} more`
                    : ""}
                </div>
              ) : null}
              <div className="handoff-body">{row.packetBody}</div>
            </div>
            );
          })}
          {omitted > 0 ? (
            <div className="handoff-omitted">
              +{omitted} older handoff{omitted === 1 ? "" : "s"} not shown —
              `muon handoff` lists them all.
            </div>
          ) : null}
        </div>
      )}
    </details>
  );
}
