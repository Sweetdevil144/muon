-- TODO 5.15: give Event a principal, a payload diff, and a request id.
--
-- Event today attributes only via `laneId` + whatever a writer stuffed into
-- `metadata`. MUON already has a Principal table and never joins it from the
-- activity ledger, so "prove a human, not an AI, approved this" requires
-- reconstructing provenance from free-form text. A competitor ships dual-keyed
-- actor + accountable human + payload diff + request id as first-class columns.
--
-- ADDITIVE ONLY. Every new column is nullable with no default: legacy rows stay
-- readable and honest (NULL = "not stamped", never a forged human). No FK onto
-- Principal — Event is append-only and must not refuse a write when a principal
-- row is missing; writers upsert Principal best-effort beside the stamp.
-- No backfill: inventing a principal for historical rows would be a lie.
--
-- Dual-key:
--   principalId / principalKind  — who acted (human | agent)
--   accountablePrincipalId       — which human is accountable (may equal
--                                  principalId when a human acted; may be NULL
--                                  for pre-accountability agent rows)
--   requestId                    — correlates this row with a gate/approval/
--                                  request that produced it
--   payloadDiff                  — JSON before/after (or field patches); never
--                                  secrets, never free-form model prose

ALTER TABLE "Event" ADD COLUMN "principalId" TEXT;
ALTER TABLE "Event" ADD COLUMN "principalKind" TEXT;
ALTER TABLE "Event" ADD COLUMN "accountablePrincipalId" TEXT;
ALTER TABLE "Event" ADD COLUMN "requestId" TEXT;
ALTER TABLE "Event" ADD COLUMN "payloadDiff" TEXT;

CREATE INDEX "Event_principalId_timestamp_idx" ON "Event"("principalId", "timestamp");
CREATE INDEX "Event_requestId_idx" ON "Event"("requestId");
