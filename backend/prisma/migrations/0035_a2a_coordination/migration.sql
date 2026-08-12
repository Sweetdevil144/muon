-- A2A (agent-to-agent coordination) + role assignment. Four ADDITIVE changes;
-- nothing existing is rewritten, and every pre-A2A row keeps working: a job with
-- a NULL role simply has no crew identity and is refused at the A2A routes.

-- The crew role a job RUNS AS. An identity label, never an authority: role
-- narrowing stays in narrowProfileForRole/assertProfileMatchesRole at launch.
ALTER TABLE "DispatchJob" ADD COLUMN "role" TEXT;

-- Operator-authored role plan for one chat (agents never author a binding).
CREATE TABLE "CrewRoleBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "fit" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL DEFAULT 'muon',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CrewRoleBinding_chatId_role_key"
    ON "CrewRoleBinding"("chatId", "role");
CREATE INDEX "CrewRoleBinding_chatId_idx" ON "CrewRoleBinding"("chatId");

-- One peer message. Identity/scope columns are server-derived from the exact-job
-- bearer; subject/body are untrusted agent text. Bounded to one chat AND one
-- mission, so there is no cross-chat and no cross-mission edge. `readAt` is
-- display metadata for a directly-addressed message; delivery correctness is
-- the per-job cursor below.
CREATE TABLE "PeerMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "fromJobId" TEXT NOT NULL,
    "fromRole" TEXT NOT NULL,
    "fromVendor" TEXT NOT NULL,
    "fromName" TEXT,
    "toKind" TEXT NOT NULL,
    "toJobId" TEXT,
    "toRole" TEXT,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "refs" JSONB NOT NULL,
    "replyTo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME
);
CREATE INDEX "PeerMessage_chatId_missionId_createdAt_idx"
    ON "PeerMessage"("chatId", "missionId", "createdAt");
CREATE INDEX "PeerMessage_toJobId_readAt_idx"
    ON "PeerMessage"("toJobId", "readAt");

-- Per-job delivery cursor. Each peer reads its mission's traffic forward
-- independently, so a role/crew broadcast reaches every recipient exactly once.
-- The cursor is a TUPLE: a timestamp alone would skip a same-millisecond peer.
CREATE TABLE "PeerInboxCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "lastReadAt" DATETIME NOT NULL,
    "lastReadMessageId" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PeerInboxCursor_jobId_key" ON "PeerInboxCursor"("jobId");
CREATE INDEX "PeerInboxCursor_chatId_missionId_idx"
    ON "PeerInboxCursor"("chatId", "missionId");

-- Advisory, expiring file lease. A released or expired row is inert.
CREATE TABLE "FileClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "releasedAt" DATETIME
);
CREATE INDEX "FileClaim_chatId_missionId_path_idx"
    ON "FileClaim"("chatId", "missionId", "path");
CREATE INDEX "FileClaim_jobId_releasedAt_idx"
    ON "FileClaim"("jobId", "releasedAt");
