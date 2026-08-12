import { z } from "zod";
import type { HandoffCheck } from "./handoff.js";

/**
 * ADR-0037 — the flake ledger.
 *
 * From the orchestrator field notes: "flake classification should be MUON's
 * job, not the operator's. 'It failed once in nine runs and never again' is a
 * fact MUON could hold and report." Today it is a fact the operator
 * re-establishes by hand, one full re-run at a time.
 *
 * The reason this module is careful rather than a counter: **"known-flaky" is
 * the most abusable label in a test report.** An agent that may call a failure
 * flaky has a way to ship broken work while sounding rigorous. So the
 * classification here annotates and never downgrades — a failed check reports
 * `failed`, always, and there is deliberately no function in this file that
 * maps a history onto an outcome.
 *
 * That is the same shape `passed-but-uncovering` took in `handoff.ts`: when the
 * tree needed to express "green but meaningless" it added evidence that fails
 * `=== "passed"` closed, rather than reinterpreting the verdict.
 */

/** Minimum recorded runs before any claim is made about a check's behaviour. */
export const MIN_RUNS_FOR_FLAKINESS = 3;
/** How many recent runs a verdict may consider (ADR-0037 D5). */
export const CHECK_HISTORY_WINDOW = 20;

export const checkRunOutcomeSchema = z.enum([
  "passed",
  "passed-but-uncovering",
  "failed",
  "skipped",
  "error",
]);
export type CheckRunOutcome = z.infer<typeof checkRunOutcomeSchema>;

