import type {
  GitHubConnectionStatus,
  GitHubDeviceFlowStart,
} from "@muon/client";
import type { VendorId } from "@muon/client/vendors";
import type {
  DesktopState,
  GitHubDeviceFlowUiPoll,
  McpAttachResult,
  McpDetachResult,
  McpInstallReport,
  McpProbeReport,
  McpStatusReport,
  UpdateStatus,
} from "../shared/ipc.js";
import { useState } from "react";
import { DiagnosticsStrip } from "./cockpit.js";
import type { AutonomyCommitment } from "@muon/client/autonomy-commitments";
import { CommitmentsPanel } from "./commitments-panel.js";
import {
  AutoContinuePanel,
  GitHubConnectPanel,
  McpConnectionsPanel,
  PortPreviewPanel,
  SettingsForm,
  UpdatesPanel,
  VendorActionsSection,
} from "./sidebar.js";

/**
 * Settings as a CENTER workspace tab — Status, GitHub, Orchestration, API,
 * Updates. Keeps Setup out of the sidebar so left-nav icons never scroll away.
 */
export function SettingsPanel(props: {
  state: DesktopState | null;
  runnerDetail?: string | null;
  onSaveSettings: (input: {
    apiBase: string;
    apiToken?: string;
  }) => Promise<void>;
  onStartGitHub: () => Promise<GitHubDeviceFlowStart>;
  onPollGitHub: (flowId: string) => Promise<GitHubDeviceFlowUiPoll>;
  onDisconnectGitHub: () => Promise<void>;
  onOpenGitHubUrl: (url: string) => Promise<void>;
  updateStatus: UpdateStatus;
  onCheckUpdates: () => void;
  onToggleAutoUpdate: (enabled: boolean) => void;
  /** S4 auto-continue posture. Optional so existing renders/tests that do not
   *  pass it fall back to reading state and a no-op toggle. */
  onToggleAutoContinue?: (enabled: boolean) => void;
  /** P0-5: local diagnostics recording consent (no egress exists). */
  onToggleTelemetry?: (enabled: boolean) => void;
  onTogglePortPreview?: (enabled: boolean) => void;
  /** TODO 5.17: pause a listed autonomy commitment without deleting it. */
  onPauseCommitment?: (commitment: AutonomyCommitment) => Promise<void>;
  /** P9: resume a paused loop dispatch from Orchestration. */
  onResumeCommitment?: (commitment: AutonomyCommitment) => Promise<void>;
  onDownloadUpdate: () => void;
  onInstallUpdate: (force?: boolean) => void;
  onRecheckReadiness?: () => void;
  readinessRefreshing?: boolean;
  readinessRefreshError?: string | null;
  /**
   * S1 §5 Connections. All optional so existing renders/tests that do not pass
   * them still mount — the panel then shows its "Not checked yet" state rather
   * than a blank section, which is the point of having one.
   */
  mcpStatus?: McpStatusReport | null;
  mcpStatusLoading?: boolean;
  mcpStatusError?: string | null;
  onRefreshMcpStatus?: () => void;
  /** Operator-initiated LIVE probe (`muon mcp probe`). Optional: without it
   *  the Connections panel renders no probe control. */
  onProbeMcp?: (input?: { mode?: string }) => Promise<McpProbeReport>;
  onInstallMcp?: (vendor: VendorId) => Promise<McpInstallReport>;
  /**
   * ADR-0028 Tier C. `mcpAttachedByVendor` reflects the LIVE dispatch job
   * list (a root job whose `capabilityMode` is `attached-coordinator`), so it
   * shows a seat attached from the CLI or another window too — not only one
   * this session minted. All optional for the same reason as the install
   * trio above: an older render/test that omits them still mounts, with the
   * Attach/Detach controls simply absent.
   */
  mcpAttachedByVendor?: ReadonlyMap<
    VendorId,
    { jobId: string; chatId: string | null }
  >;
  onAttachMcp?: (vendor: VendorId) => Promise<McpAttachResult>;
  onDetachMcp?: (vendor: VendorId) => Promise<McpDetachResult>;
}) {
  return (
    <div className="settings-workspace">
      <header className="settings-workspace-head">
        <strong>Settings</strong>
        <span>What MUON is connected to on this Mac, and how it behaves.</span>
      </header>

      <VendorActionsSection state={props.state} />

      <section className="side-section" id="settings-status">
        <div className="side-heading">
          <span>Status</span>
        </div>
        <div className="settings-diagnostics">
          <DiagnosticsStrip
            preflight={props.state?.preflight ?? null}
            readinessMeta={props.state?.readinessMeta}
            runnerDetail={props.runnerDetail}
            onRefresh={props.onRecheckReadiness}
            refreshing={props.readinessRefreshing}
            refreshError={props.readinessRefreshError}
          />
        </div>
      </section>

      <section className="side-section">
        <div className="side-heading">
          <span>GitHub</span>
        </div>
        <GitHubConnectPanel
          status={(props.state?.github ?? null) as GitHubConnectionStatus | null}
          onStart={props.onStartGitHub}
          onPoll={props.onPollGitHub}
          onDisconnect={props.onDisconnectGitHub}
          onOpenUrl={props.onOpenGitHubUrl}
        />
      </section>

      {/* S1 §5 — Connections sits beside GitHub because it is the same kind of
          thing: a quiet, per-integration status row the operator checks, not a
          wizard step. */}
      <section className="side-section" id="settings-connections">
        <div className="side-heading">
          <span>Connections</span>
        </div>
        <McpConnectionsPanel
          report={props.mcpStatus ?? null}
          loading={props.mcpStatusLoading ?? false}
          error={props.mcpStatusError ?? null}
          onRefresh={() => props.onRefreshMcpStatus?.()}
          onProbe={props.onProbeMcp}
          onInstall={(vendor) =>
            props.onInstallMcp
              ? props.onInstallMcp(vendor)
              : Promise.reject(
                  new Error("MCP registration is unavailable. Restart MUON; if it persists, reinstall.")
                )
          }
          attachedByVendor={props.mcpAttachedByVendor}
          onAttach={
            props.onAttachMcp
              ? (vendor) => props.onAttachMcp!(vendor)
              : undefined
          }
          onDetach={
            props.onDetachMcp
              ? (vendor) => props.onDetachMcp!(vendor)
              : undefined
          }
        />
      </section>

      <section className="side-section" id="settings-orchestration">
        <div className="side-heading">
          <span>Orchestration</span>
        </div>
        <AutoContinuePanel
          // Default ON, matching the desktop default (lib/settings.ts) — an
          // older state literal without the field must not read as "off".
          autoContinue={props.state?.settings?.autoContinue ?? true}
          onToggle={(enabled) => props.onToggleAutoContinue?.(enabled)}
        />
        <PortPreviewPanel
          enabled={
            props.state?.portPreviewEnabled ??
            props.state?.settings?.portPreviewEnabled ??
            false
          }
          onToggle={(enabled) => props.onTogglePortPreview?.(enabled)}
        />
        {/* P0-5 — diagnostics recording. The copy is the privacy contract:
            nothing leaves this Mac UNLESS this is on (ADR-0031 ships a
            consent-gated PostHog US uploader — this comment used to say "no
            uploader exists" eighteen lines above the copy that correctly names
            it), and the spool holds only closed-vocabulary events. Deliberately NOT the
            `.full-auto-toggle` idiom (armed = red, "this disables a gate") —
            it reads as the quiet checkbox its two neighbours use, because
            recording a launch code disables nothing. */}
        <div className="updates-panel">
          <label className="update-auto">
            <input
              checked={props.state?.telemetryEnabled ?? false}
              onChange={(event) =>
                props.onToggleTelemetry?.(event.target.checked)
              }
              type="checkbox"
            />
            Share anonymous diagnostics (launch, crash codes, milestones)
          </label>
          <div className="update-note">
            Off by default. When on: the same closed-vocabulary events written
            to this profile&apos;s local spool are also sent to PostHog (US)
            under a random per-consent id — never a name, email, path, prompt,
            or repo. Turning it off stops uploads immediately and discards the
            id.
          </div>
          <ObservatorySummaryBlock />
        </div>
        <CommitmentsPanel
          state={props.state}
          onPause={(commitment) =>
            props.onPauseCommitment
              ? props.onPauseCommitment(commitment)
              : Promise.reject(
                  new Error("Pausing commitments is unavailable. Restart MUON; if it persists, reinstall.")
                )
          }
          onResume={props.onResumeCommitment}
        />
      </section>

      <section className="side-section" id="settings-form">
        <div className="side-heading">
          <span>API</span>
        </div>
        <SettingsForm
          settings={props.state?.settings ?? null}
          onSave={props.onSaveSettings}
        />
      </section>

      <section className="side-section">
        <div className="side-heading">
          <span>Updates</span>
        </div>
        <UpdatesPanel
          appVersion={props.state?.appVersion}
          autoUpdate={props.state?.settings?.autoUpdate ?? false}
          status={props.updateStatus}
          onCheck={props.onCheckUpdates}
          onToggleAuto={props.onToggleAutoUpdate}
          onDownload={props.onDownloadUpdate}
          onInstall={props.onInstallUpdate}
        />
      </section>
    </div>
  );
}

