CREATE TABLE "MergeRepositoryLease" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "repoRoot" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "leaseExpiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "MergeRepositoryLease_leaseExpiresAt_idx"
ON "MergeRepositoryLease"("leaseExpiresAt");

CREATE UNIQUE INDEX "MergeRepositoryLease_repoRoot_key"
ON "MergeRepositoryLease"("repoRoot");
