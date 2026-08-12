import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { buildOnboardingState } from "@muon/client/onboarding";
import { buildObjectiveLoopStatusForTask } from "@muon/client/loop-status";
import type { ApprovalRequest } from "@muon/client/types";
import type {
  GitHubReview,
  ManualReviewAttestation,
} from "@muon/client";
import type {
  CrewRoleLaneIpc,
  GitNexusIndexStatus,
  McpInstallReport,
  McpStatusReport,
  UpdateStatus,
  VendorModelResolutionIpc,
} from "../shared/ipc.js";
import { FLEET_VENDORS, stepFleet, type FleetVendor } from "../lib/fleet.js";
import {
  createStateStore,
  PANE_CAP,
  type StateStore,
  type StoreSnapshot,
} from "../lib/state-store.js";
import { AgentPanes } from "./agent-panes.js";
import { EvidencePanel, MemoryPanel } from "./brain.js";
import {
  appendLiveAssistant,
  appendLiveStatus,
  type LiveChatEntry,
} from "../lib/live-chat.js";
import { ChatView } from "./chat.js";
import { objectiveLoopComposerActivity } from "./lib/objective-loop-ui.js";
import { CommandPalette } from "./command-palette.js";
import { QuestionsInbox } from "./questions-inbox.js";
import { HandoffPanel } from "./handoff-panel.js";
import { parseModelCommand, resolveModelChange } from "./lib/chat-model.js";
// WAVE E (ADR-0022 §4): ONE coordinator default. This file alone carried four
// separate `?? "claude-code"` spellings of it.
import {
  defaultCoordinatorVendor,
  type VendorId,
} from "@muon/client/vendors";
import { scopeDesktopStateToChat } from "../lib/chat-scope.js";
import {
  alignStockPresetsToVendor,
  DEFAULT_DESKTOP_PRESETS,
  type DesktopPreset,
  type DesktopPresetVendor,
} from "../lib/presets.js";
import {
  capVisibleSubagentTabs,
  selectSubagentJobs,
  SUBAGENT_TAB_CAP,
  type WatchedJob,
} from "../lib/subagent-tabs.js";
import {
  isPanelTab,
  panelTabId,
  parsePanelTab,
  PANEL_TAB_LABELS,
  type PanelTabId,
  type WorkspacePanelKind,
} from "../lib/workspace-panels.js";
import {
  chatTerminalSessionId,
  isChatTerminalSessionId,
} from "../lib/terminal-session-id.js";
import {
  buildTerminalVendorMenu,
  nextTerminalOrdinal,
  SHELL_TERMINAL_KIND,
  shouldCloseTerminalTabOnExit,
  terminalTabLabel,
} from "../lib/terminal-vendor-tabs.js";
import {
  buildCustomAgentMenu,
  customAgentTabLabel,
} from "../lib/custom-agent-tabs.js";
import type { UngovernedAgentEntry } from "@muon/client";
import {
  acknowledgeRestoredHumanTerminal,
  mergeRestoredHumanTerminalTabs,
  restoredHumanTerminalTabs,
} from "./lib/human-terminal-restore.js";
import { FrozenTerminalTab } from "./frozen-terminal-tab.js";
import {
  applyTerminalActivityEvent,
  applyTerminalExit,
  INITIAL_TERMINAL_ACTIVITY,
  terminalPaneStatus,
  type TerminalActivityState,
} from "../lib/terminal-activity.js";
import { loadDetectionManifest } from "../lib/terminal-permission-heuristic.js";
import {
  ControlRail,
  LiveDispatchHero,
  SystemsStatusButton,
} from "./cockpit.js";
import { IconChevron, IconClose } from "./ui-icons.js";
import { ReconCard } from "./recon-card.js";
import {
  RightPanel,
  type RightPanelTab,
  type ShipOutcome,
  type ShipRequest,
  type ShipTarget,
} from "./right-panel.js";
import { PresetsBar } from "./presets-bar.js";
import { Onboarding } from "./onboarding.js";
import {
  firstTaskApprovalId,
  shouldShowOnboarding,
} from "./onboarding-visibility.js";
import { runnerBanner, runnerDot } from "./runner-status.js";
import { SessionWorkspace } from "./session-workspace.js";
import { TerminalPreview } from "./terminal-preview.js";
import { TerminalSearchOverlay } from "./terminal-search-overlay.js";
import type { TerminalView } from "./lib/terminal-wire.js";
import {
  computeParkedTerminalIds,
  reconcileTerminalMruOrder,
  touchTerminalMruOrder,
} from "./lib/terminal-parked-lru.js";
import { gcParkedTerminalsAtBoot } from "./lib/parked-terminal-store.js";
import { CrewPanel, GitHubConnectPanel, Sidebar } from "./sidebar.js";
import type { GitHubConnectionStatus } from "@muon/client";
import { SettingsPanel } from "./settings-panel.js";
import { pickRunnerOrStopNotice } from "./system-notice.js";
import {
  deriveMissionTurnState,
  pinLiveTurnRoots,
} from "../lib/mission-turn-state.js";
import { mergeShipBlockReason } from "./lib/ship-gate.js";
import { WorkspaceTabs } from "./workspace-tabs.js";
import { GitNexusColumn } from "./gitnexus-status.js";
import { GraphView } from "./graph-view.js";
import { CrewTopology } from "./crew-topology.js";
import type { NavFleetLane } from "./left-nav.js";
import {
  DEFAULT_CREW_CONFIG,
  normalizeCrewConfig,
  rememberOrchestratorPrefs,
  selectOrchestratorVendor,
  type OrchestratorEffort,
  type OrchestratorVendor,
} from "../lib/crew-config.js";
import {
  orchestratorReadinessIssue,
  readyOrchestratorFallback,
} from "../lib/orchestrator-readiness.js";
import { useMissionBudgetLine } from "./lib/use-mission-budget-line.js";
import type { VendorModelCatalog } from "../lib/vendor-models.js";
import {
  isCenterNavTarget,
  reconcileFocusedApproval,
  useWorkspaceLayout,
  type ContextPanel,
  type NavTarget,
} from "./lib/workspace-layout.js";
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  usePanelWidth,
} from "./lib/panel-resize.js";
import { Splitter } from "./splitter.js";
import { useWorkspaceReviews } from "./lib/workspace-review-state.js";

// Quiet workspace: which ControlRail section each RIGHT-DOCK panel shows.
// Sidebar nav opens Control/Timeline as CENTER tabs; the dock is reserved for
// approval deep-links (focusedApproval → layout.navigate("control")).
const DOCK_SECTION: Record<ContextPanel, "review" | "activity"> = {
  control: "review",
  timeline: "activity",
};

/** Panel kinds that open without an active mission chat. */
const GLOBAL_PANEL_KINDS: ReadonlySet<WorkspacePanelKind> = new Set([
  "crew",
  "settings",
]);

const POLL_INTERVAL_MS = 2000;

export type PaletteApprovalTarget = {
  approval: ApprovalRequest | null;
  /** 2+ approvals pending, none of them focused: which one is "the" one is
   * genuinely unresolvable — never guessed. */
  ambiguous: boolean;
};

/**
 * Which approval the command palette's blanket Approve/Reject entries act
 * on. A focused approval (opened via a Review action) always wins — that is
 * an explicit human choice of target. With nothing focused, a single
 * pending approval is still unambiguous. But with 2+ pending and nothing
 * focused, falling back to `approvals[0]` would silently approve/reject
 * whichever one happened to be first — this never does that: it reports
 * `ambiguous: true` and a null target instead, so the caller can hide the
 * blanket approve/reject entries (CommandPalette drops disabled commands
 * from its results) rather than act on an arbitrary approval.
 */
export function resolvePaletteApprovalTarget(
  approvals: ApprovalRequest[],
  focused: ApprovalRequest | null
): PaletteApprovalTarget {
  if (focused) return { approval: focused, ambiguous: false };
  if (approvals.length === 1) return { approval: approvals[0], ambiguous: false };
  return { approval: null, ambiguous: approvals.length > 1 };
}

/**
 * One HUMAN interactive terminal tab (a vendor CLI or a plain shell) in a
 * chat's workspace — opened from the strip's vendor bar. `id` is the pty
 * session id itself (terminal-session-id.ts), so the strip tab, the pane, and
 * the host session share one identity. Chat-scoped: the strip shows only the
 * active chat's tabs, but the rest survive a chat switch (their sessions stay
 * alive, detached, in the host).
 */
type HumanTerminalTab = {
  id: string;
  chatId: string;
  kind: string;
  ordinal: number;
  label: string;
  /**
   * ROADMAP T1 — present ONLY on a COLD-RESTORED tab: the read-only
   * scrollback captured at the LAST app quit, before this session's pty was
   * killed. While set, the tab renders frozen (`FrozenTerminalTab`) instead
   * of a live `TerminalPreview`. Cleared by an explicit operator acknowledge
   * (see `acknowledgeRestoredHumanTerminal`), which is also the moment a
   * fresh pty is spawned under this same session id — never automatic, and
   * never on tab open/select.
   */
  frozenScrollback?: string;
};

