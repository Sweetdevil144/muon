import { describe, expect, it } from "vitest";
import { noticeExpiryMs, pickRunnerOrStopNotice } from "../src/renderer/system-notice.js";

describe("pickRunnerOrStopNotice", () => {
  it("lets the stop-all confirmation coexist with an info-tone runner banner", () => {
    expect(
      pickRunnerOrStopNotice(
        { tone: "info", text: "Runner starting, waiting for its host heartbeat." },
        "Stopped 3 active tasks."
      )
    ).toBe("stop");
  });

  it("lets the stop-all confirmation coexist with a warning-tone runner banner", () => {
    expect(
      pickRunnerOrStopNotice(
        { tone: "warning", text: "Runner recovering (attempt 1)." },
        "Stopped 3 active tasks."
      )
    ).toBe("stop");
  });

  it("still lets a true runner failure (error tone) outrank the stop confirmation", () => {
    expect(
      pickRunnerOrStopNotice(
        { tone: "error", text: "Runner unavailable, restart MUON." },
        "Stopped 3 active tasks."
      )
    ).toBe("runner");
  });

  it("falls back to the runner banner when there is no stop notice", () => {
    expect(
      pickRunnerOrStopNotice(
        { tone: "info", text: "Runner starting." },
        null
      )
    ).toBe("runner");
  });

  it("is null when neither notice is present", () => {
    expect(pickRunnerOrStopNotice(null, null)).toBeNull();
  });
});

describe("noticeExpiryMs", () => {
  it("a success receipt leaves; a failure holds longer; in-flight stays", () => {
    // "Stopped 1 active task." squatted in the header's system line forever
    // (measured 2026-08-13). A receipt confirms and leaves.
    expect(noticeExpiryMs("Stopped 1 active task.")).toBe(5_000);
    expect(noticeExpiryMs("Stopped 3 active tasks.")).toBe(5_000);
    // The failure is the only record the operator gets — it holds longer,
    // but it still leaves.
    expect(noticeExpiryMs("Stop all failed: control plane unavailable")).toBe(12_000);
    expect(noticeExpiryMs("Stopped 1/2; 1 task could not be stopped.")).toBe(12_000);
    expect(noticeExpiryMs("Could not stop this chat: nope")).toBe(12_000);
    // An expiring progress line would hide an operation still running.
    expect(noticeExpiryMs("Stopping every active task…")).toBeNull();
    expect(noticeExpiryMs("Stopping this chat's jobs…")).toBeNull();
  });
});
