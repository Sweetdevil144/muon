-- ADR-0018 R2: durable, typed loop-control progress. Additive + nullable so
-- existing loop rows and older callers retain their prior behavior.
ALTER TABLE "LoopRun" ADD COLUMN "progress" JSONB;
