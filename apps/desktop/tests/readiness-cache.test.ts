import { describe, expect, it } from "vitest";
import type { FleetReadinessReport } from "@muon/client";
import {
  createReadinessCache,
  READINESS_DISPLAY_TTL_MS,
} from "../src/lib/readiness-cache.js";

/**
 * The measured problem this cache exists for:
 *
 *   getFleetReadinessReport (cold)  ~3835 ms   <- spawns the vendor CLIs
 *   every other collectState leg     2-40 ms
 *
 * with a 2s renderer poll against an 8s backend probe cache, so roughly every
 * fourth poll stalled the WHOLE desktop state behind `cursor-agent status`
 * (3.3s on its own). These tests pin the properties that make the fix safe:
 * no caller ever waits, nothing is ever invented, and a stale value is always
 * LABELLED rather than passed off as live.
 */

function report(vendor: string, authenticated: boolean): FleetReadinessReport {
  return {
    vendors: [
      {
        vendor,
        installed: true,
        authenticated,
        detail: authenticated ? "logged in" : "not logged in",
      },
    ],
  } as unknown as FleetReadinessReport;
}

/** A probe whose resolution the test controls, so timing is deterministic. */
function deferredProbe() {
  const calls: Array<{ forced: boolean; resolve: (r: unknown) => void }> = [];
  const probe = (forced: boolean) =>
    new Promise<FleetReadinessReport | null>((resolve) => {
      calls.push({ forced, resolve: resolve as (r: unknown) => void });
    });
  return { calls, probe };
}

describe("readiness cache — never blocks a state poll", () => {
  it("answers synchronously with `probing` before any probe has landed", () => {
    const { calls, probe } = deferredProbe();
    const cache = createReadinessCache({ probe });

    const snapshot = cache.read();

    // The critical property: read() returned WITHOUT the probe resolving.
    expect(calls).toHaveLength(1);
    expect(snapshot.report).toBeNull();
    expect(snapshot.meta.state).toBe("probing");
    expect(snapshot.meta.checkedAt).toBeNull();
    expect(snapshot.meta.ageMs).toBeNull();
  });

  it("never invents a verdict — no probe result means no vendors", () => {
    const { probe } = deferredProbe();
    const snapshot = createReadinessCache({ probe }).read();
    // A fabricated "ready" here is exactly what would let a user dispatch into
    // a dead end, so the absence has to stay an absence.
    expect(snapshot.report).toBeNull();
  });

  it("serves the probed value once it lands, marked fresh", async () => {
    const { calls, probe } = deferredProbe();
    let clock = 1_000;
    const cache = createReadinessCache({ probe, now: () => clock });

    cache.read();
    calls[0]!.resolve(report("claude-code", true));
    await Promise.resolve();
    await Promise.resolve();

    clock = 3_000;
    const snapshot = cache.read();
    expect(snapshot.meta.state).toBe("fresh");
    expect(snapshot.report?.vendors[0]?.vendor).toBe("claude-code");
    // Age is measured from when the probe STARTED, not when it resolved — a
    // 3.8s probe must not read as fresher than its evidence actually is.
    expect(snapshot.meta.ageMs).toBe(2_000);
    expect(snapshot.meta.checkedAt).toBe(new Date(1_000).toISOString());
  });

  it("dedupes concurrent reads into ONE probe (the measured stampede)", () => {
    const { calls, probe } = deferredProbe();
    const cache = createReadinessCache({ probe });

    // The 2s poll plus the getState() calls a fleet "+" click makes. Three
    // concurrent COLD probes measured 5576ms against 3717ms for one.
    cache.read();
    cache.read();
    cache.read();

    expect(calls).toHaveLength(1);
  });

  it("re-probes in the background once the value passes the TTL", async () => {
    const { calls, probe } = deferredProbe();
    let clock = 0;
    const cache = createReadinessCache({ probe, now: () => clock });

    cache.read();
    calls[0]!.resolve(report("codex", true));
    await Promise.resolve();
    await Promise.resolve();

    clock = READINESS_DISPLAY_TTL_MS - 1;
    expect(cache.read().meta.state).toBe("fresh");
    expect(calls).toHaveLength(1);

    clock = READINESS_DISPLAY_TTL_MS;
    const stale = cache.read();
    // Still answers instantly from the old value — labelled `refreshing`, not
    // blanked and not a spinner.
    expect(calls).toHaveLength(2);
    expect(stale.meta.state).toBe("refreshing");
    expect(stale.report?.vendors[0]?.vendor).toBe("codex");
    expect(stale.meta.ageMs).toBe(READINESS_DISPLAY_TTL_MS);
  });
});

