ALTER TABLE "Task" ADD COLUMN "chatId" TEXT;

UPDATE "Task"
SET "chatId" = (
  SELECT MIN("DispatchJob"."chatId")
  FROM "DispatchJob"
  WHERE "DispatchJob"."taskId" = "Task"."id"
    AND "DispatchJob"."chatId" IS NOT NULL
)
WHERE "chatId" IS NULL
  AND 1 = (
    SELECT COUNT(DISTINCT "DispatchJob"."chatId")
    FROM "DispatchJob"
    WHERE "DispatchJob"."taskId" = "Task"."id"
      AND "DispatchJob"."chatId" IS NOT NULL
  );

UPDATE "Task"
SET "chatId" = (
  SELECT "OrchestratorChat"."id"
  FROM "OrchestratorChat"
  WHERE "OrchestratorChat"."taskId" = "Task"."id"
  LIMIT 1
)
WHERE "chatId" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "OrchestratorChat"
    WHERE "OrchestratorChat"."taskId" = "Task"."id"
  );

CREATE INDEX "Task_chatId_createdAt_idx"
ON "Task"("chatId", "createdAt");