/** One recorded execution of a named check in one workspace. */
export const checkRunSchema = z.object({
  name: z.string().min(1).max(120),
  workspacePath: z.string().min(1).max(1024),
  outcome: checkRunOutcomeSchema,
  at: z.string(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

export type FlakinessKind =
  /** Not enough runs to say anything. The DEFAULT. */
  | "insufficient-evidence"
  /** Every recorded run passed. */
  | "stable"
  /** Mixed outcomes across enough runs. */
  | "flaky"
  /** Every recorded run failed — broken, not flaky. */
  | "consistently-failing";

export type Flakiness = {
  readonly kind: FlakinessKind;
  readonly runs: number;
  readonly failures: number;
};

/**
 * `skipped` says nothing about whether a check works, so it is not counted as
 * a run at all — including it would let a mostly-skipped check drift toward
 * "stable" without ever having proved anything.
 *
 * `error` (the harness could not run it) counts as a failure: from the
 * operator's seat a check that cannot run is a check that is not passing, and
 * treating it as neutral is how a broken harness looks healthy.
 */
function countsAsRun(outcome: CheckRunOutcome): boolean {
  return outcome !== "skipped";
}

function countsAsFailure(outcome: CheckRunOutcome): boolean {
  return outcome === "failed" || outcome === "error";
}

/**
 * Classify a check's recent history. Arithmetic only — no heuristics, no
 * thresholds beyond the minimum-runs floor, and no reference to WHY a run
 * failed. MUON reports the pattern; it does not claim to know whether the
 * cause was a race, a timeout, or a real intermittent bug (this session's own
 * example looked like a race and was a timeout).
 */
export function classifyFlakiness(
  runs: readonly CheckRun[],
  window: number = CHECK_HISTORY_WINDOW,
  /**
   * True when the caller could not see far enough back to fill the window —
   * e.g. its job scan hit its own limit before reaching `window` runs.
   *
   * A truncated scan may still say "this failed", because a failure it DID see
   * is real. It may never say `stable` or `consistently-failing`, because both
   * are claims about runs it did not look at. ADR-0037 D2: the safe reading of
   * missing evidence is no claim, not a clean bill of health.
   */
  evidenceTruncated = false
): Flakiness {
  // Filter BEFORE slicing. Slicing first meant 17 skipped runs could push 10
  // real failures out of the window and yield "stable: 3 of 3 passed" — the
  // exact drift the `countsAsRun` docstring above says this prevents. Found by
  // adversarial review; the code contradicted its own comment.
  const recent = runs
    .filter((run) => countsAsRun(run.outcome))
    .slice(-Math.max(1, window));
  const total = recent.length;
  const failures = recent.filter((run) => countsAsFailure(run.outcome)).length;

  if (total < MIN_RUNS_FOR_FLAKINESS) {
    // Not `stable`: a check seen twice has not demonstrated anything, and the
    // safe reading of thin evidence is no claim rather than a clean bill.
    return { kind: "insufficient-evidence", runs: total, failures };
  }
  if (failures === 0) {
    return evidenceTruncated
      ? { kind: "insufficient-evidence", runs: total, failures }
      : { kind: "stable", runs: total, failures };
  }
  if (failures === total) {
    if (evidenceTruncated) {
      // Every run SEEN failed, but older runs were not read — "it has failed
      // every time" is not a claim this evidence supports.
      return { kind: "flaky", runs: total, failures };
    }
    // 9-of-9 is broken, not flaky. Calling it flaky is the exact
    // misclassification this feature would otherwise enable at scale.
    return { kind: "consistently-failing", runs: total, failures };
  }
  return { kind: "flaky", runs: total, failures };
}

/**
 * The sentence a packet carries. States the counts and stops — it never
 * suggests an action, because "so you can ignore it" is precisely the
 * conclusion an agent must not draw (ADR-0037 D3).
 */
export function describeFlakiness(flakiness: Flakiness): string {
  switch (flakiness.kind) {
    case "insufficient-evidence":
      return `no flakiness history yet (${flakiness.runs} recorded run${flakiness.runs === 1 ? "" : "s"})`;
    case "stable":
      return `stable: ${flakiness.runs} of ${flakiness.runs} recorded runs passed`;
    case "flaky":
      return `known-flaky: failed ${flakiness.failures} of ${flakiness.runs} recorded runs`;
    case "consistently-failing":
      return `consistently failing: ${flakiness.failures} of ${flakiness.runs} recorded runs`;
  }
}

/** A check plus what MUON knows about how it has behaved. */
export type AnnotatedCheck = HandoffCheck & {
  readonly flakiness: Flakiness;
  readonly flakinessNote: string;
};

/**
 * Annotate checks with their history.
 *
 * The outcome is copied through UNCHANGED — that is the whole contract, and
 * the reason this returns `HandoffCheck & {...}` rather than a reshaped type:
 * every existing consumer comparing `check.outcome === "failed"` keeps seeing
 * the failure it saw before.
 */
export function annotateChecks(
  checks: readonly HandoffCheck[],
  historyFor: (name: string) => readonly CheckRun[]
): AnnotatedCheck[] {
  return checks.map((check) => {
    const flakiness = classifyFlakiness(historyFor(check.name));
    return {
      ...check,
      flakiness,
      flakinessNote: describeFlakiness(flakiness),
    };
  });
}

/**
 * Report order: what needs a person first.
 *
 * A failure with no flakiness history outranks a known-flaky one, because the
 * first is unexplained and the second has context — but BOTH are still
 * failures and both are still in the list. Nothing is dropped, and
 * `annotateChecks(...).length` always equals the input length (ADR-0037 D4:
 * a demoted flake is de-emphasised, never removed, or a real regression hides
 * behind a history of unrelated timeouts).
 */
export function orderForReport(checks: readonly AnnotatedCheck[]): AnnotatedCheck[] {
  const rank = (check: AnnotatedCheck): number => {
    const failed = check.outcome === "failed" || check.outcome === "error";
    if (!failed) return check.outcome === "passed-but-uncovering" ? 2 : 4;
    if (check.flakiness.kind === "consistently-failing") return 0;
    if (check.flakiness.kind === "flaky") return 3;
    return 1; // a failure with no flakiness context — unexplained, wants a look
  };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => {
      const delta = rank(a.check) - rank(b.check);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((entry) => entry.check);
}

/** Trim a history to the retained window before persisting it. */
export function boundHistory(
  runs: readonly CheckRun[],
  window: number = CHECK_HISTORY_WINDOW
): CheckRun[] {
  // Same ordering as `classifyFlakiness`: a stored history of skipped runs must
  // not evict real evidence from the retained window.
  return runs
    .filter((run) => countsAsRun(run.outcome))
    .slice(-Math.max(1, window));
}
