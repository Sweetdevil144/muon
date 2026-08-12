import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import {
  heuristicWorkflowProposal,
  proposeWorkflowViaLane,
} from "@muon/core";
import {
  plannerVendorIds,
  vendorLabel,
  type VendorId,
  type WorkflowProposal,
} from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase } from "../lib/config.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printJson } from "../lib/output.js";

const PLANNER_TERMINAL_WAIT_MS = 135_000;
const PLANNER_POLL_MS = 500;
const TERMINAL_DISPATCH_STATUSES = new Set([
  "done",
  "failed",
  "interrupted",
]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPlannerDispatch(
  client: MuonApiClient,
  jobId: string
) {
  const deadline = Date.now() + PLANNER_TERMINAL_WAIT_MS;
  for (;;) {
    const job = await client.getDispatchJob(jobId);
    if (TERMINAL_DISPATCH_STATUSES.has(job.status)) {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Planner dispatch '${jobId}' did not reach a terminal state within ${PLANNER_TERMINAL_WAIT_MS}ms.`
      );
    }
    await delay(PLANNER_POLL_MS);
  }
}

export async function planWorkflowViaDispatch(args: {
  client: MuonApiClient;
  laneKey: string;
  request: string;
  taskId: string;
  workspacePath?: string;
  apiBase: string;
  /** RAW global flags for ensureRunner's credential↔base pairing. */
  apiBaseFlag?: string;
  apiTokenFlag?: string;
  context: Parameters<typeof proposeWorkflowViaLane>[0]["context"];
  ensureRunnerFn?: typeof ensureRunner;
}): Promise<WorkflowProposal> {
  // WAVE D: a POSITIVE predicate off `authority.planner`, replacing a hardcoded
  // `=== "cursor"` refusal whose prose ("readiness-only in MUON v0") stopped
  // being true when Cursor became a managed read-only lane on 2026-07-25. The
  // admitted set is unchanged for the vendors that were admitted before, and it
  // now also refuses a lane that simply has not earned planning — fail-closed,
  // where the old check let anything-but-cursor through.
  if (!plannerVendorIds().includes(args.laneKey as VendorId)) {
    throw new Error(
      `${vendorLabel(args.laneKey)} cannot plan work in MUON; choose one of: ${plannerVendorIds()
        .map((vendor) => vendorLabel(vendor))
        .join(", ")}.`
    );
  }
  const runner = await (args.ensureRunnerFn ?? ensureRunner)(args.client, {
    apiBase: args.apiBase,
    ...(args.apiBaseFlag !== undefined ? { apiBaseFlag: args.apiBaseFlag } : {}),
    ...(args.apiTokenFlag !== undefined
      ? { apiTokenFlag: args.apiTokenFlag }
      : {}),
  });
  if (!runner.live) {
    throw new Error(
      runner.note ??
        "No live lease-fenced runner is available for workflow planning.",
      // Keep the lease 401/403 classification for the exit-2 contract.
      { cause: runner.failure }
    );
  }

  return proposeWorkflowViaLane({
    request: args.request,
    context: args.context,
    runTask: async ({ brief }) => {
      const job = await args.client.enqueueDispatch({
        kind: "oneshot",
        vendor: args.laneKey,
        taskId: args.taskId,
        brief,
        harnessKey: "planner",
        ...(args.workspacePath
          ? { workspacePath: args.workspacePath }
          : {}),
      });
      const terminal = await waitForPlannerDispatch(args.client, job.id);
      if (
        terminal.status !== "done" ||
        (terminal.exitCode !== null &&
          terminal.exitCode !== undefined &&
          terminal.exitCode !== 0)
      ) {
        throw new Error(
          `Planner dispatch ${terminal.status}: ${
            terminal.result?.trim() || "no result was recorded"
          }`
        );
      }
      return {
        exitCode: terminal.exitCode ?? 0,
        output: terminal.result ?? "",
      };
    },
  });
}

function renderProposal(proposal: WorkflowProposal, runId: string): string {
  const lines: string[] = [
    `proposed plan (stored as run ${runId}, nothing is created yet):`,
    "",
  ];
  proposal.steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.priority}] ${step.title}`);
    if (step.laneKey) {
      lines.push(
        `   suggested lane: ${step.laneKey}${step.laneReason ? `, ${step.laneReason}` : ""}`
      );
    }
  });
  lines.push("");
  lines.push(`create tasks + assignments with: muon plan --apply --run-id ${runId}`);
  lines.push(
    "(or run it as a full workflow with gates: muon workflow apply --run-id " +
      runId +
      ")"
  );
  return `${lines.join("\n")}\n`;
}

