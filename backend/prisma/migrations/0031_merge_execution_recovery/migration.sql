ALTER TABLE "ApprovalRequest" ADD COLUMN "mergeExecutionStatus" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "mergeExecutionAttemptId" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "mergeExecutionLeaseExpiresAt" DATETIME;
ALTER TABLE "ApprovalRequest" ADD COLUMN "mergeExecution" JSONB;

CREATE INDEX "ApprovalRequest_status_mergeExecutionStatus_mergeExecutionLeaseExpiresAt_idx"
ON "ApprovalRequest"("status", "mergeExecutionStatus", "mergeExecutionLeaseExpiresAt");
