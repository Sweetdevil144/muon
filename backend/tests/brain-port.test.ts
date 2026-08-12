import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The embedded brain's port is OS-ASSIGNED by default, and that is a decision
 * rather than an oversight: tests, a second checkout, and the desktop all run
 * brains on this machine, and a fixed number makes them collide.
 *
 * `MUON_BRAIN_PORT` pins it for anyone who wants a stable local endpoint. It is
 * opt-in because pinning TRADES churn for contention — a second brain then
 * fails to bind instead of quietly taking another port.
 *
 * This pins the CONTRACT of the flag (a valid TCP port or nothing), which is
 * what a caller can get wrong; the bind itself is exercised live.
 */
const flag = z.coerce.number().int().positive().max(65535).optional();

describe("MUON_BRAIN_PORT is an opt-in, valid TCP port", () => {
  it("absent means OS-assigned — the collision-safe default", () => {
    expect(flag.parse(undefined)).toBeUndefined();
  });

  it("accepts a real port, from a string as env vars always are", () => {
    expect(flag.parse("47100")).toBe(47100);
  });

  it("refuses ports that cannot be bound, rather than silently falling back", () => {
    // A typo'd port that quietly became "ephemeral again" would reintroduce
    // exactly the churn someone set this flag to remove.
    for (const bad of ["0", "-1", "70000", "not-a-port", "80.5"]) {
      expect(() => flag.parse(bad), bad).toThrow();
    }
  });
});
