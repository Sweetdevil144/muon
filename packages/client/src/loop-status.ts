import {
  isPreLaunchInterrupt,
  isUncertainTerminalOutcome,
  type LoopProgress,
} from "@muon/protocol";
import type { DispatchJobRecord, LoopRunRecord, LoopRunStatus } from "./types.js";

/**
 * P9 — live objective-loop status for conversational surfaces.
 *
 * The judge's `missing:` text is evaluator model output — loop control state
 * only. It must never become a MemoryNote or enter recallForGate (ADR-0018).
 */
export type ObjectiveLoopControl = {
  loopId: string;
  taskId: string;
  kind: string;
  status: LoopRunStatus;
  iteration: number;
  maxIterations: number;
  /** Evaluator/judge output when the last verdict failed. Control state only. */
  missing: string | null;
  degraded: string | null;
  stopReason: string | null;
  /** One-line operator headline, e.g. "iteration 2/3 · missing: …" */
  headline: string;
  canStop: boolean;
  canResume: boolean;
  resumeFromJobId: string | null;
  resumeBlockedReason: string | null;
};

const TERMINAL_LOOP = new Set<LoopRunStatus>([
  "passed",
  "escalated",
  "exhausted",
  "aborted",
]);

const ACTIVE_DISPATCH = new Set(["queued", "running"]);

/** Bound evaluator prose for UI/control surfaces — never trusted memory. */
export function extractLoopMissing(
  progress: LoopProgress | null | undefined
): string | null {
  const evaluator = progress?.evaluator;
  if (!evaluator || evaluator.pass) {
    return null;
  }
  const hints = evaluator.fixHints.slice(0, 3);
  const body =
    hints.length > 0
      ? `${evaluator.reason} (${hints.join("; ")})`
      : evaluator.reason;
  return body.slice(0, 500);
}

export function formatObjectiveLoopHeadline(input: {
  iteration: number;
  maxIterations: number;
  status: LoopRunStatus;
  missing: string | null;
  degraded?: string | null;
}): string {
  const progress =
    input.status === "running"
      ? `iteration ${input.iteration}/${input.maxIterations}`
      : `${input.status} · ${input.iteration}/${input.maxIterations}`;
  if (input.missing) {
    return `${progress} · missing: ${input.missing}`;
  }
  if (input.degraded) {
    return `${progress} · degraded: ${input.degraded}`;
  }
  return progress;
}

export function pickPrimaryLoopForTask(
  loops: readonly LoopRunRecord[],
  taskId: string
): LoopRunRecord | null {
  const scoped = loops.filter((loop) => loop.taskId === taskId);
  if (scoped.length === 0) {
    return null;
  }
  return [...scoped].sort((a, b) => {
    const aActive = a.status === "running" ? 1 : 0;
    const bActive = b.status === "running" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aMs = Date.parse(a.startedAt);
    const bMs = Date.parse(b.startedAt);
    return bMs - aMs;
  })[0]!;
}

export function findLoopDispatchJob(
  jobs: readonly DispatchJobRecord[],
  taskId: string,
  dispatchJobId?: string | null
): DispatchJobRecord | null {
  if (dispatchJobId) {
    return (
      jobs.find(
        (job) =>
          job.id === dispatchJobId &&
          job.taskId === taskId &&
          job.kind === "loop"
      ) ?? null
    );
  }
  // Legacy fallback for pre-0051 LoopRun rows. New rows never infer identity
  // from task recency because two loops may legitimately share one task.
  const scoped = jobs.filter(
    (job) => job.taskId === taskId && job.kind === "loop"
  );
  if (scoped.length === 0) {
    return null;
  }
  return [...scoped].sort((a, b) => {
    const rank = (job: DispatchJobRecord) =>
      job.status === "running" || job.status === "queued"
        ? 2
        : job.status === "interrupted" || job.status === "failed"
          ? 1
          : 0;
    const delta = rank(b) - rank(a);
    if (delta !== 0) return delta;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  })[0]!;
}

