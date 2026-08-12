import path from "node:path";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Notification,
  shell,
  Tray,
  globalShortcut,
} from "electron";
import { GRAPH_MIRROR_FAILED_EVENT_KIND } from "@muon/client";
import { describeSandboxAvailability } from "@muon/adapters";
import {
  MuonApiClient,
  buildCapabilityPreflight,
  buildRedispatchInput,
  classifyVendorFailure,
  cleanupQuickstartTasks,
  deriveAutoContext,
  findCustomAgentById,
  findLoopDispatchJob,
  listCustomAgents,
  pickQuickstartVendor,
  seedQuickstartTask,
  type DispatchJobRecord,
  type GitHubConnectionStatus,
  type GitHubCredential,
  type ManualReviewAttestation,
  type PreflightSupervisorEvidence,
  type ReviewCoverageCertification,
  type UngovernedAgentEntry,
  readLockfile,
  type BlockingQuestion,
  type MemoryCompactionResult,
  type MemoryExpirySweepResult,
  type MemoryTtlPolicy,
  type RevertExpiredBatchResult,
} from "@muon/client";
import { setCustomAgentLookup } from "./lib/terminal-spawn.js";
import {
  GLOBAL_PALETTE_SHORTCUT,
  trayPresenceTitle,
  trayPresenceTooltip,
} from "./lib/tray-presence.js";
import {
  defaultCoordinatorVendor,
  type VendorId,
} from "@muon/client/vendors";
// S1 §5 — the desktop's Connections row runs the SAME evaluator and the SAME
// writer as `muon mcp status` / `muon mcp install`. In MAIN, never the
// renderer: those reach node:fs and node:child_process, and the renderer talks
// to the brain only through this typed bridge. Both bodies live in ./lib so a
// test can drive them — an inline handler here is unreachable from a test, and
// a restated evaluator inline passed the whole suite once.
import {
  attachMcpCoordinator,
  detachMcpCoordinator,
  installMcpForVendor,
  readMcpStatus,
  probeMcpServer,
} from "./lib/mcp-bridge.js";
import {
  loadMemoryLibrary,
  type MemoryLibraryQuery,
} from "@muon/client/memory-library";
import {
  createApprovalsMonitor,
  decideApproval,
  mergeOutcomesSnapshot,
  recordMergeOutcome,
  type MonitorState,
} from "./lib/approvals-monitor.js";
import {
  autoApprovePending,
  createFullAutoWatch,
  planFullAutoTick,
  promoteSilencedStandingApprovals,
  reconcileSilencedStanding,
  shouldNotifyApproval,
} from "./lib/full-auto.js";
import { createStandingApproverLeaseHolder } from "./lib/standing-approver.js";
import { createGovernedScheduleExecutor } from "./lib/governed-schedule-executor.js";
import { registerTerminalIpc } from "./lib/terminal-host.js";
import { readTaskHandoffPage } from "./lib/handoff-page.js";
import {
  captureHumanTerminalSnapshot,
  consumeHumanTerminalSnapshot,
} from "./lib/human-terminal-snapshot.js";
import {
  isAllowedTerminalLinkUrl,
  isWithinWorkspaceRoot,
} from "./lib/terminal-link-validate.js";
import type { TerminalLinkTarget } from "./shared/terminal-link-protocol.js";
import {
  resolveTerminalVendorSession,
  resolveTerminalWorkspacePath,
} from "./lib/terminal-workspace-resolver.js";
import {
  canPreviewPortForBoundChat,
  currentListeningPorts,
  startPortMonitor,
  stopPortMonitor,
  toListeningPortSnapshot,
} from "./lib/port-monitor.js";
import {
  closePortPreviewWindows,
  openPortPreviewWindow,
} from "./lib/port-preview-window.js";
import { verifyVendorSessionInStore } from "./lib/vendor-session-store.js";
import { archiveChatAfterStopping, cancelChat } from "./lib/chat-lifecycle.js";
import {
  listRendererStreamChunks,
  readRendererJobTerminal,
} from "./lib/renderer-stream-scope.js";
import { requireRendererWorkflowRun } from "./lib/renderer-workflow-scope.js";
import {
  authorizeRendererTerminalClose,
  createRendererChatOwnership,
  requireArchivableRendererChat,
  requireRendererDispatchJob,
  requireRendererRecordId,
  requireRendererTask,
  requireSelectedRendererChat,
  resolveRendererMcpAttachScope,
} from "./lib/renderer-chat-scope.js";
import { createApprovalNotifier } from "./lib/approval-notifier.js";
import {
  createJobTerminalMonitor,
  detectStuckPattern,
  fileJobTerminalGate,
  reconcileTerminalJob,
  sessionSuspendsAutomation,
  stuckStepsFromChunks,
  type ReconcileDeps,
  type TerminalJobEvent,
} from "./lib/job-terminal-monitor.js";
import { type BrainCoords, BrainSupervisor } from "./lib/brain.js";
import {
  createDesktopDebugSink,
  createLineSplitter,
  desktopLogPath,
  formatBrainLine,
  installMainConsoleTee,
  installRendererConsoleTee,
  isDebugMode,
  safeLine,
} from "./lib/debug-mode.js";
import { isLoopbackApiBase } from "./lib/deep-links.js";
import { fixSpawnPath } from "./lib/path-fix.js";
import { createQuitCoordinator } from "./lib/quit-coordinator.js";
import { resolveAppIconPath } from "./lib/app-icon.js";
import { type RunnerCoords, RunnerSupervisor } from "./lib/runner-supervisor.js";
import { GitNexusIndexSupervisor } from "./lib/gitnexus-index.js";
import { randomUUID } from "node:crypto";
import { existsSync, createWriteStream, mkdirSync, realpathSync, promises as fsPromises } from "node:fs";
import * as fsp from "node:fs/promises";
import { loadGitNexusGraph, resolveBestGraphTarget } from "./lib/gitnexus-graph.js";
import {
  createGraphCacheStore,
  fingerprintFromMeta,
} from "./lib/graph-cache.js";
import { resolveIndexTargets } from "./lib/gitnexus-repos.js";
import {
  githubGateMisconfigured,
  githubGateRequired,
  installGitHubIpcGate,
  type GitHubGateState,
} from "./lib/github-gate.js";
import {
  hydrateBakedEnv,
  readBakedBuildConfig,
} from "./lib/build-config.js";
import {
  coarseCrashReason,
  createObservatory,
  summarizeObservatory,
  type Observatory,
} from "./lib/observatory.js";
import {
  createObservatoryUploader,
  type ObservatoryUploader,
} from "./lib/observatory-upload.js";
import {
  FULL_AUTO_SELECTABLE_VENDORS,
  isGlobalStandingConsent,
  loadSettings,
  normalizeFullAutoVendors,
  persistableSettings,
  saveSettings as persistSettings,
  toRendererSettings,
  type DesktopSettings,
} from "./lib/settings.js";
import {
  alignStockPresetsToVendor,
  normalizeDesktopPresets,
  type DesktopPreset,
  type DesktopPresetVendor,
} from "./lib/presets.js";
import { normalizeCrewConfig } from "./lib/crew-config.js";
import {
  orchestratorReadinessError,
  verifyOrchestratorReadiness,
} from "./lib/orchestrator-readiness.js";
import {
  budgetExhaustedSubmitBlocker,
  gitnexusIndexSubmitBlocker,
} from "./lib/composer-submit-blocker.js";
import { buildBudgetLineView } from "@muon/client/budget-view";
import { resolveLedgerProfile } from "@muon/client/ledger-profile";
import {
  createReadinessCache,
  type ReadinessCache,
} from "./lib/readiness-cache.js";
import { applyDesktopPresetToProfile } from "./lib/preset-profile.js";
import {
  type AutoUpdaterLike,
  createUpdateController,
  type UpdateController,
  type UpdateStatus,
} from "./lib/updater.js";
import {
  confirmBoot,
  MANUAL_FALLBACK,
  performSwap,
  planSwap,
  sha512Base64,
  swapRefusalReason,
} from "./lib/staged-swap.js";
import { stopAllDispatches } from "./lib/cockpit-actions.js";
import { installNavigationGuards } from "./lib/navigation-security.js";
import { waitForFirstTaskCompletion } from "./lib/quickstart-completion.js";
import {
  defaultWorkspaceReviewDependencies,
  loadWorkspaceReview,
} from "./lib/workspace-review.js";
import { fileShipGate } from "./lib/ship-task.js";
import {
  createWorkspacePullRequest,
  isAllowedGitHubExternalUrl,
  loadGitHubReview,
  mergeWorkspacePullRequest,
} from "./lib/github-review.js";
import { loadReviewDiff } from "./lib/review-diff.js";
import {
  defaultJobTreeDependencies,
  harnessWorktreeProbe,
  resolveJobTree,
  type JobTreeDependencies,
} from "./lib/job-tree.js";
import { loadCoordination, loadCrewRoles } from "./lib/crew-topology.js";
import { loadReconMap } from "./lib/recon-map.js";
import { loadDataBoundaries } from "./lib/data-boundaries.js";
import type {
  TaskHandoffPage,
  MissionCapState,
  McpProbeReport,
  MemoryGovernanceState,
  ApplyDesktopPresetResult,
  DesktopState,
  FirstTaskResult,
  FleetCounts,
  GitHubCreatePullRequestQuery,
  GitHubMergePullRequestQuery,
  GitHubDeviceFlowUiPoll,
  MuonEvents,
  RendererSettings,
  ResolveApprovalResult,
  SaveSettingsInput,
  SendMessageResult,
  StatusEvent,
  StreamsQuery,
  JobTerminalQuery,
  JobResumeProbe,
  JobResumeProbeQuery,
  WorkspaceReviewQuery,
  ReviewDiffQuery,
  ReviewDiffResponse,
  ShipTaskResult,
  ReconMapResponse,
  DataBoundaryQuery,
  DataBoundaryResponse,
  CoordinationResponse,
  CrewRolesResponse,
  McpAttachResult,
  McpDetachResult,
  McpInstallReport,
  McpStatusReport,
} from "./shared/ipc.js";

// MUON desktop: a real windowed app (chat + fleet + agent panes) with the
// menu-bar companion kept for at-a-glance status and approval notifications.

// The orchestrator's MCP process spawns vendor CLIs; give Finder launches a
// PATH that can actually resolve them. Must run before any turn starts.
fixSpawnPath();

