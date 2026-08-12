-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceType" TEXT NOT NULL,
    "rawRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MemoryNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'project',
    "trust" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'active',
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" DATETIME,
    "validFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" DATETIME,
    "supersededBy" TEXT,
    "staleSince" DATETIME,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "taskId" TEXT,
    "laneId" TEXT,
    "modules" JSONB NOT NULL,
    "topics" JSONB NOT NULL,
    "episodeId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MemoryEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "weight" REAL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Confirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EmbeddingCache" (
    "textHash" TEXT NOT NULL PRIMARY KEY,
    "vector" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "MemoryNote_status_kind_idx" ON "MemoryNote"("status", "kind");

-- CreateIndex
CREATE INDEX "MemoryNote_textHash_idx" ON "MemoryNote"("textHash");

-- CreateIndex
CREATE INDEX "MemoryNote_taskId_idx" ON "MemoryNote"("taskId");

-- CreateIndex
CREATE INDEX "MemoryNote_laneId_idx" ON "MemoryNote"("laneId");

-- CreateIndex
CREATE INDEX "MemoryEdge_fromId_idx" ON "MemoryEdge"("fromId");

-- CreateIndex
CREATE INDEX "MemoryEdge_toId_idx" ON "MemoryEdge"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEdge_fromId_toId_kind_key" ON "MemoryEdge"("fromId", "toId", "kind");

-- CreateIndex
CREATE INDEX "Confirmation_noteId_idx" ON "Confirmation"("noteId");
