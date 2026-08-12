import { describe, expect, it } from "vitest";
import { deriveCrewLiveness } from "@muon/client";
import {
  DEFAULT_ORCHESTRATOR_POST_OUTPUT_STALL_MS,
  DEFAULT_ORCHESTRATOR_STARTUP_STALL_MS,
  DEFAULT_POST_OUTPUT_STALL_MS,
  DEFAULT_STARTUP_STALL_MS,
} from "../src/execute.js";

/**
 * F3 drift lock — the crew surfaces mirror the runner's stall windows, and the
 * mirror lives in a package the runner depends on (so the assertion has to live
 * HERE, on the side that can see both).
 *
 * The contract is amber-before-red: a job with no first output must light amber
 * ("stalled") BEFORE the runner's watchdog kills it. If the runner's window
 * moves and `crew-liveness`'s default does not, the crew tree starts painting
 * healthy launching workers as termination failures — the warning inverted into
 * a false alarm.
 */
describe("stall-window drift lock (runner ↔ crew-liveness)", () => {
  const NOW = Date.parse("2026-07-28T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  /** A running job with no first output, `age` ms after launch. */
  const at = (age: number) =>
    deriveCrewLiveness({ status: "running", createdAt: iso(age) }, NOW);

  it("stays CALM early and warns amber while the job is still legitimately alive", () => {
    expect(at(10_000).state).toBe("launching");
    // 1 ms before the runner's own watchdog: amber (a warning), and explicitly
    // "about to hit the watchdog" — NOT the past-the-watchdog inconsistency.
    const beforeKill = at(DEFAULT_STARTUP_STALL_MS - 1);
    expect(beforeKill.state).toBe("stalled");
    expect(beforeKill.reason).toMatch(/about to hit the startup watchdog/);
  });

  it("switches to the past-the-watchdog reason at EXACTLY the runner's window", () => {
    // THE drift lock. This boundary is the runner's DEFAULT_STARTUP_STALL_MS; if
    // the mirror lags the runner (as it would have at the old 90 000), every
    // healthy worker in its second silent minute is reported as a stale-state
    // or termination failure it is not.
    expect(at(DEFAULT_STARTUP_STALL_MS + 1).reason).toMatch(
      /past the startup watchdog/
    );
    expect(at(DEFAULT_STARTUP_STALL_MS - 1).reason).not.toMatch(
      /past the startup watchdog/
    );
  });

  it("keeps the coordinator's windows strictly wider than a worker's", () => {
    expect(DEFAULT_ORCHESTRATOR_STARTUP_STALL_MS).toBeGreaterThan(
      DEFAULT_STARTUP_STALL_MS
    );
    expect(DEFAULT_ORCHESTRATOR_POST_OUTPUT_STALL_MS).toBeGreaterThan(
      DEFAULT_POST_OUTPUT_STALL_MS
    );
  });
});
