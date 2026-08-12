import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// ── The boot activity replay is BOUNDED, and MUON's own audit rows are not ────
// ── activity ─────────────────────────────────────────────────────────────────
//
// `projectActivityEdges` (KG-8 / ADR-0014) used to run
// `prisma.event.findMany({ orderBy, select })` with NO `take`: it materialized the
// ENTIRE append-only `Event` table into JS objects at every boot and then skipped
// the uninteresting rows in the loop. D14's `recordGateRead` writes one row per
// PRE-EDIT GATE READ and `Event` has no retention sweep, so the boot path scaled
// with agent EDIT VOLUME — the one number this product exists to grow.
//
// Two properties, both asserted behaviourally rather than by reading the query:
//   1. THE NEWEST `ACTIVITY_REPLAY_MAX_EVENTS` ARE REPLAYED, and the overflow is
//      the OLDEST. Bounding an ascending scan would have kept the wrong half of a
//      RECENT-activity projection, and that mistake is invisible to a test that
//      only counts rows.
//   2. `memory.gate_read` / `memory.graph_mirror_failed` are excluded in SQL, so
//      they cannot consume the budget. Pinned with an audit row carrying
//      `metadata.modules` — which the real producers never write, and which the
//      OLD loop-side skip would therefore have turned into a live activity edge.

const OPERATOR = "operator-token-activity-bound";
const MODULE_NEWEST = "src/replay/newest.ts";
const MODULE_OLDEST = "src/replay/oldest.ts";
const MODULE_AUDIT = "src/replay/audit-should-not-anchor.ts";
const SINCE = new Date(0).toISOString();

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let gate: typeof import("../src/lib/gate-telemetry.js");
let app: FastifyInstance;

