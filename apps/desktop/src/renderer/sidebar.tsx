import { useEffect, useState } from "react";
import type {
  AgentRecord,
  DispatchJobRecord,
  GitHubConnectionStatus,
  GitHubDeviceFlowStart,
  OrchestratorChatRecord,
  RecordedEvent,
} from "@muon/client";
import {
  buildVendorActionMenu,
  vendorSupportsEffortControl,
} from "@muon/adapters/vendor-capabilities";
// `vendorRoleScope` — the ONE projection of the role model into "what is this
// lane managed for" — now reaches this file through `buildLaneStatus` below,
// which is also what the Doctor strip reads. Deriving it in two places is how
// the two surfaces drifted (an unrunnable probe read as "setup needed" here and
// "unknown" there), so there is deliberately no second call site.
import {
  coordinatorVendorIds,
  vendorLabel,
  type VendorId,
} from "@muon/client/vendors";
import {
  FLEET_MAX,
  FLEET_VENDORS,
  FLEET_VENDOR_LABELS,
  type FleetVendor,
  isGlobalStandingConsent,
} from "../lib/fleet.js";
import {
  buildLaneStatuses,
  freshnessLabel,
  summarizeLanes,
  type LaneStatus,
} from "./lib/lane-status.js";
import { agentCodenames } from "../lib/agent-codename.js";
import {
  DEFAULT_CREW_CONFIG,
  isCrewLaneVendor,
  knownModelsForVendor,
  normalizeCrewConfig,
  selectOrchestratorVendor,
  type CrewConfig,
  type LaneDefaultConfig,
  rememberOrchestratorPrefs,
} from "../lib/crew-config.js";
import {
  orchestratorReadinessIssue,
  readyOrchestratorFallback,
} from "../lib/orchestrator-readiness.js";
import { DESKTOP_PRESET_EFFORTS } from "../lib/presets.js";
import type {
  CliLinkBinStatus,
  CliLinkResult,
  CliLinkStatusReport,
  CliUnlinkResult,
  DesktopState,
  GitHubDeviceFlowUiPoll,
  ListeningPortSnapshot,
  McpAttachResult,
  McpDetachResult,
  McpInstallReport,
  McpProbeReport,
  McpStatusReport,
  McpVendorStatus,
  UpdateStatus,
  VendorModelResolutionIpc,
  WorkspaceReview,
} from "../shared/ipc.js";
import { modelDisplay, vendorChoiceLabel } from "./lib/model-label.js";
import { Splitter } from "./splitter.js";
import type { PanelWidthState } from "./lib/panel-resize.js";
import { LeftNav, type NavFleetLane } from "./left-nav.js";
import { VendorIcon } from "./vendor-icon.js";
import { assessMcpDrift, type McpVendorDrift } from "@muon/client/mcp-drift";
import type { NavTarget } from "./lib/workspace-layout.js";
import {
  selectWorkspaceReviewTargets,
  type WorkspaceReviewsByChat,
} from "./lib/workspace-review-state.js";
// H10 — the ONE session-slug projection, reached through the renderer-safe
// subpath. Not the `@muon/client` barrel (it drags `node:fs` into an esbuild
// browser target) and not a local copy (two implementations is exactly how the
// rail and the TUI strip would start calling one job by two names).
import { sessionSlug } from "@muon/client/session-slug";
import { MissionTokenUsagePanel } from "./mission-usage.js";
import { MissionCapControl } from "./mission-cap.js";
import { McpProbeRow } from "./mcp-probe-row.js";
import { ProviderReadinessNotice } from "./provider-readiness-notice.js";
import { WorkspacePortBadges } from "./port-badges.js";

type SidebarProps = {
  state: DesktopState | null;
  // Single-sidebar redesign: the view nav lives at the TOP of this one column
  // (no more separate nav rail). Settings/Crew open as CENTER tabs.
  navActive: NavTarget;
  navPendingDecisions: number;
  navCrewActive: boolean;
  navFleet: NavFleetLane[];
  onNavigate: (target: NavTarget) => void;
  activeChatId: string | null;
  workspaceReviews?: WorkspaceReviewsByChat;
  taskTitles: Map<string, string>;
  onSelectChat: (chatId: string) => void;
  /**
   * S7: soft-archive (operator-gated "delete") a chat. Confirmed in-row before
   * it fires (no one-click destroy). Rejections are surfaced by the parent.
   */
  onArchiveChat: (chatId: string) => void;
  /** S7: last archive failure to surface in the chat list (null = none). */
  archiveError?: string | null;
  /**
   * Cancel a chat: stop every queued/running job it owns and LEAVE THE CHAT
   * (this is not archive). Optional so existing minimal renders keep working;
   * the affordance only appears for a chat that actually has live work.
   */
  onCancelChat?: (chatId: string) => void;
  /** Chat whose cancel is in flight (its Stop control shows as busy). */
  cancellingChatId?: string | null;
  /** Honest one-liner from the last cancel ("Stopped 2 of 3 …"). */
  cancelNotice?: string | null;
  /**
   * Create a session. Optional `workspacePath` skips the folder picker and
   * lands the new chat in that project (per-group `+`). Omit for the global
   * New chat control, which must keep asking for a folder.
   */
  onNewChat: (workspacePath?: string) => void;
  onStepFleet: (vendor: FleetVendor, delta: number) => void;
  onOpenAgent: (agentId: string) => void;
  /**
   * Vendor-scoped Full-Auto standing consent: DISABLES the approval gate for
   * the selected lanes. Calls the real setFullAutoVendors IPC through the
   * parent — never a local-only flag.
   */
  onSetFullAutoVendors: (vendors: string[]) => void;
  /** ROADMAP P6 — open an allowlisted localhost preview for one port. */
  onOpenPortPreview?: (port: number) => void;
  /** Task 3: the sidebar's own resizable width (drag or arrow keys on the
   *  trailing splitter). Optional so existing test renders that don't pass
   *  it keep today's fixed-width behavior. */
  panelWidth?: PanelWidthState;
  /**
   * E3: App keeps the Sidebar mounted at all times now (the grid-column
   * width transition needs real content to shrink/grow instead of an
   * instant mount/unmount pop) and flags the collapsed state here instead.
   * Marks the whole aside `inert` — unreachable by keyboard/AT — while
   * collapsed. Optional + defaults to open so every existing render (tests,
   * minimal harnesses) keeps today's behavior verbatim.
   */
  collapsed?: boolean;
};