// Release coordinates baked at package time (build-config.json in Resources).
// Hydrated into process.env HERE — before the gate policy constant below and
// before any brain/runner child spawns (`...process.env`) — because a Finder
// launch has no shell env and the packaged identity gate must still arm.
hydrateBakedEnv(
  process.env,
  readBakedBuildConfig({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
);

// Keep every local surface on the same explicit data root when MUON_DATA_DIR is
// supplied (also gives release smoke tests an isolated, deterministic profile).
const dataDirOverride = process.env.MUON_DATA_DIR?.trim();
if (dataDirOverride) {
  app.setPath("userData", path.resolve(dataDirOverride));
}

// ONE MACHINE, ONE LEDGER (ADR-0050).
//
// Electron derives userData from `productName ?? name`, and this package is
// `@muon/desktop` with no productName — so the desktop's profile was
// `…/Application Support/@muon/desktop` while every other surface resolved
// `…/Application Support/MUON`. Two brains, two databases, and a CLI reporting
// zero for a mission the desk had on screen.
//
// Rebound HERE, before anything reads it, so all ten `getPath("userData")`
// call sites below stay consistent by construction rather than by being
// individually remembered. `resolveLedgerProfile` never merges and never
// guesses: it adopts an existing ledger when that is unambiguous, and when two
// exist it keeps the one already in use and says so.
const ledgerProfile = resolveLedgerProfile(app.getPath("userData"));
if (path.resolve(app.getPath("userData")) !== ledgerProfile.dataDir) {
  // setPath rejects a directory that does not exist yet, which is exactly the
  // fresh-install case.
  mkdirSync(ledgerProfile.dataDir, { recursive: true });
  app.setPath("userData", ledgerProfile.dataDir);
}
if (ledgerProfile.note) {
  console.log(`[muon] ${ledgerProfile.note}`);
}

// ---- debug mode (MUON_DEBUG=1, i.e. `npm run dev:desktop:debug`) ------------
//
// Strictly opt-in. When ON: main-process console output is TEE'd to
// <dataDir>/logs/desktop.log, renderer console output (invisible today unless
// DevTools is open) is forwarded there and to the terminal, and the supervised
// brain + runner mirror their stdio to the terminal. When OFF, `debugSink` is
// null and every call site below is a no-op — identical to today's behaviour.
const debugEnabled = isDebugMode();
const debugSink = debugEnabled
  ? createDesktopDebugSink(app.getPath("userData"))
  : null;
if (debugSink) {
  installMainConsoleTee(debugSink);
}

/** Write one already-formatted debug line to the terminal AND desktop.log. */
function debugLine(line: string): void {
  if (!debugSink) return;
  process.stdout.write(line);
  debugSink.write(line);
}

/**
 * Debug-only startup banner: where the data dir, database, logs and brain are,
 * printed BEFORE the developer has to go hunting for any of them. Never prints a
 * token — only the loopback base the lockfile advertises.
 */
function printDebugBanner(dataDir: string, coords: BrainCoords | null): void {
  if (!debugSink) return;
  const logDir = path.join(dataDir, "logs");
  const rule = "─".repeat(72);
  for (const line of [
    rule,
    " MUON debug mode (MUON_DEBUG=1)",
    ` data dir   ${dataDir}`,
    ` database   ${path.join(dataDir, "muon.db")}`,
    ` brain      ${coords ? coords.base : "NOT STARTED — see brain.log"}`,
    ` logs       ${path.join(logDir, "brain.log")}   (backend, pino JSON)`,
    `            ${path.join(logDir, "runner.log")}  (runner, ISO-stamped)`,
    `            ${desktopLogPath(dataDir)} (main + renderer console)`,
    " triage     npm run debug:report",
    rule,
  ]) {
    debugLine(`${line}\n`);
  }
}

/** Debug-only tee for a supervised child's raw stdio chunks. */
function childTee(
  format: (line: string) => string | null
): ((chunk: string) => void) | undefined {
  if (!debugSink) return undefined;
  return createLineSplitter((line) => {
    const formatted = format(line);
    if (formatted !== null) {
      debugLine(`${formatted}\n`);
    }
  });
}

// The orchestrator packages are ESM; the main bundle is CJS. Dynamic import
// is the supported bridge and keeps startup fast (the Claude Agent SDK chain
// loads on the first chat turn, not at app launch).
type OrchestratorModule = typeof import("@muon/orchestrator");
let orchestratorModule: Promise<OrchestratorModule> | undefined;
function loadOrchestrator(): Promise<OrchestratorModule> {
  orchestratorModule ??= import("@muon/orchestrator");
  return orchestratorModule;
}

// The desktop SUPERVISES a detached, sandboxed, AGENT-token-only `muon runner`
// (ADR-0010 Part A / F-1) instead of hosting the runner loop in Electron main,
// so the dispatched in-process Claude SDK + vendor subprocesses are blinded to
// the MUON data dir (can't `cat brain.lock` for the operator token) and carry
// only the agent token. Steer/interrupt still flow over the loopback API, so a
// detached runner behaves identically to the old in-process one.
let runnerSupervisor: RunnerSupervisor | null = null;
let isQuitting = false;

function runnerCoords(): RunnerCoords {
  return {
    apiBase: settings.apiBase,
    // AGENT-tier token ONLY (P3-A): the operator token NEVER reaches the runner
    // (sandboxedRunnerEnv strips it), so a prompt-injected sub-agent can't govern.
    agentToken: settings.agentToken ?? process.env.MUON_AGENT_TOKEN,
    // Kept in trusted Electron main: used once per generation to authorize the
    // narrow launch lease, never copied into the runner environment.
    operatorToken:
      settings.apiToken ??
      process.env.MUON_OPERATOR_TOKEN ??
      process.env.MUON_API_TOKEN,
    // Full-Auto standing consent: carried into the detached runner (MUON_FULL_AUTO)
    // so workers get the safety block. OFF (default) → env var never set.
    fullAuto: settings.fullAuto,
  };
}

function ensureRunnerSupervisor(): RunnerSupervisor {
  runnerSupervisor ??= new RunnerSupervisor({
    dataDir: app.getPath("userData"),
    host: `desktop-${hostname()}`,
    logDir: path.join(app.getPath("userData"), "logs"),
    onLog: (line) => console.log(`[runner] ${line}`),
    // Debug mode: the detached runner's own stdout/stderr (already timestamped
    // and job-tagged by runner-entry) is mirrored to the launching terminal.
    teeToTerminal: childTee((line) => safeLine(line)),
  });
  return runnerSupervisor;
}

function startRunner(): void {
  if (isQuitting) return;
  void ensureRunnerSupervisor()
    .start(runnerCoords())
    .then((result) => {
      if (debugSink) {
        const status = ensureRunnerSupervisor().getStatus();
        debugLine(
          `${new Date().toISOString()} [runner] status=${status.phase} host=${
            status.host
          } sandbox=${status.sandboxed ? "on" : "off"}${
            status.note ? ` note=${safeLine(status.note)}` : ""
          }\n`
        );
      }
      if (result.started && !result.sandboxed) {
        console.warn(
          "[runner] UNSANDBOXED (sandbox-exec unavailable or MUON_SANDBOX=0), unsandboxed: a dispatched agent could read the operator token"
        );
      }
      if (!result.live && result.note) {
        console.warn(`[runner] ${safeLine(result.note)}`);
      }
    })
    .catch((error) => {
      // TODO 7.1: safeLine → redactedTail for desktop console diagnostics.
      console.error(
        `[runner] failed to start: ${safeLine(
          error instanceof Error ? error.message : String(error)
        )}`
      );
    });
}

/** Point the runner at a new API base after a brain restart (drains the old). */
/**
 * Live jobs as of the last poll. Not authority — only used to decide whether a
 * runner respawn would land on top of running work.
 */
let liveDispatchJobCount = 0;
/** A settings-driven runner respawn that was deferred because work was live. */
let runnerEnvRestartPending = false;

function restartRunner(): void {
  if (isQuitting) return;
  runnerEnvRestartPending = false;
  void ensureRunnerSupervisor()
    .restart(runnerCoords())
    .catch((error) => {
      console.error(
        `[runner] failed to restart: ${safeLine(
          error instanceof Error ? error.message : String(error)
        )}`
      );
    });
}

/**
 * Respawn the runner to pick up a changed ENV PREFERENCE (MUON_FULL_AUTO,
 * MUON_AUTO_CONTINUE) — but never on top of live work.
 *
 * A respawn SIGTERMs the runner, and the runner's children are the vendor
 * sessions: toggling a setting mid-mission killed the founder's coordinator
 * (exit 143) and left its implementer to be reclaimed as `interrupted`
 * (observed 2026-08-04). Neither preference is AUTHORITY — MUON_FULL_AUTO
 * feeds the worker preamble's text and MUON_AUTO_CONTINUE the durable
 * reconciler — so both can safely lag one runner generation. The
 * desktop-side auto-approver, which is what actually grants approvals, changes
 * immediately either way.
 *
 * So: apply now when idle; otherwise defer to the next idle poll and say so.
 */
function restartRunnerForEnvPreference(reason: string): void {
  if (isQuitting) return;
  if (liveDispatchJobCount > 0) {
    runnerEnvRestartPending = true;
    console.log(
      `[runner] ${reason} takes effect for new work; not restarting while ${liveDispatchJobCount} job(s) are in flight (a restart would stop them). It will apply once they finish.`
    );
    return;
  }
  restartRunner();
}

/**
 * SIGTERM the runner and wait for it to drain in-flight jobs (mark them terminal,
 * release agents), but never block quit for more than a few seconds, a stuck
 * session shouldn't wedge the app. Whatever is still running past the deadline
 * is recovered by the runner's own startup reclaim next launch.
 */
async function drainRunner(deadlineMs = 6000): Promise<void> {
  await runnerSupervisor?.stop(deadlineMs);
}

// Best-effort LOCAL GitNexus index for the bound workspace. Fire-and-forget:
// it NEVER blocks startup/quit and fails safe to `unknown` status.
let gitnexusIndex: GitNexusIndexSupervisor | null = null;
// The workspace the index + "Open Graph" read from (same one the supervisor
// tracks). Set by bindWorkspace; read on demand by the graph IPC handler.
let boundWorkspace: string | null = null;
// Renderer-selected active chat. The poller preserves this selection instead of
// repeatedly rebinding every integration to whichever chat happened to update
// most recently.
let boundChatId: string | null = null;
// Monotonic fence for async chat selection. A slow `getChat(A)` must never
// commit after a later `getChat(B)`, and an in-flight state poll/startup bind
// must never overwrite a newer explicit renderer selection.
let boundChatSelectionVersion = 0;
// Every chat this WINDOW has bound, for teardown authorization (see
// createRendererChatOwnership). Written only through bindChat below, which is
// the single writer of `boundChatId` for exactly that reason: a bind that
// skipped the ledger would leave a terminal this window opened with nothing
// able to authorize its close, i.e. a leaked vendor child.
const rendererChatOwnership = createRendererChatOwnership();

/** THE ONE WRITER of `boundChatId`. Binding and recording ownership are the
 *  same act, so they cannot drift apart at a call site. */
function bindChat(chatId: string | null): void {
  boundChatId = chatId;
  rendererChatOwnership.note(chatId);
}

const NO_WORKSPACE_GITNEXUS_STATUS = {
  status: "unknown",
  note: "Select a chat to bind a workspace.",
} as const;

let graphCache: ReturnType<typeof createGraphCacheStore> | null = null;
function ensureGraphCache() {
  graphCache ??= createGraphCacheStore(
    path.join(app.getPath("userData"), "graph-cache")
  );
  return graphCache;
}

async function readGraphMeta(
  workspacePath: string
): Promise<import("./lib/gitnexus-index.js").GitNexusMeta | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      path.join(workspacePath, ".gitnexus", "meta.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as import("./lib/gitnexus-index.js").GitNexusMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function ensureGitNexusIndex(): GitNexusIndexSupervisor {
  gitnexusIndex ??= new GitNexusIndexSupervisor({
    onChange: (status) => sendToRenderer("muon:gitnexus", status),
    onLog: (line) => console.log(`[gitnexus] ${line}`),
  });
  return gitnexusIndex;
}

/** Point the index at a workspace (never throws). */
function bindWorkspace(workspacePath: string | null | undefined): void {
  if (isQuitting) return;
  if (!workspacePath) {
    boundWorkspace = null;
    gitnexusIndex?.stop();
    gitnexusIndex = null;
    sendToRenderer("muon:gitnexus", NO_WORKSPACE_GITNEXUS_STATUS);
    return;
  }
  boundWorkspace = workspacePath;
  try {
    ensureGitNexusIndex().bind(workspacePath);
  } catch (error) {
    console.warn(
      `[gitnexus] bind skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function setAutoContinueEnvironment(enabled: boolean): void {
  // Non-secret consent coordinate. Set explicitly so an inherited shell value
  // can never disagree with the desktop setting; the sandbox allowlist carries
  // only this 0/1 flag into the detached runner.
  process.env.MUON_AUTO_CONTINUE = enabled ? "1" : "0";
}

let mainWindow: BrowserWindow | null = null;
// macOS can emit `activate` while the asynchronous whenReady() bootstrap is
// still waiting for the embedded brain and GitHub credential sync. Never let
// that event create a renderer before its IPC surface exists.
let ipcHandlersRegistered = false;
let tray: Tray | null = null;
let monitorState: MonitorState = { online: false, pending: [], lastError: null };

// Full-Auto standing consent: ids currently being auto-resolved, so overlapping
// poll cycles never double-resolve the same approval. Inert when fullAuto is OFF
// (the onState branch below never runs, so nothing is ever added).
const fullAutoInFlight = new Set<string>();

/**
 * Approval ids that skipped the "review required" toast because standing
 * consent covered them. If they later become uncovered (refused merge, grace),
 * `promoteSilencedStandingApprovals` fires the notification then — once.
 */
const fullAutoSilencedNotify = new Set<string>();

// P0-1: what standing consent has actually managed to do, per approval id. The
// renderer polls `collectState()` every 2s but the auto-approver polls every 5s,
// so a gate Full Auto is ABOUT to grant was visible to the operator — wearing
// the fail-closed "this agent is paused, nothing runs on your behalf" copy — for
// up to a full auto-approver cycle before it silently vanished. This is how the
// renderer tells "MUON is granting this for you" from "this really needs you".
const fullAutoWatch = createFullAutoWatch();
let fullAutoUncovered: string[] = [];
// The POSITIVE half of the same honesty: ids standing consent is actively
// granting, stamped by the same monitor tick that runs the auto-approver. The
// renderer may only say "approving automatically" for an id on THIS list —
// absence (a brand-new approval the classifier has not seen, or main and the
// approvals fetch on different cadences) presents as an ordinary human gate
// until the next tick. The calm label is opt-in per id, never a default.
let fullAutoCovered: string[] = [];

// The heartbeat that tells the RUNNER standing consent is live. Without it the
// coordinator's session gate has no way to know an operator-tier decider is
// watching its inbox, and denies every un-preauthorized tool ("MUON denied:
// coordinator tool 'Bash' … no operator watches") even with Full Auto on.
// `client` is read lazily (through the closure) because applyBrainCoords
// replaces it whenever the embedded brain's coordinates change.
const standingApproverLease = createStandingApproverLeaseHolder(
  {
    renewStandingApproverLease: () => client.renewStandingApproverLease(),
    releaseStandingApproverLease: () => client.releaseStandingApproverLease(),
  },
  (line) => console.log(line)
);

const scheduleExecutor = createGovernedScheduleExecutor({
  client: () => client,
  // Creating a schedule authorizes its start time, never its tools. Claim only
  // while the desktop has positively renewed Full Auto's operator heartbeat;
  // the runner re-checks that same server lease at every gated coordinator call.
  canClaim: async () => {
    // P0-2: a LOCKED app must not start scheduled work — the gate stops the
    // autonomy engines, not just the IPC surface.
    if (githubGateActive()) return false;
    if (!settings?.fullAuto || !standingApproverLease.held()) return false;
    const [grant, runner] = await Promise.all([
      client.getStandingApprover().catch(() => ({ active: false as const })),
      client.getRunner().catch(() => ({ runner: null, live: false })),
    ]);
    return grant.active && runner.live;
  },
  execute: async ({ schedule, occurrence }) => {
    await requireOrchestratorReady(schedule.vendor as VendorId);
    const chat = await client.createChat({
      title: `Scheduled · ${schedule.title}`.slice(0, 120),
      workspacePath: schedule.workspacePath,
    });
    await client.updateScheduleOccurrence({
      scheduleId: schedule.id,
      occurrenceId: occurrence.id,
      status: "running",
      chatId: chat.id,
    });
    const { runChatTurn } = await loadOrchestrator();
    const result = await runChatTurn({
      client,
      chat,
      message: schedule.objective,
      apiBase: settings.apiBase,
      apiToken: settings.agentToken ?? process.env.MUON_AGENT_TOKEN,
      vendor: schedule.vendor as VendorId,
      ...(schedule.model ? { model: schedule.model } : {}),
      ...(schedule.effort ? { effort: schedule.effort } : {}),
      // Not hardcoded true: `canClaim` required global standing consent to
      // start this occurrence, but the operator can withdraw it between claim
      // and execution. Report what is true NOW — a coordinator told "gates are
      // off" when they are on files approvals nobody will answer.
      fullAuto: settings.fullAuto,
      maxWallMs: schedule.maxWallMs,
      maxDescendantWallMs: schedule.maxDescendantWallMs,
    });
    const root = (
      await client.listDispatchJobs({ chatId: chat.id, latest: true, limit: 16 })
    ).find((job) => !job.parentJobId);
    return {
      chatId: chat.id,
      ...(root ? { rootJobId: root.id } : {}),
      ...(result.errorText ? { error: result.errorText } : {}),
    };
  },
  log: (line) => console.log(line),
});

// BUG 2: the notification layer's OWN durable dedup, so one approval id fires
// exactly one "review required" notification for the life of the app even as the
// approvals monitor is rebuilt (fresh `seen` set) on every brain restart. Ids are
// forgotten once they leave the pending set (onState → reconcile).
const approvalNotifier = createApprovalNotifier({
  show: (approval) => {
    const notification = new Notification({
      title: `MUON review required: ${approval.kind}`,
      body: "Open MUON to review the complete bound action, scope, and consequence.",
    });
    notification.on("click", () => openApprovalReview(approval.id));
    notification.show();
  },
});

/**
 * U4 — the tool detail a live activity line may carry on its way to the
 * renderer. Structurally the persisted `StreamChunkDetail`; typed loosely here
 * because it arrives from the orchestrator relay, which main does not own.
 */
type LiveStatusDetail = {
  args?: unknown;
  argsTruncated?: unknown;
  result?: unknown;
  resultTruncated?: unknown;
};

/**
 * Carry a live line's tool detail across the IPC boundary.
 *
 * This BOUNDS; it does not redact. The value was already scrubbed by @muon/
 * core's single redactor before it became a durable chunk, and adding a second
 * redactor here would be a second policy that could drift from the first. What
 * this hop owns is the shape and the size: non-strings are dropped, and each
 * field is clipped at the same bound every other hop uses — args head-kept
 * (the call is its identity), result tail-kept (the end is where the error is).
 *
 * Returns `{}` when there is nothing to carry, so the IPC payload for a line
 * without detail is byte-identical to what it has always been.
 */
const LIVE_STATUS_ARGS_CHARS = 2_048;
const LIVE_STATUS_RESULT_CHARS = 8_192;

/**
 * B1 note-inspector traversal bounds. ONE hop and a small node cap: the panel
 * answers "what is this note attached to", not "show me the graph". Owned by
 * main so the renderer cannot widen them (the route caps at 3 hops / 100 nodes;
 * these are deliberately tighter than the ceiling).
 */
const MEMORY_NEIGHBORS_HOPS = 1;
const MEMORY_NEIGHBORS_LIMIT = 24;

function relayStatusDetail(
  detail: LiveStatusDetail | undefined
): { detail?: NonNullable<StatusEvent["detail"]> } {
  if (!detail || typeof detail !== "object") return {};
  const args =
    typeof detail.args === "string" && detail.args.length > 0
      ? detail.args.slice(0, LIVE_STATUS_ARGS_CHARS)
      : undefined;
  const result =
    typeof detail.result === "string" && detail.result.length > 0
      ? detail.result.slice(-LIVE_STATUS_RESULT_CHARS)
      : undefined;
  if (!args && !result) return {};
  return {
    detail: {
      ...(args
        ? {
            args,
            argsTruncated:
              detail.argsTruncated === true ||
              (typeof detail.args === "string" &&
                detail.args.length > LIVE_STATUS_ARGS_CHARS),
          }
        : {}),
      ...(result
        ? {
            result,
            resultTruncated:
              detail.resultTruncated === true ||
              (typeof detail.result === "string" &&
                detail.result.length > LIVE_STATUS_RESULT_CHARS),
          }
        : {}),
    },
  };
}

/** Push a typed event to the renderer window (no-op if it is gone). */
function sendToRenderer<K extends keyof MuonEvents>(
  channel: K,
  payload: MuonEvents[K]
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---- auto-update (opt-in egress, separate from GitHub review OAuth) ----

let updateController: UpdateController | null = null;

// Push every update transition to the renderer so the check is visible, never
// silent. Also logged for the packaged app's log file.
function pushUpdateStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("muon:update-status", status);
  }
  // F3/F6 review finding: a completed CHECK is a funnel-adjacent fact the
  // vocabulary always declared and nothing recorded — the summary read
  // "update checks: 0" forever. Terminal check states only; consent is
  // enforced inside record().
  if (status.state === "available") {
    observatory?.record({ name: "update.check", updateAvailable: true });
  } else if (status.state === "up-to-date") {
    observatory?.record({ name: "update.check", updateAvailable: false });
  }
  const suffix = "version" in status ? ` ${status.version}` : "";
  console.log(`[updater] ${status.state}${suffix}`);
}

/**
 * Lazily build the update controller over electron-updater's autoUpdater.
 * Returns null (with a transparent status) when unavailable: in dev there is no
 * app-update.yml, and electron-updater may not be installed yet, neither is a
 * crash. The dynamic import uses a non-literal specifier so `tsc` doesn't hard-
 * require the module to exist at build time.
 */
async function getUpdateController(): Promise<UpdateController | null> {
  if (updateController) {
    return updateController;
  }
  if (!app.isPackaged) {
    pushUpdateStatus({
      state: "error",
      message: "updates are only available in a packaged build",
    });
    return null;
  }
  try {
    const moduleName = "electron-updater";
    const mod = (await import(moduleName)) as {
      autoUpdater?: AutoUpdaterLike;
      default?: { autoUpdater?: AutoUpdaterLike };
    };
    const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!autoUpdater) {
      throw new Error("electron-updater exposed no autoUpdater");
    }
    // ADR-0029: unsigned builds installed under /Applications apply via the
    // MUON-owned staged swap; anything else stays check-only (each refusal is
    // an honest status at click time, never a silent downgrade).
    const bundleAtBoot = installedAppBundlePath();
    const refusal = swapRefusalReason({
      packaged: app.isPackaged,
      platform: process.platform,
      appBundlePath: bundleAtBoot,
      ...swapOwnershipEvidence(bundleAtBoot),
    });
    updateController = createUpdateController({
      autoUpdater,
      currentVersion: app.getVersion(),
      onStatus: pushUpdateStatus,
      // Round-3 #2: the governed work a restart would interrupt, by name.
      // A probe failure rejects (the controller fails closed on it).
      liveWork: async () => {
        const jobs = await client.listDispatchJobs({
          activeOnly: true,
          limit: 50,
        });
        return jobs.map(
          (job) => `${job.vendor}#${job.id.slice(0, 6)} (${job.status})`
        );
      },
      ...(refusal === null
        ? { installPolicy: "staged-swap" as const, staged: stagedSwapHooks() }
        : {}),
    });
    if (refusal !== null) {
      console.log(`[updater] staged swap unavailable: ${refusal}`);
    }
    return updateController;
  } catch (error) {
    pushUpdateStatus({
      state: "error",
      message:
        error instanceof Error ? error.message : "electron-updater unavailable",
    });
    return null;
  }
}

/** /Applications/MUON.app when running as an installed bundle, else null. */
function installedAppBundlePath(): string | null {
  const match = process.execPath.match(/^(\/Applications\/[^/]+\.app)\/Contents\/MacOS\//);
  return match ? match[1] : null;
}

/**
 * Round-3 #3 — is a package manager the real owner of this install?
 *
 * Two independent signals, both collected here because staged-swap.ts stays
 * fs-free: (1) the bundle path resolves SOMEWHERE ELSE (a manager's symlink
 * into its own store — the mise/`latest`-link pattern); (2) a Homebrew
 * Caskroom directory claims a muon cask, at either standard prefix. Each
 * lookup degrades to null ("checked, none found") — never to a skipped check.
 */
function swapOwnershipEvidence(bundlePath: string | null): {
  resolvedElsewhere: string | null;
  packageManagerReceipt: string | null;
} {
  let resolvedElsewhere: string | null = null;
  if (bundlePath) {
    try {
      const real = realpathSync(bundlePath);
      resolvedElsewhere = real === bundlePath ? null : real;
    } catch {
      resolvedElsewhere = null;
    }
  }
  let packageManagerReceipt: string | null = null;
  for (const caskroom of [
    "/opt/homebrew/Caskroom/muon",
    "/usr/local/Caskroom/muon",
  ]) {
    try {
      if (existsSync(caskroom)) {
        packageManagerReceipt = caskroom;
        break;
      }
    } catch {
      // unreadable prefix = no receipt found there
    }
  }
  return { resolvedElsewhere, packageManagerReceipt };
}

/**
 * ADR-0029 io: download-with-verify and unpack-swap-relaunch. Only main.ts
 * holds these; the controller stays electron-free and the swap logic stays
 * testable (lib/staged-swap.ts).
 */
function stagedSwapHooks(): NonNullable<
  Parameters<typeof createUpdateController>[0]["staged"]
> {
  // Mirrors electron-builder.yml publish.url — the generic feed origin the
  // check already talks to; files[].url in the feed is relative to it.
  const FEED_BASE = "https://download.getmuon.com";
  const updatesDir = path.join(app.getPath("userData"), "updates");
  return {
    async download(file, onPercent) {
      await fsp.mkdir(updatesDir, { recursive: true });
      // Review finding 7: the feed names artifacts RELATIVE to its own
      // origin. An absolute URL in a feed entry is either misconfiguration or
      // tampering — refuse rather than follow it off-host.
      if (/^[a-z][a-z0-9+.-]*:/i.test(file.url) || file.url.startsWith("//")) {
        throw new Error(
          `update feed entry is not origin-relative (${file.url.slice(0, 64)}). ${MANUAL_FALLBACK}`
        );
      }
      const url = `${FEED_BASE}/${file.url}`;
      const dest = path.join(updatesDir, path.basename(new URL(url).pathname));
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`update download failed: ${res.status}. ${MANUAL_FALLBACK}`);
      }
      const total = Number(res.headers.get("content-length") ?? 0);
      let received = 0;
      const out = createWriteStream(dest);
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) onPercent((received / total) * 100);
        if (!out.write(value)) {
          await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });
      // Verified bytes only: mismatch deletes the file and refuses.
      const digest = sha512Base64(await fsp.readFile(dest));
      if (digest !== file.sha512) {
        await fsp.rm(dest, { force: true });
        throw new Error(
          `update download failed integrity verification. ${MANUAL_FALLBACK}`
        );
      }
      return dest;
    },
    async apply(zipPath, version) {
      const bundle = installedAppBundlePath();
      // Ownership is re-collected AT APPLY TIME, not reused from boot: a cask
      // installed after launch must refuse here, where the rename would land.
      const refusal = swapRefusalReason({
        packaged: app.isPackaged,
        platform: process.platform,
        appBundlePath: bundle,
        ...swapOwnershipEvidence(bundle),
      });
      if (refusal !== null || !bundle) {
        throw new Error(refusal ?? MANUAL_FALLBACK);
      }
      const { execFile } = await import("node:child_process");
      const execFileAsync = (cmd: string, cmdArgs: string[]) =>
        new Promise<void>((resolve, reject) => {
          execFile(cmd, cmdArgs, (error) =>
            error ? reject(error) : resolve()
          );
        });
      const stagingDir = path.join(updatesDir, "staged");
      await fsp.rm(stagingDir, { recursive: true, force: true });
      await fsp.mkdir(stagingDir, { recursive: true });
      const plan = planSwap({
        appBundlePath: bundle,
        stagingDir,
        currentVersion: app.getVersion(),
        newVersion: version,
      });
      await performSwap(plan, zipPath, {
        unpackZip: (zip, dest) => execFileAsync("/usr/bin/ditto", ["-x", "-k", zip, dest]),
        stripQuarantine: (p) =>
          execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", p]),
        exists: (p) => existsSync(p),
        rename: (from, to) => fsp.rename(from, to),
        removeTree: (p) => fsp.rm(p, { recursive: true, force: true }),
      });
      await fsp.rm(zipPath, { force: true }).catch(() => undefined);
      // The bundle at the original path is now the NEW version; relaunch
      // resolves through that path. lastRunVersion still holds the OLD
      // version, so the next boot surfaces the "updated" confirmation.
      //
      // QUIT, NEVER EXIT (review finding 1): app.exit() skips before-quit,
      // which is where the quit coordinator drains the runner, stops the
      // spawned brain, and reaps pty children. Exiting here orphaned the old
      // brain and the relaunched NEW app then adopted it via the lockfile —
      // new app code over stale backend code, immediately after an update.
      app.relaunch();
      app.quit();
    },
  };
}

let settings: DesktopSettings;
// P0-5 local Observatory; created after settings load (consent read live).
let observatory: Observatory | null = null;
// ADR-0031: the consent-gated PostHog uploader riding observatory.onRecord.
let observatoryUploader: ObservatoryUploader | null = null;
// The ONLY token we persist to settings.json: a USER-SUPPLIED operator token
// for a hosted/remote brain (entered in the sidebar). The embedded flow's
// operator + agent tokens are re-minted each boot from the 0600 brain lockfile
// (`applyBrainCoords`), so they live in `settings` for runtime use only and are
// never written to disk. Kept separate so a brain restart overwriting the
// effective `settings.apiToken` with a fresh embedded token never leaks it.
let userApiToken: string | undefined;
let client: MuonApiClient;
let brain: BrainSupervisor | null = null;

/**
 * Persist the durable settings: only the user-supplied token survives, the
 * auto-minted embedded/agent tokens are stripped so they never hit disk. The
 * file is written 0600 (see lib/settings.ts).
 */
function persistUserSettings(): void {
  persistSettings(
    app.getPath("userData"),
    persistableSettings(settings, userApiToken)
  );
}

function storedGitHubStatus(): GitHubConnectionStatus {
  const credential = settings.githubCredential;
  const now = Date.now();
  const clientId = process.env.MUON_GITHUB_CLIENT_ID?.trim() ?? "";
  const accessUsable = Boolean(
    credential &&
      (credential.expiresAt === undefined ||
        Date.parse(credential.expiresAt) > now)
  );
  const refreshUsable = Boolean(
    credential?.refreshToken &&
      (credential.refreshExpiresAt === undefined ||
        Date.parse(credential.refreshExpiresAt) > now)
  );
  return {
    configured: clientId.length >= 8 && clientId.length <= 200,
    connected: accessUsable || refreshUsable,
    ...(credential?.login ? { login: credential.login } : {}),
    ...(credential?.expiresAt ? { expiresAt: credential.expiresAt } : {}),
  };
}

