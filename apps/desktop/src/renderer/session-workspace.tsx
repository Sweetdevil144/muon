import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  terminalTakeoverVendorIds,
  vendorLabel as registryVendorLabel,
} from "@muon/client/vendors";
import {
  VENDOR_CAPABILITY_DESCRIPTORS,
  buildVendorActionMenu,
  type GatePolicy,
  type InvocationChannel,
  type InvocationMode,
  type VendorKey,
} from "@muon/adapters/vendor-capabilities";
// A SUBPATH, never the `@muon/client` barrel: this is the renderer, and a
// runtime-value import through the barrel drags index → config → paths →
// `node:fs`/`node:os`/`node:child_process`, which esbuild cannot resolve for a
// browser bundle — `npm run build:renderer` fails outright while vitest stays
// green (it runs in Node, where they resolve). `@muon/protocol` itself is not
// a desktop dependency and does not resolve here either; this pure module is
// the renderer-safe route to the ONE stripper, which lives with the marker it
// strips (@muon/protocol) and is re-exported here.
import { withoutBudgetMarker } from "@muon/client/crew-liveness";
import type {
  AgentRecord,
  ApprovalRequest,
  DispatchJobRecord,
  LoopRunRecord,
  RecordedEvent,
  StreamChunk,
  VendorReadiness,
} from "@muon/client";
import { describeLoopProgress, loopForJob } from "../lib/loop-status.js";
import {
  buildSessionGovernance,
  type SessionGate,
} from "@muon/client/session-governance";
import type {
  JobResumeProbe,
  ReviewDiffResponse,
  VendorModelResolutionIpc,
  WorkspaceReview,
} from "../shared/ipc.js";
import { resolveAgentTerminalMode } from "../lib/agent-terminal-mode.js";
import { jobTerminalAttachId } from "../lib/job-terminal-attach.js";
import { agentConsoleGrid } from "./lib/agent-console-grid.js";
import { JobStreamTerminal } from "./job-stream-terminal.js";
import { modelDisplay } from "./lib/model-label.js";
import { ReviewDiffEvidence } from "./review-diff-evidence.js";
import { ReviewGateActions, useGateDecision } from "./review-gate.js";
import { VendorIcon } from "./vendor-icon.js";

/**
 * Stream cadence, split by whether the agent is still WORKING. While the job
 * runs the pane is the way a human watches the agent work, so the poll runs
 * sub-second — the feed then reads as live, which it is (each tick returns
 * only chunks after the last consumed seq, so the fast cadence costs almost
 * nothing when the agent is quiet). A finished job's feed no longer changes;
 * it settles to a slow refresh instead of hammering the brain forever.
 */
const SESSION_POLL_ACTIVE_MS = 700;
const SESSION_POLL_SETTLED_MS = 2_500;
const SESSION_CHUNK_LIMIT = 500;

/**
 * How the takeover probe waits out a vendor that has not saved this job's
 * session yet, and how long it is willing to wait.
 *
 * BOUNDED ON PURPOSE. Each attempt costs a job read plus a walk of the
 * vendor's own session store in trusted main, so this is not a poll that may
 * run forever: it re-asks only while main itself says the refusal is a "not
 * yet" (JobResumeProbe.pending), and only this many times. The measured
 * window it exists to cover is small — a `codex exec` rollout appeared about
 * 3 seconds into a run — and 40 seconds is a wide margin over it. Past that
 * the pane stops asking and offers the human an explicit re-check instead of
 * quietly hammering the store for the rest of a long job.
 */
const RESUME_PROBE_PENDING_INTERVAL_MS = 2_000;
const RESUME_PROBE_PENDING_RETRIES = 20;

type SessionSection =
  | "overview"
  | "timeline"
  | "terminal"
  | "changes"
  | "tools"
  | "capabilities"
  | "commands"
  | "audit";

const SECTIONS: Array<{ id: SessionSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "changes", label: "Changes" },
  { id: "tools", label: "Tools" },
  { id: "capabilities", label: "Capabilities" },
  { id: "commands", label: "Commands" },
  { id: "audit", label: "Audit" },
];

/**
 * A1 — display names for the tab strip.
 *
 * WAVE D: managed lanes come from the registry. The table below is the desktop's
 * SEPARATE takeover/attach namespace (ADR-0022 §8) — ids with no adapter, no
 * authority, and no registry entry — kept distinct on purpose so the two
 * keyspaces cannot merge by accident. An id in neither still renders as its own
 * raw id rather than blank.
 *
 * DISJOINTNESS IS NOW LOCKED, not accidental: the drift-lock
 * (backend/tests/vendor-registry-drift.test.ts) fails if any key here is also
 * a registry vendor id. That lock is what made granting `opencode` terminal
 * takeover safe — the id left this table when it became a managed lane, and
 * it can never quietly re-enter both keyspaces at once.
 */
const ATTACH_NAMESPACE_LABELS: Record<string, string> = {
  copilot: "Copilot",
  amp: "Amp",
  gemini: "Gemini",
  vibe: "Vibe",
};

function vendorLabel(vendor: string): string {
  return ATTACH_NAMESPACE_LABELS[vendor] ?? registryVendorLabel(vendor);
}

function authorityLabel(mode?: string | null): string {
  if (mode === "orchestrator") return "Coordinator";
  if (mode === "delegate") return "Work only";
  return "Worker";
}

/** Present the raw job/agent status enum as operator language. */
function statusLabel(status?: string | null): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Working";
    case "done":
      return "Done";
    case "failed":
      return "Needs attention";
    case "interrupted":
      return "Stopped";
    default:
      return status ?? "Unknown";
  }
}

