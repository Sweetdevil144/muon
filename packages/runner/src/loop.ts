import { randomBytes } from "node:crypto";
import {
  MuonApiClient,
  type
  AgentRecord,
  DispatchJobRecord,
  VendorReadiness,
} from "@muon/client";
import {
  PRE_LAUNCH_INTERRUPT_RESULTS,
  type HandoffPacket,
  type AttemptOutcome,
} from "@muon/protocol";
import {
  fileJobTerminalGate,
  isWatchedWorkerJob,
  type ReconcileOutcome,
} from "@muon/orchestrator";
import {
  redactForLog,
  type LanePtySpawn,
  type MemoryIngestSink,
} from "@muon/core";
import {
  executeJob,
  runPendingCapture,
  type ExecuteResult,
} from "./execute.js";
import { createRunnerReconciler, type RunnerReconciler } from "./reconcile.js";

export type RunnerLoopOptions = {
  host: string;
  pid: number;
  /** Trusted launchers pass an operator-preauthorized token; fallback is a test seam. */
  leaseToken?: string;
  apiBase: string;
  apiToken?: string;
  /** Max jobs executing at once across all vendors (fleet caps still apply). */
  concurrency?: number;
  /** Queue poll interval. */
  pollMs?: number;
  /** Heartbeat interval, must be < the brain's 15s liveness window. */
  heartbeatMs?: number;
  /** Backoff seam for durable recovery/terminal retries (tests may collapse it). */
  retryDelay?: (ms: number) => Promise<void>;
  /** Poll interval for persisted human/ancestor interrupt requests. */
  interruptPollMs?: number;
  onLog?: (line: string) => void;
  /** Execution seam for adversarial tests; production uses executeJob. */
  execute?: typeof executeJob;
  /**
   * REAL-terminal factory for one-shot vendor children (see
   * `ExecuteOptions.ptySpawn`). Injected by the launcher that owns the native
   * dependency (the desktop runner entry); absent → pipes, as today.
   */
  ptySpawn?: LanePtySpawn;
  /**
   * S4 durable auto-reconcile (task #127). When a delegated worker finishes, the
   * always-alive runner auto-resumes the orchestrator with ONE bounded turn (or
   * files a human gate for an uncertain outcome), so CLI/TUI/desktop all get
   * auto-resume with no manual "status" nudge. Default ON (mirrors the desktop
   * autoContinue setting); resolved from MUON_AUTO_CONTINUE when omitted, so an
   * operator opts out with MUON_AUTO_CONTINUE=0. A still-open desktop monitor
   * can never double-fire — both go through the SAME durable chat-lane milestone.
   */
  autoContinue?: boolean;
  /** Reconcile seam for adversarial tests; production builds one from the client. */
  reconciler?: RunnerReconciler;
  /** Backoff before retrying a reconcile that deferred (a turn was running). */
  reconcileRetryMs?: number;
  /**
   * B1: how long an `orchestrator` root may sit `queued` because the vendor's
   * single coordinator seat is held, before the runner gives it a terminal,
   * legible failure instead of a silent wait. Bounded FAR below the 30-minute
   * chat-turn budget on purpose — see COORDINATOR_SEAT_WAIT_MS.
   */
  coordinatorSeatWaitMs?: number;
  /** Abort to drain: stops claiming new jobs and waits for in-flight ones. */
  signal?: AbortSignal;
};

/**
 * B1: the bound on "waiting for the one coordinator seat".
 *
 * There is exactly ONE coordinator seat per vendor (fleet ordinal 0), and an
 * `orchestrator` job may claim only that ordinal — so a failed claim for such a
 * job is never "wait for a free worker", it is "the single seat is taken". The
 * old code swallowed that 409 (`if (isLeaseConflict(error)) break;` then
 * `if (!claimed) continue;`) with no terminal write, no chunk and no event, so
 * the job sat `queued` while a human watched Mission Chat spin for the full
 * CHAT_TURN_TIMEOUT_MS (30 minutes) — the founder's exact reported symptom.
 *
 * 60s is deliberately generous enough to absorb the ordinary case this bound
 * must NOT break: a seat that frees within seconds (the previous turn is
 * finishing, or a runner-fired auto-continue nudge raced a human turn) still
 * gets claimed normally on a later poll tick. Past it, failing loudly beats
 * waiting silently.
 *
 * WORKER jobs are deliberately untouched: queueing behind a busy fleet is
 * exactly what the 0–3 semaphore is for.
 */
