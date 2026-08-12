import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR = "operator-token-live-terminal";
const AGENT = "agent-token-live-terminal";
/** The credential a dispatched VENDOR process actually holds. */
const JOB_CAPABILITY = `jobcap-${"d".repeat(50)}`;

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  runner: { findFirst: vi.fn() },
  delegationGrant: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const JOB_ID = "job-live";

describe("live terminal attach is operator-tier, read-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: null,
      status: "running",
    });
  });

  it("refuses an unauthenticated attach", async () => {
    const app = await buildTieredApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.statusCode).toBe(401);
    await app.close();
  });

  it("refuses the AGENT tier — a vendor process must not read a console", async () => {
    // The runner's shared agent bearer may PUBLISH (lease-fenced) but may never
    // read back. Otherwise one dispatched agent could watch another's terminal
    // with its own credential.
    const app = await buildTieredApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      headers: auth(AGENT),
    });
    expect(read.statusCode).toBe(403);
    await app.close();
  });

  it("refuses a JOB CAPABILITY — the credential a vendor child actually holds", async () => {
    // Double-fenced on purpose, and both fences are asserted here: the route is
    // absent from `agentJobRouteAllowed` (403 at the global preHandler) AND
    // `requireOperator` denies independently. Tier derivation has regressed in
    // this repo before; the vendor's own credential is the shape that matters.
    prismaMock.delegationGrant.findFirst.mockResolvedValue({
      jobId: JOB_ID,
      tokenHash: createHash("sha256").update(JOB_CAPABILITY).digest("hex"),
      expiresAt: new Date(Date.now() + 600_000),
      issuedAt: new Date(),
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      taskId: "task-1",
      vendor: "codex",
      chatId: null,
      parentJobId: null,
      rootJobId: null,
      capabilityMode: "orchestrator",
      workspacePath: null,
      status: "running",
      interruptRequested: false,
      ptySessionId: null,
    });
    const app = await buildTieredApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      headers: auth(JOB_CAPABILITY),
    });
    expect(read.statusCode).toBe(403);
    await app.close();
  });

  it("admits the operator, and returns bytes and coordinates only", async () => {
    const app = await buildTieredApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      headers: auth(OPERATOR),
    });
    expect(read.statusCode).toBe(200);
    // The response shape is exhaustively: a session id, a liveness flag, frames
    // of console text, and two sequence numbers. No token, no lease, no brief,
    // no workspace path, no agent identity.
    expect(Object.keys(read.json()).sort()).toEqual([
      "available",
      "dropped",
      "firstSeq",
      "frames",
      "jobStatus",
      "lastSeq",
      "sessionId",
    ]);
    const body = JSON.stringify(read.json());
    expect(body).not.toContain(OPERATOR);
    expect(body).not.toContain(AGENT);
    await app.close();
  });
});
