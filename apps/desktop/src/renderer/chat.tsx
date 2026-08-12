import { useEffect, useRef, useState } from "react";
import type {
  ApprovalRequest,
  ObjectiveLoopControl,
  OrchestratorChatRecord,
  VendorReadiness,
} from "@muon/client";
import { defaultCoordinatorVendor, vendorShortLabel } from "@muon/client/vendors";
import {
  emptyHistory,
  reduceChunks,
  settledHistoryChunks,
  type ChatHistory,
} from "../lib/chat-history.js";
import type { SubagentTab } from "../lib/subagent-tabs.js";
import type { OrchestratorVendor } from "../lib/crew-config.js";
import type { BudgetLineView } from "@muon/client/budget-view";
import type { OrchestratorReadinessIssue } from "../lib/orchestrator-readiness.js";
import { resolveComposerSubmitBlocker } from "../lib/composer-submit-blocker.js";
import type { GitNexusIndexStatus } from "../shared/ipc.js";
import type { CrewRoleLaneIpc } from "../shared/ipc.js";
import type { VendorModelCatalog } from "../lib/vendor-models.js";
import type {
  ReadinessSnapshotMeta,
  VendorModelResolutionIpc,
} from "../shared/ipc.js";
import type { LiveChatEntry } from "../lib/live-chat.js";
import { AgentConfigMenu } from "./agent-config-menu.js";
import { ChatTranscript } from "./chat-transcript.js";
import { isNearBottom } from "./lib/stick-scroll.js";
import { ProviderReadinessNotice } from "./provider-readiness-notice.js";
import { OBJECTIVE_LOOP_ENTRY_PROMPT } from "./lib/objective-loop-ui.js";
import { ObjectiveLoopStatusBar } from "./objective-loop-status.js";
import {
  dismissQueuedMessage,
  enqueueComposerMessage,
  takeNextQueuedMessage,
  type QueuedComposerMessage,
} from "../lib/composer-message-queue.js";
import { buildSessionEntryFacts } from "./lib/session-entry-facts.js";

const HISTORY_POLL_MS = 2000;
const HISTORY_PAGE = 500;

// D2: opinionated example prompts for the empty mission chat. Fill the
// composer + focus it — NEVER auto-send, a dispatch is always the human's own
// deliberate act.
const EXAMPLE_PROMPTS = [
  "Fix the failing tests and explain what broke",
  "Add this feature end-to-end, then remember the tricky parts",
  "Show me the impact of changing this before I edit it",
  "Refactor this module for clarity without changing behavior",
];

/** P9 — conversational objective loop entry (composer chip, never auto-send). */
export { OBJECTIVE_LOOP_ENTRY_PROMPT } from "./lib/objective-loop-ui.js";

export type LiveEntry = LiveChatEntry;

