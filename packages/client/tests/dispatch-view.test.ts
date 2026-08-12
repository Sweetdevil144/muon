import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "../src/types.js";
import { buildDispatchForest } from "../src/dispatch-view.js";

function job(
  id: string,
  input: Partial<DispatchJobRecord> = {}
): DispatchJobRecord {
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: `task-${id}`,
    brief: `Work for ${id}`,
    status: "running",
    dispatchedBy: "human:desktop",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    ...input,
  };
}

describe("dispatch forest", () => {
  it("projects explicit lineage, active limits, and work-only authority", () => {
    const forest = buildDispatchForest([
      job("root", {
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        delegationChildrenIssued: 2,
        delegationDescendantsIssued: 2,
        delegationBudgetReservedMs: 180_000,
        delegationBudgetConsumedMs: 120_000,
        maxDescendantWallMs: 4_800_000,
        maxWallMs: 600_000,
        delegationDeadline: "2026-07-16T00:10:00.000Z",
      }),
      job("child-a", {
        vendor: "codex",
        parentJobId: "root",
        rootJobId: "root",
        delegationDepth: 1,
        capabilityMode: "delegate",
      }),
      job("grandchild", {
        parentJobId: "child-a",
        rootJobId: "root",
        delegationDepth: 2,
        capabilityMode: "delegate",
        status: "queued",
      }),
    ]);

    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.children[0]?.children[0]?.id).toBe("grandchild");
    expect(forest.roots[0]?.children[0]?.authority).toBe("work only");
    expect(forest.missions).toHaveLength(1);
    expect(forest.summary).toMatchObject({
      active: 3,
      usedDepth: 2,
      maxDepth: 3,
      descendantsIssued: 2,
      maxDescendants: 8,
      reservedWallMs: 180_000,
      rootWallMs: 600_000,
      // S9: v2 pool + released-spend accounting. remaining = pool − reserved −
      // consumed = 4,800,000 − 180,000 − 120,000.
      descendantPoolMs: 4_800_000,
      consumedWallMs: 120_000,
      remainingWallMs: 4_500_000,
    });
  });

  it("S9: a v1 root (no pool) reports remaining 0 and a null pool, preserving v1 semantics", () => {
    const forest = buildDispatchForest([
      job("v1-root", {
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxTotalDescendants: 8,
        delegationBudgetReservedMs: 60_000,
        // No maxDescendantWallMs: this root predates the pool, so the pool falls
        // back to the root's own turn budget (v1 semantics preserved).
        maxWallMs: 600_000,
      }),
    ]);
    const summary = forest.missions[0]!.summary;
    // Pool falls back to the root's own turn budget (v1 semantics preserved).
    expect(summary.descendantPoolMs).toBe(600_000);
    expect(summary.remainingWallMs).toBe(540_000);
  });

  it("fails visibly when a child arrives without its parent", () => {
    const forest = buildDispatchForest([
      job("orphan", {
        parentJobId: "missing-parent",
        rootJobId: "missing-root",
        delegationDepth: 2,
        capabilityMode: "delegate",
      }),
    ]);

    expect(forest.degraded).toBe(true);
    expect(forest.degradationReason).toContain("lineage");
    expect(forest.roots[0]?.id).toBe("orphan");
  });

  it("keeps limits and depth scoped to each independent root", () => {
    const forest = buildDispatchForest([
      job("root-a", {
        capabilityMode: "orchestrator",
        maxDelegationDepth: 3,
        maxTotalDescendants: 8,
        delegationDescendantsIssued: 1,
      }),
      job("child-a", {
        parentJobId: "root-a",
        rootJobId: "root-a",
        delegationDepth: 1,
        capabilityMode: "delegate",
      }),
      job("root-b", {
        capabilityMode: "orchestrator",
        maxDelegationDepth: 1,
        maxTotalDescendants: 2,
        delegationDescendantsIssued: 0,
      }),
    ]);

    expect(forest.missions).toHaveLength(2);
    const byRoot = new Map(
      forest.missions.map((mission) => [mission.root.id, mission.summary])
    );
    expect(byRoot.get("root-a")).toMatchObject({
      usedDepth: 1,
      maxDepth: 3,
      descendantsIssued: 1,
      maxDescendants: 8,
    });
    expect(byRoot.get("root-b")).toMatchObject({
      usedDepth: 0,
      maxDepth: 1,
      descendantsIssued: 0,
      maxDescendants: 2,
    });
    expect(forest.summary.maxDepth).toBeNull();
    expect(forest.summary.maxDescendants).toBeNull();
  });
});
