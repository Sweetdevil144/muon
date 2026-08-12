ALTER TABLE "StreamChunk" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "StreamChunk_taskId_dedupeKey_key"
ON "StreamChunk"("taskId", "dedupeKey");
