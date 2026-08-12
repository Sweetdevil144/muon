import {
  handoffPacketSchema,
  isPreLaunchInterrupt,
  isUncertainTerminalOutcome,
  sessionCapability,
  type HarnessCheck,
} from "@muon/protocol";
import type { CapabilityPreflight } from "./capability-preflight.js";
import {
  computeLineageDigest,
  redactSecrets,
  type RunBundle,
} from "./run-bundle.js";
import type {
  ApprovalRequest,
  DispatchJobRecord,
  DispatchKind,
  LaneSession,
} from "./types.js";

/**
 * P0.1 checkpoint+resume (Slice C2) — the PURE resume planner.
 *
 * Resume is an explicit HUMAN act; this module only ever PLANS. Structural
 * invariants (never weakened):
 *
 *  - RECONCILE FIRST, LIVE LEDGER IS AUTHORITY: the plan is derived from live
 *    rows; a supplied bundle is portable EVIDENCE whose lineage digest is
 *    re-verified against the live jobs. A provable mismatch REFUSES with a
 *    reason (degrade-safe) — the planner never guesses from stale evidence.
 *  - NO AUTONOMOUS REPLAY: only PROVABLY-UNSTARTED work (`interrupted` ∧
 *    (`startedAt == null` ∨ result ∈ PRE_LAUNCH_INTERRUPT_RESULTS, i.e. no
 *    vendor process was EVER launched)) is planned as `redispatch-fresh`, and
 *    even that executes only under an explicit `--execute`. Everything
 *    uncertain is `human-review`, re-dispatchable only via a per-job
 *    `--redispatch <jobId>`. An original already claimed by a prior resume (its
 *    append-once `resumedAt` stamp set) is `already-resumed`: reported and
 *    skipped, never re-dispatched — the redispatch route refuses it too (409).
 *  - FAIL-CLOSED GATES: a consumed gate is terminally spent; an approved-but-
 *    unconsumed command approval is expired-undelivered (the vendor provably
 *    never received the allow) — NEITHER ever revalidates. A pending gate
 *    survives untouched and goes to the human (`decide-gate`); deciding stays
 *    operator-only at the approvals route.
 *  - FRESH JOBS ONLY: a re-dispatch is a NEW job via the existing dispatch
 *    route carrying `resumedFromJobId` lineage. It is deliberately a new ROOT:
 *    budgets fresh, delegation fences unweakened — never `parentJobId` /
 *    `rootJobId`, never an in-place mutation of the interrupted row.
 *  - PURE + DETERMINISTIC (run-bundle discipline): no node built-ins, no I/O;
 *    the sha256 hasher is injected.
 */

export type RedispatchInput = {
  kind?: DispatchKind;
  vendor: string;
  taskId: string;
  brief: string;
  harnessKey?: string;
  workspacePath?: string;
  chatId?: string;
  maxWallMs?: number;
  maxIterations?: number;
  checks?: HarnessCheck[];
  iterationTimeoutMs?: number;
  approvalTimeoutMs?: number;
  resumeVendorSessionId?: string;
  model?: string;
  /**
   * ADR-0013 #52 v2 action fidelity: a resumed action job MUST re-run the SAME
   * vendor invocation the human dispatched. `action` is the resolved action id
   * (the route re-resolves + re-enforces it server-side); the resolved
   * `actionArgvOverride`/`actionBriefPrefix` ride along so the fresh job is
   * faithful to the original rather than collapsing to the plain brief.
   */
  action?: string;
  actionArgvOverride?: { command?: string; args: string[] };
  actionBriefPrefix?: string;
  /** Resume lineage: the terminal job this fresh dispatch was re-created from. */
  resumedFromJobId: string;
};

export type ResumeAction =
  /** Zero writes; the next live runner claims it. */
  | { kind: "none-still-queued"; jobId: string }
  /** status=running with a (possibly dead) lease: the successor runner's startup reclaim owns reconciliation. */
  | { kind: "await-runner-reclaim"; jobId: string }
  /** The exact pending gate survives; the human decides in the inbox. If the session is dead the approval can never be delivered — reject, then redispatch. */
  | {
      kind: "decide-gate";
      jobId: string;
      approvalId: string;
      payloadDigest?: string;
      sessionInterrupted: boolean;
    }
  /** ONLY provably-unstarted work; still requires an explicit --execute. */
  | { kind: "redispatch-fresh"; jobId: string; dispatch: RedispatchInput }
  /**
   * The interrupted ORIGINAL was already claimed by a prior resume (its
   * append-once stamp is set), so a fresh child already carries this work.
   * Report-only, never re-dispatched — a second redispatch would duplicate the
   * child and replay its vendor side effects (P0.1 replay-safety).
   */
  | { kind: "already-resumed"; jobId: string; resumedByJobId: string | null }
  /** Uncertain outcome: re-dispatchable only via an explicit --redispatch <jobId>. */
  | {
      kind: "human-review";
      jobId: string;
      evidence: {
        vendor: string;
        jobKind: string;
        startedAt: string | null;
        endedAt: string | null;
        /** Redacted + bounded terminal narrative (payload-data, never trusted). */
        result: string | null;
        interruptedSessionIds: string[];
      };
    }
  /** Read-only re-hash of the still-on-disk worktree against the packet's diffHash. */
  | {
      kind: "verify-artifacts";
      jobId: string;
      taskId: string;
      workspacePath: string | null;
      diffHash?: string;
    };

