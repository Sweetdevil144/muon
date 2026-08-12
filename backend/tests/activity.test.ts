import { describe, expect, it, vi } from "vitest";
import type { PreEditActivity } from "@muon/graph";
import {
  RECENT_ACTIVITY_WINDOW_MS,
  readActivity,
  readLiveActivity,
} from "../src/lib/activity.js";

// KG-7 (ADR-0014 §6), the LIVE cross-agent activity reader. Deterministic: a
// faithful in-memory Prisma FAKE (no DB, no network) models exactly the two reads
// the reader relies on, `dispatchJob.findMany({ where:{status:'running', NOT self}
// , select:<coords> })` and `event.findMany({ where:{taskId}, orderBy desc, take,
// select:<coords> })`, so running/not-running, anchor intersection, symbol-over-
// module preference, self-exclusion, and the COORDINATES-ONLY side-channel are all
// exercised against the same behaviour the route depends on.

type JobRow = {
  id: string;
  status: string;
  vendor: string;
  taskId: string;
  dispatchedBy: string;
  workspacePath?: string | null;
  chatId?: string | null;
  // A CONTENT-bearing column the reader must NEVER select or surface.
  brief: string;
};

type EventRow = {
  taskId: string;
  laneId: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
  // A CONTENT-bearing column the reader must NEVER select or surface.
  message: string;
};

/** A faithful fake: `findMany` HONORS `where`/`orderBy`/`take` but deliberately
 *  RETURNS FULL ROWS (ignoring `select`) so a leak test proves the READER's own
 *  discipline (it reads only coordinate fields), not the fake's. The `select`
 *  arguments are captured so a separate test asserts no content column is asked for. */
function fakePrisma(jobs: JobRow[], events: EventRow[]) {
  const jobSelectSpy = vi.fn();
  const eventSelectSpy = vi.fn();
  return {
    prisma: {
      dispatchJob: {
        findMany: async (args: {
          where: {
            status?: string;
            taskId?: { not: string } | string;
            id?: { not: string };
            workspacePath?: string;
            chatId?: string;
          };
          select: Record<string, boolean>;
          distinct?: string[];
        }) => {
          jobSelectSpy(args.select);
          let rows = jobs.filter((j) =>
            args.where.status ? j.status === args.where.status : true
          );
          const taskNot =
            typeof args.where.taskId === "object" && args.where.taskId
              ? args.where.taskId.not
              : undefined;
          if (taskNot) {
            rows = rows.filter((j) => j.taskId !== taskNot);
          }
          if (args.where.id?.not) {
            rows = rows.filter((j) => j.id !== args.where.id!.not);
          }
          if (args.where.workspacePath) {
            rows = rows.filter(
              (j) => j.workspacePath === args.where.workspacePath
            );
          }
          if (args.where.chatId) {
            rows = rows.filter((j) => j.chatId === args.where.chatId);
          }
          if (args.distinct?.includes("taskId")) {
            const seen = new Set<string>();
            rows = rows.filter((j) => {
              if (seen.has(j.taskId)) return false;
              seen.add(j.taskId);
              return true;
            });
          }
          return rows;
        },
      },
      event: {
        findMany: async (args: {
          where: { taskId: string };
          orderBy: { timestamp: "desc" };
          take: number;
          select: Record<string, boolean>;
        }) => {
          eventSelectSpy(args.select);
          return events
            .filter((e) => e.taskId === args.where.taskId)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, args.take);
        },
      },
    },
    jobSelectSpy,
    eventSelectSpy,
  };
}

/**
 * THE WORKSPACE EVERY READER IS NOW FENCED TO.
 *
 * These tests used to construct the readers with NO partition, which worked
 * only because `coordinationPartitionReady` returned true for an omitted one —
 * a default that existed, by its own docstring, to keep these tests passing.
 * That made them exercise an unfenced machine-wide read that no route performs.
 * They pass the partition the route passes now, and the fixtures carry the
 * workspace a real DispatchJob always has.
 */
const WS = "/repo/main";
const PARTITION = { workspacePath: WS } as const;

