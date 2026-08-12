-- CreateTable
CREATE TABLE "Lane" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LaneProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LaneProfile_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "Lane" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LaneSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "vendorSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LaneSession_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "Lane" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "workflowRunId" TEXT,
    "stepKey" TEXT,
    "workspacePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "laneId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "Assignment_laneId_fkey" FOREIGN KEY ("laneId") REFERENCES "Lane" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "fromLaneId" TEXT NOT NULL,
    "toLaneId" TEXT NOT NULL,
    "packetTitle" TEXT NOT NULL,
    "packetBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Handoff_fromLaneId_fkey" FOREIGN KEY ("fromLaneId") REFERENCES "Lane" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Handoff_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Handoff_toLaneId_fkey" FOREIGN KEY ("toLaneId") REFERENCES "Lane" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "laneId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decisionNotes" TEXT,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    CONSTRAINT "ApprovalRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Harness" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL DEFAULT 'human',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'human',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateKey" TEXT,
    "templateVersion" INTEGER,
    "request" TEXT NOT NULL,
    "workspacePath" TEXT,
    "proposal" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposedBy" TEXT NOT NULL DEFAULT 'heuristic',
    "appliedBy" TEXT,
    "appliedAt" DATETIME,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StreamChunk" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" TEXT NOT NULL,
    "laneId" TEXT NOT NULL,
    "agentId" TEXT,
    "sessionId" TEXT,
    "runId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'output',
    "content" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrchestratorChat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "taskId" TEXT,
    "vendorSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendor" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "currentTaskId" TEXT,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DispatchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'auto',
    "vendor" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "harnessKey" TEXT,
    "workspacePath" TEXT,
    "chatId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "agentId" TEXT,
    "host" TEXT,
    "dispatchedBy" TEXT NOT NULL DEFAULT 'orchestrator',
    "interruptRequested" BOOLEAN NOT NULL DEFAULT false,
    "steerMessages" JSONB,
    "result" TEXT,
    "exitCode" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Runner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "pid" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'online',
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LoopRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "workflowRunId" TEXT,
    "stepKey" TEXT,
    "harnessKey" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'check_repair',
    "budget" JSONB NOT NULL,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stopReason" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Lane_key_key" ON "Lane"("key");

-- CreateIndex
CREATE UNIQUE INDEX "LaneProfile_laneId_key" ON "LaneProfile"("laneId");

-- CreateIndex
CREATE INDEX "LaneSession_taskId_startedAt_idx" ON "LaneSession"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "Task_workflowRunId_idx" ON "Task"("workflowRunId");

-- CreateIndex
CREATE INDEX "Event_taskId_timestamp_idx" ON "Event"("taskId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Harness_key_key" ON "Harness"("key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_key_key" ON "WorkflowTemplate"("key");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_createdAt_idx" ON "WorkflowRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StreamChunk_taskId_seq_idx" ON "StreamChunk"("taskId", "seq");

-- CreateIndex
CREATE INDEX "StreamChunk_runId_seq_idx" ON "StreamChunk"("runId", "seq");

-- CreateIndex
CREATE INDEX "StreamChunk_agentId_seq_idx" ON "StreamChunk"("agentId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_vendor_ordinal_key" ON "Agent"("vendor", "ordinal");

-- CreateIndex
CREATE INDEX "DispatchJob_status_createdAt_idx" ON "DispatchJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LoopRun_taskId_startedAt_idx" ON "LoopRun"("taskId", "startedAt");

