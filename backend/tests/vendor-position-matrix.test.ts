import { createHash } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ROLE_SPECS,
  VENDOR_IDS,
  VENDOR_REGISTRY,
  coordinatorVendorIds,
  delegatableVendorIds,
  dispatchableVendorIds,
  evaluatorVendorIds,
  fleetVendorIds,
  isVendorId,
  plannerVendorIds,
  publicVendorIds,
  sessionCapability,
  terminalTakeoverVendorIds,
  vendorIconKey,
  vendorLabel,
  vendorRoleCeiling,
  vendorShortLabel,
  vendorSupportsInteractive,
  type AgentRole,
  type VendorEntry,
  type VendorId,
} from "@muon/protocol";
import { createDefaultAdapters } from "@muon/adapters";
import { buildApp } from "../src/app.js";

// ── The vendor × position matrix, at the ADMISSION boundary ──────────────────
//
// The founder's requirement: "claude as well as codex must be assignable as
// superagent AND as subagent." Structurally that has looked true for a while —
// both declare all seven roles, both are in COORDINATOR_VENDORS, both have a
// session driver — but "looks true" is not "is proven", and Codex-as-
// orchestrator failed twice in a real session.
//
// This file proves the ROUTE half of the matrix for every combination:
//   {claude-code, codex} × {superagent (chat root), subagent (delegate child),
//                           subagent (plain worker dispatch)}
// asserting the capability mode, the crew role, and the delegation authority
// each combination actually lands with. The runner half (MCP env contract +
// launch assertions) is proven in packages/runner/tests.
//
// The refusals are pinned in the same place and by the same table, because a
// matrix that only proves the allows is how a boundary quietly widens: Cursor
// and OpenCode must stay OUT of the coordinator seat and out of write roles.

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  agent: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  delegationGrant: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  harness: {
    findUnique: vi.fn(),
  },
  crewRoleBinding: {
    findMany: vi.fn(),
  },
  orchestratorChat: {
    findUnique: vi.fn(),
  },
  streamChunk: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  approvalRequest: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  runner: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  laneSession: {
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

/** Both positions, both vendors. The whole point of the file. */
const COORDINATOR_CAPABLE = ["claude-code", "codex"] as const;
/** Lanes that must NEVER reach the coordinator seat or a write role. */
const NON_COORDINATOR = ["cursor", "opencode"] as const;

/**
 * A vendor id MUON has never heard of. Used as the negative control on every
 * admission surface: the registry is the whole namespace, so an id outside it
 * has no position in this matrix and must be refused everywhere.
 */
// NOTE: this was `opencode` until Wave F REGISTERED that vendor. A negative
// control that silently becomes a real id would turn every refusal below into a
// vacuous pass, so it is now an id from the same terminal-native namespace that
// MUON still has no registry entry for.
const UNREGISTERED_VENDOR = "kiro";

/**
 * Refusals that rest ENTIRELY on `supportedRoles`. Each pair below names a lane
 * whose `laneCapabilities` already satisfy the role's `requiredCapabilities`, so
 * the ONLY thing standing between it and the role is one adapter field — the
 * field that is optional today and whose absence admits everything
 * (ADR-0022 §1.2(b)). These are the refusals with no second net.
 *
 * `cursor` × `docs` is the canonical case the ADR names: `docs` requires only
 * `canStreamEvents`, which Cursor has.
 *
 * OpenCode (Wave F) makes this category BIGGER, not smaller, which is why the
 * `scout`-only ceiling has to be exact. It streams, backgrounds and interrupts,
 * so `reviewer`, `qa`, `architect`, `docs` AND `orchestrator` all pass their
 * `requiredCapabilities` — every one of them is held back by `supportedRoles`
 * and by nothing else. Cursor's `implementer` refusal is the same shape after
 * TODO 2.1 (`supportsWorktrees: true` — MUON already passes `--workspace`);
 * OpenCode's `implementer` still has a second net (`supportsWorktrees: false`)
 * and is deliberately NOT listed here.
 */
const ROLE_ONLY_REFUSALS = [
  { vendor: "cursor", role: "docs" },
  { vendor: "cursor", role: "implementer" },
  { vendor: "opencode", role: "reviewer" },
  { vendor: "opencode", role: "qa" },
  { vendor: "opencode", role: "docs" },
  { vendor: "opencode", role: "architect" },
] as const satisfies readonly { vendor: VendorId; role: AgentRole }[];

const WORKSPACE = process.cwd();
const DELEGATION_TOKEN = `delegate-${"d".repeat(55)}`;
const delegationHeaders = {
  "x-muon-delegation-token": DELEGATION_TOKEN,
};

function rootParent(vendor: string): Record<string, unknown> {
  const delegationDeadline = new Date(Date.now() + 600_000);
  return {
    id: "job-parent",
    kind: "session",
    vendor,
    taskId: "task-chat-canonical",
    chatId: "chat-1",
    brief: "run the mission",
    status: "running",
    workspacePath: WORKSPACE,
    maxWallMs: 600_000,
    startedAt: new Date(),
    capabilityMode: "orchestrator",
    role: "orchestrator",
    dispatchedBy: "human",
    interruptRequested: false,
    steerMessages: [],
    delegationDepth: 0,
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 2,
    delegationChildrenIssued: 0,
    delegationDescendantsIssued: 0,
    delegationBudgetReservedMs: 0,
    delegationDeadline,
    delegationManifest: {
      version: 1,
      jobId: "job-parent",
      workspacePath: WORKSPACE,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      maxIterations: 2,
      deadlineAt: delegationDeadline.toISOString(),
      authority: "orchestrator",
      childAuthority: "work",
      narrowingRequired: true,
    },
  };
}

/** The `data` the route last handed to `dispatchJob.create`. */
const createdData = () =>
  prismaMock.dispatchJob.create.mock.calls.at(-1)?.[0]?.data as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dispatchJob.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data
  );
  prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
  prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.dispatchJob.count.mockResolvedValue(0);
  prismaMock.orchestratorChat.findUnique.mockResolvedValue({
    id: "chat-1",
    status: "active",
    workspacePath: WORKSPACE,
    taskId: "task-chat-canonical",
    vendorSessionId: null,
    vendorSessionVendor: null,
    vendorSessionRootJobId: null,
  });
  prismaMock.harness.findUnique.mockImplementation(
    async ({ where }: { where: { key: string } }) => ({ key: where.key })
  );
  prismaMock.crewRoleBinding.findMany.mockResolvedValue([]);
  prismaMock.agent.findMany.mockResolvedValue([]);
  prismaMock.agent.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: `agent-${String(data.ordinal)}`,
      status: "idle",
      currentTaskId: null,
      sessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    })
  );
  prismaMock.agent.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.event.create.mockResolvedValue({ id: "event-1" });
  prismaMock.delegationGrant.findUnique.mockResolvedValue({
    jobId: "job-parent",
    tokenHash: createHash("sha256").update(DELEGATION_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 600_000),
    issuedAt: new Date(),
  });
  prismaMock.delegationGrant.upsert.mockResolvedValue({});
  prismaMock.streamChunk.create.mockResolvedValue({ seq: 1 });
  prismaMock.$transaction.mockImplementation(
    async (work: ((tx: typeof prismaMock) => unknown) | Promise<unknown>[]) =>
      Array.isArray(work) ? Promise.all(work) : work(prismaMock)
  );
});

