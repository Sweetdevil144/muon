import { describe, expect, it } from "vitest";
import type { MemoryNoteRecord } from "../src/types.js";
import {
  authorizesDestructiveWrite,
  classifyIncomingNote,
  cosine,
  decayAccessCount,
  jaccard,
  reciprocalRankFusion,
  recencyScore,
  rerankBySalience,
  salienceScore,
  tokenize,
  trustRank,
  TRUST_RANK,
  USAGE_DECAY_HALF_LIFE_DAYS,
  type RankableNote,
} from "../src/memory-ranking.js";

function note(overrides: Partial<MemoryNoteRecord>): RankableNote {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    id: "mem-x",
    kind: "decision",
    text: "",
    taskId: null,
    laneId: null,
    modules: [],
    topics: [],
    trust: "medium",
    confirmed: false,
    stale: false,
    status: "active",
    createdBy: "human",
    createdAt: now,
    updatedAt: now,
    validFrom: now,
    invalidatedAt: null,
    invalidatedBy: null,
    staleSince: null,
    supersededBy: null,
    ...overrides,
  };
}

describe("text similarity", () => {
  it("tokenizes dropping stopwords and short tokens, keeping code paths", () => {
    expect(tokenize("We should use the RateLimiter in src/auth/limiter.ts")).toEqual([
      "ratelimiter",
      "src/auth/limiter.ts",
    ]);
  });

  it("jaccard rewards overlap, ignores order", () => {
    expect(jaccard(["a", "b", "c"], ["c", "b", "a"])).toBe(1);
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
    expect(jaccard(["a", "b", "c", "d"], ["a", "b"])).toBeCloseTo(0.5, 5);
  });
});

describe("reciprocal rank fusion", () => {
  it("fuses lists so items ranked high in multiple retrievers win", () => {
    const fts = ["a", "b", "c"];
    const graph = ["b", "d", "a"];
    const fused = reciprocalRankFusion([fts, graph]);
    // b is rank1 in graph + rank2 in fts → beats a (rank1 fts, rank3 graph)?
    const sorted = [...fused.entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0]);
    expect(sorted[0]).toBe("b");
    // items in both lists outrank items in one.
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
    expect(fused.get("d")).toBeDefined();
  });
});

describe("recency + salience", () => {
  const now = new Date("2026-07-10T00:00:00.000Z").getTime();

  it("recency halves at the half-life", () => {
    const monthAgo = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    expect(recencyScore(monthAgo, now)).toBeCloseTo(0.5, 2);
    expect(recencyScore(new Date(now).toISOString(), now)).toBe(1);
  });

  it("a confirmed high-trust note outranks a stale unconfirmed one at equal relevance", () => {
    const good = note({ id: "good", confirmed: true, trust: "high", createdAt: new Date(now).toISOString() });
    const bad = note({ id: "bad", confirmed: false, trust: "low", stale: true, createdAt: new Date(now).toISOString() });
    const ranked = rerankBySalience(
      [
        { note: bad, relevance: 0.9 },
        { note: good, relevance: 0.9 },
      ],
      undefined,
      now
    );
    expect(ranked[0].id).toBe("good");
  });

  it("relevance still dominates: a far more relevant note wins despite weaker governance", () => {
    const relevant = note({ id: "rel", confirmed: false, trust: "low", createdAt: new Date(now).toISOString() });
    const governed = note({ id: "gov", confirmed: true, trust: "high", createdAt: new Date(now).toISOString() });
    const ranked = rerankBySalience(
      [
        { note: governed, relevance: 0.2 },
        { note: relevant, relevance: 1 },
      ],
      undefined,
      now
    );
    expect(ranked[0].id).toBe("rel");
  });

  it("usage reinforcement lifts a frequently-recalled note", () => {
    const now2 = now;
    const hot = salienceScore({ note: note({ accessCount: 20 }), relevance: 0.5 }, undefined, now2);
    const cold = salienceScore({ note: note({ accessCount: 0 }), relevance: 0.5 }, undefined, now2);
    expect(hot).toBeGreaterThan(cold);
  });
});

