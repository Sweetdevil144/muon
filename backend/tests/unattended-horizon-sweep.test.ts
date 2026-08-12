import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNATTENDED_HORIZON_DEFAULT_MS } from "@muon/protocol";

/**
 * ADR-0040 D3, the CONSUMER.
 *
 * The decision module was complete and had zero production callers, so the
 * bound existed on paper while detached execution was unbounded in fact. These
 * pin the wiring, not the arithmetic — `packages/protocol` already owns the
 * verdict and its own tests.
 */

const dbMock = vi.hoisted(() => ({
  prisma: {
    operatorSetting: { findUnique: vi.fn(async () => null as unknown) },
    dispatchJob: { findMany: vi.fn(async () => [] as unknown[]) },
    event: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("../src/lib/db.js", () => dbMock);

const terminalize = vi.hoisted(() => ({
  terminalizeJobLineage: vi.fn(async () => true),
}));
vi.mock("../src/lib/attached-coordinator.js", () => terminalize);

import {
  HORIZON_NEW_ROOT_GRACE_MS,
  readConfiguredHorizonMs,
  sweepUnattendedHorizon,
} from "../src/lib/unattended-horizon.js";
import { ATTACHED_COORDINATOR_CAPABILITY_MODE } from "@muon/protocol";
import {
  daemonAttachState,
  hydrateAttendance,
  noteHumanPresent,
  isAttendingSurface,
  resetAttendanceForTests,
  SURFACE_ATTENDED_FRESH_MS,
} from "../src/lib/surface-attendance.js";

const HOUR = 60 * 60 * 1000;

describe("the unattended horizon sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttendanceForTests();
    dbMock.prisma.operatorSetting.findUnique.mockResolvedValue(null as never);
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([] as never);
    terminalize.terminalizeJobLineage.mockResolvedValue(true as never);
  });

  it("a daemon NOBODY has ever attended still ages and expires", () => {
    // The case that defeated the bound in exactly the scenario it exists for:
    // the brain/runner pair auto-spawned by a `muon` command, which no surface
    // ever attaches to. `lastAttachedAt` is null and it must NOT read as
    // "zero elapsed".
    const state = daemonAttachState(Date.now());
    expect(state.lastAttachedAt).toBeNull();
    expect(state.attached).toBe(false);
    expect(state.detached).toBe(true);
    expect(state.detachedAt).toBeGreaterThan(0);
  });

  it("a SURFACE assertion counts as attendance; ambient traffic never does", () => {
    const now = Date.now();
    expect(daemonAttachState(now).attached).toBe(false);
    noteHumanPresent("tui", now);
    expect(daemonAttachState(now).attached).toBe(true);
    // ...and it goes stale on its own, so a closed laptop detaches.
    expect(
      daemonAttachState(now + SURFACE_ATTENDED_FRESH_MS + 1).attached
    ).toBe(false);
  });

  it("a backwards clock cannot un-attend a live surface", () => {
    const now = Date.now();
    noteHumanPresent("tui", now);
    noteHumanPresent("tui", now - 10 * HOUR);
    expect(daemonAttachState(now).attached).toBe(true);
  });

  it("reaps nothing while a surface is attached", async () => {
    noteHumanPresent("tui");
    const outcome = await sweepUnattendedHorizon();
    expect(outcome.verdict).toBe("not-applicable");
    expect(terminalize.terminalizeJobLineage).not.toHaveBeenCalled();
  });

  it("reaps running ROOTS past the horizon, with the reason and an audit", async () => {
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([
      { id: "job-1", taskId: "task-1" },
    ] as never);
    // Four hours past the process start, with nobody ever attached, against
    // the 3h default.
    const outcome = await sweepUnattendedHorizon(new Date(Date.now() + 4 * HOUR));
    expect(outcome.verdict).toBe("expired");
    expect(outcome.reaped).toEqual(["job-1"]);

    const [, reason] = terminalize.terminalizeJobLineage.mock.calls[0]!;
    expect(reason).toContain("unattended horizon");
    // D4: the gate is NOT granted, and the reason says so where a human reads it.
    expect(reason).toContain("NOT granted");
    expect(reason).toContain("stopped, not failed");

    // Audited against the JOB'S OWN TASK — a surface re-attaches to a task,
    // so an event filed against the daemon in general is one nobody sees.
    const audit = dbMock.prisma.event.create.mock.calls[0]![0] as {
      data: { taskId: string; kind: string };
    };
    expect(audit.data.taskId).toBe("task-1");
    expect(audit.data.kind).toBe("daemon.horizon_expired");
  });

  it("asks for the UNFENCED reach explicitly — which is why it is not started", async () => {
    // The old assertion was `expect(opts).toBeUndefined()`, i.e. it passed for
    // any code that simply omitted the argument. The fence is now a
    // discriminated choice, so an unfenced reap has to SAY so and is
    // greppable. This is also the finding that keeps the sweep disabled: this
    // reach would interrupt a live human's attached-coordinator session,
    // because that surface's heartbeat is agent-tier and never registers as
    // attendance.
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([
      { id: "job-1", taskId: "task-1" },
    ] as never);
    await sweepUnattendedHorizon(new Date(Date.now() + 4 * HOUR));
    const [, , , fence] = terminalize.terminalizeJobLineage.mock.calls[0]!;
    expect(fence).toEqual({ unfenced: true });
  });

  it("IS STARTED by the brain now that attendance is a real signal", async () => {
    // The bound only exists if something runs it. This is the test that would
    // have caught the module shipping as dead code.
    const index = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8")
    );
    const active = index
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(active).toContain("startUnattendedHorizonSweep(");
    // Hydration must come FIRST, or a restart resets the clock and a
    // crash-looping daemon is immortal.
    expect(active.indexOf("hydrateAttendanceFromStore")).toBeLessThan(
      active.indexOf("startUnattendedHorizonSweep(")
    );
  });

  it("an unreadable setting resolves to the DEFAULT, never to the maximum", async () => {
    dbMock.prisma.operatorSetting.findUnique.mockRejectedValue(
      new Error("db is gone") as never
    );
    expect(await readConfiguredHorizonMs()).toBe(UNATTENDED_HORIZON_DEFAULT_MS);
  });

  it("a configured value is honoured, and clamped", async () => {
    dbMock.prisma.operatorSetting.findUnique.mockResolvedValue({
      key: "unattended.horizonMs",
      value: String(6 * HOUR),
    } as never);
    expect(await readConfiguredHorizonMs()).toBe(6 * HOUR);

    // Above the ceiling → the ceiling, not the request.
    dbMock.prisma.operatorSetting.findUnique.mockResolvedValue({
      key: "unattended.horizonMs",
      value: String(100 * HOUR),
    } as never);
    expect(await readConfiguredHorizonMs()).toBe(24 * HOUR);
  });

  it("a garbage setting does not disable the bound", async () => {
    // The failure that matters: an unparseable value must not read as
    // "no horizon". It resolves to the default and the daemon still expires.
    dbMock.prisma.operatorSetting.findUnique.mockResolvedValue({
      key: "unattended.horizonMs",
      value: "forever",
    } as never);
    expect(await readConfiguredHorizonMs()).toBe(UNATTENDED_HORIZON_DEFAULT_MS);
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([
      { id: "job-1", taskId: "task-1" },
    ] as never);
    const outcome = await sweepUnattendedHorizon(new Date(Date.now() + 4 * HOUR));
    expect(outcome.verdict).toBe("expired");
  });
});

