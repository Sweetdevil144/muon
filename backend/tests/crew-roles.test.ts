import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LaneCandidate } from "@muon/core";

// ── Crew role assignment ─────────────────────────────────────────────────────
//
// Role binding is MUON's answer to "who does what", and it is deliberately
// arithmetic: `assignRoles()` is pure, so the same lanes and the same pins
// always produce the same plan, and the human can predict what MUON will do.
//
// The governance properties these tests pin down:
//   • The chat's ACTIVE ORCHESTRATOR may bind roles for ITS chat (it holds the
//     agent credential, so an operator-only route would make the coordinator
//     unable to shape its own crew) — and for no other chat.
//   • A worker's job bearer and the runner's shared agent bearer may not.
//   • A HUMAN pin survives an agent recompute, and an agent's own pin is never
//     recorded as a human decision.

const OPERATOR = "operator-token-crew";
const AGENT = "agent-token-crew";
const ROOT_A = `crew-root-a-${"a".repeat(48)}`;
const WORKER_A = `crew-worker-a-${"b".repeat(46)}`;
const ROOT_B = `crew-root-b-${"c".repeat(48)}`;
const WORKSPACE = process.cwd();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// A fixed, deterministic lane set: the point of the engine is that this input
// always yields the same plan, so the fixture stands in for a live probe.
//
// `supportedRoles` is stated on every lane because the ceiling is now REQUIRED.
// These fixtures omitted it, which the engine used to read as "unconstrained",
// so the full list is what keeps every expectation below unchanged. It is the
// ENGINE under test here, not the real vendors' ceilings — those are pinned
// against the registry in vendor-position-matrix / vendor-registry-drift.
const ALL_ROLES = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
  "qa",
  "scout",
  "docs",
] as const;

const LANES: LaneCandidate[] = [
  {
    vendor: "claude-code",
    displayName: "Claude Code",
    health: "healthy",
    supportedRoles: [...ALL_ROLES],
    cost: 0.9,
    capabilities: {
      canStreamEvents: true,
      canInterrupt: true,
      canBackground: true,
      supportsApprovals: true,
      supportsWorktrees: true,
    },
  },
  {
    vendor: "codex",
    displayName: "Codex",
    health: "healthy",
    supportedRoles: [...ALL_ROLES],
    cost: 0.6,
    capabilities: {
      canStreamEvents: true,
      canInterrupt: true,
      canBackground: true,
      supportsApprovals: true,
      supportsWorktrees: true,
    },
  },
  {
    // A SYNTHETIC third lane, deliberately not a registry vendor id. It
    // over-declares `ALL_ROLES` on purpose so the assignment engine can be
    // exercised across the whole taxonomy with a lane whose CAPABILITIES are
    // narrow — that combination is the point, and no real vendor has it. Using a
    // real id here would read as a claim about that vendor's ceiling, which is
    // pinned in `vendor-position-matrix.test.ts` instead.
    vendor: "scout-lane",
    displayName: "Scout Lane (fixture)",
    health: "healthy",
    supportedRoles: [...ALL_ROLES],
    cost: 0,
    capabilities: {
      canStreamEvents: true,
      canInterrupt: false,
      canBackground: false,
      supportsApprovals: false,
      supportsWorktrees: false,
    },
  },
];

let dir: string;
let db: typeof import("../src/lib/db.js");
let crew: typeof import("../src/routes/crew.js");
let app: FastifyInstance;

type Binding = {
  vendor: string;
  role: string;
  assignedBy: string;
  blocked: boolean;
  blockedReason?: string;
};

function bindingFor(plan: { bindings: Binding[] }, role: string) {
  return plan.bindings.find((binding) => binding.role === role);
}