export const COORDINATOR_SEAT_WAIT_MS = 60_000;

/** The chat lane every Mission Chat milestone is written on. */
const CHAT_LANE_ID = "muon-chat";

/** Auto-continue defaults ON (desktop parity); MUON_AUTO_CONTINUE=0 opts out. */
function resolveAutoContinue(opts: RunnerLoopOptions): boolean {
  if (typeof opts.autoContinue === "boolean") {
    return opts.autoContinue;
  }
  const env = process.env.MUON_AUTO_CONTINUE?.trim().toLowerCase();
  return env !== "0" && env !== "false" && env !== "off";
}

/** A sleep that wakes immediately when the runner is asked to drain. */
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function isLeaseConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b/.test(message);
}

async function commitTerminal(
  client: MuonApiClient,
  input: {
    jobId: string;
    status: ExecuteResult["status"];
    result: string;
    exitCode?: number | null;
    /** Typed terminal handoff packet (P0.3); null means "no packet". */
    packet?: HandoffPacket | null;
  },
  opts: RunnerLoopOptions,
  leaseToken: string,
  log: (line: string) => void
): Promise<boolean> {
  const retryDelay = opts.retryDelay ?? ((ms: number) => delay(ms));
  let attempt = 0;
  while (true) {
    try {
      await client.updateDispatchJobForLease({
        ...input,
        host: opts.host,
        leaseToken,
      });
      return true;
    } catch (error) {
      if (isLeaseConflict(error)) {
        log(
          `terminal write for ${input.jobId.slice(0, 8)} was fenced; successor reconciliation owns the durable status`
        );
        return false;
      }
      attempt += 1;
      const waitMs = Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5000);
      log(
        `terminal write for ${input.jobId.slice(0, 8)} failed (attempt ${attempt}); retrying in ${waitMs}ms`
      );
      await retryDelay(waitMs);
    }
  }
}

/**
 * B2: the post-terminal memory sink for one job.
 *
 * The per-job capability the run used for its content writes is dead the moment
 * the job stops being `running` — deliberately, because that credential is the
 * one a VENDOR process holds, and keeping it warm to suit a background chore
 * would widen exactly the window it exists to close. The runner writes on its
 * OWN lease instead; the route derives author/task/chat from the stored job row,
 * so nothing here can name a partition of its own.
 */
function leaseMemorySink(
  client: MuonApiClient,
  jobId: string,
  host: string,
  leaseToken: string
): MemoryIngestSink {
  return {
    addMemoryNoteWithAction: (candidate) =>
      client.captureJobMemoryForLease({
        jobId,
        host,
        leaseToken,
        note: {
          kind: candidate.kind,
          text: candidate.text,
          laneId: candidate.laneId,
          modules: candidate.modules,
          topics: candidate.topics,
          symbols: candidate.symbols,
          outcome: candidate.outcome,
        },
      }),
  };
}

