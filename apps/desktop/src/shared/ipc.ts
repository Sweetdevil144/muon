import type { McpProbeVerdict } from "@muon/client/mcp-probe";
import type { DataBoundary } from "@muon/client/data-boundaries";
import type {
  BlockingQuestion,
  MemoryCompactionResult,
  MemoryExpirySweepResult,
  MemoryTtlPolicy,
  RevertExpiredBatchResult,
} from "@muon/client";
import type {
  HandoffCheckOutcome,
  HandoffPacketContract,
} from "@muon/client/handoff-view";
// WAVE D: `VendorId` reaches the desktop through `@muon/client/vendors`, the
// pure re-export subpath ADR-0022 §2 Option C exists for. The standing decision
// recorded below — apps/desktop does NOT depend on @muon/protocol — is intact:
// this is a @muon/client subpath, and @muon/client is already a dependency.
import type { VendorId } from "@muon/client/vendors";
// S1 §5 — the desktop's Connections row renders the SAME `McpStatusReport` that
// `muon mcp status` and the TUI's `/mcp` panel render. TYPE-ONLY on purpose:
// `@muon/client/mcp-status` reaches node:fs / node:child_process through the
// vendor-config module, so the evaluator runs in MAIN and only its plain-data
// result crosses the bridge. The renderer names the shape and never the module.
import type {
  CheckLevel as McpCheckLevel,
  McpStatusCheck,
  McpStatusReport,
  McpVendorReason,
  McpVendorStatus,
} from "@muon/client/mcp-status";
import type {
  InstallOutcome as McpInstallOutcome,
  McpConfigScope,
} from "@muon/client/mcp-vendor-config";
import type { DiffImpact, DiffScope } from "@muon/client/diff-impact";
import type { RepoMap, WorkUnit } from "@muon/client/repo-map";
import type {
  TerminalClientPort,
  TerminalSpawn,
} from "./terminal-protocol.js";
import type {
  ApprovalReceipt,
  ApprovalRequest,
  AutoContext,
  CapabilityPreflight,
  DispatchBudget,
  DispatchJobRecord,
  FleetSnapshot,
  GovernedScheduleRecord,
  LoopRunRecord,
  GitHubConnectionStatus,
  GitHubDeviceFlowStart,
  GitHubPullRequestAction,
  GitHubReview,
  JobTerminalView,
  MemoryExplainResult,
  MemoryGraphDegraded,
  MemoryDeleteResult,
  MemoryNeighborsResult,
  MemoryNote,
  MemoryTrust,
  MemoryLibraryQuery,
  MemoryLibrarySnapshot,
  ManualReviewAttestation,
  ApprovalMergeResult,
  OrchestratorChatRecord,
  PreEditContext,
  PreEditTargetInput,
  ReviewCoverageCertification,
  RecordedEvent,
  StreamChunk,
  StreamChunkDetail,
  Task,
  VendorReadiness,
  UngovernedAgentEntry,
  WorkflowRunRecord,
} from "@muon/client";
import type { CancelChatResult as ChatCancelReport } from "../lib/chat-lifecycle.js";
import type { UpdateStatus } from "../lib/updater.js";
import type { RunnerSupervisorStatus } from "../lib/runner-supervisor.js";
import type {
  ReadinessFreshness,
  ReadinessSnapshotMeta,
} from "../lib/readiness-cache.js";
import type {
  GitNexusIndexStatus,
  GitNexusRepoStatus,
  GitNexusReindexResult,
  GitNexusReindexRefusal,
  GitNexusIndexTrigger,
} from "../lib/gitnexus-index.js";
import type { DesktopPreset } from "../lib/presets.js";
import type { JobTree } from "../lib/job-tree.js";
import type { HumanTerminalSnapshotEntry } from "../lib/human-terminal-snapshot.js";
import type { TerminalLinkTarget } from "./terminal-link-protocol.js";

export type { UpdateStatus };
/**
 * Re-exported so the renderer can name the working tree a review surface read
 * WITHOUT importing a main-process module. Both sides read the SAME shape.
 */
export type { JobTree };
export type { GitNexusIndexStatus, GitNexusRepoStatus };
/**
 * Re-exported so the renderer can name the outcome of an operator-triggered
 * re-index WITHOUT importing a main-process module. Both sides read the SAME
 * shape — a refusal the renderer cannot name is a refusal it renders as a spinner.
 */
export type {
  GitNexusReindexResult,
  GitNexusReindexRefusal,
  GitNexusIndexTrigger,
};
export type { DesktopPreset };
/**
 * Re-exported so the renderer can name a cold-restored human terminal tab
 * (ROADMAP T1) WITHOUT importing the main-process snapshot module (which
 * touches node:fs). Both sides read the SAME shape.
 */
export type { HumanTerminalSnapshotEntry };
/**
 * Re-exported so the renderer can name readiness freshness without importing
 * a main-process module. Both sides read the SAME shape.
 */
export type { ReadinessFreshness, ReadinessSnapshotMeta };
/**
 * Re-exported so the renderer can name the tool-call detail a StreamChunk may
 * carry without importing @muon/client directly. UNTRUSTED agent text, bounded
 * and redacted before it ever reaches this process; the renderer mounts it only
 * after a human expands the card.
 */
export type { StreamChunkDetail };

/**
 * Re-exported so the renderer can name every field of the MCP status read
 * WITHOUT importing the evaluator (which needs node:fs and node:child_process).
 * Both sides read the SAME shape, and the renderer restates none of it: a
 * check id, a level, a reason id, a config path and the two per-vendor booleans
 * all arrive as data from the one shared evaluator.
 */
export type {
  McpCheckLevel,
  McpConfigScope,
  McpInstallOutcome,
  McpStatusCheck,
  McpStatusReport,
  McpVendorReason,
  McpVendorStatus,
};

/**
 * What `mcpInstall` answers with. The OUTCOME is the shared `InstallOutcome`
 * union verbatim — including its `refused` arm, whose text is authored once in
 * `@muon/client/mcp-vendor-config` so the desktop and the CLI refuse the same
 * `.dmg`-only case in the same words (§1.4c).
 */
export type McpInstallReport = {
  vendor: VendorId;
  scope: McpConfigScope;
  /** The absolute `muon-mcp` path that was recorded, or null when none resolved. */
  command: string | null;
  outcome: McpInstallOutcome;
};

/**
 * ADR-0028 Tier C — what `mcpAttach` answers with. Main runs the SAME
 * `attachCoordinatorFlow` the CLI's `muon mcp attach` calls, and this is a
 * DELIBERATELY NARROWED projection of its result: main strips
 * `capabilityFilePath`, `command`/`commandSource` and `vendorConfig` before
 * this ever crosses the bridge. The one field that could never have been
 * here in the first place is the capability token itself — neither this type
 * nor `attachCoordinatorFlow`'s own return type has a slot for it. Renderer
 * state built from this value is therefore token-free by construction, not
 * by convention.
 */
export type McpAttachResult =
  | { kind: "refused"; reason: string; hint?: string }
  | {
      kind: "attached";
      vendor: VendorId;
      jobId: string;
      chatId: string;
      workspacePath: string;
      /** The short heartbeat lease, not the execution wall. */
      expiresAt: string;
      attestation: { posture: string; claim: string };
    };

/** ADR-0028 Tier C — what `mcpDetach` answers with. */
export type McpDetachResult = {
  /** `not-attached` is idempotent clean; `partial` names unconfirmed cleanup. */
  kind: "detached" | "not-attached" | "partial";
  jobId: string | null;
  notes: readonly string[];
};

/**
 * The IPC contract between main, preload, and the renderer. Types only,
 * both sides compile against this file, so channel payloads cannot drift.
 */

