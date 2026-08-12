-- Substrate §3.4: structured outcome on attempt notes.
--
-- PURELY ADDITIVE, no backfill. NULL = legacy attempt prose with no outcome.
ALTER TABLE "MemoryNote" ADD COLUMN "outcome" TEXT;
