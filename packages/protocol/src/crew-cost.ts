/**
 * WIRING STATUS, stated precisely because this file spent a release claiming
 * more than it did.
 *
 * INGESTED AND RENDERED (2026-08-08). `summarizeMissionCost` /
 * `describeMissionCost` have a real consumer: the run bundle derives per-lane
 * spend from the EVENT SPINE (`metadata.usage.costUsd`) and `muon bundle`
 * prints the figure where a human closes a mission. CORRECTED: this note used
 * to say that field was "emitted by the claude and codex session drivers".
 * Only Claude's is — `costUsd` is set in exactly one place
 * (`packages/adapters/src/token-usage.ts:60`, reading `total_cost_usd` from a
 * Claude result message), and the paragraph below this one always said so.
 * A file that contradicts itself about which vendors report money is how a
 * partial figure gets read as a total. No migration was needed — the note that
 * used to sit here said one was, and it was wrong: the cost was already on the
 * spine, so it is derived on read exactly like ADR-0043's questions.
 *
 * THE CAP IS WIRED TOO, as of 2026-08-09. It stayed test-only until the design
 * question this module could not settle for itself was answered — *a cap
 * tested against a FLOOR refuses a mission on a number that covers only the
 * lanes that report, so in a mixed crew it is neither a real ceiling nor an
 * honest one* — and ADR-0036 D6 now answers it:
 *
 *   A refusal is NEVER wrong. Observed spend is a lower bound, so
 *   `observed >= cap` implies `actual >= cap` with certainty; the cap cannot
 *   stop a mission that has in fact spent less. A NON-refusal is not a
 *   promise: unreported lanes may already have passed the cap, which is D1's
 *   coverage gap and is named on every surface by `within-partial` /
 *   `unenforceable`.
 *
 * So it is sound and incomplete — a BRAKE that never brakes early, not a
 * ceiling. `capRefusesDispatch` returns true for `exceeded` alone, and
 * `OrchestratorChat.costCapUsd` is where the number lives (D7: the chat, not
 * the root job, because a chat mints a new root every turn and a cap that
 * forgets is not a cap).
 */

/**
 * ADR-0036 — crew economics, and the honesty that makes them usable.
 *
 * Stance test T6 asks "what did this crew cost, and was the fan-out worth it?".
 * The field notes answer it today with "I have no idea" — some agents consumed
 * 300k–470k tokens and there was no dollar figure anywhere, so a runaway lane
 * could not be stopped on cost grounds.
 *
 * The constraint that shapes every function here: **cost is vendor-reported or
 * unknown.** Claude's result messages carry `total_cost_usd`; Codex reports
 * tokens and no dollars; Cursor reports nothing. `token-usage.ts` already
 * refuses to guess from token counts, and this module refuses at the mission
 * level for the same reason — a number that mixes a reported figure with a
 * tokens×price estimate is indistinguishable from a real one downstream, and
 * drifts silently the day a vendor changes pricing.
 *
 * So a mission total is a LOWER BOUND, and the type makes that unavoidable:
 * there is no field called `total`, only `observedUsd` beside the coverage that
 * qualifies it. A caller cannot render the number without having the count in
 * hand.
 */

import { flattenDangerous } from "./evasion-corpus.js";

/** One lane's contribution. `reported: false` means unknown, never zero. */
export type LaneCost =
  | { readonly laneId: string; readonly reported: true; readonly usd: number }
  | { readonly laneId: string; readonly reported: false };

export type MissionCost = {
  /** Sum over REPORTING lanes only. Never a total; always a floor. */
  readonly observedUsd: number;
  readonly reportingLanes: number;
  readonly totalLanes: number;
  /** True when every lane reported — the only case the floor is also the total. */
  readonly complete: boolean;
};

/** One event off the spine, as much of it as cost derivation looks at. */
export type UsageBearingEvent = {
  readonly laneId?: string | null;
  readonly metadata?: unknown;
};