describe("reinforcement time-decay (KG-2)", () => {
  const now = new Date("2026-07-10T00:00:00.000Z").getTime();
  const daysAgo = (d: number) => new Date(now - d * 24 * 3600 * 1000).toISOString();

  it("halves the counter every half-life since last use", () => {
    expect(
      decayAccessCount(160, daysAgo(USAGE_DECAY_HALF_LIFE_DAYS), now)
    ).toBeCloseTo(80, 5);
    expect(
      decayAccessCount(160, daysAgo(4 * USAGE_DECAY_HALF_LIFE_DAYS), now)
    ).toBeCloseTo(10, 5); // 160 → 80 → 40 → 20 → 10
  });

  it("is a no-op for a fresh (just-used) or never-used counter", () => {
    expect(decayAccessCount(5, daysAgo(0), now)).toBeCloseTo(5, 5);
    expect(decayAccessCount(5, null, now)).toBe(5);
    expect(decayAccessCount(0, daysAgo(365), now)).toBe(0);
  });

  it("recent usefulness beats stale lifetime popularity", () => {
    // A note used 200x long ago (8 half-lives → ~0.78) decays below a note used
    // 3x recently (~2.93), reinforcement reflects recent, not lifetime, use.
    const stale = decayAccessCount(200, daysAgo(8 * USAGE_DECAY_HALF_LIFE_DAYS), now);
    const recent = decayAccessCount(3, daysAgo(1), now);
    expect(stale).toBeLessThan(recent);
  });
});

describe("dedup / contradiction on write", () => {
  const base = note({
    id: "old",
    kind: "decision",
    text: "Use the RateLimiter reading the session TTL from config",
    taskId: "task-1",
    modules: ["src/auth/limiter.ts"],
  });

  it("flags a near-identical anchored note as a duplicate (NOOP)", () => {
    const verdict = classifyIncomingNote(
      {
        kind: "decision",
        text: "Use the RateLimiter reading the session TTL from config",
        taskId: "task-1",
        modules: ["src/auth/limiter.ts"],
      },
      [base]
    );
    expect(verdict.action).toBe("duplicate");
  });

  it("keeps a strict same-kind refinement as an additive extension", () => {
    const verdict = classifyIncomingNote(
      {
        kind: "decision",
        text: "Use the RateLimiter reading session TTL from config and cap at 100 rpm",
        taskId: "task-1",
        modules: ["src/auth/limiter.ts"],
      },
      [base]
    );
    expect(verdict.action).toBe("extends");
    if (verdict.action === "extends") expect(verdict.ofNoteId).toBe("old");
  });

  it("does not drop a short extension that crosses duplicate-strength similarity", () => {
    const prior = note({
      id: "short-extension-old",
      kind: "decision",
      text: "Configure durable memory ledger projection state",
      modules: ["src/memory.ts"],
    });
    const verdict = classifyIncomingNote(
      {
        kind: "decision",
        text: "Configure durable memory ledger projection state checks",
        modules: ["src/memory.ts"],
      },
      [prior]
    );
    expect(verdict.action).toBe("extends");
    if (verdict.action === "extends") {
      expect(verdict.ofNoteId).toBe("short-extension-old");
      expect(verdict.similarity).toBeGreaterThanOrEqual(0.82);
    }
  });

  it("still supersedes a same-kind rewrite that does not preserve every prior token", () => {
    const prior = note({
      id: "rewrite-old",
      kind: "decision",
      text: "Use a single transaction for memory supersede writes",
      modules: ["src/memory.ts"],
    });
    const verdict = classifyIncomingNote(
      {
        kind: "decision",
        text: "Use an atomic transaction for memory supersede writes",
        modules: ["src/memory.ts"],
      },
      [prior]
    );
    expect(verdict.action).toBe("supersede");
    if (verdict.action === "supersede") {
      expect(verdict.ofNoteId).toBe("rewrite-old");
    }
  });

  it("surfaces a contradiction on a constraint instead of silently overwriting", () => {
    const constraint = note({
      id: "c1",
      kind: "constraint",
      text: "The limiter must read TTL from config",
      modules: ["src/auth/limiter.ts"],
    });
    const verdict = classifyIncomingNote(
      {
        kind: "constraint",
        text: "The limiter must not read TTL from config",
        modules: ["src/auth/limiter.ts"],
      },
      [constraint]
    );
    expect(verdict.action).toBe("conflict");
  });

  it("inserts a genuinely new, unrelated note", () => {
    const verdict = classifyIncomingNote(
      {
        kind: "convention",
        text: "Prefer pnpm over npm for installs",
        modules: ["package.json"],
      },
      [base]
    );
    expect(verdict.action).toBe("insert");
  });

  it("does not compare notes that share no anchor", () => {
    const verdict = classifyIncomingNote(
      {
        kind: "decision",
        text: "Use the RateLimiter reading the session TTL from config",
        taskId: "different-task",
        modules: ["src/other.ts"],
      },
      [base]
    );
    expect(verdict.action).toBe("insert");
  });
});

