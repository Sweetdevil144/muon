import { describe, expect, it } from "vitest";
import {
  clampUnattendedHorizon,
  describeHorizonReap,
  evaluateUnattendedHorizon,
  horizonApprovesPendingGate,
  UNATTENDED_HORIZON_DEFAULT_MS,
  UNATTENDED_HORIZON_MAX_MS,
  UNATTENDED_HORIZON_MIN_MS,
} from "../src/index.js";

// ADR-0040 D3/D4. Detaching removes the compensating fact MUON's posture rests
// on — that a human is reachable when a gate fires. These assertions are about
// the two things that keep that acceptable: the bound is real, and waiting is
// never a way to get approved.

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function detached(lastAttachedAt: number | null, detachedAt = NOW - 5 * HOUR) {
  return { detached: true, attached: false, lastAttachedAt, detachedAt };
}

describe("the horizon is a real bound", () => {
  it("expires once nobody has attended for longer than the horizon", () => {
    const verdict = evaluateUnattendedHorizon(
      detached(NOW - 4 * HOUR),
      3 * HOUR,
      NOW
    );
    expect(verdict.kind).toBe("expired");
    if (verdict.kind === "expired") {
      expect(verdict.unattendedMs).toBe(4 * HOUR);
      expect(verdict.horizonMs).toBe(3 * HOUR);
    }
  });

  it("does not expire inside the horizon, and says how long is left", () => {
    const verdict = evaluateUnattendedHorizon(
      detached(NOW - 1 * HOUR),
      3 * HOUR,
      NOW
    );
    expect(verdict.kind).toBe("within");
    if (verdict.kind === "within") {
      expect(verdict.remainingMs).toBe(2 * HOUR);
    }
  });

  it("expires exactly AT the horizon, not one tick after", () => {
    expect(
      evaluateUnattendedHorizon(detached(NOW - 3 * HOUR), 3 * HOUR, NOW).kind
    ).toBe("expired");
  });

  it("does not apply while a surface is attached", () => {
    expect(
      evaluateUnattendedHorizon(
        {
          detached: true,
          attached: true,
          lastAttachedAt: NOW - 10 * HOUR,
          detachedAt: NOW - 20 * HOUR,
        },
        3 * HOUR,
        NOW
      ).kind
    ).toBe("not-applicable");
  });

  it("does not apply to a daemon that is not detached at all", () => {
    // The attached desktop app is not on a countdown.
    expect(
      evaluateUnattendedHorizon(
        {
          detached: false,
          attached: false,
          lastAttachedAt: NOW - 10 * HOUR,
          detachedAt: NOW - 20 * HOUR,
        },
        3 * HOUR,
        NOW
      ).kind
    ).toBe("not-applicable");
  });

  it("AGES a daemon that has never been attended, and eventually reaps it", () => {
    // The review's finding 2, and the highest-value case rather than a corner:
    // the brain/runner pair auto-spawned by a `muon` command is never attached
    // by any surface. An earlier version returned unattendedMs = 0 on every
    // call for lastAttachedAt === null, so this daemon was IMMORTAL and D3 was
    // defeated in exactly the scenario it exists for. Measured then: still
    // "within" at +36500 days.
    const freshlyDetached = evaluateUnattendedHorizon(
      { detached: true, attached: false, lastAttachedAt: null, detachedAt: NOW },
      3 * HOUR,
      NOW
    );
    expect(freshlyDetached.kind).toBe("within");

    for (const elapsed of [4 * HOUR, 24 * HOUR, 365 * 24 * HOUR]) {
      const verdict = evaluateUnattendedHorizon(
        {
          detached: true,
          attached: false,
          lastAttachedAt: null,
          detachedAt: NOW,
        },
        3 * HOUR,
        NOW + elapsed
      );
      expect(verdict.kind, `+${elapsed}ms`).toBe("expired");
    }
  });
});

