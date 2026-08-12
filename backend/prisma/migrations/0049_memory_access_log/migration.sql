-- TODO 4.12: typed, bounded evidence that memory entered working context.
-- This never feeds authority. MemoryNote.accessCount remains the decayed ranking
-- signal; MemoryAccess exists to distinguish delivery paths and measure whether
-- any one path is associated with later human confirmation.

CREATE TABLE "MemoryAccess" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "noteId" TEXT NOT NULL,
  "accessType" TEXT NOT NULL,
  "principal" TEXT NOT NULL,
  "taskId" TEXT,
  "jobId" TEXT,
  "missionId" TEXT,
  "workspacePath" TEXT,
  "accessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MemoryAccess_noteId_accessedAt_idx"
  ON "MemoryAccess"("noteId", "accessedAt");
CREATE INDEX "MemoryAccess_accessType_accessedAt_idx"
  ON "MemoryAccess"("accessType", "accessedAt");
CREATE INDEX "MemoryAccess_workspacePath_accessedAt_idx"
  ON "MemoryAccess"("workspacePath", "accessedAt");
