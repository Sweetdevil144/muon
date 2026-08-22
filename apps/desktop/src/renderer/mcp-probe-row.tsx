import { useState } from "react";
import { MCP_PROBE_MODES } from "@muon/client/mcp-probe";
import type { McpProbeReport } from "../shared/ipc.js";

/**
 * The LIVE surface check, on the desk (surface-parity item 5).
 *
 * The line above this one — "a session gets N tools" — is computed from
 * constants compiled into this build. On 2026-08-10 it would have said 44
 * while the server a vendor had actually spawned served 27, because that
 * vendor's symlink pointed at a three-day-old `dist/`. Three shipped tools
 * were callable by nobody and nothing on any surface said so.
 *
 * So this asks the process. It is a BUTTON, not a poll: it spawns a real
 * server, handshakes it, and kills it.
 *
 * Every outcome here is stated as what it is. A server that could not be
 * probed is `unevaluated` — an unknown, never a pass — and the copy refuses to
 * let a missing measurement read as a clean one.
 *
 * THE MODE IS PART OF THE MEASUREMENT. A server's toolset depends on
 * MUON_MCP_MODE, and a vendor entry can declare `observer` or
 * `attached-coordinator` rather than the sub-agent default. Probing `base`
 * unconditionally would report a clean base result while never measuring the
 * surface an installed vendor actually receives — so the mode a vendor
 * declares is the default here, the operator can change it, and the verdict
 * always names which mode it measured.
 */
export function McpProbeRow(props: {
  probe?: (input?: { mode?: string }) => Promise<McpProbeReport>;
  /** Modes the installed vendor entries declare, from their own configs. */
  configuredModes?: readonly string[];
}) {
  const declared = [...new Set((props.configuredModes ?? []).filter(Boolean))];
  // One declared mode is unambiguous. Zero (nothing configures a mode) or
  // several (vendors disagree) fall back to the sub-agent seat, which is what
  // a vendor with no MUON_MCP_MODE gets.
  const [mode, setMode] = useState(
    declared.length === 1 ? declared[0]! : "base"
  );
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<McpProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!props.probe) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await props.probe!({ mode }));
    } catch (cause) {
      setReport(null);
      setError(
        cause instanceof Error ? cause.message : "The probe could not run."
      );
    } finally {
      setBusy(false);
    }
  };

  const level = report?.verdict.level ?? null;
  // ADR-0052. A LOCKED server answers `initialize` and `tools/list` in full, so
  // its verdict can legitimately be `ok` — and an `ok` chip in front of a server
  // that will refuse all N tools is the same "ok, N tools" lie `muon mcp probe`
  // stopped telling. The chip keeps naming the level it measured (that reading
  // is still true) and stops wearing the level's tone, exactly as the CLI keeps
  // printing `live MCP surface: ok` while flipping its mark to `!!`.
  //
  // BOTH locked states. `locked-unregistered` refuses exactly as hard, so
  // reading only `locked` here would put a calm `ok` chip in front of a server
  // that answers nothing — the same lie, one state later.
  const locked =
    report?.identityGate === "locked" ||
    report?.identityGate === "locked-unregistered";
  const registrationPending = report?.identityGate === "locked-unregistered";
  // A gate value this build cannot interpret. NOT folded into `locked`: we do
  // not know that it is locked, and claiming either way would be the same lie
  // in the opposite direction. What we do know is that the reading is
  // unreadable here, which is itself worth showing — `muon mcp probe` exits
  // non-zero on exactly this state rather than reporting a healthy server.
  const unreadableGate = report?.unknownIdentityGate ?? null;
  return (
    <div className="mcp-probe">
      <div className="mcp-probe-head">
        <button className="ghost-btn" disabled={busy} onClick={() => void run()}>
          {busy ? "Probing…" : "Probe live server"}
        </button>
        <select
          aria-label="Server mode to probe"
          value={mode}
          disabled={busy}
          onChange={(event) => {
            setMode(event.target.value);
            // A verdict is ABOUT a mode. Leaving the old one on screen beside
            // a new selection attributes a measurement to a server that was
            // never probed.
            setReport(null);
            setError(null);
          }}
        >
          {[...new Set([...MCP_PROBE_MODES, ...declared])].map((option) => (
            <option key={option} value={option}>
              {option}
              {declared.includes(option) ? " (configured)" : ""}
            </option>
          ))}
        </select>
        {level ? (
          <span
            className={`mcp-probe-chip ${
              locked || unreadableGate ? "locked" : level
            }`}
          >
            {level}
          </span>
        ) : null}
        {locked ? (
          <span className="mcp-probe-chip locked">
            {registrationPending ? "registration pending" : "identity locked"}
          </span>
        ) : null}
        {!locked && unreadableGate ? (
          <span className="mcp-probe-chip locked">identity unreadable</span>
        ) : null}
      </div>
      {error ? (
        <p className="mcp-note mcp-bad">{error}</p>
      ) : report ? (
        <>
          <p className="mcp-note">
            Mode <strong>{report.mode}</strong>: {report.verdict.detail}
          </p>
          {locked ? (
            // The CLI's own clause, word for word (`renderProbe` prints
            // "identity LOCKED — this server serves the list and refuses the
            // work", and names the pending case separately). It is the probe
            // surface's framing rather than the governed refusal below, and it
            // earns its place here because the line directly above is reporting
            // "live 27 / defined 27, ok".
            <p className="mcp-note mcp-bad">
              {registrationPending
                ? "Verified here, not yet recorded centrally. This server serves the list and refuses the work until it is."
                : "This server serves the list and refuses the work."}
            </p>
          ) : null}
          {!locked && unreadableGate ? (
            // Names the value, because "unknown state" is unactionable and the
            // string itself is the only clue to which MUON wrote it. Remedy is
            // the CLI's: this build is older than the server it just probed.
            <p className="mcp-note mcp-bad">
              This server reported an identity state this build does not
              recognise (<code>{unreadableGate}</code>), so whether it will
              serve or refuse is unknown here. Update MUON (<code>muon update</code>)
              so the two agree.
            </p>
          ) : null}
          {report.identityGateRefusal ? (
            // VERBATIM, as main handed it over. This is `githubIdentityGateRefusal`'s
            // three sentences — the same ones `muon mcp probe` prints and the same
            // ones a gated tool call returns to an agent. The desk composes none of
            // it: an operator and an agent reading about the same lock must be told
            // the same thing, which is why the copy has exactly one author.
            <p className="mcp-note mcp-bad mcp-probe-refusal">
              {report.identityGateRefusal}
            </p>
          ) : null}
          {report.verdict.missing.length > 0 ? (
            // BY NAME. A count would say "three fewer tools"; the operator
            // needs to know WHICH, because that is what tells them whether the
            // tool they are about to rely on exists in the running server.
            <p className="mcp-note mcp-bad">
              Missing: {report.verdict.missing.join(", ")}
            </p>
          ) : null}
          {report.verdict.extra.length > 0 ? (
            <p className="mcp-note">
              Served but not in this build: {report.verdict.extra.join(", ")}
            </p>
          ) : null}
          {report.failure ? (
            <p className="mcp-note mcp-bad">{report.failure}</p>
          ) : null}
        </>
      ) : (
        <p className="mcp-note">
          {"Not probed. The tool count above comes from this build, not from " +
            "the server a vendor would spawn."}
        </p>
      )}
    </div>
  );
}
