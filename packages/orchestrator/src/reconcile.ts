import type { DispatchJobRecord } from "@muon/client";
import { isBudgetExhausted, withoutBudgetMarker } from "@muon/protocol";

// Surface-independent reconcile core (S4). This is the lift-and-shift of the
// logic that used to live in apps/desktop/src/lib/job-terminal-monitor.ts, moved
// here so EVERY always-alive surface — the persistent runner as well as the
// desktop monitor — drives the exact same bounded, consented, dedupe-guarded
// continuation. The desktop re-exports these from a shim so its proven wiring
// stays byte-identical. Deliberately dependency-light (a type-only client import
// plus the pure terminal-outcome classifiers from @muon/protocol, which the
// desktop's startup graph already loads through @muon/client) so the desktop's
// CJS startup can pull it via the `@muon/orchestrator/reconcile` subpath WITHOUT
// eagerly loading the heavy orchestrator index.

/**
 * Bound on machine-synthesized reconciliation turns between human messages
 * (FD-3). The chat streams every nudge visibly and the human can Stop-all at
 * any time; this cap guarantees the loop is finite even if they do neither.
 *
 * SIX, not three. Three was set when a nudge was a courtesy "a worker landed"
 * ping; it is now the ONLY path by which a mission's work is collected and
 * reported, and three starved exactly the turn that matters. A realistic crew —
 * three implementers, then the sequential reviewer queued behind them — needs
 * four wakes, and the fourth is the one that posts the final summary. At three
 * the mission silently ended one turn short of telling the operator anything.
 *
 * Raising it weakens no permission tier. This is a RUNAWAY bound, not an
 * authority bound: every dispatch a wake turn mints still passes the same route
 * admission, gates, fences, and delegation budgets a human turn does, and total
 * fan-out stays bounded by DELEGATION_MAX_DESCENDANTS. Each unit additionally
 * requires a DISTINCT terminal child (the claim below is per-jobId and
 * claim-once), so the loop cannot feed itself; Stop-all remains immediate.
 */
export const AUTO_CONTINUE_CAP = 6;

/**
 * What a decision appends to the durable dedupe milestone.
 *
 * ONLY the bare `[event] job <id> terminal` form is counted against the cap
 * (see {@link EVENT_MILESTONE_PATTERN}, anchored end-of-line), and only a NUDGE
 * writes it. A gate and an affordance run NO turn at all, so counting them
 * spent turn budget on turns that never happened: one interrupted child, or one
 * child that arrived after the cap, permanently cost a later child its wake.
 * They still claim the same key — the dedupe is unchanged — under a suffixed
 * content the counter does not recognise.
 */
const OUTCOME_MILESTONE_SUFFIX: Readonly<Record<string, string>> = {
  gate: " (uncertain, human gate filed)",
  affordance: " (awaiting operator continuation)",
};

/**
 * Re-exported so every SURFACE that produces a {@link TerminalJobEvent} — the
 * runner's reconciler and the desktop's poll monitor — classifies it with the
 * one predicate, reachable from the same lightweight subpath they already
 * import the core from. Each surface spelling the rule itself is precisely how
 * a budget kill kept its human gate on one surface and lost it on the other.
 */
export { isUncertainTerminalOutcome } from "@muon/protocol";
// TODO 5.4 — re-export so the lightweight `@muon/orchestrator/reconcile`
// subpath (desktop CJS) can detect stuck without loading the heavy index.
export {
  detectStuckPattern,
  normalizeStuckText,
  stuckStepsFromChunks,
} from "./stuck-detector.js";
export type {
  StuckHalt,
  StuckPattern,
  StuckStep,
} from "./stuck-detector.js";

export type ContinuationDecision =
  /** Auto-synthesize one bounded reconciliation turn (consented + under cap). */
  | "nudge"
  /** Defer to the human: show the [Continue orchestration] affordance. */
  | "affordance"
  /** Outcome unknown: file a human gate, never auto-replay. */
  | "gate";

/**
 * Decide how an idle orchestrator chat should react to a worker going terminal.
 * Pure so the cap/toggle/uncertain policy is exhaustively testable without
 * Electron. Uncertain outcomes always route to a gate; otherwise auto-continue
 * only fires when it is enabled AND still under the per-chat cap.
 */
