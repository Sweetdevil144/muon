import type { LaneEvent } from "@muon/core";
// Via @muon/client, not @muon/protocol: the TUI depends on the client alone.
import {
  classifyVendorFailure,
  sanitizeVendorErrorMessage,
  withoutBudgetMarker,
} from "@muon/client";
import type {
  Lane,
  MuonApiClient,
  RecordedEvent,
  StreamChunk,
  VendorReadiness,
} from "@muon/client";

export type DispatchInput = {
  client: MuonApiClient;
  lane: Lane;
  taskId: string;
  brief: string;
  cwd?: string;
  timeoutMs?: number;
  harnessKey?: string;
  /** Test seam and low-latency terminal tuning. */
  pollMs?: number;
  /** Live callback so the cockpit can stream events into the lane column. */
  onLiveEvent: (event: RecordedEvent) => void;
};

export type DispatchResult = {
  exitCode: number;
  durationMs: number;
  output: string;
  recorded: number;
  failures: number;
};

let liveEventCounter = 0;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);
const DEFAULT_POLL_MS = 500;
const DEFAULT_WAIT_MS = 30 * 60_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function toLiveEvent(event: LaneEvent): RecordedEvent {
  liveEventCounter += 1;
  return {
    id: `live-${liveEventCounter}`,
    laneId: event.laneId,
    taskId: event.taskId,
    kind: event.kind,
    message: event.message,
    metadata: event.metadata ?? {},
    timestamp: event.timestamp,
  };
}