type ChatViewProps = {
  chat: OrchestratorChatRecord;
  approvals: ApprovalRequest[];
  running: boolean;
  live: LiveEntry[];
  onSend: (message: string) => Promise<boolean | void> | boolean | void;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => void;
  onLiveSettled: (chatId: string) => void;
  /**
   * The ROOT dispatch job of the turn currently in flight, or null when the
   * chat is idle.
   *
   * It is a BOUNDARY, not a scope. The transcript is scoped to the CHAT — every
   * turn of it, in order (ADR-0024: a mission is a chat, not a turn). This id
   * only marks where the live turn begins, so the persisted rows of that one
   * turn are not printed alongside the optimistic mirror of it while it runs.
   * Optional: without it the poll behaves exactly as it did before (it absorbs
   * nothing new while a turn runs) rather than risking a double-print.
   */
  activeRootJobId?: string | null;
  /**
   * The root the OPTIMISTIC LIVE MIRROR belongs to — the turn the HUMAN
   * started, which outlives `activeRootJobId` whenever the coordinator's
   * crew-contract CORRECTION admits a second root inside the same logical turn
   * (see `pinLiveTurnRoots`). That correction root stamps no row in the stream,
   * so using it as the boundary would find nothing to cut at and absorb the
   * turn the mirror is still rendering — printing it twice for minutes.
   *
   * Takes precedence over `activeRootJobId` when the parent supplies it. Null
   * (no mirror open) falls back to it, which is the pre-existing behavior for
   * a turn this window did not start.
   */
  liveTurnRootJobId?: string | null;
  /**
   * D4: commit a rename (double-click the header title to edit — see
   * ChatHeaderTitle below). Optional so every existing minimal render (tests,
   * harnesses) keeps working with a read-only, non-editable title.
   */
  onRenameChat?: (title: string) => void;
  /**
   * S10: the chat-level default model the orchestrator runs its turns on, and
   * the setter (validated + persisted per-chat by the parent). Optional so the
   * component still renders in minimal harnesses — the picker only mounts when a
   * setter is wired.
   */
  model?: string | null;
  /** Persisted Crew model used when this chat has no explicit override. */
  defaultModel?: string | null;
  onSetModel?: (model: string | null) => void;
  /**
   * Which vendor seats the Mission superagent (settings.crew.orchestratorVendor).
   * Optional so minimal harnesses keep working without a picker.
   */
  orchestratorVendor?: OrchestratorVendor;
  onSetOrchestratorVendor?: (vendor: OrchestratorVendor) => void;
  orchestratorEffort?: string;
  onSetOrchestratorEffort?: (effort: string) => void;
  modelCatalog?: VendorModelCatalog | null;
  modelCatalogLoading?: boolean;
  onRequestModelCatalog?: () => void;
  /** The vendor's own report of the model it will run (null until asked). */
  modelResolution?: VendorModelResolutionIpc | null;
  modelResolving?: boolean;
  /**
   * Ask for the model resolution alone (no catalogue CLI spawn). Fired when the
   * agent trigger takes hover/focus, so the closed composer shows a real model
   * without the operator having to open the menu first.
   */
  onRequestModelResolution?: () => void;
  /** TODO 3.9 — interpreted vendor readiness for the Provider panel. */
  readiness?: VendorReadiness[] | null;
  readinessMeta?: ReadinessSnapshotMeta;
  orchestratorReadinessIssue?: OrchestratorReadinessIssue | null;
  readinessRefreshing?: boolean;
  readinessRefreshError?: string | null;
  onRecheckReadiness?: () => void;
  fallbackOrchestratorVendor?: OrchestratorVendor | null;
  onUseFallbackOrchestrator?: (vendor: OrchestratorVendor) => void;
  /** TODO 3.14 — open Crew settings from the agent config menu. */
  onConfigureAgents?: () => void;
  /** TODO 3.13 — index staleness for the bound workspace. */
  gitnexusStatus?: GitNexusIndexStatus | null;
  /** TODO 3.13 — active mission budget projection (exhausted blocks send). */
  missionBudget?: BudgetLineView | null;
  /** TODO 3.11 — crew lane cost ordinals for provider/model selection. */
  crewLanes?: CrewRoleLaneIpc[] | null;
  crewCostNotice?: string | null;
  onRefreshCrewLanes?: () => void;
  /**
   * Task #124 — this mission's active subagents (jobId-keyed, the
   * orchestrator's own job already excluded by the caller via
   * selectSubagentJobs), rendered as "Open {vendor}" chips in the header so
   * a human can jump straight to any fired subagent's own tab. Optional so
   * every existing minimal render (tests, harnesses) keeps working with no
   * chips shown.
   */
  subagents?: SubagentTab[];
  onOpenSubagent?: (jobId: string) => void;
  /**
   * What the running turn is doing right now — the root job's own
   * `currentActivity`, or its waiting-for-approval state. Shown beside the
   * live dot IN THE COMPOSER while a turn runs. Optional/null: a turn that has
   * not reported an activity yet still gets an honest "Working…", never a
   * blank row and never a claim about work MUON cannot see.
   */
  turnActivity?: string | null;
  /**
   * Stop the running turn. This is the SAME governed call the old banner made
   * (`interruptDispatch` on the mission's root job) with the same fail-safe
   * semantics — only where the control LIVES changed. Omitted until MUON knows
   * which job to stop, and the composer then shows the running state without a
   * stop button rather than offering one that cannot do anything.
   *
   * May return a promise resolving to whether the INTERRUPT CALL ITSELF
   * succeeded (not whether the turn has ended yet — that is `running` going
   * false, tracked separately). A caller that cannot report this may return
   * void, in which case the button behaves as it always has: latched until
   * `running` flips. But when a caller CAN report it and the call fails
   * (brain unreachable, a lease conflict, a transient error), `stopRequested`
   * resets immediately so the control — and Esc — are available again for a
   * retry, instead of a kill switch stuck dead until the turn ends on its own
   * or the app restarts.
   */
  onStopTurn?: () => Promise<boolean> | void;
  /**
   * TODO 7.13 — "Send now" for a queued composer message: steer the root
   * running job. Omitted when no running root is known; the queue strip then
   * still allows dismiss + idle flush via onSend.
   */
  onSteerNow?: (message: string) => Promise<boolean | void> | boolean | void;
  /** P9 — live objective loop status for this chat's task. */
  objectiveLoopStatus?: ObjectiveLoopControl | null;
  onStopObjectiveLoop?: () => Promise<void>;
  onResumeObjectiveLoop?: () => Promise<void>;
};

