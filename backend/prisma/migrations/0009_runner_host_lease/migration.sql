-- A runner host is a local lease identity. Deduplicate historical rows by
-- keeping the freshest heartbeat, then enforce one row per host so simultaneous
-- first heartbeats cannot create two live owners. SQLite + Postgres compatible.
ALTER TABLE "Runner" ADD COLUMN "leaseHash" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "runnerLeaseHash" TEXT;
ALTER TABLE "Agent" ADD COLUMN "currentJobId" TEXT;

-- Preserve in-flight ownership across upgrade. If historical corruption left
-- more than one running job on one agent, bind the freshest; reclaim requeues
-- every prior job, and the exact currentJobId fence releases the agent once.
UPDATE "Agent"
SET "currentJobId" = (
  SELECT "DispatchJob"."id"
  FROM "DispatchJob"
  WHERE "DispatchJob"."agentId" = "Agent"."id"
    AND "DispatchJob"."status" = 'running'
  ORDER BY "DispatchJob"."startedAt" DESC, "DispatchJob"."createdAt" DESC
  LIMIT 1
)
WHERE "status" = 'working';

DELETE FROM "Runner"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "host"
        ORDER BY "lastSeenAt" DESC, "createdAt" DESC, "id" DESC
      ) AS "leaseRank"
    FROM "Runner"
  ) AS "ranked"
  WHERE "leaseRank" > 1
);

CREATE UNIQUE INDEX "Runner_host_key" ON "Runner"("host");
CREATE UNIQUE INDEX "Runner_leaseHash_key" ON "Runner"("leaseHash");
CREATE UNIQUE INDEX "Agent_currentJobId_key" ON "Agent"("currentJobId");
CREATE INDEX "DispatchJob_host_status_idx" ON "DispatchJob"("host", "status");
