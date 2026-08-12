import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MuonGraph } from "../src/muon-graph.js";
import type { Embedder, MemoryNoteRecord } from "../src/types.js";

// KG-3: the dense/semantic tier fires on REAL vectors. Deterministic + offline,
// a FAKE embedder (no network) maps a handful of texts to fixed vectors so a
// PARAPHRASE (zero shared tokens) is close in vector space. Paraphrase RECALL
// that pure-lexical would miss is the headline; dense-OFF must be unchanged.

const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

// Two paraphrases about object storage with NO shared whitespace token, plus an
// unrelated distractor. The fake places the two paraphrases near each other and
// the distractor orthogonal.
const NOTE_STORAGE = "Persist build artifacts into remote object storage buckets";
// Token-disjoint paraphrase: no word here is a substring of the note's haystack
// (its text OR its kind, e.g. "on" would substring-match "decisi-on-").
const QUERY_STORAGE = "dump packaged deliverables toward hosted vault racks";
const NOTE_KEYS = "Rotate signing keys every ninety weekdays";

function fakeEmbedder(): Embedder & { calls: number } {
  const table = new Map<string, number[]>([
    [norm(NOTE_STORAGE), [1, 0, 0]],
    [norm(QUERY_STORAGE), [0.95, 0.31, 0]], // cosine ≈ 0.95 with NOTE_STORAGE
    [norm(NOTE_KEYS), [0, 1, 0]], // orthogonal → cosine 0 with storage
  ]);
  const embedder = {
    calls: 0,
    id: "fake-concept-v1",
    async embed(texts: string[]): Promise<number[][]> {
      embedder.calls += texts.length;
      return texts.map((t) => {
        const hit = table.get(norm(t));
        if (hit) return hit;
        // Deterministic fallback for anything unregistered (unrelated → low cos).
        const v = [0, 0, 0];
        for (const ch of norm(t)) v[ch.charCodeAt(0) % 3] += 1;
        return v;
      });
    },
  };
  return embedder;
}

function record(over: Partial<MemoryNoteRecord> & { id: string; text: string }): MemoryNoteRecord {
  const now = "2026-07-11T00:00:00.000Z";
  return {
    kind: "decision",
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
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: null,
    ...over,
  };
}

let dir: string;
let denseGraph: MuonGraph;
let lexicalGraph: MuonGraph;
const embedder = fakeEmbedder();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "muon-graph-emb-"));
  // FTS off so recall is deterministic in CI (matches the container default).
  denseGraph = new MuonGraph(join(dir, "dense.lbug"), { embedder, disableFts: true });
  lexicalGraph = new MuonGraph(join(dir, "lex.lbug"), { disableFts: true });
  await denseGraph.init();
  await lexicalGraph.init();
});

