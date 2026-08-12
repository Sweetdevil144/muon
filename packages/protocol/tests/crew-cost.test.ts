import { describe, expect, it } from "vitest";
import {
  buildMissionReceipt,
  capRefusesDispatch,
  describeCapVerdict,
  describeMissionCost,
  describeReceipt,
  evaluateCap,
  laneCostsFromUsageEvents,
  summarizeMissionCost,
  type LaneCost,
  UNNAMEABLE_LANE,
} from "../src/crew-cost.js";
import { residualDanger } from "../src/evasion-corpus.js";

// ADR-0036. The assertions that matter are the honesty ones: a mission total is
// a LOWER BOUND because a third of the crew may report no dollars at all, and a
// number presented as "the" cost invites exactly the confident wrong decision
// T6 exists to prevent.

const reporting = (laneId: string, usd: number): LaneCost => ({
  laneId,
  reported: true,
  usd,
});
const silent = (laneId: string): LaneCost => ({ laneId, reported: false });

describe("a non-reporting lane is unknown, never zero", () => {
  it("excludes it from the sum AND from the reporting count", () => {
    const cost = summarizeMissionCost([
      reporting("claude-1", 1.5),
      silent("codex-1"),
    ]);
    expect(cost.observedUsd).toBe(1.5);
    expect(cost.reportingLanes).toBe(1);
    expect(cost.totalLanes).toBe(2);
    expect(cost.complete).toBe(false);
  });

  it("is complete only when EVERY lane reported", () => {
    expect(
      summarizeMissionCost([reporting("a", 1), reporting("b", 2)]).complete
    ).toBe(true);
    expect(
      summarizeMissionCost([reporting("a", 1), silent("b")]).complete
    ).toBe(false);
    // No lanes at all is not "complete" — there is nothing to be complete about.
    expect(summarizeMissionCost([]).complete).toBe(false);
  });

  it("does not SHOW float noise as money", () => {
    // This used to assert `observedUsd === 0.3`, which required rounding the
    // stored total to cents — and `evaluateCap` compares that same field, so
    // the rounding quietly weakened the cap (see the precision block below).
    // The concern was always about what a human READS, so it is asserted where
    // the figure becomes money.
    const cost = summarizeMissionCost([
      reporting("a", 0.1),
      reporting("b", 0.2),
    ]);
    expect(describeMissionCost(cost)).toContain("$0.30");
    expect(cost.observedUsd, "the enforcement input stays exact").toBeCloseTo(0.3, 10);
  });
});

describe("the rendering carries its own caveat", () => {
  it("marks an incomplete total with ≥ and the coverage", () => {
    const line = describeMissionCost(
      summarizeMissionCost([reporting("a", 4.2), silent("b"), silent("c")])
    );
    expect(line).toContain("≥ $4.20");
    expect(line).toContain("1 of 3 lanes reporting");
  });

  it("drops the ≥ only when every lane reported", () => {
    const line = describeMissionCost(
      summarizeMissionCost([reporting("a", 4.2), reporting("b", 1)])
    );
    expect(line).not.toContain("≥");
    expect(line).toContain("all 2 lanes reporting");
  });

  it("says cost is UNKNOWN when nothing reports, rather than showing $0.00", () => {
    // The lie this whole module exists to prevent: $0.00 reads as free.
    const line = describeMissionCost(
      summarizeMissionCost([silent("a"), silent("b")])
    );
    expect(line).toContain("unknown");
    expect(line).not.toContain("$0.00");
  });

  it("handles a mission with no lanes yet", () => {
    expect(describeMissionCost(summarizeMissionCost([]))).toBe("no lanes yet");
  });
});