export type ResumePlan = {
  /** Corrupt/stale input refuses with a reason — never guesses. */
  refused?: { reason: string };
  lineage: { live: string | null; bundle: string | null; match: boolean | null };
  versionDrift: Array<{
    vendor: string;
    exported: string | null;
    live: string | null;
  }>;
  actions: ResumeAction[];
  invariants: {
    planIsReadOnly: true;
    noAutonomousReplay: true;
    consumedGatesNeverRevalidate: true;
  };
};

export type ResumePlanInput = {
  live: {
    jobs: DispatchJobRecord[];
    approvals: ApprovalRequest[];
    sessions: LaneSession[];
  };
  bundle?: RunBundle;
  livePreflight?: CapabilityPreflight | null;
  sha256Hex?: (text: string) => string;
};

export type ResumeGateClass =
  | "pending"
  | "spent"
  | "approved-undelivered"
  | "decided";

/**
 * Fail-closed gate classification. `consumedAt != null` is terminally SPENT.
 * `approved ∧ consumedAt == null ∧ kind == "command"` is expired-undelivered:
 * the vendor blocked inside canUseTool and provably never received the allow —
 * re-approval is required (the resumed session files a NEW approval with the
 * same payloadDigest). Neither EVER revalidates on resume.
 */
export function classifyGate(approval: ApprovalRequest): ResumeGateClass {
  if (approval.consumedAt != null) return "spent";
  if (approval.status === "pending") return "pending";
  if (approval.status === "approved" && approval.kind === "command") {
    return "approved-undelivered";
  }
  return "decided";
}

/** Bound + scrub a job's free-text result for plan evidence (payload-data). */
function evidenceResult(result: string | null | undefined): string | null {
  if (result == null) return null;
  return redactSecrets(result).slice(0, 500);
}

/** The validated model override riding the action patch, if any. */
function modelOverride(job: DispatchJobRecord): string | undefined {
  const patch = job.actionProfilePatch;
  if (patch && typeof patch === "object" && typeof patch.model === "string") {
    return patch.model;
  }
  return undefined;
}

/**
 * Copy the original manifest into a FRESH dispatch (new id, new root; lineage
 * via `resumedFromJobId` only). Kind-scoped fields are copied only where the
 * dispatch schema admits them (loop-only / session-only guards), and a vendor
 * session handle rides only when the driver can actually resume it.
 */
export function buildRedispatchInput(
  job: DispatchJobRecord,
  sessions: LaneSession[]
): RedispatchInput {
  const input: RedispatchInput = {
    // The row's kind came through the dispatch schema's closed enum; the
    // route re-validates on the fresh POST regardless.
    kind: job.kind as DispatchKind,
    vendor: job.vendor,
    taskId: job.taskId,
    brief: job.brief,
    resumedFromJobId: job.id,
  };
  if (job.harnessKey != null) input.harnessKey = job.harnessKey;
  if (job.workspacePath != null) input.workspacePath = job.workspacePath;
  if (job.chatId != null) input.chatId = job.chatId;
  if (job.maxWallMs != null) input.maxWallMs = job.maxWallMs;
  const model = modelOverride(job);
  if (model !== undefined) input.model = model;
  // Carry the vendor-native action forward faithfully. Without this, a resumed
  // action job (e.g. `muon dispatch --action review`) would land with a null
  // action and run the plain brief under the default argv — a DIFFERENT vendor
  // invocation than the human dispatched and chose to resume.
  if (job.action != null) input.action = job.action;
  if (job.actionArgvOverride != null) {
    input.actionArgvOverride = job.actionArgvOverride;
  }
  if (job.actionBriefPrefix != null) {
    input.actionBriefPrefix = job.actionBriefPrefix;
  }
  if (job.kind === "loop") {
    if (job.maxIterations != null) input.maxIterations = job.maxIterations;
    if (job.checks != null) input.checks = job.checks;
    if (job.iterationTimeoutMs != null) {
      input.iterationTimeoutMs = job.iterationTimeoutMs;
    }
  }
  if (job.kind === "session") {
    if (job.approvalTimeoutMs != null) {
      input.approvalTimeoutMs = job.approvalTimeoutMs;
    }
    if (sessionCapability(job.vendor).canResume) {
      const handle = sessions.find(
        (session) => session.jobId === job.id && session.vendorSessionId
      )?.vendorSessionId;
      if (handle) input.resumeVendorSessionId = handle.slice(0, 512);
    }
  }
  return input;
}

