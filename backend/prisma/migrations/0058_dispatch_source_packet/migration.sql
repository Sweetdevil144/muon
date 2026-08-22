-- A5 (2026-08 cycle): re-dispatch cites its source handoff packet.
-- Additive, nullable, no FK — lineage/audit only, guarded at the route.
ALTER TABLE "DispatchJob" ADD COLUMN "sourcePacketId" TEXT;
CREATE INDEX "DispatchJob_sourcePacketId_idx" ON "DispatchJob"("sourcePacketId");
