import {
  buildObjectiveLoopStatus,
  findLoopDispatchJob,
} from "./loop-status.js";
import type {
  DispatchJobRecord,
  GovernedScheduleRecord,
  LoopRunRecord,
  WorkflowRunRecord,
} from "./types.js";

/**
 * TODO 5.17 — "Nothing runs that you cannot find here."
 *
 * One vocabulary for every autonomous commitment MUON already tracks: critique
 * loops, workflow runs, governed schedules, and live dispatched jobs. Pause
 * means "stop advancing without
 * deleting the record", which every kind below already has a status for.
 */

export type AutonomyCommitmentKind = "loop" | "workflow" | "dispatch" | "schedule";

export type AutonomyCommitment = {
  id: string;
  kind: AutonomyCommitmentKind;
  /** One-line operator label — never agent prose. */
  title: string;
  status: string;
  /** True when the commitment can still advance without a human. */
  active: boolean;
  /** True when a pause/abort affordance exists for this kind+status. */
  pausable: boolean;
  /** True when a human resume redispatch is available for this commitment. */
  resumable: boolean;
  startedAt?: string | null;
  /** Coordinates only — task / job / run ids for the pause path. */
  refs: {
    taskId?: string | null;
    jobId?: string | null;
    workflowRunId?: string | null;
    loopId?: string | null;
    scheduleId?: string | null;
  };
};

const ACTIVE_LOOP = new Set(["running"]);
const ACTIVE_DISPATCH = new Set(["queued", "running"]);

/**
 * Project the four existing ledgers into one sorted list. Active commitments
 * first (oldest first so the earliest promise is on top), then recently ended.
 */
export function buildAutonomyCommitments(input: {
  loops?: readonly LoopRunRecord[];
  workflows?: readonly WorkflowRunRecord[];
  dispatches?: readonly DispatchJobRecord[];
  schedules?: readonly GovernedScheduleRecord[];
}): AutonomyCommitment[] {
  const out: AutonomyCommitment[] = [];

  for (const loop of input.loops ?? []) {
    const active = ACTIVE_LOOP.has(loop.status);
    const dispatchJob = findLoopDispatchJob(
      input.dispatches ?? [],
      loop.taskId,
      loop.dispatchJobId
    );
    const control = buildObjectiveLoopStatus(loop, dispatchJob);
    out.push({
      id: `loop:${loop.id}`,
      kind: "loop",
      title: `Loop · ${loop.kind}${loop.harnessKey ? ` · ${loop.harnessKey}` : ""}`,
      status: control.headline,
      active,
      // Running loops abort; terminal ones are already paused.
      pausable: control.canStop,
      resumable: control.canResume,
      startedAt: loop.startedAt,
      refs: {
        taskId: loop.taskId,
        workflowRunId: loop.workflowRunId,
        loopId: loop.id,
        jobId: control.resumeFromJobId,
      },
    });
  }

  for (const run of input.workflows ?? []) {
    // `paused` is findable but not advancing — that is the whole point of Pause.
    const advancing =
      run.status === "running" ||
      run.status === "applied" ||
      run.status === "proposed";
    out.push({
      id: `workflow:${run.id}`,
      kind: "workflow",
      title: `Workflow · ${run.request.slice(0, 80) || run.id}`,
      status: run.status,
      active: advancing,
      pausable: run.status === "running" || run.status === "applied",
      resumable: false,
      startedAt: run.startedAt ?? run.createdAt,
      refs: { workflowRunId: run.id, taskId: run.chatId },
    });
  }

  for (const job of input.dispatches ?? []) {
    const active = ACTIVE_DISPATCH.has(job.status);
    out.push({
      id: `dispatch:${job.id}`,
      kind: "dispatch",
      title: `Dispatch · ${job.vendor}${job.role ? ` · ${job.role}` : ""}`,
      status: job.status,
      active,
      // Interrupt is the pause for a live job.
      pausable: job.status === "running",
      resumable: false,
      startedAt: job.startedAt ?? job.createdAt,
      refs: { jobId: job.id, taskId: job.taskId },
    });
  }

  for (const schedule of input.schedules ?? []) {
    const active = schedule.status === "active";
    out.push({
      id: `schedule:${schedule.id}`,
      kind: "schedule",
      title: `Schedule · ${schedule.title}`,
      status:
        schedule.lastStatus && schedule.status !== "active"
          ? `${schedule.status} · last ${schedule.lastStatus}`
          : schedule.status,
      active,
      pausable: active,
      resumable: false,
      startedAt: schedule.createdAt,
      refs: { scheduleId: schedule.id },
    });
  }

  return out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const aMs = a.startedAt ? Date.parse(a.startedAt) : 0;
    const bMs = b.startedAt ? Date.parse(b.startedAt) : 0;
    if (aMs !== bMs) return aMs - bMs;
    return a.id.localeCompare(b.id);
  });
}