/**
 * ADR-0030 — the ONE statement of "this session suspends automation":
 * human-owned and not terminally over. The backend steer guard and the
 * desktop auto-continue resolver both read THIS predicate; review finding 3
 * was the two of them drifting apart (running-only vs not-ended).
 */
export function sessionSuspendsAutomation(session: {
  owner?: string;
  status: string;
}): boolean {
  return (
    session.owner === "human" &&
    session.status !== "ended" &&
    session.status !== "failed"
  );
}

export function decideContinuation(input: {
  uncertain: boolean;
  autoContinueEnabled: boolean;
  autoTurnsUsed: number;
  autoTurnCap?: number;
  /**
   * ADR-0030: a live session in this chat is human-owned (native take-over).
   * Automation must not synthesize turns over the human's in-progress native
   * work — surface the manual affordance instead of nudging.
   */
  humanOwnedSession?: boolean;
  /**
   * TODO 5.4: named stuck halt from {@link detectStuckPattern}. When set, stop
   * nudging and surface the affordance — same path as the numeric cap, with a
   * reason the operator can read.
   */
  stuckReason?: string | null;
}): ContinuationDecision {
  if (input.uncertain) {
    return "gate";
  }
  // Stuck outranks the numeric cap: halt with a reason even when turns remain.
  if (input.stuckReason) {
    return "affordance";
  }
  // ADR-0030: while a human natively owns a session here, automation yields.
  if (input.humanOwnedSession) {
    return "affordance";
  }
  const cap = input.autoTurnCap ?? AUTO_CONTINUE_CAP;
  if (!input.autoContinueEnabled || input.autoTurnsUsed >= cap) {
    return "affordance";
  }
  return "nudge";
}

export type TerminalJobEvent = {
  job: DispatchJobRecord;
  /**
   * The job reached terminal with an UNKNOWN outcome (reclaimed/interrupted).
   * The caller must file a human gate instead of auto-continuing — MUON never
   * replays uncertain side effects on its own.
   */
  uncertain: boolean;
};

export type ReconcileOutcome =
  /** A turn was already running; retry on the next poll (nothing was written). */
  | "deferred"
  /** A peer surface (or a prior session) already owns this terminal event. */
  | "skipped"
  /** An uncertain outcome was routed to a human gate. */
  | "gated"
  /** Deferred to the human via the [Continue orchestration] affordance. */
  | "affordance"
  /** One bounded reconciliation turn was synthesized. */
  | "nudged";

/**
 * Side-effect seams for {@link reconcileTerminalJob}, injected so the whole
 * decision + dedupe + slot-claim flow is testable without Electron or a live
 * runner. `tryClaimTurnSlot` MUST be synchronous (a check-then-add on the shared
 * running-turns set) so the claim is atomic against a concurrent human turn.
 */
export type ReconcileDeps = {
  /** Durable dedupe key for a job's terminal event (the chat-lane milestone). */
  milestoneFor: (jobId: string) => string;
  /**
   * Atomically append the milestone iff `claimKey` is new for this chat.
   * Database uniqueness must arbitrate across processes; an in-memory or
   * read-then-append check is insufficient.
   */
  claimMilestone: (
    chatId: string,
    claimKey: string,
    content: string
  ) => Promise<boolean>;
  autoContinueEnabled: boolean;
  /** ADR-0030: a live human-owned session exists in this chat (resolved by the surface). */
  humanOwnedSession?: boolean;
  autoTurnsUsed: number;
  autoTurnCap?: number;
  /** TODO 5.4: named stuck halt message, or null/undefined when clear. */
  stuckReason?: string | null;
  /** Synchronously claim the chat's single turn slot; false if already held. */
  tryClaimTurnSlot: (chatId: string) => boolean;
  releaseTurnSlot: (chatId: string) => void;
  /** Count one auto-continue turn against the per-chat cap. */
  onNudge: (chatId: string) => void;
  /** Run ONE reconciliation turn (envelope built inside); slot already held. */
  runNudgeTurn: (chatId: string, job: DispatchJobRecord) => Promise<void>;
  /**
   * Optional pause between the two bounded attempts (see NUDGE_ATTEMPTS).
   * Injected so tests do not sleep; production supplies a real delay.
   */
  retryDelay?: () => Promise<void>;
  /** File a human gate for an outcome-unknown job (never auto-replayed). */
  fileGate: (chatId: string, job: DispatchJobRecord) => Promise<void>;
  /** Surface the [Continue orchestration] affordance to the renderer. */
  showAffordance: (chatId: string, jobId: string) => void;
  /**
   * Report a failed continuation. AWAITED: a surface that makes this durable
   * (the runner writes a visible chat-lane milestone) must be able to flush it
   * before the caller moves on — the old floating `void` write could be lost on
   * runner shutdown, which is exactly when a wake is most likely to fail.
   * Returning void stays valid, so a synchronous surface is unaffected.
   */
  onError?: (chatId: string, message: string) => void | Promise<void>;
};

