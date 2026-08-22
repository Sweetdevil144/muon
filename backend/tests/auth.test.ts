import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  lane: { findMany: vi.fn(), findUnique: vi.fn() },
  delegationGrant: { findFirst: vi.fn() },
  dispatchJob: { findUnique: vi.fn() },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

describe("API bearer-token gate", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.lane.findMany.mockResolvedValue([]);
    prismaMock.delegationGrant.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(null);
  });

  async function buildAppWithToken(token?: string) {
    if (token) {
      process.env.MUON_API_TOKEN = token;
    } else {
      delete process.env.MUON_API_TOKEN;
    }
    const { buildApp } = await import("../src/app.js");
    return buildApp();
  }

  it("rejects /api requests without the token when configured", async () => {
    const app = await buildAppWithToken("secret-token-123");

    const denied = await app.inject({ method: "GET", url: "/api/lanes" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: "Bearer secret-token-123" },
    });
    expect(allowed.statusCode).toBe(200);

    // Health stays open for probes.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it("rejects wrong tokens", async () => {
    const app = await buildAppWithToken("secret-token-123");
    const response = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("a token MUON issued is refused differently from a bad one", () => {
  // Measured live: a Claude session the human started got 401 "Missing or
  // invalid API token" plus a hint to check `muon doctor` — which was entirely
  // green. The token was fine; the session simply had no job, so memory and
  // crew routes had no partition to answer in. An agent cannot self-diagnose
  // from a credential error that describes a credential that is not wrong.
  const LONG = "x".repeat(64);
  // The real hash, so capabilityTokenMatches() accepts it the way it would a
  // token MUON actually issued — a fake hash would exercise the reject path
  // and the test would pass for the wrong reason.
  const LONG_HASH = createHash("sha256").update(LONG).digest("hex");

  beforeEach(() => {
    vi.resetModules();
    prismaMock.lane.findMany.mockResolvedValue([]);
    prismaMock.dispatchJob.findUnique.mockResolvedValue(null);
  });

  async function build() {
    process.env.MUON_API_TOKEN = "secret-token-123";
    const { buildApp } = await import("../src/app.js");
    return buildApp();
  }

  it("403s a RECOGNISED token whose LEASE has expired, naming the capability", async () => {
    // A REAL expired grant: MUON issued this token, and its lease has lapsed.
    // (Without expiresAt the resolver throws before reaching the branch under
    // test, and a 500 would have passed for a 403 if this asserted loosely.)
    prismaMock.delegationGrant.findFirst.mockResolvedValue({
      tokenHash: LONG_HASH,
      issuedAt: new Date(0),
      expiresAt: new Date(0),
      jobId: "job-gone",
    });
    // A plain worker job, not an attached coordinator: the horizon guard only
    // applies to the latter, and this case is an ordinary lapsed lease.
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      capabilityMode: "worker",
      status: "completed",
    });
    const app = await build();
    const response = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: `Bearer ${LONG}` },
    });
    expect(response.statusCode).toBe(403);
    // The phrase @muon/mcp's remedyFor() matches to explain the refusal.
    expect(response.json().message).toMatch(/exact active job capability/i);
    await app.close();
  });

  it("403s an UNEXPIRED grant whose JOB has finished — the ordinary inactive case", async () => {
    // The arm the 403 mostly exists for: nothing is wrong with the lease, the
    // work is simply over. Untested until now; the other 403 test used an
    // expired grant, so this branch was never reached.
    const token = "z".repeat(64);
    const hash = createHash("sha256").update(token).digest("hex");
    prismaMock.delegationGrant.findFirst.mockResolvedValue({
      tokenHash: hash,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      jobId: "job-finished",
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      capabilityMode: "worker",
      status: "completed",
      interruptRequested: false,
    });
    const app = await build();
    const response = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/exact active job capability/i);
    await app.close();
  });

  it("still 401s an UNRECOGNISED token — a bad credential is not a scope problem", async () => {
    prismaMock.delegationGrant.findFirst.mockResolvedValue(null);
    const app = await build();
    const response = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: `Bearer ${LONG}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("does NOT put the scope phrase on the 401 — that advice is false there", async () => {
    // `remedyFor()` matches the phrase and answers "a SCOPE refusal, not a
    // fault — retrying will fail identically". Told to someone whose token is
    // simply wrong, that stops them fixing the one thing they could fix.
    prismaMock.delegationGrant.findFirst.mockResolvedValue(null);
    const app = await build();
    const response = await app.inject({ method: "GET", url: "/api/lanes" });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).not.toMatch(/exact active job capability/i);
    await app.close();
  });
});

describe("a TAMPERED grant fails closed at authentication, not at scope", () => {
  // ADR-0028 §3: a corrupted far-future expiry past the attached coordinator's
  // independent horizon must never be trusted. Softening it to 403 would tell
  // whoever holds a doctored grant that their token is genuine and merely out
  // of scope — the one sentence that must not be said on that path.
  it("stays 401 for an attached-coordinator grant beyond its horizon", async () => {
    const token = "y".repeat(64);
    const hash = createHash("sha256").update(token).digest("hex");
    vi.resetModules();
    prismaMock.lane.findMany.mockResolvedValue([]);
    prismaMock.delegationGrant.findFirst.mockResolvedValue({
      tokenHash: hash,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 24 * 3_600_000),
      jobId: "job-attached",
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      capabilityMode: "attached-coordinator",
      status: "running",
    });
    process.env.MUON_API_TOKEN = "secret-token-123";
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/lanes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