const runningJob = (over: Partial<JobRow> = {}): JobRow => ({
  id: "job-A",
  workspacePath: WS,
  status: "running",
  vendor: "codex",
  taskId: "task-A",
  dispatchedBy: "orchestrator",
  brief: "SECRET_BRIEF_PAYLOAD_ZZZ",
  ...over,
});

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  taskId: "task-A",
  laneId: "lane-codex-0",
  timestamp: new Date("2026-07-10T00:00:00.000Z"),
  metadata: {},
  message: "SECRET_MESSAGE_PAYLOAD_ZZZ",
  ...over,
});

describe("readLiveActivity (KG-7 live cross-agent activity reader)", () => {
  it("surfaces a running job whose event touches a QUERY-anchor module", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma([runningJob()], [ev({ metadata: { modules: [mod] } })]);
    const activity = await readLiveActivity(prisma as never, PARTITION)({ symbols: [], modules: [mod] });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      jobId: "job-A",
      vendor: "codex",
      taskId: "task-A",
      laneId: "lane-codex-0",
      kind: "running",
      anchor: mod,
      anchorKind: "module",
      state: "live",
      at: "2026-07-10T00:00:00.000Z",
    });
  });

  it("surfaces declared edit intent without requiring an observed module change", async () => {
    const mod = "src/pay/planned.ts";
    const { prisma } = fakePrisma(
      [runningJob()],
      [ev({ metadata: { intentModules: [mod] } })]
    );
    const activity = await readLiveActivity(prisma as never, PARTITION)({
      symbols: [],
      modules: [mod],
    });
    expect(activity).toEqual([
      expect.objectContaining({
        taskId: "task-A",
        anchor: mod,
        anchorKind: "module",
        kind: "running",
        state: "live",
      }),
    ]);
  });

  it("does NOT surface a job whose events touch only a DIFFERENT module", async () => {
    const { prisma } = fakePrisma(
      [runningJob()],
      [ev({ metadata: { modules: ["src/other/y.ts"] } })]
    );
    const activity = await readLiveActivity(prisma as never, PARTITION)({
      symbols: [],
      modules: ["src/pay/charge.ts"],
    });
    expect(activity).toEqual([]);
  });

  it("does NOT surface a job that is not RUNNING (queued/done)", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma(
      [runningJob({ status: "done" })],
      [ev({ metadata: { modules: [mod] } })]
    );
    const activity = await readLiveActivity(prisma as never, PARTITION)({ symbols: [], modules: [mod] });
    expect(activity).toEqual([]);
  });

  it("EXCLUDES the caller's own task (self-exclusion #5)", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma([runningJob()], [ev({ metadata: { modules: [mod] } })]);
    const activity = await readLiveActivity(prisma as never, PARTITION)(
      { symbols: [], modules: [mod] },
      { taskId: "task-A" }
    );
    expect(activity).toEqual([]);
  });

  it("EXCLUDES the caller's own job id (self-exclusion #5)", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma([runningJob()], [ev({ metadata: { modules: [mod] } })]);
    const activity = await readLiveActivity(prisma as never, PARTITION)(
      { symbols: [], modules: [mod] },
      { jobId: "job-A" }
    );
    expect(activity).toEqual([]);
  });

  it("PREFERS a symbol match (anchorKind:'symbol', kind:'editing') over a module match", async () => {
    const mod = "src/pay/charge.ts";
    const sym = `${mod}#charge`;
    const { prisma } = fakePrisma(
      [runningJob()],
      [
        // Older module-only touch + a newer symbol touch on the same task.
        ev({ timestamp: new Date("2026-07-10T00:00:00.000Z"), metadata: { modules: [mod] } }),
        ev({
          timestamp: new Date("2026-07-10T01:00:00.000Z"),
          metadata: { modules: [mod], symbols: [sym] },
        }),
      ]
    );
    const activity = await readLiveActivity(prisma as never, PARTITION)({ symbols: [sym], modules: [mod] });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ anchor: sym, anchorKind: "symbol", kind: "editing" });
  });

  it("returns [] with no anchors, and never queries jobs when nothing to join", async () => {
    const { prisma, jobSelectSpy } = fakePrisma([runningJob()], [ev()]);
    const activity = await readLiveActivity(prisma as never, PARTITION)({ symbols: [], modules: [] });
    expect(activity).toEqual([]);
    expect(jobSelectSpy).not.toHaveBeenCalled();
  });

  // ── SIDE-CHANNEL AUDIT (the load-bearing invariant) ─────────────────────────
  it("SIDE-CHANNEL: selects COORDINATE columns only, never `brief` / `message`", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma, jobSelectSpy, eventSelectSpy } = fakePrisma(
      [runningJob()],
      [ev({ metadata: { modules: [mod] } })]
    );
    await readLiveActivity(prisma as never, PARTITION)({ symbols: [], modules: [mod] });
    // The DispatchJob read asks for id/vendor/taskId ONLY, NEVER `brief` (and no
    // longer the unused `dispatchedBy`; the coordinate select is minimal).
    const jobSelect = jobSelectSpy.mock.calls[0]![0] as Record<string, boolean>;
    expect(jobSelect).not.toHaveProperty("brief");
    expect(Object.keys(jobSelect).sort()).toEqual(
      ["id", "taskId", "vendor"].sort()
    );
    // The Event read asks for metadata/timestamp/laneId, NEVER `message`.
    const eventSelect = eventSelectSpy.mock.calls[0]![0] as Record<string, boolean>;
    expect(eventSelect).not.toHaveProperty("message");
    expect(Object.keys(eventSelect).sort()).toEqual(
      ["laneId", "metadata", "timestamp"].sort()
    );
  });

  it("SIDE-CHANNEL: no note/brief/message text leaks even when the DB returns those columns", async () => {
    const mod = "src/pay/charge.ts";
    // The fake returns FULL rows (brief + message present), so this proves the
    // READER ignores them, not that the fake hid them.
    const { prisma } = fakePrisma(
      [runningJob({ brief: "SECRET_BRIEF_PAYLOAD_ZZZ" })],
      [ev({ metadata: { modules: [mod] }, message: "SECRET_MESSAGE_PAYLOAD_ZZZ" })]
    );
    const activity = await readLiveActivity(prisma as never, PARTITION)({ symbols: [], modules: [mod] });
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain("SECRET_BRIEF_PAYLOAD_ZZZ");
    expect(serialized).not.toContain("SECRET_MESSAGE_PAYLOAD_ZZZ");
    // And every key of every entry is in the coordinate allowlist.
    const ALLOW = new Set([
      "laneId",
      "vendor",
      "taskId",
      "jobId",
      "kind",
      "anchor",
      "anchorKind",
      "at",
      "state",
    ]);
    for (const entry of activity) {
      for (const key of Object.keys(entry)) {
        expect(ALLOW.has(key)).toBe(true);
      }
    }
  });
});