describe("ADR-0036 D2/D3 — what a cap does", () => {
  it("passes below the cap and refuses at or above it", () => {
    const under = evaluateCap(summarizeMissionCost([reporting("a", 4)]), 10);
    expect(under?.kind).toBe("within");
    expect(capRefusesDispatch(under)).toBe(false);

    const at = evaluateCap(summarizeMissionCost([reporting("a", 10)]), 10);
    expect(at?.kind).toBe("exceeded");
    expect(capRefusesDispatch(at)).toBe(true);

    const over = evaluateCap(summarizeMissionCost([reporting("a", 11)]), 10);
    expect(capRefusesDispatch(over)).toBe(true);
  });

  it("is UNENFORCEABLE — not 'within' — when nothing reports", () => {
    // Saying a cap holds when nothing can measure it is the exact lie the
    // verdict type exists to prevent.
    const verdict = evaluateCap(
      summarizeMissionCost([silent("a"), silent("b")]),
      5
    );
    expect(verdict?.kind).toBe("unenforceable");
    expect(verdict).not.toMatchObject({ kind: "within" });
  });

  it("does NOT refuse dispatch on an unenforceable cap", () => {
    // MUON cannot see what those lanes cost; stopping a mission for a number
    // nobody has would be worse than letting the wall-clock budget bound it.
    const verdict = evaluateCap(summarizeMissionCost([silent("a")]), 5);
    expect(capRefusesDispatch(verdict)).toBe(false);
  });

  it("distinguishes 'no cap set' from 'a cap that passes'", () => {
    for (const capUsd of [null, undefined, Number.NaN, Infinity]) {
      expect(
        evaluateCap(summarizeMissionCost([reporting("a", 1)]), capUsd as number),
        String(capUsd)
      ).toBeNull();
    }
    expect(capRefusesDispatch(null)).toBe(false);
  });

  it("a partial-coverage pass is NOT a clean pass, and cannot be mistaken for one", () => {
    // THE DEFECT THIS SPLIT FIXES. Before it, a three-lane crew where one lane
    // reported returned {kind:"within", observedUsd:4, capUsd:10} — byte-
    // identical to a fully measured mission that really did spend $4 of $10.
    // The two silent lanes could have spent anything. D3 decided a cap over a
    // non-reporting lane is "unavailable, not unlimited"; the type now says so.
    const partial = evaluateCap(
      summarizeMissionCost([reporting("a", 4), silent("b"), silent("c")]),
      10
    );
    expect(partial?.kind).toBe("within-partial");
    const complete = evaluateCap(
      summarizeMissionCost([reporting("a", 4), reporting("b", 0)]),
      10
    );
    expect(complete?.kind).toBe("within");
    // The two must not be interchangeable to a caller switching on kind.
    expect(partial?.kind).not.toBe(complete?.kind);
  });

  it("permits partial coverage but never renders it quietly", () => {
    // Permissive for the same reason `unenforceable` is: refusing on a number
    // nobody has stops work for nothing. Loud, though — and it names lanes.
    const verdict = evaluateCap(
      summarizeMissionCost([reporting("a", 4), silent("b")]),
      10
    );
    expect(capRefusesDispatch(verdict)).toBe(false);
    const line = describeCapVerdict(verdict, ["b"]);
    expect(line).toContain("CANNOT be enforced");
    expect(line).toContain("b");
    // A bare "within cap" reading must be impossible to produce from it.
    expect(line).not.toMatch(/^\$4\.00 of \$10\.00 \(all/);
  });

  it("every verdict renders its own coverage — none can be shown bare", () => {
    const cases = [
      evaluateCap(summarizeMissionCost([reporting("a", 4)]), 10),
      evaluateCap(summarizeMissionCost([reporting("a", 4), silent("b")]), 10),
      evaluateCap(summarizeMissionCost([reporting("a", 40), silent("b")]), 10),
      evaluateCap(summarizeMissionCost([silent("a")]), 10),
    ];
    for (const verdict of cases) {
      const line = describeCapVerdict(verdict);
      expect(line, verdict?.kind).toMatch(/lanes?/);
    }
    expect(describeCapVerdict(null)).toBe("no cap set");
  });

  it("names silent lanes but bounds the list, so the decision stays readable", () => {
    const verdict = evaluateCap(
      summarizeMissionCost([reporting("a", 1), silent("b")]),
      10
    );
    const line = describeCapVerdict(verdict, ["b", "c", "d", "e", "f"]);
    expect(line).toContain("b, c, d");
    expect(line).toContain("+2 more");
    expect(line).not.toContain("e,");
  });

  it("still refuses when only SOME lanes report and the floor already passed", () => {
    // The floor is enough to refuse on: what is invisible can only add.
    const verdict = evaluateCap(
      summarizeMissionCost([reporting("a", 12), silent("b")]),
      10
    );
    expect(verdict?.kind).toBe("exceeded");
    expect(capRefusesDispatch(verdict)).toBe(true);
  });
});

describe("ADR-0036 D5 — the receipt states its own coverage", () => {
  it("names the lanes that gave no cost signal instead of omitting them", () => {
    const receipt = buildMissionReceipt({
      lanes: [reporting("claude-1", 3), silent("codex-1"), silent("cursor-1")],
      wallMsConsumed: 90_000,
      crewSize: 3,
    });
    expect(receipt.nonReportingLanes).toEqual(["codex-1", "cursor-1"]);
    const line = describeReceipt(receipt);
    expect(line).toContain("≥ $3.00");
    expect(line).toContain("crew 3");
    expect(line).toContain("90s");
    expect(line).toContain("no cost signal from: codex-1, cursor-1");
  });

  it("records crew size, because 'was the fan-out worth it' needs the fan-out", () => {
    const receipt = buildMissionReceipt({
      lanes: [reporting("a", 1)],
      wallMsConsumed: 1000,
      crewSize: 5,
    });
    expect(receipt.crewSize).toBe(5);
  });

  it("claims no counterfactual — there is no 'saved' field to fill in", () => {
    // MUON does not know what one lane would have cost. P12 made the same
    // call and this keeps it.
    const receipt = buildMissionReceipt({
      lanes: [reporting("a", 1)],
      wallMsConsumed: 1000,
      crewSize: 3,
    });
    const keys = Object.keys(receipt);
    expect(keys).not.toContain("saved");
    expect(keys).not.toContain("counterfactual");
    expect(keys).not.toContain("estimated");
    expect(JSON.stringify(receipt)).not.toMatch(/estimat|saved|would have/i);
  });

  it("omits the trailing clause when every lane reported", () => {
    const receipt = buildMissionReceipt({
      lanes: [reporting("a", 1), reporting("b", 2)],
      wallMsConsumed: 5000,
      crewSize: 2,
    });
    expect(describeReceipt(receipt)).not.toContain("no cost signal");
  });
});

describe("no inference anywhere", () => {
  it("has no API that accepts tokens or a price", () => {
    // A tokens×price path is the one change that would make every number here
    // indistinguishable from a real one. There is deliberately nowhere to put
    // it: LaneCost carries dollars or nothing.
    const lane: LaneCost = silent("codex-1");
    expect(Object.keys(lane).sort()).toEqual(["laneId", "reported"]);
    const reported: LaneCost = reporting("claude-1", 1);
    expect(Object.keys(reported).sort()).toEqual(["laneId", "reported", "usd"]);
  });
});

describe("the verdict renders stored lane ids safely", () => {
  it("flattens a hostile lane id instead of emitting it verbatim", () => {
    // Review of PR #36. `silentLanes` is caller-supplied stored text joined
    // straight into a terminal-facing string — the one path in this file with
    // no flattening while everything around it had some.
    const RLO = String.fromCodePoint(0x202e);
    const ESC = String.fromCodePoint(0x1b);
    const verdict = evaluateCap(
      summarizeMissionCost([reporting("a", 1), silent("b")]),
      10
    );
    const line = describeCapVerdict(verdict, [`lane${RLO}evil`, `${ESC}[32mok`]);
    expect(residualDanger(line, [])).toEqual([]);
    expect(line).not.toContain(RLO);
    expect(line).not.toContain(ESC);
    // Flattened, not censored — the readable part of the id survives.
    expect(line).toContain("lane");
  });

  it("a lane that flattens to nothing is REPORTED, never dropped", () => {
    // The bug this replaces a vacuous test with. `flattenDangerous(...).trim()`
    // turned an all-zero-width lane id into "", so the rendered list read
    // ": , ok" — one fewer lane than exist, silently, on the exact surface D3
    // requires to NAME the lanes it cannot enforce against.
    const verdict = evaluateCap(
      summarizeMissionCost([reporting("a", 1), silent("b")]),
      10
    );
    const line = describeCapVerdict(verdict, ["\u200b\u200b", "ok"]);
    expect(line).toContain(UNNAMEABLE_LANE);
    expect(line).not.toContain(": , ok");
    // Still two lanes named, not one.
    expect(line.split(",").length).toBeGreaterThanOrEqual(2);
  });
});

describe("a cap is compared at full precision, not at display precision", () => {
  /**
   * `summarizeMissionCost` used to round the observed total to cents, and
   * `evaluateCap` compares that same field. Spend of $1.004 against a $1.003
   * cap therefore rounded to $1.00, compared UNDER, and admitted more work
   * while already over budget.
   *
   * A brake may be imprecise. It may not round in the direction of letting you
   * through — see ADR-0036 D6, where a floor-tested cap was accepted as sound
   * and incomplete precisely because it never brakes EARLY.
   */
  const lane = (usd: number): LaneCost => ({ laneId: "a", usd, reported: true });

  it("catches spend that exceeds a sub-cent cap", () => {
    const cost = summarizeMissionCost([lane(1.004)]);
    expect(evaluateCap(cost, 1.003)?.kind).toBe("exceeded");
  });

  it("still passes genuine under-spend", () => {
    const cost = summarizeMissionCost([lane(1.002)]);
    expect(evaluateCap(cost, 1.003)?.kind).not.toBe("exceeded");
  });

  it("but MONEY is still rendered in cents", () => {
    // Precision is for the comparison; a human reads dollars.
    const cost = summarizeMissionCost([lane(0.1), lane(0.2)]);
    expect(describeMissionCost(cost)).toContain("$0.30");
  });
});

describe("a lane MUON cannot fully read is not 'reported'", () => {
  /**
   * A malformed usage record was skipped and the lane still counted as
   * reporting. The mission total was therefore an undercount that PRESENTED as
   * complete, and `evaluateCap` compared a cap against a figure it believed
   * covered everything — the same failure direction as rounding the total
   * down: the brake reads low and lets more work through.
   */
  const usage = (vendor: string, costUsd: unknown) => ({
    laneId: vendor,
    metadata: { usage: { vendor, costUsd } },
  });

  it.each([["not-a-number"], [Number.NaN], [Number.POSITIVE_INFINITY], [-5], [null]])(
    "marks the lane unreported when a record carries %p",
    (bad) => {
      const lanes = laneCostsFromUsageEvents(
        [usage("claude", 4), usage("claude", bad)],
        ["claude"]
      );
      expect(lanes[0]!.reported, "one unreadable record taints the lane").toBe(false);
    }
  );

  it("so the CAP says it cannot be enforced, rather than enforcing on a gap", () => {
    const lanes = laneCostsFromUsageEvents(
      [usage("claude", 4), usage("claude", "oops")],
      ["claude"]
    );
    const verdict = evaluateCap(summarizeMissionCost(lanes), 10);
    expect(verdict?.kind).toBe("unenforceable");
    // And it does not stop the mission on a number nobody has.
    expect(capRefusesDispatch(verdict)).toBe(false);
  });

  it("a clean lane is unaffected", () => {
    const lanes = laneCostsFromUsageEvents(
      [usage("claude", 4), usage("claude", 1.5)],
      ["claude"]
    );
    expect(lanes[0]).toMatchObject({ reported: true, usd: 5.5 });
  });

  it("one bad lane does not taint its SIBLINGS", () => {
    const lanes = laneCostsFromUsageEvents(
      [usage("claude", 4), usage("codex", "oops"), usage("codex", 2)],
      ["claude", "codex"]
    );
    expect(lanes.find((l) => l.laneId === "claude")!.reported).toBe(true);
    expect(lanes.find((l) => l.laneId === "codex")!.reported).toBe(false);
  });
});
