import type {
  HandoffCheck,
  HandoffPacket,
  LaneEvent,
  WorkflowProposal,
  WorkflowProposalStep,
} from "@muon/protocol";
import {
  buildHandoffPacket,
  renderHandoffPacketMarkdown,
} from "./build-handoff-packet.js";
import type { HandoffDiffInput } from "./handoff-evidence.js";

/**
 * Workflow runner (VISION §4): executes an APPLIED run's steps in order
 * through injected dispatch, the runner owns sequencing, gates, handoffs,
 * and resume; the surface (CLI/TUI) owns how a step actually runs (harness
 * merge, memory slice, worktree, loop). The backend stays a ledger and
 * never spawns lanes; this runs in the invoking client process.
 *
 * Resume is ledger-derived: a step whose task already reached `review` or
 * `done` is skipped, so `muon workflow resume <runId>` continues after a
 * crash with no local state file.
 */

export type WorkflowTaskRef = {
  id: string;
  stepKey: string | null;
  status: string;
  title: string;
  description: string;
  /** Target repo folder for this step (dispatch decides the fallback). */
  workspacePath?: string | null;
};

export type StepDispatchResult = {
  ok: boolean;
  summary: string;
  /** Relative files changed in the isolated task worktree. Required for fan-out. */
  changedFiles?: string[];
  /** Typed check evidence executed for this step (P0.3 handoff packets). */
  checks?: HandoffCheck[];
  /** Full-stream diff hash evidence, or an honest unavailability reason. */
  diff?: HandoffDiffInput;
};

export type StepDispatch = (args: {
  step: WorkflowProposalStep;
  task: WorkflowTaskRef;
  laneId: string;
  laneKey: string;
}) => Promise<StepDispatchResult>;