/**
 * Derive per-lane spend from the EVENT SPINE — the one place that reads
 * `metadata.usage.costUsd`.
 *
 * Extracted from the run bundle on 2026-08-09 when the cap gained an admission
 * call site, because the two would otherwise each own a copy of "what did this
 * mission cost" and the copies would decide differently the first time either
 * was touched. A cap that refuses on one arithmetic while the receipt shows
 * another is worse than no cap.
 *
 * The honesty rules are structural, not conventions:
 *
 *  - `missionLanes` is EVERY lane the mission actually ran, so a silent vendor
 *    lands in the denominator as `reported: false` rather than vanishing from
 *    it. Omitting it would turn a partial figure into a complete-looking one.
 *  - a non-finite or negative `costUsd` is skipped, never coerced. A vendor
 *    that reports garbage makes its lane unreported, not free.
 */
export function laneCostsFromUsageEvents(
  events: readonly UsageBearingEvent[],
  missionLanes: readonly string[]
): LaneCost[] {
  const byLane = new Map<string, number>();
  /**
   * Lanes that emitted a usage record MUON could not read.
   *
   * Skipping a malformed record and still calling the lane "reported" makes
   * the mission total an undercount that PRESENTS as complete — and
   * `evaluateCap` then compares a cap against a number it believes covers
   * everything. Same failure direction as rounding the total down: the brake
   * reads low and lets more work through.
   *
   * A lane MUON cannot fully read is `reported: false`, which is the state the
   * type already has for exactly this meaning — the cap becomes
   * `unenforceable` or `within-partial` and says so, instead of quietly
   * enforcing against a figure that is missing spend.
   */
  const unreadable = new Set<string>();
  for (const event of events) {
    const usage = (event.metadata as { usage?: unknown } | null)?.usage;
    if (!usage || typeof usage !== "object") continue;
    const record = usage as { vendor?: unknown; costUsd?: unknown };
    const lane =
      typeof record.vendor === "string" && record.vendor.length > 0
        ? record.vendor
        : event.laneId;
    if (!lane) continue;
    const cost = record.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      unreadable.add(lane);
      continue;
    }
    byLane.set(lane, (byLane.get(lane) ?? 0) + cost);
  }
  return missionLanes.map((lane) =>
    byLane.has(lane) && !unreadable.has(lane)
      ? { laneId: lane, reported: true, usd: byLane.get(lane)! }
      : { laneId: lane, reported: false }
  );
}

export function summarizeMissionCost(
  lanes: readonly LaneCost[]
): MissionCost {
  let observedUsd = 0;
  let reportingLanes = 0;
  for (const lane of lanes) {
    if (lane.reported) {
      observedUsd += lane.usd;
      reportingLanes += 1;
    }
  }
  return {
    // FULL PRECISION, deliberately. This used to round to cents here, and
    // `evaluateCap` reads the same field — so $1.004 of observed spend against
    // a $1.003 cap rounded down to $1.00, compared under, and admitted more
    // work while already over budget. A brake must not round in the direction
    // of letting you through. Rounding is a RENDERING concern and belongs in
    // `describeMissionCost`, which is the one place a figure becomes money a
    // human reads.
    observedUsd,
    reportingLanes,
    totalLanes: lanes.length,
    complete: lanes.length > 0 && reportingLanes === lanes.length,
  };
}

/**
 * The one rendering. Every surface uses it so no surface can accidentally show
 * a bare number: the `≥` and the coverage travel with the figure.
 */
export function describeMissionCost(cost: MissionCost): string {
  if (cost.totalLanes === 0) return "no lanes yet";
  if (cost.reportingLanes === 0) {
    return `cost unknown (0 of ${cost.totalLanes} lanes report dollars)`;
  }
  const money = `$${cost.observedUsd.toFixed(2)}`;
  if (cost.complete) return `${money} (all ${cost.totalLanes} lanes reporting)`;
  return `≥ ${money} (${cost.reportingLanes} of ${cost.totalLanes} lanes reporting)`;
}

