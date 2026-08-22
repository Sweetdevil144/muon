import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

/**
 * A CHATLESS TASK CAN CITE ITS OWN PACKET (A5/A12).
 *
 * The packet-citation guard proves "same mission" by comparing chat partitions,
 * and a null chat on either side is correctly NOT a match — `null === null`
 * once let two unrelated chatless tasks cite each other. But the guard never
 * looked at the other proof it already had selected: the packet's own `taskId`.
 * `POST /tasks` from an operator leaves `chatId` null, so a continue-on-lane
 * citing that task's own wrap packet 409'd with "a chatless task has no
 * partition to prove" — refused on its own lineage.
 *
 * Same task is a strictly narrower claim than same mission, and it is admitted
 * only when NEITHER side names a chat, so the hole the null check closed stays
 * closed. Both directions are pinned here, on both routes.
 */

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
  harness: { findUnique: vi.fn() },
  crewRoleBinding: { findMany: vi.fn() },
  orchestratorChat: { findUnique: vi.fn() },
  delegationGrant: { findUnique: vi.fn(), upsert: vi.fn() },
  agent: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  lane: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
  handoff: { create: vi.fn(), findUnique: vi.fn() },
  event: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const TEST_WORKSPACE = process.cwd();
const DELEGATION_TOKEN = `delegate-${"c".repeat(55)}`;
const delegationHeaders = {
  "x-muon-delegation-token": DELEGATION_TOKEN,
};
const JOB = {
  id: "job-1",
  kind: "auto",
  vendor: "claude-code",
  taskId: "task-1",
  brief: "fix the thing",
  status: "queued",
  agentId: null,
  host: null,
  runnerLeaseHash: null,
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  result: null,
  exitCode: null,
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  startedAt: null,
  endedAt: null,
};

/** A live coordinator parent, so the delegate route reaches its citation guard.
 *  Its own chat is irrelevant to that guard — the comparison is between the
 *  CITED PACKET's task and the CHILD's target task. */
function rootParent(): Record<string, unknown> {
  const delegationDeadline = new Date(Date.now() + 600_000);
  return {
    ...JOB,
    id: "job-parent",
    kind: "session",
    chatId: "chat-1",
    status: "running",
    workspacePath: TEST_WORKSPACE,
    maxWallMs: 600_000,
    startedAt: new Date(),
    capabilityMode: "orchestrator",
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
      workspacePath: TEST_WORKSPACE,
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

describe("a chatless task's own packet is citable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchJob.create.mockResolvedValue(JOB);
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(JOB);
    prismaMock.dispatchJob.update.mockResolvedValue(JOB);
    // The delegate path RESERVES capacity with a conditional updateMany and
    // refuses unless exactly one row moved.
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.dispatchJob.count.mockResolvedValue(0);
    prismaMock.harness.findUnique.mockResolvedValue({ key: "repair" });
    prismaMock.crewRoleBinding.findMany.mockResolvedValue([]);
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      id: "chat-1",
      status: "active",
      workspacePath: TEST_WORKSPACE,
      taskId: "task-chat-canonical",
      vendorSessionId: null,
      vendorSessionVendor: null,
      vendorSessionRootJobId: null,
    });
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-parent",
      tokenHash: createHash("sha256").update(DELEGATION_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    prismaMock.delegationGrant.upsert.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation(
      async (
        work: ((tx: typeof prismaMock) => unknown) | Promise<unknown>[]
      ) => (Array.isArray(work) ? Promise.all(work) : work(prismaMock))
    );
  });

  // ── the root route ────────────────────────────────────────────────────────
  it("root: a chatless dispatch cites ITS OWN task's packet (201)", async () => {
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-1",
      task: { chatId: null },
    });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "continue on lane, per my own wrap",
        sourcePacketId: "handoff-own-wrap",
      },
    });
    expect(created.statusCode).toBe(201);
    // The citation is lineage, so it has to REACH the row, not merely be
    // tolerated by the guard.
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourcePacketId: "handoff-own-wrap" }),
      })
    );
    await app.close();
  });

  it("root: two DIFFERENT chatless tasks still cannot cite each other (409)", async () => {
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-other",
      task: { chatId: null },
    });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "cite a stranger's packet",
        sourcePacketId: "handoff-stranger",
      },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().message).toMatch(/no partition to prove/);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  // ── the delegate route, same rule ─────────────────────────────────────────
  it("delegate: a chatless child cites ITS OWN task's packet (201)", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.dispatchJob.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data
    );
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-child",
      task: { chatId: null },
    });
    prismaMock.task.findUnique.mockResolvedValue({ chatId: null });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "Repair per the packet",
        workspacePath: TEST_WORKSPACE,
        sourcePacketId: "handoff-child-own",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(prismaMock.dispatchJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourcePacketId: "handoff-child-own" }),
    });
    await app.close();
  });

  it("delegate: two DIFFERENT chatless tasks are still refused (409)", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-somewhere-else",
      task: { chatId: null },
    });
    prismaMock.task.findUnique.mockResolvedValue({ chatId: null });
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "Repair per the packet",
        workspacePath: TEST_WORKSPACE,
        sourcePacketId: "handoff-stranger",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/no partition to prove/);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("delegate: a MISSING target task proves nothing, chatless or not (409)", async () => {
    // The same-task proof must not be reachable through an absent task row: a
    // task nobody can read has no partition and no identity to match.
    prismaMock.dispatchJob.findUnique.mockResolvedValue(rootParent());
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-child",
      task: { chatId: null },
    });
    prismaMock.task.findUnique.mockResolvedValue(null);
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-parent/delegate",
      headers: delegationHeaders,
      payload: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "Repair per the packet",
        workspacePath: TEST_WORKSPACE,
        sourcePacketId: "handoff-child-own",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("a citation across a CHAT boundary is untouched by any of this (409)", async () => {
    // The rule that was already right: one side in a mission, the other in a
    // different one, is refused no matter what the task ids say.
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-1",
      task: { chatId: "chat-foreign" },
    });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "reach across missions",
        chatId: "chat-1",
        workspacePath: TEST_WORKSPACE,
        sourcePacketId: "handoff-foreign",
      },
    });
    expect(created.statusCode).toBe(409);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── ADR-0083: repair IS a verb ──────────────────────────────────────────────
