-- TODO 5.5: durable, append-only evidence of what MUON supplied to a vendor.
-- ContextFrame is immutable; delivery is a separate terminal receipt so an
-- interrupted write cannot upgrade a merely queued frame by mutation.

CREATE TABLE "ContextFrame" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientRequestId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "laneId" TEXT NOT NULL,
  "workspacePath" TEXT,
  "chatId" TEXT,
  "missionId" TEXT NOT NULL,
  "turnSeq" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "completeness" TEXT NOT NULL DEFAULT 'muon_supplied',
  "content" TEXT NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "charCount" INTEGER NOT NULL,
  "tokenEstimate" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ContextFrame_jobId_clientRequestId_key"
  ON "ContextFrame"("jobId", "clientRequestId");
CREATE UNIQUE INDEX "ContextFrame_jobId_turnSeq_key"
  ON "ContextFrame"("jobId", "turnSeq");
CREATE INDEX "ContextFrame_taskId_createdAt_idx"
  ON "ContextFrame"("taskId", "createdAt");
CREATE INDEX "ContextFrame_missionId_createdAt_idx"
  ON "ContextFrame"("missionId", "createdAt");

CREATE TABLE "ContextExposure" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "frameId" TEXT NOT NULL,
  "artifactKind" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "eligible" BOOLEAN NOT NULL,
  "included" BOOLEAN NOT NULL,
  "reason" TEXT NOT NULL,
  "ordinal" INTEGER,
  "charCount" INTEGER,
  "trustTier" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ContextExposure_frameId_artifactKind_artifactId_reason_key"
  ON "ContextExposure"("frameId", "artifactKind", "artifactId", "reason");
CREATE INDEX "ContextExposure_artifactKind_artifactId_idx"
  ON "ContextExposure"("artifactKind", "artifactId");

CREATE TABLE "ContextFrameDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "frameId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sessionId" TEXT,
  "vendorSessionId" TEXT,
  "failure" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ContextFrameDelivery_frameId_key"
  ON "ContextFrameDelivery"("frameId");

CREATE TABLE "ContextCondensation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "jobId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "inputFrameId" TEXT,
  "outputFrameId" TEXT,
  "origin" TEXT NOT NULL,
  "sourceResponseId" TEXT NOT NULL,
  "summary" TEXT,
  "summaryOffset" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ContextCondensation_jobId_sourceResponseId_key"
  ON "ContextCondensation"("jobId", "sourceResponseId");
CREATE INDEX "ContextCondensation_taskId_createdAt_idx"
  ON "ContextCondensation"("taskId", "createdAt");

CREATE TABLE "ContextCondensationMember" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "condensationId" TEXT NOT NULL,
  "artifactKind" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ContextCondensationMember_condensationId_artifactKind_artifactId_key"
  ON "ContextCondensationMember"("condensationId", "artifactKind", "artifactId");
CREATE INDEX "ContextCondensationMember_artifactKind_artifactId_idx"
  ON "ContextCondensationMember"("artifactKind", "artifactId");