export function Sidebar(props: SidebarProps) {
  const chats = props.state?.chats ?? [];
  const counts = props.state?.fleet?.counts ?? {};
  const agents = props.state?.fleet?.agents ?? [];

  // Per-chat count of still-in-flight worker jobs (queued/running). Archiving is
  // a soft, non-destructive act — those jobs keep running — but the confirm step
  // escalates its warning when a chat still has live work, so the human makes an
  // explicit second decision (S7 running-jobs guard).
  // Per-group collapse (spec R2 / H8) — session-local chevrons.
  //
  // The DEFAULT is collapsed: a rail that opens every project's session list at
  // once is the "wall of cards" H8 exists to prevent, and the terminal — not
  // the rail — is the hero. Only what the human is standing in opens itself.
  // This map holds EXPLICIT toggles only, so a deliberate open/close is sticky
  // for the session even after the active chat moves to another project (the
  // rail must not re-close a group a human opened to watch).
  const [groupCollapseOverrides, setGroupCollapseOverrides] = useState<
    Map<string, boolean>
  >(() => new Map());
  // Blocked-at-gate per chat (spec R7): MUON's extra state, rendered loudest.
  //
  // An ApprovalRequest has NO chatId — it is bound to a task and (since P0.1)
  // to the job that filed it. This loop used to read `approval.chatId`, which
  // is always undefined, so every approval was skipped and the badge that
  // exists to shout "this mission is blocked" never once appeared. The
  // renderer's typecheck says so plainly; nobody was running it.
  //
  // The chat is resolved through the JOB, which does carry one, with taskId as
  // the fallback for pre-P0.1 rows and non-job gates. An approval whose chat
  // cannot be resolved is counted NOWHERE rather than against a guess — a
  // badge on the wrong mission is worse than no badge.
  const chatByJob = new Map<string, string>();
  const chatByTask = new Map<string, string>();
  for (const job of props.state?.dispatchJobs ?? []) {
    if (!job.chatId) continue;
    chatByJob.set(job.id, job.chatId);
    chatByTask.set(job.taskId, job.chatId);
  }
  const blockedByChat = new Map<string, number>();
  for (const approval of props.state?.approvals ?? []) {
    const chatId =
      (approval.jobId ? chatByJob.get(approval.jobId) : undefined) ??
      chatByTask.get(approval.taskId);
    if (!chatId) continue;
    blockedByChat.set(chatId, (blockedByChat.get(chatId) ?? 0) + 1);
  }
  const runningJobsByChat = new Map<string, number>();
  const listeningPortsByChat = new Map<string, ListeningPortSnapshot[]>();
  for (const port of props.state?.listeningPorts ?? []) {
    if (!port.chatId) {
      continue;
    }
    const list = listeningPortsByChat.get(port.chatId) ?? [];
    list.push(port);
    listeningPortsByChat.set(port.chatId, list);
  }
  for (const job of props.state?.dispatchJobs ?? []) {
    if (!job.chatId) continue;
    if (job.status === "queued" || job.status === "running") {
      runningJobsByChat.set(
        job.chatId,
        (runningJobsByChat.get(job.chatId) ?? 0) + 1
      );
    }
  }

  // H9/H10 — the ONE job a session row speaks for: the SAME target the review
  // dock already reviews (`selectWorkspaceReviewTargets`), so the rail's
  // worktree badge and the dock's diff can never be about two different runs.
  // Its `executionPath` is the lease-fenced fact the runner recorded (ADR-0048)
  // — the row never guesses, and never names a branch.
  const jobsById = new Map(
    (props.state?.dispatchJobs ?? []).map((job) => [job.id, job] as const)
  );
  const reviewJobByChat = new Map<string, DispatchJobRecord>();
  for (const target of selectWorkspaceReviewTargets(
    chats,
    props.state?.dispatchJobs ?? []
  )) {
    const job = jobsById.get(target.jobId);
    if (job) {
      reviewJobByChat.set(target.chatId, job);
    }
  }

  const groups = groupChatsByWorkspace(chats);
  // Which group opens itself: the one the human is standing in. When no group
  // owns the active chat (nothing selected yet), the FIRST one opens instead —
  // an all-collapsed rail is a blank screen, and a consumer never gets one.
  const activeGroupKey =
    groups.find((group) =>
      group.chats.some((chat) => chat.id === props.activeChatId)
    )?.key ??
    groups[0]?.key ??
    null;

  return (
    <aside
      className={"sidebar" + (props.collapsed ? " sidebar-collapsed" : "")}
      inert={props.collapsed ? true : undefined}
    >
      {/* Chrome (nav + New chat + auto-approve) is its own Y-scrollport so a
          short window can still reach Timeline/Graph/Settings. Sessions scroll
          in .sidebar-scroll. The scrollbar sits INSIDE the right padding —
          clear of the resize handle at the aside's edge (otherwise the
          scrollbar swallows the drag). */}
      <div className="sidebar-chrome">
      <LeftNav
        active={props.navActive}
        pendingDecisions={props.navPendingDecisions}
        crewActive={props.navCrewActive}
        fleet={props.navFleet}
        onNavigate={props.onNavigate}
      />
      <button
        className="newbtn"
        onClick={() => props.onNewChat()}
        type="button"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        New chat
      </button>
      <section className="side-section full-auto-section">
        <div className="side-heading">
          <span>Auto-approve</span>
        </div>
        <FullAutoPanel
          selected={props.state?.fullAutoVendors ?? []}
          onSetVendors={props.onSetFullAutoVendors}
        />
      </section>
      </div>
      <div className="sidebar-scroll">
      <section className="side-section">
        {/* Session desk IA (spec R1–R8): PROJECTS → SESSIONS. Group `+` creates in
            THAT workspace (group.key); the rail "New chat" still picks a folder. */}
        {chats.length === 0 ? (
          <div className="side-empty">No sessions yet.</div>
        ) : (
          groups.map((group) => {
            const collapsed =
              groupCollapseOverrides.get(group.key) ??
              group.key !== activeGroupKey;
            const sessionCount = group.chats.length;
            // H9 — a gate waiting inside a CLOSED project must still be
            // visible: collapsing is how a human puts a project away, not how
            // MUON gets to stop telling them something is stuck. The count is
            // rolled up onto the header line — no new chrome, the same one row.
            const blockedInGroup = group.chats.filter(
              (chat) => (blockedByChat.get(chat.id) ?? 0) > 0
            ).length;
            return (
              <div
                className={"rail-group" + (collapsed ? " collapsed" : "")}
                key={group.key}
              >
                <div className="rail-group-head">
                  <button
                    className="rail-group-toggle"
                    aria-expanded={!collapsed}
                    // The accessible name carries BOTH facts a human needs
                    // before opening a project: which project, and how much is
                    // in it. `.rail-group-name` stays the leaf alone so the
                    // visible label never becomes a sentence.
                    aria-label={`${group.label} — ${sessionCount} session${
                      sessionCount === 1 ? "" : "s"
                    }${
                      blockedInGroup > 0
                        ? `, ${blockedInGroup} blocked at a gate`
                        : ""
                    }`}
                    title={group.key}
                    onClick={() =>
                      setGroupCollapseOverrides((prev) => {
                        const next = new Map(prev);
                        next.set(group.key, !collapsed);
                        return next;
                      })
                    }
                  >
                    <span className="rail-caret" aria-hidden="true">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M4 6.5 8 10l4-3.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="rail-group-name">{group.label}</span>
                    {blockedInGroup > 0 ? (
                      <span className="rail-group-blocked" aria-hidden="true">
                        <span className="status-glyph" />
                        {blockedInGroup}
                      </span>
                    ) : null}
                    <span className="rail-group-count" aria-hidden="true">
                      {sessionCount}
                    </span>
                  </button>
                  <button
                    className="rail-group-add"
                    onClick={() => props.onNewChat(group.key)}
                    aria-label={`New session in ${group.label}`}
                    title={`New session in ${group.label}`}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                {collapsed ? null : (
                  <div className="rail-sessions">
                    {orderByAttention(group.chats, (chat) =>
                      attentionRank({
                        blockedApprovals: blockedByChat.get(chat.id) ?? 0,
                        runningJobs: runningJobsByChat.get(chat.id) ?? 0,
                      })
                    ).map((chat) => (
                      <ChatRow
                        key={chat.id}
                        chat={chat}
                        active={chat.id === props.activeChatId}
                        runningJobs={runningJobsByChat.get(chat.id) ?? 0}
                        blockedApprovals={blockedByChat.get(chat.id) ?? 0}
                        sessionTree={sessionTree(reviewJobByChat.get(chat.id))}
                        sessionName={
                          reviewJobByChat.has(chat.id)
                            ? sessionSlug(reviewJobByChat.get(chat.id)!.id)
                            : null
                        }
                        workspaceReview={
                          props.workspaceReviews?.[chat.id]?.review ?? null
                        }
                        workspaceReviewLoading={
                          props.workspaceReviews?.[chat.id]?.loading ?? false
                        }
                        listeningPorts={listeningPortsByChat.get(chat.id) ?? []}
                        portPreviewEnabled={
                          props.state?.portPreviewEnabled ??
                          props.state?.settings?.portPreviewEnabled ??
                          false
                        }
                        onOpenPortPreview={props.onOpenPortPreview}
                        onSelect={() => props.onSelectChat(chat.id)}
                        onArchive={() => props.onArchiveChat(chat.id)}
                        onCancel={
                          props.onCancelChat
                            ? () => props.onCancelChat?.(chat.id)
                            : undefined
                        }
                        cancelling={props.cancellingChatId === chat.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        {props.cancelNotice ? (
          <div className="chat-cancel-notice" role="status">
            {props.cancelNotice}
          </div>
        ) : null}
        {props.archiveError ? (
          <div className="chat-archive-error" role="alert">
            {props.archiveError}
          </div>
        ) : null}
      </section>

      {/* Setup/Settings live in a CENTER tab (SettingsPanel) so expanding them
          can never scroll LeftNav icons out of view. */}
      </div>
      {props.panelWidth ? (
        <Splitter
          label="Resize sidebar"
          value={props.panelWidth.width}
          min={props.panelWidth.min}
          max={props.panelWidth.max}
          sign={1}
          onChange={props.panelWidth.setWidth}
          className="sidebar-splitter"
        />
      ) : null}
    </aside>
  );
}

/** The crew workspace — fleet sizing, orchestrator seat, per-lane model/effort. */
export function CrewPanel(props: {
  state: DesktopState | null;
  taskTitles: Map<string, string>;
  onStepFleet: (vendor: FleetVendor, delta: number) => void;
  onOpenAgent: (agentId: string) => void;
  /** Active-mission audit events for honest per-vendor token totals. */
  missionEvents?: RecordedEvent[];
  /** The mission the cost panels describe. Without it they render nothing. */
  activeChatId?: string | null;
  /** Last fleet resize error (surfaced so silent IPC failures are visible). */
  fleetError?: string | null;
  onSaveCrewConfig?: (crew: CrewConfig) => Promise<void>;
  onRecheckReadiness?: () => void;
  readinessRefreshing?: boolean;
  readinessRefreshError?: string | null;
  /**
   * D1/D2 — the SAME per-vendor resolution map the Mission composer reads. The
   * Orchestrator Model select used to print a hardcoded "Vendor default" while
   * the composer printed a resolved model: one fact, two surfaces, two answers.
   * Both now index this map and render it through `modelDisplay`, so they
   * cannot disagree.
   */
  modelResolutions?: Partial<Record<string, VendorModelResolutionIpc | null>>;
  modelResolvingByVendor?: Partial<Record<string, boolean>>;
  onRequestModelResolution?: (vendor: VendorId) => void;
}) {
  const counts = props.state?.fleet?.counts ?? {};
  // Full fleet roster (NOT chat-scoped) — sizing + codenames are global seats.
  const agents = props.state?.fleet?.agents ?? [];
  // WAVE E: the fallback is DEFAULT_CREW_CONFIG itself, not a fourth hand-copied
  // literal of it that drifted from the real defaults.
  const crew = normalizeCrewConfig(
    props.state?.settings?.crew ?? DEFAULT_CREW_CONFIG
  );

  const [draft, setDraft] = useState(crew);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedReadinessIssue = orchestratorReadinessIssue(
    props.state?.readiness,
    draft.orchestratorVendor
  );
  const fallbackVendor = readyOrchestratorFallback(
    props.state?.readiness,
    draft.orchestratorVendor
  );

  useEffect(() => {
    setDraft(crew);
  }, [
    crew.orchestratorVendor,
    crew.orchestratorModel,
    crew.orchestratorEffort,
    JSON.stringify(crew.laneDefaults),
  ]);

  // Ask only for the vendor this page is actually showing, and only once the
  // page is mounted — navigating to Crew is a user action, never app settle.
  const orchestratorVendor = draft.orchestratorVendor;
  const requestModelResolution = props.onRequestModelResolution;
  useEffect(() => {
    requestModelResolution?.(orchestratorVendor);
  }, [orchestratorVendor, requestModelResolution]);

  // Built WITHOUT an explicit model: this describes what the "" option means,
  // i.e. what happens when the Crew config names no model at all.
  const orchestratorModelDisplay = modelDisplay({
    vendor: orchestratorVendor,
    resolution: props.modelResolutions?.[orchestratorVendor] ?? null,
    ...(props.modelResolvingByVendor?.[orchestratorVendor]
      ? { resolving: true }
      : {}),
  });

  const persist = async (next: typeof draft) => {
    setDraft(next);
    setSaveError(null);
    if (!props.onSaveCrewConfig) return;
    try {
      await props.onSaveCrewConfig(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (error) {
      setDraft(crew);
      setSaveError(
        error instanceof Error
          ? error.message
          : "Could not save the Crew configuration."
      );
    }
  };

  // ONE projection for every lane, shared with the Doctor strip so the two can
  // never disagree about a lane again (they used to: an UNKNOWN probe read as
  // "setup needed" here and "unknown" there).
  const lanes = buildLaneStatuses({
    // From the REGISTRY, never the probe payload — a retired lane (Ollama, cut
    // today) cannot reappear, and a lane the operator can size always has a row.
    vendors: FLEET_VENDORS,
    readiness: props.state?.readiness,
    meta: props.state?.readinessMeta,
    counts,
    agents,
  });
  const totals = summarizeLanes(lanes);
  const freshness = freshnessLabel(props.state?.readinessMeta);
  const probing =
    props.state?.readinessMeta?.state === "probing" ||
    props.state?.readinessMeta?.state === "refreshing" ||
    Boolean(props.readinessRefreshing);

  return (
    <div className="crew-panel crew-workspace">
      <header className="crew-workspace-head">
        <div className="crew-workspace-title">
          <strong>Crew</strong>
          {/* Freshness is `status`, never `alert`: an ageing probe is
              information, not a failure demanding attention. */}
          {freshness ? (
            <span
              className={`crew-freshness ${props.state?.readinessMeta?.state ?? "unknown"}`}
              role="status"
            >
              <span className="crew-freshness-dot" aria-hidden="true" />
              {freshness}
            </span>
          ) : null}
          {props.onRecheckReadiness ? (
            <button
              type="button"
              className="ghost-btn crew-recheck"
              disabled={props.readinessRefreshing}
              onClick={props.onRecheckReadiness}
            >
              {props.readinessRefreshing ? "Checking…" : "Re-check"}
            </button>
          ) : null}
        </div>
        <span>Fleet size, orchestrator seat, and per-vendor model defaults.</span>
      </header>

      <CrewSummary totals={totals} probing={probing} />

      {props.readinessRefreshError ? (
        <div className="crew-fleet-error" role="status">
          {props.readinessRefreshError}
        </div>
      ) : null}

      {props.fleetError ? (
        <div className="crew-fleet-error" role="alert">
          {props.fleetError}
        </div>
      ) : null}
      {saveError ? (
        <div className="crew-fleet-error" role="alert">
          {saveError}
        </div>
      ) : null}

      <section className="crew-orchestrator" aria-label="Orchestrator">
        <div className="crew-section-head">
          <strong>Orchestrator</strong>
          <span>Which vendor runs Mission chat (the super-agent).</span>
        </div>
        <label className="crew-field">
          Vendor
          <select
            value={draft.orchestratorVendor}
            onChange={(e) => {
              // WAVE D: the options are a projection of `coordinatorVendorIds()`.
              // The cast is not the gate — `normalizeCrewConfig` checks the same
              // projection on the way in, and the backend role ceiling
              // (`assertVendorMayHoldRole`) is the authority that actually
              // refuses a seat.
              void persist(
                selectOrchestratorVendor(draft, e.target.value as VendorId)
              );
            }}
          >
            {coordinatorVendorIds().map((vendor) => (
              <option key={vendor} value={vendor}>
                {vendorLabel(vendor)}
              </option>
            ))}
          </select>
        </label>
        <label className="crew-field">
          Model
          <select
            aria-label="Orchestrator model"
            value={draft.orchestratorModel || ""}
            title={
              draft.orchestratorModel ? undefined : orchestratorModelDisplay.title
            }
            onChange={(e) =>
              void persist(
                rememberOrchestratorPrefs(draft, {
                  model: e.target.value,
                })
              )
            }
          >
            {/*
              The VALUE stays "" — this is a label change only. "" is still
              "MUON names no model", the option grants nothing, and what MUON
              displays here can never become what MUON dispatches.
            */}
            <option value="">
              {vendorChoiceLabel(
                draft.orchestratorVendor,
                orchestratorModelDisplay
              )}
            </option>
            {knownModelsForVendor(draft.orchestratorVendor).map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="crew-field">
          Effort
          <select
            value={draft.orchestratorEffort}
            onChange={(e) =>
              void persist(
                rememberOrchestratorPrefs(draft, {
                  effort: e.target.value as typeof draft.orchestratorEffort,
                })
              )
            }
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </label>
        {selectedReadinessIssue ? (
          <ProviderReadinessNotice
            issue={selectedReadinessIssue}
            refreshing={props.readinessRefreshing}
            refreshError={props.readinessRefreshError}
            onRefresh={props.onRecheckReadiness}
            fallbackVendor={fallbackVendor}
            onUseFallback={(vendor) =>
              void persist(selectOrchestratorVendor(draft, vendor))
            }
          />
        ) : null}
        {saved ? <span className="settings-saved">Saved.</span> : null}
      </section>

      {props.missionEvents ? (
        <div className="crew-meter-grid">
          <MissionTokenUsagePanel events={props.missionEvents} />
          {/* The BRAKE next to the meter: seeing the spend and being unable to
              limit it was the whole of parity item 4. */}
          <MissionCapControl chatId={props.activeChatId ?? null} />
        </div>
      ) : null}

      <section className="crew-lanes" aria-label="Fleet lanes">
        <div className="crew-section-head">
          <strong>Fleet</strong>
          <span>
            0–3 managed workers per vendor. Every lane here takes managed
            dispatch; some are managed for a limited set of crew roles, noted on
            the lane. Names are stable codenames.
          </span>
        </div>
        {lanes.map((lane) => {
          const vendor = lane.vendor as FleetVendor;
          return (
            <VendorBlock
              key={vendor}
              vendor={vendor}
              lane={lane}
              agents={agents.filter(
                (agent) => agent.vendor === vendor && agent.ordinal >= 1
              )}
              taskTitles={props.taskTitles}
              // Model/effort knobs only for lanes with a MUON-known model
              // catalogue; a local lane is sizeable without a fabricated dropdown.
              {...(isCrewLaneVendor(vendor)
                ? {
                    laneDefault: draft.laneDefaults[vendor],
                    onLaneDefaultChange: (next: LaneDefaultConfig) =>
                      void persist({
                        ...draft,
                        laneDefaults: {
                          ...draft.laneDefaults,
                          [vendor]: next,
                        },
                      }),
                  }
                : {})}
              onStep={(delta) => props.onStepFleet(vendor, delta)}
              onOpenAgent={props.onOpenAgent}
            />
          );
        })}
      </section>
    </div>
  );
}

/**
 * The live counters above the lanes. Numbers only, in the quiet idiom: no
 * gauges, no colour beyond the existing status tokens. Reads as a sentence at a
 * glance and stays honest while the first probe is still running.
 */
function CrewSummary(props: {
  totals: ReturnType<typeof summarizeLanes>;
  probing: boolean;
}) {
  const { totals } = props;
  // Never a standalone "ready" — the noun stays attached so the line reads as
  // a count, not a verdict on the app as a whole.
  const stats: Array<{ key: string; value: number; label: string; tone: string }> =
    [
      { key: "ready", value: totals.ready, label: "lanes ready", tone: "ready" },
      {
        key: "attention",
        value: totals.needsAttention,
        label: "need setup",
        tone: "warn",
      },
      { key: "seats", value: totals.seats, label: "seats", tone: "idle" },
      { key: "working", value: totals.working, label: "working", tone: "live" },
    ];
  return (
    <div className="crew-summary" aria-label="Crew summary">
      {stats.map((stat) => (
        <div className={`crew-stat ${stat.tone}`} key={stat.key}>
          <b>{stat.value}</b>
          <span>{stat.label}</span>
        </div>
      ))}
      {totals.checking > 0 ? (
        <div className="crew-stat idle checking">
          <b>{totals.checking}</b>
          <span>{props.probing ? "checking" : "unchecked"}</span>
        </div>
      ) : null}
      {/* The honest dispatch verdict. Role-aware, mirroring the backend's own
          `anyVendorReady`: a ready lane whose entire ceiling is read-only
          (OpenCode holds `scout` only) does not make the app dispatch-capable
          on its own, so it must not read as if it does. Held back until every
          lane has been checked — an unfinished probe is not evidence of "no". */}
      {!totals.canDispatch && totals.checking === 0 ? (
        <div className="crew-summary-note">
          No lane can take unplanned work yet — connect Claude Code or Codex.
        </div>
      ) : null}
    </div>
  );
}

/**
 * ADR-0052 — THE CONSENT MOMENT, wherever it happens.
 *
 * This panel is rendered twice: on the full-screen gate and in Settings →
 * GitHub. Connecting here is what fires `registerDesktopInstall`, so this is the
 * screen that collects the consent for the install record — and it said nothing
 * about it. A review found the desktop POSTing an install record from a Settings
 * connect an operator had made to enable pull-request review, with no sentence
 * anywhere naming the record. `gateRecordDisclosure` is that sentence, composed
 * once in `@muon/client` and carried verbatim from main; it arrives only when
 * the gate is ARMED, which is exactly when connecting records anything.
 */

/**
 * Put the device code on the clipboard, reporting whether it actually landed.
 *
 * The device flow's one manual step is transcribing an 8-character code into a
 * browser that is about to steal focus, so copying it is the difference between
 * "paste" and "read it off a window you can no longer see". Returns a boolean
 * rather than throwing because a copy failure must NEVER block the sign-in —
 * the code is still on screen and still typable, so the UI degrades to exactly
 * what it did before.
 */
export async function copyDeviceCode(
  code: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.clipboard
): Promise<boolean> {
  if (!code || !clipboard?.writeText) return false;
  try {
    await clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
}

export function GitHubConnectPanel(props: {
  status: GitHubConnectionStatus | null;
  onStart: () => Promise<GitHubDeviceFlowStart>;
  onPoll: (flowId: string) => Promise<GitHubDeviceFlowUiPoll>;
  onDisconnect: () => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  /** `state.githubGate?.recordDisclosure` — present ⇒ connecting files a
   *  record, and this is the sentence that says so. Never composed here. */
  gateRecordDisclosure?: string;
  /** `state.githubGate?.registration` — the quiet status line for a record that
   *  has not landed yet (F3). */
  gateRegistration?: {
    state: "open" | "locked" | "locked-unregistered";
    detail?: string;
  };
  /**
   * Rendered on the GATE SCREEN, where `status.connected` can be TRUE while the
   * gate stays locked: `muon github login` (or a sign-in whose registration
   * never landed) connects the LIVE brain without leaving the app a credential.
   * Founder bug (2026-08-19): the panel showed a green "Connected as X" row —
   * whose only control was Disconnect — beside a lock that would not open.
   * When locked, the panel must offer the door (Connect), never a status row
   * claiming a satisfaction the gate does not recognize.
   */
  gateLocked?: boolean;
}) {
  const [flow, setFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!flow) {
      return;
    }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await props.onPoll(flow.flowId);
        if (canceled) return;
        if (result.status === "pending") {
          setMessage("Waiting for authorization…");
          timer = setTimeout(poll, result.retryAfterMs);
          return;
        }
        if (result.status === "connected") {
          setMessage(
            result.login ? `Connected as ${result.login}.` : "GitHub connected."
          );
          setFlow(null);
          return;
        }
        setMessage(result.message);
        setFlow(null);
      } catch (error) {
        if (canceled) return;
        setMessage(
          error instanceof Error
            ? error.message
            : "GitHub authorization failed."
        );
        setFlow(null);
      }
    };
    timer = setTimeout(poll, flow.intervalMs);
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [flow, props.onPoll]);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await props.onStart();
      setFlow(next);
      // Copy BEFORE opening the browser: the moment the browser takes focus the
      // user is looking at GitHub's "enter code" box, and the code they need is
      // back in a window they can no longer see. The result drives the code
      // row below — "on your clipboard" is a claim, so it is only made when the
      // clipboard actually took the code.
      const autoCopied = await copyDeviceCode(next.userCode);
      setCopied(autoCopied ? "copied" : "failed");
      setMessage(null);
      await props.onOpenUrl(next.verificationUri);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not start GitHub setup."
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await props.onDisconnect();
      setFlow(null);
      // WHICH SURFACES THIS RE-LOCKS, said out loud — the mirror of `muon
      // logout`'s copy. Disconnect now clears the shared credential too, so it
      // signs out the CLI and `muon-mcp` on this machine as well; an operator
      // who is handing the laptop over needs to know that happened, and one who
      // only meant to unlink an account needs to know it went further than the
      // app. Only claimed when the gate is armed, because that is when the
      // credential file exists at all.
      setMessage(
        props.gateRecordDisclosure
          ? "GitHub disconnected. This also signed out the `muon` CLI and `muon-mcp` on this machine — they re-lock until the next `muon login`."
          : "GitHub disconnected."
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not disconnect GitHub."
      );
    } finally {
      setBusy(false);
    }
  };

  const login = props.status?.login ?? null;

  return (
    <div className="github-connect">
      {props.status?.connected && !props.gateLocked ? (
        <div className="github-account-row">
          <div className="github-account-identity">
            <span className="github-mark" aria-hidden="true">
              <svg
                viewBox="0 0 16 16"
                width="18"
                height="18"
                fill="currentColor"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </span>
            <div className="github-account-meta">
              <strong className="github-account-login">
                {login ?? "GitHub account"}
              </strong>
              <span className="github-account-sub">
                <span className="dot working" aria-hidden="true" />
                Connected as {login ?? "this Mac"}
              </span>
            </div>
          </div>
          <button
            className="secondary-btn github-disconnect"
            disabled={busy}
            onClick={() => void disconnect()}
            type="button"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="github-account-row github-account-row-idle">
          <div className="github-account-identity">
            <span className="github-mark muted" aria-hidden="true">
              <svg
                viewBox="0 0 16 16"
                width="18"
                height="18"
                fill="currentColor"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </span>
            <div className="github-account-meta">
              <strong className="github-account-login">GitHub</strong>
              <span className="github-account-sub">
                {props.gateLocked
                  ? "Sign in to unlock this Mac"
                  : "Read-only PR checks for this Mac"}
              </span>
            </div>
          </div>
          <button
            className="primary-btn github-connect-btn"
            disabled={busy || props.status?.configured === false}
            onClick={() => void start()}
            type="button"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}

      {/* Locked while the brain reports connected: name the split instead of
          showing a green row. One sentence, one remedy. */}
      {props.gateLocked && props.status?.connected ? (
        <p className="github-connect-note" role="status">
          GitHub is connected for this machine&apos;s live brain
          {props.status.login ? ` (as ${props.status.login})` : ""}, but the app
          has not stored its own sign-in yet — run <code>muon login</code> in a
          terminal, or click Connect to finish here.
        </p>
      ) : null}

      {props.status?.configured === false ? (
        <p className="github-connect-note">
          Set MUON_GITHUB_CLIENT_ID to enable device authorization.
        </p>
      ) : null}

      {/* VERBATIM from main. The same three-clause sentence `muon login` prints
          before the browser opens and every gate refusal ends with. */}
      {props.gateRecordDisclosure ? (
        <p className="github-connect-note">{props.gateRecordDisclosure}</p>
      ) : null}

      {/* F3 — a deferred record, said quietly and completely: what is true, that
          MUON is handling it, and that the only affected surfaces are the ones
          that need the record. Never "an error occurred". */}
      {props.gateRegistration?.state === "locked-unregistered" ? (
        <p className="github-connect-note" role="status">
          This install is verified but not recorded with the MUON project yet —
          MUON retries automatically when online, and nothing here needs doing.
          Until it lands, the CLI and <code>muon-mcp</code> on this machine stay
          locked.
          {props.gateRegistration.detail
            ? ` (last attempt: ${props.gateRegistration.detail})`
            : ""}
        </p>
      ) : null}

      {flow ? (
        <div className="github-device-code" role="status">
          {/* One code, one sentence, one quiet button (founder, 2026-08-19:
              the two-ghost-button row "looks really bad"). The code was copied
              and the browser opened by `start()`; the steady state is a claim
              — "on your clipboard, paste it on GitHub" — not a control. The
              copy button returns ONLY when the clipboard refused, because that
              is the one case with something left to do here. */}
          <code>{flow.userCode}</code>
          <span className="github-device-code-hint">
            {copied === "copied"
              ? "on your clipboard — paste it on GitHub to authorize"
              : "enter this code on GitHub to authorize"}
          </span>
          <div className="github-device-code-actions">
            {copied !== "copied" ? (
              <button
                className="ghost-btn"
                onClick={() => {
                  void copyDeviceCode(flow.userCode).then((ok) =>
                    setCopied(ok ? "copied" : "failed")
                  );
                }}
                type="button"
              >
                {copied === "failed" ? "Copy code" : "Copy"}
              </button>
            ) : null}
            {/* The browser may have been closed by the time the user comes
                back; re-opening stays available, quietly. */}
            <button
              className="ghost-btn"
              onClick={() => void props.onOpenUrl(flow.verificationUri)}
              type="button"
            >
              Open GitHub
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="github-connect-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * CONNECTIONS — one row per agent CLI you can register MUON's MCP server with,
 * beside the GitHub connect row. S1 of
 * docs/design/cc-as-superagent-delivery.md §5.
 *
 * This is a STATUS surface, not a call to action (quiet-design-system §2, §5):
 * an already-registered vendor reads as a calm fact with a dot, and Install is a
 * quiet ghost button, never an accent-filled primary. Registering MUON is
 * useful, not urgent, and four accent buttons in a settings pane would be four
 * things shouting at a user who came here to check something.
 *
 * EVERY value below is a field on the ONE `McpStatusReport` that `muon mcp
 * status` and the TUI's `/mcp` panel render — it arrives over the typed bridge
 * from main, where the shared evaluator runs. The renderer computes no check, no
 * level, no reason, no config path and neither of the two per-vendor booleans.
 *
 * NEVER A DEAD END (first-run rule): when Install cannot work, the button is
 * disabled AND the row says why in the same breath — the vendor CLI is not
 * installed, or no executable `muon-mcp` resolved on this machine. A disabled
 * control with no sentence next to it is the failure this rule exists to stop.
 */
/** F8: verdict → the row's state word (shared assessor, desktop wording). */
const DRIFT_LABELS: Record<McpVendorDrift["verdict"], string> = {
  "in-sync": "Registered · in sync",
  drifted: "Registered · drifted",
  broken: "Registered · broken path",
  "not-registered": "Not registered",
  "vendor-missing": "CLI not installed",
};

function McpVendorRow(props: {
  row: McpVendorStatus;
  /** F8 (ADR-0019 R2 slice): this vendor's drift verdict from the shared
   *  assessor — the same one `muon mcp status` prints. */
  drift?: McpVendorDrift;
  /** Null while the machine-level command probe is still unknown. */
  resolvedCommand: string | null;
  busy: boolean;
  result: McpInstallReport | null;
  onInstall: (vendor: VendorId) => void;
  /** ADR-0028 Tier C. Present ⇒ this vendor's root job is attached RIGHT NOW,
   *  per the live dispatch job list — never derived from this row's own
   *  install state, which answers a different question ("is MUON registered
   *  in the config file") from this one ("is a governed seat live"). */
  attached?: { jobId: string; chatId: string | null };
  attachBusy: boolean;
  attachResult: McpAttachResult | McpDetachResult | null;
  onAttach?: (vendor: VendorId) => void;
  onDetach?: (vendor: VendorId) => void;
}) {
  const { row } = props;
  // Two independent reasons Install cannot run, both surfaced as prose.
  const blocked = !row.cliInstalled
    ? `${row.cli} is not on this machine. MUON never installs or signs you in to an agent CLI — install it yourself, then re-check.`
    : props.resolvedCommand === null
      ? "No executable 'muon-mcp' resolved on this machine, so MUON has no verified path to record."
      : null;
  const stale = row.installed && row.commandResolves === false;

  return (
    <div className="mcp-row">
      <div className="mcp-row-head">
        {/* A 6px status dot in the subtle status colour, per
            docs/design/quiet-design-system.md §5 — never a filled signal square
            and never `.dot.working`, whose pulse animation would read as live
            activity on what is a settled fact. */}
        <span
          className={`dot ${
            stale ? "failure" : row.installed ? "success" : "neutral"
          }`}
        />
        <strong>{row.label}</strong>
        <span className="mcp-row-state">
          {props.drift ? DRIFT_LABELS[props.drift.verdict] : row.installed ? "Registered" : "Not registered"}
        </span>
        <button
          className="ghost-btn mcp-install-btn"
          disabled={props.busy || blocked !== null}
          onClick={() => props.onInstall(row.vendor)}
        >
          {props.busy
            ? "Registering…"
            : row.installed
              ? stale
                ? "Re-register"
                : "Re-register"
              : "Install"}
        </button>
      </div>

      {/* The head line above is this row's answer; the paths and capability
          booleans are reference. Folded (never dropped) so four vendors do not
          stack twenty fact rows down the Settings page — the facts stay in the
          DOM and in the accessible tree, one disclosure away. */}
      <details className="mcp-row-more">
        <summary>Paths and capabilities</summary>
        <dl className="mcp-row-facts">
          <dt>Config</dt>
          <dd className="mcp-mono">{row.configPath}</dd>
          <dt>Command</dt>
          <dd className="mcp-mono">{row.command ?? "—"}</dd>
          <dt>Resolves</dt>
          <dd className={stale ? "mcp-bad" : undefined}>
            {row.commandResolves === null
              ? "n/a"
              : row.commandResolves
                ? "yes"
                : "no — the recorded path no longer exists"}
          </dd>
          {/* TWO SEPARATE BOOLEANS, never one without the other. Conflating
              "MUON can install into it" with "it can coordinate a crew" is the
              documentation failure ADR-0022 warns about; cursor and opencode
              are installable and hold no seat. */}
          <dt>Installable</dt>
          <dd>{row.installable ? "yes" : "no"}</dd>
          <dt>Coordinator seat</dt>
          <dd>
            {row.coordinatorSeat ? "yes" : "no"}
            <span className="mcp-note">
              {row.coordinatorSeat
                ? " — it can be the superagent that dispatches a crew"
                : " — it can use MUON's memory + code graph, never coordinate a crew"}
            </span>
          </dd>
        </dl>
      </details>

      {blocked ? <p className="mcp-note mcp-blocked">{blocked}</p> : null}

      {/* F8: drift findings from the shared assessor — the same sentences
          `muon mcp status` prints, so the two surfaces cannot disagree.
          The row's own reasons render below unchanged; the assessor only
          ADDS the expected-vs-observed verdict sentences. */}
      {(props.drift?.findings ?? [])
        .filter((finding) => finding.code !== "vendor-reason")
        .map((finding) => (
          <p
            key={finding.code}
            className={`mcp-note ${finding.severity === "error" ? "mcp-bad" : ""}`}
          >
            {finding.detail}
            {finding.fix ? <code> {finding.fix}</code> : null}
          </p>
        ))}

      {row.reasons.map((reason) => (
        <p
          key={reason.id}
          className={`mcp-note ${reason.level === "fail" ? "mcp-bad" : ""}`}
        >
          {reason.detail}
        </p>
      ))}

      {props.result ? (
        <p className="mcp-note" role="status">
          {props.result.outcome.kind === "refused"
            ? props.result.outcome.reason
            : props.result.outcome.kind === "already-current"
              ? `Already registered with exactly this command — nothing was written. Restart ${row.cli} if it is running.`
              : `Registered in ${props.result.outcome.configPath}. No token, no API base and no mode were written. Restart ${row.cli} to pick it up.`}
        </p>
      ) : null}

      {/* ADR-0028 Tier C — only a coordinator-seat vendor can ever hold an
          attached seat; cursor/opencode never render this block at all, the
          same "two separate booleans" discipline as the facts list above.
          Also omitted wholesale when neither handler is wired, so an older
          caller/build that has not adopted attach/detach yet mounts exactly
          as it did before this feature existed. */}
      {row.coordinatorSeat && (props.onAttach || props.onDetach) ? (
        <div className="mcp-row-attach">
          <span
            className={`dot ${props.attached ? "success" : "neutral"}`}
          />
          <span className="mcp-row-state">
            {props.attached
              ? "Attached coordinator (non-hermetic)"
              : "Not attached"}
          </span>
          {props.attached ? (
            <button
              className="ghost-btn"
              disabled={props.attachBusy}
              onClick={() => props.onDetach?.(row.vendor)}
            >
              {props.attachBusy ? "Detaching…" : "Detach"}
            </button>
          ) : (
            <button
              className="ghost-btn"
              disabled={props.attachBusy || !props.onAttach}
              onClick={() => props.onAttach?.(row.vendor)}
            >
              {props.attachBusy ? "Attaching…" : "Attach"}
            </button>
          )}
          <span className="mcp-note">
            {props.attached
              ? "Governs the crew a terminal session you start yourself may dispatch. Detach (or close that terminal) to release the seat."
              : "Mints a governed dispatch seat for a terminal session you start and run yourself — never a MUON-launched one."}
          </span>
          {props.attachResult ? (
            <p className="mcp-note" role="status">
              {props.attachResult.kind === "refused"
                ? props.attachResult.reason
                : props.attachResult.kind === "attached"
                  ? `Attached — restart ${row.cli} to pick up the new MCP entry.`
                  : props.attachResult.kind === "detached"
                    ? `Detached and reverted ${row.cli}'s MCP config to base.`
                    : props.attachResult.kind === "partial"
                      ? `Detach incomplete: ${props.attachResult.notes.join(" · ")}`
                    : "Nothing was attached — already clean."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function McpConnectionsPanel(props: {
  /** null = the first read has not landed yet (loading). */
  report: McpStatusReport | null;
  loading: boolean;
  /** An honest sentence when the read itself failed. */
  error: string | null;
  onRefresh: () => void;
  onInstall: (vendor: VendorId) => Promise<McpInstallReport>;
  /** ADR-0028 Tier C. All three optional — an older caller that omits them
   *  still mounts, with no attach/detach controls rendered (see the
   *  `props.onAttach ? … : undefined` guard in `McpVendorRow`). */
  attachedByVendor?: ReadonlyMap<
    VendorId,
    { jobId: string; chatId: string | null }
  >;
  onAttach?: (vendor: VendorId) => Promise<McpAttachResult>;
  onDetach?: (vendor: VendorId) => Promise<McpDetachResult>;
  /** Optional: an older caller renders no probe control at all. */
  onProbe?: (input?: { mode?: string }) => Promise<McpProbeReport>;
}) {
  const [busyVendor, setBusyVendor] = useState<VendorId | null>(null);
  const [results, setResults] = useState<
    Partial<Record<VendorId, McpInstallReport>>
  >({});
  const [attachBusyVendor, setAttachBusyVendor] = useState<VendorId | null>(
    null
  );
  const [attachResults, setAttachResults] = useState<
    Partial<Record<VendorId, McpAttachResult | McpDetachResult>>
  >({});

  const install = async (vendor: VendorId) => {
    setBusyVendor(vendor);
    try {
      const result = await props.onInstall(vendor);
      setResults((prior) => ({ ...prior, [vendor]: result }));
      props.onRefresh();
    } catch (error) {
      // A rejected bridge call must still produce a sentence, never a silently
      // stuck button.
      setResults((prior) => ({
        ...prior,
        [vendor]: {
          vendor,
          scope: "user",
          command: null,
          outcome: {
            kind: "refused",
            reason:
              error instanceof Error
                ? error.message
                : "Could not register MUON with that agent CLI.",
          },
        },
      }));
    } finally {
      setBusyVendor(null);
    }
  };

  const attach = async (vendor: VendorId) => {
    if (!props.onAttach) return;
    setAttachBusyVendor(vendor);
    try {
      const result = await props.onAttach(vendor);
      setAttachResults((prior) => ({ ...prior, [vendor]: result }));
    } catch (error) {
      setAttachResults((prior) => ({
        ...prior,
        [vendor]: {
          kind: "refused",
          reason:
            error instanceof Error
              ? error.message
              : "Could not attach that coordinator.",
        },
      }));
    } finally {
      setAttachBusyVendor(null);
    }
  };

  const detach = async (vendor: VendorId) => {
    if (!props.onDetach) return;
    setAttachBusyVendor(vendor);
    try {
      const result = await props.onDetach(vendor);
      setAttachResults((prior) => ({ ...prior, [vendor]: result }));
    } catch (error) {
      setAttachResults((prior) => ({
        ...prior,
        [vendor]: {
          kind: "not-attached",
          jobId: null,
          notes: [
            error instanceof Error
              ? error.message
              : "Could not detach that coordinator.",
          ],
        },
      }));
    } finally {
      setAttachBusyVendor(null);
    }
  };

  return (
    <div className="mcp-connections">
      <p className="mcp-lede">
        {"Register MUON's MCP server with an agent CLI you start yourself, so " +
          "that session gets MUON's memory graph and code understanding. MUON " +
          "writes no token and no API base — the entry discovers this machine's " +
          "brain on its own."}
      </p>

      {props.report ? (
        <p className="mcp-summary">
          A session you start yourself gets <strong>{props.report.tier}</strong>{" "}
          tier and {props.report.toolCount} tools · credential from{" "}
          <strong>{props.report.tokenSource}</strong> · brain{" "}
          <strong>{props.report.brainRunning ? "running" : "not running"}</strong>
        </p>
      ) : null}

      {props.error ? (
        // The read failed: say so in one line and keep the way forward live.
        <div className="mcp-error" role="status">
          <p className="mcp-note mcp-bad">{props.error}</p>
          <button className="ghost-btn" onClick={props.onRefresh}>
            Try again
          </button>
        </div>
      ) : props.report === null ? (
        <p className="mcp-note" role="status">
          {props.loading
            ? "Reading each agent CLI's own MCP config…"
            : "Not checked yet."}
        </p>
      ) : props.report.vendors.length === 0 ? (
        // Cannot happen with today's positive vendor table, and is still
        // rendered rather than left blank: an empty list must read as a fact.
        <p className="mcp-note">
          {"No agent CLI on this build can hold MUON's MCP server."}
        </p>
      ) : (
        <>
          {props.report.vendors.map((row) => (
            <McpVendorRow
              key={row.vendor}
              row={row}
              drift={assessMcpDrift(props.report!).vendors.find(
                (entry) => entry.vendor === row.vendor
              )}
              resolvedCommand={props.report?.resolvedCommand ?? null}
              busy={busyVendor === row.vendor}
              result={results[row.vendor] ?? null}
              onInstall={(vendor) => void install(vendor)}
              attached={props.attachedByVendor?.get(row.vendor)}
              attachBusy={attachBusyVendor === row.vendor}
              attachResult={attachResults[row.vendor] ?? null}
              onAttach={
                props.onAttach ? (vendor) => void attach(vendor) : undefined
              }
              onDetach={
                props.onDetach ? (vendor) => void detach(vendor) : undefined
              }
            />
          ))}
          <McpProbeRow
            probe={props.onProbe}
            // What the vendors' OWN entries declare, so the default probe
            // measures the surface they actually receive.
            configuredModes={props.report.vendors
              .map((row) => row.mode)
              .filter((value): value is string => Boolean(value))}
          />
          <div className="mcp-actions">
            <button
              className="ghost-btn"
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              {props.loading ? "Re-checking…" : "Re-check"}
            </button>
            <span className="mcp-note">
              MUON governs what a registered session may do to the crew and to
              memory. It does not govern what that session does to your files —
              your own agent-CLI permissions do.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Settings -> Command Line Tools (founder request, 2026-08-17): the DMG side
 * of curl<->desktop parity. A DMG-only install carries `muon`/`muon-tui`/
 * `muon-mcp` inside the app bundle but nothing on PATH — this is the quiet,
 * per-binary status row (mirrors `McpConnectionsPanel`'s shape) plus a
 * Link/Unlink pair. Link is idempotent and per-binary: a foreign file at one
 * target path (say a tarball-installed `muon`) does not block linking the
 * other two.
 */
export function CliLinkPanel(props: {
  /** null = the first read has not landed yet. */
  status: CliLinkStatusReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onLink: () => Promise<CliLinkResult>;
  onUnlink: () => Promise<CliUnlinkResult>;
}) {
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [lastMessages, setLastMessages] = useState<string[] | null>(null);

  const runLink = async () => {
    setBusy("link");
    setLastMessages(null);
    try {
      const result = await props.onLink();
      setLastMessages(
        result.kind === "unavailable"
          ? [result.reason]
          : result.entries.map((entry) =>
              entry.action === "written"
                ? `${entry.bin}: ${entry.detail} ${entry.targetPath}`
                : entry.action === "already-linked"
                  ? `${entry.bin}: already linked`
                  : `${entry.bin}: not linked — ${entry.reason}`
            )
      );
      props.onRefresh();
    } catch (error) {
      setLastMessages([
        error instanceof Error ? error.message : "Could not link the CLI.",
      ]);
    } finally {
      setBusy(null);
    }
  };

  const runUnlink = async () => {
    setBusy("unlink");
    setLastMessages(null);
    try {
      const result = await props.onUnlink();
      setLastMessages(
        result.kind === "unavailable"
          ? [result.reason]
          : result.entries.map((entry) =>
              entry.action === "removed"
                ? `${entry.bin}: removed ${entry.targetPath}`
                : entry.action === "absent"
                  ? `${entry.bin}: nothing to remove`
                  : `${entry.bin}: left in place — ${entry.reason}`
            )
      );
      props.onRefresh();
    } catch (error) {
      setLastMessages([
        error instanceof Error ? error.message : "Could not unlink the CLI.",
      ]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cli-link-panel">
      <p className="mcp-lede">
        {"Make the muon, muon-tui and muon-mcp commands this app carries " +
          "available in your terminal, as three small scripts in " +
          "~/.local/bin. No sudo, and nothing written outside that one " +
          "folder — Unlink removes exactly what Link wrote."}
      </p>

      {props.error ? (
        <div className="mcp-error" role="status">
          <p className="mcp-note mcp-bad">{props.error}</p>
          <button className="ghost-btn" onClick={props.onRefresh}>
            Try again
          </button>
        </div>
      ) : props.status === null ? (
        <p className="mcp-note" role="status">
          {props.loading ? "Checking ~/.local/bin…" : "Not checked yet."}
        </p>
      ) : props.status.kind === "unavailable" ? (
        <p className="mcp-note">{props.status.reason}</p>
      ) : (
        <>
          {props.status.entries.map((row) => (
            <div className="mcp-row" key={row.bin}>
              <div className="mcp-row-head">
                <span className={`dot ${cliLinkDotClass(row.state)}`} />
                <strong>{row.bin}</strong>
                <span className="mcp-row-state">
                  {cliLinkStateLabel(row.state)}
                </span>
              </div>
              <span className="mcp-mono">{row.targetPath}</span>
            </div>
          ))}
          <div className="mcp-actions">
            <button
              className="ghost-btn"
              disabled={busy !== null}
              onClick={() => void runLink()}
            >
              {busy === "link" ? "Linking…" : "Link"}
            </button>
            <button
              className="ghost-btn"
              disabled={busy !== null}
              onClick={() => void runUnlink()}
            >
              {busy === "unlink" ? "Unlinking…" : "Unlink"}
            </button>
            <span className="mcp-note">
              {"~/.local/bin must be on your shell's PATH for these to run " +
                "by name — add it to your shell profile if it is not."}
            </span>
          </div>
          {lastMessages ? (
            <ul className="mcp-row-facts">
              {lastMessages.map((message, index) => (
                // eslint-disable-next-line react/no-array-index-key -- a
                // fixed-order, non-reorderable status list for one action.
                <li key={index} className="mcp-note">
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

function cliLinkDotClass(state: CliLinkBinStatus["state"]): string {
  switch (state) {
    case "linked-current":
      return "success";
    case "linked-stale":
      return "pending";
    case "foreign":
      return "failure";
    default:
      return "neutral"; // "absent"
  }
}

function cliLinkStateLabel(state: CliLinkBinStatus["state"]): string {
  switch (state) {
    case "linked-current":
      return "linked";
    case "linked-stale":
      return "linked, app moved — Link to refresh";
    case "foreign":
      return "not MUON's — left alone";
    default:
      return "not linked"; // "absent"
  }
}

/**
 * One chat row: the selectable chat button plus a hover-revealed archive
 * ("delete") affordance. Archive is a destructive-feeling but SOFT act, so it
 * is never one-click — the first click ARMS the control (turns it into a solid
 * red confirm chip), a second click fires. Escalates the accessible label when
 * the chat still has live worker jobs (S7). The archive button stops event
 * propagation so it never selects the row it lives in.
 */
export function workspaceDiffTotals(
  review: WorkspaceReview | null | undefined
): { additions: number; deletions: number } | null {
  if (!review || review.status !== "available") {
    return null;
  }
  return review.fileStats.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}

/**
 * Projects → sessions (spec R1): chats grouped by their workspace folder,
 * groups in first-seen order, sessions keeping the list's own order. The KEY
 * is the full path (two folders may share a leaf name); the LABEL is the leaf.
 */
function groupChatsByWorkspace<T extends { workspacePath: string }>(
  chats: readonly T[]
): { key: string; label: string; chats: T[] }[] {
  const groups = new Map<string, { key: string; label: string; chats: T[] }>();
  for (const chat of chats) {
    const key = chat.workspacePath.replace(/[\\/]+$/, "");
    const existing = groups.get(key);
    if (existing) {
      existing.chats.push(chat);
    } else {
      groups.set(key, {
        key,
        label: workspaceLabel(chat.workspacePath),
        chats: [chat],
      });
    }
  }
  return [...groups.values()];
}

function workspaceLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || workspacePath;
}

/**
 * H9 — which tree a session's work is actually IN, from the ledger's own field.
 *
 * `executionPath` is what the lease-holding runner recorded (ADR-0048): the run
 * had its own worktree and its changes are NOT in the checkout. Without one the
 * run edited the workspace directly, which is a different and quieter fact — so
 * it gets a different, quieter marker rather than a shared label that sends an
 * operator looking for changes in the wrong directory. No job at all yields
 * NOTHING: a row that has dispatched no work has no tree to name, and inventing
 * one (a branch name, a guess from the workspace) is the failure this exists to
 * prevent.
 */
export type SessionTree =
  | { kind: "worktree"; label: string; path: string }
  | { kind: "workspace" }
  | null;

export function sessionTree(
  job: { executionPath?: string | null } | null | undefined
): SessionTree {
  if (!job) {
    return null;
  }
  const path = job.executionPath?.trim();
  if (!path) {
    return { kind: "workspace" };
  }
  return { kind: "worktree", label: workspaceLabel(path), path };
}

/**
 * H9 — attention rank inside a group: blocked-at-gate outranks working, which
 * outranks idle. Lower sorts first. MUON's extra state is the loudest thing on
 * the rail because it is the only one that cannot proceed without a human.
 */
export function attentionRank(input: {
  blockedApprovals: number;
  runningJobs: number;
}): number {
  if (input.blockedApprovals > 0) return 0;
  if (input.runningJobs > 0) return 1;
  return 2;
}

/**
 * Stable rank sort: equal-rank rows keep the list's own order, so a row never
 * jumps position for a reason the human cannot see.
 */
export function orderByAttention<T>(
  rows: readonly T[],
  rank: (row: T) => number
): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.row);
}

function ChatRow(props: {
  chat: OrchestratorChatRecord;
  active: boolean;
  runningJobs: number;
  /** Pending gates on this chat (spec R7) — blocked-at-gate, rendered loudest. */
  blockedApprovals?: number;
  /** H9 — the bound worktree, or the quiet "workspace" fact, or nothing. */
  sessionTree?: SessionTree;
  /** H10 — the speakable name for this session's review-target job. */
  sessionName?: string | null;
  workspaceReview: WorkspaceReview | null;
  workspaceReviewLoading: boolean;
  listeningPorts: ListeningPortSnapshot[];
  portPreviewEnabled: boolean;
  onOpenPortPreview?: (port: number) => void;
  onSelect: () => void;
  onArchive: () => void;
  /** Present when the parent wires the chat-level cancel. */
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const diff = workspaceDiffTotals(props.workspaceReview);
  const archiveLabel = confirming
    ? props.runningJobs > 0
      ? // Archive STOPS this work first and refuses if it cannot — say so, so
        // the second click is an informed one.
        `Confirm archive — stops ${props.runningJobs} active job${
          props.runningJobs === 1 ? "" : "s"
        } first`
      : "Confirm archive"
    : "Archive chat";
  const cancelLabel = props.cancelling
    ? "Stopping this chat's jobs…"
    : `Stop ${props.runningJobs} active job${
        props.runningJobs === 1 ? "" : "s"
      } in this chat`;
  return (
    <div
      className={`chat-row${props.active ? " active" : ""}`}
      // Leaving the row disarms a half-confirmed archive so it can't linger
      // invisibly (the button hides on mouse-out) and fire on a later stray click.
      onMouseLeave={() => setConfirming(false)}
    >
      <button
        className="chat-item"
        onClick={props.onSelect}
        title={props.chat.workspacePath}
      >
        <span className="workspace-row-copy">
          {/* Session card (spec R4–R7): title, mono slug with branch glyph,
              status. The workspace leaf no longer repeats here — the GROUP
              header already names the project. */}
          <span className="chat-title session-card-title">
            {props.chat.title}
          </span>
          <span className="session-card-slug">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <circle cx="4.5" cy="4" r="1.7" />
              <circle cx="4.5" cy="12" r="1.7" />
              <circle cx="11.5" cy="8" r="1.7" />
              <path d="M4.5 5.7v4.6M9.8 8H8a3.5 3.5 0 0 1-3.5-2.3" />
            </svg>
            {/* H10: the SPEAKABLE name first (what a human says in a review),
                the chat coordinate second (what a human pastes). Only the
                coordinate truncates — the name is the half that must survive a
                narrow rail. Identity is still the id: the slug is derived from
                it at render time, stored nowhere. */}
            {props.sessionName ? (
              <span className="session-card-name">{props.sessionName}</span>
            ) : null}
            <span className="slug-text">
              session/{props.chat.id.slice(0, 12)}
            </span>
          </span>
          <span
            className={
              "session-card-status " +
              ((props.blockedApprovals ?? 0) > 0
                ? "blocked"
                : props.runningJobs > 0
                  ? "working"
                  : "idle")
            }
          >
            <span className="status-glyph" aria-hidden="true" />
            {(props.blockedApprovals ?? 0) > 0
              ? `Blocked — ${props.blockedApprovals} gate${
                  props.blockedApprovals === 1 ? "" : "s"
                }`
              : props.runningJobs > 0
                ? "Working"
                : "Idle"}
          </span>
          <span className="workspace-row-meta session-card-meta-row">
            {/* H9 — WHICH TREE, from `executionPath` and nothing else. The leaf
                is shown (a full worktree path never fits a rail); the full path
                is the tooltip and the accessible name. */}
            {props.sessionTree?.kind === "worktree" ? (
              <span
                className="session-tree-badge worktree"
                title={props.sessionTree.path}
                aria-label={`Worktree ${props.sessionTree.path}`}
              >
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M2 4.2h4.2l1.1 1.4H14v6.2H2z" strokeLinejoin="round" />
                </svg>
                <span className="tree-text">{props.sessionTree.label}</span>
              </span>
            ) : props.sessionTree?.kind === "workspace" ? (
              <span
                className="session-tree-badge workspace"
                title={`No isolated worktree — this session works directly in ${props.chat.workspacePath}`}
              >
                workspace
              </span>
            ) : null}
            {diff ? (
              <span
                aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}
                className="workspace-diff-badge"
              >
                <span className="numstat-add">+{diff.additions}</span>
                <span className="numstat-del">−{diff.deletions}</span>
              </span>
            ) : props.workspaceReviewLoading ? (
              <span className="workspace-review-loading">Checking changes…</span>
            ) : null}
            {/* Listening-port badges deliberately do NOT live here. A chat row
                is chat identity + chat management; a transient `:52994
                cursorsandbox` chip is neither, and it pushed the title out of
                a narrow rail. Port discovery still runs and still surfaces
                through the workspace/ports surface — this row just stopped
                being the place it shouts from. */}
          </span>
        </span>
        {/* Workspace path lives in the title tooltip for mouse users;
            this keeps it reachable for keyboard/AT users too. */}
        <span className="sr-only">{props.chat.workspacePath}</span>
      </button>
      {/* The per-row STOP control is deliberately gone: a workspace row is chat
          identity + chat management, and its primary action is "switch to this
          chat" — putting "kill this chat's crew" one pixel away is how a
          misclick ends a live mission. It was NOT deleted, which would have
          left "stop everything" as the only stop MUON has: it moved to the
          command palette ("Stop this chat's jobs"), a deliberate action that
          costs the row nothing. `onCancel` is still the same governed IPC. */}
      <button
        className={`chat-delete${confirming ? " confirming" : ""}`}
        aria-label={archiveLabel}
        title={archiveLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          props.onArchive();
        }}
        onBlur={() => setConfirming(false)}
      >
        <span aria-hidden="true">{confirming ? "✓" : "✕"}</span>
      </button>
    </div>
  );
}

/**
 * ADR-0013 #52, the desktop reads the SAME vendor capability descriptor as the
 * TUI palette and renders the equivalent affordance: a readiness-aware list of
 * `/<action> [vendor]` flags, each with a vendor badge + a parity/gate chip.
 * Only actions a lane can honour in one-shot mode are offered; the four
 * invariant-guarded features either carry a gate chip (full-auto/system-prompt)
 * or stay hidden (cloud/egress) until the operator opts in.
 */
export function VendorActionsSection(props: { state: DesktopState | null }) {
  const menu = buildVendorActionMenu({
    readiness: props.state?.readiness ?? null,
    mode: "one-shot",
  }).filter(
    (item) =>
      item.ready && (item.gate !== "none" || item.parity !== "clean")
  );
  if (menu.length === 0) {
    return null;
  }
  return (
    <details className="side-section vendor-actions">
      <summary className="side-heading">
        <span>Advanced commands</span>
        <b>{menu.length}</b>
      </summary>
      <div className="vendor-action-list">
        {menu.slice(0, 8).map((item) => (
          <div
            key={`${item.vendor}:${item.actionId}`}
            className="vendor-action-row"
            title={item.note ?? item.label}
          >
            <span>
              <span className="vendor-action-cmd">/{item.command}</span>
              <small>{item.vendorLabel}</small>
            </span>
            <span className={`vendor-action-chip chip-${chipTone(item.chip)}`}>
              {item.chip}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

/** Map a parity/gate chip to a coarse CSS tone (matches the TUI colour rule). */
function chipTone(chip: string): "safe" | "warn" | "danger" {
  if (/refused|gated|cloud|provenance/.test(chip)) return "danger";
  if (
    chip.includes("⚠") ||
    chip.includes("limited") ||
    chip.includes("needs-work")
  ) {
    return "warn";
  }
  return "safe";
}

function updateStatusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update ${status.version} is available at getmuon.com/download.`;
    case "up-to-date":
      return `You're on the latest (${status.version}).`;
    case "downloading":
      return `Downloading… ${status.percent}%`;
    case "downloaded":
      return `Update ${status.version} downloaded and verified — ready to restart.`;
    case "waiting-for-work":
      return `Update ${status.version} is waiting for ${status.lanes.length} running lane(s): ${status.lanes.join(", ")}. It applies on its own when they finish.`;
    case "updated":
      return `Updated to ${status.version}${status.from ? ` (from ${status.from})` : ""}.`;
    case "error":
      return status.message;
    default:
      return "";
  }
}

/**
 * Full-Auto ("Auto-approve"): one standing-consent button for every managed
 * lane. ON is the default posture (Auto mode). Approvals resolve through the
 * SAME operator path a human click uses, including non-lane gates. Egress is
 * still withheld before it is filed, and a merge whose review certification
 * is blocked still needs an explicit operator attestation this cannot supply.
 * Dangerous visual language (armed = AA-safe red rail) because this disables
 * real gates. Reads state.fullAutoVendors; onSetVendors is the parent's real
 * setFullAutoVendors IPC call, never a local-only flag.
 */
function FullAutoPanel(props: {
  selected: readonly string[];
  onSetVendors: (vendors: string[]) => void;
}) {
  // `props.selected` is POLLED state: it only catches up after the IPC round
  // trip AND a full `collectState()` tick. Pending is the click we already
  // sent, so a second click inside that window does not read a stale array.
  const [pending, setPending] = useState<string[] | null>(null);
  const selected = pending ?? props.selected;
  useEffect(() => {
    setPending(null);
  }, [props.selected]);
  const armed = selected.length > 0;
  // P0-1: a nonempty SUBSET must not look, speak, or clear as machine-wide.
  // The pressed state and the danger rail key on ARMED (any lane's gates are
  // off — that is dangerous); the COPY keys on the one shared global
  // predicate, so "every lane" is only ever said when it is true. A subset
  // names its lanes instead. Clicking while armed only NARROWS (to none) —
  // the palette's rule, for the same reason: widening a subset silently is
  // the one gesture this button must never own.
  const global = isGlobalStandingConsent(selected);
  const toggle = () => {
    const next = armed ? [] : [...FLEET_VENDORS];
    setPending(next);
    props.onSetVendors(next);
  };
  const subsetNames = selected
    .map((vendor) => FLEET_VENDOR_LABELS[vendor] ?? vendor)
    .join(", ");
  return (
    <div className={"full-auto-panel" + (armed ? " armed" : "")}>
      <button
        type="button"
        className="full-auto-btn"
        aria-pressed={armed}
        aria-describedby="full-auto-copy"
        onClick={toggle}
      >
        Auto-approve
      </button>
      <small id="full-auto-copy">
        {global
          ? "On for every lane. Egress and blocked merge reviews still ask."
          : armed
            ? `On for ${subsetNames} only — other lanes still ask. Egress and blocked merge reviews still ask.`
            : "Off: every approval waits for you."}
      </small>
    </div>
  );
}

/**
 * S4 auto-continue, the desktop's other standing-posture toggle. The IPC
 * (`setAutoContinue`) and the persisted preference already existed with no
 * control anywhere in the app, so turning it off meant setting an env var and
 * relaunching. This is that control.
 *
 * Deliberately NOT the Full-Auto visual language: auto-continue does not
 * disable a gate — it decides whether MUON takes the next orchestration turn by
 * itself or waits for the operator to press Continue orchestration. It reads
 * the same quiet checkbox idiom as the update preference beside it.
 */
export function AutoContinuePanel(props: {
  autoContinue: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="updates-panel">
      <label className="update-auto">
        <input
          type="checkbox"
          checked={props.autoContinue}
          aria-describedby="auto-continue-copy"
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        Continue orchestration automatically
      </label>
      <div className="update-note" id="auto-continue-copy">
        MUON continues an idle chat by itself when a worker finishes. Off means
        the chat waits and offers you a Continue orchestration button instead.
      </div>
    </div>
  );
}

/** ROADMAP P6 — opt-in localhost preview pane. OFF by default. */
export function PortPreviewPanel(props: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="updates-panel">
      <label className="update-auto">
        <input
          type="checkbox"
          checked={props.enabled}
          aria-describedby="port-preview-copy"
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        Allow localhost port preview
      </label>
      <div className="update-note" id="port-preview-copy">
        When enabled, workspace port badges can open{" "}
        <code>http://127.0.0.1:&lt;port&gt;/</code> in a separate preview
        window. MUON never opens other hosts.
      </div>
    </div>
  );
}

export function UpdatesPanel(props: {
  appVersion?: string;
  autoUpdate: boolean;
  status: UpdateStatus;
  onCheck: () => void;
  onToggleAuto: (enabled: boolean) => void;
  onDownload: () => void;
  onInstall: (force?: boolean) => void;
}) {
  const { status } = props;
  return (
    <div className="updates-panel">
      <div className="update-version">
        MUON {props.appVersion ?? "—"}
      </div>
      <label className="update-auto">
        <input
          type="checkbox"
          checked={props.autoUpdate}
          onChange={(event) => props.onToggleAuto(event.target.checked)}
        />
        Check for updates on launch
      </label>
      <div className="update-status">{updateStatusLabel(status)}</div>
      <button
        className="update-btn ghost"
        disabled={status.state === "checking" || status.state === "downloading"}
        onClick={props.onCheck}
      >
        Check for updates
      </button>
      {status.state === "available" ? (
        <button className="update-btn" onClick={props.onDownload}>
          Download {status.version}
        </button>
      ) : null}
      {status.state === "downloaded" ? (
        <button className="update-btn" onClick={() => props.onInstall()}>
          Restart into {status.version}
        </button>
      ) : null}
      {status.state === "waiting-for-work" ? (
        // Round-3 #2: the informed interruption. The status line above names
        // the lanes; this button is the explicit consent to cut them.
        <button className="update-btn" onClick={() => props.onInstall(true)}>
          Restart now (interrupts {status.lanes.length} lane
          {status.lanes.length === 1 ? "" : "s"})
        </button>
      ) : null}
      <div className="update-note">
        Nothing is checked, downloaded, or installed without you clicking it.
        Applying an update verifies the download, swaps the app in
        /Applications with a rollback copy kept until the new version boots,
        and restarts. If anything fails, grab the release from
        getmuon.com/download.
      </div>
    </div>
  );
}

function VendorBlock(props: {
  vendor: FleetVendor;
  /** The shared lane projection (lane-status.ts) — the ONE source of verdict. */
  lane: LaneStatus;
  agents: AgentRecord[];
  taskTitles: Map<string, string>;
  laneDefault?: LaneDefaultConfig;
  onLaneDefaultChange?: (lane: LaneDefaultConfig) => void;
  onStep: (delta: number) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const sorted = [...props.agents].sort((a, b) => a.ordinal - b.ordinal);
  // Display-only codenames (agent-codename.ts): the crew tree shows "Nova"
  // instead of the "claude-code-1" routing name. Vendor stays visible via the
  // block header (FLEET_VENDOR_LABELS) above this list; the backend name is
  // preserved on the row's `title` for traceability.
  const codenames = agentCodenames(sorted.map((agent) => agent.id));
  const lane = props.lane;
  // What this lane is FOR, from the ONE role model — never `vendor !== "cursor"`.
  // That hardcoding disabled the Cursor stepper (so a lane the CLI could scale
  // with `muon fleet set --cursor` was unscalable in the app) and printed copy
  // that contradicted the Crew/Topology views.
  const scope = lane.roleScope;
  const count = lane.count;
  // Kept for the existing chip CSS: `.ready` vs `.degraded` are the two tones
  // that stylesheet knows. The finer state lives in `data-lane-state`, which is
  // what the new per-state styling hooks onto.
  const capabilityTone =
    lane.tone === "ready" ? "ready" : lane.known ? "degraded" : "idle";
  const models = knownModelsForVendor(props.vendor);
  return (
    <div
      className={`vendor-block${scope.scoped ? " role-scoped" : ""}${
        lane.needsAttention ? " needs-attention" : ""
      }`}
      data-lane-state={lane.state}
    >
      <div className="vendor-row">
        <span className="vendor-name">
          <VendorIcon vendor={props.vendor} />
          {FLEET_VENDOR_LABELS[props.vendor]}
          {lane.working > 0 ? (
            <span className="vendor-live" title={`${lane.working} working now`}>
              <span className="vendor-live-dot" aria-hidden="true" />
              {lane.working} working
            </span>
          ) : null}
        </span>
        <small
          className={`vendor-capability ${capabilityTone}`}
          title={lane.action ?? lane.detail}
        >
          {lane.chip}
        </small>
        <span className="stepper">
          <button
            type="button"
            disabled={count <= 0}
            onClick={() => props.onStep(-1)}
            title="Remove an instance"
            aria-label={`Remove a ${FLEET_VENDOR_LABELS[props.vendor]} instance`}
          >
            −
          </button>
          <span className="count">{count}</span>
          <button
            type="button"
            disabled={count >= FLEET_MAX}
            onClick={() => props.onStep(1)}
            title={`Add an instance — ${scope.summary}`}
            aria-label={`Add a ${FLEET_VENDOR_LABELS[props.vendor]} instance`}
          >
            +
          </button>
        </span>
      </div>
      {/* The probe's own sentence. This is the line that distinguishes the
          three situations a human must act on differently — "CLI not found",
          "not logged in", "auth probe could not run" are all DIFFERENT here,
          and none of them is ever inferred from a process exit code. */}
      <div className="vendor-detail">{lane.detail}</div>
      {lane.action ? (
        // The exact next step, from the probe's own fixHint wherever one
        // exists, so the command shown is the command that works.
        <div className={`vendor-action ${lane.tone}`}>{lane.action}</div>
      ) : null}
      {scope.scoped ? (
        // Managed, but for part of the role taxonomy. Say which roles, derived
        // from the role model, so the sidebar cannot drift from the Crew view or
        // from what the dispatch route will actually accept.
        <div className="vendor-role-note">{scope.summary}</div>
      ) : null}
      {lane.known ? (
        // THE SEAT, on every lane, either way. It is deliberately not folded
        // into `scope.summary` above: that line renders only for role-scoped
        // lanes, so the seat would have been named for the two vendors that
        // just gained one and never for the two that always had one. Both
        // answers read from the registry, never from a vendor list here.
        <div className="vendor-role-note">
          {lane.coordinatorEligible
            ? "Can hold MUON's coordinator seat, which coordinates a crew rather than doing the work."
            : "Cannot hold the coordinator seat — it runs as crew only."}
        </div>
      ) : null}
      {props.laneDefault && props.onLaneDefaultChange ? (
        // Collapsed to ONE line per lane: four lanes kept eight permanent
        // dropdowns on screen for set-and-forget defaults. The summary still
        // STATES the current values (nothing hidden, only the editors), so
        // scanning the fleet stays one glance.
        <details className="vendor-lane-defaults-details">
          <summary>
            Defaults · {props.laneDefault.model}
            {vendorSupportsEffortControl(props.vendor)
              ? ` · ${props.laneDefault.effort}`
              : ""}
          </summary>
          <div className="vendor-lane-defaults">
          <label>
            Model
            <select
              value={props.laneDefault.model}
              onChange={(e) =>
                props.onLaneDefaultChange?.({
                  ...props.laneDefault!,
                  model: e.target.value,
                })
              }
            >
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          {vendorSupportsEffortControl(props.vendor) ? (
            <label>
              Effort
              <select
                value={props.laneDefault.effort}
                onChange={(e) =>
                  props.onLaneDefaultChange?.({
                    ...props.laneDefault!,
                    effort: e.target.value as LaneDefaultConfig["effort"],
                  })
                }
              >
                {DESKTOP_PRESET_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          </div>
        </details>
      ) : null}
      {sorted.length > 0 ? (
        <div className="agent-list">
          {sorted.map((agent) => {
            const working = agent.status === "working";
            const task = agent.currentTaskId
              ? (props.taskTitles.get(agent.currentTaskId) ??
                agent.currentTaskId)
              : "idle";
            return (
              <button
                key={agent.id}
                type="button"
                className={`agent-row${working ? " working clickable" : ""}`}
                onClick={
                  working ? () => props.onOpenAgent(agent.id) : undefined
                }
                title={
                  working
                    ? `${agent.name} · ${task} · open this agent's stream`
                    : `${agent.name} · ${agent.status}`
                }
              >
                <span className={`dot ${agent.status}`} />
                <VendorIcon vendor={props.vendor} />
                <span className="agent-name">
                  {codenames.get(agent.id) ?? agent.name}
                </span>
                <span className="sr-only">
                  {working
                    ? `${task} · open this agent's stream`
                    : agent.status}
                </span>
              </button>
            );
          })}
        </div>
      ) : count > 0 ? (
        <div className="agent-list-empty">
          Seats reserved — agents appear after the control plane syncs.
        </div>
      ) : (
        // The empty state every lane needs: zero seats is a CHOICE, not a
        // fault, so it says what the "+" would do rather than looking broken.
        <div className="vendor-empty">
          No seats. Use + to put this lane to work.
        </div>
      )}
    </div>
  );
}

export function SettingsForm(props: {
  settings: { apiBase: string; apiTokenSet?: boolean } | null;
  onSave: (input: { apiBase: string; apiToken?: string }) => Promise<void>;
}) {
  // null draft = not editing: the shown apiBase derives from the brain state
  // during render, so no effect is needed to seed or re-sync it. The token
  // field is ENTRY-ONLY, the raw token never reaches the renderer, so we show
  // a status indicator ("set" vs "auto (embedded)") and only ever SEND a
  // freshly-typed value; a blank field leaves the stored token untouched.
  const [apiBaseDraft, setApiBaseDraft] = useState<string | null>(null);
  const [apiTokenDraft, setApiTokenDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apiBase = apiBaseDraft ?? props.settings?.apiBase ?? "";
  const apiTokenSet = props.settings?.apiTokenSet ?? false;

  const save = async () => {
    await props.onSave({
      apiBase: apiBase.trim(),
      apiToken: apiTokenDraft?.trim() || undefined,
    });
    setApiBaseDraft(null);
    setApiTokenDraft(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="settings-form">
      <label>
        API base
        <input
          value={apiBase}
          placeholder="http://localhost:4000"
          onChange={(event) => setApiBaseDraft(event.target.value)}
        />
      </label>
      <label>
        <span className="settings-token-label">
          API token
          <span className="settings-token-status">
            {apiTokenSet ? "set" : "auto (embedded)"}
          </span>
        </span>
        <input
          type="password"
          value={apiTokenDraft ?? ""}
          placeholder={
            apiTokenSet
              ? "enter a new token to replace"
              : "optional, for a remote control plane"
          }
          onChange={(event) => setApiTokenDraft(event.target.value)}
        />
      </label>
      <button className="settings-save" onClick={() => void save()}>
        Save
      </button>
      {saved && <span className="settings-saved">Saved.</span>}
    </div>
  );
}
