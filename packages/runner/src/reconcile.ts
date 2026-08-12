import type { DispatchJobRecord, MuonApiClient } from "@muon/client";
import { isUncertainTerminalOutcome } from "@muon/protocol";
import {
  countAutoTurnsSinceHuman,
  detectStuckPattern,
  stuckStepsFromChunks,
  fileJobTerminalGate,
  isWatchedWorkerJob,
  jobTerminalMilestone,
  reconcileTerminalJob,
  runChatTurn,
  type MissionRoster,
  type OrchestratorLaneKey,
  type ReconcileDeps,
  type ReconcileOutcome,
} from "@muon/orchestrator";

// Worker output is untrusted agent data; only the tail rides into the nudge
// envelope (payload-is-data), never the full result and never as instructions.
// Mirrors the desktop's JOB_RESULT_TAIL_MAX so both surfaces frame the event
// identically.
const JOB_RESULT_TAIL_MAX = 2000;

// The lane the chat's durable milestones live on (matches runChatTurn's writes).
const CHAT_LANE_ID = "muon-chat";
// A chat's governed-child window. Generous: a mission realistically never fans
// out this far, so the roster the wake turn reads is the whole crew.
const CHAT_JOB_PAGE = 200;
const LIVE_STATUSES = new Set(["queued", "running"]);
/** Pause between the reconcile core's two bounded nudge attempts. */
const NUDGE_RETRY_MS = 750;

/**
 * Which MISSION a chat-bound worker belongs to: the chat root whose turn
 * dispatched it. `rootJobId` is the lineage column; a direct child of the chat
 * root predates it on some rows, and there `parentJobId` IS the root. Returns
 * undefined only for a row that is neither, which `isWatchedWorkerJob` already
 * excludes.
 */
function missionOf(job: DispatchJobRecord): string | undefined {
  return job.rootJobId ?? job.parentJobId ?? undefined;
}

/**
 * How the mission's own coordinator turn was configured, read back off the root
 * DispatchJob the operator's turn created.
 *
 * A wake is a CONTINUATION of that turn, so it must run the same way. The
 * runner used to send none of this and the desktop's event turn sent all of it
 * — a divergence that stayed invisible only because every runner wake was
 * refused before it could run. Left live it would have put the continuation on
 * the DEFAULT lane rather than the mission's coordinator, and on the lane's
 * default model rather than the operator's chosen one.
 *
 * Read defensively: an unreadable root yields an empty settings object and the
 * wake falls back to exactly today's defaults rather than failing.
 */
type MissionTurnSettings = {
  vendor?: string;
  model?: string;
  effort?: string;
};

function missionTurnSettings(root: DispatchJobRecord): MissionTurnSettings {
  const patch = (root.actionProfilePatch ?? {}) as Record<string, unknown>;
  const model = typeof patch.model === "string" ? patch.model : undefined;
  return {
    vendor: root.vendor,
    ...(model ? { model } : {}),
    ...(effortFrom(root, patch) ? { effort: effortFrom(root, patch)! } : {}),
  };
}

/**
 * The reasoning-effort LEVEL the mission ran at, recovered from the resolved
 * action the route persisted. `effort` is a vendor-shaped action — a
 * `profileField` patch on codex, an argv `flag` on claude-code — so both shapes
 * are read by name. Anything else returns undefined and the wake simply omits
 * effort; guessing a level would be worse than inheriting the lane default.
 */
function effortFrom(
  root: DispatchJobRecord,
  patch: Record<string, unknown>
): string | undefined {
  if (root.action !== "effort") {
    return undefined;
  }
  const rawConfig = patch.rawConfig as Record<string, unknown> | undefined;
  const configured = rawConfig?.model_reasoning_effort;
  if (typeof configured === "string" && configured) {
    return configured;
  }
  const extraArgs = patch.extraArgs;
  if (Array.isArray(extraArgs)) {
    const at = extraArgs.indexOf("--effort");
    const level = at >= 0 ? extraArgs[at + 1] : undefined;
    if (typeof level === "string" && level) return level;
  }
  return undefined;
}
// A generous page: a chat realistically never accrues this many chunks between
// two human messages, so the last `[you]` and every event milestone since it
// are always in the window the durable cap counter reads.
const CHAT_CHUNK_PAGE = 500;

