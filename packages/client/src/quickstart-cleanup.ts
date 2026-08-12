import { QUICKSTART_TASK_MARKER } from "./quickstart.js";
import type {
  ApprovalRequest,
  DispatchJobRecord,
  Task,
  TaskStatus,
} from "./types.js";

/**
 * BUG 1(b), BOOT CLEANUP for a STALE quickstart first-task.
 *
 * A quickstart job stranded QUEUED in an earlier session gets re-picked by the
 * runner on every launch, which re-requests its Bash approvals and re-fires the
 * "review required" modals + notifications. This clears that stale work WITHOUT
 * touching the user's data dir: it interrupts the lingering quickstart task's
 * non-terminal jobs, rejects its pending approvals, and parks the task itself.
 *
 * SAFETY: it is MARKER-SCOPED and IDEMPOTENT. Only tasks whose title carries
 * {@link QUICKSTART_TASK_MARKER} are ever touched, so real work is never
 * disturbed; already-terminal jobs / decided approvals are skipped, so a second
 * run is a no-op. Every step is best-effort and defensive — a single failed call
 * never aborts the rest (this runs at boot and must never wedge startup).
 *
 * Pure over a minimal client surface so it tests deterministically and can run
 * from any operator-tier surface (desktop boot, a backend script, the CLI).
 */

/** The operator-tier client surface the cleanup drives — all already on the
 *  MuonApiClient, and trivially mockable in tests. */
export type QuickstartCleanupClient = {
  listTasks(): Promise<Task[]>;
  listDispatchJobs(filter?: {
    activeOnly?: boolean;
    limit?: number;
  }): Promise<DispatchJobRecord[]>;
  listApprovals(): Promise<ApprovalRequest[]>;
  interruptDispatchJob(jobId: string): Promise<void>;
  resolveApproval(input: {
    approvalId: string;
    status: "approved" | "rejected";
    decisionNotes?: string;
  }): Promise<unknown>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task>;
};

export type QuickstartCleanupResult = {
  /** Quickstart task ids that were parked. */
  tasks: string[];
  /** Non-terminal quickstart job ids that were interrupted. */
  jobs: string[];
  /** Pending quickstart approval ids that were rejected. */
  approvals: string[];
};

const NON_TERMINAL_JOB = new Set(["queued", "running"]);

/** True when `task` is a quickstart-seeded sample (matched on the stable title
 *  marker, so it also matches a task seeded by an older build). */
export function isQuickstartTask(task: Pick<Task, "title">): boolean {
  return task.title.startsWith(QUICKSTART_TASK_MARKER);
}

/**
 * Clear any lingering quickstart task + its non-terminal jobs + pending
 * approvals. Returns the ids it touched (empty when there is nothing stale).
 * Never throws: list failures degrade to "nothing found" and per-item failures
 * are swallowed, so it is safe to await on the startup path.
 */
export async function cleanupQuickstartTasks(
  client: QuickstartCleanupClient
): Promise<QuickstartCleanupResult> {
  const result: QuickstartCleanupResult = { tasks: [], jobs: [], approvals: [] };

  const allTasks = await client.listTasks().catch(() => [] as Task[]);
  const quickstartTasks = allTasks.filter(isQuickstartTask);
  if (quickstartTasks.length === 0) {
    return result;
  }
  const quickstartTaskIds = new Set(quickstartTasks.map((task) => task.id));

  // 1) Interrupt the non-terminal jobs — the actual source of the re-firing
  //    approvals. A queued job terminalizes at the interrupt route, so the
  //    runner can never re-pick it. Skip jobs already terminal or already
  //    cancelling (idempotent, and avoids the route's cancel-fence conflict).
  const jobs = await client
    .listDispatchJobs({ limit: 500 })
    .catch(() => [] as DispatchJobRecord[]);
  const staleJobs = jobs.filter(
    (job) =>
      quickstartTaskIds.has(job.taskId) &&
      NON_TERMINAL_JOB.has(String(job.status)) &&
      !job.interruptRequested
  );
  await Promise.allSettled(
    staleJobs.map(async (job) => {
      await client.interruptDispatchJob(job.id);
      result.jobs.push(job.id);
    })
  );

  // 2) Reject the pending approvals so the "review required" modals stop.
  const approvals = await client
    .listApprovals()
    .catch(() => [] as ApprovalRequest[]);
  const staleApprovals = approvals.filter(
    (approval) =>
      approval.status === "pending" && quickstartTaskIds.has(approval.taskId)
  );
  await Promise.allSettled(
    staleApprovals.map(async (approval) => {
      await client.resolveApproval({
        approvalId: approval.id,
        status: "rejected",
        decisionNotes: "cleared stale MUON quickstart sample on startup",
      });
      result.approvals.push(approval.id);
    })
  );

  // 3) Park the task itself. "done" is gated behind a ship review, so a stale
  //    sample can't take it — "blocked" is the reachable operator-tier way to
  //    retire it from the active surface. Best-effort; already-parked tasks and
  //    a backend refusal never abort the (already-completed) job/approval clear.
  await Promise.allSettled(
    quickstartTasks
      .filter((task) => task.status !== "blocked" && task.status !== "done")
      .map(async (task) => {
        await client.updateTaskStatus(task.id, "blocked");
        result.tasks.push(task.id);
      })
  );

  return result;
}
