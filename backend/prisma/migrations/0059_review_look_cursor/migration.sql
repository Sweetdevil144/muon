-- H1 (2026-08 cycle): durable per-principal review read cursor.
CREATE TABLE "ReviewLookCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "principal" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "lastLookedAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ReviewLookCursor_principal_targetKind_targetId_key" ON "ReviewLookCursor"("principal", "targetKind", "targetId");
