-- 0056 — a claim names a COORDINATE, not a file (design §5.2 `WorkClaim`).
--
-- `path` becomes `coordinate` + `coordinateKind`, and `workspacePath` becomes
-- required so a claim can be fenced. A claim is a 30-minute ADVISORY lease, so
-- rows that cannot be resolved to a workspace are dropped rather than carried
-- forward with a lie: an unfenced claim is exactly the false-collision source
-- this column exists to remove, and anything dropped here would have expired
-- within the half hour anyway.

CREATE TABLE "new_FileClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspacePath" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "coordinateKind" TEXT NOT NULL DEFAULT 'path',
    "coordinate" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "releasedAt" DATETIME
);

INSERT INTO "new_FileClaim" (
    "id", "workspacePath", "chatId", "missionId", "jobId",
    "coordinateKind", "coordinate", "intent", "role", "vendor",
    "createdAt", "expiresAt", "releasedAt"
)
SELECT
    c."id",
    j."workspacePath",
    c."chatId",
    c."missionId",
    c."jobId",
    'path',
    c."path",
    c."intent",
    c."role",
    c."vendor",
    c."createdAt",
    c."expiresAt",
    c."releasedAt"
FROM "FileClaim" c
JOIN "DispatchJob" j ON j."id" = c."jobId"
WHERE j."workspacePath" IS NOT NULL AND j."workspacePath" <> '';

DROP TABLE "FileClaim";
ALTER TABLE "new_FileClaim" RENAME TO "FileClaim";

CREATE INDEX "FileClaim_workspacePath_chatId_coordinate_idx"
    ON "FileClaim"("workspacePath", "chatId", "coordinate");
CREATE INDEX "FileClaim_jobId_releasedAt_idx"
    ON "FileClaim"("jobId", "releasedAt");
