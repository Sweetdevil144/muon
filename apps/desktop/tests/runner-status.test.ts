import { describe, expect, it } from "vitest";
import { runnerBanner } from "../src/renderer/runner-status.js";

const status = (
  phase: "stopped" | "starting" | "live" | "backoff" | "degraded",
  overrides: Partial<{
    sandboxed: boolean;
    restartAttempt: number;
    note: string;
  }> = {}
) => ({
  phase,
  host: "desktop-mac",
  sandboxed: overrides.sandboxed ?? true,
  restartAttempt: overrides.restartAttempt ?? 0,
  note: overrides.note,
});

describe("runnerBanner", () => {
  it("stays silent for a healthy sandboxed runner", () => {
    expect(
      runnerBanner({
        online: true,
        runnerLive: true,
        runnerStatus: status("live"),
      })
    ).toBeNull();
  });

  it("distinguishes startup from a stale process-only state", () => {
    expect(
      runnerBanner({
        online: true,
        runnerLive: false,
        runnerStatus: status("starting"),
      })
    ).toEqual({
      tone: "info",
      text: "Runner starting, waiting for its host heartbeat. Dispatched work remains queued.",
    });
    expect(
      runnerBanner({
        online: true,
        runnerLive: false,
        runnerStatus: status("live"),
      })
    ).toEqual({
      tone: "warning",
      text: "Runner process is up, but its control-plane heartbeat is stale. New work remains queued.",
    });
  });

  it("surfaces bounded recovery attempts and degraded notes", () => {
    expect(
      runnerBanner({
        online: true,
        runnerLive: false,
        runnerStatus: status("backoff", {
          restartAttempt: 3,
          note: "runner exited unexpectedly; retrying in 4000ms",
        }),
      })
    ).toEqual({
      tone: "warning",
      text: "Runner recovering (attempt 3), runner exited unexpectedly; retrying in 4000ms. Dispatched work remains queued.",
    });
    expect(
      runnerBanner({
        online: true,
        runnerLive: false,
        runnerStatus: status("degraded", {
          restartAttempt: 6,
          note: "automatic restart limit reached",
        }),
      })
    ).toEqual({
      tone: "error",
      text: "Runner unavailable, automatic restart limit reached. Restart MUON or inspect runner.log; queued work has not executed.",
    });
  });

  it("makes unsandboxed operation visible even while live", () => {
    expect(
      runnerBanner({
        online: true,
        runnerLive: true,
        runnerStatus: status("live", { sandboxed: false }),
      })
    ).toEqual({
      tone: "warning",
      text: "Runner is live without sandbox isolation. Task permissions still apply, but local file isolation is limited.",
    });
  });

  it("preserves the legacy state fallback and suppresses runner noise while offline", () => {
    expect(
      runnerBanner({
        online: true,
        runnerLive: false,
      })
    ).toEqual({
      tone: "info",
      text: "Runner starting, dispatched work remains queued until a heartbeat arrives.",
    });
    expect(
      runnerBanner({
        online: false,
        runnerLive: false,
        runnerStatus: status("degraded"),
      })
    ).toBeNull();
  });
});