/**
 * What a cap decision can be. `unenforceable` is a first-class answer, and so
 * is `within-partial`.
 *
 * THE SPLIT IS THE POINT. D3 decided that a cap over a non-reporting lane is
 * `unavailable`, not `unlimited`, and that the surface must say so "naming
 * them" — but the verdict used to return a bare `within` whenever ANY lane
 * reported. A three-lane crew where only one reports dollars produced
 * `{kind:"within", observedUsd: 4, capUsd: 10}`, byte-identical to a fully
 * measured mission that genuinely spent $4 of $10. The other two could have
 * spent anything.
 *
 * That is not a rendering bug to fix at each surface — it is an unsafe reading
 * the TYPE allowed, so the type stops allowing it. A caller switching on
 * `kind` must now handle partial coverage explicitly, the same fail-closed-by-
 * vocabulary move as the UNKNOWN approval risk tier. Every non-null verdict
 * carries its coverage for the same reason `MissionCost` has no field called
 * `total`: you cannot get the number without the caveat.
 *
 * Only ONE vendor reports dollars today (`extractClaudeTokenUsage` reads
 * Claude's `total_cost_usd`; nothing else emits `costUsd`), so in any mixed
 * crew partial coverage is the NORMAL case, not the edge case.
 */
export type CapVerdict =
  /** Below the cap, and every lane reported — the only clean pass. */
  | {
      readonly kind: "within";
      readonly observedUsd: number;
      readonly capUsd: number;
      readonly totalLanes: number;
    }
  /**
   * Below the cap on the lanes that report, while others cannot be measured
   * at all. Permissive (see `capRefusesDispatch`) but never quiet.
   */
  | {
      readonly kind: "within-partial";
      readonly observedUsd: number;
      readonly capUsd: number;
      readonly reportingLanes: number;
      readonly totalLanes: number;
    }
  /** Observed spend met or passed the cap — refuse the NEXT dispatch. */
  | {
      readonly kind: "exceeded";
      readonly observedUsd: number;
      readonly capUsd: number;
      readonly reportingLanes: number;
      readonly totalLanes: number;
    }
  /**
   * A cap exists but nothing reports, so observed spend cannot test it. NOT
   * "within": saying a cap holds when nothing can measure it is the lie this
   * type exists to prevent.
   */
  | { readonly kind: "unenforceable"; readonly capUsd: number; readonly totalLanes: number };

/**
 * Test a cap against observed spend.
 *
 * `exceeded` is `>=` rather than `>`: a cap is a limit, and the dispatch that
 * would take the mission exactly to it is the one worth refusing while the
 * refusal still means something.
 */
export function evaluateCap(
  cost: MissionCost,
  capUsd: number | null | undefined
): CapVerdict | null {
  if (capUsd === null || capUsd === undefined || !Number.isFinite(capUsd)) {
    return null; // no cap set — not the same as a cap that passes
  }
  if (cost.reportingLanes === 0) {
    return { kind: "unenforceable", capUsd, totalLanes: cost.totalLanes };
  }
  if (cost.observedUsd >= capUsd) {
    return {
      kind: "exceeded",
      observedUsd: cost.observedUsd,
      capUsd,
      reportingLanes: cost.reportingLanes,
      totalLanes: cost.totalLanes,
    };
  }
  // Under the cap on what MUON can see. Whether that is a pass depends
  // entirely on whether there was anything it could NOT see.
  return cost.complete
    ? {
        kind: "within",
        observedUsd: cost.observedUsd,
        capUsd,
        totalLanes: cost.totalLanes,
      }
    : {
        kind: "within-partial",
        observedUsd: cost.observedUsd,
        capUsd,
        reportingLanes: cost.reportingLanes,
        totalLanes: cost.totalLanes,
      };
}

/**
 * Does this verdict refuse the next dispatch?
 *
 * ONLY `exceeded`. An unenforceable cap must not block work — MUON cannot see
 * what those lanes cost, and refusing on an unmeasurable limit would stop a
 * mission for a number nobody has. The wall-clock budget still bounds them.
 */
export function capRefusesDispatch(verdict: CapVerdict | null): boolean {
  return verdict?.kind === "exceeded";
}

/**
 * The ONE rendering of a verdict, for the same reason `describeMissionCost` is
 * the one rendering of a figure: no surface may show a cap result without the
 * coverage that qualifies it. D3 says the surface names the lanes it cannot
 * enforce against, so pass `silentLanes` (the run bundle already carries
 * `laneCosts`, from which they are the `reported: false` entries).
 *
 * Naming is bounded: an unbounded id list on a wide crew would push the
 * decision itself off the line a human reads.
 *
 * It HAS a production caller as of 2026-08-09 — the dispatch admission's
 * refusal message and `muon cost` both render through it — so the flattening
 * below defends text a human is reading today, not text they might one day.
 */
