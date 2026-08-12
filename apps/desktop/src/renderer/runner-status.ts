import type { DesktopState } from "../shared/ipc.js";

export type RunnerBanner = {
  tone: "info" | "warning" | "error";
  text: string;
};

type RunnerState = Pick<
  DesktopState,
  "online" | "runnerLive" | "runnerStatus"
>;

const cleanNote = (note: string | undefined, fallback: string): string =>
  (note?.trim() || fallback).replace(/[.!?]+$/, "");

/** Turn supervisor evidence into an operator-facing, non-optimistic status. */
export function runnerBanner(state: RunnerState): RunnerBanner | null {
  if (!state.online) return null;
  const status = state.runnerStatus;
  if (!status) {
    return state.runnerLive
      ? null
      : {
          tone: "info",
          text: "Runner starting, dispatched work remains queued until a heartbeat arrives.",
        };
  }

  switch (status.phase) {
    case "starting":
      return {
        tone: "info",
        text: "Runner starting, waiting for its host heartbeat. Dispatched work remains queued.",
      };
    case "backoff":
      return {
        tone: "warning",
        text: `Runner recovering (attempt ${status.restartAttempt}), ${cleanNote(
          status.note,
          "the previous runner exited"
        )}. Dispatched work remains queued.`,
      };
    case "degraded": {
      const reason = cleanNote(status.note, "automatic recovery stopped");
      return state.runnerLive
        ? {
            tone: "warning",
            text: `Desktop runner unavailable, ${reason}. Another runner is live; verify it is the intended executor.`,
          }
        : {
            tone: "error",
            text: `Runner unavailable, ${reason}. Restart MUON or inspect runner.log; queued work has not executed.`,
          };
    }
    case "stopped":
      return {
        tone: "warning",
        text: "Runner stopped, dispatched work remains queued until MUON restarts it.",
      };
    case "live":
      if (!state.runnerLive) {
        return {
          tone: "warning",
          text: "Runner process is up, but its control-plane heartbeat is stale. New work remains queued.",
        };
      }
      return status.sandboxed
        ? null
        : {
            tone: "warning",
            text: "Runner is live without sandbox isolation. Task permissions still apply, but local file isolation is limited.",
          };
  }
}

/**
 * What the toolbar's live dot may honestly claim.
 *
 * The dot used to read `runnerBanner || state?.offline`. `runnerBanner` is
 * THIS MODULE'S FUNCTION, imported and never called, so the condition was
 * always true and the dot said "Runner offline" forever — while `offline` is
 * not a field on DesktopState at all, so the second half was always undefined.
 * Both mistakes were invisible because the renderer's typecheck was not being
 * run (it had nine standing errors, this among them).
 *
 * Three states, not two. Before the first poll lands, and whenever the control
 * plane itself is unreachable, MUON does not KNOW whether a runner is live —
 * and a dot that shows green on no information is the failure mode that makes
 * an operator trust a dead crew.
 */
export type RunnerDot = {
  readonly state: "online" | "offline" | "unknown";
  readonly label: string;
};

export function runnerDot(
  state: Pick<DesktopState, "online" | "runnerLive"> | null | undefined
): RunnerDot {
  if (!state) {
    return { state: "unknown", label: "Runner status unknown, no reading yet" };
  }
  if (!state.online) {
    // The control plane is the thing that would TELL us about the runner.
    return {
      state: "unknown",
      label: "Runner status unknown, control plane unreachable",
    };
  }
  return state.runnerLive
    ? { state: "online", label: "Runner online" }
    : { state: "offline", label: "Runner offline, dispatched work stays queued" };
}