afterAll(async () => {
  await denseGraph.close();
  await lexicalGraph.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dense semantic tier (KG-3)", () => {
  it("paraphrase RECALL: a semantically-similar query surfaces a note lexical would miss", async () => {
    const stored = await denseGraph.addMemoryNote({
      kind: "decision",
      text: NOTE_STORAGE,
      createdBy: "human",
    });
    await denseGraph.addMemoryNote({
      kind: "convention",
      text: NOTE_KEYS,
      createdBy: "human",
    });

    // The paraphrase query shares ZERO tokens with the stored note.
    for (const token of QUERY_STORAGE.toLowerCase().split(/\s+/)) {
      expect(NOTE_STORAGE.toLowerCase()).not.toContain(token);
    }

    // Dense recall surfaces it anyway.
    const hits = await denseGraph.searchMemory(QUERY_STORAGE);
    expect(hits.some((n) => n.id === stored.id)).toBe(true);
  });

  it("dense-OFF fallback: pure-lexical misses the same paraphrase (no dense = no recall)", async () => {
    const stored = await lexicalGraph.addMemoryNote({
      kind: "decision",
      text: NOTE_STORAGE,
      createdBy: "human",
    });
    // No embedder → semanticCandidates contributes nothing; the token-disjoint
    // paraphrase query returns no lexical match. This is the "no regression"
    // baseline the dense tier is measured against.
    const hits = await lexicalGraph.searchMemory(QUERY_STORAGE);
    expect(hits.some((n) => n.id === stored.id)).toBe(false);

    // Lexical retrieval still works for a query that DOES share tokens.
    const lexHits = await lexicalGraph.searchMemory("object storage buckets");
    expect(lexHits.some((n) => n.id === stored.id)).toBe(true);
  });

  it("projectMemoryNote (the LEDGER path) stores the real vector → dense recall", async () => {
    // The production ingest projects a note WITH its cached vector; prove that
    // path (not just addMemoryNote) lights up dense recall. Space must be
    // explicit — no silent claim that an unknown vector is in the live space.
    const rec = record({ id: "mem-proj-1", text: NOTE_STORAGE });
    const [vec] = await embedder.embed([rec.text]);
    await denseGraph.projectMemoryNote(rec, vec, undefined, embedder.id);

    const hits = await denseGraph.searchMemory(QUERY_STORAGE);
    expect(hits.some((n) => n.id === rec.id)).toBe(true);
  });

  it("TODO 4.4: projectMemoryNote with a vector but no space stays lexical", async () => {
    const rec = record({
      id: "mem-proj-nospace",
      text: "unique nospace marker phrase omega",
    });
    const [vec] = await embedder.embed([rec.text]);
    await denseGraph.projectMemoryNote(rec, vec); // no embeddingSpace
    // Lexical still finds it; dense paraphrase path must not (vector refused).
    expect(
      (await denseGraph.searchMemory("nospace marker phrase omega")).some(
        (n) => n.id === rec.id
      )
    ).toBe(true);
  });

  it("projectMemoryNote without a vector leaves it lexical (embedding stays [])", async () => {
    // A note projected with NO vector must not crash and must not gain dense
    // recall, the local-first default when the cache/embedder is cold.
    const rec = record({ id: "mem-proj-2", text: "unique undense marker phrase zeta" });
    await denseGraph.projectMemoryNote(rec); // no embedding arg
    const hits = await denseGraph.searchMemory("marker phrase zeta");
    // Found lexically (shares tokens), proving projection succeeded.
    expect(hits.some((n) => n.id === rec.id)).toBe(true);
  });

  it("TODO 4.4: dense arm gates on embeddingSpace equality (cross-space → empty arm)", async () => {
    // Stamp a vector under space A, then query under space B. Exact equality
    // (not a coverage threshold) must exclude the note from dense candidates
    // so a model switch cannot become a silent recency arm.
    const spaceA = mkdtempSync(join(tmpdir(), "muon-space-a-"));
    const spaceB = mkdtempSync(join(tmpdir(), "muon-space-b-"));
    const embedA = fakeEmbedder();
    embedA.id = "space-a";
    const embedB = {
      ...fakeEmbedder(),
      id: "space-b",
      async embed(texts: string[]) {
        return embedA.embed(texts); // same geometry, different space stamp
      },
    };
    const graphA = new MuonGraph(join(spaceA, "g.lbug"), {
      embedder: embedA,
      disableFts: true,
    });
    const graphB = new MuonGraph(join(spaceB, "g.lbug"), {
      embedder: embedB,
      disableFts: true,
    });
    await graphA.init();
    await graphB.init();
    try {
      const rec = record({ id: "mem-space-1", text: NOTE_STORAGE });
      const [vec] = await embedA.embed([rec.text]);
      await graphA.projectMemoryNote(rec, vec, undefined, "space-a");
      // Same-space dense still recalls the paraphrase.
      expect(
        (await graphA.searchMemory(QUERY_STORAGE)).some((n) => n.id === rec.id)
      ).toBe(true);

      // Reproject the same vector into graphB under space-a label while B
      // queries as space-b — dense must miss; lexical still works on shared tokens.
      await graphB.projectMemoryNote(rec, vec, undefined, "space-a");
      expect(
        (await graphB.searchMemory(QUERY_STORAGE)).some((n) => n.id === rec.id)
      ).toBe(false);
      expect(
        (await graphB.searchMemory("object storage buckets")).some(
          (n) => n.id === rec.id
        )
      ).toBe(true);
    } finally {
      await graphA.close();
      await graphB.close();
      rmSync(spaceA, { recursive: true, force: true });
      rmSync(spaceB, { recursive: true, force: true });
    }
  });
});
