import {
  handoffPacketSchema,
  isBudgetExhausted,
  isPreLaunchInterrupt,
  isUncertainTerminalOutcome,
  sessionCapability,
  type HandoffPacket,
} from "@muon/protocol";
import {
  buildDispatchForest,
  type DispatchForest,
  type DispatchTreeNode,
} from "./dispatch-view.js";
import {
  collectCapabilityPreflight,
  type CapabilityPreflight,
  type CapabilityPreflightClient,
} from "./capability-preflight.js";
import type {
  ApprovalRequest,
  DispatchBudget,
  DispatchJobRecord,
  LaneSession,
  LoopRunRecord,
  OrchestratorChatRecord,
  RecordedEvent,
  StreamChunk,
} from "./types.js";
import {
  laneCostsFromUsageEvents,
  summarizeMissionCost,
  type LaneCost,
  type MissionCost,
} from "@muon/protocol";
import type { MergeReviewRecord } from "@muon/protocol";

/**
 * P0.1 slice 1 — the read-only durable run bundle.
 *
 * ONE pure, browser-safe projection (same discipline as `dispatch-view.ts` /
 * `capability-preflight.ts`: no node built-ins) that folds already-fetched
 * ledger evidence into a single portable JSON artifact: the dispatch manifest +
 * delegation lineage, S9 budget accounting, the P0.3 typed handoff packets,
 * approval records with their evidence refs, stream MILESTONES (never raw stream
 * bytes), the capability-preflight snapshot, and artifact hashes.
 *
 * INVARIANTS (structural, not decorative):
 *  - STRICTLY read-only. Assembly performs GETs only; it never mutates the
 *    ledger. `collectRunBundle` calls only read endpoints.
 *  - NO credential material EVER. Every embedded free-text field is scrubbed
 *    through {@link redactSecrets} BEFORE it is length-bounded (redact-before-
 *    truncate), so a `KEY=value` / `Bearer …` pair split at a char bound can
 *    never leak a trailing fragment. Numbers, enums, ids, and sha256 evidence
 *    refs are carried verbatim (a payload/diff/artifact hash is a REF, not a
 *    secret).
 *  - Raw stream bytes stay out: only `kind === "milestone"` chunks ride here.
 *  - Bounded by construction: every array is capped and any drop is reported
 *    honestly in `omissions` (never a silent truncation).
 *
 * DELIBERATE EXCLUSIONS (kept out to hold the invariants, documented so a reader
 * knows the bundle is intentionally lean, not lossy by accident):
 *  - a job's raw `result` output and its `steerMessages` — unbounded agent/human
 *    free text; the structured terminal narrative already lives in the typed
 *    handoff packet.
 *  - runner lease / host material — never on the wire `DispatchJobRecord` to
 *    begin with (the api-client schema strips it), so it cannot reach here.
 *
 * REDACTOR PROVENANCE: `@muon/core`'s handoff `redactSecrets` seam is the
 * reference implementation, but it is module-private AND `@muon/core` is
 * node-tied (it is not even a dependency of this browser-safe `@muon/client`
 * package). So we mirror its exact regexes here as an equivalent pure redactor.
 * Keep the two in sync if the seam changes.
 */

export const RUN_BUNDLE_VERSION = 2 as const;

// ---- bounds (caps + free-text ceilings) ----
const MAX_JOBS = 200;
const MAX_ROOTS = 25;
const MAX_APPROVALS = 100;
const MAX_MILESTONES = 200;
const MAX_ARTIFACTS = 200;
const MAX_SESSIONS = 100;
const MAX_LOOPS = 50;
const MAX_BRIEF_CHARS = 1000;
const MAX_REASON_CHARS = 1000;
const MAX_SCOPE_CHARS = 2000;
const MAX_IMPACT_CHARS = 4000;
const MAX_DETAIL_VALUE_CHARS = 2000;
const MAX_DETAIL_ENTRIES = 25;
const MAX_MILESTONE_CHARS = 2000;
const MAX_TITLE_CHARS = 200;

export const RUN_BUNDLE_LIMITS = {
  maxJobs: MAX_JOBS,
  maxRoots: MAX_ROOTS,
  maxApprovals: MAX_APPROVALS,
  maxMilestones: MAX_MILESTONES,
  maxArtifacts: MAX_ARTIFACTS,
  briefChars: MAX_BRIEF_CHARS,
  milestoneChars: MAX_MILESTONE_CHARS,
} as const;
export type RunBundleLimits = typeof RUN_BUNDLE_LIMITS;

/**
 * Best-effort secret scrubbing — a faithful mirror of the `@muon/core` handoff
 * seam. Strips the common `KEY=value` and bearer-token shapes so credentials
 * never survive into a bundle field.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      // Character runs bounded to a constant so scanning is LINEAR (no O(n^2)
      // backtracking on long keyword-free identifier runs — ReDoS SEC-3/SEC-4).
      // Real secrets still redact: a longer variable name simply matches from a
      // later start position, and the value group (\S+) is unbounded.
      /([A-Za-z0-9_-]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_-]{0,64})(\s*[=:]\s*)(\S+)/gi,
      "$1$2[redacted]"
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
}

/**
 * MACHINE IDENTITY — absolute filesystem paths and machine-local hostnames.
 *
 * WHY THIS EXISTS. `backend/src/lib/memory-pack-import.ts` claimed "No absolute
 * path, hostname or username may ever ride a pack, in either direction", and
 * `memory-pack.ts` claimed "the only workspace value on the wire is the salted
 * opaque origin fingerprint". Both were FALSE: the only filter on exported prose
 * was {@link redactSecrets}, which matches `KEY=value` secret shapes and bearer
 * tokens and nothing else. A security review exported a confirmed note reading
 * "The vault lives at /Users/<name>/SWE/ACME-CLIENT-PRIVATE/ops/keys.md on host
 * <machine>.local" — verbatim, into a directory the user is told to commit to a
 * team git repo. MUON's own notes routinely carry absolute paths; ADR-0026 quotes
 * several.
 *
 * DETERMINISTIC AND MACHINE-INDEPENDENT, which is a hard requirement rather than
 * a preference. The pack's content address is computed over the REDACTED text,
 * and `verifyRecord` re-runs this redaction on the RECEIVING machine and refuses
 * the record unless it hashes to the declared `textHash`. So redacting "this
 * machine's `os.hostname()`/`userInfo().username`" would produce a different
 * string on the importer and refuse every legitimate pack. Only shapes, never
 * lookups.
 *
 * REPO-RELATIVE PATHS SURVIVE, deliberately. `src/pay/charge.ts` is a module
 * ANCHOR and the thing a memory note is usually about; it means the same on both
 * machines and carries no machine identity. Only ABSOLUTE paths are replaced, and
 * they are replaced whole — the tail is often the most identifying part
 * (`ACME-CLIENT-PRIVATE`), and an absolute path from another machine is
 * meaningless to the reader anyway.
 */
