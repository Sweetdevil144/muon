import { describe, expect, it } from "vitest";
import {
  budgetExhaustedSubmitBlocker,
  gitnexusIndexSubmitBlocker,
  resolveComposerSubmitBlocker,
} from "../src/lib/composer-submit-blocker.js";
import { buildBudgetLineView } from "@muon/client/budget-view";
import type { DispatchBudget } from "@muon/client";

function budget(overrides: Partial<DispatchBudget>): DispatchBudget {
  return {
    jobId: "job-1",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 4_800_000,
    poolMs: 4_800_000,
    reservedMs: 600_000,
    consumedMs: 4_800_000,
    remainingMs: 0,
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

describe("composer submit blockers", () => {
  it("blocks on stale gitnexus index", () => {
    const blocker = gitnexusIndexSubmitBlocker({
      status: "ready",
      stale: true,
      note: "HEAD is ahead of indexed commit",
    });
    expect(blocker?.kind).toBe("index-stale");
    expect(blocker?.message).toMatch(/re-index/i);
  });

  it("does not block while the index is fresh", () => {
    expect(
      gitnexusIndexSubmitBlocker({ status: "ready", stale: false })
    ).toBeNull();
  });

  it("blocks on exhausted mission budget", () => {
    const blocker = budgetExhaustedSubmitBlocker(
      buildBudgetLineView(budget({ remainingMs: 0 }))
    );
    expect(blocker?.kind).toBe("budget-exhausted");
    expect(blocker?.message).toMatch(/raise budget/i);
  });

  it("prefers readiness over index and budget", () => {
    const blocker = resolveComposerSubmitBlocker({
      readinessIssue: {
        vendor: "codex",
        label: "Codex",
        blocking: true,
        detail: "Missing API key",
        fixHint: "Add the key, then re-check.",
      },
      gitnexus: { status: "ready", stale: true },
      budget: buildBudgetLineView(budget({ remainingMs: 0 })),
    });
    expect(blocker?.kind).toBe("readiness");
  });

  it("falls through to index stale when readiness is clear", () => {
    const blocker = resolveComposerSubmitBlocker({
      gitnexus: { status: "ready", stale: true },
      budget: buildBudgetLineView(budget({ remainingMs: 0 })),
    });
    expect(blocker?.kind).toBe("index-stale");
  });
});