async function postPlan(token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/crew/roles",
    headers: auth(token),
    payload,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-crew-roles-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.createMany({
    data: [
      {
        id: "task-crew-a",
        title: "Crew A",
        description: "Chat A crew planning.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-a",
      },
      {
        id: "task-crew-b",
        title: "Crew B",
        description: "Chat B crew planning.",
        status: "in_progress",
        workspacePath: WORKSPACE,
        chatId: "chat-b",
      },
    ],
  });
  await db.prisma.orchestratorChat.createMany({
    data: [
      {
        id: "chat-a",
        title: "Chat A",
        workspacePath: WORKSPACE,
        taskId: "task-crew-a",
      },
      {
        id: "chat-b",
        title: "Chat B",
        workspacePath: WORKSPACE,
        taskId: "task-crew-b",
      },
    ],
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-root-a",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-crew-a",
        chatId: "chat-a",
        brief: "Coordinate chat A.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-worker-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-crew-a",
        chatId: "chat-a",
        parentJobId: "job-root-a",
        rootJobId: "job-root-a",
        role: "implementer",
        brief: "Implement chat A work.",
        workspacePath: WORKSPACE,
        status: "running",
        dispatchedBy: "agent:job:job-root-a",
      },
      {
        id: "job-root-b",
        kind: "session",
        vendor: "claude-code",
        taskId: "task-crew-b",
        chatId: "chat-b",
        brief: "Coordinate chat B.",
        workspacePath: WORKSPACE,
        capabilityMode: "orchestrator",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-root-a", ROOT_A],
      ["job-worker-a", WORKER_A],
      ["job-root-b", ROOT_B],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  crew = await import("../src/routes/crew.js");
  crew.setCrewLaneProvider(async () => LANES);
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  crew?.setCrewLaneProvider(null);
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/crew/roles produces a deterministic plan and persists it", () => {
  it("binds each role to the best-fitting live lane and stores the bindings", async () => {
    const res = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer", "qa"],
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json().plan;
    expect(plan).toMatchObject({ version: 1, chatId: "chat-a", unfilled: [] });

    // Capability-derived, cost-adjusted, reuse-penalised — and reproducible.
    expect(bindingFor(plan, "implementer")).toMatchObject({
      vendor: "claude-code",
      assignedBy: "muon",
      blocked: false,
    });
    expect(bindingFor(plan, "reviewer")?.vendor).toBe("codex");
    expect(bindingFor(plan, "qa")?.vendor).toBe("scout-lane");
    for (const binding of plan.bindings as { fit: number; reason: string }[]) {
      expect(binding.fit).toBeGreaterThan(0);
      expect(binding.reason.length).toBeGreaterThan(0);
    }

    const rows = await db.prisma.crewRoleBinding.findMany({
      where: { chatId: "chat-a" },
      orderBy: { role: "asc" },
    });
    expect(rows.map((row) => [row.role, row.vendor])).toEqual([
      ["implementer", "claude-code"],
      ["qa", "scout-lane"],
      ["reviewer", "codex"],
    ]);
  });

  it("is deterministic and replaces the chat's bindings rather than accreting them", async () => {
    const first = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer", "qa"],
    });
    const second = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer", "qa"],
    });
    expect(second.json().plan).toEqual(first.json().plan);

    const narrower = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer"],
    });
    expect(narrower.json().plan.bindings).toHaveLength(1);
    expect(await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-a" } })).toBe(1);
  });

  it("honors a human pin, marks it assignedBy human, and records a blocked pin instead of granting it", async () => {
    const res = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      // The human outranks the engine for reviewer; and pins the implementer to
      // a lane that CANNOT hold it (no worktrees) — recorded blocked, not granted.
      pinned: { reviewer: "scout-lane", implementer: "scout-lane" },
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json().plan;
    expect(bindingFor(plan, "reviewer")).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
      blocked: false,
    });
    const implementer = bindingFor(plan, "implementer");
    expect(implementer).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
      blocked: true,
    });
    expect(implementer?.blockedReason).toMatch(/supportsWorktrees/);

    const stored = await db.prisma.crewRoleBinding.findFirst({
      where: { chatId: "chat-a", role: "implementer" },
    });
    expect(stored).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
      blocked: true,
    });
    expect(stored?.blockedReason).toMatch(/supportsWorktrees/);
  });

  it("404s for a chat that does not exist and never writes a binding", async () => {
    const res = await postPlan(OPERATOR, { chatId: "chat-nope" });
    expect(res.statusCode).toBe(404);
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-nope" } })
    ).toBe(0);
  });
});