export type RunnerReconcilerOptions = {
  client: MuonApiClient;
  apiBase: string;
  /** AGENT-tier token; the resumed turn files gates but never governs (P3-A). */
  apiToken?: string;
  /** Gate the whole behavior (mirrors the desktop autoContinue setting). */
  autoContinue: boolean;
  /**
   * Process-local per-chat turn slot. Held for the DURATION of a reconciliation
   * turn so a second worker finishing on the same chat DEFERS (and is retried)
   * instead of racing a second concurrent resume of the one vendor session.
   */
  runningTurns: Set<string>;
  /** Drains a pending nudge poll on runner shutdown. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Test seam: run ONE enveloped reconciliation turn (prod = runChatTurn). */
  runNudgeTurn?: (chatId: string, job: DispatchJobRecord) => Promise<void>;
};

export type RunnerReconciler = {
  /**
   * Reconcile ONE terminal worker job into a bounded, consented continuation.
   * Returns the outcome; "deferred" means a turn is already running for this
   * chat and the caller should retry.
   */
  reconcile: (job: DispatchJobRecord) => Promise<ReconcileOutcome>;
};

/**
 * Wire the shared S4 reconcile core to the always-alive runner (task #127). The
 * runner is the ONE process that literally marks jobs terminal, so this is where
 * the durable auto-resume belongs — the orchestrator now resumes on CLI/TUI/
 * desktop alike, with no manual "status" nudge.
 *
 * Cross-surface / cross-restart dedupe is the SAME durable chat-lane milestone
 * the desktop uses, so a runner-fired nudge and a still-open desktop's nudge can
 * never double-fire (whichever writes the milestone first owns the event). The
 * auto-turn cap is likewise durable: it is COUNTED from the chat lane, so it
 * survives a runner restart without any in-memory carry.
 */
