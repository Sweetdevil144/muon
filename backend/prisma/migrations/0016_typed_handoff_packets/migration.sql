-- P0.3 typed handoff packets. Nullable for every legacy row; the app layer
-- validates new writes against handoffPacketSchema (@muon/protocol) and treats
-- packet content as agent-produced untrusted data (data-only surfaces).
ALTER TABLE "Handoff" ADD COLUMN "packetJson" JSONB;
-- Terminal packet on the dispatch wire: the runner attaches it at commit;
-- delegates/orchestrator observers read it from the job row.
ALTER TABLE "DispatchJob" ADD COLUMN "packetJson" JSONB;
