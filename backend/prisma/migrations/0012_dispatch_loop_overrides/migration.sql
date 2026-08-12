-- Task-scoped loop overrides: additive + nullable so existing jobs continue
-- to use reusable harness checks and the loop engine's default iteration timeout.
ALTER TABLE "DispatchJob" ADD COLUMN "checks" JSONB;
ALTER TABLE "DispatchJob" ADD COLUMN "iterationTimeoutMs" INTEGER;
