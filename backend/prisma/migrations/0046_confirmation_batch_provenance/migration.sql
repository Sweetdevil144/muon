-- Bulk memory removal provenance: batchId groups reversible expire sweeps;
-- reason is operator-authored audit text (bounded at the route layer).
ALTER TABLE "Confirmation" ADD COLUMN "batchId" TEXT;
ALTER TABLE "Confirmation" ADD COLUMN "reason" TEXT;

CREATE INDEX "Confirmation_batchId_idx" ON "Confirmation"("batchId");
