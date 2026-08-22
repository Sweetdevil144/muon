import type { RunnerBanner } from "./runner-status.js";

/**
 * Decides which of the runner banner or the "Stop all" confirmation wins the
 * single system line (the offline banner is handled separately upstream and
 * always wins outright). A true runner failure (error tone) still outranks
 * the stop confirmation, but an info/warning runner banner (e.g. "Runner
 * starting") must not swallow it, an operator who just hit Stop all needs to
 * see that it took effect.
 */
export function pickRunnerOrStopNotice(
  runnerNotice: RunnerBanner | null,
  stopNotice: string | null
): "runner" | "stop" | null {
  if (runnerNotice?.tone === "error") {
    return "runner";
  }
  if (stopNotice) {
    return "stop";
  }
  if (runnerNotice) {
    return "runner";
  }
  return null;
}

/**
 * How long a stop/cancel notice may hold its line, in ms — or null to stay.
 *
 * These notices are TRANSIENT CONFIRMATIONS, not state: "Stopped 1 active
 * task." was true at the click and says nothing an hour later, yet it used to
 * sit in the header's system line forever (measured 2026-08-13 — the founder's
 * navbar still read "Stopped 1 active task." from a long-finished stop).
 * Three grades:
 *
 *  - in-flight ("Stopping…") stays until its own completion replaces it — an
 *    expiring progress line would hide an operation that is still running;
 *  - a failure holds longer, because it is the only record the operator gets;
 *  - a success confirms and leaves.
 */
export function noticeExpiryMs(notice: string): number | null {
  if (notice.endsWith("…")) {
    return null;
  }
  if (/failed|could not/i.test(notice)) {
    return 12_000;
  }
  return 5_000;
}

