import { describe, expect, it } from "vitest";
import { rankLanes } from "../src/routing.js";
import type { LaneOutcomeStats } from "../src/types.js";

function lane(overrides: Partial<LaneOutcomeStats>): LaneOutcomeStats {
  return {
    laneId: "lane-x",
    laneKey: "x",
    laneName: "X",
    assignments: 0,
    completions: 0,
    blocked: 0,
    averageDurationMs: null,
    lastActivityAt: null,
    ...overrides,
  };
}

describe("rankLanes", () => {
  it("ranks lanes with more completions higher", () => {
    const result = rankLanes([
      lane({ laneId: "a", laneName: "A", assignments: 4, completions: 1 }),
      lane({ laneId: "b", laneName: "B", assignments: 4, completions: 4 }),
    ]);
    expect(result[0]?.laneId).toBe("b");
  });

  it("penalizes blocked runs", () => {
    const result = rankLanes([
      lane({ laneId: "a", laneName: "A", assignments: 3, completions: 2, blocked: 3 }),
      lane({ laneId: "b", laneName: "B", assignments: 3, completions: 2, blocked: 0 }),
    ]);
    expect(result[0]?.laneId).toBe("b");
  });

  it("always includes a human-readable reason", () => {
    const result = rankLanes([
      lane({ laneId: "a", laneName: "A" }),
      lane({
        laneId: "b",
        laneName: "B",
        assignments: 2,
        completions: 1,
        blocked: 1,
        averageDurationMs: 42_000,
      }),
    ]);
    const idle = result.find((s) => s.laneId === "a");
    const busy = result.find((s) => s.laneId === "b");
    expect(idle?.reason).toContain("no history");
    expect(busy?.reason).toContain("1/2 assignments completed");
    expect(busy?.reason).toContain("blocked");
    expect(busy?.reason).toContain("avg 42s");
  });

  it("keeps deterministic order for ties", () => {
    const result = rankLanes([
      lane({ laneId: "b", laneName: "Bravo" }),
      lane({ laneId: "a", laneName: "Alpha" }),
    ]);
    expect(result.map((s) => s.laneName)).toEqual(["Alpha", "Bravo"]);
  });

  it("boosts topic overlap with a hard cap so it cannot outrank outcomes", () => {
    const base = lane({ assignments: 1, completions: 1 });
    const [without] = rankLanes([base]);
    const [withTopics] = rankLanes([{ ...base, topicMatches: 2 }]);
    const [capped] = rankLanes([{ ...base, topicMatches: 10 }]);

    expect(withTopics.score).toBeCloseTo(without.score + 1.5, 3);
    expect(withTopics.reason).toContain("2 memory topic(s) match the request");
    expect(capped.score).toBeCloseTo(without.score + 3, 3);
  });
});
