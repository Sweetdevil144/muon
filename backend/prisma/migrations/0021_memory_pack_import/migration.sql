-- P1.4 slice 2: memory pack IMPORT provenance. One ADDITIVE table; nothing
-- existing changes. Origin confirmations land ONLY here (data, never authority),
-- so an imported record is structurally incapable of satisfying the
-- confirmed-only gate until a human in the receiving workspace confirms it
-- through the existing flow. (originWorkspace, recordHash) is the
-- anchor-independent idempotence key for re-import/sync.
CREATE TABLE "MemoryImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originWorkspace" TEXT NOT NULL,
    "originLabel" TEXT NOT NULL,
    "originNoteId" TEXT NOT NULL,
    "recordHash" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "noteId" TEXT,
    "disposition" TEXT NOT NULL,
    "originAuthor" TEXT NOT NULL,
    "originConfirmedBy" TEXT NOT NULL,
    "originConfirmedAt" DATETIME NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MemoryImport_originWorkspace_recordHash_key"
    ON "MemoryImport"("originWorkspace", "recordHash");
CREATE INDEX "MemoryImport_noteId_idx" ON "MemoryImport"("noteId");
CREATE INDEX "MemoryImport_originWorkspace_originNoteId_idx"
    ON "MemoryImport"("originWorkspace", "originNoteId");