/**
 * How many times a nudge turn is attempted before it is reported as failed.
 *
 * TWO, and never a loop. The durable claim is written BEFORE the turn (it has
 * to be — it is what stops two surfaces running the same turn), so a throw used
 * to consume the terminal event permanently: every later attempt found the
 * claim taken and returned "skipped". A single transient 409 (a human turn
 * raced us) or timeout therefore ended autonomous continuation for that child
 * for good. One bounded retry covers the transient case without ever becoming
 * a retry loop; a genuinely refused wake still fails, visibly, after two.
 */
const NUDGE_ATTEMPTS = 2;

/**
 * Reconcile one worker's terminal event into a bounded, consented continuation
 * (S4). The atomic turn-slot claim happens BEFORE any await on the nudge path,
 * so a machine nudge and a human message can never run two turns on the same
 * session. A deferred nudge writes nothing (so it is retried cleanly); every
 * other outcome first claims the durable dedupe milestone.
 */
export async function reconcileTerminalJob(
  event: TerminalJobEvent,
  deps: ReconcileDeps
): Promise<ReconcileOutcome> {
  const chatId = event.job.chatId;
  if (!chatId) {
    return "skipped";
  }

  const decision = decideContinuation({
    uncertain: event.uncertain,
    autoContinueEnabled: deps.autoContinueEnabled,
    autoTurnsUsed: deps.autoTurnsUsed,
    autoTurnCap: deps.autoTurnCap,
    stuckReason: deps.stuckReason,
    humanOwnedSession: deps.humanOwnedSession,
  });

  if (decision === "nudge") {
    // Claim the slot synchronously (no await yet) so a human turn cannot slip in.
    if (!deps.tryClaimTurnSlot(chatId)) {
      return "deferred";
    }
    try {
      const claim = await claimTerminalEvent(event.job.id, chatId, deps, "nudge");
      if (claim === "error") {
        // Nothing durable was claimed — retried cleanly on the next poll.
        return "deferred";
      }
      if (claim === "lost") {
        return "skipped";
      }
      deps.onNudge(chatId);
      let failure: unknown;
      for (let attempt = 1; attempt <= NUDGE_ATTEMPTS; attempt += 1) {
        try {
          await deps.runNudgeTurn(chatId, event.job);
          return "nudged";
        } catch (error) {
          // A live root turn already running is the ORDINARY overlap race (a
          // worker finished while the coordinator's own turn was still
          // going), not a failure: that turn's OWN terminal event re-fires
          // reconcile with everything this nudge would have said. Retrying —
          // and then recording a red `reconcile.failed` — told the operator
          // auto-continue was broken when it was working exactly as designed
          // (founder screenshot, 2026-08-06).
          if (
            (error as { code?: string } | null)?.code ===
            "MUON_ACTIVE_ROOT_EXISTS"
          ) {
            return "skipped";
          }
          failure = error;
          if (attempt < NUDGE_ATTEMPTS) await deps.retryDelay?.();
        }
      }
      // Bounded attempts exhausted. Report it where the human is looking and
      // yield to the [Continue orchestration] affordance — never a retry loop.
      // The report is best-effort: a reporting failure must not mask the
      // continuation failure it is reporting.
      await Promise.resolve(
        deps.onError?.(
          chatId,
          failure instanceof Error ? failure.message : "auto-continue failed"
        )
      ).catch(() => undefined);
      return "nudged";
    } finally {
      deps.releaseTurnSlot(chatId);
    }
  }

  const claim = await claimTerminalEvent(event.job.id, chatId, deps, decision);
  if (claim === "error") {
    // Nothing durable was claimed — retried cleanly on the next poll.
    return "deferred";
  }
  if (decision === "gate") {
    if (claim === "lost") {
      // REPAIR (P0.1 Slice C5): a prior surface/session claimed the milestone
      // but its gate filing may have failed (the historical 400 swallow).
      // fileGate is idempotent per jobId (jobId-bound pending-gate dedupe), so
      // re-filing here is safe and closes the gap where the uncertain job
      // never durably reached a human gate.
      try {
        await deps.fileGate(chatId, event.job);
      } catch (error) {
        await Promise.resolve(
          deps.onError?.(
            chatId,
            error instanceof Error ? error.message : "gate filing failed"
          )
        ).catch(() => undefined);
      }
      return "skipped";
    }
    try {
      await deps.fileGate(chatId, event.job);
    } catch (error) {
      // The milestone is already durably claimed; report and yield. The gate
      // still lands via the lost-race repair path on a later pass/surface.
      await Promise.resolve(
        deps.onError?.(
          chatId,
          error instanceof Error ? error.message : "gate filing failed"
        )
      ).catch(() => undefined);
      return "skipped";
    }
    return "gated";
  }
  if (claim === "lost") {
    return "skipped";
  }
  // TODO 5.4: durable named halt so the operator (and a restarted surface)
  // sees "Halted: alternating pattern ×6" instead of a silent cap.
  if (deps.stuckReason) {
    await Promise.resolve(
      deps.onError?.(chatId, deps.stuckReason)
    ).catch(() => undefined);
  }
  deps.showAffordance(chatId, event.job.id);
  return "affordance";
}