export function createRunnerReconciler(
  options: RunnerReconcilerOptions
): RunnerReconciler {
  const { client } = options;
  const requireActiveChat = async (chatId: string) => {
    const chat = await client.getChat(chatId).catch(() => null);
    if (!chat || chat.status === "archived") {
      throw new Error("Cannot reconcile an archived orchestrator chat.");
    }
    return chat;
  };

  /**
   * The mission's governed children at wake time, so the continuation can name
   * WHICH children finished (and whether any is still live) instead of naming
   * only the one whose terminal event happened to fire. Ledger rows, so the
   * turn's trusted control block may carry them.
   *
   * Best-effort and bounded: a failed read falls back to the single event, which
   * is exactly the behavior before this existed. The event's own job is folded
   * in explicitly because its terminal status may not have propagated to the
   * listing yet.
   */
  const missionRoster = async (
    chatId: string,
    job: DispatchJobRecord
  ): Promise<MissionRoster | undefined> => {
    const jobs = await client
      // LATEST, not the first page: the listing is createdAt ASC, so a chat on
      // its third mission returned its FIRST mission's children and the current
      // crew fell outside the window entirely.
      .listDispatchJobs({ chatId, limit: CHAT_JOB_PAGE, latest: true })
      .catch(() => undefined);
    if (!jobs) {
      return undefined;
    }
    // MISSION-scoped, not chat-scoped. A chat outlives any one mission, and
    // scoping by chatId alone was wrong twice over: mission 2's summary
    // re-reported mission 1's children as its own work, and a single stuck
    // `queued` child left over from an abandoned mission held `live > 0`
    // forever — which made "nothing is runnable" unreachable and the final
    // summary structurally impossible for the rest of that chat's life.
    const mission = missionOf(job);
    const children = jobs.filter(
      (candidate) =>
        isWatchedWorkerJob(candidate) && missionOf(candidate) === mission
    );
    const finished = children
      .filter(
        (child) => child.id !== job.id && !LIVE_STATUSES.has(child.status)
      )
      .map((child) => ({
        jobId: child.id,
        taskId: child.taskId,
        vendor: child.vendor,
        status: child.status,
      }));
    return {
      finished: [
        {
          jobId: job.id,
          taskId: job.taskId,
          vendor: job.vendor,
          status: job.status,
        },
        ...finished,
      ],
      live: children.filter(
        (child) => child.id !== job.id && LIVE_STATUSES.has(child.status)
      ).length,
    };
  };

  const runNudgeTurn =
    options.runNudgeTurn ??
    (async (chatId: string, job: DispatchJobRecord) => {
      // Fetch fresh: the vendorSessionId must be current to resume the session.
      const chat = await requireActiveChat(chatId);
      const mission = await missionRoster(chatId, job);
      const missionRootId = missionOf(job);
      const root = missionRootId
        ? await client.getDispatchJob(missionRootId).catch(() => undefined)
        : undefined;
      const turn = root ? missionTurnSettings(root) : {};
      await runChatTurn({
        client,
        chat,
        // Unused for event turns (no `[you]` milestone / titling); kept legible.
        message: `job ${job.id} terminal`,
        apiBase: options.apiBase,
        // AGENT-tier token (P3-A): the reconciliation turn runs WITHOUT govern
        // authority, identical to a human-typed turn — it files gates, never
        // grants. The runner's own client is already agent-tier; auth flows
        // through it, so this only mirrors the desktop's runEventTurn shape.
        apiToken: options.apiToken,
        // Drain-safe: a runner shutdown aborts the completion poll so a pending
        // nudge never holds the process open for the full turn budget.
        signal: options.signal,
        // The mission's own coordinator seat, model and effort — a continuation
        // of a turn must run the way that turn ran. Each is sent only when the
        // root actually carried it, so a mission with no overrides produces a
        // byte-identical wake to before.
        ...(turn.vendor ? { vendor: turn.vendor as OrchestratorLaneKey } : {}),
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        // Full-Auto: a machine wake carries the SAME safety block a human turn
        // does, so the gates-off orchestrator stays conservative. Without it the
        // wake ran with every gate auto-approving and none of the caution that
        // is supposed to accompany that. Same env the runner already reads when
        // it fuses the worker preamble (execute.ts), so one switch governs both.
        ...(process.env.MUON_FULL_AUTO === "1" ? { fullAuto: true } : {}),
        event: {
          jobId: job.id,
          taskId: job.taskId,
          status: job.status,
          exitCode: job.exitCode ?? null,
          resultTail: (job.result ?? "").slice(-JOB_RESULT_TAIL_MAX),
          ...(mission ? { mission } : {}),
        },
      });
    });

  const buildDeps = async (chatId: string): Promise<ReconcileDeps> => {
    // The durable cap counter: `[event]` milestones since the last `[you]`. Read
    // once up front (chronological order) so the cap survives a runner restart.
    const chunks = await client
      .listStreamChunks({
        taskId: chatId,
        latest: true,
        limit: CHAT_CHUNK_PAGE,
      })
      // The success path returns full StreamChunks (kind included); the failure
      // fallback carries the SAME shape so countAutoTurnsSinceHuman can kind-gate.
      .catch(() => [] as { content: string; kind: string }[]);
    return {
      milestoneFor: (jobId) => jobTerminalMilestone(jobId),
      claimMilestone: async (id, claimKey, content) => {
        // Archive can land after the outer reconcile pre-check while the durable
        // lane is loading. Recheck at the write boundary so a closed chat never
        // receives a hidden terminal milestone.
        await requireActiveChat(id);
        const result = await client.claimStreamChunk({
          taskId: id,
          laneId: CHAT_LANE_ID,
          claimKey,
          kind: "milestone",
          content,
        });
        return result.claimed;
      },
      autoContinueEnabled: options.autoContinue,
      autoTurnsUsed: countAutoTurnsSinceHuman(chunks),
      // TODO 5.4: named stuck halt over the same durable window as the cap.
      stuckReason: detectStuckPattern(stuckStepsFromChunks(chunks))?.message ?? null,
      // Held through the turn (see runningTurns doc): serializes resumes and, as
      // a side effect, prevents the durable counter from being double-read.
      tryClaimTurnSlot: (id) => {
        if (options.runningTurns.has(id)) {
          return false;
        }
        options.runningTurns.add(id);
        return true;
      },
      releaseTurnSlot: (id) => {
        options.runningTurns.delete(id);
      },
      // No in-memory tally: claimTerminalEvent has already written this event's
      // `[event]` milestone by the time onNudge runs, so the next reconcile's
      // countAutoTurnsSinceHuman sees it. The durable stream IS the counter.
      onNudge: () => undefined,
      runNudgeTurn,
      fileGate: async (id, job) => {
        // The uncertain path does not call runNudgeTurn, so it needs its own
        // final archive fence immediately before creating a visible approval.
        await requireActiveChat(id);
        await fileJobTerminalGate(client, id, job);
      },
      // No renderer in the runner: the durable milestone + chat history carry the
      // "worker finished while idle" state for whatever surface opens next.
      showAffordance: () => undefined,
      // A failed wake used to reach a runner log line and nowhere else. That is
      // how a 403 on the continuation dispatch became total silence in Mission
      // Chat: the durable `[event]` claim was already written, so nothing
      // retried and nothing said why. Write the reason where the human is
      // looking. Deliberately NOT an `[event] job … terminal` milestone, so it
      // can never be miscounted against the auto-continue cap.
      onError: async (id, message) => {
        options.log?.(`reconcile ${id.slice(0, 8)}: ${message}`);
        // AWAITED, not a floating `void`: this chunk is the only thing that
        // tells the human why continuation stopped, and the failure that
        // triggers it is most likely at runner shutdown — precisely when an
        // unawaited write is dropped.
        // TODO 5.4: stuck halts share this seam with a distinct prefix so the
        // operator message is the named reason, not a generic reconcile failure.
        const content = message.startsWith("Halted:")
          ? `[stuck.halt] ${message}. Continue orchestration by hand.`
          : `[reconcile.failed] MUON could not auto-continue after a worker finished: ${message}. Continue orchestration by hand.`;
        await client
          .recordStreamChunks([
            {
              taskId: id,
              laneId: CHAT_LANE_ID,
              kind: "milestone",
              content,
            },
          ])
          .catch(() => undefined);
      },
      // A real pause between the two bounded attempts, so the retry gives a
      // racing human turn or a settling backend a moment rather than
      // immediately re-hitting the same conflict.
      retryDelay: () =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, NUDGE_RETRY_MS);
          timer.unref?.();
        }),
    };
  };

  return {
    reconcile: async (job) => {
      const chatId = job.chatId;
      if (!chatId) {
        return "skipped";
      }
      // A terminal event can race a human archive. Check before writing the
      // dedupe milestone or filing any gate, so an archived chat never receives
      // hidden continuation state. runNudgeTurn repeats the check after the
      // claim to close the check→archive race.
      const chat = await client.getChat(chatId).catch(() => null);
      if (!chat || chat.status === "archived") {
        return "skipped";
      }
      const deps = await buildDeps(chatId);
      return reconcileTerminalJob(
        // Uncertain (interrupted/reclaimed/wall-budget kill) → the core routes
        // to a human gate, NEVER an autonomous replay.
        //
        // Derived from the SHARED predicate, never from a status string. A
        // wall-budget kill commits `failed`, and spelling the rule as
        // `status === "interrupted"` here quietly turned that whole class from
        // "human approves" into "one autonomous coordinator turn" — while the
        // resume planner two packages away still called it human-only. The
        // reclassification's value was HONEST REPORTING, which the gate reason
        // now carries (fileJobTerminalGate), not the removal of the gate: a
        // worker killed 3s over budget mid-edit has partial unverified writes.
        { job, uncertain: isUncertainTerminalOutcome(job) },
        deps
      );
    },
  };
}