export type RendererSettings = {
  apiBase: string;
  /**
   * Non-secret indicator: is a USER-SUPPLIED (manual/hosted) operator token
   * configured? The raw token is NEVER sent to the renderer (P3-A token
   * hygiene), false means the embedded (auto) token is in use. Optional so
   * older state literals stay valid; the UI treats undefined as unset.
   */
  apiTokenSet?: boolean;
  /**
   * Opt-in automatic on-launch update check. GitHub review egress is separately
   * enabled by device-flow connection. Optional so older state literals stay
   * valid; the UI treats undefined as off.
   */
  autoUpdate?: boolean;
  /**
   * S4 durable orchestration: auto-continue an idle chat when a worker finishes
   * (bounded + gated; see DesktopSettings.autoContinue). Optional so older state
   * literals stay valid; the UI treats undefined as on (the desktop default).
   */
  autoContinue?: boolean;
  /**
   * Full-Auto ("Auto Approve all") operator standing-consent state, so the
   * renderer can render the persistent "safety gates off" indicator + toggle.
   * Optional so older state literals stay valid; the UI treats undefined as off.
   */
  fullAuto?: boolean;
  /**
   * ROADMAP P6 — opt-in localhost preview pane (`http://127.0.0.1:<port>/`
   * only). OFF by default; enabling it does not open anything until the
   * operator clicks a port badge.
   */
  portPreviewEnabled?: boolean;
  /** P0-5: local diagnostics recording consent. Optional; defaults off. */
  telemetryEnabled?: boolean;
  /**
   * Non-secret, strictly allowlisted dispatch presets. Optional for compatibility
   * with an older main process; the renderer falls back to desktop defaults.
   */
  presets?: DesktopPreset[];
  /**
   * Crew / orchestrator configuration (vendor seat + per-lane model/effort).
   * Optional so older state literals stay valid; the UI falls back to defaults.
   */
  crew?: {
    orchestratorVendor: VendorId;
    orchestratorModel: string;
    orchestratorEffort: "low" | "medium" | "high" | "xhigh" | "max";
    /** TODO 3.8 — last Mission model/effort per coordinator vendor id. */
    orchestratorByVendor?: Partial<
      Record<
        VendorId,
        {
          model: string;
          effort: "low" | "medium" | "high" | "xhigh" | "max";
        }
      >
    >;
    laneDefaults: Record<string, { model: string; effort: "low" | "medium" | "high" }>;
  };
};

/**
 * What the VENDOR reports it will run when MUON names no model.
 *
 * `model: null` is a statement, not a blank: `state` says whether the vendor
 * was asked and reported nothing, whether the probe failed, or whether MUON has
 * no way to ask that vendor at all. Surfaces must render the distinction; none
 * of them may substitute a placeholder model name.
 *
 * DISPLAY ONLY. This resolution grants nothing and selects nothing. It never
 * reaches dispatch, and `validateModelForVendor` remains the sole authority
 * over which model a run actually uses.
 */
export type VendorModelResolutionIpc = {
  vendor: VendorId;
  model: string | null;
  state: "reported" | "not-reported" | "probe-failed" | "no-probe";
  /**
   * Provenance: the command that reported the model, or the settings file it
   * was read from (home-relative, e.g. `~/.claude/settings.json`). Surfaces
   * show it so a displayed model is always attributable to a source the
   * operator can recognise as their own.
   */
  probe?: string;
  reason?: string;
};

/** Live/fallback model catalog for the Mission Agent config menu. */
export type VendorModelCatalogIpc = {
  vendor: VendorId;
  source: "cli" | "fallback";
  models: Array<{
    id: string;
    label: string;
    efforts: string[];
    defaultEffort?: string;
  }>;
};

/**
 * Renderer → main settings write. Carries a raw token ONLY when the user
 * manually enters one for a hosted/remote brain; it flows one-way into main
 * (persisted as the sole durable token) and is never echoed back in state.
 */
export type SaveSettingsInput = {
  apiBase: string;
  apiToken?: string;
};

export type ApplyDesktopPresetResult = {
  preset: DesktopPreset;
  laneProfileVersion: number;
};

export type DesktopState = {
  online: boolean;
  lastError: string | null;
  /** A persistent runner is live to execute dispatched jobs (the app hosts one). */
  /** True when the brain has filed a `memory.graph_mirror_failed` Event — the
   *  memory graph is a MIRROR, so its failure is a partial outage the operator
   *  should see rather than a silent one. Polled BY KIND, so ordinary event
   *  volume cannot bury it. */
  memoryDegraded: boolean;
  runnerLive: boolean;
  /**
   * The interactive vendor terminal is backed by a REAL pty (node-pty loaded;
   * the default now) rather than the echo diagnostic, so a subagent tab
   * defaults to its Terminal section instead of the audit Timeline. False only
   * when the native module failed to load or MUON_REAL_PTY=0 opted out.
   * Optional so older state literals stay valid.
   */
  realPty?: boolean;
  /**
   * Evidence from the desktop's own supervised child. Optional for compatibility
   * with older main processes; contains no API coordinates or token material.
   */
  runnerStatus?: RunnerSupervisorStatus;
  /**
   * Local GitNexus index status for the bound workspace (phase + symbolCount +
   * lastIndexedAt). Optional so older state literals stay valid; carries no
   * token/coordinates. The navbar renders it.
   */
  gitnexus?: GitNexusIndexStatus;
  settings: RendererSettings;
  /** Safe connection posture; never contains access/refresh credentials. */
  github?: GitHubConnectionStatus;
  /**
   * P0-2 — the GitHub identity gate. `required` is the build's policy
   * (packaged, or MUON_REQUIRE_GITHUB_LOGIN=1); `satisfied` means a completed
   * device-flow credential is persisted. The renderer draws the gate screen
   * from this, but ENFORCEMENT lives in trusted main (installGitHubIpcGate
   * wraps every IPC channel) — a renderer that ignores this field still
   * cannot start work. Optional so older state literals in tests stay valid.
   */
  githubGate?: { required: boolean; satisfied: boolean };
  /** Full-Auto standing-consent state, mirrored for the persistent "safety gates off" indicator. */
  fullAuto: boolean;
  /**
   * Vendor-scoped standing consent: which managed lanes the auto-approver
   * covers (fullAuto === vendors selected at all). Optional so older state
   * literals in tests stay valid; the renderer defaults it to [].
   */
  fullAutoVendors?: string[];
  /**
   * P0-1: pending approval ids standing consent is NOT covering — outside the
   * selected lanes, refused by the brain, or not landed inside the grace
   * window. Optional so older state literals stay valid; always empty when no
   * lane is armed (then every gate is the human's).
   */
  fullAutoUncoveredApprovalIds?: string[];
  /**
   * The POSITIVE half: ids standing consent is actively granting, stamped by
   * the same monitor tick that runs the auto-approver. Surfaces may say
   * "approving automatically" ONLY for ids on this list — an id on neither
   * list (a brand-new approval the classifier has not seen yet; the approvals
   * fetch and the monitor run on independent cadences) renders as an ordinary
   * fail-closed human gate until the next tick. The calm label is opt-in per
   * id, never a default.
   */
  fullAutoCoveredApprovalIds?: string[];
  /**
   * What deciding a `merge` gate ACTUALLY did to the primary checkout, keyed
   * by approval id — the brain reports it on the resolve call and main keeps
   * a bounded copy so the Changes panel can say "landed as <sha>" even when
   * Full Auto decided the gate after the file call returned. Optional so
   * older state literals stay valid; bounded (recent decisions only), so
   * absence of an id means "not decided here recently", never "not merged".
   */
  mergeOutcomes?: Record<string, ApprovalMergeResult>;
  fleet: FleetSnapshot | null;
  chats: OrchestratorChatRecord[];
  /** Pending approvals only, what the inline gate cards render. */
  approvals: ApprovalRequest[];
  /** OPEN blocking questions machine-wide (ADR-0043) — the human inbox half. */
  questions: BlockingQuestion[];
  /** The inbox read is BOUNDED (spine window + response cap); true = partial. */
  questionsTruncated: boolean;
  /** The read FAILED — distinct from an empty inbox, which is a real zero. */
  questionsUnavailable: boolean;
  /** All tasks, so agent rows can show task titles instead of ids. */
  tasks: Task[];
  /** Inert planner proposals waiting for an explicit human apply/dismiss. */
  workflowProposals?: WorkflowRunRecord[];
  /**
   * TODO 5.17: every workflow run (any status) for the commitments screen.
   * Optional so older state literals stay valid. Proposals above remain the
   * chat-scoped Review-rail subset.
   */
  workflowRuns?: WorkflowRunRecord[];
  /**
   * TODO 5.17: live + recent critique loops for the commitments screen.
   * Optional so older state literals stay valid.
   */
  loopRuns?: LoopRunRecord[];
  /** Operator-authored scheduled turns, including their bounded recent audit. */
  schedules?: GovernedScheduleRecord[];
  /** Recent dispatch ledger rows for streams, panic-stop, and human audit. */
  dispatchJobs?: DispatchJobRecord[];
  /** Bounded append-only event-ledger rows for the human-readable audit view. */
  auditEvents?: RecordedEvent[];
  /**
   * P0.4: live (unexpired, unrevoked) content-bound approval receipts, for the
   * inbox annotation. Optional so older state literals stay valid.
   */
  activeReceipts?: ApprovalReceipt[];
  /**
   * P2b onboarding: per-vendor readiness (installed? logged in?) with fix hints.
   * `null` = the readiness probe was unavailable (degrade to manual steps). The
   * first-run wizard renders from this; it never carries a token.
   */
  readiness: VendorReadiness[] | null;
  /**
   * How old the `readiness`/`preflight` evidence above is, and whether a probe
   * is running right now.
   *
   * Readiness is the ONE part of this state that costs real subprocess time
   * (the vendor CLIs are spawned to check install + login; `cursor-agent
   * status` alone measured 3.3s), so it is served from a main-process cache
   * instead of blocking every poll. That makes its age a fact the human is
   * entitled to see: the Crew and Status surfaces render "checked 12s ago" /
   * "Checking providers…" from this, so a stale-but-labelled lane light can
   * never be mistaken for a live one.
   *
   * Optional so older state literals stay valid. Never carries credentials.
   */
  readinessMeta?: ReadinessSnapshotMeta;
  /**
   * P0.5 doctor contract: the same bounded capability preflight the CLI and
   * MCP surfaces project (built in main from already-fetched state). Optional
   * so older state literals stay valid; the DiagnosticsStrip renders it.
   */
  preflight?: CapabilityPreflight;
  /**
   * The running app's version (package.json). Optional so existing state
   * literals stay valid. The Updates panel shows it.
   */
  appVersion?: string;
  /**
   * ROADMAP P6 — listening ports tied to the bound chat's workspace or its
   * active jobs (from one shared bounded scan in main). Optional for older
   * mains; carries no credentials.
   */
  listeningPorts?: ListeningPortSnapshot[];
  /** ROADMAP P6 — opt-in localhost preview pane. Optional; defaults off. */
  portPreviewEnabled?: boolean;
  /** P0-5: local diagnostics recording consent. Optional; defaults off. */
  telemetryEnabled?: boolean;
};

