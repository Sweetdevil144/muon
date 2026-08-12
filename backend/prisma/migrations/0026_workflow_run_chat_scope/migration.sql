ALTER TABLE "WorkflowRun" ADD COLUMN "chatId" TEXT;

CREATE INDEX "WorkflowRun_chatId_status_createdAt_idx"
ON "WorkflowRun"("chatId", "status", "createdAt");
