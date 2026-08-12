import { getVendorReadinessCached } from "@muon/adapters";
import { proposeWorkflowViaLane } from "@muon/core";
import {
  coordinatorPreference,
  plannerVendorIds,
  type WorkflowProposal,
} from "@muon/protocol";
import { prisma } from "./db.js";

// A workflow plan is the input to every later step, so it stays on a lane MUON
// can hold a full planning conversation with. This is a QUALITY preference among
// ready vendors, not an authority boundary (that lives on the role below).
//
// WAVE E (ADR-0022 §4): the operator preference INTERSECTED with the vendors
// that actually hold `authority.planner`. Intersected, never unioned — an
// operator naming an unauthorized vendor in their preference must not thereby
// make it a planner.
const PLANNER_LANE_PREFERENCE: readonly string[] = coordinatorPreference().filter(
  (vendor) => plannerVendorIds().includes(vendor)
);
const PLANNER_HARNESS_KEY = "planner";
const PLANNER_ROLE = "architect";
import { RUNNER_LIVE_WINDOW_MS } from "./runner-lease.js";
const PLANNER_TERMINAL_WAIT_MS = 135_000;
const PLANNER_POLL_MS = 250;
const TERMINAL_DISPATCH_STATUSES = new Set([
  "done",
  "failed",
  "interrupted",
]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function dispatchPlannerTask(input: {
  vendor: string;
  taskId: string;
  brief: string;
  workspacePath?: string;
}): Promise<{ exitCode: number; output: string }> {
  const runner = await prisma.runner.findFirst({
    where: {
      lastSeenAt: {
        gte: new Date(Date.now() - RUNNER_LIVE_WINDOW_MS),
      },
    },
    select: { id: true },
  });
  if (!runner) {
    throw new Error(
      "No live lease-fenced runner is available for workflow planning."
    );
  }

  const job = await prisma.dispatchJob.create({
    data: {
      kind: "oneshot",
      vendor: input.vendor,
      taskId: input.taskId,
      brief: input.brief,
      harnessKey: PLANNER_HARNESS_KEY,
      // The planner run IS the architect role (read-only, proposes a plan and
      // never a patch). Stamped here because this is the one dispatch that is
      // created directly on the ledger rather than through the dispatch route,
      // and a roleless job cannot be narrowed or coordinate over A2A.
      role: PLANNER_ROLE,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      dispatchedBy: "system:workflow-planner",
    },
  });

  const deadline = Date.now() + PLANNER_TERMINAL_WAIT_MS;
  for (;;) {
    const current = await prisma.dispatchJob.findUnique({
      where: { id: job.id },
    });
    if (!current) {
      throw new Error(`Planner dispatch '${job.id}' disappeared.`);
    }
    if (TERMINAL_DISPATCH_STATUSES.has(current.status)) {
      if (current.status === "done" && (current.exitCode ?? 0) === 0) {
        return {
          exitCode: current.exitCode ?? 0,
          output: current.result ?? "",
        };
      }
      throw new Error(
        `Planner dispatch ${current.status}: ${
          current.result?.trim() || "no result was recorded"
        }`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Planner dispatch '${job.id}' did not reach a terminal state within ${PLANNER_TERMINAL_WAIT_MS}ms.`
      );
    }
    await delay(PLANNER_POLL_MS);
  }
}

export async function planWorkflowViaAvailableLane(args: {
  request: string;
  workspacePath?: string;
  taskId: string;
  laneKeys: string[];
  harnessKeys: string[];
  templateKeys: string[];
}): Promise<{ proposal: WorkflowProposal; plannerLaneKey: string }> {
  const readiness = await getVendorReadinessCached();
  const readyLaneKeys = PLANNER_LANE_PREFERENCE.filter(
    (laneKey) =>
      args.laneKeys.includes(laneKey) &&
      readiness.some(
        (entry) =>
          entry.vendor === laneKey &&
          entry.installed &&
          entry.authenticated
      )
  );
  const plannerLaneKey = readyLaneKeys[0];
  if (!plannerLaneKey) {
    throw new Error(
      "No dispatch-ready planner lane is available. Connect Claude Code or Codex, then retry."
    );
  }

  const proposal = await proposeWorkflowViaLane({
    request: args.request,
    context: {
      laneKeys: readyLaneKeys,
      harnessKeys: args.harnessKeys,
      templateKeys: args.templateKeys,
    },
    runTask: ({ brief }) =>
      dispatchPlannerTask({
        vendor: plannerLaneKey,
        taskId: args.taskId,
        brief,
        workspacePath: args.workspacePath,
      }),
  });

  return { proposal, plannerLaneKey };
}