/** Renderer-safe listen-port row surfaced in workspace badges. */
export type ListeningPortSnapshot = {
  port: number;
  address: string;
  pid: number;
  command?: string;
  ownerKind?: "workspace" | "job" | "terminal";
  chatId?: string;
  jobId?: string;
  workspacePath?: string;
};

/**
 * One node of the local knowledge graph, flattened for the IPC payload (the
 * renderer's graph adapter reads these fields directly). Token-free: only the
 * symbol identity + source location the graph already holds.
 */
export type GitNexusGraphNode = {
  id: string;
  /** NodeLabel (File | Function | Class | …); drives node color/size. */
  label: string;
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
};

/** One directed relationship (CONTAINS | CALLS | IMPORTS | …); drives edge color. */
export type GitNexusGraphRelationship = {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
};

/**
 * The full local knowledge graph the "Open Graph" page renders. Read on demand
 * from the workspace's `.gitnexus/` store (never a network fetch). Fail-safe:
 * an unreadable graph returns empty arrays + a human-readable `error`, never a
 * rejected IPC call.
 */
export type GitNexusGraphData = {
  nodes: GitNexusGraphNode[];
  relationships: GitNexusGraphRelationship[];
  /** True when the full graph exceeded the render cap and was trimmed. */
  truncated: boolean;
  /** Present when the graph could not be read (CLI missing, not indexed, error). */
  error?: string;
  workspacePath?: string;
};

export type AssistantEvent = {
  chatId: string;
  text: string;
  mode: "delta" | "message";
};
/**
 * U4 — a live activity line, plus the bounded/redacted tool detail the ledger
 * recorded for it.
 *
 * `detail` is the SAME shape the persisted chunk carries (`StreamChunkDetail`):
 * head-kept args, tail-kept result, already bounded at the adapter and already
 * scrubbed by @muon/core's single redactor before it was durable. It is
 * forwarded here, never re-derived and never re-redacted — a second redactor
 * would be a second policy.
 *
 * Optional, so an emitter that has nothing to say sends exactly today's payload
 * and every existing card renders unchanged.
 */
export type StatusEvent = {
  chatId: string;
  line: string;
  detail?: {
    args?: string;
    argsTruncated?: boolean;
    result?: string;
    resultTruncated?: boolean;
  };
};
export type OpenApprovalEvent = { approvalId: string };
/**
 * S4: a delegated worker finished while the orchestrator chat was idle, and
 * auto-continue was off or the per-chat cap was reached, so the renderer shows a
 * [Continue orchestration] affordance instead of an autonomous turn.
 */
export type JobIdleTerminalEvent = { chatId: string; jobId: string };

export type MuonEvents = {
  "muon:assistant": AssistantEvent;
  "muon:status": StatusEvent;
  "muon:open-approval": OpenApprovalEvent;
  /** Live auto-update progress (checking → available → downloading → …). */
  "muon:update-status": UpdateStatus;
  /** A worker landed while the chat was idle; offer a manual continuation. */
  "muon:job-idle-terminal": JobIdleTerminalEvent;
  /** Live local-index status transitions (idle → indexing → ready → …). */
  "muon:gitnexus": GitNexusIndexStatus;
  /** Cmd/Ctrl+W — close the active closable workspace tab (never Mission). */
  "muon:close-active-tab": null;
  /**
   * TODO 7.9 — global hotkey focused the window; open (or re-focus) the
   * in-renderer ⌘K command palette.
   */
  "muon:open-command-palette": null;
};

export type SendMessageResult = {
  ok: boolean;
  error?: string;
};

/**
 * Renderer-safe device-flow progress. The backend/client poll result also
 * carries the access/refresh credential on success, but trusted main consumes
 * and persists it before projecting only this token-free union across IPC.
 */
export type GitHubDeviceFlowUiPoll =
  | { status: "pending"; retryAfterMs: number }
  | {
      status: "connected";
      login?: string;
      expiresAt?: string;
    }
  | {
      status: "expired" | "denied" | "error";
      message: string;
    };

/**
 * P6, the guided first task. Picks a folder, seeds a SAFE, additive sample task
 * into it, and dispatches it to a ready vendor (the hosted runner executes it).
 * A discriminated result so the wizard shows clear feedback without a dead-end:
 *   - canceled       , the folder picker was dismissed.
 *   - no-vendor-ready, nothing connected yet → stay in onboarding.
 *   - error          , a dispatch/setup failure, with an actionable fixHint.
 * Never carries a token; the sample is additive + workspace-scoped.
 */
export type FirstTaskResult =
  | {
      ok: true;
      taskId: string;
      jobId: string;
      memoryId: string;
      vendor: string;
      workspacePath: string;
      completedAt: string;
    }
  | { ok: false; reason: "canceled" }
  | { ok: false; reason: "no-vendor-ready" }
  | {
      ok: false;
      reason: "error";
      message: string;
      fixHint?: string;
      retryable: boolean;
    };

/**
 * BUG 1: outcome of an approval decision. The approve/reject ALWAYS lands; when
 * the operator also asked to "remember" an action that isn't receipt-eligible,
 * the server soft-skips the mint and the main process surfaces `receiptSkipped`
 * as a gentle, non-error note (never the old red 400).
 */
export type ResolveApprovalResult = {
  receiptSkipped?: boolean;
  receiptSkippedReason?: string;
};

/**
 * What filing the desktop merge gate returned. Assignment-compatible with the
 * Changes panel's `ShipOutcome` (renderer/right-panel.tsx): `pending` is true
 * because this call only FILES the gate — deciding it belongs to Review or to
 * Full Auto's standing consent, never to the filing handler. `merge` exists in
 * the shape for that later, decided outcome; the file call itself never sets
 * it.
 */
export type ShipTaskResult = {
  approvalId: string;
  pending: boolean;
  merge?: ApprovalMergeResult;
};

export type StreamsQuery = {
  taskId?: string;
  runId?: string;
  afterSeq?: number;
  limit?: number;
  latest?: boolean;
};

/**
 * LIVE TERMINAL — attach (0038). One cursor-based read of a dispatched job's
 * REAL console, `GET /api/dispatch/:jobId/terminal`.
 *
 * It goes through MAIN and not the renderer because the route is OPERATOR
 * tier: the renderer holds no token and must not acquire one to watch an
 * agent work. Bytes and coordinates only, exactly like `streams`.
 *
 * There is deliberately NO write counterpart on this bridge, and there must
 * not be: sending input to a dispatched agent would bypass the approval path
 * that makes it governed.
 */
export type JobTerminalQuery = {
  jobId: string;
  /**
   * Owning chat. Same soft scope as `workspaceReview`: main authorizes the job
   * against THIS chat rather than requiring it to stay the selected mission,
   * so watching one worker while switching missions is not a race.
   */
  chatId?: string;
  /** Last `lastSeq` this viewer consumed. Omitted ⇒ from the ring's start. */
  afterSeq?: number;
  limit?: number;
};