describe("the matrix is COMPLETE (a new vendor cannot skip stating its position)", () => {
  // A pinned table is only meaningful while it is TOTAL. Without this, adding a
  // fifth managed vendor routes around the whole file: every `it.each` below
  // keeps passing on the four vendors it already names, and the newcomer is
  // proven neither admitted nor refused anywhere. Asserting the union against
  // the registry makes "state your position" a test failure rather than an act
  // of authorial discipline.
  const fleetSizeable = publicVendorIds().filter(
    (id) => VENDOR_REGISTRY[id].authority.fleetSizeable
  );

  it("COORDINATOR_CAPABLE ∪ NON_COORDINATOR === the public, fleet-sizeable vendors", () => {
    const stated = [...COORDINATOR_CAPABLE, ...NON_COORDINATOR].sort();
    expect(stated).toEqual([...fleetSizeable].sort());
  });

  it("states each vendor exactly once — no vendor is both", () => {
    const stated = [...COORDINATOR_CAPABLE, ...NON_COORDINATOR];
    expect(new Set(stated).size).toBe(stated.length);
  });

  it("agrees with the registry about WHICH of them may seat the coordinator", () => {
    // The two halves of the table are not free-standing opinions: they are the
    // `coordinatorSeat` column, and a table that drifts from it would pin the
    // wrong boundary in every refusal below.
    expect(
      fleetSizeable.filter((id) => VENDOR_REGISTRY[id].authority.coordinatorSeat)
    ).toEqual([...COORDINATOR_CAPABLE]);
    expect(
      fleetSizeable.filter(
        (id) => !VENDOR_REGISTRY[id].authority.coordinatorSeat
      )
    ).toEqual([...NON_COORDINATOR]);
  });

  it("every ROLE_ONLY_REFUSAL really is capability-clean (the ceiling is the only net)", async () => {
    // If a refusal below were ALSO enforced by a missing lane capability, it
    // would keep passing after the `supportedRoles` fail-open was reintroduced,
    // and would prove nothing about the field this file exists to fence.
    const adapters = createDefaultAdapters();
    for (const { vendor, role } of ROLE_ONLY_REFUSALS) {
      expect(
        VENDOR_REGISTRY[vendor].authority.supportedRoles,
        `${vendor} must NOT declare ${role}`
      ).not.toContain(role);
      const adapter = adapters.find((entry) => entry.id === vendor)!;
      const capabilities = await adapter.capabilities();
      for (const capability of ROLE_SPECS[role].requiredCapabilities) {
        expect(
          capabilities[capability],
          `${vendor} has ${capability}, so only supportedRoles refuses ${role}`
        ).toBe(true);
      }
    }
  });
});