describe("dense dedup (KG-3): max(jaccard, cosine)", () => {
  it("cosine similarity is 0 for empty / mismatched vectors, 1 for parallel", () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 5);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  // A storage decision + a token-DISJOINT paraphrase of it on the same anchor.
  const storage = note({
    id: "store",
    kind: "decision",
    text: "Persist build artifacts into remote object storage buckets",
    modules: ["src/store.ts"],
  });
  const paraphrase = {
    kind: "decision" as const,
    text: "Save compiled program outputs on cloud blob shelves",
    modules: ["src/store.ts"],
  };
  const vStore = [1, 0, 0];

  it("F1: a dense-only match (high cosine, jaccard≈0) is NON-destructive → related", () => {
    // Lexical-only (no vectors): the paraphrase shares ~no tokens → INSERT.
    expect(classifyIncomingNote(paraphrase, [storage]).action).toBe("insert");

    // With a near-parallel vector but NO lexical corroboration (jaccard < floor):
    // it must NOT supersede/drop, it routes to `related` (both notes survive).
    const verdict = classifyIncomingNote(paraphrase, [storage], {
      incoming: [0.86, 0.51, 0],
      byId: (id) => (id === "store" ? vStore : undefined),
    });
    expect(verdict.action).toBe("related");
    if (verdict.action === "related") expect(verdict.withNoteId).toBe("store");
  });

  it("F1 regression: token-bucket vs leaky-bucket (cosine high, jaccard≈0) → related, NOT supersede", () => {
    // The reviewer's exact repro: DIFFERENT algorithms, same anchor. A dense-only
    // supersede here would irreversibly destroy the token-bucket fact.
    const tokenBucket = note({
      id: "tb",
      kind: "convention",
      text: "Rate limiting uses a token bucket algorithm",
      modules: ["src/limit.ts"],
    });
    const verdict = classifyIncomingNote(
      {
        kind: "convention",
        text: "Throttling relies on a leaky bucket strategy",
        modules: ["src/limit.ts"],
      },
      [tokenBucket],
      { incoming: [0.85, 0.53, 0], byId: () => [1, 0, 0] } // cosine ≈ 0.85
    );
    expect(verdict.action).toBe("related"); // both kept, nothing rejected
  });

  it("genuine dedup: dense + LEXICAL corroboration (jaccard ≥ floor) → supersede", () => {
    // Real overlap (jaccard ~0.36, above the 0.3 floor but below the 0.5 lexical
    // supersede threshold) + high cosine → the destructive supersede is allowed.
    const prior = note({
      id: "rl",
      kind: "decision",
      text: "The rate limiter uses a token bucket to throttle burst traffic",
      modules: ["src/rl.ts"],
    });
    const incoming = {
      kind: "decision" as const,
      text: "The rate limiter relies on a token bucket for throttling bursts",
      modules: ["src/rl.ts"],
    };
    // Lexical alone (jaccard ~0.36 < 0.5) would NOT supersede → insert.
    expect(classifyIncomingNote(incoming, [prior]).action).toBe("insert");
    const verdict = classifyIncomingNote(incoming, [prior], {
      incoming: [0.86, 0.51, 0],
      byId: () => [1, 0, 0],
    });
    expect(verdict.action).toBe("supersede");
  });

  it("a lexically-corroborated near-identical note → duplicate (NOOP)", () => {
    // Same text (jaccard 1) + high cosine → destructive duplicate is corroborated.
    const dupInput = {
      kind: "decision" as const,
      text: storage.text, // identical text → exact-match corroboration
      modules: ["src/store.ts"],
    };
    const verdict = classifyIncomingNote(dupInput, [storage], {
      incoming: [0.97, 0.243, 0],
      byId: () => vStore,
    });
    expect(verdict.action).toBe("duplicate");
  });

  it("conflict STILL conflict: opposite polarity beats even a ~0.99 cosine", () => {
    const constraint = note({
      id: "pg",
      kind: "constraint",
      text: "The database layer must use Postgres",
      modules: ["src/db.ts"],
    });
    const verdict = classifyIncomingNote(
      {
        kind: "constraint",
        text: "The database layer must not use Postgres",
        modules: ["src/db.ts"],
      },
      [constraint],
      { incoming: [0.99, 0.141, 0], byId: () => [1, 0, 0] } // cosine ≈ 0.99
    );
    // A genuinely contradicting fact is surfaced for the human, NEVER merged.
    expect(verdict.action).toBe("conflict");
    if (verdict.action === "conflict") expect(verdict.withNoteId).toBe("pg");
  });

  it("F4: a genuine contradiction is NOT masked by a higher-cosine duplicate", () => {
    const incoming = {
      kind: "constraint" as const,
      text: "The cache layer must store every response body",
      modules: ["src/cache.ts"],
    };
    const dup = note({
      id: "dup",
      kind: "constraint",
      text: "The cache layer must store each response body fully",
      modules: ["src/cache.ts"],
    });
    const clash = note({
      id: "clash",
      kind: "constraint",
      text: "The cache layer must not store response bodies",
      modules: ["src/cache.ts"],
    });
    const verdict = classifyIncomingNote(incoming, [dup, clash], {
      incoming: [1, 0, 0],
      byId: (id) =>
        id === "dup"
          ? [0.98, 0.199, 0] // cosine ≈ 0.98 (higher, would win "best")
          : id === "clash"
            ? [0.92, 0.392, 0] // cosine ≈ 0.92 (opposite polarity)
            : undefined,
    });
    // Best-only polarity checking would pick `dup` (higher cosine) → duplicate,
    // silently masking the contradiction. F4 gates EVERY candidate → conflict.
    expect(verdict.action).toBe("conflict");
    if (verdict.action === "conflict") expect(verdict.withNoteId).toBe("clash");
  });

  it("dense-OFF fallback: identical verdicts with or without an all-lexical vector set", () => {
    const prior = note({
      id: "old",
      kind: "decision",
      text: "Use the RateLimiter reading the session TTL from config",
      taskId: "task-1",
      modules: ["src/auth/limiter.ts"],
    });
    const incoming = {
      kind: "decision" as const,
      text: "Use the RateLimiter reading session TTL from config and cap at 100 rpm",
      taskId: "task-1",
      modules: ["src/auth/limiter.ts"],
    };
    // Vectors present but orthogonal (cosine 0) must not change the lexical
    // verdict, dense only ADDS recall, it never suppresses a lexical match.
    const lexicalOnly = classifyIncomingNote(incoming, [prior]);
    const withOrthogonalVectors = classifyIncomingNote(incoming, [prior], {
      incoming: [0, 1, 0],
      byId: () => [1, 0, 0],
    });
    expect(withOrthogonalVectors).toEqual(lexicalOnly);
    expect(lexicalOnly.action).toBe("extends");
  });
});

