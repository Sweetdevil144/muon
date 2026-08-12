import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED_MARKER,
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_CHILDREN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_MAX_DESCENDANTS,
  PRE_LAUNCH_INTERRUPT_RESULTS,
  budgetExhaustedResult,
  delegationRootPolicyV2Schema,
  isBudgetExhausted,
  isPreLaunchInterrupt,
  isUncertainTerminalOutcome,
  withoutBudgetMarker,
} from "../src/index.js";

// ── P0.1 Slice A: pre-launch interrupt classification ────────────────────────
//
// "Provably unstarted" is a byte-exact contract: a resume planner may only
// auto-redispatch a job whose interrupted `result` proves NO vendor process was
// ever launched. These strings must stay byte-identical to what the runner
// writes (packages/runner/src/loop.ts and execute.ts) — the constants exist so
// the writer and the classifier can never drift.

describe("PRE_LAUNCH_INTERRUPT_RESULTS", () => {
  it("carries the three exact pre-vendor-launch strings", () => {
    expect(PRE_LAUNCH_INTERRUPT_RESULTS).toEqual([
      "runner authority was lost before vendor execution began",
      "runner authority was lost before vendor launch",
      "absolute delegation deadline elapsed before vendor launch",
    ]);
  });

  it("isPreLaunchInterrupt accepts each constant", () => {
    for (const result of PRE_LAUNCH_INTERRUPT_RESULTS) {
      expect(isPreLaunchInterrupt(result)).toBe(true);
    }
  });

  it("isPreLaunchInterrupt rejects post-launch and unknown outcomes", () => {
    expect(isPreLaunchInterrupt(null)).toBe(false);
    expect(isPreLaunchInterrupt(undefined)).toBe(false);
    expect(isPreLaunchInterrupt("")).toBe(false);
    expect(
      isPreLaunchInterrupt("runner authority was lost during vendor execution")
    ).toBe(false);
    // The REC-025 reclaim text is post-claim, therefore NEVER provably
    // unstarted — a vendor process may still be alive.
    expect(
      isPreLaunchInterrupt(
        "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching."
      )
    ).toBe(false);
    // Near-miss (the pre-claim variant used before the lane lookup) must not
    // classify: it is not one of the three promoted literals.
    expect(
      isPreLaunchInterrupt("runner authority was lost before execution began")
    ).toBe(false);
  });
});

describe("wall-budget exhaustion classification (F2)", () => {
  const result = budgetExhaustedResult({
    vendor: "claude-code",
    budgetMs: 600_000,
    elapsedMs: 603_297,
  });

  it("is classifiable structurally, not by reading prose", () => {
    expect(result.startsWith(BUDGET_EXHAUSTED_MARKER)).toBe(true);
    expect(isBudgetExhausted(result)).toBe(true);
  });

  it("states the budget, the ACTUAL spend, and that nobody interrupted it", () => {
    // The founder's measured numbers: 603 297 ms against a 600 000 ms budget.
    expect(result).toContain("wall-clock budget of 600s");
    expect(result).toContain("ran out after 603s of work");
    expect(result).toContain("No human interrupted this run");
    expect(result).toContain("the runner did not lose authority");
    expect(result).toContain("larger maxWallMs");
  });

  it("falls back to the budget when the spend is unknown, and never invents one", () => {
    const noSpend = budgetExhaustedResult({
      vendor: "codex",
      budgetMs: 60_000,
    });
    expect(noSpend).toContain("budget of 60s ran out after 60s");
    expect(
      budgetExhaustedResult({
        vendor: "codex",
        budgetMs: 60_000,
        elapsedMs: Number.NaN,
      })
    ).toContain("ran out after 60s");
  });

  it("never claims budget exhaustion for anything else", () => {
    for (const other of [
      ...PRE_LAUNCH_INTERRUPT_RESULTS,
      "runner authority was lost during vendor execution",
      "MUON stopped claude-code: no output within 180s",
      "the tests did not pass",
      "",
      null,
      undefined,
    ]) {
      expect(isBudgetExhausted(other)).toBe(false);
    }
  });

  it("and a pre-launch interrupt is never mistaken for a budget kill (both directions)", () => {
    expect(isPreLaunchInterrupt(result)).toBe(false);
  });

  it("strips the MACHINE marker for human prose, and leaves everything else alone", () => {
    const human = withoutBudgetMarker(result);
    expect(human.startsWith(BUDGET_EXHAUSTED_MARKER)).toBe(false);
    // The sentence itself is untouched — stripping is not summarizing.
    expect(human.startsWith("MUON stopped claude-code:")).toBe(true);
    expect(human).toContain("ran out after 603s of work");
    // A non-budget result passes through byte-identical.
    expect(withoutBudgetMarker("the tests did not pass")).toBe(
      "the tests did not pass"
    );
    expect(withoutBudgetMarker("")).toBe("");
  });

  it("classifies a budget kill as UNCERTAIN — the human gate, not an autonomous turn", () => {
    // The whole point: `failed` says WHY it ended, never what it left behind.
    // The founder's workers were killed 3s over budget MID-EDIT; those partial
    // writes are exactly as unverified as any interrupt's.
    expect(
      isUncertainTerminalOutcome({ status: "failed", result })
    ).toBe(true);
    expect(
      isUncertainTerminalOutcome({ status: "interrupted", result: null })
    ).toBe(true);
    // A vendor that failed on its merits, and a clean finish, are CERTAIN.
    expect(
      isUncertainTerminalOutcome({
        status: "failed",
        result: "the tests did not pass",
      })
    ).toBe(false);
    expect(isUncertainTerminalOutcome({ status: "done", result: "ok" })).toBe(
      false
    );
    // A missing result never manufactures uncertainty for a non-interrupt.
    expect(isUncertainTerminalOutcome({ status: "failed" })).toBe(false);
  });
});

describe("delegation budget arithmetic stays bounded (F2)", () => {
  it("keeps the default child inside the per-child hard cap, with headroom", () => {
    // The manifest schema caps a child at 1 800 000 ms; the default must stay
    // strictly under it so an explicit larger request is still expressible.
    expect(DEFAULT_CHILD_WALL_MS).toBeLessThan(1_800_000);
  });

  it("keeps the default root pool inside the v2 schema ceiling", () => {
    const defaultPool = DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS;
    const ceiling = DELEGATION_MAX_DESCENDANTS * 1_800_000;
    expect(defaultPool).toBeLessThanOrEqual(ceiling);
    // …and the pool the backend mints must actually VALIDATE as a v2 root.
    expect(
      delegationRootPolicyV2Schema.safeParse({
        version: 2,
        jobId: "job-root",
        workspacePath: "/repo",
        maxDepth: DELEGATION_MAX_DEPTH,
        maxChildrenPerParent: DELEGATION_MAX_CHILDREN,
        maxTotalDescendants: DELEGATION_MAX_DESCENDANTS,
        maxIterations: 2,
        maxDescendantWallMs: defaultPool,
        deadlineAt: new Date().toISOString(),
        authority: "orchestrator",
        childAuthority: "work",
        narrowingRequired: true,
      }).success
    ).toBe(true);
  });

  it("lets a FULL-WIDTH fan-out of default children fit the pool at once", () => {
    // The point of F1+F2 together: DELEGATION_MAX_CHILDREN siblings, each at the
    // default budget, must be simultaneously affordable — otherwise widening the
    // fleet just moves the queue from the seat semaphore to the budget pool.
    expect(DELEGATION_MAX_CHILDREN * DEFAULT_CHILD_WALL_MS).toBeLessThanOrEqual(
      DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS
    );
  });
});
