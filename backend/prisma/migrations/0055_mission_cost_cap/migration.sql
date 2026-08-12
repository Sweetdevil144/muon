-- ADR-0036 D7: the mission dollar cap lives on the CHAT, because a chat mints a
-- new root dispatch job every turn and a cap that reset each turn is not a cap.
ALTER TABLE "OrchestratorChat" ADD COLUMN "costCapUsd" REAL;
ALTER TABLE "OrchestratorChat" ADD COLUMN "costCapSetBy" TEXT;
ALTER TABLE "OrchestratorChat" ADD COLUMN "costCapSetAt" DATETIME;
