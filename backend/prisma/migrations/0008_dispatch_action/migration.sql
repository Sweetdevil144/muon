-- ADR-0013 #52 v2 (vendor-native action surface, REAL dispatch): a vendor action
-- is resolved + guard-enforced at the dispatch ROUTE, then rides on the job so
-- the runner applies it at execution. `action` records the resolved action id
-- (provenance); `actionProfilePatch` merges into the compiled LaneProfile;
-- `actionArgvOverride` overrides the one-shot taskCommand (subcommand channel);
-- `actionBriefPrefix` prepends to the brief. Additive + nullable, no backfill:
-- every existing / plain dispatch keeps NULL. Postgres-compatible.
ALTER TABLE "DispatchJob" ADD COLUMN "action" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "actionProfilePatch" JSONB;
ALTER TABLE "DispatchJob" ADD COLUMN "actionArgvOverride" JSONB;
ALTER TABLE "DispatchJob" ADD COLUMN "actionBriefPrefix" TEXT;