function persistGitHubCredential(credential: GitHubCredential): void {
  const wasGated = githubGateActive();
  settings = { ...settings, githubCredential: credential };
  persistUserSettings();
  // The job monitor snapshots autoContinueEnabled at build time; crossing the
  // gate boundary must rebuild it so auto-continue resumes/stops accordingly.
  if (wasGated && !githubGateActive() && jobMonitor) {
    restartJobMonitor();
  }
}

// ── P0-2 — the GitHub identity gate ─────────────────────────────────────────
// Policy is fixed once per run; SATISFACTION is read live from settings, so a
// completed device flow unlocks every gated channel without a restart. The
// gate is identity, not connectivity: a persisted credential satisfies it
// even offline, and an expired-but-present one still names WHO the operator
// is — re-verification is a Settings action, never a lockout.
const githubGateIsRequired = githubGateRequired({
  env: process.env,
  isPackaged: app.isPackaged,
});

function githubGateActive(): boolean {
  return githubGateIsRequired && !settings.githubCredential;
}

function githubGateState(): GitHubGateState {
  return {
    required: githubGateIsRequired,
    satisfied: Boolean(settings.githubCredential),
  };
}

async function syncGitHubCredential(): Promise<void> {
  if (!settings.githubCredential) {
    return;
  }
  try {
    await client.setGitHubCredential(settings.githubCredential);
  } catch (error) {
    console.warn(
      `[github] could not restore credential to the control plane: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * ADR-0040 D3a — tell the brain a human is here.
 *
 * Best-effort and deliberately not awaited by its callers: presence is a
 * hint, and a brain that is down or too old to have the route must never make
 * the window stutter. Failing to assert fails CLOSED (the daemon ages toward
 * its horizon), which is the safe direction.
 */
function noteHumanPresentNow(): void {
  void makeClient()
    .noteHumanPresent("desktop")
    .catch(() => undefined);
}

/**
 * THE BRAIN CAN MOVE UNDER A LONG-LIVED DESKTOP (measured on the founder's
 * machine, 2026-08-11: the app chased a dead :55666 for six runner-recovery
 * rounds while a live brain sat on another port — every surface read
 * "Control plane offline" and createChat threw ECONNREFUSED).
 *
 * The supervisor's adopt-watch already recovers the case it can SEE; this is
 * the case it cannot: an externally restarted brain (a CLI `muon shutdown` +
 * auto-start mints a fresh port + token) while the app holds the old
 * coordinates. Same remedy as the MCP server and for the same reason — on a
 * CONNECTION-refused failure the client re-reads the lockfile, retries once,
 * and a real move also resyncs `settings`/monitors/runner off the hot path.
 * An EXPLICIT operator-entered base opts out: the human said where to talk.
 */
let brainDataDir: string | null = null;
let apiBaseExplicit = false;

function rebaseFromLockfile():
  | { baseUrl: string; apiToken?: string }
  | null {
  if (apiBaseExplicit || !brainDataDir) return null;
  const lock = readLockfile(brainDataDir);
  if (!lock) return null;
  const base = `http://127.0.0.1:${lock.port}`;
  if (base !== settings.apiBase) {
    // Full resync (settings, monitors, runner) belongs to applyBrainCoords;
    // scheduled so the in-flight request retries immediately on the fresh
    // coordinates without waiting for the restart fan-out.
    setTimeout(() => {
      if (!apiBaseExplicit && base !== settings.apiBase) {
        applyBrainCoords({
          base,
          token: lock.token || undefined,
          agentToken: lock.agentToken || undefined,
        });
      }
    }, 0);
  }
  return {
    baseUrl: base,
    apiToken:
      lock.token || (settings.apiToken ?? process.env.MUON_API_TOKEN),
  };
}

function makeClient(): MuonApiClient {
  return new MuonApiClient(
    settings.apiBase,
    fetch,
    settings.apiToken ?? process.env.MUON_API_TOKEN,
    undefined,
    rebaseFromLockfile
  );
}

/**
 * DISPLAY-ONLY readiness, served without ever blocking a state poll.
 *
 * Every other leg of `collectState()` costs 2–40ms against the loopback brain;
 * the readiness probe costs ~3.8s because it spawns the vendor CLIs (measured:
 * `cursor-agent status` alone is 3.3s). Keeping it inside the poll's
 * `Promise.all` stalled the ENTIRE desktop state — chats, fleet, approvals,
 * dispatch ledger — roughly every fourth poll, and always on the first one.
 *
 * The cache resolves that by answering from what is already known and probing
 * in the background. It is NOT a governance surface: `requireOrchestratorReady`
 * and the brain's dispatch routes keep their own un-cached verdict path, so a
 * value that is a few seconds old can only make a LABEL stale (the UI renders
 * its age), never admit something a fresh probe would refuse.
 */
const readinessCache: ReadinessCache = createReadinessCache({
  probe: (refresh) =>
    client
      .getFleetReadinessReport(refresh ? { refresh: true } : undefined)
      .catch(() => null),
});

// Point every subsystem at the embedded brain's current loopback coordinates.
// Called at boot and again if the supervised brain restarts on a new port.
function applyBrainCoords(coords: BrainCoords): void {
  apiBaseExplicit = false;
  settings = {
    ...settings,
    // Cleared on disk too, or the next launch would restore an opt-out this
    // call just superseded.
    apiBaseExplicit: false,
    apiBase: coords.base,
    apiToken: coords.token ?? settings.apiToken,
    agentToken: coords.agentToken ?? settings.agentToken,
  };
  client = makeClient();
  // A restarted brain is a different control plane: drop the old verdict rather
  // than showing it against the new one, then prime so the first Crew/Status
  // paint after the restart already has real evidence instead of a spinner.
  readinessCache.clear();
  readinessCache.prime();
  void syncGitHubCredential();
  restartMonitor();
  restartJobMonitor();
  restartRunner();
}

// The MUON app icon. Packaged builds carry Resources/icon.icns; in dev it sits
// beside dist/ under build/. The dock reads the
// .icns from the bundle automatically, but setting it explicitly makes
// `npm run dev` (and the window) show the MUON mark too.
function appIconPath(): string {
  return resolveAppIconPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hiddenInset",
    icon: appIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Pin the OS-process sandbox explicitly (don't rely on the Electron ≥20
      // default). The preload is written self-contained for a sandboxed context
      // (only `require("electron")`), so this changes nothing at runtime.
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // GitNexus OSS caches under `<repo>/.gitnexus/` and detects HEAD staleness.
  // There is no post-commit hook in our integration — nudge ensureIndexed when
  // the window is focused so commits made outside the app get picked up.
  mainWindow.on("focus", () => {
    gitnexusIndex?.ensureIndexed();
    noteHumanPresentNow();
  });

  // ADR-0040 D3a — HUMAN PRESENCE, asserted only while the window is both
  // VISIBLE and FOCUSED.
  //
  // Not process liveness: `window-all-closed` deliberately keeps this app
  // alive as a tray companion, and its monitors keep polling the brain with
  // the operator token forever. That polling is exactly why the horizon could
  // never fire before — a daemon nobody was watching read as attended. A
  // visible, focused window is the strongest presence signal this surface has.
  const attendanceTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
      noteHumanPresentNow();
    }
  }, 30_000);
  attendanceTimer.unref?.();
  mainWindow.on("closed", () => clearInterval(attendanceTimer));

  installNavigationGuards(mainWindow.webContents);

  // A blank window must never be the whole story. Two failure modes reach
  // here, and NEITHER is caught by the React error boundary (that one only
  // sees render throws): the renderer process dying natively, and the document
  // failing to load at all. Both previously left an empty frame with nothing
  // written anywhere. Log them unconditionally — not behind MUON_DEBUG,
  // because this is exactly the state a founder needs to report.
  // BOUNDED recovery. A deterministic renderer death at load (OOM on a large
  // restored scrollback, a GPU kill) would otherwise reload → die → reload in a
  // tight loop that pegs the CPU and buries the cause in its own log spam. Two
  // attempts inside one window, then stop and leave the last error standing:
  // an app that says why it is blank beats one that thrashes.
  let rendererGoneAt = 0;
  let rendererReloads = 0;
  const RENDERER_RELOAD_WINDOW_MS = 60_000;
  const RENDERER_RELOAD_LIMIT = 2;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[renderer] process gone (reason=${details.reason}, exitCode=${details.exitCode})`
    );
    // P0-5: a coarse, closed-vocabulary crash record in the local spool
    // (consent-gated; no prose, no paths — see observatory.ts).
    observatory?.record({
      name: "app.crash.renderer",
      reason: coarseCrashReason(details.reason),
    });
    if (details.reason === "clean-exit") return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const now = Date.now();
    if (now - rendererGoneAt > RENDERER_RELOAD_WINDOW_MS) {
      rendererReloads = 0;
    }
    rendererGoneAt = now;
    rendererReloads += 1;
    if (rendererReloads > RENDERER_RELOAD_LIMIT) {
      console.error(
        `[renderer] ${rendererReloads - 1} reloads inside ${
          RENDERER_RELOAD_WINDOW_MS / 1000
        }s did not stick; not reloading again. The brain, the runner and every ` +
          "running agent are separate processes and keep going. Quit and relaunch " +
          "MUON, and report the reason above."
      );
      return;
    }
    mainWindow.webContents.reload();
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[renderer] did-fail-load ${errorCode} ${errorDescription} (${validatedURL})`
      );
    }
  );

  // Debug mode: the renderer's console is invisible unless DevTools is open.
  // Forward it to the terminal and desktop.log so a renderer error is diagnosable
  // from the same place as everything else.
  if (debugSink) {
    installRendererConsoleTee(mainWindow.webContents, debugLine);
  }

  // Cmd/Ctrl+W closes the active closable workspace tab (renderer), never the
  // whole app. Mission chat is not closable.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      (input.control || input.meta) &&
      !input.alt &&
      !input.shift &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("muon:close-active-tab", null);
      }
    }
  });

  // Red-X / menu Close → confirm quit (tray apps otherwise just hide).
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    void dialog
      .showMessageBox(mainWindow!, {
        type: "question",
        buttons: ["Quit MUON", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Quit MUON?",
        message: "Quit MUON?",
        detail:
          "This closes the desktop window and stops the local control plane session. Running agent jobs may still be interrupted on quit.",
      })
      .then(({ response }) => {
        if (response === 0) {
          isQuitting = true;
          app.quit();
        }
      });
  });

  void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function focusWindow(): void {
  if (!ipcHandlersRegistered) {
    return;
  }
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function openApprovalReview(approvalId: string): void {
  focusWindow();
  const send = () =>
    mainWindow?.webContents.send("muon:open-approval", { approvalId });
  if (mainWindow?.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

// ---- state collection (one IPC call per renderer poll) ----

async function collectState(): Promise<DesktopState> {
  const selectionVersionAtPollStart = boundChatSelectionVersion;
  // Non-secret projection: the raw operator/api token NEVER crosses to the
  // renderer, only a boolean indicator (set vs embedded/auto) does.
  const rendererSettings: RendererSettings = toRendererSettings(
    settings,
    userApiToken
  );
  const appVersion = app.getVersion();
  const supervisorStatus = runnerSupervisor?.getStatus();
  // Supervisor evidence for the doctor contract: phase + sandbox only, the
  // host label never enters the preflight (machine-identity-free contract).
  const supervisorEvidence: PreflightSupervisorEvidence | undefined =
    supervisorStatus
      ? {
          phase: supervisorStatus.phase,
          sandboxed: supervisorStatus.sandboxed,
          // Round-3 #9: WHY confinement is off, so the preflight stops
          // telling every non-macOS host to restart to restore something
          // that platform never had. Derived here (node side) and passed as
          // a label; the preflight projection stays browser-safe.
          sandboxAvailability: describeSandboxAvailability(),
          note: supervisorStatus.note,
        }
      : undefined;
  // Readiness is read OFF the critical path. `read()` never awaits a vendor
  // subprocess: it answers from the main-process cache and schedules a probe in
  // the background when the value is older than the display TTL. Before this,
  // this one leg cost ~3.8s and held every other leg below hostage.
  const readinessSnapshot = readinessCache.read();
  const readinessReport = readinessSnapshot.report;
  try {
    const [
      fleet,
      chats,
      approvals,
      tasks,
      runner,
      allWorkflowRuns,
      loopRuns,
      schedules,
      recentDispatchJobs,
      selectedActiveDispatchJobs,
      allActiveRootJobs,
      auditEvents,
      mirrorFailures,
      activeReceipts,
      github,
      openQuestions,
    ] =
      await Promise.all([
        client.getFleet(),
        client.listChats(),
        client.listApprovals(),
        client.listTasks(),
        // null (not {live:false}) on a FAILED read: the preflight maps null to
        // the honest unknown/RUNNER_UNKNOWN state instead of claiming offline.
        client.getRunner().catch(() => null),
        // TODO 5.17: every workflow (not only proposed) belongs on commitments.
        client.listWorkflowRuns().catch(() => []),
        // TODO 5.17: every live/recent loop belongs on the commitments screen.
        client.listLoopRuns().catch(() => []),
        client.listSchedules().catch(() => []),
        client.listDispatchJobs({ latest: true, limit: 24 }).catch(() => []),
        boundChatId
          ? client
              .listDispatchJobs({
                chatId: boundChatId,
                activeOnly: true,
                limit: 200,
              })
              .catch(() => [])
          : Promise.resolve([]),
        // ADR-0028 attachment is a GLOBAL per-vendor seat, so its status must
        // not disappear when it belongs to another chat or falls outside the
        // 24-row recent window. Active roots are bounded by the finite fleet;
        // the API limit remains an explicit defensive ceiling.
        client
          .listDispatchJobs({ activeRootOnly: true, limit: 200 })
          .catch(() => []),
        client.listRecentEvents(50).catch(() => []),
        // THE DEGRADATION SIGNAL, asked for BY NAME rather than hoped for.
        //
        // `memory.graph_mirror_failed` had exactly one consumer — the 50-row poll
        // above — and `reportMirrorFailure` justifies its coalescing on "the
        // operator surfaces that already read the event log show that memory is
        // degraded". Once every pre-edit gate read files its own Event, a
        // once-per-30s mirror failure loses that race as a matter of course, so
        // the justification stopped holding. One extra bounded request removes the
        // race instead of widening the window and hoping.
        client
          .listRecentEvents(1, GRAPH_MIRROR_FAILED_EVENT_KIND)
          .catch(() => []),
        // P0.4: live receipts for the inbox annotation. Older brains without
        // the route degrade to an empty list, never an error.
        client.listReceipts({ activeOnly: true }).catch(() => []),
        // Local control-plane status only: this never calls GitHub and never
        // returns a credential. Older brains fall back to the private settings
        // posture so renderer state remains token-free.
        client.getGitHubStatus().catch(() => storedGitHubStatus()),
        // Surface-parity audit 2026-08-11: the open-questions INBOX. Agents
        // file blocking questions (ADR-0043) and until this leg only the CLI
        // could see them. Degrades to an empty inbox, never an error.
        client
          .listOpenQuestions()
          // Failure is DATA, not an empty inbox: a hidden blocking question
          // is the exact harm this leg exists to end (cubic P1). The renderer
          // shows "unavailable", never a silently-empty list.
          .then((result) => ({ ...result, unavailable: false }))
          .catch(() => ({
            questions: [] as BlockingQuestion[],
            truncated: false,
            unavailable: true,
          })),
      ]);
    // Preserve the renderer-selected chat across polls. If it vanished (archive
    // from another surface), fall back to the newest active chat; with no chats,
    // tear every workspace integration down immediately.
    if (selectionVersionAtPollStart === boundChatSelectionVersion) {
      const selectedChat = boundChatId
        ? chats.find((chat) => chat.id === boundChatId)
        : undefined;
      const nextBoundChat = selectedChat ?? chats[0] ?? null;
      bindChat(nextBoundChat?.id ?? null);
      bindWorkspace(nextBoundChat?.workspacePath);
    }
    // Live-work signal for `restartRunnerForEnvPreference`: a runner respawn
    // SIGTERMs its vendor children, so a settings change must wait for idle
    // rather than stopping a mission. Recomputed every poll; a deferred change
    // is applied the moment the last job settles.
    liveDispatchJobCount = allActiveRootJobs.filter(
      (job) => job.status === "queued" || job.status === "running"
    ).length;
    // P0-5 activation funnel — derived from ledger FACTS on the poll we
    // already run, never from renderer claims. Each fires once per profile
    // (the milestone file dedupes); consent-gated inside record().
    if (
      readinessReport?.anyReady === true ||
      readinessReport?.vendors?.some(
        (vendor) => vendor.installed && vendor.authenticated
      ) === true
    ) {
      // The stage BEFORE first_chat: the moment a machine first has a usable
      // lane. The install->activation gap between this stamp and first_chat
      // is the onboarding number that matters.
      observatory?.record({ name: "funnel.first_vendor_ready" });
    }
    if (chats.length > 0) {
      observatory?.record({ name: "funnel.first_chat" });
    }
    if (allActiveRootJobs.length > 0 || recentDispatchJobs.length > 0) {
      observatory?.record({ name: "funnel.first_dispatch" });
    }
    if (
      Object.values(mergeOutcomesSnapshot()).some(
        (outcome) => outcome.status === "merged"
      )
    ) {
      // Only a merge that LANDED counts as the activation milestone — the
      // outcome map also records no-op/conflict/blocked/failed, and a
      // once-per-profile "user shipped" stamp must not be spent on a failure.
      observatory?.record({ name: "funnel.first_merge" });
    }
    if (liveDispatchJobCount === 0 && runnerEnvRestartPending) {
      console.log(
        "[runner] applying the deferred preference change now that no jobs are in flight."
      );
      restartRunner();
    }

    return {
      online: true,
      lastError: null,
      // MEMORY IS DEGRADED, surfaced as state rather than left in a log nobody
      // filters. `reportMirrorFailure` coalesces per label on the stated
      // assumption that an operator surface reading the event log would show it;
      // this is that surface actually doing so.
      memoryDegraded: mirrorFailures.length > 0,
      runnerLive: runner?.live ?? false,
      realPty: terminalRealPty(),
      runnerStatus: supervisorStatus,
      gitnexus:
        gitnexusIndex?.getStatus() ?? { ...NO_WORKSPACE_GITNEXUS_STATUS },
      settings: rendererSettings,
      github,
      githubGate: githubGateState(),
      fullAuto: settings.fullAuto,
      fullAutoVendors: [...settings.fullAutoVendors],
      fullAutoUncoveredApprovalIds:
        settings.fullAutoVendors.length > 0 ? [...fullAutoUncovered] : [],
      fullAutoCoveredApprovalIds:
        settings.fullAutoVendors.length > 0 ? [...fullAutoCovered] : [],
      // Decided-merge facts (bounded, keyed by approval id) so the Changes
      // panel can report "landed as <sha>" for a gate Full Auto decided after
      // the file call had already returned.
      mergeOutcomes: mergeOutcomesSnapshot(),
      fleet,
      chats,
      approvals: approvals.filter((entry) => entry.status === "pending"),
      // OPEN blocking questions, machine-wide (a pending human decision, like
      // an approval — the Control badge counts both).
      questions: openQuestions.questions,
      questionsTruncated: openQuestions.truncated,
      questionsUnavailable: openQuestions.unavailable,
      tasks,
      workflowProposals: allWorkflowRuns.filter(
        (run) =>
          run.status === "proposed" &&
          (!boundChatId || run.chatId === boundChatId)
      ),
      workflowRuns: allWorkflowRuns,
      loopRuns,
      schedules,
      dispatchJobs: [
        ...new Map(
          [
            ...recentDispatchJobs,
            ...selectedActiveDispatchJobs,
            ...allActiveRootJobs,
          ].map((job) => [job.id, job])
        ).values(),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      auditEvents,
      activeReceipts,
      readiness: readinessReport?.vendors ?? null,
      readinessMeta: readinessSnapshot.meta,
      // P0.5: the SAME contract the CLI/MCP surfaces project, built from the
      // already-fetched state (no extra probe).
      preflight: buildCapabilityPreflight({
        brain: { reachable: true },
        readiness: readinessReport,
        runner,
        // The SAME worker rows the claim semaphore selects from, so the seats
        // the doctor reports are the seats a dispatch can actually get.
        fleet,
        supervisor: supervisorEvidence,
      }),
      appVersion,
      listeningPorts: currentListeningPorts()
        .filter((port) => port.owner?.chatId)
        .map(toListeningPortSnapshot),
      portPreviewEnabled: settings.portPreviewEnabled,
      telemetryEnabled: settings.telemetryEnabled,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreachable";
    return {
      online: false,
      lastError: message,
      // The brain is UNREACHABLE, which is not the same fact as "memory is
      // degraded" — `online: false` already says the stronger thing, and
      // asserting a degradation we could not observe would be a guess.
      memoryDegraded: false,
      runnerLive: false,
      realPty: terminalRealPty(),
      runnerStatus: supervisorStatus,
      gitnexus:
        gitnexusIndex?.getStatus() ?? { ...NO_WORKSPACE_GITNEXUS_STATUS },
      settings: rendererSettings,
      github: storedGitHubStatus(),
      githubGate: githubGateState(),
      fullAuto: settings.fullAuto,
      fullAutoVendors: [...settings.fullAutoVendors],
      // Brain unreachable: no pending approvals to describe either way.
      fullAutoUncoveredApprovalIds: [],
      fullAutoCoveredApprovalIds: [],
      fleet: null,
      chats: [],
      approvals: [],
      questions: [],
      questionsTruncated: false,
      questionsUnavailable: true,
      tasks: [],
      workflowProposals: [],
      workflowRuns: [],
      loopRuns: [],
      schedules: [],
      dispatchJobs: [],
      auditEvents: [],
      activeReceipts: [],
      // A brain outage does not un-install or sign out the LOCAL vendor CLIs,
      // so the last probed lane evidence is still the honest answer — and its
      // `readinessMeta` age/error say plainly how old it is and why it stopped
      // refreshing. The PREFLIGHT below still passes readiness:null, because
      // the doctor contract must report an unreachable control plane as the
      // hard failure it is rather than papering over it with lane evidence.
      readiness: readinessReport?.vendors ?? null,
      readinessMeta: readinessSnapshot.meta,
      preflight: buildCapabilityPreflight({
        brain: { reachable: false, detail: message },
        readiness: null,
        runner: null,
        supervisor: supervisorEvidence,
      }),
      appVersion,
    };
  }
}

// ---- tray (menu-bar companion survives the rebuild) ----

function trayTitle(): string {
  return trayPresenceTitle({
    online: monitorState.online,
    pendingCount: monitorState.pending.length,
  });
}

function rebuildTrayMenu(): void {
  if (!tray) {
    return;
  }

  const approvalItems: MenuItemConstructorOptions[] =
    monitorState.pending.length === 0
      ? [{ label: "No pending approvals", enabled: false }]
      : monitorState.pending.slice(0, 10).map((approval) => ({
          label: `Review ${approval.kind} request · ${approval.requestedBy}`,
          click: () => openApprovalReview(approval.id),
        }));

  const menu = Menu.buildFromTemplate([
    {
      label: monitorState.online
        ? `Brain online, ${settings.apiBase}`
        : `Brain offline, ${monitorState.lastError ?? "unreachable"}`,
      enabled: false,
    },
    { type: "separator" },
    { label: "Open MUON", click: () => focusWindow() },
    { type: "separator" },
    { label: `Approvals (${monitorState.pending.length})`, enabled: false },
    ...approvalItems,
    { type: "separator" },
    // "Open TUI in Terminal" and "Open Hub Dashboard" are gone deliberately:
    // both backed dev-only coordinates (`npm run tui` is a repo script that
    // fails from a packaged app's home-dir Terminal; the "Hub Dashboard" URL
    // pointed at a localhost dev server route that does not exist) and
    // neither setting was editable anywhere in the UI. A tray item that can
    // only fail is worse than none.
    { label: "Quit MUON", role: "quit" },
  ]);

  tray.setContextMenu(menu);
  tray.setTitle(trayTitle());
  tray.setToolTip(
    trayPresenceTooltip({
      online: monitorState.online,
      pendingCount: monitorState.pending.length,
    })
  );
}

function makeMonitor() {
  return createApprovalsMonitor(client, {
    onState: (next) => {
      monitorState = next;
      rebuildTrayMenu();
      // BUG 2: forget notified ids once they leave the pending set, so the
      // dedup set stays bounded and only holds live approvals.
      approvalNotifier.reconcile(next.pending);
      reconcileSilencedStanding({
        silenced: fullAutoSilencedNotify,
        pending: next.pending,
      });
      // Renew (or release) the standing-approver lease on the SAME cycle that
      // drives the auto-approver below, so what the RUNNER is told about standing
      // consent can never outlive the process actually supplying it. Deliberately
      // NOT conditioned on `pending.length`: the coordinator has to know an
      // approver is watching BEFORE it files anything, which is exactly the case
      // where the queue is still empty.
      void standingApproverLease.reconcile({
        fullAuto: settings.fullAuto,
        online: next.online,
      });
      // Full-Auto standing consent: drive the SAME operator resolveApproval path
      // a human click uses — for the approvals the SELECTED lanes cover. The
      // vendor of each approval is server-derived (laneVendor); a subset
      // selection leaves every other approval (unselected lane, or no
      // resolvable lane at all) as an ordinary fail-closed human gate. All
      // lanes selected reproduces the legacy "Auto-approve all" exactly.
      // `client` here is the operator client (makeClient) — the two-token model
      // is preserved: the operator is approving, just automatically. Withheld
      // egress-gate actions never reach `pending`, so egress stays an explicit,
      // un-auto-consented lever. Fully inert when no vendor is selected.
      // ONE pure decision for the whole tick (see planFullAutoTick for why it
      // is extracted): ANY armed lane drives the approver — never the derived
      // ALL-lanes `settings.fullAuto`, which exists for the three unscoped
      // consumers (standing-approver lease, runner env, schedule canClaim) and
      // once made a subset selection silently inert here.
      const tick = planFullAutoTick({
        // P0-2: while the identity gate is locked, standing consent is
        // suspended outright — a locked app must not grant approvals on the
        // operator's behalf. Read live: unlocking re-arms on the next tick.
        pending: next.pending,
        selectedVendors: githubGateActive() ? [] : settings.fullAutoVendors,
        selectableVendors: FULL_AUTO_SELECTABLE_VENDORS,
        online: next.online,
        watch: fullAutoWatch,
      });
      fullAutoUncovered = tick.uncovered;
      fullAutoCovered = tick.covered;
      // Covered→uncovered (refused merge / grace): the toast was suppressed
      // when standing consent claimed them; promote now that the human is
      // required. Cold-start pending never enters fullAutoSilencedNotify, so
      // this cannot storm on launch.
      for (const approval of promoteSilencedStandingApprovals({
        silenced: fullAutoSilencedNotify,
        uncoveredIds: tick.uncovered,
        pending: next.pending,
      })) {
        approvalNotifier.notify(approval);
      }
      if (tick.toApprove.length > 0) {
        void autoApprovePending(
          client,
          tick.toApprove,
          fullAutoInFlight,
          // console.log = the packaged app's log-file audit sink.
          (line) => console.log(line),
          fullAutoWatch.refused
        );
      }
    },
    // Standing consent covers an approval → silent. Uncovered (or standing
    // consent off) → "review required". Dedup lives in the notifier.
    onNewApproval: (approval) => {
      const selectedVendors = githubGateActive()
        ? []
        : settings.fullAutoVendors;
      if (
        !shouldNotifyApproval({
          approval,
          selectedVendors,
          selectableVendors: FULL_AUTO_SELECTABLE_VENDORS,
          refusedIds: fullAutoWatch.refused,
        })
      ) {
        fullAutoSilencedNotify.add(approval.id);
        return;
      }
      approvalNotifier.notify(approval);
    },
  });
}

let monitor: ReturnType<typeof makeMonitor>;
let portMonitor: ReturnType<typeof startPortMonitor> | null = null;

/**
 * How fast the approvals monitor polls while Full Auto is ON.
 *
 * Under standing consent every pending approval is going to be granted, so the
 * poll interval is pure DEAD TIME between a governed action being filed and it
 * being allowed to proceed. That cost used to be invisible: a coordinator tool
 * call was fast-denied outright, so nothing waited on this loop. Now that the
 * standing-approver lease lets a coordinator FILE and wait, this interval IS
 * the superagent's gate latency — at the 5s default, every `Bash` it runs
 * stalls for up to a full cycle.
 *
 * Deliberately narrow: only the approvals monitor, and only while Full Auto is
 * on. With Full Auto off an approval waits on a human anyway, so a tighter
 * cadence would buy nothing and only add wakeups. The brain is loopback SQLite,
 * so this is cheap; `min` with the operator's own setting so a human who
 * already chose something faster is never slowed down.
 */
const FULL_AUTO_POLL_MS = 1_000;

function approvalPollIntervalMs(): number {
  // Any armed lane, not the derived ALL-lanes boolean: under a subset the poll
  // interval is still the covered lanes' gate latency.
  return settings.fullAutoVendors.length > 0
    ? Math.min(FULL_AUTO_POLL_MS, settings.pollIntervalMs)
    : settings.pollIntervalMs;
}

function restartMonitor(): void {
  monitor.stop();
  monitor = makeMonitor();
  monitor.start(approvalPollIntervalMs());
}

// ---- IPC ----

/** Show the native folder picker; returns the chosen path or null if canceled. */
async function pickWorkspaceFolder(): Promise<string | null> {
  const options = {
    title: "Pick the folder your crew works in",
    properties: ["openDirectory", "createDirectory"],
  } satisfies Electron.OpenDialogOptions;
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

const runningTurns = new Set<string>();

// ---- S4: durable orchestration (terminal-event nudge + continue affordance) ----

// Worker output is untrusted agent data; only the tail rides into the nudge
// envelope (payload-is-data), never the full result and never as instructions.
const JOB_RESULT_TAIL_MAX = 2000;

// Per-chat count of machine-synthesized reconciliation turns since the last
// human message (reset when the human speaks or clicks Continue). With the cap
// in decideContinuation this makes auto-continue a finite, human-bounded loop.
const autoTurnCounts = new Map<string, number>();

// S10: the per-chat default model, mirrored from the renderer's picker/`/model`
// on each human turn so machine turns (auto-continue nudge, [Continue]) run the
// orchestrator on the SAME model the human chose. Client-held only (no
// persistence this slice); the route re-validates it fail-closed per dispatch.
const chatModels = new Map<string, string>();

/**
 * Read the cached readiness verdict first. Only a definite block triggers one
 * cache-bypassing probe, matching the runner's fail-before-claim behavior
 * without adding a vendor CLI probe to every healthy Mission turn.
 */
async function requireOrchestratorReady(
  vendor: DesktopSettings["crew"]["orchestratorVendor"]
): Promise<void> {
  const issue = await verifyOrchestratorReadiness(vendor, (refresh) =>
    client.getVendorReadiness(refresh ? { refresh: true } : undefined).catch(
      () => null
    )
  );
  if (issue?.blocking) {
    throw new Error(orchestratorReadinessError(issue));
  }
}

/** Run ONE enveloped reconciliation turn for a terminal worker job. */
async function runEventTurn(
  chatId: string,
  job: DispatchJobRecord
): Promise<void> {
  const { runChatTurn } = await loadOrchestrator();
  // Fetch fresh: the vendorSessionId must be current to resume the session.
  const chat = await client.getChat(chatId);
  if (chat.status === "archived") {
    return;
  }
  const crew = settings.crew;
  await requireOrchestratorReady(crew.orchestratorVendor);
  await runChatTurn({
    client,
    chat,
    // Unused for event turns (no `[you]` milestone / titling); kept legible.
    message: `job ${job.id} terminal`,
    apiBase: settings.apiBase,
    // AGENT-tier token (P3-A): the reconciliation turn runs WITHOUT govern
    // authority, identical to a human-typed turn — it files gates, never grants.
    apiToken: settings.agentToken ?? process.env.MUON_AGENT_TOKEN,
    // Operator-chosen orchestrator seat (claude-code | codex).
    vendor: crew.orchestratorVendor,
    // S10: prefer the chat's chosen model; else the crew orchestrator default.
    model:
      chatModels.get(chatId) ||
      crew.orchestratorModel ||
      undefined,
    effort: crew.orchestratorEffort || undefined,
    // Full-Auto: a machine reconciliation nudge carries the same safety block so
    // the gates-off orchestrator stays conservative even off a human turn.
    fullAuto: settings.fullAuto,
    event: {
      jobId: job.id,
      taskId: job.taskId,
      status: job.status,
      exitCode: job.exitCode ?? null,
      resultTail: (job.result ?? "").slice(-JOB_RESULT_TAIL_MAX),
    },
    onAssistantText: (text, mode) =>
      sendToRenderer("muon:assistant", { chatId, text, mode }),
    // U4: forward the ledger's bounded/redacted tool detail when the relay
    // supplies one. Main never derives or re-redacts it — the chunk arrives
    // already scrubbed by the single redactor and already bounded at the
    // adapter; this hop only carries it. See `relayStatusDetail`.
    onStatus: (line: string, detail?: LiveStatusDetail) =>
      sendToRenderer("muon:status", {
        chatId,
        line,
        ...relayStatusDetail(detail),
      }),
  });
}

/**
 * Reclaimed/interrupted job (outcome unknown): file a human gate instead of an
 * autonomous turn. MUON never replays uncertain side effects on its own — the
 * operator reviews and continues by hand if it is safe.
 *
 * P0.1 Slice C5: delegates to the idempotent, jobId-bound
 * {@link fileJobTerminalGate}. The former `gateTag: "job-terminal:<id>"`
 * failed parseGateTag (400 at the approvals route) so the gate never landed;
 * the gateTag-LESS shape is the sanctioned INERT escalation (it can never
 * redeem at any route), and the jobId binding gives cross-surface,
 * cross-restart dedupe via the durable Slice-A column.
 *
 * Non-goal (by design, this slice): re-deriving the certain-outcome
 * `[Continue orchestration]` affordance across an app restart — the
 * acceptance-critical UNCERTAIN path is durable via this gate; the certain
 * affordance remains session-local.
 */
async function fileUncertainGate(
  chatId: string,
  job: DispatchJobRecord
): Promise<void> {
  const chat = await client.getChat(chatId).catch(() => null);
  if (!chat || chat.status === "archived") {
    throw new Error("Cannot file a continuation gate for an archived chat.");
  }
  await fileJobTerminalGate(client, chatId, job);
}

/** Bind the reconcile side-effects to the real client / turn-slot / renderer. */
function terminalReconcileDeps(milestoneFor: (jobId: string) => string): ReconcileDeps {
  return {
    milestoneFor,
    claimMilestone: async (chatId, claimKey, content) => {
      const chat = await client.getChat(chatId).catch(() => null);
      if (!chat || chat.status === "archived") {
        throw new Error("Cannot write a terminal milestone to an archived chat.");
      }
      const result = await client.claimStreamChunk({
        taskId: chatId,
        laneId: "muon-chat",
        claimKey,
        kind: "milestone",
        content,
      });
      return result.claimed;
    },
    // P0-2: gated ⇒ no synthesized orchestration turns; the gate stops the
    // autonomy engines, not just the IPC surface. In-flight vendor work still
    // finishes (the runner is untouched) — MUON just stops taking NEW turns.
    autoContinueEnabled: settings.autoContinue && !githubGateActive(),
    autoTurnsUsed: 0, // filled per-job below (chat-scoped)
    // Synchronous check-then-add: the claim is atomic against a human turn.
    tryClaimTurnSlot: (chatId) => {
      if (runningTurns.has(chatId)) {
        return false;
      }
      runningTurns.add(chatId);
      return true;
    },
    releaseTurnSlot: (chatId) => {
      runningTurns.delete(chatId);
    },
    onNudge: (chatId) =>
      autoTurnCounts.set(chatId, (autoTurnCounts.get(chatId) ?? 0) + 1),
    runNudgeTurn: (chatId, job) => runEventTurn(chatId, job),
    fileGate: (chatId, job) => fileUncertainGate(chatId, job),
    showAffordance: (chatId, jobId) =>
      sendToRenderer("muon:job-idle-terminal", { chatId, jobId }),
    onError: (chatId, message) =>
      sendToRenderer("muon:status", {
        chatId,
        // TODO 5.4: named stuck halt is not a failed wake — surface the reason.
        line: message.startsWith("Halted:")
          ? `✗ ${message}`
          : `✗ auto-continue failed: ${message}`,
      }),
  };
}

/**
 * Reconcile a worker's terminal transition into a bounded, consented
 * continuation. Returns `true` when handled (stop tracking) or `false` to defer
 * (a turn was running; retry next poll).
 */
async function handleTerminalJob(event: TerminalJobEvent): Promise<boolean> {
  const chatId = event.job.chatId;
  if (!chatId) {
    return true;
  }
  const chat = await client.getChat(chatId).catch(() => null);
  if (!chat || chat.status === "archived") {
    return true;
  }
  const { jobTerminalMilestone } = await loadOrchestrator();
  const deps = terminalReconcileDeps((jobId) => jobTerminalMilestone(jobId));
  deps.autoTurnsUsed = autoTurnCounts.get(chatId) ?? 0;
  // TODO 5.4: same durable activity window the runner uses for stuck patterns.
  const chunks = await client
    .listStreamChunks({
      taskId: chatId,
      latest: true,
      limit: 200,
    })
    .catch(() => [] as { content: string; kind: string }[]);
  deps.stuckReason =
    detectStuckPattern(stuckStepsFromChunks(chunks))?.message ?? null;
  // ADR-0030: while any live session in this chat is human-owned (native
  // take-over), automation yields — resolved here, decided in the shared
  // engine. Chat linkage goes session→job→chatId.
  //
  // FAIL CLOSED (review: "ownership lookup fails open"): an UNREADABLE
  // ownership state suspends automation exactly as a human-owned one does.
  // The false-suspend cost is one manual [Continue] click; the false-proceed
  // cost is automation synthesizing turns over a session the operator is
  // driving natively — the state this check exists to prevent. So: a failed
  // session list suspends; a human-owned session whose job cannot be
  // resolved (or that predates job binding) counts as THIS chat's.
  deps.humanOwnedSession = await client
    .listSessions()
    .then((sessions) => {
      // The ONE shared predicate (reconcile.ts sessionSuspendsAutomation) —
      // review finding 3 was this resolver and the backend steer guard
      // drifting apart.
      const humanOwned = sessions.filter((session) =>
        sessionSuspendsAutomation(session)
      );
      if (humanOwned.length === 0) return false;
      return Promise.all(
        humanOwned.map(async (session) => {
          // No job binding = cannot prove it is another chat's: suspend.
          if (!session.jobId) return true;
          try {
            const job = await client.getDispatchJob(session.jobId);
            return job.chatId === chatId;
          } catch {
            return true; // unreadable linkage: suspend, never talk over it
          }
        })
      ).then((flags) => flags.some(Boolean));
    })
    .catch(() => true);
  const outcome = await reconcileTerminalJob(event, deps);
  return outcome !== "deferred";
}

function makeJobMonitor() {
  return createJobTerminalMonitor(
    client,
    {
      onTerminalJob: (event) => handleTerminalJob(event),
    },
    {
      // Cross-surface dedupe (task #127): when the persistent runner is live it
      // is the durable reconcile driver, so the desktop monitor defers ENTIRELY
      // to it (no double-resume, no cap divergence). Only when NO runner is live
      // does the desktop reconcile — mirroring the CLI fallback. A probe failure
      // maps to "not live" so an uncertain job still reaches its human gate.
      isRunnerLive: () =>
        client
          .getRunner()
          .then((runner) => runner.live)
          .catch(() => false),
    }
  );
}

let jobMonitor: ReturnType<typeof makeJobMonitor>;

// The spawn door's actual backing (real node-pty vs echo diagnostic), set when
// terminal IPC registers. `realPty` in DesktopState reads THIS, not the env:
// the terminal is real by default now, and a status claim must track what a
// human session would actually get.
let terminalHostController: ReturnType<typeof registerTerminalIpc> | null = null;

// ROADMAP T1 — whatever the LAST quit cold-restore-snapshotted, read once at
// this process's startup (before any human tab could reopen and steal the
// id). Consumed from disk the moment it is read (see
// `consumeHumanTerminalSnapshot`), so this in-memory copy is the only place
// it lives for the rest of this run; `muon:getHumanTerminalRestore` just
// hands it back, once, to whichever renderer asks first.
const humanTerminalRestore = consumeHumanTerminalSnapshot(app.getPath("userData"));

function terminalRealPty(): boolean {
  const state = terminalHostController?.realPtyState();
  // "loading" reports true: node-pty resolves in milliseconds at startup and
  // the open path awaits it, so the session a human can reach is real. A load
  // FAILURE flips this to false the moment it is known.
  return state === "real" || state === "loading";
}

function restartJobMonitor(): void {
  jobMonitor.stop();
  jobMonitor = makeJobMonitor();
  jobMonitor.start(settings.pollIntervalMs);
}

/**
 * ONE authorization + resumability answer for a job's recorded vendor session,
 * shared verbatim by the two consumers that must never disagree: the terminal
 * host's spawn-time `resolveVendorSession` dep and the renderer's
 * `muon:jobResumeProbe` (the affordance decides whether to exist from the
 * exact check the click will be judged by). Chat binding, job status, the
 * stamped id, and the vendor's OWN session store are all part of the verdict
 * — see resolveTerminalVendorSession and vendor-session-store.ts.
 */
function lookupJobVendorSession(
  jobId: string
): ReturnType<typeof resolveTerminalVendorSession> {
  return resolveTerminalVendorSession(
    jobId,
    boundChatId,
    (id) => client.getDispatchJob(id),
    (input) => verifyVendorSessionInStore(input)
  );
}

function registerIpcHandlers(): void {
  // The live-terminal byte relay: native node-pty for the human's interactive
  // shell/vendor CLI, with the deterministic echo driver as a diagnostic
  // fallback. Autonomous dispatch execution remains in the detached runner.
  const terminalHost = (terminalHostController = registerTerminalIpc({
    // Host-derive a terminal's cwd from the id embedded in its session id
    // (real-pty path only) so it opens IN the chat's workspace or the job's
    // worktree — the renderer never names the cwd. Every unresolvable id
    // refuses; nothing falls back to the app's own launch directory. The
    // ambient bound workspace is deliberately NOT passed any more (see
    // resolveTerminalWorkspacePath: the `"shell"` branch that read it named a
    // session id no surface emits, and skipped the archived-chat refusal both
    // real branches make).
    resolveWorkspacePath: (jobId) =>
      resolveTerminalWorkspacePath(
        jobId,
        boundChatId,
        (id) => client.getDispatchJob(id),
        (chatId) => client.getChat(chatId)
      ),
    // BACKLINK RESUME: the vendor session id the runner stamped on the job,
    // looked up host-side under the same chat binding as the cwd above. The
    // renderer only ever names the `<vendor>:resume` kind. The store check is
    // the dead-button guard: the SAME lookup answers the renderer's probe, so
    // a spawn can never be authorized for a session the probe refused.
    resolveVendorSession: (jobId) => lookupJobVendorSession(jobId),
  }));
  ipcMain.handle(
    "muon:closeTerminal",
    async (_event, input: { sessionId: string }) => {
      // Teardown by session identity — do not require the chat to still be
      // SELECTED. Archive/switch races flip boundChatId before this IPC lands.
      // Ownership is required though: the chat (or the job's chat) must be one
      // this window has bound, which is exactly the set whose terminals this
      // host can be holding.
      await authorizeRendererTerminalClose(
        client,
        input.sessionId,
        rendererChatOwnership
      );
      terminalHost.closeSession(input.sessionId);
    }
  );
  // ROADMAP T4 — the parked-runtime LRU's "from host if available" replay
  // path. Same ownership bar as closing the session: a renderer must not be
  // able to read scrollback for a chat's terminal it never bound. Absent
  // entirely from any authorization failure — that just means "nothing to
  // replay", never a thrown surface error in the terminal pane.
  ipcMain.handle(
    "muon:terminalScrollback",
    async (_event, input: { sessionId: string }) => {
      try {
        await authorizeRendererTerminalClose(
          client,
          input.sessionId,
          rendererChatOwnership
        );
      } catch {
        return null;
      }
      return terminalHost.scrollbackSnapshot(input.sessionId);
    }
  );
  // ROADMAP T4 — open one ALREADY-ALLOWLISTED OSC-8 hyperlink target
  // (⌘-click in a terminal pane). The renderer's own classification
  // (renderer/lib/terminal-link-security.ts) is a UX nicety at best — it is
  // untrusted, so EVERY field is re-checked here before anything touches the
  // filesystem or the OS's own URL opener. `boundWorkspace` (main's own view
  // of the selected chat's workspace, never a root the renderer supplied) is
  // the ONLY root a path target may resolve inside.
  ipcMain.handle(
    "muon:openTerminalLink",
    async (_event, input: { target: TerminalLinkTarget }) => {
      const target = input?.target;
      if (target?.kind === "url") {
        if (!isAllowedTerminalLinkUrl(target.url)) {
          throw new Error("Refusing to open an untrusted terminal link.");
        }
        await shell.openExternal(target.url);
        return;
      }
      if (target?.kind === "path") {
        if (
          !boundWorkspace ||
          !isWithinWorkspaceRoot(target.absolutePath, boundWorkspace)
        ) {
          throw new Error(
            "Refusing to open a terminal link path outside the bound workspace."
          );
        }
        // Reveal, never execute: a path a running process printed is
        // untrusted content, and showing it in Finder cannot run it.
        shell.showItemInFolder(target.absolutePath);
        return;
      }
      throw new Error("Refusing to open an unrecognized terminal link target.");
    }
  );
  ipcMain.handle("muon:getState", () => collectState());
  // ROADMAP T1 — hand back whatever this process consumed from the LAST
  // quit's cold-restore snapshot. Read-and-cleared from disk once already
  // (module load, above); this is just serving the in-memory copy, so a
  // renderer reload before every tab is acknowledged does not lose the
  // still-frozen ones.
  ipcMain.handle("muon:getHumanTerminalRestore", () => humanTerminalRestore);
  // ADR-0039 (feature #13): the user's local vendor DETECTION manifest, read
  // from the data dir. Display data only — it feeds the terminal-tab
  // permission dot and nothing else, and the schema is closed so it cannot
  // carry authority. Absent or unreadable resolves to null, which the renderer
  // treats as "keep the compiled patterns".
  ipcMain.handle("muon:getDetectionManifest", async (): Promise<unknown> => {
    try {
      const raw = await fsPromises.readFile(
        path.join(app.getPath("userData"), "detection-manifest.json"),
        "utf8"
      );
      return JSON.parse(raw) as unknown;
    } catch {
      // Missing file is the normal case, and a malformed one is the renderer's
      // to REFUSE and report — not this handler's to guess at.
      return null;
    }
  });
  // On-demand local knowledge-graph read for the "Open Graph" page. Fail-safe:
  // ROADMAP 4.1b — reconnaissance: repo shape + crew recommendation for the
  // bound workspace (repo_map made visible). Always resolves.
  ipcMain.handle("muon:reconMap", (): Promise<ReconMapResponse> =>
    loadReconMap(boundWorkspace ?? "")
  );
  ipcMain.handle(
    "muon:dataBoundaries",
    (_event, query: DataBoundaryQuery): Promise<DataBoundaryResponse> =>
      loadDataBoundaries(boundWorkspace ?? "", query.file)
  );
  // loadGitNexusGraph always resolves (empty + error on any failure). An
  // explicit repoPath (multi-repo graph tabs) picks ONE detected repo's own
  // `.gitnexus/` store; omitted ⇒ the bound workspace root, unchanged.
  // Disk/memory cache keyed by meta fingerprint so Open Graph is instant
  // across sessions until the index changes (commit/reindex) or the user clears.
  ipcMain.handle(
    "muon:gitnexusGraph",
    async (_event, input?: { repoPath?: string; force?: boolean }) => {
      const target = resolveBestGraphTarget(input?.repoPath, boundWorkspace, {
        hasIndex: (dir) =>
          existsSync(path.join(dir, ".gitnexus", "meta.json")),
        detectRepos: (root) => resolveIndexTargets(root),
      });
      const meta = target ? await readGraphMeta(target) : null;
      const fingerprint = fingerprintFromMeta(meta);
      const cache = ensureGraphCache();
      if (!input?.force && target) {
        const cached = await cache.get(target, fingerprint);
        if (cached) {
          return cached;
        }
      }
      const graph = await loadGitNexusGraph(target);
      if (target) {
        await cache.set(target, fingerprint, graph);
      }
      return graph;
    }
  );

  ipcMain.handle(
    "muon:clearGitnexusGraphCache",
    async (_event, input?: { repoPath?: string }) => {
      const target = input?.repoPath?.trim()
        ? input.repoPath.trim()
        : boundWorkspace ?? undefined;
      await ensureGraphCache().clear(target);
    }
  );

  // Operator-triggered re-index. The supervisor owns the decision (single-in-
  // flight, target allow-list, force rule) and returns a VALUE — a refusal is
  // never an exception and never renders as progress. `repoPath` is validated
  // against the supervisor's own resolved targets, so the untrusted renderer
  // cannot aim `analyze` at an arbitrary directory.
  ipcMain.handle(
    "muon:gitnexusReindex",
    async (_event, input?: { repoPath?: string }) => {
      const supervisor = gitnexusIndex;
      if (!supervisor) {
        return {
          accepted: false as const,
          reason: "no-repo" as const,
          note: "No workspace is bound to the code graph right now.",
        };
      }
      const result = supervisor.reindexNow(input?.repoPath);
      if (result.accepted) {
        // The Open Graph cache is keyed by the index fingerprint, but a forced
        // rebuild can land the SAME commit with a different store — drop the
        // cached payload so the graph page cannot serve the pre-repair graph.
        for (const target of result.targets) {
          await ensureGraphCache()
            .clear(target)
            .catch(() => undefined);
        }
      }
      return result;
    }
  );

  ipcMain.handle(
    "muon:createChat",
    async (_event, input: { workspacePath: string }) => {
      const chat = await client.createChat({ workspacePath: input.workspacePath });
      boundChatSelectionVersion += 1;
      bindChat(chat.id);
      bindWorkspace(chat.workspacePath);
      return chat;
    }
  );

  ipcMain.handle(
    "muon:selectChat",
    async (_event, input: { chatId: string | null }) => {
      const selectionVersion = ++boundChatSelectionVersion;
      if (!input.chatId) {
        bindChat(null);
        bindWorkspace(null);
        return;
      }
      const chat = await client.getChat(input.chatId).catch((error) => {
        if (selectionVersion === boundChatSelectionVersion) {
          bindChat(null);
          bindWorkspace(null);
        }
        throw error;
      });
      if (selectionVersion !== boundChatSelectionVersion) {
        return;
      }
      if (chat.status === "archived") {
        bindChat(null);
        bindWorkspace(null);
        throw new Error("Cannot select an archived chat.");
      }
      bindChat(chat.id);
      bindWorkspace(chat.workspacePath);
    }
  );

  ipcMain.handle("muon:listChats", () => client.listChats());

  ipcMain.handle("muon:getChat", (_event, input: { chatId: string }) =>
    client.getChat(input.chatId)
  );

  // S7: soft-archive a chat over the OPERATOR client (the local human surface).
  // The backend gate 403s the agent tier; here `client` is already operator, so
  // the human's own delete goes straight through. A rejection propagates to the
  // renderer, which surfaces it in the sidebar (never a silent failure).
  // Cancel = "stop everything this chat is running", nothing else. The chat
  // stays active, selected, and usable; only its work is interrupted, over the
  // same per-job governed path the mission header's Stop all uses. Idempotent.
  // getChat first so a stale/unknown chat id reads as a real error instead of
  // a cheerful "nothing to stop".
  ipcMain.handle(
    "muon:cancelChat",
    async (_event, input: { chatId: string }) => {
      const chat = await client.getChat(input.chatId);
      return cancelChat(client, chat.id, {
        // Long enough to cover interrupt detection (~250ms) plus a vendor's own
        // settle (Claude Code waits up to 3s), so the common case reports a
        // verified stop rather than an indefinite "stopping".
        settleMs: 4_000,
        pollMs: 200,
      });
    }
  );

  ipcMain.handle(
    "muon:archiveChat",
    async (_event, input: { chatId: string }) => {
      // AUTHORIZE BEFORE THE CASCADE. This handler is not selection-scoped
      // (every sidebar row archives its own chat — see
      // requireArchivableRendererChat for why that cannot simply be tightened,
      // and for the residual it names); what it CAN require is a shape MUON
      // issues and a real record, resolved before "stop every job in this
      // chat" runs. An already-archived chat answers with its own record
      // rather than replaying the stop path against it.
      const archivable = await requireArchivableRendererChat(
        client,
        input.chatId
      );
      const chatId = archivable.chatId;
      if (archivable.alreadyArchived) {
        // Idempotent, and still swept: a pty for an archived chat must not
        // survive because the archive raced a second click.
        terminalHost.closeChatSessions(chatId);
        return archivable.chat;
      }
      // Stop first, THEN archive — and only once the backend precondition is
      // genuinely satisfied. There is no "soft archive anyway" path: the
      // backend never permitted one, so the old deadline fallback could only
      // ever surface a bare 409. If a job will not stop this throws a
      // ChatStopBlockedError naming it, and the chat stays put.
      const result = await archiveChatAfterStopping(client, chatId, {
        settleMs: 6_000,
        pollMs: 200,
      });
      // ALL of this chat's human workspace sessions — the legacy single shell
      // and every vendor tab ("Claude 2", …); main cannot enumerate the
      // renderer's ordinals, so the host does.
      terminalHost.closeChatSessions(chatId);
      for (const jobId of result.jobIds) {
        terminalHost.closeSession(`terminal-${jobId}`);
      }
      autoTurnCounts.delete(chatId);
      chatModels.delete(chatId);
      if (boundChatId === chatId) {
        boundChatSelectionVersion += 1;
        bindChat(null);
        bindWorkspace(null);
      }
      return result.chat;
    }
  );

  // D4: rename a chat, same operator client as archiveChat above — the
  // human's own rename goes straight through.
  ipcMain.handle(
    "muon:updateChat",
    async (_event, input: { chatId: string; title?: string }) => {
      requireSelectedRendererChat(boundChatId, input.chatId);
      return client.updateChat(input);
    }
  );

  // S9 mission budget: read is tier-agnostic; the raise is an OPERATOR act —
  // `client` is the operator client, so the human's own raise goes straight
  // through while the backend keeps it raise-only + ceiling-bounded.
  ipcMain.handle(
    "muon:getDispatchBudget",
    async (_event, input: { jobId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      await requireRendererDispatchJob(client, chatId, input.jobId);
      const budget = await client.getDispatchBudget(input.jobId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while budget was loading.");
      }
      return budget;
    }
  );
  ipcMain.handle(
    "muon:raiseDispatchBudget",
    async (_event, input: { jobId: string; maxDescendantWallMs: number }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      await requireRendererDispatchJob(client, chatId, input.jobId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before the budget raise.");
      }
      return client.raiseDispatchBudget(input.jobId, {
        maxDescendantWallMs: input.maxDescendantWallMs,
      });
    }
  );
  ipcMain.handle(
    "muon:interruptDispatch",
    async (_event, input: { jobId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      const job = await requireRendererDispatchJob(client, chatId, input.jobId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before interruption.");
      }
      if (job.status !== "queued" && job.status !== "running") {
        throw new Error(`Dispatch '${job.id}' is already ${job.status}.`);
      }
      await client.interruptDispatchJob(job.id);
    }
  );

  /**
   * REVOKE a lane's live credential (surface-parity, 2026-08-11).
   *
   * A DIFFERENT ACT FROM INTERRUPT, and the two must not be blurred:
   * `interruptDispatch` asks the process to stop; this kills the identity it
   * authenticates with. A revoked job may still be running — it simply can no
   * longer act as itself against the brain.
   *
   * Same fence as interrupt (`requireRendererDispatchJob` + the selection
   * version), so the renderer can only revoke a job on the chat it is bound
   * to. Unlike interrupt it is NOT restricted to queued/running: revoking the
   * credential of a job whose status has gone stale is exactly what an
   * operator wants when they are not sure what is still alive.
   */
  ipcMain.handle(
    "muon:revokeDispatchGrants",
    async (
      _event,
      input: { jobId: string }
    ): Promise<{ jobId: string; revoked: number; note: string }> => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      const job = await requireRendererDispatchJob(client, chatId, input.jobId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before the revocation.");
      }
      return client.revokeDispatchGrants(job.id);
    }
  );

  // TODO 7.13 — composer "Send now" steers the selected chat's root job.
  ipcMain.handle(
    "muon:steerDispatch",
    async (_event, input: { jobId: string; message: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      const message =
        typeof input.message === "string" ? input.message.trim() : "";
      if (!message) {
        throw new Error("Steer message is empty.");
      }
      if (message.length > 16_000) {
        throw new Error("Steer message exceeds the 16k character bound.");
      }
      const job = await requireRendererDispatchJob(client, chatId, input.jobId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before steering.");
      }
      if (job.status !== "running") {
        throw new Error(
          `Dispatch '${job.id}' is ${job.status}; steer requires a running job.`
        );
      }
      await client.steerDispatchJob(job.id, message);
    }
  );

  // TODO 5.17 — Pause from the commitments screen. Operator-local surface: any
  // live record in this brain is pausable without deleting it. Dispatch still
  // goes through interrupt; workflow → paused; loop → aborted.
  ipcMain.handle(
    "muon:pauseAutonomyCommitment",
    async (
      _event,
      input: { kind: "loop" | "workflow" | "dispatch" | "schedule"; id: string }
    ) => {
      const id = requireRendererRecordId(input.id, "commitment");
      if (input.kind === "schedule") {
        await client.updateSchedule({ scheduleId: id, status: "paused" });
        return;
      }
      if (input.kind === "dispatch") {
        const job = await client.getDispatchJob(id);
        if (job.status !== "queued" && job.status !== "running") {
          throw new Error(`Dispatch '${job.id}' is already ${job.status}.`);
        }
        await client.interruptDispatchJob(job.id);
        return;
      }
      if (input.kind === "workflow") {
        const detail = await client.getWorkflowRun(id);
        if (
          detail.run.status !== "running" &&
          detail.run.status !== "applied"
        ) {
          throw new Error(
            `Workflow '${detail.run.id}' is ${detail.run.status}, not pausable.`
          );
        }
        await client.updateWorkflowRun({
          runId: detail.run.id,
          status: "paused",
        });
        return;
      }
      if (input.kind === "loop") {
        const loops = await client.listLoopRuns().catch(() => []);
        const loop = loops.find((entry) => entry.id === id);
        if (loop) {
          const jobs = await client
            .listDispatchJobs({ taskId: loop.taskId })
            .catch(() => []);
          const loopJob = findLoopDispatchJob(
            jobs,
            loop.taskId,
            loop.dispatchJobId
          );
          if (
            loopJob &&
            (loopJob.status === "queued" || loopJob.status === "running")
          ) {
            await client.interruptDispatchJob(loopJob.id);
          }
        }
        // PATCH is fail-closed for unknown / non-running loops on the brain.
        await client.updateLoopRun({
          loopId: id,
          status: "aborted",
          stopReason: "paused_by_operator",
        });
        return;
      }
      throw new Error("Unknown commitment kind.");
    }
  );

  ipcMain.handle(
    "muon:resumeObjectiveLoop",
    async (_event, input: { jobId: string }) => {
      const jobId = requireRendererRecordId(input.jobId, "dispatch job");
      const job = await client.getDispatchJob(jobId);
      const chatId = boundChatId;
      if (!chatId || job.chatId !== chatId) {
        throw new Error(
          "Resume is only available for a loop dispatch in the selected chat."
        );
      }
      if (job.kind !== "loop") {
        throw new Error("Only loop dispatches can be resumed from here.");
      }
      const sessions = await client.listSessions({ taskId: job.taskId }).catch(
        () => []
      );
      const fresh = await client.enqueueDispatch({
        ...buildRedispatchInput(job, sessions),
        dispatchedBy: "operator",
      });
      return { jobId: fresh.id };
    }
  );

  ipcMain.handle(
    "muon:sendMessage",
    async (
      event,
      input: { chatId: string; message: string; model?: string }
    ): Promise<SendMessageResult> => {
      try {
        requireSelectedRendererChat(boundChatId, input.chatId);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "chat out of scope",
        };
      }
      if (runningTurns.has(input.chatId)) {
        return { ok: false, error: "a turn is already running for this chat" };
      }
      runningTurns.add(input.chatId);
      // A human message re-opens the auto-continue budget for this chat (S4):
      // the cap counts machine turns BETWEEN human messages.
      autoTurnCounts.set(input.chatId, 0);
      // S10: mirror the renderer's per-chat model so later machine turns reuse
      // it. The renderer is the source of truth, so an absent field clears it.
      if (input.model) {
        chatModels.set(input.chatId, input.model);
      } else {
        chatModels.delete(input.chatId);
      }
      try {
        const crew = settings.crew;
        await requireOrchestratorReady(crew.orchestratorVendor);
        // Fetch fresh: the vendorSessionId must be current to resume.
        const chat = await client.getChat(input.chatId);
        const gnStatus = gitnexusIndex?.getStatus();
        const indexBlock = gitnexusIndexSubmitBlocker(
          gnStatus?.workspacePath === chat.workspacePath ? gnStatus : null
        );
        if (indexBlock) {
          return { ok: false, error: indexBlock.message };
        }
        const scopedJobs = await client
          .listDispatchJobs({ chatId: input.chatId, latest: true, limit: 32 })
          .catch(() => []);
        const activeRoot = scopedJobs.find(
          (job) =>
            job.parentJobId === null &&
            (job.status === "queued" || job.status === "running")
        );
        if (activeRoot) {
          const budget = await client
            .getDispatchBudget(activeRoot.id)
            .catch(() => null);
          const budgetBlock = budgetExhaustedSubmitBlocker(
            budget ? buildBudgetLineView(budget) : null
          );
          if (budgetBlock) {
            return { ok: false, error: budgetBlock.message };
          }
        }
        const { runChatTurn } = await loadOrchestrator();
        const sender = event.sender;
        const result = await runChatTurn({
          client,
          chat,
          message: input.message,
          apiBase: settings.apiBase,
          // AGENT-tier token (P3-A): the orchestrator's MCP runs without govern
          // authority, it files gates the human approves via the operator client.
          apiToken: settings.agentToken ?? process.env.MUON_AGENT_TOKEN,
          // Operator-chosen orchestrator seat (claude-code | codex).
          vendor: crew.orchestratorVendor,
          // S10: chat-level model, else crew orchestrator default.
          model:
            input.model ||
            crew.orchestratorModel ||
            undefined,
          effort: crew.orchestratorEffort || undefined,
          // Full-Auto: append the safety block to this turn's brief when the
          // operator's standing consent is active. OFF → today's brief exactly.
          fullAuto: settings.fullAuto,
          onAssistantText: (text, mode) => {
            if (!sender.isDestroyed()) {
              sender.send("muon:assistant", {
                chatId: input.chatId,
                text,
                mode,
              });
            }
          },
          onStatus: (line: string, detail?: LiveStatusDetail) => {
            if (!sender.isDestroyed()) {
              sender.send("muon:status", {
                chatId: input.chatId,
                line,
                ...relayStatusDetail(detail),
              });
            }
          },
        });
        return result.exitCode === 0
          ? { ok: true }
          : {
              ok: false,
              error:
                result.errorText?.trim() ||
                "the orchestrator turn ended with an error",
            };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "turn failed",
        };
      } finally {
        runningTurns.delete(input.chatId);
      }
    }
  );

  // S4: the [Continue orchestration] affordance. A human-consented single
  // reconciliation turn for a worker that finished while the chat was idle —
  // same enveloped nudge as auto-continue, and it resets the auto-turn cap
  // (the human re-engaged). Fails closed if a turn is already running.
  ipcMain.handle(
    "muon:continueOrchestration",
    async (
      _event,
      input: { chatId: string; jobId: string }
    ): Promise<SendMessageResult> => {
      let job: DispatchJobRecord;
      try {
        requireSelectedRendererChat(boundChatId, input.chatId);
        job = await requireRendererDispatchJob(
          client,
          input.chatId,
          input.jobId
        );
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : "continuation out of scope",
        };
      }
      if (runningTurns.has(input.chatId)) {
        return { ok: false, error: "a turn is already running for this chat" };
      }
      runningTurns.add(input.chatId);
      autoTurnCounts.set(input.chatId, 0);
      try {
        await runEventTurn(input.chatId, job);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "continue failed",
        };
      } finally {
        runningTurns.delete(input.chatId);
      }
    }
  );

  ipcMain.handle("muon:setFleet", (_event, input: { counts: FleetCounts }) =>
    client.setFleet(input.counts)
  );

  // Re-probe readiness NOW (bypass BOTH the display cache and the brain's own
  // short one): the wizard's / Crew's "re-check" after the user ran the
  // vendor's own login. Never handles a token, reads booleans.
  //
  // This goes through the same cache the polls read, so the fresh verdict is
  // live on every surface the instant this resolves — it used to refresh only
  // the BACKEND cache and rely on the next poll to notice.
  ipcMain.handle("muon:refreshReadiness", async () => {
    const snapshot = await readinessCache.refresh();
    return snapshot.report?.vendors ?? null;
  });

  // S1 of docs/design/cc-as-superagent-delivery.md §5 — the desktop half of
  // `muon mcp status | install`. Both bodies are in ./lib/mcp-bridge.ts, which
  // delegates to the SHARED evaluator/writer in `@muon/client`; nothing about a
  // check, a reason, a scope or a vendor fact is re-derived there or in the
  // renderer. These two handlers stay one line each ON PURPOSE — anything with
  // a decision in it here is unreachable from a test.
  ipcMain.handle("muon:mcpStatus", async (): Promise<McpStatusReport> => {
    return readMcpStatus();
  });

  // OPERATOR-INITIATED, never polled: this spawns a real MCP server process,
  // handshakes it and kills it. `mcpStatus` above is the cheap, pollable read;
  // its tool COUNT is a compile-time constant, which is how the desk could
  // report 44 tools while a vendor's server actually served 27.
  ipcMain.handle(
    "muon:mcpProbe",
    async (
      _event,
      input?: { mode?: string }
    ): Promise<McpProbeReport> => probeMcpServer({ mode: input?.mode })
  );

  ipcMain.handle(
    "muon:mcpInstall",
    async (_event, input: { vendor: VendorId }): Promise<McpInstallReport> =>
      installMcpForVendor(input.vendor)
  );

  // ADR-0028 Tier C — the desktop half of `muon mcp attach | detach`. Both
  // bodies are in ./lib/mcp-bridge.ts, which delegates to the SAME
  // `attachCoordinatorFlow`/`detachCoordinatorFlow` the CLI calls: no
  // independent authority lives in main, only the operator-tier `client`
  // already used by every other handler in this file. The renderer supplies
  // no path authority: workspace comes from main's bound state (the desktop's
  // equivalent of the CLI's cwd), falling back to the OS home so a fresh
  // install with no chat open yet can still mint one. An existing chat must be
  // the chat main currently selected.
  ipcMain.handle(
    "muon:mcpAttach",
    async (
      _event,
      input: { vendor: VendorId; chatId?: unknown }
    ): Promise<McpAttachResult> =>
      attachMcpCoordinator(
        input.vendor,
        resolveRendererMcpAttachScope(
          boundChatId,
          boundWorkspace,
          app.getPath("home"),
          input
        ),
        {
          client,
          apiBase: settings.apiBase,
          dataDir: app.getPath("userData"),
        }
      )
  );

  ipcMain.handle(
    "muon:mcpDetach",
    async (_event, input: { vendor: VendorId }): Promise<McpDetachResult> =>
      detachMcpCoordinator(input.vendor, {
        client,
        dataDir: app.getPath("userData"),
      })
  );

  // ROADMAP P7 — host-side read of the ungoverned custom-agent store. The
  // renderer never opens the JSON file; spawn resolution uses the same
  // userData root via setCustomAgentLookup below.
  ipcMain.handle(
    "muon:listCustomAgents",
    (): UngovernedAgentEntry[] => listCustomAgents(app.getPath("userData"))
  );

  ipcMain.handle(
    "muon:reviewApproval",
    async (
      _event,
      input: { approvalId: string }
    ): Promise<ReviewCoverageCertification> => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before reviewing an approval.");
      }
      const approval = (await client.listApprovals()).find(
        (candidate) => candidate.id === input.approvalId
      );
      if (!approval) {
        throw new Error("The requested approval does not exist.");
      }
      if (approval.kind !== "merge") {
        throw new Error("Only merge approvals have graph review evidence.");
      }
      await requireRendererTask(client, chatId, approval.taskId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before review loaded.");
      }
      return client.getApprovalReviewCertification(input.approvalId);
    }
  );

  ipcMain.handle(
    "muon:taskHandoffs",
    async (
      _event,
      input: { taskId: string }
    ): Promise<TaskHandoffPage> => {
      // Demand-driven, not polled: a handoff is read when a human opens the
      // session's wrap, and the state poll has no business paying for it.
      // Fenced by the SAME `requireRendererTask` the auto-context read uses —
      // the renderer may only ask about a task on its bound chat.
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      await requireRendererTask(client, chatId, input.taskId);
      // BOUNDED, newest-first, classified — and a failed read kept distinct
      // from an absence, with the binding re-checked after the await. All four
      // decisions live in `lib/handoff-page` so they are tested rather than
      // remembered inside an IPC handler.
      return readTaskHandoffPage({
        read: () => client.getTaskDetail(input.taskId),
        stillBound: () =>
          selectionVersion === boundChatSelectionVersion &&
          chatId === boundChatId,
      });
    }
  );

  /**
   * The per-run bound, REFUSED rather than clamped.
   *
   * Clamping would run a different amount of work than the operator asked
   * for — and the number they asked for is exactly the number the preview
   * they just approved was computed with.
   */
  const boundedForget = (value: number): number => {
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new Error("The per-run bound must be a whole number from 1 to 500.");
    }
    return value;
  };

  // MEMORY GOVERNANCE (surface-parity item 6). Operator tier, machine-wide:
  // a retention posture is not chat-scoped, so unlike the cap handlers below
  // there is no bound-chat fence here — the operator-tier `client` is the
  // authority, exactly as it is for `muon memory ttl`.
  ipcMain.handle(
    "muon:memoryGovernance",
    async (): Promise<MemoryGovernanceState> => {
      // ONE read, so the panel cannot show a TTL from after a change beside a
      // retention window from before it.
      // LIFECYCLE FIRST, because it decides whether the flat TTL is even a
      // question. Under a kind-dependent table both memory-ttl endpoints 409
      // by design ("use /settings/memory-lifecycle"), so asking for it
      // unconditionally inside a Promise.all rejected the whole read and the
      // panel reported the policy as UNREADABLE on precisely the machines
      // running the newer posture.
      const [lifecycle, compactionRetentionDays, memoryMining] =
        await Promise.all([
          client.getMemoryLifecyclePolicy(),
          client.getMemoryCompactionRetentionDays(),
          client.getMemoryMining(),
        ]);
      const kindTable = lifecycle.source === "kind_table";
      return {
        ttl: kindTable ? null : await client.getMemoryTtlPolicy(),
        lifecycleSource: lifecycle.source,
        daysByKind: kindTable
          ? (lifecycle.policy.daysByKind as Record<string, number>)
          : null,
        compactionRetentionDays,
        memoryMining,
      };
    }
  );

  ipcMain.handle(
    "muon:setMemoryTtl",
    async (_event, policy: MemoryTtlPolicy): Promise<MemoryTtlPolicy> => {
      // Re-checked here because main must not forward a policy it has not
      // looked at. 0 is MEANINGFUL (expiry off) — unlike a cost cap, where it
      // is refused — so the floor is 0, not 1.
      if (
        !Number.isInteger(policy.days) ||
        policy.days < 0 ||
        policy.days > 3_650
      ) {
        throw new Error("Retention must be a whole number of days from 0 to 3650.");
      }
      // The route refuses this under a kind table too; refusing here means the
      // operator reads WHY rather than a bare 409.
      const lifecycle = await client.getMemoryLifecyclePolicy();
      if (lifecycle.source === "kind_table") {
        throw new Error(
          "Kind-dependent lifetimes are in force, so there is no single TTL to set. Change the table with `muon memory lifecycle-policy`."
        );
      }
      return client.setMemoryTtlPolicy(policy);
    }
  );

  ipcMain.handle(
    "muon:setMemoryMining",
    async (_event, enabled: boolean): Promise<boolean> => {
      // REFUSED, not coerced. `enabled === true` would have turned anything
      // unexpected into "mining off" — a silent posture change nobody asked
      // for, in the direction that quietly stops memory growing at all.
      if (typeof enabled !== "boolean") {
        throw new Error("Memory mining is on or off; nothing else.");
      }
      return client.setMemoryMining(enabled);
    }
  );

  ipcMain.handle(
    "muon:setMemoryCompactionRetentionDays",
    async (_event, days: number): Promise<number> => {
      if (!Number.isInteger(days) || days < 1 || days > 3_650) {
        throw new Error(
          "The compaction window must be a whole number of days from 1 to 3650."
        );
      }
      return client.setMemoryCompactionRetentionDays(days);
    }
  );

  ipcMain.handle(
    "muon:sweepExpiredMemory",
    async (
      _event,
      input: { dryRun: boolean; maxForget: number; previewDigest?: string }
    ): Promise<MemoryExpirySweepResult> =>
      client.sweepExpiredMemory({
        dryRun: input.dryRun,
        maxForget: boundedForget(input.maxForget),
        reason: "swept from the MUON desk",
        // Binds the apply to the preview the operator actually read.
        ...(input.previewDigest ? { previewDigest: input.previewDigest } : {}),
      })
  );

  ipcMain.handle(
    "muon:compactMemory",
    async (
      _event,
      input: { dryRun: boolean; maxForget: number; previewDigest?: string }
    ): Promise<MemoryCompactionResult> =>
      client.compactMemory({
        dryRun: input.dryRun,
        maxForget: boundedForget(input.maxForget),
        reason: "compacted from the MUON desk",
        ...(input.previewDigest ? { previewDigest: input.previewDigest } : {}),
      })
  );

  ipcMain.handle(
    "muon:revertExpiredMemoryBatch",
    async (_event, batchId: string): Promise<RevertExpiredBatchResult> =>
      client.revertExpiredMemoryBatch(batchId)
  );

  ipcMain.handle(
    "muon:missionCost",
    async (): Promise<MissionCapState> => {
      // The mission is the BOUND chat, never a renderer-supplied id: a cap is
      // an operator control over the mission the human is looking at.
      const chatId = boundChatId;
      if (!chatId) throw new Error("Select a mission to see its cost cap.");
      const view = await client.getMissionCost(chatId);
      return {
        // The mission this answer is about — main's bound chat can lag the
        // renderer's selection by one async hop, so the reading names itself
        // rather than letting the caller assume it is current.
        chatId,
        capUsd: view.capUsd,
        capSetBy: view.capSetBy,
        // D1: the ONE rendering travels with the figure.
        summary: view.summary,
        refusesDispatch: view.refusesDispatch,
      };
    }
  );

  ipcMain.handle(
    "muon:setMissionCostCap",
    async (
      _event,
      input: { capUsd: number | null }
    ): Promise<MissionCapState> => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) throw new Error("Select a mission before capping it.");
      // What counts as a cap is decided in one place (`@muon/client/cost-cap`)
      // and the renderer already applied it. Re-checked here because main must
      // not forward a number it has not looked at: a zero would read, on every
      // surface, like a configured limit while refusing every dispatch.
      if (
        input.capUsd !== null &&
        (!Number.isFinite(input.capUsd) || input.capUsd <= 0)
      ) {
        throw new Error(
          "A cap must be a positive dollar amount, or null to clear it."
        );
      }
      const update = await client.setMissionCostCap(chatId, input.capUsd);
      // A mission switch between the click and the write would land this cap
      // on a mission the human was no longer looking at. The write already
      // went to `chatId`, so this reports rather than silently succeeding
      // under the new selection's name.
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error(
          "The cap was set on the mission you had selected; the selection changed while it saved."
        );
      }
      return {
        chatId,
        capUsd: update.capUsd,
        capSetBy: update.capSetBy,
        summary: update.summary,
        refusesDispatch: update.refusesDispatch,
      };
    }
  );

  ipcMain.handle(
    "muon:answerQuestion",
    async (
      _event,
      input: { questionId: string; taskId: string; answer: string }
    ): Promise<{ answered: boolean }> => {
      // Operator-authored, ADR-0043: answering confers no authority — one
      // event, no receipt, no grant. The route 409s a re-answer; surface that
      // as a plain error the panel can show.
      // Through the long-lived client, so the answer follows a brain that
      // moved between the poll and the human's decision (cubic P2).
      //
      // DELIBERATELY NOT FENCED TO THE SELECTED CHAT, unlike the approval and
      // handoff handlers beside it (raised twice by gitnexus-check on PR #42,
      // once here and once at the QuestionsInbox call site). Those fences stop
      // a STALE SELECTION from acting on the wrong mission; a question id names
      // its target exactly, so there is nothing stale to guard. The inbox shows
      // every mission's blocked agents on purpose — chipped "other mission",
      // active ones sorted first — because an agent blocked on a question
      // outranks which session the human happens to be looking at, and it is
      // one operator who owns all of them. Fencing this would leave an Answer
      // button that refuses: advertised and inert.
      return client.answerQuestion(input);
    }
  );

  ipcMain.handle(
    "muon:resolveApproval",
    async (
      _event,
      input: {
        approvalId: string;
        status: "approved" | "rejected";
        receiptTtlMs?: number;
        manualReview?: ManualReviewAttestation;
      }
    ): Promise<ResolveApprovalResult> => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before deciding an approval.");
      }
      const approval = (await client.listApprovals()).find(
        (candidate) => candidate.id === input.approvalId
      );
      if (!approval) {
        throw new Error("The requested approval does not exist.");
      }
      await requireRendererTask(client, chatId, approval.taskId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before the decision.");
      }
      if (input.manualReview && input.status !== "approved") {
        throw new Error(
          "Manual merge review can accompany only an approval."
        );
      }
      if (input.manualReview && input.receiptTtlMs !== undefined) {
        throw new Error(
          "Merge review and remembered-action receipts cannot be combined."
        );
      }
      if (input.manualReview && approval.kind !== "merge") {
        throw new Error(
          "Manual review attestation is valid only for merge approvals."
        );
      }
      // P0.4 + BUG 1: an explicit receipt opt-in rides the SAME operator
      // decision (mint at operator tier). The approve/reject decision ALWAYS
      // lands: if the action can't be remembered the server soft-skips the mint
      // (200, no red 400), so here we surface a gentle, non-error note rather
      // than failing the decision. No opt-in = today's path exactly.
      if (input.receiptTtlMs !== undefined && input.status === "approved") {
        const resolved = await client.resolveApproval({
          approvalId: input.approvalId,
          status: input.status,
          decisionNotes: "decided from MUON desktop",
          receipt: { ttlMs: input.receiptTtlMs },
        });
        recordMergeOutcome(resolved.id, resolved.merge);
        void monitor.poll();
        if (resolved.receiptSkipped) {
          // Soft surface: the decision succeeded; the action just can't be
          // remembered. Informational, never an error dialog.
          new Notification({
            title: "Approved — this action type can't be remembered",
            body:
              resolved.receiptSkippedReason ??
              "Only reads, edits inside the task radius, and configured checks can be remembered.",
          }).show();
          return {
            receiptSkipped: true,
            receiptSkippedReason: resolved.receiptSkippedReason,
          };
        }
        return {};
      }
      if (input.manualReview !== undefined && input.status === "approved") {
        const resolved = await client.resolveApproval({
          approvalId: input.approvalId,
          status: input.status,
          decisionNotes: "manually reviewed from MUON desktop",
          manualReview: input.manualReview,
        });
        recordMergeOutcome(resolved.id, resolved.merge);
        void monitor.poll();
        return {};
      }
      await decideApproval(client, input.approvalId, input.status);
      void monitor.poll();
      return {};
    }
  );

  // The desktop's `muon ship`: FILE the governed merge gate for one finished
  // dispatch. Filing only — this handler NEVER decides the gate. With gates on
  // the operator decides it in Review; under Full Auto the standing consent
  // decides it on the auto-approver's next poll, exactly like every other
  // gate. A second consent site here is the bounded-surface hazard this
  // codebase has been burned by twice, so there deliberately is none.
  ipcMain.handle(
    "muon:shipTask",
    async (
      _event,
      input: {
        jobId: string;
        taskId: string;
        requestedBy: string;
        kind: "merge";
        reason: string;
      }
    ): Promise<ShipTaskResult> => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      // Authorization + filing live in lib/ship-task.ts (unit-tested without
      // Electron); only the selection-version fence needs main's own state.
      const result = await fileShipGate(client, chatId, input, () => {
        if (
          selectionVersion !== boundChatSelectionVersion ||
          chatId !== boundChatId
        ) {
          throw new Error(
            "The selected chat changed before the gate was filed."
          );
        }
      });
      // Wake the monitor so the new gate reaches Review (and, under Full
      // Auto, the auto-approver) without waiting a full poll interval.
      void monitor.poll();
      return result;
    }
  );

  ipcMain.handle(
    "muon:applyWorkflowProposal",
    async (_event, input: { runId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      await requireRendererWorkflowRun(client, chatId, input.runId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before workflow apply.");
      }
      await client.applyWorkflowRun(input.runId, "human:desktop");
    }
  );

  ipcMain.handle(
    "muon:dismissWorkflowProposal",
    async (_event, input: { runId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      await requireRendererWorkflowRun(client, chatId, input.runId);
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed before workflow dismissal.");
      }
      await client.updateWorkflowRun({
        runId: input.runId,
        status: "abandoned",
      });
    }
  );

  ipcMain.handle("muon:stopAll", () => stopAllDispatches(client));

  ipcMain.handle("muon:streams", async (_event, query: StreamsQuery) => {
    const chatId = boundChatId;
    const selectionVersion = boundChatSelectionVersion;
    const chunks = await listRendererStreamChunks(client, chatId, query);
    return selectionVersion === boundChatSelectionVersion &&
      chatId === boundChatId
      ? chunks
      : [];
  });

  // LIVE TERMINAL (0038) — one read of a dispatched job's REAL console.
  //
  // Here rather than in the renderer because `GET /api/dispatch/:jobId/terminal`
  // is OPERATOR tier: watching an agent work must never require the renderer to
  // hold a token. Read-only by construction — the bridge has no write
  // counterpart, because typing into a dispatched agent would bypass the
  // approval path that makes it governed.
  //
  // Chat scope is SOFT (query.chatId, like workspaceReview/githubReview): a
  // human watching one worker while switching missions must not have the pane
  // yanked mid-poll. Authorization still happens per read.
  ipcMain.handle(
    "muon:jobTerminal",
    async (_event, query: JobTerminalQuery) =>
      readRendererJobTerminal(client, boundChatId, query)
  );

  // BACKLINK RESUME PROBE — the renderer asks BEFORE drawing "Open this job's
  // real <vendor> session", and shows the reason in the button's place when
  // the answer is no. Same lookup the spawn path authorizes with
  // (lookupJobVendorSession), so the button and the click cannot diverge.
  // Always resolves: a probe that rejected would re-create the blank-pane
  // class it exists to prevent.
  ipcMain.handle(
    "muon:jobResumeProbe",
    async (_event, query: JobResumeProbeQuery): Promise<JobResumeProbe> => {
      try {
        // `query.jobId` is TYPED here, not parsed: the type is a claim about
        // our renderer's code, and this handler's argument is whatever crossed
        // the bridge. Bound its shape before it becomes part of a request path
        // downstream (the client escapes it as well).
        const lookup = await lookupJobVendorSession(
          requireRendererRecordId(query?.jobId, "job")
        );
        return lookup.ok
          ? {
              status: "ready",
              vendor: lookup.vendor,
              sessionId: lookup.sessionId,
              // The mode the spawn will be authorized for, verbatim from the
              // same lookup — so a button that says "fork" cannot be a door
              // that resumes, or the reverse.
              mode: lookup.mode,
            }
          : {
              status: "unavailable",
              reason: lookup.reason,
              // "Not yet" vs "no", decided by the SAME resolver from the job's
              // own status — the renderer re-probes on this and words the
              // callout from it, and must never derive either itself.
              ...(lookup.pending ? { pending: true } : {}),
            };
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "MUON could not check whether this session can be reopened.",
        };
      }
    }
  );

  // GitHub OAuth/review is an OPERATOR-only backend surface. Trusted main is
  // the sole IPC consumer of the credential-bearing poll response: it persists
  // the secret to the 0600 settings file and returns only safe status fields.
  ipcMain.handle("muon:startGitHubDeviceFlow", () =>
    client.startGitHubDeviceFlow()
  );
  ipcMain.handle(
    "muon:pollGitHubDeviceFlow",
    async (
      _event,
      input: { flowId: string }
    ): Promise<GitHubDeviceFlowUiPoll> => {
      const result = await client.pollGitHubDeviceFlow(input.flowId);
      if (result.status !== "connected") {
        return result;
      }
      persistGitHubCredential(result.credential);
      return {
        status: "connected",
        ...(result.login ? { login: result.login } : {}),
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      };
    }
  );
  ipcMain.handle("muon:disconnectGitHub", async () => {
    const status = await client.disconnectGitHub();
    settings = { ...settings, githubCredential: undefined };
    persistUserSettings();
    // Crossing INTO the gate: rebuild the job monitor (auto-continue snapshot)
    // and close any live human terminals — a locked app must not keep hosting
    // an interactive shell with workspace access after its UI has unmounted.
    if (githubGateActive()) {
      restartJobMonitor();
      terminalHostController?.closeAllSessions();
    }
    return status;
  });
  ipcMain.handle(
    "muon:githubReview",
    async (_event, query: WorkspaceReviewQuery) => {
      // Same soft scope as workspaceReview — authorize by owning chat, do not
      // abort when the user switches missions mid-load.
      const chatId = query.chatId ?? boundChatId;
      await requireRendererDispatchJob(client, chatId, query.jobId);
      return loadGitHubReview(client, query, {
        onCredential: (credential) => persistGitHubCredential(credential),
      });
    }
  );
  ipcMain.handle(
    "muon:createGitHubPullRequest",
    async (_event, query: GitHubCreatePullRequestQuery) => {
      const chatId = query.chatId ?? boundChatId;
      await requireRendererDispatchJob(client, chatId, query.jobId);
      return createWorkspacePullRequest(client, query, {
        onCredential: (credential) => persistGitHubCredential(credential),
      });
    }
  );
  ipcMain.handle(
    "muon:mergeGitHubPullRequest",
    async (_event, query: GitHubMergePullRequestQuery) => {
      const chatId = query.chatId ?? boundChatId;
      await requireRendererDispatchJob(client, chatId, query.jobId);
      return mergeWorkspacePullRequest(client, query, {
        onCredential: (credential) => persistGitHubCredential(credential),
      });
    }
  );
  ipcMain.handle(
    "muon:openGitHubUrl",
    async (_event, input: { url: string }) => {
      if (!isAllowedGitHubExternalUrl(input.url)) {
        throw new Error("Refusing to open an untrusted GitHub URL.");
      }
      await shell.openExternal(input.url);
    }
  );

  // WHICH TREE the human's review evidence is read from. A worktree-backed
  // harness edits the task checkout in MUON's external worktree store while the job record
  // keeps naming the canonical checkout, so both review reads below resolve the
  // job's REAL tree first and degrade (never silently substitute the root) when
  // an expected worktree cannot be located. See lib/job-tree.ts.
  //
  // Built PER CALL, not once: `client` is reassigned whenever the operator saves
  // new API coordinates, and a captured client would keep asking the previous
  // brain which harnesses use a worktree. The probe's cache is therefore
  // per-read, which is all it needs (one harness per review).
  const jobTreeDependencies = (): JobTreeDependencies => ({
    ...defaultJobTreeDependencies,
    requiresWorktree: harnessWorktreeProbe(client),
  });

  ipcMain.handle(
    "muon:workspaceReview",
    async (_event, query: WorkspaceReviewQuery) => {
      // Authorize against the job's owning chat (query.chatId), falling back to
      // the selected chat for older callers. Never require the reviewed chat to
      // stay selected for the whole load — sidebar reviews every open mission.
      const chatId = query.chatId ?? boundChatId;
      await requireRendererDispatchJob(client, chatId, query.jobId);
      const treeDeps = jobTreeDependencies();
      return loadWorkspaceReview(client, query, {
        ...defaultWorkspaceReviewDependencies,
        resolveTree: (job) => resolveJobTree(job, treeDeps),
      });
    }
  );
  // ROADMAP 4.1b — the governed-evidence review lane: resolve the job's worktree,
  // then map its diff to affected execution flows (fail-closed). Always resolves.
  ipcMain.handle(
    "muon:reviewDiff",
    async (_event, query: ReviewDiffQuery): Promise<ReviewDiffResponse> => {
      try {
        const job = await requireRendererDispatchJob(
          client,
          boundChatId,
          query.jobId
        );
        const resolution = await resolveJobTree(job, jobTreeDependencies());
        if (resolution.status === "unresolved") {
          return {
            status: "degraded",
            reason: resolution.reason,
            action: resolution.action,
          };
        }
        const result = await loadReviewDiff(resolution.tree.path, {
          scope: query.scope,
          baseRef: query.baseRef,
        });
        // The verdict is only trustworthy alongside the tree it was computed
        // from, so they travel together and the panel names the tree.
        return result.status === "ok"
          ? { ...result, tree: resolution.tree }
          : result;
      } catch (error) {
        return {
          status: "degraded",
          reason: `Could not load the dispatch job: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        };
      }
    }
  );

  // Crew topology reads (OPERATOR tier, the local human surface). Both are
  // ALWAYS-RESOLVING: loadCrewRoles/loadCoordination map a missing route,
  // timeout, or unrecognized body to `{status:"unavailable", reason}` so the
  // Topology tab degrades to local dispatch state instead of blanking.
  //
  // SCOPE: strictly the SELECTED chat. requireSelectedRendererChat refuses a
  // foreign chatId outright (that is a real violation, not a degrade), and the
  // post-await selection re-check turns a chat SWITCH mid-flight into an
  // unavailable result rather than cross-chat bleed into the new chat's panel.
  const crewTopologyCoords = () => ({
    apiBase: settings.apiBase,
    apiToken:
      settings.apiToken ??
      process.env.MUON_OPERATOR_TOKEN ??
      process.env.MUON_API_TOKEN,
  });
  ipcMain.handle(
    "muon:crewRoles",
    async (_event, input: { chatId: string }): Promise<CrewRolesResponse> => {
      requireSelectedRendererChat(boundChatId, input.chatId);
      const selectionVersion = boundChatSelectionVersion;
      const result = await loadCrewRoles({
        ...crewTopologyCoords(),
        chatId: input.chatId,
      });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        input.chatId !== boundChatId
      ) {
        return {
          status: "unavailable",
          reason: "The selected chat changed while roles were loading.",
        };
      }
      return result;
    }
  );
  ipcMain.handle(
    "muon:coordination",
    async (
      _event,
      input: { chatId: string; missionId?: string }
    ): Promise<CoordinationResponse> => {
      requireSelectedRendererChat(boundChatId, input.chatId);
      const selectionVersion = boundChatSelectionVersion;
      const result = await loadCoordination({
        ...crewTopologyCoords(),
        chatId: input.chatId,
        missionId: input.missionId,
      });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        input.chatId !== boundChatId
      ) {
        return {
          status: "unavailable",
          reason:
            "The selected chat changed while coordination was loading.",
        };
      }
      return result;
    }
  );

  // P6a, the pre-edit ("Brain") gate, backed by the OPERATOR client (the human
  // surface). getMemoryNote is the operator-tier note-by-id read for a proposal's
  // text on demand; updateMemoryNote is the operator-tier KG-6 confirm/reject.
  ipcMain.handle(
    "muon:preEditContext",
    async (_event, input: Parameters<typeof client.preEditContext>[0]) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before loading pre-edit evidence.");
      }
      // ADR-0026 §9: the hero gate, fenced to the bound chat's workspace for the
      // same reason `memoryLibrary` above is — and here it matters most, because the
      // gate fans out one recall per anchor MODULE and those paths are
      // workspace-relative. `chatId`/`workspace` last so the bound values win.
      const workspace = boundWorkspace;
      const context = await client.preEditContext({
        ...input,
        chatId,
        ...(workspace ? { workspace } : {}),
      });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while evidence was loading.");
      }
      return context;
    }
  );

  ipcMain.handle(
    "muon:getMemoryNote",
    async (_event, input: { noteId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before opening memory.");
      }
      const note = await client.getMemoryNote(input.noteId, { chatId });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while memory was loading.");
      }
      return note;
    }
  );

  ipcMain.handle(
    "muon:memoryExplain",
    async (_event, input: { noteId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before explaining memory.");
      }
      // ADR-0026 §9: the PROVENANCE WALK is a read. Without the workspace the
      // traversal crosses repos through the shared `Module` node — the exact
      // `src/index.ts`-collides hazard §1 is about — and a foreign
      // `scope:"global"` note comes back WITH ITS TEXT. The sibling handlers
      // (`muon:memoryLibrary`, `muon:preEditContext`) already send `boundWorkspace`;
      // these two were missed, and a review reproduced the leak.
      const explanation = await client.memoryExplain(input.noteId, {
        chatId,
        workspace: boundWorkspace ?? undefined,
      });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while memory was loading.");
      }
      return explanation;
    }
  );

  // B1 — the bounded neighbourhood of ONE note, for the human note inspector.
  // The bounds live HERE, not on the bridge: the renderer names a note and gets
  // one hop and at most MEMORY_NEIGHBORS_LIMIT nodes back, so no click can turn
  // a governed traversal into a whole-graph read. Operator tier, same chat scope
  // and same selection re-check as memoryExplain. This widens NOTHING for an
  // agent: the route's own text gate still decides which nodes carry prose.
  ipcMain.handle(
    "muon:memoryNeighbors",
    async (_event, input: { noteId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before exploring memory.");
      }
      const neighbors = await client.memoryNeighbors(
        `note:${input.noteId}`,
        {
          chatId,
          // Same fence as `memoryExplain` above, same reason.
          workspace: boundWorkspace ?? undefined,
          hops: MEMORY_NEIGHBORS_HOPS,
          limit: MEMORY_NEIGHBORS_LIMIT,
        }
      );
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while memory was loading.");
      }
      return neighbors;
    }
  );

  ipcMain.handle(
    "muon:updateMemoryNote",
    async (_event, input: Parameters<typeof client.updateMemoryNote>[0]) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before governing memory.");
      }
      const note = await client.getMemoryNote(input.noteId, { chatId });
      if (
        note.chatId !== chatId ||
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error(
          "That memory note is not governed by the selected chat."
        );
      }
      return client.updateMemoryNote(input);
    }
  );

  ipcMain.handle(
    "muon:deleteMemoryNote",
    async (_event, input: { noteId: string }) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before forgetting memory.");
      }
      const note = await client.getMemoryNote(input.noteId, {
        chatId,
        workspace: boundWorkspace ?? undefined,
      });
      if (
        note.chatId !== chatId ||
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error(
          "That memory note is not governed by the selected chat."
        );
      }
      return client.deleteMemoryNote(input.noteId, { chatId });
    }
  );

  // WIN 3 (founder product decision): expose the operator-tier crew-visible
  // toggle READ so the memory UI frames agent notes as "Auto · crew memory"
  // (active) rather than "Review needed" when it is ON. Read-only; the backend
  // route 403s an agent token, and this never mutates the gate.
  ipcMain.handle("muon:getAutoConfirmAgentMemory", () =>
    client.getAutoConfirmAgentMemory()
  );

  ipcMain.handle(
    "muon:memoryLibrary",
    async (_event, query?: MemoryLibraryQuery) => {
      const chatId = boundChatId;
      const selectionVersion = boundChatSelectionVersion;
      if (!chatId) {
        throw new Error("Select a chat before opening memory.");
      }
      // ── ADR-0026 §1 / §9: the desktop was ALREADY workspace-fenced, by accident ──
      //
      // `chatId` last in the spread means the bound chat WINS over any caller value,
      // and `OrchestratorChat.workspacePath` is NOT NULL, so a chat lives in exactly
      // one workspace and the chat fence happened to be a workspace fence. That is a
      // coincidence of two keys, not a stated invariant, and it left one hole: the
      // library's chat admission is `chatId = $chat OR scope = 'global'`, so a
      // promoted global note from ANOTHER repo was admissible (§6). Measured: zero
      // notes on the observed brain have `scope != "project"`, so the hole has never
      // been exercised — which is exactly why closing it costs nothing now.
      //
      // `boundWorkspace` IS the bound chat's `workspacePath` (`bindWorkspace` is
      // called with it on every poll), and the server reduces it with the SAME
      // `repoRootOf` the write path used, so the two cannot disagree. `workspace`
      // last, for the identical reason `chatId` is.
      const workspace = boundWorkspace;
      const snapshot = await loadMemoryLibrary({
        apiBase: settings.apiBase,
        apiToken:
          settings.apiToken ??
          process.env.MUON_OPERATOR_TOKEN ??
          process.env.MUON_API_TOKEN,
        query: {
          ...query,
          chatId,
          ...(workspace ? { workspace } : {}),
        },
      });
      if (
        selectionVersion !== boundChatSelectionVersion ||
        chatId !== boundChatId
      ) {
        throw new Error("The selected chat changed while memory was loading.");
      }
      return snapshot;
    }
  );

  ipcMain.handle("muon:pickFolder", () => pickWorkspaceFolder());

  // P6, "Run your first task": pick a folder, seed the SAFE, additive sample
  // task into it, and dispatch it to a ready vendor. The desktop HOSTS the runner
  // (startRunner), so the dispatched job executes and the fresh user watches the
  // whole loop. Backed by the OPERATOR client; never handles a vendor token; the
  // sample is additive + workspace-scoped (backend P3-B allowlist validates it).
  ipcMain.handle("muon:runFirstTask", async (): Promise<FirstTaskResult> => {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      return { ok: false, reason: "canceled" };
    }
    bindWorkspace(folder); // start indexing early, best-effort
    // Fresh probe (bypass the cache) so a just-completed login is reflected
    // before we block or dispatch.
    const readiness = await client
      .getVendorReadiness({ refresh: true })
      .catch(() => null);
    const vendor = pickQuickstartVendor(readiness);
    if (!vendor) {
      return { ok: false, reason: "no-vendor-ready" };
    }
    try {
      const outcome = await seedQuickstartTask(client, {
        workspacePath: folder,
        vendor,
      });
      if (!outcome.ok) {
        return { ok: false, reason: "no-vendor-ready" };
      }
      // Give the user a home surface for the run: a chat bound to the folder so
      // the dispatched work streams into a familiar place. Best-effort.
      await client.createChat({ workspacePath: folder }).catch(() => undefined);
      const completed = await waitForFirstTaskCompletion({
        jobId: outcome.job.id,
        taskId: outcome.task.id,
        getJob: (jobId) => client.getDispatchJob(jobId),
        recallMemories: (taskId) => client.recallRelatedToTask(taskId),
        addMemory: (input) => client.addMemoryNote(input),
      });
      return {
        ok: true,
        taskId: outcome.task.id,
        jobId: outcome.job.id,
        memoryId: completed.memory.id,
        vendor: outcome.vendor,
        workspacePath: folder,
        completedAt: completed.job.endedAt ?? new Date().toISOString(),
      };
    } catch (error) {
      // A clear, actionable failure, never a raw dump, never a token.
      const notice = classifyVendorFailure({ vendor, readiness, error });
      return {
        ok: false,
        reason: "error",
        message: `${notice.title}: ${notice.detail}`,
        fixHint: notice.fixHint,
        retryable: notice.retryable,
      };
    }
  });

  // P6, hero AUTO-CONTEXT: derive a pre-edit target from a task's touched
  // modules/symbols (its recorded events + anchored memory), so the Brain modal
  // pre-fills itself during a real dispatch. Runs over the operator client;
  // returns null (→ manual entry) when nothing is derivable. Carries no token.
  ipcMain.handle("muon:autoContext", async (_event, input: { taskId?: string }) => {
    const taskId = input?.taskId;
    if (!taskId) {
      return null;
    }
    const chatId = boundChatId;
    const selectionVersion = boundChatSelectionVersion;
    await requireRendererTask(client, chatId, taskId);
    const [events, memories, detail] = await Promise.all([
      client.listTaskEvents(taskId).catch(() => []),
      client.recallRelatedToTask(taskId).catch(() => []),
      client.getTaskDetail(taskId).catch(() => null),
    ]);
    if (
      selectionVersion !== boundChatSelectionVersion ||
      chatId !== boundChatId
    ) {
      return null;
    }
    return deriveAutoContext({ events, memories, taskTitle: detail?.title });
  });

  ipcMain.handle(
    "muon:saveSettings",
    (_event, input: SaveSettingsInput): Promise<DesktopState> => {
      // VALIDATE BEFORE MUTATING. This refusal used to sit after the token
      // assignment, so a save it rejected had already replaced the operator
      // token in module state — the next unrelated persistUserSettings() would
      // write it to disk, and every path reading `userApiToken` used it
      // immediately. A refused request must leave zero durable trace.
      const requestedBase = input.apiBase.trim();
      if (requestedBase && !isLoopbackApiBase(requestedBase)) {
        // FAIL CLOSED on a non-loopback brain. `settings.apiToken` is the OPERATOR
        // bearer and `makeClient()` attaches it to every request against this base,
        // so an unvalidated value here is an operator-credential egress with no
        // human in the loop — and `restartRunner()` would hand the same base to the
        // sandboxed runner. The desktop is loopback-only by design (README), so
        // there is no legitimate caller this refuses.
        throw new Error(
          `Refusing a non-loopback brain URL: ${requestedBase}. MUON's desktop app talks only to a local brain (http/https on 127.0.0.1, ::1 or localhost).`
        );
      }
      const entered = input.apiToken?.trim();
      if (entered) {
        // Manual/hosted entry: the ONE token we persist, and the effective
        // operator token for the client. A blank field means "leave the token
        // as-is" (the raw value is never shown, so it can't be re-submitted).
        userApiToken = entered;
        settings = { ...settings, apiToken: entered };
      }
      settings = {
        ...settings,
        apiBase: requestedBase || settings.apiBase,
      };
      // The human named a base: automatic lockfile rebase stands down until a
      // brain-coords change (applyBrainCoords) supersedes it.
      if (requestedBase) {
        apiBaseExplicit = true;
        // PERSISTED as well as held: a flag that only lived in memory made the
        // opt-out last until the next launch, and no further.
        settings = { ...settings, apiBaseExplicit: true };
      }
      persistUserSettings();
      client = makeClient();
      restartMonitor();
      restartJobMonitor();
      restartRunner();
      return collectState();
    }
  );

  ipcMain.handle(
    "muon:savePresets",
    (
      _event,
      input: { presets?: DesktopPreset[] }
    ): Promise<DesktopState> => {
      settings = {
        ...settings,
        presets: normalizeDesktopPresets(input?.presets),
      };
      persistUserSettings();
      return collectState();
    }
  );

  ipcMain.handle(
    "muon:saveCrewConfig",
    (
      _event,
      input: { crew?: unknown }
    ): Promise<DesktopState> => {
      settings = {
        ...settings,
        crew: normalizeCrewConfig(input?.crew),
      };
      persistUserSettings();
      return collectState();
    }
  );

  ipcMain.handle(
    "muon:listVendorModels",
    async (_event, input: { vendor?: string }) => {
      const {
        isVendorModelTarget,
        listVendorModels,
      } = await import("./lib/vendor-models.js");
      const vendor = input?.vendor;
      // Renderer is untrusted — same guard as resolveVendorModel (TODO 3.1 review).
      if (!isVendorModelTarget(vendor)) {
        throw new Error("Unknown vendor for model catalogue.");
      }
      return listVendorModels(vendor);
    }
  );

  /**
   * Resolve the model the VENDOR reports it will run. The renderer is
   * untrusted, so the vendor id is validated against the registry here and an
   * unknown id is REFUSED rather than defaulted into another vendor's probe.
   *
   * The project-tier settings directory is `boundWorkspace` — MAIN's own view
   * of the workspace it bound — and is deliberately NOT accepted from the
   * renderer. A vendor's settings cascade reads files off disk; letting the
   * renderer name that directory would turn a display resolver into a
   * renderer-directed file read.
   */
  ipcMain.handle(
    "muon:resolveVendorModel",
    async (_event, input: { vendor?: unknown }) => {
      const { isVendorModelTarget, resolveVendorModel } = await import(
        "./lib/vendor-models.js"
      );
      const requested = input?.vendor ?? defaultCoordinatorVendor();
      if (!isVendorModelTarget(requested)) {
        throw new Error("A known vendor id is required to resolve a model.");
      }
      return resolveVendorModel(requested, { projectDir: boundWorkspace });
    }
  );

  ipcMain.handle(
    "muon:applyPreset",
    async (
      _event,
      input: { presetId?: string }
    ): Promise<ApplyDesktopPresetResult> => {
      const presetId = input?.presetId?.trim();
      if (!presetId || presetId.length > 64) {
        throw new Error("A valid preset id is required.");
      }
      // Resolve by id in trusted main. The renderer never supplies a raw
      // LaneProfile, so it cannot smuggle tools, MCP servers, sandbox changes,
      // arbitrary flags, tokens, or full-auto through this convenience path.
      const rawPreset = settings.presets.find(
        (candidate) => candidate.id === presetId
      );
      if (!rawPreset) {
        throw new Error(`Preset '${presetId}' is not configured.`);
      }
      // Stock Careful/Balanced/Quick follow the Mission orchestrator seat.
      const orchestratorVendor = settings.crew
        .orchestratorVendor as DesktopPresetVendor;
      const preset =
        alignStockPresetsToVendor([rawPreset], orchestratorVendor)[0] ??
        rawPreset;
      const lane = (await client.listLanes()).find(
        (candidate) => candidate.key === preset.vendor
      );
      if (!lane) {
        throw new Error(`Lane '${preset.vendor}' is not available.`);
      }
      const current = await client.getLaneProfile(lane.id);
      const profile = applyDesktopPresetToProfile(current.profile, preset);
      // `client` is the desktop's OPERATOR client. No token crosses IPC and the
      // runner still rebuilds the orchestrator's exact bounded grant at launch.
      const updated = await client.putLaneProfile(lane.id, profile);
      return {
        preset: { ...preset },
        laneProfileVersion: updated.version,
      };
    }
  );

  // ---- auto-update IPC (explicit, user-initiated egress) ----

  ipcMain.handle("muon:checkForUpdates", async () => {
    const controller = await getUpdateController();
    await controller?.check();
  });

  ipcMain.handle("muon:downloadUpdate", async () => {
    const controller = await getUpdateController();
    await controller?.download();
  });

  ipcMain.handle(
    "muon:installUpdate",
    async (_event, input?: { force?: boolean }) => {
      const controller = await getUpdateController();
      // `force` is the informed interruption: the renderer only offers it
      // while the waiting-for-work status is naming the lanes it would cut.
      controller?.install({ force: Boolean(input?.force) });
    }
  );

  // Persist the opt-in preference. Enabling it does NOT check immediately, the
  // check runs on the next launch (or when the user clicks "Check for updates").
  ipcMain.handle(
    "muon:setAutoUpdate",
    (_event, input: { enabled: boolean }) => {
      settings = { ...settings, autoUpdate: Boolean(input.enabled) };
      persistUserSettings();
    }
  );

  // S4: persist the auto-continue (durable-nudge) preference. Local-only, no
  // egress. Off falls back to the manual [Continue orchestration] affordance.
  ipcMain.handle(
    "muon:setAutoContinue",
    (_event, input: { enabled: boolean }) => {
      settings = { ...settings, autoContinue: Boolean(input.enabled) };
      setAutoContinueEnvironment(settings.autoContinue);
      persistUserSettings();
      // The durable reconciler lives in the detached runner, so this preference
      // change is not real until that process receives the new explicit 0/1 —
      // but a respawn kills live vendor sessions, so it waits for idle.
      restartRunnerForEnvPreference("auto-continue change");
    }
  );

  // P0-5 / ADR-0031 — diagnostics consent. It gates BOTH the 0600 spool and the
  // PostHog uploader ("no uploader exists" here was left over from before
  // ADR-0031 shipped one). Still not an authority change and still needs no
  // runner restart — but it is the egress switch, which is why revoking it
  // discards the buffer below rather than letting the next flush notice.
  ipcMain.handle(
    "muon:setTelemetryEnabled",
    (_event, input: { enabled: boolean }) => {
      const enabling = input?.enabled === true && !settings.telemetryEnabled;
      const disabling = input?.enabled !== true && settings.telemetryEnabled;
      settings = {
        ...settings,
        telemetryEnabled: input?.enabled === true,
        ...(enabling
          ? {
              telemetryConsentAt: new Date().toISOString(),
              // ADR-0031: a fresh anonymous identity per consent epoch.
              telemetryDeviceId: randomUUID(),
            }
          : {}),
        ...(disabling ? { telemetryDeviceId: undefined } : {}),
      };
      persistUserSettings();
      if (disabling) {
        // ADR-0031: drop anything buffered the MOMENT consent is withdrawn.
        // Waiting for the next flush to notice left a window (up to
        // FLUSH_INTERVAL_MS) in which a re-grant minted a fresh consent epoch
        // and the pre-revocation rows then shipped under it.
        observatoryUploader?.discard();
      }
      if (enabling) {
        // First row of a consenting spool: when consent began. Revocation
        // needs no row — a disabled spool records nothing, so silence after
        // this row IS the revocation record.
        observatory?.record({ name: "consent.granted" });
      }
      return collectState();
    }
  );

  // F3 — the local analytics read: counts + funnel timestamps only, computed
  // in trusted main from the 0600 spool. No raw rows cross the bridge.
  ipcMain.handle("muon:observatorySummary", () =>
    summarizeObservatory(app.getPath("userData"))
  );

  // Vendor-scoped standing consent ("Auto-approve" per lane). The legacy
  // boolean IPC survives as enabled → every lane / none, so the palette toggle
  // and any older renderer keep working; both paths land here.
  const applyFullAutoVendors = (vendors: string[]): void => {
    const normalized = normalizeFullAutoVendors(vendors, false);
    const wasOn = settings.fullAuto;
    settings = {
      ...settings,
      fullAutoVendors: normalized,
      // Derived, never independently set. ALL lanes, not any: the lease
      // heartbeat, the runner env flag, and the schedule executor all read this
      // as an unscoped machine-wide fact, and under a subset each of them would
      // be false. See isGlobalStandingConsent.
      fullAuto: isGlobalStandingConsent(normalized),
    };
    persistUserSettings();
    // Slice 2: on toggle-ON, force an immediate reconcile so the already-
    // pending queue drains now (onState → autoApprovePending) without waiting
    // a full poll interval. On OFF there is nothing to unwind — the next
    // onState simply skips the standing-consent branch.
    // The CADENCE changes with the posture, not just the queue: under
    // standing consent the poll interval is the coordinator's gate latency
    // (see approvalPollIntervalMs). Restarting re-arms the timer at the new
    // rate AND polls immediately, which is what the toggle-ON reconcile
    // below always wanted.
    restartMonitor();
    // ANY armed lane deserves the immediate drain — a subset covers real
    // approvals too (the approver keys on the selection, not the derived
    // ALL-lanes boolean; see the makeMonitor onState wiring).
    if (normalized.length > 0) {
      void monitor.poll();
    }
    // The LEASE tracks the global boolean: it is the unscoped machine-wide
    // "an operator-tier decider is watching" statement, so a drop out of
    // full consent — to a subset OR to off — must not wait for a poll: give
    // it back NOW so the coordinator's session gate goes back to its
    // fast-deny on its very next call. (The server-side TTL is only the
    // backstop for a crash, not the normal path off.)
    if (!settings.fullAuto) {
      void standingApproverLease.release();
    }
    // Slice 3: re-spawn the detached runner so it carries (ON) or drops (OFF)
    // MUON_FULL_AUTO — but ONLY when the derived boolean actually flipped.
    // Moving between non-empty vendor subsets changes which approvals the
    // desktop covers, not the runner env, and a respawn mid-mission hard-kills
    // in-flight vendor sessions (task #9), so it must never happen needlessly.
    if (wasOn !== settings.fullAuto) {
      restartRunnerForEnvPreference("standing-consent change");
    }
  };
  ipcMain.handle(
    "muon:setFullAuto",
    (_event, input: { enabled: boolean }) => {
      applyFullAutoVendors(
        input.enabled ? [...FULL_AUTO_SELECTABLE_VENDORS] : []
      );
    }
  );
  ipcMain.handle(
    "muon:setFullAutoVendors",
    (_event, input: { vendors: string[] }) => {
      applyFullAutoVendors(
        Array.isArray(input.vendors) ? input.vendors : []
      );
    }
  );

  // ROADMAP P6 — opt-in localhost preview. OFF by default; never opens arbitrary hosts.
  ipcMain.handle(
    "muon:setPortPreviewEnabled",
    (_event, input: { enabled: boolean }) => {
      settings = {
        ...settings,
        portPreviewEnabled: Boolean(input.enabled),
      };
      if (!settings.portPreviewEnabled) {
        closePortPreviewWindows();
      }
      persistUserSettings();
    }
  );
  ipcMain.handle(
    "muon:openPortPreview",
    (_event, input: { port: number }) => {
      if (!settings.portPreviewEnabled) {
        throw new Error(
          "Localhost preview is off. Enable it in Settings before opening a port."
        );
      }
      if (
        !canPreviewPortForBoundChat(
          boundChatId,
          boundWorkspace,
          input.port
        )
      ) {
        throw new Error(
          "That port is not a current localhost listener owned by the selected mission."
        );
      }
      openPortPreviewWindow(input.port);
    }
  );
}

