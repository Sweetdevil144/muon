import { beforeEach, describe, expect, it, vi } from "vitest";

// A dead runner leaves its LoopRun "running" forever, and the desktop then
// shows a phantom "iteration N/M · Pause" for a loop nothing executes (found
// live: a row from two days prior). At boot every runner lease predates the
// process, so a running row whose owning job is not running/pending — or that
// never bound a job at all (pre-0051) — settles to aborted with an honest
// reason. Rows whose job the dispatch spine will resume survive untouched.

const dbMock = vi.hoisted(() => ({
  prisma: {
    loopRun: {
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    dispatchJob: {
      findMany: vi.fn(async () => [] as unknown[]),
    },
  },
}));

vi.mock("../src/lib/db.js", () => dbMock);

import { settleOrphanedLoopRuns } from "../src/lib/bootstrap.js";

describe("settleOrphanedLoopRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles unbound legacy rows and rows whose job is terminal; spares live jobs", async () => {
    dbMock.prisma.loopRun.findMany.mockResolvedValueOnce([
      { id: "loop-legacy", dispatchJobId: null },
      { id: "loop-dead", dispatchJobId: "job-done" },
      { id: "loop-live", dispatchJobId: "job-running" },
    ]);
    // Only job-running is still live; job-done is terminal (absent from the
    // running/pending query result).
    dbMock.prisma.dispatchJob.findMany.mockResolvedValueOnce([
      { id: "job-running" },
    ]);

    const settled = await settleOrphanedLoopRuns();

    expect(settled).toBe(2);
    expect(dbMock.prisma.loopRun.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["loop-legacy", "loop-dead"] }, status: "running" },
      data: expect.objectContaining({
        status: "aborted",
        stopReason:
          "settled at boot: the owning run ended without settling this loop",
      }),
    });
  });

  it("does nothing when nothing is running, and never writes for all-live rows", async () => {
    dbMock.prisma.loopRun.findMany.mockResolvedValueOnce([]);
    expect(await settleOrphanedLoopRuns()).toBe(0);
    expect(dbMock.prisma.loopRun.updateMany).not.toHaveBeenCalled();

    dbMock.prisma.loopRun.findMany.mockResolvedValueOnce([
      { id: "loop-live", dispatchJobId: "job-running" },
    ]);
    dbMock.prisma.dispatchJob.findMany.mockResolvedValueOnce([
      { id: "job-running" },
    ]);
    expect(await settleOrphanedLoopRuns()).toBe(0);
    expect(dbMock.prisma.loopRun.updateMany).not.toHaveBeenCalled();
  });
});
