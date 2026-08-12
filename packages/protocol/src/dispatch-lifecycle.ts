/**
 * P0.1 checkpoint + resume: pre-launch interrupt classification.
 *
 * "Provably unstarted" is the ONLY class of interrupted work a resume planner
 * may re-dispatch without a per-job human decision (the no-autonomous-replay
 * invariant). A job qualifies when its terminal `result` proves NO vendor
 * process was ever launched. These are the three exact strings the runner
 * writes on that path — promoted here so the writer
 * (packages/runner/src/loop.ts, packages/runner/src/execute.ts) and every
 * classifier stay byte-identical and can never drift.
 *
 * Note: worktree creation can precede the "before vendor launch" refusal, so
 * "provably unstarted" means exactly "no vendor process was ever launched" —
 * the honest claim — not "no filesystem side effect of any kind".
 */
export const PRE_LAUNCH_INTERRUPT_RESULTS = [
  // runner loop: a heartbeat fence / drain landed while the atomic claim was
  // in flight; the claim is released before any vendor work begins.
  "runner authority was lost before vendor execution began",
  // executeJob: the execution signal aborted after setup but strictly before
  // the vendor process spawn.
  "runner authority was lost before vendor launch",
  // executeJob: the absolute delegation deadline elapsed before spawn.
  "absolute delegation deadline elapsed before vendor launch",
] as const;

export type PreLaunchInterruptResult =
  (typeof PRE_LAUNCH_INTERRUPT_RESULTS)[number];

/** True iff `result` proves the vendor process was never launched. */
export function isPreLaunchInterrupt(
  result: string | null | undefined
): boolean {
  return (
    typeof result === "string" &&
    (PRE_LAUNCH_INTERRUPT_RESULTS as readonly string[]).includes(result)
  );
}

/**
 * WALL-BUDGET EXHAUSTION — the terminal class that used to be indistinguishable
 * from a human interrupt.
 *
 * A job MUON stopped because its own wall-clock budget ran out committed
 * `status: interrupted, exitCode: 130, interruptRequested: 0` — byte-identical
 * in shape to a run a human SIGINT'd, minus a flag that is also 0 for an
 * ancestor-driven stop. The founder's two claude workers each ran 603 s against
 * a 600 000 ms budget and were reported that way, so the coordinator told the
 * human its workers had been "cut off by something outside their own control" —
 * a wrong diagnosis it had no evidence to avoid.
 *
 * The fix is two-part and both parts matter:
 *  1. the terminal status is `failed`, never `interrupted`, because MUON — not a
 *     human and not a lost runner — ended the run, and
 *  2. the result carries this MARKER as its first token, so every reader can
 *     classify the cause structurally instead of pattern-matching prose.
 *
 * Deliberately NOT a new `DispatchJob.status` value: `queued|running|done|
 * failed|interrupted` is read by ~20 call sites across the backend, client,
 * MCP tools, TUI and desktop, and a status one of them does not understand is a
 * worse failure than the one being fixed. `failed` + a machine-readable reason
 * is understood everywhere today and still cannot be mistaken for a human act.
 */
export const BUDGET_EXHAUSTED_MARKER = "[muon:budget-exhausted]";

/**
 * The exact terminal `result` for a wall-budget kill. States the budget, what
 * was actually spent, and — because this is the sentence that was wrong before —
 * that nobody interrupted it.
 */
export function budgetExhaustedResult(input: {
  vendor: string;
  budgetMs: number;
  elapsedMs?: number;
}): string {
  const budgetSeconds = Math.round(input.budgetMs / 1000);
  const spent =
    typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs)
      ? `${Math.round(input.elapsedMs / 1000)}s`
      : `${budgetSeconds}s`;
  return (
    `${BUDGET_EXHAUSTED_MARKER} MUON stopped ${input.vendor}: its own ` +
    `wall-clock budget of ${budgetSeconds}s ran out after ${spent} of work. ` +
    "No human interrupted this run, the runner did not lose authority, and the " +
    "vendor did not fail — the job simply did not finish inside the budget it " +
    "was dispatched with. Any work it had already written to the workspace is " +
    "still there and unverified. Re-dispatch with a larger maxWallMs, or split " +
    "the scope, to finish it."
  );
}

/**
 * True iff this terminal result was written by the wall-budget kill above.
 * The one classifier every consumer uses, so "budget expiry" can never drift
 * into a substring match on a sentence someone later rewords.
 */
export function isBudgetExhausted(result: string | null | undefined): boolean {
  return (
    typeof result === "string" && result.startsWith(BUDGET_EXHAUSTED_MARKER)
  );
}

/**
 * The same terminal result with the MACHINE marker removed — the sentence a
 * human reads. Lives beside the marker it strips, so the two can never drift:
 * the crew rail, the desktop session pane and the reconcile gate all quote this
 * one helper rather than each re-deriving "drop the first token".
 *
 * Non-budget results pass through untouched.
 */
export function withoutBudgetMarker(result: string): string {
  return isBudgetExhausted(result)
    ? result.slice(BUDGET_EXHAUSTED_MARKER.length).trimStart()
    : result;
}

/**
 * UNCERTAIN OUTCOME — the one predicate every surface asks, so this class can
 * never drift back apart.
 *
 * "Uncertain" is not "MUON does not know why the run ended"; it is "a vendor was
 * stopped MID-WORK and nobody has verified what it left in the workspace". Both
 * classes qualify:
 *  - `interrupted` — a human SIGINT, an ancestor stop, or a lost runner, and
 *  - a WALL-BUDGET kill, which commits `failed` with {@link BUDGET_EXHAUSTED_MARKER}
 *    because MUON itself ended it. Knowing the CAUSE exactly says nothing about
 *    the workspace: the founder's two claude implementers were killed at 603s
 *    mid-edit, and their partial writes are as unverified as any interrupt's.
 *
 * Every consumer that routes on this (the reconcile gate, the resume planner,
 * the run-bundle checkpoint) must use THIS function rather than comparing
 * `status` to a string: the reclassification of budget kills from `interrupted`
 * to `failed` silently deleted a human approval gate the last time each site
 * spelled the rule itself.
 */
export function isUncertainTerminalOutcome(job: {
  status: string;
  result?: string | null;
}): boolean {
  return job.status === "interrupted" || isBudgetExhausted(job.result);
}
