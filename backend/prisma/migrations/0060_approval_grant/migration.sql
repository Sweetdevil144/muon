-- ADR-0056: graded durable approval grants — the `always` grade.
-- A receipt binds a RUN (jobId + delegation manifest); a grant binds a CHAT
-- (taskId + policy fingerprint). Separate table so neither authority column set
-- has to become nullable to accommodate the other.
CREATE TABLE "ApprovalGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approvalId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "actionClass" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "resolvedTarget" TEXT,
    "policyFingerprint" TEXT NOT NULL,
    "originJobId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ApprovalGrant_approvalId_key" ON "ApprovalGrant"("approvalId");
CREATE INDEX "ApprovalGrant_taskId_payloadDigest_idx" ON "ApprovalGrant"("taskId", "payloadDigest");