describe("readiness cache — honest degradation", () => {
  it("keeps the last good value and records why it stopped refreshing", async () => {
    const { calls, probe } = deferredProbe();
    let clock = 0;
    const errors: string[] = [];
    const cache = createReadinessCache({
      probe,
      now: () => clock,
      onError: (message) => errors.push(message),
    });

    cache.read();
    calls[0]!.resolve(report("cursor", true));
    await Promise.resolve();
    await Promise.resolve();

    clock = READINESS_DISPLAY_TTL_MS;
    cache.read();
    // The brain went away mid-probe.
    calls[1]!.resolve(null);
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = cache.read();
    // The local vendor CLIs did not change just because the control plane
    // blinked, so the evidence stays — with its age and reason attached.
    expect(snapshot.report?.vendors[0]?.vendor).toBe("cursor");
    expect(snapshot.meta.error).toMatch(/unavailable/i);
    expect(errors).toHaveLength(1);
    expect(["stale", "refreshing"]).toContain(snapshot.meta.state);
  });

  it("reports `unknown`, not a guess, when the FIRST probe fails", async () => {
    const cache = createReadinessCache({
      probe: () => Promise.reject(new Error("spawn ENOENT")),
    });

    await cache.refresh();

    const snapshot = cache.read();
    expect(snapshot.report).toBeNull();
    expect(snapshot.meta.error).toBe("spawn ENOENT");
    expect(["unknown", "probing"]).toContain(snapshot.meta.state);
  });
});

describe("readiness cache — the explicit human re-check", () => {
  it("bypasses the brain's own probe cache", async () => {
    const { calls, probe } = deferredProbe();
    const cache = createReadinessCache({ probe });

    void cache.refresh();

    expect(calls).toHaveLength(1);
    // `refresh: true` is what makes a just-completed `vendor login` visible.
    expect(calls[0]!.forced).toBe(true);
  });

  it("runs CONCURRENTLY with an in-flight background probe, and wins", async () => {
    const { calls, probe } = deferredProbe();
    let clock = 0;
    const cache = createReadinessCache({ probe, now: () => clock });

    // A background probe is already running (poll-driven).
    cache.read();
    expect(calls[0]!.forced).toBe(false);

    // The human presses "Re-check" 200ms in. Queueing behind the background
    // probe measured 7675ms for that button press against ~3.8s for one probe,
    // so the forced probe starts immediately instead.
    clock = 200;
    const forced = cache.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.forced).toBe(true);

    // The forced (cache-bypassing) answer lands first...
    calls[1]!.resolve(report("codex", true));
    await forced;
    expect(cache.read().report?.vendors[0]?.vendor).toBe("codex");

    // ...and the older background probe resolving late must NOT overwrite it.
    calls[0]!.resolve(report("codex", false));
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = cache.read();
    expect(snapshot.report?.vendors[0]?.authenticated).toBe(true);
    expect(snapshot.meta.ageMs).toBe(0);
  });

  it("joins an already-running forced probe rather than spawning a second", () => {
    const { calls, probe } = deferredProbe();
    const cache = createReadinessCache({ probe });

    void cache.refresh();
    void cache.refresh();

    expect(calls).toHaveLength(1);
  });
});

describe("readiness cache — brain restart", () => {
  it("drops the old control plane's verdict instead of showing it", async () => {
    const { calls, probe } = deferredProbe();
    const cache = createReadinessCache({ probe });

    cache.read();
    calls[0]!.resolve(report("claude-code", true));
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.read().report).not.toBeNull();

    cache.clear();

    const snapshot = cache.read();
    expect(snapshot.report).toBeNull();
    expect(snapshot.meta.checkedAt).toBeNull();
  });
});