describe("a human pin survives an agent reassignment", () => {
  it("keeps the human's binding when the orchestrator recomputes, and never forges human provenance", async () => {
    const seeded = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      pinned: { reviewer: "scout-lane" },
    });
    expect(bindingFor(seeded.json().plan, "reviewer")).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
    });

    // The coordinator recomputes and tries to move the human's reviewer AND to
    // stamp its own choice as a human decision.
    const recomputed = await postPlan(ROOT_A, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer", "qa"],
      pinned: { reviewer: "claude-code", qa: "claude-code" },
    });
    expect(recomputed.statusCode).toBe(200);
    const plan = recomputed.json().plan;
    // The human pin is preserved verbatim, provenance intact.
    expect(bindingFor(plan, "reviewer")).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
    });
    // The agent's own pin is honored as a CHOICE but recorded as muon's, so it
    // can never masquerade as a human decision (or become sticky itself).
    expect(bindingFor(plan, "qa")).toMatchObject({
      vendor: "claude-code",
      assignedBy: "muon",
    });

    const rows = await db.prisma.crewRoleBinding.findMany({
      where: { chatId: "chat-a" },
    });
    expect(
      rows.filter((row) => row.assignedBy === "human").map((row) => row.role)
    ).toEqual(["reviewer"]);
  });

  it("cannot be defeated by narrowing the role list (the pinned role is unioned back in)", async () => {
    await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      pinned: { reviewer: "scout-lane" },
    });

    // Dropping `reviewer` from the requested roles would otherwise delete the
    // human's binding without the agent ever naming it.
    const narrowed = await postPlan(ROOT_A, {
      chatId: "chat-a",
      roles: ["implementer"],
    });
    expect(narrowed.statusCode).toBe(200);
    expect(bindingFor(narrowed.json().plan, "reviewer")).toMatchObject({
      vendor: "scout-lane",
      assignedBy: "human",
    });
    expect(
      await db.prisma.crewRoleBinding.findFirst({
        where: { chatId: "chat-a", role: "reviewer" },
      })
    ).toMatchObject({ vendor: "scout-lane", assignedBy: "human" });
  });

  it("lets the operator — and only the operator — move or clear a human pin", async () => {
    const moved = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      pinned: { reviewer: "claude-code" },
    });
    expect(bindingFor(moved.json().plan, "reviewer")).toMatchObject({
      vendor: "claude-code",
      assignedBy: "human",
    });

    const cleared = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
    });
    expect(bindingFor(cleared.json().plan, "reviewer")).toMatchObject({
      vendor: "codex",
      assignedBy: "muon",
    });
    expect(
      await db.prisma.crewRoleBinding.count({
        where: { chatId: "chat-a", assignedBy: "human" },
      })
    ).toBe(0);
  });
});

describe("crew role authority is scoped to the caller's own chat", () => {
  it("refuses an orchestrator that names another chat (403), leaving that chat untouched", async () => {
    const before = await db.prisma.crewRoleBinding.count({
      where: { chatId: "chat-b" },
    });
    const res = await postPlan(ROOT_A, { chatId: "chat-b" });
    expect(res.statusCode).toBe(403);
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-b" } })
    ).toBe(before);
  });

  it("refuses a worker job bearer and the shared agent bearer (403)", async () => {
    for (const token of [WORKER_A, AGENT]) {
      const res = await postPlan(token, {
        chatId: "chat-a",
        roles: ["implementer"],
      });
      expect(res.statusCode, token.slice(0, 10)).toBe(403);
    }
  });

  it("gives a job bearer its OWN chat's plan and refuses a foreign chatId", async () => {
    const own = await app.inject({
      method: "GET",
      url: "/api/crew/roles",
      headers: auth(WORKER_A),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().plan.chatId).toBe("chat-a");
    // Another lane's install/health posture is operator diagnostics, not peer data.
    expect(own.json().lanes).toBeUndefined();

    const constrained = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-a",
      headers: auth(WORKER_A),
    });
    expect(constrained.statusCode).toBe(200);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-b",
      headers: auth(WORKER_A),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("lets the shared-agent observer read only an explicitly named chat", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/crew/roles",
      headers: auth(AGENT),
    });
    expect(missing.statusCode).toBe(400);

    const scoped = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-a",
      headers: auth(AGENT),
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().plan.chatId).toBe("chat-a");
    expect(scoped.json().lanes).toBeUndefined();
  });
});

