-- Task-scoped dispatch budgets: additive + nullable so existing jobs and
-- callers continue to use their harness defaults.
ALTER TABLE "DispatchJob" ADD COLUMN "maxIterations" INTEGER;
ALTER TABLE "DispatchJob" ADD COLUMN "maxWallMs" INTEGER;