/**
 * FAIL-SOFT BY CONSTRUCTION, like `CrewRolesResponse`. A brain that predates
 * the route, an unreachable one, or a body we cannot parse all resolve as
 * `unavailable` with a human reason — the tab then falls back to the RECORDED
 * stream and says so, which is honest. It never rejects into a blank pane.
 */
export type JobTerminalResponse =
  | ({ status: "ok" } & JobTerminalView)
  | UnavailableIpc;

/**
 * BACKLINK RESUME PROBE — "may this job's real vendor session be reopened,
 * and if not, why not", answered by trusted MAIN before the renderer renders
 * the affordance.
 *
 * The dead-button class this closes: the renderer used to offer "Open this
 * job's real <vendor> session" on the strength of the stamped id alone, and
 * the click then died inside the pane with the vendor's own error (the
 * founder's hit: codex's "No saved session found with ID …"). Main answers
 * from the SAME resolver the spawn path authorizes with — chat binding, job
 * status, recorded id, and the vendor's own session store — so the button and
 * the spawn can never disagree. `unavailable` carries the honest sentence the
 * renderer shows in the button's place. Always resolves; never rejects.
 */
export type JobResumeProbeQuery = {
  jobId: string;
};

export type JobResumeProbe =
  | {
      status: "ready";
      vendor: string;
      sessionId: string;
      /**
       * WHICH door main authorized, decided from the job's own status:
       *  - `"resume"` the job has stopped, so the human continues THE session;
       *  - `"fork"`   the job is still running, so the human gets a fork —
       *    the vendor's own copy of the history so far, under a new session
       *    id, while the governed child keeps sole ownership of the original.
       * The renderer RENDERS this; it never chooses it. Its only job is to
       * label the button with the truth about what clicking it will do.
       */
      mode: "resume" | "fork";
    }
  | {
      status: "unavailable";
      reason: string;
      /**
       * "NOT YET", as distinct from "no" — main's own statement that this
       * refusal names a condition which flips WHILE the job runs (the vendor
       * has not reported a session id yet, or has not written the session into
       * its own store yet). The renderer re-asks on a BOUNDED cadence while
       * this is true, and words the callout as a wait.
       *
       * It is main's call and not the renderer's for the same reason `mode` is:
       * a renderer that decided "transient" from the job status it happens to
       * hold would be a second opinion about an authority answer, and the two
       * could disagree across a status transition. Absent ⇒ "no", so an older
       * main process can only ever make this pane quieter.
       */
      pending?: boolean;
    };

export type WorkspaceReviewQuery = {
  jobId: string;
  /**
   * Owning chat for this review. Required for sidebar/multi-chat fetches so
   * main can authorize without forcing the chat to be the currently selected
   * mission (selection races used to throw "Select a chat before…").
   */
  chatId?: string;
};

export type GitHubCreatePullRequestQuery = WorkspaceReviewQuery;

export type GitHubMergePullRequestQuery = WorkspaceReviewQuery & {
  pullNumber: number;
  expectedHeadSha: string;
  method?: "merge" | "squash" | "rebase";
};

export type WorkspaceReview =
  | {
      status: "available";
      workspacePath: string;
      /** Current branch, or `detached@<short-sha>` for task worktrees. */
      branch: string;
      /** Paths with index changes. A path may also appear in unstagedFiles. */
      stagedFiles: string[];
      /** Paths with working-tree or untracked changes. */
      unstagedFiles: string[];
      files: string[];
      stat: string;
      /** Per-file +/- line counts (git --numstat) for the changed files. */
      fileStats: Array<{
        path: string;
        additions: number;
        deletions: number;
        binary: boolean;
      }>;
      diffText: string;
      truncated: boolean;
      totalBytes: number;
      maxBytes: number;
      /**
       * WHICH working tree this evidence was read from — same requirement as
       * `ReviewDiffResponse.tree`, for the same reason: without it the
       * renderer cannot tell a task worktree from the canonical checkout, so
       * "Land this work" could not distinguish mergeable child work from
       * changes that are already in the primary checkout.
       */
      tree: JobTree;
    }
  | {
      status: "degraded";
      reason: string;
      action: string;
    };

// Governed-evidence review lane (ROADMAP 4.1b): the same change mapped to the
// execution flows it disturbs, fail-closed. `DiffImpact` is plain JSON.
export type ReviewDiffQuery = {
  jobId: string;
  scope?: DiffScope;
  baseRef?: string;
};

export type ReviewDiffResponse =
  | {
      status: "ok";
      impact: DiffImpact;
      /**
       * WHICH working tree this evidence was read from. REQUIRED: a job whose
       * harness runs in an isolated worktree edits
       * MUON's external task worktree, not the canonical checkout its
       * `workspacePath` names, and an impact panel that cannot say which tree it
       * read can render an empty diff of the wrong tree as a clean verdict. Main
       * resolves it (lib/job-tree.ts) and degrades rather than guessing.
       */
      tree: JobTree;
    }
  | { status: "degraded"; reason: string; action?: string };

// Reconnaissance card (ROADMAP 4.1b): the repo_map the orchestrator reads to
// auto-size + partition a crew, rendered so the human sees WHY N workers and
// WHAT each owns. RepoMap / WorkUnit are plain JSON.
export type ReconMapResponse =
  | {
      status: "ok";
      map: RepoMap;
      recommendation: {
        crewSize: number;
        caps: { maxChildren: number; maxDescendants: number };
        workUnits: WorkUnit[];
      };
    }
  | { status: "degraded"; reason: string };

// Migration-risk (ROADMAP 4.1b): which datastore tables the pre-edit target
// writes + who else writes them. `DataBoundary` is plain JSON.
export type DataBoundaryQuery = { file: string };
export type DataBoundaryResponse =
  | { status: "ok"; boundary: DataBoundary }
  | { status: "degraded"; reason: string };

// ─── Crew topology (roles + A2A coordination) ────────────────────────────────
// SHAPE MIRROR, not a re-export: `@muon/protocol` is deliberately NOT a desktop
// dependency (same reasoning as recon-map.ts's DELEGATION_MAX_* mirror), so the
// wire shapes the topology panel renders are restated here. Source of truth:
//   packages/protocol/src/agent-role.ts  (AgentRole, RoleBinding, CrewRolePlan)
//   packages/protocol/src/a2a.ts         (CoordinationSnapshot, PeerMessage,
//                                         ClaimConflict)
// Keep this block in sync when those schemas change; the main-process loader
// (lib/crew-topology.ts) validates every field it reads and DROPS anything it
// does not recognize, so a protocol addition degrades to "not shown", never to
// a crash or a mis-rendered authority claim.

export type AgentRoleIpc =
  | "orchestrator"
  | "architect"
  | "implementer"
  | "reviewer"
  | "qa"
  | "scout"
  | "docs";

export const AGENT_ROLES_IPC: readonly AgentRoleIpc[] = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
  "qa",
  "scout",
  "docs",
] as const;

export type RoleBindingIpc = {
  vendor: string;
  role: AgentRoleIpc;
  /** Deterministic 0..1 fit score from the assignment engine. */
  fit: number;
  /** Human-readable justification. MUON-authored, safe to render verbatim. */
  reason: string;
  assignedBy: "human" | "muon";
  /** Set when the lane cannot currently hold the role it was assigned. */
  blocked: boolean;
  blockedReason?: string;
};

export type CrewRolePlanIpc = {
  version: 1;
  chatId: string;
  bindings: RoleBindingIpc[];
  /** Roles the mission wanted but no available lane could hold. */
  unfilled: AgentRoleIpc[];
};

/**
 * IS THE PLAN A DECISION OR A PREVIEW? `/api/crew/roles` answers a chat with no
 * stored bindings with the crew MUON WOULD assign, so the panel can show the
 * capability before anyone has acted — but a preview must never render as a
 * commitment, and `plan` alone cannot carry that difference.
 *
 *  - `assigned` — bindings are stored; dispatch narrows against them.
 *  - `proposed` — computed on the read from the live lanes; nothing is bound.
 *  - `none` — no plan at all (`plan` is null).
 */
export type CrewPlanStatusIpc = "assigned" | "proposed" | "none";

export type LaneHealthIpc = "healthy" | "degraded" | "unavailable";

/**
 * One candidate lane, exactly as `GET /api/crew/roles` reports it to an
 * OPERATOR (a job bearer gets `plan` only — another lane's install posture is
 * operator diagnostics, not peer data).
 */
export type CrewRoleLaneIpc = {
  vendor: string;
  /** The adapter's own display name. */
  displayName?: string;
  health?: LaneHealthIpc;
  /** Relative cost ordinal (0…1), not dollars. */
  cost?: number;
  costOrdinal?: number;
  /** Only if a future route version puts the assignment on the lane itself. */
  role?: AgentRoleIpc | null;
};