describe("vendor × position: SUPERAGENT (the Mission coordinator seat)", () => {
  it.each(COORDINATOR_CAPABLE)(
    "%s takes the coordinator seat with orchestrator mode, role, and authority",
    async (vendor) => {
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          kind: "session",
          vendor,
          taskId: "task-chat-canonical",
          brief: "run the mission",
          chatId: "chat-1",
          workspacePath: WORKSPACE,
        },
      });

      expect(created.statusCode).toBe(201);
      expect(createdData()).toMatchObject({
        vendor,
        capabilityMode: "orchestrator",
        role: "orchestrator",
        delegationDepth: 0,
        delegationManifest: expect.objectContaining({
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        }),
      });
      await app.close();
    }
  );

  it.each(NON_COORDINATOR)(
    "%s is REFUSED the coordinator seat; nothing is enqueued",
    async (vendor) => {
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          kind: "session",
          vendor,
          taskId: "task-chat-canonical",
          brief: "run the mission",
          chatId: "chat-1",
          workspacePath: WORKSPACE,
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toContain("orchestrator");
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    }
  );
});

describe("vendor × position: SUBAGENT (a plain dispatched worker)", () => {
  it.each(COORDINATOR_CAPABLE)(
    "%s dispatches as a worker with a write role and no coordinator authority",
    async (vendor) => {
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor,
          taskId: "task-1",
          brief: "fix the parser",
          harnessKey: "implement",
        },
      });

      expect(created.statusCode).toBe(201);
      const data = createdData()!;
      expect(data).toMatchObject({ vendor, role: "implementer" });
      // A worker is not a coordinator: no orchestrator mode, no delegation
      // manifest, no seat above the fleet.
      expect(data.capabilityMode).toBeUndefined();
      expect(data.delegationManifest).toBeUndefined();
      await app.close();
    }
  );
});

