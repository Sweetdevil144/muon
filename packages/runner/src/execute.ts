import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  applyHarnessToProfile,
  assertHarnessRequirements,
  buildHandoffPacket,
  captureFromMemoryProposals,
  captureFromSignal,
  collectWorktreeEvidence,
  createDiffEvaluator,
  createMemoryWindowStore,
  createStreamRecorder,
  ensureTaskWorktree,
  extractMemoriesViaLane,
  hashMiningOutput,
  ingestCandidates,
  MEMORY_EXTRACTOR_PRINCIPAL,
  mergeProfilePatch,
  parseWorkerFinalReport,
  parseWorkerMemoryProposals,
  redactedTail,
  READ_ONLY_LANE_PROFILE,
  runLaneTask,
  runLoop,
  resolveRepoRoot,
  selectMemorySliceNotes,
  selectStandingNotes,
  startManagedSession,
  stdinBriefDeliveryStall,
  summarizeWorktreePreparation,
  withMemorySlice,
  withStandingMemory,
  withMuonMcpServer,
  withWorkerPreamble,
  attestRepoEnvironment,
  isVendorSessionId,
  laneUsesPtyConsole,
  locateTaskWorktreePath,
  MUON_MCP_SERVER_NAME,
  toHandoffCheck,
  type CaptureSignal,
  type LanePtySpawn,
  type MemoryCandidate,
  type MemoryIngestSink,
  type RunLaneTaskInput,
  type SessionLedger,
  type WorktreeEvidence,
} from "@muon/core";
import {
  budgetExhaustedResult,
  MUON_CONTROL_TOOL_NAMES,
  MUON_DELEGATE_EDIT_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  PRE_LAUNCH_INTERRUPT_RESULTS,
  ROLE_SPECS,
  RoleAuthorityError,
  agentRoleSchema,
  assertProfileMatchesRole,
  delegationManifestSchema,
  delegationRootPolicySchema,
  HANDOFF_DEGRADATION,
  isVendorId,
  memorySliceFilter,
  narrowProfileForRole,
  policyProfileSchema,
  sessionCapability,
  STREAM_MESSAGE_CONTENT_CHARS,
  vendorSupportsInteractive,
  type HandoffCheck,
  type HandoffPacket,
  type LaneEvent,
  type LaneProfile,
  type PolicyProfile,
  type StandingApproverGrant,
  type ContextExposureInput,
} from "@muon/protocol";
import {
  describeToolGap,
  dispatchToolGap,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  resolveCheckArgv,
  type AgentRole,
} from "@muon/protocol";
import { resolveImportedServers } from "./imported-capabilities.js";
import {
  emptyHarnessConfig,
  isAuthorizationFailure,
  waitForApproval,
  type AgentRecord,
  type DispatchJobRecord,
  type MuonApiClient,
} from "@muon/client";
import { verifyEditPreflightCoverage } from "./preflight-coverage.js";
import {
  createContextEvidenceRecorder,
  supportsContextEvidence,
  type ContextEvidenceRecorder,
} from "./context-evidence.js";
import {
  JobTerminalHost,
  type JobTerminalSession,
  type JobTerminalSink,
} from "./pty/job-terminal.js";
import {
  materializeMemoryDirectory,
  supportsMemoryDirectory,
  withMemoryDirectoryHint,
} from "./memory-directory.js";
import {
  createMemoryToolEvidenceCollector,
  groundMemoryToolEvidence,
  type MemoryToolObservation,
} from "./memory-tool-evidence.js";

export type ExecuteOptions = {
  apiBase: string;
  apiToken?: string;
  /** Per-job bearer client used for content-bearing cognition calls. The
   * persistent runner keeps its shared agent client for queue/control traffic,
   * while the vendor run receives only this exact job capability. */
  jobClient?: MuonApiClient;
  /** Progress lines (steer received, interrupt requested, …). */
  onLog?: (line: string) => void;
  /** How often a live session polls the brain for steer/interrupt. */
  steerPollMs?: number;
  /** Explicit runner-lease fence for the active vendor execution. */
  signal?: AbortSignal;
  /** One-job capability issued only to this lease-holding runner. */
  delegationToken?: string;
  /** Exact runner lease used for destructive queue drains. */
  runnerLease?: { host: string; leaseToken: string };
  /**
   * Liveness watchdog: if the vendor produces NO stream output within this many
   * ms of launch, MUON stops it with a distinct, honest reason instead of
   * letting it burn the whole wall-clock budget in silence. 0 disables it.
   */
  startupTimeoutMs?: number;
  /**
   * Post-first-output inactivity window. A pending human approval pauses this
   * clock; real assistant/tool activity restarts it. 0 disables it.
   */
  postOutputTimeoutMs?: number;
  /**
   * Where this job's LIVE TERMINAL frames go. Absent → derived from
   * `runnerLease` below, because publishing is lease-fenced exactly like every
   * other mid-flight write the runner makes. Absent AND no lease → there is no
   * live terminal at all and the job runs precisely as it does today.
   *
   * Injected rather than constructed so a test can assert the exact bytes a run
   * publishes without a brain.
   */
  jobTerminalSink?: JobTerminalSink;
  /**
   * REAL-terminal factory for one-shot vendor children (node-pty in the
   * desktop runner, a fake in tests). Injected by the process that owns the
   * native dependency; @muon/runner itself never imports it. Absent → pipes,
   * today's behaviour exactly. Only lanes that opt in (`prefersPtyConsole`)
   * ever run on it, so pipes-contract lanes are unaffected by construction.
   */
  ptySpawn?: LanePtySpawn;
};

/**
 * Default no-first-output window. Generous enough that any streaming vendor
 * (Claude SDK, Codex app-server) emits SOMETHING well within it, so it only
 * fires on a genuinely stuck launch, never on a legitimately slow first turn.
 * It does NOT identify the cause: a provider can take minutes to reject a
 * request on quota/billing, so the window closes first and the report may only
 * state what was observed (see `stallReason`).
 */
/**
 * How many times one job may try to record ONE reported vendor session id as
 * its backlink. Bounded so a wedged brain cannot be re-POSTed once per
 * steer-poll tick for the whole life of a long job; generous enough to ride
 * out a restart. A NEW id (a loop iteration's fresh session) re-arms the
 * bound — see `stampVendorSession`.
 */
const MAX_VENDOR_SESSION_STAMP_ATTEMPTS = 3;

/**
 * No-first-output window for a WORKER.
 *
 * Was 90 s, and 90 s executed healthy runs: a vendor that is still completing an
 * MCP handshake, loading a large system prompt, or thinking through its first
 * turn is legitimately silent past it, and the report it then wrote ("no output
 * within 90s… a provider quota / auth / MCP failure") named three causes that
 * had not happened. Tripled, because the watchdog's job is to catch a vendor
 * that is HUNG, and three minutes of total silence is still far outside any
 * healthy first turn while costing a 20-minute worker 15% of its budget in the
 * genuinely-hung case. Disarmed the instant real vendor output arrives (see
 * `sawFirstOutput`), so it never bounds a run that has proven itself alive —
 * `DEFAULT_POST_OUTPUT_STALL_MS` takes over from there.
 */
export const DEFAULT_STARTUP_STALL_MS = 180_000;
/**
 * The same window for the ROOT COORDINATOR, which has strictly more to do
 * before its first token than a worker does: it handshakes the muon MCP server
 * AND the code-graph server, receives the governed memory slice, and opens on
 * the largest system prompt MUON builds. This is the run that actually died —
 * orchestrator job 1815d211, killed at 90 s having produced nothing, which the
 * human saw as an unexplained dead turn.
 *
 * Five minutes: an order of magnitude past any healthy first-output latency
 * observed, and still only a sixth of the 30-minute chat-turn budget, so a
 * coordinator that is genuinely hung is caught with 25 minutes of the turn left
 * rather than burning it in silence.
 */
export const DEFAULT_ORCHESTRATOR_STARTUP_STALL_MS = 300_000;
export const DEFAULT_POST_OUTPUT_STALL_MS = 5 * 60_000;
/**
 * Post-first-output inactivity window for the root coordinator. Doubled over a
 * worker's for the same reason as above: a coordinator's quiet periods are
 * whole-graph impact queries and delegation waits, not an edit/test cycle, and
 * a single legitimate long tool call must not read as a hang.
 */
export const DEFAULT_ORCHESTRATOR_POST_OUTPUT_STALL_MS = 10 * 60_000;

/**
 * WHICH stall windows a run gets. Extracted so the choice is one statement with
 * one owner and can be asserted directly — the alternative is a unit test that
 * waits five real minutes to discover which default was picked, which is the
 * kind of test nobody writes, which is how the coordinator ended up on a
 * worker's window in the first place.
 *
 * An explicit option always wins (a caller that names a window means it).
 */
export function resolveStallWindows(input: {
  capabilityMode: "worker" | "delegate" | "orchestrator";
  startupTimeoutMs?: number;
  postOutputTimeoutMs?: number;
}): { startupStallMs: number; postOutputStallMs: number } {
  const coordinator = input.capabilityMode === "orchestrator";
  return {
    startupStallMs:
      input.startupTimeoutMs ??
      (coordinator
        ? DEFAULT_ORCHESTRATOR_STARTUP_STALL_MS
        : DEFAULT_STARTUP_STALL_MS),
    postOutputStallMs:
      input.postOutputTimeoutMs ??
      (coordinator
        ? DEFAULT_ORCHESTRATOR_POST_OUTPUT_STALL_MS
        : DEFAULT_POST_OUTPUT_STALL_MS),
  };
}
const MEMORY_OBJECTIVE_QUERY_CHARS = 600;

/**
 * Search the already-governed memory view with a bounded task objective, not a
 * freshly-created task id alone. Worker contracts put GOAL/SCOPE first; a root
 * coordinator may carry a larger generated preamble, so its human payload is
 * conservatively taken from the tail. This string is local search data only.
 */
function memoryObjectiveQuery(
  brief: string,
  capabilityMode?: string | null
): string | undefined {
  const normalized = brief.trim().replace(/\s+/g, " ");
  if (normalized.length < 12) return undefined;
  return capabilityMode === "orchestrator"
    ? normalized.slice(-MEMORY_OBJECTIVE_QUERY_CHARS)
    : normalized.slice(0, MEMORY_OBJECTIVE_QUERY_CHARS);
}

/**
 * The slice-dedup match rule (TODO 4.2). Byte-identical to
 * `memory-ranking.ts`'s `normalizeForMatch` — trim, collapse runs of
 * whitespace, lowercase — restated here as a one-liner rather than reached for
 * across the package boundary (the runner imports no graph internals, and this
 * is a best-effort brief collapse, not a gate). Two notes whose text normalizes
 * to the same string are the SAME statement for slice purposes.
 */
