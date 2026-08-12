-- Restricted recursive delegation: server-derived lineage, hard limits, and
-- the exact work-only child capability manifest.
ALTER TABLE "DispatchJob" ADD COLUMN "parentJobId" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "rootJobId" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationDepth" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DispatchJob" ADD COLUMN "maxDelegationDepth" INTEGER;
ALTER TABLE "DispatchJob" ADD COLUMN "maxChildren" INTEGER;
ALTER TABLE "DispatchJob" ADD COLUMN "maxTotalDescendants" INTEGER;
ALTER TABLE "DispatchJob" ADD COLUMN "maxDelegationIterations" INTEGER;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationChildrenIssued" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationDescendantsIssued" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationBudgetReservedMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationDeadline" DATETIME;
ALTER TABLE "DispatchJob" ADD COLUMN "capabilityMode" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "delegationManifest" JSONB;

CREATE INDEX "DispatchJob_parentJobId_idx" ON "DispatchJob"("parentJobId");
CREATE INDEX "DispatchJob_rootJobId_idx" ON "DispatchJob"("rootJobId");

CREATE TABLE "DelegationGrant" (
  "jobId" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
