import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A REAL SQLite test (no Prisma mock), like embedded-sqlite.test.ts: boot
// reconciliation is a WRITE against the operator's own database, so the property
// that matters — it retires and never deletes, and a second boot is a no-op — is
// only worth asserting against the real engine.
//
// The fixture is the founder's actual database shape after a vendor was removed
// from the registry: five Lane rows and five vendors' worth of fleet seats, with
// real work (task → assignment → dispatch job) hanging off the row that is about
// to be retired.

let prisma: (typeof import("../src/lib/db.js"))["prisma"];
let ensureDefaultLanes: (typeof import("../src/lib/bootstrap.js"))["ensureDefaultLanes"];
let retireUnregisteredLanes: (typeof import("../src/lib/vendor-lanes.js"))["retireUnregisteredLanes"];
let availableLaneKeys: (typeof import("../src/lib/vendor-lanes.js"))["availableLaneKeys"];
let availableLaneWhere: (typeof import("../src/lib/vendor-lanes.js"))["availableLaneWhere"];
let RETIRED: string;
let dir: string;

/** The removed vendor, standing in for whichever lane leaves the registry next. */
const GONE = "ollama";

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-lane-retire-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();

  const bootstrap = await import("../src/lib/bootstrap.js");
  ensureDefaultLanes = bootstrap.ensureDefaultLanes;
  const vendorLanes = await import("../src/lib/vendor-lanes.js");
  retireUnregisteredLanes = vendorLanes.retireUnregisteredLanes;
  availableLaneKeys = vendorLanes.availableLaneKeys;
  availableLaneWhere = vendorLanes.availableLaneWhere;
  RETIRED = vendorLanes.RETIRED_LANE_STATUS;

  await ensureDefaultLanes();

  // The leftover: a lane + fleet seat for a vendor the registry no longer names,
  // exactly as an earlier build seeded it — status still "available".
  await prisma.lane.create({
    data: {
      id: "lane-gone",
      key: GONE,
      name: "Ollama",
      provider: GONE,
      role: "worker",
    },
  });
  await prisma.agent.create({
    data: { id: "agent-gone", vendor: GONE, name: `${GONE}-1`, ordinal: 1 },
  });
  // Real history on that lane: it must survive retirement intact.
  await prisma.task.create({
    data: {
      id: "task-gone",
      title: "Ran on the lane that was removed",
      description: "History that must keep resolving after the vendor is gone.",
    },
  });
  await prisma.assignment.create({
    data: {
      id: "assignment-gone",
      taskId: "task-gone",
      laneId: "lane-gone",
      summary: "Work that actually ran on the removed lane.",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("boot reconciliation retires lanes the registry no longer names", () => {
  it("seeds exactly the registered lanes and leaves the stale row for the reconciler", async () => {
    const seeded = await prisma.lane.findMany({ select: { key: true } });
    expect(seeded.map((lane) => lane.key).sort()).toEqual(
      [...availableLaneKeys(), GONE].sort()
    );
  });

  it("stamps the unregistered lane retired, and is a no-op on the second boot", async () => {
    expect(await retireUnregisteredLanes()).toBe(1);
    // Boot twice, same result: the second pass matches zero rows because the
    // guard excludes rows that already carry the marker.
    expect(await retireUnregisteredLanes()).toBe(0);

    const gone = await prisma.lane.findUnique({ where: { key: GONE } });
    expect(gone?.status).toBe(RETIRED);
  });

  it("does not fight the seeding path that runs beside it", async () => {
    // The real boot order, run again end to end. The seed owns the registered
    // keys, the reconciler owns the rest, and neither touches the other's set —
    // so no boot can flip a lane back and forth.
    await ensureDefaultLanes();
    expect(await retireUnregisteredLanes()).toBe(0);

    const registered = await prisma.lane.findMany({
      where: availableLaneWhere(),
      select: { status: true },
    });
    expect(registered).toHaveLength(availableLaneKeys().length);
    expect(registered.every((lane) => lane.status === "available")).toBe(true);
    expect((await prisma.lane.findUnique({ where: { key: GONE } }))?.status).toBe(
      RETIRED
    );
  });

  it("retires, never deletes — every row referencing the lane survives", async () => {
    // Nothing was orphaned: the task, its assignment and the fleet seat are all
    // still there, and the assignment still joins to the lane it ran on.
    const assignment = await prisma.assignment.findUnique({
      where: { id: "assignment-gone" },
      include: { lane: true },
    });
    expect(assignment?.lane.name).toBe("Ollama");
    expect(assignment?.lane.key).toBe(GONE);
    expect(await prisma.agent.findUnique({ where: { id: "agent-gone" } })).not.toBeNull();
    expect(await prisma.task.findUnique({ where: { id: "task-gone" } })).not.toBeNull();
  });

  it("the available-lane read derives from the registry, never from the marker", async () => {
    // The whole point of the mechanism: put the row back in the state an older
    // build would leave it in — present, unregistered, and still claiming to be
    // available — and it is STILL absent from the available set. The marker is
    // advisory; the registry is the answer.
    await prisma.lane.update({
      where: { key: GONE },
      data: { status: "available" },
    });

    const available = await prisma.lane.findMany({
      where: availableLaneWhere(),
      select: { key: true },
    });
    expect(available.map((lane) => lane.key)).not.toContain(GONE);
    expect(available).toHaveLength(availableLaneKeys().length);

    // …and the next boot re-stamps it, so the two agree again.
    expect(await retireUnregisteredLanes()).toBe(1);
  });
});
