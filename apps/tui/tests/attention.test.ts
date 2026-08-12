import { describe, expect, it } from "vitest";
import type { CrewLiveness } from "@muon/client/crew-liveness";
import {
  ATTENTION_PRIORITY,
  attentionPriority,
  countWantsOperator,
  isSeenClearable,
  resolveAttentionState,
  rollUpAttention,
  sortByAttention,
  wantsOperator,
  type AttentionState,
} from "../src/lib/attention.js";

// ADR-0032 D3/D4. The load-bearing assertion in this file is the seen-gating
// one: looking at a lane must never make a pending gate look answered.

const ALL_STATES: AttentionState[] = [
  "blocked",
  "failed",
  "warning",
  "done",
  "working",
  "idle",
  "unknown",
];

const ALL_LIVENESS: CrewLiveness[] = [
  "queued",
  "launching",
  "stalled",
  "waiting-approval",
  "live",
  "progressing",
  "budget-low",
  "done",
  "needs-attention",
];

describe("ADR-0032 D3 — seen-gating", () => {
  it("clears ONLY `done`, checked exhaustively over every state", () => {
    // Written as a total table rather than `expect(isSeenClearable("done"))`,
    // so a state added later cannot join the clearable set by omission.
    const clearable = ALL_STATES.filter(isSeenClearable);
    expect(clearable).toEqual(["done"]);
  });

  it("a lane waiting on a gate stays blocked no matter how often it is seen", () => {
    expect(resolveAttentionState("waiting-approval", false)).toBe("blocked");
    expect(resolveAttentionState("waiting-approval", true)).toBe("blocked");
  });

  it("a failed lane stays failed once seen (parity with the desktop pane fold)", () => {
    expect(resolveAttentionState("needs-attention", false)).toBe("failed");
    expect(resolveAttentionState("needs-attention", true)).toBe("failed");
  });

  it("done decays to idle once seen — the one intended transition", () => {
    expect(resolveAttentionState("done", false)).toBe("done");
    expect(resolveAttentionState("done", true)).toBe("idle");
  });

  it("seen never changes any state other than done", () => {
    for (const liveness of ALL_LIVENESS) {
      const unseen = resolveAttentionState(liveness, false);
      const seen = resolveAttentionState(liveness, true);
      if (liveness === "done") continue;
      expect(seen, `${liveness} changed under seen`).toBe(unseen);
    }
  });

  it("absent liveness is unknown, not idle", () => {
    expect(resolveAttentionState(null, false)).toBe("unknown");
    expect(resolveAttentionState(undefined, true)).toBe("unknown");
  });
});

describe("ADR-0032 D3 — the liveness fold is total", () => {
  it("maps all nine CrewLiveness states to a real attention state", () => {
    for (const liveness of ALL_LIVENESS) {
      expect(ALL_STATES).toContain(resolveAttentionState(liveness, false));
    }
  });

  it("keeps the two amber signals distinct from plain working", () => {
    // Collapsing these into "working" would discard the early warning the
    // original desktop hang lacked.
    expect(resolveAttentionState("stalled", false)).toBe("warning");
    expect(resolveAttentionState("budget-low", false)).toBe("warning");
    expect(resolveAttentionState("live", false)).toBe("working");
    expect(resolveAttentionState("progressing", false)).toBe("working");
  });
});

describe("ADR-0032 D4 — ordering", () => {
  it("ranks blocked > failed > warning > done > working > idle > unknown", () => {
    const ordered = [...ALL_STATES].sort(
      (a, b) => attentionPriority(b) - attentionPriority(a)
    );
    expect(ordered).toEqual([
      "blocked",
      "failed",
      "warning",
      "done",
      "working",
      "idle",
      "unknown",
    ]);
  });

  it("gives every state a distinct priority (no accidental ties)", () => {
    const values = Object.values(ATTENTION_PRIORITY);
    expect(new Set(values).size).toBe(values.length);
  });

  it("puts a blocked lane first even when it arrived last", () => {
    const rows: { id: string; state: AttentionState }[] = [
      { id: "a", state: "working" },
      { id: "b", state: "done" },
      { id: "c", state: "blocked" },
    ];
    expect(sortByAttention(rows, (r) => r.state).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("is stable within a priority, so a poll refresh does not shuffle the rail", () => {
    const rows: { id: string; state: AttentionState }[] = [
      { id: "first", state: "working" },
      { id: "second", state: "working" },
      { id: "third", state: "working" },
    ];
    expect(sortByAttention(rows, (r) => r.state).map((r) => r.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("ADR-0032 D4 — parent rollup", () => {
  it("a workspace reports its most-demanding child", () => {
    expect(rollUpAttention(["working", "blocked", "idle"])).toBe("blocked");
    expect(rollUpAttention(["idle", "done"])).toBe("done");
    expect(rollUpAttention(["working", "warning"])).toBe("warning");
  });

  it("an empty crew is unknown, never idle", () => {
    // "nothing here" and "everything here finished" are different facts.
    expect(rollUpAttention([])).toBe("unknown");
  });

  it("never reports less than a blocked child, whatever else is present", () => {
    for (const other of ALL_STATES) {
      expect(rollUpAttention([other, "blocked"])).toBe("blocked");
    }
  });
});

describe("the NEEDS YOU scalar", () => {
  it("counts blocked, failed and done — the states that want a person", () => {
    expect(wantsOperator("blocked")).toBe(true);
    expect(wantsOperator("failed")).toBe(true);
    expect(wantsOperator("done")).toBe(true);
    expect(wantsOperator("warning")).toBe(false);
    expect(wantsOperator("working")).toBe(false);
    expect(wantsOperator("idle")).toBe(false);
    expect(wantsOperator("unknown")).toBe(false);
  });

  it("counts across a fleet", () => {
    expect(
      countWantsOperator(["blocked", "working", "done", "idle", "failed"])
    ).toBe(3);
    expect(countWantsOperator([])).toBe(0);
  });
});
