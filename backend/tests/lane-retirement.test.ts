import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicVendorIds } from "@muon/protocol";
import { buildApp } from "../src/app.js";

/**
 * TWO SOURCES OF TRUTH FOR "WHAT LANES EXIST".
 *
 * `bootstrap` seeds a Lane row and a fleet Agent row per registered vendor, and
 * seeding only ever ADDS. So when a vendor was removed from the ADR-0022
 * registry, its rows stayed — and every surface that enumerated lanes or seats
 * from the DATABASE kept reporting it, while every surface that derived them from
 * the REGISTRY did not. The crew topology drew a fifth lane node under its own
 * "4 lanes" header; that was the visible symptom, not the bug.
 *
 * These tests pin the fix at the route boundary: the persisted row survives (see
 * lane-retirement-sqlite.test.ts for retire-not-delete), it just stops being an
 * ANSWER to "which lanes exist". The mock honours `where`, so each assertion is
 * about the response a surface actually receives, not about a call shape.
 */

/** The removed vendor, standing in for whichever lane leaves the registry next. */
const GONE = "ollama";

type Row = Record<string, unknown>;

function laneRow(key: string, name: string): Row {
  return {
    id: `lane-${key}`,
    key,
    name,
    provider: key,
    role: "worker",
    status: "available",
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    updatedAt: new Date("2026-07-10T10:00:00.000Z"),
  };
}

function agentRow(vendor: string, ordinal: number): Row {
  return {
    id: `agent-${vendor}-${ordinal}`,
    vendor,
    name: `${vendor}-${ordinal}`,
    ordinal,
    status: "idle",
    currentTaskId: null,
    currentJobId: null,
    sessionId: null,
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    updatedAt: new Date("2026-07-10T10:00:00.000Z"),
  };
}

/** The founder's database: every registered lane, PLUS the leftover. */
const LANE_ROWS = [
  ...publicVendorIds().map((id) => laneRow(id, id)),
  laneRow(GONE, "Ollama"),
];
const AGENT_ROWS = [
  // The coordinator seat (ordinal 0) plus one worker per vendor, leftover included.
  agentRow("claude-code", 0),
  ...publicVendorIds().map((id) => agentRow(id, 1)),
  agentRow(GONE, 1),
];

/**
 * The subset of Prisma's `where` this suite uses — `{ in: [...] }` membership and
 * `{ gte: n }` — applied for real, so a route that forgot its filter returns the
 * stale row here exactly as it did in the app.
 */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === "object") {
      const clause = condition as { in?: unknown[]; gte?: number };
      if (clause.in !== undefined) return clause.in.includes(value);
      if (clause.gte !== undefined) return Number(value) >= clause.gte;
    }
    return value === condition;
  });
}

const prismaMock = vi.hoisted(() => ({
  lane: { findMany: vi.fn() },
  task: { findUnique: vi.fn() },
  agent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  event: { create: vi.fn() },
  $transaction: vi.fn(),
}));

const graphMock = vi.hoisted(() => ({ suggestLanes: vi.fn() }));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  mirrorToGraph: () => undefined,
}));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.lane.findMany.mockImplementation(
    async (args?: { where?: Row }) =>
      LANE_ROWS.filter((row) => matches(row, args?.where))
  );
  prismaMock.agent.findMany.mockImplementation(
    async (args?: { where?: Row }) =>
      AGENT_ROWS.filter((row) => matches(row, args?.where))
  );
  // A task that really ran on the removed lane, joined the way the Timeline and
  // the audit surfaces join it — by id, through the surviving row.
  prismaMock.task.findUnique.mockResolvedValue({
    id: "task-history",
    title: "Ran on the lane that was removed",
    status: "done",
    assignments: [
      {
        id: "assignment-history",
        taskId: "task-history",
        laneId: `lane-${GONE}`,
        summary: "Work that actually ran there.",
        lane: laneRow(GONE, "Ollama"),
      },
    ],
    handoffs: [],
    approvals: [],
  });
  prismaMock.agent.findFirst.mockResolvedValue(null);
  prismaMock.agent.count.mockResolvedValue(0);
  prismaMock.agent.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.agent.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.event.create.mockResolvedValue({});
  prismaMock.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock)
  );
  // The graph still remembers the retired lane. That is provenance, and it must
  // not smuggle the lane back into a surface that enumerates available lanes.
  graphMock.suggestLanes.mockResolvedValue([
    {
      laneId: `lane-${GONE}`,
      laneKey: GONE,
      laneName: "Ollama",
      score: 0.99,
      reason: "most history",
    },
  ]);
});

describe("a lane whose vendor left the registry is not an available lane", () => {
  it("GET /api/lanes omits it — the read every surface resolves lanes through", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/lanes" });

    expect(response.statusCode).toBe(200);
    const keys = response.json().lanes.map((lane: { key: string }) => lane.key);
    expect(keys).not.toContain(GONE);
    expect(keys.sort()).toEqual([...publicVendorIds()].sort());
    await app.close();
  });

  it("GET /api/fleet reports no seat for it — the topology's own lane count", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/fleet" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const vendors = [
      ...new Set(body.agents.map((agent: { vendor: string }) => agent.vendor)),
    ];
    // THE REGRESSION: `agents` used to be unfiltered while `counts` was derived
    // from the registry, so the two disagreed — five seats under a four-lane
    // header. They are now the same answer.
    expect(vendors).not.toContain(GONE);
    expect(vendors.sort()).toEqual(Object.keys(body.counts).sort());
    await app.close();
  });

  it("GET /api/fleet/agents omits its seats too", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/fleet/agents" });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().agents.map((agent: { vendor: string }) => agent.vendor)
    ).not.toContain(GONE);
    await app.close();
  });

  it("but history still resolves — a task that ran there still names its lane", async () => {
    // The counterpart guard: retirement removes an OPTION, never a FACT. Every
    // history read is KEYED (by task id, by lane id, by seat id), so it must NOT
    // pick up the registry filter — a Timeline that lost the lane name of work
    // that really ran is a worse bug than a stale node.
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-history",
    });

    expect(response.statusCode).toBe(200);
    const [assignment] = response.json().task.assignments;
    expect(assignment.lane.key).toBe(GONE);
    expect(assignment.lane.name).toBe("Ollama");
    await app.close();
  });

  it("GET /api/routing/suggest never recommends it, even with the best history", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/routing/suggest?text=fix%20the%20parser%20crash",
    });

    expect(response.statusCode).toBe(200);
    const suggested = response
      .json()
      .suggestions.map((entry: { laneKey: string }) => entry.laneKey);
    expect(suggested).not.toContain(GONE);
    await app.close();
  });
});

describe("a retired lane cannot be given work or capacity", () => {
  it("POST /api/dispatch refuses it (registry admission, before any enqueue)", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: GONE,
        taskId: "task-1",
        brief: "Do some work on the lane that no longer exists.",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(`Unknown vendor '${GONE}'`);
    await app.close();
  });

  it("POST /api/fleet/agents/claim refuses it", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: GONE },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain(`Unknown vendor '${GONE}'`);
    // Refused at admission: no seat was even nominated for it.
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("PUT /api/fleet cannot resize it — up or down", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { [GONE]: 3 },
    });

    expect(response.statusCode).toBe(200);
    // The counts schema is a reduction over the registry, so the key is not even
    // representable: nothing was created, nothing was deleted, and the retired
    // vendor gets no total in the answer.
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
    expect(prismaMock.agent.deleteMany).not.toHaveBeenCalled();
    expect(Object.keys(response.json().counts)).not.toContain(GONE);
    await app.close();
  });
});