export function App() {
  const [snapshot, setSnapshot] = useState<StoreSnapshot>({
    state: null,
    panes: [],
    tabs: [],
    error: null,
  });
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LiveChatEntry[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  // S4: per-chat pending [Continue orchestration] affordance (chatId → jobId),
  // set when a worker landed while the chat was idle and auto-continue did not
  // fire (disabled or cap reached).
  const [idleNudges, setIdleNudges] = useState<Record<string, string>>({});
  // S10: per-chat default model (chatId → model id). The orchestrator applies it
  // to its own turns; unset chats keep today's behavior. Client-held only (no
  // persistence field this slice); the picker + `/model` command both set it,
  // and every dispatch re-validates it fail-closed at the route.
  const [chatModels, setChatModels] = useState<Record<string, string>>({});
  const [activePresetIds, setActivePresetIds] = useState<
    Record<string, string>
  >({});
  const [presetStatus, setPresetStatus] = useState<Record<string, string>>({});
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null);
  // The sidebar collapse must STICK across reloads/relaunches, else the toggle
  // reads as "does nothing" (every window snaps back open). Persisted global.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("muon.sidebarOpen") !== "0";
    } catch {
      return true;
    }
  });
  const [panesOpen, setPanesOpen] = useState(true);
  // Task #124: "chat" (the mission chat itself), a `panel:` tab (task #130 —
  // Memory/Evidence), or a subagent tab's jobId — NOT an agentId. Job tabs
  // are keyed by job, not by fleet agent slot, so a reused agent (the runner
  // can hand the same slot to a later dispatch) can never collide two
  // different subagents' tabs together. `(string & {})` keeps the two known
  // literals autocompletable while still accepting any job id.
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<
    "chat" | PanelTabId | (string & {})
  >("chat");
  // Task #130/#132 — Memory & Evidence as first-class, closable CENTER tabs
  // (killing the old cramped modal). A separate, uncapped, human-driven set
  // from the jobId subagent tabs above: a human explicitly opens/closes
  // these via nav/titlebar/hero/control-rail/palette, so there is no
  // SUBAGENT_TAB_CAP eviction and no auto-open/close reducer here.
  const [openPanelTabs, setOpenPanelTabs] = useState<WorkspacePanelKind[]>([]);
  // Terminal-native: the human's own interactive terminal tabs (vendor CLIs +
  // plain shells), opened from the strip's vendor bar. Session-id-keyed and
  // chat-scoped; closing one KILLS its pty (switching tabs only detaches).
  const [humanTerminals, setHumanTerminals] = useState<HumanTerminalTab[]>([]);
  // ROADMAP P7 — runtime-registered custom agents (host JSON store). Loaded
  // once on mount; registration is a CLI/out-of-band write, so a relaunch or
  // Settings refresh is enough — no live watcher required for v1.
  const [customAgents, setCustomAgents] = useState<UngovernedAgentEntry[]>([]);
  // ROADMAP T1 — once per app launch, ask main for whatever it cold-restored
  // from the LAST quit's snapshot and fold it into the tab list, frozen. Runs
  // once ([]): a later chat switch or reload must never re-fetch and
  // re-inject an already-acknowledged (or already-closed) tab — main hands
  // this back from an in-memory copy it already cleared from disk, so asking
  // again would just repeat the same answer, not find anything new.
  useEffect(() => {
    // Optional call: a test harness's mocked `window.muon` — like the
    // pre-existing `resolveVendorModel?.()` call below — commonly implements
    // only the IPC surface its own scenario exercises. Production's preload
    // always provides this method.
    window.muon
      .getHumanTerminalRestore?.()
      ?.then((entries) => {
        if (entries.length === 0) return;
        setHumanTerminals((current) =>
          mergeRestoredHumanTerminalTabs(
            current,
            restoredHumanTerminalTabs(entries)
          )
        );
      })
      ?.catch(() => undefined);
  }, []);
  // ADR-0039 (feature #13): install the user's local vendor DETECTION manifest
  // if they have one. Display data only — it decides which literals the
  // terminal-tab permission dot matches, and nothing else. A refusal leaves the
  // compiled patterns in force, which is exactly the pre-manifest behaviour, so
  // a bad file costs the user the override and never the app.
  useEffect(() => {
    window.muon
      .getDetectionManifest?.()
      ?.then((candidate) => {
        if (candidate === null || candidate === undefined) return;
        const result = loadDetectionManifest(candidate);
        if (result.refused) {
          // Surfaced rather than swallowed: a refusal nobody can see is
          // indistinguishable from a file that was never read, and the user
          // would have no idea their edit did nothing.
          console.warn(`[muon] detection manifest not applied: ${result.refused}`);
        }
      })
      ?.catch(() => undefined);
  }, []);
  useEffect(() => {
    window.muon
      .listCustomAgents?.()
      ?.then((entries) => setCustomAgents(entries))
      ?.catch(() => undefined);
  }, []);
  // ROADMAP T4 — boot-time buffer GC for the parked-runtime LRU's in-memory
  // store. Cheap and almost always a no-op: the store is per-renderer-process
  // state, so an ordinary cold app launch starts it empty with nothing to
  // collect. It matters for a renderer that reloads without a full relaunch
  // (a window reload keeps the main process, and this module, alive) — this
  // is what stops a stale parked buffer from a much earlier session outliving
  // its usefulness across that reload.
  useEffect(() => {
    gcParkedTerminalsAtBoot();
  }, []);
  const acknowledgeRestoredTerminal = useCallback((id: string) => {
    setHumanTerminals((current) =>
      acknowledgeRestoredHumanTerminal(current, id)
    );
  }, []);
  // ROADMAP T2 — per-human-terminal-tab pty activity (output/input bytes,
  // exit code), keyed by tab id. Feeds `resolveTerminalPaneStatus` for the
  // tab strip's activity dot; see lib/terminal-activity.ts for why this is a
  // thin, display-only heuristic and not a real vendor lifecycle hook.
  const [terminalActivity, setTerminalActivity] = useState<
    Record<string, TerminalActivityState>
  >({});
  // ROADMAP T4 — PARKED-RUNTIME LRU. Only the active chat's terminal panes
  // are ever mounted (the render below filters `humanTerminals` by
  // `activeChat.id`), so this order — and the cap it feeds — is scoped to
  // whatever is currently mounted, not every terminal across every chat. A
  // ref, not state: it is pure bookkeeping for the derived `parkedTerminalIds`
  // set below and must never itself trigger a render.
  const terminalMruOrderRef = useRef<string[]>([]);
  const [parkedTerminalIds, setParkedTerminalIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // ROADMAP T4 — the find-box controller for each MOUNTED terminal pane
  // (`TerminalView.search`, via `TerminalPreview.onSearchController`), keyed
  // by session id. A ref, not state: the overlay reads it imperatively on
  // find/next/prev rather than re-rendering the whole tree on every
  // attach/park cycle.
  const terminalSearchControllersRef = useRef<
    Record<string, TerminalView["search"] | undefined>
  >({});
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearchQuery, setTerminalSearchQuery] = useState("");
  const [firstTaskRunning, setFirstTaskRunning] = useState(false);
  // F7 — the wizard dismisses the moment "Run your first task" is clicked, so
  // its completion message can never render there. The OUTCOME surfaces here
  // in the mission view instead: the activation moment (first memory
  // captured) with the one next action that shows the moat (review it).
  const [firstTaskOutcome, setFirstTaskOutcome] = useState<{
    vendor: string;
    memoryId: string;
  } | null>(null);
  // Once the user runs their first task, the onboarding wizard is done for good
  // (persisted) — it never re-shows, and the mission takes over immediately.
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return localStorage.getItem("muon.onboarded") === "1";
    } catch {
      return false;
    }
  });
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  // S7: a failed soft-archive (e.g. an operator-gate 403 on a hosted brain)
  // must be visible where the action happened, never swallowed.
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** Chat-level cancel: which chat is stopping, and what the last stop achieved. */
  const [cancellingChatId, setCancellingChatId] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  /** Chats hidden immediately on archive click until the next authoritative tick. */
  const [pendingArchivedIds, setPendingArchivedIds] = useState<string[]>([]);
  const [focusedApprovalId, setFocusedApprovalId] = useState<string | null>(
    null
  );
  const [controlDockTab, setControlDockTab] =
    useState<RightPanelTab>("review");
  const [githubReview, setGitHubReview] = useState<GitHubReview | null>(null);
  const [githubReviewLoading, setGitHubReviewLoading] = useState(false);
  const [githubReviewRefresh, setGitHubReviewRefresh] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: "idle",
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Desk theme (founder ask, 2026-08-11): light is the session-desk default,
  // dark returns the Quiet base. Persisted like the sidebar collapse.
  const [deskTheme, setDeskTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("muon.deskTheme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });
  const toggleDeskTheme = useCallback(() => {
    setDeskTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem("muon.deskTheme", next);
      } catch {
        // Persistence is a nicety; the toggle itself must never throw.
      }
      return next;
    });
  }, []);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [readinessRefreshing, setReadinessRefreshing] = useState(false);
  const [readinessRefreshError, setReadinessRefreshError] = useState<
    string | null
  >(null);
  // S1 §5 Connections. null = never read (the panel's own "not checked yet"
  // state); the loading and error states are separate on purpose so the panel
  // can distinguish "still reading" from "read and it failed".
  const [mcpStatus, setMcpStatus] = useState<McpStatusReport | null>(null);
  const [mcpStatusLoading, setMcpStatusLoading] = useState(false);
  const [mcpStatusError, setMcpStatusError] = useState<string | null>(null);
  // Live GitNexus index status. Pushed from main via `muon:gitnexus` for instant
  // transitions; falls back to the polled DesktopState.gitnexus until the first
  // push arrives.
  const [gitnexusLive, setGitnexusLive] = useState<GitNexusIndexStatus | null>(
    null
  );
  const storeRef = useRef<StateStore | null>(null);
  // chatId → the ROOT the chat's open live mirror belongs to, i.e. where the
  // turn the human started begins in the stream. Pinned for the whole logical
  // turn even when the coordinator's crew-contract correction admits a second
  // root inside it (`pinLiveTurnRoots`), because the mirror still holds the
  // ORIGINATING root's exchange and history must not absorb it underneath.
  //
  // A ref, not state: it is derived from `live` + the durable job rows during
  // render and only ever pins or releases, so holding it in state would mean a
  // setState-in-render loop for a value that is never independently authored.
  // It lives HERE and not in ChatView because ChatView unmounts on a workspace
  // tab switch while the mirror it describes (`live`) does not.
  const liveTurnRootsRef = useRef<Record<string, string | null>>({});
  const pendingWorkspaceTabRef = useRef<{
    chatId: string;
    tabId: string;
  } | null>(null);
  /** TODO 3.15 — jobs the operator has opened; clears `review` once seen. */
  const seenJobIdsRef = useRef<Set<string>>(new Set());
  const layout = useWorkspaceLayout();

  useEffect(() => {
    const store = createStateStore({
      fetchState: () => window.muon.getState(),
      onChange: setSnapshot,
    });
    storeRef.current = store;
    store.start(POLL_INTERVAL_MS);
    return () => store.stop();
  }, []);

  useEffect(() => {
    const offAssistant = window.muon.on(
      "muon:assistant",
      ({ chatId, text, mode }) => {
        setLive((prev) => ({
          ...prev,
          [chatId]: appendLiveAssistant(prev[chatId] ?? [], text, mode),
        }));
      }
    );
    const offStatus = window.muon.on(
      "muon:status",
      ({ chatId, line, detail }) => {
        setLive((prev) => ({
          ...prev,
          // U4: carry the ledger's bounded/redacted tool detail into the LIVE
          // transcript, so a call's args and result are readable while the turn
          // is still running — not only once it settles and re-reads its
          // persisted chunks. Absent detail stays absent.
          [chatId]: appendLiveStatus(prev[chatId] ?? [], line, detail),
        }));
      }
    );
    const offApproval = window.muon.on(
      "muon:open-approval",
      ({ approvalId }) => {
        setFocusedApprovalId(approvalId);
      }
    );
    // S4: a worker landed while this chat was idle and auto-continue did not
    // fire — offer the human a one-turn manual continuation.
    const offIdle = window.muon.on(
      "muon:job-idle-terminal",
      ({ chatId, jobId }) => {
        setIdleNudges((prev) => ({ ...prev, [chatId]: jobId }));
      }
    );
    return () => {
      offAssistant();
      offStatus();
      offApproval();
      offIdle();
    };
  }, []);

  // Persist the sidebar collapse so it survives reload/relaunch (the toggle
  // must visibly "stick" — see the muon.sidebarOpen initializer above).
  useEffect(() => {
    try {
      localStorage.setItem("muon.sidebarOpen", sidebarOpen ? "1" : "0");
    } catch {
      /* private mode: best-effort, non-fatal */
    }
  }, [sidebarOpen]);

  // Live auto-update progress (checking → available → downloading → downloaded).
  useEffect(() => window.muon.on("muon:update-status", setUpdateStatus), []);

  // Live local code-graph index status (idle → indexing → ready → …).
  useEffect(() => window.muon.on("muon:gitnexus", setGitnexusLive), []);

  const onCheckUpdates = useCallback(() => window.muon.checkForUpdates(), []);
  const onDownloadUpdate = useCallback(() => window.muon.downloadUpdate(), []);
  const onInstallUpdate = useCallback(
    (force?: boolean) => window.muon.installUpdate(force ? { force } : undefined),
    []
  );
  const onToggleAutoUpdate = useCallback(async (enabled: boolean) => {
    await window.muon.setAutoUpdate(enabled);
    await storeRef.current?.tick();
  }, []);
  // S4 auto-continue: MUON takes the next orchestration turn by itself when a
  // worker finishes on an idle chat. Same shape as the toggles around it — call
  // the real IPC, then tick so the checkbox reflects the CONFIRMED persisted
  // state rather than an optimistic local flag.
  const onToggleAutoContinue = useCallback(async (enabled: boolean) => {
    await window.muon.setAutoContinue(enabled);
    await storeRef.current?.tick();
  }, []);
  const onToggleTelemetry = useCallback(async (enabled: boolean) => {
    await window.muon.setTelemetryEnabled(enabled);
    await storeRef.current?.tick();
  }, []);
  // TODO 5.17: Pause from the commitments screen — stop advancing, keep the record.
  const onPauseCommitment = useCallback(
    async (commitment: {
      kind: "loop" | "workflow" | "dispatch" | "schedule";
      refs: {
        loopId?: string | null;
        workflowRunId?: string | null;
        jobId?: string | null;
        scheduleId?: string | null;
      };
    }) => {
      const id =
        commitment.kind === "loop"
          ? commitment.refs.loopId
          : commitment.kind === "workflow"
            ? commitment.refs.workflowRunId
            : commitment.kind === "schedule"
              ? commitment.refs.scheduleId
              : commitment.refs.jobId;
      if (!id) {
        throw new Error("That commitment has no pause target.");
      }
      await window.muon.pauseAutonomyCommitment({
        kind: commitment.kind,
        id,
      });
      await storeRef.current?.tick();
    },
    []
  );
  const onResumeCommitment = useCallback(
    async (commitment: {
      kind: "loop" | "workflow" | "dispatch" | "schedule";
      refs: { jobId?: string | null };
    }) => {
      if (commitment.kind !== "loop" || !commitment.refs.jobId) {
        throw new Error("Only a paused loop dispatch can be resumed here.");
      }
      await window.muon.resumeObjectiveLoop({ jobId: commitment.refs.jobId });
      await storeRef.current?.tick();
    },
    []
  );
  const onStopObjectiveLoop = useCallback(async (loopId: string) => {
    await window.muon.pauseAutonomyCommitment({ kind: "loop", id: loopId });
    await storeRef.current?.tick();
  }, []);
  const onResumeObjectiveLoop = useCallback(async (jobId: string) => {
    await window.muon.resumeObjectiveLoop({ jobId });
    await storeRef.current?.tick();
  }, []);
  // Full-Auto ("Auto Approve all"): DISABLES every approval gate app-wide.
  // Calls the real IPC then ticks so the titlebar "safety gates off" band and
  // the sidebar toggle's own checked state both reflect the confirmed backend
  // state, not an optimistic local flag.
  const onToggleFullAuto = useCallback(async (enabled: boolean) => {
    await window.muon.setFullAuto(enabled);
    await storeRef.current?.tick();
  }, []);
  // Vendor-scoped standing consent: the sidebar's per-lane checkboxes. The
  // boolean toggle above survives for the command palette (all lanes / none).
  const onSetFullAutoVendors = useCallback(async (vendors: string[]) => {
    await window.muon.setFullAutoVendors(vendors);
    await storeRef.current?.tick();
  }, []);
  const onTogglePortPreview = useCallback(async (enabled: boolean) => {
    await window.muon.setPortPreviewEnabled(enabled);
    await storeRef.current?.tick();
  }, []);
  const onOpenPortPreview = useCallback(async (port: number) => {
    await window.muon.openPortPreview(port);
  }, []);
  const onStartGitHub = useCallback(
    () => window.muon.startGitHubDeviceFlow(),
    []
  );
  const onPollGitHub = useCallback(async (flowId: string) => {
    const result = await window.muon.pollGitHubDeviceFlow(flowId);
    if (result.status === "connected") {
      await storeRef.current?.tick();
    }
    return result;
  }, []);
  const onDisconnectGitHub = useCallback(async () => {
    await window.muon.disconnectGitHub();
    setGitHubReview(null);
    await storeRef.current?.tick();
  }, []);
  const onOpenGitHubUrl = useCallback(
    (url: string) => window.muon.openGitHubUrl(url),
    []
  );

  const state = snapshot.state;
  const chats = (state?.chats ?? []).filter(
    (chat) => !pendingArchivedIds.includes(chat.id)
  );

  useEffect(() => {
    // Drop optimistic archive markers once the chat is gone from the ledger.
    setPendingArchivedIds((prev) => {
      if (prev.length === 0) return prev;
      const live = new Set((state?.chats ?? []).map((chat) => chat.id));
      const next = prev.filter((id) => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [state?.chats]);
  const workspaceReviews = useWorkspaceReviews(
    chats,
    state?.dispatchJobs ?? []
  );
  const firstTaskGateId = firstTaskApprovalId(
    firstTaskRunning,
    state?.approvals ?? []
  );

  useEffect(() => {
    if (!firstTaskGateId) {
      return;
    }
    setFocusedApprovalId(firstTaskGateId);
  }, [firstTaskGateId]);

  // Derived during render: until the user picks a chat, the newest one is
  // active. No effect needed, and no flash of "no chat" on first load.
  const effectiveChatId =
    activeChatId && chats.some((chat) => chat.id === activeChatId)
      ? activeChatId
      : (chats[0]?.id ?? null);
  const previousEffectiveChatIdRef = useRef<string | null | undefined>(
    undefined
  );

  // Every workspace integration is owned by the selected chat. Switching (or
  // closing the final chat) resets transient navigation/dock/overlay state and
  // tells trusted main which chat id to resolve into a workspace path.
  useEffect(() => {
    const previousEffectiveChatId = previousEffectiveChatIdRef.current;
    if (previousEffectiveChatId === effectiveChatId) {
      return;
    }
    previousEffectiveChatIdRef.current = effectiveChatId;
    const isInitialFallbackHydration =
      previousEffectiveChatId === null &&
      effectiveChatId !== null &&
      activeChatId === null;
    if (!isInitialFallbackHydration) {
      const pending = pendingWorkspaceTabRef.current;
      setActiveWorkspaceTab(
        pending?.chatId === effectiveChatId ? pending.tabId : "chat"
      );
      if (pending?.chatId === effectiveChatId) {
        pendingWorkspaceTabRef.current = null;
      }
      setOpenPanelTabs([]);
      setControlDockTab("review");
      setGitnexusLive(null);
      layout.navigate("mission");
    }
    if (!effectiveChatId) {
      setFocusedApprovalId(null);
    }
    void window.muon
      .selectChat?.(effectiveChatId)
      ?.catch(() => undefined);
  }, [activeChatId, effectiveChatId, layout.navigate]);

  const openPanelTab = useCallback(
    (kind: WorkspacePanelKind) => {
      // Crew + Settings are global — openable without an active mission.
      if (!effectiveChatId && !GLOBAL_PANEL_KINDS.has(kind)) {
        return;
      }
      setOpenPanelTabs((current) =>
        current.includes(kind) ? current : [...current, kind]
      );
      setActiveWorkspaceTab(panelTabId(kind));
    },
    [effectiveChatId]
  );
  const closePanelTab = useCallback(
    (kind: WorkspacePanelKind) => {
      if (kind === "terminal" && effectiveChatId) {
        void window.muon.terminal.close?.(`terminal-chat:${effectiveChatId}`);
      }
      setOpenPanelTabs((current) =>
        current.filter((candidate) => candidate !== kind)
      );
      setActiveWorkspaceTab((current) =>
        current === panelTabId(kind) ? "chat" : current
      );
      // The closed tab's button/panel unmounts. Restore keyboard focus to the
      // always-present Mission tab after React commits the new strip.
      requestAnimationFrame(() => {
        document.getElementById("workspace-tab-chat")?.focus();
      });
    },
    [effectiveChatId]
  );
  /**
   * Open one vendor CLI (or plain shell) as its own terminal tab — the vendor
   * bar's click handler, and the ONLY way a human terminal session starts.
   * Each click mints a fresh numbered session ("Claude", then "Claude 2"): the
   * reference flow is one click → the vendor's real interactive TUI, never
   * "create a terminal, then type a command". The host still resolves the
   * actual command and cwd from its own allowlist + the bound chat record;
   * this only NAMES a kind.
   */
  const openHumanTerminal = useCallback(
    (kind: string) => {
      if (!effectiveChatId) return;
      const chatTabs = humanTerminals.filter(
        (tab) => tab.chatId === effectiveChatId
      );
      const ordinal = nextTerminalOrdinal(chatTabs, kind);
      const id = chatTerminalSessionId(effectiveChatId, kind, ordinal);
      const label = kind.startsWith("custom:")
        ? customAgentTabLabel(kind, ordinal, customAgents)
        : terminalTabLabel(kind, ordinal);
      setHumanTerminals((current) => [
        ...current,
        {
          id,
          chatId: effectiveChatId,
          kind,
          ordinal,
          label,
        },
      ]);
      setActiveWorkspaceTab(id);
      // T2: opening a tab IS looking at it — without this, a fresh tab that
      // exits cleanly before the human ever re-selects it (they never left)
      // would still read `review` under the seen-gate below.
      seenJobIdsRef.current.add(id);
    },
    [customAgents, effectiveChatId, humanTerminals]
  );
  /** Closing a terminal tab KILLS its pty — never an orphan; tab switches
   *  only detach (scrollback survives for a later remount). */
  const closeHumanTerminal = useCallback((id: string) => {
    void window.muon.terminal.close?.(id);
    setHumanTerminals((current) => current.filter((tab) => tab.id !== id));
    setTerminalActivity((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setActiveWorkspaceTab((current) => (current === id ? "chat" : current));
  }, []);
  /** T2 — one output frame or keystroke on a human terminal tab's pty. Pure
   *  fold (lib/terminal-activity.ts); this only holds the result in state. */
  const onHumanTerminalActivity = useCallback(
    (id: string, event: { kind: "output" | "input"; data: string }) => {
      setTerminalActivity((current) => ({
        ...current,
        [id]: applyTerminalActivityEvent(
          current[id] ?? INITIAL_TERMINAL_ACTIVITY,
          event
        ),
      }));
    },
    []
  );
  /**
   * The pty behind a human terminal tab exited.
   *
   * A session that RAN and then finished closes its tab, as before. A session
   * that died in its first seconds keeps it: that pane holds the vendor's own
   * last words and the `[session exited: code N]` marker, and auto-closing on
   * top of them is what turned one failed Cursor launch into a human clicking
   * "+ Cursor" over and over. The host separately refuses to respawn that id
   * (createTerminalRespawnGuard), so nothing restarts behind the human's back
   * either.
   *
   * "In its first seconds" is the CHILD'S measured lifetime, off the exit
   * frame — the same number the host's guard judges by. Subtracting this tab's
   * own creation time from `Date.now()` (what this did) answered a different
   * question with a different clock: it counted the host's spawn latency, and
   * when the pane had been unmounted while the child died it counted the whole
   * time the human was away, turning a 300ms launch failure into a "long
   * session" whose tab was then auto-closed on top of the evidence.
   */
  const onHumanTerminalExit = useCallback(
    (tab: HumanTerminalTab, exit: { lifetimeMs: number; exitCode: number }) => {
      // T2: recorded even when the tab is about to auto-close below — a kept
      // tab (long-lived session) must show `failed`/`review` immediately, not
      // the next time something else in the tree happens to re-render.
      setTerminalActivity((current) => ({
        ...current,
        [tab.id]: applyTerminalExit(
          current[tab.id] ?? INITIAL_TERMINAL_ACTIVITY,
          exit.exitCode
        ),
      }));
      if (shouldCloseTerminalTabOnExit({ lifetimeMs: exit.lifetimeMs })) {
        closeHumanTerminal(tab.id);
      }
    },
    [closeHumanTerminal]
  );
  // ⌘J keeps its muscle memory as "get me a shell": focus this chat's most
  // recent shell tab, or open one.
  const focusOrOpenShellTab = useCallback(() => {
    if (!effectiveChatId) return;
    const shells = humanTerminals.filter(
      (tab) =>
        tab.chatId === effectiveChatId && tab.kind === SHELL_TERMINAL_KIND
    );
    const latest = shells[shells.length - 1];
    if (latest) {
      setActiveWorkspaceTab(latest.id);
      seenJobIdsRef.current.add(latest.id);
      return;
    }
    openHumanTerminal(SHELL_TERMINAL_KIND);
  }, [effectiveChatId, humanTerminals, openHumanTerminal]);

  // Cmd/Ctrl+K palette; Cmd/Ctrl+J focuses/opens the shell terminal tab.
  // Cmd/Ctrl+W is intercepted in main (before-input-event) and arrives as
  // muon:close-active-tab — closes closable tabs only, never Mission chat.
  // ROADMAP T4 — Cmd/Ctrl+F opens the find bar, but ONLY while a human
  // terminal tab is the active workspace tab: the chat transcript, Memory,
  // and every other surface have no terminal to search, and stealing the
  // browser's own find gesture there (Electron ships one, `Cmd+F` on a
  // webContents) would be a net loss for no benefit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        focusOrOpenShellTab();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === "f" || e.key === "F") &&
        isChatTerminalSessionId(activeWorkspaceTab)
      ) {
        e.preventDefault();
        setTerminalSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusOrOpenShellTab, activeWorkspaceTab]);
  // Closing (or navigating away from) the active terminal must not leave a
  // stale find bar floating over whatever surface comes up next.
  useEffect(() => {
    if (!isChatTerminalSessionId(activeWorkspaceTab)) {
      setTerminalSearchOpen(false);
    }
  }, [activeWorkspaceTab]);

  useEffect(() => {
    return window.muon.on("muon:open-command-palette", () => {
      setPaletteOpen(true);
    });
  }, []);
  useEffect(() => {
    return window.muon.on("muon:close-active-tab", () => {
      const panel = parsePanelTab(activeWorkspaceTab);
      if (panel) {
        closePanelTab(panel);
        return;
      }
      // A human terminal tab's id IS its session id — close it through the
      // one path that kills the pty, not the job-tab teardown below (which
      // would derive a nonsense `terminal-terminal-chat:…` session).
      if (isChatTerminalSessionId(activeWorkspaceTab)) {
        closeHumanTerminal(activeWorkspaceTab);
        return;
      }
      if (activeWorkspaceTab !== "chat" && !isPanelTab(activeWorkspaceTab)) {
        void window.muon.terminal.close?.(`terminal-${activeWorkspaceTab}`);
        storeRef.current?.closeTab(activeWorkspaceTab);
        setActiveWorkspaceTab("chat");
      }
      // Mission chat: intentionally a no-op (not closable).
    });
  }, [activeWorkspaceTab, closeHumanTerminal, closePanelTab]);

  // Drop any pending idle-terminal affordance for a chat (the human took over,
  // by messaging or by clicking Continue).
  const clearIdleNudge = useCallback((chatId: string) => {
    setIdleNudges((prev) => {
      if (!(chatId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
  }, []);

  // S10: apply a chat-level model change (from the picker or a `/model` command)
  // through the shared S5 validation authority. A rejected id never enters the
  // store (fail-closed at the UI too); a degrade warning is relayed as a status
  // line so it is never silent. The route stays the real authority per dispatch.
  const setChatModel = useCallback((chatId: string, model: string | null) => {
    const outcome = resolveModelChange(
      model,
      snapshot.state?.settings?.crew?.orchestratorVendor ?? defaultCoordinatorVendor()
    );
    if (outcome.kind === "set") {
      setChatModels((prev) => ({ ...prev, [chatId]: outcome.model }));
    } else if (outcome.kind === "clear") {
      setChatModels((prev) => {
        if (!(chatId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
    }
    setLive((prev) => ({
      ...prev,
      [chatId]: [...(prev[chatId] ?? []), { role: "status", text: outcome.note }],
    }));
  }, [snapshot.state?.settings?.crew?.orchestratorVendor]);

  const onSavePresets = useCallback(async (presets: DesktopPreset[]) => {
    await window.muon.savePresets(presets);
    await storeRef.current?.tick();
  }, []);

  const onApplyPreset = useCallback(
    async (chatId: string, presetId: string) => {
      setApplyingPresetId(presetId);
      setPresetStatus((current) => {
        const next = { ...current };
        delete next[chatId];
        return next;
      });
      try {
        const result = await window.muon.applyPreset(presetId);
        const missionVendor =
          snapshot.state?.settings?.crew?.orchestratorVendor ?? defaultCoordinatorVendor();
        // Presets that match the Mission orchestrator seat also set this chat's model.
        if (result.preset.vendor === missionVendor) {
          setChatModel(chatId, result.preset.model);
        }
        setActivePresetIds((current) => ({
          ...current,
          [chatId]: result.preset.id,
        }));
        setPresetStatus((current) => ({
          ...current,
          [chatId]:
            result.preset.vendor === missionVendor
              ? `${result.preset.name} applied: ${result.preset.vendor} lane configured and this mission model set to ${result.preset.model}.`
              : `${result.preset.name} configured for the ${result.preset.vendor} worker lane; the mission root keeps its current model.`,
        }));
      } catch (error) {
        setPresetStatus((current) => ({
          ...current,
          [chatId]: `✗ ${
            error instanceof Error ? error.message : "Could not apply preset."
          }`,
        }));
      } finally {
        setApplyingPresetId(null);
      }
    },
    [setChatModel, snapshot.state?.settings?.crew?.orchestratorVendor]
  );

  const send = useCallback(
    async (chatId: string, message: string) => {
      // S10: a HUMAN-typed literal `/model <id>` never becomes a chat turn — it
      // sets the chat's own root model client-side. The super-agent sets WORKER
      // models via dispatch(model=…) but must never rewrite its own root model
      // through chat prose (payload-is-data), so this interception is the human
      // path only and returns before any message reaches the orchestrator.
      const modelCommand = parseModelCommand(message);
      if (modelCommand) {
        setChatModel(chatId, modelCommand.model === "" ? null : modelCommand.model);
        return true;
      }
      clearIdleNudge(chatId);
      setRunning((prev) => ({ ...prev, [chatId]: true }));
      // Optimistic user bubble; replaced by the persisted "[you]" chunk once
      // the turn settles. Stale status lines from earlier turns clear here.
      setLive((prev) => ({ ...prev, [chatId]: [{ role: "user", text: message }] }));
      // The mirror is (re)opened for a BRAND-NEW logical turn, so its pinned
      // transcript boundary starts empty and re-pins from the root this turn
      // admits. Dropped here rather than only on settle: a settle whose fetch
      // failed deliberately keeps its live entries, and that must not let a
      // previous turn's root become this turn's boundary.
      delete liveTurnRootsRef.current[chatId];
      try {
        const result = await window.muon.sendMessage({
          chatId,
          message,
          // Only sent when set → an unset chat keeps today's behavior verbatim.
          model: chatModels[chatId],
        });
        if (!result.ok) {
          setLive((prev) => ({
            ...prev,
            [chatId]: [
              ...(prev[chatId] ?? []),
              { role: "status", text: `✗ ${result.error ?? "turn failed"}` },
            ],
          }));
        }
        return result.ok;
      } catch (error) {
        setLive((prev) => ({
          ...prev,
          [chatId]: [
            ...(prev[chatId] ?? []),
            {
              role: "status",
              text: `✗ ${
                error instanceof Error
                  ? error.message
                  : "Could not reach the desktop agent runtime."
              }`,
            },
          ],
        }));
        return false;
      } finally {
        setRunning((prev) => ({ ...prev, [chatId]: false }));
        void storeRef.current?.tick();
      }
    },
    [clearIdleNudge, setChatModel, chatModels]
  );

  // S4: the [Continue orchestration] button — one human-consented reconciliation
  // turn for a worker that finished while the chat was idle.
  const continueOrchestration = useCallback(
    async (chatId: string, jobId: string) => {
      clearIdleNudge(chatId);
      setRunning((prev) => ({ ...prev, [chatId]: true }));
      const result = await window.muon.continueOrchestration({ chatId, jobId });
      if (!result.ok) {
        setLive((prev) => ({
          ...prev,
          [chatId]: [
            ...(prev[chatId] ?? []),
            { role: "status", text: `✗ ${result.error ?? "continue failed"}` },
          ],
        }));
      }
      setRunning((prev) => ({ ...prev, [chatId]: false }));
      void storeRef.current?.tick();
    },
    [clearIdleNudge]
  );

  // Returns whether the INTERRUPT CALL ITSELF succeeded — not whether the turn
  // has ended (that is `running` going false, once the brain confirms it).
  // ChatView's stop control needs this: on a failed interrupt attempt (brain
  // unreachable, a 409 lease conflict, a transient 500) it must unlatch and
  // let the human retry, rather than staying "Stopping…" forever because
  // `running` never flips on a call that never landed.
  const cancelDispatch = useCallback(
    async (chatId: string, jobId: string): Promise<boolean> => {
      try {
        await window.muon.interruptDispatch(jobId);
        setLive((current) => ({
          ...current,
          [chatId]: [
            ...(current[chatId] ?? []),
            { role: "status", text: "Stopping this mission turn…" },
          ],
        }));
        return true;
      } catch (error) {
        setLive((current) => ({
          ...current,
          [chatId]: [
            ...(current[chatId] ?? []),
            {
              role: "status",
              text: `✗ ${
                error instanceof Error
                  ? error.message
                  : "Could not stop this mission turn."
              }`,
            },
          ],
        }));
        return false;
      } finally {
        void storeRef.current?.tick();
      }
    },
    []
  );

  // After the settled turn is fetched from streams, drop every optimistic
  // entry. Status/tool lifecycle is durable activity now; retaining live status
  // rows would duplicate it after history polling or restart reconciliation.
  const settleLive = useCallback((chatId: string) => {
    setLive((prev) => ({
      ...prev,
      [chatId]: [],
    }));
  }, []);

  /**
   * New session. With `workspacePath`, create in that project and skip the
   * folder picker (rail per-project `+`). Without it, pick a folder — the
   * global New chat / titlebar `+` path must stay unchanged.
   */
  const newChat = useCallback(async (workspacePath?: string) => {
    const folder =
      typeof workspacePath === "string" && workspacePath.length > 0
        ? workspacePath
        : await window.muon.pickFolder();
    if (!folder) {
      return;
    }
    const chat = await window.muon.createChat({ workspacePath: folder });
    pendingWorkspaceTabRef.current = null;
    setFocusedApprovalId(null);
    setActiveChatId(chat.id);
    await storeRef.current?.tick();
  }, []);

  const onStepFleet = useCallback(
    async (vendor: FleetVendor, delta: number) => {
      const counts = snapshot.state?.fleet?.counts ?? {};
      const next = stepFleet(counts, vendor, delta);
      setFleetError(null);
      try {
        // Don't await a full state poll — setFleet is authoritative enough;
        // tick reconciles agents/counts in the background.
        await window.muon.setFleet(next);
        void storeRef.current?.tick();
      } catch (error) {
        void storeRef.current?.tick();
        setFleetError(
          error instanceof Error
            ? error.message
            : "Could not resize the fleet."
        );
      }
    },
    [snapshot.state?.fleet?.counts]
  );

  const onSaveCrewConfig = useCallback(
    async (crew: import("../lib/crew-config.js").CrewConfig) => {
      await window.muon.saveCrewConfig(crew);
      await storeRef.current?.tick();
    },
    []
  );

  // Wizard "re-check": force a backend re-probe (bypassing the short cache),
  // then tick so the freshly-cached readiness lands in the polled state.
  const onRecheckReadiness = useCallback(async () => {
    setReadinessRefreshing(true);
    setReadinessRefreshError(null);
    try {
      const readiness = await window.muon.refreshReadiness();
      if (!readiness) {
        throw new Error("Provider checks are unavailable right now.");
      }
      await storeRef.current?.tick();
    } catch (error) {
      setReadinessRefreshError(
        error instanceof Error
          ? error.message
          : "Could not re-check provider readiness."
      );
    } finally {
      setReadinessRefreshing(false);
    }
  }, []);

  // S1 §5 CONNECTIONS: read the ONE `McpStatusReport` the CLI and the TUI
  // render, over the typed bridge. Lazy — this is a diagnostic the operator asks
  // for, not something the mission view needs — and it never throws into the
  // render: a failure becomes `mcpStatusError`, which the panel shows as one
  // sentence plus a live "Try again".
  const onRefreshMcpStatus = useCallback(async () => {
    setMcpStatusLoading(true);
    setMcpStatusError(null);
    try {
      setMcpStatus(await window.muon.mcpStatus());
    } catch (error) {
      setMcpStatusError(
        error instanceof Error
          ? error.message
          : "Could not read MUON's MCP registration status."
      );
    } finally {
      setMcpStatusLoading(false);
    }
  }, []);

  const onInstallMcp = useCallback(
    (vendor: VendorId) => window.muon.mcpInstall(vendor),
    []
  );

  // The LIVE surface check. Deliberately NOT wired into the status refresh
  // above: that one is cheap and runs when the panel opens, while this spawns
  // a real MCP server process. An operator asks for it.
  const onProbeMcp = useCallback(
    (input?: { mode?: string }) => window.muon.mcpProbe(input),
    []
  );

  // ADR-0028 Tier C. `onAttachMcp` binds to the active chat when the caller
  // does not name one — the Connections row's own "attach" affordance has no
  // chat picker of its own, so it means "this workspace's current chat".
  // Neither handler receives or returns a token: `McpAttachResult` (the
  // shared IPC type) has no field for one.
  const onAttachMcp = useCallback(
    (vendor: VendorId) =>
      window.muon.mcpAttach({ vendor, chatId: effectiveChatId ?? undefined }),
    [effectiveChatId]
  );
  const onDetachMcp = useCallback(
    (vendor: VendorId) => window.muon.mcpDetach(vendor),
    []
  );

  // "Attached" is read off the SAME `dispatchJobs` the mission view already
  // polls — never a second attach-specific fetch — filtered to a ROOT job
  // (no parent) that is still ACTIVE and whose `capabilityMode` names Tier C.
  // This is the honest non-hermetic signal ADR-0028 calls for: it reflects
  // reality (including a seat attached from the CLI or another terminal
  // entirely) rather than only this window's own last attach call.
  const mcpAttachedByVendor = useMemo(() => {
    const map = new Map<
      VendorId,
      { jobId: string; chatId: string | null }
    >();
    for (const job of state?.dispatchJobs ?? []) {
      if (job.capabilityMode !== "attached-coordinator") continue;
      if (job.parentJobId) continue;
      if (job.status !== "running" && job.status !== "queued") continue;
      map.set(job.vendor as VendorId, {
        jobId: job.id,
        chatId: job.chatId ?? null,
      });
    }
    return map;
  }, [state?.dispatchJobs]);

  // P6, "Run your first task": main picks a folder, seeds the SAFE sample task,
  // and dispatches it; we tick so the fresh chat + task land in state (which
  // dismisses the wizard). Returns the result so the wizard can show feedback.
  const onRunFirstTask = useCallback(async () => {
    // Dismiss the wizard immediately so the mission shows at once (the read-only
    // task runs in the background) — no second doctor panel, no waiting.
    setOnboardingDismissed(true);
    try {
      localStorage.setItem("muon.onboarded", "1");
    } catch {
      // Private-mode / storage-disabled: session-state dismissal still applies.
    }
    setFirstTaskRunning(true);
    try {
      const result = await window.muon.runFirstTask();
      await storeRef.current?.tick();
      if (result.ok) {
        setFirstTaskOutcome({ vendor: result.vendor, memoryId: result.memoryId });
      }
      return result;
    } finally {
      setFirstTaskRunning(false);
    }
  }, []);

  const onResolveApproval = useCallback(
    async (
      approvalId: string,
      status: "approved" | "rejected",
      receiptTtlMs?: number,
      manualReview?: ManualReviewAttestation
    ) => {
      // Fail-closed SHIP gate (ROADMAP 4.3): a merge cannot be approved while
      // the change is REVIEW BLIND — some changed file is unindexed or the
      // index is stale, so the affected-flow evidence is incomplete and "0
      // processes affected" is NOT an all-clear. Enforced HERE at the human
      // surface (can't approve → can't merge), not merely in the orchestrator
      // prompt. Missing/degraded review evidence blocks too.
      if (status === "approved") {
        const approval = (state?.approvals ?? []).find(
          (a) => a.id === approvalId
        );
        if (approval?.kind === "merge") {
          // MCP/CLI/TUI ship approvals historically omit jobId. Resolve the
          // newest same-task job in the selected chat so the real workflow
          // reaches review_diff; no matching job means no evidence and blocks.
          const reviewJobId =
            approval.jobId ??
            [...(state?.dispatchJobs ?? [])]
              .filter(
                (job) =>
                  job.taskId === approval.taskId &&
                  job.chatId === effectiveChatId
              )
              .sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt)
              )[0]?.id;
          // `?.` guards the case where the IPC surface predates review_diff.
          const review = reviewJobId
            ? ((await window.muon
                .reviewDiff?.({ jobId: reviewJobId })
                ?.catch(() => null)) ?? null)
            : null;
          const blockReason = mergeShipBlockReason(
            approval,
            status,
            review,
            manualReview !== undefined
          );
          if (blockReason) {
            setStopNotice(blockReason);
            throw new Error(blockReason);
          }
        }
      }
      // A rejected IPC call (e.g. the server refused the receipt mint) throws
      // BEFORE any state clears, so the review dialog stays open and shows
      // the reason while the approval stays pending.
      await window.muon.resolveApproval({
        approvalId,
        status,
        receiptTtlMs,
        manualReview,
      });
      setFocusedApprovalId((current) =>
        current === approvalId ? null : current
      );
      await storeRef.current?.tick();
    },
    [effectiveChatId, state?.approvals, state?.dispatchJobs]
  );

  const onApplyProposal = useCallback(async (runId: string) => {
    await window.muon.applyWorkflowProposal(runId);
    await storeRef.current?.tick();
  }, []);

  const onDismissProposal = useCallback(async (runId: string) => {
    await window.muon.dismissWorkflowProposal(runId);
    await storeRef.current?.tick();
  }, []);

  const onStopAll = useCallback(async () => {
    setStopNotice("Stopping every active task…");
    try {
      const result = await window.muon.stopAll();
      setStopNotice(
        result.failedJobIds.length === 0
          ? `Stopped ${result.stopped} active task${result.stopped === 1 ? "" : "s"}.`
          : `Stopped ${result.stopped}/${result.requested}; ${result.failedJobIds.length} task${result.failedJobIds.length === 1 ? "" : "s"} could not be stopped.`
      );
      await storeRef.current?.tick();
    } catch (error) {
      setStopNotice(
        `Stop all failed: ${error instanceof Error ? error.message : "control plane unavailable"}`
      );
    }
  }, []);

  const onSaveSettings = useCallback(
    async (input: { apiBase: string; apiToken?: string }) => {
      await window.muon.saveSettings(input);
      await storeRef.current?.tick();
    },
    []
  );

  // Cancel this chat's work, like interrupting a session — but for everything
  // the chat owns, not just the turn you can see. NOT archive: the chat stays
  // selected and usable, and its history is untouched. Idempotent, so a second
  // press while one is in flight is simply ignored (the control is disabled).
  const onCancelChat = useCallback(async (chatId: string) => {
    setCancellingChatId(chatId);
    setCancelNotice("Stopping this chat's jobs…");
    try {
      const result = await window.muon.cancelChat(chatId);
      // `summary` never claims a job stopped that the ledger still shows live.
      setCancelNotice(result.summary);
    } catch (error) {
      setCancelNotice(
        `Could not stop this chat: ${
          error instanceof Error ? error.message : "control plane unavailable"
        }`
      );
    } finally {
      setCancellingChatId(null);
      void storeRef.current?.tick();
    }
  }, []);

  // S7: soft-archive ("delete") a chat. The archived chat drops out of the list
  // on the next tick; if it was the selected one, clear the selection so the
  // effectiveChatId fallback re-selects the newest remaining chat. Any failure
  // is surfaced in the sidebar, never silent.
  const onArchiveChat = useCallback(async (chatId: string) => {
    setArchiveError(null);
    const nextChatId =
      chats.find((candidate) => candidate.id !== chatId)?.id ?? null;
    const wasActive = effectiveChatId === chatId;
    // Close terminals BEFORE flipping selection so teardown IPC is not racing
    // the selectChat bind (main also tolerates selection drift on close).
    const jobsForChat = (state?.dispatchJobs ?? []).filter(
      (job) => job.chatId === chatId
    );
    for (const job of jobsForChat) {
      void window.muon.terminal.close?.(`terminal-${job.id}`);
      storeRef.current?.closeTab(job.id);
      storeRef.current?.closePane(job.id);
    }
    void window.muon.terminal.close?.(`terminal-chat:${chatId}`);
    // Every human terminal tab in the archived chat dies with it — main's
    // archive path also reaps by chat prefix, but a failed/blocked archive
    // must still not leave the renderer holding tabs for closed sessions.
    for (const tab of humanTerminals) {
      if (tab.chatId === chatId) {
        void window.muon.terminal.close?.(tab.id);
      }
    }
    setHumanTerminals((current) =>
      current.filter((tab) => tab.chatId !== chatId)
    );
    setPendingArchivedIds((prev) =>
      prev.includes(chatId) ? prev : [...prev, chatId]
    );
    pendingWorkspaceTabRef.current = null;
    setFocusedApprovalId(null);
    if (wasActive) {
      setOpenPanelTabs([]);
      setActiveWorkspaceTab("chat");
      setActiveChatId(nextChatId);
    }
    try {
      await window.muon.archiveChat(chatId);
      void storeRef.current?.tick();
    } catch (error) {
      setPendingArchivedIds((prev) => prev.filter((id) => id !== chatId));
      if (wasActive) {
        setActiveChatId(chatId);
      }
      // A blocked archive already names the exact jobs holding the chat open
      // ("Cannot archive this chat yet. 1 job is still active: …"), so it is
      // shown verbatim rather than buried under a second generic prefix.
      setArchiveError(
        error instanceof Error
          ? error.message
          : "Could not archive that chat: control plane unavailable"
      );
      void storeRef.current?.tick();
    }
  }, [chats, effectiveChatId, humanTerminals, state?.dispatchJobs]);

  // D4: rename a chat (double-click the chat header to edit — see chat.tsx).
  // Auto-title only ever fires while a chat's title is still literally "New
  // chat" (packages/orchestrator/src/chat.ts), so a human rename here is safe
  // from being clobbered by the next turn. A failure is NOT surfaced today
  // (mirrors the pre-existing behavior of every other tick-driven mutation
  // here besides archive) — the tick below just leaves the prior title
  // visible if the write didn't land.
  const onRenameChat = useCallback(async (chatId: string, title: string) => {
    await window.muon.updateChat({ chatId, title });
    await storeRef.current?.tick();
  }, []);

  // S8: crew-click → live stream view. A caller may name an exact historical
  // pane job while the reusable fleet slot already points at a newer dispatch.
  // Prefer that exact job. A full-fleet Crew row may belong to another chat, so
  // fall back to the seat's active/newest dispatch across chats and switch the
  // selected chat before opening it. This keeps every integration chat-scoped
  // without rendering a clickable fleet row that silently does nothing.
  const openAgentPane = useCallback(
    (agentId: string, exactJobId?: string | null) => {
      const jobs = state?.dispatchJobs ?? [];
      const agent = state?.fleet?.agents?.find(
        (candidate) => candidate.id === agentId
      );
      const exactJob = exactJobId
        ? jobs.find(
            (candidate) =>
              candidate.id === exactJobId &&
              (!candidate.agentId || candidate.agentId === agentId)
          )
        : undefined;
      const currentJob = agent?.currentJobId
        ? jobs.find((candidate) => candidate.id === agent.currentJobId)
        : undefined;
      const sameChatJobs = jobs
        .filter(
          (candidate) =>
            candidate.agentId === agentId &&
            candidate.chatId === effectiveChatId
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const agentJobs = jobs
        .filter((candidate) => candidate.agentId === agentId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const active = (candidate: (typeof jobs)[number]) =>
        candidate.status === "running" || candidate.status === "queued";
      const job =
        exactJob ??
        (currentJob && active(currentJob) ? currentJob : undefined) ??
        sameChatJobs.find(active) ??
        agentJobs.find(active) ??
        (currentJob?.chatId === effectiveChatId ? currentJob : undefined) ??
        sameChatJobs[0] ??
        agentJobs[0];
      if (job?.chatId && job.chatId !== effectiveChatId) {
        pendingWorkspaceTabRef.current = {
          chatId: job.chatId,
          tabId:
            job.capabilityMode === "orchestrator" ? "chat" : job.id,
        };
        setActiveChatId(job.chatId);
      }
      if (job) {
        storeRef.current?.openPane(job.id);
      }
      setPanesOpen(true);
      // Task #124: the top workspace-tab strip is keyed by JOB id, not agent
      // id. An agent with no resolvable job (rare — every call site here
      // gates on a working/dispatched agent) or whose job is the
      // orchestrator's OWN turn (that job IS the mission chat, never a tab —
      // see selectSubagentJobs) falls back to the mission chat rather than
      // pointing the strip at a dead or double-rendered tab id.
      if (job && job.capabilityMode !== "orchestrator") {
        storeRef.current?.openTab({
          id: job.id,
          agentId: job.agentId ?? agent?.id ?? null,
          vendor: job.vendor,
          status: job.status,
          capabilityMode: job.capabilityMode,
        });
        if (job.chatId === effectiveChatId) {
          setActiveWorkspaceTab(job.id);
        }
      } else {
        if (!job?.chatId || job.chatId === effectiveChatId) {
          setActiveWorkspaceTab("chat");
        }
      }
    },
    [state?.fleet?.agents, state?.dispatchJobs, effectiveChatId]
  );

  const activeChat = chats.find((chat) => chat.id === effectiveChatId) ?? null;
  const rawGitNexusStatus = gitnexusLive ?? state?.gitnexus ?? null;
  const activeGitNexusStatus: GitNexusIndexStatus =
    activeChat &&
    rawGitNexusStatus?.workspacePath === activeChat.workspacePath
      ? rawGitNexusStatus
      : {
          status: "unknown",
          note: activeChat
            ? "Binding this chat's workspace…"
            : "Select a chat to bind a workspace.",
        };
  const agents = state?.fleet?.agents ?? [];
  const taskTitles = new Map(
    (state?.tasks ?? []).map((task) => [task.id, task.title])
  );
  const chatScope = scopeDesktopStateToChat({
    chat: activeChat,
    jobs: state?.dispatchJobs ?? [],
    approvals: state?.approvals ?? [],
    auditEvents: state?.auditEvents ?? [],
    proposals: state?.workflowProposals ?? [],
  });
  const objectiveLoopStatus = useMemo(
    () =>
      activeChat?.taskId
        ? buildObjectiveLoopStatusForTask({
            taskId: activeChat.taskId,
            loops: state?.loopRuns ?? [],
            jobs: state?.dispatchJobs ?? [],
          })
        : null,
    [activeChat?.taskId, state?.loopRuns, state?.dispatchJobs]
  );
  const missionTurn = deriveMissionTurnState(
    chatScope.jobs,
    Boolean(activeChat && (running[activeChat.id] ?? false))
  );
  const activeRootJob = missionTurn.activeRoot;
  const latestRootJob = missionTurn.latestRoot;
  const activeChatRunning = missionTurn.running;
  const missionBudgetRefreshKey = activeRootJob
    ? `${activeRootJob.status}:${activeRootJob.createdAt}:${chatScope.jobs.length}`
    : "";
  const missionBudget = useMissionBudgetLine(
    activeRootJob?.id ?? null,
    missionBudgetRefreshKey
  );
  // Maintained for EVERY chat holding an open mirror, not just the selected
  // one: a turn keeps running when the human switches chats, and the pin has to
  // already be right when they switch back — latching it on arrival would latch
  // the correction root, which is the bug.
  liveTurnRootsRef.current = pinLiveTurnRoots(
    liveTurnRootsRef.current,
    Object.keys(live).filter((chatId) => (live[chatId]?.length ?? 0) > 0),
    state?.dispatchJobs ?? []
  );
  const liveTurnRootJobId = activeChat
    ? (liveTurnRootsRef.current[activeChat.id] ?? null)
    : null;
  const focusedApproval = chatScope.approvals.find(
    (approval) => approval.id === focusedApprovalId
  );
  // First-run onboarding shows when there are no chats yet, OR when readiness
  // has been probed and no vendor is connected (nothing can dispatch). We do
  // NOT nag mid-session when the probe is merely unavailable (readiness null)
  // and the user already has chats.
  const readiness = state?.readiness ?? null;
  const selectedOrchestratorVendor =
    state?.settings?.crew?.orchestratorVendor ?? defaultCoordinatorVendor();
  const selectedOrchestratorIssue = orchestratorReadinessIssue(
    readiness,
    selectedOrchestratorVendor
  );
  const fallbackOrchestratorVendor = readyOrchestratorFallback(
    readiness,
    selectedOrchestratorVendor
  );
  const onboarding = buildOnboardingState(readiness);
  const showOnboarding = shouldShowOnboarding({
    stateReady: state !== null,
    online: state?.online ?? false,
    firstTaskRunning,
    chatCount: chats.length,
    readinessKnown: readiness !== null,
    anyVendorReady: onboarding.anyReady,
    pendingApprovalCount: state?.approvals.length ?? 0,
    dismissed: onboardingDismissed,
  });
  const paneJobs = snapshot.panes
    .map((id) => chatScope.jobs.find((job) => job.id === id))
    .filter(
      (job): job is NonNullable<typeof job> => job !== undefined
    )
    .slice(-PANE_CAP);
  const paneAgents = paneJobs
    .map((job) => {
      const agent = agents.find((candidate) => candidate.id === job.agentId);
      if (!agent) {
        return undefined;
      }
      return {
        ...agent,
        status:
          job.status === "running" || job.status === "queued"
            ? "working"
            : job.status === "failed"
              ? "failed"
              : "idle",
        currentTaskId: job.taskId,
        currentJobId: job.id,
      };
    })
    .filter(
      (agent): agent is NonNullable<typeof agent> =>
        agent !== undefined
    );
  // Task #124: narrow the store's app-wide open tabs (snapshot.tabs) down to
  // THIS chat's own subagents, the same pattern paneAgents already uses
  // against snapshot.panes — selectSubagentJobs is the single source of
  // truth for "which jobs are eligible tabs" (excludes the orchestrator job,
  // which IS this chat), shared with the auto-reducer inside the store.
  const chatSubagentJobIds = new Set(
    selectSubagentJobs(chatScope.jobs).map((job) => job.id)
  );
  const chatSubagentTabs = snapshot.tabs.filter((tab) =>
    chatSubagentJobIds.has(tab.jobId)
  );
  // SUBAGENT_TAB_CAP is applied HERE — per chat, after narrowing — never
  // app-wide against snapshot.tabs (state-store.ts intentionally leaves that
  // list unbounded). Capping app-wide would slice the newest N tabs across
  // EVERY chat, so an unrelated chat's fan-out could evict this chat's own
  // running subagent tabs; the active chat must always see all of its own
  // tabs up to the cap, never lose them to another chat. The stable cap keeps
  // human-pinned and failed/interrupted tabs even when that exceeds the nominal
  // limit; the strip scrolls horizontally instead of hiding review evidence.
  const subagentTabs = capVisibleSubagentTabs(
    chatSubagentTabs,
    SUBAGENT_TAB_CAP
  );
  const runnerNotice = state ? runnerBanner(state) : null;
  // The dot is its own reading, and it has THREE states: an unknown must not
  // render as online (see runnerDot).
  const liveDot = runnerDot(state);
  const runnerOrStopNotice = pickRunnerOrStopNotice(runnerNotice, stopNotice);
  const activeTaskId = chatScope.activeTaskId;
  const rawStreamAgents =
    paneAgents.length > 0
      ? paneAgents
      : agents
          .filter(
            (agent) =>
              agent.status === "working" && chatScope.agentIds.has(agent.id)
          )
          .slice(0, 3);
  // The dispatch row is the execution source of truth. Fleet-agent release can
  // trail a terminal write by one poll, and a just-claimed job can lead the
  // Agent row by one poll; projecting the job status here prevents "idle" panes
  // beside a "working" job tab (or the reverse).
  const streamAgents = rawStreamAgents.map((agent) => {
    const sameAgentJobs = chatScope.jobs
      .filter((candidate) => candidate.agentId === agent.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const job =
      sameAgentJobs.find(
        (candidate) => candidate.id === agent.currentJobId
      ) ??
      sameAgentJobs.find(
        (candidate) =>
          candidate.status === "running" || candidate.status === "queued"
      ) ??
      sameAgentJobs[0];
    if (!job) {
      return agent;
    }
    const status =
      job.status === "running" || job.status === "queued"
        ? "working"
        : job.status === "failed"
          ? "failed"
          : "idle";
    return {
      ...agent,
      status,
      currentTaskId: job.taskId,
      currentJobId: job.id,
    };
  });
  // Task #124 / Wave 4.1 stale-job hazard, kept precise under the jobId tab
  // model: SessionGovernanceBanner (session-workspace.tsx) binds its
  // FAIL-CLOSED approval gate to activeSessionJob.id, so this resolution must
  // always name the CURRENT job — a dropped/misrouted job here silently
  // drops a pending approval gate from view. The OLD agent-keyed resolution
  // (activeWorkspaceTab === agentId) had to fall back from an agent's
  // currentJobId to an agentId match, because a reused agent slot could
  // otherwise bind a STALE/terminal job. Tabs are now keyed by jobId
  // directly — the tab's own identity IS the job — so this is a plain id
  // lookup with no fallback chain to get wrong; it is STRICTLY SAFER than
  // what it replaces, not merely equivalent.
  //
  // Task #130 LOAD-BEARING GUARD: a `panel:` tab (Memory/Evidence) must NEVER
  // resolve a DispatchJobRecord here — it fails to null exactly like "chat"
  // does. A panel tab is a human-driven, job-less surface; if it ever
  // resolved a job, SessionGovernanceBanner could bind its fail-closed
  // approval gate to the wrong tab. `isPanelTab` alone is enough to route
  // this (panel tab ids are never a real job id — see workspace-panels.ts).
  const activePanelTab = parsePanelTab(activeWorkspaceTab);
  // S1 §5: load the Connections read the FIRST time Settings is opened, and not
  // before — the evaluator reads four config files and probes PATH, and the
  // mission view has no use for the answer. Declared here rather than with the
  // other effects because it reads `activePanelTab`, which is resolved above.
  useEffect(() => {
    if (activePanelTab !== "settings" || mcpStatus !== null || mcpStatusError) {
      return;
    }
    void onRefreshMcpStatus();
  }, [activePanelTab, mcpStatus, mcpStatusError, onRefreshMcpStatus]);
  // A human terminal tab (vendor CLI / shell) is its own surface: never a
  // panel, never a job — so it can never bind a governance banner either.
  const activeHumanTerminal = isChatTerminalSessionId(activeWorkspaceTab)
    ? (humanTerminals.find(
        // Scoped to the SELECTED chat, because the panes are now rendered from
        // that chat's list: a tab id that survived a chat switch would select
        // no pane at all and leave the centre blank.
        (tab) => tab.id === activeWorkspaceTab && tab.chatId === effectiveChatId
      ) ?? null)
    : null;
  // ROADMAP T4 — PARKED-RUNTIME LRU recompute. Only LIVE (non-frozen) panes
  // of the ACTIVE chat ever hold an XTerm instance to park in the first
  // place (a cold-restored tab renders `FrozenTerminalTab`, which owns no
  // view at all). Recomputed on every mount-set/active change, not just once
  // — closing a tab must free its LRU slot for another immediately, not only
  // on the next focus switch.
  const mountedLiveHumanTerminalIds = humanTerminals
    .filter(
      (tab) => tab.chatId === effectiveChatId && tab.frozenScrollback === undefined
    )
    .map((tab) => tab.id);
  const mountedLiveHumanTerminalIdsKey = mountedLiveHumanTerminalIds.join(",");
  useEffect(() => {
    const reconciled = reconcileTerminalMruOrder(
      terminalMruOrderRef.current,
      mountedLiveHumanTerminalIds
    );
    terminalMruOrderRef.current = activeHumanTerminal
      ? touchTerminalMruOrder(reconciled, activeHumanTerminal.id)
      : reconciled;
    setParkedTerminalIds(
      computeParkedTerminalIds(
        terminalMruOrderRef.current,
        activeHumanTerminal?.id ?? null
      )
    );
    // `mountedLiveHumanTerminalIdsKey` stands in for the array's contents —
    // the array itself is a fresh reference every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedLiveHumanTerminalIdsKey, activeHumanTerminal?.id]);
  const activeSessionJob =
    activeWorkspaceTab === "chat" ||
    isPanelTab(activeWorkspaceTab) ||
    isChatTerminalSessionId(activeWorkspaceTab)
      ? null
      : (chatScope.jobs.find((job) => job.id === activeWorkspaceTab) ?? null);
  // SessionWorkspace still wants an AgentRecord (name/status for its header).
  // Prefer the REAL fleet agent behind the job; a queued job with no agent
  // slot assigned yet gets a lightweight stub built FROM the job itself
  // (vendor/status), so the tab always renders real job data instead of
  // silently falling through to the "chat" pane below.
  const sessionAgentForJob = (
    job: (typeof chatScope.jobs)[number]
  ): Parameters<typeof SessionWorkspace>[0]["agent"] =>
    agents.find((agent) => agent.id === job.agentId) ?? {
      id: job.agentId ?? job.id,
      vendor: job.vendor,
      name: `${job.vendor}-${job.id.slice(-4)}`,
      ordinal: 0,
      status: job.status === "running" ? "working" : "idle",
      currentTaskId: job.taskId,
      currentJobId: job.id,
    };
  const activeSessionAgent = activeSessionJob
    ? sessionAgentForJob(activeSessionJob)
    : null;
  // WHICH SESSION PANES MUST STAY MOUNTED. The one on screen, plus every job
  // whose Terminal body is holding a LIVE takeover pty.
  //
  // The pane used to be rendered only for the active tab, so ANY workspace-tab
  // switch — chat, a panel, a human terminal — unmounted the whole subtree
  // including an open fork's TerminalPreview. The pty survives that, but
  // nothing that can see it does: the port closes, the host detaches, and with
  // no consumer left to ack, PtyHost's backpressure pauses the vendor child
  // the moment it writes past its unread high-water mark. Coming back rebuilds
  // a fresh XTerm over a BOUNDED byte ring — for a full-screen vendor TUI,
  // replay from wherever the ring was trimmed to, quite possibly mid-escape
  // sequence. That is the same "switching stopped the terminal / the codex
  // stream is distorted" pair the human terminal tabs below were made
  // keep-mounted to fix. And if the job FINISHED while the human was away, the
  // grant flips to `resume` and the host refuses any `.fork` open outright
  // (terminal-host.ts), so that child is unreachable for the life of the app
  // with nothing in the UI saying so.
  //
  // Bounded on purpose: only panes holding a pty are kept, not every open job
  // tab, so a background pane is always one the human deliberately opened a
  // terminal in.
  const [takeoverJobIds, setTakeoverJobIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const setJobTakeoverOpen = useCallback((jobId: string, open: boolean) => {
    setTakeoverJobIds((current) => {
      // Identity-stable when nothing changed: this is called from an effect on
      // every mount, and a fresh Set each time would re-render forever.
      if (current.has(jobId) === open) {
        return current;
      }
      const next = new Set(current);
      if (open) {
        next.add(jobId);
      } else {
        next.delete(jobId);
      }
      return next;
    });
  }, []);
  const mountedSessionJobs = chatScope.jobs.filter(
    (job) => job.id === activeSessionJob?.id || takeoverJobIds.has(job.id)
  );
  // Task #124 — the chat header's "Open {vendor}" chip / any other direct
  // job-based open call: no agent resolution needed, the chat already has
  // the DispatchJobRecord in scope (chatScope.jobs). Never opens a tab for
  // the orchestrator's own job (that IS this chat) — mirrors openAgentPane's
  // guard above and openSubagentTab (subagent-tabs.ts) guards it again.
  const openSubagentTab = useCallback(
    (jobId: string) => {
      const job = chatScope.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.capabilityMode === "orchestrator") {
        return;
      }
      const watched: WatchedJob = {
        id: job.id,
        agentId: job.agentId ?? null,
        vendor: job.vendor,
        status: job.status,
        capabilityMode: job.capabilityMode,
      };
      storeRef.current?.openTab(watched);
      setActiveWorkspaceTab(job.id);
    },
    [chatScope.jobs]
  );
  /**
   * Crew-topology node click. Routes through the EXISTING tab-activation path
   * — the orchestrator's own job IS the mission chat (never a subagent tab, the
   * same guard openAgentPane/openSubagentTab already apply), everything else
   * goes through openSubagentTab. No second navigation mechanism.
   */
  const openTopologyJob = useCallback(
    (jobId: string) => {
      const job = chatScope.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        return;
      }
      if (job.capabilityMode === "orchestrator") {
        setActiveWorkspaceTab("chat");
        return;
      }
      openSubagentTab(jobId);
    },
    [chatScope.jobs, openSubagentTab]
  );
  /**
   * Vendors that hold a SEAT in the crew (≥1 agent, or a readiness-confirmed
   * lane), so the topology still draws an idle lane before its first dispatch.
   * The orchestrator seat is the hub itself and is filtered out downstream.
   */
  const crewSeatVendors = Array.from(
    new Set([
      ...agents.map((agent) => agent.vendor),
      ...(state?.readiness ?? [])
        .filter((entry) => entry.authenticated)
        .map((entry) => entry.vendor),
    ])
  ).sort((left, right) => left.localeCompare(right));
  const selectWorkspaceTab = useCallback(
    (id: string) => {
      if (id === "chat" || isPanelTab(id)) {
        setActiveWorkspaceTab(id);
        return;
      }
      const job = chatScope.jobs.find((candidate) => candidate.id === id);
      if (job && job.capabilityMode !== "orchestrator") {
        // Selecting a tab is an explicit human open. Pin it before switching so
        // a cleanly completed tab cannot auto-close while it is being read.
        storeRef.current?.openTab({
          id: job.id,
          agentId: job.agentId ?? null,
          vendor: job.vendor,
          status: job.status,
          capabilityMode: job.capabilityMode,
        });
      }
      setActiveWorkspaceTab(id);
      seenJobIdsRef.current.add(id);
    },
    [chatScope.jobs]
  );
  const pendingApprovalJobIds = useMemo(
    () =>
      new Set(
        (state?.approvals ?? [])
          .map((approval) => approval.jobId)
          .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0)
      ),
    [state?.approvals]
  );
  const anyJobRunning =
    Object.values(running).some(Boolean) ||
    (state?.dispatchJobs ?? []).some(
      (job) => job.status === "running" || job.status === "queued"
    );
  // Live work owned by the SELECTED chat — what "Stop this chat's tasks" acts
  // on. Advisory only (it just enables the affordance); the authoritative set
  // is re-read server-side by the cancel itself.
  const activeChatActiveJobs = (state?.dispatchJobs ?? []).filter(
    (job) =>
      job.chatId === effectiveChatId &&
      (job.status === "running" || job.status === "queued")
  ).length;

  // Center workspace tabs claim the left-nav highlight when open; otherwise
  // fall back to mission (or the approval dock when no center tab is active).
  // Terminal is strip-only — never a left-nav destination.
  const navActive: NavTarget =
    activePanelTab && isCenterNavTarget(activePanelTab)
      ? activePanelTab
      : !activeChat
        ? "mission"
        : layout.activeNav === "control" || layout.activeNav === "timeline"
          ? "mission"
          : layout.activeNav;
  // The fleet summary at the foot of the nav (count + readiness per vendor).
  // Every managed lane, from the one fleet list — not a third hand-written
  // vendor array that silently omits whichever lane landed most recently.
  const fleetLanes: NavFleetLane[] = FLEET_VENDORS.map((vendor) => ({
    vendor,
    count: agents.filter((agent) => agent.vendor === vendor).length,
    ready: Boolean(
      (state?.readiness ?? []).find((r) => r.vendor === vendor)?.authenticated
    ),
  }));
  // The active mission's task ids — the root chat task plus every crew job's
  // task — so questions (machine-wide in state) can be chat-scoped here.
  const activeChatTaskIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeChat?.taskId) ids.add(activeChat.taskId);
    for (const job of chatScope.jobs) {
      if (job.taskId) ids.add(job.taskId);
    }
    return ids;
  }, [activeChat, chatScope.jobs]);
  const openChatQuestions = (state?.questions ?? []).filter((question) =>
    activeChatTaskIds.has(question.taskId)
  ).length;
  // A blocking question IS a pending human decision — same badge as gates.
  const pendingDecisions =
    chatScope.approvals.length +
    chatScope.proposals.length +
    openChatQuestions;
  const crewActive = chatScope.jobs.some(
    (job) => job.status === "running" || job.status === "queued"
  );
  // Nav routing — single choke point so center tabs can NEVER become overlays:
  //   center nav (incl. control/timeline/settings/crew) → openPanelTab
  //   mission → focus Mission chat + close right dock
  const onNavigate = useCallback(
    (target: NavTarget) => {
      if (
        !activeChat &&
        target !== "mission" &&
        target !== "settings" &&
        target !== "crew"
      ) {
        return;
      }
      if (target === "mission") {
        setActiveWorkspaceTab("chat");
        layout.navigate("mission");
        return;
      }
      if (isCenterNavTarget(target)) {
        openPanelTab(target);
        return;
      }
      layout.navigate(target);
    },
    [activeChat, layout, openPanelTab]
  );

  const [modelCatalog, setModelCatalog] = useState<VendorModelCatalog | null>(
    null
  );
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [crewLanes, setCrewLanes] = useState<CrewRoleLaneIpc[]>([]);
  const [crewCostNotice, setCrewCostNotice] = useState<string | null>(null);

  const refreshModelCatalog = useCallback(async (vendor: OrchestratorVendor) => {
    setModelCatalogLoading(true);
    try {
      const catalog = await window.muon.listVendorModels(vendor);
      setModelCatalog(catalog);
    } catch {
      setModelCatalog(null);
    } finally {
      setModelCatalogLoading(false);
    }
  }, []);

  // The vendor's OWN report of the model it will run when MUON names none.
  //
  // Keyed BY VENDOR, not a single slot. The composer and the Crew page can be
  // looking at different vendors at the same instant (the Crew page's select is
  // a local draft that leads the persisted value), and a single slot meant
  // whichever surface asked last decided what BOTH of them displayed. Same
  // fact, two surfaces, two answers — the drift this whole change closes. Both
  // now index the same map by the vendor they are actually showing, and
  // `modelDisplay` additionally discards a resolution whose vendor does not
  // match, so a stale entry can never be printed under the wrong name.
  //
  // Deliberately NOT part of the boot-time catalog fetch and NOT on the settle
  // path: a resolution is asked for only by a surface about to display it (the
  // agent trigger taking hover/focus or opening, the Crew page mounting), and
  // main caches + single-flights it. A failed ask leaves a null resolution,
  // which renders as "<vendor> picks" — never as a guess.
  const [modelResolutions, setModelResolutions] = useState<
    Partial<Record<string, VendorModelResolutionIpc | null>>
  >({});
  const [modelResolvingByVendor, setModelResolvingByVendor] = useState<
    Partial<Record<string, boolean>>
  >({});
  // Synchronous in-flight/asked ledger. `setState` is async, so two surfaces
  // mounting in the same tick would both pass a state-based guard and fire two
  // IPCs; a ref closes that window.
  const askedModelVendorsRef = useRef<Set<string>>(new Set());
  const resolveModelForVendor = useCallback(
    async (vendor: OrchestratorVendor, options?: { refresh?: boolean }) => {
      if (!options?.refresh && askedModelVendorsRef.current.has(vendor)) return;
      askedModelVendorsRef.current.add(vendor);
      setModelResolvingByVendor((current) => ({ ...current, [vendor]: true }));
      try {
        const resolution = await window.muon.resolveVendorModel?.(vendor);
        setModelResolutions((current) => ({
          ...current,
          [vendor]: resolution ?? null,
        }));
      } catch {
        setModelResolutions((current) => ({ ...current, [vendor]: null }));
      } finally {
        setModelResolvingByVendor((current) => ({
          ...current,
          [vendor]: false,
        }));
      }
    },
    []
  );
  // Stable identity: the Crew page asks for its vendor from an effect, so an
  // inline arrow here would re-fire that effect on every App render.
  const onRequestModelResolution = useCallback(
    (vendor: OrchestratorVendor) => void resolveModelForVendor(vendor),
    [resolveModelForVendor]
  );

  const refreshCrewLanes = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const result = await window.muon.crewRoles(activeChatId);
      if (result.status === "ok") {
        setCrewLanes(result.lanes);
        setCrewCostNotice(result.costAccounting?.notice ?? null);
      }
    } catch {
      // Cost ordinal is advisory — keep the last good read on failure.
    }
  }, [activeChatId]);

  const onSetOrchestratorVendor = useCallback(
    async (vendor: OrchestratorVendor) => {
      const current = normalizeCrewConfig(
        state?.settings?.crew ?? DEFAULT_CREW_CONFIG
      );
      await onSaveCrewConfig(selectOrchestratorVendor(current, vendor));
      void refreshModelCatalog(vendor);
    },
    [onSaveCrewConfig, refreshModelCatalog, state?.settings?.crew]
  );

  const onSetMissionOrchestratorVendor = useCallback(
    async (vendor: OrchestratorVendor) => {
      try {
        await onSetOrchestratorVendor(vendor);
      } catch (error) {
        if (!activeChat) return;
        setLive((current) => ({
          ...current,
          [activeChat.id]: [
            ...(current[activeChat.id] ?? []),
            {
              role: "status",
              text: `✗ ${
                error instanceof Error
                  ? error.message
                  : "Could not change the Mission provider."
              }`,
            },
          ],
        }));
      }
    },
    [activeChat, onSetOrchestratorVendor]
  );

  const onSetOrchestratorEffort = useCallback(
    async (effort: string) => {
      const current = normalizeCrewConfig(
        state?.settings?.crew ?? DEFAULT_CREW_CONFIG
      );
      await onSaveCrewConfig(
        rememberOrchestratorPrefs(current, {
          effort: effort as OrchestratorEffort,
        })
      );
    },
    [onSaveCrewConfig, state?.settings?.crew]
  );

  useEffect(() => {
    const vendor =
      state?.settings?.crew?.orchestratorVendor ?? defaultCoordinatorVendor();
    void refreshModelCatalog(vendor);
  }, [refreshModelCatalog, state?.settings?.crew?.orchestratorVendor]);
  // A native approval notification may refer to another chat. Route to that
  // chat first; the focused dialog remains scoped and cannot render until the
  // target chat is active.
  useEffect(() => {
    if (!focusedApprovalId || !state) {
      return;
    }
    const approval = state.approvals.find(
      (candidate) => candidate.id === focusedApprovalId
    );
    if (!approval) {
      return;
    }
    const approvalJob = approval.jobId
      ? (state.dispatchJobs ?? []).find((job) => job.id === approval.jobId)
      : undefined;
    const targetChatId =
      approvalJob?.chatId ??
      chats.find((chat) => chat.taskId === approval.taskId)?.id ??
      null;
    if (targetChatId && targetChatId !== effectiveChatId) {
      pendingWorkspaceTabRef.current = null;
      setActiveChatId(targetChatId);
    }
  }, [
    chats,
    effectiveChatId,
    focusedApprovalId,
    state,
  ]);
  // Drop a STALE focused-approval id (resolved on another surface, auto-approved,
  // or a stale notification for a decided id) so it can never pin the Control
  // dock and lock the workspace. Reconcile against the live ledger every poll.
  useEffect(() => {
    const reconciled = reconcileFocusedApproval(
      focusedApprovalId,
      (state?.approvals ?? []).map((approval) => approval.id)
    );
    if (reconciled !== focusedApprovalId) {
      setFocusedApprovalId(reconciled);
    }
  }, [focusedApprovalId, state?.approvals]);
  // A focused approval must always reach the governed dialog, which lives inside
  // ControlRail — so opening one reveals the Control dock (mounting the rail +
  // its ApprovalReviewDialog). Gated on the RESOLVED approval (never a dangling
  // id), so a stale focus can never force-open or pin the dock.
  useEffect(() => {
    if (focusedApproval) {
      if (controlDockTab !== "review") {
        setControlDockTab("review");
      }
      if (layout.panel !== "control") {
        layout.navigate("control");
      }
    }
  }, [controlDockTab, focusedApproval, layout]);

  const dockPanel = layout.panel;
  const dockSection = dockPanel ? DOCK_SECTION[dockPanel] : null;

  // E3: keep the dock's own content mounted (see the <aside> below) so the
  // grid-column collapse can animate in BOTH directions instead of the
  // content popping out the instant the panel closes. `renderedDockPanel`
  // stays pinned to the last non-null panel while `dockSection`/`dockPanel`
  // (above) go null, so the close transition still has real content to
  // shrink away — the dock is `inert` while collapsed, so none of it is
  // reachable by keyboard/AT in the meantime.
  const [renderedDockPanel, setRenderedDockPanel] =
    useState<ContextPanel | null>(null);
  useEffect(() => {
    if (dockPanel) {
      setRenderedDockPanel(dockPanel);
      return;
    }
    // FIX 5: once the dock closes, clear the pinned content AFTER the close
    // transition (--dur-med) so the collapsed dock actually UNMOUNTS its last
    // section. Otherwise ControlRail keeps rendering it against a 0-width inert
    // surface and its children keep firing IPC forever (MissionBudgetControl →
    // getDispatchBudget, LiveDispatchHero → autoContext/preEditContext). The
    // delay preserves the close animation (a synchronous clear would pop the
    // content out mid-transition); re-opening cancels the pending clear via the
    // cleanup below, so the truthy branch re-pins the panel with no flicker.
    const timer = window.setTimeout(() => setRenderedDockPanel(null), 220);
    return () => window.clearTimeout(timer);
  }, [dockPanel]);
  const renderedDockSection = renderedDockPanel
    ? DOCK_SECTION[renderedDockPanel]
    : null;

  // A3: one status-keyed workspaceReview read per chat now feeds BOTH the A2
  // dock and the Workspaces sidebar. No duplicate numstat implementation or
  // duplicate active-chat IPC request.
  const dockWorkspaceReviewEntry = effectiveChatId
    ? workspaceReviews[effectiveChatId]
    : undefined;
  const dockReviewJob =
    (state?.dispatchJobs ?? []).find(
      (job) => job.id === dockWorkspaceReviewEntry?.jobId
    ) ?? null;
  const dockWorkspaceReview =
    dockWorkspaceReviewEntry?.review ?? null;
  const dockWorkspaceReviewLoading =
    dockWorkspaceReviewEntry?.loading ?? false;
  const dockWorkspacePath =
    dockWorkspaceReview?.status === "available"
      ? dockWorkspaceReview.workspacePath
      : (dockReviewJob?.workspacePath ?? activeChat?.workspacePath ?? null);

  // "Land this work" (Changes panel): the governed desktop `muon ship`.
  // Everything here is a fact the dock already holds — the shown job, the tree
  // its review was READ FROM, and the lane that ran it (lane keys are vendor
  // ids, so `job.vendor` is the same author `muon ship --lane` would name).
  const dockShipTarget: ShipTarget | null = dockReviewJob
    ? {
        jobId: dockReviewJob.id,
        taskId: dockReviewJob.taskId ?? null,
        laneKey: dockReviewJob.vendor ?? null,
        status: dockReviewJob.status ?? "",
        tree:
          // The truthiness guard is deliberate: a review from an older main
          // carries no `tree`, and "which tree is this" must then read as
          // unknown — never crash, never assume the canonical checkout.
          dockWorkspaceReview?.status === "available" && dockWorkspaceReview.tree
            ? {
                status: "resolved",
                kind: dockWorkspaceReview.tree.kind,
                path: dockWorkspaceReview.tree.path,
              }
            : dockWorkspaceReview?.status === "degraded"
              ? {
                  status: "unresolved",
                  reason: dockWorkspaceReview.reason,
                  action: dockWorkspaceReview.action,
                }
              : {
                  status: "unresolved",
                  reason: "This dispatch's tree has not been read yet.",
                  action: "Landing unlocks once the workspace review loads.",
                },
        fullAuto: state?.fullAuto ?? false,
      }
    : null;
  // jobId → the merge gate this window filed for it. Kept OUTSIDE the panel so
  // a decided outcome (below) can be matched back after tab switches.
  const [shipFiledByJob, setShipFiledByJob] = useState<Record<string, string>>(
    {}
  );
  const onShipDispatch = useCallback(
    async (request: ShipRequest): Promise<ShipOutcome> => {
      const outcome = await window.muon.shipTask(request);
      setShipFiledByJob((current) => ({
        ...current,
        [request.jobId]: outcome.approvalId,
      }));
      void storeRef.current?.tick();
      return outcome;
    },
    []
  );
  // The LATER, authoritative fact: what deciding that gate actually did to the
  // primary checkout (main keeps it keyed by approval id). Null until decided
  // WITH a merge result — the panel then keeps its own honest "filed" line.
  const dockShipApprovalId = dockReviewJob
    ? (shipFiledByJob[dockReviewJob.id] ?? null)
    : null;
  const dockShipMerge = dockShipApprovalId
    ? (state?.mergeOutcomes?.[dockShipApprovalId] ?? null)
    : null;
  const dockShipOutcome: ShipOutcome | null =
    dockShipApprovalId && dockShipMerge
      ? { approvalId: dockShipApprovalId, pending: false, merge: dockShipMerge }
      : null;

  const onCreateGitHubPullRequest = useCallback(async () => {
    if (!dockReviewJob) {
      throw new Error("Select a governed dispatch before creating a pull request.");
    }
    const action = await window.muon.createGitHubPullRequest({
      jobId: dockReviewJob.id,
      ...(effectiveChatId ? { chatId: effectiveChatId } : {}),
    });
    if (action.operation === "created" || action.operation === "existing") {
      setGitHubReview(action.review);
    }
    return action;
  }, [dockReviewJob, effectiveChatId]);

  const onMergeGitHubPullRequest = useCallback(
    async (input: { pullNumber: number; expectedHeadSha: string }) => {
      if (!dockReviewJob) {
        throw new Error("Select a governed dispatch before merging a pull request.");
      }
      return window.muon.mergeGitHubPullRequest({
        jobId: dockReviewJob.id,
        ...(effectiveChatId ? { chatId: effectiveChatId } : {}),
        ...input,
        method: "squash",
      });
    },
    [dockReviewJob, effectiveChatId]
  );

  useEffect(() => {
    const jobId = dockWorkspaceReviewEntry?.jobId;
    const shouldLoad =
      Boolean(state?.github?.connected) &&
      Boolean(jobId) &&
      dockPanel === "control" &&
      controlDockTab === "review";
    if (!shouldLoad || !jobId) {
      setGitHubReviewLoading(false);
      setGitHubReview(null);
      return;
    }
    let canceled = false;
    setGitHubReviewLoading(true);
    void window.muon
      .githubReview({ jobId, chatId: effectiveChatId ?? undefined })
      .then((review) => {
        if (!canceled) {
          setGitHubReview(review);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setGitHubReview({
            status: "degraded",
            reason:
              error instanceof Error
                ? error.message
                : "GitHub pull-request evidence is unavailable.",
            action: "Reconnect GitHub in Setup, then retry.",
          });
        }
      })
      .finally(() => {
        if (!canceled) {
          setGitHubReviewLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [
    controlDockTab,
    dockPanel,
    dockWorkspaceReviewEntry?.jobId,
    effectiveChatId,
    githubReviewRefresh,
    state?.github?.connected,
  ]);

  // Task #130: the open Memory/Evidence tabs, in open order, for the
  // workspace-tab strip — rendered AFTER "Mission chat", BEFORE the jobId
  // subagent tabs (see WorkspaceTabs).
  const panelTabsForStrip = openPanelTabs.map((kind) => ({
    id: panelTabId(kind),
    label: PANEL_TAB_LABELS[kind],
  }));

  // The strip's vendor tab bar: every spawnable vendor (registry-granted
  // terminal takeover + a declared CLI) with its readiness state, plus the
  // plain shell, plus ROADMAP P7 custom (ungoverned) agents after vendors.
  // Same readiness rows the crew surfaces read — no second probe.
  const terminalVendorMenu = useMemo(
    () => [
      ...buildTerminalVendorMenu(state?.readiness ?? null),
      ...buildCustomAgentMenu(customAgents),
    ],
    [customAgents, state?.readiness]
  );

  // Task 3: resizable sidebar + context-dock. Widths persist per panel
  // (localStorage) and drive the grid via CSS custom properties set on the
  // root element below, so the existing `.app.quiet` columns just read them.
  const sidebarWidth = usePanelWidth(
    "sidebar",
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH
  );
  const dockWidth = usePanelWidth(
    "dock",
    DOCK_DEFAULT_WIDTH,
    DOCK_MIN_WIDTH,
    DOCK_MAX_WIDTH
  );
  const controlRailProps: Omit<
    Parameters<typeof ControlRail>[0],
    "sections"
  > = {
    approvals: chatScope.approvals,
    // P0-1: same honesty in the dock inbox as on the agent tab. ANY armed lane
    // enables the split (the approver keys on the selection, not the derived
    // ALL-lanes boolean), and the covered list is what actually earns a card
    // the calm label — membership is stamped by main's own approver tick.
    fullAuto: (state?.fullAutoVendors?.length ?? 0) > 0,
    fullAutoCoveredApprovalIds: state?.fullAutoCoveredApprovalIds ?? [],
    fullAutoUncoveredApprovalIds: state?.fullAutoUncoveredApprovalIds ?? [],
    proposals: chatScope.proposals,
    jobs: chatScope.jobs,
    auditEvents: chatScope.auditEvents,
    receipts: state?.activeReceipts,
    workspaceReview: dockWorkspaceReview,
    focusApprovalId: focusedApprovalId,
    onReviewApproval: (approvalId) => {
      setFocusedApprovalId(approvalId);
    },
    onLoadMergeReview: (approvalId) =>
      window.muon.reviewApproval(approvalId),
    onResolveApproval,
    onApplyProposal: (runId) => void onApplyProposal(runId),
    onDismissProposal: (runId) => void onDismissProposal(runId),
    onOpenMemory: () => openPanelTab("memory"),
  };

  // First paint before the first state poll resolves: neither the app chrome
  // nor the gate — a quiet shell. Without this, a GATED launch mounted the
  // full app (and every child's effects) for up to a poll interval before
  // swapping to the gate card.
  if (!state) {
    return <div className="app quiet" aria-busy="true" />;
  }

  // P0-2 — the GitHub identity gate screen. Rendered INSTEAD of the app while
  // the gate is required and unsatisfied. Presentation only: trusted main
  // wraps every IPC channel (installGitHubIpcGate), so bypassing this screen
  // changes nothing. Completing the device flow flips `satisfied` on the next
  // state tick and the full app mounts.
  if (state.githubGate?.required && !state.githubGate.satisfied) {
    return (
      <div className="app quiet github-gate-screen">
        <div className="github-gate-card" role="dialog" aria-label="Sign in with GitHub">
          <img aria-hidden="true" className="titlebar-mark" src="./assets/muon-mark.svg" />
          <h1>Verify your GitHub identity</h1>
          <p>
            MUON runs coding agents with real authority over your repositories,
            so it asks who is operating it before any work starts. Sign in once
            with GitHub&apos;s device flow — MUON stores the credential locally
            (0600) and never sends it to a vendor or an agent.
          </p>
          <GitHubConnectPanel
            status={(state.github ?? null) as GitHubConnectionStatus | null}
            onStart={onStartGitHub}
            onPoll={onPollGitHub}
            onDisconnect={onDisconnectGitHub}
            onOpenUrl={onOpenGitHubUrl}
          />
          <p className="github-gate-note">
            While locked, observation, stops, approvals, and updates stay
            available; starting new work does not.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        // Session desk light scope:
        // the desk surface runs the calm-light token scope over the Quiet
        // dark base, and carries the breadcrumb chrome row.
        "app quiet has-crumb" +
        (deskTheme === "light" ? " desk-light" : "") +
        (sidebarOpen ? "" : " sidebar-hidden") +
        (dockSection ? "" : " dock-hidden")
      }
      style={
        {
          "--sidebar-w": `${sidebarWidth.width}px`,
          "--dock-w": `${dockWidth.width}px`,
        } as CSSProperties
      }
    >
      <div className="titlebar">
        {/* Top-bar anatomy (spec T1–T4): traffic-light inset, brand,
            Projects/Sessions toggle, circular +. The sidebar collapse moved
            to the breadcrumb ← below — the top bar carries no collapse. */}
        <div className="titlebar-brand tb-left">
          <img
            alt=""
            aria-hidden="true"
            className="titlebar-mark"
            src="./assets/muon-mark.svg"
          />
          <strong>MUON</strong>
        </div>
        <div className="tb-tabs" role="tablist" aria-label="Desk view">
          {/* UI-now: Projects focuses the rail (the project→session tree);
              Sessions is the active desk view. Distinct destinations arrive
              with the projects overview (session-desk G4 follow-on). */}
          <button
            className="tb-tab"
            role="tab"
            aria-selected={false}
            onClick={() => setSidebarOpen(true)}
          >
            Projects
          </button>
          <button className="tb-tab active" role="tab" aria-selected>
            Sessions
          </button>
          <button
            className="tb-plus"
            onClick={() => void newChat()}
            aria-label="New session"
            title="New session"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {state?.fullAuto ? (
          <span className="full-auto-indicator" role="status">
            Full auto — safety gates off
          </span>
        ) : (state?.fullAutoVendors?.length ?? 0) > 0 ? (
          // A SUBSET selection still disarms real gates on the checked lanes;
          // showing nothing here read as "safety gates on" while covered
          // approvals were resolving themselves.
          <span className="full-auto-indicator" role="status">
            Auto-approve — {state!.fullAutoVendors!.length} lane
            {state!.fullAutoVendors!.length === 1 ? "" : "s"}, gates off there
          </span>
        ) : null}
        <div className="tb-cluster">
          {/* Presence, mapped honestly: MUON's fleet, never fake collaborators
              (spec T6). */}
          <span
            className="tb-presence"
            title={fleetLanes
              .map((lane) => `${lane.vendor}: ${lane.count}`)
              .join(" · ")}
          >
            <span className="presence-avatar" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                <circle cx="8" cy="5.5" r="2.6" />
                <path d="M2.8 13.4c.7-2.6 2.8-3.9 5.2-3.9s4.5 1.3 5.2 3.9z" />
              </svg>
            </span>
            {fleetLanes.reduce((sum, lane) => sum + lane.count, 0)}
          </span>
          {/* A dot, not a live region: role="status" here collided with the
              full-auto band's own status role in every by-role query, and a
              silent colour change is not an announcement anyway. */}
          <span
            className={`tb-live-dot ${liveDot.state}`}
            role="img"
            aria-label={liveDot.label}
            title={liveDot.label}
          />
          <button
            className="tb-kbd"
            onClick={() => setPaletteOpen(true)}
            title="Command palette"
          >
            ⌘K
          </button>
          <button
            className="desk-iconbtn"
            onClick={toggleDeskTheme}
            aria-label={
              deskTheme === "light" ? "Switch to dark desk" : "Switch to light desk"
            }
            title={
              deskTheme === "light" ? "Switch to dark desk" : "Switch to light desk"
            }
          >
            {deskTheme === "light" ? (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6z" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <button
            className="desk-iconbtn"
            onClick={() => onNavigate("settings")}
            aria-label="Settings"
            title="Settings"
          >
            {/* Cog — the previous rays-around-circle was indistinguishable from
                the light/dark sun control next to it. */}
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Breadcrumb bar (spec B1–B6): ← · project / Sessions · model · tools · Stop */}
      <div className="crumbbar">
        <button
          className="crumb-back"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-pressed={sidebarOpen}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <svg
            viewBox="0 0 16 16"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M10.5 3.5 6 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="crumb-path" title={activeChat?.workspacePath ?? ""}>
          {activeChat
            ? (activeChat.workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ??
              activeChat.workspacePath)
            : "MUON"}
          <span className="crumb-sep">/</span>
          <span className="crumb-leaf">Sessions</span>
          <span className="crumb-caret" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 6.5 8 10l4-3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        <span className="crumb-spacer" />
        {state ? (
          <SystemsStatusButton
            preflight={state.preflight ?? null}
            readinessMeta={state.readinessMeta}
            onOpenSettings={() => onNavigate("settings")}
          />
        ) : null}
        <GitNexusColumn
          status={activeGitNexusStatus}
          onOpenGraph={() => {
            if (activeChat) {
              openPanelTab("graph");
            }
          }}
        />
        <span className="crumb-tools">
          <button
            className="desk-iconbtn"
            onClick={() => openPanelTab("evidence")}
            disabled={!activeChat}
            aria-label="Pre-edit context"
            title="Look up code impact and memory for any symbol before you edit"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="m6.5 4.5-3 3.5 3 3.5M9.5 4.5l3 3.5-3 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="desk-iconbtn"
            onClick={() => openPanelTab("timeline")}
            disabled={!activeChat}
            aria-label="Timeline"
            title="Timeline"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <circle cx="8" cy="8" r="5.6" />
              <path d="M8 5v3.2l2.2 1.4" strokeLinecap="round" />
            </svg>
          </button>
        </span>
        <button
          className="crumb-stop"
          onClick={() => void onStopAll()}
          disabled={!anyJobRunning}
          title="Stop every queued or running task"
        >
          <span className="stop-glyph" aria-hidden="true" />
          Stop
        </button>
      </div>

      {!sidebarOpen && (
        <button
          className="sidebar-expand"
          onClick={() => setSidebarOpen(true)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <IconChevron dir="right" size={14} />
        </button>
      )}

      {/* E3: kept mounted (was `{sidebarOpen && <Sidebar/>}`) so the grid's
          --sidebar-w → 0 transition (see .app.quiet) can animate the collapse
          itself, not just the reopen. `inert` while collapsed removes it from
          the tab order/AT tree — collapsed contents are inert, not gone. The
          persisted collapse state (muon.sidebarOpen) and the floating
          .sidebar-expand affordance above are unchanged. */}
      <Sidebar
        state={state}
        navActive={navActive}
        navPendingDecisions={pendingDecisions}
        navCrewActive={crewActive}
        navFleet={fleetLanes}
        onNavigate={onNavigate}
        activeChatId={effectiveChatId}
        workspaceReviews={workspaceReviews}
        taskTitles={taskTitles}
        onSelectChat={(chatId) => {
          pendingWorkspaceTabRef.current = null;
          setFocusedApprovalId(null);
          setActiveChatId(chatId);
        }}
        onArchiveChat={(chatId) => void onArchiveChat(chatId)}
        archiveError={archiveError}
        onCancelChat={(chatId) => void onCancelChat(chatId)}
        cancellingChatId={cancellingChatId}
        cancelNotice={cancelNotice}
        onNewChat={(workspacePath) => void newChat(workspacePath)}
        onStepFleet={(vendor, delta) => void onStepFleet(vendor, delta)}
        onOpenAgent={openAgentPane}
        onSetFullAutoVendors={(vendors) => void onSetFullAutoVendors(vendors)}
        onOpenPortPreview={(port) => void onOpenPortPreview(port)}
        panelWidth={sidebarWidth}
        collapsed={!sidebarOpen}
      />

      <main className="center cockpit-center">
        {/* One system line: highest-priority notice only. Offline always
            wins; otherwise a true runner failure (error tone) outranks the
            stop-all confirmation, but an info/warning runner banner does
            not, see pickRunnerOrStopNotice. */}
        {state && !state.online ? (
          <div className="system-line offline-banner">
            Control plane offline, {state.lastError ?? "unreachable"}. Open
            Settings to set the API base and token, and make sure the backend
            is running.
          </div>
        ) : runnerOrStopNotice === "runner" && runnerNotice ? (
          <div className={`system-line runner-banner ${runnerNotice.tone}`}>
            {runnerNotice.text}
          </div>
        ) : runnerOrStopNotice === "stop" && stopNotice ? (
          <div className="system-line stop-notice" role="status">
            {stopNotice}
          </div>
        ) : null}
        {firstTaskOutcome ? (
          <div className="system-line first-task-done" role="status">
            <span>
              First task complete — MUON captured its first memory from the
              run. Review it and decide whether the crew may rely on it.
            </span>
            <button
              className="ghost-btn"
              onClick={() => {
                onNavigate("memory");
                setFirstTaskOutcome(null);
              }}
            >
              Review memory
            </button>
            <button
              aria-label="Dismiss"
              className="ghost-btn"
              onClick={() => setFirstTaskOutcome(null)}
            >
              ×
            </button>
          </div>
        ) : null}
        {/* "Why this dispatch" + "Reconnaissance" moved OUT of center into the
            right context dock (see the Control/Review dock below) so the center
            is just the mission chat. */}
        {activeChat ? (
          <div className="workspace-stack">
            <WorkspaceTabs
              activeId={
                activePanelTab
                  ? panelTabId(activePanelTab)
                  : (activeHumanTerminal?.id ??
                    activeSessionJob?.id ??
                    "chat")
              }
              panelTabs={panelTabsForStrip}
              tabs={subagentTabs}
              seenJobIds={seenJobIdsRef.current}
              pendingApprovalJobIds={pendingApprovalJobIds}
              onSelect={selectWorkspaceTab}
              onClose={(id) => {
                const kind = parsePanelTab(id);
                if (kind) {
                  closePanelTab(kind);
                  return;
                }
                if (isChatTerminalSessionId(id)) {
                  closeHumanTerminal(id);
                  return;
                }
                void window.muon.terminal.close?.(`terminal-${id}`);
                storeRef.current?.closeTab(id);
                if (activeWorkspaceTab === id) {
                  setActiveWorkspaceTab("chat");
                }
              }}
              terminalTabs={humanTerminals
                .filter((tab) => tab.chatId === activeChat.id)
                .map(({ id, label, kind }) => ({
                  id,
                  label,
                  kind,
                  // ROADMAP P7 — custom:<slug> tabs are always Ungoverned.
                  ungoverned: kind.startsWith("custom:"),
                  // T2: display-only heuristic status for this tab's dot —
                  // see lib/terminal-activity.ts + lib/pane-status.ts.
                  status: terminalPaneStatus(
                    terminalActivity[id] ?? INITIAL_TERMINAL_ACTIVITY,
                    seenJobIdsRef.current.has(id),
                    // ADR-0039 D3: the tab's vendor, so a per-vendor manifest
                    // entry applies. Without it every tab took the wildcard
                    // and per-vendor detection was dead code.
                    { vendorId: kind }
                  ),
                }))}
              vendorMenu={terminalVendorMenu}
              onOpenVendorTerminal={openHumanTerminal}
            />
            {activePanelTab ? (
              <div
                aria-labelledby={`workspace-tab-${panelTabId(activePanelTab)}`}
                className="workspace-panel-shell"
                id={`workspace-panel-${panelTabId(activePanelTab)}`}
                role="tabpanel"
              >
                {(() => {
                  // Exhaustive switch — adding a WorkspacePanelKind without a
                  // case here is a type error, so no new surface can silently
                  // fall through to Terminal (or mount as an overlay).
                  switch (activePanelTab) {
                    case "memory":
                      return (
                        <MemoryPanel
                          activeTaskId={activeTaskId}
                          chatId={activeChat.id}
                          standingConsent={state?.fullAuto ?? false}
                        />
                      );
                    case "evidence":
                      return (
                        <EvidencePanel
                          activeTaskId={activeTaskId}
                          chatId={activeChat.id}
                          // U3: Evidence opens populated. These are the same
                          // chat-scoped records the Crew/Timeline surfaces
                          // read, so no new IPC and no second source of truth.
                          jobs={chatScope.jobs}
                          events={chatScope.auditEvents}
                          taskTitles={taskTitles}
                          missionLoading={!state}
                          missionError={fleetError}
                        />
                      );
                    case "graph":
                      return (
                        <GraphView
                          open
                          onClose={() => closePanelTab("graph")}
                          status={activeGitNexusStatus}
                        />
                      );
                    case "terminal":
                      // A4 — the human's own login shell in this chat's
                      // workspace, not job-tied. NOT "governed": ADR-0023 §5
                      // records this posture deliberately — the shell is
                      // spawned by Electron main, unconfined, with the
                      // operator's own ambient environment minus MUON's
                      // control-plane tokens, exactly as if the human had
                      // opened a terminal themselves. No approval gate, no
                      // sandbox, no lane budget applies to what is typed here.
                      // What IS host-decided: the command (a fixed allowlist)
                      // and the cwd (resolved from the chat record, never from
                      // this component). Fixed sessionId so scrollback survives
                      // switching away and back. Shell exit closes the tab.
                      return (
                        <TerminalPreview
                          sessionId={`terminal-chat:${activeChat.id}`}
                          spawn={{ file: "shell", cwd: "." }}
                          onExit={() => closePanelTab("terminal")}
                        />
                      );
                    case "topology":
                      // The live crew org chart for THIS chat's mission.
                      // Keyed by chat so a switch remounts clean — no
                      // cross-chat bleed of roles/coordination state.
                      return (
                        <CrewTopology
                          key={activeChat.id}
                          chatId={activeChat.id}
                          fleetVendors={crewSeatVendors}
                          jobs={chatScope.jobs}
                          onOpenJob={openTopologyJob}
                          orchestratorVendor={selectedOrchestratorVendor}
                        />
                      );
                    case "crew":
                      return (
                        <CrewPanel
                          state={state}
                          taskTitles={taskTitles}
                          missionEvents={chatScope.auditEvents}
                          activeChatId={effectiveChatId}
                          fleetError={fleetError}
                          onSaveCrewConfig={onSaveCrewConfig}
                          onRecheckReadiness={() =>
                            void onRecheckReadiness()
                          }
                          readinessRefreshing={readinessRefreshing}
                          readinessRefreshError={readinessRefreshError}
                          onStepFleet={(vendor, delta) =>
                            void onStepFleet(vendor, delta)
                          }
                          onOpenAgent={openAgentPane}
                          modelResolutions={modelResolutions}
                          modelResolvingByVendor={modelResolvingByVendor}
                          onRequestModelResolution={onRequestModelResolution}
                        />
                      );
                    case "control":
                      return (
                        <div className="control-workspace">
                          <header className="workspace-page-head">
                            <strong>Control</strong>
                            <span>
                              What needs you on this mission — gates, recon, and
                              why agents are working.
                            </span>
                          </header>
                          <section
                            className="control-page-section"
                            aria-labelledby="control-why-heading"
                          >
                            <header className="control-page-section-head">
                              <h2 id="control-why-heading">Why this dispatch</h2>
                              <p>
                                Shared context and evidence that shaped the
                                current plan.
                              </p>
                            </header>
                            <LiveDispatchHero
                              taskId={activeTaskId}
                              onOpenBrain={() => openPanelTab("evidence")}
                            />
                          </section>
                          <section
                            className="control-page-section"
                            aria-labelledby="control-recon-heading"
                          >
                            <header className="control-page-section-head">
                              <h2 id="control-recon-heading">Reconnaissance</h2>
                              <p>
                                Repo shape and a recommended crew plan for this
                                workspace.
                              </p>
                            </header>
                            <ReconCard />
                          </section>
                          <section
                            className="control-page-section control-page-section-review"
                            aria-label="Review"
                          >
                            <ControlRail
                              {...controlRailProps}
                              sections={["review"]}
                            />
                          </section>
                        </div>
                      );
                    case "timeline":
                      return (
                        <div className="control-workspace timeline-workspace">
                          <header className="workspace-page-head">
                            <strong>Timeline</strong>
                            <span>
                              What agents reported on this mission — held as
                              data, never as an instruction.
                            </span>
                          </header>
                          <ControlRail
                            {...controlRailProps}
                            sections={["activity"]}
                          />
                        </div>
                      );
                    case "settings":
                      return (
                        <SettingsPanel
                          state={state}
                          runnerDetail={runnerNotice?.text}
                          onRecheckReadiness={() =>
                            void onRecheckReadiness()
                          }
                          readinessRefreshing={readinessRefreshing}
                          readinessRefreshError={readinessRefreshError}
                          onSaveSettings={onSaveSettings}
                          onStartGitHub={onStartGitHub}
                          onPollGitHub={onPollGitHub}
                          onDisconnectGitHub={onDisconnectGitHub}
                          onOpenGitHubUrl={onOpenGitHubUrl}
                          updateStatus={updateStatus}
                          onCheckUpdates={onCheckUpdates}
                          onToggleAutoUpdate={onToggleAutoUpdate}
                          onToggleAutoContinue={(enabled) => void onToggleAutoContinue(enabled)}
                          onToggleTelemetry={(enabled) => void onToggleTelemetry(enabled)}
                          onTogglePortPreview={(enabled) => void onTogglePortPreview(enabled)}
                          onPauseCommitment={onPauseCommitment}
                          onResumeCommitment={onResumeCommitment}
                          onDownloadUpdate={onDownloadUpdate}
                          onInstallUpdate={onInstallUpdate}
                          mcpStatus={mcpStatus}
                          mcpStatusLoading={mcpStatusLoading}
                          mcpStatusError={mcpStatusError}
                          onRefreshMcpStatus={() => void onRefreshMcpStatus()}
                          onProbeMcp={onProbeMcp}
                          onInstallMcp={onInstallMcp}
                          mcpAttachedByVendor={mcpAttachedByVendor}
                          onAttachMcp={onAttachMcp}
                          onDetachMcp={onDetachMcp}
                        />
                      );
                    default: {
                      const _exhaustive: never = activePanelTab;
                      return _exhaustive;
                    }
                  }
                })()}
              </div>
            ) : activeHumanTerminal ? (
              // The human terminal panes are NOT rendered here. They are
              // rendered ONCE, below, for every open terminal tab in this chat,
              // and merely hidden when another tab is on screen — see the
              // block after this switch for why unmounting them was the defect.
              null
            ) : activeSessionAgent && activeSessionJob ? (
              // The session panes are NOT rendered here either. They are
              // rendered ONCE, below, for the job on screen AND for every job
              // whose Terminal body is holding a live takeover pty, and merely
              // hidden when another tab is on screen — see `mountedSessionJobs`
              // for why unmounting them was the defect.
              null
            ) : (
              <div
                aria-labelledby="workspace-tab-chat"
                className="conversation-shell"
                id="workspace-panel-chat"
                role="tabpanel"
              >
                {/* The "Restored active mission turn · … [Stop this turn]"
                    banner used to sit here, full-width and warning-coloured,
                    above the conversation. The running turn and its stop are
                    now part of the composer (ChatView's `turnActivity` /
                    `onStopTurn` below) — same governed interrupt, no slab over
                    the chat. */}
                {!activeChatRunning &&
                latestRootJob &&
                (latestRootJob.status === "failed" ||
                  latestRootJob.status === "interrupted") ? (
                  <div className="idle-terminal-notice" role="status">
                    <span>
                      Last mission turn {latestRootJob.status}. Review its
                      activity, then send a new follow-up when you are ready.
                    </span>
                  </div>
                ) : null}
                {idleNudges[activeChat.id] && !activeChatRunning ? (
                  <div className="idle-terminal-notice" role="status">
                    <span>Worker finished while orchestrator was idle.</span>
                    <button
                      className="primary-btn"
                      onClick={() =>
                        void continueOrchestration(
                          activeChat.id,
                          idleNudges[activeChat.id]!
                        )
                      }
                    >
                      Continue orchestration
                    </button>
                  </div>
                ) : null}
                <PresetsBar
                  activePresetId={activePresetIds[activeChat.id] ?? null}
                  applyingPresetId={applyingPresetId}
                  disabled={activeChatRunning}
                  onApply={(presetId) =>
                    onApplyPreset(activeChat.id, presetId)
                  }
                  onSave={onSavePresets}
                  presets={
                    alignStockPresetsToVendor(
                      state?.settings.presets ?? DEFAULT_DESKTOP_PRESETS,
                      (state?.settings?.crew?.orchestratorVendor ??
                        "claude-code") as DesktopPresetVendor
                    )
                  }
                  status={presetStatus[activeChat.id] ?? null}
                />
                <ChatView
                  // Keyed so switching chats remounts with fresh history state.
                  key={activeChat.id}
                  chat={activeChat}
                  approvals={[]}
                  running={activeChatRunning}
                  live={live[activeChat.id] ?? []}
                  model={chatModels[activeChat.id] ?? null}
                  defaultModel={
                    state?.settings?.crew?.orchestratorModel || null
                  }
                  onSetModel={(model) => setChatModel(activeChat.id, model)}
                  orchestratorVendor={selectedOrchestratorVendor}
                  onSetOrchestratorVendor={(vendor) =>
                    void onSetMissionOrchestratorVendor(vendor)
                  }
                  orchestratorEffort={
                    state?.settings?.crew?.orchestratorEffort ?? "medium"
                  }
                  onSetOrchestratorEffort={(effort) =>
                    void onSetOrchestratorEffort(effort)
                  }
                  modelCatalog={modelCatalog}
                  modelCatalogLoading={modelCatalogLoading}
                  modelResolution={
                    modelResolutions[selectedOrchestratorVendor] ?? null
                  }
                  modelResolving={
                    modelResolvingByVendor[selectedOrchestratorVendor] ?? false
                  }
                  onRequestModelResolution={() => {
                    void resolveModelForVendor(selectedOrchestratorVendor);
                  }}
                  onRequestModelCatalog={() => {
                    void refreshModelCatalog(selectedOrchestratorVendor);
                    // Opening the menu is an explicit ask, so it re-probes even
                    // when a previous answer is already on screen.
                    void resolveModelForVendor(selectedOrchestratorVendor, {
                      refresh: true,
                    });
                  }}
                  readiness={state?.readiness ?? null}
                  readinessMeta={state?.readinessMeta}
                  orchestratorReadinessIssue={selectedOrchestratorIssue}
                  gitnexusStatus={activeGitNexusStatus}
                  missionBudget={missionBudget}
                  crewLanes={crewLanes}
                  crewCostNotice={crewCostNotice}
                  onRefreshCrewLanes={() => void refreshCrewLanes()}
                  readinessRefreshing={readinessRefreshing}
                  readinessRefreshError={readinessRefreshError}
                  onRecheckReadiness={() => void onRecheckReadiness()}
                  fallbackOrchestratorVendor={fallbackOrchestratorVendor}
                  onUseFallbackOrchestrator={(vendor) =>
                    void onSetMissionOrchestratorVendor(vendor)
                  }
                  onConfigureAgents={() => openPanelTab("crew")}
                  onSend={(message) => send(activeChat.id, message)}
                  onResolveApproval={(id, status) =>
                    void onResolveApproval(id, status)
                  }
                  onRenameChat={(title) => void onRenameChat(activeChat.id, title)}
                  onLiveSettled={settleLive}
                  // U4 — where the LIVE turn begins in this chat's stream, so
                  // the transcript can keep loading the turns BEFORE it while
                  // this one runs. Not a scope: the mission is the chat.
                  activeRootJobId={activeRootJob?.id ?? null}
                  // …and which root the live MIRROR belongs to, which stays the
                  // root the human's turn started on even after a crew-contract
                  // correction re-roots the turn. Null while no mirror is open,
                  // where the active root above is the right boundary.
                  liveTurnRootJobId={liveTurnRootJobId}
                  subagents={subagentTabs}
                  onOpenSubagent={openSubagentTab}
                  // The turn control, moved from the banner into the composer.
                  // `recoveredActiveRoot` no longer gates it: a turn is a turn
                  // whether this window started it or found it already running
                  // after a restart, and both are stoppable the same way.
                  turnActivity={
                    objectiveLoopComposerActivity(objectiveLoopStatus) ??
                    (activeRootJob
                      ? activeRootJob.waitingApproval
                        ? "Waiting for your approval"
                        : (activeRootJob.currentActivity ??
                          "Waiting for the next provider event")
                      : null)
                  }
                  objectiveLoopStatus={objectiveLoopStatus}
                  onStopObjectiveLoop={
                    objectiveLoopStatus?.canStop
                      ? () => onStopObjectiveLoop(objectiveLoopStatus.loopId)
                      : undefined
                  }
                  onResumeObjectiveLoop={
                    objectiveLoopStatus?.canResume &&
                    objectiveLoopStatus.resumeFromJobId
                      ? () =>
                          onResumeObjectiveLoop(objectiveLoopStatus.resumeFromJobId!)
                      : undefined
                  }
                  // Wired only once MUON holds the job it would interrupt, so
                  // the composer never shows a stop that cannot stop anything.
                  // Identical governed call to the old banner's. NOT wrapped in
                  // `void` — the composer awaits the result so a failed
                  // interrupt attempt (not a failed turn) unlatches the stop
                  // control for a retry instead of leaving it stuck forever.
                  {...(activeRootJob
                    ? {
                        onStopTurn: () =>
                          cancelDispatch(activeChat.id, activeRootJob.id),
                        onSteerNow: (message: string) =>
                          window.muon.steerDispatch(activeRootJob.id, message),
                      }
                    : {})}
                />
              </div>
            )}
            {/* EVERY open human terminal in this chat, mounted at once and
                merely HIDDEN when another tab is on screen.

                Switching tabs used to unmount the pane. The pty survived — but
                nothing survived that a human could see it through. The port
                closed, so the host DETACHED, and with no consumer left to ack,
                PtyHost's backpressure paused the driver the moment the child
                had written its high-water mark of unread bytes: the vendor CLI
                was genuinely stopped, mid-render, by OS flow control. Coming
                back then disposed nothing and rebuilt everything — a fresh
                XTerm replaying a BOUNDED byte ring, which for a full-screen
                vendor TUI means replaying from wherever the ring happened to
                have been trimmed to, quite possibly mid-escape-sequence, with
                the alternate-screen enter long gone. "Switching stopped the
                terminal" and "the codex stream is distorted" are the same
                mount/unmount cycle seen twice.

                So a background tab is now literally that: still mounted, still
                attached, still acking, still scrolling — just not on screen.
                Nothing here opens or closes a session; `hidden` is a
                presentation flag that only triggers a re-measure on return
                (a hidden container reports 0×0). */}
            {humanTerminals
              .filter((tab) => tab.chatId === activeChat.id)
              .map((tab) => {
                const active = activeHumanTerminal?.id === tab.id;
                return (
                  <div
                    aria-labelledby={`workspace-tab-${tab.id}`}
                    className="workspace-panel-shell workspace-terminal-shell"
                    hidden={!active}
                    id={`workspace-panel-${tab.id}`}
                    key={tab.id}
                    role="tabpanel"
                  >
                    {tab.frozenScrollback !== undefined ? (
                      <FrozenTerminalTab
                        hidden={!active}
                        onAcknowledge={() =>
                          acknowledgeRestoredTerminal(tab.id)
                        }
                        scrollback={tab.frozenScrollback}
                        sessionId={tab.id}
                      />
                    ) : (
                      <TerminalPreview
                        hidden={!active}
                        // ROADMAP T4 — PARKED-RUNTIME LRU: released while
                        // backgrounded beyond the cap; pty + channel untouched.
                        parked={parkedTerminalIds.has(tab.id)}
                        sessionId={tab.id}
                        spawn={{ file: tab.kind, cwd: "." }}
                        workspaceRoot={activeChat.workspacePath ?? null}
                        onExit={(exit) => onHumanTerminalExit(tab, exit)}
                        onActivity={(event) =>
                          onHumanTerminalActivity(tab.id, event)
                        }
                        onSearchController={(controller) => {
                          terminalSearchControllersRef.current[tab.id] =
                            controller ?? undefined;
                        }}
                      />
                    )}
                    {active && terminalSearchOpen && (
                      <TerminalSearchOverlay
                        onClose={() => setTerminalSearchOpen(false)}
                        onFindNext={() =>
                          terminalSearchControllersRef.current[
                            tab.id
                          ]?.findNext(terminalSearchQuery)
                        }
                        onFindPrevious={() =>
                          terminalSearchControllersRef.current[
                            tab.id
                          ]?.findPrevious(terminalSearchQuery)
                        }
                        onQueryChange={(query) => {
                          setTerminalSearchQuery(query);
                          if (query) {
                            terminalSearchControllersRef.current[
                              tab.id
                            ]?.findNext(query);
                          } else {
                            terminalSearchControllersRef.current[
                              tab.id
                            ]?.clear();
                          }
                        }}
                        query={terminalSearchQuery}
                      />
                    )}
                  </div>
                );
              })}
            {/* THE SESSION PANES, on the same rule and for the same reason.
                The one on screen, plus any job whose Terminal body holds a
                live takeover pty — see `mountedSessionJobs` above for the
                full failure. A takeover pane that unmounts on an ordinary tab
                switch is worse than the human terminal case it mirrors: the
                fork can also become permanently unreachable, because the
                host refuses a `.fork` open once the job's grant has flipped
                to `resume`. */}
            {mountedSessionJobs.map((job) => {
              const active = activeSessionJob?.id === job.id;
              return (
                <div
                  aria-labelledby={`workspace-tab-${job.id}`}
                  className="workspace-session-shell"
                  hidden={!active}
                  id={`workspace-panel-${job.id}`}
                  key={job.id}
                  role="tabpanel"
                >
                  <SessionWorkspace
                    // Task #124: keyed by JOB id (not agent id) so every
                    // crew-click / tab switch is a fresh mount even when the
                    // runner reuses the same agent slot for a different
                    // dispatch — initialSection="timeline" then reliably lands
                    // on the live stream each time, the same way ChatView
                    // remounts fresh per chat above. Rendering one pane PER JOB
                    // keeps that property by construction: no instance is ever
                    // reused across jobs, so the takeover latch inside it can
                    // never describe a different job's door.
                    key={job.id}
                    agent={sessionAgentForJob(job)}
                    events={chatScope.auditEvents}
                    job={job}
                    hidden={!active}
                    onTakeoverOpenChange={(open) =>
                      setJobTakeoverOpen(job.id, open)
                    }
                    readiness={state?.readiness ?? null}
                    // A `loop` job stays "Working" across every iteration; the
                    // header uses these to name the iteration and what the last
                    // one concluded instead of implying a stalled agent.
                    loopRuns={state?.loopRuns ?? []}
                    // Wave 4.1: the fail-closed gate for this agent surfaces AT the
                    // tab; "Review & decide" opens the same governed dialog the rail
                    // uses (focusApprovalId), never a second resolve path.
                    approvals={chatScope.approvals}
                    // P0-1: with standing consent on, a gate MUON is about to
                    // grant must not wear the fail-closed "you are blocking me"
                    // copy — and the reverse: only an id main's approver tick
                    // POSITIVELY covers may wear the calm one.
                    fullAuto={(state?.fullAutoVendors?.length ?? 0) > 0}
                    fullAutoCoveredApprovalIds={
                      state?.fullAutoCoveredApprovalIds ?? []
                    }
                    fullAutoUncoveredApprovalIds={
                      state?.fullAutoUncoveredApprovalIds ?? []
                    }
                    onReviewApproval={(approvalId) =>
                      setFocusedApprovalId(approvalId)
                    }
                    // The inline gate decides through the SAME governed resolve
                    // the dock rail uses — one consent site, never a second one.
                    onResolveApproval={onResolveApproval}
                    onOpenBrain={() => openPanelTab("evidence")}
                    // When the real vendor pty is on (MUON_REAL_PTY=1), land the
                    // operator on the live interactive TERMINAL, not the audit
                    // Timeline (the "streaming" view). Echo mode keeps Timeline.
                    initialSection={state?.realPty ? "terminal" : "timeline"}
                    // Task #125: every subagent tab exposes a live Terminal
                    // section — the echo driver today, the real vendor pty when
                    // MUON_REAL_PTY is enabled — so the operator can watch what
                    // the subagent is actually doing.
                    terminalPreview={true}
                    taskTitle={taskTitles.get(job.taskId) ?? job.taskId}
                    onClose={() => {
                      // Closing the TAB is the deliberate teardown, and it is
                      // what reaps the takeover ptys too: the host sweeps every
                      // `.resume`/`.fork` sibling from this plain coordinate.
                      void window.muon.terminal.close?.(`terminal-${job.id}`);
                      setJobTakeoverOpen(job.id, false);
                      storeRef.current?.closeTab(job.id);
                      storeRef.current?.closePane(job.id);
                      setActiveWorkspaceTab("chat");
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : activePanelTab === "crew" ? (
          <div className="workspace-panel-shell" role="tabpanel">
            <CrewPanel
              state={state}
              taskTitles={taskTitles}
              missionEvents={[]}
              activeChatId={effectiveChatId}
              fleetError={fleetError}
              onSaveCrewConfig={onSaveCrewConfig}
              onRecheckReadiness={() => void onRecheckReadiness()}
              readinessRefreshing={readinessRefreshing}
              readinessRefreshError={readinessRefreshError}
              onStepFleet={(vendor, delta) => void onStepFleet(vendor, delta)}
              onOpenAgent={openAgentPane}
              modelResolutions={modelResolutions}
              modelResolvingByVendor={modelResolvingByVendor}
              onRequestModelResolution={onRequestModelResolution}
            />
          </div>
        ) : activePanelTab === "settings" ? (
          <div className="workspace-panel-shell" role="tabpanel">
            <SettingsPanel
              state={state}
              runnerDetail={runnerNotice?.text}
              onRecheckReadiness={() => void onRecheckReadiness()}
              readinessRefreshing={readinessRefreshing}
              readinessRefreshError={readinessRefreshError}
              onSaveSettings={onSaveSettings}
              onStartGitHub={onStartGitHub}
              onPollGitHub={onPollGitHub}
              onDisconnectGitHub={onDisconnectGitHub}
              onOpenGitHubUrl={onOpenGitHubUrl}
              updateStatus={updateStatus}
              onCheckUpdates={onCheckUpdates}
              onToggleAutoUpdate={onToggleAutoUpdate}
              onToggleAutoContinue={(enabled) => void onToggleAutoContinue(enabled)}
              onToggleTelemetry={(enabled) => void onToggleTelemetry(enabled)}
              onTogglePortPreview={(enabled) => void onTogglePortPreview(enabled)}
              onPauseCommitment={onPauseCommitment}
              onResumeCommitment={onResumeCommitment}
              onDownloadUpdate={onDownloadUpdate}
              onInstallUpdate={onInstallUpdate}
              mcpStatus={mcpStatus}
              mcpStatusLoading={mcpStatusLoading}
              mcpStatusError={mcpStatusError}
              onRefreshMcpStatus={() => void onRefreshMcpStatus()}
              onProbeMcp={onProbeMcp}
              onInstallMcp={onInstallMcp}
              mcpAttachedByVendor={mcpAttachedByVendor}
              onAttachMcp={onAttachMcp}
              onDetachMcp={onDetachMcp}
            />
          </div>
        ) : (
          <div className="center-empty">
            <span className={state === null ? "loading-line" : undefined}>
              {state === null
                ? "Connecting…"
                : state.online
                  ? "Pick a chat or start a new one."
                  : ""}
            </span>
            {state?.online ? (
              <button className="ghost-btn" onClick={() => void newChat()}>
                + New chat
              </button>
            ) : null}
          </div>
        )}

        {panesOpen && streamAgents.length > 0 ? (
          <AgentPanes
            key={activeChat?.id ?? "no-chat"}
            agents={streamAgents}
            defaultOpen={paneAgents.length > 0}
            taskTitles={taskTitles}
            onOpen={openAgentPane}
            onClose={(jobId) => {
              if (jobId) {
                storeRef.current?.closePane(jobId);
              }
            }}
          />
        ) : null}
      </main>

      {/* E3: kept mounted (was `{dockSection ? <aside>…</aside> : null}`) so
          the grid's --dock-w → 0 transition can animate the close too, not
          just the open. Content stays pinned to the last panel shown
          (renderedDockPanel/renderedDockSection) while it's collapsing, and
          the whole dock is `inert` while closed — never reachable by
          keyboard/AT, never a hidden duplicate of "Open memory" etc. */}
      <aside
        className={"context-dock" + (dockSection ? "" : " context-dock-collapsed")}
        aria-label={`${renderedDockPanel ?? "context"} panel`}
        inert={dockSection ? undefined : true}
      >
        <Splitter
          label="Resize panel"
          value={dockWidth.width}
          min={dockWidth.min}
          max={dockWidth.max}
          sign={-1}
          onChange={dockWidth.setWidth}
          className="dock-splitter"
        />
        <button
          className="dock-close"
          type="button"
          aria-label="Close panel"
          onClick={layout.closePanel}
        >
          <IconClose size={14} />
        </button>
        {renderedDockPanel === "control" ? (
          <RightPanel
            activeTab={controlDockTab}
            onTabChange={setControlDockTab}
            workspacePath={dockWorkspacePath}
            workspaceReview={dockWorkspaceReview}
            loading={dockWorkspaceReviewLoading}
            ship={{
              target: dockShipTarget,
              onShip: onShipDispatch,
              outcome: dockShipOutcome,
            }}
            reviewLocked={Boolean(focusedApproval)}
            githubConnected={state?.github?.connected ?? false}
            githubPublicationKey={dockReviewJob?.id}
            githubReview={githubReview}
            githubReviewLoading={githubReviewLoading}
            onRefreshGitHubReview={() =>
              setGitHubReviewRefresh((current) => current + 1)
            }
            onOpenGitHubUrl={(url) => void onOpenGitHubUrl(url)}
            onCreateGitHubPullRequest={onCreateGitHubPullRequest}
            onMergeGitHubPullRequest={onMergeGitHubPullRequest}
            reviewContent={
              <>
                {/* ADR-0043's operator half: agents' blocking questions,
                    FIRST — a blocked agent outranks every other read here. */}
                <QuestionsInbox
                  questions={state?.questions ?? []}
                  truncated={state?.questionsTruncated ?? false}
                  unavailable={state?.questionsUnavailable ?? false}
                  activeTaskIds={activeChatTaskIds}
                  onAnswer={(input) => window.muon.answerQuestion(input)}
                />
                {/* The session's WRAP (parity item 3): what this mission
                    produced, with MUON's own trust classification leading. */}
                <HandoffPanel taskId={activeTaskId ?? null} />
                {/* "Why this dispatch" + "Reconnaissance" remain part of the
                    Control surface, now inside Review above the unchanged
                    ControlRail approval path. */}
                <details className="dock-collapsible" open>
                  <summary>Why this dispatch</summary>
                  <LiveDispatchHero
                    taskId={activeTaskId}
                    onOpenBrain={() => openPanelTab("evidence")}
                  />
                </details>
                {activeChat ? (
                  <details className="dock-collapsible" open>
                    <summary>Reconnaissance</summary>
                    <ReconCard />
                  </details>
                ) : null}
                <ControlRail {...controlRailProps} sections={["review"]} />
              </>
            }
          />
        ) : (
          <ControlRail
            {...controlRailProps}
            sections={renderedDockSection ? [renderedDockSection] : []}
          />
        )}
      </aside>

      {showOnboarding && (
        <Onboarding
          readiness={readiness}
          readinessMeta={state?.readinessMeta}
          onRunFirstTask={onRunFirstTask}
          onRecheck={onRecheckReadiness}
          recheckError={readinessRefreshError}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={(() => {
          // Approve/deny target = the focused approval, else — ONLY when it
          // is the single pending one — that approval. With 2+ pending and
          // none focused, resolvePaletteApprovalTarget refuses to guess: it
          // returns a null target, which disables (and CommandPalette then
          // hides) the blanket approve/reject entries below, so the palette
          // can never silently act on an arbitrary pending approval. Every
          // entry maps to an existing App handler (no new IPC). No kbd hints
          // on approve/reject: 'a'/'r' type into the palette's own filter
          // while it is open, so a badge implying a palette-level shortcut
          // would be misleading (the real single-key shortcuts live inside
          // the approval review dialog itself).
          const approvals = chatScope.approvals;
          const target = resolvePaletteApprovalTarget(
            approvals,
            focusedApproval ?? null
          );
          const pending = target.approval;
          return [
            {
              id: "toggle-desk-theme",
              label:
                deskTheme === "light"
                  ? "Switch to dark desk"
                  : "Switch to light desk",
              run: toggleDeskTheme,
            },
            {
              id: "approve",
              label: "Approve pending action",
              disabled: !pending,
              run: () =>
                pending &&
                void onResolveApproval(pending.id, "approved").catch(
                  () => undefined
                ),
            },
            {
              id: "reject",
              label: "Reject pending action",
              disabled: !pending,
              run: () =>
                pending &&
                void onResolveApproval(pending.id, "rejected").catch(
                  () => undefined
                ),
            },
            {
              id: "review",
              label: target.ambiguous
                ? `Review pending approvals (${approvals.length})`
                : "Review pending approval",
              disabled: approvals.length === 0,
              run: () => {
                const openTarget = pending ?? approvals[0] ?? null;
                if (openTarget) setFocusedApprovalId(openTarget.id);
              },
            },
            {
              id: "fullauto",
              // Keyed on ANY armed lane: with a subset selected, "Turn ON"
              // would read as "currently off" and clicking it would silently
              // WIDEN the subset to every lane. Armed → the palette only ever
              // narrows (clear all lanes).
              label:
                (state?.fullAutoVendors?.length ?? 0) > 0
                  ? "Turn auto-approve OFF"
                  : "Turn auto-approve ON (safety gates off)",
              run: () =>
                void onToggleFullAuto(
                  (state?.fullAutoVendors?.length ?? 0) === 0
                ),
            },
            {
              // Relocated from the Workspaces row, where it sat beside the
              // row's own "switch to this chat" target. Stopping ONE chat's
              // jobs must stay reachable — the only other stops are the
              // composer's (root job only) and the titlebar's Stop-all
              // (everything, everywhere) — but it should cost a deliberate
              // action, not a near-miss.
              id: "stopchat",
              label: "Stop this chat's jobs",
              disabled: !effectiveChatId || cancellingChatId !== null,
              run: () => {
                if (effectiveChatId) void onCancelChat(effectiveChatId);
              },
            },
            { id: "newchat", label: "New chat", run: () => void newChat() },
            {
              id: "memory",
              label: "Open memory",
              run: () => openPanelTab("memory"),
            },
            {
              id: "context",
              label: "Open pre-edit context",
              run: () => openPanelTab("evidence"),
            },
            {
              id: "graph",
              label: "Open knowledge graph",
              disabled: activeGitNexusStatus?.status !== "ready",
              run: () => openPanelTab("graph"),
            },
            {
              id: "terminal",
              label: "Open terminal",
              disabled: !activeChat,
              run: () => focusOrOpenShellTab(),
            },
            // One palette entry per spawnable vendor CLI — the same registry
            // + readiness gate as the strip's vendor bar, one click to the
            // vendor's real interactive session.
            ...terminalVendorMenu
              .filter((entry) => entry.kind !== SHELL_TERMINAL_KIND)
              .map((entry) => ({
                id: `terminal-${entry.kind}`,
                label: `Open ${entry.label} session`,
                disabled: !activeChat || !entry.enabled,
                run: () => openHumanTerminal(entry.kind),
              })),
            {
              id: "settings",
              label: "Open settings",
              run: () => onNavigate("settings"),
            },
            {
              id: "crew",
              label: "Open crew",
              run: () => onNavigate("crew"),
            },
            {
              id: "topology",
              label: "Open crew topology",
              disabled: !activeChat,
              run: () => onNavigate("topology"),
            },
            {
              id: "cancelchat",
              label: "Stop this chat's tasks",
              disabled: !effectiveChatId || activeChatActiveJobs === 0,
              run: () => {
                if (effectiveChatId) {
                  void onCancelChat(effectiveChatId);
                }
              },
            },
            {
              id: "stopall",
              label: "Stop all tasks",
              disabled: !anyJobRunning,
              run: () => void onStopAll(),
            },
          ];
        })()}
      />
    </div>
  );
}
