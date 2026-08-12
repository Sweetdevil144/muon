import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS,
  ATTACHED_COORDINATOR_LEASE_HORIZON_MS,
  ATTACHED_COORDINATOR_LEASE_TTL_MS,
  DEFAULT_CHILD_WALL_MS,
} from "@muon/protocol";

// ── ADR-0028 Tier C, Batch 1: the attached (external, non-hermetic) coordinator ──
//
// Proves the CRITICAL design split this batch exists to fix: `DispatchJob.
// delegationDeadline` is the LONG execution wall every delegated child inherits
// its remaining budget from (30 minutes, set once at attach and never touched
// again), while `DelegationGrant.expiresAt` is the SHORT, heartbeat-renewed
// capability lease (120s) that gates whether the external terminal is still
// alive. Collapsing the two would leave every delegated child with ~2 minutes
// of wall-clock instead of a real turn — that regression is what most of these
// tests are aimed at catching.

const OPERATOR = "operator-token-attached-coordinator";
const AGENT = "agent-token-attached-coordinator";
const WORKSPACE = process.cwd();
const COORDINATOR_VENDORS = ["codex", "claude-code"] as const;
const MUTATED_ENV_KEYS = [
  "DATABASE_URL",
  "MUON_GRAPH_DIR",
  "MUON_OPERATOR_TOKEN",
  "MUON_AGENT_TOKEN",
  "MUON_API_TOKEN",
] as const;
const savedEnv = Object.fromEntries(
  MUTATED_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof MUTATED_ENV_KEYS)[number], string | undefined>;

type Db = typeof import("../src/lib/db.js");
type AttachedLib = typeof import("../src/lib/attached-coordinator.js");

let dir: string;
let db: Db;
let attachedLib: AttachedLib;
let app: FastifyInstance;
let chatCounter = 0;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Every coordinator-seat vendor's ordinal-0 Agent row, reset idle. */
async function resetCoordinatorSeats(): Promise<void> {
  for (const vendor of COORDINATOR_VENDORS) {
    await db.prisma.agent.update({
      where: { vendor_ordinal: { vendor, ordinal: 0 } },
      data: {
        status: "idle",
        currentTaskId: null,
        currentJobId: null,
        sessionId: null,
      },
    });
  }
}

async function makeChat(): Promise<{ id: string; taskId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: auth(OPERATOR),
    payload: {
      title: `Attached coordinator test chat ${(chatCounter += 1)}`,
      workspacePath: WORKSPACE,
    },
  });
  expect(res.statusCode).toBe(201);
  const chat = res.json().chat as { id: string; taskId: string };
  return chat;
}

async function attach(vendor: string, chatId: string) {
  return app.inject({
    method: "POST",
    url: "/api/dispatch/attached",
    headers: auth(OPERATOR),
    payload: { vendor, chatId },
  });
}

/** Attach a fresh chat + root in one call; the common happy path fixture. */
async function attachFresh(vendor: string = "codex") {
  const chat = await makeChat();
  const res = await attach(vendor, chat.id);
  expect(res.statusCode).toBe(201);
  return { chat, body: res.json() as AttachResponse };
}

interface AttachResponse {
  job: {
    id: string;
    status: string;
    role: string;
    capabilityMode: string;
    delegationDeadline: string;
    delegationBudgetReservedMs: number;
  };
  chat: { id: string; taskId: string };
  capability: { token: string; expiresAt: string };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-attached-coordinator-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  // `env.ts` freezes `process.env` into a module-level singleton at first
  // import; without resetting the module registry here, a dynamically
  // imported `app.js`/`env.js` from an EARLIER test file in this worker can
  // still be cached with THAT file's tokens, silently 401-ing every request
  // this file makes (and, worse, leaking these tokens into files that run
  // after it and expect the open, no-token dev mode).
  vi.resetModules();

  db = await import("../src/lib/db.js");
  attachedLib = await import("../src/lib/attached-coordinator.js");
  await db.ensureSchema();