export function redactMachineIdentity(text: string): string {
  return (
    text
      // POSIX absolute paths. The leading segment set is bounded so the scan is
      // linear, and the run is capped for the same ReDoS reason as above.
      .replace(
        /\/(?:Users|home|var|private|tmp|opt|srv|mnt|media|root)(?:\/[\w.@ +-]{1,64}){0,16}/g,
        "[path redacted]"
      )
      // Windows drive paths and UNC shares.
      .replace(/[A-Za-z]:\\(?:[\w.@ +-]{1,64}\\?){0,16}/g, "[path redacted]")
      .replace(/\\\\[\w.-]{1,64}(?:\\[\w.@ +-]{1,64}){0,16}/g, "[path redacted]")
      // Machine-local hostnames. `.local` is mDNS and `.internal` is the common
      // private-network convention; both name a host that exists only inside the
      // sender's network, so neither is meaningful to a reader and both identify.
      .replace(/\b[\w-]{1,64}\.(?:local|internal|lan|home)\b/gi, "[host redacted]")
  );
}

/**
 * The FULL export/import redaction, and the one both sides must agree on.
 *
 * Composed rather than folded into {@link redactSecrets} because that function is
 * also the run-bundle redactor, where an absolute path is legitimate context for
 * the operator reading their own machine's bundle. A pack crosses a MACHINE
 * boundary; a bundle does not.
 *
 * ORDER MATTERS: secrets first, so a credential embedded in a path
 * (`/Users/x/.config/API_KEY=abc`) is scrubbed as a secret before the path rule
 * swallows the whole span and hides that a secret was ever there.
 */
export function redactForPack(text: string): string {
  return redactMachineIdentity(redactSecrets(text));
}

/**
 * Redacted THEN bounded. Redaction runs over the FULL string first, so a secret
 * anywhere in the text is scrubbed before the slice can cut it in half.
 */
function redactBounded(text: string, maxChars: number): string {
  return redactSecrets(text).slice(0, maxChars);
}

// ---- bundle shape ----

export type RunBundleSource = {
  kind: "job" | "chat";
  id: string;
  /** Redacted, bounded chat title (chat source only). */
  title: string | null;
  workspacePath: string | null;
};

/** One row of the dispatch manifest. Numbers/enums/ids verbatim; brief redacted. */
export type RunBundleJob = {
  id: string;
  vendor: string;
  kind: string;
  status: string;
  taskId: string;
  chatId: string | null;
  parentJobId: string | null;
  rootJobId: string | null;
  capabilityMode: string | null;
  depth: number;
  maxDepth: number | null;
  /** The validated model override (`actionProfilePatch.model`), or null. */
  model: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Redacted + bounded task brief. */
  brief: string;
  hasPacket: boolean;
  /**
   * Round-3 #15 — "memory informed this run" as a visible fact. Unique
   * standing-note ids the injection ledger recorded for this job (bounded to
   * `MAX_MEMORY_NOTES_PER_JOB`, coordinate-only — ids, never note text), or
   * `null` when the ledger could not be read. Absence is never rendered as
   * zero: `null` means "unknown", `{ notes: 0 }` means "measured, none".
   */
  memoryInformed: { notes: number; noteIds: string[] } | null;
};

export type RunBundleHandoff = {
  jobId: string;
  /** Validated + redacted terminal packet, or null when it failed validation. */
  packet: HandoffPacket | null;
  /** Set when `packet === null`: why the row could not be trusted. */
  invalidReason?: string;
};

export type RunBundleApprovalEvidence = {
  action: string;
  scope: string;
  riskLevel: string;
  impactIfApproved: string;
  /** sha256 REF to the exact approved payload — evidence, not a secret. */
  payloadDigest?: string;
  details: { key: string; value: string }[];
};

export type RunBundleApproval = {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  requestedBy: string;
  reason: string;
  gateTag: string | null;
  decisionNotes: string | null;
  consumedAt: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  evidence: RunBundleApprovalEvidence | null;
  reviewCertification: MergeReviewRecord | null;
};

export type RunBundleMilestone = {
  seq: number;
  taskId: string;
  laneId: string;
  agentId: string | null;
  runId: string | null;
  at: string;
  /** Redacted + bounded milestone text. */
  content: string;
};

/** Artifact hash evidence aggregated from the terminal packets. */
export type RunBundleArtifact = {
  jobId: string;
  /** `file`/`report`/`log`/`other` for a produced artifact, `diff` for the run's diff hash. */
  kind: string;
  /** Redacted + bounded path (`diff` rows carry the well-known `<worktree diff>`). */
  path: string;
  /** sha256 evidence ref (`sha256:…`), when present. */
  hash?: string;
};

// ---- checkpoint projection (P0.1 checkpoint+resume, bundle v2) ----
//
// The ledger IS the checkpoint. Everything below is a PURE projection of
// already-durable rows (jobs, sessions, approvals, loop progress); nothing
// here is a second source of truth, and nothing here is ever a replay anchor.

export type RunBundleJobPhase =
  | "queued"
  | "running"
  | "waiting-gate"
  | "terminal";

export type RunBundleResumeMechanism =
  | "still-queued"
  | "redispatch-fresh"
  | "session-resume"
  | "human-review"
  | "none";

export type RunBundleCheckpointJob = {
  jobId: string;
  phase: RunBundleJobPhase;
  /** Terminal with an UNKNOWN outcome (interrupted after a vendor launch). */
  uncertain: boolean;
  /**
   * `isPreLaunchInterrupt(result)` (the three exact pre-launch strings) or a
   * queued→interrupted row (`startedAt == null`): NO vendor process was ever
   * launched, the only class a resume may re-dispatch without a per-job
   * human decision.
   */
  provablyUnstarted: boolean;
  resume: {
    mechanism: RunBundleResumeMechanism;
    /** Vendor resume handle, verbatim ref (≤512 chars), when applicable. */
    vendorSessionId?: string;
    reason: string;
  };
};

