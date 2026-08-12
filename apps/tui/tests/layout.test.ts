import { describe, expect, it } from "vitest";
import {
  COLUMN_LAYOUT_MIN_WIDTH,
  DESK_LAYOUT_MIN_WIDTH,
  nextFocusZone,
  resolveLayoutMode,
  resolveRowBudget,
} from "../src/lib/layout.js";

describe("layout", () => {
  it("uses columns at or above the width threshold", () => {
    expect(resolveLayoutMode(COLUMN_LAYOUT_MIN_WIDTH)).toBe("columns");
    expect(resolveLayoutMode(DESK_LAYOUT_MIN_WIDTH - 1)).toBe("columns");
  });

  it("uses the five-seat desk when every lane stays legible", () => {
    expect(resolveLayoutMode(DESK_LAYOUT_MIN_WIDTH)).toBe("desk");
    expect(resolveLayoutMode(200)).toBe("desk");
  });

  it("falls back to side-panel on narrow terminals", () => {
    expect(resolveLayoutMode(COLUMN_LAYOUT_MIN_WIDTH - 1)).toBe("side-panel");
    expect(resolveLayoutMode(80)).toBe("side-panel");
  });

  it("cycles focus zones with Tab order", () => {
    expect(nextFocusZone("tasks", "next")).toBe("lanes");
    expect(nextFocusZone("lanes", "next")).toBe("approvals");
    expect(nextFocusZone("approvals", "next")).toBe("handoffs");
    expect(nextFocusZone("handoffs", "next")).toBe("tasks");
    expect(nextFocusZone("tasks", "prev")).toBe("handoffs");
  });
});

describe("resolveRowBudget", () => {
  // Side-panel structural chrome that resolveRowBudget does not cover:
  // Header(2) + Rule x3(3) + Diagnostics(2) + DispatchHero(3) + CommandBar(2)
  // + Footer(1). See Header.tsx, chrome.tsx, CockpitPanels.tsx, CommandBar.tsx,
  // Footer.tsx.
  const STRUCTURAL_CHROME = 13;
  // Every budgeted zone's own label/hint row that sits OUTSIDE its
  // maxRows-bounded list: FleetRail label(1) [+ hint(1) once not compact],
  // the fleet/task mission-budget row(1) (MissionBudgetLine, S9 TUI parity),
  // TaskLedger label(1), ChatPane label(1), ReviewInbox label+counts+hint(3),
  // HandoffsPanel label(1).
  const COMPACT_SHELL_OVERHEAD = 8; // fleet hint dropped in compact
  const STANDARD_SHELL_OVERHEAD = 9; // fleet hint shown once not compact

  function listRowSum(budget: ReturnType<typeof resolveRowBudget>): number {
    return (
      budget.agents + budget.tasks + budget.chat + budget.approvals + budget.handoffs
    );
  }

  it("fits chrome + budget inside an 80x24 terminal (compact floor)", () => {
    const budget = resolveRowBudget(24);
    expect(budget.profile).toBe("compact");
    expect(STRUCTURAL_CHROME + COMPACT_SHELL_OVERHEAD + listRowSum(budget)).toBeLessThanOrEqual(
      24
    );
  });

  it("fits chrome + budget inside a 30-row terminal (standard floor)", () => {
    const budget = resolveRowBudget(30);
    expect(budget.profile).toBe("standard");
    expect(STRUCTURAL_CHROME + STANDARD_SHELL_OVERHEAD + listRowSum(budget)).toBeLessThanOrEqual(
      30
    );
  });

  it("still fits at the top of each profile's height bucket", () => {
    expect(
      STRUCTURAL_CHROME + COMPACT_SHELL_OVERHEAD + listRowSum(resolveRowBudget(26))
    ).toBeLessThanOrEqual(26);
    expect(
      STRUCTURAL_CHROME + STANDARD_SHELL_OVERHEAD + listRowSum(resolveRowBudget(34))
    ).toBeLessThanOrEqual(34);
  });

  it("shrank compact/standard budgets well below the pre-fix values that overshot the terminal", () => {
    // Pre-fix: compact 3/6/10/1/1 (sum 21), standard 5/10/12/2/2 (sum 31).
    expect(listRowSum(resolveRowBudget(24))).toBeLessThan(21);
    expect(listRowSum(resolveRowBudget(30))).toBeLessThan(31);
  });

  it("never lets chat's maxRows hit 0 (Array.prototype.slice(-0) returns the FULL array, not none)", () => {
    expect(resolveRowBudget(24).chat).toBeGreaterThan(0);
    expect(resolveRowBudget(30).chat).toBeGreaterThan(0);
  });

  it("leaves the tall profile untouched", () => {
    expect(resolveRowBudget(35)).toEqual({
      profile: "tall",
      agents: 9,
      tasks: 16,
      chat: 18,
      approvals: 4,
      handoffs: 8,
    });
  });
});