/**
 * Write the dedupe milestone iff no surface has yet. Tri-state (P0.1 C5):
 * "won" = we durably claimed it; "lost" = a peer already had; "error" = the
 * WRITE failed, so nothing durable was claimed and the caller must defer —
 * the old `.catch(() => undefined)` here silently treated a failed write as
 * a win, which could drop a terminal event forever.
 */
async function claimTerminalEvent(
  jobId: string,
  chatId: string,
  deps: ReconcileDeps,
  decision: ContinuationDecision
): Promise<"won" | "lost" | "error"> {
  // Same claim key for every outcome (the dedupe is about the EVENT), different
  // content (the cap is about TURNS). See OUTCOME_MILESTONE_SUFFIX.
  const milestone =
    deps.milestoneFor(jobId) + (OUTCOME_MILESTONE_SUFFIX[decision] ?? "");
  try {
    const claimed = await deps.claimMilestone(
      chatId,
      `terminal-job:${jobId}`,
      milestone
    );
    return claimed ? "won" : "lost";
  } catch {
    return "error";
  }
}

/** The minimal approvals surface {@link fileJobTerminalGate} needs. */
export type UncertainGateClient = {
  listApprovals: () => Promise<
    Array<{ kind: string; status: string; jobId?: string | null }>
  >;
  requestApproval: (input: {
    taskId: string;
    requestedBy: string;
    kind: "gate";
    reason: string;
    jobId: string;
  }) => Promise<unknown>;
};

/**
 * File the uncertain-outcome human gate for a terminal job (P0.1 Slice C5),
 * idempotently: skips when a PENDING jobId-bound gate already exists (the
 * durable Slice-A column makes this dedupe work across surfaces AND
 * restarts). The filing is a gateTag-LESS `kind:"gate"` — the sanctioned
 * inert escalation shape: with no gateTag it can never redeem at any route,
 * it only summons the human. (The old `gateTag: "job-terminal:<id>"` failed
 * parseGateTag → a 400 the monitor swallowed; never re-add a tag here.)
 */
export async function fileJobTerminalGate(
  client: UncertainGateClient,
  chatId: string,
  job: DispatchJobRecord
): Promise<"filed" | "exists"> {
  const approvals = await client.listApprovals().catch(() => []);
  const pending = approvals.some(
    (approval) =>
      approval.kind === "gate" &&
      approval.status === "pending" &&
      approval.jobId === job.id
  );
  if (pending) {
    return "exists";
  }
  await client.requestApproval({
    taskId: job.taskId,
    requestedBy: "muon-desktop",
    kind: "gate",
    reason: uncertainGateReason(chatId, job),
    jobId: job.id,
  });
  return "filed";
}