  for (const vendor of COORDINATOR_VENDORS) {
    await db.prisma.agent.create({
      data: { vendor, ordinal: 0, name: `${vendor}-coordinator` },
    });
  }

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await resetCoordinatorSeats();
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
  for (const key of MUTATED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("POST /api/dispatch/attached", () => {
  it("requires operator authority; the ambient agent token is refused (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/attached",
      headers: auth(AGENT),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a vendor that cannot hold the coordinator seat (400)", async () => {
    const chat = await makeChat();
    const res = await attach("cursor", chat.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot hold MUON's coordinator seat/);
  });

  it("names the seat holder's job id when ordinal 0 is already occupied (409)", async () => {
    await db.prisma.agent.update({
      where: { vendor_ordinal: { vendor: "codex", ordinal: 0 } },
      data: {
        status: "working",
        currentJobId: "holder-job-already-attached",
        currentTaskId: "some-task",
      },
    });
    const chat = await makeChat();
    const res = await attach("codex", chat.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("holder-job-already-attached");
  });

  it("creates a running attached-coordinator root with a long execution wall and a short renewable lease", async () => {
    const before = Date.now();
    const { body } = await attachFresh("codex");

    expect(body.job.status).toBe("running");
    expect(body.job.role).toBe("orchestrator");
    expect(body.job.capabilityMode).toBe(ATTACHED_COORDINATOR_CAPABILITY_MODE);
    expect(typeof body.capability.token).toBe("string");
    expect(body.capability.token.length).toBeGreaterThanOrEqual(32);

    // The long wall: ~30 minutes out from attach, NEVER anywhere near the lease.
    const wallMs = new Date(body.job.delegationDeadline).getTime() - before;
    expect(wallMs).toBeGreaterThan(29 * 60_000);
    expect(wallMs).toBeLessThan(31 * 60_000);

    // ADR-0049 — a MINT stamps the BOOTSTRAP lease (~10 min), not the
    // steady-state 120s. The mint is the one moment no heartbeat can exist
    // yet, and it is exactly the window a human spends restarting the terminal
    // the attach told them to restart; at 120s the printed remedy expired
    // before it could be used. The HEARTBEAT test below still pins the short
    // lease, which is what governs a connected seat.
    const leaseMs = new Date(body.capability.expiresAt).getTime() - before;
    expect(leaseMs).toBeGreaterThan(ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS - 20_000);
    expect(leaseMs).toBeLessThan(ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS + 20_000);
    // Still well under the wall: the two clocks stay an order apart.
    expect(wallMs).toBeGreaterThan(leaseMs * 2);

    const grant = await db.prisma.delegationGrant.findUnique({
      where: { jobId: body.job.id },
    });
    expect(grant?.expiresAt.toISOString()).toBe(body.capability.expiresAt);

    const seat = await db.prisma.agent.findUnique({
      where: { vendor_ordinal: { vendor: "codex", ordinal: 0 } },
    });
    expect(seat?.status).toBe("working");
    expect(seat?.currentJobId).toBe(body.job.id);
  });
});

describe("POST /api/dispatch/attached/:jobId/heartbeat", () => {
  it("renews only the short lease; the long delegationDeadline wall never moves", async () => {
    const { body } = await attachFresh("codex");
    const originalDeadline = body.job.delegationDeadline;

    const hb = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${body.job.id}/heartbeat`,
      headers: auth(body.capability.token),
    });
    expect(hb.statusCode).toBe(200);
    const hbBody = hb.json();
    // Byte-identical: a heartbeat carries no duration for this field at all.
    expect(hbBody.job.delegationDeadline).toBe(originalDeadline);

    const grant = await db.prisma.delegationGrant.findUnique({
      where: { jobId: body.job.id },
    });
    expect(grant?.expiresAt.toISOString()).toBe(hbBody.expiresAt);
    // ADR-0049 — THE FIRST HEARTBEAT NARROWS THE LEASE, and that is the whole
    // safety property of the bootstrap window: the mint is wide (10 min, for a
    // human to restart their terminal) and the moment the seat proves it is
    // alive it drops back to the steady-state 120s. So this is deliberately
    // EARLIER than the minted expiry, not later.
    const renewedMs = grant!.expiresAt.getTime();
    expect(renewedMs).toBeLessThan(
      new Date(body.capability.expiresAt).getTime()
    );
    // Still a live lease, and still an order below the long wall.
    expect(renewedMs).toBeGreaterThan(Date.now());
    expect(renewedMs).toBeLessThan(
      Date.now() + ATTACHED_COORDINATOR_LEASE_HORIZON_MS
    );
    expect(renewedMs).toBeLessThan(new Date(originalDeadline).getTime());
  });

  it("403s without the exact attached-coordinator job capability", async () => {
    const { body: rootA } = await attachFresh("codex");
    const { body: rootB } = await attachFresh("claude-code");

    // Operator tier: never agent-tier at all.
    const asOperator = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${rootA.job.id}/heartbeat`,
      headers: auth(OPERATOR),
    });
    expect(asOperator.statusCode).toBe(403);

    // Ambient agent tier: agent-tier, but no exact job capability at all.
    const asAmbientAgent = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${rootA.job.id}/heartbeat`,
      headers: auth(AGENT),
    });
    expect(asAmbientAgent.statusCode).toBe(403);

    // A real attached-coordinator capability, but for a DIFFERENT job.
    const wrongJob = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${rootA.job.id}/heartbeat`,
      headers: auth(rootB.capability.token),
    });
    expect(wrongJob.statusCode).toBe(403);
  });