describe("ADR-0040 D3a — the defects that kept this disabled", () => {
  // Its own beforeEach: without one, `mock.calls[0]` is a STALE call from the
  // previous describe and the assertions read the wrong sweep.
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttendanceForTests();
    dbMock.prisma.operatorSetting.findUnique.mockResolvedValue(null as never);
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([] as never);
    terminalize.terminalizeJobLineage.mockResolvedValue(true as never);
  });

  it("NEVER reaps an attached coordinator — that session is a human at a terminal", async () => {
    // The worst defect in the first attempt: an attached coordinator's
    // heartbeat is AGENT-tier, so a person working there never refreshed
    // attendance and the sweep would have interrupted them mid-work. That
    // session has its OWN lease sweep (ADR-0028 §4); two liveness models
    // governing one job is how one of them rots.
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([] as never);
    await sweepUnattendedHorizon(new Date(Date.now() + 4 * HOUR));
    const where = dbMock.prisma.dispatchJob.findMany.mock.calls[0]![0].where;
    expect(where.NOT).toEqual({
      capabilityMode: ATTACHED_COORDINATOR_CAPABILITY_MODE,
    });
  });

  it("gives a YOUNG root grace — expiry is the daemon's, not the work's", async () => {
    // Without grace, a mission dispatched into an already-expired daemon is
    // killed within one sweep interval of starting.
    dbMock.prisma.dispatchJob.findMany.mockResolvedValue([] as never);
    const now = new Date(Date.now() + 4 * HOUR);
    await sweepUnattendedHorizon(now);
    const where = dbMock.prisma.dispatchJob.findMany.mock.calls[0]![0].where;
    const cutoff = where.createdAt.lt as Date;
    expect(now.getTime() - cutoff.getTime()).toBe(HORIZON_NEW_ROOT_GRACE_MS);
  });

  it("survives a restart — a hydrated stamp keeps the daemon attended", () => {
    // Process memory alone made a daemon that restarts hourly immortal.
    resetAttendanceForTests();
    const now = Date.now();
    hydrateAttendance(now - 1_000);
    expect(daemonAttachState(now).attached).toBe(true);
  });

  it("refuses a hydrated stamp from the FUTURE", () => {
    resetAttendanceForTests();
    const now = Date.now();
    hydrateAttendance(now + 10 * HOUR);
    // A clock claiming someone will be here in ten hours is a clock to
    // distrust, not a reason to keep spending.
    expect(daemonAttachState(now).attached).toBe(false);
  });

  it("only a KNOWN surface may vouch for a human", () => {
    expect(isAttendingSurface("desktop")).toBe(true);
    expect(isAttendingSurface("tui")).toBe(true);
    expect(isAttendingSurface("cli")).toBe(true);
    expect(isAttendingSurface("runner")).toBe(false);
    expect(isAttendingSurface("")).toBe(false);
  });
});
