import { describe, expect, it } from "vitest";
import { pickRunnerOrStopNotice } from "../src/renderer/system-notice.js";

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
