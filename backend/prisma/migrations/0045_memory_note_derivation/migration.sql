-- TODO 4.8 / D7: provenance tier on notes before any derivation ships.
--
-- PURELY ADDITIVE, no backfill. NULL derivation = legacy authored statement.
-- NULL reviewStatus = no operator review stamp yet.
ALTER TABLE "MemoryNote" ADD COLUMN "derivation" TEXT;
ALTER TABLE "MemoryNote" ADD COLUMN "reviewStatus" TEXT;
