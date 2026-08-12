import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

// The dev/test `fake` vendor must be reachable ONLY when MUON_FAKE_VENDOR=1.
// This locks that guard on the dispatch route, the DELEGATE route, and the
// fleet claim route so a production run can never reach the fake adapter.
//
// The seam is deliberately TWO-CONDITION (ADR-0022): the registry marks the
// entry `visibility: "dev-test"`, AND `fakeVendorEnabled()` is read LIVE at each
// call. Neither alone admits it, and the env read is never folded into the
// registry — a module-load evaluation would freeze the seam.

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    create: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  agent: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  delegationGrant: { findUnique: vi.fn(), upsert: vi.fn() },
  approvalRequest: { findMany: vi.fn(), updateMany: vi.fn() },
  runner: { findFirst: vi.fn(), updateMany: vi.fn() },
  laneSession: { updateMany: vi.fn() },
  harness: { findUnique: vi.fn() },
  crewRoleBinding: { findMany: vi.fn() },
  orchestratorChat: { findUnique: vi.fn() },
  streamChunk: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const FAKE_JOB = {
  id: "job-fake",
  kind: "oneshot",
  vendor: "fake",
  taskId: "task-1",
  brief: "fake work",
  status: "queued",
  agentId: null,
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  result: null,
  exitCode: null,
  createdAt: new Date("2026-07-12T00:00:00.000Z"),
  startedAt: null,
  endedAt: null,
};

const FAKE_AGENT = {
  id: "agent-fake-1",
  vendor: "fake",
  name: "fake-1",
  ordinal: 1,
  status: "idle",
  currentTaskId: null,
  sessionId: null,
  createdAt: new Date("2026-07-12T00:00:00.000Z"),
  updatedAt: new Date("2026-07-12T00:00:00.000Z"),
};

const WORKSPACE = process.cwd();
const DELEGATION_TOKEN = `delegate-${"d".repeat(55)}`;

/** A running orchestrator root the delegate route can hang a child off. */
const ROOT_PARENT = (() => {
  const delegationDeadline = new Date(Date.now() + 600_000);
  return {
    id: "job-parent",
    kind: "session",
    vendor: "claude-code",
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
})();

function delegateFake() {
  return {
    method: "POST" as const,
    url: "/api/dispatch/job-parent/delegate",
    headers: { "x-muon-delegation-token": DELEGATION_TOKEN },
    payload: {
      kind: "auto",
      vendor: "fake",
      taskId: "task-child",
      brief: "fake delegated work",
      workspacePath: WORKSPACE,
    },
  };
}

describe("fake vendor guard (MUON_FAKE_VENDOR seam)", () => {
  const originalEnv = process.env.MUON_FAKE_VENDOR;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchJob.create.mockResolvedValue(FAKE_JOB);
    prismaMock.agent.findFirst.mockResolvedValue(FAKE_AGENT);
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agent.findUnique.mockResolvedValue({ ...FAKE_AGENT, status: "working" });
    prismaMock.agent.count.mockResolvedValue(0);
    prismaMock.dispatchJob.count.mockResolvedValue(0);
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.dispatchJob.findUnique.mockResolvedValue(ROOT_PARENT);
    prismaMock.harness.findUnique.mockImplementation(
      async ({ where }: { where: { key: string } }) => ({ key: where.key })
    );
    prismaMock.crewRoleBinding.findMany.mockResolvedValue([]);
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-parent",
      tokenHash: createHash("sha256").update(DELEGATION_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    prismaMock.delegationGrant.upsert.mockResolvedValue({});
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: null,
      vendorSessionVendor: null,
      vendorSessionRootJobId: null,
    });
    prismaMock.streamChunk.create.mockResolvedValue({ seq: 1 });
    prismaMock.$transaction.mockImplementation(
      async (work: ((tx: typeof prismaMock) => unknown) | Promise<unknown>[]) =>
        Array.isArray(work) ? Promise.all(work) : work(prismaMock)
    );
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MUON_FAKE_VENDOR;
    else process.env.MUON_FAKE_VENDOR = originalEnv;
  });

  it("rejects a 'fake' dispatch (400) when the seam is DISABLED", async () => {
    delete process.env.MUON_FAKE_VENDOR;
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: { vendor: "fake", kind: "oneshot", taskId: "task-1", brief: "fake work" },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  // Cursor's boundary moved from the VENDOR to the ROLE: it is a managed
  // read-only lane, so write-class work is still refused before any enqueue —
  // now with a reason the caller can act on.
  it("rejects Cursor dispatch for a write-class role", async () => {
    delete process.env.MUON_FAKE_VENDOR;
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "cursor",
        kind: "oneshot",
        taskId: "task-1",
        brief: "must not enqueue",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(
      /Cursor is a managed READ-ONLY lane.*implementer/i
    );
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a Cursor fleet claim that does not name a read-only role", async () => {
    delete process.env.MUON_FAKE_VENDOR;
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "cursor", taskId: "task-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(
      /managed for read-only crew roles only/i
    );
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a 'fake' agent claim (400) when the seam is DISABLED", async () => {
    delete process.env.MUON_FAKE_VENDOR;
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "fake", taskId: "task-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a 'fake' dispatch (201) when the seam is ENABLED", async () => {
    process.env.MUON_FAKE_VENDOR = "1";
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: { vendor: "fake", kind: "oneshot", taskId: "task-1", brief: "fake work" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().job.vendor).toBe("fake");
    await app.close();
  });

  it("accepts a 'fake' agent claim (201) when the seam is ENABLED", async () => {
    process.env.MUON_FAKE_VENDOR = "1";
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "fake", taskId: "task-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().agent.vendor).toBe("fake");
    await app.close();
  });

  // ADR-0022 C2 closed a real asymmetry: `delegateDispatchSchema.vendor` used to
  // hardcode its own four-vendor enum and OMITTED the `fake` seam that the
  // create route admits, so the dev/test double could be dispatched but never
  // delegated to. Both routes now read `authority.delegatable` through the SAME
  // two-condition seam — which is why both halves are pinned here.
  it("rejects a 'fake' delegate (400) when the seam is DISABLED", async () => {
    delete process.env.MUON_FAKE_VENDOR;
    const app = buildApp();
    const res = await app.inject(delegateFake());
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a 'fake' delegate (201) when the seam is ENABLED", async () => {
    process.env.MUON_FAKE_VENDOR = "1";
    const app = buildApp();
    prismaMock.dispatchJob.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data
    );
    const res = await app.inject(delegateFake());
    expect(res.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalled();
    await app.close();
  });

  it("still rejects an unknown vendor at /delegate even with the seam enabled", async () => {
    // The seam opens for `fake` and for nothing else: an id outside the registry
    // has no `delegatable` column to be true.
    process.env.MUON_FAKE_VENDOR = "1";
    const app = buildApp();
    const res = await app.inject({
      ...delegateFake(),
      payload: { ...delegateFake().payload, vendor: "not-a-vendor" },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("still rejects an unknown vendor (400) even with the seam enabled", async () => {
    process.env.MUON_FAKE_VENDOR = "1";
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: { vendor: "not-a-vendor", kind: "oneshot", taskId: "task-1", brief: "x" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
