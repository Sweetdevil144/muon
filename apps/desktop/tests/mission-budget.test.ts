import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nextBudgetRaise } from "../src/renderer/cockpit.js";
import type { DispatchBudget } from "@muon/client";

const CEILING_MS = 8 * 1_800_000;

function budget(overrides: Partial<DispatchBudget>): DispatchBudget {
  return {
    jobId: "job-1",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 4_800_000,
    poolMs: 4_800_000,
    reservedMs: 600_000,
    consumedMs: 0,
    remainingMs: 4_200_000,
    deadlineAt: null,
    childrenIssued: 1,
    maxChildren: 3,
    descendantsIssued: 1,
    maxDescendants: 8,
    depth: 0,
    maxDepth: 3,
    children: [],
    ...overrides,
  };
}

describe("S9 mission budget control", () => {
  it("raises in +10 minute steps", () => {
    expect(nextBudgetRaise(budget({}))).toBe(4_800_000 + 600_000);
  });

  it("caps the raise target at the server ceiling (8 x 30 min)", () => {
    expect(
      nextBudgetRaise(budget({ maxDescendantWallMs: CEILING_MS - 60_000 }))
    ).toBe(CEILING_MS);
  });

  it("refuses to raise past the ceiling", () => {
    expect(
      nextBudgetRaise(budget({ maxDescendantWallMs: CEILING_MS }))
    ).toBeNull();
  });

  it("refuses v1 roots (no descendant pool) — the route would reject", () => {
    expect(nextBudgetRaise(budget({ maxDescendantWallMs: null }))).toBeNull();
  });

  it("two-step confirm is real: the raise button renders an arming state", () => {
    // The interactive path is covered structurally: the component only calls
    // raiseDispatchBudget when already arming (see cockpit.tsx raise()).
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/renderer/cockpit.tsx"
      ),
      "utf8"
    );
    // First press arms instead of firing.
    expect(source).toMatch(
      /if \(!arming\) \{\s*setArming\(true\);\s*return;\s*\}/
    );
    // The armed state is visible and labeled as a confirm.
    expect(source).toContain("Confirm +10 min");
    // Failures surface inline with an alert role, never silently.
    expect(source).toContain('className="mission-budget-error" role="alert"');
  });
});