export type WorkflowLedger = {
  updateRunStatus(input: {
    runId: string;
    status: "running" | "paused" | "done";
  }): Promise<unknown>;
  recordEvent(event: {
    laneId: string;
    taskId: string;
    kind: LaneEvent["kind"];
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  requestApproval(input: {
    taskId: string;
    requestedBy: string;
    kind: "gate" | "merge";
    reason: string;
  }): Promise<{ id: string }>;
  /** Must throw on rejection/timeout/unknown, gates fail closed. */
  waitForApproval(approvalId: string): Promise<void>;
  assignTask(input: {
    taskId: string;
    laneId: string;
    summary: string;
  }): Promise<unknown>;
  updateTaskStatus(taskId: string, status: string): Promise<unknown>;
  createHandoff(input: {
    taskId: string;
    fromLaneId: string;
    toLaneId: string;
    packetTitle: string;
    packetBody: string;
    /** Typed v2 packet; optional so existing ledger adapters compile unchanged. */
    packet?: HandoffPacket;
  }): Promise<unknown>;
  /** Resolves a lane key to its ledger id; throws on unknown keys. */
  resolveLaneId(laneKey: string): Promise<string>;
};

export type RunWorkflowInput = {
  runId: string;
  proposal: WorkflowProposal;
  tasks: WorkflowTaskRef[];
  ledger: WorkflowLedger;
  dispatch: StepDispatch;
};

export type WorkflowOutcome = {
  status: "done" | "paused";
  completedSteps: string[];
  pausedAt?: string;
  reason?: string;
};

const COMPLETED_TASK_STATUSES = new Set(["review", "done"]);
const WORKFLOW_ACTOR = "muon-workflow";
const MAX_PARALLEL_STEPS = 3;

function normalizeWorkspacePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function pathOwnsFile(ownedPath: string, changedFile: string): boolean {
  const root = normalizeWorkspacePath(ownedPath);
  const file = normalizeWorkspacePath(changedFile);
  return file === root || file.startsWith(`${root}/`);
}

function ownershipOverlap(
  steps: WorkflowProposalStep[]
): string | undefined {
  for (let left = 0; left < steps.length; left += 1) {
    const leftStep = steps[left]!;
    for (let right = left + 1; right < steps.length; right += 1) {
      const rightStep = steps[right]!;
      for (const leftPath of leftStep.parallel?.paths ?? []) {
        for (const rightPath of rightStep.parallel?.paths ?? []) {
          if (
            pathOwnsFile(leftPath, rightPath) ||
            pathOwnsFile(rightPath, leftPath)
          ) {
            return `parallel ownership overlap: step '${leftStep.stepKey}' path '${leftPath}' collides with step '${rightStep.stepKey}' path '${rightPath}'`;
          }
        }
      }
    }
  }
  return undefined;
}

function enforceParallelOwnership(
  step: WorkflowProposalStep,
  result: StepDispatchResult
): StepDispatchResult {
  if (!step.parallel || !result.ok) {
    return result;
  }
  if (!result.changedFiles) {
    return {
      ok: false,
      summary: `parallel step '${step.stepKey}' did not attest changed files; collision safety cannot be verified`,
    };
  }
  const outside = result.changedFiles.filter(
    (file) =>
      !step.parallel!.paths.some((ownedPath) =>
        pathOwnsFile(ownedPath, file)
      )
  );
  if (outside.length > 0) {
    return {
      ok: false,
      summary: `parallel step '${step.stepKey}' edited outside declared ownership (${step.parallel.paths.join(", ")}): ${outside.join(", ")}`,
      changedFiles: result.changedFiles,
    };
  }
  return result;
}

export async function runWorkflowRun(
  input: RunWorkflowInput
): Promise<WorkflowOutcome> {
  const { ledger, proposal, dispatch } = input;
  const completedSteps: string[] = [];

  const pause = async (
    stepKey: string,
    taskId: string,
    laneId: string,
    reason: string
  ): Promise<WorkflowOutcome> => {
    await ledger.recordEvent({
      laneId,
      taskId,
      kind: "task.blocked",
      message: `workflow paused at step '${stepKey}': ${reason}`,
      metadata: { workflowRunId: input.runId, stepKey },
    });
    await ledger.updateRunStatus({ runId: input.runId, status: "paused" });
    return { status: "paused", completedSteps, pausedAt: stepKey, reason };
  };

  const taskFor = (step: WorkflowProposalStep): WorkflowTaskRef => {
    const task = input.tasks.find((entry) => entry.stepKey === step.stepKey);
    if (!task) {
      throw new Error(
        `Workflow run ${input.runId} has no task for step '${step.stepKey}'. Apply the run before executing it.`
      );
    }
    return task;
  };

  const escalateFailure = async (
    step: WorkflowProposalStep,
    task: WorkflowTaskRef,
    laneId: string,
    summary: string
  ): Promise<WorkflowOutcome> => {
    const approval = await ledger.requestApproval({
      taskId: task.id,
      requestedBy: WORKFLOW_ACTOR,
      kind: "gate",
      reason: `workflow step '${step.stepKey}' failed: ${summary.slice(0, 300)}. Decide, then \`muon workflow resume ${input.runId}\`.`,
    });
    await ledger.recordEvent({
      laneId,
      taskId: task.id,
      kind: "approval.requested",
      message: `escalation gate filed for failed step '${step.stepKey}'`,
      metadata: {
        workflowRunId: input.runId,
        stepKey: step.stepKey,
        approvalId: approval.id,
      },
    });
    return pause(step.stepKey, task.id, laneId, summary);
  };

  const finishStep = async (
    step: WorkflowProposalStep,
    task: WorkflowTaskRef,
    laneId: string,
    laneKey?: string,
    result?: StepDispatchResult
  ): Promise<WorkflowOutcome | undefined> => {
    // Human checkpoint after the step: fail closed on reject/timeout.
    if (step.gate) {
      const approval = await ledger.requestApproval({
        taskId: task.id,
        requestedBy: WORKFLOW_ACTOR,
        kind: step.gate,
        reason: `workflow gate after step '${step.stepKey}' (${step.title}), approve to continue`,
      });
      try {
        await ledger.waitForApproval(approval.id);
      } catch (error) {
        return pause(
          step.stepKey,
          task.id,
          laneId,
          `gate not approved: ${error instanceof Error ? error.message : "rejected"}`
        );
      }
    }

    await ledger.updateTaskStatus(task.id, "review");
    await ledger.recordEvent({
      laneId,
      taskId: task.id,
      kind: "workflow.step.completed",
      message: `step '${step.stepKey}' completed`,
      metadata: { workflowRunId: input.runId, stepKey: step.stepKey },
    });
    completedSteps.push(step.stepKey);

    // Handoff packet to the next step's lane, when both ends are known.
    if (step.handoffTo && laneKey) {
      const nextStep = proposal.steps.find(
        (entry) => entry.stepKey === step.handoffTo
      );
      const nextTask = input.tasks.find(
        (entry) => entry.stepKey === step.handoffTo
      );
      if (nextStep?.laneKey && nextStep.laneKey !== laneKey && nextTask) {
        const toLaneId = await ledger.resolveLaneId(nextStep.laneKey);
        // Typed v2 handoff packet: the receiving lane gets the compact
        // contract (evidence, degradation) before any prose; the body stays
        // the rendered markdown of the same packet for v1 readers.
        //
        // A human-edited brief can be shorter than the packet schema allows
        // (proposal `brief` is min(1), packet `taskGoal` is min(3)), so packet
        // construction can throw. A completed step must never be turned into a
        // failure over handoff construction: fall back to a prose-only handoff
        // (packet omitted) instead of propagating the throw.
        let packet: HandoffPacket | undefined;
        let packetBody: string;
        try {
          packet = buildHandoffPacket({
            laneKey,
            taskId: nextTask.id,
            brief: nextStep.brief, // taskGoal = the RECEIVING step's goal
            outcome: {
              ok: result?.ok ?? true,
              summary: `step '${step.stepKey}' (${step.title}) finished: ${
                result?.summary ?? "no dispatch summary (human or resumed step)"
              }`,
            },
            events: [],
            checks: result?.checks,
            changedFiles: result?.changedFiles,
            diff: result?.diff,
            recommendedNextAction: `Start step '${step.handoffTo}' (${nextStep.title}).`,
          });
          packetBody = renderHandoffPacketMarkdown(packet);
        } catch {
          packet = undefined;
          packetBody = `Workflow handoff: step '${step.stepKey}' (${step.title}) completed. Continue with step '${step.handoffTo}' (${nextStep.title}).`;
        }
        await ledger.createHandoff({
          taskId: nextTask.id,
          fromLaneId: laneId,
          toLaneId,
          packetTitle: `Workflow handoff: ${step.stepKey} -> ${step.handoffTo}`,
          packetBody,
          ...(packet ? { packet } : {}),
        });
      }
    }
    return undefined;
  };

  const runSequentialStep = async (
    step: WorkflowProposalStep
  ): Promise<WorkflowOutcome | undefined> => {
    const task = taskFor(step);

    // Resume: a step whose task already completed is not re-dispatched.
    if (COMPLETED_TASK_STATUSES.has(task.status)) {
      completedSteps.push(step.stepKey);
      return undefined;
    }

    const isHumanStep = step.role === "human";
    const laneKey = isHumanStep ? undefined : step.laneKey;
    if (!isHumanStep && !laneKey) {
      return pause(
        step.stepKey,
        task.id,
        "muon",
        "step has no lane assigned, edit the proposal or assign one at apply time"
      );
    }
    const laneId = laneKey ? await ledger.resolveLaneId(laneKey) : "muon";

    await ledger.recordEvent({
      laneId,
      taskId: task.id,
      kind: "workflow.step.started",
      message: `step '${step.stepKey}' started (${isHumanStep ? "human" : laneKey})`,
      metadata: { workflowRunId: input.runId, stepKey: step.stepKey },
    });

    // Hoisted so the terminal handoff packet can carry the dispatch
    // evidence; stays undefined for human steps.
    let result: StepDispatchResult | undefined;
    if (!isHumanStep && laneKey) {
      await ledger.assignTask({
        taskId: task.id,
        laneId,
        summary: `workflow ${proposal.templateKey ?? input.runId} step '${step.stepKey}': ${step.brief.slice(0, 100)}`,
      });

      result = enforceParallelOwnership(
        step,
        await dispatch({ step, task, laneId, laneKey })
      );
      if (!result.ok) {
        return escalateFailure(step, task, laneId, result.summary);
      }
    }

    return finishStep(step, task, laneId, laneKey, result);
  };

  const runParallelGroup = async (
    group: WorkflowProposalStep[]
  ): Promise<WorkflowOutcome | undefined> => {
    const groupName = group[0]?.parallel?.group ?? "unknown";
    const pending: {
      step: WorkflowProposalStep;
      task: WorkflowTaskRef;
      laneKey: string;
      laneId: string;
    }[] = [];

    for (const step of group) {
      const task = taskFor(step);
      if (COMPLETED_TASK_STATUSES.has(task.status)) {
        completedSteps.push(step.stepKey);
        continue;
      }
      if (step.role === "human" || !step.laneKey) {
        return pause(
          step.stepKey,
          task.id,
          "muon",
          "parallel step has no dispatchable lane assigned"
        );
      }
      pending.push({
        step,
        task,
        laneKey: step.laneKey,
        laneId: await ledger.resolveLaneId(step.laneKey),
      });
    }

    // Resume can leave only one unfinished member; it returns to the safe
    // sequential default instead of manufacturing a one-lane "fan-out".
    if (pending.length <= 1) {
      return pending[0]
        ? runSequentialStep(pending[0].step)
        : undefined;
    }
    if (pending.length > MAX_PARALLEL_STEPS) {
      const first = pending[0]!;
      return pause(
        first.step.stepKey,
        first.task.id,
        "muon",
        `parallel group '${groupName}' exceeds the ${MAX_PARALLEL_STEPS}-step bound`
      );
    }

    const overlap = ownershipOverlap(pending.map((entry) => entry.step));
    if (overlap) {
      const first = pending[0]!;
      return pause(first.step.stepKey, first.task.id, "muon", overlap);
    }

    const ownership = pending
      .map(
        ({ step }) =>
          `${step.stepKey} [${step.parallel!.paths.join(", ")}]`
      )
      .join("; ");
    const approval = await ledger.requestApproval({
      taskId: pending[0]!.task.id,
      requestedBy: WORKFLOW_ACTOR,
      kind: "gate",
      reason: `parallel group '${groupName}' requests ${pending.length}-lane fan-out for genuinely independent work with declared ownership: ${ownership}. Approve to dispatch concurrently.`,
    });
    await ledger.recordEvent({
      laneId: "muon",
      taskId: pending[0]!.task.id,
      kind: "approval.requested",
      message: `fan-out gate filed for parallel group '${groupName}'`,
      metadata: {
        workflowRunId: input.runId,
        parallelGroup: groupName,
        stepKeys: pending.map(({ step }) => step.stepKey),
        approvalId: approval.id,
      },
    });
    try {
      await ledger.waitForApproval(approval.id);
    } catch (error) {
      const first = pending[0]!;
      return pause(
        first.step.stepKey,
        first.task.id,
        "muon",
        `fan-out gate not approved: ${error instanceof Error ? error.message : "rejected"}`
      );
    }

    for (const { step, task, laneId, laneKey } of pending) {
      await ledger.recordEvent({
        laneId,
        taskId: task.id,
        kind: "workflow.step.started",
        message: `step '${step.stepKey}' started (${laneKey}) in parallel group '${groupName}'`,
        metadata: {
          workflowRunId: input.runId,
          stepKey: step.stepKey,
          parallelGroup: groupName,
        },
      });
      await ledger.assignTask({
        taskId: task.id,
        laneId,
        summary: `workflow ${proposal.templateKey ?? input.runId} parallel step '${step.stepKey}': ${step.brief.slice(0, 100)}`,
      });
    }

    const executions = await Promise.all(
      pending.map(async (entry) => {
        try {
          const result = enforceParallelOwnership(
            entry.step,
            await dispatch(entry)
          );
          return { ...entry, result };
        } catch (error) {
          return {
            ...entry,
            result: {
              ok: false,
              summary:
                error instanceof Error ? error.message : String(error),
            } satisfies StepDispatchResult,
          };
        }
      })
    );

    for (const execution of executions) {
      if (!execution.result.ok) {
        continue;
      }
      const paused = await finishStep(
        execution.step,
        execution.task,
        execution.laneId,
        execution.laneKey,
        execution.result
      );
      if (paused) {
        return paused;
      }
    }

    const failures = executions.filter((entry) => !entry.result.ok);
    if (failures.length > 0) {
      const first = failures[0]!;
      const summary = failures
        .map(
          ({ step, result }) => `${step.stepKey}: ${result.summary}`
        )
        .join("; ");
      return escalateFailure(
        first.step,
        first.task,
        first.laneId,
        summary
      );
    }
    return undefined;
  };

  await ledger.updateRunStatus({ runId: input.runId, status: "running" });

  for (let index = 0; index < proposal.steps.length; ) {
    const step = proposal.steps[index]!;
    if (!step.parallel) {
      const outcome = await runSequentialStep(step);
      if (outcome) {
        return outcome;
      }
      index += 1;
      continue;
    }

    const groupName = step.parallel.group;
    let end = index + 1;
    while (
      end < proposal.steps.length &&
      proposal.steps[end]?.parallel?.group === groupName
    ) {
      end += 1;
    }
    const outcome = await runParallelGroup(proposal.steps.slice(index, end));
    if (outcome) {
      return outcome;
    }
    index = end;
  }

  await ledger.updateRunStatus({ runId: input.runId, status: "done" });
  return { status: "done", completedSteps };
}