/** Shown for a lane whose id carries no renderable character. */
export const UNNAMEABLE_LANE = "(unnameable lane)";

export function describeCapVerdict(
  verdict: CapVerdict | null,
  silentLanes: readonly string[] = []
): string {
  if (verdict === null) return "no cap set";
  const cap = `$${verdict.capUsd.toFixed(2)}`;
  const named = (): string => {
    if (silentLanes.length === 0) return "";
    // LANE IDS ARE STORED TEXT, and D3 requires this list to NAME the lanes
    // the cap cannot be enforced against — so a lane must never disappear from
    // it. `flattenDangerous(...).trim()` did exactly that: a lane id of only
    // zero-width characters flattened to "", and the rendered list showed
    // ": , ok" — one fewer lane than there are, silently.
    //
    // `UNNAMEABLE` is the same posture as the client's `NO_PRINTABLE_TEXT`:
    // a row that cannot be rendered is reported as unrenderable rather than
    // collapsed into blank space. (Those two functions share a character class
    // via `DANGEROUS_RANGES`, not a policy — this is the policy difference,
    // stated rather than assumed away.)
    const shown = silentLanes.slice(0, 3).map((lane) => {
      const flat = flattenDangerous(lane).trim();
      return flat === "" ? UNNAMEABLE_LANE : flat;
    });
    const rest = silentLanes.length - shown.length;
    return `: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
  };
  switch (verdict.kind) {
    case "within":
      return `$${verdict.observedUsd.toFixed(2)} of ${cap} (all ${verdict.totalLanes} lanes reporting)`;
    case "within-partial":
      return `$${verdict.observedUsd.toFixed(2)} of ${cap} observed, but the cap CANNOT be enforced for ${
        verdict.totalLanes - verdict.reportingLanes
      } of ${verdict.totalLanes} lanes${named()} — wall-clock is what bounds those`;
    case "exceeded":
      return `≥ $${verdict.observedUsd.toFixed(2)} has met the ${cap} cap — further dispatch refused (${verdict.reportingLanes} of ${verdict.totalLanes} lanes reporting)`;
    case "unenforceable":
      return `cap ${cap} cannot be enforced: 0 of ${verdict.totalLanes} lanes report dollars${named()} — wall-clock is what bounds this mission`;
  }
}

/**
 * The mission receipt (ADR-0036 D5).
 *
 * `crewSize` rides along because T6's second half — "was the fan-out worth
 * it" — is unanswerable without the fan-out recorded beside its cost. There is
 * deliberately no counterfactual field: MUON does not know what one lane would
 * have cost, and "you saved $X by parallelising" would be invention.
 */
export type MissionReceipt = {
  readonly cost: MissionCost;
  readonly lanes: readonly LaneCost[];
  readonly wallMsConsumed: number;
  readonly crewSize: number;
  /** Lanes whose vendor cannot report dollars, named rather than omitted. */
  readonly nonReportingLanes: readonly string[];
};

export function buildMissionReceipt(input: {
  lanes: readonly LaneCost[];
  wallMsConsumed: number;
  crewSize: number;
}): MissionReceipt {
  return {
    cost: summarizeMissionCost(input.lanes),
    lanes: [...input.lanes],
    wallMsConsumed: input.wallMsConsumed,
    crewSize: input.crewSize,
    nonReportingLanes: input.lanes
      .filter((lane) => !lane.reported)
      .map((lane) => lane.laneId),
  };
}

export function describeReceipt(receipt: MissionReceipt): string {
  const head = `${describeMissionCost(receipt.cost)} · crew ${receipt.crewSize} · ${Math.round(receipt.wallMsConsumed / 1000)}s`;
  if (receipt.nonReportingLanes.length === 0) return head;
  return `${head} · no cost signal from: ${receipt.nonReportingLanes.join(", ")}`;
}