/** Task ids for the module rows the replay is asked about. */
async function tasksTouching(module: string): Promise<string[]> {
  const rows = await graphLib
    .getGraph()
    .recentActivityOn({ symbols: [], modules: [module] }, SINCE);
  return rows.map((row) => row.taskId).sort();
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-activity-bound-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  delete process.env.MUON_AGENT_TOKEN;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  gate = await import("../src/lib/gate-telemetry.js");
  await db.ensureSchema();

  const base = Date.UTC(2026, 0, 1);
  const at = (offsetMs: number) => new Date(base + offsetMs);

  // The OLDEST anchor-bearing event. It must fall off the bound.
  await db.prisma.event.create({
    data: {
      laneId: "codex",
      taskId: "task-replay-oldest",
      kind: "task.progress",
      message: "oldest touch",
      metadata: { modules: [MODULE_OLDEST] },
      timestamp: at(0),
    },
  });

  // Exactly `ACTIVITY_REPLAY_MAX_EVENTS` filler rows in between, so the oldest row
  // above is row `max + 1` counting back from the newest and is the ONE that the
  // bound drops. They carry no anchors, so they cost the replay nothing but a slot.
  const filler = Array.from(
    { length: ledger.ACTIVITY_REPLAY_MAX_EVENTS },
    (_unused, index) => ({
      laneId: "codex",
      taskId: "task-replay-filler",
      kind: "task.progress",
      message: `filler ${index}`,
      metadata: {},
      timestamp: at(1_000 + index),
    })
  );
  for (let cursor = 0; cursor < filler.length; cursor += 500) {
    await db.prisma.event.createMany({
      data: filler.slice(cursor, cursor + 500),
    });
  }

  // The NEWEST anchor-bearing event. It must survive.
  await db.prisma.event.create({
    data: {
      laneId: "codex",
      taskId: "task-replay-newest",
      kind: "task.progress",
      message: "newest touch",
      metadata: { modules: [MODULE_NEWEST] },
      timestamp: at(9_000_000),
    },
  });

  // MUON's OWN audit rows, newest of all, and adversarially carrying an anchor
  // array the real producers never write. If the exclusion were the loop-side skip
  // it replaced (drop rows with no symbols/modules), these WOULD become live
  // activity edges attributed to the sentinel `taskId: "memory"`.
  await db.prisma.event.createMany({
    data: [
      {
        laneId: "muon",
        taskId: "memory",
        kind: gate.GATE_READ_EVENT_KIND,
        message: "pre-edit gate read: 0 surfaced",
        metadata: { modules: [MODULE_AUDIT], surfaced: 0 },
        timestamp: at(9_100_000),
      },
      {
        laneId: "muon",
        taskId: "memory",
        kind: graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND,
        message: "graph mirror failed (test): boom",
        metadata: { modules: [MODULE_AUDIT], op: "test" },
        timestamp: at(9_200_000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  // The boot replay, run explicitly so the assertions describe a completed pass.
  await ledger.projectLedgerToGraph();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.awaitGraphMirrors();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("KG-8 boot replay: bounded, newest-first, and audit rows excluded", () => {
  it("replays the NEWEST anchor-bearing event and DROPS the one past the bound", async () => {
    // The pair. Without both halves a replay that projected nothing at all would
    // pass the second assertion on its own.
    expect(await tasksTouching(MODULE_NEWEST)).toEqual(["task-replay-newest"]);
    expect(await tasksTouching(MODULE_OLDEST)).toEqual([]);
  });

  it("never turns MUON's own audit rows into activity, whatever their metadata says", async () => {
    expect(await tasksTouching(MODULE_AUDIT)).toEqual([]);
  });

  it("the corpus really is past the bound, so neither assertion above is vacuous", async () => {
    const total = await db.prisma.event.count();
    expect(total).toBeGreaterThan(ledger.ACTIVITY_REPLAY_MAX_EVENTS);
  });
});

describe("GET /api/events: the degradation signal is addressable by kind", () => {
  it("returns the mirror-failure row even when it is far outside the default window", async () => {
    // The whole point. `?limit=50` is what the desktop polls, and it is the only
    // consumer of `memory.graph_mirror_failed` in the tree — so with thousands of
    // higher-volume rows newer than the alarm, the default window cannot see it.
    const windowed = await app.inject({
      method: "GET",
      url: "/api/events?limit=50",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(windowed.statusCode).toBe(200);
    expect(
      (windowed.json().events as { kind: string }[]).some(
        (event) => event.kind === graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND
      )
      // …which it CAN here, because the alarm is the newest row of all. The
      // assertion below is the one that does not depend on winning that race.
    ).toBe(true);

    const named = await app.inject({
      method: "GET",
      url: `/api/events?limit=50&kind=${encodeURIComponent(
        graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND
      )}`,
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(named.statusCode).toBe(200);
    const kinds = (named.json().events as { kind: string }[]).map(
      (event) => event.kind
    );
    expect(kinds).toEqual([graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND]);
  });

  it("SURVIVES the flood: the alarm is still addressable with newer high-volume rows on top", async () => {
    // The reproduction, made concrete. Bury the alarm under more gate reads than
    // the window holds and ask again — by name.
    const base = Date.UTC(2027, 0, 1);
    await db.prisma.event.createMany({
      data: Array.from({ length: 120 }, (_unused, index) => ({
        laneId: "muon",
        taskId: "memory",
        kind: gate.GATE_READ_EVENT_KIND,
        message: `pre-edit gate read: ${index} surfaced`,
        metadata: { surfaced: index },
        timestamp: new Date(base + index),
      })),
    });

    const windowed = await app.inject({
      method: "GET",
      url: "/api/events?limit=50",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    // Flushed out of the window entirely — this is the defect, asserted.
    expect(
      (windowed.json().events as { kind: string }[]).some(
        (event) => event.kind === graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND
      )
    ).toBe(false);

    const named = await app.inject({
      method: "GET",
      url: `/api/events?limit=50&kind=${encodeURIComponent(
        graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND
      )}`,
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(
      (named.json().events as { kind: string }[]).map((event) => event.kind)
    ).toEqual([graphLib.GRAPH_MIRROR_FAILED_EVENT_KIND]);
  });

  it("the filter only ever NARROWS: an unknown kind matches nothing and the default is unchanged", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/api/events?kind=not.a.kind.anyone.writes",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().events).toEqual([]);

    const unfiltered = await app.inject({
      method: "GET",
      url: "/api/events?limit=7",
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(unfiltered.statusCode).toBe(200);
    expect((unfiltered.json().events as unknown[]).length).toBe(7);
  });
});
