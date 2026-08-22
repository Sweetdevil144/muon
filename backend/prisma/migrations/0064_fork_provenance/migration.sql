-- ADR-0044/0071 — fork provenance. A fork is a NEW mission branched from a
-- RECORDED step (a terminal job): forkedFromJobId is the audit edge (D6),
-- forkSourceTaskId the materialization pointer the runner seeds the fresh
-- worktree from (D5). Neither carries authority, budget, claims, or standing
-- (D1/D2/D3 — everything is re-derived at create).
ALTER TABLE "DispatchJob" ADD COLUMN "forkedFromJobId" TEXT;
ALTER TABLE "DispatchJob" ADD COLUMN "forkSourceTaskId" TEXT;
ALTER TABLE "Task" ADD COLUMN "forkSourceTaskId" TEXT;

CREATE INDEX "DispatchJob_forkedFromJobId_idx" ON "DispatchJob"("forkedFromJobId");