function resumeEligibility(
  loop: LoopRunRecord,
  job: DispatchJobRecord | null | undefined
): Pick<
  ObjectiveLoopControl,
  "canResume" | "resumeFromJobId" | "resumeBlockedReason"
> {
  if (loop.status === "running") {
    return {
      canResume: false,
      resumeFromJobId: null,
      resumeBlockedReason: "This loop is still running.",
    };
  }
  if (loop.status === "passed") {
    return {
      canResume: false,
      resumeFromJobId: null,
      resumeBlockedReason: "This loop already passed.",
    };
  }
  if (!job) {
    return {
      canResume: false,
      resumeFromJobId: null,
      resumeBlockedReason: "No loop dispatch job is recorded for this task.",
    };
  }
  if (job.resumedAt != null || job.resumedByJobId != null) {
    return {
      canResume: false,
      resumeFromJobId: job.id,
      resumeBlockedReason: "This loop dispatch was already resumed once.",
    };
  }
  if (ACTIVE_DISPATCH.has(job.status)) {
    return {
      canResume: false,
      resumeFromJobId: job.id,
      resumeBlockedReason: "The loop dispatch is still live.",
    };
  }
  if (loop.status === "aborted" && job.status === "interrupted") {
    return {
      canResume: true,
      resumeFromJobId: job.id,
      resumeBlockedReason: null,
    };
  }
  if (
    loop.status === "aborted" &&
    (job.status === "failed" || job.status === "interrupted")
  ) {
    return {
      canResume: true,
      resumeFromJobId: job.id,
      resumeBlockedReason: null,
    };
  }
  if (job.status === "interrupted" && isPreLaunchInterrupt(job.result)) {
    return {
      canResume: true,
      resumeFromJobId: job.id,
      resumeBlockedReason: null,
    };
  }
  if (isUncertainTerminalOutcome(job)) {
    return {
      canResume: true,
      resumeFromJobId: job.id,
      resumeBlockedReason: null,
    };
  }
  return {
    canResume: false,
    resumeFromJobId: job.id,
    resumeBlockedReason:
      loop.status === "escalated" || loop.status === "exhausted"
        ? "Escalated or exhausted loops need a fresh dispatch from chat."
        : "This loop cannot be resumed from its current ledger state.",
  };
}

export function buildObjectiveLoopStatus(
  loop: LoopRunRecord,
  job?: DispatchJobRecord | null
): ObjectiveLoopControl {
  const iteration = loop.progress?.iteration ?? loop.iterations;
  const maxIterations = loop.budget.maxIterations;
  const missing = extractLoopMissing(loop.progress);
  const degraded = loop.progress?.degraded ?? null;
  const resume = resumeEligibility(loop, job ?? null);
  return {
    loopId: loop.id,
    taskId: loop.taskId,
    kind: loop.kind,
    status: loop.status,
    iteration,
    maxIterations,
    missing,
    degraded,
    stopReason: loop.stopReason ?? null,
    headline: formatObjectiveLoopHeadline({
      iteration,
      maxIterations,
      status: loop.status,
      missing,
      degraded,
    }),
    canStop: loop.status === "running",
    ...resume,
  };
}

export function buildObjectiveLoopStatusForTask(input: {
  taskId: string;
  loops?: readonly LoopRunRecord[];
  jobs?: readonly DispatchJobRecord[];
}): ObjectiveLoopControl | null {
  const loop = pickPrimaryLoopForTask(input.loops ?? [], input.taskId);
  if (!loop) {
    return null;
  }
  const job = findLoopDispatchJob(
    input.jobs ?? [],
    input.taskId,
    loop.dispatchJobId
  );
  return buildObjectiveLoopStatus(loop, job);
}

export function loopCommitmentIsActive(status: LoopRunStatus): boolean {
  return status === "running";
}

export function loopCommitmentIsTerminal(status: LoopRunStatus): boolean {
  return TERMINAL_LOOP.has(status);
}
