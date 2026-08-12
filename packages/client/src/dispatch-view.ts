import type { DispatchJobRecord } from "./types.js";

export type DispatchTreeAuthority = "orchestrator" | "work only" | "worker";

export type DispatchTreeNode = {
  id: string;
  parentJobId: string | null;
  rootJobId: string;
  vendor: string;
  status: string;
  brief: string;
  taskId: string;
  depth: number;
  maxDepth: number | null;
  authority: DispatchTreeAuthority;
  // Wave 4.2 crew-liveness inputs (carried so a renderer can derive the live
  // state without a second fetch). `startedAt` is the LAUNCH instant (the start
  // of the startup window, matching the runner watchdog — never the enqueue
  // time); `lastProgressAt` is the last output heartbeat (null = no output yet).
  createdAt: string;
  startedAt: string | null;
  lastProgressAt: string | null;
  waitingApproval: boolean;
  currentActivity: string | null;
  exitCode: number | null;
  result: string | null;
  children: DispatchTreeNode[];
};

export type DispatchForestSummary = {
  active: number;
  usedDepth: number;
  maxDepth: number | null;
  childrenIssued: number;
  maxChildren: number | null;
  descendantsIssued: number;
  maxDescendants: number | null;
  reservedWallMs: number;
  // S9 budget accounting. `descendantPoolMs` is the root's fleet-scaled pool
  // (v2), falling back to the root's own turn budget (`rootWallMs`) for a v1
  // root. `remainingWallMs = pool − reserved − consumed`, floored at 0. Aggregate
  // (multi-mission) summaries sum the spends and leave `descendantPoolMs` null.
  consumedWallMs: number;
  descendantPoolMs: number | null;
  remainingWallMs: number;
  rootWallMs: number | null;
  deadlineAt: string | null;
};

export type DispatchForest = {
  roots: DispatchTreeNode[];
  missions: Array<{
    root: DispatchTreeNode;
    summary: DispatchForestSummary;
  }>;
  summary: DispatchForestSummary;
  degraded: boolean;
  degradationReason: string | null;
};

function authorityOf(job: DispatchJobRecord): DispatchTreeAuthority {
  if (job.capabilityMode === "orchestrator") return "orchestrator";
  if (job.capabilityMode === "delegate") return "work only";
  return "worker";
}

function newestFirst(a: DispatchTreeNode, b: DispatchTreeNode): number {
  return b.id.localeCompare(a.id);
}

function nodesWithin(root: DispatchTreeNode): DispatchTreeNode[] {
  return [root, ...root.children.flatMap(nodesWithin)];
}

/**
 * Browser-safe dispatch projection shared by UI surfaces. Lineage is treated
 * as display data only: malformed/missing parents degrade visibly and never
 * acquire authority through this projection.
 */
export function buildDispatchForest(
  jobs: DispatchJobRecord[]
): DispatchForest {
  const lineageJobs = jobs.filter(
    (job) =>
      job.capabilityMode === "orchestrator" ||
      job.capabilityMode === "delegate" ||
      Boolean(job.parentJobId || job.rootJobId)
  );
  const byId = new Map<string, DispatchTreeNode>();
  const sourceById = new Map<string, DispatchJobRecord>();
  for (const job of lineageJobs) {
    sourceById.set(job.id, job);
    byId.set(job.id, {
      id: job.id,
      parentJobId: job.parentJobId ?? null,
      rootJobId: job.rootJobId ?? job.id,
      vendor: job.vendor,
      status: job.status,
      brief: job.brief,
      taskId: job.taskId,
      depth: job.delegationDepth ?? 0,
      maxDepth: job.maxDelegationDepth ?? null,
      authority: authorityOf(job),
      createdAt: job.createdAt ?? new Date(0).toISOString(),
      startedAt: job.startedAt ?? null,
      lastProgressAt: job.lastProgressAt ?? null,
      waitingApproval: job.waitingApproval ?? false,
      currentActivity: job.currentActivity ?? null,
      exitCode: job.exitCode ?? null,
      result: job.result ?? null,
      children: [],
    });
  }

  const roots: DispatchTreeNode[] = [];
  let malformedLineage = false;
  for (const node of byId.values()) {
    if (!node.parentJobId) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parentJobId);
    if (!parent || parent.depth >= node.depth) {
      malformedLineage = true;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  for (const node of byId.values()) {
    node.children.sort(newestFirst);
  }
  roots.sort(newestFirst);

  const missions = roots.map((root) => {
    const nodes = nodesWithin(root);
    const rootSource = sourceById.get(root.id);
    const reservedWallMs = rootSource?.delegationBudgetReservedMs ?? 0;
    const consumedWallMs = rootSource?.delegationBudgetConsumedMs ?? 0;
    // v2 pool if present, else the root's own turn budget (v1 semantics).
    const descendantPoolMs =
      rootSource?.maxDescendantWallMs ?? rootSource?.maxWallMs ?? null;
    return {
      root,
      summary: {
        active: nodes.filter((node) =>
          ["queued", "running"].includes(node.status)
        ).length,
        usedDepth: nodes.reduce(
          (max, node) => Math.max(max, node.depth),
          root.depth
        ),
        maxDepth: rootSource?.maxDelegationDepth ?? null,
        childrenIssued: rootSource?.delegationChildrenIssued ?? 0,
        maxChildren: rootSource?.maxChildren ?? null,
        descendantsIssued:
          rootSource?.delegationDescendantsIssued ??
          Math.max(0, nodes.length - 1),
        maxDescendants: rootSource?.maxTotalDescendants ?? null,
        reservedWallMs,
        consumedWallMs,
        descendantPoolMs,
        remainingWallMs:
          descendantPoolMs === null
            ? 0
            : Math.max(0, descendantPoolMs - reservedWallMs - consumedWallMs),
        rootWallMs: rootSource?.maxWallMs ?? null,
        deadlineAt: rootSource?.delegationDeadline ?? null,
      },
    };
  });
  const summary =
    missions.length === 1
      ? missions[0]!.summary
      : {
          active: missions.reduce(
            (total, mission) => total + mission.summary.active,
            0
          ),
          usedDepth: missions.reduce(
            (max, mission) => Math.max(max, mission.summary.usedDepth),
            0
          ),
          maxDepth: null,
          childrenIssued: missions.reduce(
            (total, mission) => total + mission.summary.childrenIssued,
            0
          ),
          maxChildren: null,
          descendantsIssued: missions.reduce(
            (total, mission) => total + mission.summary.descendantsIssued,
            0
          ),
          maxDescendants: null,
          reservedWallMs: missions.reduce(
            (total, mission) => total + mission.summary.reservedWallMs,
            0
          ),
          consumedWallMs: missions.reduce(
            (total, mission) => total + mission.summary.consumedWallMs,
            0
          ),
          // A pool is per-root; there is no single aggregate pool across
          // independent missions, so leave it null (like rootWallMs/maxDepth).
          descendantPoolMs: null,
          remainingWallMs: missions.reduce(
            (total, mission) => total + mission.summary.remainingWallMs,
            0
          ),
          rootWallMs: null,
          deadlineAt: null,
        };

  return {
    roots,
    missions,
    summary,
    degraded: malformedLineage,
    degradationReason: malformedLineage
      ? "Some dispatch lineage is incomplete; review the audit trail before acting."
      : null,
  };
}