const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "interrupted"]);

function jobIsProvablyUnstarted(job: DispatchJobRecord): boolean {
  return (
    job.status === "interrupted" &&
    (isPreLaunchInterrupt(job.result) || job.startedAt == null)
  );
}

/**
 * The append-once resume claim (P0.1 replay-safety): a set `resumedAt` /
 * `resumedByJobId` means a fresh child already claimed this original. Such a
 * row is never re-dispatched again — the redispatch route also refuses it (409)
 * — so the planner reports it as `already-resumed` instead of `redispatch-fresh`
 * or `human-review`.
 */
function jobAlreadyResumed(job: DispatchJobRecord): boolean {
  return job.resumedAt != null || job.resumedByJobId != null;
}

/** Extract a validated packet diffHash without trusting the raw column. */
function packetDiffHash(job: DispatchJobRecord): string | undefined {
  if (job.packetJson == null) return undefined;
  const parsed = handoffPacketSchema.safeParse(job.packetJson);
  return parsed.success ? parsed.data.diffHash : undefined;
}

function planVersionDrift(
  bundle: RunBundle | undefined,
  livePreflight: CapabilityPreflight | null | undefined
): ResumePlan["versionDrift"] {
  // Drift is only meaningful against EXPORTED evidence. With no bundle (the
  // common local-kill recovery: `muon bundle resume <jobId> --execute` without
  // `--from`), the live ledger is the sole authority — there is nothing to
  // compare against, so comparing every installed vendor to an EMPTY export set
  // would manufacture phantom drift and refuse the primary recovery path 100%
  // of the time. Return no drift and let the live plan proceed.
  if (!bundle?.capabilityPreflight) return [];
  const exported = new Map<string, string | null>(
    (bundle?.capabilityPreflight?.vendors ?? []).map((vendor) => [
      vendor.vendor,
      vendor.cliVersion ?? null,
    ])
  );
  const live = new Map<string, string | null>(
    (livePreflight?.vendors ?? []).map((vendor) => [
      vendor.vendor,
      vendor.cliVersion ?? null,
    ])
  );
  const vendors = [...new Set([...exported.keys(), ...live.keys()])].sort();
  const drift: ResumePlan["versionDrift"] = [];
  for (const vendor of vendors) {
    const exportedVersion = exported.get(vendor) ?? null;
    const liveVersion = live.get(vendor) ?? null;
    if (exportedVersion === liveVersion) continue;
    if (exportedVersion === null && liveVersion === null) continue;
    drift.push({ vendor, exported: exportedVersion, live: liveVersion });
  }
  return drift;
}

/**
 * Build the read-only resume plan. Deterministic; performs NO I/O; every
 * mutation it proposes still requires the human's explicit `--execute` /
 * `--redispatch` over the existing dispatch route (no new authority).
 */
