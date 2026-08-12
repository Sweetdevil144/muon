import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  runner: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const LEASE_TOKEN = `lease-${"a".repeat(58)}`;
const LEASE_HASH = createHash("sha256").update(LEASE_TOKEN).digest("hex");

const LIVE_RUNNER = {
  id: "r1",
  host: "desktop-mac",
  pid: 41,
  leaseHash: LEASE_HASH,
  status: "online",
  lastSeenAt: new Date(),
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
};

const JOB_ID = "job-backlink";
const VENDOR_SESSION_ID = "019fa043-e5c2-7731-b2f3-11312f91d2d2";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    host: "desktop-mac",
    leaseToken: LEASE_TOKEN,
    vendorSessionId: VENDOR_SESSION_ID,
    ...overrides,
  };
}

describe("dispatch vendor-session backlink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
  });

  it("stamps the vendor session id under the exact runner lease", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/vendor-session`,
      payload: payload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vendorSessionId: VENDOR_SESSION_ID });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: JOB_ID,
        status: "running",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      },
      data: { vendorSessionId: VENDOR_SESSION_ID },
    });
  });

  it("normalizes the id to lowercase (both vendors emit lowercase uuids)", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/vendor-session`,
      payload: payload({ vendorSessionId: VENDOR_SESSION_ID.toUpperCase() }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vendorSessionId: VENDOR_SESSION_ID });
  });

  it("refuses anything that is not the vendors' uuid shape", async () => {
    // The column's one consumer is a resume argv, so shape is a fence here,
    // not a formality.
    const app = buildApp();
    for (const bad of [
      "not-a-uuid",
      "019fa043-e5c2-7731-b2f3", // truncated
      `${VENDOR_SESSION_ID}; rm -rf /`, // injection shape
      "",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/dispatch/${JOB_ID}/vendor-session`,
        payload: payload({ vendorSessionId: bad }),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a stamp from anything but the lease-holding runner of a RUNNING job", async () => {
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 0 });
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/vendor-session`,
      payload: payload(),
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a dead or unknown lease outright", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/vendor-session`,
      payload: payload(),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
  });
});
