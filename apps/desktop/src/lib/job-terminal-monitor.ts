import type { MuonApiClient } from "@muon/client";
import {
  isUncertainTerminalOutcome,
  isWatchedWorkerJob,
  type TerminalJobEvent,
} from "@muon/orchestrator/reconcile";

// S4 durable-orchestration reconcile core (decideContinuation, reconcileTerminalJob,
// fileJobTerminalGate, isWatchedWorkerJob, the ReconcileDeps seam, AUTO_CONTINUE_CAP)
// now lives in the SHARED module @muon/orchestrator/reconcile so the always-alive
// runner drives the exact same auto-resume on CLI/TUI/desktop (task #127). This
// module keeps only the desktop-specific poll monitor and RE-EXPORTS the core so
// main.ts's wiring — and this package's tests — stay byte-identical. The subpath
// import is deliberate: it stays lightweight (no eager load of the heavy
// orchestrator index) for the desktop's CJS startup.
export {
  AUTO_CONTINUE_CAP,
  decideContinuation,
  detectStuckPattern,
  reconcileTerminalJob,
  sessionSuspendsAutomation,
  fileJobTerminalGate,
  isUncertainTerminalOutcome,
  isWatchedWorkerJob,
  stuckStepsFromChunks,
} from "@muon/orchestrator/reconcile";
export type {
  ContinuationDecision,
  TerminalJobEvent,
  ReconcileOutcome,
  ReconcileDeps,
  StuckHalt,
  UncertainGateClient,
} from "@muon/orchestrator/reconcile";

// A worker job's terminal outcome. done — and a vendor that genuinely failed on
// its merits — are KNOWN (the job ran and we have its result). Which of these
// rows is UNCERTAIN is NOT a status test and is deliberately not spelled here:
// it comes from the shared `isUncertainTerminalOutcome`, which also covers
// MUON's own wall-budget kill (a `failed` row whose vendor was stopped
// mid-work). A status set here read a budget kill as certain while the runner
// read it as uncertain — the same event reaching a human on one surface and an
// autonomous turn on the other.
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

export type JobTerminalMonitorState = {
  online: boolean;
  lastError: string | null;
};

export type JobTerminalMonitorEvents = {
  onState?: (state: JobTerminalMonitorState) => void;
  /**
   * Fired once per newly-terminal watched worker job. Return `true` when the
   * event was handled (nudge fired, affordance surfaced, or gate filed, or a
   * peer surface already owns it) so the monitor stops tracking it; return
   * `false` to DEFER (e.g. a turn is already running) and be retried next poll.
   */
  onTerminalJob: (event: TerminalJobEvent) => boolean | Promise<boolean>;
};

export type JobTerminalMonitorOptions = {
  /**
   * Cross-surface reconcile guard (task #127). Returns whether an always-alive
   * runner is currently live. When it is, this desktop monitor defers ENTIRELY
   * to the runner — the ONE process that literally marks jobs terminal and the
   * durable reconcile driver — so the two surfaces never double-resume a vendor
   * session nor diverge the auto-continue cap (the runner counts it durably from
   * the chat lane; the desktop counted it in memory). Mirrors the CLI fallback's
   * "only when no runner is live" gate in apps/cli/src/commands/chat.ts. Omitted
   * (or a probe failure) → the desktop reconciles as before, so an uncertain job
   * still reaches its human gate (fail toward reconcile, never toward silence).
   */
  isRunnerLive?: () => Promise<boolean>;
};

// Per-chat page size. The dispatch list is oldest-first, so we take a generous
// page to be sure a chat's freshly-terminal workers are in it (a chat realistic-
// ally never accrues this many jobs). Scoping per chat also keeps the poll off
// the global ledger, where a busy system's newest jobs fall off the first page.
const CHAT_JOBS_PAGE = 200;

/**
 * Polls each chat's ledger for watched worker jobs reaching terminal so an idle
 * orchestrator chat can be nudged to reconcile (S4). Mirrors approvals-monitor:
 * jobs already terminal at startup are adopted silently (no launch storm), and
 * each job is announced at most once — unless the handler defers it.
 *
 * Cross-surface + cross-restart dedupe lives in the durable chat-lane milestone
 * the handler writes; this in-memory set only avoids redundant work within a
 * single running session.
 *
 * NOTE: since task #127 the persistent runner drives this same reconcile from
 * `commitTerminal`, so this desktop poll is now a redundant peer — the shared
 * milestone CAS keeps the two from ever double-firing. It is retained so the
 * proven desktop path stays live even against an older runner.
 */
export function createJobTerminalMonitor(
  client: MuonApiClient,
  events: JobTerminalMonitorEvents,
  options: JobTerminalMonitorOptions = {}
) {
  const handled = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let firstPoll = true;

  const poll = async () => {
    try {
      // Cross-surface dedupe (task #127): when the always-alive runner is live it
      // is the durable reconcile driver, so the desktop defers ENTIRELY for this
      // sweep — reconciling here too would double-resume the vendor session and
      // diverge the auto-continue cap. Probed once per sweep. We keep tracking
      // (never mark handled) so if the runner later dies the desktop picks
      // reconciliation back up; the durable milestone CAS keeps it idempotent.
      const runnerLive = options.isRunnerLive
        ? await options.isRunnerLive().catch(() => false)
        : false;
      const chats = await client.listChats();
      // Snapshot firstPoll for the whole sweep so a chat visited later in the
      // first sweep is still adopted (not nudged).
      const adopting = firstPoll;
      for (const chat of chats) {
        const jobs = await client.listDispatchJobs({
          chatId: chat.id,
          limit: CHAT_JOBS_PAGE,
        });
        for (const job of jobs) {
          if (!isWatchedWorkerJob(job)) {
            continue;
          }
          if (!TERMINAL_STATUSES.has(job.status)) {
            continue;
          }
          if (handled.has(job.id)) {
            continue;
          }
          // Jobs already terminal when the app opened are adopted but not
          // nudged — the orchestrator turn that owned them is long over.
          if (adopting) {
            handled.add(job.id);
            continue;
          }
          // A live runner owns reconciliation: defer (don't fire, don't mark
          // handled) so the desktop resumes reconciling only if the runner dies.
          if (runnerLive) {
            continue;
          }
          const done = await events.onTerminalJob({
            job,
            uncertain: isUncertainTerminalOutcome(job),
          });
          if (done) {
            handled.add(job.id);
          }
        }
      }
      firstPoll = false;
      events.onState?.({ online: true, lastError: null });
    } catch (error) {
      events.onState?.({
        online: false,
        lastError: error instanceof Error ? error.message : "poll failed",
      });
    }
  };

  return {
    poll,
    start: (intervalMs: number) => {
      if (timer) {
        return;
      }
      void poll();
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