describe("a corrupted clock cannot buy an extension", () => {
  it("IGNORES a future lastAttachedAt entirely, however far ahead it is", () => {
    // The review's finding 3, and a lesson about the test rather than the
    // code: the previous version used NOW + 2h against a 3h horizon evaluated
    // at NOW, which passes whether or not the stamp is trusted. It certified
    // the assertion, not the property. Honouring the stamp deferred the reap by
    // exactly the corruption delta — measured then: lastAttachedAt = NOW + 100
    // days stayed "within" until +101 days.
    for (const skew of [2 * HOUR, 100 * 24 * HOUR, 365 * 24 * HOUR]) {
      const verdict = evaluateUnattendedHorizon(
        {
          detached: true,
          attached: false,
          lastAttachedAt: NOW + skew,
          detachedAt: NOW - 5 * HOUR,
        },
        3 * HOUR,
        NOW
      );
      // The daemon detached 5h ago and the horizon is 3h. A trusted future
      // stamp would say "within"; distrusting it says "expired".
      expect(verdict.kind, `+${skew}ms`).toBe("expired");
    }
  });

  it("ignores an attach that predates this unattended run", () => {
    // An attach from before the daemon detached says nothing about this run.
    const verdict = evaluateUnattendedHorizon(
      {
        detached: true,
        attached: false,
        lastAttachedAt: NOW - 20 * HOUR,
        detachedAt: NOW - 5 * HOUR,
      },
      3 * HOUR,
      NOW
    );
    expect(verdict.kind).toBe("expired");
    if (verdict.kind === "expired") {
      // Aged from detachedAt (5h), not from the older attach (20h).
      expect(verdict.unattendedMs).toBe(5 * HOUR);
    }
  });

  it("lets a REAL attach after detach push the clock forward", () => {
    // The trustworthy case still works: a surface that genuinely attached an
    // hour ago resets the countdown from there.
    const verdict = evaluateUnattendedHorizon(
      {
        detached: true,
        attached: false,
        lastAttachedAt: NOW - 1 * HOUR,
        detachedAt: NOW - 10 * HOUR,
      },
      3 * HOUR,
      NOW
    );
    expect(verdict.kind).toBe("within");
    if (verdict.kind === "within") {
      expect(verdict.remainingMs).toBe(2 * HOUR);
    }
  });

  it("clamps a horizon that a setting tried to make unbounded", () => {
    expect(clampUnattendedHorizon(Number.MAX_SAFE_INTEGER)).toBe(
      UNATTENDED_HORIZON_MAX_MS
    );
    expect(clampUnattendedHorizon(Infinity)).toBe(UNATTENDED_HORIZON_DEFAULT_MS);
  });

  it("resolves an unreadable setting to the DEFAULT, never to the maximum", () => {
    // An unreadable setting is an unknown, and the safe reading of an unknown
    // here is the conservative one — not the longest bound MUON allows.
    for (const bad of [undefined, null, "3h", {}, [], NaN, -1, 0]) {
      const clamped = clampUnattendedHorizon(bad);
      expect(clamped, String(bad)).toBe(UNATTENDED_HORIZON_DEFAULT_MS);
      expect(clamped, String(bad)).not.toBe(UNATTENDED_HORIZON_MAX_MS);
    }
  });

  it("refuses a horizon short enough to reap an ordinary restart", () => {
    expect(clampUnattendedHorizon(1)).toBe(UNATTENDED_HORIZON_MIN_MS);
    expect(clampUnattendedHorizon(500)).toBe(UNATTENDED_HORIZON_MIN_MS);
  });

  it("clamps inside evaluate too, so a raw setting cannot bypass the range", () => {
    // Passing an absurd horizon straight to evaluate must not disable the bound.
    const verdict = evaluateUnattendedHorizon(
      { detached: true, attached: false, lastAttachedAt: null, detachedAt: NOW - 48 * HOUR },
      Number.MAX_SAFE_INTEGER,
      NOW
    );
    expect(verdict.kind).toBe("expired");
  });

  it("keeps the default conservative — hours, not days", () => {
    expect(UNATTENDED_HORIZON_DEFAULT_MS).toBeLessThanOrEqual(6 * HOUR);
    expect(UNATTENDED_HORIZON_DEFAULT_MS).toBeGreaterThanOrEqual(1 * HOUR);
  });
});

describe("ADR-0040 D4 — waiting is never a way to get approved", () => {
  it("never approves a pending gate — asserted at the TYPE level too", () => {
    // The review is right that `expect(f()).toBe(false)` on a function whose
    // declared return type is `false` cannot fail. Keeping the runtime check
    // (it would catch a return-type widening plus a body change together) and
    // adding the thing that actually holds the line: the declared type. If
    // someone widens it to `boolean` to make room for a true, this stops
    // compiling.
    const verdict: false = horizonApprovesPendingGate();
    expect(verdict).toBe(false);
  });

  it("exports nothing that could approve, grant, or auto-continue", () => {
    return import("../src/unattended-horizon.ts").then((module) => {
      const suspicious = Object.keys(module).filter(
        (name) =>
          /approve|grant|autoApprove|allow|continue/i.test(name) &&
          name !== "horizonApprovesPendingGate"
      );
      expect(suspicious).toEqual([]);
    });
  });

  it("says in the audit line that the pending approval was NOT granted", () => {
    const line = describeHorizonReap({
      unattendedMs: 4 * HOUR,
      horizonMs: 3 * HOUR,
    });
    expect(line).toMatch(/NOT granted/);
    // Stopped, not failed — the distinction has to be legible on re-attach.
    expect(line).toMatch(/stopped, not failed/i);
  });
});

describe("the reap explains itself with the number that was in force", () => {
  it("names both the elapsed time and the bound", () => {
    // ADR-0040's own recommendation: record the value, so the horizon is never
    // implicit in an audit row.
    const line = describeHorizonReap({
      unattendedMs: 4 * HOUR,
      horizonMs: 3 * HOUR,
    });
    expect(line).toContain("4.0h");
    expect(line).toContain("3.0h");
  });

  it("never suggests the work can simply be resumed", () => {
    // Re-attach is discovery, not resurrection (D5). An audit line implying
    // otherwise would set the wrong expectation at exactly the wrong moment.
    const line = describeHorizonReap({
      unattendedMs: 4 * HOUR,
      horizonMs: 3 * HOUR,
    });
    expect(line).not.toMatch(/will resume|resumes automatically|picked up again/i);
  });
});