export function planResume(input: ResumePlanInput): ResumePlan {
  const invariants = {
    planIsReadOnly: true as const,
    noAutonomousReplay: true as const,
    consumedGatesNeverRevalidate: true as const,
  };
  const versionDrift = planVersionDrift(input.bundle, input.livePreflight);

  // ---- reconcile: live ledger is authority, the bundle is evidence ----
  let lineage: ResumePlan["lineage"] = {
    live: null,
    bundle: input.bundle?.checkpoint?.lineageDigest ?? null,
    match: null,
  };
  const refuse = (reason: string): ResumePlan => ({
    refused: { reason },
    lineage,
    versionDrift,
    actions: [],
    invariants,
  });

  if (input.bundle && !input.bundle.checkpoint) {
    return refuse(
      "bundle predates the v2 checkpoint contract (no checkpoint section); re-export with the current CLI"
    );
  }

  if (input.sha256Hex) {
    if (input.bundle) {
      // Recompute the LIVE digest over exactly the job set the bundle names,
      // so a later fresh redispatch never disturbs the original comparison.
      const bundleIds = new Set(
        input.bundle.manifest.jobs.map((job) => job.id)
      );
      const liveById = new Map(input.live.jobs.map((job) => [job.id, job]));
      const missing = [...bundleIds].filter((id) => !liveById.has(id));
      if (missing.length > 0) {
        lineage = { ...lineage, match: false };
        return refuse(
          `live ledger is missing ${missing.length} job(s) the bundle names (${missing
            .slice(0, 5)
            .join(", ")}); refusing to plan from mismatched evidence`
        );
      }
      const liveSubset = [...bundleIds].map(
        (id) => liveById.get(id) as DispatchJobRecord
      );
      const liveDigest = computeLineageDigest(liveSubset, input.sha256Hex);
      const bundleDigest = input.bundle.checkpoint.lineageDigest;
      lineage = {
        live: liveDigest,
        bundle: bundleDigest,
        match: bundleDigest === null ? null : liveDigest === bundleDigest,
      };
      if (lineage.match === false) {
        return refuse(
          "lineage digest mismatch: the live ledger does not match the bundle's immutable manifest (stale or corrupt bundle); refusing to plan from it"
        );
      }
    } else {
      lineage = {
        live: computeLineageDigest(input.live.jobs, input.sha256Hex),
        bundle: null,
        match: null,
      };
    }
  }

  // ---- per-job actions (live rows only) ----
  const actions: ResumeAction[] = [];
  for (const job of input.live.jobs) {
    const pendingGates = input.live.approvals.filter(
      (approval) =>
        approval.jobId === job.id && classifyGate(approval) === "pending"
    );
    if (pendingGates.length > 0) {
      // The human decision comes FIRST; nothing else is planned for this job.
      const sessionInterrupted = input.live.sessions.some(
        (session) => session.jobId === job.id && session.status === "interrupted"
      );
      for (const gate of pendingGates) {
        actions.push({
          kind: "decide-gate",
          jobId: job.id,
          approvalId: gate.id,
          ...(gate.evidence?.payloadDigest !== undefined
            ? { payloadDigest: gate.evidence.payloadDigest }
            : {}),
          sessionInterrupted,
        });
      }
      continue;
    }

    if (job.status === "queued") {
      actions.push({ kind: "none-still-queued", jobId: job.id });
      continue;
    }
    if (job.status === "running") {
      actions.push({ kind: "await-runner-reclaim", jobId: job.id });
      continue;
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      continue; // unknown status: plan nothing rather than guess
    }
    if (jobAlreadyResumed(job)) {
      // The append-once claim is already spent: a fresh child carries this
      // work. Report + skip — never redispatch-fresh (that duplicates side
      // effects), never human-review (the human already resumed it).
      actions.push({
        kind: "already-resumed",
        jobId: job.id,
        resumedByJobId: job.resumedByJobId ?? null,
      });
      continue;
    }
    if (jobIsProvablyUnstarted(job)) {
      actions.push({
        kind: "redispatch-fresh",
        jobId: job.id,
        dispatch: buildRedispatchInput(job, input.live.sessions),
      });
      continue;
    }
    // A budget kill is `failed` (nobody interrupted it), but for RESUME it is
    // the same situation as an interrupt: MUON stopped a vendor mid-work, so
    // there may be partial, unverified side effects in the workspace and the
    // planner must not treat it as a finished run with nothing to resume. Same
    // human-review action, never an autonomous replay.
    //
    // The SAME two classes the dispatch route admits for `resumedFromJobId`
    // (backend resume lineage guard) and the reconciler gates on
    // (isUncertainTerminalOutcome), so the `--redispatch <jobId>` this action
    // advertises is one the backend actually accepts.
    if (isUncertainTerminalOutcome(job)) {
      actions.push({
        kind: "human-review",
        jobId: job.id,
        evidence: {
          vendor: job.vendor,
          jobKind: job.kind,
          startedAt: job.startedAt ?? null,
          endedAt: job.endedAt ?? null,
          result: evidenceResult(job.result),
          interruptedSessionIds: input.live.sessions
            .filter(
              (session) =>
                session.jobId === job.id && session.status === "interrupted"
            )
            .map((session) => session.id),
        },
      });
      continue;
    }
    // done / failed: nothing to resume; verify artifact evidence read-only.
    const diffHash = packetDiffHash(job);
    if (diffHash !== undefined) {
      actions.push({
        kind: "verify-artifacts",
        jobId: job.id,
        taskId: job.taskId,
        workspacePath: job.workspacePath ?? null,
        diffHash,
      });
    }
  }

  return { lineage, versionDrift, actions, invariants };
}