// ---- lifecycle ----

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusWindow());

  app.whenReady().then(async () => {
    const dataDir = app.getPath("userData");
    // ROADMAP P7 — spawn resolution must read the SAME userData store the
    // CLI/desktop list IPC use. Default resolveDataDir() usually matches on
    // macOS, but an Electron userData override must win here.
    setCustomAgentLookup((id) => findCustomAgentById(id, dataDir));
    settings = loadSettings(dataDir);
    // Restore the operator's "talk to THIS brain" decision across restarts.
    apiBaseExplicit = settings.apiBaseExplicit === true;
    setAutoContinueEnvironment(settings.autoContinue);
    // P0-5 + ADR-0031: the consent-gated Observatory spool AND its uploader.
    // The comment here used to say "no uploader exists" three lines above the
    // call that constructs one — corrected, along with the `provider` field
    // that was still stamping "none" onto every audited record.
    observatoryUploader = createObservatoryUploader({
      // Egress consent is the TOGGLE ALONE: the MUON_OBSERVATORY_SPOOL audit
      // override records locally but must never upload (ADR-0031).
      enabled: () => settings.telemetryEnabled,
      deviceId: () => settings.telemetryDeviceId ?? null,
    });
    observatory = createObservatory({
      dataDir,
      appVersion: app.getVersion(),
      enabled: () =>
        settings.telemetryEnabled ||
        process.env.MUON_OBSERVATORY_SPOOL?.trim() === "1",
      onRecord: (row) => observatoryUploader?.enqueue(row),
    });
    observatory.record({ name: "app.launch" });
    // Main-process crashes: monitor-only (never swallows the exception).
    process.on("uncaughtExceptionMonitor", () => {
      observatory?.record({
        name: "app.crash.main",
        reason: "uncaught-exception",
      });
    });
    // The persisted token (if any) is by definition the user-supplied one, it
    // is the only token saveSettings writes. The embedded brain may override
    // the effective `settings.apiToken` below, but `userApiToken` stays the
    // durable one so we never re-persist an auto-minted embedded token.
    userApiToken = settings.apiToken;

    // ADR-0029: first boot of a NEW version — surface the confirmation and
    // only then drop the staged-swap rollback bundle. lastRunVersion is
    // re-stamped every boot so the next update can detect itself.
    try {
      const boot = await confirmBoot({
        currentVersion: app.getVersion(),
        lastRunVersion: settings.lastRunVersion,
        appBundlePath: installedAppBundlePath(),
        io: {
          exists: (p) => existsSync(p),
          removeTree: (p) => fsp.rm(p, { recursive: true, force: true }),
        },
      });
      if (boot.justUpdated) {
        pushUpdateStatus({
          state: "updated",
          version: app.getVersion(),
          from: boot.from,
        });
        observatory?.record({ name: "update.applied" });
      }
      if (settings.lastRunVersion !== app.getVersion()) {
        settings.lastRunVersion = app.getVersion();
        persistUserSettings();
      }
    } catch {
      // Boot confirmation is hygiene; it must never block launch.
    }

    // Start (or adopt) the embedded brain, then target it. If it can't start,
    // the app still launches (offline) against the configured settings default.
    brainDataDir = dataDir;
    brain = new BrainSupervisor({
      dataDir,
      onChange: applyBrainCoords,
      onLog: (line) => console.log(`[brain] ${line}`),
      // Debug mode: pretty-print the brain's pino JSON to the terminal. Without
      // this the backend's logs only ever reach brain.log, which is why a dev
      // run looked like it produced "no logs" at all.
      teeToTerminal: childTee(formatBrainLine),
    });
    const coords = await brain.start();
    printDebugBanner(dataDir, coords);
    if (coords) {
      settings = {
        ...settings,
        apiBase: coords.base,
        apiToken: coords.token ?? settings.apiToken,
        agentToken: coords.agentToken ?? settings.agentToken,
      };
    }

    client = makeClient();
    // Kick the ~3.8s vendor-CLI probe NOW, in parallel with everything below,
    // and never await it. By the time the window paints and the human can reach
    // Crew / Status the lane lights are usually already real — and if they are
    // not, those surfaces say "Checking providers…" instead of stalling.
    readinessCache.prime();
    await syncGitHubCredential();
    monitor = makeMonitor();
    jobMonitor = makeJobMonitor();

    // Dock icon: the MUON mark (needed in dev; packaged reads the .icns).
    const dockIcon = nativeImage.createFromPath(appIconPath());
    if (app.dock && !dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }

    // P0-2 — the GitHub identity gate wraps ipcMain.handle AND ipcMain.on
    // BEFORE any handler registers, so every invoke channel and every
    // fire-and-forget send (the terminal relay's muon:openTerminal included)
    // is gate-checked by default. `githubGateActive` reads live module state:
    // finishing the device flow (persistGitHubCredential) unlocks immediately.
    // A packaged build with NO client id degrades to ungated (the gate's one
    // door would not exist) — loudly, because that is a release defect.
    if (githubGateMisconfigured({ env: process.env, isPackaged: app.isPackaged })) {
      console.error(
        "[github-gate] RELEASE DEFECT: packaged build has no MUON_GITHUB_CLIENT_ID — the identity gate cannot arm and is DISABLED for this run."
      );
    }
    installGitHubIpcGate(ipcMain, githubGateActive);
    registerIpcHandlers();
    ipcHandlersRegistered = true;
    createWindow();

    // TODO 7.9 — global hotkey focuses the window and opens ⌘K even when
    // another app is frontmost. Soft-fail if the OS refuses the accelerator
    // (already claimed); in-window ⌘K still works.
    const paletteShortcutOk = globalShortcut.register(
      GLOBAL_PALETTE_SHORTCUT,
      () => {
        focusWindow();
        sendToRenderer("muon:open-command-palette", null);
      }
    );
    if (!paletteShortcutOk) {
      console.warn(
        `[desktop] global shortcut ${GLOBAL_PALETTE_SHORTCUT} was not registered; in-window ⌘K still works`
      );
    }

    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle("◌");
    rebuildTrayMenu();

    monitor.start(approvalPollIntervalMs());
    portMonitor = startPortMonitor({
      listChats: () => client.listChats(),
      listActiveJobs: () =>
        boundChatId
          ? client.listDispatchJobs({
              chatId: boundChatId,
              activeOnly: true,
              limit: 200,
            })
          : Promise.resolve([]),
      resolveJobWorkspace: (jobId) =>
        resolveTerminalWorkspacePath(
          jobId,
          boundChatId,
          (id) => client.getDispatchJob(id),
          (chatId) => client.getChat(chatId)
        ),
    });
    // S4: watch dispatched workers so an idle orchestrator chat is reconciled
    // when they land (bounded auto-continue / [Continue] affordance).
    jobMonitor.start(settings.pollIntervalMs);
    scheduleExecutor.start();
    // BUG 1(b): retire a quickstart first-task stranded QUEUED in an earlier
    // session (its non-terminal jobs + pending approvals) BEFORE the runner
    // comes up, so it can't be re-picked and re-fire its approval modals every
    // launch. Marker-scoped + idempotent; degrades to a no-op if the brain is
    // unreachable, and never wedges startup.
    try {
      const cleared = await cleanupQuickstartTasks(client);
      if (cleared.jobs.length || cleared.approvals.length || cleared.tasks.length) {
        console.log(
          `[quickstart] cleared stale first-task — ${cleared.tasks.length} task(s), ` +
            `${cleared.jobs.length} job(s), ${cleared.approvals.length} approval(s)`
        );
      }
    } catch (error) {
      console.warn(
        `[quickstart] boot cleanup skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    // Host the runner so dispatched work actually executes while the app runs.
    startRunner();

    // Best-effort: bind the local index to the newest workspace. Fire-and-forget
    // AFTER the window — must never block or wedge startup.
    if (!isQuitting) {
      const startupSelectionVersion = boundChatSelectionVersion;
      void client
        .listChats()
        .then((chats) => {
          if (startupSelectionVersion !== boundChatSelectionVersion) {
            return;
          }
          const newest = chats
            .filter((chat) => chat.status !== "archived" && chat.workspacePath)
            .sort((left, right) =>
              (right.updatedAt ?? right.createdAt).localeCompare(
                left.updatedAt ?? left.createdAt
              )
            )[0];
          boundChatSelectionVersion += 1;
          bindChat(newest?.id ?? null);
          bindWorkspace(newest?.workspacePath);
        })
        .catch(() => undefined);
    }

    // Opt-in only: the sole allowed outbound call. Skipped entirely unless the
    // user enabled it in Settings; getUpdateController() is also a no-op in dev.
    if (settings.autoUpdate) {
      void (async () => {
        const controller = await getUpdateController();
        await controller?.check();
      })();
    }
  });

  // Dock icon stays; closing the window keeps the tray companion alive.
  app.on("window-all-closed", () => undefined);
  app.on("activate", () => focusWindow());

  // TERMINAL-DRIVEN shutdowns must run the SAME teardown a menu quit runs.
  // The dev script forwards SIGINT/SIGTERM here, and without these handlers
  // the process died without `before-quit` — the spawned brain was orphaned
  // (Ctrl-C's process-group delivery masked it; a plain `kill` did not), the
  // runner only survived thanks to its parent-death pipe, and pty children
  // raced. One path: signal → app.quit() → the quit coordinator drains the
  // runner, stops the brain (spawned OR adopted-on-our-profile), and reaps
  // every interactive pty. `once` so a second Ctrl-C still force-kills.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`[desktop] ${signal} received — running full teardown`);
      app.quit();
    });
  }

  app.on(
    "before-quit",
    createQuitCoordinator({
      stopMonitor: () => {
        // ADR-0031: best-effort final flush; quit never waits on the network.
        void observatoryUploader?.flush();
        observatoryUploader?.stop();
        monitor?.stop();
        jobMonitor?.stop();
        scheduleExecutor.stop();
        portMonitor?.stop();
        stopPortMonitor();
        closePortPreviewWindows();
        // The approver is going away, so stop claiming it is watching. Best
        // effort by design — the brain may already be down — and unnecessary for
        // correctness: an un-renewed lease lapses within its server-side TTL.
        void standingApproverLease.release();
      },
      onBegin: () => {
        isQuitting = true;
        globalShortcut.unregisterAll();
        gitnexusIndex?.stop(); // best-effort, never awaited
        // ROADMAP T1 — snapshot every human tab's scrollback to disk BEFORE
        // the very next line kills its pty. Best-effort (captureHumanTerminal
        // Snapshot never throws) and strictly ordered: reading scrollback off
        // an already-dead session would race the kill below and could read a
        // torn/short buffer.
        if (terminalHostController) {
          captureHumanTerminalSnapshot(
            app.getPath("userData"),
            terminalHostController.snapshotHumanSessions()
          );
        }
        // Reap the human's own interactive sessions (vendor tabs, shells,
        // resume panes) the moment quit begins — a desktop-side pty child
        // must never outlive the window, mirroring the runner-side
        // terminateLanePtyChildren for governed lanes.
        terminalHostController?.closeAllSessions();
      },
      // Always call stop(), even during backoff with no child: this invalidates
      // delayed recovery before Electron exits.
      drainRunner: () => drainRunner(),
      // Keep the loopback brain alive until the runner has drained its terminal
      // writes and released agents.
      stopBrain: () => brain?.stop(),
      quit: () => app.quit(),
      onError: (error) =>
        console.error(
          `[runner] shutdown drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    })
  );
}
