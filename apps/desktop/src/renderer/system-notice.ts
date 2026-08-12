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
