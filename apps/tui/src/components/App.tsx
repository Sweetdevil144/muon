import { describeRunFailure } from "../lib/run-dispatcher.js";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMemoryDecision,
  QUICKSTART_SAMPLE,
  REMEMBER_ACTION_INELIGIBLE_SENTENCE,
  REMEMBER_ACTION_TTL_MS,
  buildApprovalReview,
  buildBudgetLineView,
  buildDispatchForest,
  buildOnboardingState,
  deriveAutoContext,
  fetchProposalNote,
  loadPreEditView,
  parseEditTarget,
  pickQuickstartVendor,
  pollFailBudgetLine,
  resolveProposal,
  resolveAgentToken,
  unknownBudgetLine,
  terminalSafe,
} from "@muon/client";
import type {
  AgentRecord,
  ApprovalRequest,
  BudgetLineView,
  LaneSession,
  MemoryNote,
  OrchestratorChatRecord,
  ReviewCoverageCertification,
  PreEditTargetInput,
  PreEditView,
  RecordedEvent,
  StreamChunk,
  Task,
  TaskDetail,
  WorkflowRunRecord,
} from "@muon/client";
import { runChatTurn, CHAT_LANE_KEY } from "@muon/orchestrator";
import {
  heuristicWorkflowProposal,
} from "@muon/core";
import {
  buildActionForm,
  executeAction,
  resolveApprovalAction,
  type ActionForm,
} from "../lib/actions.js";
import type { BrainStore } from "../lib/brain-store.js";
import { loadCrewPanel, type CrewPanelLoad } from "../lib/crew-view.js";
import {
  attachMcpCoordinatorInTui,
  detachMcpCoordinatorInTui,
  loadMcpPanel,
  type McpPanelLoad,
} from "../lib/mcp-view.js";
import { buildLaneColumns } from "../lib/lane-columns.js";
import { parseCommandBarInput } from "../lib/command-bar.js";
import { stopAllDispatches } from "../lib/cockpit-actions.js";
import { executeWorkflowInTui } from "../lib/workflow-executor.js";
import {
  activateTabByOrdinal,
  activeTab,
  closeTab,
  cycleTab,
  deskTabId,
  initialDeskTabs,
  openTab,
  type DeskTabsState,
} from "../lib/desk-tabs.js";
import { sortByAttention, wantsOperator } from "../lib/attention.js";
import {
  appendChunks,
  bufferFor,
  pruneBuffers,
  type StreamBuffers,
} from "../lib/stream-buffers.js";
import { attentionByAgent, markLaneSeen } from "../lib/lane-attention.js";
import { TabStrip } from "./TabStrip.js";
import { RailCollapsed } from "./RailCollapsed.js";
import { KeymapHelp } from "./KeymapHelp.js";
import {
  nextFocusZone,
  resolveLayoutMode,
  resolveRowBudget,
  type FocusZone,
} from "../lib/layout.js";
import { hub, statusTone } from "../lib/theme.js";
import { buildPaletteCommands, filterPaletteCommands } from "../lib/palette.js";
import {
  buildVendorActionMenu,
  normalizeVendorAlias,
  resolveVendorAction,
  validateModelForVendor,
  type VendorKey,
} from "@muon/core";
import { dispatchRun } from "../lib/run-dispatcher.js";
import { startTuiSession, type TuiSession } from "../lib/session-controller.js";
import { runShipReview } from "../lib/ship.js";
import { latestOwnedByHuman, latestTakeOver } from "../lib/take-over.js";
import { editText, isTextEdit } from "../lib/text-input.js";
import {
  DISPATCHED_ACTIONS,
  resolveKeyAction,
  type KeyScope,
} from "../lib/key-dispatch.js";
import { useBrainStore } from "../hooks/use-brain-store.js";
import { AgentStreamOverlay } from "./AgentStreamOverlay.js";
import { ApprovalReviewOverlay } from "./ApprovalReviewOverlay.js";
import { ChatPane, type ChatMessage } from "./ChatPane.js";
import { Rule } from "./chrome.js";
import {
  DiagnosticsPanel,
  DispatchHero,
  ReviewInbox,
  buildDispatchSummary,
} from "./CockpitPanels.js";
import { CommandBar } from "./CommandBar.js";
import { CommandPalette } from "./CommandPalette.js";
import { CrewPanel, CREW_MESSAGE_WINDOW } from "./CrewPanel.js";
import { McpPanel, MCP_VENDOR_WINDOW } from "./McpPanel.js";
import { FleetRail } from "./FleetRail.js";
import { LaneDesk } from "./LaneDesk.js";
import { Footer } from "./Footer.js";
import { FormPrompt } from "./FormPrompt.js";
import { BrainPanel } from "./BrainPanel.js";
import { HandoffsPanel } from "./HandoffsPanel.js";
import { Header } from "./Header.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { MissionBudgetLine } from "./MissionBudgetLine.js";
import { MissionBudgetOverlay } from "./MissionBudgetOverlay.js";
import { OnboardingPanel } from "./OnboardingPanel.js";
import { TaskDetailOverlay } from "./TaskDetailOverlay.js";
import { TaskLedger } from "./TaskLedger.js";
import { WorkflowPanel } from "./WorkflowPanel.js";

type Props = {
  store: BrainStore;
  /** Override terminal width in tests. */
  widthOverride?: number;
};

type FormState = {
  form: ActionForm;
  values: Record<string, string>;
  fieldIndex: number;
  error: string | null;
  busy: boolean;
  hint?: string;
};

