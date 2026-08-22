-- ADR-0060: the offer ledger — "MUON offered note N to job J", recorded
-- server-side inside the serve paths. Append-only evidence, never authority;
-- a decision's derived_from set is derived from these rows at query time.
CREATE TABLE "MemoryOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partition" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspacePath" TEXT,
    "principal" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "firstAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "MemoryOffer_jobId_noteId_key" ON "MemoryOffer"("jobId", "noteId");
CREATE INDEX "MemoryOffer_partition_firstAt_idx" ON "MemoryOffer"("partition", "firstAt");
CREATE INDEX "MemoryOffer_noteId_idx" ON "MemoryOffer"("noteId");