export type RunBundleCheckpoint = {
  /**
   * sha256 over the mission's IMMUTABLE manifest fields (raw brief as a hash
   * ref only) — stable across every lifecycle phase, so pre-kill and
   * post-restart digests are comparable. Null when no hasher was injected.
   */
  lineageDigest: string | null;
  jobs: RunBundleCheckpointJob[];
  /** The exact pending gate(s), with their durable bindings. */
  pendingGates: Array<{
    approvalId: string;
    kind: string;
    jobId: string | null;
    gateTag: string | null;
    payloadDigest?: string;
    createdAt: string | null;
  }>;
  /** Consumed = terminally spent; a consumed gate NEVER revalidates. */
  spentGates: Array<{
    approvalId: string;
    consumedAt: string;
    gateTag: string | null;
    payloadDigest?: string;
  }>;
  /** approved ∧ consumedAt==null ∧ kind=='command': provably never delivered. */
  approvedUndelivered: Array<{
    approvalId: string;
    jobId: string | null;
    payloadDigest?: string;
  }>;
  sessions: Array<{
    id: string;
    jobId: string | null;
    vendorSessionId: string | null;
    status: string;
  }>;
  /** From LoopRun.progress — EVIDENCE only, never a replay anchor. */
  loopChecks: Array<{
    loopRunId: string;
    taskId: string;
    status: string;
    iterations: number;
    lastIteration?: number;
    degraded?: string;
  }>;
  invariants: {
    resumeIsHumanInitiated: true;
    consumedGatesNeverRevalidate: true;
    derivedFromLedgerOnly: true;
    noAutonomousReplay: true;
  };
};

const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "interrupted"]);

/**
 * sha256 lineage digest over the mission's IMMUTABLE manifest fields only:
 * `{id, taskId, parentJobId, rootJobId, resumedFromJobId, kind, vendor,
 * createdAt, briefSha256}` sorted by job id. Status/results/timestamps that
 * move with the lifecycle are deliberately excluded, so the digest is
 * phase-stable; the raw brief rides as a hash ref only (payloadDigest stance).
 */
