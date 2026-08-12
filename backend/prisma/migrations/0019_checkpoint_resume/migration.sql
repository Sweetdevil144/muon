-- P0.1 checkpoint + resume (Slice A): the ledger IS the checkpoint. Three
-- additive nullable columns close the three provable gaps — job→session edge,
-- job→gate edge, and resume lineage. No new store, no new writer: each column
-- is written by an existing route/transaction.
ALTER TABLE "LaneSession"     ADD COLUMN "jobId" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "jobId" TEXT;
ALTER TABLE "DispatchJob"     ADD COLUMN "resumedFromJobId" TEXT;
CREATE INDEX "LaneSession_jobId_idx"          ON "LaneSession"("jobId");
CREATE INDEX "ApprovalRequest_jobId_idx"      ON "ApprovalRequest"("jobId");
CREATE INDEX "DispatchJob_resumedFromJobId_idx" ON "DispatchJob"("resumedFromJobId");

-- Append-once resume claim (P0.1 replay-safety): two additive nullable columns
-- fence the ONE unfenced write path (the resume redispatch). The route claims
-- the original interrupted job with a guarded `updateMany` (WHERE resumedAt IS
-- NULL) in the same transaction as the fresh child's create — so a second
-- resume of the same original is refused instead of minting a duplicate child.
-- Claimed by primary key (`id`), so no extra index is needed. This migration
-- has not shipped; the columns extend it rather than minting a new 0020.
ALTER TABLE "DispatchJob" ADD COLUMN "resumedAt" DATETIME;
ALTER TABLE "DispatchJob" ADD COLUMN "resumedByJobId" TEXT;