/** How much of the worker's own terminal sentence the gate quotes. */
const GATE_REASON_RESULT_MAX = 400;

/**
 * WHY the human is being summoned, in the job's own terms.
 *
 * A wall-budget kill gets the truth it now records — which budget, how long it
 * actually ran, that nobody interrupted it — instead of "ended 'failed' with an
 * unknown outcome", the generic sentence that let a coordinator tell the founder
 * its workers had been "cut off by something outside their own control". The
 * gate itself is unchanged: an uncertain job still needs a human, because the
 * cause being known says nothing about the half-finished edits in its worktree.
 *
 * The quoted result is bounded and marker-free (payload-is-data: it is worker-
 * adjacent text MUON wrote, rendered to a human, never instructions).
 */
function uncertainGateReason(chatId: string, job: DispatchJobRecord): string {
  const tail =
    `Review it in chat ${chatId}, then continue orchestration by hand if it is safe.`;
  if (isBudgetExhausted(job.result)) {
    return (
      `Worker ${job.vendor} job ${job.id} was stopped by MUON: ` +
      `${withoutBudgetMarker(job.result ?? "").slice(0, GATE_REASON_RESULT_MAX)} ` +
      `MUON will not auto-continue work whose partial, unverified edits nobody has ` +
      `checked — ${tail}`
    );
  }
  return (
    `Worker ${job.vendor} job ${job.id} ended '${job.status}' with an unknown outcome. ` +
    `MUON will not auto-continue an uncertain job — ${tail}`
  );
}

/**
 * A dispatched WORKER job bound to a chat — the child jobs the orchestrator
 * delegated during a turn. Delegated children inherit the chat root's `chatId`
 * and carry a `parentJobId` (dispatch.ts child creation), while the chat's own
 * session turn is a root with a `chatId` but NO `parentJobId`. So this predicate
 * watches exactly the workers whose completion the founder needs reconciled,
 * and never re-nudges on the orchestrator's own turn finishing.
 */
export function isWatchedWorkerJob(job: DispatchJobRecord): boolean {
  return Boolean(job.chatId) && Boolean(job.parentJobId);
}

// A typed human turn (`user.message`, content `[you] …`) resets auto-continue;
// a machine reconciliation turn writes one `[event] job … terminal` milestone.
// So the count of event milestones since the last trusted human message
// IS the durable, restart-surviving auto-turn counter the desktop used to hold
// in memory.
const HUMAN_TURN_PREFIX = "[you] ";
const EVENT_MILESTONE_PATTERN = /^\[event\] job .+ terminal$/;

/**
 * Count the machine-synthesized reconciliation turns taken since the human last
 * spoke, derived purely from the durable chat lane. `chunks` MUST be in
 * chronological order (oldest→newest — exactly what `listStreamChunks({latest})`
 * returns). This makes the per-chat cap survive a runner restart for free: the
 * count lives in the append-only stream, not in any one process's memory.
 *
 * Kind-gated on BOTH the reset AND the count (content-field side-channel
 * invariant): the human reset point is `kind:"user.message"` and the machine
 * counter is `kind:"milestone"`, while the orchestrator's own streamed
 * assistant OUTPUT lands on this SAME chat lane as `kind:"output"`. An output
 * chunk beginning "[you] " (e.g. echoing a worker resultTail) must NEVER reset
 * the cap, and an `[event] … terminal` echo must NEVER be counted — trusting the
 * content field regardless of kind would let untrusted agent text defeat
 * AUTO_CONTINUE_CAP and drive unbounded auto-continue.
 */
export function countAutoTurnsSinceHuman(
  chunks: { content: string; kind: string }[]
): number {
  let lastHuman = -1;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i]!;
    if (
      chunk.kind === "user.message" &&
      chunk.content.startsWith(HUMAN_TURN_PREFIX)
    ) {
      lastHuman = i;
      break;
    }
  }
  let count = 0;
  for (let i = lastHuman + 1; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    if (chunk.kind === "milestone" && EVENT_MILESTONE_PATTERN.test(chunk.content)) {
      count += 1;
    }
  }
  return count;
}