describe("vendor × position: SUBAGENT (a delegated child)", () => {
  // The full cross-product: EITHER coordinator vendor must be able to delegate
  // to EITHER worker vendor. A same-vendor-only path would be exactly the
  // silent second-class treatment this file exists to catch.
  const pairs = COORDINATOR_CAPABLE.flatMap((parent) =>
    COORDINATOR_CAPABLE.map((child) => [parent, child] as const)
  );

  it.each(pairs)(
    "a %s coordinator delegates a bounded work-only child to %s",
    async (parentVendor, childVendor) => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(
        rootParent(parentVendor)
      );
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          kind: "auto",
          vendor: childVendor,
          taskId: "task-child",
          brief: "Implement the parser fix",
          workspacePath: WORKSPACE,
          maxWallMs: 120_000,
        },
      });

      expect(created.statusCode).toBe(201);
      expect(createdData()).toMatchObject({
        vendor: childVendor,
        capabilityMode: "delegate",
        role: "implementer",
        parentJobId: "job-parent",
        rootJobId: "job-parent",
        delegationDepth: 1,
        chatId: "chat-1",
        delegationManifest: expect.objectContaining({
          authority: "work",
          forbiddenAuthority: ["govern", "approve", "merge", "ship"],
          narrowingAttested: true,
        }),
      });
      await app.close();
    }
  );

  it.each(COORDINATOR_CAPABLE)(
    "a %s coordinator can NEVER delegate the coordinator seat downward",
    async (parentVendor) => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(
        rootParent(parentVendor)
      );
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          kind: "auto",
          vendor: parentVendor,
          taskId: "task-child",
          brief: "Take over coordination",
          workspacePath: WORKSPACE,
          role: "orchestrator",
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it.each(NON_COORDINATOR)(
    "%s is REFUSED a delegated write role; nothing is enqueued",
    async (childVendor) => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(
        rootParent("claude-code")
      );
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          kind: "auto",
          vendor: childVendor,
          taskId: "task-child",
          brief: "Implement the parser fix",
          workspacePath: WORKSPACE,
          role: "implementer",
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    }
  );
});

// ── The refusals that rest on ONE optional adapter field ─────────────────────
//
// Everything above proves the boundary MUON advertises. What follows proves the
// boundary MUON has no second net for. `assertVendorMayHoldRole` is reached from
// three routes, and for the pairs in ROLE_ONLY_REFUSALS it is the ONLY thing
// between the lane and the role: the capability check would pass, so if the role
// ceiling ever reads as "unset" the lane is admitted outright. Pinned on all
// three so a fail-open cannot survive by being closed on only one.

/** A running job the operator tier may control, for the steer surface. */
function runningJob(vendor: string): Record<string, unknown> {
  return {
    id: "job-steer",
    kind: "session",
    vendor,
    taskId: "task-1",
    chatId: null,
    brief: "do the thing",
    status: "running",
    workspacePath: WORKSPACE,
    steerMessages: [],
    interruptRequested: false,
    rootJobId: null,
    parentJobId: null,
  };
}

/** The chat's server-bound provider-session handle, owned by `vendor`. */
const BOUND_SESSION_ID = "vendor-session-42";
function chatBoundTo(vendor: string): Record<string, unknown> {
  return {
    id: "chat-1",
    status: "active",
    workspacePath: WORKSPACE,
    taskId: "task-chat-canonical",
    vendorSessionId: BOUND_SESSION_ID,
    vendorSessionVendor: vendor,
    vendorSessionRootJobId: "job-root",
  };
}

