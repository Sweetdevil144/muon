-- Older MUON builds allowed several queued/running roots for one chat. Creating
-- the unique index over such an install would brick startup. The state is
-- ambiguous, so fail closed: interrupt every active duplicate root and its
-- queued/running descendants, release their claimed seats/sessions, and leave
-- the human to start one fresh turn from the durable chat history.
--
-- Repeat the recursive CTE per statement because the embedded migrator executes
-- migrations as individual statements inside one transaction.
WITH RECURSIVE
"DuplicateRoot"("id") AS (
  SELECT "job"."id"
  FROM "DispatchJob" AS "job"
  INNER JOIN (
    SELECT "chatId"
    FROM "DispatchJob"
    WHERE "chatId" IS NOT NULL
      AND "parentJobId" IS NULL
      AND "status" IN ('queued', 'running')
    GROUP BY "chatId"
    HAVING COUNT(*) > 1
  ) AS "duplicate" ON "duplicate"."chatId" = "job"."chatId"
  WHERE "job"."parentJobId" IS NULL
    AND "job"."status" IN ('queued', 'running')
),
"DoomedJob"("id") AS (
  SELECT "id" FROM "DuplicateRoot"
  UNION
  SELECT "child"."id"
  FROM "DispatchJob" AS "child"
  INNER JOIN "DoomedJob" AS "parent" ON "child"."parentJobId" = "parent"."id"
)
UPDATE "Agent"
SET "status" = 'idle',
    "currentTaskId" = NULL,
    "currentJobId" = NULL,
    "sessionId" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "currentJobId" IN (SELECT "id" FROM "DoomedJob");

WITH RECURSIVE
"DuplicateRoot"("id") AS (
  SELECT "job"."id"
  FROM "DispatchJob" AS "job"
  INNER JOIN (
    SELECT "chatId"
    FROM "DispatchJob"
    WHERE "chatId" IS NOT NULL
      AND "parentJobId" IS NULL
      AND "status" IN ('queued', 'running')
    GROUP BY "chatId"
    HAVING COUNT(*) > 1
  ) AS "duplicate" ON "duplicate"."chatId" = "job"."chatId"
  WHERE "job"."parentJobId" IS NULL
    AND "job"."status" IN ('queued', 'running')
),
"DoomedJob"("id") AS (
  SELECT "id" FROM "DuplicateRoot"
  UNION
  SELECT "child"."id"
  FROM "DispatchJob" AS "child"
  INNER JOIN "DoomedJob" AS "parent" ON "child"."parentJobId" = "parent"."id"
)
UPDATE "LaneSession"
SET "status" = 'interrupted',
    "endedAt" = COALESCE("endedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "jobId" IN (SELECT "id" FROM "DoomedJob")
  AND "status" = 'running';

WITH RECURSIVE
"DuplicateRoot"("id") AS (
  SELECT "job"."id"
  FROM "DispatchJob" AS "job"
  INNER JOIN (
    SELECT "chatId"
    FROM "DispatchJob"
    WHERE "chatId" IS NOT NULL
      AND "parentJobId" IS NULL
      AND "status" IN ('queued', 'running')
    GROUP BY "chatId"
    HAVING COUNT(*) > 1
  ) AS "duplicate" ON "duplicate"."chatId" = "job"."chatId"
  WHERE "job"."parentJobId" IS NULL
    AND "job"."status" IN ('queued', 'running')
),
"DoomedJob"("id") AS (
  SELECT "id" FROM "DuplicateRoot"
  UNION
  SELECT "child"."id"
  FROM "DispatchJob" AS "child"
  INNER JOIN "DoomedJob" AS "parent" ON "child"."parentJobId" = "parent"."id"
)
UPDATE "DispatchJob"
SET "status" = 'interrupted',
    "interruptRequested" = 1,
    "endedAt" = COALESCE("endedAt", CURRENT_TIMESTAMP),
    "result" = COALESCE(
      "result",
      'Interrupted during migration: this chat had multiple active root dispatches from an older MUON build.'
    ),
    "delegationBudgetReservedMs" = CASE
      WHEN "parentJobId" IS NULL THEN 0
      ELSE "delegationBudgetReservedMs"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM "DoomedJob")
  AND "status" IN ('queued', 'running');

-- A chat may now have at most one queued/running root dispatch. The route's
-- serializable preflight improves the error message; this partial index is the
-- atomic authority when two processes race between their reads and writes.
CREATE UNIQUE INDEX "DispatchJob_one_active_root_per_chat"
ON "DispatchJob"("chatId")
WHERE "chatId" IS NOT NULL
  AND "parentJobId" IS NULL
  AND "status" IN ('queued', 'running');
