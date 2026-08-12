import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { standingApproverGrantSchema } from "@muon/protocol";

// ── The standing-approver lease (Full Auto) ──────────────────────────────────
//
// The regression these lock down: Full Auto lived only inside the desktop main
// process, so with "FULL AUTO — SAFETY GATES OFF" on screen a coordinator's
// `Bash` was still denied ("no operator watches the coordinator's approval
// inbox"). This route is how the brain learns an operator-tier decider really
// IS watching — and, just as importantly, how it stops saying so.
//
// It is a LEASE, not a flag. A desktop that publishes `true` and then crashes
// must not leave a coordinator ungated forever, so nothing here is durable past
// its TTL and every uncertainty resolves to "nobody is watching".
//
// Tier asymmetry mirrors the R4 mining flag: WRITE is operator-only (asserting a
// human's standing consent is live is exactly the claim an agent must never
// make); READ is reachable by the SHARED agent bearer, because MUON's own runner
// is the reader — but NOT by a per-job capability, the credential a vendor
// process actually holds.

const OPERATOR = "operator-token-standing-1";
const AGENT = "agent-token-standing-1";
const JOB_TOKEN = `job-standing-${"j".repeat(52)}`;

const settingRows = new Map<string, { key: string; value: string }>();

const prismaMock = vi.hoisted(() => ({
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/preedit.js", () => ({ preEditContext: vi.fn() }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/activity.js", () => ({ readActivity: () => async () => [] }));
vi.mock("../src/lib/duplicate-work.js", () => ({
  readDuplicateWork: () => async () => [],
}));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const LEASE_URL = "/api/approvals/standing-approver/lease";
const LEASE_KEY = "standingApproverLeaseExpiresAt";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  settingRows.clear();
  prismaMock.operatorSetting.findUnique.mockImplementation(
    async (args: { where: { key: string } }) =>
      settingRows.get(args.where.key) ?? null
  );
  prismaMock.operatorSetting.upsert.mockImplementation(
    async (args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }) => {
      const existing = settingRows.get(args.where.key);
      const row = existing
        ? { ...existing, value: args.update.value }
        : { ...args.create };
      settingRows.set(args.where.key, row);
      return row;
    }
  );
  prismaMock.operatorSetting.deleteMany.mockImplementation(
    async (args: { where: { key: string } }) => {
      const existed = settingRows.delete(args.where.key);
      return { count: existed ? 1 : 0 };
    }
  );
  prismaMock.delegationGrant.findFirst.mockResolvedValue({
    jobId: "job-standing",
    tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  prismaMock.dispatchJob.findUnique.mockResolvedValue({
    id: "job-standing",
    taskId: "task-standing",
    vendor: "codex",
    chatId: "chat-a",
    parentJobId: null,
    rootJobId: "job-standing",
    capabilityMode: "orchestrator",
    workspacePath: "/repo",
    status: "running",
    interruptRequested: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("standing-approver lease store", () => {
  it("DEFAULT CLOSED: with no row at all, nobody is watching", async () => {
    const { getStandingApproverGrant } = await import(
      "../src/lib/operator-settings.js"
    );

    await expect(getStandingApproverGrant()).resolves.toEqual({ active: false });
  });

  it("a renewal publishes a grant that carries its OWN expiry, one fixed TTL ahead", async () => {
    const {
      getStandingApproverGrant,
      renewStandingApproverLease,
      STANDING_APPROVER_LEASE_TTL_MS,
    } = await import("../src/lib/operator-settings.js");

    const before = Date.now();
    const grant = await renewStandingApproverLease();
    const after = Date.now();

    expect(grant.active).toBe(true);
    // An `active` grant is unrepresentable without an expiry (protocol schema),
    // so the "boolean that never lapses" failure mode cannot be constructed.
    const expiresAt = Date.parse(
      (grant as { expiresAt: string }).expiresAt
    );
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + STANDING_APPROVER_LEASE_TTL_MS
    );
    expect(expiresAt).toBeLessThanOrEqual(
      after + STANDING_APPROVER_LEASE_TTL_MS
    );
    await expect(getStandingApproverGrant()).resolves.toEqual(grant);
    expect(settingRows.get(LEASE_KEY)?.value).toBe(
      (grant as { expiresAt: string }).expiresAt
    );
  });

  it("STALE fails closed: a lease that outlived its TTL reports nobody watching", async () => {
    // The desktop-crashed case: the row survives, the grant does not.
    const { getStandingApproverGrant, renewStandingApproverLease } =
      await import("../src/lib/operator-settings.js");
    await renewStandingApproverLease();
    const { STANDING_APPROVER_LEASE_TTL_MS } = await import(
      "../src/lib/operator-settings.js"
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + STANDING_APPROVER_LEASE_TTL_MS + 1_000);

    await expect(getStandingApproverGrant()).resolves.toEqual({ active: false });
  });

  it("a malformed, hand-edited, or unreadable row all resolve to nobody watching", async () => {
    const { getStandingApproverGrant } = await import(
      "../src/lib/operator-settings.js"
    );

    for (const value of [
      "",
      "true",
      "soon",
      // Past the horizon any real issuer could mint: a row like this must not
      // buy a grant nothing can revoke.
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      // Already lapsed.
      new Date(Date.now() - 1_000).toISOString(),
    ]) {
      settingRows.set(LEASE_KEY, { key: LEASE_KEY, value });
      await expect(getStandingApproverGrant()).resolves.toEqual({
        active: false,
      });
    }

    prismaMock.operatorSetting.findUnique.mockRejectedValueOnce(
      new Error("store unavailable")
    );
    await expect(getStandingApproverGrant()).resolves.toEqual({ active: false });
  });

  it("release is immediate and idempotent", async () => {
    const {
      getStandingApproverGrant,
      releaseStandingApproverLease,
      renewStandingApproverLease,
    } = await import("../src/lib/operator-settings.js");

    await renewStandingApproverLease();
    await expect(releaseStandingApproverLease()).resolves.toEqual({
      active: false,
    });
    await expect(getStandingApproverGrant()).resolves.toEqual({ active: false });
    // Releasing a lease nobody holds is a no-op, so the approver may call it on
    // every cycle it is off.
    await expect(releaseStandingApproverLease()).resolves.toEqual({
      active: false,
    });
  });
});

describe("standing-approver lease route tiers", () => {
  it("DEFAULT CLOSED over the wire; the operator AND the runner's shared agent bearer may READ it", async () => {
    const app = await buildTieredApp();
    for (const token of [OPERATOR, AGENT]) {
      const res = await app.inject({
        method: "GET",
        url: LEASE_URL,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ standingApprover: { active: false } });
    }
    await app.close();
  });

  it("REFUSES a per-job capability — the credential a vendor process holds never reads posture", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(JOB_TOKEN),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("WRITE stays operator-only: an agent-tier PUT/DELETE is 403 and the store is never written", async () => {
    const app = await buildTieredApp();
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: LEASE_URL,
        headers: auth(AGENT),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    expect(settingRows.size).toBe(0);

    // …and the agent's own read still reports nobody watching.
    const agentGet = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(AGENT),
    });
    expect(agentGet.json()).toEqual({ standingApprover: { active: false } });
    await app.close();
  });

  it("an operator PUT publishes a live grant the runner's agent bearer can read; DELETE revokes it at once", async () => {
    const app = await buildTieredApp();
    const put = await app.inject({
      method: "PUT",
      url: LEASE_URL,
      headers: auth(OPERATOR),
    });
    expect(put.statusCode).toBe(200);
    const published = put.json().standingApprover as {
      active: boolean;
      expiresAt: string;
    };
    expect(published.active).toBe(true);
    expect(Date.parse(published.expiresAt)).toBeGreaterThan(Date.now());

    const agentGet = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(AGENT),
    });
    expect(agentGet.json()).toEqual({ standingApprover: published });

    const del = await app.inject({
      method: "DELETE",
      url: LEASE_URL,
      headers: auth(OPERATOR),
    });
    expect(del.statusCode).toBe(200);
    // Revocation is not "at next restart": the very next read is closed.
    const afterRelease = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(AGENT),
    });
    expect(afterRelease.json()).toEqual({
      standingApprover: { active: false },
    });
    await app.close();
  });

  it("NOT env-settable: an agent-controllable env var cannot publish a watcher", async () => {
    process.env.standingApproverLeaseExpiresAt = new Date(
      Date.now() + 10_000
    ).toISOString();
    process.env.MUON_FULL_AUTO = "1";
    try {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "GET",
        url: LEASE_URL,
        headers: auth(OPERATOR),
      });
      expect(res.json()).toEqual({ standingApprover: { active: false } });
      await app.close();
    } finally {
      delete process.env.standingApproverLeaseExpiresAt;
      delete process.env.MUON_FULL_AUTO;
    }
  });

  it("WIRE CONTRACT: what the route emits is exactly what the client parses", async () => {
    // The hop the runner depends on. `standingApproverGrantSchema` is the SAME
    // schema `MuonApiClient.getStandingApprover` parses with, so this fails the
    // moment either half drifts — no field written here and read nowhere, and no
    // consumer left reading an older shape.
    const app = await buildTieredApp();

    const closed = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(AGENT),
    });
    expect(
      standingApproverGrantSchema.safeParse(closed.json().standingApprover)
        .success
    ).toBe(true);

    await app.inject({ method: "PUT", url: LEASE_URL, headers: auth(OPERATOR) });
    const live = await app.inject({
      method: "GET",
      url: LEASE_URL,
      headers: auth(AGENT),
    });
    const parsed = standingApproverGrantSchema.parse(
      live.json().standingApprover
    );
    expect(parsed.active).toBe(true);
    await app.close();
  });

  it("the lease path never shadows an approval id (two segments, distinct handlers)", async () => {
    // "/standing-approver/lease" must not be routable as "/:approvalId/review"
    // or as an approval resolve, or a coordinator could reach a decision route.
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/approvals/standing-approver",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