export function computeLineageDigest(
  jobs: DispatchJobRecord[],
  sha256Hex: (text: string) => string
): string {
  const projection = [...jobs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((job) => ({
      id: job.id,
      taskId: job.taskId,
      parentJobId: job.parentJobId ?? null,
      rootJobId: job.rootJobId ?? null,
      resumedFromJobId: job.resumedFromJobId ?? null,
      kind: job.kind,
      vendor: job.vendor,
      createdAt: job.createdAt,
      briefSha256: sha256Hex(job.brief),
    }));
  return sha256Hex(JSON.stringify(projection));
}

/**
 * Lifecycle phase from durable rows alone. `waiting-gate` is DERIVED, never a
 * dispatch status: `running` ∧ this job's session `waiting_approval` ∧ a
 * pending approval bound to this job — the dispatch state machine is untouched.
 */
export function classifyJobPhase(
  job: DispatchJobRecord,
  sessions: LaneSession[],
  approvals: ApprovalRequest[]
): RunBundleJobPhase {
  if (job.status === "queued") return "queued";
  if (TERMINAL_JOB_STATUSES.has(job.status)) return "terminal";
  const sessionWaiting = sessions.some(
    (session) => session.jobId === job.id && session.status === "waiting_approval"
  );
  const gatePending = approvals.some(
    (approval) => approval.jobId === job.id && approval.status === "pending"
  );
  return sessionWaiting && gatePending ? "waiting-gate" : "running";
}

function checkpointJob(
  job: DispatchJobRecord,
  sessions: LaneSession[],
  approvals: ApprovalRequest[]
): RunBundleCheckpointJob {
  const phase = classifyJobPhase(job, sessions, approvals);
  const provablyUnstarted =
    job.status === "interrupted" &&
    (isPreLaunchInterrupt(job.result) ||
      job.startedAt === null ||
      job.startedAt === undefined);
  // "Uncertain" here is a RESUME question — was this vendor stopped mid-work
  // with side effects nobody has verified? A wall-budget kill is `failed` (MUON
  // ended it, no human did) but the answer to that question is identical, so it
  // classifies the same way and keeps its session-resume handle. Without this
  // it would fall through to "terminal with a known outcome; nothing to
  // resume", which is exactly the wrong thing to tell a human about a worker
  // that died 3 seconds over its budget mid-edit.
  //
  // The SHARED predicate, minus the one refinement that belongs to a checkpoint:
  // a job proven never to have launched has no unverified side effects at all,
  // so it is certain — and re-dispatchable without a human.
  const uncertain = isUncertainTerminalOutcome(job) && !provablyUnstarted;

  let resume: RunBundleCheckpointJob["resume"];
  if (phase === "queued") {
    resume = {
      mechanism: "still-queued",
      reason:
        "still queued in the ledger; the next live runner claims it (zero writes needed)",
    };
  } else if (phase === "running" || phase === "waiting-gate") {
    resume = {
      mechanism: "none",
      reason:
        phase === "waiting-gate"
          ? "a pending gate awaits the human decision; the gate survives with its exact binding"
          : "running; if its runner died, the successor runner's startup reclaim owns reconciliation",
    };
  } else if (provablyUnstarted) {
    resume = {
      mechanism: "redispatch-fresh",
      reason: isPreLaunchInterrupt(job.result)
        ? "interrupted strictly before any vendor launch (exact pre-launch result string); safe to re-dispatch as a fresh job"
        : "interrupted while still queued (never started); safe to re-dispatch as a fresh job",
    };
  } else if (uncertain) {
    // Which vendors' interactive sessions can be resumed by handing the vendor
    // its own session/thread id back. Read from the registry's `canResume`
    // column (ADR-0022 C4); this used to be a hand-maintained table here with a
    // "KEEP IN SYNC with the session drivers" comment on it, and an unlisted
    // vendor read as falsy by accident rather than by statement.
    if (job.kind === "session" && sessionCapability(job.vendor).canResume) {
      const handle = sessions.find(
        (session) => session.jobId === job.id && session.vendorSessionId
      )?.vendorSessionId;
      resume = handle
        ? {
            mechanism: "session-resume",
            vendorSessionId: handle.slice(0, 512),
            // REDEEMABLE, for both uncertain classes: POST /api/dispatch admits
            // a `resumedFromJobId` that is `interrupted` OR a wall-budget-killed
            // `failed` (backend/src/routes/dispatch.ts, resume lineage guard +
            // the append-once CAS). Handing a budget-killed session a handle the
            // route would have 409'd was the incoherence: a mechanism this
            // checkpoint promised and no surface could spend.
            reason:
              "vendor session can be resumed via resumeVendorSessionId on an explicit human re-dispatch",
          }
        : {
            mechanism: "human-review",
            reason:
              "resume handle unavailable (vendor session id was never persisted); human review required",
          };
    } else if (job.kind === "session") {
      resume = {
        mechanism: "none",
        reason: `vendor '${job.vendor}' sessions cannot be resumed (driver canResume:false); human review required`,
      };
    } else {
      resume = {
        mechanism: "human-review",
        reason: isBudgetExhausted(job.result)
          ? "stopped by MUON when its own wall-clock budget ran out, mid-work; only an explicit human decision may re-dispatch (consider a larger maxWallMs)"
          : "interrupted after a vendor launch with an unknown outcome; only an explicit human decision may re-dispatch",
      };
    }
  } else {
    resume = {
      mechanism: "none",
      reason: "terminal with a known outcome; nothing to resume",
    };
  }

  return {
    jobId: job.id,
    phase,
    uncertain,
    provablyUnstarted,
    resume,
  };
}

export type RunBundle = {
  version: typeof RUN_BUNDLE_VERSION;
  /** Caller-supplied generation clock (ISO 8601). */
  generatedAt: string;
  source: RunBundleSource;
  manifest: {
    jobs: RunBundleJob[];
    /** Total jobs seen before the `maxJobs` cap (so a drop is visible). */
    jobCount: number;
  };
  /** Delegation lineage (shared `buildDispatchForest` projection, briefs redacted). */
  lineage: DispatchForest;
  /** S9 budget accounting, one entry per root mission. */
  budgets: DispatchBudget[];
  /**
   * ADR-0036 — what the crew COST, derived from the event spine (feature #11
   * phase 2; no migration). `null` = the ledger could not be read, which is
   * NOT the same as "$0.00": a vendor that reports nothing stays a
   * non-reporting lane inside `cost`, and `describeMissionCost` renders the
   * floor with its coverage so no surface can print a bare number.
   */
  cost: MissionCost | null;
  /** Per-lane contributions behind `cost`. `[]` only when `cost` is null. */
  laneCosts: LaneCost[];
  handoffs: RunBundleHandoff[];
  approvals: RunBundleApproval[];
  milestones: RunBundleMilestone[];
  /** P0.5 capability snapshot at generation time (null when uncollectable). */
  capabilityPreflight: CapabilityPreflight | null;
  /** The last-safe-checkpoint projection (P0.1, bundle v2). */
  checkpoint: RunBundleCheckpoint;
  artifacts: RunBundleArtifact[];
  limits: RunBundleLimits;
  /** Honest, per-cap record of anything dropped to hold the bounds. */
  omissions: string[];
  invariants: {
    readOnly: true;
    credentialMaterialExcluded: true;
    rawStreamBytesExcluded: true;
    freeTextRedactedThenBounded: true;
  };
};

export type RunBundleInput = {
  /** Caller-supplied clock; the ONE source of `generatedAt`. */
  generatedAt: string;
  source: { kind: "job" | "chat"; id: string };
  chat?: OrchestratorChatRecord | null;
  /** The mission's job records (root + descendants); order does not matter. */
  jobs: DispatchJobRecord[];
  /** S9 mission budgets, one per root. */
  budgets: DispatchBudget[];
  /** ALL approvals; the builder filters to the mission's task ids. */
  approvals: ApprovalRequest[];
  /** ALL fetched stream chunks; the builder keeps only `milestone` kinds. */
  milestones: StreamChunk[];
  capabilityPreflight?: CapabilityPreflight | null;
  /** Lane sessions (secondary checkpoint source); the builder mission-scopes. */
  sessions?: LaneSession[];
  /** Loop runs (secondary checkpoint source); the builder mission-scopes. */
  loopRuns?: LoopRunRecord[];
  /**
   * Injected sha256 hasher (keeps this module pure + browser-safe; the CLI
   * injects `node:crypto`). Absent ⇒ `lineageDigest: null` + honest omission.
   */
  sha256Hex?: (text: string) => string;
  /**
   * Round-3 #15: per-job unique note ids from the injection ledger. A job id
   * mapped to `null` (or absent, or the whole map absent) renders as
   * `memoryInformed: null` — unknown, never zero.
   */
  memoryInjections?: Record<string, string[] | null>;
  /**
   * ADR-0036: per-lane spend the collector derived from the event spine.
   * Absent/undefined ⇒ the bundle reports cost as UNKNOWN rather than zero.
   */
  laneCosts?: readonly LaneCost[] | null;
  /**
   * Task-event reads that FAILED while deriving spend. Reported as an omission
   * rather than absorbed: a receipt whose cost read was partial and which does
   * not say so overstates its own coverage, which is the one thing ADR-0036 D1
   * exists to prevent.
   */
  costReadFailures?: number;
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Newest-first by id, matching the forest projection's ordering. */
function newestFirstBySeq(a: RunBundleMilestone, b: RunBundleMilestone): number {
  return b.seq - a.seq;
}

/** Extract the validated model override without dumping the whole action patch. */
function modelOverride(job: DispatchJobRecord): string | null {
  const patch = job.actionProfilePatch;
  if (patch && typeof patch === "object" && typeof patch.model === "string") {
    return redactBounded(patch.model, MAX_TITLE_CHARS);
  }
  return null;
}

/** Bound on note ids carried per job — ids are small, but a bundle is not a dump. */
export const MAX_MEMORY_NOTES_PER_JOB = 32;

function toMemoryInformed(
  jobId: string,
  injections: Record<string, string[] | null> | undefined,
  omissions: string[]
): { notes: number; noteIds: string[] } | null {
  const noteIds = injections?.[jobId];
  if (noteIds === null || noteIds === undefined) return null;
  const bounded = noteIds.slice(0, MAX_MEMORY_NOTES_PER_JOB);
  if (noteIds.length > bounded.length) {
    omissions.push(
      `memory: job ${jobId} carried ${noteIds.length} injected notes; ids capped at ${MAX_MEMORY_NOTES_PER_JOB}`
    );
  }
  // `notes` stays the TRUE count even when the id list is capped.
  return { notes: noteIds.length, noteIds: bounded };
}

function toManifestJob(
  job: DispatchJobRecord,
  memoryInformed: { notes: number; noteIds: string[] } | null
): RunBundleJob {
  return {
    id: job.id,
    vendor: job.vendor,
    kind: job.kind,
    status: job.status,
    taskId: job.taskId,
    chatId: job.chatId ?? null,
    parentJobId: job.parentJobId ?? null,
    rootJobId: job.rootJobId ?? null,
    capabilityMode: (job.capabilityMode as string | null) ?? null,
    depth: job.delegationDepth ?? 0,
    maxDepth: job.maxDelegationDepth ?? null,
    model: modelOverride(job),
    exitCode: job.exitCode ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    brief: redactBounded(job.brief, MAX_BRIEF_CHARS),
    hasPacket: job.packetJson !== undefined && job.packetJson !== null,
    memoryInformed,
  };
}

/** Redact every free-text field of a validated packet; ids/hashes stay verbatim. */
function redactPacket(packet: HandoffPacket): HandoffPacket {
  return {
    ...packet,
    taskGoal: redactSecrets(packet.taskGoal),
    whatChanged: redactSecrets(packet.whatChanged),
    whatFailed: redactSecrets(packet.whatFailed),
    nextLaneRequest: redactSecrets(packet.nextLaneRequest),
    commandsRun: packet.commandsRun.map(redactSecrets),
    checksStatus: packet.checksStatus.map(redactSecrets),
    openQuestions: packet.openQuestions.map(redactSecrets),
    uncertainties: packet.uncertainties.map(redactSecrets),
    unresolvedDecisions: packet.unresolvedDecisions.map(redactSecrets),
    ...(packet.recommendedNextAction !== undefined
      ? { recommendedNextAction: redactSecrets(packet.recommendedNextAction) }
      : {}),
    checks: packet.checks.map((check) => ({
      ...check,
      name: redactSecrets(check.name),
      ...(check.command !== undefined
        ? { command: redactSecrets(check.command) }
        : {}),
      summary: redactSecrets(check.summary),
    })),
    artifacts: packet.artifacts.map((artifact) => ({
      ...artifact,
      path: redactSecrets(artifact.path),
    })),
    memoryProposals: packet.memoryProposals.map((proposal) => ({
      ...proposal,
      text: redactSecrets(proposal.text),
    })),
    degraded: {
      ...packet.degraded,
      reasons: packet.degraded.reasons.map(redactSecrets),
    },
  };
}

/** Validate an untrusted `packetJson`, then redact its free text. */
function toHandoffRow(job: DispatchJobRecord): RunBundleHandoff | null {
  if (job.packetJson === undefined || job.packetJson === null) {
    return null;
  }
  const parsed = handoffPacketSchema.safeParse(job.packetJson);
  if (!parsed.success) {
    return {
      jobId: job.id,
      packet: null,
      invalidReason: "packet failed schema validation",
    };
  }
  // Redaction only shrinks/substitutes within existing bounds, so a re-parse
  // cannot fail; guard it anyway and degrade honestly if it ever does.
  const redacted = handoffPacketSchema.safeParse(redactPacket(parsed.data));
  if (!redacted.success) {
    return {
      jobId: job.id,
      packet: null,
      invalidReason: "packet failed re-validation after redaction",
    };
  }
  return { jobId: job.id, packet: redacted.data };
}

function toApprovalRow(approval: ApprovalRequest): RunBundleApproval {
  const evidence = approval.evidence
    ? {
        action: redactBounded(approval.evidence.action, MAX_TITLE_CHARS),
        scope: redactBounded(approval.evidence.scope, MAX_SCOPE_CHARS),
        riskLevel: approval.evidence.riskLevel,
        impactIfApproved: redactBounded(
          approval.evidence.impactIfApproved,
          MAX_IMPACT_CHARS
        ),
        ...(approval.evidence.payloadDigest !== undefined
          ? { payloadDigest: approval.evidence.payloadDigest }
          : {}),
        details: Object.entries(approval.evidence.details)
          .slice(0, MAX_DETAIL_ENTRIES)
          .map(([key, value]) => ({
            key: redactBounded(key, MAX_TITLE_CHARS),
            value: redactBounded(value, MAX_DETAIL_VALUE_CHARS),
          })),
      }
    : null;
  return {
    id: approval.id,
    taskId: approval.taskId,
    kind: approval.kind,
    status: approval.status,
    requestedBy: approval.requestedBy,
    reason: redactBounded(approval.reason, MAX_REASON_CHARS),
    gateTag: approval.gateTag ?? null,
    decisionNotes:
      approval.decisionNotes != null
        ? redactBounded(approval.decisionNotes, MAX_REASON_CHARS)
        : null,
    consumedAt: approval.consumedAt ?? null,
    createdAt: approval.createdAt ?? null,
    decidedAt: approval.decidedAt ?? null,
    evidence,
    reviewCertification: approval.reviewCertification ?? null,
  };
}

function toMilestoneRow(chunk: StreamChunk): RunBundleMilestone {
  return {
    seq: chunk.seq,
    taskId: chunk.taskId,
    laneId: chunk.laneId,
    agentId: chunk.agentId ?? null,
    runId: chunk.runId ?? null,
    at: chunk.timestamp,
    content: redactBounded(chunk.content, MAX_MILESTONE_CHARS),
  };
}

/** Redact the raw (un-scrubbed) briefs the forest projection copies verbatim. */
function redactForestBriefs(forest: DispatchForest): DispatchForest {
  const visit = (node: DispatchTreeNode): void => {
    node.brief = redactBounded(node.brief, MAX_BRIEF_CHARS);
    node.children.forEach(visit);
  };
  // `missions[].root` are the same object references as `forest.roots`, so one
  // pass over the roots covers every node the bundle exposes.
  forest.roots.forEach(visit);
  return forest;
}

/** Aggregate sha256 artifact + diff-hash evidence out of the validated packets. */
function collectArtifacts(handoffs: RunBundleHandoff[]): {
  artifacts: RunBundleArtifact[];
  truncated: boolean;
} {
  const artifacts: RunBundleArtifact[] = [];
  for (const row of handoffs) {
    if (!row.packet) continue;
    if (row.packet.diffHash !== undefined) {
      artifacts.push({
        jobId: row.jobId,
        kind: "diff",
        path: "<worktree diff>",
        hash: row.packet.diffHash,
      });
    }
    for (const artifact of row.packet.artifacts) {
      artifacts.push({
        jobId: row.jobId,
        kind: artifact.kind,
        // Already redacted by `redactPacket`; keep it bounded here too.
        path: redactBounded(artifact.path, MAX_TITLE_CHARS + 60),
        ...(artifact.hash !== undefined ? { hash: artifact.hash } : {}),
      });
    }
  }
  return {
    artifacts: artifacts.slice(0, MAX_ARTIFACTS),
    truncated: artifacts.length > MAX_ARTIFACTS,
  };
}

/**
 * Pure, deterministic bundle assembly. Given already-fetched ledger evidence and
 * a caller-supplied clock, folds it into the bounded, redacted {@link RunBundle}.
 */
export function buildRunBundle(input: RunBundleInput): RunBundle {
  const omissions: string[] = [];
  if ((input.costReadFailures ?? 0) > 0) {
    omissions.push(
      `cost: ${input.costReadFailures} task event read(s) failed, so observed spend omits them`
    );
  }

  // ---- manifest + lineage ----
  const allJobs = input.jobs;
  const cappedJobs = allJobs.slice(0, MAX_JOBS);
  if (allJobs.length > MAX_JOBS) {
    omissions.push(
      `manifest: ${allJobs.length - MAX_JOBS} of ${allJobs.length} jobs omitted past the ${MAX_JOBS} cap`
    );
  }
  const manifestJobs = cappedJobs.map((job) =>
    toManifestJob(
      job,
      toMemoryInformed(job.id, input.memoryInjections, omissions)
    )
  );
  // Name OUR OWN cap distinctly from a failed read: both render as null on
  // the job, but "we chose not to look past N" is a different fact from
  // "we looked and could not read" (review pass 7 #10).
  if (input.memoryInjections) {
    const unqueried = cappedJobs.filter(
      (job) => !(job.id in input.memoryInjections!)
    ).length;
    if (unqueried > 0) {
      omissions.push(
        `memory: injection ledger read for ${cappedJobs.length - unqueried} of ${cappedJobs.length} jobs (collector cap); the rest are unknown`
      );
    }
  }
  const lineage = redactForestBriefs(buildDispatchForest(cappedJobs));

  const taskIds = new Set(cappedJobs.map((job) => job.taskId));

  // ---- handoff packets + artifact hashes ----
  const handoffs = cappedJobs
    .map(toHandoffRow)
    .filter((row): row is RunBundleHandoff => row !== null);
  const { artifacts, truncated: artifactsTruncated } =
    collectArtifacts(handoffs);
  if (artifactsTruncated) {
    omissions.push(
      `artifacts: capped at ${MAX_ARTIFACTS}; older artifact hashes omitted`
    );
  }

  // ---- approvals (scoped to the mission's tasks) ----
  const missionApprovals = input.approvals.filter((approval) =>
    taskIds.has(approval.taskId)
  );
  const approvals = missionApprovals.slice(0, MAX_APPROVALS).map(toApprovalRow);
  if (missionApprovals.length > MAX_APPROVALS) {
    omissions.push(
      `approvals: ${missionApprovals.length - MAX_APPROVALS} of ${missionApprovals.length} omitted past the ${MAX_APPROVALS} cap`
    );
  }

  // ---- stream MILESTONES only (never raw output/reasoning bytes) ----
  const missionMilestones = input.milestones
    .filter(
      (chunk) => chunk.kind === "milestone" && taskIds.has(chunk.taskId)
    )
    .map(toMilestoneRow)
    .sort(newestFirstBySeq);
  const milestones = missionMilestones.slice(0, MAX_MILESTONES);
  if (missionMilestones.length > MAX_MILESTONES) {
    omissions.push(
      `milestones: ${missionMilestones.length - MAX_MILESTONES} of ${missionMilestones.length} omitted past the ${MAX_MILESTONES} cap`
    );
  }

  // ---- budgets (one per root) ----
  const budgets = input.budgets.slice(0, MAX_ROOTS);
  if (input.budgets.length > MAX_ROOTS) {
    omissions.push(
      `budgets: ${input.budgets.length - MAX_ROOTS} of ${input.budgets.length} root missions omitted past the ${MAX_ROOTS} cap`
    );
  }

  // ---- checkpoint projection (P0.1, bundle v2) ----
  const jobIds = new Set(cappedJobs.map((job) => job.id));
  const missionSessions = (input.sessions ?? []).filter(
    (session) =>
      (session.jobId != null && jobIds.has(session.jobId)) ||
      taskIds.has(session.taskId)
  );
  const cappedSessions = missionSessions.slice(0, MAX_SESSIONS);
  if (missionSessions.length > MAX_SESSIONS) {
    omissions.push(
      `sessions: ${missionSessions.length - MAX_SESSIONS} of ${missionSessions.length} omitted past the ${MAX_SESSIONS} cap`
    );
  }
  const missionLoops = (input.loopRuns ?? []).filter((loop) =>
    taskIds.has(loop.taskId)
  );
  const cappedLoops = missionLoops.slice(0, MAX_LOOPS);
  if (missionLoops.length > MAX_LOOPS) {
    omissions.push(
      `loops: ${missionLoops.length - MAX_LOOPS} of ${missionLoops.length} omitted past the ${MAX_LOOPS} cap`
    );
  }

  let lineageDigest: string | null = null;
  if (input.sha256Hex) {
    lineageDigest = computeLineageDigest(cappedJobs, input.sha256Hex);
  } else {
    omissions.push(
      "checkpoint: lineageDigest omitted (no sha256 hasher injected; browser-safe assembly)"
    );
  }

  const checkpoint: RunBundleCheckpoint = {
    lineageDigest,
    jobs: cappedJobs.map((job) =>
      checkpointJob(job, cappedSessions, missionApprovals)
    ),
    pendingGates: missionApprovals
      .filter((approval) => approval.status === "pending")
      .slice(0, MAX_APPROVALS)
      .map((approval) => ({
        approvalId: approval.id,
        kind: approval.kind,
        jobId: approval.jobId ?? null,
        gateTag: approval.gateTag ?? null,
        ...(approval.evidence?.payloadDigest !== undefined
          ? { payloadDigest: approval.evidence.payloadDigest }
          : {}),
        createdAt: approval.createdAt ?? null,
      })),
    spentGates: missionApprovals
      .filter((approval) => approval.consumedAt != null)
      .slice(0, MAX_APPROVALS)
      .map((approval) => ({
        approvalId: approval.id,
        consumedAt: approval.consumedAt as string,
        gateTag: approval.gateTag ?? null,
        ...(approval.evidence?.payloadDigest !== undefined
          ? { payloadDigest: approval.evidence.payloadDigest }
          : {}),
      })),
    approvedUndelivered: missionApprovals
      .filter(
        (approval) =>
          approval.kind === "command" &&
          approval.status === "approved" &&
          approval.consumedAt == null
      )
      .slice(0, MAX_APPROVALS)
      .map((approval) => ({
        approvalId: approval.id,
        jobId: approval.jobId ?? null,
        ...(approval.evidence?.payloadDigest !== undefined
          ? { payloadDigest: approval.evidence.payloadDigest }
          : {}),
      })),
    sessions: cappedSessions.map((session) => ({
      id: session.id,
      jobId: session.jobId ?? null,
      // Verbatim resume-handle ref, bounded (same 512 ceiling the dispatch
      // schema enforces on resumeVendorSessionId).
      vendorSessionId: session.vendorSessionId
        ? session.vendorSessionId.slice(0, 512)
        : null,
      status: session.status,
    })),
    loopChecks: cappedLoops.map((loop) => ({
      loopRunId: loop.id,
      taskId: loop.taskId,
      status: loop.status,
      iterations: loop.iterations,
      ...(loop.progress?.iteration !== undefined
        ? { lastIteration: loop.progress.iteration }
        : {}),
      ...(loop.progress?.degraded !== undefined
        ? { degraded: redactBounded(loop.progress.degraded, MAX_TITLE_CHARS) }
        : {}),
    })),
    invariants: {
      resumeIsHumanInitiated: true,
      consumedGatesNeverRevalidate: true,
      derivedFromLedgerOnly: true,
      noAutonomousReplay: true,
    },
  };

  const source: RunBundleSource = {
    kind: input.source.kind,
    id: input.source.id,
    title: input.chat?.title
      ? redactBounded(input.chat.title, MAX_TITLE_CHARS)
      : null,
    workspacePath: input.chat?.workspacePath ?? null,
  };

  return {
    version: RUN_BUNDLE_VERSION,
    generatedAt: input.generatedAt,
    source,
    manifest: { jobs: manifestJobs, jobCount: allJobs.length },
    // A FAILED READ CANNOT CLAIM COMPLETENESS. Recording the failure in
    // `omissions` was not enough on its own — an adversarial review pointed
    // out that `summarizeMissionCost` still sets `complete: true` whenever the
    // SURVIVING reads happen to cover every vendor, so the receipt's own
    // coverage field kept lying while a footnote said otherwise. The two must
    // agree, and the field is what downstream code reads.
    cost: input.laneCosts
      ? (input.costReadFailures ?? 0) > 0
        ? { ...summarizeMissionCost(input.laneCosts), complete: false }
        : summarizeMissionCost(input.laneCosts)
      : null,
    laneCosts: input.laneCosts ? [...input.laneCosts] : [],
    lineage,
    budgets,
    handoffs,
    approvals,
    milestones,
    capabilityPreflight: input.capabilityPreflight ?? null,
    checkpoint,
    artifacts,
    limits: RUN_BUNDLE_LIMITS,
    omissions,
    invariants: {
      readOnly: true,
      credentialMaterialExcluded: true,
      rawStreamBytesExcluded: true,
      freeTextRedactedThenBounded: true,
    },
  };
}

/** Read-only endpoints the collector composes; a superset of the preflight client. */
export type RunBundleClient = CapabilityPreflightClient & {
  getDispatchJob(jobId: string): Promise<DispatchJobRecord>;
  getDispatchBudget(jobId: string): Promise<DispatchBudget>;
  listDispatchJobs(filter?: {
    chatId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<DispatchJobRecord[]>;
  getChat?(chatId: string): Promise<OrchestratorChatRecord>;
  listApprovals(): Promise<ApprovalRequest[]>;
  listStreamChunks(filter: {
    taskId?: string;
    latest?: boolean;
    limit?: number;
  }): Promise<StreamChunk[]>;
  /** Optional secondary checkpoint sources (older clients omit them → []). */
  listSessions?(filter?: {
    taskId?: string;
    status?: string;
  }): Promise<LaneSession[]>;
  listLoopRuns?(filter?: { taskId?: string }): Promise<LoopRunRecord[]>;
  /** Round-3 #15: injection-ledger events ride `taskId = jobId`. Optional —
   *  an older client omits it and every job renders `memoryInformed: null`. */
  listTaskEvents?(taskId: string): Promise<RecordedEvent[]>;
};

// How many chunks to pull per task before filtering down to milestones.
const STREAM_FETCH_LIMIT = 500;
const MAX_STREAM_TASKS = 25;
// Injection-ledger reads per bundle, matching the other secondary fan-outs.
const MAX_MEMORY_LEDGER_JOBS = 25;

/**
 * Compose a run bundle from EXISTING read-only endpoints. The primary target
 * (the job, or the chat's job list) must resolve or this rejects with a clear
 * error; every SECONDARY source (budgets, approvals, streams, the preflight
 * snapshot, individual descendant fetches) degrades to empty/null rather than
 * failing the whole export. Never writes to the ledger.
 */
export async function collectRunBundle(
  client: RunBundleClient,
  input: {
    jobId?: string;
    chatId?: string;
    now?: Date;
    /** Injected hasher for the lineage digest (CLI passes node:crypto). */
    sha256Hex?: (text: string) => string;
  }
): Promise<RunBundle> {
  const hasJob = typeof input.jobId === "string" && input.jobId.length > 0;
  const hasChat = typeof input.chatId === "string" && input.chatId.length > 0;
  if (hasJob === hasChat) {
    throw new Error(
      "collectRunBundle needs exactly one of jobId or chatId"
    );
  }
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();

  let jobs: DispatchJobRecord[] = [];
  let rootIds: string[] = [];
  let chat: OrchestratorChatRecord | null = null;
  let source: { kind: "job" | "chat"; id: string };

  if (hasChat) {
    const chatId = input.chatId as string;
    source = { kind: "chat", id: chatId };
    chat = client.getChat
      ? await client.getChat(chatId).catch(() => null)
      : null;
    // Primary source — surface a failure to the caller.
    jobs = await client.listDispatchJobs({ chatId, limit: MAX_JOBS });
    const roots = buildDispatchForest(jobs).roots.map((root) => root.id);
    rootIds =
      roots.length > 0
        ? roots
        : unique(jobs.map((job) => job.rootJobId ?? job.id));
  } else {
    const jobId = input.jobId as string;
    source = { kind: "job", id: jobId };
    // Primary source — surface a failure to the caller.
    const rootJob = await client.getDispatchJob(jobId);
    const rootId = rootJob.rootJobId ?? rootJob.id;
    // The mission budget (resolved to the root) enumerates every descendant id.
    const budget0 = await client.getDispatchBudget(jobId).catch(() => null);
    const memberIds = new Set<string>([rootId, rootJob.id]);
    if (budget0) {
      memberIds.add(budget0.jobId);
      for (const child of budget0.children) memberIds.add(child.jobId);
    }
    const ids = [...memberIds].slice(0, MAX_JOBS);
    const fetched = await Promise.all(
      ids.map((id) =>
        id === rootJob.id
          ? Promise.resolve(rootJob)
          : client.getDispatchJob(id).catch(() => null)
      )
    );
    jobs = fetched.filter((job): job is DispatchJobRecord => job !== null);
    rootIds = unique(jobs.map((job) => job.rootJobId ?? job.id));
    if (rootJob.chatId && client.getChat) {
      chat = await client.getChat(rootJob.chatId).catch(() => null);
    }
  }

  const budgets = (
    await Promise.all(
      rootIds
        .slice(0, MAX_ROOTS)
        .map((id) => client.getDispatchBudget(id).catch(() => null))
    )
  ).filter((budget): budget is DispatchBudget => budget !== null);

  const approvals = await client.listApprovals().catch(() => []);

  const taskIds = unique(jobs.map((job) => job.taskId)).slice(0, MAX_STREAM_TASKS);
  const chunkLists = await Promise.all(
    taskIds.map((taskId) =>
      client
        .listStreamChunks({ taskId, latest: true, limit: STREAM_FETCH_LIMIT })
        .catch(() => [] as StreamChunk[])
    )
  );
  const milestones = chunkLists.flat();

  // Secondary checkpoint sources: sessions + loop runs per mission task.
  // Degrade to [] on any failure or a missing (older-client) method.
  const sessionLists = await Promise.all(
    taskIds.map((taskId) =>
      client.listSessions
        ? client.listSessions({ taskId }).catch(() => [] as LaneSession[])
        : Promise.resolve([] as LaneSession[])
    )
  );
  const sessions = sessionLists.flat();
  const loopLists = await Promise.all(
    taskIds.map((taskId) =>
      client.listLoopRuns
        ? client.listLoopRuns({ taskId }).catch(() => [] as LoopRunRecord[])
        : Promise.resolve([] as LoopRunRecord[])
    )
  );
  const loopRuns = loopLists.flat();

  // Round-3 #15: the injection ledger, per job (events ride taskId = jobId).
  // A failed or unavailable read maps to null — "unknown", never zero. Capped
  // like every other secondary fan-out in this collector; a job past the cap
  // is simply UNKNOWN, which the field represents honestly.
  const injectionEntries = await Promise.all(
    jobs
      .slice(0, MAX_MEMORY_LEDGER_JOBS)
      .map(async (job): Promise<readonly [string, string[] | null]> => {
        if (!client.listTaskEvents) return [job.id, null] as const;
        try {
          const events = await client.listTaskEvents(job.id);
          const matching = events.filter(
            (event) => String(event.kind) === MEMORY_INJECTED_EVENT_KIND
          );
          const noteIds = unique(
            matching
              .map((event) => (event.metadata as { noteId?: unknown }).noteId)
              .filter(
                (noteId): noteId is string =>
                  typeof noteId === "string" && noteId.length > 0
              )
          );
          // Injection rows EXIST but none yielded an id: the metadata was
          // stripped (agent-tier events route) or its key shifted. That is
          // provably UNKNOWN, not "measured, none" — rendering it as zero is
          // the exact inversion this field forbids (review round 6 #6).
          if (matching.length > 0 && noteIds.length === 0) {
            return [job.id, null] as const;
          }
          return [job.id, noteIds] as const;
        } catch {
          return [job.id, null] as const;
        }
      })
  );
  const memoryInjections = Object.fromEntries(injectionEntries);

  // ADR-0036 phase 2 — crew cost, INGESTED at last (feature #11's missing
  // half). No migration: session drivers already emit `metadata.usage.costUsd`
  // onto the event spine, so mission spend is DERIVED on read exactly the way
  // ADR-0043's questions are. Usage events ride the TASK id (the injection
  // pass above is job-keyed), so this is its own read.
  //
  // Vendors that report nothing stay `reported: false` — never zero — and a
  // read we could not make at all leaves `laneCosts` null, so the bundle says
  // "unknown" rather than "$0.00". Both are the same honesty rule that has
  // been broken twice on this surface already.
  let laneCosts: LaneCost[] | null = null;
  /** Task-event reads that failed, so the spend below is missing theirs. */
  let costReadFailures = 0;
  if (client.listTaskEvents) {
    const costTaskIds = taskIds.slice(0, MAX_MEMORY_LEDGER_JOBS);
    const perTask = await Promise.all(
      costTaskIds.map(async (taskId) => {
        try {
          return await client.listTaskEvents!(taskId);
        } catch {
          return null;
        }
      })
    );
    // A PARTIAL FETCH CANNOT CLAIM FULL COVERAGE.
    //
    // An adversarial review found the gap: costs were computed whenever ANY
    // task-event read succeeded, and the failed ones were silently omitted. If
    // the surviving reads happened to include every vendor,
    // `summarizeMissionCost` reported `complete: true` — an exported receipt
    // overstating its own coverage, which is the one thing ADR-0036 D1 spends
    // its whole design preventing.
    costReadFailures = perTask.filter((events) => events === null).length;
    if (perTask.some((events) => events !== null)) {
      // ONE arithmetic, shared with the dispatch admission that enforces the
      // cap (`laneCostsFromUsageEvents`). This used to be a local loop; the
      // moment the cap gained a call site, a second copy of "what did this
      // mission cost" would have meant a brake that refused on one number
      // while the receipt printed another.
      //
      // `missionLanes` is every lane the mission actually RAN, so a silent
      // vendor is counted as non-reporting rather than omitted from the
      // denominator.
      laneCosts = laneCostsFromUsageEvents(
        perTask.flatMap((events) => events ?? []),
        // LANES THAT LAUNCHED, matching the backend's cap query exactly. A
        // queued job — or one interrupted or failed BEFORE launch — never
        // spent a cent, and counting its vendor here reported the receipt as
        // partial and named a lane as unreportable that did no work. This file
        // already reasons this way at the `startedAt === null` check above; the
        // denominator was the one place it did not.
        unique(
          jobs.filter((job) => job.startedAt !== null).map((job) => job.vendor)
        )
      );
    }
  }

  const capabilityPreflight = await collectCapabilityPreflight(client, {
    now,
  }).catch(() => null);

  return buildRunBundle({
    generatedAt,
    source,
    chat,
    jobs,
    budgets,
    approvals,
    milestones,
    capabilityPreflight,
    sessions,
    loopRuns,
    memoryInjections,
    laneCosts,
    // NEVER A SILENT TRUNCATION — the invariant this file states about every
    // other bounded array, applied to the one place it was not: a task-event
    // read that FAILED omits that task's spend, and a receipt that does not
    // say so overstates its own coverage.
    ...(costReadFailures > 0
      ? { costReadFailures }
      : {}),
    ...(input.sha256Hex ? { sha256Hex: input.sha256Hex } : {}),
  });
}

/**
 * The Event kind the brain files when a graph-mirror write fails.
 *
 * DEFINED HERE, in the one package every surface already depends on, because it
 * is a NAME two sides must agree on: the backend files it and the desktop polls
 * for it BY KIND. It previously lived only in the backend, which the desktop
 * cannot import — so the desktop would have had to restate the literal, and a
 * restated name is a name that drifts. `backend/src/lib/graph.ts` re-exports it so
 * its existing importers are unchanged.
 */
export const GRAPH_MIRROR_FAILED_EVENT_KIND = "memory.graph_mirror_failed";

/**
 * The Event kind the brain files when a standing note is injected at an edit
 * boundary (Substrate §3.3, `taskId = jobId`). Defined HERE for the same
 * reason as the kind above: the backend files it and the bundle collector
 * filters by it, and a restated literal is a literal that drifts.
 * `backend/src/lib/injection-telemetry.ts` re-exports it for its importers.
 */
export const MEMORY_INJECTED_EVENT_KIND = "memory.injected";
