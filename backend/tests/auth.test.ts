import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  lane: { findMany: vi.fn(), findUnique: vi.fn() },
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