describe("ADR-0083: repairOf derives the citation and composes the brief", () => {
  it("a degraded-classified packet composes a REPAIRS block; the citation reaches the row", async () => {
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-1",
      task: { chatId: null },
      // A schema FRAGMENT: the shared classifier's honest verdict is
      // packet_parse_failed — degraded, never clean.
      packetJson: { degraded: { flag: true, reasons: ["checks unrun"] } },
    });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "fix what the packet says broke",
        repairOf: "handoff-own-wrap",
      },
    });
    expect(created.statusCode).toBe(201);
    const data = (
      prismaMock.dispatchJob.create.mock.calls.at(-1)![0] as {
        data: { sourcePacketId?: string; brief: string; repairOf?: unknown };
      }
    ).data;
    expect(data.sourcePacketId).toBe("handoff-own-wrap");
    // Never a column: the verb is consumed by the route.
    expect("repairOf" in data).toBe(false);
    expect(data.brief).toContain(
      "[MUON REPAIRS packet handoff-own-wrap — contract: packet_parse_failed]"
    );
    expect(data.brief).toContain("handoff_read");
    expect(data.brief).toContain("[end MUON repair block]");
    expect(data.brief).toContain("fix what the packet says broke");
    // COORDINATES OVER CONTENT (A2): the packet's agent-authored reason
    // text must NEVER reach the next worker's prompt — a compromised
    // packet must not steer a repair worker through the server.
    expect(data.brief).not.toContain("checks unrun");
    await app.close();
  });

  it("a prose-only packet composes a CONTINUES block — the label is the classification's word", async () => {
    prismaMock.handoff.findUnique.mockResolvedValue({
      taskId: "task-1",
      task: { chatId: null },
      packetJson: null,
    });
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "carry on from the wrap",
        repairOf: "handoff-own-wrap",
      },
    });
    expect(created.statusCode).toBe(201);
    const data = (
      prismaMock.dispatchJob.create.mock.calls.at(-1)![0] as {
        data: { brief: string };
      }
    ).data;
    expect(data.brief).toContain(
      "[MUON CONTINUES packet handoff-own-wrap — contract: prose_only]"
    );
    await app.close();
  });

  it("repairOf and a DIFFERENT sourcePacketId refuse — a repair cites exactly the packet it repairs", async () => {
    prismaMock.dispatchJob.create.mockClear();
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      payload: {
        vendor: "claude-code",
        taskId: "task-1",
        brief: "confused citation",
        repairOf: "handoff-a",
        sourcePacketId: "handoff-b",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("disagree");
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });
});
