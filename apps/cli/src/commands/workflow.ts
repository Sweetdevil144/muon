import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import {
  assertHarnessRequirements,
  checkStatusWord,
  collectWorktreeEvidence,
  ensureTaskWorktree,
  isCheckGreen,
  proposalFromTemplate,
  resolveRepoRoot,
  runChecksWithCoverage,
  runWorkflowRun,
  toHandoffCheck,
  worktreeChangedFiles,
  type StepDispatch,
  type WorkflowLedger,
  type WorktreeEvidence,
} from "@muon/core";
import {
  emptyHarnessConfig,
  handoffPacketSchema,
  type HandoffCheck,
} from "@muon/protocol";
import type { WorkflowRunDetail } from "@muon/client";
import { MuonApiClient } from "../lib/api-client.js";
import { waitForApproval } from "../lib/approval-gate.js";
import { resolveApiBase, resolveAgentToken } from "../lib/config.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printJson } from "../lib/output.js";

const GATE_TIMEOUT_DEFAULT_MS = 300_000;
const DISPATCH_POLL_MS = 500;
const DISPATCH_GRACE_MS = 60_000;
const DEFAULT_DISPATCH_WAIT_MS = 30 * 60_000;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function renderRunSummary(detail: WorkflowRunDetail): string {
  const lines: string[] = [
    `run ${detail.run.id} [${detail.run.status}], ${detail.run.proposal.summary}`,
    `template: ${detail.run.templateKey ?? "(ad-hoc)"} · proposed by ${detail.run.proposedBy}${detail.run.appliedBy ? ` · applied by ${detail.run.appliedBy}` : ""}`,
    "",
  ];
  for (const step of detail.run.proposal.steps) {
    const task = detail.tasks.find((entry) => entry.stepKey === step.stepKey);
    const gate = step.gate ? ` gate:${step.gate}` : "";
    const loop = step.loop ? ` loop:${step.loop.maxIterations}x` : "";
    const lane = step.role === "human" ? "human" : step.laneKey ?? step.role;
    const status = task ? task.status : "(not applied)";
    lines.push(
      `  ${step.stepKey.padEnd(16)} ${status.padEnd(12)} ${lane}${step.harnessKey ? ` +${step.harnessKey}` : ""}${loop}${gate}`
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The surface half of the workflow runner: core owns sequencing/gates/
 * resume; this dispatch owns durable enqueue/observation while the persistent
 * runner owns profiles, memory, fleet claims, and vendor execution.
 */
function buildStepDispatch(args: {
  client: MuonApiClient;
  apiBase: string;
  apiToken?: string;
  /** RAW global flags, for ensureRunner's credential↔base pairing. */
  apiBaseFlag?: string;
  apiTokenFlag?: string;
  runId: string;
  workspacePath?: string;
}): StepDispatch {
  const { client } = args;

  return async ({ step, task, laneId, laneKey }) => {
    const harness = step.harnessKey
      ? (await client.getHarness(step.harnessKey)).config
      : emptyHarnessConfig;
    assertHarnessRequirements(harness, {
      laneKey,
      interactiveAvailable: false,
      worktree: true, // every lane step runs isolated
    });
    if (step.loop && step.loop.kind !== harness.loopKind) {
      throw new Error(
        `Workflow loop kind '${step.loop.kind}' does not match harness loop kind '${harness.loopKind}'.`
      );
    }

    // The run's workspace wins; the step task's own workspace overrides it;
    // the executing client's cwd is only the last resort.
    const repoRoot = await resolveRepoRoot(
      task.workspacePath ?? args.workspacePath ?? process.cwd()
    );
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: task.id });
    process.stderr.write(
      `step '${step.stepKey}' → ${laneKey} in ${worktree.path}\n`
    );

    const runner = await ensureRunner(client, {
      apiBase: args.apiBase,
      ...(args.apiBaseFlag !== undefined
        ? { apiBaseFlag: args.apiBaseFlag }
        : {}),
      ...(args.apiTokenFlag !== undefined
        ? { apiTokenFlag: args.apiTokenFlag }
        : {}),
    });
    if (!runner.live) {
      throw new Error(
        runner.note ??
          "No persistent runner is online. Start one with `muon runner`, then retry.",
        // Keep the lease 401/403 classification for the exit-2 contract.
        { cause: runner.failure }
);
    }
    const baseline = await client
      .listStreamChunks({ taskId: task.id, latest: true, limit: 1 })
      .catch(() => []);
    let afterSeq = baseline.at(-1)?.seq ?? 0;

    const dispatchWorkspace = harness.requires.worktree
      ? repoRoot
      : worktree.path;
    const job = await client.enqueueDispatch({
      kind: step.loop ? "loop" : "oneshot",
      vendor: laneKey,
      taskId: task.id,
      brief: step.brief,
      ...(step.harnessKey ? { harnessKey: step.harnessKey } : {}),
      ...(step.loop?.maxIterations
        ? { maxIterations: step.loop.maxIterations }
        : {}),
      ...(step.loop?.maxWallMs ? { maxWallMs: step.loop.maxWallMs } : {}),
      workspacePath: dispatchWorkspace,
    });
    process.stderr.write(
      `dispatch ${job.id} queued for step '${step.stepKey}'\n`
    );

    const configuredWait =
      step.loop?.maxWallMs ?? harness.budget.maxWallMs ?? DEFAULT_DISPATCH_WAIT_MS;
    const deadline = Date.now() + configuredWait + DISPATCH_GRACE_MS;
    let terminal;
    for (;;) {
      const current = await client.getDispatchJob(job.id);
      const chunks = await client
        .listStreamChunks({
          taskId: task.id,
          afterSeq,
          limit: 100,
        })
        .catch(() => []);
      for (const chunk of chunks) {
        process.stderr.write(
          `[${chunk.timestamp}] ${chunk.kind} ${chunk.content}\n`
        );
      }
      afterSeq = chunks[chunks.length - 1]?.seq ?? afterSeq;
      if (TERMINAL_STATUSES.has(current.status)) {
        terminal = current;
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Workflow dispatch '${job.id}' exceeded its ${configuredWait}ms budget.`
        );
      }
      await delay(DISPATCH_POLL_MS);
    }

    let ok =
      terminal.status === "done" &&
      (terminal.exitCode === null ||
        terminal.exitCode === undefined ||
        terminal.exitCode === 0);
    let summary =
      terminal.result?.trim() ||
      (ok
        ? step.loop
          ? "loop passed"
          : "completed (exit 0)"
        : `dispatch ${terminal.status}`);

    // Typed check evidence for the handoff packet (P0.3). Break-on-first-
    // failure is kept: unexecuted checks are simply absent, which is honest.
    // Routed through the loop's own entry point so a step check is worth
    // exactly what the same check is worth inside a loop — coverage-qualified,
    // with the changed packages' own suites run where the declared command
    // cannot see them.
    const stepChecks: HandoffCheck[] = [];
    if (ok && !step.loop && harness.checks.length > 0) {
      const checkRun = await runChecksWithCoverage({
        checks: harness.checks,
        cwd: worktree.path,
        stopOnFirstFailure: true,
      });
      for (const checkResult of checkRun.checks) {
        stepChecks.push(toHandoffCheck(checkResult));
      }
      const blocking = checkRun.checks.find((entry) => !isCheckGreen(entry));
      if (blocking) {
        ok = false;
        summary = blocking.skip
          ? `check '${blocking.name}': ${checkStatusWord(blocking)} — ${
              blocking.skip.detail
            }`
          : blocking.coverage?.status === "uncovering"
            ? `check '${blocking.name}' exited 0 but covered none of the changed files`
            : `check '${blocking.name}' failed (exit ${blocking.exitCode})`;
      } else if (checkRun.unqualified) {
        // Honest about the gap instead of implying a qualified pass.
        summary = `${summary} (checks not qualified against a diff: ${checkRun.unqualified})`;
      }
    }

    // Loop steps ran their checks inside the runner: when the terminal row
    // carries a typed packet (agent-produced data), reuse its check evidence.
    const terminalPacket =
      terminal.packetJson != null
        ? handoffPacketSchema.safeParse(terminal.packetJson)
        : undefined;

    const changedFiles = await worktreeChangedFiles(worktree.path).catch(
      () => undefined
    );
    if (changedFiles && changedFiles.length > 0) {
      await client
        .recordEvent({
          laneId,
          taskId: task.id,
          kind: "task.progress",
          message: `touched ${changedFiles.length} file(s)`,
          metadata: { modules: changedFiles },
        })
        .catch(() => undefined);
    }

    // Diff evidence from the isolated step worktree; failure degrades honestly.
    const evidence: WorktreeEvidence = await collectWorktreeEvidence(
      worktree.path
    ).catch(
      (): WorktreeEvidence => ({
        diff: { unavailableReason: "diff_error:collect_failed" },
      })
    );

    return {
      ok,
      summary,
      changedFiles,
      checks:
        stepChecks.length > 0
          ? stepChecks
          : terminalPacket && terminalPacket.success
            ? terminalPacket.data.checks
            : undefined,
      diff: evidence.diff,
    };
  };
}

function buildWorkflowLedger(
  client: MuonApiClient,
  options: { gateTimeoutMs: number }
): WorkflowLedger {
  let lanesCache: { id: string; key: string }[] | undefined;
  return {
    updateRunStatus: (input) =>
      client.updateWorkflowRun({ runId: input.runId, status: input.status }),
    recordEvent: (event) => client.recordEvent(event),
    requestApproval: (input) => client.requestApproval(input),
    waitForApproval: async (approvalId) => {
      process.stderr.write(
        `gate waiting in the inbox (id: ${approvalId})\n` +
          `decide with: muon approve resolve --approval-id ${approvalId} --status approved|rejected\n`
      );
      await waitForApproval(client, approvalId, {
        timeoutMs: options.gateTimeoutMs,
        onPoll: () => process.stderr.write("gate still pending...\n"),
      });
    },
    assignTask: (input) => client.assignTask(input),
    updateTaskStatus: (taskId, status) =>
      client.updateTaskStatus(taskId, status as Parameters<typeof client.updateTaskStatus>[1]),
    createHandoff: (input) => client.createHandoff(input),
    resolveLaneId: async (laneKey) => {
      lanesCache ??= await client.listLanes();
      const lane = lanesCache.find((entry) => entry.key === laneKey);
      if (!lane) {
        throw new Error(`Lane key '${laneKey}' not found in backend ledger.`);
      }
      return lane.id;
    },
  };
}

async function executeRun(args: {
  client: MuonApiClient;
  program: Command;
  runId: string;
  gateTimeoutMs: number;
}): Promise<void> {
  const detail = await args.client.getWorkflowRun(args.runId);
  const rawFlags = args.program.opts<{ apiBase?: string; apiToken?: string }>();
  const apiBase = resolveApiBase(rawFlags.apiBase);
  const outcome = await runWorkflowRun({
    runId: args.runId,
    proposal: detail.run.proposal,
    tasks: detail.tasks.map((task) => ({
      id: task.id,
      stepKey: task.stepKey ?? null,
      status: task.status,
      title: task.title,
      description: task.description,
      workspacePath: task.workspacePath ?? null,
    })),
    ledger: buildWorkflowLedger(args.client, {
      gateTimeoutMs: args.gateTimeoutMs,
    }),
    dispatch: buildStepDispatch({
      client: args.client,
      apiBase,
      // Pair the agent token with the flag base too: a flag-supplied base
      // must not receive the local lockfile's agent credential.
      apiToken: resolveAgentToken(undefined, rawFlags.apiBase),
      ...(rawFlags.apiBase !== undefined
        ? { apiBaseFlag: rawFlags.apiBase }
        : {}),
      ...(rawFlags.apiToken !== undefined
        ? { apiTokenFlag: rawFlags.apiToken }
        : {}),
      runId: args.runId,
      workspacePath: detail.run.workspacePath ?? undefined,
    }),
  });

  if (outcome.status === "done") {
    process.stdout.write(
      `workflow run ${args.runId} done, steps: ${outcome.completedSteps.join(" → ")}\n`
    );
  } else {
    process.stdout.write(
      `workflow run ${args.runId} paused at '${outcome.pausedAt}': ${outcome.reason}\n` +
        `continue with: muon workflow resume --run-id ${args.runId}\n`
    );
    process.exitCode = 2;
  }
}

export function registerWorkflowCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const workflow = program
    .command("workflow")
    .description(
      "Declared multi-step plans with roles, gates, and handoffs (proposals apply only by human action)"
    );

  workflow
    .command("templates")
    .description("List workflow templates")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const client = createClient();
        const templates = await client.listWorkflowTemplates();
        if (options.json) {
          printJson({ templates });
          return;
        }
        for (const template of templates) {
          const steps = template.definition.steps
            .map((step) => step.stepKey)
            .join(" → ");
          process.stdout.write(
            `${template.key.padEnd(12)} v${template.version}  ${template.name}: ${steps}\n`
          );
        }
      } catch (error) {
        failCommand(error, "Templates failed.");
      }
    });

  workflow
    .command("list")
    .description("List workflow runs")
    .option("--status <status>", "Filter by run status")
    .option("--json", "Print as JSON")
    .action(async (options: { status?: string; json?: boolean }) => {
      try {
        const client = createClient();
        const runs = await client.listWorkflowRuns(
          options.status ? { status: options.status as never } : undefined
        );
        if (options.json) {
          printJson({ runs });
          return;
        }
        for (const run of runs) {
          process.stdout.write(
            `${run.id}  [${run.status}] ${run.templateKey ?? "(ad-hoc)"}, ${run.proposal.summary}\n`
          );
        }
      } catch (error) {
        failCommand(error, "List failed.");
      }
    });

  workflow
    .command("status")
    .description("Show one workflow run with per-step task state")
    .requiredOption("--run-id <runId>", "Workflow run id")
    .option("--json", "Print as JSON")
    .action(async (options: { runId: string; json?: boolean }) => {
      try {
        const client = createClient();
        const detail = await client.getWorkflowRun(options.runId);
        if (options.json) {
          printJson(detail);
        } else {
          process.stdout.write(renderRunSummary(detail));
        }
      } catch (error) {
        failCommand(error, "Status failed.");
      }
    });

  workflow
    .command("run")
    .description(
      "Materialize a template into a proposed run; --apply applies AND executes it"
    )
    .argument("<templateKey>", "Workflow template key (see: muon workflow templates)")
    .argument("<request...>", "What you want done")
    .option("--apply", "Apply the proposal (create step tasks) and execute")
    .option(
      "--workspace <dir>",
      "Target repo folder for the crew (default: current directory)"
    )
    .option(
      "--gate-timeout <ms>",
      `How long gates wait for approval before pausing (default ${GATE_TIMEOUT_DEFAULT_MS})`
    )
    .option("--json", "Print as JSON")
    .action(
      async (
        templateKey: string,
        requestParts: string[],
        options: {
          apply?: boolean;
          workspace?: string;
          gateTimeout?: string;
          json?: boolean;
        }
      ) => {
        try {
          const client = createClient();
          const request = requestParts.join(" ");
          const template = await client.getWorkflowTemplate(templateKey);
          const proposal = proposalFromTemplate(template.definition, request, {
            templateKey,
          });

          // Routing enrichment: suggest a lane per non-human step from the
          // request text + step brief. Recommendation only, the human can
          // edit before applying.
          for (const step of proposal.steps) {
            if (step.role === "suggest") {
              const suggestions = await client
                .suggestLanes(undefined, `${step.title} ${step.brief}`)
                .catch(() => []);
              const top = suggestions[0];
              if (top) {
                step.laneKey = top.laneKey;
                step.laneReason = top.reason;
              }
            } else if (step.role !== "human") {
              step.laneKey = step.role;
            }
          }

          const run = await client.createWorkflowRun({
            templateKey,
            templateVersion: template.version,
            request,
            workspacePath: options.workspace ?? process.cwd(),
            proposal,
            proposedBy: "heuristic",
          });

          if (!options.apply) {
            if (options.json) {
              printJson({ run, applied: false });
            } else {
              process.stdout.write(
                renderRunSummary({ run, tasks: [] }) +
                  `\napply + execute with: muon workflow apply --run-id ${run.id}\n`
              );
            }
            return;
          }

          await client.applyWorkflowRun(run.id, "human");
          await executeRun({
            client,
            program,
            runId: run.id,
            gateTimeoutMs:
              Number(options.gateTimeout) || GATE_TIMEOUT_DEFAULT_MS,
          });
        } catch (error) {
          failCommand(error, "Workflow run failed.");
        }
      }
    );

  workflow
    .command("apply")
    .description("Apply a proposed run (steps become tasks) and execute it")
    .requiredOption("--run-id <runId>", "Workflow run id")
    .option("--gate-timeout <ms>", "Gate approval wait in ms")
    .action(async (options: { runId: string; gateTimeout?: string }) => {
      try {
        const client = createClient();
        await client.applyWorkflowRun(options.runId, "human");
        process.stdout.write(`workflow run ${options.runId} applied, executing\n`);
        await executeRun({
          client,
          program,
          runId: options.runId,
          gateTimeoutMs: Number(options.gateTimeout) || GATE_TIMEOUT_DEFAULT_MS,
        });
      } catch (error) {
        failCommand(error, "Apply failed.");
      }
    });

  workflow
    .command("resume")
    .description(
      "Resume an applied/paused run from ledger state (completed steps are skipped)"
    )
    .requiredOption("--run-id <runId>", "Workflow run id")
    .option("--gate-timeout <ms>", "Gate approval wait in ms")
    .action(async (options: { runId: string; gateTimeout?: string }) => {
      try {
        const client = createClient();
        await executeRun({
          client,
          program,
          runId: options.runId,
          gateTimeoutMs: Number(options.gateTimeout) || GATE_TIMEOUT_DEFAULT_MS,
        });
      } catch (error) {
        failCommand(error, "Resume failed.");
      }
    });
}
