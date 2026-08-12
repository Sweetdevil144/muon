import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DELEGATION_MAX_CHILDREN } from "@muon/protocol";

/**
 * F1 — THE DEMO CENTREPIECE: a 3-wide same-vendor fan-out must actually RUN
 * CONCURRENTLY.
 *
 * REAL SQLite + the REAL fastify app, because the thing under test is the
 * atomic claim transaction (`POST /api/dispatch/:id/claim`) — the reservation
 * that decides whether a child starts now or waits for a seat. A mocked prisma
 * cannot answer that question; the semaphore IS the database.
 *
 * The founder's evidence: cluster A (claude-code) ended at 1785184766164 and
 * cluster C (claude-code) started at 1785184766281 — 117 ms LATER, i.e. it had
 * been queued behind A the whole time, because the fleet held exactly one
 * dispatchable claude-code seat. These tests reproduce that with one seat and
 * prove it is gone with the seeded fleet.
 */

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));

let prisma: typeof import("../src/lib/db.js")["prisma"];
let app: Awaited<ReturnType<typeof import("../src/app.js")["buildApp"]>>;
let dir: string;
let operatorToken: string | undefined;

async function api(
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown
) {
  const response = await app.inject({
    method,
    url,
    ...(operatorToken
      ? { headers: { authorization: `Bearer ${operatorToken}` } }
      : {}),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return {
    status: response.statusCode,
    json: response.body ? JSON.parse(response.body) : undefined,
  };
}

async function createTask(title: string): Promise<string> {
  const res = await api("POST", "/api/tasks", {
    title,
    description: `${title} (parallel fan-out fixture)`,
  });
  expect(res.status).toBe(201);
  return res.json.task.id as string;
}

async function mintLease(host: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const res = await api("POST", "/api/runner/lease", { host, leaseToken: token });
  expect(res.status).toBe(200);
  return token;
}

/** Set the claude-code worker fleet to exactly `seats` idle instances. */
async function setSeats(seats: number): Promise<void> {
  await prisma.agent.deleteMany({ where: { vendor: "claude-code" } });
  for (let ordinal = 1; ordinal <= seats; ordinal += 1) {
    await prisma.agent.create({
      data: {
        vendor: "claude-code",
        name: `claude-code-${ordinal}`,
        ordinal,
        status: "idle",
      },
    });
  }
}

/** Enqueue `count` sibling children on ONE vendor — the fan-out under test. */
async function enqueueSiblings(
  taskId: string,
  count: number
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: `cluster ${String.fromCharCode(65 + index)}`,
    });
    expect(res.status).toBe(201);
    ids.push(res.json.job.id as string);
  }
  return ids;
}

/**
 * Claim every sibling CONCURRENTLY through the real atomic transaction, exactly
 * as one runner tick does. Returns which claims won a seat.
 */