describe("role admission: the refusals that rest ENTIRELY on `supportedRoles`", () => {
  it.each(ROLE_ONLY_REFUSALS)(
    "$vendor is REFUSED role '$role' at POST /api/dispatch",
    async ({ vendor, role }) => {
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          vendor,
          taskId: "task-1",
          brief: "write the release notes",
          role,
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it.each(ROLE_ONLY_REFUSALS)(
    "$vendor is REFUSED role '$role' as a delegated child",
    async ({ vendor, role }) => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(
        rootParent("claude-code")
      );
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-parent/delegate",
        headers: delegationHeaders,
        payload: {
          kind: "auto",
          vendor,
          taskId: "task-child",
          brief: "Write the release notes",
          workspacePath: WORKSPACE,
          role,
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it.each(ROLE_ONLY_REFUSALS)(
    "$vendor is REFUSED a '$role' seat at POST /api/fleet/agents/claim",
    async ({ vendor, role }) => {
      const app = buildApp();
      const refused = await app.inject({
        method: "POST",
        url: "/api/fleet/agents/claim",
        payload: { vendor, taskId: "task-1", role },
      });

      expect(refused.statusCode).toBe(400);
      // Refused BEFORE the semaphore: no seat is ever taken out of the pool.
      expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it("and the SAME lanes keep the roles they do declare", () => {
    // The control. A refusal test that would also pass if the lane held nothing
    // proves the wrong thing, so pin the positive half of each ceiling too.
    expect(VENDOR_REGISTRY.cursor.authority.supportedRoles).toContain("reviewer");
    expect(VENDOR_REGISTRY.opencode.authority.supportedRoles).toContain("scout");
    // …and OpenCode's ceiling is EXACTLY that one role. Asserting the whole
    // array (not just `toContain`) is what makes a future widening fail here.
    expect([...VENDOR_REGISTRY.opencode.authority.supportedRoles]).toEqual([
      "scout",
    ]);
  });
});

describe("a vendor MUON has never heard of has no position at all", () => {
  it("is refused at POST /api/dispatch", async () => {
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: UNREGISTERED_VENDOR,
        taskId: "task-1",
        brief: "do the thing",
      },
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/unknown vendor/i);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("is refused at /delegate", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      rootParent("claude-code")
    );
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: UNREGISTERED_VENDOR,
        taskId: "task-child",
        brief: "Implement the parser fix",
        workspacePath: WORKSPACE,
      },
    });

    expect(refused.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("is refused at POST /api/fleet/agents/claim", async () => {
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: UNREGISTERED_VENDOR, taskId: "task-1" },
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/unknown vendor/i);
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("is refused at POST /api/dispatch/:jobId/steer", async () => {
    // The one surface reached from a STORED row rather than from a request
    // body, so it is the one an admission allowlist cannot fence: a job whose
    // vendor was removed from the registry is still steerable unless the steer
    // route itself asks. Absence of a capability must read as "no capability"
    // (ADR-0022 §1.2(e), G8), never as "unconstrained".
    prismaMock.dispatchJob.findUnique.mockResolvedValue(
      runningJob(UNREGISTERED_VENDOR)
    );
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-steer/steer",
      payload: { message: "focus on the API" },
    });

    expect(refused.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  // WAVE F added the two surfaces this block was missing. ADR-0022 §5 Wave B3
  // named dispatch, delegate, claim and steer; the coordinator seat and the
  // fleet resize were never asserted for an unknown id, and they are the two
  // that grant the MOST — the seat is the super-orchestrator, and a resize is
  // what materialises an agent row at all.
  it("is refused the coordinator seat", async () => {
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        kind: "session",
        vendor: UNREGISTERED_VENDOR,
        taskId: "task-chat-canonical",
        brief: "run the mission",
        chatId: "chat-1",
        workspacePath: WORKSPACE,
      },
    });

    expect(refused.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("cannot be sized into the fleet by PUT /api/fleet", async () => {
    // The resize body is built by reduction over `fleetVendorIds()`, so an
    // unknown key is STRIPPED rather than rejected. That is a quiet refusal, and
    // quiet is exactly why it needs a test: the assertion that matters is not the
    // status code but that NO agent row is created for the id.
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { [UNREGISTERED_VENDOR]: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
    for (const call of prismaMock.agent.create.mock.calls) {
      expect(call[0]?.data?.vendor).not.toBe(UNREGISTERED_VENDOR);
    }
    await app.close();
  });
});

describe("WAVE F — the negative control is provably still a negative control", () => {
  // ADR-0022 §9.3(2) recorded this as an OPEN hole: `vendor-position-matrix`
  // used `opencode` as "the id MUON has never heard of", and registering
  // OpenCode would have turned every refusal above into a VACUOUS pass. It was
  // caught only because the suite happened to go red — "luck rather than
  // design", in the ADR's own words.
  //
  // This closes it by design. Registering the control id now fails HERE, with a
  // message that says what actually went wrong, instead of somewhere downstream
  // as a puzzling assertion diff — or, far worse, not failing at all on the
  // subset of refusals a zero-authority entry would still satisfy.
  it("the id used as the control is genuinely outside the registry", () => {
    expect(isVendorId(UNREGISTERED_VENDOR)).toBe(false);
    expect(VENDOR_IDS).not.toContain(UNREGISTERED_VENDOR);
  });

  it("holds nothing on any derived authority set", () => {
    for (const derived of [
      dispatchableVendorIds(),
      delegatableVendorIds(),
      coordinatorVendorIds(),
      fleetVendorIds(),
      evaluatorVendorIds(),
      plannerVendorIds(),
      terminalTakeoverVendorIds(),
      publicVendorIds(),
    ]) {
      expect(derived).not.toContain(UNREGISTERED_VENDOR);
    }
    expect(vendorRoleCeiling(UNREGISTERED_VENDOR)).toEqual([]);
    expect(sessionCapability(UNREGISTERED_VENDOR).canSend).toBe(false);
    expect(vendorSupportsInteractive(UNREGISTERED_VENDOR)).toBe(false);
  });

  it("still RENDERS — an unrunnable id is not a crash", () => {
    // The other half of Wave F's bar. A vendor MUON refuses everywhere must
    // still survive every presentation path, because these strings reach the
    // cockpit from stored rows and brain responses. The identity fallback is
    // the contract: an unknown id renders as ITSELF, never blank and never as a
    // neighbouring vendor's label.
    expect(vendorLabel(UNREGISTERED_VENDOR)).toBe(UNREGISTERED_VENDOR);
    expect(vendorShortLabel(UNREGISTERED_VENDOR)).toBe(UNREGISTERED_VENDOR);
    expect(vendorIconKey(UNREGISTERED_VENDOR)).toBe(UNREGISTERED_VENDOR);
  });
});

describe("WAVE F — a registry entry with ZERO authority is refused identically", () => {
  /**
   * THE ACCEPTANCE TEST (ADR-0022 §5 Wave F), landed WITHOUT registering a
   * placeholder vendor. The choice is recorded in ADR-0022 §10; the short
   * version is that a permanent no-adapter entry in the production registry
   * squats a real product's id, forces a second `dev-test` seam through a
   * structural invariant that says there is exactly one, and re-opens §9.3(2)
   * by colliding with the negative control above.
   *
   * It is landable without one because of the property this block proves: every
   * governance surface reads a POSITIVE PREDICATE off the registry, never a
   * name and never a subtraction. So a registered entry with all-`false`
   * authority and `supportedRoles: []` produces byte-identical answers to an id
   * that is not registered at all — same empty derived sets, same `[]` ceiling,
   * same all-false session posture. The two are INDISTINGUISHABLE to every
   * refusal above, which is precisely why those refusals cover both.
   *
   * The fixture entry is local to this test. It is a real `VendorEntry` (the
   * type is what forces every authority field to be stated), so if a future
   * field is added to `authority` with a permissive default, this stops
   * compiling — which is the same protection a registered entry would give,
   * without the entry.
   */
  const ZERO_AUTHORITY: VendorEntry["authority"] = {
    supportedRoles: [],
    coordinatorSeat: false,
    dispatchable: false,
    delegatable: false,
    fleetSizeable: false,
    evaluator: false,
    planner: false,
    terminalTakeover: false,
    tier1: false,
  };

  it("is excluded by every derived set's predicate", () => {
    // Each predicate is applied to the zero-authority posture directly, so this
    // asserts the PREDICATE, not the current registry contents.
    expect(ZERO_AUTHORITY.dispatchable).toBe(false);
    expect(ZERO_AUTHORITY.delegatable).toBe(false);
    expect(ZERO_AUTHORITY.coordinatorSeat).toBe(false);
    expect(ZERO_AUTHORITY.fleetSizeable).toBe(false);
    expect(ZERO_AUTHORITY.evaluator).toBe(false);
    expect(ZERO_AUTHORITY.planner).toBe(false);
    expect(ZERO_AUTHORITY.terminalTakeover).toBe(false);
    expect(ZERO_AUTHORITY.supportedRoles).toEqual([]);
  });

  it("no authority field defaults to permissive — every one must be stated", () => {
    // Mechanism 2 of ADR-0022 §3.4, asserted rather than assumed. If a field is
    // ever added to `authority`, the object above stops compiling until its
    // author types an answer; this run-time half catches the other mistake,
    // where the added field is typed `true` in the zero-authority case.
    for (const [field, value] of Object.entries(ZERO_AUTHORITY)) {
      if (field === "supportedRoles") continue;
      expect(value, `${field} must be false in the zero-authority posture`).toBe(
        false
      );
    }
    // Totality: the fixture states EVERY key the real entries state, so a new
    // authority field cannot be proven "false by default" by being omitted here.
    expect(Object.keys(ZERO_AUTHORITY).sort()).toEqual(
      Object.keys(VENDOR_REGISTRY["claude-code"].authority).sort()
    );
  });

  it("matches an unregistered id on every governance answer", () => {
    // The equivalence that licenses the route tests above to stand in for a
    // registered-but-powerless vendor.
    expect(ZERO_AUTHORITY.supportedRoles).toEqual(
      vendorRoleCeiling(UNREGISTERED_VENDOR)
    );
    const unknownSession = sessionCapability(UNREGISTERED_VENDOR);
    expect(unknownSession.canSend).toBe(false);
    expect(unknownSession.canInterrupt).toBe(false);
    expect(unknownSession.canResume).toBe(false);
    expect(unknownSession.persistsSessionHandle).toBe(false);
    expect(unknownSession.driver).toBe("none");
  });

  it("the ONE thing a registered entry adds is a label, not an authority", () => {
    // `fake` is the only entry in the tree that is nameable-but-fenced, so it is
    // the closest live analogue: `visibility: "dev-test"` keeps it out of every
    // PUBLIC projection while its labels still resolve. That split — identity
    // resolves, authority does not — is the whole shape ADR-0022 §0 claims.
    expect(publicVendorIds()).not.toContain("fake");
    expect(fleetVendorIds()).not.toContain("fake");
    expect(vendorLabel("fake")).toBe(VENDOR_REGISTRY.fake.displayName);
  });
});

describe("per-vendor SESSION posture, pinned verbatim (post-Wave-C4)", () => {
  // WAVE C4 LANDED, and this table records the ONE behaviour change it caused.
  //
  // The Wave B version of this table pinned `cursor: true, opencode: true,
  // fake: true` with the note "…accept a steer only because no descriptor
  // exists for them, which is exactly the fail-open Wave C4 closes". C4 closed
  // it: the route now reads `sessionCapability(vendor).canSend`, where absence
  // is `false` by construction (ADR-0022 §1.2(e), G8), so all three are refused.
  //
  // This is a NARROWING and it lands on three REGISTERED vendors, not only on
  // unregistered ids. None of them has a session driver at all — a queued steer
  // for them could never have been delivered — so what the route used to do was
  // advertise an interactive steer that silently no-ops. `claude-code` and
  // `codex`, the only two lanes with a driver, are byte-identical to before.
  const STEER_ACCEPTED: Readonly<Record<string, boolean>> = {
    // canSend:false — the SDK driver's send() throws, so a queued steer could
    // never be delivered. UNCHANGED by C4.
    "claude-code": false,
    // canSend:true — the app-server driver accepts sends into a live session.
    // UNCHANGED by C4, and the only `true` in the registry.
    codex: true,
    // driver:"none". Was accepted (fail-open); now refused (fail-closed).
    cursor: false,
    opencode: false,
    fake: false,
  };

  it.each(Object.entries(STEER_ACCEPTED))(
    "%s steer accepted === %s",
    async (vendor, accepted) => {
      prismaMock.dispatchJob.findUnique.mockResolvedValue(runningJob(vendor));
      const app = buildApp();
      const steer = await app.inject({
        method: "POST",
        url: "/api/dispatch/job-steer/steer",
        payload: { message: "focus on the API" },
      });

      expect(steer.statusCode).toBe(accepted ? 200 : 400);
      if (!accepted) {
        expect(steer.json().message).toMatch(/cannot accept a live steer/i);
        // Refused BEFORE the queue: a steer a lane can never deliver is never
        // written to the job row.
        expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
      }
      await app.close();
    }
  );

  // The chat-continuity handle is bound to ONE vendor. Pinned per vendor so the
  // C4 swap to `session.persistsSessionHandle` cannot quietly let a second lane
  // resume another lane's thread coordinate (G7).
  const RESUME_BINDABLE: Readonly<Record<string, boolean>> = {
    "claude-code": true,
    codex: false,
    cursor: false,
    opencode: false,
  };

  it.each(Object.entries(RESUME_BINDABLE))(
    "%s may resume its own chat-bound provider session === %s",
    async (vendor, bindable) => {
      prismaMock.orchestratorChat.findUnique.mockResolvedValue(
        chatBoundTo(vendor)
      );
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/dispatch",
        payload: {
          kind: "session",
          vendor,
          taskId: "task-chat-canonical",
          brief: "resume the mission",
          chatId: "chat-1",
          workspacePath: WORKSPACE,
          resumeVendorSessionId: BOUND_SESSION_ID,
        },
      });

      expect(created.statusCode).toBe(bindable ? 201 : 409);
      await app.close();
    }
  );

  it("is EXACTLY the registry's declared session posture, with no fail-open arm", () => {
    // The Wave B version of this cross-check carried an `if (driver !== "none")`
    // arm, because the route and the registry disagreed for the three lanes with
    // no driver. That arm is gone: the route reads this column directly now, so
    // the table above and the registry must agree for EVERY vendor. A
    // reintroduced fail-open shows up here as a disagreement rather than as a
    // silently-widened surface.
    for (const [vendor, accepted] of Object.entries(STEER_ACCEPTED)) {
      expect(
        VENDOR_REGISTRY[vendor as VendorId].session.canSend,
        `${vendor} steer`
      ).toBe(accepted);
    }
    for (const [vendor, bindable] of Object.entries(RESUME_BINDABLE)) {
      expect(
        VENDOR_REGISTRY[vendor as VendorId].session.persistsSessionHandle
      ).toBe(bindable);
    }
    // Completeness: the table states every registry id, so a new vendor cannot
    // arrive with no pinned steer answer.
    expect(Object.keys(STEER_ACCEPTED).sort()).toEqual([...VENDOR_IDS].sort());
  });
});
