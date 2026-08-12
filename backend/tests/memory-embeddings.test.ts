import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@muon/graph";

// KG-3 end-to-end (REAL SQLite + REAL LadybugDB, a FAKE embedder, no network).
// The dense tier is wired through the LEDGER ingest. Covers: genuine dedup
// (dense + lexical corroboration → supersede), the F1 invariant (dense-only,
// lexically-unsupported match is NON-destructive → related, both kept), an
// EmbeddingCache hit avoiding recompute, the F2 model-key (a model switch is a
// miss, never cross-space reuse), contradiction-still-contradiction, dense-ON
// concurrency atomicity, and a dense-OFF no-regression baseline.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
const hashOf = (t: string) => createHash("sha256").update(norm(t)).digest("hex");

// Genuine same-fact paraphrases: lexical overlap ~0.36 (above the 0.3 floor,
// below the 0.5 lexical supersede threshold) + cosine ~0.86 → a corroborated,
// destructive SUPERSEDE (dense pushes it over, lexical floor makes it safe).
const DEDUP_A = "The rate limiter uses a token bucket to throttle burst traffic";
const DEDUP_B = "The rate limiter relies on a token bucket for throttling bursts";
// Token-DISJOINT, DIFFERENT facts (the reviewer's F1 repro): high cosine but
// jaccard ~0 → dense-only, lexically-UNSUPPORTED → NON-destructive `related`.
const TOKEN_BUCKET = "Rate limiting uses a token bucket algorithm";
const LEAKY_BUCKET = "Throttling relies on a leaky bucket strategy";
// A Postgres constraint + its negation → conflict wins over high cosine.
const PG = "The database layer must use Postgres";
const PG_NEG = "The database layer must not use Postgres";

function makeFake(id: string, table: Map<string, number[]>): Embedder & { calls: number } {
  const e = {
    calls: 0,
    id,
    async embed(texts: string[]): Promise<number[][]> {
      e.calls += texts.length;
      return texts.map((t) => {
        const hit = table.get(norm(t));
        if (hit) return hit;
        const v = [0, 0, 0];
        for (const ch of norm(t)) v[ch.charCodeAt(0) % 3] += 1;
        return v;
      });
    },
  };
  return e;
}

const embedder = makeFake(
  "fake-main-v1",
  new Map<string, number[]>([
    [norm(DEDUP_A), [1, 0, 0]],
    [norm(DEDUP_B), [0.86, 0.51, 0]], // cosine ≈ 0.86 with DEDUP_A
    [norm(TOKEN_BUCKET), [1, 0, 0]],
    [norm(LEAKY_BUCKET), [0.85, 0.53, 0]], // cosine ≈ 0.85 with TOKEN_BUCKET
    [norm(PG), [1, 0, 0]],
    [norm(PG_NEG), [0.99, 0.141, 0]], // cosine ≈ 0.99 with PG
  ])
);

async function activeNotesOnModule(module: string): Promise<string[]> {
  const anchors = await db.prisma.memoryAnchor.findMany({
    where: { kind: "module", value: module },
  });
  const ids = [...new Set(anchors.map((a) => a.noteId))];
  const active: string[] = [];
  for (const id of ids) {
    const note = await db.prisma.memoryNote.findUnique({ where: { id } });
    if (note?.status === "active") active.push(id);
  }
  return active;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-emb-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
  // Inject the deterministic fake BEFORE any ingest so the graph + ledger both
  // resolve it (still zero network, MUON_EMBED_DISABLE from setup is overridden).
  graphLib.__setEmbedderForTests(embedder);
});

