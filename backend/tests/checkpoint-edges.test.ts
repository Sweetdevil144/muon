import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

// ── P0.1 checkpoint edges (Slice A) ──────────────────────────────────────────
//
// The ledger IS the checkpoint: the job→gate edge (`ApprovalRequest.jobId`),
// the job→session edge (`LaneSession.jobId`), and the single-use command-
// approval delivery stamp (`POST /api/approvals/:id/consume`) are the durable
// truths a resume planner later reads. These tests pin the route behavior:
// bindings persist at create time and consumption is a one-way, guarded,
// command-only updateMany (mirroring redeemGateAtRoute: no TOCTOU window).

type StoredApproval = {
  kind: string;
  status: string;
  consumedAt: Date | null;
};

// Module-level in-memory approvals store so the guarded `updateMany` the
// consume route relies on is modeled faithfully (single-use semantics are the
// point, not a canned count). Reset in beforeEach.
const approvalStore = new Map<string, StoredApproval>();

const prismaMock = vi.hoisted(() => ({
  approvalRequest: {
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  task: {
    update: vi.fn(),
  },
  laneSession: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  dispatchJob: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const EVIDENCE = {
  action: "Bash",
  scope: "Command: npm test",
  riskLevel: "high",
  impactIfApproved:
    "Runs a shell command in the selected workspace and may read, modify, or delete files.",
  payloadDigest: "a".repeat(64),
  details: { command: "npm test", sessionId: "session-1" },
};

describe("checkpoint edges (P0.1 Slice A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalStore.clear();

    prismaMock.approvalRequest.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "approval-1",
        status: "pending",
        consumedAt: null,
        decidedAt: null,
        createdAt: new Date("2026-07-16T00:00:00.000Z"),
        ...data,
      })
    );
    prismaMock.approvalRequest.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: {
          id: string;
          kind?: string;
          status?: string;
          consumedAt?: Date | null;
        };
        data: { consumedAt?: Date };
      }) => {
        const entry = approvalStore.get(where.id);
        if (!entry) return { count: 0 };
        if (where.kind !== undefined && entry.kind !== where.kind)
          return { count: 0 };
        if (where.status !== undefined && entry.status !== where.status)
          return { count: 0 };
        if (where.consumedAt === null && entry.consumedAt !== null)
          return { count: 0 };
        if (data.consumedAt) entry.consumedAt = data.consumedAt;
        return { count: 1 };
      }
    );
    prismaMock.task.update.mockResolvedValue({ id: "task-1", status: "review" });
    prismaMock.laneSession.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "session-1",
        status: "running",
        startedAt: new Date("2026-07-16T00:00:00.000Z"),
        endedAt: null,
        lane: { id: "lane-1", key: "claude-code", name: "Claude Code" },
        ...data,
      })
    );
  });

  it("approvals POST persists the jobId binding on the row", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals",
      payload: {
        taskId: "task-1",
        requestedBy: "claude-code",
        kind: "command",
        reason: "session tool 'Bash' (session session-1)",
        evidence: EVIDENCE,
        jobId: "job-42",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(prismaMock.approvalRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobId: "job-42" }),
    });
    await app.close();
  });

  it("approvals GET derives laneVendor from the LEDGER's job row, null when unbound", async () => {
    // Vendor-scoped standing consent reads this: the vendor must come from the
    // brain's own DispatchJob row for the persisted binding, never from
    // anything the caller asserts, and an unbound gate must read null so a
    // subset selection fails closed on it.
    prismaMock.approvalRequest.findMany.mockResolvedValue([
      { id: "approval-a", taskId: "task-1", status: "pending", jobId: "job-42" },
      { id: "approval-b", taskId: "task-1", status: "pending", jobId: null },
      {
        id: "approval-c",
        taskId: "task-1",
        status: "pending",
        jobId: "job-unknown",
      },
    ]);
    prismaMock.dispatchJob.findMany.mockResolvedValue([
      { id: "job-42", vendor: "codex", capabilityMode: "worker" },
    ]);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/approvals" });
    expect(res.statusCode).toBe(200);
    const rows = res.json().approvals as Array<{
      id: string;
      laneVendor: string | null;
    }>;
    expect(rows.find((r) => r.id === "approval-a")?.laneVendor).toBe("codex");
    expect(rows.find((r) => r.id === "approval-b")?.laneVendor).toBeNull();
    // A binding naming a job the ledger does not know resolves to null — never
    // a guess, never an error that hides the rest of the queue.
    expect(rows.find((r) => r.id === "approval-c")?.laneVendor).toBeNull();
    expect(prismaMock.dispatchJob.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["job-42", "job-unknown"] } },
      select: { id: true, vendor: true, capabilityMode: true },
    });
    await app.close();
  });

  // A COORDINATOR-filed gate is filed by the coordinator's own job but its
  // authority acts elsewhere — `set_fleet({codex:3})`, `raise_budget` over the
  // whole tree, `apply_workflow` across lanes. Attributing it to the
  // coordinator's vendor would let a consent granted for lane A auto-approve an
  // action on lane B, so it must carry NO lane and fail closed under a subset.
  it("refuses to attribute a lane to a COORDINATOR-filed gate", async () => {
    prismaMock.approvalRequest.findMany.mockResolvedValue([
      { id: "gate-fleet", taskId: "task-1", status: "pending", jobId: "job-coord" },
      { id: "gate-worker", taskId: "task-1", status: "pending", jobId: "job-worker" },
    ]);
    prismaMock.dispatchJob.findMany.mockResolvedValue([
      { id: "job-coord", vendor: "claude-code", capabilityMode: "orchestrator" },
      { id: "job-worker", vendor: "claude-code", capabilityMode: "worker" },
    ]);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/approvals" });
    const rows = res.json().approvals as Array<{
      id: string;
      laneVendor: string | null;
    }>;
    expect(rows.find((r) => r.id === "gate-fleet")?.laneVendor).toBeNull();
    expect(rows.find((r) => r.id === "gate-worker")?.laneVendor).toBe(
      "claude-code"
    );
    await app.close();
  });

  it("approvals POST without a jobId stays valid (column is additive)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/approvals",
      payload: {
        taskId: "task-1",
        requestedBy: "claude-code",
        kind: "command",
        reason: "session tool 'Bash' (session session-1)",
        evidence: EVIDENCE,
      },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("consume stamps an approved, unconsumed command approval exactly once", async () => {
    approvalStore.set("approval-ok", {
      kind: "command",
      status: "approved",
      consumedAt: null,
    });
    const app = buildApp();

    const first = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-ok/consume",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ consumed: true });
    expect(approvalStore.get("approval-ok")!.consumedAt).toBeInstanceOf(Date);
    // The guarded updateMany carries the full single-use predicate: command
    // kind, operator-approved, never consumed. One statement, no read-then-write.
    expect(prismaMock.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: "approval-ok",
        kind: "command",
        status: "approved",
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });

    // Replay: the stamp is one-way and never un-set, so the second consume 409s.
    const second = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-ok/consume",
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it("refuses to consume a pending (undecided) command approval", async () => {
    approvalStore.set("approval-pending", {
      kind: "command",
      status: "pending",
      consumedAt: null,
    });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-pending/consume",
    });
    expect(res.statusCode).toBe(409);
    expect(approvalStore.get("approval-pending")!.consumedAt).toBeNull();
    await app.close();
  });

  it("never consumes a route gate here: kind 'gate' is 409 (redeemGateAtRoute stays exclusive)", async () => {
    approvalStore.set("approval-gate", {
      kind: "gate",
      status: "approved",
      consumedAt: null,
    });
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-gate/consume",
    });
    expect(res.statusCode).toBe(409);
    expect(approvalStore.get("approval-gate")!.consumedAt).toBeNull();
    await app.close();
  });

  it("sessions POST persists the jobId binding on the row", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        laneId: "lane-1",
        taskId: "task-1",
        jobId: "job-42",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(prismaMock.laneSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobId: "job-42" }),
      include: { lane: true },
    });
    await app.close();
  });
});