/**
 * Task #124 — the persistent "Open {vendor}" chip strip in the mission chat
 * header: one chip per subagent this mission has fired. Renders nothing when
 * there are no active subagents (a fresh/idle chat stays exactly as it was)
 * or when the caller didn't wire an open handler (never a dead control).
 */
function SubagentChips(props: {
  subagents: SubagentTab[];
  onOpen?: (jobId: string) => void;
}) {
  const onOpen = props.onOpen;
  if (props.subagents.length === 0 || !onOpen) {
    return null;
  }
  return (
    <div className="subagent-chips" aria-label="Active subagents">
      {props.subagents.map((tab) => (
        <button
          className="subagent-chip"
          key={tab.jobId}
          onClick={() => onOpen(tab.jobId)}
          type="button"
        >
          <span className={`activity-dot ${tab.status}`} aria-hidden="true" />
          Open {vendorShortLabel(tab.vendor)}
        </button>
      ))}
    </div>
  );
}

/**
 * D4 — double-click the mission-chat title to rename it in place. Read-only
 * (renders the plain <h2> unchanged) when `onRename` isn't wired, so no
 * caller loses today's non-editable header. Auto-title (the orchestrator)
 * only ever rewrites a title still literally "New chat", so this is always
 * safe to commit.
 */
function ChatHeaderTitle(props: {
  title: string;
  onRename?: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // The title can change out from under an idle (non-editing) header — e.g.
  // auto-title landing on the first turn — so the seed always tracks it.
  useEffect(() => {
    if (!editing) {
      setDraft(props.title);
    }
  }, [props.title, editing]);

  if (!props.onRename) {
    return <h2>{props.title}</h2>;
  }

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    // Empty-trim keeps the old title — never rename to a blank chat.
    if (trimmed.length === 0 || trimmed === props.title) {
      setDraft(props.title);
      return;
    }
    props.onRename?.(trimmed);
  };

  const cancel = () => {
    setDraft(props.title);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        aria-label="Rename chat"
        className="chat-title-edit"
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  return (
    <h2
      onDoubleClick={() => setEditing(true)}
      title="Double-click to rename"
    >
      {props.title}
    </h2>
  );
}

export function ChatView(props: ChatViewProps) {
  const { chat, running, onLiveSettled } = props;
  const submitBlocker = resolveComposerSubmitBlocker({
    running,
    readinessIssue: props.orchestratorReadinessIssue,
    gitnexus: props.gitnexusStatus,
    budget: props.missionBudget,
  });
  // TODO 7.13 — textarea stays enabled while a turn runs so the human can
  // queue the next message. Only a real blocker (budget/readiness/index)
  // disables input. Idle send still requires !running.
  const inputDisabled = submitBlocker !== null;
  const composerDisabled = running || submitBlocker !== null;
  const [history, setHistory] = useState<ChatHistory>(emptyHistory());
  const [draft, setDraft] = useState("");
  const [messageQueue, setMessageQueue] = useState<QueuedComposerMessage[]>([]);
  const messageQueueRef = useRef<QueuedComposerMessage[]>([]);
  const queueDeliveryRef = useRef<string | null>(null);
  const [queueDeliveryId, setQueueDeliveryId] = useState<string | null>(null);
  const [queueDeliveryError, setQueueDeliveryError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  // Poll cursor, only touched inside async callbacks. It can run ahead of
  // history.lastSeq if a fetch lands mid-unmount; reduceChunks is idempotent
  // so an overlapping page is harmless. The parent keys this component by
  // chat id, so switching chats remounts with a fresh cursor and history.
  const lastSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // D2: example-prompt chips fill the composer via setDraft + focus this ref
  // — they NEVER auto-send.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Follow the live stream only while the user is at/near the bottom. Scrolling
  // up to read history clears this so polls/stream chunks cannot yank them down.
  const stickToBottomRef = useRef(true);
  const prevRunning = useRef(running);
  // Presentation-only latch for the stop control: the click already fired the
  // governed interrupt, so the button says "Stopping…" and stops accepting a
  // second click until the turn actually settles. It is NOT authority — the
  // turn ends when the brain says it ended, not when this flips.
  const [stopRequested, setStopRequested] = useState(false);
  const stopButtonRef = useRef<HTMLButtonElement | null>(null);
  // Set by a send from THIS composer. When the turn starts, the textarea the
  // human was typing in goes disabled and the browser drops focus to <body> —
  // focus must not be lost, so it is handed to the stop control in the same
  // box. That is also what makes "Esc to interrupt" true where it is shown.
  const claimStopFocus = useRef(false);
  const stopTurn = props.onStopTurn;
  const canStopTurn = running && typeof stopTurn === "function";
  const requestStop = () => {
    if (!stopTurn || stopRequested) {
      return;
    }
    setStopRequested(true);
    // The interrupt call is fire-and-forget from here as far as the TURN goes
    // (it ends when the brain says it ended, tracked by `running` below) — but
    // the CALL ITSELF can fail before it ever reaches the brain (unreachable,
    // a 409 lease conflict, a transient 500). If it reports that, unlatch
    // immediately so the button — and Esc — are available again for a retry,
    // rather than staying "Stopping…" forever because `running` never flips.
    try {
      const result = stopTurn();
      if (result && typeof (result as Promise<boolean>).then === "function") {
        void (result as Promise<boolean>).then(
          (ok) => {
            if (ok === false) {
              setStopRequested(false);
            }
          },
          () => {
            setStopRequested(false);
          }
        );
      }
    } catch {
      setStopRequested(false);
    }
  };
  useEffect(() => {
    if (!running && stopRequested) {
      setStopRequested(false);
    }
  }, [running, stopRequested]);
  useEffect(() => {
    if (!canStopTurn || !claimStopFocus.current) {
      return;
    }
    claimStopFocus.current = false;
    stopButtonRef.current?.focus();
  }, [canStopTurn]);

  // Cursor-poll persisted history. It runs DURING a turn too — the mission is
  // the whole chat (ADR-0024), so the turns before this one must be on screen
  // while the current one streams. What is skipped is only the LIVE turn's own
  // rows, which the optimistic mirror is already rendering: `settledHistoryChunks`
  // cuts the page at that turn's first row, and the cursor stops there, so the
  // rest is absorbed normally the moment the turn settles.
  //
  // The boundary is the root the LIVE MIRROR belongs to, and only falls back to
  // "whichever root is active now" when there is no mirror to protect. They
  // differ for exactly one turn shape — the crew-contract correction, which
  // opens a SECOND root inside one logical turn and stamps no row to cut at —
  // and using the active root there absorbs the very rows the mirror is still
  // rendering.
  //
  // Held in a ref, not a dep: the boundary must not restart the poll, and it
  // changes once per turn.
  const liveRootJobIdRef = useRef<string | null>(
    props.liveTurnRootJobId ?? props.activeRootJobId ?? null
  );
  liveRootJobIdRef.current =
    props.liveTurnRootJobId ?? props.activeRootJobId ?? null;
  // The turn whose backfill is COMPLETE: the cursor has reached that turn's
  // first row, so nothing before it is left to load. Without this the poll
  // would re-read the whole live turn — up to a full page — every two seconds
  // and discard all of it, for the entire length of the turn.
  const backfilledRootRef = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    backfilledRootRef.current = null;
    const tick = async () => {
      const liveRoot = liveRootJobIdRef.current;
      if (running && liveRoot && backfilledRootRef.current === liveRoot) {
        return;
      }
      try {
        const chunks = await window.muon.streams({
          taskId: chat.id,
          afterSeq: lastSeqRef.current,
          limit: HISTORY_PAGE,
        });
        if (stopped || chunks.length === 0) {
          return;
        }
        const settled = running ? settledHistoryChunks(chunks, liveRoot) : chunks;
        // Seeing the live turn's first row IS the end of the backfill. A live
        // root we do not know yet never sets this — it keeps polling until the
        // boundary is knowable, which is the fail-closed half of the same rule.
        if (running && liveRoot && settled.length < chunks.length) {
          backfilledRootRef.current = liveRoot;
        }
        if (settled.length === 0) {
          return;
        }
        lastSeqRef.current = settled.reduce(
          (max, chunk) => Math.max(max, chunk.seq),
          lastSeqRef.current
        );
        setHistory((current) => reduceChunks(current, settled));
      } catch {
        // brain offline; the next tick retries
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), HISTORY_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [chat.id, running]);

  // When a turn settles, pull its persisted chunks then drop the optimistic
  // live entries so nothing double-renders.
  useEffect(() => {
    if (prevRunning.current && !running) {
      void (async () => {
        try {
          const chunks = await window.muon.streams({
            taskId: chat.id,
            afterSeq: lastSeqRef.current,
            limit: HISTORY_PAGE,
          });
          if (chunks.length > 0) {
            lastSeqRef.current = chunks.reduce(
              (max, chunk) => Math.max(max, chunk.seq),
              lastSeqRef.current
            );
            setHistory((current) => reduceChunks(current, chunks));
          }
        } catch {
          // keep live entries if the fetch failed, better duplicated than lost
          return;
        }
        onLiveSettled(chat.id);
      })();
    }
    prevRunning.current = running;
  }, [running, chat.id, onLiveSettled]);

  // Autoscroll only while the user is following the bottom of the log.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history, props.live, props.approvals.length]);

  const submit = () => {
    const message = draft.trim();
    if (!message || inputDisabled) {
      return;
    }
    if (running) {
      // TODO 7.13 — queue while busy; never auto-steer on Enter.
      setMessageQueue((current) => enqueueComposerMessage(current, message));
      setDraft("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      return;
    }
    if (composerDisabled) {
      return;
    }
    setDraft("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // The composer is about to lock; keep focus inside it (on the stop).
    claimStopFocus.current = true;
    // A new send always re-pins to the bottom so the reply is visible.
    stickToBottomRef.current = true;
    props.onSend(message);
  };

  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  const deliverQueuedMessage = async (
    entry: QueuedComposerMessage,
    deliver: (message: string) => Promise<boolean | void> | boolean | void
  ): Promise<void> => {
    // State disables the button on the next render; the ref also closes the
    // same-tick double-click window before React has committed that render.
    if (queueDeliveryRef.current) {
      return;
    }
    queueDeliveryRef.current = entry.id;
    setQueueDeliveryId(entry.id);
    setQueueDeliveryError(null);
    try {
      const delivered = await deliver(entry.text);
      if (delivered === false) {
        throw new Error("MUON did not accept the message.");
      }
      setMessageQueue((current) =>
        dismissQueuedMessage(current, entry.id)
      );
    } catch (error) {
      setQueueDeliveryError({
        id: entry.id,
        message:
          error instanceof Error ? error.message : "Message delivery failed.",
      });
    } finally {
      queueDeliveryRef.current = null;
      setQueueDeliveryId(null);
    }
  };

  // Idle flush: when a turn settles, deliver the next queued item as a normal
  // mission message (onSend), not a steer. Remove it only after the control
  // plane accepts it; a failed flush stays visible and retryable.
  const onSend = props.onSend;
  const prevRunningForQueue = useRef(running);
  useEffect(() => {
    const wasRunning = prevRunningForQueue.current;
    prevRunningForQueue.current = running;
    if (!wasRunning || running || inputDisabled) {
      return;
    }
    const { next } = takeNextQueuedMessage(messageQueueRef.current);
    if (next) {
      // Defer so we don't send during the same render as the state flip.
      queueMicrotask(() => void deliverQueuedMessage(next, onSend));
    }
  }, [running, inputDisabled, onSend]);

  const hasContent =
    history.messages.length > 0 || props.live.length > 0 || props.approvals.length > 0;

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header-row">
          <div>
            <span className="conversation-kicker">Mission chat</span>
            <ChatHeaderTitle title={chat.title} onRename={props.onRenameChat} />
          </div>
          <span className="chat-workspace" title={chat.workspacePath}>
            {chat.workspacePath}
          </span>
        </div>
        <SessionEntryFactsStrip
          approvals={props.approvals}
          missionBudget={props.missionBudget}
        />
        <SubagentChips
          subagents={props.subagents ?? []}
          onOpen={props.onOpenSubagent}
        />
      </div>
      <div
        aria-busy={running}
        aria-label="Mission conversation log"
        aria-live="polite"
        className="chat-scroll"
        onScroll={() => {
          const el = scrollRef.current;
          if (el) {
            stickToBottomRef.current = isNearBottom(el);
          }
        }}
        ref={scrollRef}
        role="log"
      >
        {!hasContent && (
          <div className="chat-empty">
            <div className="chat-welcome">
              <h2>What should the crew build?</h2>
              <p>
                Describe the outcome. MUON coordinates the crew and asks when
                it needs you.
              </p>
              <div
                aria-label="Example prompts"
                className="subagent-chips chat-example-chips"
              >
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <button
                    className="subagent-chip"
                    key={prompt}
                    onClick={() => {
                      setDraft(prompt);
                      textareaRef.current?.focus();
                    }}
                    type="button"
                  >
                    {prompt}
                  </button>
                ))}
                <button
                  className="subagent-chip objective-loop-entry-chip"
                  onClick={() => {
                    setDraft(OBJECTIVE_LOOP_ENTRY_PROMPT);
                    textareaRef.current?.focus();
                  }}
                  type="button"
                >
                  Run an objective loop until checks pass
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Pure presentation projection: persisted typed stream rows and the
            optimistic live mirror are grouped without changing authority,
            composer, or stick-scroll semantics. */}
        <ChatTranscript
          history={history.messages}
          live={props.live}
          running={running}
          subagents={props.subagents}
          onOpenSubagent={props.onOpenSubagent}
        />
        {/* The running indicator used to live here AND (as an amber banner) at
            the top of the conversation. There is now exactly one, in the
            composer below — the same place the send action lives, and the only
            spot that stays on screen when the human scrolls back through the
            log. */}
      </div>
      <div
        className="composer"
        onKeyDown={(event) => {
          // Esc-to-interrupt, the terminal idiom. Scoped to the composer's own
          // subtree ON PURPOSE: a window-level Escape here would silently steal
          // the key from the command palette, the agent menu, and every dialog
          // that closes on Escape.
          if (event.key === "Escape" && canStopTurn && !stopRequested) {
            event.preventDefault();
            requestStop();
          }
        }}
      >
        {props.orchestratorReadinessIssue ? (
          <ProviderReadinessNotice
            issue={props.orchestratorReadinessIssue}
            refreshing={props.readinessRefreshing}
            refreshError={props.readinessRefreshError}
            onRefresh={props.onRecheckReadiness}
            fallbackVendor={props.fallbackOrchestratorVendor}
            onUseFallback={props.onUseFallbackOrchestrator}
          />
        ) : null}
        <ObjectiveLoopStatusBar
          status={props.objectiveLoopStatus ?? null}
          onStop={props.onStopObjectiveLoop}
          onResume={props.onResumeObjectiveLoop}
        />
        {running ? (
          // The running turn, stated quietly and IN PLACE: one live dot, what
          // the turn is doing, and (when a stop is actually possible) the
          // keyboard way out. No panel, no border, no warning colour — a turn
          // running is the normal case, not an incident.
          <div className="composer-turn" role="status">
            <span className="dot working" aria-hidden="true" />
            <span className="composer-turn-activity">
              {stopRequested
                ? "Stopping this turn…"
                : (props.turnActivity?.trim() || "Working…")}
            </span>
            {canStopTurn && !stopRequested ? (
              <span className="composer-turn-esc">Esc to interrupt</span>
            ) : null}
          </div>
        ) : null}
        {messageQueue.length > 0 ? (
          <div className="composer-queue" aria-label="Queued messages">
            {messageQueue.map((entry) => (
              <div className="composer-queue-item" key={entry.id}>
                <span className="composer-queue-text" title={entry.text}>
                  Queued: {entry.text}
                </span>
                {running && props.onSteerNow ? (
                  <button
                    className="composer-queue-send-now"
                    disabled={queueDeliveryId !== null}
                    onClick={() =>
                      void deliverQueuedMessage(entry, props.onSteerNow!)
                    }
                    type="button"
                  >
                    {queueDeliveryId === entry.id ? "Sending…" : "Send now"}
                  </button>
                ) : null}
                {!running && queueDeliveryError?.id === entry.id ? (
                  <button
                    className="composer-queue-send-now"
                    disabled={queueDeliveryId !== null}
                    onClick={() => void deliverQueuedMessage(entry, onSend)}
                    type="button"
                  >
                    {queueDeliveryId === entry.id ? "Retrying…" : "Retry"}
                  </button>
                ) : null}
                <button
                  aria-label="Dismiss queued message"
                  className="composer-queue-dismiss"
                  disabled={queueDeliveryId === entry.id}
                  onClick={() =>
                    setMessageQueue((current) =>
                      dismissQueuedMessage(current, entry.id)
                    )
                  }
                  type="button"
                >
                  Dismiss
                </button>
                {queueDeliveryError?.id === entry.id ? (
                  <span className="composer-queue-error" role="status">
                    Not sent: {queueDeliveryError.message}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-box">
          <textarea
            aria-describedby="composer-hint"
            aria-label="Message to MUON"
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={inputDisabled}
            placeholder={
              running
                ? "Queue a follow-up… Enter queues · Send now steers"
                : "Plan, search, build anything…"
            }
            onChange={(event) => {
              setDraft(event.target.value);
              const el = event.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              {props.onSetOrchestratorVendor &&
              props.onSetModel &&
              props.onSetOrchestratorEffort ? (
                <AgentConfigMenu
                  disabled={running}
                  vendor={props.orchestratorVendor ?? defaultCoordinatorVendor()}
                  defaultModel={props.defaultModel}
                  model={props.model ?? null}
                  effort={props.orchestratorEffort ?? "medium"}
                  catalog={props.modelCatalog ?? null}
                  catalogLoading={props.modelCatalogLoading}
                  modelResolution={props.modelResolution ?? null}
                  modelResolving={props.modelResolving}
                  onChangeVendor={props.onSetOrchestratorVendor}
                  onChangeModel={props.onSetModel}
                  onChangeEffort={props.onSetOrchestratorEffort}
                  onOpen={props.onRequestModelCatalog}
                  onRequestModelResolution={props.onRequestModelResolution}
                  readiness={props.readiness}
                  readinessMeta={props.readinessMeta}
                  onRefreshReadiness={props.onRecheckReadiness}
                  onConfigureAgents={props.onConfigureAgents}
                  crewLanes={props.crewLanes}
                  crewCostNotice={props.crewCostNotice}
                  onRefreshCrewLanes={props.onRefreshCrewLanes}
                />
              ) : null}
            </div>
            {submitBlocker ? (
              <span
                className="composer-submit-blocker"
                role="status"
                title={submitBlocker.detail}
              >
                {submitBlocker.message}
              </span>
            ) : null}
            {canStopTurn ? (
              // The stop control takes the SEND SLOT while a turn runs — the
              // one place a human already looks for "the button that acts on
              // this box". Same size, same shape, quiet outline instead of the
              // filled send: unmistakably stop, and never alarm-coloured.
              <button
                aria-label="Stop this turn"
                className="composer-stop"
                disabled={stopRequested}
                onClick={requestStop}
                ref={stopButtonRef}
                title="Stop this turn (Esc)"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <rect fill="currentColor" height="7" rx="1.5" width="7" x="4.5" y="4.5" />
                </svg>
              </button>
            ) : (
              <button
                aria-label={running ? "Queue message" : "Send"}
                className="composer-send"
                disabled={inputDisabled || draft.trim().length === 0}
                onClick={submit}
                title={running ? "Queue while the turn is busy" : "Send"}
                type="button"
              >
                <svg
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.25"
                  viewBox="0 0 16 16"
                >
                  <path d="M8 12.5V3.5" />
                  <path d="M4.5 7 8 3.5 11.5 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <span className="hint" id="composer-hint">
          {running
            ? "Turn running — Enter queues · Send now steers the root job · Esc stops · ⌘K commands"
            : submitBlocker
              ? "Fix the blocker above to send."
            : "Enter to send · Shift+Enter for a new line · ⌘K commands · /model <id>"}
        </span>
      </div>
    </>
  );
}

/** G6 — compact audit strip under the mission title. No placeholder chrome. */
function SessionEntryFactsStrip(props: {
  approvals: readonly ApprovalRequest[];
  missionBudget?: BudgetLineView | null;
  lastFindingSummary?: string | null;
}) {
  const facts = buildSessionEntryFacts({
    approvals: props.approvals,
    missionBudget: props.missionBudget,
    lastFindingSummary: props.lastFindingSummary,
  });
  if (facts.length === 0) return null;
  return (
    <ul aria-label="Session status" className="session-entry-facts">
      {facts.map((fact) => (
        <li
          className={`session-entry-fact session-entry-fact-${fact.tone}`}
          key={fact.id}
        >
          <span className="session-entry-fact-dot" aria-hidden="true" />
          <span>{fact.label}</span>
        </li>
      ))}
    </ul>
  );
}