/**
 * S10: the model MUON dispatched this session with. Read from the validated
 * `actionProfilePatch.model` the dispatch route persisted (an explicit
 * per-dispatch model, or the chat-level default the orchestrator applied).
 *
 * U2: this now returns `null` — not the string "Vendor default" — when MUON
 * named no model. "MUON named none" is a fact about MUON, not an answer to
 * "what is this agent running on"; the caller asks the VENDOR for that and
 * `modelDisplay` turns both answers into one honest label.
 */
function dispatchedModel(job: DispatchJobRecord | null): string | null {
  const patch = job?.actionProfilePatch as { model?: unknown } | null | undefined;
  const model = patch?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

function gateLabel(gate: GatePolicy): string {
  switch (gate) {
    case "none":
      return "No extra approval";
    case "dispatch-gate":
      return "Approval before start";
    case "egress-gate":
      return "Approval before network access";
    case "fail-closed-interpose":
      return "Approval before each action";
    case "refuse":
      return "Blocked";
    case "warn":
      return "Review warning";
  }
}

function channelLabel(channel: InvocationChannel): string {
  switch (channel.kind) {
    case "profileField":
      return "Session profile";
    case "flag":
      return "Validated CLI arguments";
    case "subcommand":
      return "CLI subcommand";
    case "promptPrefix":
      return "Prompt translation";
    case "sessionSlash":
      return "Live slash command";
    case "mcp":
      return "MCP tool";
  }
}

function MetaRows(props: {
  /** `[label, value, tone?, title?]` — `title` is hover provenance, never copy. */
  rows: Array<
    | [string, string | number | null | undefined]
    | [string, string | number | null | undefined, "mono" | undefined]
    | [string, string | number | null | undefined, "mono" | undefined, string]
  >;
}) {
  return (
    <dl className="session-meta-grid">
      {props.rows.map(([label, value, tone, title]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd
            className={tone === "mono" ? "mono" : undefined}
            {...(title ? { title } : {})}
          >
            {value ?? "Not available"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Wave 4.1 — the inline, FAIL-CLOSED governance gate for this agent tab. Its whole
 * point is co-location: the pending decision surfaces WHERE the agent works, and is
 * DECIDED there — three actions, no navigation, no modal in the way.
 *
 * It creates no authority. Every button routes into the one governed
 * `resolveApproval` path the dock and the TUI already use, so content-binding,
 * single-use, and the receipt mint stay owned by the server. It renders nothing
 * when no decision is pending, so a calm tab stays calm.
 */
function SessionGovernanceBanner(props: {
  gates: SessionGate[];
  headline: string;
  /** Full Auto is ON, yet these gates still need the human — the foot says why. */
  fullAuto?: boolean;
  /** Optional so a missing handler NEVER hides a pending gate (fail-closed): the
   *  gate stays visible and points the operator at the review rail instead. */
  onReview?: (approvalId: string) => void;
  /**
   * The governed decision. Optional for the same fail-closed reason: without it
   * the gate degrades to "Review & decide" (or a plain instruction) instead of
   * vanishing.
   */
  onResolve?: (
    approvalId: string,
    status: "approved" | "rejected",
    receiptTtlMs?: number
  ) => void | Promise<void>;
}) {
  const onReview = props.onReview;
  return (
    <section
      className="session-gate"
      role="region"
      aria-label="Pending decision for this agent"
    >
      <div className="session-gate-head">
        <span className="session-gate-kicker">Needs your decision</span>
        {/* Announce the headline calmly on change (polling refresh) without an
            alert role re-reading the buttons on every poll. */}
        <strong aria-live="polite">{props.headline}</strong>
      </div>
      <ul className="session-gate-list">
        {props.gates.map((gate) => (
          <SessionGateItem
            key={gate.approvalId}
            gate={gate}
            onResolve={props.onResolve}
            onReview={onReview}
          />
        ))}
      </ul>
      <div className="session-gate-foot">
        <span>
          {props.fullAuto
            ? // Full Auto is ON and this gate STILL needs the human — say why,
              // so the toggle's promise and the prompt never contradict.
              "Full Auto could not grant this one, so it stays fail-closed: this agent is paused until you decide."
            : "Fail-closed — this agent stays paused until you decide. Nothing runs on your behalf."}
        </span>
      </div>
    </section>
  );
}

/**
 * One pending gate: evidence as copy, decision as exactly three buttons.
 *
 * A `merge` gate is the one exception — approving it requires the worktree
 * review certification (and, when REVIEW BLIND, an artifact attestation), which
 * only the evidence dialog can gather. Offering three buttons there would mean
 * offering an Approve MUON must refuse, so it routes instead.
 */
function SessionGateItem(props: {
  gate: SessionGate;
  onReview?: (approvalId: string) => void;
  onResolve?: (
    approvalId: string,
    status: "approved" | "rejected",
    receiptTtlMs?: number
  ) => void | Promise<void>;
}) {
  const gate = props.gate;
  const onResolve = props.onResolve;
  const { busy, error, decide } = useGateDecision((status, receiptTtlMs) =>
    onResolve
      ? // Two-arg call when nothing is remembered keeps the governed payload
        // byte-identical to the plain approve path.
        receiptTtlMs === undefined
        ? onResolve(gate.approvalId, status)
        : onResolve(gate.approvalId, status, receiptTtlMs)
      : undefined
  );
  const decidableInline = gate.kind !== "merge" && Boolean(onResolve);
  return (
    <li className="session-gate-item">
      <div className="session-gate-copy">
        <strong>{gate.review.action}</strong>
        <span className="session-gate-scope">{gate.review.scope}</span>
        {/* The agent's stated reason — shown as quoted DATA, never an
            instruction the operator acts on directly. */}
        <small className="session-gate-reason">“{gate.reason}”</small>
        <small className="session-gate-authority">{gate.review.authority}</small>
        {gate.review.degraded && gate.review.degradationReason ? (
          <small className="session-gate-degraded">
            {gate.review.degradationReason}
          </small>
        ) : null}
        {decidableInline ? (
          <ReviewGateActions
            busy={busy}
            error={error}
            onDecide={decide}
            review={gate.review}
          />
        ) : null}
      </div>
      {decidableInline ? null : props.onReview ? (
        <button
          className="session-gate-review"
          onClick={() => props.onReview?.(gate.approvalId)}
          type="button"
        >
          Review &amp; decide
        </button>
      ) : (
        <small className="session-gate-authority">
          Decide from the review panel.
        </small>
      )}
    </li>
  );
}

/**
 * P0-1 — the SAME filed gates, told truthfully when Full Auto is on.
 *
 * With standing consent the request is not a human pause: MUON is about to
 * resolve it on the operator's behalf through the same governed path a click
 * uses. The card therefore stays VISIBLE (hiding it would be the opposite lie,
 * and the grant is a real governance event the operator is entitled to watch)
 * but drops the blocking language and the decide button — there is nothing here
 * for the human to do. If the grant is refused or does not land, the gate moves
 * back into SessionGovernanceBanner above and reads fail-closed again.
 */
function SessionAutoApproveBanner(props: {
  gates: SessionGate[];
  headline: string;
}) {
  return (
    <section
      className="session-gate session-gate-auto"
      role="region"
      aria-label="Approving automatically for this agent"
    >
      <div className="session-gate-head">
        <span className="session-gate-kicker">Approving for you</span>
        <strong aria-live="polite">{props.headline}</strong>
      </div>
      <ul className="session-gate-list">
        {props.gates.map((gate) => (
          <li key={gate.approvalId} className="session-gate-item">
            <div className="session-gate-copy">
              <strong>{gate.review.action}</strong>
              <span className="session-gate-scope">{gate.review.scope}</span>
              {/* The agent's stated reason — quoted DATA, never an instruction. */}
              <small className="session-gate-reason">“{gate.reason}”</small>
              <small className="session-gate-authority">
                {gate.review.authority}
              </small>
            </div>
          </li>
        ))}
      </ul>
      <div className="session-gate-foot">
        <span>
          Full Auto is on, so MUON approved this as you — through the same
          governed path your click uses, and recorded in the audit trail. Turn
          Full Auto off to decide these yourself.
        </span>
      </div>
    </section>
  );
}

export function SessionWorkspace(props: {
  agent: AgentRecord;
  job: DispatchJobRecord | null;
  taskTitle: string;
  events: RecordedEvent[];
  readiness: VendorReadiness[] | null;
  /**
   * Wave 4.1 — pending approvals in scope; the banner selects only the gate(s)
   * bound to THIS agent's job/task (fail-closed, content-bound). Defaults to
   * none so callers that don't wire governance render a calm tab.
   */
  approvals?: ApprovalRequest[];
  /**
   * P0-1 — Full-Auto standing consent as `DesktopState` reports it. Purely a
   * choice of which true sentence to show: it grants nothing. The calm
   * "approving automatically" sentence needs an id POSITIVELY listed on
   * `fullAutoCoveredApprovalIds`; anything else — uncovered or simply not yet
   * classified — stays the fail-closed prompt.
   */
  fullAuto?: boolean;
  fullAutoCoveredApprovalIds?: string[];
  fullAutoUncoveredApprovalIds?: string[];
  /**
   * Live + recent governed loops (`DesktopState.loopRuns`). Used only to say
   * which iteration a `loop` job is on and what the last one concluded —
   * a bare "Working" cannot distinguish an iterating agent from a hung one.
   * Optional so callers/tests that don't wire it render exactly as before.
   */
  loopRuns?: LoopRunRecord[];
  /**
   * Opens the evidence dialog for this gate (sets focusApprovalId). Still the
   * route for a `merge` gate, whose approval needs the worktree review
   * certification the inline card cannot gather.
   */
  onReviewApproval?: (approvalId: string) => void;
  /**
   * The ONE governed decision path (app.tsx → `window.muon.resolveApproval`),
   * shared with the dock rail and the TUI. `receiptTtlMs` rides only when the
   * operator pressed "Approve, don't ask again" — it is the existing
   * content-bound receipt opt-in, never a second consent mechanism.
   */
  onResolveApproval?: (
    approvalId: string,
    status: "approved" | "rejected",
    receiptTtlMs?: number
  ) => void | Promise<void>;
  /**
   * Opens the full pre-edit brain (auto-scoped to the active task). Accepted
   * for call-site compatibility; the gate itself no longer renders a
   * navigation control — three decisions, and the evidence is on the card.
   */
  onOpenBrain?: () => void;
  /**
   * S8: which section this session opens on. Crew-rail / running-agent opens
   * pass "timeline" so a click lands on the live stream immediately, like
   * opening a chat — defaults to "overview" for every other call site.
   */
  initialSection?: SessionSection;
  /**
   * Wave 4 §5.0.3 — feature-guarded live terminal tab (fake echo driver for now).
   * OFF by default so the proven cockpit is untouched; a caller opts in until the
   * terminal-native pivot is ready to become the default body.
   */
  terminalPreview?: boolean;
  /**
   * This whole pane is BACKGROUNDED — another workspace tab is on screen. The
   * parent renders it hidden rather than unmounting it whenever it holds a
   * live takeover pty (see `onTakeoverOpenChange`); this is what the terminal
   * body needs in order to re-measure on the way back.
   */
  hidden?: boolean;
  /**
   * This pane's Terminal body now holds (or no longer holds) a live vendor
   * takeover. The parent keeps the pane MOUNTED while it does — unmounting it
   * strands a pty the human is typing into. See JobStreamTerminal's prop of
   * the same name for the full failure it prevents.
   */
  onTakeoverOpenChange?: (open: boolean) => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SessionSection>(
    props.initialSection ?? "overview"
  );
  // The live terminal tab is additive + last, and only when explicitly enabled.
  const sections = props.terminalPreview
    ? [...SECTIONS, { id: "terminal" as const, label: "Terminal" }]
    : SECTIONS;
  // Does the Terminal body currently hold a live takeover pty? Kept HERE as
  // well as reported upward, because this pane has its own unmount door: the
  // section tabs. A fork must survive a click on Timeline exactly as it must
  // survive a click on another workspace tab.
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const notifyTakeoverOpen = props.onTakeoverOpenChange;
  const handleTakeoverOpenChange = useCallback(
    (open: boolean) => {
      setTakeoverOpen(open);
      notifyTakeoverOpen?.(open);
    },
    [notifyTakeoverOpen]
  );
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  // U1: the Terminal body is the job's own stream, so a read failure must be
  // visible there rather than swallowed into a blank panel.
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamLoading, setStreamLoading] = useState(false);
  const [workspaceReview, setWorkspaceReview] =
    useState<WorkspaceReview | null>(null);
  const [reviewDiff, setReviewDiff] = useState<ReviewDiffResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  // U2: the vendor's own report of the model it runs, asked for only when this
  // job carries no explicit model (otherwise the dispatch record is the answer).
  const [modelResolution, setModelResolution] =
    useState<VendorModelResolutionIpc | null>(null);
  const [modelResolving, setModelResolving] = useState(false);
  const lastSeqRef = useRef(0);
  const jobId = props.job?.id;
  // Read by the self-scheduling poll below WITHOUT being an effect dep: a
  // status flip must change the cadence, not reset the accumulated stream
  // (the effect resets chunks and the cursor whenever it re-runs).
  const followingRef = useRef(false);
  followingRef.current = props.job
    ? ["queued", "running"].includes(props.job.status ?? "")
    : false;

  useEffect(() => {
    // Task #124 — resolve fresh by jobId on EVERY change, not only when jobId
    // goes null→set: tabs are now jobId-keyed, and a runner can reuse the
    // same agent slot for a DIFFERENT dispatch (e.g. switching tabs between
    // two jobs on the same agent without an intervening remount). Without
    // this unconditional reset, switching straight from one job to another
    // on the same agent id would keep the previous job's chunks/cursor and
    // silently mix two subagents' streams together.
    setChunks([]);
    setStreamError(null);
    lastSeqRef.current = 0;
    if (!jobId) {
      setStreamLoading(false);
      return;
    }
    setStreamLoading(true);
    let stopped = false;
    const tick = async () => {
      try {
        const next = await window.muon.streams({
          runId: jobId,
          afterSeq: lastSeqRef.current,
          limit: SESSION_CHUNK_LIMIT,
        });
        if (stopped) return;
        setStreamLoading(false);
        setStreamError(null);
        if (next.length === 0) return;
        lastSeqRef.current = Math.max(
          lastSeqRef.current,
          ...next.map((chunk) => chunk.seq)
        );
        setChunks((current) => [...current, ...next].slice(-SESSION_CHUNK_LIMIT));
      } catch (error) {
        // The surrounding Doctor strip owns the recovery action, but the
        // Terminal section renders this stream AS its body — a silent catch
        // there would be an unexplained blank panel.
        if (stopped) return;
        setStreamLoading(false);
        setStreamError(
          error instanceof Error
            ? error.message
            : "MUON could not read this job's stream."
        );
      }
    };
    // Self-scheduling rather than a fixed interval, so the cadence tracks the
    // job's life without re-running this effect (which would wipe the stream):
    // sub-second while the agent works, settled once it has finished.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        await tick();
        schedule();
      }, followingRef.current ? SESSION_POLL_ACTIVE_MS : SESSION_POLL_SETTLED_MS);
    };
    void tick().then(schedule);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (section !== "changes" || !jobId) return;
    let stopped = false;
    // ROADMAP 4.1b: the governed-evidence lane — map the diff to affected flows,
    // fail-closed. Runs alongside the raw-diff review; it is the headline surface.
    void window.muon
      .reviewDiff({ jobId })
      .then((impact) => {
        if (!stopped) setReviewDiff(impact);
      })
      .catch((error) => {
        if (!stopped) {
          setReviewDiff({
            status: "degraded",
            reason:
              error instanceof Error
                ? error.message
                : "Impact evidence is unavailable.",
          });
        }
      });
    setReviewLoading(true);
    void window.muon
      .workspaceReview({
        jobId,
        chatId: props.job?.chatId ?? undefined,
      })
      .then((review) => {
        if (!stopped) setWorkspaceReview(review);
      })
      .catch((error) => {
        if (!stopped) {
          setWorkspaceReview({
            status: "degraded",
            reason:
              error instanceof Error
                ? error.message
                : "Workspace review is unavailable.",
            action:
              "Inspect the timeline and terminal artifact, then retry.",
          });
        }
      })
      .finally(() => {
        if (!stopped) setReviewLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [jobId, props.job?.chatId, props.job?.status, section]);

  // U2 — ask the vendor which model it will run, but only when MUON named
  // none: an explicit dispatch model is already the answer, and the probe is a
  // real subprocess. Main caches + single-flights it, so N open tabs on the
  // same vendor cost one probe.
  const explicitModel = dispatchedModel(props.job);
  const agentVendor = props.agent.vendor;
  useEffect(() => {
    if (explicitModel) {
      setModelResolution(null);
      setModelResolving(false);
      return;
    }
    const resolve = window.muon?.resolveVendorModel;
    if (!resolve) {
      setModelResolution(null);
      setModelResolving(false);
      return;
    }
    let stopped = false;
    setModelResolving(true);
    void resolve(agentVendor as Parameters<typeof resolve>[0])
      .then((resolution) => {
        if (!stopped) setModelResolution(resolution);
      })
      .catch(() => {
        if (!stopped) setModelResolution(null);
      })
      .finally(() => {
        if (!stopped) setModelResolving(false);
      });
    return () => {
      stopped = true;
    };
  }, [agentVendor, explicitModel]);

  const vendor = props.agent.vendor as VendorKey;
  const descriptor = VENDOR_CAPABILITY_DESCRIPTORS[vendor];
  const invocationMode: InvocationMode =
    props.job?.kind === "session" ? "interactive" : "one-shot";
  const commandRows = useMemo(
    () =>
      buildVendorActionMenu({
        readiness: props.readiness,
        vendor,
        mode: invocationMode,
      }).map((item) => ({
        item,
        action: descriptor?.actions.find(
          (candidate) => candidate.id === item.actionId
        ),
      })),
    [descriptor, invocationMode, props.readiness, vendor]
  );
  const readiness = props.readiness?.find(
    (entry) => entry.vendor === props.agent.vendor
  );
  const jobEvents = props.events.filter(
    (event) => event.taskId === props.job?.taskId
  );
  // Wave 4.1: the fail-closed gate(s) bound to THIS agent, co-located at the tab.
  const loopLine = describeLoopProgress(
    loopForJob(props.loopRuns, props.job?.id ?? null)
  );
  const governance = buildSessionGovernance({
    job: props.job,
    approvals: props.approvals ?? [],
    fullAuto: {
      enabled: props.fullAuto === true,
      coveredApprovalIds: props.fullAutoCoveredApprovalIds ?? [],
      uncoveredApprovalIds: props.fullAutoUncoveredApprovalIds ?? [],
    },
  });

  const model = modelDisplay({
    explicitModel,
    vendor: props.agent.vendor,
    resolution: modelResolution,
    ...(modelResolving ? { resolving: true } : {}),
  });

  // U1 — what this tab's Terminal IS. Never a spawn decision: the resolver has
  // no branch that starts a process.
  //
  // 0038 — the live half is now REAL. `ptySessionId` is stamped by the brain on
  // the first console byte the runner relays, so a non-null value means MUON
  // actually observed this job's vendor child printing — not merely that a pane
  // could be opened. `jobTerminalAttachId` re-derives it from the job's own id
  // and refuses anything else, so a malformed or foreign coordinate degrades to
  // the recorded stream instead of mounting a mislabelled pane.
  //
  // NULL IS THE COMMON, HONEST CASE and must stay comfortable: claude-code runs
  // through the in-process Agent SDK (MUON never owns that child's stdio), and
  // `codex` in session/auto kind speaks a protocol channel rather than a
  // console. Those tabs show the recorded stream, labelled as a recording.
  const liveSessionId = jobTerminalAttachId(props.job);
  // Vendors with no human pty console (cursor/opencode/claude-code) still
  // stamp ptySessionId from pipe onBytes. Prefer the ledger activity feed so
  // the Terminal tab renders the run, not raw cursor-agent JSON.
  const preferActivityFeed = agentConsoleGrid(props.agent.vendor) === null;
  // The live pane told us there is nothing to attach to after all. Recorded
  // from here, WITH the reason — a fallback the human cannot see the cause of
  // is indistinguishable from a bug.
  const [liveDegraded, setLiveDegraded] = useState<string | null>(null);
  useEffect(() => {
    // A new job — or the same job re-running under a new epoch — deserves a
    // fresh attempt; a stale degrade must never suppress a live console that
    // now exists.
    setLiveDegraded(null);
  }, [jobId, liveSessionId]);
  const terminalMode = resolveAgentTerminalMode({
    job: props.job
      ? { id: props.job.id, status: props.job.status ?? null }
      : null,
    liveSessionId: liveDegraded ? null : liveSessionId,
    preferActivityFeed,
    recordedChunks: chunks.length,
    loading: streamLoading,
  });
  // Only a vendor the registry grants terminal takeover can be spawned at all.
  // Offering the button for any other vendor would be a control that fails on
  // click — main refuses the kind, correctly, and the human learns nothing.
  const spawnKind = (
    terminalTakeoverVendorIds() as readonly string[]
  ).includes(props.agent.vendor)
    ? props.agent.vendor
    : null;
  // BACKLINK TAKEOVER: meaningful as soon as the runner has stamped the
  // vendor's own session id on the job — INCLUDING while it runs. A running
  // job is granted a FORK, never a resume (terminal-workspace-resolver.ts
  // decides that host-side, from the job's own status), so "two writers on one
  // transcript" stays impossible while the human still gets a live keyboard.
  // Vendors without a takeover-able CLI session (cursor, opencode) never offer
  // it; main's probe is the authority either way.
  const resumableVendor =
    spawnKind === "claude-code" || spawnKind === "codex" ? spawnKind : null;
  const jobStatus = props.job?.status ?? null;
  const resumeVendorSessionId = resumableVendor
    ? props.job?.vendorSessionId ?? null
    : null;
  // DEAD-BUTTON GUARD: the resume affordance renders only after trusted main
  // verifies — via the exact lookup the spawn is authorized by, including the
  // vendor's own session store — that the door would actually open. `null`
  // (no recorded session, probe in flight, or an old bridge) renders no
  // button; an `unavailable` answer renders its reason in the button's place.
  const [resumeProbe, setResumeProbe] = useState<JobResumeProbe | null>(null);
  // The human's explicit "check again", for the case the bounded retry budget
  // below ran out before the vendor got around to saving its session.
  const [resumeProbeAttempt, setResumeProbeAttempt] = useState(0);
  useEffect(() => {
    setResumeProbe(null);
    if (!jobId || !resumeVendorSessionId) return;
    const probe = window.muon?.jobResumeProbe;
    if (typeof probe !== "function") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const ask = (): void => {
      void probe({ jobId })
        .then((result) => {
          if (stopped) return;
          setResumeProbe(result);
          // RE-ASK ONLY A "NOT YET". Main sets `pending` exactly when the
          // refusal names a condition that flips WHILE the job runs — the
          // vendor has not written this session into its own store yet. That
          // is the common case, not the exotic one: the probe fires about a
          // second after the id is stamped, and a `codex exec` rollout was
          // measured appearing 3 seconds into a 30-second run. A single probe
          // latched that miss for the WHOLE run, because none of this effect's
          // identity deps changes again while a job runs — so the pane spent
          // the entire run saying the session could not be reopened, about a
          // session that could be, one second later.
          //
          // Everything else stops here: a `ready` answer needs no second look,
          // and a hard refusal (foreign mission, no fork for this vendor) does
          // not change until the job's STATUS does — which re-runs this effect
          // from the top anyway.
          if (
            result.status === "unavailable" &&
            result.pending === true &&
            (retries += 1) <= RESUME_PROBE_PENDING_RETRIES
          ) {
            timer = setTimeout(ask, RESUME_PROBE_PENDING_INTERVAL_MS);
          }
        })
        .catch(() => {
          if (!stopped) {
            setResumeProbe({
              status: "unavailable",
              reason:
                "MUON could not check whether this session can be reopened. It will try again when you reopen this tab.",
            });
          }
        });
    };
    ask();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `jobStatus` is a dependency because it is what main's answer TURNS ON:
    // the same job answers `fork` while it runs and `resume` once it stops, so
    // a probe cached across that transition would label the button with the
    // wrong door. It is ALSO the retry loop's stop condition: a job going
    // terminal tears this effect down, clearing any scheduled re-ask.
  }, [jobId, resumeVendorSessionId, jobStatus, resumeProbeAttempt]);

  return (
    <section className="session-workspace" aria-label={`${props.agent.name} session`}>
      <header className="session-workspace-header">
        <div>
          <h2>{props.taskTitle}</h2>
          <span className="session-meta-inline">
            <VendorIcon vendor={props.agent.vendor} />{" "}
            {vendorLabel(props.agent.vendor)} · {props.agent.name}
          </span>
          {props.job?.brief ? (
            <details className="session-brief">
              <summary>Dispatch brief</summary>
              <p>{props.job.brief}</p>
            </details>
          ) : (
            <p>No dispatch is currently bound to this agent.</p>
          )}
        </div>
        <div className="session-header-actions">
          <span className={`session-status ${props.job?.status ?? props.agent.status}`}>
            {statusLabel(props.job?.status ?? props.agent.status)}
          </span>
          {/* A governed loop reads as "Working" for its whole life. Say which
              iteration it is on and what the last one concluded, so a looping
              agent is never mistaken for a hung one. Absent for every
              non-loop job — no line rather than an invented one. */}
          {loopLine ? (
            <span className="session-loop-progress">{loopLine}</span>
          ) : null}
          <button onClick={props.onClose}>Close tab</button>
        </div>
      </header>

      {governance.blocked ? (
        <SessionGovernanceBanner
          gates={governance.gates}
          headline={governance.headline}
          fullAuto={props.fullAuto === true}
          onReview={props.onReviewApproval}
          onResolve={props.onResolveApproval}
        />
      ) : null}

      {governance.autoApproving.length > 0 ? (
        <SessionAutoApproveBanner
          gates={governance.autoApproving}
          headline={governance.autoHeadline}
        />
      ) : null}

      <nav aria-label="Session details" className="session-section-tabs" role="tablist">
        {sections.map((entry) => (
          <button
            aria-selected={section === entry.id}
            className={section === entry.id ? "active" : ""}
            key={entry.id}
            onClick={() => setSection(entry.id)}
            role="tab"
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div
        className={`session-workspace-body${
          section === "terminal" ? " terminal-body" : ""
        }`}
      >
        {/* THE TERMINAL BODY IS MOUNTED, NOT SWITCHED, once it holds a live
            takeover pty. Section tabs are the second door onto the same defect
            the workspace tabs had: unmounting a pane whose fork the human is
            typing into detaches the relay, so the host pauses that child by
            backpressure and the next mount replays a bounded ring — and if the
            job finished meanwhile, the `.fork` slot is refused outright and
            the child is unreachable. `hidden` is presentation only; nothing
            here opens or closes a session. */}
        {props.terminalPreview && (section === "terminal" || takeoverOpen) ? (
          <JobStreamTerminal
            hidden={props.hidden === true || section !== "terminal"}
            onTakeoverOpenChange={handleTakeoverOpenChange}
            mode={terminalMode}
            chunks={chunks}
            vendorLabel={vendorLabel(props.agent.vendor)}
            // U3 — the raw vendor id, so the LIVE pane can render this job's
            // console at the geometry it was actually produced at.
            vendor={props.agent.vendor}
            spawnKind={spawnKind}
            // The SPAWN coordinate, deliberately a different shape from the
            // attach coordinate above: `terminal-<jobId>` starts a new session,
            // `pty:job:<jobId>:<epoch>` reads the running one. They never meet.
            spawnSessionId={`terminal-${props.job?.id ?? props.agent.id}`}
            vendorSessionId={resumeVendorSessionId}
            resumeProbe={resumeProbe}
            resumeKind={resumableVendor ? `${resumableVendor}:resume` : null}
            // ONE SLOT PER DOOR. A fork and a resume are different vendor
            // sessions, so they get different ptys: sharing one meant a fork
            // opened mid-run was still alive when the job finished, and the
            // re-open — freshly authorized as a resume — was served that same
            // fork instead (PtyRelay.open no-ops while the host holds the id).
            // The host refuses a slot that does not match the mode it granted,
            // so naming both here buys the renderer no authority.
            resumeSessionId={`terminal-${props.job?.id ?? props.agent.id}.resume`}
            forkSessionId={`terminal-${props.job?.id ?? props.agent.id}.fork`}
            // The human's way past the bounded retry budget above.
            onRecheckTakeover={() =>
              setResumeProbeAttempt((attempt) => attempt + 1)
            }
            error={streamError}
            chatId={props.job?.chatId ?? null}
            liveDegradedReason={liveSessionId ? liveDegraded : null}
            onLiveDegraded={setLiveDegraded}
          />
        ) : null}
        {section === "terminal" ? null : section === "overview" ? (
          <>
            <MetaRows
              rows={[
                ["Vendor", vendorLabel(props.agent.vendor)],
                ["Phase", statusLabel(props.job?.status ?? props.agent.status)],
                ["Access", authorityLabel(props.job?.capabilityMode)],
                [
                  "Started from",
                  props.job?.parentJobId
                    ? `${props.job.parentJobId} → ${props.job.id}`
                    : props.job?.id,
                  "mono",
                ],
                [
                  "Depth",
                  `Depth ${props.job?.delegationDepth ?? 0} of ${
                    props.job?.maxDelegationDepth ?? "not yet reported"
                  }`,
                ],
                [
                  "Children",
                  `${props.job?.delegationChildrenIssued ?? 0} of ${
                    props.job?.maxChildren ?? "not yet reported"
                  }`,
                ],
                [
                  "Delegations",
                  `${props.job?.delegationDescendantsIssued ?? 0} of ${
                    props.job?.maxTotalDescendants ?? "not yet reported"
                  }`,
                ],
                ["Workspace", props.job?.workspacePath],
                // The backlink handle: the vendor's own session id, resumable
                // from the Terminal section once the job has finished.
                ["Vendor session", props.job?.vendorSessionId ?? null, "mono"],
                ["Model", model.text, undefined, model.title],
                ["Harness", props.job?.harnessKey ?? "Default"],
                ["Wall-clock budget", props.job?.maxWallMs ? `${props.job.maxWallMs} ms` : null],
              ]}
            />
            <div className="session-callout">
              <strong>Session control</strong>
              <p>
                This agent can work only within this task. Approvals, merges,
                and releases stay with you.
              </p>
            </div>
          </>
        ) : null}

        {section === "timeline" ? (
          <div className="session-timeline">
            {chunks.length === 0 ? (
              <p className="session-empty">No stream events recorded yet.</p>
            ) : (
              chunks.map((chunk) => (
                <article key={chunk.seq}>
                  <span>{chunk.kind}</span>
                  <p>{chunk.content}</p>
                </article>
              ))
            )}
          </div>
        ) : null}

        {section === "changes" ? (
          <div className="session-list">
            {jobId ? (
              <ReviewDiffEvidence
                review={reviewDiff}
                loading={reviewLoading}
                // Only claim a raw diff follows when we do not already KNOW the
                // workspace read failed too (an unresolvable tree fails both).
                rawDiffAvailable={workspaceReview?.status !== "degraded"}
              />
            ) : null}
            {reviewLoading ? (
              <p className="session-empty loading-line">
                Reading workspace evidence…
              </p>
            ) : workspaceReview?.status === "available" ? (
              <>
                <article>
                  <strong>Changed files</strong>
                  {workspaceReview.files.length > 0 ? (
                    <ul className="session-change-files">
                      {workspaceReview.files.map((file) => {
                        const stat = workspaceReview.fileStats?.find(
                          (s) => s.path === file
                        );
                        return (
                          <li key={file}>
                            <code>{file}</code>
                            {stat ? (
                              stat.binary ? (
                                <span className="numstat numstat-binary">
                                  binary
                                </span>
                              ) : (
                                <span className="numstat">
                                  <span className="numstat-add">
                                    +{stat.additions}
                                  </span>
                                  <span className="numstat-del">
                                    −{stat.deletions}
                                  </span>
                                </span>
                              )
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p>No Git changes are currently visible.</p>
                  )}
                </article>
                <article>
                  <strong>Diff stat</strong>
                  <p>{workspaceReview.stat || "No changed-line summary."}</p>
                </article>
                <article>
                  <strong>Bounded diff</strong>
                  <pre className="session-diff">{workspaceReview.diffText || "No diff."}</pre>
                  <p>
                    {workspaceReview.truncated
                      ? `Truncated at ${workspaceReview.maxBytes.toLocaleString()} bytes from ${workspaceReview.totalBytes.toLocaleString()} total bytes. Open the workspace for the complete diff.`
                      : `${workspaceReview.totalBytes.toLocaleString()} bytes · complete within the review bound.`}
                  </p>
                </article>
              </>
            ) : workspaceReview?.status === "degraded" ? (
              <div className="session-callout degraded">
                <strong>Workspace evidence unavailable</strong>
                <p>{workspaceReview.reason}</p>
                <p>{workspaceReview.action}</p>
              </div>
            ) : !jobId ? (
              <p className="session-empty">
                No dispatch is bound to this session, so no workspace can be reviewed.
              </p>
            ) : null}
            {/* Render only articles that carry content; one quiet line
                replaces a stack of negatives. */}
            {props.job?.action ? (
              <article>
                <strong>Resolved vendor action</strong>
                <p>{props.job.action}</p>
              </article>
            ) : null}
            {props.job?.checks?.length ? (
              <article>
                <strong>Checks</strong>
                <p>{props.job.checks.map((check) => check.name).join(" · ")}</p>
              </article>
            ) : null}
            {props.job?.result ? (
              <article>
                <strong>Terminal artifact</strong>
                {/* Marker-free: `[muon:budget-exhausted]` is a MACHINE token
                    every classifier keys on, not something the operator should
                    read. The stripper is the shared one that lives with the
                    marker, so this pane and the crew rail can never disagree
                    about what a human sees. */}
                <p>{withoutBudgetMarker(props.job.result)}</p>
              </article>
            ) : null}
            {!props.job?.action &&
            !props.job?.checks?.length &&
            !props.job?.result ? (
              <p className="session-empty">No checks or artifacts recorded.</p>
            ) : null}
          </div>
        ) : null}

        {section === "tools" ? (
          <div className="session-list">
            <article>
              <strong>Session access</strong>
              <p>
                {authorityLabel(props.job?.capabilityMode)} · tool responses
                cannot issue instructions.
              </p>
            </article>
            {jobEvents
              .filter((event) => event.kind === "approval.requested")
              .map((event) => (
                <article key={event.id}>
                  <strong>Approval request</strong>
                  <p>{event.message}</p>
                </article>
              ))}
            {jobEvents.every((event) => event.kind !== "approval.requested") ? (
              <p className="session-empty">No structured tool approval events yet.</p>
            ) : null}
          </div>
        ) : null}

        {section === "capabilities" ? (
          <>
            <MetaRows
              rows={[
                ["Installed", readiness?.installed ? "Yes" : "No / unknown"],
                ["Authentication", readiness?.authenticated ? "Ready" : "Degraded"],
                ["Auth method", readiness?.credentialMethod],
                ["Execution mode", invocationMode],
                [
                  "Live steering",
                  descriptor?.sessionCapabilities?.canSend ? "Supported" : "Not supported",
                ],
                [
                  "Interrupt",
                  descriptor?.sessionCapabilities?.canInterrupt ??
                  descriptor?.laneCapabilities.canInterrupt
                    ? "Supported"
                    : "Unavailable",
                ],
                [
                  "Resume",
                  descriptor?.sessionCapabilities?.canResume
                    ? "Supported"
                    : "Unavailable",
                ],
              ]}
            />
            <div className="session-callout">
              <strong>Readiness details</strong>
              <p>{readiness?.detail ?? "Vendor readiness evidence is unavailable."}</p>
            </div>
          </>
        ) : null}

        {section === "commands" ? (
          <div className="session-command-grid">
            {commandRows.map(({ item, action }) => (
              <article className={item.ready ? "" : "disabled"} key={item.actionId}>
                <header>
                  <code>/{item.command}</code>
                  <span>{item.ready ? "Available" : "Unavailable"}</span>
                </header>
                <h3>{item.label}</h3>
                <dl>
                  <div>
                    <dt>Runs through</dt>
                    <dd>{action ? channelLabel(action.channel) : "MUON adapter"}</dd>
                  </div>
                  <div>
                    <dt>Approval</dt>
                    <dd>{gateLabel(item.gate)}</dd>
                  </div>
                  <div>
                    <dt>Coverage</dt>
                    <dd>{item.parity}</dd>
                  </div>
                  <div>
                    <dt>Input / scope</dt>
                    <dd>
                      {action?.arg
                        ? `${action.arg.name}${
                            action.argValues
                              ? ` · ${action.argValues.join(" | ")}`
                              : ""
                          }`
                        : "No argument"}
                    </dd>
                  </div>
                </dl>
                <p>
                  {item.note ??
                    "Uses MUON's adapter and the current session settings."}
                </p>
              </article>
            ))}
          </div>
        ) : null}

        {section === "audit" ? (
          <div className="session-list">
            {jobEvents.length === 0 ? (
              <p className="session-empty">No ledger events for this task yet.</p>
            ) : (
              jobEvents.map((event) => (
                <article key={event.id}>
                  <strong>{event.kind}</strong>
                  <p>{event.message}</p>
                  <small>{event.timestamp}</small>
                </article>
              ))
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
