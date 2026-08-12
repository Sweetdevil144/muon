import { describe, expect, it, vi } from "vitest";
import { PREFLIGHT_LIMITS } from "@muon/client";

// Route modules pull in the Prisma client; stub it so this pure drift-lock
// test never touches a database.
vi.mock("../src/lib/db.js", () => ({ prisma: {} }));

import { FLEET_MAX_PER_VENDOR } from "../src/routes/fleet.js";
import { RUNNER_LIVE_WINDOW_MS } from "../src/routes/dispatch.js";

describe("capability preflight limits drift-lock", () => {
  it("keeps PREFLIGHT_LIMITS in lockstep with the backend constants", () => {
    expect(PREFLIGHT_LIMITS.maxAgentsPerVendor).toBe(FLEET_MAX_PER_VENDOR);
    expect(PREFLIGHT_LIMITS.runnerLiveWindowMs).toBe(RUNNER_LIVE_WINDOW_MS);
  });
});
