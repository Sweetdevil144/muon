// Wave 4.2 — the crew-liveness state machine. Turns the signals already on the
// wire (job status/exit, the last task.progress/first-output heartbeat, remaining
// budget, and the watchdog's honest stall reason) into a single observable state
// per subagent. Its whole point is the signal the original hang LACKED: a child
// that launches but produces nothing lights AMBER ("stalled") the moment it
// crosses the startup window — visible in seconds, before it burns its budget and
// dies. Pure + shared so the desktop crew tree and the TUI fleet rail render it
// identically (no drift).

import { withoutBudgetMarker } from "@muon/protocol";

/**
 * Re-exported on this BROWSER-SAFE subpath because the desktop renderer needs
 * it and can reach neither of the alternatives: `@muon/protocol` is not a
 * desktop dependency (it does not resolve for the renderer bundle at all), and
 * the `@muon/client` barrel drags index → paths → `node:fs`, which esbuild
 * cannot bundle for a browser target. This module is pure and already renderer-
 * imported, so the panes that RENDER a terminal result strip the machine marker
 * with the same one definition the crew rail below uses.
 */
export { withoutBudgetMarker } from "@muon/protocol";

export type CrewLiveness =
  | "queued" // claimed, not yet producing
  | "launching" // running, no first output yet, still within the startup window
  | "stalled" // running, no first output PAST the startup window — amber, about to fail
  | "waiting-approval" // intentionally paused at a governed human gate
  | "live" // running, produced output, currently quiet
  | "progressing" // running, fresh progress
  | "budget-low" // running, budget nearly exhausted — amber
  | "done" // exited cleanly
  | "needs-attention"; // failed / interrupted / non-zero exit — red

export interface CrewLivenessInput {
  status: string; // queued | running | done | failed | interrupted | cancelled
  exitCode?: number | null;
  /**
   * ISO — the LAUNCH instant, the start of the startup window. Callers should
   * pass the run-start (`startedAt`) when available so the window matches the
   * runner's no-first-output watchdog, which is armed at launch — NOT the
   * enqueue time, which would inflate the age by queue-wait. Falls back to
   * creation time only when there is no recorded start.
   */
  createdAt: string;
  /** ISO — last first-output/task.progress/stream milestone; absent = no output yet. */
  lastProgressAt?: string | null;
  /** May carry the watchdog's honest stall reason or the failure tail. */
  result?: string | null;
  remainingBudgetMs?: number | null;
  /** Human gate is open for this exact job; inactivity watchdogs must exempt it. */
  waitingApproval?: boolean;
}

export interface CrewLivenessOptions {
  /**
   * No first output past this reads amber "stalled" — the early warning. MUST be
   * shorter than the runner's no-first-output watchdog so the amber lights BEFORE
   * the watchdog kills the job (that's the "before it dies" the original hang
   * lacked). Default 45s vs the runner's 180s worker watchdog.
   */
  startupWarnMs?: number;
  /**
   * The runner's no-first-output watchdog window (DEFAULT_STARTUP_STALL_MS in
   * execute.ts). A job still RUNNING without a durable progress row past this
   * boundary is inconsistent with the watchdog contract (lost runner, ignored
   * termination, or stale state), so it remains actionable instead of being
   * shown as calmly live.
   *
   * MUST track the runner (drift-locked in tests). When the runner's window was
   * raised from 90s to 180s and this mirror was not, every healthy worker in its
   * second silent minute would have been painted as a termination failure — the
   * amber-before-red contract inverted into red-before-anything.
   */
  startupWatchdogMs?: number;
  /** Beyond this since the last progress, a live job reads "live", not "progressing". */
  staleProgressMs?: number;
  /** Quiet-after-progress age that becomes an actionable stall warning. */
  idleWarnMs?: number;
  /** Remaining budget at/below this reads "budget-low". */
  budgetLowMs?: number;
}

export interface CrewLivenessResult {
  state: CrewLiveness;
  /** Amber/red — the operator's eye is needed. */
  attention: boolean;
  /** Age of the last progress signal, when there is one. */
  lastProgressAgeMs?: number;
  /** A short, honest reason when stalled or needing attention. */
  reason?: string;
}

const DEFAULT_STARTUP_WARN_MS = 45_000;
/** Mirrors the runner's DEFAULT_STARTUP_STALL_MS (packages/runner/src/execute.ts). */
const DEFAULT_STARTUP_WATCHDOG_MS = 180_000;
const DEFAULT_STALE_PROGRESS_MS = 15_000;
const DEFAULT_IDLE_WARN_MS = 2 * 60_000;
const DEFAULT_BUDGET_LOW_MS = 60_000;

