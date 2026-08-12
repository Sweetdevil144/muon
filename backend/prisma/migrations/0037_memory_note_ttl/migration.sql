-- R3 TTL / expiration for low-trust agent notes (mem0 §6 `expiration_date`).
--
-- PURELY ADDITIVE, no backfill. Two nullable columns plus one index; every
-- pre-0037 row keeps working unchanged because NULL `expiresAt` means "never
-- expires", which is exactly the pre-TTL behaviour. Every older client keeps
-- working too: the fields are optional on the wire and ignored by readers that
-- do not know them.
--
-- Why not reuse `validTo`: valid time states when the FACT stops holding, and
-- the bitemporal as-of read interprets it that way. A TTL states that MUON stops
-- vouching for an unreviewed agent guess — the fact may still be true. Reusing
-- `validTo` would make an as-of query claim the fact became false at the TTL
-- boundary, and would make "confirming clears the expiry" erase a genuine
-- human-stated valid-time end.
--
--   expiresAt — the policy deadline, stamped at INGEST only on a note that is
--     unconfirmed AND agent-authored AND at-or-below the operator trust ceiling.
--     Cleared when a human confirms the note or raises it to high trust.
--   expiredAt — the sweeper's materialized eviction marker. Audit + graph mirror
--     + the bounded sweep's idempotent cursor ONLY; no read path keys on it, so
--     recall stays correct even if the sweeper never runs.
--
-- Expiry HIDES, it never deletes. The row, its text, its Confirmation ledger and
-- its supersede history are all retained (the tombstone/soft-state model this
-- bi-temporal ledger already uses everywhere else).
ALTER TABLE "MemoryNote" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "MemoryNote" ADD COLUMN "expiredAt" DATETIME;

-- The sweeper's bounded scan: `expiresAt <= now AND expiredAt IS NULL`.
CREATE INDEX "MemoryNote_expiresAt_expiredAt_idx" ON "MemoryNote"("expiresAt", "expiredAt");