// KG-8 (ADR-0014), the FUSED reader `readActivity(prisma, graph)`: LIVE (KG-7)
// PLUS RECENT (KG-8, the `ACTED_ON` window). Deterministic: the same faithful fake
// prisma feeds the live leg, and a fake graph stands in for the recent leg (its
// query correctness is proven separately against a REAL store in
// packages/graph/tests). These pin the composition invariants: merge, live-wins
// DEDUP, self-exclusion on BOTH legs, degrade-to-live-only, the bounded window
// floor, and the coordinates-only side-channel on the recent rows.
const ALLOW = new Set([
  "laneId",
  "vendor",
  "taskId",
  "jobId",
  "kind",
  "anchor",
  "anchorKind",
  "at",
  "state",
]);

/**
 * A finished job for the RECENT leg's task, in the same workspace.
 *
 * The recent leg resolves allowed task ids from the LEDGER partition before it
 * walks the graph, so a recent row whose task has no job in this workspace is
 * correctly outside the fence. These fixtures used to omit it and passed only
 * because there was no fence at all — the merge tests were asserting a merge
 * that the route could never produce.
 */
const recentJob = (over: Partial<JobRow> = {}): JobRow =>
  runningJob({ id: "job-R", taskId: "task-R", status: "done", ...over });

const recentRow = (over: Partial<PreEditActivity> = {}): PreEditActivity => ({
  laneId: "lane-cc-0",
  vendor: "claude-code",
  taskId: "task-R",
  jobId: "job-R",
  kind: "editing",
  anchor: "src/pay/charge.ts#charge",
  anchorKind: "symbol",
  at: "2026-07-11T12:00:00.000Z",
  state: "recent",
  ...over,
});

