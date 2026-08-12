-- Session controls are persisted on the durable job so resume and fail-closed
-- approval timing survive the calling CLI/chat process.
ALTER TABLE "DispatchJob" ADD COLUMN "resumeVendorSessionId" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "approvalTimeoutMs" INTEGER;
