CREATE TABLE "GovernedSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "model" TEXT,
    "effort" TEXT,
    "cadenceMinutes" INTEGER,
    "nextRunAt" DATETIME NOT NULL,
    "maxRuns" INTEGER,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "maxWallMs" INTEGER NOT NULL,
    "maxDescendantWallMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastStartedAt" DATETIME,
    "lastEndedAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ScheduleOccurrence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "chatId" TEXT,
    "rootJobId" TEXT,
    "error" TEXT,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    CONSTRAINT "ScheduleOccurrence_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "GovernedSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GovernedSchedule_status_nextRunAt_idx" ON "GovernedSchedule"("status", "nextRunAt");
CREATE INDEX "GovernedSchedule_workspacePath_createdAt_idx" ON "GovernedSchedule"("workspacePath", "createdAt");
CREATE UNIQUE INDEX "ScheduleOccurrence_scheduleId_scheduledFor_key" ON "ScheduleOccurrence"("scheduleId", "scheduledFor");
CREATE INDEX "ScheduleOccurrence_status_claimedAt_idx" ON "ScheduleOccurrence"("status", "claimedAt");
CREATE INDEX "ScheduleOccurrence_chatId_idx" ON "ScheduleOccurrence"("chatId");