/** A fake ActivityGraph capturing the recent-read args; returns `rows` or throws. */
function fakeGraph(rows: PreEditActivity[], opts?: { throws?: boolean }) {
  const calls: {
    anchors: { symbols: string[]; modules: string[] };
    sinceIso: string;
    exclude?: { taskId?: string; jobId?: string };
    allowedTaskIds?: readonly string[] | null;
  }[] = [];
  return {
    graph: {
      recentActivityOn: async (
        anchors: { symbols: string[]; modules: string[] },
        sinceIso: string,
        exclude?: { taskId?: string; jobId?: string },
        allowedTaskIds?: readonly string[] | null
      ) => {
        calls.push({ anchors, sinceIso, exclude, allowedTaskIds });
        if (opts?.throws) {
          throw new Error("graph recent-read exploded");
        }
        if (allowedTaskIds) {
          return rows.filter((r) => allowedTaskIds.includes(r.taskId));
        }
        return rows;
      },
    },
    calls,
  };
}

describe("readActivity (KG-8 fused live + recent reader)", () => {
  it("MERGES live (KG-7) and recent (KG-8) onto one channel", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma(
      [runningJob(), recentJob()],
      [ev({ metadata: { modules: [mod] } })]
    );
    const { graph } = fakeGraph([recentRow()]);
    const activity = await readActivity(prisma as never, graph, { partition: PARTITION })({
      symbols: ["src/pay/charge.ts#charge"],
      modules: [mod],
    });
    expect(activity.map((a) => a.state).sort()).toEqual(["live", "recent"]);
    expect(activity.find((a) => a.state === "live")?.jobId).toBe("job-A");
    expect(activity.find((a) => a.state === "recent")?.jobId).toBe("job-R");
  });

  it("DEDUP live vs recent: a job LIVE on an anchor is NOT also emitted recent for the same (task, anchor)", async () => {
    const mod = "src/pay/charge.ts";
    // Live job task-A on module `mod`. Recent row for the SAME task+anchor → dropped.
    const { prisma } = fakePrisma(
      [runningJob(), recentJob({ taskId: "task-Z", id: "job-Z" })],
      [ev({ metadata: { modules: [mod] } })]
    );
    const { graph } = fakeGraph([
      recentRow({ taskId: "task-A", anchor: mod, anchorKind: "module", kind: "running" }),
      // A recent row on a DIFFERENT task survives.
      recentRow({ taskId: "task-Z", anchor: mod, anchorKind: "module", jobId: "job-Z" }),
    ]);
    const activity = await readActivity(prisma as never, graph, { partition: PARTITION })({ symbols: [], modules: [mod] });
    const recents = activity.filter((a) => a.state === "recent");
    expect(recents.map((r) => r.taskId)).toEqual(["task-Z"]); // task-A deduped (live wins)
    expect(activity.filter((a) => a.state === "live").map((a) => a.taskId)).toEqual(["task-A"]);
  });

  it("DEGRADE-TO-EMPTY: a THROWING graph recent-read yields LIVE-ONLY (no crash, no 500)", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma([runningJob()], [ev({ metadata: { modules: [mod] } })]);
    const { graph } = fakeGraph([], { throws: true });
    const activity = await readActivity(prisma as never, graph, { partition: PARTITION })({ symbols: [], modules: [mod] });
    expect(activity).toHaveLength(1);
    expect(activity[0]!.state).toBe("live");
  });

  it("SELF-EXCLUSION (#5) is threaded to the RECENT leg too", async () => {
    const mod = "src/pay/charge.ts";
    // One job in the partition, none of it LIVE on this anchor. The reader
    // short-circuits before the graph when a workspace has NO jobs at all —
    // correct, and a saved walk — so a test about what reaches the graph must
    // give it a reason to get there.
    const { prisma } = fakePrisma([recentJob()], []);
    const { graph, calls } = fakeGraph([]);
    await readActivity(prisma as never, graph, { partition: PARTITION })(
      { symbols: [], modules: [mod] },
      { taskId: "my-task", jobId: "my-job" }
    );
    expect(calls[0]!.exclude).toEqual({ taskId: "my-task", jobId: "my-job" });
  });

  it("BOUNDED WINDOW: the recent read gets a `since` floor of now − RECENT_ACTIVITY_WINDOW_MS", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma([recentJob()], []);
    const { graph, calls } = fakeGraph([]);
    const now = Date.parse("2026-07-12T00:00:00.000Z");
    await readActivity(prisma as never, graph, { now: () => now, partition: PARTITION })({
      symbols: [],
      modules: [mod],
    });
    expect(calls[0]!.sinceIso).toBe(
      new Date(now - RECENT_ACTIVITY_WINDOW_MS).toISOString()
    );
  });

  it("SIDE-CHANNEL: recent rows carry ONLY coordinate fields, no content, no poison leak", async () => {
    const mod = "src/pay/charge.ts";
    // Live leg fed poison columns (fake returns full rows); recent leg is a clean
    // coordinate row. The merged output must contain neither poison nor a non-allow key.
    const { prisma } = fakePrisma(
      [runningJob({ brief: "SECRET_BRIEF_PAYLOAD_ZZZ" })],
      [ev({ metadata: { modules: [mod] }, message: "SECRET_MESSAGE_PAYLOAD_ZZZ" })]
    );
    const { graph } = fakeGraph([recentRow({ taskId: "task-R2", anchor: mod, anchorKind: "module" })]);
    const activity = await readActivity(prisma as never, graph, { partition: PARTITION })({ symbols: [], modules: [mod] });
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain("SECRET_BRIEF_PAYLOAD_ZZZ");
    expect(serialized).not.toContain("SECRET_MESSAGE_PAYLOAD_ZZZ");
    for (const entry of activity) {
      for (const key of Object.keys(entry)) {
        expect(ALLOW.has(key)).toBe(true);
      }
    }
  });
});

