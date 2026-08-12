import { describe, expect, it } from "vitest";
import { ONBOARDING_VENDORS } from "@muon/client/onboarding";
import {
  clampFleetCount,
  FLEET_MAX,
  FLEET_VENDORS,
  FLEET_VENDOR_LABELS,
  stepFleet,
} from "../src/lib/fleet.js";

describe("clampFleetCount", () => {
  it("clamps to the 0–3 range", () => {
    expect(clampFleetCount(-1)).toBe(0);
    expect(clampFleetCount(0)).toBe(0);
    expect(clampFleetCount(2)).toBe(2);
    expect(clampFleetCount(3)).toBe(3);
    expect(clampFleetCount(7)).toBe(FLEET_MAX);
  });

  it("truncates fractions and zeroes non-finite input", () => {
    expect(clampFleetCount(2.9)).toBe(2);
    expect(clampFleetCount(Number.NaN)).toBe(0);
    expect(clampFleetCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("FLEET_VENDORS", () => {
  it("sizes every managed lane the control plane knows about", () => {
    // The app drifted from the backend/client vendor list once already: Cursor
    // became a managed read-only lane and a fourth lane arrived, and the desktop
    // kept showing three rows while `muon fleet set --<lane>` worked from the CLI.
    expect([...FLEET_VENDORS]).toEqual([...ONBOARDING_VENDORS]);
    for (const vendor of FLEET_VENDORS) {
      expect(FLEET_VENDOR_LABELS[vendor]).toBeTruthy();
    }
    expect(FLEET_VENDOR_LABELS.opencode).toBe("OpenCode");
  });
});

describe("stepFleet", () => {
  it("steps one vendor and returns normalized counts for every vendor", () => {
    const next = stepFleet({ "claude-code": 1 }, "claude-code", 1);
    expect(next).toEqual({
      "claude-code": 2,
      codex: 0,
      cursor: 0,
      opencode: 0,
    });
  });

  it("never steps below 0 or above 3", () => {
    expect(stepFleet({ codex: 0 }, "codex", -1).codex).toBe(0);
    expect(stepFleet({ codex: 3 }, "codex", 1).codex).toBe(3);
  });

  it("treats missing and out-of-range existing counts as clamped values", () => {
    const next = stepFleet({ cursor: 9 }, "cursor", -1);
    expect(next.cursor).toBe(2);
    expect(next["claude-code"]).toBe(0);
  });
});
