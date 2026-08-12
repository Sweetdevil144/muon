export type MetricsInput = {
  tasks: Array<{
    id: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  assignments: Array<{ taskId: string; summary: string; createdAt: Date }>;
  handoffs: Array<{ taskId: string; createdAt: Date }>;
  approvals: Array<{
    status: string;
    createdAt: Date;
    decidedAt: Date | null;
  }>;
  events: Array<{ taskId: string; kind: string; timestamp: Date }>;
};

export type CoordinationMetrics = {
  approvals: {
    decided: number;
    pending: number;
    averageTurnaroundMs: number | null;
    medianTurnaroundMs: number | null;
  };
  handoffs: {
    total: number;
    prepSamples: number;
    averagePrepMs: number | null;
    medianPrepMs: number | null;
  };
  assignments: {
    total: number;
    duplicateBriefings: number;
    tasksWithDuplicates: number;
  };
  tasks: {
    total: number;
    completed: number;
    averageCycleMs: number | null;
    medianCycleMs: number | null;
  };
};

function average(samples: number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

function median(samples: number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * Aggregates the go/no-go KPIs from ledger rows: approval turnaround,
 * handoff prep time (run completion -> handoff filed), duplicate briefing
 * count, and completed-task cycle time.
 */
export function computeMetrics(input: MetricsInput): CoordinationMetrics {
  const turnarounds = input.approvals
    .filter((approval) => approval.decidedAt !== null)
    .map(
      (approval) =>
        approval.decidedAt!.getTime() - approval.createdAt.getTime()
    );
  const pending = input.approvals.filter(
    (approval) => approval.status === "pending"
  ).length;

  // Prep time: how long after a lane finished (task.completed event) the
  // handoff packet for that task was filed.
  const completedEventsByTask = new Map<string, number[]>();
  for (const event of input.events) {
    if (event.kind !== "task.completed") {
      continue;
    }
    const list = completedEventsByTask.get(event.taskId) ?? [];
    list.push(event.timestamp.getTime());
    completedEventsByTask.set(event.taskId, list);
  }
  const prepTimes: number[] = [];
  for (const handoff of input.handoffs) {
    const handoffAt = handoff.createdAt.getTime();
    const candidates = (completedEventsByTask.get(handoff.taskId) ?? []).filter(
      (timestamp) => timestamp <= handoffAt
    );
    if (candidates.length === 0) {
      continue;
    }
    prepTimes.push(handoffAt - Math.max(...candidates));
  }

  const briefingCounts = new Map<string, { taskId: string; count: number }>();
  for (const assignment of input.assignments) {
    const key = `${assignment.taskId}\u0000${assignment.summary}`;
    const entry = briefingCounts.get(key) ?? {
      taskId: assignment.taskId,
      count: 0,
    };
    entry.count += 1;
    briefingCounts.set(key, entry);
  }
  let duplicateBriefings = 0;
  const tasksWithDuplicates = new Set<string>();
  for (const entry of briefingCounts.values()) {
    if (entry.count > 1) {
      duplicateBriefings += entry.count - 1;
      tasksWithDuplicates.add(entry.taskId);
    }
  }

  const cycleTimes = input.tasks
    .filter((task) => task.status === "done")
    .map((task) => task.updatedAt.getTime() - task.createdAt.getTime());

  return {
    approvals: {
      decided: turnarounds.length,
      pending,
      averageTurnaroundMs: average(turnarounds),
      medianTurnaroundMs: median(turnarounds),
    },
    handoffs: {
      total: input.handoffs.length,
      prepSamples: prepTimes.length,
      averagePrepMs: average(prepTimes),
      medianPrepMs: median(prepTimes),
    },
    assignments: {
      total: input.assignments.length,
      duplicateBriefings,
      tasksWithDuplicates: tasksWithDuplicates.size,
    },
    tasks: {
      total: input.tasks.length,
      completed: cycleTimes.length,
      averageCycleMs: average(cycleTimes),
      medianCycleMs: median(cycleTimes),
    },
  };
}
