import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_CHILD_WALL_MS,
  DELEGATION_MAX_DESCENDANTS,
  budgetRaiseGateTag,
} from "@muon/protocol";

// ── S9: budget visibility + operator raise (end-to-end, real temp-SQLite brain)
//
// Proves the founder loop: after a budget 409 the human can SEE the mission
// budget (both tiers) and RAISE the descendant pool as an explicit operator act.
// The raise is OPERATOR-tier (agent token 403 without a redeemed single-use gate),
// monotonic (never lowers the fail-closed cap), ceiling-bounded (sized, never
// uncapped), and rewrites the column AND the persisted v2 policy manifest in
// lockstep so the delegate route's consistency check stays green. A v1 root
// (no pool) preserves its turn-budget semantics and cannot be raised here.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-dispatch-budget";
const AGENT = "agent-token-dispatch-budget";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

// The default v2 chat-root pool: DELEGATION_MAX_DESCENDANTS × DEFAULT_CHILD_WALL_MS.
// DERIVED, never a literal — this is the number that has to move when the child
// default moves, and a hardcoded copy is how it silently would not.
const DEFAULT_POOL_MS = DELEGATION_MAX_DESCENDANTS * DEFAULT_CHILD_WALL_MS;
// The v2 schema ceiling: DELEGATION_MAX_DESCENDANTS × per-child wall cap.
const POOL_CEILING_MS = DELEGATION_MAX_DESCENDANTS * 1_800_000;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createV2Root(): Promise<string> {
  const chatResponse = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth(OPERATOR),
    payload: {
      title: "Budget test chat",
      workspacePath: process.cwd(),
    },
  });
  expect(chatResponse.statusCode).toBe(201);
  const chat = chatResponse.json().chat as { id: string; taskId: string };
  const created = await app.inject({
    method: "POST",
    url: "/api/dispatch",
    headers: auth(OPERATOR),
    payload: {
      kind: "session",
      vendor: "claude-code",
      taskId: chat.taskId,
      brief: "orchestrate the crew",
      chatId: chat.id,
      workspacePath: process.cwd(),
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().job.id as string;
}

/** File a raise gate (agent tier) and approve it (operator tier); return its id. */
async function fileAndApproveRaiseGate(
  jobId: string,
  poolMs: number
): Promise<string> {
  const task = await prisma.task.create({
    data: { title: "chat shadow", description: "gate host task" },
  });
  const filed = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers: auth(AGENT),
    payload: {
      taskId: task.id,
      requestedBy: "muon-orchestrator",
      kind: "gate",
      reason: "raise the mission budget",
      gateTag: budgetRaiseGateTag(jobId, poolMs),
    },
  });
  expect(filed.statusCode).toBe(201);
  const approvalId = filed.json().approval.id as string;
  // Informed consent: the stored/displayed subject is server-derived from the tag.
  expect(filed.json().approval.reason).toBe(
    `Raise delegation budget for job ${jobId} to ${poolMs} ms`
  );
  const approved = await app.inject({
    method: "PATCH",
    url: `/api/approvals/${approvalId}`,
    headers: auth(OPERATOR),
    payload: { status: "approved" },
  });
  expect(approved.statusCode).toBe(200);
  return approvalId;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-dispatch-budget-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S9 GET /:jobId/budget (visibility, both tiers)", () => {
  it("returns the mission budget to the operator AND the agent tier", async () => {
    const jobId = await createV2Root();

    for (const token of [OPERATOR, AGENT]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/dispatch/${jobId}/budget`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      const budget = res.json().budget;
      expect(budget).toMatchObject({
        jobId,
        maxDescendantWallMs: DEFAULT_POOL_MS,
        poolMs: DEFAULT_POOL_MS,
        reservedMs: 0,
        consumedMs: 0,
        remainingMs: DEFAULT_POOL_MS,
        maxChildren: 3,
        maxDescendants: 8,
        depth: 0,
        maxDepth: 3,
      });
      expect(Array.isArray(budget.children)).toBe(true);
    }
  });

  it("resolves any job in the tree to its root and lists a per-child breakdown", async () => {
    const rootId = await createV2Root();
    await prisma.dispatchJob.create({
      data: {
        id: `child-${Math.random().toString(36).slice(2)}`,
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "bounded child work",
        status: "running",
        rootJobId: rootId,
        parentJobId: rootId,
        delegationDepth: 1,
        maxWallMs: 600_000,
        startedAt: new Date(Date.now() - 120_000),
        capabilityMode: "delegate",
        dispatchedBy: "agent:delegate",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/dispatch/${rootId}/budget`,
      headers: auth(AGENT),
    });
    expect(res.statusCode).toBe(200);
    const budget = res.json().budget;
    expect(budget.jobId).toBe(rootId);
    expect(budget.children).toHaveLength(1);
    expect(budget.children[0]).toMatchObject({
      vendor: "codex",
      status: "running",
      depth: 1,
      // Still in-flight → reservation is live; consumed is bounded by it.
      reservedMs: 600_000,
    });
    expect(budget.children[0].consumedMs).toBeGreaterThanOrEqual(0);
    expect(budget.children[0].consumedMs).toBeLessThanOrEqual(600_000);
    // Numbers + enums only: never agent free-text on a visibility payload.
    expect(budget.children[0]).not.toHaveProperty("brief");
    expect(budget.children[0]).not.toHaveProperty("result");
  });

  it("404s on an unknown job", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dispatch/does-not-exist/budget",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("S9 PATCH /:jobId/budget (operator raise)", () => {
  it("operator raises the pool directly (no gate); column AND manifest move in lockstep", async () => {
    const jobId = await createV2Root();
    const next = DEFAULT_POOL_MS + 1_200_000;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: next },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().budget).toMatchObject({
      maxDescendantWallMs: next,
      poolMs: next,
      remainingMs: next,
    });

    // Column and the persisted v2 policy manifest are both raised, so the
    // delegate route's root-policy consistency check keeps matching.
    const row = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(row?.maxDescendantWallMs).toBe(next);
    expect(
      (row?.delegationManifest as { maxDescendantWallMs?: number } | null)
        ?.maxDescendantWallMs
    ).toBe(next);
  });

  it("is monotonic: a raise to an equal or lower pool is rejected (400)", async () => {
    const jobId = await createV2Root();

    const equal = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: DEFAULT_POOL_MS },
    });
    expect(equal.statusCode).toBe(400);

    const lower = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: DEFAULT_POOL_MS - 60_000 },
    });
    expect(lower.statusCode).toBe(400);

    // The pool is untouched by a rejected raise.
    const row = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(row?.maxDescendantWallMs).toBe(DEFAULT_POOL_MS);
  });

  it("is ceiling-bounded: a raise beyond the schema max is rejected (400), never uncapped", async () => {
    const jobId = await createV2Root();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: POOL_CEILING_MS + 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot raise a v1 root (no pool); v1 turn-budget semantics are preserved (409)", async () => {
    const deadline = new Date(Date.now() + 600_000);
    const v1 = await prisma.dispatchJob.create({
      data: {
        kind: "session",
        vendor: "claude-code",
        taskId: "task-v1",
        brief: "v1 orchestrator",
        status: "running",
        workspacePath: process.cwd(),
        chatId: "chat-v1",
        maxWallMs: 1_800_000,
        capabilityMode: "orchestrator",
        delegationDepth: 0,
        maxDelegationDepth: 3,
        maxChildren: 3,
        maxTotalDescendants: 8,
        maxDelegationIterations: 10,
        delegationDeadline: deadline,
        // No maxDescendantWallMs, and a v1 manifest (no pool field).
        delegationManifest: {
          version: 1,
          jobId: "placeholder",
          workspacePath: process.cwd(),
          maxDepth: 3,
          maxChildrenPerParent: 3,
          maxTotalDescendants: 8,
          maxIterations: 10,
          deadlineAt: deadline.toISOString(),
          authority: "orchestrator",
          childAuthority: "work",
          narrowingRequired: true,
        },
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${v1.id}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: 4_800_000 },
    });
    expect(res.statusCode).toBe(409);
    const row = await prisma.dispatchJob.findUnique({ where: { id: v1.id } });
    expect(row?.maxDescendantWallMs ?? null).toBeNull();
  });

  it("rejects a raise that targets a delegated child, not a root (400)", async () => {
    const rootId = await createV2Root();
    const child = await prisma.dispatchJob.create({
      data: {
        kind: "auto",
        vendor: "codex",
        taskId: "task-child",
        brief: "child",
        status: "running",
        rootJobId: rootId,
        parentJobId: rootId,
        delegationDepth: 1,
        maxWallMs: 600_000,
        capabilityMode: "delegate",
        dispatchedBy: "agent:delegate",
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${child.id}/budget`,
      headers: auth(OPERATOR),
      payload: { maxDescendantWallMs: 6_000_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("S9 PATCH /:jobId/budget (agent-tier gate enforcement)", () => {
  it("agent tier WITHOUT a gate → 403; the pool is not touched", async () => {
    const jobId = await createV2Root();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(AGENT),
      payload: { maxDescendantWallMs: DEFAULT_POOL_MS + 600_000 },
    });
    expect(res.statusCode).toBe(403);
    const row = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(row?.maxDescendantWallMs).toBe(DEFAULT_POOL_MS);
  });

  it("agent tier WITH an operator-approved gate bound to this job + pool → 200; single-use (replay 403)", async () => {
    const jobId = await createV2Root();
    const next = DEFAULT_POOL_MS + 1_800_000;
    const approvalId = await fileAndApproveRaiseGate(jobId, next);

    const raised = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(AGENT),
      payload: { maxDescendantWallMs: next, gateApprovalId: approvalId },
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().budget.maxDescendantWallMs).toBe(next);

    // Single-use: replaying the same gate id is rejected.
    const replay = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(AGENT),
      payload: {
        maxDescendantWallMs: next + 600_000,
        gateApprovalId: approvalId,
      },
    });
    expect(replay.statusCode).toBe(403);
  });

  it("agent tier with a gate bound to a DIFFERENT pool → 403; the gate is not consumed", async () => {
    const jobId = await createV2Root();
    // Gate approved for one amount, PATCH requests another → tag mismatch.
    const approvalId = await fileAndApproveRaiseGate(jobId, DEFAULT_POOL_MS + 600_000);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(AGENT),
      payload: {
        maxDescendantWallMs: DEFAULT_POOL_MS + 1_200_000,
        gateApprovalId: approvalId,
      },
    });
    expect(res.statusCode).toBe(403);
    // The mismatched tag matched no row, so the gate stays usable for its real
    // payload — proving it was not spent.
    const stillUsable = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${jobId}/budget`,
      headers: auth(AGENT),
      payload: {
        maxDescendantWallMs: DEFAULT_POOL_MS + 600_000,
        gateApprovalId: approvalId,
      },
    });
    expect(stillUsable.statusCode).toBe(200);
  });
});