export type CrewCostAccountingIpc = {
  metered: false;
  notice: string;
};

/**
 * FAIL-SOFT BY CONSTRUCTION. The roles/coordination routes are newer than this
 * panel, so the bridge never rejects: a 404, a timeout, a non-JSON body, or a
 * shape we do not recognize all resolve as `unavailable` with a human reason.
 * The topology then renders from LOCAL dispatch state alone.
 */
/**
 * Set on an `unavailable` result the panel may usefully ask for AGAIN: a
 * refused socket, a timeout, a 5xx/429 — anything that can pass on its own. A
 * route that is simply ABSENT (404/501), a missing bridge method, or a body we
 * cannot parse is NOT retryable: re-asking would produce the same answer, so
 * the panel stays degraded and points at Refresh instead. Absent ⇒ not
 * retryable, so any producer that does not set it can never cause a re-read.
 */
export type UnavailableIpc = {
  status: "unavailable";
  reason: string;
  retryable?: boolean;
};

export type CrewRolesResponse =
  | {
      status: "ok";
      plan: CrewRolePlanIpc | null;
      /** Always concrete: `none` exactly when `plan` is null. */
      planStatus: CrewPlanStatusIpc;
      lanes: CrewRoleLaneIpc[];
      costAccounting?: CrewCostAccountingIpc;
    }
  | UnavailableIpc;

export type ClaimConflictIpc = {
  path: string;
  /** The job that already holds an `edit` claim on this path. */
  heldByJobId: string;
  heldByRole: AgentRoleIpc;
  heldByVendor: string;
  heldByName?: string;
  expiresAt: string;
};

export type CoordinationParticipantIpc = {
  jobId: string;
  vendor: string;
  role: AgentRoleIpc;
  name?: string;
  status: string;
  claimedPaths: number;
  unreadMessages: number;
};

export type CoordinationSnapshotIpc = {
  version: 1;
  chatId: string;
  missionId: string;
  participants: CoordinationParticipantIpc[];
  openConflicts: ClaimConflictIpc[];
  messageCount: number;
};

export type PeerMessageKindIpc =
  | "question"
  | "answer"
  | "review_request"
  | "review_verdict"
  | "constraint"
  | "status"
  | "blocked";

/**
 * One peer envelope. `subject` and `body` are UNTRUSTED agent-produced text —
 * the renderer labels them as such and never styles them as system copy.
 */
export type PeerMessageIpc = {
  id: string;
  fromJobId: string;
  fromRole: AgentRoleIpc;
  fromVendor: string;
  fromName?: string;
  /** Exact peer when addressed by job; null for a role/crew fan-out. */
  toJobId: string | null;
  kind: PeerMessageKindIpc;
  subject: string;
  body: string;
  createdAt: string;
};

export type CoordinationResponse =
  | {
      status: "ok";
      snapshot: CoordinationSnapshotIpc | null;
      /**
       * The mission's recent peer envelopes, read from the SEPARATE
       * operator-tier transcript route (`GET /api/a2a/messages`). The
       * coordination snapshot itself is coordinates-only by contract, so the
       * bodies never ride on it.
       */
      messages: PeerMessageIpc[];
      /**
       * True when the mission HAS peer messages the rail cannot show — the
       * transcript route failed, answered a shape we do not recognize, or came
       * back empty while the snapshot still counts traffic. Derived from that
       * real condition, never from the transport alone, so the rail can never
       * badge "12 messages" above "no peer messages yet".
       */
      messagesOmitted: boolean;
    }
  | UnavailableIpc;

export type FleetCounts = Partial<Record<VendorId, number>>;

export type StopAllResult = {
  requested: number;
  stopped: number;
  failedJobIds: string[];
};

/**
 * The result of cancelling ONE chat's work. `stopped` is only ever a job the
 * ledger showed leaving queued/running; anything still live is in `blocked`
 * with the reason, so the UI can never render "cancelled" over a live job.
 */
export type CancelChatResult = ChatCancelReport;

