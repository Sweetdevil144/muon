import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { setReadinessProber } from "../src/routes/fleet.js";

const prismaMock = vi.hoisted(() => ({
  agent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  event: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const graphMock = vi.hoisted(() => ({
  suggestLanes: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  mirrorToGraph: () => undefined,
}));

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    vendor: "claude-code",
    name: "claude-code-1",
    ordinal: 1,
    status: "idle",
    currentTaskId: null,
    sessionId: null,
    createdAt: new Date("2026-07-10T10:00:00.000Z"),
    updatedAt: new Date("2026-07-10T10:00:00.000Z"),
    ...overrides,
  };
}

describe("fleet API (agents per vendor, claim semaphore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.agent.findMany.mockResolvedValue([]);
    prismaMock.agent.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        agentRow({ id: `agent-${args.data.ordinal}`, ...args.data })
    );
    prismaMock.agent.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.agent.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.event.create.mockResolvedValue({ id: "event-1" });
    // Interactive transactions are a callback over the same client surface.
    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock)
    );
  });

  it("rejects a resize above the per-vendor maximum (400 via zod)", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 4 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("scales up by creating named instances per vendor", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.agent.create).toHaveBeenCalledWith({
      data: { vendor: "claude-code", ordinal: 1, name: "claude-code-1" },
    });
    expect(prismaMock.agent.create).toHaveBeenCalledWith({
      data: { vendor: "claude-code", ordinal: 2, name: "claude-code-2" },
    });
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "fleet.updated" }),
      })
    );
    await app.close();
  });

  it("scales down by deleting idle instances only, warning about working ones", async () => {
    prismaMock.agent.findMany.mockResolvedValue([
      agentRow({ id: "agent-1", ordinal: 1, name: "claude-code-1" }),
      agentRow({
        id: "agent-2",
        ordinal: 2,
        name: "claude-code-2",
        status: "working",
        currentTaskId: "task-1",
      }),
      agentRow({ id: "agent-3", ordinal: 3, name: "claude-code-3" }),
    ]);
    prismaMock.agent.deleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 1 },
    });

    expect(response.statusCode).toBe(200);
    // Only the idle excess instance is retired; the delete is status-guarded
    // so a concurrently claimed agent can never be killed by a resize.
    expect(prismaMock.agent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["agent-3"] }, status: "idle" },
    });
    expect(response.json().warnings).toEqual([
      "claude-code: 1 working agent(s) kept until they finish, resize again later",
    ]);
    await app.close();
  });

  it("scales up after a gap by reusing the smallest unused ordinal", async () => {
    // Scale-down retired ordinal 2 while 1 and 3 kept working: the next
    // instance must fill the gap, not collide on @@unique([vendor, ordinal]).
    prismaMock.agent.findMany.mockResolvedValue([
      agentRow({ id: "agent-1", ordinal: 1, name: "claude-code-1" }),
      agentRow({
        id: "agent-3",
        ordinal: 3,
        name: "claude-code-3",
        status: "working",
      }),
    ]);

    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.agent.create).toHaveBeenCalledWith({
      data: { vendor: "claude-code", ordinal: 2, name: "claude-code-2" },
    });
    await app.close();
  });

  it("keeps an excess agent that got claimed mid-resize (guarded delete found nothing)", async () => {
    prismaMock.agent.findMany.mockResolvedValue([
      agentRow({ id: "agent-1", ordinal: 1, name: "claude-code-1" }),
      agentRow({ id: "agent-2", ordinal: 2, name: "claude-code-2" }),
    ]);
    // agent-2 read as idle, but a concurrent claim flipped it to working
    // before the delete: the status guard matches zero rows.
    prismaMock.agent.deleteMany.mockResolvedValue({ count: 0 });

    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["agent-2"] }, status: "idle" },
    });
    // The warning reflects what actually remained, not the stale read.
    expect(response.json().warnings).toEqual([
      "claude-code: 1 working agent(s) kept until they finish, resize again later",
    ]);
    await app.close();
  });

  it("maps a P2002 ordinal collision during resize to a 409, not a 500", async () => {
    prismaMock.agent.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("concurrent fleet resize");
    await app.close();
  });

  it("excludes the coordinator (ordinal 0) from fleet counts and the agent list", async () => {
    prismaMock.agent.findMany.mockResolvedValue([]);
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/api/fleet" });

    expect(response.statusCode).toBe(200);
    // The snapshot query filters out ordinal 0, so the coordinator sits above the
    // fleet: never counted toward a vendor total, never in the operator's view.
    // It ALSO scopes seats to the claimable vendors, so a seat left behind by a
    // vendor that has since left the registry cannot outlive it in this list —
    // see lane-retirement.test.ts.
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ordinal: { gte: 1 } }),
      })
    );
    await app.close();
  });

  it("a resize to 0 never counts, creates, or deletes the coordinator", async () => {
    // No worker lanes for claude-code; the coordinator (ordinal 0) is invisible
    // to the worker-scoped resize query, so it can never enter the delete set.
    prismaMock.agent.findMany.mockResolvedValue([]);
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/api/fleet",
      payload: { "claude-code": 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vendor: "claude-code", ordinal: { gte: 1 } },
      })
    );
    expect(prismaMock.agent.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("claims an idle agent atomically: 201, marked working with the task", async () => {
    prismaMock.agent.findFirst.mockResolvedValue(
      agentRow({ vendor: "codex", name: "codex-1" })
    );
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agent.findUnique.mockResolvedValue(
      agentRow({
        vendor: "codex",
        name: "codex-1",
        status: "working",
        currentTaskId: "task-1",
      })
    );

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "codex", taskId: "task-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().agent).toMatchObject({
      status: "working",
      currentTaskId: "task-1",
    });
    // The claim is a status-guarded write, not a blind update by id.
    expect(prismaMock.agent.updateMany).toHaveBeenCalledWith({
      where: { id: "agent-1", status: "idle" },
      data: { status: "working", currentTaskId: "task-1" },
    });
    await app.close();
  });

  it("retries the next idle candidate when a concurrent claim wins the row", async () => {
    prismaMock.agent.findFirst
      .mockResolvedValueOnce(
        agentRow({ id: "agent-1", vendor: "codex", name: "codex-1" })
      )
      .mockResolvedValueOnce(
        agentRow({ id: "agent-2", ordinal: 2, vendor: "codex", name: "codex-2" })
      );
    // First candidate was grabbed between findFirst and the guarded update.
    prismaMock.agent.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.agent.findUnique.mockResolvedValue(
      agentRow({
        id: "agent-2",
        ordinal: 2,
        vendor: "codex",
        name: "codex-2",
        status: "working",
        currentTaskId: "task-1",
      })
    );

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "codex", taskId: "task-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().agent).toMatchObject({
      id: "agent-2",
      status: "working",
      currentTaskId: "task-1",
    });
    expect(prismaMock.agent.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.agent.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "agent-1", status: "idle" },
      data: { status: "working", currentTaskId: "task-1" },
    });
    expect(prismaMock.agent.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "agent-2", status: "idle" },
      data: { status: "working", currentTaskId: "task-1" },
    });
    await app.close();
  });

  it("409s after the retry cap when every guarded claim loses the race", async () => {
    // An idle row always appears in the read, but another claimer always
    // wins the guarded write, the loop must terminate, not spin forever.
    prismaMock.agent.findFirst.mockResolvedValue(
      agentRow({ vendor: "codex", name: "codex-1" })
    );
    prismaMock.agent.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.agent.count.mockResolvedValue(3);

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "codex", taskId: "task-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain(
      "All 3 'codex' agent(s) are working"
    );
    expect(prismaMock.agent.findFirst).toHaveBeenCalledTimes(5);
    expect(prismaMock.agent.updateMany).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it("rejects an unscoped Cursor claim before consulting the fleet semaphore", async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null);
    prismaMock.agent.count.mockResolvedValue(0);

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "cursor" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(
      /managed for read-only crew roles only/i
    );
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a Cursor claim for a write-class role, and admits a review-class one", async () => {
    const app = buildApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "cursor", role: "implementer" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/managed READ-ONLY lane/i);
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();

    const cursorSeat = agentRow({ vendor: "cursor", name: "cursor-1" });
    prismaMock.agent.findFirst.mockResolvedValue(cursorSeat);
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agent.findUnique.mockResolvedValue({
      ...cursorSeat,
      status: "working",
    });
    const claimed = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "cursor", role: "reviewer", taskId: "task-1" },
    });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json().agent.vendor).toBe("cursor");
    await app.close();
  });

  it("rejects an opencode claim for a role its adapter does not declare", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "opencode", role: "implementer" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(
      /Vendor 'opencode' cannot hold the crew role 'implementer'/i
    );
    expect(prismaMock.agent.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("409s a claim when every instance of the vendor is working", async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null);
    prismaMock.agent.count.mockResolvedValue(3);

    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/fleet/agents/claim",
      payload: { vendor: "codex", taskId: "task-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain(
      "All 3 'codex' agent(s) are working"
    );
    await app.close();
  });

  // A stubbed prober keeps this deterministic and spawn-free (no real vendor
  // CLI is ever run in tests).
  describe("readiness route (P2 auth-aware onboarding)", () => {
    afterEach(() => setReadinessProber(null));

    it("returns per-vendor readiness and anyReady:true when a vendor is ready", async () => {
      setReadinessProber(async () => [
        {
          vendor: "claude-code",
          installed: true,
          authenticated: true,
          credentialMethod: "api-key",
          detail: "configured with a Claude Code API key",
        },
        { vendor: "codex", installed: true, authenticated: false, detail: "not logged in", fixHint: "`codex login`" },
        { vendor: "cursor", installed: false, authenticated: false, detail: "not found", fixHint: "install it" },
      ]);

      const app = buildApp();
      const response = await app.inject({ method: "GET", url: "/api/fleet/readiness" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.anyReady).toBe(true);
      expect(body.warning).toBeUndefined();
      expect(body.vendors).toHaveLength(3);
      expect(body.vendors[0]).toMatchObject({
        vendor: "claude-code",
        authenticated: true,
        credentialMethod: "api-key",
      });
      expect(body.vendors[1]).toMatchObject({
        vendor: "codex",
        authenticated: false,
        fixHint: "`codex login`",
      });
      await app.close();
    });

    it("soft-warns (anyReady:false + warning) when NO vendor is ready", async () => {
      setReadinessProber(async () => [
        { vendor: "claude-code", installed: true, authenticated: false, detail: "not logged in", fixHint: "sign in" },
        { vendor: "codex", installed: false, authenticated: false, detail: "not found" },
        { vendor: "cursor", installed: false, authenticated: false, detail: "not found" },
      ]);

      const app = buildApp();
      const response = await app.inject({ method: "GET", url: "/api/fleet/readiness" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.anyReady).toBe(false);
      expect(body.warning).toBe(
        "No vendor is ready, configure or sign in to at least one installed agent before dispatching."
      );
      await app.close();
    });

    it("reports authenticated Cursor evidence without unlocking dispatch", async () => {
      setReadinessProber(async () => [
        {
          vendor: "cursor",
          installed: true,
          authenticated: true,
          detail: "logged in",
        },
      ]);

      const app = buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/fleet/readiness",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.vendors[0]).toMatchObject({
        vendor: "cursor",
        installed: true,
        authenticated: true,
      });
      expect(body.anyReady).toBe(false);
      expect(body.warning).toMatch(/No vendor is ready/i);
      await app.close();
    });

    // `anyReady` is DERIVED from each lane's declared role ceiling, not from a
    // vendor name list. Pinned with a lane MUON has no probe for: the derived
    // rule answers "no write role ⇒ does not unlock dispatch", where the old
    // `vendor !== "cursor"` spelling would have counted it ready. Same verdict
    // as before for all four managed lanes; this is the drift it now resists.
    it("does not unlock dispatch for a lane with no write-capable role", async () => {
      setReadinessProber(async () => [
        {
          vendor: "some-unmanaged-lane",
          installed: true,
          authenticated: true,
          detail: "logged in",
        },
      ]);

      const app = buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/fleet/readiness",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().anyReady).toBe(false);
      await app.close();
    });

    it("echoes the prober's authState tri-state verbatim (P0.5 wire passthrough)", async () => {
      setReadinessProber(async () => [
        {
          vendor: "codex",
          installed: true,
          authenticated: false,
          detail: "auth probe could not run (timed out)",
          fixHint: "log into Codex first: `codex login`",
          authState: "unknown",
        },
      ]);

      const app = buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/fleet/readiness",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().vendors[0]).toMatchObject({
        vendor: "codex",
        authenticated: false,
        authState: "unknown",
      });
      await app.close();
    });

    it("passes refresh=1 through to the prober (post-login re-check)", async () => {
      const prober = vi.fn(async () => [
        { vendor: "claude-code", installed: true, authenticated: true, detail: "logged in" },
      ]);
      setReadinessProber(prober);

      const app = buildApp();
      await app.inject({ method: "GET", url: "/api/fleet/readiness?refresh=1" });

      expect(prober).toHaveBeenCalledWith({ refresh: true });
      await app.close();
    });
  });

  it("releasing an agent (PATCH status idle) clears its task and session pointers", async () => {
    prismaMock.agent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agent.findUnique.mockResolvedValue(agentRow());

    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/fleet/agents/agent-1",
      payload: { status: "idle" },
    });

    expect(response.statusCode).toBe(200);
    expect(prismaMock.agent.updateMany).toHaveBeenCalledWith({
      where: { id: "agent-1", currentJobId: null },
      data: {
        status: "idle",
        currentTaskId: null,
        currentJobId: null,
        sessionId: null,
      },
    });
    await app.close();
  });

  it("rejects generic release of an agent owned by a dispatch job", async () => {
    prismaMock.agent.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.agent.findUnique.mockResolvedValue(
      agentRow({
        status: "working",
        currentTaskId: "task-1",
        currentJobId: "job-1",
      })
    );

    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/fleet/agents/agent-1",
      payload: { status: "idle" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/dispatch job/i);
    expect(prismaMock.agent.update).not.toHaveBeenCalled();
    await app.close();
  });
});
