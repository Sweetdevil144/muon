import {
  assertHarnessRequirements,
  checkStatusWord,
  ensureTaskWorktree,
  isCheckGreen,
  resolveRepoRoot,
  runChecksWithCoverage,
  runWorkflowRun,
  worktreeChangedFiles,
  type StepDispatch,
  type WorkflowLedger,
  type WorkflowOutcome,
} from "@muon/core";
import { emptyHarnessConfig, waitForApproval } from "@muon/client";
import type {
  MuonApiClient,
  RecordedEvent,
  StreamChunk,
  TaskStatus,
} from "@muon/client";

// In-TUI workflow execution: the cockpit half of the core runner. Mirrors
// the CLI executor; when the desktop runner lands (Phase 2) this gets
// extracted into a shared orchestrator package instead of a third copy.

export type ExecuteWorkflowInput = {
  client: MuonApiClient;
  runId: string;
  apiBase: string;
  apiToken?: string;
  gateTimeoutMs?: number;
  onLiveEvent: (event: RecordedEvent) => void;
  onStatus: (line: string) => void;
};

const GATE_TIMEOUT_DEFAULT_MS = 300_000;
const DISPATCH_POLL_MS = 500;
const DISPATCH_GRACE_MS = 60_000;
const DEFAULT_DISPATCH_WAIT_MS = 30 * 60_000;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function streamToLiveEvent(chunk: StreamChunk): RecordedEvent {
  return {
    id: `workflow-stream-${chunk.seq}`,
    laneId: chunk.laneId,
    taskId: chunk.taskId,
    kind: chunk.kind === "gate" ? "task.blocked" : "task.progress",
    message: chunk.content,
    metadata: {
      streamSeq: chunk.seq,
      streamKind: chunk.kind,
      ...(chunk.agentId ? { agentId: chunk.agentId } : {}),
    },
    timestamp: chunk.timestamp,
  };
}

function buildDispatch(
  input: ExecuteWorkflowInput,
  workspacePath?: string
): StepDispatch {
  const { client } = input;

  return async ({ step, task, laneKey }) => {
    const harness = step.harnessKey
      ? (await client.getHarness(step.harnessKey)).config
      : emptyHarnessConfig;
    assertHarnessRequirements(harness, {
      laneKey,
      interactiveAvailable: false,
      worktree: true,
    });
    if (step.loop && step.loop.kind !== harness.loopKind) {
      throw new Error(
        `Workflow loop kind '${step.loop.kind}' does not match harness loop kind '${harness.loopKind}'.`
      );
    }

    const repoRoot = await resolveRepoRoot(
      task.workspacePath ?? workspacePath ?? process.cwd()
    );
    const worktree = await ensureTaskWorktree({ repoRoot, taskId: task.id });
    input.onStatus(`▶ step '${step.stepKey}' → ${laneKey} in ${worktree.path}`);

    const runner = await client.getRunner();
    if (!runner.live) {
      throw new Error(
        "No persistent runner is online. Start one with `muon runner`, then retry."
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
    input.onStatus(`dispatch ${job.id} queued for step '${step.stepKey}'`);

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
        input.onLiveEvent(streamToLiveEvent(chunk));
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

    // Same entry point as the CLI executor and the loop (governed-op
    // cross-surface parity): a check is worth the same here as it is there,
    // coverage included, with the changed packages' own suites run where the
    // declared command cannot see them.
    if (ok && !step.loop && harness.checks.length > 0) {
      const checkRun = await runChecksWithCoverage({
        checks: harness.checks,
        cwd: worktree.path,
        stopOnFirstFailure: true,
      });
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
        summary = `${summary} (checks not qualified against a diff: ${checkRun.unqualified})`;
      }
    }

    const changedFiles = await worktreeChangedFiles(worktree.path).catch(
      () => undefined
    );
    return { ok, summary, changedFiles };
  };
}

function buildLedger(
  input: ExecuteWorkflowInput,
  gateTimeoutMs: number
): WorkflowLedger {
  const { client } = input;
  let lanesCache: { id: string; key: string }[] | undefined;

  return {
    updateRunStatus: (args) =>
      client.updateWorkflowRun({ runId: args.runId, status: args.status }),
    recordEvent: (event) => client.recordEvent(event),
    requestApproval: (args) => client.requestApproval(args),
    waitForApproval: async (approvalId) => {
      input.onStatus(
        `⛔ gate waiting in the inbox (${approvalId}), press a/r on it, or approve from web/desktop`
      );
      await waitForApproval(client, approvalId, { timeoutMs: gateTimeoutMs });
    },
    assignTask: (args) => client.assignTask(args),
    updateTaskStatus: (taskId, status) =>
      client.updateTaskStatus(taskId, status as TaskStatus),
    createHandoff: (args) => client.createHandoff(args),
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

export async function executeWorkflowInTui(
  input: ExecuteWorkflowInput
): Promise<WorkflowOutcome> {
  const detail = await input.client.getWorkflowRun(input.runId);
  const gateTimeoutMs = input.gateTimeoutMs ?? GATE_TIMEOUT_DEFAULT_MS;

  return runWorkflowRun({
    runId: input.runId,
    proposal: detail.run.proposal,
    tasks: detail.tasks.map((task) => ({
      id: task.id,
      stepKey: task.stepKey ?? null,
      status: task.status,
      title: task.title,
      description: task.description,
      workspacePath: task.workspacePath ?? null,
    })),
    ledger: buildLedger(input, gateTimeoutMs),
    dispatch: buildDispatch(input, detail.run.workspacePath ?? undefined),
  });
}