function streamToLiveEvent(chunk: StreamChunk): RecordedEvent {
  return {
    id: `stream-${chunk.seq}`,
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

/**
 * TUI `run`, creates the assignment, enqueues one durable dispatch, observes
 * its persisted stream, and records compact lifecycle events. The TUI never
 * claims a fleet agent or launches a vendor process itself.
 */
/**
 * A failure BEFORE the vendor ever ran — MUON's own control plane could not
 * start the work (no runner, assignment refused, enqueue refused).
 *
 * Marked so a surface does not hand it to `classifyVendorFailure`, whose whole
 * job is diagnosing a VENDOR. Review pass 11 F5 measured both ways that goes
 * wrong: a MUON API-token 401 matches the classifier's `/401|unauthorized/i`
 * and renders as "Codex isn't connected, run `codex login`" while the vendor is
 * perfectly fine; and the commonest first-run failure — "No persistent runner
 * is online. Start one with `muon runner`" — gets its detail REPLACED by
 * onboarding copy, destroying the one actionable sentence in it.
 *
 * Duck-typed rather than `instanceof`, because these errors cross a package
 * boundary where a duplicated class identity would silently stop matching.
 */
export const RUN_DISPATCH_STAGE = "muonRunDispatchStage" as const;

/**
 * ONE source for the stage set. The type AND the guard derive from this array,
 * because the first version of this module listed the members twice — a union
 * for the type and a literal comparison in the guard — and adding a stage to
 * one without the other is exactly how a new member silently stops being
 * recognised. The polling stage was in fact missed on the first pass: a
 * `getDispatchJob` rejection and the deadline throw both propagated untagged,
 * so the desk classified MUON's own failure as a vendor login problem.
 */
export const RUN_DISPATCH_STAGES = [
  "runner",
  "assign",
  "enqueue",
  "poll",
] as const;
export type RunDispatchStage = (typeof RUN_DISPATCH_STAGES)[number];

export function runDispatchError(
  stage: RunDispatchStage,
  message: string,
  cause?: unknown
): Error {
  const error = new Error(message) as Error & {
    [RUN_DISPATCH_STAGE]?: RunDispatchStage;
  };
  error[RUN_DISPATCH_STAGE] = stage;
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

/** True when MUON, not the vendor, is why this run did not start. */
export function runDispatchStageOf(error: unknown): RunDispatchStage | null {
  if (!error || typeof error !== "object") return null;
  const stage = (error as Record<string, unknown>)[RUN_DISPATCH_STAGE];
  return RUN_DISPATCH_STAGES.includes(stage as RunDispatchStage)
    ? (stage as RunDispatchStage)
    : null;
}

export async function dispatchRun(input: DispatchInput): Promise<DispatchResult> {
  const { client, lane, taskId, brief } = input;
  const runner = await client.getRunner().catch((cause: unknown) => {
    throw runDispatchError(
      "runner",
      "MUON could not reach its runner service. Check that the backend is running, then retry.",
      cause
    );
  });
  if (!runner.live) {
    throw runDispatchError(
      "runner",
      "No persistent runner is online. Start one with `muon runner`, then retry."
    );
  }

  const baseline = await client
    .listStreamChunks({ taskId, latest: true, limit: 1 })
    .catch(() => []);
  let afterSeq = baseline.at(-1)?.seq ?? 0;

  await client
    .assignTask({
      taskId,
      laneId: lane.id,
      summary: `tui run: ${brief.slice(0, 120)}`,
    })
    .catch((cause: unknown) => {
      throw runDispatchError(
        "assign",
        `MUON refused to assign ${taskId} to ${lane.key}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      );
    });

  const job = await client
    .enqueueDispatch({
      kind: "oneshot",
      vendor: lane.key,
      taskId,
      brief,
      ...(input.harnessKey ? { harnessKey: input.harnessKey } : {}),
      ...(input.cwd ? { workspacePath: input.cwd } : {}),
    })
    .catch((cause: unknown) => {
      throw runDispatchError(
        "enqueue",
        `MUON refused to enqueue this dispatch: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      );
    });

  let recorded = 0;
  let failures = 0;
  const record = async (event: LaneEvent) => {
    try {
      await client.recordEvent(event);
      recorded += 1;
    } catch {
      failures += 1;
    }
  };
  let lifecycleEvent = 0;
  const lifecycleId = () => {
    lifecycleEvent += 1;
    return `dispatch-${job.id}-${lifecycleEvent}`;
  };
  const startedAt = Date.now();
  const started: LaneEvent = {
    id: lifecycleId(),
    laneId: lane.id,
    taskId,
    kind: "task.started",
    message: `dispatch ${job.id} queued`,
    metadata: { jobId: job.id },
    timestamp: new Date().toISOString(),
  };
  input.onLiveEvent(toLiveEvent(started));
  await record(started);

  const deadline = startedAt + (input.timeoutMs ?? DEFAULT_WAIT_MS);
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  let terminal;
  for (;;) {
    // MUON's own read, so a rejection here is MUON's failure, not the
    // vendor's — the job may well be running fine while the control plane is
    // unreachable.
    const current = await client.getDispatchJob(job.id).catch((cause: unknown) => {
      throw runDispatchError(
        "poll",
        `MUON could not read dispatch ${job.id}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause
      );
    });
    const chunks = await client
      .listStreamChunks({
        taskId,
        afterSeq,
        limit: 100,
      })
      .catch(() => []);
    if (chunks.length > 0) {
      for (const chunk of chunks) {
        input.onLiveEvent(streamToLiveEvent(chunk));
      }
      afterSeq = chunks[chunks.length - 1]?.seq ?? afterSeq;
      await record({
        id: lifecycleId(),
        laneId: lane.id,
        taskId,
        kind: "task.progress",
        message: chunks.map((chunk) => chunk.content).join("\n").slice(-2_000),
        metadata: {
          jobId: job.id,
          streamChunks: chunks.length,
          afterSeq,
        },
        timestamp: chunks[chunks.length - 1]?.timestamp ?? new Date().toISOString(),
      });
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      terminal = current;
      break;
    }
    if (Date.now() >= deadline) {
      // The WATCH timed out, not the agent. The job keeps running under the
      // runner; only this desk stopped waiting — say that, rather than letting
      // the vendor classifier suggest a re-login.
      throw runDispatchError(
        "poll",
        `MUON stopped watching dispatch ${job.id} after ${
          input.timeoutMs ?? DEFAULT_WAIT_MS
        }ms — the job may still be running; check the lane.`
      );
    }
    await delay(pollMs);
  }

  const exitCode =
    terminal.exitCode ?? (terminal.status === "done" ? 0 : 1);
  const completed: LaneEvent = {
    id: lifecycleId(),
    laneId: lane.id,
    taskId,
    kind: terminal.status === "done" ? "task.completed" : "task.blocked",
    message:
      terminal.status === "done"
        ? `dispatch ${job.id} completed`
        : // The lane event is prose the operator reads in the rail, so the
          // machine classifier is stripped here exactly as the fleet rail and
          // the desktop pane strip it (one shared definition).
          `dispatch ${job.id} ${terminal.status}: ${
            withoutBudgetMarker(terminal.result ?? "").slice(-500) ||
            "no result was recorded"
          }`,
    metadata: {
      jobId: job.id,
      dispatchStatus: terminal.status,
      exitCode,
    },
    timestamp: terminal.endedAt ?? new Date().toISOString(),
  };
  input.onLiveEvent(toLiveEvent(completed));
  await record(completed);

  return {
    exitCode,
    durationMs: Date.now() - startedAt,
    output: terminal.result ?? "",
    recorded,
    failures,
  };
}

/**
 * ONE answer to "what do I show when a run fails?", for every surface.
 *
 * The stage tags below exist so MUON's own control-plane failures stop being
 * diagnosed as vendor login problems. The new desk consumed them; the CLASSIC
 * desk — the one that actually ships — passed the same errors straight to
 * `classifyVendorFailure` and told the operator to re-authenticate a vendor
 * that was never involved. That is the third time in this branch a fix landed
 * on one surface and not its twin, so the decision moves HERE, beside the
 * tagging, where a surface cannot hold a different opinion about it.
 *
 * A tagged error is MUON's and is shown as itself: it already carries the
 * actionable sentence (`muon runner`, "the job may still be running"), and
 * routing it through the vendor classifier replaces that with onboarding copy.
 * Everything else is genuinely the vendor's and keeps the shared classifier's
 * onboarding/retry split.
 */
export function describeRunFailure(input: {
  readonly error: unknown;
  readonly vendor: string;
  readonly readiness?: VendorReadiness[] | null;
}): string {
  if (runDispatchStageOf(input.error)) {
    return `✗ ${sanitizeVendorErrorMessage(input.error)} (press / to retry)`;
  }
  const notice = classifyVendorFailure({
    vendor: input.vendor,
    readiness: input.readiness ?? null,
    error: input.error,
  });
  return notice.route === "onboarding"
    ? `✗ ${notice.title}, ${notice.fixHint ?? notice.detail}`
    : `✗ ${notice.title}: ${notice.detail} (press / to retry)`;
}