/** First line of the job result, trimmed — the watchdog reason or failure tail. */
function shortReason(result?: string | null): string | undefined {
  if (typeof result !== "string") {
    return undefined;
  }
  // The budget-exhaustion marker is a MACHINE token (consumers classify on it);
  // this field is the sentence a human reads, so it carries the prose and not
  // the tag — and dropping it also stops the tag from eating a tenth of the
  // 200-character budget the operator's one line gets. The stripper lives with
  // the marker in @muon/protocol: a second local copy of "drop the first token"
  // is how the tag ends up shown on one surface and hidden on the next.
  const line = withoutBudgetMarker(result).split("\n", 1)[0]?.trim();
  if (!line) {
    return undefined;
  }
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function parseInstant(value?: string | null): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function deriveCrewLiveness(
  input: CrewLivenessInput,
  now: number,
  options: CrewLivenessOptions = {}
): CrewLivenessResult {
  const startupWarnMs = options.startupWarnMs ?? DEFAULT_STARTUP_WARN_MS;
  const startupWatchdogMs =
    options.startupWatchdogMs ?? DEFAULT_STARTUP_WATCHDOG_MS;
  const staleProgressMs = options.staleProgressMs ?? DEFAULT_STALE_PROGRESS_MS;
  const idleWarnMs = options.idleWarnMs ?? DEFAULT_IDLE_WARN_MS;
  const budgetLowMs = options.budgetLowMs ?? DEFAULT_BUDGET_LOW_MS;

  const nonZeroExit =
    typeof input.exitCode === "number" && input.exitCode !== 0;

  // Terminal states first.
  if (
    input.status === "failed" ||
    input.status === "interrupted" ||
    input.status === "cancelled" ||
    (input.status === "done" && nonZeroExit)
  ) {
    return {
      state: "needs-attention",
      attention: true,
      ...(shortReason(input.result) ? { reason: shortReason(input.result) } : {}),
    };
  }
  if (input.status === "done") {
    return { state: "done", attention: false };
  }
  if (input.status === "queued") {
    return { state: "queued", attention: false };
  }
  if (input.waitingApproval) {
    return {
      state: "waiting-approval",
      attention: true,
      reason: "waiting for an operator approval",
    };
  }

  // Running (or any not-yet-terminal state).
  const lastProgress = parseInstant(input.lastProgressAt);
  if (lastProgress === undefined) {
    // No first output yet — the exact original-hang case. Amber lights in the
    // window BEFORE the runner's watchdog kills a silent job (warn → watchdog);
    // that early warning is the whole point. Past the watchdog, a still-running
    // row with no durable progress is itself a stale-state/termination failure;
    // never hide that inconsistency as a calm live state.
    const start = parseInstant(input.createdAt) ?? now;
    const age = now - start;
    if (age >= startupWarnMs && age < startupWatchdogMs) {
      return {
        state: "stalled",
        attention: true,
        reason:
          shortReason(input.result) ??
          // In-flight fallback: there is no result row yet, so nothing about the
          // CAUSE has been observed. State the observation, then name the
          // candidates — quota/billing first, because a provider can take
          // minutes to return a spend-cap rejection and this window closes long
          // before that. Naming them is not asserting them. One line only:
          // shortReason() renders the first line alone.
          "no output yet — about to hit the startup watchdog; cause unconfirmed (provider quota/billing, auth, profile, or an unfinished MCP handshake)",
      };
    }
    if (age >= startupWatchdogMs) {
      return {
        state: "stalled",
        attention: true,
        reason:
          shortReason(input.result) ??
          "no durable provider output past the startup watchdog — runner ownership or provider termination may be stale",
      };
    }
    return { state: "launching", attention: false };
  }

  const lastProgressAgeMs = Math.max(0, now - lastProgress);
  if (
    typeof input.remainingBudgetMs === "number" &&
    input.remainingBudgetMs <= budgetLowMs
  ) {
    return { state: "budget-low", attention: true, lastProgressAgeMs };
  }
  if (lastProgressAgeMs <= staleProgressMs) {
    return { state: "progressing", attention: false, lastProgressAgeMs };
  }
  if (lastProgressAgeMs >= idleWarnMs) {
    return {
      state: "stalled",
      attention: true,
      lastProgressAgeMs,
      reason:
        "no provider or tool progress after initial output — MUON will stop the turn if inactivity continues",
    };
  }
  return { state: "live", attention: false, lastProgressAgeMs };
}

/** Operator-facing one-word label for a liveness state. */
export function crewLivenessLabel(state: CrewLiveness): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "launching":
      return "Launching";
    case "stalled":
      return "Stalled";
    case "waiting-approval":
      return "Awaiting approval";
    case "live":
      return "Live";
    case "progressing":
      return "Working";
    case "budget-low":
      return "Budget low";
    case "done":
      return "Done";
    case "needs-attention":
      return "Needs attention";
  }
}