export type MuonBridge = {
  getState(): Promise<DesktopState>;
  /**
   * Read a workspace's local knowledge graph on demand (for the "Open Graph"
   * page). Reads the `.gitnexus/` store via the bundled CLI — no network,
   * no token. Always resolves: an unreadable graph comes back with empty arrays
   * + an `error` string, never a rejection.
   *
   * `repoPath`: multi-repo graph tabs (Auto Repository Detection). Pick ONE
   * detected repo's own `.gitnexus/` store by its absolute root (a `path` from
   * `GitNexusIndexStatus.repos`). Omitted ⇒ today's single-repo behavior (the
   * bound workspace root).
   */
  gitnexusGraph(
    repoPath?: string,
    options?: { force?: boolean }
  ): Promise<GitNexusGraphData>;
  /** Drop cached Open Graph payloads (one repo, or all when omitted). */
  clearGitnexusGraphCache(repoPath?: string): Promise<void>;
  /**
   * Ask MUON to re-index the workspace's code graph NOW — the operator's escape
   * hatch when indexing failed or the graph stopped matching the code.
   *
   * Drives the user's own bundled `gitnexus analyze --index-only` locally: no
   * network, no token, no hosted service. Always resolves to a VALUE; an
   * `accepted:false` result carries the reason (already running, no repo, CLI
   * missing) so the UI can say what happened instead of spinning.
   *
   * `repoPath`: one detected repo (a `path` from `GitNexusIndexStatus.repos`).
   * Omitted ⇒ every repo in the workspace, indexed one at a time.
   */
  gitnexusReindex(repoPath?: string): Promise<GitNexusReindexResult>;
  createChat(input: { workspacePath: string }): Promise<OrchestratorChatRecord>;
  /**
   * Bind trusted main-process integrations (workspace index, graph, terminal
   * cwd) to the renderer's selected active chat. Main resolves the workspace
   * from the chat id; the untrusted renderer never supplies a raw path.
   */
  selectChat(chatId: string | null): Promise<void>;
  listChats(): Promise<OrchestratorChatRecord[]>;
  getChat(chatId: string): Promise<OrchestratorChatRecord>;
  /**
   * S7: "delete" a chat = OPERATOR-tier SOFT archive. The main process calls it
   * with the OPERATOR client; the backend flips status→"archived" and preserves
   * the whole audit trail. Archived chats leave the default list. Rejects (the
   * renderer surfaces the message) if the brain refuses — it is never silent.
   */
  archiveChat(chatId: string): Promise<OrchestratorChatRecord>;
  /**
   * Cancel a chat: stop every queued/running job it owns, over the SAME
   * governed per-job interrupt the mission header's Stop all uses — scoped to
   * one chat. This is not archive and not delete: the chat stays active and
   * usable afterwards. Safe to press twice (an already-fenced job is not
   * re-interrupted). The report never claims a still-running job was stopped.
   */
  cancelChat(chatId: string): Promise<CancelChatResult>;
  /**
   * D4: rename a chat (the ONLY field the desktop UI edits here — the client's
   * own `updateChat` also accepts vendorSessionId/status, deliberately not
   * exposed on this bridge). Auto-title (packages/orchestrator/src/chat.ts)
   * only overwrites a chat's title while it is still literally "New chat", so
   * a human rename is never silently clobbered by the next turn.
   */
  updateChat(input: {
    chatId: string;
    title?: string;
  }): Promise<OrchestratorChatRecord>;
  /**
   * S9 mission budget: read the root mission's descendant-pool state
   * (numbers/enums only). Read-only, either tier server-side.
   */
  getDispatchBudget(jobId: string): Promise<DispatchBudget>;
  /**
   * S9 raise (OPERATOR act): the main process calls the route with the
   * operator client, so the human's own raise goes straight through; the
   * backend stays raise-only + ceiling-bounded. Rejections propagate to the
   * renderer and are surfaced inline — never silent.
   */
  raiseDispatchBudget(
    jobId: string,
    maxDescendantWallMs: number
  ): Promise<DispatchBudget>;
  /** Interrupt one exact dispatch owned by the currently selected chat. */
  interruptDispatch(jobId: string): Promise<void>;
  /**
   * Kill a lane's live credential NOW. NOT the same as interrupting it: the
   * process may keep running, it simply can no longer act as itself.
   */
  revokeDispatchGrants(input: {
    jobId: string;
  }): Promise<{ jobId: string; revoked: number; note: string }>;
  /**
   * TODO 7.13 — "Send now" from the composer queue: steer one exact running
   * dispatch owned by the currently selected chat. Operator client; never
   * resolves an approval.
   */
  steerDispatch(jobId: string, message: string): Promise<void>;
  /**
   * TODO 5.17: pause one autonomy commitment without deleting it.
   * Dispatch → interrupt; workflow → paused; loop → aborted.
   */
  pauseAutonomyCommitment(input: {
    kind: "loop" | "workflow" | "dispatch" | "schedule";
    id: string;
  }): Promise<void>;
  /**
   * P9 — resume a paused/interrupted loop dispatch as a fresh governed job.
   */
  resumeObjectiveLoop(input: { jobId: string }): Promise<{ jobId: string }>;
  /**
   * Runs one orchestrator turn; resolves when the turn completes. S10: an
   * optional per-chat default `model` rides along so the orchestrator's own turn
   * runs on it (validated fail-closed at the route). Omitted → today's behavior.
   */
  sendMessage(input: {
    chatId: string;
    message: string;
    model?: string;
  }): Promise<SendMessageResult>;
  /**
   * S4: human-consented single reconciliation turn for a worker that finished
   * while the chat was idle (the [Continue orchestration] button). Runs the same
   * enveloped nudge as auto-continue and resets the per-chat auto-turn cap.
   */
  continueOrchestration(input: {
    chatId: string;
    jobId: string;
  }): Promise<SendMessageResult>;
  setFleet(counts: FleetCounts): Promise<FleetSnapshot>;
  /**
   * Re-probe vendor readiness NOW, bypassing the backend's short cache, the
   * wizard's "re-check" button after the user runs the vendor's own login.
   * Returns `null` when the probe is unavailable.
   */
  refreshReadiness(): Promise<VendorReadiness[] | null>;
  /**
   * S1 §5 — "what would a vendor CLI the human starts THEMSELVES get from
   * MUON". Main runs the shared evaluator (`buildMcpStatusReport`) and returns
   * its plain-data report; the renderer only renders it.
   *
   * Read-only and side-effect-free by construction: it spawns no vendor process
   * (it reads each config file directly, so it renders on exactly the broken
   * machine it exists to diagnose) and it starts no brain — a surface that
   * reports whether a brain is running must not change that answer by being
   * opened. Always RESOLVES; a failure comes back as failing checks, never as a
   * rejection, so the Connections row can never spin.
   */
  mcpStatus(): Promise<McpStatusReport>;
  /**
   * Register MUON's MCP server with ONE vendor, at that vendor's default scope.
   * Writes no token, no `MUON_API_BASE` and no `MUON_MCP_MODE` — the same entry
   * `muon mcp install <vendor>` writes, through the same shared writer.
   *
   * Always RESOLVES to a report; a refusal is `outcome.kind === "refused"` with
   * the reason, because a disabled button with no explanation is the dead end
   * first-run UX must never produce.
   */
  mcpInstall(vendor: VendorId): Promise<McpInstallReport>;
  /**
   * ADR-0028 Tier C — mint a governed dispatch seat for a coordinator-seat
   * vendor CLI the human runs themselves, through the SAME operator-tier
   * `attachCoordinator` the CLI's `muon mcp attach` calls: no independent
   * authority lives in the desktop. Main supplies the bound workspace (or the
   * host-owned fresh-install fallback) when a new chat must be created;
   * `chatId` may reuse only the chat main currently selected. Always RESOLVES; a
   * refusal (wrong vendor, seat contention, muon-mcp unresolved, …) comes back
   * as `{kind: "refused", reason}`, never a rejection.
   */
  mcpAttach(input: {
    vendor: VendorId;
    chatId?: string;
  }): Promise<McpAttachResult>;
  /**
   * ADR-0028 Tier C — revoke a vendor's attached-coordinator seat and revert
   * its MCP config to base, through the SAME `detachCoordinator` the CLI
   * calls. Idempotent: detaching an already-clean vendor resolves to
   * `{kind: "not-attached"}` rather than rejecting.
   */
  mcpDetach(vendor: VendorId): Promise<McpDetachResult>;
  /**
   * ROADMAP P7 — list runtime-registered custom (ungoverned) agents from the
   * host's data dir. Main reads the JSON store; the renderer only receives
   * plain entries for the terminal menu / Ungoverned badge. Never a
   * dispatchable VendorId.
   */
  listCustomAgents(): Promise<UngovernedAgentEntry[]>;
  /** One handoff packet as the desk renders it — classified, never raw. */
  taskHandoffs(input: { taskId: string }): Promise<TaskHandoffPage>;
  /**
   * ADR-0036 D4 — this mission's cap and what it has spent, for the BOUND
   * chat. No chatId parameter: main supplies it from the selection, so the
   * renderer cannot read another mission's bill.
   */
  /**
   * Ask the INSTALLED MCP server what it actually serves (`muon mcp probe`).
   * Spawns a real process, so it is operator-initiated and never polled.
   */
  mcpProbe(input?: { mode?: string }): Promise<McpProbeReport>;
  /** Memory's governing policy: TTL, which lifetime table is live, and the
   *  compaction window. Operator tier, machine-wide (not chat-scoped). */
  memoryGovernance(): Promise<MemoryGovernanceState>;
  setMemoryTtl(policy: MemoryTtlPolicy): Promise<MemoryTtlPolicy>;
  setMemoryMining(enabled: boolean): Promise<boolean>;
  setMemoryCompactionRetentionDays(days: number): Promise<number>;
  /** Soft expiry. `dryRun` reports without writing; the desk requires one
   *  before it will apply. */
  sweepExpiredMemory(input: {
    dryRun: boolean;
    maxForget: number;
    /** The digest of the dry run this apply is bound to (409 if stale). */
    previewDigest?: string;
  }): Promise<MemoryExpirySweepResult>;
  /** NOT reversible, unlike a sweep. Same dry-run-first discipline. */
  compactMemory(input: {
    dryRun: boolean;
    maxForget: number;
    previewDigest?: string;
  }): Promise<MemoryCompactionResult>;
  revertExpiredMemoryBatch(batchId: string): Promise<RevertExpiredBatchResult>;
  missionCost(): Promise<MissionCapState>;
  /**
   * Set (or, with null, clear) the BOUND mission's cap. Operator-authored.
   * Refuses NEW dispatch only — it never interrupts a running lane.
   */
  setMissionCostCap(capUsd: number | null): Promise<MissionCapState>;
  /** ADR-0043 operator half: answer one open blocking question. */
  answerQuestion(input: {
    questionId: string;
    taskId: string;
    answer: string;
  }): Promise<{ answered: boolean }>;
  resolveApproval(input: {
    approvalId: string;
    status: "approved" | "rejected";
    /**
     * P0.4: EXPLICIT operator opt-in — mint a content-bound receipt (bounded
     * TTL) alongside an approved decision. Absent = today's decision exactly.
     */
    receiptTtlMs?: number;
    /** Exact operator attestation for a freshly loaded REVIEW BLIND artifact. */
    manualReview?: ManualReviewAttestation;
  }): Promise<ResolveApprovalResult>;
  /**
   * File the governed `kind:"merge"` gate for one finished dispatch — the
   * desktop's `muon ship`. Same payload shape the CLI and TUI send; `jobId`
   * rides along ONLY so main can authorize the renderer against the owning
   * chat. Main NEVER decides the gate here: with gates on the operator decides
   * in Review, and under Full Auto the standing consent decides it on the
   * auto-approver's next poll — one consent site, like every other gate.
   */
  shipTask(input: {
    jobId: string;
    taskId: string;
    requestedBy: string;
    kind: "merge";
    reason: string;
  }): Promise<ShipTaskResult>;
  /** Operator-only, server-derived review state for one merge approval. */
  reviewApproval(approvalId: string): Promise<ReviewCoverageCertification>;
  applyWorkflowProposal(runId: string): Promise<void>;
  dismissWorkflowProposal(runId: string): Promise<void>;
  stopAll(): Promise<StopAllResult>;
  /**
   * Persisted agent output. A chunk may carry `detail` — the bounded, redacted
   * args/result of the tool call its line announced — which is what the tool
   * cards render in their scrollable panel. Absent on every chunk written
   * before that column existed, and on every adapter that captures nothing, so
   * a consumer must treat absence as "no detail", never as "no output".
   */
  streams(query: StreamsQuery): Promise<StreamChunk[]>;
  /**
   * LIVE TERMINAL — one read of a dispatched job's real console (0038).
   *
   * READ-ONLY and OPERATOR tier in main. `jobId` is authorized against its
   * owning chat before a single byte is fetched, so a renderer cannot read a
   * foreign mission's console. Always resolves — see `JobTerminalResponse`.
   *
   * The pane the renderer mounts on this is an ATTACH, never a spawn: the
   * session id it displays (`pty:job:<jobId>:<epoch>`) is refused by the
   * terminal spawn host by construction.
   */
  jobTerminal(query: JobTerminalQuery): Promise<JobTerminalResponse>;
  /**
   * BACKLINK RESUME PROBE (see JobResumeProbe). Read-only: it spawns nothing
   * and holds no session — it only answers whether the resume door would
   * open, so the renderer never draws a button that fails on click.
   */
  jobResumeProbe(query: JobResumeProbeQuery): Promise<JobResumeProbe>;
  /** Begin operator-only GitHub App device authorization. */
  startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart>;
  /** Poll through trusted main; credentials are consumed before this resolves. */
  pollGitHubDeviceFlow(flowId: string): Promise<GitHubDeviceFlowUiPoll>;
  /** Clear backend custody and desktop's private persisted credential. */
  disconnectGitHub(): Promise<GitHubConnectionStatus>;
  /** Resolve an existing PR/checks for the trusted dispatch workspace/branch. */
  githubReview(query: WorkspaceReviewQuery): Promise<GitHubReview>;
  /** Create a PR only after the backend verifies the exact job's landed gate. */
  createGitHubPullRequest(
    query: GitHubCreatePullRequestQuery
  ): Promise<GitHubPullRequestAction>;
  /** Merge the exact reviewed head after checks and the landed gate re-verify. */
  mergeGitHubPullRequest(
    query: GitHubMergePullRequestQuery
  ): Promise<GitHubPullRequestAction>;
  /** Open only a verified github.com device/PR URL in the system browser. */
  openGitHubUrl(url: string): Promise<void>;
  workspaceReview(query: WorkspaceReviewQuery): Promise<WorkspaceReview>;
  /**
   * Crew ROLE PLAN for one chat (`GET /api/crew/roles?chatId=`) — who MUON
   * decided each lane is FOR, with the fit + reason behind the call. Operator
   * tier in main. Always resolves; see CrewRolesResponse for the fail-soft
   * contract. Scoped to the SELECTED chat — a foreign chatId is refused.
   */
  crewRoles(chatId: string): Promise<CrewRolesResponse>;
  /**
   * A2A coordination for one MISSION (`GET /api/a2a/coordination`, plus the
   * operator-tier transcript at `GET /api/a2a/messages`) — participants,
   * file-claim conflicts, message counts and recent envelopes. Operator tier in
   * main. Always resolves; see CoordinationResponse. Scoped to the SELECTED
   * chat. `missionId` is the mission's ROOT jobId and is required by the route:
   * omitting it resolves `unavailable`, never a 400 the renderer must handle.
   */
  coordination(
    chatId: string,
    missionId?: string
  ): Promise<CoordinationResponse>;
  /** ROADMAP 4.1b — the diff mapped to affected execution flows (fail-closed). */
  reviewDiff(query: ReviewDiffQuery): Promise<ReviewDiffResponse>;
  /** ROADMAP 4.1b — the workspace reconnaissance (repo shape + crew recommendation). */
  reconMap(): Promise<ReconMapResponse>;
  /** ROADMAP 4.1b — datastore tables a file writes + co-writers (migration risk). */
  dataBoundaries(query: DataBoundaryQuery): Promise<DataBoundaryResponse>;
  /**
   * P6a, the pre-edit ("Brain") gate for the human. Fuses a target's code
   * blast-radius with the GOVERNED memory anchored to it + pending proposals.
   * The main process calls it with the OPERATOR client (P3-A human surface).
   *
   * ADR-0026 §9: main FORCES both partition coordinates here — the bound chat AND
   * its workspace — so the renderer neither sets nor needs them. This is the gate
   * that fans out one recall per anchor MODULE, and module anchors are
   * workspace-relative, so it is the surface where a cross-repo collision would put
   * another repo's decision in front of an editing agent.
   */
  preEditContext(input: PreEditTargetInput): Promise<PreEditContext>;
  /**
   * Fetch a single note by id INCLUDING its text, the operator-tier note-by-id
   * read the panel uses to pull a pending proposal's (untrusted) text ON DEMAND
   * so a human can read it before adjudicating. Never auto-injected.
   */
  getMemoryNote(noteId: string): Promise<MemoryNote>;
  /** B2, operator-tier shortest governed provenance path for the note inspector. */
  // B3: the memory graph is a mirror, so its outage degrades this call rather
  // than rejecting it. The renderer MUST branch on `degraded` — an empty result
  // without it would render as "this note has no provenance", which is false.
  memoryExplain(
    noteId: string
  ): Promise<MemoryExplainResult & { degraded?: MemoryGraphDegraded }>;
  /**
   * B1, operator-tier BOUNDED neighbourhood of one note — what the brain has
   * linked to it, one hop out. Deliberately takes ONLY a note id: the traversal
   * bounds (hops + node cap) are owned by main, so an untrusted renderer cannot
   * widen a governed graph walk into a whole-graph read.
   *
   * Shows MORE TO THE HUMAN and grants NOTHING to an agent: the backend's text
   * gate is unchanged, so an unconfirmed note comes back coordinates-only and
   * the renderer must never substitute prose it happens to know locally.
   *
   * B3: like `memoryExplain`, a graph outage DEGRADES instead of rejecting. The
   * renderer MUST branch on `degraded` — an empty neighbourhood without it would
   * render as "this note has no neighbours", which is a different and false
   * claim from "the graph could not be consulted".
   */
  memoryNeighbors(
    noteId: string
  ): Promise<MemoryNeighborsResult & { degraded?: MemoryGraphDegraded }>;
  /**
   * Confirm/reject a memory note (operator-tier KG-6 route). Adjudicating a
   * pending PROPOSES_SUPERSEDE: confirm the PROPOSING note to APPLY the supersede,
   * reject to DROP it. The panel refreshes via preEditContext afterwards.
   */
  updateMemoryNote(input: {
    noteId: string;
    confirmed?: boolean;
    status?: "active" | "paused" | "rejected";
    pinned?: boolean;
    trust?: MemoryTrust;
    principal?: string;
  }): Promise<MemoryNote>;
  /** Permanently tombstone one note after main re-checks the selected chat. */
  deleteMemoryNote(noteId: string): Promise<MemoryDeleteResult>;
  /**
   * WIN 3 (founder product decision) — read the #133 operator-tier
   * crew-visible toggle (`autoConfirmAgentMemory`, default ON). The memory UI
   * uses it to FRAME agent-authored, crew-visible notes as already-active
   * ("Auto · crew memory") instead of a "Review needed" queue. Read-only: it
   * never confirms a note, never widens the per-chat blast radius, and never
   * touches the human-only `confirmed` flag. Operator-tier in main.
   */
  getAutoConfirmAgentMemory(): Promise<boolean>;
  /**
   * ADR-0026 §9: `chatId` AND `workspace` are both forced by main from the bound
   * chat and are NOT the renderer's to set — a `workspace` in this query is
   * overridden, exactly as `chatId` already is. The returned notes carry
   * `workspacePath` so the panel can LABEL what it shows (null = the §8 residue).
   */
  memoryLibrary(query?: MemoryLibraryQuery): Promise<MemoryLibrarySnapshot>;
  pickFolder(): Promise<string | null>;
  /**
   * P6, "Run your first task": pick a folder, seed the SAFE sample task into it,
   * and dispatch it to a ready vendor so the fresh user watches the whole loop
   * run. Backed by the OPERATOR client in main; never handles a vendor token.
   */
  runFirstTask(): Promise<FirstTaskResult>;
  /**
   * P6, hero AUTO-CONTEXT: derive a pre-edit target from a task's touched
   * modules/symbols (its recorded events + anchored memory) so the Brain modal
   * pre-fills itself during a real dispatch. Returns null when nothing is
   * derivable (→ the modal falls back to manual entry). Runs in main over the
   * operator client; carries no token.
   */
  autoContext(taskId: string): Promise<AutoContext | null>;
  saveSettings(input: SaveSettingsInput): Promise<DesktopState>;
  savePresets(presets: DesktopPreset[]): Promise<DesktopState>;
  /** Persist crew / orchestrator vendor + per-lane model/effort defaults. */
  saveCrewConfig(crew: NonNullable<RendererSettings["crew"]>): Promise<DesktopState>;
  /** Prefer CLI catalog (`codex debug models`); Claude uses latest aliases. */
  listVendorModels(vendor: VendorId): Promise<VendorModelCatalogIpc>;
  /**
   * U2 — ask the vendor CLI which model it will actually run. Deliberately
   * SEPARATE from `listVendorModels` (which is fetched on app settle) because
   * the probe costs seconds; call it only when a surface is about to display
   * the answer. Cached + single-flighted in main.
   */
  resolveVendorModel(vendor: VendorId): Promise<VendorModelResolutionIpc>;
  /**
   * Resolve a persisted preset by id in trusted main, then apply its allowlisted
   * model/effort/permission fields through the operator-tier lane-profile API.
   * The renderer never submits a raw LaneProfile.
   */
  applyPreset(presetId: string): Promise<ApplyDesktopPresetResult>;
  /**
   * Run an update check against the GitHub releases feed NOW (the manual
   * "Check for updates" button, an explicit, allowed outbound call). Progress
   * arrives via the "muon:update-status" event. No-op-safe when offline.
   */
  checkForUpdates(): Promise<void>;
  /** Download the available update the user just confirmed. */
  downloadUpdate(): Promise<void>;
  /** Quit and install a downloaded update. */
  installUpdate(input?: { force?: boolean }): Promise<void>;
  /** Persist the opt-in automatic on-launch update-check preference. */
  setAutoUpdate(enabled: boolean): Promise<void>;
  /** Persist the S4 auto-continue (durable-nudge) preference. */
  setAutoContinue(enabled: boolean): Promise<void>;
  /** P0-5: gate the LOCAL diagnostics spool (no uploader exists; see observatory.ts). */
  setTelemetryEnabled(enabled: boolean): Promise<unknown>;
  /** F3: counts + funnel timestamps aggregated from the local spool in trusted main. */
  observatorySummary(): Promise<unknown>;
  /** Persist the Full-Auto ("Auto Approve all") operator standing-consent. */
  setFullAuto(enabled: boolean): Promise<void>;
  /**
   * Vendor-scoped standing consent: select exactly which managed lanes
   * auto-approve. Unknown ids are dropped in trusted main; empty = off.
   */
  setFullAutoVendors(vendors: string[]): Promise<void>;
  /** ROADMAP P6 — opt-in localhost preview (`http://127.0.0.1:<port>/` only). */
  setPortPreviewEnabled(enabled: boolean): Promise<void>;
  /** ROADMAP P6 — open the allowlisted preview pane for one localhost port. */
  openPortPreview(port: number): Promise<void>;
  /**
   * Wave 4 §2.5 — the live-terminal byte channel, SEPARATE from the polled
   * streams() path. `open` returns a per-session duplex (a MessageChannelMain
   * port under the hood) that carries BYTES + coordinates only, never a token.
   * Re-opening the same sessionId re-attaches and replays scrollback (reconnect).
   */
  terminal: {
    open(sessionId: string, spawn: TerminalSpawn): Promise<TerminalClientPort>;
    /** Deliberately kill a terminal session; tab switches only detach. */
    close(sessionId: string): Promise<void>;
    /**
     * ROADMAP T4 — the parked-runtime LRU's "from host if available" replay
     * path: read a LIVE session's retained scrollback right now (the SAME
     * ring `snapshotHumanSessions` reads at quit for T1's cold-restore, just
     * asked for while the app keeps running). Used only when a pane's
     * in-memory serialize-addon snapshot was evicted by the LRU cap (or never
     * captured) — the ordinary resume path prefers that richer, local buffer.
     * `null` for an unknown/exited session; never throws.
     */
    scrollback(
      sessionId: string
    ): Promise<{ text: string; cols: number; rows: number } | null>;
    /**
     * ROADMAP T4 — open one ALREADY-ALLOWLISTED OSC-8 hyperlink target
     * (⌘-click). Main RE-VALIDATES independently before doing anything: a
     * `url` target opens through `shell.openExternal` (http(s) only, checked
     * again server-side); a `path` target reveals the file in Finder rather
     * than executing it, and only after confirming it resolves inside the
     * CURRENTLY BOUND workspace — main's own `boundWorkspace`, never a root
     * the renderer supplied. Rejects on a refusal so the click site can stay
     * silent about it (there is no useful recovery action for a human here).
     */
    openLink(target: TerminalLinkTarget): Promise<void>;
  };
  /**
   * ROADMAP T1 — cold-restore for human terminal tabs across a full app
   * quit. Reads (and clears, on main's side) whatever this process captured
   * on the LAST quit before it killed every pty; empty on a clean profile,
   * once already consumed this run, or when the prior quit closed with no
   * human tab open. Every entry comes back FROZEN — read-only captured
   * scrollback, never a live pty. Spawning the fresh session for one is a
   * completely ordinary `terminal.open` call the renderer makes once the
   * operator explicitly acknowledges (T1 step 4); this method never spawns
   * anything itself.
   */
  getHumanTerminalRestore(): Promise<HumanTerminalSnapshotEntry[]>;
  /**
   * ADR-0039: the user's local vendor detection manifest, or null when there
   * is none. Deliberately `unknown` — the renderer validates it through
   * `readDetectionManifest`, which refuses whole rather than trusting a shape
   * asserted at the boundary.
   */
  getDetectionManifest(): Promise<unknown>;
  on<K extends keyof MuonEvents>(
    channel: K,
    callback: (payload: MuonEvents[K]) => void
  ): () => void;
};

