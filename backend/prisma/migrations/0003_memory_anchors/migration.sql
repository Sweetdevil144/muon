-- CreateTable
CREATE TABLE "MemoryAnchor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "MemoryAnchor_kind_value_idx" ON "MemoryAnchor"("kind", "value");

-- CreateIndex
CREATE INDEX "MemoryAnchor_noteId_idx" ON "MemoryAnchor"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryAnchor_noteId_kind_value_key" ON "MemoryAnchor"("noteId", "kind", "value");
