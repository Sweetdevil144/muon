-- Enterprise inbound leads from the marketing site (/enterprise).
-- Shape matches model EnterpriseContact in schema.prisma. Unused by the
-- embedded local brain; marketing writes to the same table on Railway Postgres.
CREATE TABLE "EnterpriseContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fullName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "companyEmail" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "problemDescription" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'marketing_site',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "EnterpriseContact_companyEmail_idx" ON "EnterpriseContact"("companyEmail");
CREATE INDEX "EnterpriseContact_createdAt_idx" ON "EnterpriseContact"("createdAt");
CREATE INDEX "EnterpriseContact_status_createdAt_idx" ON "EnterpriseContact"("status", "createdAt");
