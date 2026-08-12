import { describe, expect, it } from "vitest";
import {
  entityIdf,
  entityKindWeight,
  rankByEntityMentions,
  type EntityCorpusStats,
  type EntityMention,
  type MemoryEntity,
} from "../src/memory-entities.js";

// ── D-mem0-1: the entity arm needs an IDF term ───────────────────────────────
//
// MEASURED PREMISE, not a hypothetical. On the founder's live brain the entity
// keys `gitnexus` and `apps/cli/readme.md` each appear on 30 of 212 active notes —
// 14% of the corpus apiece — and `rankByEntityMentions` weighted them by entity
// KIND alone, so a word on one note in seven scored exactly like a word on one
// note. `npm run health:memory` row 19 alarms on precisely that condition, and it
// had never been evaluated before the harness shipped: the numbers matched the
// baseline, and nobody had checked the predicate against them.
//
// The fix is IDF, `log((N+1)/(df+1))`, NOT mem0's `1/(1+0.001*(n-1)^2)` — those
// constants are tuned against an additive similarity score in [0, 0.5], and MUON's
// entity arm emits a RANK into RRF. See `docs/design/memory-index-decisions.md` §5.

const corpus = (
  df: Record<string, number>,
  activeNotes: number
): EntityCorpusStats => ({ df: new Map(Object.entries(df)), activeNotes });

const entity = (key: string, kind: MemoryEntity["kind"]): MemoryEntity => ({
  key,
  kind,
  display: key,
});

const mention = (noteId: string, entityKey: string, at: string): EntityMention => ({
  noteId,
  entityKey,
  createdAt: at,
});

describe("entityIdf", () => {
  it("falls as a key gets commoner, and is ZERO for a key on every note", () => {
    const N = 212;
    const rare = entityIdf("k", corpus({ k: 1 }, N));
    const live = entityIdf("k", corpus({ k: 30 }, N)); // the measured case
    const everywhere = entityIdf("k", corpus({ k: N }, N));

    expect(rare).toBeGreaterThan(live);
    expect(live).toBeGreaterThan(everywhere);
    // A word that appears on EVERY note distinguishes nothing, and the smoothed
    // ratio says so exactly rather than approximately.
    expect(everywhere).toBe(0);
    // And it is never negative, or a common key would INVERT the sort instead of
    // merely losing to a rare one.
    expect(everywhere).toBeGreaterThanOrEqual(0);
  });

  it("treats an uncounted key as maximally rare, not as an error", () => {
    // A key absent from the map was never counted; a key nothing mentions cannot
    // be common. Both readings agree on df 0, so there is no failure mode here.
    expect(entityIdf("never-counted", corpus({}, 212))).toBe(
      entityIdf("k", corpus({ k: 0 }, 212))
    );
  });

  it("CLAMPS a df larger than the corpus rather than inverting the sort", () => {
    // Should be impossible — df counts distinct active notes — so this is about
    // what happens when it is not: a miscount must degrade to "no discount", never
    // to a negative weight that ranks a corpus-wide key ABOVE a rare one.
    expect(entityIdf("k", corpus({ k: 9_999 }, 10))).toBe(0);
  });
});

describe("rankByEntityMentions applies the discount to the ORDER", () => {
  it("THE MEASURED CASE: a 14%-of-corpus key stops outranking a rare one", () => {
    // Note A carries the corpus-wide key. Note B carries a rare key of the SAME
    // entity kind, so kind weight cannot explain the difference — only IDF can.
    const common = entity("gitnexus", "term");
    const rare = entity("seatbelt-sandbox", "term");
    expect(entityKindWeight(common.kind)).toBe(entityKindWeight(rare.kind));

    const mentions = [
      mention("note-common", common.key, "2026-07-30T00:00:02.000Z"),
      mention("note-rare", rare.key, "2026-07-30T00:00:01.000Z"),
    ];
    const stats = corpus({ [common.key]: 30, [rare.key]: 1 }, 212);

    const ranked = rankByEntityMentions(mentions, [common, rare], 10, stats);
    expect(ranked).toEqual(["note-rare", "note-common"]);

    // AND THE CONTROL: with a flat corpus the two are equal on score and the
    // newest-first tiebreak decides — which is the pre-IDF behaviour, and proves
    // the reordering above came from IDF rather than from anything else.
    const flat = rankByEntityMentions(
      mentions,
      [common, rare],
      10,
      corpus({ [common.key]: 1, [rare.key]: 1 }, 212)
    );
    expect(flat).toEqual(["note-common", "note-rare"]);
  });

  it("a rare key still loses to TWO rare keys — the arm still counts distinct hits", () => {
    // IDF scales each key's contribution; it must not turn the arm into
    // "highest-IDF key wins", or a note matching the whole query would lose to one
    // matching a single obscure term.
    const a = entity("alpha", "term");
    const b = entity("bravo", "term");
    const ranked = rankByEntityMentions(
      [
        mention("both", a.key, "2026-07-30T00:00:01.000Z"),
        mention("both", b.key, "2026-07-30T00:00:01.000Z"),
        mention("one", a.key, "2026-07-30T00:00:02.000Z"),
      ],
      [a, b],
      10,
      corpus({ alpha: 2, bravo: 2 }, 212)
    );
    expect(ranked[0]).toBe("both");
  });

  it("DEGRADES to the pre-IDF order when the corpus could not be counted — by WEIGHT, not just by tiebreak", () => {
    // THE REVIEW FINDING, pinned. The previous version of this test asserted only
    // the recency tiebreak on two single-entity notes — a case where the pre-IDF
    // order and a zeroed order AGREE, so it could not fail on the bug it named.
    // The real property is that the summed KIND WEIGHT still decides: a note
    // carrying more (and more evidential) query entities must still win, even
    // though it is older.
    const symbol = entity("src/pay/charge.ts#applyCharge", "symbol");
    const term = entity("idempotency", "term");
    const ranked = rankByEntityMentions(
      [
        mention("rich", symbol.key, "2026-07-30T00:00:01.000Z"),
        mention("rich", term.key, "2026-07-30T00:00:01.000Z"),
        mention("thin", term.key, "2026-07-30T00:00:09.000Z"),
      ],
      [symbol, term],
      10,
      { df: new Map(), activeNotes: 0 }
    );
    expect(ranked).toEqual(["rich", "thin"]);
    // And the weight really is the kind weight, unscaled.
    expect(entityIdf(symbol.key, { df: new Map(), activeNotes: 0 })).toBe(1);
  });

  it("still breaks GENUINE ties by recency when the corpus could not be counted", () => {
    // Both keys are the SAME kind, so with no corpus their weights are equal and
    // the tiebreak really is what decides — which is the property this test is for.
    // It previously used a `symbol` against a `term` (weights 3 and 1), so it was
    // never a tie and would have passed on score alone.
    const a = entity("alpha", "term");
    const b = entity("bravo", "term");
    const ranked = rankByEntityMentions(
      [
        mention("older", a.key, "2026-07-30T00:00:01.000Z"),
        mention("newer", b.key, "2026-07-30T00:00:02.000Z"),
      ],
      [a, b],
      10,
      { df: new Map(), activeNotes: 0 }
    );
    // Deterministic and total, which is the property every caller relies on.
    expect(ranked).toEqual(["newer", "older"]);
    expect(new Set(ranked).size).toBe(ranked.length);
  });
});
