-- ADR-0027 D10-D12: durable, workspace+mission-fenced evidence that two
-- independent crew principals proposed the same normalized claim, plus the
-- human rejection bind that permanently blocks auto-corroboration in that
-- mission. Additive only; legacy single-vouch rows are deliberately not
-- backfilled because one old vouch is not evidence of two independent authors.

CREATE TABLE "MemoryCorroboration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "noteId" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "workspacePath" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "principal" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "MemoryCorroboration_workspacePath_missionId_textHash_principal_key"
  ON "MemoryCorroboration"("workspacePath", "missionId", "textHash", "principal");
CREATE INDEX "MemoryCorroboration_workspacePath_missionId_textHash_idx"
  ON "MemoryCorroboration"("workspacePath", "missionId", "textHash");
CREATE INDEX "MemoryCorroboration_noteId_idx"
  ON "MemoryCorroboration"("noteId");

CREATE TABLE "MemoryRejectBind" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "noteId" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "workspacePath" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "principal" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "MemoryRejectBind_workspacePath_missionId_textHash_key"
  ON "MemoryRejectBind"("workspacePath", "missionId", "textHash");
CREATE INDEX "MemoryRejectBind_noteId_idx" ON "MemoryRejectBind"("noteId");