export function App({ store, widthOverride }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const snapshot = useBrainStore(store);

  const [focus, setFocus] = useState<FocusZone>("tasks");
  const [taskIndex, setTaskIndex] = useState(0);
  // ADR-0032 D5, applied to the crew rail. Selection is bound to the AGENT,
  // not to a row number: the rail reorders whenever a lane's attention changes
  // (a peer going blocked sorts to the top), and a numeric cursor would silently
  // move onto whichever agent inherited that row — so `s`, Enter and `b` would
  // act on someone the operator did not choose. Null means "nothing selected
  // yet"; the derived index below falls back to the top row.
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [approvalReview, setApprovalReview] =
    useState<ApprovalRequest | null>(null);
  const [approvalReviewCertification, setApprovalReviewCertification] =
    useState<ReviewCoverageCertification | null>(null);
  const [approvalReviewError, setApprovalReviewError] = useState<string | null>(
    null
  );
  const [approvalResolving, setApprovalResolving] = useState(false);
  const approvalReviewLoadVersion = useRef(0);
  const [handoffIndex, setHandoffIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [formState, setFormState] = useState<FormState | null>(null);
  // First-run guidance: the cockpit opens with the front door signposted.
  const [statusLine, setStatusLine] = useState<string | null>(
    'press / and tell the crew what to do, e.g. "fix the failing login test" · Ctrl+K for every command'
  );
  const [memoryView, setMemoryView] = useState<{
    title: string;
    /** The exact query that produced `notes`, kept so the R3 expired toggle can
     *  re-ask the SAME governed search instead of filtering locally. */
    query: string;
    notes: MemoryNote[];
    /** R3 TTL posture of this result set. OFF by default — cross-surface parity
     *  with the desktop toggle and `muon memory search`. */
    showExpired: boolean;
    /** ADR-0026 §9: the workspace this result set was fenced to. Carried on the
     *  view rather than re-read at render time, so the label can never describe a
     *  partition other than the one that produced these notes. */
    workspacePath: string;
  } | null>(null);
  const [memoryNoteIndex, setMemoryNoteIndex] = useState(0);
  const [memoryBusy, setMemoryBusy] = useState(false);
  // The operator's crew-visible posture, for the SHARED memory tier rule
  // (memoryNoteTier). Strict (false) until read; strict on any failure — a
  // note is never described as MORE settled than the rule allows.
  const [autoConfirmAgentMemory, setAutoConfirmAgentMemory] = useState(false);
  useEffect(() => {
    let stopped = false;
    void Promise.resolve()
      .then(() => store.client.getAutoConfirmAgentMemory())
      .then((enabled) => {
        if (!stopped) setAutoConfirmAgentMemory(Boolean(enabled));
      })
      .catch(() => {
        /* strict on failure */
      });
    return () => {
      stopped = true;
    };
  }, [store]);
  // Single-flight fence: a toggle flap must not let an older response repaint a
  // newer posture (the EXPIRED markers and the footer hint are derived from the
  // pair, so a crossed response would misreport what is on screen).
  const memorySearchVersion = useRef(0);
  /** Last time this terminal told the brain a human is here (ADR-0040 D3a). */
  const lastPresenceRef = useRef(0);
  // P6a, the pre-edit ("Brain") panel: the fused view + what target produced it
  // (for refresh), the selected proposal, and any proposal text fetched on demand.
  const [brainView, setBrainView] = useState<PreEditView | null>(null);
  const [brainTarget, setBrainTarget] = useState<string | null>(null);
  // The exact input that produced the current view (a manual target OR the
  // active task's auto-context), used to REFRESH after an adjudication.
  const [brainInput, setBrainInput] = useState<PreEditTargetInput | null>(null);
  const [brainProposalIndex, setBrainProposalIndex] = useState(0);
  const [brainProposalText, setBrainProposalText] = useState<
    Record<string, string | undefined>
  >({});
  const [brainBusy, setBrainBusy] = useState(false);
  // CREW, the read-only roles + A2A coordination panel for the ONE selected
  // chat. `crewChatId` is captured when the panel opens and every refresh
  // re-reads THAT chat, so the view can never drift onto another one.
  const [crewOpen, setCrewOpen] = useState(false);
  const [crewChatId, setCrewChatId] = useState<string | null>(null);
  const [crewLoad, setCrewLoad] = useState<CrewPanelLoad | null>(null);
  const [crewBusy, setCrewBusy] = useState(false);
  const [crewMessageIndex, setCrewMessageIndex] = useState(0);
  // MCP, the read-only "what would a vendor CLI I start MYSELF get" panel (S1
  // of docs/design/cc-as-superagent-delivery.md §5). Machine-scoped, not
  // chat-scoped: it reads each vendor's own MCP config plus this shell's env,
  // so unlike CREW it has nothing to fail closed against.
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpLoad, setMcpLoad] = useState<McpPanelLoad>({ status: "loading" });
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpVendorIndex, setMcpVendorIndex] = useState(0);
  const [taskDetailView, setTaskDetailView] = useState<{
    detail: TaskDetail;
    events: RecordedEvent[];
    memory: MemoryNote[];
    sessions: LaneSession[];
  } | null>(null);
  const [liveEvents, setLiveEvents] = useState<RecordedEvent[]>([]);
  const [workflowView, setWorkflowView] = useState<{
    runs: WorkflowRunRecord[];
  } | null>(null);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [commandValue, setCommandValue] = useState("");
  const [commandFocused, setCommandFocused] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [proposalCount, setProposalCount] = useState(0);
  const [quickstartCompleted, setQuickstartCompleted] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStreaming, setChatStreaming] = useState("");
  const [agentView, setAgentView] = useState<AgentRecord | null>(null);
  // ADR-0032 D2 — retained per-agent stream buffers (see lib/stream-buffers.ts).
  const [streamBuffers, setStreamBuffers] = useState<StreamBuffers>({});
  // S9 TUI parity: the active mission root's budget (numbers/enums only, no
  // raise affordance). unknownBudgetLine() until the first resolve lands —
  // never a fabricated ready read.
  const [missionBudget, setMissionBudget] = useState<BudgetLineView>(
    unknownBudgetLine()
  );
  const [budgetOverlayOpen, setBudgetOverlayOpen] = useState(false);
  // ADR-0032 D2/D6 — the center tab list and the `?` overlay's filter. Tabs are
  // the only navigation state; nothing about switching them touches the panels
  // above, which is the whole point of the model.
  const [deskTabs, setDeskTabs] = useState<DeskTabsState>(initialDeskTabs);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpQuery, setHelpQuery] = useState("");
  // ADR-0032 D3 — lanes the operator has looked at since they last changed.
  // Keyed by agent id; only ever CLEARS a completion state (`resolveAttentionState`
  // enforces that), so marking something seen can never dismiss a pending gate.
  const [seenLanes, setSeenLanes] = useState<Record<string, string>>({});
  const chatRef = useRef<OrchestratorChatRecord | null>(null);
  // S10: the chat-level default model set via `/model <id>`. Stashed here and
  // threaded onto the next orchestrator turn's dispatch (the route re-validates
  // it fail-closed). Undefined → today's behavior (the lane's stored model).
  const chatModelRef = useRef<string | undefined>(undefined);
  // Cursor mirror so a poll resumes without waiting for the state round trip.
  const streamCursorRef = useRef<Record<string, number>>({});
  const runningRef = useRef(false);
  const activeSessionRef = useRef<TuiSession | null>(null);
  const brainIntentEpochRef = useRef(0);
  const brainDecisionInFlightRef = useRef(false);
  const crewEpochRef = useRef(0);
  const mcpEpochRef = useRef(0);

  const width = widthOverride ?? stdout?.columns ?? 120;
  const layoutMode = resolveLayoutMode(width);
  const height = stdout?.rows ?? 40;
  const budget = resolveRowBudget(height);

  // ADR-0032 D3/D4 — one derivation feeding the rail, the tab strip and the
  // NEEDS YOU scalar, so those three can never disagree about who is blocked.
  const laneAttention = useMemo(
    () => attentionByAgent(snapshot.agents, snapshot.dispatchJobs, seenLanes),
    [snapshot.agents, snapshot.dispatchJobs, seenLanes]
  );
  // The rail's order: most-demanding lane first, stable within a priority so a
  // poll refresh never shuffles rows under the operator's cursor.
  //
  // This is ONE list, and `laneIndex` indexes it — never `snapshot.agents`.
  // Rendering from a sorted list while resolving the selection from an unsorted
  // one is precisely how `s` stops the wrong lane (the D5 hazard, applied to
  // the crew instead of to approvals).
  const railAgents = useMemo(
    () =>
      sortByAttention(
        snapshot.agents,
        (agent) => laneAttention[agent.id] ?? "unknown"
      ),
    [snapshot.agents, laneAttention]
  );
  // The cursor follows the agent through a reorder. An agent that left the
  // fleet falls back to the top row rather than to a stale position.
  const laneIndex = useMemo(() => {
    if (!selectedLaneId) return 0;
    const found = railAgents.findIndex(
      (agent) => agent.id === selectedLaneId
    );
    return found >= 0 ? found : 0;
  }, [railAgents, selectedLaneId]);
  const setLaneIndex = (next: number | ((current: number) => number)) => {
    const target = typeof next === "function" ? next(laneIndex) : next;
    const clamped = Math.min(Math.max(target, 0), Math.max(railAgents.length - 1, 0));
    setSelectedLaneId(railAgents[clamped]?.id ?? null);
  };

  useEffect(() => {
    let canceled = false;
    void store.client
      .listWorkflowRuns({ status: "proposed" })
      .then((runs) => {
        if (!canceled) setProposalCount(runs.length);
      })
      .catch(() => {
        // Keep the LAST KNOWN count: fabricating 0 on a fetch failure
        // silently under-reports NEEDS YOUR DECISION (the store deliberately
        // avoids exactly this for receipts).
      });
    return () => {
      canceled = true;
    };
  }, [snapshot.updatedAt, store.client]);

  // Resume the most recent chat for this folder so the TUI reopens where
  // you left off (like reopening a project in a coding-agent app).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chats = await store.client.listChats();
        const existing = chats.find(
          (chat) =>
            chat.status === "active" && chat.workspacePath === process.cwd()
        );
        if (!existing || cancelled) {
          return;
        }
        chatRef.current = existing;
        const history = await store.client.listStreamChunks({
          taskId: existing.id,
          limit: 200,
          latest: true,
        });
        if (cancelled) {
          return;
        }
        setChatMessages(
          history.map((chunk) =>
            chunk.kind === "user.message" &&
            chunk.laneId === "muon-chat" &&
            chunk.content.startsWith("[you] ")
              ? { role: "you", text: chunk.content.slice(6) }
              : chunk.kind === "milestone" || chunk.kind === "activity"
                ? { role: "status", text: chunk.content }
                : { role: "muon", text: chunk.content }
          )
        );
      } catch {
        // brain offline, chat starts fresh once it is back
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retention is bounded two ways: `appendChunks` caps each buffer, and a lane
  // that leaves the fleet drops its buffer entirely. Without this a long
  // session keeps the scrollback of every lane it ever watched.
  useEffect(() => {
    const live = snapshot.agents.map((agent) => agent.id);
    setStreamBuffers((current) => {
      const pruned = pruneBuffers(current, live);
      if (pruned === current) return current;
      for (const subject of Object.keys(streamCursorRef.current)) {
        if (!live.includes(subject)) delete streamCursorRef.current[subject];
      }
      return pruned;
    });
    // …and close the view if the agent it is showing has left the fleet.
    //
    // Pruning the buffer while RETAINING `agentView` left the overlay open on
    // a departed lane and, worse, left the 2s poll below querying it forever —
    // it keys off `agentView`, not off the fleet. The operator saw a frozen
    // stream for an agent that no longer exists and had to close it by hand to
    // stop the traffic.
    setAgentView((current) =>
      current && !live.includes(current.id) ? null : current
    );
  }, [snapshot.agents]);

  // Live tail for the agent focus view.
  //
  // ADR-0032 D2: the buffer and cursor are RETAINED per agent, so closing a
  // stream and reopening it resumes where it left off instead of refetching
  // from seq 0 and replacing what was on screen. `appendChunks` drops anything
  // at or below the retained cursor, which is also what makes an overlapping
  // poll unable to duplicate or reorder chunks.
  useEffect(() => {
    const subject = agentView?.id;
    if (!subject) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        // Previous poll still running; skip this tick.
        return;
      }
      inFlight = true;
      try {
        const chunks = await store.client.listStreamChunks({
          agentId: subject,
          afterSeq: streamCursorRef.current[subject] ?? 0,
          limit: 200,
        });
        if (cancelled) {
          return;
        }
        setStreamBuffers((current) => {
          const next = appendChunks(current, subject, chunks);
          // Mirror the cursor into a ref so the NEXT poll resumes correctly
          // without waiting for the state round trip.
          streamCursorRef.current[subject] = bufferFor(next, subject).cursor;
          return next;
        });
      } catch {
        // keep polling
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentView?.id]);

  const columns = useMemo(
    () =>
      buildLaneColumns(snapshot.lanes, snapshot.tasks, [
        ...liveEvents,
        ...snapshot.events,
      ]),
    [snapshot.lanes, snapshot.tasks, snapshot.events, liveEvents]
  );

  const paletteResults = useMemo(
    () => filterPaletteCommands(paletteQuery, buildPaletteCommands(snapshot.readiness)),
    [paletteQuery, snapshot.readiness]
  );

  const pendingApprovals = snapshot.approvals.filter(
    (approval) => approval.status === "pending"
  );

  const selectedTask = snapshot.tasks[taskIndex];
  const selectedAgent = railAgents[laneIndex];
  const selectedLane =
    snapshot.lanes.find((lane) => lane.key === selectedAgent?.vendor) ??
    columns[laneIndex]?.lane;

  // S9 TUI parity (item 3, v0-gap-analysis §4): project the active mission
  // root's budget from the SAME `GET /api/dispatch/:jobId/budget` contract
  // desktop's MissionBudgetControl reads, through the shared
  // buildBudgetLineView projection — never a divergent local derivation.
  // Read-only: no raise call ever happens here. A poll failure REPLACES the
  // view outright (pollFailBudgetLine), never leaving stale ready numbers on
  // screen; no selected task / no dispatch lineage yet is the honest
  // "unknown" state, not a guessed "ready".
  useEffect(() => {
    let cancelled = false;
    const task = selectedTask;
    if (!task) {
      setMissionBudget(unknownBudgetLine());
      return () => {
        cancelled = true;
      };
    }
    void store.client
      .listDispatchJobs({ taskId: task.id })
      .then((jobs) => {
        if (cancelled) return undefined;
        const root = buildDispatchForest(jobs).missions[0]?.root;
        if (!root) {
          setMissionBudget(unknownBudgetLine());
          return undefined;
        }
        return store.client.getDispatchBudget(root.id).then((budget) => {
          if (!cancelled) {
            setMissionBudget(buildBudgetLineView(budget));
          }
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMissionBudget(
            pollFailBudgetLine(
              error instanceof Error ? error.message : "budget unavailable"
            )
          );
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id, snapshot.updatedAt]);

  const openForm = (commandId: string) => {
    const form = buildActionForm(commandId, { selectedTask, selectedLane });
    if (!form) {
      return false;
    }
    const values: Record<string, string> = {};
    for (const field of form.fields) {
      if (field.prefill) {
        values[field.id] = field.prefill;
      }
    }
    setFormState({ form, values, fieldIndex: 0, error: null, busy: false });
    setPaletteOpen(false);

    // Routing intelligence: recommend a lane while assigning/running.
    // Recommendation only, the human still fills in the lane key.
    if (commandId === "assign" || commandId === "run") {
      void store.client
        .suggestLanes(selectedTask?.id ?? "task")
        .then((suggestions) => {
          const top = suggestions[0];
          if (!top) {
            return;
          }
          setFormState((current) =>
            current && current.form.commandId === commandId
              ? {
                  ...current,
                  hint: `suggested lane: ${top.laneKey}, ${top.reason}`,
                }
              : current
          );
        })
        .catch(() => undefined);
    }
    return true;
  };

  const finishAction = (message: string, ok: boolean) => {
    setFormState(null);
    setStatusLine(`${ok ? "✓" : "✗"} ${message}`);
    void store.refresh();
  };

  const openWorkflowPanel = async (selectRunId?: string) => {
    const runs = await store.client.listWorkflowRuns();
    const index = selectRunId
      ? Math.max(
          0,
          runs.findIndex((run) => run.id === selectRunId)
        )
      : 0;
    setWorkflowIndex(index);
    setWorkflowView({ runs });
  };

  // P6a/P6, load (or refresh) the pre-edit ("Brain") panel. Uses the shared
  // loader over the OPERATOR client, so the TUI renders the same truth as the
  // desktop/CLI. Takes the resolved INPUT (a manual target OR the active task's
  // auto-context) + a display label. `keepProposalText` preserves fetched-on-
  // demand text across a refresh after an adjudication.
  const loadBrain = async (
    input: PreEditTargetInput,
    label: string,
    keepProposalText = false,
    intentEpoch?: number
  ): Promise<boolean> => {
    const epoch = intentEpoch ?? ++brainIntentEpochRef.current;
    if (epoch !== brainIntentEpochRef.current) {
      return false;
    }
    setBrainBusy(true);
    try {
      const view = await loadPreEditView(store.client, input);
      if (epoch !== brainIntentEpochRef.current) {
        return false;
      }
      setBrainInput(input);
      setBrainTarget(label);
      setBrainView(view);
      setBrainProposalIndex((index) =>
        Math.min(index, Math.max(view.pendingProposals.length - 1, 0))
      );
      if (!keepProposalText) {
        setBrainProposalText({});
      }
      return true;
    } catch (error) {
      if (epoch === brainIntentEpochRef.current) {
        throw error;
      }
      return false;
    } finally {
      if (epoch === brainIntentEpochRef.current) {
        setBrainBusy(false);
      }
    }
  };

  const closeBrain = () => {
    brainIntentEpochRef.current += 1;
    setBrainView(null);
    setBrainInput(null);
    setBrainTarget(null);
    setBrainProposalIndex(0);
    setBrainProposalText({});
    setBrainBusy(false);
  };

  // CREW, load (or refresh) roles + coordination for ONE chat through the same
  // operator-tier readers `muon crew roles` / `muon crew coord` use. Read-only:
  // nothing here writes a role binding. `loadCrewPanel` never rejects — each
  // half degrades to an honest reason — so a missing A2A route shows a one-line
  // explanation instead of blanking the cockpit.
  const refreshCrew = (chatId: string) => {
    const epoch = ++crewEpochRef.current;
    setCrewBusy(true);
    void loadCrewPanel({
      client: store.client,
      chatId,
      // The store's CURRENT pair, not a fresh resolve: with an explicit
      // --api-base the fresh resolve read the auto-discovered brain instead —
      // one panel labelled "crew for chat X" answered from two ledgers.
      apiBase: store.apiBase,
      apiToken: store.apiToken,
    })
      .then((load) => {
        if (epoch !== crewEpochRef.current) {
          return;
        }
        setCrewLoad(load);
        setCrewMessageIndex(0);
      })
      .catch((error: unknown) => {
        // Defensive: loadCrewPanel catches its own failures. A throw here is a
        // bug, so fail soft with both halves honestly unavailable.
        if (epoch !== crewEpochRef.current) {
          return;
        }
        const reason =
          error instanceof Error ? error.message : "crew view unavailable";
        setCrewLoad({
          chatId,
          roles: { status: "error", reason },
          coordination: { status: "unavailable", reason },
        });
      })
      .finally(() => {
        if (epoch === crewEpochRef.current) {
          setCrewBusy(false);
        }
      });
  };

  const openCrew = () => {
    const chat = chatRef.current;
    crewEpochRef.current += 1;
    setCrewOpen(true);
    setCrewLoad(null);
    setCrewMessageIndex(0);
    setCrewChatId(chat?.id ?? null);
    if (!chat) {
      // Fails closed outside a chat rather than showing another chat's crew.
      setCrewBusy(false);
      setStatusLine(
        "crew: no chat in this folder yet — press / and tell the crew what to do"
      );
      return;
    }
    setStatusLine(`… loading crew for chat ${chat.id}`);
    refreshCrew(chat.id);
  };

  const closeCrew = () => {
    crewEpochRef.current += 1;
    setCrewOpen(false);
    setCrewLoad(null);
    setCrewChatId(null);
    setCrewBusy(false);
    setCrewMessageIndex(0);
  };

  // MCP, read the ONE `McpStatusReport` that `muon mcp status` renders. No
  // vendor process is spawned and no brain is started — a surface that reports
  // whether a brain is running must not change that answer by rendering (§2.2
  // correction 8). `loadMcpPanel` never rejects; the catch below is defensive.
  const refreshMcp = () => {
    const epoch = ++mcpEpochRef.current;
    setMcpBusy(true);
    void loadMcpPanel()
      .then((load) => {
        if (epoch !== mcpEpochRef.current) {
          return;
        }
        setMcpLoad(load);
        setMcpVendorIndex(0);
      })
      .catch((error: unknown) => {
        if (epoch !== mcpEpochRef.current) {
          return;
        }
        setMcpLoad({
          status: "error",
          reason:
            error instanceof Error
              ? error.message
              : "could not read the MCP registration status",
        });
      })
      .finally(() => {
        if (epoch === mcpEpochRef.current) {
          setMcpBusy(false);
        }
      });
  };

  const openMcp = () => {
    setMcpOpen(true);
    setMcpLoad({ status: "loading" });
    setMcpVendorIndex(0);
    setStatusLine("… reading MCP registration status");
    refreshMcp();
  };

  const closeMcp = () => {
    mcpEpochRef.current += 1;
    setMcpOpen(false);
    setMcpLoad({ status: "loading" });
    setMcpBusy(false);
    setMcpVendorIndex(0);
  };

  // P6, hero AUTO-CONTEXT: open the Brain pre-filled from the CURRENT task's
  // touched modules/symbols (its recorded events + anchored memory), so the moat
  // surfaces automatically during a real dispatch, no manual target typing.
  // Returns false when nothing is derivable (no active task / nothing touched yet)
  // so the caller falls back to manual entry.
  const openBrainForTask = async (
    task: Task,
    intentEpoch: number
  ): Promise<boolean> => {
    const [events, memories] = await Promise.all([
      store.client.listTaskEvents(task.id).catch(() => []),
      store.client.recallRelatedToTask(task.id).catch(() => []),
    ]);
    if (intentEpoch !== brainIntentEpochRef.current) {
      return false;
    }
    const auto = deriveAutoContext({ events, memories, taskTitle: task.title });
    if (!auto) {
      return false;
    }
    setBrainProposalIndex(0);
    setBrainProposalText({});
    return loadBrain(auto.input, auto.label, false, intentEpoch);
  };

  // P6, turn a dispatch/run failure into a CLEAR, actionable status line: a
  // not-connected/auth failure points at the fix (onboarding); a real run failure
  // shows a sanitized reason + a retry hint. Never a raw dump, never a token.
  // Delegates to the SHARED decision (run-dispatcher.ts). This function used
  // to inline the classifier call, which meant it ignored the control-plane
  // stage tags entirely: a rejected status poll or a watch deadline — MUON's
  // failure, with the job often still running fine — rendered as "this vendor
  // isn't connected, go log in".
  const vendorFailStatus = (vendor: string, error: unknown): string =>
    describeRunFailure({ error, vendor, readiness: snapshot.readiness });

  // The command bar's plain-text path: a chat turn with the
  // super-orchestrator. It creates tasks, dispatches the fleet, and files
  // gates via its tools; gated actions land in the inbox on this screen.
  const submitInstruction = (request: string) => {
    setCommandBusy(true);
    setCommandValue("");
    setCommandFocused(false);
    setChatMessages((current) => [...current, { role: "you", text: request }]);
    void (async () => {
      chatRef.current ??= await store.client.createChat({
        workspacePath: process.cwd(),
      });
      const replyLines: string[] = [];
      const result = await runChatTurn({
        client: store.client,
        chat: chatRef.current,
        message: request,
        apiBase: store.apiBase,
        apiToken: resolveAgentToken(),
        // S10: apply the chat-level default model set via `/model` (if any).
        model: chatModelRef.current,
        onAssistantText: (text) => {
          replyLines.push(text);
          setChatStreaming(replyLines.join("\n"));
        },
        onStatus: (line) => {
          setChatMessages((current) => [
            ...current,
            { role: "status", text: line },
          ]);
        },
      });
      // Refresh the resumable session id for the next turn.
      chatRef.current = await store.client.getChat(chatRef.current.id);
      setChatStreaming("");
      // A failed turn shows its error, not a fake reply.
      if (result.exitCode !== 0) {
        setChatMessages((current) => [
          ...current,
          {
            role: "status",
            text: `✗ orchestrator turn failed: ${result.errorText ?? "unknown error"}`,
          },
        ]);
      } else {
        setChatMessages((current) => [
          ...current,
          {
            role: "muon",
            text: replyLines.join("\n") || "(no reply, check the inbox)",
          },
        ]);
      }
    })()
      .catch((error) => {
        setChatStreaming("");
        setChatMessages((current) => [
          ...current,
          {
            role: "status",
            text: `✗ ${error instanceof Error ? error.message : "chat turn failed"}`,
          },
        ]);
      })
      .finally(() => {
        setCommandBusy(false);
        void store.refresh();
      });
  };

  // Power path: /plan keeps the stored-proposal flow for template work.
  const submitProposal = (request: string) => {
    setCommandBusy(true);
    void (async () => {
      const proposal = heuristicWorkflowProposal(request);
      for (const step of proposal.steps) {
        if (step.role === "suggest" && !step.laneKey) {
          const suggestions = await store.client
            .suggestLanes(undefined, `${step.title} ${step.brief}`)
            .catch(() => []);
          const top = suggestions[0];
          if (top) {
            step.laneKey = top.laneKey;
            step.laneReason = top.reason;
          }
        }
      }
      const run = await store.client.createWorkflowRun({
        request,
        workspacePath: process.cwd(),
        proposal,
        proposedBy: "heuristic",
      });
      await openWorkflowPanel(run.id);
      setStatusLine(
        `✓ proposal ${run.id} stored, a apply · x apply + execute here`
      );
    })()
      .catch((error) => {
        setStatusLine(
          `✗ plan failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      })
      .finally(() => {
        setCommandBusy(false);
        setCommandValue("");
        setCommandFocused(false);
      });
  };

  // Runs an applied workflow inside the cockpit: steps dispatch locally,
  // events stream into lane columns, gates land in the inbox on screen.
  const executeWorkflowRun = (runId: string) => {
    if (runningRef.current) {
      setStatusLine("✗ a run is already active");
      return;
    }
    runningRef.current = true;
    setWorkflowView(null);
    setStatusLine(`▶ executing workflow ${runId}, gates land in the inbox`);
    void executeWorkflowInTui({
      client: store.client,
      runId,
      apiBase: store.apiBase,
      apiToken: resolveAgentToken(),
      onLiveEvent: (event) => {
        setLiveEvents((current) => [event, ...current].slice(0, 50));
      },
      onStatus: (line) => setStatusLine(line),
    })
      .then((outcome) => {
        setStatusLine(
          outcome.status === "done"
            ? `✓ workflow ${runId} done, steps: ${outcome.completedSteps.join(" → ")}`
            : `◐ workflow ${runId} paused at '${outcome.pausedAt}': ${outcome.reason}, resume from Workflow runs`
        );
      })
      .catch((error) => {
        setStatusLine(
          `✗ workflow failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      })
      .finally(() => {
        runningRef.current = false;
        setLiveEvents([]);
        void store.refresh();
      });
  };

  // P6, the guided first task from the cockpit: seed the SAFE, additive sample
  // task and dispatch it to a ready vendor IN-PROCESS (like `run`), so the fresh
  // user watches the whole loop stream into the lane columns without inventing a
  // task. No vendor ready → point at the GET STARTED panel (never a dead-end).
  const runQuickstart = () => {
    if (runningRef.current) {
      setStatusLine("✗ a run is already active");
      return;
    }
    const vendorKey = pickQuickstartVendor(snapshot.readiness);
    if (!vendorKey) {
      setStatusLine(
        "✗ connect a coding agent first, see the GET STARTED panel, then retry"
      );
      return;
    }
    const lane = snapshot.lanes.find((entry) => entry.key === vendorKey);
    if (!lane) {
      setStatusLine(
        `✗ no '${vendorKey}' lane, muon fleet set --${vendorKey} 1 first`
      );
      return;
    }
    runningRef.current = true;
    setStatusLine(`▶ quickstart: seeding your first task → ${lane.key}…`);
    void (async () => {
      const task = await store.client.createTask({
        title: QUICKSTART_SAMPLE.title,
        description: QUICKSTART_SAMPLE.description,
        priority: QUICKSTART_SAMPLE.priority,
        workspacePath: process.cwd(),
      });
      const result = await dispatchRun({
        client: store.client,
        lane,
        taskId: task.id,
        brief: QUICKSTART_SAMPLE.brief,
        cwd: process.cwd(),
        onLiveEvent: (event) => {
          setLiveEvents((current) => [event, ...current].slice(0, 50));
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(`quickstart vendor exited ${result.exitCode}`);
      }
      const memories = await store.client
        .recallRelatedToTask(task.id)
        .catch(() => [] as MemoryNote[]);
      const memory =
        memories[0] ??
        (await store.client.addMemoryNote({
          kind: "attempt",
          text: `MUON quickstart completed on ${lane.key}; the read-only repository summary ran and touched no files.`,
          taskId: task.id,
          laneId: lane.id,
          // BUG 1: the first task is strictly READ-ONLY — it writes nothing, so
          // the memory anchors to no module (topics only).
          modules: [],
          topics: ["quickstart", "onboarding"],
          trust: "low",
          createdBy: "muon-quickstart",
        }));
      setQuickstartCompleted(true);
      setStatusLine(
        `✓ first task ${task.id} finished · memory ${memory.id} captured for review`
      );
    })()
      .catch((error) => {
        setStatusLine(vendorFailStatus(lane.key, error));
      })
      .finally(() => {
        runningRef.current = false;
        setLiveEvents([]);
        void store.refresh();
      });
  };

  const triggerCommand = (commandId: string, args: string[] = []) => {
    if (commandId === "quickstart") {
      runQuickstart();
      return;
    }
    if (commandId === "crew") {
      openCrew();
      return;
    }
    if (commandId === "mcp") {
      openMcp();
      return;
    }
    // ADR-0028 Tier C — shared attach/detach flow; never surfaces a capability
    // token into TUI state (AttachCoordinatorFlowResult is token-free).
    if (commandId === "mcp-attach") {
      const vendorToken = args[0]?.trim();
      if (!vendorToken) {
        setStatusLine("✗ /mcp-attach <claude|codex> — name a coordinator-seat vendor");
        return;
      }
      const chatId = chatRef.current?.id;
      setStatusLine(`… attaching ${vendorToken} as Tier C coordinator`);
      setMcpBusy(true);
      void attachMcpCoordinatorInTui({
        client: store.client,
        vendorToken,
        workspacePath: process.cwd(),
        // The SAME brain the client talks to — never re-resolved (see
        // attachMcpCoordinatorInTui's apiBase doc).
        apiBase: store.apiBase,
        chatId,
      })
        .then((result) => {
          if (result.kind === "refused") {
            setStatusLine(
              `✗ attach refused: ${result.reason}${result.hint ? ` · ${result.hint}` : ""}`
            );
            return;
          }
          setStatusLine(
            `✓ attached ${result.vendor} · job ${result.jobId} · chat ${result.chatId} · NON-HERMETIC · restart ${result.vendor} promptly · lease ${result.expiresAt}`
          );
          refreshMcp();
        })
        .catch((error: unknown) => {
          setStatusLine(
            `✗ attach failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => setMcpBusy(false));
      return;
    }
    if (commandId === "mcp-detach") {
      const vendorToken = args[0]?.trim();
      if (!vendorToken) {
        setStatusLine("✗ /mcp-detach <claude|codex> — name the attached vendor");
        return;
      }
      setStatusLine(`… detaching ${vendorToken}`);
      setMcpBusy(true);
      void detachMcpCoordinatorInTui({
        client: store.client,
        vendorToken,
      })
        .then((result) => {
          if (result.kind === "refused") {
            setStatusLine(`✗ detach refused: ${result.reason}`);
            return;
          }
          if (result.kind === "partial") {
            setStatusLine(
              `✗ detach incomplete: ${result.notes.join(" · ")}`
            );
            refreshMcp();
            return;
          }
          setStatusLine(
            result.kind === "not-attached"
              ? `✓ ${vendorToken} already clean (not attached)`
              : `✓ detached ${vendorToken}${result.jobId ? ` · job ${result.jobId}` : ""}`
          );
          refreshMcp();
        })
        .catch((error: unknown) => {
          setStatusLine(
            `✗ detach failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => setMcpBusy(false));
      return;
    }
    if (commandId === "workflows") {
      setStatusLine("… loading workflow runs");
      void openWorkflowPanel()
        .then(() => setStatusLine(null))
        .catch((error) =>
          setStatusLine(
            `✗ workflows failed: ${error instanceof Error ? error.message : "unknown"}`
          )
        );
      return;
    }
    // P6, the Brain gate auto-loads from the SELECTED task's touched
    // modules/symbols; only when there is no active task (or nothing touched yet)
    // does it fall back to the manual "enter a target" form.
    if (commandId === "context") {
      const intentEpoch = ++brainIntentEpochRef.current;
      const task = selectedTask;
      if (task) {
        setStatusLine("… loading pre-edit context from the active task");
        void openBrainForTask(task, intentEpoch)
          .then((ok) => {
            if (intentEpoch !== brainIntentEpochRef.current) {
              return;
            }
            if (ok) {
              setStatusLine("memory: context loaded from the active task");
            } else if (!openForm("context")) {
              setStatusLine("✗ could not open memory review");
            } else {
              setStatusLine("no touched modules yet, enter a target");
            }
          })
          .catch(() => {
            if (intentEpoch !== brainIntentEpochRef.current) {
              return;
            }
            if (!openForm("context")) {
              setStatusLine("✗ could not open memory review");
            }
          });
        return;
      }
      if (!openForm("context")) {
        setStatusLine("✗ could not open memory review");
      }
      return;
    }
    // S7: soft-archive ("delete") the resumed chat. Operator-tier over the
    // store client; the audit trail survives, the chat just leaves the lists.
    if (commandId === "archive-chat") {
      const chat = chatRef.current;
      if (!chat) {
        setStatusLine("✗ no active chat to archive in this folder");
        return;
      }
      setStatusLine(`… archiving chat ${chat.id}`);
      void store.client
        .archiveChat(chat.id)
        .then(() => {
          chatRef.current = null;
          setChatMessages([]);
          setStatusLine(
            `✓ archived chat ${chat.id}; its history is preserved`
          );
        })
        .catch((error) =>
          setStatusLine(
            `✗ archive failed: ${
              error instanceof Error ? error.message : "control plane unavailable"
            }`
          )
        );
      return;
    }
    if (!openForm(commandId)) {
      setStatusLine(`✗ unknown command '${commandId}'`);
    }
  };

  const submitForm = (state: FormState) => {
    const { form, values } = state;
    setFormState({ ...state, busy: true, error: null });

    if (form.commandId === "run") {
      const lane = snapshot.lanes.find(
        (entry) => entry.key === (values.laneKey ?? "").trim()
      );
      if (!lane) {
        setFormState({
          ...state,
          busy: false,
          error: `Lane '${values.laneKey}' not found`,
        });
        return;
      }
      if (runningRef.current) {
        setFormState({ ...state, busy: false, error: "A run is already active" });
        return;
      }
      runningRef.current = true;
      setFormState(null);
      setStatusLine(`▶ running ${lane.key} on ${values.taskId}…`);
      const runTaskId = (values.taskId ?? "").trim();
      void store.client
        .getTaskDetail(runTaskId)
        .then((detail) => detail.workspacePath ?? undefined)
        .catch(() => undefined)
        .then((workspaceCwd) =>
          dispatchRun({
            client: store.client,
            lane,
            taskId: runTaskId,
            brief: (values.brief ?? "").trim(),
            cwd: workspaceCwd,
            onLiveEvent: (event) => {
              setLiveEvents((current) => [event, ...current].slice(0, 50));
            },
          })
        )
        .then((result) => {
          setStatusLine(
            `✓ run finished (exit ${result.exitCode}, ${result.recorded} events recorded)`
          );
        })
        .catch((error) => {
          setStatusLine(vendorFailStatus(lane.key, error));
        })
        .finally(() => {
          runningRef.current = false;
          setLiveEvents([]);
          void store.refresh();
        });
      return;
    }

    if (form.commandId === "session-start") {
      const lane = snapshot.lanes.find(
        (entry) => entry.key === (values.laneKey ?? "").trim()
      );
      if (!lane) {
        setFormState({
          ...state,
          busy: false,
          error: `Lane '${values.laneKey}' not found`,
        });
        return;
      }
      if (activeSessionRef.current) {
        setFormState({
          ...state,
          busy: false,
          error: `Session ${activeSessionRef.current.sessionId} is already active`,
        });
        return;
      }
      setFormState(null);
      setStatusLine(`▶ starting session on ${lane.key}…`);
      // Claim the seat SYNCHRONOUSLY: the guard above reads this ref, and it
      // was only assigned in .then() — two submits inside one enqueue
      // round-trip started two dispatches and the first lost its interrupt
      // handle. The placeholder is replaced by the real session (or cleared)
      // when the start settles.
      activeSessionRef.current = {
        sessionId: "(starting)",
        laneKey: lane.key,
      } as NonNullable<typeof activeSessionRef.current>;
      void startTuiSession({
        client: store.client,
        lane,
        taskId: (values.taskId ?? "").trim(),
        brief: (values.brief ?? "").trim(),
        apiBase: store.apiBase,
        apiToken: resolveAgentToken(),
        onLiveEvent: (event) => {
          setLiveEvents((current) => [event, ...current].slice(0, 50));
        },
        onDone: (message) => {
          activeSessionRef.current = null;
          setStatusLine(message);
          void store.refresh();
        },
      })
        .then((session) => {
          activeSessionRef.current = session;
          setStatusLine(
            `● session ${session.sessionId} live on ${session.laneKey}, approvals land in the inbox`
          );
        })
        .catch((error) => {
          // Release the synchronously-claimed seat: the start never happened.
          activeSessionRef.current = null;
          setStatusLine(
            `✗ session failed: ${error instanceof Error ? error.message : "unknown"}`
          );
        });
      return;
    }

    if (form.commandId === "session-send") {
      const active = activeSessionRef.current;
      if (!active) {
        setFormState({ ...state, busy: false, error: "No active session" });
        return;
      }
      if (!active.canSend) {
        setFormState({
          ...state,
          busy: false,
          error: `Lane '${active.laneKey}' does not support live steering; use take-over instead`,
        });
        return;
      }
      void active
        .send((values.message ?? "").trim())
        .then(() => finishAction("message sent to session", true))
        .catch((error) => {
          setFormState({
            ...state,
            busy: false,
            error: error instanceof Error ? error.message : "Send failed",
          });
        });
      return;
    }

    if (form.commandId === "ship") {
      const lane = snapshot.lanes.find(
        (entry) => entry.key === (values.laneKey ?? "").trim()
      );
      if (!lane) {
        setFormState({
          ...state,
          busy: false,
          error: `Lane '${values.laneKey}' not found`,
        });
        return;
      }
      setFormState(null);
      setStatusLine("▶ running ship checks…");
      void runShipReview({
        client: store.client,
        lane,
        taskId: (values.taskId ?? "").trim(),
        checkCommand: (values.check ?? "npm test").trim() || "npm test",
        // The TASK's workspace, not the TUI's cwd: run the check where the
        // work lives, or the filed merge gate attests to a check that ran
        // against a different tree. Falls back to cwd only when the task
        // never declared a workspace.
        cwd:
          snapshot.tasks.find((task) => task.id === (values.taskId ?? "").trim())
            ?.workspacePath ?? undefined,
      })
        .then((outcome) => {
          setStatusLine(`${outcome.ok ? "✓" : "✗"} ${outcome.message}`);
          void store.refresh();
        })
        .catch((error) => {
          setStatusLine(
            `✗ ship failed: ${error instanceof Error ? error.message : "unknown"}`
          );
        });
      return;
    }

    if (form.commandId === "plan") {
      setFormState(null);
      submitProposal((values.request ?? "").trim());
      return;
    }

    if (form.commandId === "specialist") {
      const lane = snapshot.lanes.find(
        (entry) => entry.key === (values.laneKey ?? "").trim()
      );
      if (!lane) {
        setFormState({
          ...state,
          busy: false,
          error: `Lane '${values.laneKey}' not found`,
        });
        return;
      }
      if (runningRef.current) {
        setFormState({ ...state, busy: false, error: "A run is already active" });
        return;
      }
      runningRef.current = true;
      setFormState(null);
      setStatusLine("▶ assembling specialist…");
      void (async () => {
        // Specialist = task + brief + harness + memory slice + lane,
        // assembled in one action, dispatched through the normal machinery.
        const harnessKey = (values.harnessKey ?? "").trim();
        if (harnessKey) {
          await store.client.getHarness(harnessKey);
        }

        const workspace = (values.workspace ?? "").trim() || process.cwd();
        const task = await store.client.createTask({
          title: (values.title ?? "").trim(),
          description: (values.brief ?? "").trim(),
          priority: "medium",
          workspacePath: workspace,
        });

        setStatusLine(
          `▶ specialist ${task.id} → ${lane.key}${harnessKey ? ` +${harnessKey}` : ""}…`
        );
        const result = await dispatchRun({
          client: store.client,
          lane,
          taskId: task.id,
          brief: (values.brief ?? "").trim(),
          cwd: workspace,
          harnessKey: harnessKey || undefined,
          onLiveEvent: (event) => {
            setLiveEvents((current) => [event, ...current].slice(0, 50));
          },
        });
        setStatusLine(
          `✓ specialist ${task.id} finished (exit ${result.exitCode}, ${result.recorded} events)`
        );
      })()
        .catch((error) => {
          setStatusLine(vendorFailStatus(lane.key, error));
        })
        .finally(() => {
          runningRef.current = false;
          setLiveEvents([]);
          void store.refresh();
        });
      return;
    }

    if (form.commandId === "memory-search") {
      const query = (values.query ?? "").trim();
      const version = ++memorySearchVersion.current;
      // ADR-0026 §1 measured this call site (App.tsx:1178) sending no partition
      // coordinate, so one TUI search read every repo on the machine. The invoking
      // directory is the default; the SERVER canonicalizes it and reduces a
      // worktree to its repo root, so the TUI never restates that rule.
      const memoryWorkspace = process.cwd();
      void store.client
        // R3: expired notes stay hidden on the first read (the hygienic
        // default every surface shares); `e` re-asks with showExpired.
        .searchMemory(query, {
          workspace: memoryWorkspace,
          showExpired: false,
        })
        .then((notes) => {
          if (memorySearchVersion.current !== version) return;
          setFormState(null);
          setMemoryNoteIndex(0);
          setMemoryView({
            title: `"${values.query}"`,
            query,
            notes,
            showExpired: false,
            workspacePath: memoryWorkspace,
          });
        })
        .catch((error) => {
          if (memorySearchVersion.current !== version) return;
          setFormState({
            ...state,
            busy: false,
            error: error instanceof Error ? error.message : "Search failed",
          });
        });
      return;
    }

    if (form.commandId === "context") {
      const target = (values.target ?? "").trim();
      setBrainProposalIndex(0);
      setBrainProposalText({});
      void loadBrain(parseEditTarget(target), target)
        .then((loaded) => {
          if (!loaded) {
            return;
          }
          setFormState(null);
          setStatusLine(`memory: pre-edit context for ${target}`);
        })
        .catch((error) => {
          setFormState({
            ...state,
            busy: false,
            error:
              error instanceof Error ? error.message : "Pre-edit context failed",
          });
        });
      return;
    }

    if (form.commandId === "memory-add") {
      void store.client
        .addMemoryNote({
          kind: (values.kind ?? "decision").trim() as MemoryNote["kind"],
          text: (values.text ?? "").trim(),
          taskId: (values.taskId ?? "").trim() || undefined,
          modules: (values.module ?? "").trim()
            ? [(values.module ?? "").trim()]
            : [],
          createdBy: "human",
        })
        .then((note) => finishAction(`Memory note added: ${note.id}`, true))
        .catch((error) => {
          setFormState({
            ...state,
            busy: false,
            error: error instanceof Error ? error.message : "Add failed",
          });
        });
      return;
    }

    void executeAction(store.client, form, values).then((result) => {
      if (result.ok) {
        finishAction(result.message, true);
      } else {
        setFormState({ ...state, busy: false, error: result.message });
      }
    });
  };

  const resolveSelectedApproval = (
    decision: "approved" | "rejected",
    // P0.4: set ONLY by the explicit "approve, don't ask again" keystroke (A);
    // the plain approve path never mints a receipt.
    receiptTtlMs?: number,
    attestReviewBlind = false
  ) => {
    if (approvalResolving) {
      setStatusLine("… approval decision already in progress");
      return;
    }
    const approval = pendingApprovals[approvalIndex];
    if (!approval) {
      setStatusLine("✗ no pending approval selected");
      return;
    }
    const review = buildApprovalReview(approval);
    if (approvalReview?.id !== approval.id) {
      const loadVersion = ++approvalReviewLoadVersion.current;
      setApprovalReview(approval);
      setApprovalReviewCertification(null);
      setApprovalReviewError(null);
      if (approval.kind === "merge") {
        void store.client
          .getApprovalReviewCertification(approval.id)
          .then((certification) => {
            if (approvalReviewLoadVersion.current === loadVersion) {
              setApprovalReviewCertification(certification);
            }
          })
          .catch((error) => {
            if (approvalReviewLoadVersion.current === loadVersion) {
              setApprovalReviewError(
                error instanceof Error
                  ? error.message
                  : "Could not load merge review evidence."
              );
            }
          });
      }
      setStatusLine(
        `reviewing ${approval.id} · press ${decision === "approved" ? "a again to approve the exact action" : "r again to reject"}`
      );
      return;
    }
    if (decision === "approved" && !review.approvable) {
      setStatusLine(
        `✗ ${review.degradationReason ?? "approval is not safely bound; reject and re-file"}`
      );
      return;
    }
    if (receiptTtlMs !== undefined && !review.receiptEligible) {
      setStatusLine(`✗ ${REMEMBER_ACTION_INELIGIBLE_SENTENCE}`);
      return;
    }
    let manualReview:
      | import("@muon/client").ManualReviewAttestation
      | undefined;
    if (decision === "approved" && approval.kind === "merge") {
      if (approvalReviewError) {
        setStatusLine(`✗ ${approvalReviewError}`);
        return;
      }
      if (!approvalReviewCertification) {
        setStatusLine("… merge review evidence is still loading");
        return;
      }
      if (approvalReviewCertification.status === "blocked") {
        if (
          approvalReviewCertification.blockCode !== "review-blind" ||
          !attestReviewBlind
        ) {
          setStatusLine(
            approvalReviewCertification.blockCode === "review-blind"
              ? "✗ review every blind file, then press m to attest and approve"
              : `✗ ${approvalReviewCertification.reason}`
          );
          return;
        }
        if (
          (approvalReviewCertification.blindFiles?.length ?? 0) > 12
        ) {
          setStatusLine(
            "✗ this review has more than 12 blind files; use Desktop or `muon approve review` to inspect the complete set"
          );
          return;
        }
        manualReview = {
          acknowledged: true,
          artifactDigest: approvalReviewCertification.artifactDigest,
          blindFiles: approvalReviewCertification.blindFiles ?? [],
        };
      } else if (attestReviewBlind) {
        setStatusLine("✗ manual attestation is not needed; press a to approve");
        return;
      }
    }
    setStatusLine(`… ${decision === "approved" ? "approving" : "rejecting"} ${approval.id}`);
    setApprovalResolving(true);
    void resolveApprovalAction(
      store.client,
      approval.id,
      decision,
      // Surface attribution, matching the desktop's "decided from MUON
      // desktop": an audit-trail row must say WHERE the human decided.
      "decided from MUON TUI",
      receiptTtlMs,
      manualReview
    ).then((result) => {
      setApprovalResolving(false);
      if (result.ok) {
        approvalReviewLoadVersion.current += 1;
        setApprovalReview(null);
        setApprovalReviewCertification(null);
        setApprovalReviewError(null);
      }
      setStatusLine(`${result.ok ? "✓" : "✗"} ${result.message}`);
      void store.refresh();
    });
  };

  const stopAll = () => {
    setStatusLine("■ stopping every active lane…");
    const activeSession = activeSessionRef.current;
    void Promise.allSettled([
      activeSession?.interrupt() ?? Promise.resolve(),
      stopAllDispatches(store.client),
    ])
      .then(([, dispatchResult]) => {
        activeSessionRef.current = null;
        if (dispatchResult.status === "rejected") {
          throw dispatchResult.reason;
        }
        const result = dispatchResult.value;
        const directRunNote =
          runningRef.current && !activeSession
            ? " · current in-process run has no interrupt handle yet"
            : "";
        setStatusLine(
          result.failedJobIds.length === 0
            ? `■ stopped ${result.stopped} dispatch lane${result.stopped === 1 ? "" : "s"}${directRunNote}`
            : `✗ stopped ${result.stopped}/${result.requested}; failed: ${result.failedJobIds.join(", ")}${directRunNote}`
        );
        void store.refresh();
      })
      .catch((error) => {
        setStatusLine(
          `✗ stop all failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      });
  };

  const stopSelectedLane = () => {
    const agent = railAgents[laneIndex];
    if (!agent) {
      setStatusLine("✗ no crew lane selected");
      return;
    }
    const job =
      snapshot.dispatchJobs.find((candidate) => candidate.id === agent.currentJobId) ??
      snapshot.dispatchJobs.find((candidate) => candidate.agentId === agent.id);
    if (
      !job ||
      job.interruptRequested ||
      (job.status !== "queued" && job.status !== "running")
    ) {
      setStatusLine(`✗ ${agent.name} has no active dispatch to stop`);
      return;
    }
    setStatusLine(`■ stopping ${agent.name} · ${job.id}`);
    void store.client
      .interruptDispatchJob(job.id)
      .then(() => {
        setStatusLine(`■ stopped ${agent.name} · ${job.id}`);
        void store.refresh();
      })
      .catch((error: unknown) => {
        setStatusLine(
          `✗ stop ${agent.name} failed: ${
            error instanceof Error ? error.message : "unknown"
          }`
        );
      });
  };

  // ADR-0013 #52, resolve a `/<action> [vendor]` pick against the shared
  // descriptor (readiness- and mode-aware) and surface the badged, gated result.
  // The resolver re-routes the four invariant-breakers here: full-auto is
  // dispatch-gated (and withheld in interactive), --strict-mcp-config is refused
  // (the governed brain stays), cloud is egress-gated, system-prompt warns.
  const dispatchVendorAction = (
    actionId: string,
    vendor: VendorKey | undefined,
    args: string[]
  ): void => {
    // S10: `/model <id>` is REAL — it sets the chat-level default model the
    // super-orchestrator runs its turns on (always Claude Code, CHAT_LANE_KEY),
    // stashed for the next `runChatTurn`. Validated through the SAME S5 authority
    // the route enforces: a rejected id refuses fast (never silent), a degrade
    // warning is surfaced, and the route re-validates fail-closed per dispatch.
    if (actionId === "model") {
      const requested = args[0];
      if (!requested) {
        setStatusLine("✗ /model needs a model id (e.g. /model opus)");
        return;
      }
      // TODO 3.3 made `VendorKey` the registry id itself, so this alias resolve
      // now succeeds for every REGISTERED vendor and the refusal below is
      // reachable only for a lane the registry does not name. Kept rather than
      // deleted: degrading to "no validation" for an unresolvable lane would be
      // the fail-open the route's own `assertVendorHasModelCatalog` refuses.
      // Never wave an unvalidatable model through.
      const coordinatorKey = normalizeVendorAlias(CHAT_LANE_KEY);
      if (!coordinatorKey) {
        setStatusLine(
          `✗ /model unavailable: MUON has no managed model catalog for the coordinator lane '${CHAT_LANE_KEY}'`
        );
        return;
      }
      const check = validateModelForVendor(coordinatorKey, requested);
      if (!check.ok) {
        setStatusLine(`✗ /model rejected: ${check.reason}`);
        return;
      }
      chatModelRef.current = requested;
      setStatusLine(
        check.warning
          ? `✓ model set to ${requested} for this chat — ${check.warning}`
          : `✓ model set to ${requested} for this chat (applies to the next turn)`
      );
      return;
    }
    const readiness = snapshot.readiness;
    let chosen = vendor;
    if (!chosen) {
      const menu = buildVendorActionMenu({ readiness, mode: "one-shot", actionId });
      const ready = menu.find((entry) => entry.ready);
      if (menu.length === 0) {
        setStatusLine(`✗ no vendor supports /${actionId}`);
        return;
      }
      if (!ready) {
        const vendors = menu.map((entry) => entry.badge).join(", ");
        setStatusLine(`✗ /${actionId}, no ready vendor (supported by: ${vendors})`);
        return;
      }
      chosen = ready.vendor;
    }
    const resolved = resolveVendorAction(chosen, actionId, { args, mode: "one-shot" });
    if (!resolved.supported) {
      setStatusLine(`✗ ${resolved.reason}`);
      return;
    }
    const parts = [`${chosen} · ${resolved.action?.label ?? actionId}`];
    if (resolved.refused) {
      parts.push("refused — memory control stays on");
    } else if (resolved.argvOverride) {
      parts.push(`argv: ${[chosen, ...resolved.argvOverride.args].join(" ")}`);
    } else if (resolved.briefPrefix) {
      parts.push(`prefix: ${resolved.briefPrefix}`);
    } else if (resolved.sessionSend) {
      parts.push(`session: ${resolved.sessionSend}`);
    } else if (resolved.profilePatch) {
      parts.push(`profile: ${JSON.stringify(resolved.profilePatch)}`);
    }
    if (resolved.downgraded) parts.push("interactive-safe");
    if (resolved.warnings[0]) parts.push(resolved.warnings[0]);
    const icon = resolved.refused ? "⚠" : resolved.gate === "none" ? "→" : "gated";
    setStatusLine(`${icon} ${parts.join("  ·  ")}`);
  };

  useInput((input, key) => {
    // ADR-0040 D3a — a KEYSTROKE proves a person is at this terminal, which a
    // poll never does. Throttled so holding a key is not a request per
    // character; the brain only needs to hear from us well inside its
    // freshness window, not on every press.
    const nowMs = Date.now();
    if (nowMs - lastPresenceRef.current > 30_000) {
      lastPresenceRef.current = nowMs;
      void store.client.noteHumanPresent("tui").catch(() => undefined);
    }
    // ADR-0042 D2 — the keymap table dispatches, BEFORE the mode cascade.
    //
    // This is the structural fix for the Tab-after-`/` class. Every mode below
    // is a black hole for keys it does not personally name, so a binding that
    // should survive a modal surface had to be re-implemented inside each one
    // — and was not. Resolving first means a scope KEEPS what it inherits by
    // construction rather than by anyone remembering to.
    //
    // Scoped dispatch is deliberately incremental: only ids in
    // `DISPATCHED_ACTIONS` run from here. Everything else falls through to the
    // cascade exactly as before, and `key-dispatch.test.ts` asserts the split
    // is declared rather than accidental. Migrating the remainder is the rest
    // of D2; this is the slice that removes the bug class.
    {
      const scope: KeyScope = commandFocused
        ? "command-bar"
        : paletteOpen
          ? "palette"
          : helpOpen
            ? "help"
            : formState
              ? "form"
              : "cockpit";
      const resolved = resolveKeyAction(scope, key, input, focus);
      if (resolved && DISPATCHED_ACTIONS.has(resolved.id)) {
        if (resolved.id === "cycle-zone") {
          // Leaving a text field is part of cycling out of it.
          if (scope === "command-bar") setCommandFocused(false);
          setFocus((current) => nextFocusZone(current, key.shift ? "prev" : "next"));
          return;
        }
      }
    }

    // Command bar input wins while focused, it is the front door.
    if (commandFocused) {
      if (commandBusy) {
        return;
      }
      if (key.escape) {
        setCommandFocused(false);
        setCommandValue("");
        return;
      }
      if (key.return) {
        const action = parseCommandBarInput(commandValue);
        if (action.type === "error") {
          setStatusLine(`✗ ${action.message}`);
          return;
        }
        if (action.type === "palette") {
          setCommandFocused(false);
          setCommandValue("");
          triggerCommand(action.commandId, action.args);
          return;
        }
        if (action.type === "vendorAction") {
          setCommandFocused(false);
          setCommandValue("");
          dispatchVendorAction(action.actionId, action.vendor, action.args);
          return;
        }
        submitInstruction(action.request);
        return;
      }
      // FUNCTIONAL updater, not a closure read. Ink splits one stdin chunk into
      // several SYNCHRONOUS key events (`splitBackspaceBytes` exists precisely
      // because holding a key sends repeated bytes in one chunk), and React
      // does not commit between them — so reading `commandValue` from this
      // render's closure makes every event in the chunk see the same stale
      // value and the last write win. Holding backspace deleted ONE character,
      // and `DEL` followed by a keystroke lost the delete entirely.
      setCommandValue((value) => editText(value, key, input) ?? value);
      return;
    }

    // ADR-0032 D6 — the `?` keymap. Sits above every other mode so help is
    // reachable from wherever the operator got lost, and takes printable input
    // as a filter (the table is long enough that scanning it is the slow path).
    if (helpOpen) {
      if (key.escape || input === "?") {
        setHelpOpen(false);
        setHelpQuery("");
        return;
      }
      setHelpQuery((value) => editText(value, key, input) ?? value);
      return;
    }

    if (approvalReview) {
      if (key.escape) {
        if (approvalResolving) {
          setStatusLine("… wait for the approval decision to finish");
          return;
        }
        approvalReviewLoadVersion.current += 1;
        setApprovalReview(null);
        setApprovalReviewCertification(null);
        setApprovalReviewError(null);
        setStatusLine("approval review closed without a decision");
        return;
      }
      if (input === "A") {
        // "Approve, don't ask again" — the SAME content-bound receipt the
        // desktop button sends, same lifetime constant. Eligibility is
        // re-checked inside (the server mint stays the final authority).
        resolveSelectedApproval("approved", REMEMBER_ACTION_TTL_MS);
        return;
      }
      if (input === "a") {
        resolveSelectedApproval("approved");
        return;
      }
      if (input === "m") {
        // `m` exists ONLY on the blocked-merge gate (an explicit REVIEW BLIND
        // attestation). On any other kind the attest flag used to be silently
        // ignored and the keypress fell through to a plain APPROVE — an
        // unadvertised fourth approve key on gates the overlay never offered
        // it for. The CLI and desktop both refuse this; now the TUI does too.
        const attestTarget = pendingApprovals[approvalIndex];
        if (attestTarget && attestTarget.kind !== "merge") {
          setStatusLine(
            "✗ m (attest) applies only to a merge gate — use a to approve, r to reject"
          );
          return;
        }
        resolveSelectedApproval("approved", undefined, true);
        return;
      }
      if (input === "r") {
        resolveSelectedApproval("rejected");
      }
      return;
    }

    if (formState) {
      if (formState.busy) {
        return;
      }
      if (key.escape) {
        setFormState(null);
        return;
      }
      if (key.return) {
        if (formState.fieldIndex < formState.form.fields.length - 1) {
          setFormState({
            ...formState,
            fieldIndex: formState.fieldIndex + 1,
            error: null,
          });
        } else {
          submitForm(formState);
        }
        return;
      }
      if (key.upArrow) {
        setFormState({
          ...formState,
          fieldIndex: Math.max(0, formState.fieldIndex - 1),
        });
        return;
      }
      if (key.downArrow) {
        setFormState({
          ...formState,
          fieldIndex: Math.min(
            formState.form.fields.length - 1,
            formState.fieldIndex + 1
          ),
        });
        return;
      }
      const field = formState.form.fields[formState.fieldIndex];
      if (!field) {
        return;
      }
      if (isTextEdit(key, input)) {
        const fieldId = field.id;
        setFormState((prev) =>
          prev
            ? {
                ...prev,
                values: {
                  ...prev.values,
                  [fieldId]: editText(prev.values[fieldId] ?? "", key, input) ?? "",
                },
              }
            : prev
        );
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFormState({
          ...formState,
          values: {
            ...formState.values,
            [field.id]: (formState.values[field.id] ?? "") + input,
          },
        });
      }
      return;
    }

    if (memoryView) {
      if (key.escape || input === "q") {
        // Abandon any in-flight expired-toggle reload with the panel.
        memorySearchVersion.current += 1;
        setMemoryBusy(false);
        setMemoryView(null);
        return;
      }
      if (key.upArrow || input === "k") {
        setMemoryNoteIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setMemoryNoteIndex((index) =>
          Math.min(Math.max(memoryView.notes.length - 1, 0), index + 1)
        );
        return;
      }
      if (input === "e" || input === "E") {
        // R3 TTL parity with the desktop "Show expired" toggle: the posture is
        // a SERVER parameter on the governed search, so flipping it re-asks the
        // backend rather than filtering what is already on screen. Operator
        // tier honours it; an agent-tier bearer is silently downgraded
        // server-side, which is deliberate (a 403 would make the flag a tier
        // oracle) and needs no handling here.
        const next = !memoryView.showExpired;
        const version = ++memorySearchVersion.current;
        setMemoryBusy(true);
        setStatusLine(
          next
            ? "… reloading memory including expired notes"
            : "… reloading memory without expired notes"
        );
        void store.client
          // The SAME workspace the view was built with, never a fresh cwd read: a
          // toggle must re-ask the same question, and re-deriving it here would let
          // an expired-toggle silently move the partition.
          .searchMemory(memoryView.query, {
            workspace: memoryView.workspacePath,
            showExpired: next,
          })
          .then((notes) => {
            if (memorySearchVersion.current !== version) return;
            setMemoryBusy(false);
            setMemoryNoteIndex(0);
            setMemoryView({ ...memoryView, notes, showExpired: next });
            setStatusLine(
              next
                ? `memory: ${notes.length} note(s), expired included`
                : `memory: ${notes.length} note(s), expired hidden`
            );
          })
          .catch((error) => {
            if (memorySearchVersion.current !== version) return;
            setMemoryBusy(false);
            setStatusLine(
              `✗ memory reload failed: ${
                error instanceof Error ? error.message : "unknown"
              }`
            );
          });
        return;
      }
      const selectedNote = memoryView.notes[memoryNoteIndex];
      if (selectedNote && (input === "p" || input === "P")) {
        void store.client
          .updateMemoryNote(buildMemoryDecision(selectedNote.id, "pause"))
          .then(() => {
            const nextNotes = memoryView.notes.filter(
              (note) => note.id !== selectedNote.id
            );
            setMemoryView(
              nextNotes.length > 0
                ? { ...memoryView, notes: nextNotes }
                : null
            );
            setMemoryNoteIndex((index) => Math.max(0, index - 1));
            setStatusLine(
              `✓ memory ${selectedNote.id} paused · resume from the library or CLI`
            );
          })
          .catch((error) =>
            setStatusLine(
              `✗ pause failed: ${error instanceof Error ? error.message : "unknown"}`
            )
          );
        return;
      }
      if (selectedNote && (input === "c" || input === "C")) {
        void store.client
          // The SHARED payload builder (parity with the desktop, the CLI and
          // the shell desk): only a human principal elevates a note into gate
          // views, and that rule lives in one function.
          .updateMemoryNote(buildMemoryDecision(selectedNote.id, "confirm"))
          .then((updated) => {
            setMemoryView({
              ...memoryView,
              notes: memoryView.notes.map((note) =>
                note.id === updated.id ? updated : note
              ),
            });
            // R3: a human confirm CLEARS the expiry server-side, and the note
            // returned here already reports `expired: false` — the EXPIRED
            // marker disappears in place, which is the redemption made visible.
            setStatusLine(
              selectedNote.expired === true
                ? `✓ memory ${updated.id} confirmed · expiry cleared`
                : `✓ memory ${updated.id} confirmed`
            );
          })
          .catch((error) =>
            setStatusLine(
              `✗ confirm failed: ${error instanceof Error ? error.message : "unknown"}`
            )
          );
        return;
      }
      if (selectedNote && (input === "x" || input === "X")) {
        void store.client
          // KG-6 governed rejection, through the SHARED builder: both halves
          // (`confirmed:false` for the adjudication + its principal,
          // `status:"rejected"` to retire it) are its responsibility now.
          .updateMemoryNote(buildMemoryDecision(selectedNote.id, "reject"))
          .then(() => {
            const nextNotes = memoryView.notes.filter(
              (note) => note.id !== selectedNote.id
            );
            setMemoryView(
              nextNotes.length > 0
                ? { ...memoryView, notes: nextNotes }
                : null
            );
            setMemoryNoteIndex((index) => Math.max(0, index - 1));
            setStatusLine(`✓ memory ${selectedNote.id} rejected`);
          })
          .catch((error) =>
            setStatusLine(
              `✗ reject failed: ${error instanceof Error ? error.message : "unknown"}`
            )
          );
        return;
      }
      return;
    }

    if (brainView) {
      if (key.escape || input === "q") {
        closeBrain();
        return;
      }
      if (input === "r" && brainInput) {
        setStatusLine(`… refreshing memory for ${brainTarget ?? "target"}`);
        void loadBrain(brainInput, brainTarget ?? "target", true)
          .then((loaded) => {
            if (loaded) {
              setStatusLine(`memory: refreshed ${brainTarget ?? "target"}`);
            }
          })
          .catch((error) =>
            setStatusLine(
              `✗ refresh failed: ${error instanceof Error ? error.message : "unknown"}`
            )
          );
        return;
      }
      const proposals = brainView.pendingProposals;
      if (key.upArrow || input === "k") {
        setBrainProposalIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setBrainProposalIndex((index) =>
          Math.min(Math.max(proposals.length - 1, 0), index + 1)
        );
        return;
      }
      const selected = proposals[brainProposalIndex];
      // `v`, fetch the proposal's UNTRUSTED text ON DEMAND via the operator
      // note-by-id path. Never auto-injected; the human explicitly asks for it.
      if (selected && (input === "v" || input === "V")) {
        setBrainProposalText((current) => ({
          ...current,
          [selected.proposalNoteId]: "…",
        }));
        void fetchProposalNote(store.client, selected.proposalNoteId)
          .then((note) =>
            setBrainProposalText((current) => ({
              ...current,
              [selected.proposalNoteId]: note.text,
            }))
          )
          .catch((error) => {
            setBrainProposalText((current) => {
              const next = { ...current };
              delete next[selected.proposalNoteId];
              return next;
            });
            setStatusLine(
              `✗ view failed: ${error instanceof Error ? error.message : "unknown"}`
            );
          });
        return;
      }
      // `c` / `x`, confirm/reject through the operator-tier KG-6 route, then refresh.
      if (selected && (input === "c" || input === "C" || input === "x" || input === "X")) {
        if (brainDecisionInFlightRef.current) {
          return;
        }
        const selectedText = brainProposalText[selected.proposalNoteId];
        if (selectedText === undefined || selectedText === "…") {
          setStatusLine(
            `✗ press v to view proposal ${selected.proposalNoteId} before confirming or rejecting`
          );
          return;
        }
        const decision = input === "c" || input === "C" ? "confirm" : "reject";
        const decisionEpoch = brainIntentEpochRef.current;
        const decisionInput = brainInput;
        const decisionTarget = brainTarget ?? "target";
        const successMessage =
          decision === "confirm"
            ? `✓ proposal ${selected.proposalNoteId} confirmed, supersede applied`
            : `✓ proposal ${selected.proposalNoteId} rejected, memory kept`;
        brainDecisionInFlightRef.current = true;
        setStatusLine(`… ${decision}ing proposal ${selected.proposalNoteId}`);
        void resolveProposal(store.client, {
          proposalNoteId: selected.proposalNoteId,
          decision,
        })
          .then(async () => {
            if (decisionEpoch !== brainIntentEpochRef.current) {
              return;
            }
            setBrainView((current) => {
              if (!current) {
                return current;
              }
              const pendingProposals = current.pendingProposals.filter(
                (proposal) =>
                  proposal.proposalNoteId !== selected.proposalNoteId
              );
              return {
                ...current,
                pendingProposals,
                pendingCount: pendingProposals.length,
              };
            });
            setBrainProposalIndex((index) =>
              Math.min(
                index,
                Math.max(brainView.pendingProposals.length - 2, 0)
              )
            );
            setBrainProposalText((current) => {
              const next = { ...current };
              delete next[selected.proposalNoteId];
              return next;
            });
            setStatusLine(successMessage);
            if (!decisionInput) {
              return;
            }
            try {
              const loaded = await loadBrain(
                decisionInput,
                decisionTarget,
                true
              );
              if (loaded) {
                setStatusLine(successMessage);
              }
            } catch (error) {
              setStatusLine(
                `${successMessage} · refresh failed: ${
                  error instanceof Error ? error.message : "unknown"
                }`
              );
            }
          })
          .catch((error) => {
            if (decisionEpoch === brainIntentEpochRef.current) {
              setStatusLine(
                `✗ ${decision} failed: ${
                  error instanceof Error ? error.message : "unknown"
                }`
              );
            }
          })
          .finally(() => {
            brainDecisionInFlightRef.current = false;
          });
        return;
      }
      return;
    }

    // CREW is read-only: close, refresh, and scroll the untrusted peer log.
    // Deliberately NO write keystroke here — role assignment stays with the
    // orchestrator and `muon crew roles --assign`.
    if (crewOpen) {
      if (key.escape || input === "q") {
        closeCrew();
        return;
      }
      if (input === "r" || input === "R") {
        if (!crewChatId) {
          setStatusLine(
            "✗ no chat to load a crew for — press / and tell the crew what to do"
          );
          return;
        }
        setStatusLine(`… refreshing crew for chat ${crewChatId}`);
        refreshCrew(crewChatId);
        return;
      }
      const messageCount =
        crewLoad?.coordination.status === "ready"
          ? crewLoad.coordination.messages.length
          : 0;
      if (key.downArrow || input === "j") {
        setCrewMessageIndex((index) =>
          Math.min(Math.max(messageCount - CREW_MESSAGE_WINDOW, 0), index + 1)
        );
        return;
      }
      if (key.upArrow || input === "k") {
        setCrewMessageIndex((index) => Math.max(0, index - 1));
      }
      return;
    }

    // MCP is read-only, and matches CREW's key handling exactly (Esc/q close,
    // r refresh, j/k scroll) so the cockpit has ONE overlay idiom. Deliberately
    // NO install keystroke: `muon mcp install <vendor>` writes into a config
    // file MUON does not own, and that stays an explicit command rather than a
    // single letter next to the scroll keys.
    if (mcpOpen) {
      if (key.escape || input === "q") {
        closeMcp();
        return;
      }
      if (input === "r" || input === "R") {
        setStatusLine("… re-reading MCP registration status");
        refreshMcp();
        return;
      }
      const vendorCount =
        mcpLoad.status === "ready" ? mcpLoad.report.vendors.length : 0;
      if (key.downArrow || input === "j") {
        setMcpVendorIndex((index) =>
          Math.min(Math.max(vendorCount - MCP_VENDOR_WINDOW, 0), index + 1)
        );
        return;
      }
      if (key.upArrow || input === "k") {
        setMcpVendorIndex((index) => Math.max(0, index - 1));
      }
      return;
    }

    if (taskDetailView) {
      if (key.escape || input === "q") {
        setTaskDetailView(null);
      }
      return;
    }

    if (agentView) {
      if (key.escape || input === "q") {
        // Close the VIEW, keep the BUFFER (ADR-0032 D2). Clearing here is what
        // made reopening a stream refetch from seq 0 and lose its history.
        setAgentView(null);
      }
      return;
    }

    if (budgetOverlayOpen) {
      if (key.escape || input === "q") {
        setBudgetOverlayOpen(false);
      }
      return;
    }

    if (workflowView) {
      if (key.escape || input === "q") {
        setWorkflowView(null);
        return;
      }
      if (key.upArrow || input === "k") {
        setWorkflowIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setWorkflowIndex((index) =>
          Math.min(Math.max(workflowView.runs.length - 1, 0), index + 1)
        );
        return;
      }
      const selectedRun = workflowView.runs[workflowIndex];
      if (selectedRun && (input === "a" || input === "A")) {
        if (selectedRun.status !== "proposed") {
          setStatusLine(`✗ run ${selectedRun.id} is ${selectedRun.status}, not proposed`);
          return;
        }
        setStatusLine(`… applying ${selectedRun.id}`);
        void store.client
          .applyWorkflowRun(selectedRun.id, "human")
          .then(async (applied) => {
            const runs = await store.client.listWorkflowRuns().catch(() => []);
            setWorkflowView({ runs });
            setStatusLine(
              `✓ applied ${applied.run.id} (${applied.tasks.length} step task(s)), press x to execute here`
            );
            void store.refresh();
          })
          .catch((error) =>
            setStatusLine(
              `✗ apply failed: ${error instanceof Error ? error.message : "unknown"}`
            )
          );
        return;
      }
      // x = apply if needed, then execute inside the cockpit.
      if (selectedRun && (input === "x" || input === "X")) {
        if (
          selectedRun.status !== "proposed" &&
          selectedRun.status !== "applied" &&
          selectedRun.status !== "paused"
        ) {
          setStatusLine(
            `✗ run ${selectedRun.id} is ${selectedRun.status}, nothing to execute`
          );
          return;
        }
        const start = () => executeWorkflowRun(selectedRun.id);
        if (selectedRun.status === "proposed") {
          setStatusLine(`… applying ${selectedRun.id}`);
          void store.client
            .applyWorkflowRun(selectedRun.id, "human")
            .then(start)
            .catch((error) =>
              setStatusLine(
                `✗ apply failed: ${error instanceof Error ? error.message : "unknown"}`
              )
            );
        } else {
          start();
        }
        return;
      }
      return;
    }

    if (key.ctrl && input === "k") {
      setPaletteOpen((open) => !open);
      setPaletteQuery("");
      setPaletteIndex(0);
      setFocus(paletteOpen ? "tasks" : "palette");
      return;
    }

    if (paletteOpen) {
      if (key.escape) {
        setPaletteOpen(false);
        setFocus("tasks");
        return;
      }
      if (key.upArrow) {
        setPaletteIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteIndex((i) =>
          Math.min(Math.max(paletteResults.length - 1, 0), i + 1)
        );
        return;
      }
      if (key.return) {
        const selected = paletteResults[paletteIndex];
        if (!selected) {
          return;
        }
        // ADR-0013 #52, a vendor-action palette entry ("vendor:<v>:<action>")
        // resolves through the shared descriptor (badged, gated), not a cockpit
        // command.
        if (selected.id.startsWith("vendor:")) {
          const [, vendor, actionId] = selected.id.split(":");
          setPaletteOpen(false);
          dispatchVendorAction(actionId!, vendor as VendorKey, []);
          return;
        }
        if (selected.id === "quit") {
          store.stop();
          exit();
          return;
        }
        if (selected.id === "refresh") {
          void store.refresh();
          setPaletteOpen(false);
          setFocus("tasks");
          return;
        }
        if (selected.id.startsWith("focus-")) {
          const zone = selected.id.replace("focus-", "") as FocusZone;
          setFocus(zone === "lanes" ? "lanes" : zone);
          setPaletteOpen(false);
          return;
        }
        if (selected.id === "approve" || selected.id === "reject") {
          setPaletteOpen(false);
          setFocus("approvals");
          resolveSelectedApproval(
            selected.id === "approve" ? "approved" : "rejected"
          );
          return;
        }
        if (selected.id === "session-interrupt") {
          setPaletteOpen(false);
          const active = activeSessionRef.current;
          if (!active) {
            setStatusLine("✗ no active session");
            return;
          }
          void active
            .interrupt()
            .then(() => setStatusLine(`■ session ${active.sessionId} interrupted`))
            .catch((error) =>
              setStatusLine(
                `✗ interrupt failed: ${error instanceof Error ? error.message : "unknown"}`
              )
            );
          return;
        }
        if (selected.id === "workflows") {
          setPaletteOpen(false);
          triggerCommand("workflows");
          return;
        }
        if (selected.id === "crew") {
          setPaletteOpen(false);
          triggerCommand("crew");
          return;
        }
        if (selected.id === "mcp") {
          setPaletteOpen(false);
          triggerCommand("mcp");
          return;
        }
        if (selected.id === "quickstart") {
          setPaletteOpen(false);
          triggerCommand("quickstart");
          return;
        }
        // P6, the Brain gate auto-loads from the active task (or the manual
        // form when there's none). Route it through triggerCommand's auto path.
        if (selected.id === "context") {
          setPaletteOpen(false);
          triggerCommand("context");
          return;
        }
        if (selected.id === "take-over") {
          setPaletteOpen(false);
          const taskId = selectedTask?.id;
          if (!taskId) {
            setStatusLine("✗ select a task first");
            return;
          }
          // ADR-0030: take-over is a GOVERNED WRITE, not a string to copy.
          // This used to print the native argv and stop, which left MUON's
          // ownership record saying `muon` while the human drove the session
          // natively — the two-owners-one-session state ADR-0030's acceptance
          // line forbids, under a palette entry whose own description says
          // "automation must relinquish ownership first". The CLI has always
          // called the route (apps/cli/src/commands/session.ts); this surface
          // had drifted to the ungoverned half of the same verb.
          void store.client
            .listSessions({ taskId })
            .then(async (sessions) => {
              const takeOver = latestTakeOver(sessions);
              if (!takeOver) {
                setStatusLine("✗ no resumable session for this task yet");
                return;
              }
              const result = await store.client.takeOverSession(
                takeOver.session.id
              );
              setStatusLine(
                `${result.alreadyOwned ? "already yours" : "taken over"} — automation suspended. Run: ${takeOver.command} · hand it back with the "return session" command`
              );
            })
            .catch(() => setStatusLine("✗ could not take the session over"));
          return;
        }
        if (selected.id === "return-session") {
          setPaletteOpen(false);
          const taskId = selectedTask?.id;
          if (!taskId) {
            setStatusLine("✗ select a task first");
            return;
          }
          // The other half of the round trip. Added WITH the governed
          // take-over above rather than after it: transferring ownership from
          // a surface that cannot transfer it back is a one-way door, and the
          // human would have had to leave the TUI for `muon session return`.
          void store.client
            .listSessions({ taskId })
            .then(async (sessions) => {
              const owned = latestOwnedByHuman(sessions);
              if (!owned) {
                setStatusLine("✗ no session of this task is human-owned");
                return;
              }
              const result = await store.client.returnSession(owned.id);
              const snapshot = result.snapshot;
              const note = snapshot
                ? ` · ${snapshot.dirtyFiles ?? "unknown"} dirty file(s)${
                    snapshot.readinessDegraded
                      ? "; readiness re-check DEGRADED (recorded in the audit row)"
                      : "; vendor readiness re-checked"
                  }`
                : "";
              setStatusLine(
                `${result.alreadyOwned ? "was not taken over" : "returned"} — automation may act again${note}`
              );
            })
            .catch(() => setStatusLine("✗ could not return the session"));
          return;
        }
        if (openForm(selected.id)) {
          return;
        }
        setPaletteOpen(false);
        setFocus("tasks");
        return;
      }
      setPaletteQuery((query) => {
        const edited = editText(query, key, input);
        if (edited !== null && edited !== query) setPaletteIndex(0);
        return edited ?? query;
      });
      return;
    }

    // `/` or `i` focuses the command bar, the prompt-first front door.
    if (input === "/" || input === "i") {
      setCommandFocused(true);
      setCommandValue("");
      return;
    }

    // ADR-0032 D6 — `?` opens the generated keymap. Bound here so it works from
    // the desk; the help mode above owns every key once it is open.
    if (input === "?") {
      setHelpQuery("");
      setHelpOpen(true);
      return;
    }

    // ADR-0032 D2 — tabs. Ordinals never wrap (an out-of-range digit is a
    // no-op, not a jump to the far end); `[`/`]` cycle as a ring.
    if (input >= "1" && input <= "9") {
      setDeskTabs((tabs) => activateTabByOrdinal(tabs, Number(input)));
      return;
    }
    if (input === "]") {
      setDeskTabs((tabs) => cycleTab(tabs, "next"));
      return;
    }
    if (input === "[") {
      setDeskTabs((tabs) => cycleTab(tabs, "prev"));
      return;
    }
    if (input === "x") {
      setDeskTabs((tabs) => {
        const next = closeTab(tabs, tabs.activeId);
        if (next === tabs) {
          setStatusLine("chat and crew stay open — nothing to close here");
        }
        return next;
      });
      return;
    }

    // ADR-0032 D4 — jump to whatever wants a person. Approvals outrank lanes
    // because a filed gate is a decision already waiting; a `done` lane is only
    // a result to read.
    if (input === "o") {
      if (pendingApprovals.length > 0) {
        setFocus("approvals");
        setApprovalIndex(0);
        setStatusLine(
          `${pendingApprovals.length} pending — a/r to decide, evidence opens first`
        );
      } else {
        const index = railAgents.findIndex((agent) =>
          wantsOperator(laneAttention[agent.id] ?? "unknown")
        );
        if (index >= 0) {
          setFocus("lanes");
          setLaneIndex(index);
          setStatusLine(`→ ${railAgents[index]!.id}`);
        } else {
          setStatusLine("nothing needs you");
        }
      }
      return;
    }

    if (input === "q") {
      store.stop();
      exit();
      return;
    }

    if (input === "!") {
      stopAll();
      return;
    }

    if (input === "s" && focus === "lanes") {
      stopSelectedLane();
      return;
    }

    if (focus === "approvals" && input === "A") {
      // The shared constant, not a copy of its value: this path and the review
      // overlay's `A` mint the same receipt, and a literal here would silently
      // diverge the moment the constant moved.
      resolveSelectedApproval("approved", REMEMBER_ACTION_TTL_MS);
      return;
    }
    if (focus === "approvals" && input === "a") {
      resolveSelectedApproval("approved");
      return;
    }
    if (focus === "approvals" && input === "r") {
      resolveSelectedApproval("rejected");
      return;
    }

    if (key.tab) {
      setFocus((current) =>
        nextFocusZone(current, key.shift ? "prev" : "next")
      );
      return;
    }

    // Fleet: Enter on an agent opens its live stream, watch it work.
    if (key.return && focus === "lanes") {
      const agent = railAgents[laneIndex];
      if (agent) {
        setAgentView(agent);
        // ADR-0032 D3 — looking at a lane acknowledges a FINISHED result and
        // nothing else. `resolveAttentionState` is what enforces that, so a
        // lane parked at a gate stays blocked no matter how often it is opened.
        setSeenLanes((seen) =>
          markLaneSeen(seen, agent, snapshot.dispatchJobs)
        );
      } else {
        setStatusLine("✗ no agent selected, muon fleet set to add instances");
      }
      return;
    }

    // Fleet: b opens the active mission's per-descendant budget breakdown
    // (S9 TUI parity, read-only). Always opens — an unknown/poll-fail state
    // renders honestly rather than being a dead end.
    if (input === "b" && focus === "lanes") {
      setBudgetOverlayOpen(true);
      return;
    }

    // Task detail overlay, the interactive `muon report`.
    if (key.return && focus === "tasks" && selectedTask) {
      const taskId = selectedTask.id;
      setStatusLine(`… loading ${taskId}`);
      void Promise.all([
        store.client.getTaskDetail(taskId),
        store.client.listTaskEvents(taskId),
        store.client.recallRelatedToTask(taskId).catch(() => []),
        store.client.listSessions({ taskId }).catch(() => []),
      ])
        .then(([detail, events, memory, sessions]) => {
          setStatusLine(null);
          setTaskDetailView({ detail, events, memory, sessions });
        })
        .catch((error) => {
          setStatusLine(
            `✗ detail failed: ${error instanceof Error ? error.message : "unknown"}`
          );
        });
      return;
    }

    if (input === "j" || key.downArrow) {
      if (focus === "tasks") {
        setTaskIndex((i) =>
          Math.min(Math.max(snapshot.tasks.length - 1, 0), i + 1)
        );
      } else if (focus === "lanes") {
        setLaneIndex((i) =>
          Math.min(Math.max(railAgents.length - 1, 0), i + 1)
        );
      } else if (focus === "approvals") {
        setApprovalIndex((i) =>
          Math.min(Math.max(pendingApprovals.length - 1, 0), i + 1)
        );
      } else if (focus === "handoffs") {
        setHandoffIndex((i) =>
          Math.min(Math.max(snapshot.handoffs.length - 1, 0), i + 1)
        );
      }
      return;
    }

    if (input === "k" || key.upArrow) {
      if (focus === "tasks") {
        setTaskIndex((i) => Math.max(0, i - 1));
      } else if (focus === "lanes") {
        setLaneIndex((i) => Math.max(0, i - 1));
      } else if (focus === "approvals") {
        setApprovalIndex((i) => Math.max(0, i - 1));
      } else if (focus === "handoffs") {
        setHandoffIndex((i) => Math.max(0, i - 1));
      }
    }
  });

  // First-run onboarding: show the connect panel once readiness has been
  // probed and NO vendor is ready yet ("connect" phase). null (not-yet-probed /
  // probe down) and "ready" both hide it, no nagging once an agent is live.
  const onboardingState = buildOnboardingState(snapshot.readiness);
  const hasCompletedTask =
    quickstartCompleted ||
    snapshot.tasks.some((task) => task.status === "done");
  const showOnboardingPanel =
    onboardingState.phase === "connect" ||
    // "unavailable" = the readiness probe itself failed. The panel has a
    // purpose-built degraded branch with MANUAL connect steps for exactly
    // this — hiding it here meant a brand-new user with zero CLIs and a
    // probe outage saw no GET STARTED at all.
    onboardingState.phase === "unavailable" ||
    (onboardingState.anyReady && !hasCompletedTask && snapshot.tasks.length === 0);
  const dispatchSummary = buildDispatchSummary(snapshot, selectedTask);
  const cockpitWidth = Math.max(40, width - 4);
  const compact = budget.profile === "compact";
  const workingCount = snapshot.agents.filter(
    (agent) => agent.status === "working"
  ).length;
  const ambientAttention =
    snapshot.pendingApprovals > 0 || dispatchSummary.degraded;
  const overlayOpen = Boolean(
    paletteOpen ||
      formState ||
      memoryView ||
      brainView ||
      crewOpen ||
      mcpOpen ||
      taskDetailView ||
      workflowView ||
      agentView ||
      budgetOverlayOpen ||
      approvalReview ||
      helpOpen
  );

  // A backgrounded stream tab that went blocked should be visible without
  // switching to it — the tab chip warms instead of staying dim.
  const tabsWantingOperator = useMemo(() => {
    const ids = new Set<string>();
    for (const [agentId, state] of Object.entries(laneAttention)) {
      if (wantsOperator(state)) ids.add(deskTabId("stream", agentId));
    }
    return ids;
  }, [laneAttention]);

  // ADR-0032 D1. Every panel that used to blank the whole cockpit now renders
  // HERE, inside the center region, so the rail and the NEEDS YOU inbox stay on
  // screen while it is open. `centerWidth` is what the panels get; it is the
  // center column, never the terminal, because a panel sized to the terminal
  // would overflow the region it now lives in.
  // While a panel is open the rail collapses to its attention glyphs so the
  // panel has room to render without truncating. It stays MOUNTED — D1 is
  // "never lose sight of the crew", not "always 26 columns". The inbox never
  // collapses: it is the decision surface.
  const panelIsOpen = Boolean(
    paletteOpen ||
      helpOpen ||
      approvalReview ||
      formState ||
      memoryView ||
      brainView ||
      crewOpen ||
      mcpOpen ||
      taskDetailView ||
      workflowView ||
      agentView ||
      budgetOverlayOpen
  );
  const railWidth = panelIsOpen ? 4 : 26;
  const inboxWidth = 30;
  const columnar = layoutMode === "desk" || layoutMode === "columns";
  const centerWidth = Math.max(
    30,
    (columnar ? width - railWidth - inboxWidth : width) - 4
  );

  const centerPanel = paletteOpen ? (
    <CommandPalette
      query={paletteQuery}
      results={paletteResults}
      selectedIndex={paletteIndex}
    />
  ) : helpOpen ? (
    // Chrome above/below the center costs ~10 rows (header, rules, ambient
    // line, status, command bar, footer); the rest is the help's.
    <KeymapHelp
      query={helpQuery}
      width={centerWidth}
      maxRows={Math.max(6, height - 10)}
    />
  ) : approvalReview ? (
    <ApprovalReviewOverlay
      approval={approvalReview}
      certification={approvalReviewCertification}
      certificationError={approvalReviewError}
      resolving={approvalResolving}
      width={centerWidth}
    />
  ) : formState ? (
    <FormPrompt
      form={formState.form}
      values={formState.values}
      fieldIndex={formState.fieldIndex}
      error={formState.error}
      busy={formState.busy}
      hint={formState.hint}
    />
  ) : memoryView ? (
    <MemoryPanel
      title={memoryView.title}
      notes={memoryView.notes}
      selectedIndex={memoryNoteIndex}
      showExpired={memoryView.showExpired}
      workspacePath={memoryView.workspacePath}
      busy={memoryBusy}
      autoConfirmAgentMemory={autoConfirmAgentMemory}
    />
  ) : brainView ? (
    <BrainPanel
      view={brainView}
      selectedProposalIndex={brainProposalIndex}
      proposalText={brainProposalText}
      busy={brainBusy}
    />
  ) : crewOpen ? (
    <CrewPanel
      chatId={crewChatId}
      load={crewLoad}
      busy={crewBusy}
      messageIndex={crewMessageIndex}
    />
  ) : mcpOpen ? (
    <McpPanel load={mcpLoad} busy={mcpBusy} vendorIndex={mcpVendorIndex} />
  ) : taskDetailView ? (
    <TaskDetailOverlay
      detail={taskDetailView.detail}
      events={taskDetailView.events}
      memory={taskDetailView.memory}
      sessions={taskDetailView.sessions}
    />
  ) : workflowView ? (
    <WorkflowPanel runs={workflowView.runs} selectedIndex={workflowIndex} />
  ) : agentView ? (
    <AgentStreamOverlay
      agent={agentView}
      chunks={[...bufferFor(streamBuffers, agentView.id).chunks]}
    />
  ) : budgetOverlayOpen ? (
    <MissionBudgetOverlay view={missionBudget} />
  ) : null;

  // The center's own content when no panel is up: the active tab. `chat` and
  // `desk` coexist as tabs at every width — widening the terminal no longer
  // removes the conversation (the old ternary at 150 cols did exactly that).
  const activeCenterTab = activeTab(deskTabs);
  const centerBody =
    centerPanel ??
    (activeCenterTab.kind === "desk" ? (
      <LaneDesk
        agents={railAgents}
        jobs={snapshot.dispatchJobs}
        tasks={snapshot.tasks}
        events={[...liveEvents, ...snapshot.events]}
        focused={focus === "lanes"}
        selectedIndex={laneIndex}
      />
    ) : (
      <ChatPane
        messages={chatMessages}
        streamingText={chatStreaming}
        busy={commandBusy}
        workspace={process.cwd()}
        maxRows={budget.chat}
      />
    ));

  const rail = panelIsOpen ? (
    <RailCollapsed
      states={snapshot.agents.map(
        (agent) => laneAttention[agent.id] ?? "unknown"
      )}
      taskCount={snapshot.tasks.length}
      width={railWidth}
    />
  ) : (
    <Box flexDirection="column" width={railWidth} flexShrink={0}>
      <FleetRail
        agents={railAgents}
        jobs={snapshot.dispatchJobs}
        focused={focus === "lanes"}
        selectedIndex={laneIndex}
        maxRows={budget.agents}
        compact={compact}
      />
      <Box paddingX={1}>
        <MissionBudgetLine view={missionBudget} compact={compact} />
      </Box>
      <TaskLedger
        tasks={snapshot.tasks}
        focused={focus === "tasks"}
        selectedIndex={taskIndex}
        maxRows={budget.tasks}
      />
    </Box>
  );

  const inbox = (
    <ReviewInbox
      approvals={snapshot.approvals}
      proposalCount={proposalCount}
      memoryReviewCount={brainView?.pendingCount ?? 0}
      width={columnar ? inboxWidth - 1 : width - 2}
      focused={focus === "approvals"}
      selectedIndex={approvalIndex}
      maxRows={budget.approvals}
      compact={compact}
      activeReceipts={snapshot.activeReceipts}
    />
  );

  const handoffs = (
    <HandoffsPanel
      handoffs={snapshot.handoffs}
      focused={focus === "handoffs"}
      selectedIndex={handoffIndex}
      maxRows={budget.handoffs}
    />
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header snapshot={snapshot} layoutMode={layoutMode} />
      <Rule width={width} />
      {/* Diagnostics + hero collapse to a single ambient line while a panel is
          up: the panel needs the rows, and the detail is one `esc` away. The
          RAIL AND INBOX DO NOT COLLAPSE — that is the ADR-0032 D1 invariant. */}
      {centerPanel ? (
        <Box paddingX={1}>
          <Text
            color={ambientAttention ? hub.warn : undefined}
            dimColor={!ambientAttention}
          >
            needs approval {snapshot.pendingApprovals} · crew {workingCount}/
            {snapshot.agents.length} active ·{" "}
            {dispatchSummary.degraded ? "degraded" : "ready"}
          </Text>
        </Box>
      ) : (
        <>
          {/* Hard row cap so an unexpectedly long readiness/error line clips
              instead of pushing CommandBar/Footer past the terminal. */}
          <Box flexDirection="column" flexShrink={0} overflow="hidden" height={6}>
            <DiagnosticsPanel
              snapshot={snapshot}
              width={width - 2}
              compact={compact}
            />
            <DispatchHero summary={dispatchSummary} width={width - 2} />
          </Box>
          {showOnboardingPanel ? (
            <>
              <Rule width={width} />
              <OnboardingPanel
                readiness={snapshot.readiness}
                hasCompletedTask={hasCompletedTask}
                width={Math.min(width - 4, 76)}
              />
            </>
          ) : null}
        </>
      )}
      <Rule width={width} />
      {columnar ? (
        <Box flexGrow={1} flexDirection="row" overflow="hidden">
          {rail}
          <Box
            flexGrow={1}
            minWidth={0}
            flexDirection="column"
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderDimColor
          >
            <TabStrip
              state={deskTabs}
              width={centerWidth}
              attention={tabsWantingOperator}
            />
            <Box flexGrow={1} minHeight={0} overflow="hidden">
              {centerBody}
            </Box>
          </Box>
          <Box
            flexDirection="column"
            width={inboxWidth}
            flexShrink={0}
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderDimColor
          >
            {inbox}
            <Box height={1} />
            {handoffs}
          </Box>
        </Box>
      ) : (
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          <Box flexGrow={1} flexDirection="row" overflow="hidden">
            {rail}
            <Box
              flexGrow={1}
              minWidth={0}
              flexDirection="column"
              borderStyle="single"
              borderLeft
              borderTop={false}
              borderBottom={false}
              borderRight={false}
              borderDimColor
            >
              <TabStrip
                state={deskTabs}
                width={centerWidth}
                attention={tabsWantingOperator}
              />
              <Box flexGrow={1} minHeight={0} overflow="hidden">
                {centerBody}
              </Box>
            </Box>
          </Box>
          <Rule width={width} />
          {inbox}
          {handoffs}
        </Box>
      )}
      {statusLine ? (
        // SANITIZED AT THE RENDER BOUNDARY. This footer carried backend and
        // vendor text verbatim — `error.message` from executeAction, a
        // certification failure, a lane name — and nothing on the way here
        // flattened it. Found on the NEW desk by review; the same hole was
        // here, on the desk that actually ships today. One choke point rather
        // than per-writer patches: this surface has dozens of `setStatusLine`
        // callers and a bounded surface has to cover every one of them.
        // Tone is computed from the SAME sanitized string so the colour
        // matches the text shown. CORRECTED, because the first version of this
        // comment claimed "a control byte cannot pick the colour" and that is
        // backwards: `statusTone` reads only the FIRST character, and
        // `terminalSafe` trims, so a leading control byte that used to make the
        // tone fall through to plain now exposes the SECOND character to the
        // check. That is a real (small) widening, not a narrowing. It is
        // acceptable only because every fully-external writer on this surface
        // leads with MUON's own prose — if one ever leads with vendor text,
        // the tone must be computed from a MUON-authored prefix instead.
        <Box paddingX={1}>
          <Text
            color={statusTone(terminalSafe(statusLine)).color}
            dimColor={statusTone(terminalSafe(statusLine)).dim}
          >
            {terminalSafe(statusLine)}
          </Text>
        </Box>
      ) : null}
      <CommandBar
        value={commandValue}
        focused={commandFocused}
        busy={commandBusy}
        workspace={process.cwd()}
      />
      <Footer paletteOpen={paletteOpen} />
    </Box>
  );
}
