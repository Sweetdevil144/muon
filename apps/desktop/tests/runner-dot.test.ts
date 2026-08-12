import { describe, expect, it } from "vitest";
import { runnerDot } from "../src/renderer/runner-status.js";

/**
 * The toolbar dot spent its whole life red: the condition tested
 * `runnerBanner`, the imported FUNCTION, which is always truthy. Its other
 * half read `state.offline`, a field DesktopState does not have. Nine standing
 * errors in a typecheck nobody ran is how both survived.
 */
describe("runnerDot", () => {
  it("is ONLINE only when the control plane says the runner is live", () => {
    expect(runnerDot({ online: true, runnerLive: true }).state).toBe("online");
  });

  it("is OFFLINE when the control plane answers and the runner is not live", () => {
    const dot = runnerDot({ online: true, runnerLive: false });
    expect(dot.state).toBe("offline");
    expect(dot.label).toMatch(/stays queued/);
  });

  it("is UNKNOWN before any reading, never a green light", () => {
    expect(runnerDot(null).state).toBe("unknown");
    expect(runnerDot(undefined).state).toBe("unknown");
  });

  it("is UNKNOWN when the control plane itself is unreachable", () => {
    // `runnerLive` from the last successful poll is not evidence about now:
    // the thing that would tell us is the thing that is down.
    const dot = runnerDot({ online: false, runnerLive: true });
    expect(dot.state).toBe("unknown");
    expect(dot.state).not.toBe("online");
    expect(dot.label).toMatch(/control plane unreachable/);
  });
});