describe("substrate §3.1: coordination partition fence", () => {
  it("LIVE: same relative module in another workspace is invisible", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma(
      [
        runningJob({
          id: "job-here",
          taskId: "task-here",
          workspacePath: "/repo/a",
        }),
        runningJob({
          id: "job-there",
          taskId: "task-there",
          workspacePath: "/repo/b",
          vendor: "claude-code",
        }),
      ],
      [
        ev({
          taskId: "task-here",
          metadata: { modules: [mod] },
        }),
        ev({
          taskId: "task-there",
          laneId: "lane-cc-0",
          metadata: { modules: [mod] },
        }),
      ]
    );
    const activity = await readLiveActivity(prisma as never, {
      workspacePath: "/repo/a",
    })({ symbols: [], modules: [mod] });
    expect(activity.map((a) => a.jobId)).toEqual(["job-here"]);
  });

  it("LIVE: no workspace and no allowGlobal → [] (fail-closed)", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma(
      [runningJob({ workspacePath: "/repo/a" })],
      [ev({ metadata: { modules: [mod] } })]
    );
    const activity = await readLiveActivity(prisma as never, {
      workspacePath: null,
      allowGlobal: false,
    })({ symbols: [], modules: [mod] });
    expect(activity).toEqual([]);
  });

  it("FUSED: recent leg receives allowedTaskIds from the ledger partition", async () => {
    const mod = "src/pay/charge.ts";
    const { prisma } = fakePrisma(
      [
        runningJob({
          id: "job-here",
          taskId: "task-here",
          workspacePath: "/repo/a",
        }),
      ],
      []
    );
    const { graph, calls } = fakeGraph([
      recentRow({ taskId: "task-here", anchor: mod, anchorKind: "module" }),
      recentRow({ taskId: "task-foreign", anchor: mod, anchorKind: "module" }),
    ]);
    const activity = await readActivity(prisma as never, graph, {
      partition: { workspacePath: "/repo/a" },
    })({ symbols: [], modules: [mod] });
    expect(calls[0]!.allowedTaskIds).toEqual(["task-here"]);
    expect(activity.map((a) => a.taskId)).toEqual(["task-here"]);
  });
});
