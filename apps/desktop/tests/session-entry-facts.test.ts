import { describe, expect, it } from "vitest";
import { buildSessionEntryFacts } from "../src/renderer/lib/session-entry-facts.js";
import type { BudgetLineView } from "@muon/client/budget-view";

describe("buildSessionEntryFacts", () => {
  it("names pending gates and never invents a finding", () => {
    const facts = buildSessionEntryFacts({
      approvals: [{ id: "a1" }, { id: "a2" }] as never[],
    });
    expect(facts.map((f) => f.id)).toEqual(["gate"]);
    expect(facts[0]?.label).toBe("2 gates waiting");
    expect(facts[0]?.tone).toBe("warn");
  });

  it("reports ready when no gates and shows budget when known", () => {
    const budget: BudgetLineView = {
      status: "ready",
      summaryLabel: "15m left of 30m pool",
      poolLabel: "30m",
      reservedLabel: "0",
      consumedLabel: "15m",
      remainingLabel: "15m",
      children: [],
    };
    const facts = buildSessionEntryFacts({
      approvals: [],
      missionBudget: budget,
    });
    expect(facts).toEqual([
      { id: "gate", label: "No pending gates", tone: "ready" },
      { id: "budget", label: "15m left of 30m pool", tone: "neutral" },
    ]);
  });

  it("omits unknown budget and includes a real finding summary", () => {
    const facts = buildSessionEntryFacts({
      approvals: [],
      missionBudget: {
        status: "unknown",
        summaryLabel: "no active mission",
        poolLabel: "—",
        reservedLabel: "—",
        consumedLabel: "—",
        remainingLabel: "—",
        children: [],
      },
      lastFindingSummary: "Peer published linked finding on auth",
    });
    expect(facts.map((f) => f.id)).toEqual(["gate", "finding"]);
    expect(facts[1]?.label).toContain("auth");
  });
});
