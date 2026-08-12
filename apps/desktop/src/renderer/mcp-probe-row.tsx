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
          <span className={`mcp-probe-chip ${level}`}>{level}</span>
        ) : null}
      </div>
      {error ? (
        <p className="mcp-note mcp-bad">{error}</p>
      ) : report ? (
        <>
          <p className="mcp-note">
            Mode <strong>{report.mode}</strong>: {report.verdict.detail}
          </p>
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
