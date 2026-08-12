import type { LoopRunRecord } from "@muon/client";

/**
 * The one honest sentence for a governed loop bound to a dispatched job.
 *
 * WHY: a `loop` job renders as a bare "Working" for as long as it iterates, so
 * an agent that has finished iteration 3 of 10 with failing checks is
 * indistinguishable from an agent that is hung, or from one whose session
 * never closed. The founder read exactly that as "the subagent completed but
 * MUON never refreshed" — the ledger said `loop.iteration ↻ 3/10 tests:fail`
 * the whole time (2026-08-05).
 *
 * The line is derived ONLY from what the ledger recorded: the iteration
 * counter, the budget, and the shell/evaluator outcome of the last completed
 * iteration. It never guesses why, and it never claims a verdict the loop has
 * not produced.
 */
export function describeLoopProgress(
  loop: LoopRunRecord | null | undefined
): string | null {
  if (!loop) return null;
  if (loop.status !== "running") return null;
  const max = loop.budget?.maxIterations;
  // `iterations` counts COMPLETED iterations; the one in flight is the next.
  const current = Math.max(1, (loop.iterations ?? 0) + 1);
  const counter =
    typeof max === "number" && max > 0
      ? `loop ${Math.min(current, max)}/${max}`
      : `loop ${current}`;
  const outcome = lastOutcome(loop);
  return outcome ? `${counter} · ${outcome}` : counter;
}

/**
 * What the LAST recorded iteration concluded, in operator language. Shell
 * results are the loop's own gate; the evaluator verdict only exists on a
 * `critique_patch` loop and only after the shell went green.
 */
function lastOutcome(loop: LoopRunRecord): string | null {
  const progress = loop.progress;
  if (!progress) return null;
  const failing = (progress.shell ?? []).filter((row) => !row.ok);
  if (failing.length > 0) {
    const names = failing.map((row) => row.name).join(", ");
    return `checks failing (${names})`;
  }
  const evaluator = progress.evaluator;
  if (evaluator && !evaluator.pass) {
    return "reviewer asked for changes";
  }
  if ((progress.shell ?? []).length > 0) {
    return "checks passing";
  }
  return null;
}

/** The loop run that owns `jobId`, if the ledger bound one. */
export function loopForJob(
  loops: readonly LoopRunRecord[] | null | undefined,
  jobId: string | null | undefined
): LoopRunRecord | null {
  if (!loops || !jobId) return null;
  return loops.find((loop) => loop.dispatchJobId === jobId) ?? null;
}