afterAll(async () => {
  await settle();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("memory embeddings tier (KG-3)", () => {
  it("paraphrase DEDUP (corroborated): dense + lexical overlap → supersede, 1 active", async () => {
    const mod = "kg3/dedup-module.ts";
    const first = await ledger.ingestMemoryNote({
      kind: "decision",
      text: DEDUP_A,
      modules: [mod],
      topics: ["kg3-dedup"],
      createdBy: "human",
    });
    expect(first.action).toBe("inserted");

    // A genuine paraphrase (jaccard ≈ 0.36 ≥ floor, cosine ≈ 0.86): dense pushes
    // it to supersede and the lexical floor makes that safe (clearly same fact).
    // Same author (peer trust) so the KG-6 trust gate is a NO-OP and the DEDUP
    // mechanism itself is what's under test (a lower-trust writer would instead be
    // gated to a PROPOSES_SUPERSEDE, see memory-governance.test.ts).
    const second = await ledger.ingestMemoryNote({
      kind: "decision",
      text: DEDUP_B,
      modules: [mod],
      topics: ["kg3-dedup"],
      createdBy: "human",
    });
    expect(second.action).toBe("superseded");
    expect(second.relatedNoteId).toBe(first.note.id);

    const active = await activeNotesOnModule(mod);
    expect(active).toEqual([second.note.id]);
    console.log(
      `[KG-3 paraphrase-dedup] corroborated supersede → active-on-anchor=${active.length}`
    );
  });

  it("F1 invariant: a dense-only (lexically-unsupported) match keeps BOTH notes (related, no drop)", async () => {
    const mod = "kg3/f1-module.ts";
    const kept = await ledger.ingestMemoryNote({
      kind: "convention",
      text: TOKEN_BUCKET,
      modules: [mod],
      topics: ["kg3-f1"],
      createdBy: "human",
    });
    expect(kept.action).toBe("inserted");

    // DIFFERENT algorithm, same anchor, cosine ~0.85 but jaccard ~0. A dense-only
    // supersede would DESTROY the token-bucket fact, the invariant forbids it.
    const related = await ledger.ingestMemoryNote({
      kind: "convention",
      text: LEAKY_BUCKET,
      modules: [mod],
      topics: ["kg3-f1"],
      createdBy: "codex",
    });
    expect(related.action).toBe("related");
    expect(related.relatedNoteId).toBe(kept.note.id);

    // BOTH notes remain active, nothing rejected/dropped.
    const active = await activeNotesOnModule(mod);
    expect(new Set(active)).toEqual(new Set([kept.note.id, related.note.id]));
    const predecessor = await db.prisma.memoryNote.findUnique({
      where: { id: kept.note.id },
    });
    expect(predecessor?.status).toBe("active"); // NOT rejected

    // A "related" edge + a human reconcile request were recorded.
    const edge = await db.prisma.memoryEdge.findFirst({
      where: { fromId: related.note.id, toId: kept.note.id, kind: "related" },
    });
    expect(edge).not.toBeNull();
    const reconcile = await db.prisma.confirmation.findFirst({
      where: { noteId: related.note.id, decision: "reconcile" },
    });
    expect(reconcile).not.toBeNull();
    console.log(
      `[KG-3 F1] token-bucket vs leaky-bucket → action=${related.action}, both active=${active.length}, predecessor status=${predecessor?.status}`
    );
  });

  it("EmbeddingCache HIT: identical text reuses the vector, embed runs once", async () => {
    const mod = "kg3/cache-module.ts";
    const text = "Cache hit probe: adopt vitest as the unit test runner here";
    const before = embedder.calls;

    const a = await ledger.ingestMemoryNote({
      kind: "convention",
      text,
      modules: [mod],
      topics: ["kg3-cache"],
      createdBy: "human",
    });
    expect(a.action).toBe("inserted");

    // The vector is now in the durable cache, keyed by (textHash, model).
    const cached = await db.prisma.embeddingCache.findUnique({
      where: { textHash_model: { textHash: hashOf(text), model: embedder.id } },
    });
    expect(cached).not.toBeNull();
    expect(cached?.dims).toBe(3);

    // Re-ingest identical text → cache HIT (no recompute) and dedup to NOOP.
    // Same author (peer trust) so the KG-6 gate is a no-op and the cache/dedup
    // path is what's exercised (a lower-trust writer would be gated instead).
    const b = await ledger.ingestMemoryNote({
      kind: "convention",
      text,
      modules: [mod],
      topics: ["kg3-cache"],
      createdBy: "human",
    });
    expect(b.action).toBe("duplicate");
    expect(embedder.calls - before).toBe(1); // embedded exactly once
    console.log(
      `[KG-3 cache-hit] identical text ingested twice → embed calls delta=${embedder.calls - before}`
    );
  });

  it("F2 model-key: a MUON_EMBED_MODEL switch is a cache MISS, never cross-space reuse", async () => {
    const mod = "kg3/f2-model-module.ts";
    const text = "Feature flags default to off until an operator enables them";

    // Ingest under model A.
    graphLib.__setEmbedderForTests(makeFake("model-a-v1", new Map([[norm(text), [1, 0, 0]]])));
    await ledger.ingestMemoryNote({
      kind: "decision",
      text,
      modules: [mod],
      topics: ["kg3-f2"],
      createdBy: "human",
    });

    // Switch to model B (different space) and ingest the SAME text. embedNoteText
    // must MISS (not reuse A's vector) and recompute under B → a distinct cache
    // row. fakeB counts one embed for this text.
    const fakeB = makeFake("model-b-v1", new Map([[norm(text), [0, 1, 0]]]));
    const beforeB = fakeB.calls;
    graphLib.__setEmbedderForTests(fakeB);
    await ledger.ingestMemoryNote({
      kind: "decision",
      text,
      modules: [mod],
      topics: ["kg3-f2"],
      createdBy: "codex",
    });
    expect(fakeB.calls - beforeB).toBe(1); // recomputed under B, no A reuse

    // Two cache rows for the same textHash, one per model, distinct vectors.
    const rows = await db.prisma.embeddingCache.findMany({
      where: { textHash: hashOf(text) },
    });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.model))).toEqual(
      new Set(["model-a-v1", "model-b-v1"])
    );
    graphLib.__setEmbedderForTests(embedder); // restore
    console.log(
      `[KG-3 F2] model switch → ${rows.length} cache rows, models=${rows.map((r) => r.model).sort().join(",")}`
    );
  });

  it("conflict STILL conflict: a contradicting statement is not deduped away", async () => {
    const mod = "kg3/conflict-module.ts";
    const base = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: PG,
      modules: [mod],
      topics: ["kg3-conflict"],
      createdBy: "human",
    });
    expect(base.action).toBe("inserted");

    // Near-identical vector (~0.99) BUT opposite polarity → CONFLICT, both active.
    const clash = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: PG_NEG,
      modules: [mod],
      topics: ["kg3-conflict"],
      createdBy: "codex",
    });
    expect(clash.action).toBe("conflict");
    expect(clash.relatedNoteId).toBe(base.note.id);

    const active = await activeNotesOnModule(mod);
    expect(new Set(active)).toEqual(new Set([base.note.id, clash.note.id]));
    const contradicts = await db.prisma.memoryEdge.findFirst({
      where: { fromId: clash.note.id, toId: base.note.id, kind: "contradicts" },
    });
    expect(contradicts).not.toBeNull();
    console.log(
      `[KG-3 conflict] high-cosine opposite-polarity → action=${clash.action}, both active=${active.length}`
    );
  });

  it("dense-ON concurrency: 8 concurrent same-fact ingests → exactly 1 insert, 1 active", async () => {
    const mod = "kg3/concurrency-module.ts";
    // Alternate two genuine paraphrases (they legitimately dedup/supersede). The
    // vector is computed OUT of the write-actor lock; the classify runs IN it,
    // this proves that split stays atomic (no TOCTOU double-insert) with dense ON.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ledger.ingestMemoryNote({
          kind: "decision",
          text: i % 2 === 0 ? DEDUP_A : DEDUP_B,
          modules: [mod],
          topics: ["kg3-concurrency"],
          createdBy: "human",
        })
      )
    );
    const inserted = results.filter((r) => r.action === "inserted");
    expect(inserted).toHaveLength(1); // no double-insert under concurrency

    const active = await activeNotesOnModule(mod);
    expect(active.length).toBe(1); // all collapsed to a single active note
    console.log(
      `[KG-3 dense-ON concurrency] ${N} concurrent → inserted=${inserted.length}, active-on-anchor=${active.length}`
    );
  });

  it("dense-OFF fallback: no embedder → identical to today's lexical behavior", async () => {
    graphLib.__setEmbedderForTests(undefined); // hard-off for this test only
    try {
      const mod = "kg3/denseoff-module.ts";
      // Fresh texts never embedded elsewhere. Token-disjoint paraphrases that
      // dense WOULD relate, with no embedder they stay two distinct INSERTs
      // (exactly the prior lexical behavior, no cache written).
      const EVICT = "Cache eviction follows a least recently accessed policy";
      const COLD = "Discard the coldest entries first whenever capacity saturates";
      const p1 = await ledger.ingestMemoryNote({
        kind: "convention",
        text: EVICT,
        modules: [mod],
        topics: ["kg3-off"],
        createdBy: "human",
      });
      const p2 = await ledger.ingestMemoryNote({
        kind: "convention",
        text: COLD,
        modules: [mod],
        topics: ["kg3-off"],
        createdBy: "codex",
      });
      expect(p1.action).toBe("inserted");
      expect(p2.action).toBe("inserted");

      const active = await activeNotesOnModule(mod);
      expect(active.length).toBe(2);

      // Nothing was embedded/cached while dense was off.
      const cached = await db.prisma.embeddingCache.findMany({
        where: { textHash: hashOf(EVICT) },
      });
      expect(cached.length).toBe(0);

      // An EXACT duplicate still dedups lexically (unchanged governance).
      const dup = await ledger.ingestMemoryNote({
        kind: "convention",
        text: EVICT,
        modules: [mod],
        topics: ["kg3-off"],
        createdBy: "human",
      });
      expect(dup.action).toBe("duplicate");
      console.log(
        `[KG-3 dense-off] no embedder → paraphrases distinct (active=${active.length}), exact dup deduped, cache empty`
      );
    } finally {
      graphLib.__setEmbedderForTests(embedder); // restore for isolation
    }
  });
});