async function runOne(
  client: MuonApiClient,
  job: DispatchJobRecord,
  agent: AgentRecord,
  opts: RunnerLoopOptions,
  leaseToken: string,
  log: (line: string) => void,
  controller: AbortController,
  /** Fire the durable auto-reconcile for a watched worker's terminal event. */
  scheduleReconcile: (job: DispatchJobRecord) => void
): Promise<void> {
  const signal = controller.signal;
  log(`▶ ${job.vendor} · ${job.kind} · job ${job.id} · task ${job.taskId}`);
  let result: ExecuteResult;
  let jobCapabilityToken: string | undefined;
  let canDelegate = false;
  try {
    const issued = await client.issueDelegationTokenForLease({
      jobId: job.id,
      host: opts.host,
      leaseToken,
    });
    jobCapabilityToken = issued.token;
    canDelegate = issued.canDelegate;
  } catch (error) {
    result = {
      status: "failed",
      result: `could not issue job-bound agent capability: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    const wrote = await commitTerminal(
      client,
      {
        jobId: job.id,
        status: result.status,
        result: result.result,
      },
      opts,
      leaseToken,
      log
    );
    log(
      `■ job ${job.id.slice(0, 8)} → ${result.status}${wrote ? "" : " (status write failed)"}`
    );
    if (wrote && isWatchedWorkerJob(job)) {
      scheduleReconcile({
        ...job,
        status: result.status,
        result: result.result,
        exitCode: result.exitCode ?? null,
      });
    }
    return;
  }
  const jobClient = new MuonApiClient(
    opts.apiBase,
    fetch,
    jobCapabilityToken
  );
  const monitorStop = new AbortController();
  const interruptMonitor = (async () => {
    const pollMs = opts.interruptPollMs ?? 250;
    while (!monitorStop.signal.aborted && !signal.aborted) {
      try {
        const current = await client.getDispatchJob(job.id);
        if (current.interruptRequested) {
          log(`  ${job.id.slice(0, 8)}: interrupt requested, aborting execution`);
          // A TYPED reason: the bare abort() left the terminal attribution
          // with nothing to classify, and its fallback blamed "runner
          // authority was lost" — a coordinator's deliberate interrupt was
          // recorded as an infrastructure failure (job 81ddb7bb, 2026-08-05).
          controller.abort(
            Object.assign(new Error("interrupt requested"), {
              code: "MUON_INTERRUPT_REQUESTED" as const,
            })
          );
          return;
        }
      } catch {
        // A transient read failure cannot revoke the runner lease or execution.
      }
      await delay(pollMs, monitorStop.signal);
    }
  })();
  try {
    const execute = opts.execute ?? executeJob;
    result = await execute(client, job, agent, {
      apiBase: opts.apiBase,
      apiToken: jobCapabilityToken,
      jobClient,
      signal,
      delegationToken: canDelegate ? jobCapabilityToken : undefined,
      runnerLease: { host: opts.host, leaseToken },
      onLog: (line) => log(`  ${job.id.slice(0, 8)}: ${line}`),
      ...(opts.ptySpawn ? { ptySpawn: opts.ptySpawn } : {}),
    });
  } catch (error) {
    result = signal.aborted
      ? {
          status: "interrupted",
          result: "runner lease was replaced while this job was executing",
        }
      : {
          status: "failed",
          result: `runner error: ${error instanceof Error ? error.message : error}`,
        };
  } finally {
    monitorStop.abort();
    await interruptMonitor.catch(() => undefined);
  }
  // Stay self-healing while this lease is authoritative: transient backend
  // loss cannot strand a running job forever. A successor lease conflict is
  // the only reason to stop; that successor reclaims this job transactionally.
  const wrote = await commitTerminal(
    client,
    {
      jobId: job.id,
      status: result.status,
      result: result.result,
      exitCode: result.exitCode ?? null,
      // Lease-fenced retries resend the SAME packet; the backend's exact-replay
      // check deliberately ignores it.
      packet: result.packet ?? null,
    },
    opts,
    leaseToken,
    log
  );
  log(
    `■ job ${job.id.slice(0, 8)} → ${result.status}${wrote ? "" : " (status write failed)"}`
  );

  // S4 durable auto-reconcile (task #127): the runner just marked this job
  // terminal, so it is the process that must auto-resume the orchestrator. Only
  // for a WATCHED worker (a chat-bound delegated child) and only when the status
  // actually committed (a fenced write means the successor owns reconciliation).
  // Detached inside scheduleReconcile so it never holds this job's concurrency
  // slot while the resumed orchestrator turn runs. A KNOWN outcome (done, or a
  // vendor that genuinely failed) → one bounded nudge; an UNCERTAIN one
  // (interrupted, or MUON's own wall-budget kill — see
  // isUncertainTerminalOutcome) → a human gate, never an autonomous replay.
  if (wrote && isWatchedWorkerJob(job)) {
    scheduleReconcile({
      ...job,
      status: result.status,
      result: result.result,
      exitCode: result.exitCode ?? null,
    });
  }

  // B2: mine LAST. The terminal write above already released the fleet agent
  // and ended the chat turn, so the extractor's whole extra vendor process (up
  // to 120s) now costs the human nothing — it used to sit between the
  // assistant's last token and the seat being freed, doubling every turn's
  // latency and its subscription spend on the coordinator's critical path.
  //
  // AWAITED, not fire-and-forget, and deliberately so. It holds this job's
  // runner concurrency slot (one of six) but no fleet seat, which means the
  // drain in runRunnerLoop's `finally` waits for it and an in-flight extractor
  // can never outlive the runner as an orphan child. The drain signal is passed
  // through so a shutdown aborts the pass rather than blocking on it.
  //
  // Only the terminal write is a precondition: a FENCED write (`wrote` false)
  // means a successor lease owns this job, so we do not write memory for it
  // either. Failures stay observable through the existing `degraded(...)` →
  // `task.progress` event, which the shared agent bearer can still record after
  // the job is terminal.
  if (wrote) {
    const attemptOutcome: AttemptOutcome =
      result.status === "done"
        ? "worked"
        : result.status === "failed"
          ? "abandoned"
          : "unknown";
    const capture = {
      ...(result.capture ?? {
        memoryCapture: "reference" as const,
        taskId: job.taskId,
        laneId: agent.id,
        chatId: job.chatId ?? undefined,
        vendor: job.vendor,
        role: typeof job.role === "string" ? job.role : undefined,
        cwd: job.workspacePath ?? process.cwd(),
        brief: job.brief,
        output: "",
      }),
      attempt: {
        outcome: attemptOutcome,
        summary: job.brief,
      },
    };
    await runPendingCapture(client, capture, {
      sink: leaseMemorySink(client, job.id, opts.host, leaseToken),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onLog: (line) => log(`  ${job.id.slice(0, 8)}: ${line}`),
    });
  }
}

/**
 * The persistent runner (R1). A long-lived process that:
 *  - heartbeats the brain so surfaces know a runner is live,
 *  - polls the queued dispatch jobs,
 *  - atomically reserves a fleet agent AND claims the job in one backend
 *    transaction, so neither crashes nor response loss can leak the semaphore,
 *  - executes concurrently (background), releasing the agent on completion.
 *
 * Because this process outlives any single chat turn, dispatches truly run in
 * the background and the human can steer/interrupt them across turns.
 */
export async function runRunnerLoop(
  client: MuonApiClient,
  opts: RunnerLoopOptions
): Promise<void> {
  // TODO 7.1: default runner stdout is an error/status surface — scrub it.
  const log =
    opts.onLog ?? ((line: string) => console.log(`[runner] ${redactForLog(line)}`));
  const concurrency = opts.concurrency ?? 6;
  const pollMs = opts.pollMs ?? 1500;
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const inFlight = new Map<
    string,
    { promise: Promise<void>; controller: AbortController }
  >();
  if (!Number.isInteger(opts.pid) || opts.pid <= 0) {
    throw new Error("Runner requires a positive process PID.");
  }
  const leaseToken =
    opts.leaseToken ?? randomBytes(32).toString("hex");

  // ---- S4 durable auto-reconcile (task #127) ----
  // The runner owns the auto-resume because it is the always-alive process that
  // marks jobs terminal. The reconciler holds a PROCESS-LOCAL per-chat turn slot
  // so two workers finishing on one chat serialize; the cross-surface/cross-
  // restart guardrails (the durable milestone CAS + the lane-derived cap) live in
  // the shared core, so a still-open desktop can never double-fire.
  const autoContinue = resolveAutoContinue(opts);
  const reconciler =
    opts.reconciler ??
    createRunnerReconciler({
      client,
      apiBase: opts.apiBase,
      apiToken: opts.apiToken,
      autoContinue,
      runningTurns: new Set<string>(),
      signal: opts.signal,
      log,
    });
  const reconcileRetryMs = opts.reconcileRetryMs ?? 1000;
  const reconcileTasks = new Set<Promise<void>>();

  // Fire-and-forget so a terminal worker's slot frees immediately: the resume
  // must NOT hold a concurrency slot while it polls the very orchestrator session
  // it enqueues (that would deadlock the runner against its own turn). A
  // "deferred" outcome (a resume is already running for this chat) writes nothing
  // durable, so it is cleanly retried until it settles or the runner drains.
  const scheduleReconcile = (job: DispatchJobRecord): void => {
    if (!autoContinue || opts.signal?.aborted) {
      return;
    }
    const task = (async () => {
      for (;;) {
        let outcome: ReconcileOutcome;
        try {
          outcome = await reconciler.reconcile(job);
        } catch (error) {
          log(
            `auto-reconcile for ${job.id.slice(0, 8)} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return;
        }
        if (outcome !== "deferred" || opts.signal?.aborted) {
          return;
        }
        await delay(reconcileRetryMs, opts.signal);
      }
    })();
    reconcileTasks.add(task);
    void task.finally(() => reconcileTasks.delete(task));
  };

  // ---- B1: the coordinator seat is ONE seat, so contention must be loud ----
  const coordinatorSeatWaitMs =
    opts.coordinatorSeatWaitMs ?? COORDINATOR_SEAT_WAIT_MS;
  // Jobs whose "waiting for the seat" notice is already written, so the poll
  // loop states it ONCE rather than every tick. Entries are dropped the moment
  // the job stops being queued (it claimed the seat, or it was failed here), so
  // this cannot grow with the runner's uptime.
  const seatWaitAnnounced = new Set<string>();

  /**
   * A claim that 409'd for an `orchestrator` root. Because such a job can claim
   * ONLY fleet ordinal 0, this is seat contention, not fleet saturation — so it
   * gets a visible chat milestone immediately and a hard bound on the wait.
   *
   * The 409 alone does not prove contention (it also covers "another runner
   * took it" and "it already went terminal"), so the job is RE-READ: only one
   * that is still `queued` after our claim failed is genuinely seatless. That
   * check is state-based rather than a match on the conflict's message text,
   * which would drift the first time the route reworded itself.
   */
  const boundCoordinatorSeatWait = async (
    job: DispatchJobRecord
  ): Promise<void> => {
    const fresh = await client.getDispatchJob(job.id).catch(() => null);
    if (!fresh || fresh.status !== "queued") {
      seatWaitAnnounced.delete(job.id);
      return;
    }
    if (fresh.chatId && !seatWaitAnnounced.has(fresh.id)) {
      seatWaitAnnounced.add(fresh.id);
      // Written on the chat's own lane, so `waitForTerminal` forwards it to the
      // live turn's onStatus and Mission Chat shows WHY it has not started.
      // Individually swallowed: telling the user about the wait must never be
      // able to stop the bound below from ENDING it.
      try {
        await client
          .recordStreamChunks([
            {
              taskId: fresh.chatId,
              laneId: CHAT_LANE_ID,
              kind: "milestone",
              content: `[seat.busy] The '${fresh.vendor}' coordinator seat is held by another turn, so this one is queued and has NOT started. MUON seats exactly one coordinator per vendor. It will fail rather than wait if the seat is not free within ${Math.round(
                coordinatorSeatWaitMs / 1000
              )}s.`,
            },
          ])
          .catch(() => undefined);
      } catch {
        // A client without the writer, or a transport that threw synchronously.
      }
    }
    if (Date.now() - new Date(fresh.createdAt).getTime() < coordinatorSeatWaitMs) {
      return;
    }
    const reason = `The '${fresh.vendor}' coordinator seat (fleet ordinal 0) was still held after ${Math.round(
      coordinatorSeatWaitMs / 1000
    )}s, so this turn never started — nothing was sent to the vendor and no work was done. Wait for the holding turn to finish, interrupt it from the cockpit, or check the fleet for a coordinator agent stuck in 'working'.`;
    const wrote = await commitTerminal(
      client,
      { jobId: fresh.id, status: "failed", result: reason },
      opts,
      leaseToken,
      log
    );
    seatWaitAnnounced.delete(fresh.id);
    log(
      `✗ job ${fresh.id.slice(0, 8)} not dispatched, ${fresh.vendor} coordinator seat busy${
        wrote ? "" : " (status write failed)"
      }`
    );
  };

  let accepting = !opts.signal?.aborted;
  let heartbeatStopped = false;
  const heartbeatStop = new AbortController();
  const stopAccepting = () => {
    accepting = false;
  };
  const abortInFlight = () => {
    for (const { controller } of inFlight.values()) {
      controller.abort();
    }
  };
  opts.signal?.addEventListener("abort", stopAccepting);

  // This first heartbeat is a HOST LEASE acquisition. Never swallow failure:
  // a second launch incarnation must exit before it can reclaim or claim work.
  await client.runnerHeartbeat(opts.host, opts.pid, leaseToken);
  const heartbeat = (async () => {
    let consecutiveFailures = 0;
    while (!heartbeatStopped) {
      await delay(heartbeatMs, heartbeatStop.signal);
      if (heartbeatStopped) break;
      try {
        await client.runnerHeartbeat(opts.host, opts.pid, leaseToken);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const fenced = isLeaseConflict(error);
        // A 409 is an explicit fencing event: another incarnation owns this
        // host. Transient failures stop NEW claims after three misses, but the
        // heartbeat keeps retrying while already-claimed work drains.
        if (fenced || consecutiveFailures >= 3) {
          log(
            `host lease lost after ${consecutiveFailures} heartbeat failure(s): ${message}`
          );
          accepting = false;
          if (fenced) {
            // Stop the old vendor execution before the successor reconciles the
            // job. Filesystem side effects are not database-fenceable.
            abortInFlight();
            heartbeatStopped = true;
          }
        }
      }
    }
  })();

  try {
    // Recovery is a prerequisite to new work, not a one-shot best effort.
    // Heartbeat already runs above, so this lease stays fresh while the backend
    // rides out a transient startup failure.
    let reclaimAttempt = 0;
    while (accepting) {
      try {
        const reclaimed = await client.reclaimDispatchJobs(
          opts.host,
          leaseToken
        );
        if (reclaimed.reclaimed > 0) {
          log(
            `reclaimed ${reclaimed.reclaimed} orphaned job(s) from a prior run`
          );
          // FIX 3: startup reclaim bulk-marks stranded runs 'interrupted' (an
          // UNKNOWN outcome) OUTSIDE runOne, so the normal-completion reconcile
          // never fires for them. For each reclaimed WATCHED worker, file the
          // uncertain-outcome human gate directly (never an autonomous replay) so
          // a headless (runner-only, CLI/TUI) deployment still summons the human.
          // fileJobTerminalGate is idempotent (pending jobId-bound gate dedup) and
          // is deliberately NOT gated on autoContinue — an uncertain outcome must
          // reach a human regardless of the auto-continue toggle. Best-effort: a
          // gate-filing hiccup must never block reclaim, which precedes all work.
          for (const jobId of reclaimed.jobIds) {
            try {
              const orphan = await client.getDispatchJob(jobId);
              if (isWatchedWorkerJob(orphan) && orphan.chatId) {
                await fileJobTerminalGate(client, orphan.chatId, orphan);
              }
            } catch (error) {
              log(
                `reclaim gate for ${jobId.slice(0, 8)} deferred: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }
        break;
      } catch (error) {
        if (isLeaseConflict(error)) {
          accepting = false;
          break;
        }
        reclaimAttempt += 1;
        const waitMs = Math.min(
          500 * 2 ** Math.min(reclaimAttempt - 1, 4),
          5000
        );
        log(
          `startup reclaim failed (attempt ${reclaimAttempt}); retrying in ${waitMs}ms`
        );
        await (opts.retryDelay ?? ((ms: number) => delay(ms)))(waitMs);
      }
    }

    log(
      `online as ${opts.host} (pid ${opts.pid}) · concurrency ${concurrency} · ${opts.apiBase}`
    );

    while (accepting) {
      if (inFlight.size >= concurrency) {
        await delay(pollMs, opts.signal);
        continue;
      }
      const queued = await client
        .listDispatchJobs({ status: "queued" })
        .catch(() => [] as DispatchJobRecord[]);

      // Readiness gate (P2), once per tick: don't claim an agent for a vendor
      // the user isn't logged into. Fail such jobs with the actionable fix
      // BEFORE claiming, the alternative is a claimed-then-failed agent plus a
      // cryptic runtime error. Fetched once (the backend caches the probe) and
      // honest: if the probe is unavailable, we don't block.
      let readiness: VendorReadiness[] | null = null;
      // A single fresh (cache-bypassing) re-probe per tick, lazily fetched only
      // if some job looks not-ready, closes the staleness window so a job is
      // never PERMANENTLY failed on an ≤8s-stale "not logged in" right after a
      // login. Reused across all jobs in the tick.
      let refreshed: VendorReadiness[] | null | undefined;
      if (queued.length > 0) {
        try {
          readiness = await client.getVendorReadiness();
        } catch {
          readiness = null;
        }
      }

      for (const job of queued) {
        if (!accepting || inFlight.size >= concurrency) break;
        if (inFlight.has(job.id)) continue;

        if (readiness) {
          const cached = readiness.find((entry) => entry.vendor === job.vendor);
          if (cached && !(cached.installed && cached.authenticated)) {
            // Re-probe ONCE (fresh) before permanently failing, the cache may
            // predate a just-completed login.
            if (refreshed === undefined) {
              refreshed = await client
                .getVendorReadiness({ refresh: true })
                .catch(() => null);
            }
            const fresh = refreshed?.find((entry) => entry.vendor === job.vendor);
            const effective = fresh ?? cached;
            if (!(effective.installed && effective.authenticated)) {
              const reason = `Cannot dispatch to '${job.vendor}': ${effective.detail}.${
                effective.fixHint ? ` ${effective.fixHint}` : ""
              }`;
              await commitTerminal(
                client,
                {
                  jobId: job.id,
                  status: "failed",
                  result: reason,
                },
                opts,
                leaseToken,
                log
              );
              log(`✗ job ${job.id.slice(0, 8)} not dispatched, ${effective.detail}`);
              continue;
            }
            // Fresh probe says ready → fall through and dispatch normally.
          }
        }

        // The backend owns the whole claim transaction: reserve one idle agent,
        // stamp exact job ownership, and move queued → running atomically.
        let claimed:
          | { job: DispatchJobRecord; agent: AgentRecord }
          | undefined;
        let claimAttempt = 0;
        while (accepting && !claimed) {
          try {
            claimed = await client.claimDispatchJobAndAgentForLease({
              jobId: job.id,
              host: opts.host,
              leaseToken,
            });
          } catch (error) {
            // A 409 is a durable outcome (another runner/job state or fleet
            // saturation). Any other failure may be a lost HTTP response after
            // the backend committed; retry the SAME lease-bound claim so the
            // endpoint's idempotent replay returns the reserved pair.
            if (isLeaseConflict(error)) break;
            claimAttempt += 1;
            const waitMs = Math.min(
              500 * 2 ** Math.min(claimAttempt - 1, 4),
              5000
            );
            log(
              `claim for ${job.id.slice(0, 8)} failed (attempt ${claimAttempt}); retrying in ${waitMs}ms`
            );
            await (opts.retryDelay ?? ((ms: number) => delay(ms)))(waitMs);
          }
        }
        if (!claimed) {
          // B1: for a WORKER this is ordinary fleet saturation and queueing is
          // exactly right — the 0–3 semaphore exists for it. For an
          // `orchestrator` root there is only ever ONE claimable seat, so a
          // silent `continue` here is what left a second Mission Chat spinning
          // for 30 minutes with nothing written anywhere.
          if (accepting && job.capabilityMode === "orchestrator") {
            // Never let the bound itself take the runner down: a poll tick that
            // cannot evaluate contention must still keep claiming other work.
            await boundCoordinatorSeatWait(job).catch((error: unknown) =>
              log(
                `coordinator seat check for ${job.id.slice(0, 8)} failed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
          }
          continue;
        }
        seatWaitAnnounced.delete(job.id);
        // A heartbeat fence or drain request can land while the atomic claim
        // request is in flight. The backend may already have reserved the
        // agent, but this incarnation must never begin vendor work afterward.
        // Try to release the exact reservation; on a successor 409, that
        // successor owns reconciliation.
        if (!accepting) {
          const wrote = await commitTerminal(
            client,
            {
              jobId: claimed.job.id,
              status: "interrupted",
              // Shared pre-launch constant (byte-identical to the old
              // literal): a resume planner may treat this as provably-unstarted.
              result: PRE_LAUNCH_INTERRUPT_RESULTS[0],
            },
            opts,
            leaseToken,
            log
          );
          // FIX 3: this interrupted commit happens OUTSIDE runOne (a fence/drain
          // landed after the atomic claim), so the normal-completion reconcile
          // never fires. Route a WATCHED worker through the durable reconcile →
          // decideContinuation (interrupted ⇒ file a human gate, never an
          // autonomous replay); the milestone CAS keeps it idempotent against the
          // successor's reclaim. Only when the status durably committed (a fenced
          // write means the successor owns reconciliation).
          if (wrote && isWatchedWorkerJob(claimed.job)) {
            scheduleReconcile({
              ...claimed.job,
              status: "interrupted",
              result: PRE_LAUNCH_INTERRUPT_RESULTS[0],
              exitCode: null,
            });
          }
          continue;
        }

        const execution = new AbortController();
        const task = runOne(
          client,
          claimed.job,
          claimed.agent,
          opts,
          leaseToken,
          log,
          execution,
          scheduleReconcile
        ).finally(() => {
          inFlight.delete(job.id);
        });
        inFlight.set(job.id, { promise: task, controller: execution });
      }
      await delay(pollMs, opts.signal);
    }
  } finally {
    accepting = false;
    opts.signal?.removeEventListener("abort", stopAccepting);
    // Never abandon a claimed agent: drain in-flight work before exit.
    if (inFlight.size > 0) {
      log(`draining ${inFlight.size} in-flight job(s)…`);
      await Promise.allSettled(
        [...inFlight.values()].map(({ promise }) => promise)
      );
    }
    // Settle any in-flight auto-reconcile turns too. The abort signal (set on
    // drain) stops each turn's completion poll within a poll tick, so this is
    // bounded — the abandoned orchestrator dispatch stays runner-owned and is
    // reconciled by the next runner incarnation.
    if (reconcileTasks.size > 0) {
      await Promise.allSettled([...reconcileTasks]);
    }
    heartbeatStopped = true;
    heartbeatStop.abort();
    await heartbeat.catch(() => undefined);
    log("offline");
  }
}