/** F3 — the local analytics readout: counts + funnel timestamps aggregated in
 *  trusted main from the 0600 spool. Loaded only when the operator asks. */
function ObservatorySummaryBlock() {
  const [summary, setSummary] = useState<{
    launches: number;
    crashes: Record<string, number>;
    updateChecks: number;
    updatesApplied: number;
    consentGrantedAt?: string;
    funnel: Record<string, string | undefined>;
    spoolBytes: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSummary(
        (await window.muon.observatorySummary()) as typeof summary
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "summary unavailable");
    }
  };

  const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "—");
  const crashCount = summary
    ? Object.values(summary.crashes).reduce((a, b) => a + b, 0)
    : 0;
  return (
    <div className="observatory-summary">
      <button className="update-btn ghost" onClick={() => void load()}>
        {summary ? "Refresh local summary" : "View local summary"}
      </button>
      {error ? <div className="update-note">{error}</div> : null}
      {summary ? (
        <div className="update-note" data-testid="observatory-summary">
          <div>
            Launches {summary.launches} · crashes {crashCount} · update checks{" "}
            {summary.updateChecks} · updates applied {summary.updatesApplied}
          </div>
          <div>
            First chat {day(summary.funnel.first_chat)} · first dispatch{" "}
            {day(summary.funnel.first_dispatch)} · first merge{" "}
            {day(summary.funnel.first_merge)}
          </div>
          <div>
            Recording since {day(summary.consentGrantedAt)} · spool{" "}
            {Math.max(1, Math.round(summary.spoolBytes / 1024))} KB, local only
          </div>
        </div>
      ) : null}
    </div>
  );
}
