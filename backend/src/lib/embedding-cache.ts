import { createHash } from "node:crypto";
import type { EmbeddingCacheStore } from "@muon/graph";

function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Same content identity as the memory ledger. A regression test pins the two
 * implementations together without introducing a graph↔ledger import cycle. */
export function embeddingTextHash(text: string): string {
  return createHash("sha256")
    .update(normalizeEmbeddingText(text))
    .digest("hex");
}

function parseVector(json: string, dims: number): number[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return undefined;
    const vector = value.map(Number);
    return vector.length === dims &&
      vector.length > 0 &&
      vector.every((entry) => Number.isFinite(entry))
      ? vector
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Durable model-keyed cache shared by graph-local note/query embedding and the
 * relational memory ledger. MuonGraph treats every failure as a lexical fallback.
 */
export const durableEmbeddingCache: EmbeddingCacheStore = {
  async get(text, model) {
    // Lazy import keeps graph-only consumers (probes/tests/CLI) from initializing
    // Prisma or loading relational environment state until dense recall actually
    // needs the durable cache.
    const { prisma } = await import("./db.js");
    const row = await prisma.embeddingCache.findUnique({
      where: {
        textHash_model: {
          textHash: embeddingTextHash(text),
          model,
        },
      },
    });
    return row ? parseVector(row.vector, row.dims) : undefined;
  },

  async put(text, model, vector) {
    if (
      vector.length === 0 ||
      !vector.every((entry) => Number.isFinite(entry))
    ) {
      return;
    }
    const { prisma } = await import("./db.js");
    const textHash = embeddingTextHash(text);
    const encoded = JSON.stringify(vector);
    await prisma.embeddingCache.upsert({
      where: { textHash_model: { textHash, model } },
      create: {
        textHash,
        model,
        vector: encoded,
        dims: vector.length,
      },
      update: {
        vector: encoded,
        dims: vector.length,
      },
    });
  },
};
