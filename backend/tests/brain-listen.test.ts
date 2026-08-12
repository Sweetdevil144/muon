import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDED_BRAIN_PORT } from "@muon/protocol";
import { resolveBrainListenPlan } from "../src/lib/brain-listen.js";

/**
 * The embedded brain's address is what every local surface discovers, what an
 * attached seat's capability file PINS at attach time, and what a long-lived
 * MCP server keeps calling for days. Churn there was invisible and expensive:
 * a capability file pinned :55666 while the brain answered on :50598.
 */
describe("resolveBrainListenPlan", () => {
  it("prefers the STABLE constant when nothing is configured", () => {
    const plan = resolveBrainListenPlan(undefined);
    expect(plan.port).toBe(DEFAULT_EMBEDDED_BRAIN_PORT);
    expect(plan.mayFallBack, "a user whose port is taken still gets a brain").toBe(true);
  });

  it("honours an explicit pin, and REFUSES to silently take another port", () => {
    const plan = resolveBrainListenPlan(51_234);
    expect(plan.port).toBe(51_234);
    // Falling back here would turn someone's configuration into a suggestion:
    // they asked for an address, and they must hear that it was unavailable.
    expect(plan.mayFallBack).toBe(false);
  });

  it("treats an explicit 0 as 'give me an ephemeral port', with nothing to fall back from", () => {
    const plan = resolveBrainListenPlan(0);
    expect(plan.port).toBe(0);
    expect(plan.mayFallBack).toBe(false);
  });

  it("keeps the constant off the OS ephemeral range", () => {
    // If the kernel could hand this number to something else first, a "stable"
    // port would collide by design rather than by accident.
    expect(DEFAULT_EMBEDDED_BRAIN_PORT).toBeLessThan(32_768);
    expect(DEFAULT_EMBEDDED_BRAIN_PORT).toBeGreaterThan(1_024);
  });
});