/**
 * A handoff packet projected for the desk. The typed packet's prose
 * (whatChanged/whatFailed) is NOT echoed — it already rides `packetBody` —
 * and changedFiles is capped with the omission reported, the same shape
 * `handoff_read` gives an agent.
 */
export type TaskHandoffView = {
  id: string;
  packetTitle: string;
  packetBody: string;
  contract: HandoffPacketContract;
  status: string;
  createdAt: string;
  fromLane: string | null;
  toLane: string | null;
  changedFiles: string[];
  changedFilesOmitted: number;
  checks: { name: string; outcome: HandoffCheckOutcome }[];
  degradedReasons: string[];
  diffVerified: boolean;
};

/**
 * Memory's GOVERNING policy, read in one hop (surface-parity item 6).
 *
 * Bundled rather than three IPC round trips: the panel shows one posture, and
 * three separate reads could land in three different states — a retention
 * window from before a change beside a TTL from after it.
 */
export type MemoryGovernanceState = {
  /**
   * The flat TTL, or NULL when it is not the policy in force.
   *
   * Under a kind-dependent table the flat-TTL endpoints 409 by design — it is
   * not merely unused, it is the wrong question. Reading it unconditionally
   * made the whole panel report "unreadable" on exactly the machines running
   * the newer policy.
   */
  ttl: MemoryTtlPolicy | null;
  /** Which lifetime table is in force. Migration stays on the CLI: it needs
   *  the exact digest of a dry run, and a half-control here could activate a
   *  table nobody previewed. */
  lifecycleSource: "legacy_global" | "kind_table";
  /** Days per kind, when the kind table is the policy in force. */
  daysByKind: Record<string, number> | null;
  compactionRetentionDays: number;
  /**
   * Whether MUON mines memory out of finished runs at all (R4).
   *
   * Its READER is the runner and its route has always existed; the SETTER had
   * no surface on any app, so the posture could only be flipped by hand
   * against the HTTP API. It belongs beside retention: both answer "what does
   * MUON keep, and from what".
   */
  memoryMining: boolean;
};

