import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@muon/graph";

const norm = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLowerCase();
const hashOf = (text: string) =>
  createHash("sha256").update(norm(text)).digest("hex");

function fakeEmbedder(
  id: string,
  table: Map<string, number[]>
): Embedder & { calls: number } {
  const embedder = {
    id,
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      embedder.calls += texts.length;
      return texts.map((text) => table.get(norm(text)) ?? [0, 0, 1]);
    },
  };
  return embedder;
}

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let ledger: typeof import("../src/lib/memory-ledger.js");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-graph-cache-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  ledger = await import("../src/lib/memory-ledger.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("graph-side embedding durability (KG-3 F6c)", () => {
  it("reuses durable note/query vectors after a graph restart and model outage", async () => {
    const noteText =
      "Durable graph note stores deployment artifacts in object storage";
    const queryText = "archive packaged outputs inside remote buckets";
    const durable = fakeEmbedder(
      "graph-durable-v1",
      new Map([
        [norm(noteText), [1, 0, 0]],
        [norm(queryText), [0.98, 0.2, 0]],
      ])
    );
    graphLib.__setEmbedderForTests(durable);
    const graph = graphLib.getGraph();
    const note = await graph.addMemoryNote({
      kind: "decision",
      text: noteText,
      modules: ["src/durable-cache.ts"],
      createdBy: "human",
    });
    expect((await graph.searchMemory(queryText)).map((row) => row.id)).toContain(
      note.id
    );
    expect(durable.calls).toBe(2);
    await graphLib.closeGraph();

    const unavailable = {
      id: durable.id,
      calls: 0,
      async embed(): Promise<number[][]> {
        unavailable.calls += 1;
        throw new Error("local model unavailable");
      },
      async isAvailable(): Promise<boolean> {
        return false;
      },
    };
    graphLib.__setEmbedderForTests(unavailable);
    const reopened = graphLib.getGraph();
    expect(
      (await reopened.searchMemory(queryText)).map((row) => row.id)
    ).toContain(note.id);
    expect(unavailable.calls).toBe(0);

    const cached = await db.prisma.embeddingCache.findMany({
      where: {
        model: durable.id,
        textHash: { in: [hashOf(noteText), hashOf(queryText)] },
      },
    });
    expect(cached).toHaveLength(2);

    const { embeddingTextHash } = await import(
      "../src/lib/embedding-cache.js"
    );
    expect(embeddingTextHash(noteText)).toBe(
      ledger.computeMemoryTextHash(noteText)
    );
  });
});
