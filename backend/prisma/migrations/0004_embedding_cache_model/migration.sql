-- KG-3 F2: key the embedding cache by (textHash, model) so a MUON_EMBED_MODEL
-- switch is a natural cache miss (never a cross-embedding-space cosine, which
-- would feed garbage similarity into the dedup thresholds). The cache is a
-- rebuildable projection (every vector recomputes from the note text), so
-- recreating the table loses nothing durable. SQLite cannot ALTER a primary key
-- in place, hence drop + recreate with the composite PK.
DROP TABLE IF EXISTS "EmbeddingCache";
CREATE TABLE "EmbeddingCache" (
    "textHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("textHash", "model")
);