/**
 * What the RUNNING MCP server serves, scored against this build.
 *
 * `verdict.level` carries `unevaluated` for both "could not resolve a command"
 * and "the server never answered" — neither is a pass, and the UI must not
 * render either as one. `failure` says which.
 */
export type McpProbeReport = {
  /** The binary a vendor would spawn, or null when none resolved. */
  command: string | null;
  mode: string;
  verdict: McpProbeVerdict;
  failure: string | null;
};

/**
 * A mission's cap as the desk shows it.
 *
 * `summary` is the backend's ONE rendering (ADR-0036 D1) and is what a surface
 * displays: the figure and the coverage that qualifies it travel together, so
 * no surface can show a bare total and imply the cap covers lanes that never
 * reported a dollar. The raw `capUsd` is here for the control's own state (is
 * there a cap to clear?), never to be formatted into a sentence of its own.
 */
export type MissionCapState = {
  /**
   * The mission this reading is ABOUT, as main resolved it.
   *
   * Untagged, a cap could be shown under the wrong mission's name: the
   * renderer updates its selection before main's `selectChat` has rebound, so
   * a read issued at that moment answers for the previous mission and the
   * panel had no way to tell (cubic P1). The renderer compares this to the
   * chat it is rendering and discards anything else.
   */
  chatId: string;
  capUsd: number | null;
  capSetBy: string | null;
  summary: string;
  refusesDispatch: boolean;
};

/**
 * One BOUNDED page of handoffs, newest first.
 *
 * The count of dropped rows describes the COLLECTION, so it rides the
 * envelope. It used to be stamped on the last row by positional convention,
 * which quietly bound every producer and consumer to an ordering rule nothing
 * enforced — the next reader to sort or filter these rows would have carried
 * the truncation away with whichever row happened to land last (cubic P2).
 */
export type TaskHandoffPage = {
  items: TaskHandoffView[];
  omitted: number;
};