// ---- KG-6 trust gate (pure predicate) ----
describe("authorizesDestructiveWrite (KG-6 trust gate)", () => {
  it("orders trust low < medium < high", () => {
    expect(trustRank("low")).toBeLessThan(trustRank("medium"));
    expect(trustRank("medium")).toBeLessThan(trustRank("high"));
    expect(TRUST_RANK).toEqual({ low: 0, medium: 1, high: 2 });
  });

  it("BLOCKS a lower-trust writer against an unconfirmed higher-trust victim (the hostile case)", () => {
    expect(
      authorizesDestructiveWrite({
        incomingTrust: "low",
        incomingIsHuman: false,
        existingTrust: "high",
        existingConfirmed: false,
      })
    ).toBe(false);
  });

  it("ALLOWS a same-or-higher-trust writer against an unconfirmed peer (no over-block)", () => {
    expect(
      authorizesDestructiveWrite({
        incomingTrust: "high",
        incomingIsHuman: false,
        existingTrust: "medium",
        existingConfirmed: false,
      })
    ).toBe(true);
    expect(
      authorizesDestructiveWrite({
        incomingTrust: "medium",
        incomingIsHuman: false,
        existingTrust: "medium",
        existingConfirmed: false,
      })
    ).toBe(true);
  });

  it("BLOCKS any non-human write against a human-CONFIRMED victim, even a higher-trust one (KG-5 protection)", () => {
    expect(
      authorizesDestructiveWrite({
        incomingTrust: "high",
        incomingIsHuman: false,
        existingTrust: "medium",
        existingConfirmed: true,
      })
    ).toBe(false);
  });

  it("ALWAYS allows a human writer (top authority), even against a confirmed higher-trust victim", () => {
    expect(
      authorizesDestructiveWrite({
        incomingTrust: "low",
        incomingIsHuman: true,
        existingTrust: "high",
        existingConfirmed: true,
      })
    ).toBe(true);
  });
});
