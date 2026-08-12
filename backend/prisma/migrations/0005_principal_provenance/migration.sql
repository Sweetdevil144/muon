-- KG-5 provenance: the Principal (human | agent) that AUTHORED / CONFIRMED a
-- memory note. Upserted from MemoryNote.createdBy on ingest (parsing the
-- `human:<id>` / `agent:<vendor>` convention, or the bare legacy form). A note's
-- trust DERIVES from its author principal's trust, the hook KG-6 gates governed
-- multi-principal writes on. The relational row is the source of truth; the graph
-- Principal node + AUTHORED_BY / CONFIRMED_BY edges are a rebuildable projection,
-- so a `.lbug` store wipe → projectLedgerToGraph restores provenance with no loss.
CREATE TABLE "Principal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "vendor" TEXT,
    "trust" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Principal_kind_idx" ON "Principal"("kind");