describe("GET /api/crew/roles (operator view)", () => {
  it("returns the stored plan plus the live lanes it was computed from", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-a",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.chatId).toBe("chat-a");
    expect(res.json().lanes).toEqual([
      {
        vendor: "claude-code",
        displayName: "Claude Code",
        health: "healthy",
        cost: 0.9,
        costOrdinal: 0.9,
      },
      {
        vendor: "codex",
        displayName: "Codex",
        health: "healthy",
        cost: 0.8,
        costOrdinal: 0.8,
      },
      {
        vendor: "scout-lane",
        displayName: "Scout Lane (fixture)",
        health: "healthy",
        cost: 0.5,
        costOrdinal: 0.5,
      },
    ]);
    expect(res.json().costAccounting).toEqual({
      metered: false,
      notice: "cost accounting not yet metered",
    });
  });

  it("marks a stored plan `assigned`", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-a",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().planStatus).toBe("assigned");
  });

  it("derives unfilled from the stored bindings instead of reporting none", async () => {
    // The desktop's "Unfilled roles" affordance reads this list. Hard-coding
    // `[]` on the read path made it dead code against the live route: only a
    // POST response ever named a role nobody could hold.
    const written = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer", "reviewer"],
      // the fixture lane cannot hold `implementer` (no worktrees), so the pin is stored
      // BLOCKED — a binding row exists, but nobody actually holds the role.
      pinned: { implementer: "scout-lane" },
    });
    expect(bindingFor(written.json().plan, "implementer")).toMatchObject({
      vendor: "scout-lane",
      blocked: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-a",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    const unfilled = res.json().plan.unfilled as string[];
    // A blocked binding is not a holder: the same predicate dispatch uses.
    expect(unfilled).toContain("implementer");
    // …and a role nothing was ever bound for is unfilled too.
    expect(unfilled).toContain("qa");
    // The one role a live lane actually holds is NOT reported unfilled.
    expect(unfilled).not.toContain("reviewer");
  });

  it("requires the operator to name a chat (400) — a plan is never workspace-wide", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crew/roles",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── the proposed plan ────────────────────────────────────────────────────────
//
// A chat with no bindings used to answer `plan: null`, so the first thing a new
// user saw in the crew view was vendor lanes with no roles at all — the headline
// capability invisible until an agent happened to call assign_roles. The read now
// answers with the plan MUON WOULD bind, marked `proposed`.
//
// The property that makes that safe is the one every test below is really about:
// a READ NEVER WRITES. The preview is computed and returned; POST remains the
// only thing that can create a CrewRoleBinding row.
describe("GET /api/crew/roles previews the plan MUON would assign", () => {
  it("returns the crew it WOULD bind for an unbound chat, marked proposed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-b",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planStatus).toBe("proposed");
    expect(body.plan).toMatchObject({ version: 1, chatId: "chat-b" });
    // The whole taxonomy, from the same live lanes a POST would use — not a
    // partial crew and not a fabricated one.
    expect(
      (body.plan.bindings as Binding[]).map((binding) => [
        binding.role,
        binding.vendor,
      ])
    ).toEqual([
      ["orchestrator", "claude-code"],
      ["implementer", "codex"],
      ["reviewer", "scout-lane"],
      ["architect", "claude-code"],
      ["qa", "codex"],
      ["docs", "claude-code"],
      ["scout", "scout-lane"],
    ]);
    // Nothing is pinned, because a pin IS a binding row and there are none.
    expect(
      (body.plan.bindings as Binding[]).every(
        (binding) => binding.assignedBy === "muon"
      )
    ).toBe(true);
  });

  it("PERSISTS NOTHING — reading a preview leaves the chat unbound", async () => {
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-b" } })
    ).toBe(0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/crew/roles?chatId=chat-b",
        headers: auth(OPERATOR),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().planStatus).toBe("proposed");
    }

    // The invariant: a GET is side-effect free. If the preview were persisted,
    // the second read would report `assigned` and this row count would be 7.
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-b" } })
    ).toBe(0);
    // …and no OTHER chat's bindings were touched either.
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-a" } })
    ).toBeGreaterThan(0);
  });

  it("is deterministic — the same crew previews identically every time", async () => {
    const read = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/crew/roles?chatId=chat-b",
          headers: auth(OPERATOR),
        })
      ).json();
    expect(await read()).toEqual(await read());
  });

  it("gives the job bearer the SAME answer, minus the operator-only lanes", async () => {
    const operator = await app.inject({
      method: "GET",
      url: "/api/crew/roles?chatId=chat-b",
      headers: auth(OPERATOR),
    });
    // ROOT_B is chat-b's own job bearer, so it names no chat at all.
    const bearer = await app.inject({
      method: "GET",
      url: "/api/crew/roles",
      headers: auth(ROOT_B),
    });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().planStatus).toBe("proposed");
    expect(bearer.json().plan).toEqual(operator.json().plan);
    // Another lane's install/health posture stays operator diagnostics.
    expect(bearer.json().lanes).toBeUndefined();
    expect(
      await db.prisma.crewRoleBinding.count({ where: { chatId: "chat-b" } })
    ).toBe(0);
  });

  it("does NOT fabricate a crew when no lane is available", async () => {
    crew.setCrewLaneProvider(async () => []);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/crew/roles?chatId=chat-b",
        headers: auth(OPERATOR),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().plan).toBeNull();
      // `plan === null` ⇔ `planStatus === "none"`, so no surface has to defend
      // against "proposed, but empty".
      expect(res.json().planStatus).toBe("none");
      expect(res.json().lanes).toEqual([]);
    } finally {
      crew.setCrewLaneProvider(async () => LANES);
    }
  });

  it("does NOT fabricate a crew when every lane is unavailable", async () => {
    crew.setCrewLaneProvider(async () =>
      LANES.map((lane) => ({ ...lane, health: "unavailable" as const }))
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/crew/roles?chatId=chat-b",
        headers: auth(OPERATOR),
      });
      expect(res.statusCode).toBe(200);
      // A lane nobody can dispatch to holds no role, so there is no crew to
      // preview — the same rule a chat with zero binding rows already followed.
      expect(res.json().plan).toBeNull();
      expect(res.json().planStatus).toBe("none");
      // The lanes themselves still come back: that is how the operator sees WHY.
      expect(res.json().lanes).toHaveLength(3);
    } finally {
      crew.setCrewLaneProvider(async () => LANES);
    }
  });

  it("a stored plan always wins over the preview", async () => {
    await postPlan(OPERATOR, { chatId: "chat-b", roles: ["reviewer"] });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/crew/roles?chatId=chat-b",
        headers: auth(OPERATOR),
      });
      expect(res.json().planStatus).toBe("assigned");
      // The single stored binding, not the seven a preview would compute.
      expect(res.json().plan.bindings).toHaveLength(1);
    } finally {
      await db.prisma.crewRoleBinding.deleteMany({ where: { chatId: "chat-b" } });
    }
  });

  it("answers a POST with planStatus assigned — a write is always the commit", async () => {
    const res = await postPlan(OPERATOR, {
      chatId: "chat-a",
      roles: ["implementer"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().planStatus).toBe("assigned");
  });
});
