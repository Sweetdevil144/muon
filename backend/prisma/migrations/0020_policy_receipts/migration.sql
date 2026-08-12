-- P0.4 slice 2: policy profile residence + content-bound receipts. Two
-- ADDITIVE tables; nothing existing changes. Gates stay fail-closed: a missing
-- profile row means today's ask-everything, and a receipt can only ever be
-- redeemed by the exact action + payload digest + workspace + run + manifest
-- it was minted for, before its expiry, unless revoked.

-- Operator-authored workspace policy profile (agents never author policy).
CREATE TABLE "WorkspacePolicyProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspacePath" TEXT NOT NULL,
    "taskScope" TEXT NOT NULL DEFAULT '',
    "profile" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WorkspacePolicyProfile_workspacePath_taskScope_key"
    ON "WorkspacePolicyProfile"("workspacePath", "taskScope");

-- Content-bound, expiring, operator-minted approval receipt.
CREATE TABLE "ApprovalReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approvalId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sessionId" TEXT,
    "workspacePath" TEXT NOT NULL,
    "actionClass" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "manifestFingerprint" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ApprovalReceipt_approvalId_key" ON "ApprovalReceipt"("approvalId");
CREATE INDEX "ApprovalReceipt_jobId_payloadDigest_idx" ON "ApprovalReceipt"("jobId", "payloadDigest");