function normalizeNoteText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Collapse a note list for the brief slice by ID **and by content** (TODO 4.2).
 *
 * Keying on `id` alone let the same fact repeat verbatim in one slice whenever
 * it arrived under two ids — a clone note, or the identical text learned in two
 * chats and fused from `taskNotes` + `objectiveNotes`. Now an exact id repeat
 * is dropped as before, AND a second note whose text normalizes to one already
 * kept is dropped too, so a slice never spends two of its `k` lines on one
 * statement.
 *
 * Order and representative choice are deliberate: first occurrence holds the
 * slot (so the caller's fusion order is preserved), EXCEPT that a
 * human-confirmed note UPGRADES an unconfirmed twin in place — when the same
 * text appears confirmed and unconfirmed, the slice keeps the confirmed one at
 * the earlier position. Trust is the tie-breaker the downstream vouched-only
 * selection cares about, so the collapse must not discard it.
 */
export function dedupeMemoryNotes<
  T extends { id: string; text: string; confirmed?: boolean },
>(notes: T[]): T[] {
  const out: T[] = [];
  const seenIds = new Set<string>();
  const slotByContent = new Map<string, number>();
  for (const note of notes) {
    if (seenIds.has(note.id)) continue;
    seenIds.add(note.id);
    const key = normalizeNoteText(note.text);
    const existingSlot = slotByContent.get(key);
    if (existingSlot === undefined) {
      slotByContent.set(key, out.length);
      out.push(note);
      continue;
    }
    // Content collision: keep the position, but let a confirmed note replace an
    // unconfirmed twin (never the reverse — an unconfirmed clone can't demote a
    // confirmed representative).
    const kept = out[existingSlot];
    if (note.confirmed && !kept.confirmed) {
      out[existingSlot] = note;
    }
  }
  return out;
}

/** Bounded rolling tail of the vendor's own stderr kept for stall reporting. */
const VENDOR_STDERR_TAIL_CHARS = 2000;

/**
 * What `DispatchJob.result` keeps of a vendor's output: the TAIL, because the
 * end of a run is where its verdict is.
 *
 * Was 4 000 — the "small copy", on the theory that the report-sized copies were
 * the stream chunk and the packet's `finalMessage`. In practice this IS the
 * report for anything that reads the ledger row, and 4 000 cut real closing
 * reports: codex job 1becbe2c committed
 * `[muon:truncated] 59 characters were dropped from the START` — a worker's
 * verdict clipped for the sake of 59 characters. Raised to the SAME class the
 * stream recorder already stores assistant output at
 * (`STREAM_MESSAGE_CONTENT_CHARS`, 64 000), so a report survives the ledger the
 * way it survives the stream, and the marker is kept for a genuinely huge
 * output because a tail that starts mid-word looks exactly like a vendor that
 * began mid-word.
 *
 * Bounded, not unbounded: 64 000 characters plus a packet still sits far inside
 * Fastify's 1 MiB default body limit on the terminal PATCH, which is the next
 * hard clamp on this path.
 */
const JOB_RESULT_TAIL_CHARS = STREAM_MESSAGE_CONTENT_CHARS;
/**
 * The same tail on the branch that appends MUON's completion-gate verdict, held
 * one gate-verdict's worth below it so the appended sentence cannot push the
 * stored row past the bound the tail marker just promised.
 */
const JOB_RESULT_GATED_TAIL_CHARS = JOB_RESULT_TAIL_CHARS - 600;

function jobResultTail(
  output: string,
  maxChars = JOB_RESULT_TAIL_CHARS
): string {
  if (output.length <= maxChars) {
    return output;
  }
  return (
    `[muon:truncated] ${output.length - maxChars} characters were dropped ` +
    `from the START of this output; MUON kept the last ${maxChars}. The ` +
    `worker's closing message rides the typed handoff packet (handoff_read).` +
    `\n\n${output.slice(-maxChars)}`
  );
}

/**
 * What MUON actually SAW of the vendor's stderr when a watchdog fired.
 *
 * `attached` separates "the vendor wrote nothing" from "this execution path
 * carried no stderr observer". The watchdog may only report what it observed:
 * claiming silence it never listened for is the same defect as naming a cause
 * it never saw.
 */
type VendorStderrEvidence = {
  attached: boolean;
  tail: string;
  /**
   * Set when the vendor said it was blocked reading its prompt from stdin. This
   * is the one cause the watchdog can name with certainty, so when it is present
   * it REPLACES the speculative cause list rather than joining it.
   */
  stdinWaitCause?: string;
};

/**
 * Short, explicitly-unconfirmed cause list. Quota/billing is named FIRST
 * because it is both real and slow: a provider can take minutes to answer with
 * a spend-cap rejection, so the startup window closes long before it arrives.
 */
const STALL_CAUSE_HINT =
  "Possible causes, none confirmed by MUON: a provider quota / billing / rate-limit rejection (these can take minutes to return), a vendor auth or profile failure, or an unfinished MCP handshake.";

/**
 * Honest, distinct reason surfaced when the liveness watchdog fires.
 *
 * The first line states only what MUON OBSERVED (downstream surfaces show that
 * line alone); the vendor's own bounded, redacted stderr is appended last.
 */
function stallReason(
  observation: string,
  vendor: string,
  evidence: VendorStderrEvidence
): string {
  // An OBSERVED cause outranks the speculative list. `STALL_CAUSE_HINT` names
  // quota, auth and MCP because those are the plausible unknowns; offering them
  // when MUON actually watched the child say it was waiting on stdin would bury
  // the real answer among three wrong ones.
  if (evidence.stdinWaitCause) {
    return [
      `${observation}; ${vendor} was waiting on stdin.`,
      evidence.stdinWaitCause,
      ...(evidence.tail.length > 0
        ? [`--- ${vendor} stderr (tail) ---`, evidence.tail]
        : []),
    ].join("\n");
  }
  if (evidence.tail.length > 0) {
    return [
      `${observation}; ${vendor} wrote to stderr (its own output, redacted, below).`,
      STALL_CAUSE_HINT,
      `--- ${vendor} stderr (tail) ---`,
      evidence.tail,
    ].join("\n");
  }
  return [
    `${observation}; ${
      evidence.attached
        ? "the vendor produced nothing on stdout or stderr"
        : `MUON captured no stderr from ${vendor} on this run`
    }.`,
    STALL_CAUSE_HINT,
  ].join("\n");
}

function startupStallReason(
  vendor: string,
  ms: number,
  evidence: VendorStderrEvidence
): string {
  return stallReason(
    `MUON stopped ${vendor}: no output within ${Math.round(ms / 1000)}s`,
    vendor,
    evidence
  );
}

function postOutputStallReason(
  vendor: string,
  ms: number,
  evidence: VendorStderrEvidence
): string {
  return stallReason(
    `MUON stopped ${vendor}: no assistant or tool activity for ${Math.round(
      ms / 1000
    )}s after work began`,
    vendor,
    evidence
  );
}

/**
 * Only genuine vendor activity may disarm the startup watchdog.
 *
 * Adapter lifecycle messages (`task.started`) and profile-compatibility
 * diagnostics are emitted synchronously before the child process or SDK has
 * produced any output. Treating either as progress leaves a silent vendor
 * marked "running" until the full wall-clock budget. Approval requests count
 * because they prove the vendor is alive and intentionally waiting at a
 * fail-closed human gate.
 */
function isVendorStartupProgress(event: LaneEvent): boolean {
  if (event.metadata.profileUnsupported !== undefined) {
    return false;
  }
  // Preflight/lifecycle diagnostics occur before the vendor has begun useful
  // work and must not disarm the startup watchdog. Once Codex reports an actual
  // item coordinate, though, the provider is demonstrably active even if its
  // first assistant token has not arrived yet.
  if (
    event.metadata.controlPlane === true &&
    event.metadata.codexActivity === undefined &&
    event.metadata.toolActivity === undefined &&
    event.metadata.approvalResolved !== true &&
    event.kind !== "approval.requested" &&
    event.kind !== "approval.auto"
  ) {
    return false;
  }
  return (
    (event.kind === "task.progress" && event.message.trim().length > 0) ||
    event.kind === "approval.requested" ||
    event.kind === "approval.auto" ||
    event.kind === "task.blocked" ||
    event.kind === "task.completed"
  );
}

/**
 * B2: everything ONE memory capture needs, handed back with the terminal result
 * so the runner can mine AFTER committing that terminal.
 *
 * These are the exact arguments `captureMemories` used to receive inline; the
 * type exists only to carry them across the executeJob → runner boundary.
 */
export type PendingMemoryCapture = {
  harnessKey?: string | null;
  /** TODO 4.19 — harness `memoryCapture: reference` skips LLM mining. */
  memoryCapture?: "mine" | "reference";
  taskId: string;
  laneId: string;
  chatId?: string;
  vendor: string;
  role?: string;
  cwd: string;
  worktreeCwd?: string;
  brief: string;
  output: string;
  /** Structured Edit/Write-family lifecycles observed from the vendor stream. */
  toolObservations?: MemoryToolObservation[];
  relatedNotes?: { id: string; kind: string; text: string }[];
  loop?: { passed: boolean; stopReason: string };
  attempt?: { outcome: "worked" | "abandoned" | "unknown"; summary: string };
};

function buildPendingMemoryCapture(input: {
  harness: { memoryCapture?: "mine" | "reference" };
  job: { harnessKey?: string | null; brief: string; chatId?: string | null; role?: unknown };
  taskId: string;
  laneId: string;
  vendor: string;
  cwd: string;
  worktreeCwd?: string;
  output: string;
  toolObservations?: MemoryToolObservation[];
  relatedNotes?: { id: string; kind: string; text: string }[];
  loop?: { passed: boolean; stopReason: string };
}): PendingMemoryCapture {
  const role =
    typeof input.job.role === "string" ? input.job.role : undefined;
  return {
    harnessKey: input.job.harnessKey,
    memoryCapture: input.harness.memoryCapture ?? "mine",
    taskId: input.taskId,
    laneId: input.laneId,
    chatId: input.job.chatId ?? undefined,
    vendor: input.vendor,
    role,
    cwd: input.cwd,
    worktreeCwd: input.worktreeCwd,
    brief: input.job.brief,
    relatedNotes: input.relatedNotes,
    output: input.output,
    toolObservations: input.toolObservations,
    ...(input.loop ? { loop: input.loop } : {}),
  };
}

export type ExecuteResult = {
  status: "done" | "failed" | "interrupted";
  exitCode?: number;
  result: string;
  /**
   * Typed terminal handoff packet (P0.3). Present for emitting terminals
   * (loop and one-shot); absent for interrupted runs, sessions (deferred),
   * and when emission itself failed — absence is visible downstream.
   */
  packet?: HandoffPacket;
  /**
   * B2: this run's memory capture, DEFERRED to the caller.
   *
   * It used to be awaited HERE, before the result was returned — i.e. before
   * the terminal write — so the LLM mining tier (a whole extra one-shot vendor
   * process, capped at 120s) sat between the assistant's last token and the
   * fleet agent being released. On a coordinator turn that meant the chat kept
   * spinning for up to two minutes after it had visibly finished, and the one
   * coordinator seat stayed claimed the whole time. The runner now commits the
   * terminal FIRST (releasing the seat, ending the turn) and mines afterwards.
   *
   * Absent = there is nothing to capture: an interrupted or aborted run, whose
   * output is not a completed thought worth mining.
   */
  capture?: PendingMemoryCapture;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * S6, extract ONLY a `{model}` key from a job's persisted `actionProfilePatch`.
 * A delegated child's profile has already been narrowed (permission mode reset,
 * rawConfig/extraArgs cleared, MCP + allowedTools pinned to the manifest), so
 * only this single value-typed field may ride its action patch. Picking it here
 * (rather than merging the whole patch) keeps the narrowing attestation byte-
 * identical even if a wider patch ever reached the row — `model` touches none of
 * allowedTools / mcpServers / permissionMode / rawConfig / extraArgs.
 */
function pickModelPatch(patch: unknown): Partial<LaneProfile> | undefined {
  if (
    patch &&
    typeof patch === "object" &&
    !Array.isArray(patch) &&
    typeof (patch as { model?: unknown }).model === "string"
  ) {
    return { model: (patch as { model: string }).model };
  }
  return undefined;
}

export function attestGovernedWorkspace(input: {
  rootWorkspace: string;
  workspacePath: string;
  executionCwd?: string;
  managedTaskId?: string;
}): string | null {
  try {
    const expectedRoot = path.resolve(input.rootWorkspace);
    const expectedWorkspace = path.resolve(input.workspacePath);
    const actualRoot = fs.realpathSync(expectedRoot);
    const actualWorkspace = fs.realpathSync(expectedWorkspace);
    if (
      actualRoot !== expectedRoot ||
      actualWorkspace !== expectedWorkspace ||
      !isWithin(actualRoot, actualWorkspace)
    ) {
      return "governed workspace is no longer canonical or was retargeted after dispatch";
    }
    if (input.executionCwd) {
      const expectedCwd = path.resolve(input.executionCwd);
      const actualCwd = fs.realpathSync(expectedCwd);
      const managedWorktree = input.managedTaskId
        ? fs.realpathSync(locateTaskWorktreePath(actualRoot, input.managedTaskId))
        : null;
      const cwdAllowed =
        actualCwd === actualWorkspace ||
        (actualWorkspace === actualRoot && actualCwd === managedWorktree);
      if (actualCwd !== expectedCwd || !cwdAllowed) {
        return "governed execution cwd is outside the canonical workspace boundary";
      }
    }
    return null;
  } catch {
    return "governed workspace cannot be resolved at execution time";
  }
}

function makeSessionLedger(client: MuonApiClient): SessionLedger {
  return {
    // `input` carries the P0.1 checkpoint bindings (jobId on both the session
    // record and the session gate) straight through to the brain.
    createSession: (input) => client.createSession(input),
    updateSession: (input) => client.updateSession(input),
    requestApproval: (input) => client.requestApproval(input),
    waitForApproval: async (approvalId, timeoutMs) => {
      await waitForApproval(client, approvalId, { timeoutMs });
    },
    // Single-use delivery stamp (consume-before-allow): throws when the stamp
    // did not land, and the session manager then fails closed to deny.
    consumeApproval: (approvalId) => client.consumeCommandApproval(approvalId),
    // Content-bound receipt redemption (P0.4): EVERY failure — transport, a
    // non-2xx, a server-side miss — collapses to `null`, and the seam treats
    // null as "file the gate exactly as today". Never deny, never allow.
    redeemReceipt: (input) =>
      client
        .redeemReceipt(input)
        .then((result) =>
          result.redeemed && result.receipt
            ? {
                receiptId: result.receipt.id,
                expiresAt: result.receipt.expiresAt,
              }
            : null
        )
        .catch(() => null),
  };
}

const REVIEW_HARNESSES = new Set(["review", "security-audit"]);
const EDIT_PREFLIGHT_HARNESSES = new Set(["implement", "repair"]);
/** Bound on a memory-capture diagnostic. Vendor-authored text can reach these
 *  strings, so they go through `redactedTail` before any log or ledger write. */
const MEMORY_DIAGNOSTIC_CHARS = 300;

/**
 * Rolling conversational window (R4 phase 0), one per chat/task, in-process and
 * doubly bounded (10 messages × 300 chars, 64 sessions). Module-level so it
 * survives across the successive jobs of ONE chat inside a runner process. It
 * is a recall aid, never a source of truth: eviction or a runner restart costs
 * the extractor some context and nothing else.
 */
const memoryWindows = createMemoryWindowStore();

/**
 * The rolling window's session key. Keyed by VENDOR as well as by chat/task
 * because the extractor runs on `laneKey: input.vendor`: a chat that switches
 * vendors between jobs would otherwise feed vendor A's output tail into vendor
 * B's extraction prompt, which is one chat's content reaching a second vendor's
 * model. Switching vendors costs the extractor its back-references and nothing
 * else — the window is a recall aid, never a source of truth.
 */
function memoryWindowKey(
  vendor: string,
  chatId: string | undefined,
  taskId: string
): string {
  // A newline can appear in neither a vendor key nor an id, so it cannot be
  // used to make one vendor/chat pair collide with another by concatenation.
  return [vendor, chatId ?? taskId].join("\n");
}

type MemoryMiningPosture = {
  enabled: boolean;
  reason: string;
  /** Control REFUSED the read (401/403) rather than failing to answer it. */
  authFailure?: boolean;
};

/**
 * Resolve whether the LLM mining tier may run for this job.
 *
 * DEFAULT ON. `MUON_MEMORY_MINE` is now only an override: "0" is a guaranteed,
 * network-free kill switch honoured before anything is asked, "1" forces it on.
 * Otherwise the operator-owned setting decides, and every branch names itself so
 * the debug report can say WHICH one fired.
 *
 * The two ways that read can fail are NOT the same fact and do not share a
 * posture:
 *   • control could not ANSWER (offline, timeout, 5xx) → stay permissive. This
 *     one is deliberate: failing closed on a transient blip silently recreates
 *     the empty-brain bug, and the operator's actual setting is unknown.
 *   • control REFUSED the credential (401/403) → fail CLOSED, loudly. A rotated
 *     or misconfigured shared agent token is not transient: it would mine on
 *     EVERY job forever while the operator's setting says off. This governs a
 *     vendor model call carrying untrusted grounded tool payload, the rolling
 *     window, and surfaced note text — an egress decision, not recall hygiene.
 *
 * Read on the runner's SHARED agent client, deliberately not the per-job one:
 * this is control-plane posture, and the brain refuses the read to a per-job
 * capability precisely so a vendor process can never ask.
 */
async function resolveMemoryMining(
  client: MuonApiClient
): Promise<MemoryMiningPosture> {
  const override = process.env.MUON_MEMORY_MINE;
  if (override === "0") {
    return { enabled: false, reason: "MUON_MEMORY_MINE=0 kill switch" };
  }
  if (override === "1") {
    return { enabled: true, reason: "MUON_MEMORY_MINE=1 override" };
  }
  try {
    const enabled = await client.getMemoryMining();
    return {
      enabled,
      reason: enabled ? "operator setting on" : "operator setting off",
    };
  } catch (error) {
    if (isAuthorizationFailure(error)) {
      return {
        enabled: false,
        authFailure: true,
        reason: `control refused this runner's credential while reading the operator setting (${redactedTail(
          error instanceof Error ? error.message : String(error),
          MEMORY_DIAGNOSTIC_CHARS
        )}); mining ships grounded tool evidence to a vendor model, so it fails closed until the token is fixed`,
      };
    }
    return {
      enabled: true,
      reason: `operator setting unreadable (${redactedTail(
        error instanceof Error ? error.message : String(error),
        MEMORY_DIAGNOSTIC_CHARS
      )}), using the default`,
    };
  }
}

/**
 * Is a standing operator approver (Full Auto) watching the approval inbox right
 * now? Asked ONCE PER GATED COORDINATOR TOOL CALL, never cached for the session:
 * the operator can withdraw standing consent mid-run, and the whole point of the
 * lease is that it stops meaning "yes" within a heartbeat of that happening.
 *
 * Read on the runner's SHARED agent client, deliberately not the per-job one —
 * this is control-plane posture, and the brain refuses the read to a per-job
 * capability precisely so a vendor process can never ask.
 *
 * FAIL CLOSED on everything: control offline, a 401, a malformed answer all
 * become `undefined`, which the session gate treats exactly as "no approver",
 * i.e. today's fast-deny. Widening on an unreadable answer would hand a
 * coordinator an ungated shell the moment the brain hiccuped.
 */
async function resolveStandingApprover(
  client: MuonApiClient
): Promise<StandingApproverGrant | undefined> {
  try {
    return await client.getStandingApprover();
  } catch {
    return undefined;
  }
}

/**
 * The self-filling brain in action (R4): after a job finishes, mine durable
 * notes from what it produced and ingest them (unconfirmed, dedup-aware).
 *
 * Always on and free: structured signals, a review that raised CONCERNS, a
 * loop that could not converge, become notes with no model call.
 * On by default (`resolveMemoryMining`): a one-shot lane pass mines grounded
 * Edit/Write tool evidence for everything the structured signals missed.
 * Purely best-effort,
 * capturing memory must never fail or slow the actual work — but it must never
 * fail SILENTLY either, so every degradation is logged and filed as an event.
 */
export async function captureMemories(
  client: MuonApiClient,
  input: {
    /** The runner's SHARED agent client, for the control-plane mining lookup.
     *  Content-bearing writes stay on `client` (the exact-job capability) unless
     *  an explicit `sink` overrides where they go. */
    controlClient: MuonApiClient;
    /**
     * B2: where the ingested notes are WRITTEN. Absent → the `client` above,
     * i.e. the exact-job capability, unchanged. The runner supplies one when it
     * captures AFTER the terminal write, because the per-job capability is dead
     * by then by design and must NOT be kept alive to suit us — see
     * `POST /api/dispatch/:jobId/memory-capture`.
     */
    sink?: MemoryIngestSink;
    /**
     * B2: aborts the extractor's vendor child. The runner passes its DRAIN
     * signal so a shutdown stops an in-flight mining pass promptly instead of
     * leaving a vendor process to outlive the job that spawned it.
     */
    signal?: AbortSignal;
    harnessKey?: string | null;
    memoryCapture?: "mine" | "reference";
    taskId: string;
    laneId: string;
    /** #126: the chat this run belongs to, so auto-captured notes land in the
     *  chat's partition and stay visible to the chat's own agents (a NULL-chat
     *  capture would be reachable only via scope:"global"). Absent → global. */
    chatId?: string;
    vendor: string;
    role?: string;
    cwd: string;
    /** Only a governed worktree may supply module anchors. */
    worktreeCwd?: string;
    /** The assigned brief (never the injected preamble/memory slice): this
     *  turn's human side of the rolling conversational window. */
    brief: string;
    output: string;
    toolObservations?: MemoryToolObservation[];
    /** Notes already surfaced into THIS job's brief. Shown to the extractor as
     *  integers so it neither re-proposes them nor invents an id (§7.1). */
    relatedNotes?: { id: string; kind: string; text: string }[];
    loop?: { passed: boolean; stopReason: string };
    attempt?: { outcome: "worked" | "abandoned" | "unknown"; summary: string };
    onLog?: (line: string) => void;
  }
): Promise<void> {
  // A capture diagnostic must itself be unable to fail the job, so the log line
  // and the ledger write are both individually swallowed.
  const degraded = async (stage: string, detail: unknown): Promise<void> => {
    const reason = redactedTail(
      detail instanceof Error ? detail.message : String(detail),
      MEMORY_DIAGNOSTIC_CHARS
    );
    try {
      input.onLog?.(`memory capture degraded (${stage}): ${reason}`);
    } catch {
      // A logging sink is not allowed to take the job down either.
    }
    try {
      await client
        .recordEvent({
          laneId: input.laneId,
          taskId: input.taskId,
          kind: "task.progress",
          message: `memory capture degraded (${stage})`,
          // controlPlane marks this as MUON's own diagnostic, not vendor
          // activity, exactly like the other runner-emitted events.
          metadata: {
            controlPlane: true,
            memoryCapture: "degraded",
            stage,
            reason,
          },
        })
        .catch(() => undefined);
    } catch {
      // Client without recordEvent, or a transport that threw synchronously.
    }
  };

  try {
    const report = parseWorkerFinalReport(input.output);
    const proposals =
      report?.memoryProposals ?? parseWorkerMemoryProposals(input.output);
    const verifiedModules = input.worktreeCwd
      ? await collectWorktreeEvidence(input.worktreeCwd)
          .then((evidence) =>
            "hash" in evidence.diff ? (evidence.changedFiles ?? []) : []
          )
          .catch(() => [])
      : [];
    const groundedToolCalls = groundMemoryToolEvidence({
      observations: input.toolObservations ?? [],
      worktreeCwd: input.worktreeCwd,
      changedFiles: verifiedModules,
    });
    // Substrate §3.1 coordinate producer: publish observed modules on the live
    // dispatch path (CLI already does this). Feeds KG-7/KG-8 + D9 without
    // changing memory capture. Best-effort — never fail the job for it.
    if (verifiedModules.length > 0) {
      try {
        await client
          .recordEvent({
            laneId: input.laneId,
            taskId: input.taskId,
            kind: "task.progress",
            message: `touched ${verifiedModules.length} file(s)`,
            metadata: { modules: verifiedModules },
          })
          .catch(() => undefined);
      } catch {
        // Client without recordEvent, or a sync throw — ignore.
      }
    }
    const signals: CaptureSignal[] = [];
    if (
      input.harnessKey &&
      REVIEW_HARNESSES.has(input.harnessKey) &&
      /VERDICT:\s*CONCERNS/i.test(input.output)
    ) {
      signals.push({ type: "second_opinion", verdict: input.output });
    }
    if (input.loop && !input.loop.passed) {
      signals.push({ type: "loop_escalation", stopReason: input.loop.stopReason });
    }
    if (input.attempt) {
      signals.push({ type: "execution_attempt", ...input.attempt });
    }
    for (const question of report?.openQuestions ?? []) {
      signals.push({ type: "open_question", question });
    }
    const deterministicSignals = signals.flatMap((signal) =>
      captureFromSignal(signal, {
        taskId: input.taskId,
        laneId: input.laneId,
        modules: verifiedModules,
        createdBy:
          signal.type === "open_question"
            ? `agent:${input.vendor}`
            : "muon-capture",
      })
    );
    const explicitProposals = captureFromMemoryProposals(proposals, {
      modules: verifiedModules,
      taskId: input.taskId,
      laneId: input.laneId,
      createdBy: `agent:${input.vendor}`,
    });

    // The mining posture is resolved BEFORE anything is recorded, because the
    // kill switch has to stop CAPTURE, not just the model call. The rolling
    // window used to be appended around the `if (mining.enabled)` branch, so
    // with mining OFF a job's brief and the tail of its output were still
    // recorded — and the moment the operator flipped mining back ON, the NEXT
    // job's extractor prompt shipped that content to a vendor model. The switch
    // is honoured before MUON asks; it must equally be honoured before MUON
    // KEEPS. Cost of moving it: one loopback settings read per job (both env
    // overrides still answer without any network call).
    const mining = await resolveMemoryMining(input.controlClient);
    const referenceOnly = input.memoryCapture === "reference";
    const sessionKey = memoryWindowKey(
      input.vendor,
      input.chatId,
      input.taskId
    );
    let mined: MemoryCandidate[] = [];
    if (mining.enabled && !referenceOnly) {
      // R4 phase 0: this turn's ask joins the session window BEFORE extraction,
      // so the extractor can resolve "it"/"that approach" against what was
      // asked. Afterward, only MUON's grounded file summary joins — never final
      // assistant prose.
      memoryWindows.append(sessionKey, { role: "human", text: input.brief });
      const recent = memoryWindows.read(sessionKey);
      // TODO 4.5: the model sees only completed/failed Edit/Write-family calls
      // whose paths MUON resolved inside the governed worktree AND found in the
      // git-observed changed set. Final prose is never the mining source.
      if (groundedToolCalls.length > 0) {
        const contentHash = hashMiningOutput(JSON.stringify(groundedToolCalls));
        if (memoryWindows.hasMinedContent(sessionKey, contentHash)) {
          input.onLog?.("memory mining skipped: already mined this evidence");
        } else {
          let miningFailed = false;
          // The extractor reads UNTRUSTED tool-call payload. It must run with NO
          // tools and NO MUON MCP server, it only summarizes data into JSON, so a
          // prompt-injection payload in edited content cannot make it write files
          // or poison the brain. (Its notes still go through dedup and still land
          // UNCONFIRMED — crew-visible inside their own chat when the operator's
          // autoConfirmAgentMemory posture is on, never human-confirmed by it.)
          mined = await extractMemoriesViaLane({
            source: { type: "tool_calls", calls: groundedToolCalls },
            context: {
              taskId: input.taskId,
              laneId: input.laneId,
              modules: [],
              createdBy: MEMORY_EXTRACTOR_PRINCIPAL,
            },
            entityContext: {
              ...(input.worktreeCwd || input.cwd
                ? { workspacePath: input.worktreeCwd ?? input.cwd }
                : {}),
              laneId: input.laneId,
              ...(input.role ? { role: input.role } : {}),
            },
            recent,
            related: input.relatedNotes,
            runTask: ({ brief }) =>
              runLaneTask({
                laneKey: input.vendor,
                taskId: input.taskId,
                brief,
                cwd: input.cwd,
                // Bound the mining call so a hung extractor can never pin the
                // runner. B2: this pass now runs AFTER the terminal write, so it
                // no longer holds the fleet agent — but it is still owned by the
                // runner's own lifecycle (loop.ts awaits it, and the drain aborts
                // it through `signal`), so it can never become an orphan child.
                timeoutMs: 120_000,
                ...(input.signal ? { signal: input.signal } : {}),
                profile: READ_ONLY_LANE_PROFILE,
                onEvent: () => undefined,
              }),
          }).catch(async (error) => {
            miningFailed = true;
            // THE bug this whole path used to hide: mining could fail on every
            // job forever and nothing anywhere said so.
            await degraded("mine", error);
            return [];
          });
          if (!miningFailed) {
            memoryWindows.markMinedContent(sessionKey, contentHash);
          }
        }
      } else {
        input.onLog?.(
          "memory mining skipped: no git-grounded Edit/Write tool calls"
        );
      }
      if (groundedToolCalls.length > 0) {
        memoryWindows.append(sessionKey, {
          role: "agent",
          text: `Observed grounded file changes: ${Array.from(
            new Set(groundedToolCalls.flatMap((call) => call.modules))
          ).join(", ")}`,
        });
      }
    } else {
      // Withdrawing consent also drops what is ALREADY buffered for this
      // session. The window exists for exactly one purpose — being fed to a
      // vendor model — so leaving it warm across an off period is leaving text
      // staged for an errand the operator cancelled.
      memoryWindows.clear(sessionKey);
      input.onLog?.(
        referenceOnly
          ? "memory mining skipped: harness memoryCapture=reference"
          : `memory mining skipped: ${mining.reason}`
      );
      if (mining.authFailure) {
        // Fail-closed AND loud: a refused credential is a standing condition,
        // not a blip, and silence here is how it would persist unnoticed.
        await degraded("mining-auth", mining.reason);
      }
    }

    const candidates = [...deterministicSignals, ...explicitProposals, ...mined];
    if (candidates.length === 0) {
      return;
    }
    // #126: stamp every auto-captured note with the chat partition WITHOUT
    // touching @muon/core — wrap the client sink so each write carries chatId.
    // A no-chat run (plain worker) ingests through the exact-job client directly;
    // the backend derives its `task:<taskId>` partition, never an operator-wide
    // view. ingestCandidates keeps its dedup tally.
    //
    // B2: an explicit sink WINS. The deferred (post-terminal) capture supplies
    // the lease-fenced one, which derives the very same partition server-side
    // from the stored job row.
    const sink: MemoryIngestSink =
      input.sink ??
      (input.chatId
        ? {
            addMemoryNoteWithAction: (candidate) =>
              client.addMemoryNoteWithAction({
                ...candidate,
                chatId: input.chatId,
              }),
          }
        : client);
    const summary = await ingestCandidates(sink, candidates);
    input.onLog?.(
      `captured ${summary.ingested}/${summary.proposed} note(s) to the brain`
    );
    if (summary.ingested < summary.proposed) {
      // ingestCandidates swallows a failed write by design; the tally is the
      // only place the loss is visible, so surface it rather than let it pass.
      await degraded(
        "ingest",
        `${summary.proposed - summary.ingested} of ${summary.proposed} note(s) were not written`
      );
    }
  } catch (error) {
    // Best-effort: never let memory capture affect the job outcome — but say so.
    await degraded("capture", error);
  }
}

/**
 * B2: run ONE deferred capture, called by the runner AFTER `commitTerminal`.
 *
 * By this point the job is terminal, so its fleet agent is released and the chat
 * turn has already returned — the extractor's cost is off the human's critical
 * path. It is still inside the RUNNER's lifecycle, though: loop.ts awaits this
 * before freeing the job's concurrency slot and the drain awaits those slots, so
 * an extractor child can never outlive the process that spawned it.
 *
 * Both clients here are the runner's SHARED agent bearer: it is what the mining
 * posture read requires, it is what may still record the degraded diagnostic
 * event after the job is terminal, and the actual note writes go through the
 * lease-fenced `sink` because the per-job capability is (correctly) already dead.
 */
export async function runPendingCapture(
  client: MuonApiClient,
  pending: PendingMemoryCapture,
  opts: {
    sink: MemoryIngestSink;
    signal?: AbortSignal;
    onLog?: (line: string) => void;
  }
): Promise<void> {
  // The spread is safe here in a way it would not be on a governed surface:
  // `PendingMemoryCapture` is exactly the coordinate subset of this input, it
  // carries no authority field, and the backend re-derives author/task/chat from
  // the stored job row regardless of what any of this says.
  await captureMemories(client, {
    ...pending,
    controlClient: client,
    sink: opts.sink,
    ...(opts.signal ? { signal: opts.signal } : {}),
    onLog: opts.onLog,
  });
}

/**
 * Builds the typed terminal handoff packet (P0.3) for an emitting terminal.
 * Diff evidence is collected ONLY from a governed task worktree
 * (`worktreeCwd` set when `harness.requires.worktree`); anything else is an
 * honest degradation, never a fabricated hash. Emission must never fail or
 * delay a terminal: any throw yields `undefined`, and the absence of a packet
 * is itself visible downstream (handoff_read reports prose_only).
 */
async function buildTerminalPacket(args: {
  laneKey: string;
  taskId: string;
  brief: string;
  result?: { exitCode: number; output: string; errorOutput: string; durationMs: number };
  outcome?: { ok: boolean; summary: string };
  /** Loop worker output; result.output is used for one-shot terminals. */
  workerOutput?: string;
  checks?: HandoffCheck[];
  /** Set ONLY when the harness ran in a governed task worktree. */
  worktreeCwd?: string;
  recommendedNextAction: string;
}): Promise<HandoffPacket | undefined> {
  try {
    const workerOutput = args.result?.output ?? args.workerOutput ?? "";
    const report = parseWorkerFinalReport(workerOutput);
    const memoryProposals =
      report?.memoryProposals ?? parseWorkerMemoryProposals(workerOutput);
    const evidence: WorktreeEvidence | undefined = args.worktreeCwd
      ? await collectWorktreeEvidence(args.worktreeCwd).catch(
          (error): WorktreeEvidence => ({
            diff: {
              unavailableReason: `diff_error:${(error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 150)}`,
            },
          })
        )
      : undefined;
    return buildHandoffPacket({
      laneKey: args.laneKey,
      taskId: args.taskId,
      brief: args.brief,
      result: args.result,
      outcome: args.outcome,
      events: [],
      checks: args.checks,
      diff: evidence?.diff,
      changedFiles: evidence?.changedFiles,
      openQuestions: report?.openQuestions,
      uncertainties: report?.uncertainties,
      memoryProposals,
      // THE PACKET'S OWN COPY of what the worker actually said, kept whether or
      // not the report parsed. Until this, a final report survived in exactly
      // one truncated place — the live stream chunk — and for a loop job the
      // job's `result` held MUON's verdict line instead of the output, so the
      // tail was gone for good. A second durable copy is the difference between
      // "bounded" and "lost".
      ...(workerOutput.trim().length > 0
        ? { finalMessage: workerOutput }
        : {}),
      // NAME THE ABSENCE. An empty `openQuestions` is what a worker that had
      // none produces AND what a worker that never reported produces; without
      // this reason a reader cannot tell "worked, no evidence" from "worked,
      // here is the diff". `parseWorkerFinalReport` demands ten labels in exact
      // order, so a vendor that wraps or reformats its final message loses the
      // whole report — that failure is visible, and `finalMessage` above is the
      // evidence for WHY it failed rather than a bare assertion that it did.
      ...(report === undefined
        ? { degradedReasons: [HANDOFF_DEGRADATION.noWorkerReport] }
        : {}),
      recommendedNextAction:
        report?.nextAction ?? args.recommendedNextAction,
    });
  } catch {
    return undefined;
  }
}

/**
 * Executes ONE claimed dispatch job to completion, streaming to the brain.
 * The fleet agent is claimed/released by the caller (runner loop) so release
 * is guaranteed in a finally even if this throws, leak-safety is structural,
 * not dependent on ordering. Live sessions poll the brain for cross-turn
 * steer/interrupt (the whole point of R1: control outlives the chat turn).
 */
export async function executeJob(
  client: MuonApiClient,
  job: DispatchJobRecord,
  agent: AgentRecord,
  opts: ExecuteOptions
): Promise<ExecuteResult> {
  const cognitionClient = opts.jobClient ?? client;
  const log = opts.onLog ?? (() => undefined);
  const vendor = job.vendor;
  const taskId = job.taskId;
  if (opts.signal?.aborted) {
    return {
      status: "interrupted",
      result: "runner authority was lost before execution began",
    };
  }

  const lanes = await client.listLanes();
  const lane = lanes.find((entry) => entry.key === vendor);
  if (!lane) {
    return { status: "failed", result: `lane '${vendor}' not found in ledger` };
  }

  let harness;
  try {
    harness = job.harnessKey
      ? (await client.getHarness(job.harnessKey)).config
      : emptyHarnessConfig;
  } catch (error) {
    return {
      status: "failed",
      result: `harness '${job.harnessKey}' not found: ${
        error instanceof Error ? error.message : error
      }`,
    };
  }

  const kind = job.kind;
  const useLoop = kind === "loop";
  // "Does this vendor have a session driver", asked of the registry instead of
  // spelled by name here AND a second time in the dispatch route (ADR-0022
  // §1.2(c)). Fail-closed for an id the registry has never heard of.
  const interactive =
    kind === "session" || (kind === "auto" && vendorSupportsInteractive(vendor));

  try {
    assertHarnessRequirements(harness, {
      laneKey: vendor,
      interactiveAvailable: interactive && vendor !== "cursor",
      worktree: harness.requires.worktree,
    });
  } catch (error) {
    return {
      status: "failed",
      result: error instanceof Error ? error.message : "harness rejected",
    };
  }

  const loopChecks = [...harness.checks, ...(job.checks ?? [])];
  if (useLoop && loopChecks.length === 0) {
    return {
      status: "failed",
      result:
        "loop needs a harness with checks (e.g. 'repair' or 'implement'), nothing to repair against",
    };
  }

  const task = await client.getTaskDetail(taskId).catch(() => undefined);
  const requestedCwd =
    job.workspacePath ?? task?.workspacePath ?? process.cwd();
  let cwd = requestedCwd;

  const storedProfile = await client
    .getLaneProfile(lane.id)
    .then((result) => result.profile)
    .catch(() => undefined);
  const rootPolicy =
    job.capabilityMode === "orchestrator"
      ? delegationRootPolicySchema.safeParse(job.delegationManifest)
      : undefined;
  const delegation =
    job.capabilityMode === "delegate"
      ? delegationManifestSchema.safeParse(job.delegationManifest)
      : undefined;
  if (delegation && !delegation.success) {
    // The refusal stands either way — this only tells the operator WHICH of
    // two very different things happened. A manifest is minted at dispatch
    // and re-validated here, so a child queued before a MUON upgrade that
    // added a base-tier tool arrives NARROWER than today's policy and is
    // refused with a message that reads like tampering. That has now happened
    // twice (`peer_wait`, then `whoami`). Distinguishing them costs nothing
    // and stops an upgrade from looking like an attack.
    //
    // Deliberately NOT relaxed to a subset check: `propagatedTools` is an
    // attestation of the policy at mint time, and deciding that a stale
    // narrower manifest may run under today's wider tier is a trust-boundary
    // change that belongs in an ADR, not in a diagnostic fix.
    const staleTools = (
      job.delegationManifest as { propagatedTools?: unknown } | null
    )?.propagatedTools;
    const narrowerOnly =
      Array.isArray(staleTools) &&
      staleTools.every(
        (name) =>
          typeof name === "string" &&
          (MUON_DELEGATE_CAPABILITY_TOOL_NAMES as readonly string[]).includes(
            name
          )
      ) &&
      staleTools.length < MUON_DELEGATE_CAPABILITY_TOOL_NAMES.length;
    return {
      status: "failed",
      result: narrowerOnly
        ? `delegated child capability manifest predates this MUON build (attested ${staleTools.length} tools, current delegate policy is ${MUON_DELEGATE_CAPABILITY_TOOL_NAMES.length}); refusing vendor launch. This is a version skew, not tampering — re-dispatch the child.`
        : "delegated child capability narrowing could not be attested; refusing vendor launch",
    };
  }
  if (rootPolicy && !rootPolicy.success) {
    return {
      status: "failed",
      result:
        "orchestrator root delegation policy could not be attested; refusing vendor launch",
    };
  }
  const capabilityMode =
    job.capabilityMode === "delegate"
      ? "delegate"
      : job.capabilityMode === "orchestrator"
        ? "orchestrator"
        : "worker";
  // ADR-0048: BOTH attestations must agree before a delegate may edit — the
  // manifest (the parent's grant, minted route-side from the harness contract)
  // AND the harness this runner resolved (so a hand-edited manifest cannot
  // grant edit to a read-shaped harness). The worktree requirement is the
  // write boundary: `harness.requires.worktree` is what makes `cwd` an
  // isolated task worktree at launch.
  const delegateEdits =
    capabilityMode === "delegate" &&
    delegation?.success === true &&
    delegation.data.fileAuthority === "edit" &&
    harness.requires.worktree === true;
  if (delegateEdits && useLoop) {
    // ADR-0048: refused, not degraded. A loop runs the harness checks
    // host-side (`npm test` via runShellCheck, unsandboxed), and an edit
    // delegate has just been granted the power to REWRITE what those checks
    // execute — with no approver present to see a single edit. That is
    // arbitrary host execution ungated, the exact hole the implement
    // harness's own docblock refuses to open for silently-preauthorized
    // workers. An edit delegate is ONESHOT: it produces a reviewable diff in
    // its isolated worktree, and verification runs under authority that can
    // gate it (the parent's review, the human's merge gate) — never under
    // the child's own hand.
    return {
      status: "failed",
      result:
        "an edit-authority delegate cannot run a check loop: host-side checks would execute what the child itself wrote, ungated. Dispatch it oneshot; checks belong to the reviewer.",
    };
  }
  const isRootCoordinator =
    capabilityMode === "orchestrator" &&
    Boolean(job.chatId) &&
    !job.parentJobId;
  if (job.chatId && capabilityMode === "worker") {
    return {
      status: "failed",
      result:
        "chat identity is not authority; an explicit orchestrator capability mode is required",
    };
  }
  if (
    rootPolicy?.success &&
    (rootPolicy.data.jobId !== job.id ||
      rootPolicy.data.workspacePath !== job.workspacePath ||
      rootPolicy.data.maxDepth !== job.maxDelegationDepth ||
      rootPolicy.data.maxChildrenPerParent !== job.maxChildren ||
      rootPolicy.data.maxTotalDescendants !== job.maxTotalDescendants ||
      rootPolicy.data.maxIterations !== job.maxDelegationIterations ||
      rootPolicy.data.deadlineAt !== job.delegationDeadline)
  ) {
    return {
      status: "failed",
      result:
        "orchestrator root policy does not match persisted job scope; refusing vendor launch",
    };
  }
  if (
    delegation?.success &&
    (delegation.data.jobId !== job.id ||
      delegation.data.parentJobId !== job.parentJobId ||
      delegation.data.rootJobId !== job.rootJobId ||
      delegation.data.depth !== job.delegationDepth ||
      delegation.data.maxDepth !== job.maxDelegationDepth ||
      delegation.data.maxChildrenPerParent !== job.maxChildren ||
      delegation.data.maxTotalDescendants !== job.maxTotalDescendants ||
      delegation.data.workspacePath !== job.workspacePath ||
      delegation.data.budget.maxWallMs !== job.maxWallMs ||
      delegation.data.budget.maxIterations !==
        (job.kind === "loop" ? job.maxIterations ?? undefined : undefined) ||
      delegation.data.deadlineAt !== job.delegationDeadline ||
      delegation.data.delegationIterationCap !==
        job.maxDelegationIterations)
  ) {
    return {
      status: "failed",
      result:
        "delegation manifest does not match persisted child scope or lineage; refusing vendor launch",
    };
  }
  const governedWorkspace = rootPolicy?.success
    ? {
        rootWorkspace: rootPolicy.data.workspacePath,
        workspacePath: rootPolicy.data.workspacePath,
      }
    : delegation?.success
      ? {
          rootWorkspace: delegation.data.rootWorkspace,
          workspacePath: delegation.data.workspacePath,
        }
      : null;
  if (job.delegationDeadline) {
    const remainingMs =
      new Date(job.delegationDeadline).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return {
        status: "interrupted",
        // Shared pre-launch constant (byte-identical to the old literal): a
        // resume planner classifies this row as provably-unstarted.
        result: PRE_LAUNCH_INTERRUPT_RESULTS[2],
      };
    }
  }
  if (governedWorkspace) {
    const workspaceFailure = attestGovernedWorkspace({
      ...governedWorkspace,
      executionCwd: requestedCwd,
    });
    if (workspaceFailure) {
      return {
        status: "failed",
        result: `${workspaceFailure}; refusing vendor launch`,
      };
    }
  }
  // ── P0.4: workspace policy profile sourcing — WORKER sessions only. A
  // delegate or orchestrator never receives policy or workspacePath, so a
  // policy allow evaluated inside a child can never widen past the parent's
  // exact tool manifest. Degrade-safe by construction: no explicit governed
  // workspace, a fetch error, a missing row, or invalid JSON all yield
  // `undefined` ⇒ no simulation ⇒ every un-preapproved call gates exactly as
  // today. NEVER `defaultPolicyProfile` here — that is a CLI display default.
  const governedWorkspacePath =
    job.workspacePath ?? task?.workspacePath ?? undefined;
  let policyProfile: PolicyProfile | undefined;
  if (
    capabilityMode === "worker" &&
    governedWorkspacePath &&
    // Every transport that carries MUON's approval bridge: interactive
    // sessions, and the loop iterations of every vendor with a session
    // driver, which run through the SAME managed session (neither vendor's
    // one-shot transport carries an approval channel MUON can answer — see
    // the loop branch below).
    (interactive || (useLoop && vendorSupportsInteractive(vendor))) &&
    vendor !== "cursor"
  ) {
    const policyRecord = await Promise.resolve()
      .then(() =>
        client.getWorkspacePolicy({
          workspacePath: governedWorkspacePath,
          taskId,
        })
      )
      .catch(() => undefined);
    const parsedPolicy = policyRecord?.profile
      ? policyProfileSchema.safeParse(policyRecord.profile)
      : undefined;
    policyProfile = parsedPolicy?.success ? parsedPolicy.data : undefined;
  }
  const needsDelegationToken =
    capabilityMode === "orchestrator" ||
    (delegation?.success && delegation.data.canDelegate);
  if (needsDelegationToken && !opts.delegationToken) {
    return {
      status: "failed",
      result:
        "job-bound delegation capability was not issued to this runner; refusing vendor launch",
    };
  }
  // ADR-0038 D3/D8 — the imported servers a HUMAN enabled for THIS lane,
  // re-attested right now. The whole lifecycle (eligibility, attestation,
  // drift reporting, fail-closed failure, merge) lives in
  // `imported-capabilities.ts` rather than inline here: it is a small state
  // machine and this is the central launch orchestrator, and coupling the two
  // made it testable only through a full dispatch.
  const profileSource = await resolveImportedServers({
    attest: (laneKey) =>
      client.attestLaneImports(
        laneKey,
        opts.runnerLease
          ? {
              jobId: job.id,
              host: opts.runnerLease.host,
              leaseToken: opts.runnerLease.leaseToken,
            }
          : undefined
      ),
    record: (event) =>
      client
        .recordEvent({
          laneId: lane.id,
          taskId,
          kind: "task.progress",
          message: event.message,
          // `controlPlane` marks this as MUON's own diagnostic rather than
          // vendor activity, exactly like the other runner-emitted events.
          metadata: { controlPlane: true, ...event.metadata },
        })
        .catch(() => undefined),
    laneKey: lane.key,
    capabilityMode,
    profile:
      capabilityMode === "delegate"
        ? undefined
        : applyHarnessToProfile(storedProfile, harness),
  });
  const preflightNonce = randomBytes(32).toString("hex");
  const baseProfileRaw = withMuonMcpServer(
    profileSource,
    {
      taskId,
      laneKey: capabilityMode === "orchestrator" ? "muon-orchestrator" : vendor,
      jobId: job.id,
      workspacePath: requestedCwd,
      preflightNonce,
      apiBase: opts.apiBase,
      apiToken: opts.apiToken,
    }
  );
  // #126: thread the chat id into the BASE MUON MCP env so EVERY chat-scoped
  // agent (delegate sub-agents that do the actual editing, not only the
  // orchestrator) writes + reads memory under this chat's partition. Without this
  // a delegate's memory_add/search/recall/preedit ran with MUON_CHAT_ID unset →
  // writes landed chatId=NULL and the cross-chat leak silently persisted (#1
  // risk). A plain worker has no chatId (guarded above), so this is a no-op there;
  // the orchestrator/delegate branches below spread `server.env`, keeping it.
  const baseProfile = job.chatId
    ? {
        ...baseProfileRaw,
        mcpServers: baseProfileRaw.mcpServers.map((server) =>
          server.name === MUON_MCP_SERVER_NAME
            ? { ...server, env: { ...server.env, MUON_CHAT_ID: job.chatId! } }
            : server
        ),
      }
    : baseProfileRaw;
  const profile = capabilityMode === "orchestrator"
    ? {
        ...baseProfile,
        // Reset every OTHER authority-bearing field to a bounded default, for the
        // SAME reason we don't spread baseProfile.allowedTools: they come from the
        // raw shared USER worker-lane profile. An operator-set
        // `permissionMode:"bypassPermissions"` (or a rawConfig/extraArgs vendor
        // flag like --dangerously-skip-permissions) would ungate this UNWATCHED
        // coordinator regardless of allowedTools — a wider bypass than the tool
        // leak. The delegate branch resets these; the coordinator must too. The
        // bounded-coordinator invariant covers EVERY authority field, not one.
        permissionMode: "default" as const,
        // Codex ships its own native multi-agent fleet. A MUON coordinator must
        // never spawn those untracked children outside the exact-job lineage,
        // budget, workspace, and token gates. Disable that vendor-native path
        // for this coordinator only; governed fan-out remains available through
        // the exact `mcp__muon__dispatch` capability below.
        rawConfig:
          vendor === "codex" ? { "features.multi_agent": false } : {},
        extraArgs: [],
        mcpServers: baseProfile.mcpServers.map((server) =>
          server.name === MUON_MCP_SERVER_NAME
            ? {
                ...server,
                env: {
                  ...server.env,
                  MUON_MCP_MODE: "orchestrator",
                  MUON_JOB_ID: job.id,
                  MUON_DELEGATION_TOKEN: opts.delegationToken!,
                  MUON_CHAT_ID: job.chatId!,
                  MUON_CHAT_TASK_ID: taskId,
                  MUON_WORKSPACE: job.workspacePath ?? requestedCwd,
                },
              }
            : server
        ),
        // A coordinator is a read/plan/delegate control plane, never a worker.
        // Its exact preauthorization contains only the governed MUON MCP
        // inventory. Native Read/Write/Edit would let it mutate the canonical
        // workspace without worktree isolation or the pre-edit evidence gate.
        //
        // We deliberately do NOT spread `baseProfile.allowedTools`. The
        // orchestrator chat runs on the SHARED vendor lane (CHAT_LANE_KEY) with
        // an always-empty harness, so `baseProfile.allowedTools` IS the raw USER
        // worker-lane profile. Unioning it would silently promote a pre-authorized
        // `["*"]`/`["Bash"]` worker grant into this UNWATCHED coordinator's
        // SDK-preauthorized allowedTools — and an SDK-preauthorized tool never
        // routes to canUseTool → bridgeApproval/fast-deny is never reached, so the
        // human gate is bypassed. A Set only DEDUPES, it can never filter, so the
        // leak was real. The over-capability assertion below refuses launch if
        // any later step re-widens this set.
        allowedTools: [
          ...new Set([
            ...MUON_ORCHESTRATOR_TOOL_NAMES.map(
              (name) => `mcp__${MUON_MCP_SERVER_NAME}__${name}`
            ),
          ]),
        ],
      }
    : capabilityMode === "delegate" && delegation?.success
      ? {
          ...baseProfile,
          permissionMode: "default" as const,
          rawConfig: {},
          extraArgs: [],
          mcpServers: baseProfile.mcpServers
            .filter((server) => server.name === MUON_MCP_SERVER_NAME)
            .map((server) => ({
              ...server,
              env: {
                ...server.env,
                MUON_MCP_MODE: "delegate",
                MUON_DELEGATE_CAN_SPAWN: String(
                  delegation.data.canDelegate
                ),
                MUON_JOB_ID: job.id,
                ...(opts.delegationToken
                  ? { MUON_DELEGATION_TOKEN: opts.delegationToken }
                  : {}),
                MUON_PARENT_JOB_ID: delegation.data.parentJobId,
                MUON_ROOT_JOB_ID: delegation.data.rootJobId,
                MUON_DELEGATION_DEPTH: String(delegation.data.depth),
                MUON_WORKSPACE: delegation.data.workspacePath,
              },
            })),
          allowedTools: [
            ...delegation.data.propagatedTools.map(
              (name) => `mcp__${MUON_MCP_SERVER_NAME}__${name}`
            ),
            // ADR-0048: the ONLY widening a delegate can ever receive, and it
            // is a positive named list, not a mode. The write boundary is the
            // task worktree: these are preauthorized with the child's cwd set
            // to that worktree, and the vendor's own permission model treats
            // paths outside cwd as requiring approval nobody is present to
            // give. Bash is deliberately absent — see the constant's docblock.
            ...(delegateEdits ? MUON_DELEGATE_EDIT_TOOL_NAMES : []),
          ],
        }
      : baseProfile;

  // #126: the memory-slice arms below are chat-scoped, so an agent's brief is
  // seeded with its own chat's memory plus the ONE documented cross-chat
  // escape hatch (promoted-global + human-confirmed). The standing arm (4.1)
  // rides that same escape hatch — it carries only `scope:'global'`
  // human-confirmed canon — so "never another chat's [project] memory" still
  // holds: a chat-bound project note never crosses via any arm here.
  const objectiveQuery = memoryObjectiveQuery(job.brief, capabilityMode);
  // TODO 0.4 (closed 2026-07-31): `harness.memorySlice.topics`/`.modules` were a
  // no-op authority field — a harness author could set `topics: ["auth"]` and
  // the promised narrowing silently never happened; only `.k` was read. They now
  // compile into the ONE bounded filter grammar (R5) and ride BOTH slice arms.
  // The server re-validates the filter, and it is a narrower over an
  // already-authorized set, so this cannot widen any read. Empty spec →
  // undefined → byte-identical to the pre-0.4 calls.
  const sliceFilter = memorySliceFilter(harness.memorySlice);
  const [taskNotes, objectiveNotes, standingNotes] = await Promise.all([
    cognitionClient
      .recallRelatedToTask(taskId, job.chatId ?? undefined, sliceFilter)
      .catch(() => []),
    // Only the exact-job client can request objective memory. This prevents a
    // direct/operator executeJob caller from accidentally querying an all-chat
    // view; production always supplies this capability-bound client.
    opts.jobClient && objectiveQuery
      ? cognitionClient
          .searchMemory(objectiveQuery, {
            ...(job.chatId ? { chatId: job.chatId } : {}),
            ...(sliceFilter ? { filter: sliceFilter } : {}),
          })
          .catch(() => [])
      : Promise.resolve([]),
    // TODO 4.1 — the STANDING arm: the workspace's promoted-global
    // human-confirmed constraint/convention canon, no anchor, no query. Gated
    // on `opts.jobClient` EXACTLY like the objective arm above: only the
    // capability-bound job client may fetch it, so the server derives the
    // workspace from the job capability and the fence is real. A direct/
    // operator `executeJob` (no jobClient) would otherwise send no workspace,
    // get the operator's unscoped view, and inject EVERY repo's canon under a
    // heading that names this one — a false provenance claim. Absence → empty
    // arm, the pre-4.1 brief byte-identical. The `typeof` guard additionally
    // keeps a narrower client that lacks the method on that same path.
    opts.jobClient &&
    typeof cognitionClient.recallStandingMemory === "function"
      ? cognitionClient.recallStandingMemory().catch(() => [])
      : Promise.resolve([]),
  ]);
  // No authorship filter here. `selectMemorySliceNotes` below is VOUCHED-only:
  // a human confirm OR the orchestrator's vouch (P0-2), which is the posture
  // deciding, exactly as this comment always said it must. Mined prose rides
  // that one posture (`autoConfirmAgentMemory`) like every other agent note —
  // F9's per-author pre-filter is gone and must not be reinstated here.
  //
  // The vouch reaches this line only because `memoryNoteSchema` carries
  // `confirmedBy` (api-client.ts): zod strips unknown keys, so dropping it there
  // silently returns this crew to human-confirmed-only memory with no error
  // anywhere.
  // TODO 4.1 + 4.2 cross-arm dedup: a note that rides the STANDING section must
  // not also spend one of the slice's k lines. The standing selection runs
  // first (it is the stricter tier); the slice arms are then filtered by the
  // SAME normalized-content rule `dedupeMemoryNotes` uses, so the two sections
  // can never carry one statement twice however many ids it arrived under.
  const standingSelection = selectStandingNotes(
    standingNotes,
    undefined,
    job.workspacePath
  );
  const standingTexts = new Set(
    standingSelection.selected.map((note) => normalizeNoteText(note.text))
  );
  const notes = dedupeMemoryNotes([...taskNotes, ...objectiveNotes]).filter(
    (note) => !standingTexts.has(normalizeNoteText(note.text))
  );
  const surfaced = selectMemorySliceNotes(notes, harness.memorySlice.k);
  const standingSelectedIds = new Set(
    standingSelection.selected.map((note) => note.id)
  );
  const surfacedIds = new Set(surfaced.map((note) => note.id));
  let includedOrdinal = 0;
  const memoryContextExposures: ContextExposureInput[] = [
    ...standingNotes.map((note) => {
      const eligible =
        note.confirmed &&
        !note.stale &&
        (note.kind === "constraint" || note.kind === "convention") &&
        !(
          job.workspacePath != null &&
          note.workspacePath != null &&
          note.workspacePath !== job.workspacePath
        );
      const included = standingSelectedIds.has(note.id);
      return {
        artifactKind: "memory_note" as const,
        artifactId: note.id,
        eligible,
        included,
        reason: "standing_memory",
        ...(included ? { ordinal: includedOrdinal++ } : {}),
        charCount: note.text.length,
        trustTier: note.confirmed ? ("human_confirmed" as const) : ("trust_floor" as const),
      };
    }),
    ...notes.map((note) => {
      const eligible = note.confirmed || note.confirmedBy === "orchestrator";
      const included = surfacedIds.has(note.id);
      return {
        artifactKind: "memory_note" as const,
        artifactId: note.id,
        eligible,
        included,
        reason: "memory_slice",
        ...(included ? { ordinal: includedOrdinal++ } : {}),
        charCount: note.text.length,
        trustTier: note.confirmed
          ? ("human_confirmed" as const)
          : note.confirmedBy === "orchestrator"
            ? ("crew_vouched" as const)
            : ("trust_floor" as const),
      };
    }),
  ];
  // Order on the wire: worker-discipline preamble → standing canon → memory
  // slice → brief. One choke point for oneshot, session, loop, AND the whole
  // delegate tree. Standing precedes the slice because it is the workspace's
  // canon — the constraints that hold regardless of the task read before the
  // task-relevant notes.
  //
  // Standing notes are deliberately NOT marked used (KG-2 reinforcement):
  // they arrive in every brief by POLICY, not by retrieval, and counting a
  // policy delivery as an access would let 16 canon notes flood the
  // reinforcement signal on every dispatch.
  //
  // Full-Auto: the detached runner is launched with MUON_FULL_AUTO=1 only when the
  // operator's standing consent is active (sandboxedRunnerEnv sets it explicitly);
  // reading it here fuses the FULL-AUTO safety block into every worker preamble.
  // Unset (default) → today's preamble byte-identical.
  // TODO 5.1: role is read here ONLY for the T1 peer-channel preamble block
  // (reviewer|implementer). This parse is intentionally fail-OPEN and
  // narrower than the launch assertion below (`agentRoleSchema.safeParse`,
  // which fails the job closed on unknown roles). An unrecognized or missing
  // role leaves the preamble byte-identical; launch still enforces the full
  // role enum later.
  const preambleRoleRaw = (job as { role?: unknown }).role;
  const preambleRole =
    typeof preambleRoleRaw === "string" &&
    (preambleRoleRaw === "reviewer" || preambleRoleRaw === "implementer")
      ? preambleRoleRaw
      : undefined;
  // Feature #7: attest the tree the worker will build in. Best-effort by
  // construction — a failure to observe the environment must never fail a job,
  // and a consistent environment adds no preamble block at all.
  let environmentDrift: string[] = [];
  try {
    // The REPOSITORY, not the task worktree: the drift that matters (stray
    // installed-layout residue, migration lockfiles) lives in the repo root
    // and is what `prepareWorktreeDependencies` mirrors into a worktree. The
    // worktree cwd is also not resolved yet at preamble-build time.
    const attestRoot = job.workspacePath;
    if (attestRoot) {
      const attestation = await attestRepoEnvironment(attestRoot, {
        exists: async (path: string) =>
          await fs.promises
            .access(path)
            .then(() => true)
            .catch(() => false),
        readPackageManagerField: async () => {
          try {
            const raw = await fs.promises.readFile(
              path.join(attestRoot, "package.json"),
              "utf8"
            );
            const parsed = JSON.parse(raw) as { packageManager?: unknown };
            return typeof parsed.packageManager === "string"
              ? parsed.packageManager
              : undefined;
          } catch {
            return undefined;
          }
        },
      });
      environmentDrift = [...attestation.drift];
    }
  } catch {
    environmentDrift = [];
  }
  // Feature #10. Compared against the mode the agent ACTUALLY runs under —
  // resolved above, not the mode requested — so a job narrowed at dispatch
  // reports the gap that narrowing created. Attested, never gating: the
  // harness's `requires.tools` declares a need, and a need MUON cannot meet is
  // a fact the worker should carry into its report, not a refused dispatch.
  // The gap must be read from the profile the agent will ACTUALLY run under,
  // which is the harness-overlaid profile AFTER role narrowing — a reviewer
  // loses every write-class tool there, `memory_delete` and `memory_clone`
  // among them. The narrowing itself happens much further down (it has to be
  // last), so this recomputes it here for the deny list only, off the same
  // pure function, and throws the result away. Reading `profile` directly
  // would describe a profile no agent ever runs, and an earlier revision of
  // this comment claimed the narrowing was already applied when it was not.
  //
  // The one thing this still cannot see is a `deniedTools` entry added by a
  // vendor-native action patch below; those are merged after the brief is
  // built and none currently carries one.
  const gapRole = ((): AgentRole | undefined => {
    const raw = (job as { role?: unknown }).role;
    if (raw === undefined || raw === null || raw === "") return undefined;
    const parsed = agentRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  })();
  const toolGap = describeToolGap(
    dispatchToolGap({
      requiredTools: harness.requires.tools ?? [],
      capabilityMode,
      profile,
      role: gapRole,
      vendor,
    })
  );
  const fullBrief = withWorkerPreamble(
    // ADR-0026 §9: the slice states WHICH repository's memory it is, read from
    // `job.workspacePath` — the same authenticated column the backend derives the
    // read fence from, so the label and the fence cannot disagree. Deliberately NOT
    // `MUON_WORKSPACE`: this file remaps that to the governed task worktree for
    // every worker under an editing harness (see `capabilityMode === "worker"`
    // below), which would label each dispatch with its own throwaway path.
    withStandingMemory(
      withMemorySlice(job.brief, notes, harness.memorySlice.k, {
        workspacePath: job.workspacePath,
      }),
      standingNotes,
      { scope: { workspacePath: job.workspacePath } }
    ),
    {
      fullAuto: process.env.MUON_FULL_AUTO === "1",
      ...(preambleRole ? { role: preambleRole } : {}),
      ...(environmentDrift.length > 0 ? { environmentDrift } : {}),
      ...(toolGap ? { toolGap } : {}),
    }
  );

  // ADR-0013 #52 v2, a vendor-native action, resolved + guard-ENFORCED at the
  // dispatch route, rides on the job. Apply it here at execution:
  //   • `actionProfilePatch` merges via mergeProfilePatch, which APPENDS
  //     mcpServers so the governed-brain MCP server can never be evicted;
  //   • `actionBriefPrefix` prepends to the brief (one-shot slash-command analog);
  //   • `actionArgvOverride` reshapes the one-shot invocation (subcommand channel).
  // The guards were already enforced route-side (the runner never re-decides
  // whether it's allowed); the adapter still re-sanitizes the final spawn argv.
  // S6: for a DELEGATE child, apply ONLY the {model} key of actionProfilePatch
  // (the route persists nothing else for delegates; this defensive pick keeps
  // the narrowing attestation below byte-identical regardless of the row). A
  // worker/orchestrator applies the full resolved action patch as before.
  const actionPatch =
    capabilityMode === "delegate"
      ? pickModelPatch(job.actionProfilePatch)
      : (job.actionProfilePatch as Partial<LaneProfile> | null | undefined);
  let dispatchProfile = actionPatch
    ? mergeProfilePatch(profile, actionPatch)
    : profile;
  if (delegation?.success) {
    // ADR-0048 + the delegation.ts lesson (2026-08-10): the assertion derives
    // its expectation from the SAME manifest field the grant derives from, so
    // producer and validator cannot drift — an expectation recomposed from a
    // different source is how one tool addition took down every dispatch.
    const expectedTools = [
      ...delegation.data.propagatedTools.map(
        (name) => `mcp__${MUON_MCP_SERVER_NAME}__${name}`
      ),
      ...(delegateEdits ? MUON_DELEGATE_EDIT_TOOL_NAMES : []),
    ];
    const exactTools =
      dispatchProfile.allowedTools.length === expectedTools.length &&
      expectedTools.every((tool) => dispatchProfile.allowedTools.includes(tool));
    const muonServer = dispatchProfile.mcpServers.find(
      (server) => server.name === MUON_MCP_SERVER_NAME
    );
    const exactMode =
      muonServer?.env?.MUON_MCP_MODE === "delegate" &&
      muonServer.env.MUON_JOB_ID === job.id &&
      muonServer.env.MUON_DELEGATE_CAN_SPAWN ===
        String(delegation.data.canDelegate) &&
      (delegation.data.canDelegate
        ? muonServer.env.MUON_DELEGATION_TOKEN === opts.delegationToken
        : muonServer.env.MUON_DELEGATION_TOKEN === undefined);
    const exactServers =
      dispatchProfile.mcpServers.length === 1 &&
      dispatchProfile.mcpServers[0]?.name === MUON_MCP_SERVER_NAME;
    // The control tier is named EXPLICITLY, not derived by subtracting the
    // tiers a delegate is allowed to hold from the orchestrator's superset.
    // The subtraction form (ORCHESTRATOR − CONTEXT − DELEGATE) silently
    // reclassified every NEW tier as "control": when the A2A coordination
    // tier was added to both the orchestrator grant and the delegate
    // capability grant, this guard began refusing EVERY delegate launch,
    // because the tools were legitimately in `propagatedTools` yet counted as
    // control by subtraction. Enumerating the forbidden tier directly means a
    // future tier addition is inert here by default — which is the correct
    // failure direction for a guard whose job is to spot a WIDENING.
    const noControlTools = MUON_CONTROL_TOOL_NAMES.every(
      (name) =>
        !dispatchProfile.allowedTools.includes(
          `mcp__${MUON_MCP_SERVER_NAME}__${name}`
        )
    );
    if (!exactTools || !exactMode || !exactServers || !noControlTools) {
      return {
        status: "failed",
        result:
          "delegated child effective capability set is wider than its manifest; refusing vendor launch",
      };
    }
  }
  // Orchestrator over-capability assertion (mirrors the delegate exactTools guard
  // above): the coordinator runs UNWATCHED on the shared vendor lane, so its
  // effective grant MUST be EXACTLY the bounded set — the orchestrator MCP
  // inventory — and nothing wider. Fail-closed backstop
  // against future drift (an action-patch merge that appends allowedTools, a
  // re-added baseProfile.allowedTools spread) silently re-widening the
  // coordinator past its bound. Any extra tool (Bash, "*", a leaked worker
  // grant) refuses launch instead of reaching the vendor as a pre-authorized,
  // ungated capability.
  if (capabilityMode === "orchestrator") {
    const expectedOrchestratorTools = [
      ...new Set([
        ...MUON_ORCHESTRATOR_TOOL_NAMES.map(
          (name) => `mcp__${MUON_MCP_SERVER_NAME}__${name}`
        ),
      ]),
    ];
    const exactOrchestratorTools =
      dispatchProfile.allowedTools.length ===
        expectedOrchestratorTools.length &&
      expectedOrchestratorTools.every((tool) =>
        dispatchProfile.allowedTools.includes(tool)
      );
    if (!exactOrchestratorTools) {
      return {
        status: "failed",
        result:
          "orchestrator effective capability set is wider than the read/plan/delegate coordinator grant; refusing vendor launch",
      };
    }
    // The tool allowlist is not the only authority axis: a leaked
    // `permissionMode:"bypassPermissions"` (or "acceptEdits") from the shared
    // lane profile would ungate the coordinator regardless of allowedTools.
    // The bounded coordinator runs in "default" (must-ask) mode — anything
    // else refuses launch.
    if (dispatchProfile.permissionMode !== "default") {
      return {
        status: "failed",
        result: `orchestrator permissionMode "${dispatchProfile.permissionMode}" bypasses the coordinator gate; the bounded coordinator must run in "default" — refusing vendor launch`,
      };
    }
    if (
      vendor === "codex" &&
      (dispatchProfile.rawConfig as Record<string, unknown>)[
        "features.multi_agent"
      ] !== false
    ) {
      return {
        status: "failed",
        result:
          "Codex orchestrator native multi-agent execution is not disabled; refusing a coordinator launch that could bypass governed delegation",
      };
    }
  }
  if (harness.requires.worktree) {
    try {
      const repoRoot = await resolveRepoRoot(requestedCwd);
      if (governedWorkspace) {
        const repoFailure = attestGovernedWorkspace({
          ...governedWorkspace,
          executionCwd: repoRoot,
        });
        if (repoFailure) {
          return {
            status: "failed",
            result:
              "governed worktree requires the canonical workspace to be the repository root; refusing filesystem changes",
          };
        }
      }
      const worktree = await ensureTaskWorktree({
        repoRoot,
        taskId,
      });
      cwd = worktree.path;
      // The worker is about to be told "run the checks". Say out loud what it
      // was actually handed, so an operator reading the log can tell a real
      // check failure from a tree that could never have resolved a module.
      // Before this line the runner logged NOTHING about worktrees at all: a
      // tree with no resolvable dependencies looked identical to a healthy one
      // until the worker's own run failed inside it.
      log(
        `task worktree ${worktree.created ? "created" : "reused"} at ${cwd}: ${summarizeWorktreePreparation(
          worktree.preparation
        )}`
      );
      // T5 — repo-declared lifecycle commands are arbitrary execution sourced
      // from the repo and NEVER run unconfirmed. When the plan awaits an
      // operator, file the gate (server-side deduped by gateTag) and continue
      // WITHOUT setup this run: approving records the confirmation, so the
      // NEXT dispatch runs it. Filing failure only logs — a gate hiccup must
      // not fail the dispatch that already refused to run the commands.
      const setupGate = worktree.preparation.setupConfirmationRequired;
      if (setupGate) {
        const bound = setupGate.confirmationBound;
        const commandCount =
          bound.setup.length + bound.teardown.length + bound.run.length;
        const preview = [...bound.setup, ...bound.teardown, ...bound.run]
          .slice(0, 3)
          .map((step) => resolveCheckArgv(step).join(" "))
          .join("; ");
        try {
          await client.requestApproval({
            taskId,
            requestedBy: "runner",
            kind: "command",
            reason:
              `Repo-declared project lifecycle wants ${commandCount} command(s) ` +
              `(e.g. ${preview}${commandCount > 3 ? "; …" : ""}). Approving records ` +
              `confirmation for hash ${setupGate.setupHash.slice(0, 12)}…; the next ` +
              `dispatch runs setup in the task worktree.`,
            gateTag: `project-setup:${setupGate.setupHash}`,
            evidence: {
              action: "project-setup",
              scope: repoRoot,
              riskLevel: "high",
              impactIfApproved:
                "Repo-declared setup/teardown/run commands execute in this task's worktree on future dispatches (with MUON control-plane credentials stripped from their environment).",
              details: {
                repoRoot,
                setupHash: setupGate.setupHash,
              },
            },
          });
          log(
            `project setup awaits operator confirmation (hash ${setupGate.setupHash.slice(0, 12)}…); gate filed, continuing without setup this run`
          );
        } catch (error) {
          log(
            `project-setup gate could not be filed (${error instanceof Error ? error.message : String(error)}); setup stays skipped`
          );
        }
      }
      if (governedWorkspace) {
        const worktreeFailure = attestGovernedWorkspace({
          ...governedWorkspace,
          executionCwd: cwd,
          managedTaskId: taskId,
        });
        if (worktreeFailure) {
          return {
            status: "failed",
            result: `${worktreeFailure}; refusing vendor launch`,
          };
        }
      }
    } catch (error) {
      return {
        status: "failed",
        result: `could not prepare task worktree: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  // ── WHERE THIS JOB ACTUALLY RAN ─────────────────────────────────────────────
  //
  // `cwd` is final here for BOTH shapes: the prepared-and-attested task worktree
  // resolved just above, or the canonical workspace when the harness needs no
  // isolated tree. This is the one moment the runner holds that fact, so it is
  // recorded here rather than left for a review surface to re-derive from the
  // harness — deriving answers what the dispatch was SUPPOSED to do, which is a
  // different claim from where its vendor was launched.
  //
  // Recorded for the non-worktree shape TOO, deliberately. "It ran in the
  // workspace root" is a fact worth stating; leaving it null would be
  // indistinguishable from "MUON does not know", and a reader would have to
  // guess exactly where it should not.
  //
  // Placed after every refusal that precedes tree preparation — a policy,
  // deadline, capability, or worktree-creation failure returns above and records
  // nothing, because no tree was ever established for it. A run that is
  // interrupted between here and the spawn DOES keep its stamp, and that is the
  // honest answer: the tree exists on disk and is exactly where a reviewer
  // should look for whatever it did or did not do.
  //
  // Best-effort: a stamp that cannot be written degrades the human's review view
  // (it falls back to deriving the tree) and must never fail an otherwise-healthy
  // run, so the failure is logged and execution continues.
  if (opts.runnerLease) {
    try {
      await client.recordDispatchExecutionPathForLease({
        jobId: job.id,
        executionPath: cwd,
        host: opts.runnerLease.host,
        leaseToken: opts.runnerLease.leaseToken,
      });
    } catch (error) {
      log(
        `could not record execution path for job ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (capabilityMode === "worker") {
    // GitNexus and review_diff must inspect the exact execution workspace. For
    // editing harnesses this is the governed task worktree, not the canonical
    // checkout that existed when the base profile was first assembled.
    dispatchProfile = {
      ...dispatchProfile,
      mcpServers: dispatchProfile.mcpServers.map((server) =>
        server.name === MUON_MCP_SERVER_NAME
          ? { ...server, env: { ...server.env, MUON_WORKSPACE: cwd } }
          : server
      ),
    };
  }
  // ── ROLE NARROWING + LAUNCH ASSERTION (VISION §2). A role is enforced, not
  // decorative, and it is enforced HERE — on the FINAL composed profile, after
  // the harness overlay, the capability-mode branch, the action patch, and the
  // worker workspace remap. Applying it any earlier would leave the last
  // `{...spread}` holding the authority, which is exactly how every previous
  // bounded surface in MUON was defeated. Nothing mutates `dispatchProfile`
  // between this point and the three spawn sites below.
  //
  // Additive and backwards compatible by construction: the dispatch row's
  // `role` column is nullable and read defensively, so a job WITHOUT a role is
  // neither narrowed nor asserted and behaves byte-identically to today. A role
  // this runner does NOT recognize is a different situation — version skew
  // between a newer brain and an older runner binary — and it fails closed:
  // silently ignoring it would run an agent the operator believes is bounded.
  const rawJobRole = (job as { role?: unknown }).role;
  const jobRole =
    rawJobRole === undefined || rawJobRole === null || rawJobRole === ""
      ? undefined
      : agentRoleSchema.safeParse(rawJobRole);
  if (jobRole && !jobRole.success) {
    return {
      status: "failed",
      result:
        "dispatch job declares a role this runner does not recognize; it cannot be bounded here — refusing vendor launch",
    };
  }
  // Hoisted so the spawn call below can forward it to the adapter. The lane's
  // own role assertion (e.g. Cursor refusing a write role) is defence in depth
  // behind the route check and the narrowing below — but it only works if the
  // adapter is actually told which role it is running as.
  const effectiveRole = jobRole?.success ? jobRole.data : undefined;
  if (jobRole?.success) {
    const role = jobRole.data;
    try {
      const narrowed = narrowProfileForRole(dispatchProfile, role);
      // A role may only REMOVE authority. `narrowProfileForRole` fills an UNSET
      // permission mode / sandbox with the role's ceiling — a tightening for a
      // read-only role (this is how `reviewer` reaches the vendor sandboxed),
      // but a GRANT for a write-authority role whose lane left the field unset
      // at the vendor default. Keep unset fields unset there, so naming an
      // agent `implementer` can never hand it accept-edits its lane profile
      // never had.
      dispatchProfile =
        ROLE_SPECS[role].authority === "read-only"
          ? narrowed
          : {
              ...narrowed,
              permissionMode: dispatchProfile.permissionMode
                ? narrowed.permissionMode
                : undefined,
              sandbox: dispatchProfile.sandbox ? narrowed.sandbox : undefined,
            };
      // Fail-closed launch assertion, same shape as the bounded-coordinator
      // grant above: if anything left this profile wider than the role it
      // claims to run as, refuse rather than run a "reviewer" that can write.
      assertProfileMatchesRole(dispatchProfile, role);
    } catch (error) {
      return {
        status: "failed",
        result:
          error instanceof RoleAuthorityError
            ? `${error.message}; refusing vendor launch`
            : `role '${role}' authority could not be attested; refusing vendor launch`,
      };
    }
    // `actionArgvOverride` reaches the vendor argv WITHOUT passing through the
    // lane profile, so narrowing the profile alone leaves the role bounded on
    // every surface but this one — the exact shape of every earlier defeat.
    // Judge it with the SAME authority vocabulary by presenting it as
    // `extraArgs`, so the two surfaces can never drift apart. A widening action
    // and a read-only role are contradictory instructions: refuse, rather than
    // silently rewrite what the operator asked the vendor to run.
    if (job.actionArgvOverride) {
      try {
        assertProfileMatchesRole(
          { ...dispatchProfile, extraArgs: job.actionArgvOverride.args },
          role
        );
      } catch {
        return {
          status: "failed",
          result: `vendor action argv exceeds the authority of role '${role}'; refusing vendor launch`,
        };
      }
    }
  }
  // Packet diff evidence only comes from a governed task worktree; a primary
  // checkout yields an honest `no_diff_evidence` degradation instead.
  const worktreeCwd = harness.requires.worktree ? cwd : undefined;
  // TODO 4.14: give file-native vendors the SAME strict human gate without
  // asking them to remember to call MCP. Only the exact-job client may fetch the
  // projection, and the backend derives its workspace from that capability. A
  // failure adds no prompt claim and execution retains the existing MCP path.
  let memoryDirectory:
    | { relativePath: string; truncated: boolean }
    | undefined;
  if (
    capabilityMode !== "orchestrator" &&
    opts.jobClient &&
    supportsMemoryDirectory(cognitionClient)
  ) {
    try {
      const snapshot = await cognitionClient.getMemoryDirectorySnapshot();
      memoryDirectory = {
        relativePath: await materializeMemoryDirectory({
          cwd,
          jobId: job.id,
          snapshot,
        }),
        truncated: snapshot.truncated,
      };
      log(
        `governed memory directory ready at ${memoryDirectory.relativePath} (${snapshot.noteCount} human-confirmed note${snapshot.noteCount === 1 ? "" : "s"})`
      );
    } catch (error) {
      log(
        `governed memory directory unavailable: ${redactedTail(
          error instanceof Error ? error.message : String(error),
          200
        )}`
      );
    }
  }
  const baseDispatchBrief = job.actionBriefPrefix
    ? `${job.actionBriefPrefix}\n\n${fullBrief}`
    : fullBrief;
  const dispatchBrief = memoryDirectory
    ? withMemoryDirectoryHint(
        baseDispatchBrief,
        memoryDirectory.relativePath,
        memoryDirectory.truncated
      )
    : baseDispatchBrief;
  const contextEvidence: ContextEvidenceRecorder | undefined =
    opts.runnerLease && supportsContextEvidence(client)
      ? createContextEvidenceRecorder({
          client,
          jobId: job.id,
          lease: opts.runnerLease,
        })
      : undefined;
  let contextWriteChain: Promise<void> = Promise.resolve();
  const actionArgvOverride = job.actionArgvOverride ?? undefined;
  // Explicit reinforcement producer (ADR-0009 §2.4 / KG-2): ONLY the notes that
  // actually made it INTO the injected memory slice count as "used" (retrieval
  // alone never reinforces; notes fetched-but-dropped are excluded). Fire-and-
  // forget through the write-actor-buffered signal, a ranking hint must never
  // fail or slow the job.
  if (surfaced.length > 0) {
    void cognitionClient
      .markMemoryUsed(
        surfaced.map((note) => note.id),
        "brief_injection"
      )
      .catch(() => undefined);
  }

  const executionController = new AbortController();
  let wallClockElapsed = false;
  /**
   * When the vendor actually started, so the budget report can state what was
   * SPENT rather than assume the budget was spent exactly. Set at the deadline
   * arming below (the last point before launch).
   */
  let executionStartedAt = 0;
  const onAuthorityAbort = () => executionController.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAuthorityAbort, { once: true });
  if (opts.signal?.aborted) {
    onAuthorityAbort();
  }
  let effectiveMaxWallMs =
    job.maxWallMs ?? harness.budget.maxWallMs ?? 1_800_000;
  if (job.delegationDeadline) {
    const remainingMs =
      new Date(job.delegationDeadline).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      opts.signal?.removeEventListener("abort", onAuthorityAbort);
      return {
        status: "interrupted",
        // Shared pre-launch constant (byte-identical to the old literal).
        result: PRE_LAUNCH_INTERRUPT_RESULTS[2],
      };
    }
    effectiveMaxWallMs = Math.min(effectiveMaxWallMs, remainingMs);
  }
  executionStartedAt = Date.now();
  const deadlineTimer = setTimeout(() => {
    wallClockElapsed = true;
    executionController.abort(new Error("execution wall-clock budget elapsed"));
  }, effectiveMaxWallMs);
  const executionSignal = executionController.signal;

  if (executionSignal.aborted) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    opts.signal?.removeEventListener("abort", onAuthorityAbort);
    return {
      status: "interrupted",
      // Shared pre-launch constant (byte-identical to the old literal): the
      // vendor process was provably never launched. NOTE: worktree creation
      // may already have happened above — "provably unstarted" claims only
      // "no vendor process", which is the honest claim.
      result: PRE_LAUNCH_INTERRUPT_RESULTS[1],
    };
  }

  // ── LIVE TERMINAL (read-only). One session per job, created here and joined
  // by every later caller, so there is no path that could produce a second one.
  // The session publishes NOTHING until the vendor actually writes a console
  // byte, which is what makes `ptySessionId` mean "there is a real process
  // console behind this" rather than "a pane exists". A lane that runs through
  // an in-process SDK (claude-code) or a protocol channel (codex app-server)
  // therefore leaves it null and the viewer honestly falls back to the recorded
  // stream — a blank pane labelled "live" would be the lie this avoids.
  const jobTerminalSink: JobTerminalSink | undefined =
    opts.jobTerminalSink ??
    (opts.runnerLease
      ? (input) =>
          client.publishJobTerminalForLease({
            ...input,
            host: opts.runnerLease!.host,
            leaseToken: opts.runnerLease!.leaseToken,
          })
      : undefined);
  const jobTerminal: JobTerminalSession | undefined = jobTerminalSink
    ? new JobTerminalHost({ publish: jobTerminalSink, onLog: log }).openOrAttach(
        job.id
      )
    : undefined;
  const onVendorBytes = jobTerminal
    ? (frame: { stream: "stdout" | "stderr"; data: string }) =>
        jobTerminal.write(frame.stream, frame.data)
    : undefined;

  // BACKLINK: the vendor's OWN session id for this run (codex app-server
  // thread/rollout, codex exec banner, Claude SDK stream), stamped onto the
  // job through the same lease fence as every other mid-flight write.
  // Fire-and-forget and at-most-once PER ID — a resume handle is a
  // convenience, never something a job may fail over. LAST SESSION WINS: a
  // loop's later iteration opens a NEW vendor session, and the transcript the
  // human's resume button should reopen is the final one, so a different valid
  // id re-stamps (the brain accepts the overwrite under the same lease fence)
  // while a re-report of the same id — the poll loop re-asserts every tick —
  // stays a no-op.
  let stampedVendorSessionId: string | null = null;
  let vendorSessionAttempts = 0;
  /** The id the attempt counter currently guards; a NEW id re-arms it. */
  let vendorSessionAttemptId: string | null = null;
  /** The id whose POST is in flight, so a re-report cannot duplicate it. */
  let vendorSessionInFlight: string | null = null;
  const stampVendorSession = (vendorSessionId: string): void => {
    if (!opts.runnerLease) return;
    if (stampedVendorSessionId === vendorSessionId) return;
    if (vendorSessionInFlight === vendorSessionId) return;
    // The brain's backlink route validates this exact shape. Posting anything
    // else is a guaranteed 400 — and it used to consume the one-shot latch, so
    // a single malformed id cost the job its resume handle permanently.
    if (!isVendorSessionId(vendorSessionId)) return;
    // Bounded PER ID: a transient brain outage must not lose the handle, and a
    // permanently failing brain must not be re-POSTed once per poll tick for
    // the life of a long job. A new id re-arms the bound deliberately — one
    // arrives at most once per vendor session, so the loop's own iteration
    // budget bounds the total.
    if (vendorSessionAttemptId !== vendorSessionId) {
      vendorSessionAttemptId = vendorSessionId;
      vendorSessionAttempts = 0;
    }
    if (vendorSessionAttempts >= MAX_VENDOR_SESSION_STAMP_ATTEMPTS) return;
    vendorSessionAttempts += 1;
    vendorSessionInFlight = vendorSessionId;
    try {
      // The try covers a client (test double, version-skewed lib) without the
      // method: a resume handle must never take down the poll loop it rides.
      void client
        .recordJobVendorSessionForLease({
          jobId: job.id,
          vendorSessionId,
          host: opts.runnerLease.host,
          leaseToken: opts.runnerLease.leaseToken,
        })
        // Latched only on SUCCESS, so a failed attempt is retried by the next
        // report rather than silently swallowed as though it had landed.
        .then(() => {
          stampedVendorSessionId = vendorSessionId;
        })
        .catch(() => undefined)
        .finally(() => {
          vendorSessionInFlight = null;
        });
    } catch {
      vendorSessionInFlight = null;
    }
  };

  const streams = createStreamRecorder({
    sink: client,
    agentId: agent.id,
    // Fleet agent slots are reusable. Persist the dispatch id as the stream's
    // run coordinate so desktop panes never read a predecessor/successor job's
    // output merely because both used the same agent id.
    runId: job.id,
  });
  const memoryToolEvidence = createMemoryToolEvidenceCollector();

  // The vendor's own stderr, kept as a BOUNDED rolling tail. A silent launch is
  // silent on stdout only: vendor warnings and provider rejections land here
  // first, and they are the only vendor-side evidence a watchdog report can
  // honestly carry. Never accumulated in full — a hostile or huge stderr must
  // not balloon runner memory or a log line.
  let vendorStderrAttached = false;
  let vendorStderrTail = "";
  /**
   * Set once the vendor itself says it is reading its prompt from stdin. Fed
   * from BOTH streams on purpose: codex 0.145 prints
   * `Reading additional input from stdin...` on stdout, and a line on stdout is
   * also enough to disarm the startup watchdog — so the founder's hang was
   * reported five minutes later as a generic post-output stall with quota and
   * auth as its suggested causes, none of which it was.
   */
  let stdinWaitCause: string | undefined;
  const observeForStdinWait = (text: string): void => {
    stdinWaitCause ??= stdinBriefDeliveryStall(text);
  };
  const observeVendorStderr = (chunk: string): void => {
    if (chunk.length === 0) return;
    observeForStdinWait(chunk);
    // Bound the incoming chunk BEFORE concatenating, so a single megabyte write
    // is never materialized into the retained tail.
    const bounded =
      chunk.length > VENDOR_STDERR_TAIL_CHARS
        ? chunk.slice(-VENDOR_STDERR_TAIL_CHARS)
        : chunk;
    vendorStderrTail = `${vendorStderrTail}${bounded}`.slice(
      -VENDOR_STDERR_TAIL_CHARS
    );
  };
  // Redacted through @muon/core's single redaction control: stderr routinely
  // carries credentials and this string reaches the runner log and the brain.
  const vendorStderrEvidence = (): VendorStderrEvidence => ({
    attached: vendorStderrAttached,
    tail:
      vendorStderrTail.length > 0
        ? redactedTail(vendorStderrTail, VENDOR_STDERR_TAIL_CHARS)
        : "",
    ...(stdinWaitCause ? { stdinWaitCause } : {}),
  });

  // Liveness watchdog (Wave 0): a vendor that launches but emits no output must
  // fail FAST with a diagnosable reason, not sit silent until the full wall-clock
  // budget elapses. Armed here (just before launch); cleared on first output.
  // The coordinator gets the longer windows: it is doing strictly more before
  // its first token and its quiet periods are graph queries, not a stalled
  // child process. An explicit option still overrides both, unchanged.
  const { startupStallMs, postOutputStallMs } = resolveStallWindows({
    capabilityMode,
    ...(opts.startupTimeoutMs !== undefined
      ? { startupTimeoutMs: opts.startupTimeoutMs }
      : {}),
    ...(opts.postOutputTimeoutMs !== undefined
      ? { postOutputTimeoutMs: opts.postOutputTimeoutMs }
      : {}),
  });
  let startupStalled = false;
  let postOutputStalled = false;
  let sawFirstOutput = false;
  let pendingApprovalCount = 0;

  /**
   * Did THIS job's own wall budget end the run?
   *
   * A run has exactly one true stop reason, and the record used to collapse
   * three of them into `interrupted`. A human/ancestor interrupt
   * (`interruptRequested`, or the runner's own `opts.signal` being aborted) and
   * either watchdog stall are all attributable to something OTHER than the
   * budget, and each already writes its own honest report — so what is left,
   * and only what is left, is budget exhaustion. Evaluated at the terminal
   * branches, after every one of those flags has settled.
   */
  const budgetExhausted = (humanInterrupted = false): boolean =>
    wallClockElapsed &&
    !humanInterrupted &&
    !startupStalled &&
    !postOutputStalled &&
    opts.signal?.aborted !== true;

  /** The terminal result for a budget kill, carrying the ACTUAL spend. */
  const budgetResult = (): string =>
    budgetExhaustedResult({
      vendor,
      budgetMs: effectiveMaxWallMs,
      elapsedMs: Date.now() - executionStartedAt,
    });
  let startupTimer: ReturnType<typeof setTimeout> | null =
    startupStallMs > 0 && startupStallMs < effectiveMaxWallMs
      ? setTimeout(() => {
          // Review F2: if an UNRELATED abort already fired (runner authority
          // lost, operator interrupt) with zero prior vendor output, do NOT
          // reclassify it as a startup stall — the result sites check
          // `startupStalled` first, so firing here would misreport the real
          // cause as "no output within Xs".
          if (sawFirstOutput || executionSignal.aborted) return;
          startupStalled = true;
          executionController.abort(
            new Error(
              startupStallReason(vendor, startupStallMs, vendorStderrEvidence())
            )
          );
        }, startupStallMs)
      : null;
  let postOutputTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPostOutputTimer = () => {
    if (postOutputTimer) {
      clearTimeout(postOutputTimer);
      postOutputTimer = null;
    }
  };
  const armPostOutputTimer = () => {
    clearPostOutputTimer();
    if (
      !sawFirstOutput ||
      pendingApprovalCount > 0 ||
      postOutputStallMs <= 0 ||
      postOutputStallMs >= effectiveMaxWallMs ||
      executionSignal.aborted
    ) {
      return;
    }
    postOutputTimer = setTimeout(() => {
      if (pendingApprovalCount > 0 || executionSignal.aborted) return;
      postOutputStalled = true;
      executionController.abort(
        new Error(
          postOutputStallReason(
            vendor,
            postOutputStallMs,
            vendorStderrEvidence()
          )
        )
      );
    }, postOutputStallMs);
    postOutputTimer.unref?.();
  };
  const markProgress = (event: LaneEvent) => {
    // Before the disarm below: a child announcing it is reading stdin counts as
    // output, so this is the last point at which that line is still visible to
    // the watchdog that will fire minutes later.
    if (event.kind === "task.progress") {
      observeForStdinWait(event.message);
    }
    const reportedPendingApprovals =
      event.metadata.approvalPendingCount;
    if (event.kind === "approval.requested") {
      pendingApprovalCount += 1;
      clearPostOutputTimer();
    } else if (
      typeof reportedPendingApprovals === "number" &&
      Number.isSafeInteger(reportedPendingApprovals) &&
      reportedPendingApprovals >= 0 &&
      reportedPendingApprovals <= pendingApprovalCount
    ) {
      pendingApprovalCount = reportedPendingApprovals;
    } else if (event.metadata.approvalResolved === true) {
      pendingApprovalCount = 0;
    } else if (event.kind === "approval.auto") {
      pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
    }
    if (!isVendorStartupProgress(event)) return;
    if (!sawFirstOutput) {
      sawFirstOutput = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
    }
    const isNonterminalToolFailure =
      event.kind === "task.blocked" &&
      (event.metadata.toolActivity !== undefined ||
        event.metadata.codexActivity !== undefined);
    if (
      (event.kind === "task.blocked" && !isNonterminalToolFailure) ||
      event.kind === "task.completed"
    ) {
      clearPostOutputTimer();
    } else if (pendingApprovalCount === 0) {
      armPostOutputTimer();
    }
  };
  const handleStreamEvent = (event: LaneEvent, projected: LaneEvent = event) => {
    memoryToolEvidence.observe(event);
    markProgress(event);
    if (event.metadata.profileUnsupported !== undefined) {
      // A capability the operator ASKED FOR and this lane cannot honor is a
      // governance fact, not a compatibility footnote — a runner-log line is
      // invisible to the person who set the policy. It reaches the stream now
      // because the adapter marks it `controlPlane`, so it renders as MUON's
      // own statement rather than as the agent's words (which is what made it
      // read like a fatal task error before, and why it was dropped here).
      log(event.message);
    }
    const reportedCompaction = event.metadata.contextCondensation;
    if (
      contextEvidence &&
      typeof reportedCompaction === "object" &&
      reportedCompaction !== null &&
      (reportedCompaction as { origin?: unknown }).origin ===
        "vendor_reported" &&
      typeof (reportedCompaction as { sourceResponseId?: unknown })
        .sourceResponseId === "string"
    ) {
      const sourceResponseId = (
        reportedCompaction as { sourceResponseId: string }
      ).sourceResponseId;
      const inputFrameId = contextEvidence.latestDeliveredFrameId();
      contextWriteChain = contextWriteChain.then(async () => {
        try {
          await contextEvidence.vendorCompacted({
            sourceResponseId,
            ...(inputFrameId ? { inputFrameId } : {}),
          });
        } catch (error) {
          log(
            `could not record vendor compaction ${sourceResponseId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      });
    }
    // SPEND HAS TO REACH THE LEDGER, not just the transcript.
    //
    // `streams.handle` writes StreamChunks. The cost cap (ADR-0036) reads
    // EVENT rows. A vendor's usage — the only place real dollars are reported
    // — was emitted by the adapters on this path and therefore never became an
    // Event, so `laneCostsFromUsageEvents` saw nothing, every lane read
    // `reported: false`, the verdict was permanently `unenforceable`, and
    // `capRefusesDispatch` never refused anything. The cap was decorative in
    // production while every one of its unit tests passed, because those tests
    // build Event rows directly.
    //
    // Best-effort, like every other audit write here: a ledger gap must not
    // fail the run. But it must be ATTEMPTED, which it never was.
    const reportedUsage = projected.metadata.usage;
    if (reportedUsage !== null && typeof reportedUsage === "object") {
      void client
        .recordEvent({
          laneId: lane.id,
          taskId,
          kind: "task.progress",
          message: "vendor usage reported",
          metadata: { jobId: job.id, usage: reportedUsage },
        })
        .catch(() => undefined);
    }
    streams.handle(projected);
  };
  const verifySuccessfulEdit = async () => {
    if (!EDIT_PREFLIGHT_HARNESSES.has(job.harnessKey ?? "")) {
      return {
        ok: true,
        changedFiles: [],
        coveredFiles: [],
        uncoveredFiles: [],
      };
    }
    try {
      const coverage = await verifyEditPreflightCoverage({
        client,
        taskId,
        jobId: job.id,
        nonce: preflightNonce,
        worktreeCwd,
      });
      if (!coverage.ok) {
        await client
          .recordEvent({
            laneId: lane.id,
            taskId,
            kind: "task.blocked",
            message:
              "edit completion blocked: verified preflight coverage is incomplete",
            metadata: {
              jobId: job.id,
              preflightGate: "failed",
              uncoveredFiles: coverage.uncoveredFiles,
            },
          })
          .catch(() => undefined);
      }
      return coverage;
    } catch (error) {
      const reason = `Edit preflight completion evidence is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await client
        .recordEvent({
          laneId: lane.id,
          taskId,
          kind: "task.blocked",
          message:
            "edit completion blocked: preflight evidence could not be verified",
          metadata: { jobId: job.id, preflightGate: "unavailable" },
        })
        .catch(() => undefined);
      return {
        ok: false,
        changedFiles: [],
        coveredFiles: [],
        uncoveredFiles: [],
        reason,
      };
    }
  };

  // The rendered command line of each configured check (harness.checks ∪
  // job.checks): the ONLY Bash the seam may classify as `test`
  // (byte-equality). A rendering mismatch is safe — it just gates as today.
  // CODE-C: hoisted to a TOP-LEVEL `checkCommands` so test-class receipts
  // redeem even with NO policy profile (the default config); it is NOT gated
  // on `policyProfile`, so the P0.4 fatigue fix is no longer inert by default.
  // Shared by the interactive branch AND the codex loop branch, which runs its
  // iterations through the same managed-session gate.
  const renderedChecks = loopChecks.map((check) =>
    check.args && check.args.length > 0
      ? `${check.command} ${check.args.join(" ")}`
      : check.command
  );

  try {
    if (interactive && vendor !== "cursor") {
      const dispatchFrame = contextEvidence
        ? await contextEvidence.begin({
            source: "dispatch",
            content: dispatchBrief,
            exposures: memoryContextExposures,
          })
        : undefined;
      let managed;
      try {
        managed = await startManagedSession(makeSessionLedger(client), {
          laneKey: vendor,
          laneId: lane.id,
          taskId,
          jobId: job.id,
          brief: dispatchBrief,
          cwd,
          profile: dispatchProfile,
          resumeVendorSessionId: job.resumeVendorSessionId ?? undefined,
          approvalTimeoutMs: job.approvalTimeoutMs ?? undefined,
        // Defense-in-depth (capabilityMode==='orchestrator' ONLY): the
        // coordinator holds only the AGENT delegation token, its approvals land
        // in an inbox NO operator watches, and PATCH /approvals needs operator
        // tier — so an UNGRANTED coordinator tool call could only 300s-hang then
        // fail closed. Flag the session so bridgeApproval denies such a call FAST
        // with an actionable message instead of blocking on waitForApproval. A
        // WORKER/delegate never sets this, so its human-in-the-loop gate keeps
        // its full 300s semantics untouched.
        noInteractiveApprover: capabilityMode === "orchestrator",
        // …and the ONE fact that can make that premise false: Full Auto. With a
        // live standing-approver lease an operator-tier decider really is
        // watching the coordinator's inbox, so the call gates normally (file →
        // wait → decided → recorded) instead of denying. Supplied ONLY for the
        // coordinator, so a worker's path stays byte-identical, and re-read per
        // gated call so toggling Full Auto off revokes it on the next one.
        resolveStandingApprover:
          capabilityMode === "orchestrator"
            ? () => resolveStandingApprover(client)
            : undefined,
        // P0.4: workers only — a delegate/orchestrator gets neither, so
        // receipts and policy can never authorize descendant escalation.
        workspacePath:
          capabilityMode === "worker" ? governedWorkspacePath : undefined,
        checkCommands: renderedChecks,
        policy: policyProfile
          ? {
              profile: policyProfile,
              executionCwd: cwd,
              checkCommands: renderedChecks,
            }
          : undefined,
        signal: executionSignal,
        // The interactive path's vendor stderr — this is the branch the founder's
        // Mission Chat turn actually takes (kind auto|session ⇒ startManagedSession
        // ⇒ CodexSessionDriver), so without it the spend-cap rejection codex spent
        // ~5 minutes producing was never surfaced. `onVendorStderrAttached` fires
        // only for a driver that really feeds this sink, so a driver without one
        // keeps saying "MUON captured no stderr" rather than claiming a silence
        // it never listened for.
        onDiagnostic: observeVendorStderr,
        onVendorStderrAttached: () => {
          vendorStderrAttached = true;
        },
          onEvent: (event) => {
            handleStreamEvent(
              event,
              isRootCoordinator
                ? {
                    ...event,
                    taskId: job.chatId!,
                    laneId: "muon-chat",
                  }
                : event
            );
          },
        });
      } catch (error) {
        if (dispatchFrame) {
          await contextEvidence?.failed(dispatchFrame, error).catch(() => undefined);
        }
        throw error;
      }
      if (dispatchFrame) {
        await contextEvidence
          ?.delivered(dispatchFrame, {
            sessionId: managed.sessionId,
            ...(managed.handle.vendorSessionId
              ? { vendorSessionId: managed.handle.vendorSessionId }
              : {}),
          })
          .catch((error) => {
            log(
              `could not complete context frame ${dispatchFrame.id}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
      }

      // Poll the brain for steer/interrupt while the session runs. This is
      // what makes cross-turn control possible: the chat turn that dispatched
      // is long gone, but the human can still steer via the persisted queue.
      let running = true;
      let interrupted = false;
      let executionInterrupted = false;
      const pollMs = opts.steerPollMs ?? 1000;
      const onExecutionAbort = () => {
        executionInterrupted = true;
        void managed.handle.interrupt().catch(() => undefined);
        log(
          startupStalled
            ? startupStallReason(vendor, startupStallMs, vendorStderrEvidence())
            : postOutputStalled
              ? postOutputStallReason(
                  vendor,
                  postOutputStallMs,
                  vendorStderrEvidence()
                )
            : wallClockElapsed
              ? "wall-clock budget elapsed, stopping session"
              : "runner authority lost, stopping session"
        );
      };
      executionSignal.addEventListener("abort", onExecutionAbort, {
        once: true,
      });
      if (executionSignal.aborted) {
        onExecutionAbort();
      }
      await client
        .updateAgent({ agentId: agent.id, sessionId: managed.sessionId })
        .catch(() => undefined);
      // Only DRAIN steer for a session that can actually accept sends. A
      // canSend:false driver (e.g. the Claude SDK, whose send() throws) would
      // otherwise drain → send() throws → requeue → re-drain every poll: a busy
      // loop ~1×/s that never delivers and misreports the cause as "session
      // ended between drain and send". The steer ENTRY points reject a
      // canSend:false vendor up front; gating the drain here is the runner-side
      // backstop. Interrupt polling below runs for ALL vendors (canInterrupt).
      //
      // FAIL-CLOSED (ADR-0022 §1.2(e), G8). This used to read
      // `!(sessionCaps && sessionCaps.canSend === false)` against the ADAPTER's
      // descriptor table, so a lane with no descriptor drained as if it could
      // send. Absence of a capability now reads as "no capability".
      const canSendSteer = sessionCapability(vendor).canSend;
      const pollLoop = (async () => {
        while (running && !executionSignal.aborted) {
          await delay(pollMs);
          if (!running || executionSignal.aborted) break;
          // Resume/backlink handle at first knowledge (idempotent stamp): a
          // mid-run kill must not lose the id the human resumes with.
          if (managed.handle.vendorSessionId) {
            stampVendorSession(managed.handle.vendorSessionId);
          }
          try {
            const messages =
              canSendSteer && opts.runnerLease
                ? await client.drainDispatchSteer(job.id, opts.runnerLease)
                : [];
            for (const message of messages) {
              let steerFrame;
              try {
                steerFrame = contextEvidence
                  ? await contextEvidence.begin({
                      source: "steer",
                      content: message,
                    })
                  : undefined;
                await managed.handle.send(message);
                if (steerFrame) {
                  await contextEvidence
                    ?.delivered(steerFrame, {
                      sessionId: managed.sessionId,
                      ...(managed.handle.vendorSessionId
                        ? { vendorSessionId: managed.handle.vendorSessionId }
                        : {}),
                    })
                    .catch((error) => {
                      log(
                        `could not complete steer context frame ${steerFrame!.id}: ${
                          error instanceof Error ? error.message : String(error)
                        }`
                      );
                    });
                }
                log(`steer → ${message.slice(0, 80)}`);
              } catch (error) {
                if (steerFrame) {
                  await contextEvidence
                    ?.failed(steerFrame, error)
                    .catch(() => undefined);
                }
                // A genuine race: the session ended between drain and send (only
                // reachable for a canSend session now). The message was already
                // deleted server-side; restore it through the exact lease-holder
                // path so a re-dispatch/resume can still consume it.
                await client
                  .requeueDispatchSteer(job.id, message, opts.runnerLease!)
                  .catch(() => undefined);
              }
            }
            const fresh = await client.getDispatchJob(job.id).catch(() => null);
            if (fresh?.interruptRequested) {
              interrupted = true;
              await managed.handle.interrupt().catch(() => undefined);
              log("interrupt requested, stopping session");
            }
          } catch {
            // A polling hiccup must never crash the run.
          }
        }
      })();

      // A finally guarantees the poll loop is stopped even if wait() rejects,
      // otherwise it would poll the brain forever after the job has failed.
      let result;
      try {
        result = await managed.handle.wait();
      } finally {
        running = false;
        executionSignal.removeEventListener("abort", onExecutionAbort);
        await pollLoop.catch(() => undefined);
      }
      // Last chance for a session whose id only became known at the end
      // (idempotent — a poll-loop stamp already won if it fired).
      if (managed.handle.vendorSessionId) {
        stampVendorSession(managed.handle.vendorSessionId);
      }
      await streams.flush().catch(() => undefined);
      // G7: persist the chat-continuity handle only for a lane that declares it
      // keeps one, and stamp the binding with the lane that ACTUALLY ran — the
      // literal here used to say `claude-code` twice, so a second lane earning
      // the handle would have mis-attributed its own session.
      // (`isVendorId` is implied by the capability being true — absence fails
      // closed — but it is what makes the narrowing visible to the compiler,
      // and the value is written into a DURABLE binding, so state it.)
      if (
        isRootCoordinator &&
        isVendorId(vendor) &&
        sessionCapability(vendor).persistsSessionHandle &&
        managed.handle.vendorSessionId
      ) {
        await cognitionClient
          .updateChat({
            chatId: job.chatId!,
            vendorSessionId: managed.handle.vendorSessionId,
            vendorSessionVendor: vendor,
            vendorSessionRootJobId: job.id,
          })
          .catch(() => undefined);
      }
      // B2: DEFERRED, not skipped. This is the coordinator turn's branch, and
      // awaiting the extractor here is exactly what kept the chat spinning (and
      // the ordinal-0 seat claimed) for up to two minutes after the assistant's
      // last token. The runner runs it once the terminal is committed.
      const capture =
        !executionInterrupted && !executionSignal.aborted
          ? buildPendingMemoryCapture({
              harness,
              job,
              taskId,
              laneId: lane.id,
              vendor,
              cwd,
              worktreeCwd,
              output: result.output,
              toolObservations: memoryToolEvidence.snapshot(),
              relatedNotes: surfaced,
            })
          : undefined;
      const editCoverage =
        !interrupted &&
        !executionInterrupted &&
        !executionSignal.aborted &&
        result.exitCode === 0
          ? await verifySuccessfulEdit()
          : undefined;
      // A run MUON ended because ITS OWN budget ran out is `failed`, never
      // `interrupted`: nobody acted on it, so a row that reads as a human
      // interrupt is a false statement about what happened. `cutShort` keeps
      // every other consequence of being stopped mid-work (no packet, no
      // memory capture) exactly as it was.
      const budgetKill = budgetExhausted(interrupted);
      const cutShort =
        interrupted || executionInterrupted || executionSignal.aborted;
      const status = budgetKill
        ? "failed"
        : cutShort
          ? "interrupted"
          : result.exitCode === 0 && editCoverage?.ok !== false
            ? "done"
            : "failed";
      // P0-2: THE SESSION PATH USED TO RETURN NO PACKET AT ALL.
      //
      // `packet` was simply absent from this return — the branch was documented
      // as "sessions (deferred)" and nothing ever un-deferred it. `mode: auto`
      // opens a SESSION for claude-code and codex, so this is the branch most
      // real dispatches take: the founder's two docs jobs both came through
      // here, both committed `status: done, exitCode: 0`, and both left
      // `handoff_read` empty. `parseWorkerFinalReport` was never the culprit —
      // it was never CALLED for them. One had edited the README and one had
      // not, and the ledger could not tell them apart, so the coordinator
      // correctly refused to call anything confirmed.
      //
      // Emitted on the same terms as the loop branch: never for an interrupted
      // run (there is no completed thought to report), and never fabricated —
      // a session runs no checks, so the packet is honestly degraded with
      // `no_check_evidence`, plus `no_diff_evidence` outside a governed
      // worktree and `no_worker_report` when the final message carried no typed
      // report. `buildTerminalPacket` swallows its own failures, so a packet
      // can still never fail or delay this terminal.
      //
      // Gated on `cutShort || budgetKill`, NOT on the status string: a
      // budget-killed run is now `failed`, and it is still a run that was
      // stopped mid-thought, so it emits no packet for exactly the reason an
      // interrupted one does not.
      const packet =
        cutShort || budgetKill
          ? undefined
          : await buildTerminalPacket({
              laneKey: vendor,
              taskId,
              // taskGoal is the assigned brief, not the injected worker
              // preamble / memory slice / action prefix.
              brief: job.brief,
              // `outcome`, never `result`: a `SessionResult` carries only an
              // exit code and the output, so taking the `result` branch would
              // mean inventing the `errorOutput` and `durationMs` a
              // `LaneCommandResult` has. The outcome path exists precisely so a
              // dispatch without a raw command result reports what it honestly
              // has and fabricates no exit codes or durations.
              outcome: {
                ok: status === "done",
                summary:
                  editCoverage?.ok === false
                    ? editCoverage.reason ??
                      "edit preflight completion failed"
                    : status === "done"
                      ? result.output
                      : `session exited with code ${result.exitCode}`,
              },
              workerOutput: result.output,
              worktreeCwd,
              recommendedNextAction:
                status === "done"
                  ? `Continue task '${taskId}' from this packet.`
                  : editCoverage?.ok === false
                    ? "Run preflight_edit for every uncovered file/symbol, then rerun the checks."
                    : `Diagnose the non-zero exit and retry task '${taskId}'.`,
            });
      return {
        status,
        exitCode: result.exitCode,
        ...(packet !== undefined ? { packet } : {}),
        result: startupStalled
          ? startupStallReason(vendor, startupStallMs, vendorStderrEvidence())
          : postOutputStalled
            ? postOutputStallReason(
                vendor,
                postOutputStallMs,
                vendorStderrEvidence()
              )
          : budgetKill
            ? budgetResult()
          : editCoverage?.ok === false
            ? `${jobResultTail(result.output, JOB_RESULT_GATED_TAIL_CHARS)}\n\nMUON completion gate: ${editCoverage.reason}`
            : jobResultTail(result.output),
        ...(capture !== undefined ? { capture } : {}),
      };
    }

    if (useLoop) {
      const evaluate = harness.evaluator
        ? createDiffEvaluator({
            implementerLaneKey: vendor,
            taskId,
            cwd,
            spec: harness.evaluator,
            signal: executionSignal,
            onEvent: (event) => {
              handleStreamEvent(event);
            },
            isReady: async (laneKey) =>
              (await client.getVendorReadiness()).some(
                (entry) =>
                  entry.vendor === laneKey &&
                  entry.installed &&
                  entry.authenticated
              ),
          })
        : undefined;
      // Every loop iteration spawns the vendor child through runLaneTask (or,
      // for a session-driver vendor, a managed session whose driver forwards
      // stderr), so its stderr is observable exactly as on the one-shot path
      // below.
      vendorStderrAttached = true;
      // ── THE GOVERNED GATE ON THE LOOP PATH ────────────────────────────────
      // A loop iteration on the one-shot transport is ungovernable by MUON on
      // BOTH session vendors, for mirror-image reasons (each measured live):
      //   • codex: `codex exec` has NO approval channel — it ignores
      //     `approval_policy` entirely and runs `approval: never` however the
      //     profile was compiled (0.145.0; its own banner says so). A codex
      //     implement/repair child did four minutes of write-authority work
      //     and filed ZERO approval requests.
      //   • claude-code: the one-shot session channel installs no
      //     `canUseTool`, so Claude's OWN permission layer adjudicates every
      //     tool call with no MUON grant reachable and denies the writes — a
      //     FULL AUTO mission's claude implementer failed every Edit/Bash
      //     with ZERO approval requests filed, so standing consent had
      //     nothing to grant.
      // One was ungated, the other over-gated; both are "MUON is not the
      // gate". The fix is the transport, once: each iteration runs through
      // the SAME managed session the interactive branch uses, so every
      // command, file change, and MCP tool call crosses MUON's approval
      // bridge (policy simulation, receipts, the human inbox,
      // deny-on-timeout) — one enforcement layer, and it is MUON's, exactly
      // as ADR-0023 resolved for the sandbox. Asked of the registry
      // (`vendorSupportsInteractive`), not spelled by vendor name: the
      // vendor-specific part is WHICH driver the managed session selects,
      // never WHETHER an iteration is gated. A lane without a session driver
      // (cursor, fake) keeps runLaneTask.
      const gatedIterationExecute = vendorSupportsInteractive(vendor)
        ? async (iteration: RunLaneTaskInput) => {
            // The per-iteration budget, kept from the one-shot transport: a
            // session start input carries no timeout, so the bound rides the
            // signal instead — the same 130-exit an aborted one-shot reports,
            // and the loop then repairs or escalates exactly as before.
            const iterationController = new AbortController();
            const parentSignal = iteration.signal ?? executionSignal;
            const onParentAbort = () =>
              iterationController.abort(parentSignal.reason);
            if (parentSignal.aborted) {
              onParentAbort();
            } else {
              parentSignal.addEventListener("abort", onParentAbort, {
                once: true,
              });
            }
            const iterationTimer =
              iteration.timeoutMs !== undefined && iteration.timeoutMs > 0
                ? setTimeout(
                    () =>
                      iterationController.abort(
                        new Error(
                          `loop iteration exceeded its ${iteration.timeoutMs}ms budget`
                        )
                      ),
                    iteration.timeoutMs
                  )
                : undefined;
            iterationTimer?.unref?.();
            try {
              const managed = await startManagedSession(
                makeSessionLedger(client),
                {
                  laneKey: vendor,
                  laneId: lane.id,
                  taskId,
                  jobId: job.id,
                  brief: iteration.brief,
                  cwd: iteration.cwd,
                  profile: iteration.profile,
                  approvalTimeoutMs: job.approvalTimeoutMs ?? undefined,
                  noInteractiveApprover: capabilityMode === "orchestrator",
                  // Full Auto's standing-approver lease — same terms as the
                  // interactive branch: coordinator only, re-read per gated call.
                  resolveStandingApprover:
                    capabilityMode === "orchestrator"
                      ? () => resolveStandingApprover(client)
                      : undefined,
                  // P0.4: workers only — same terms as the interactive branch.
                  workspacePath:
                    capabilityMode === "worker"
                      ? governedWorkspacePath
                      : undefined,
                  checkCommands: renderedChecks,
                  policy: policyProfile
                    ? {
                        profile: policyProfile,
                        executionCwd: cwd,
                        checkCommands: renderedChecks,
                      }
                    : undefined,
                  signal: iterationController.signal,
                  onDiagnostic:
                    iteration.onDiagnostic ?? observeVendorStderr,
                  onVendorStderrAttached: () => {
                    vendorStderrAttached = true;
                  },
                  onEvent: iteration.onEvent,
                }
              );
              // Resume/backlink handle at first knowledge, same fence as every
              // other mid-flight write; idempotent when a later iteration
              // reports a new thread.
              if (managed.handle.vendorSessionId) {
                stampVendorSession(managed.handle.vendorSessionId);
              }
              const result = await managed.handle.wait();
              // Late knowledge too: the Claude SDK reports its session id on
              // the stream (the first `system` message), strictly after
              // start() returns — the stamp is idempotent, so both sites fire.
              if (managed.handle.vendorSessionId) {
                stampVendorSession(managed.handle.vendorSessionId);
              }
              return { exitCode: result.exitCode, output: result.output };
            } finally {
              if (iterationTimer) clearTimeout(iterationTimer);
              parentSignal.removeEventListener("abort", onParentAbort);
            }
          }
        : undefined;
      const contextAwareIterationExecute = async (
        iteration: RunLaneTaskInput
      ) => {
        const frame = contextEvidence
          ? await contextEvidence.begin({
              source: "loop",
              content: iteration.brief,
              exposures: memoryContextExposures,
            })
          : undefined;
        let result;
        try {
          result = gatedIterationExecute
            ? await gatedIterationExecute(iteration)
            : await runLaneTask(iteration);
        } catch (error) {
          if (frame) {
            await contextEvidence?.failed(frame, error).catch(() => undefined);
          }
          throw error;
        }
        if (frame) {
          await contextEvidence?.delivered(frame).catch((error) => {
            log(
              `could not complete loop context frame ${frame.id}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        }
        return result;
      };
      const outcome = await runLoop({
        dispatchJobId: job.id,
        kind: harness.loopKind,
        laneKey: vendor,
        laneId: lane.id,
        taskId,
        brief: dispatchBrief,
        checks: loopChecks,
        maxIterations: job.maxIterations ?? harness.budget.maxIterations,
        maxWallMs: effectiveMaxWallMs,
        timeoutMs: job.iterationTimeoutMs ?? undefined,
        cwd,
        evaluate,
        profile: dispatchProfile,
        harnessKey: job.harnessKey ?? undefined,
        signal: executionSignal,
        ledger: {
          createLoopRun: (input) => client.createLoopRun(input),
          updateLoopRun: (input) => client.updateLoopRun(input),
          recordEvent: (event) => client.recordEvent(event),
          requestApproval: (input) => client.requestApproval(input),
        },
        onEvent: (event) => {
          handleStreamEvent(event);
        },
        onDiagnostic: observeVendorStderr,
        ...(onVendorBytes ? { onBytes: onVendorBytes } : {}),
        execute: contextAwareIterationExecute,
      });
      await streams.flush().catch(() => undefined);
      const passed = outcome.status === "passed";
      const editCoverage = passed
        ? await verifySuccessfulEdit()
        : undefined;
      const completionPassed = passed && editCoverage?.ok !== false;
      // B2: deferred to after the terminal write, exactly as on the session
      // branch — a worker's seat frees (and its auto-continue nudge fires) the
      // moment it finishes, not two minutes later.
      const capture =
        outcome.status !== "aborted" && !executionSignal.aborted
          ? buildPendingMemoryCapture({
              harness,
              job,
              taskId,
              laneId: lane.id,
              vendor,
              cwd,
              worktreeCwd,
              output: outcome.finalOutput ?? outcome.stopReason,
              toolObservations: memoryToolEvidence.snapshot(),
              relatedNotes: surfaced,
              loop: {
                passed: completionPassed,
                stopReason:
                  editCoverage?.ok === false
                    ? editCoverage.reason ?? "edit preflight completion failed"
                    : outcome.stopReason,
              },
            })
          : undefined;
      const loopInterrupted =
        outcome.status === "aborted" || executionSignal.aborted;
      // The loop path has no human-interrupt flag of its own (an interrupt
      // arrives as an abort on the shared signal, which `budgetExhausted`
      // already excludes via `opts.signal`), so the budget question is asked
      // with the same helper the session path uses.
      const loopBudgetKill = budgetExhausted();
      // Emitting terminal (P0.3): map the check evidence the loop already
      // produced into the typed packet. A run cut short — interrupted OR
      // budget-killed — emits no packet.
      const packet = loopInterrupted
        ? undefined
        : await buildTerminalPacket({
            laneKey: vendor,
            // taskGoal is the assigned brief, not the injected worker
            // preamble / memory slice / action prefix.
            brief: job.brief,
            taskId,
            outcome: {
              ok: completionPassed,
              summary:
                editCoverage?.ok === false
                  ? editCoverage.reason ??
                    "edit preflight completion failed"
                  : outcome.stopReason,
            },
            workerOutput: outcome.finalOutput,
            checks: outcome.lastChecks.map((check) => toHandoffCheck(check)),
            worktreeCwd,
            recommendedNextAction: completionPassed
              ? "Checks passed; review and land the worktree changes."
              : editCoverage?.ok === false
                ? "Run preflight_edit for every uncovered file/symbol, then rerun the checks."
                : `Repair loop ${outcome.status}: ${outcome.stopReason.slice(0, 200)}`,
          });
      return {
        status: loopBudgetKill
          ? "failed"
          : loopInterrupted
            ? "interrupted"
            : completionPassed
              ? "done"
              : "failed",
        // Review F1 (HIGH): a startup stall aborts the loop, which returns
        // GRACEFULLY with a generic "runner authority lost" stopReason (never
        // reaching the catch block that surfaces the real reason). implement and
        // repair are LOOP harnesses, so without this branch the exact codex-hang
        // class the watchdog exists to diagnose was misreported as a runner/lease
        // problem. Surface the diagnosable stall reason, matching the interactive
        // and oneshot paths.
        result: startupStalled
          ? startupStallReason(vendor, startupStallMs, vendorStderrEvidence())
          : postOutputStalled
            ? postOutputStallReason(
                vendor,
                postOutputStallMs,
                vendorStderrEvidence()
              )
          : loopBudgetKill
            ? budgetResult()
          : editCoverage?.ok === false
            ? `loop checks passed, but MUON blocked completion: ${editCoverage.reason}`
            : `${passed ? "loop passed" : `loop ${outcome.status}`} in ${
              outcome.iterations
            } iteration(s): ${outcome.stopReason}${
              outcome.approvalId ? ` (approval ${outcome.approvalId})` : ""
            }`,
        ...(packet !== undefined ? { packet } : {}),
        ...(capture !== undefined ? { capture } : {}),
      };
    }

    // REAL TERMINAL (one-shot): with an injected pty factory, an opted-in lane
    // (codex) runs on a genuine pseudo-terminal — the live pane then carries
    // the vendor's native console instead of piped fragments, and the vendor
    // session id from its own banner becomes the job's resume/backlink handle.
    // A pty merges stderr into stdout, so `vendorStderrAttached` stays false
    // there: the watchdog may only claim the silence it actually listened for.
    // Asked of the adapter registry, not spelled by vendor name, so a lane
    // that keeps pipes (claude SDK, cursor) keeps its stderr observer too.
    const ptyRun =
      opts.ptySpawn !== undefined &&
      !actionArgvOverride &&
      laneUsesPtyConsole(vendor);
    // The one-shot path spawns the vendor child directly, so its stderr IS
    // observable from here (pipes only). Recording that lets a stall on this
    // path say the vendor was silent on both streams — a claim the paths
    // without an observer must not make.
    vendorStderrAttached = !ptyRun;
    const oneShotFrame = contextEvidence
      ? await contextEvidence.begin({
          source: "dispatch",
          content: dispatchBrief,
          exposures: memoryContextExposures,
        })
      : undefined;
    let result;
    try {
      result = await runLaneTask({
        laneKey: vendor,
        taskId,
        brief: dispatchBrief,
        cwd,
        timeoutMs: effectiveMaxWallMs,
        signal: executionSignal,
        profile: dispatchProfile,
        argvOverride: actionArgvOverride,
        ...(effectiveRole ? { role: effectiveRole } : {}),
        onEvent: (event) => {
          handleStreamEvent(event);
        },
        onDiagnostic: observeVendorStderr,
        ...(onVendorBytes ? { onBytes: onVendorBytes } : {}),
        ...(ptyRun ? { pty: { spawn: opts.ptySpawn! } } : {}),
        onVendorSessionId: stampVendorSession,
      });
    } catch (error) {
      if (oneShotFrame) {
        await contextEvidence?.failed(oneShotFrame, error).catch(() => undefined);
      }
      throw error;
    }
    if (oneShotFrame) {
      await contextEvidence?.delivered(oneShotFrame).catch((error) => {
        log(
          `could not complete context frame ${oneShotFrame.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
    await streams.flush().catch(() => undefined);
    if (executionSignal.aborted) {
      // The one-shot path's budget kill used to read `interrupted` with the
      // bare prose "execution wall-clock budget elapsed during vendor
      // execution" — the status said a human acted and the sentence was buried
      // in a field nothing classified. Now: `failed`, plus the shared marker.
      const oneShotBudgetKill = budgetExhausted();
      // A REQUESTED interrupt (human or coordinator) is its own stop reason:
      // the untyped fallback used to blame "runner authority was lost", so a
      // deliberate stop read as an infrastructure failure in the ledger and
      // in every report built from it.
      const interruptRequestedStop =
        (executionSignal.reason as { code?: string } | undefined)?.code ===
        "MUON_INTERRUPT_REQUESTED";
      return {
        status: oneShotBudgetKill ? "failed" : "interrupted",
        exitCode: result.exitCode,
        result: startupStalled
          ? startupStallReason(vendor, startupStallMs, vendorStderrEvidence())
          : postOutputStalled
            ? postOutputStallReason(
                vendor,
                postOutputStallMs,
                vendorStderrEvidence()
              )
          : oneShotBudgetKill
            ? budgetResult()
            : interruptRequestedStop
              ? "stopped by a requested interrupt (operator or coordinator)"
              : "runner authority was lost during vendor execution",
      };
    }
    const editCoverage =
      result.exitCode === 0 ? await verifySuccessfulEdit() : undefined;
    const completionPassed =
      result.exitCode === 0 && editCoverage?.ok !== false;
    // B2: deferred to after the terminal write (the aborted case returned
    // above, so a one-shot that reaches here always has something to mine).
    const capture = buildPendingMemoryCapture({
      harness,
      job,
      taskId,
      laneId: lane.id,
      vendor,
      cwd,
      worktreeCwd,
      output: result.output,
      toolObservations: memoryToolEvidence.snapshot(),
      relatedNotes: surfaced,
    });
    // Emitting terminal (P0.3): a one-shot runs no checks, so the packet is
    // honestly degraded with `no_check_evidence` (and `no_diff_evidence`
    // outside a governed worktree). The v1 prose result stays unchanged.
    const packet = await buildTerminalPacket({
      laneKey: vendor,
      taskId,
      // taskGoal is the assigned brief, not the injected worker preamble /
      // memory slice / action prefix.
      brief: job.brief,
      ...(completionPassed
        ? { result }
        : {
            outcome: {
              ok: false,
              summary:
                editCoverage?.reason ??
                "edit preflight completion failed",
            },
            workerOutput: result.output,
          }),
      worktreeCwd,
      recommendedNextAction:
        completionPassed
          ? `Continue task '${taskId}' from this packet.`
          : editCoverage?.ok === false
            ? "Run preflight_edit for every uncovered file/symbol, then rerun the checks."
          : `Diagnose the non-zero exit and retry task '${taskId}'.`,
    });
    return {
      status: completionPassed ? "done" : "failed",
      exitCode: result.exitCode,
      result:
        editCoverage?.ok === false
          ? `${jobResultTail(result.output, JOB_RESULT_GATED_TAIL_CHARS)}\n\nMUON completion gate: ${editCoverage.reason}`
          : jobResultTail(result.output),
      ...(packet !== undefined ? { packet } : {}),
      capture,
    };
  } catch (error) {
    await streams.flush().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (executionSignal.aborted) {
      if (startupStalled) {
        return {
          status: "interrupted",
          result: startupStallReason(
            vendor,
            startupStallMs,
            vendorStderrEvidence()
          ),
        };
      }
      if (postOutputStalled) {
        return {
          status: "interrupted",
          result: postOutputStallReason(
            vendor,
            postOutputStallMs,
            vendorStderrEvidence()
          ),
        };
      }
      // Same classification on the throwing path: a vendor that dies of the
      // abort MUON raised at its own deadline is a budget failure, not an
      // interrupt. The thrown message is dropped for that case on purpose —
      // it is MUON's own "execution wall-clock budget elapsed" Error, and the
      // shared report states the budget, the spend, and that nobody acted.
      if (budgetExhausted()) {
        return { status: "failed", result: budgetResult() };
      }
      return {
        status: "interrupted",
        result: `runner authority was lost during vendor execution: ${message}`,
      };
    }
    await client
      .recordEvent({
        laneId: lane.id,
        taskId,
        kind: "task.blocked",
        message: `dispatch failed: ${message}`,
      })
      .catch(() => undefined);
    return { status: "failed", result: `dispatch failed: ${message}` };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (startupTimer) clearTimeout(startupTimer);
    clearPostOutputTimer();
    opts.signal?.removeEventListener("abort", onAuthorityAbort);
    await contextWriteChain.catch(() => undefined);
    // Flush the console's trailing partial line and the last batch. `end()`
    // never rejects, and it is awaited so a live terminal cannot outlive the
    // execution that produced it.
    await jobTerminal?.end();
  }
}