async function claimAll(
  jobIds: string[],
  host: string,
  lease: string
): Promise<{ claimed: string[]; refused: string[] }> {
  const results = await Promise.all(
    jobIds.map(async (jobId) => {
      const res = await api("POST", `/api/dispatch/${jobId}/claim`, {
        host,
        leaseToken: lease,
      });
      return { jobId, status: res.status };
    })
  );
  return {
    claimed: results.filter((r) => r.status < 300).map((r) => r.jobId),
    refused: results.filter((r) => r.status >= 400).map((r) => r.jobId),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-fanout-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  operatorToken = process.env.MUON_API_TOKEN;
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
  await prisma.lane.create({
    data: {
      key: "claude-code",
      name: "Claude Code",
      provider: "anthropic",
      role: "engineer",
    },
  });
}, 30_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("same-vendor fan-out concurrency (F1)", () => {
  it("REPRODUCES the defect: with ONE seat, only one sibling runs and the rest stay queued", async () => {
    await setSeats(1);
    const taskId = await createTask("one-seat fan-out");
    const jobIds = await enqueueSiblings(taskId, DELEGATION_MAX_CHILDREN);
    const host = "runner-one-seat";
    const lease = await mintLease(host);

    const { claimed, refused } = await claimAll(jobIds, host, lease);

    // This is the founder's run: one worker starts, the siblings WAIT.
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(DELEGATION_MAX_CHILDREN - 1);
    for (const jobId of refused) {
      const job = await api("GET", `/api/dispatch/${jobId}`);
      expect(job.json.job.status).toBe("queued");
      expect(job.json.job.startedAt).toBeNull();
    }
  }, 20_000);

  it("WITH THE SEEDED FLEET, all three siblings are running at the same time", async () => {
    await setSeats(DELEGATION_MAX_CHILDREN);
    const taskId = await createTask("full-width fan-out");
    const jobIds = await enqueueSiblings(taskId, DELEGATION_MAX_CHILDREN);
    const host = "runner-full-width";
    const lease = await mintLease(host);

    const { claimed, refused } = await claimAll(jobIds, host, lease);

    expect(claimed).toHaveLength(DELEGATION_MAX_CHILDREN);
    expect(refused).toEqual([]);

    // CONCURRENT, not sequential: every sibling is `running` simultaneously,
    // each on its OWN seat. Serialized execution could not produce this state —
    // a queued sibling has no agent and no startedAt until its turn comes.
    const seats = new Set<string>();
    for (const jobId of jobIds) {
      const job = (await api("GET", `/api/dispatch/${jobId}`)).json.job;
      expect(job.status).toBe("running");
      expect(job.startedAt).not.toBeNull();
      expect(job.agentId).toBeTruthy();
      seats.add(job.agentId as string);
    }
    expect(seats.size).toBe(DELEGATION_MAX_CHILDREN);

    // And the fleet agrees: three claude-code seats, all working at once.
    const working = await prisma.agent.count({
      where: { vendor: "claude-code", status: "working" },
    });
    expect(working).toBe(DELEGATION_MAX_CHILDREN);
  }, 20_000);

  it("the semaphore still holds: a FOURTH sibling on a full fleet is refused, not overbooked", async () => {
    await setSeats(DELEGATION_MAX_CHILDREN);
    const taskId = await createTask("over-width fan-out");
    const jobIds = await enqueueSiblings(taskId, DELEGATION_MAX_CHILDREN + 1);
    const host = "runner-over-width";
    const lease = await mintLease(host);

    const { claimed, refused } = await claimAll(jobIds, host, lease);

    expect(claimed).toHaveLength(DELEGATION_MAX_CHILDREN);
    expect(refused).toHaveLength(1);
    // Widening seats must never widen the semaphore itself: no seat is ever
    // handed to two jobs.
    const agentIds = await Promise.all(
      claimed.map(async (jobId) => {
        const job = (await api("GET", `/api/dispatch/${jobId}`)).json.job;
        return job.agentId as string;
      })
    );
    expect(new Set(agentIds).size).toBe(DELEGATION_MAX_CHILDREN);
  }, 20_000);

  it("the reserved coordinator seat is never spent on a worker fan-out", async () => {
    await setSeats(DELEGATION_MAX_CHILDREN);
    // The ordinal-0 coordinator sits ABOVE the fleet.
    await prisma.agent.create({
      data: {
        vendor: "claude-code",
        name: "claude-code-coordinator",
        ordinal: 0,
        status: "idle",
      },
    });
    const taskId = await createTask("coordinator seat is reserved");
    const jobIds = await enqueueSiblings(taskId, DELEGATION_MAX_CHILDREN + 1);
    const host = "runner-coordinator-guard";
    const lease = await mintLease(host);

    const { claimed } = await claimAll(jobIds, host, lease);

    // Four workers, four seats present (3 worker + 1 coordinator) — but only
    // three claims succeed, because ordinal 0 is not a worker seat.
    expect(claimed).toHaveLength(DELEGATION_MAX_CHILDREN);
    const coordinator = await prisma.agent.findFirst({
      where: { vendor: "claude-code", ordinal: 0 },
    });
    expect(coordinator?.status).toBe("idle");
    expect(coordinator?.currentJobId).toBeNull();
  }, 20_000);
});
