-- ADR-0080: the DELIVER ledger — "MUON served packet P to job J".
-- Append-only evidence, never authority (0080 D2): recorded server-side at
-- the packet serve path through the 0088 boundary; surfaces DERIVE delivery
-- verdicts from these rows at read time.
CREATE TABLE "HandoffOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partition" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspacePath" TEXT,
    "principal" TEXT NOT NULL,
    "handoffId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "firstAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "HandoffOffer_jobId_handoffId_key" ON "HandoffOffer"("jobId", "handoffId");
CREATE INDEX "HandoffOffer_partition_firstAt_idx" ON "HandoffOffer"("partition", "firstAt");
CREATE INDEX "HandoffOffer_handoffId_idx" ON "HandoffOffer"("handoffId");
