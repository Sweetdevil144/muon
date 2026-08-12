ALTER TABLE "LoopRun" ADD COLUMN "dispatchJobId" TEXT;

CREATE UNIQUE INDEX "LoopRun_dispatchJobId_key" ON "LoopRun"("dispatchJobId");