export function registerPlanCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("plan")
    .description(
      "Super-orchestrator: break a request into a stored, human-applied proposal (heuristic by default; --planner-lane uses one of your own lanes)"
    )
    .argument("[request...]", "What you want done (omit when using --run-id)")
    .option(
      "--planner-lane <laneKey>",
      "Draft the proposal with this lane (LLM-backed, BYO auth); falls back to heuristics on invalid output"
    )
    .option(
      "--workspace <dir>",
      "Target repo folder for the crew (default: current directory)"
    )
    .option("--apply", "Apply a proposal: create its tasks and assignments")
    .option("--run-id <runId>", "Apply a previously stored proposal by id")
    .option("--json", "Print as JSON")
    .action(
      async (
        requestParts: string[],
        options: {
          plannerLane?: string;
          workspace?: string;
          apply?: boolean;
          runId?: string;
          json?: boolean;
        }
      ) => {
        try {
          const client = createClient();

          // --apply --run-id: the human approval step for a stored proposal.
          if (options.apply && options.runId) {
            const applied = await client.applyWorkflowRun(options.runId, "human");
            const created: { taskId: string; title: string; lane: string | null }[] =
              [];
            for (const task of applied.tasks) {
              const step = applied.run.proposal.steps.find(
                (entry) => entry.stepKey === task.stepKey
              );
              if (step?.laneKey) {
                const lanes = await client.listLanes();
                const lane = lanes.find((entry) => entry.key === step.laneKey);
                if (lane) {
                  await client.assignTask({
                    taskId: task.id,
                    laneId: lane.id,
                    summary: `muon plan: ${task.title.slice(0, 100)}`,
                  });
                }
              }
              created.push({
                taskId: task.id,
                title: task.title,
                lane: step?.laneKey ?? null,
              });
              process.stdout.write(
                `created ${task.id}, ${task.title}${step?.laneKey ? ` → ${step.laneKey}` : ""}\n`
              );
            }
            if (options.json) {
              printJson({ created, applied: true, runId: options.runId });
            }
            return;
          }

          const request = requestParts.join(" ").trim();
          if (!request) {
            throw new Error(
              "Provide a request, or use --apply --run-id <id> for a stored proposal."
            );
          }

          // Hybrid planner: lane-backed when asked, heuristic otherwise,
          // and heuristic as the fallback when the lane output is invalid.
          let proposal: WorkflowProposal;
          let proposedBy = "heuristic";
          if (options.plannerLane) {
            const [lanes, harnesses, templates] = await Promise.all([
              client.listLanes(),
              client.listHarnesses().catch(() => []),
              client.listWorkflowTemplates().catch(() => []),
            ]);
            try {
              process.stderr.write(
                `planning via lane '${options.plannerLane}'...\n`
              );
              proposal = await planWorkflowViaDispatch({
                client,
                laneKey: options.plannerLane,
                request,
                taskId: "muon-plan",
                workspacePath: options.workspace ?? process.cwd(),
                apiBase: resolveApiBase(
                  program.opts<{ apiBase?: string }>().apiBase
                ),
                apiBaseFlag: program.opts<{ apiBase?: string }>().apiBase,
                apiTokenFlag: program.opts<{ apiToken?: string }>().apiToken,
                context: {
                  laneKeys: lanes.map((lane) => lane.key),
                  harnessKeys: harnesses.map((harness) => harness.key),
                  templateKeys: templates.map((template) => template.key),
                },
              });
              proposedBy = options.plannerLane;
            } catch (error) {
              process.stderr.write(
                `${error instanceof Error ? error.message : error}\nfalling back to the heuristic splitter\n`
              );
              proposal = heuristicWorkflowProposal(request);
            }
          } else {
            proposal = heuristicWorkflowProposal(request);
          }

          // Routing enrichment: honest pre-task suggestions from the request
          // text (note-topic overlap), not a fake task id.
          for (const step of proposal.steps) {
            if (step.role === "suggest" && !step.laneKey) {
              const suggestions = await client
                .suggestLanes(undefined, `${step.title} ${step.brief}`)
                .catch(() => []);
              const top = suggestions[0];
              if (top) {
                step.laneKey = top.laneKey;
                step.laneReason = top.reason;
              }
            }
          }

          const run = await client.createWorkflowRun({
            request,
            workspacePath: options.workspace ?? process.cwd(),
            proposal,
            proposedBy,
          });

          if (!options.apply) {
            if (options.json) {
              printJson({ run, applied: false });
            } else {
              process.stdout.write(renderProposal(proposal, run.id));
            }
            return;
          }

          // `muon plan "<request>" --apply` applies the run it just proposed.
          const applied = await client.applyWorkflowRun(run.id, "human");
          const lanes = await client.listLanes();
          for (const task of applied.tasks) {
            const step = applied.run.proposal.steps.find(
              (entry) => entry.stepKey === task.stepKey
            );
            const lane = step?.laneKey
              ? lanes.find((entry) => entry.key === step.laneKey)
              : undefined;
            if (lane) {
              await client.assignTask({
                taskId: task.id,
                laneId: lane.id,
                summary: `muon plan: ${task.title.slice(0, 100)}`,
              });
            }
            process.stdout.write(
              `created ${task.id}, ${task.title}${lane ? ` → ${lane.key}` : ""}\n`
            );
          }
          if (options.json) {
            printJson({ runId: run.id, applied: true });
          }
        } catch (error) {
          failCommand(error, "Plan failed.");
        }
      }
    );
}