  it("fails closed on a corrupted far-future grant expiry (ADR-0028 §3 independent horizon)", async () => {
    const { body } = await attachFresh("codex");
    await db.prisma.delegationGrant.update({
      where: { jobId: body.job.id },
      data: { expiresAt: new Date(Date.now() + 10 * 24 * 3_600_000) },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${body.job.id}/heartbeat`,
      headers: auth(body.capability.token),
    });
    // Never classified into any tier: the presented token can no longer be
    // trusted as an irrevocable grant, so the request never even reaches the
    // route's own 403 — it fails closed at authentication.
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/dispatch/attached/:jobId", () => {
  it("terminalizes the root, frees the coordinator seat, and is not repeatable", async () => {
    const { body } = await attachFresh("codex");
    const jobId = body.job.id;

    const detach1 = await app.inject({
      method: "DELETE",
      url: `/api/dispatch/attached/${jobId}`,
      headers: auth(OPERATOR),
    });
    expect(detach1.statusCode).toBe(200);
    expect(detach1.json()).toEqual({ detached: true, jobId });

    const row = await db.prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("interrupted");
    expect(row?.interruptRequested).toBe(true);

    const seat = await db.prisma.agent.findUnique({
      where: { vendor_ordinal: { vendor: "codex", ordinal: 0 } },
    });
    expect(seat?.status).toBe("idle");
    expect(seat?.currentJobId).toBeNull();

    const grant = await db.prisma.delegationGrant.findUnique({
      where: { jobId },
    });
    expect(grant?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    const detach2 = await app.inject({
      method: "DELETE",
      url: `/api/dispatch/attached/${jobId}`,
      headers: auth(OPERATOR),
    });
    expect(detach2.statusCode).toBe(409);
  });
});

describe("the brain-side lease sweeper", () => {
  it("reaps a root whose lease has lapsed while its long wall still has decades left, releasing queued child reservations", async () => {
    const { chat, body } = await attachFresh("codex");
    const rootId = body.job.id;
    const token = body.capability.token;

    const delegateRes = await app.inject({
      method: "POST",
      url: `/api/dispatch/${rootId}/delegate`,
      headers: { ...auth(token), "x-muon-delegation-token": token },
      payload: {
        vendor: "codex",
        taskId: chat.taskId,
        brief: "child work reserved before the sweep reaps its root",
      },
    });
    expect(delegateRes.statusCode).toBe(201);
    const childId = delegateRes.json().job.id as string;

    const rootBeforeSweep = await db.prisma.dispatchJob.findUnique({
      where: { id: rootId },
    });
    // The long wall still has ~29+ minutes left — nothing about the lease
    // lapsing below shrinks it.
    expect(rootBeforeSweep!.delegationDeadline!.getTime()).toBeGreaterThan(
      Date.now() + 25 * 60_000
    );
    expect(rootBeforeSweep!.delegationBudgetReservedMs).toBeGreaterThan(0);

    // Simulate the operator's external terminal going silent: only the SHORT
    // lease lapses.
    await db.prisma.delegationGrant.update({
      where: { jobId: rootId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const reaped = await attachedLib.sweepExpiredAttachedCoordinators();
    expect(reaped).toContain(rootId);

    const rootAfter = await db.prisma.dispatchJob.findUnique({
      where: { id: rootId },
    });
    expect(rootAfter?.status).toBe("interrupted");
    expect(rootAfter?.interruptRequested).toBe(true);
    // The queued child's reservation was returned to the (now-terminal) pool.
    expect(rootAfter?.delegationBudgetReservedMs).toBe(0);

    const childAfter = await db.prisma.dispatchJob.findUnique({
      where: { id: childId },
    });
    expect(childAfter?.status).toBe("interrupted");
    expect(childAfter?.interruptRequested).toBe(true);

    const seat = await db.prisma.agent.findUnique({
      where: { vendor_ordinal: { vendor: "codex", ordinal: 0 } },
    });
    expect(seat?.status).toBe("idle");
    expect(seat?.currentJobId).toBeNull();

    // Idempotent / bounded: a second sweep finds nothing left to reap here.
    const secondSweep = await attachedLib.sweepExpiredAttachedCoordinators();
    expect(secondSweep).not.toContain(rootId);
  });
});

describe("delegation under an attached root", () => {
  it("a delegated child inherits its wall-clock budget from the long deadline, not the 120s lease", async () => {
    const { chat, body } = await attachFresh("codex");
    const token = body.capability.token;

    const delegateRes = await app.inject({
      method: "POST",
      url: `/api/dispatch/${body.job.id}/delegate`,
      headers: { ...auth(token), "x-muon-delegation-token": token },
      payload: {
        vendor: "codex",
        taskId: chat.taskId,
        brief: "prove the delegated child gets a real turn, not the lease TTL",
      },
    });
    expect(delegateRes.statusCode).toBe(201);
    const child = delegateRes.json().job;

    expect(child.capabilityMode).toBe("delegate");
    expect(child.maxWallMs).toBe(DEFAULT_CHILD_WALL_MS);
    expect(child.maxWallMs).toBeGreaterThan(ATTACHED_COORDINATOR_LEASE_TTL_MS * 5);
    expect(new Date(child.delegationDeadline).getTime()).toBe(
      new Date(body.job.delegationDeadline).getTime()
    );
  });
});

describe("attached capability route allowlist (deny-by-default)", () => {
  it("blocks fleet writes, budget raises, workflow apply, and approval resolution (403)", async () => {
    const { body } = await attachFresh("codex");
    const token = body.capability.token;

    const setFleet = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      headers: auth(token),
      payload: {},
    });
    expect(setFleet.statusCode).toBe(403);

    const raiseBudget = await app.inject({
      method: "PATCH",
      url: `/api/dispatch/${body.job.id}/budget`,
      headers: auth(token),
      payload: { maxDescendantWallMs: 999_999_999 },
    });
    expect(raiseBudget.statusCode).toBe(403);

    const applyWorkflow = await app.inject({
      method: "POST",
      url: "/api/workflow-runs/does-not-exist/apply",
      headers: auth(token),
      payload: {},
    });
    expect(applyWorkflow.statusCode).toBe(403);

    const resolveApproval = await app.inject({
      method: "PATCH",
      url: "/api/approvals/does-not-exist",
      headers: auth(token),
      payload: { status: "approved" },
    });
    expect(resolveApproval.statusCode).toBe(403);
  });
});

describe("ADR-0049 — the bootstrap widening DECAYS, and cannot become permanent", () => {
  /**
   * The mint's wider ceiling is anchored to `issuedAt`, not to `now`. That
   * anchor is the entire safety of it: anchored to now, every attached grant
   * would carry an 11-minute forged-timestamp window forever instead of the
   * 2.5 the guard was written for, and no test would have noticed — this one
   * exists because a mutation to `now` passed the whole suite.
   */
  it("refuses a far-future expiry once the mint window has passed", async () => {
    const { body } = await attachFresh("codex");

    // The seat works now, inside its bootstrap window.
    const fresh = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${body.job.id}/heartbeat`,
      headers: auth(body.capability.token),
    });
    expect(fresh.statusCode).toBe(200);

    // Rewind the ISSUE past the bootstrap window while claiming an expiry that
    // only the bootstrap ceiling would ever have allowed — the shape a
    // corrupted or forged row has.
    await db.prisma.delegationGrant.update({
      where: { jobId: body.job.id },
      data: {
        issuedAt: new Date(Date.now() - ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS * 2),
        expiresAt: new Date(Date.now() + ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS),
      },
    });

    const stale = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${body.job.id}/heartbeat`,
      headers: auth(body.capability.token),
    });
    expect(
      stale.statusCode,
      "an old grant may not keep the mint's wider ceiling"
    ).not.toBe(200);
  });

  it("still accepts the steady-state lease a heartbeat writes, however old the grant", async () => {
    const { body } = await attachFresh("codex");
    await db.prisma.delegationGrant.update({
      where: { jobId: body.job.id },
      data: {
        issuedAt: new Date(Date.now() - ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS * 5),
        expiresAt: new Date(Date.now() + ATTACHED_COORDINATOR_LEASE_TTL_MS),
      },
    });
    const beat = await app.inject({
      method: "POST",
      url: `/api/dispatch/attached/${body.job.id}/heartbeat`,
      headers: auth(body.capability.token),
    });
    // A long-lived, well-behaved seat is unaffected by any of this.
    expect(beat.statusCode).toBe(200);
  });
});
