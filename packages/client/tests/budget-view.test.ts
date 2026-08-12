import { describe, expect, it } from "vitest";
import type { DispatchBudget } from "../src/types.js";
import {
  buildBudgetLineView,
  compactBudgetDuration,
  pollFailBudgetLine,
  unknownBudgetLine,
} from "../src/budget-view.js";

function budget(overrides: Partial<DispatchBudget> = {}): DispatchBudget {
  return {
    jobId: "job-root",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 1_800_000,
    poolMs: 1_800_000,
    reservedMs: 300_000,
    consumedMs: 600_000,
    remainingMs: 900_000,
    deadlineAt: null,
    childrenIssued: 1,
    maxChildren: 3,
    descendantsIssued: 1,
    maxDescendants: 8,
    depth: 0,
    maxDepth: 3,
    children: [
      {
        jobId: "child-a",
        vendor: "codex",
        status: "running",
        depth: 1,
        reservedMs: 300_000,
        consumedMs: 120_000,
      },
    ],
    ...overrides,
  };
}

describe("compactBudgetDuration", () => {
  it("renders sub-minute spans in ceiling seconds", () => {
    expect(compactBudgetDuration(1_000)).toBe("1s");
    expect(compactBudgetDuration(59_999)).toBe("60s");
  });

  it("renders minute-plus spans in ceiling minutes", () => {
    expect(compactBudgetDuration(60_000)).toBe("1m");
    expect(compactBudgetDuration(90_000)).toBe("2m");
  });

  it("floors negative/garbage input at 0 rather than a signed label", () => {
    expect(compactBudgetDuration(-500)).toBe("0s");
  });
});

describe("buildBudgetLineView (ready)", () => {
  it("projects plain pool/reserved/consumed/remaining numbers, no free text", () => {
    const view = buildBudgetLineView(budget());
    expect(view.status).toBe("ready");
    expect(view.poolLabel).toBe("30m");
    expect(view.reservedLabel).toBe("5m");
    expect(view.consumedLabel).toBe("10m");
    expect(view.remainingLabel).toBe("15m");
    expect(view.summaryLabel).toContain("15m");
    expect(view.summaryLabel).toContain("30m");
  });

  it("projects the per-descendant breakdown from numbers/enums only", () => {
    const view = buildBudgetLineView(budget());
    expect(view.children).toEqual([
      {
        jobId: "child-a",
        vendor: "codex",
        status: "running",
        depth: 1,
        reservedLabel: "5m",
        consumedLabel: "2m",
      },
    ]);
  });

  it("an empty descendant list projects as an empty array, not undefined", () => {
    const view = buildBudgetLineView(budget({ children: [] }));
    expect(view.children).toEqual([]);
  });
});

describe("buildBudgetLineView (exhausted)", () => {
  it("a fully consumed pool is the sole needs-you state", () => {
    const view = buildBudgetLineView(
      budget({ remainingMs: 0, consumedMs: 1_800_000, reservedMs: 0 })
    );
    expect(view.status).toBe("exhausted");
    expect(view.remainingLabel).toBe("0s");
    expect(view.summaryLabel.toLowerCase()).toContain("exhausted");
  });

  it("an over-drawn pool (negative remaining) still floors at 0, never a signed number", () => {
    const view = buildBudgetLineView(budget({ remainingMs: -60_000 }));
    expect(view.status).toBe("exhausted");
    expect(view.remainingLabel).toBe("0s");
    expect(view.remainingLabel).not.toContain("-");
  });
});

describe("unknownBudgetLine", () => {
  it("renders placeholders, never a fabricated number, before any mission root resolves", () => {
    const view = unknownBudgetLine();
    expect(view.status).toBe("unknown");
    expect(view.poolLabel).toBe("—");
    expect(view.reservedLabel).toBe("—");
    expect(view.consumedLabel).toBe("—");
    expect(view.remainingLabel).toBe("—");
    expect(view.children).toEqual([]);
  });
});

describe("pollFailBudgetLine", () => {
  it("carries the failure detail and placeholders, never stale ready numbers", () => {
    const view = pollFailBudgetLine("control plane unreachable");
    expect(view.status).toBe("poll-fail");
    expect(view.detail).toBe("control plane unreachable");
    expect(view.poolLabel).toBe("—");
    expect(view.children).toEqual([]);
  });
});
