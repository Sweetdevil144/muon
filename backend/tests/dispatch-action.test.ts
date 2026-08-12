import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { dispatchActionGateTag } from "@muon/protocol";

// ── ADR-0013 #52 v2: the vendor-native action surface, ENFORCED at dispatch ────
//
// v1 only LABELLED `gate:"dispatch-gate"` for one-shot full-auto; nothing
// enforced it, so full-auto could ship ungated. These tests prove the guards are
// now REAL at `POST /api/dispatch`:
//   • --strict-mcp-config is REFUSED (400), the governed brain is non-evictable;
//   • one-shot full-auto is OPERATOR/gate-enforced (agent tier w/o gate → 403);
//   • a resolved subcommand argv (ultrareview) is persisted, a '-'-prefixed
//     target rejected;
//   • a profileField patch (model) is persisted;
//   • cloud/remote is withheld unless the OPERATOR opts into egress;
//   • interactive full-auto stays DOWNGRADED (bypass withheld, no gate needed);
//   • a plain dispatch (no action) is byte-for-byte unchanged (back-compat).
//
// The gate store faithfully models `redeemGateAtRoute`'s atomic guarded update,
// exactly like route-gate.test.ts, so no-gate / matching-gate / replay are all
// exercised against the SAME behavior the route depends on.

const OPERATOR = "operator-token-dispatch-action";
const AGENT = "agent-token-dispatch-action";

type StoredApproval = {
  kind: string;
  status: string;
  consumedAt: Date | null;
  gateTag: string | null;
};
const gateStore = new Map<string, StoredApproval>();

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  orchestratorChat: { findUnique: vi.fn() },
  delegationGrant: { findUnique: vi.fn() },
  approvalRequest: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

async function buildTieredApp() {
  process.env.MUON_FAKE_VENDOR = "1";
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

function seedGate(id: string, tag: string) {
  gateStore.set(id, { kind: "gate", status: "approved", consumedAt: null, gateTag: tag });
}

function dispatch(app: Awaited<ReturnType<typeof buildTieredApp>>, token: string, body: unknown) {
  return app.inject({ method: "POST", url: "/api/dispatch", headers: auth(token), payload: body });
}

/** The action-derived fields the route persisted on the created job. */
function createdActionData(): Record<string, unknown> {
  const call = prismaMock.dispatchJob.create.mock.calls.at(-1);
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

const BASE = { kind: "oneshot", taskId: "task-1", brief: "do the thing" };

describe("ADR-0013 v2, dispatch action enforcement", () => {
  const originalFake = process.env.MUON_FAKE_VENDOR;

  beforeEach(() => {
    vi.clearAllMocks();
    gateStore.clear();
    prismaMock.dispatchJob.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ id: "job-1", ...args.data })
    );
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    prismaMock.dispatchJob.findMany.mockResolvedValue([]);
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      status: "active",
      workspacePath: process.cwd(),
    });
    prismaMock.$transaction.mockImplementation(async (work: unknown) =>
      Array.isArray(work)
        ? Promise.all(work)
        : (work as (tx: typeof prismaMock) => unknown)(prismaMock)
    );
    // The atomic single-use gate redeem (mirror of route-gate.test.ts).
    prismaMock.approvalRequest.updateMany.mockImplementation(
      async (args: {
        where: { id: string; kind: string; status: string; consumedAt: null; gateTag: string };
        data: { consumedAt: Date };
      }) => {
        const stored = gateStore.get(args.where.id);
        if (
          !stored ||
          stored.kind !== args.where.kind ||
          stored.status !== args.where.status ||
          stored.consumedAt !== args.where.consumedAt ||
          stored.gateTag !== args.where.gateTag
        ) {
          return { count: 0 };
        }
        stored.consumedAt = args.data.consumedAt;
        return { count: 1 };
      }
    );
  });

  afterEach(() => {
    if (originalFake === undefined) delete process.env.MUON_FAKE_VENDOR;
    else process.env.MUON_FAKE_VENDOR = originalFake;
  });

  it("prevents an agent token from minting a root orchestrator chat job", async () => {
    const app = await buildTieredApp();
    const denied = await dispatch(app, AGENT, {
      kind: "session",
      vendor: "claude-code",
      taskId: "task-chat",
      brief: "act as an orchestrator",
      chatId: "chat-forged",
      workspacePath: process.cwd(),
    });
    expect(denied.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();

    const allowed = await dispatch(app, OPERATOR, {
      kind: "session",
      vendor: "claude-code",
      taskId: "task-chat",
      brief: "act as an orchestrator",
      chatId: "chat-human",
      workspacePath: process.cwd(),
    });
    expect(allowed.statusCode).toBe(201);
    expect(createdActionData()).toMatchObject({
      capabilityMode: "orchestrator",
      delegationDepth: 0,
      maxDelegationDepth: 3,
      maxChildren: 3,
      maxTotalDescendants: 8,
    });
    await app.close();
  });

  it("prevents an agent job capability from interrupting another tree", async () => {
    const token = `control-${"e".repeat(56)}`;
    prismaMock.dispatchJob.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "job-caller"
          ? {
              id: "job-caller",
              rootJobId: null,
              parentJobId: null,
            }
          : {
              id: "job-other",
              rootJobId: null,
              parentJobId: null,
            }
    );
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-caller",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-other/interrupt",
      headers: {
        ...auth(AGENT),
        "x-muon-caller-job-id": "job-caller",
        "x-muon-delegation-token": token,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects agent job control without a bound capability as forbidden", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: "job-target",
      status: "running",
      rootJobId: null,
      parentJobId: null,
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-target/interrupt",
      headers: auth(AGENT),
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("lists only un-interrupted active jobs for panic-stop draining", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/dispatch?activeOnly=true&limit=200",
      headers: auth(OPERATOR),
    });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.dispatchJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["queued", "running"] },
          interruptRequested: false,
        },
        take: 200,
      })
    );
    await app.close();
  });

  it("expires agent job control when the caller is no longer active", async () => {
    const token = `control-${"f".repeat(56)}`;
    prismaMock.dispatchJob.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === "job-caller"
          ? {
              id: "job-caller",
              status: "done",
              rootJobId: "job-root",
              parentJobId: "job-root",
            }
          : {
              id: "job-child",
              status: "running",
              rootJobId: "job-root",
              parentJobId: "job-caller",
            }
    );
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      jobId: "job-caller",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/job-child/interrupt",
      headers: {
        ...auth(AGENT),
        "x-muon-caller-job-id": "job-caller",
        "x-muon-delegation-token": token,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  // ── GUARD: one-shot full-auto is operator/gate-enforced ─────────────────────
  it("agent tier, one-shot full-auto, NO gate → 403; nothing enqueued", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      ...BASE,
      vendor: "fake",
      action: "full-auto",
      actionVendor: "claude-code",
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("agent tier, one-shot full-auto, redeemed operator gate → 201 + permissionMode:full-auto persisted", async () => {
    // The gate binds the EXECUTION vendor (the lane that runs = "fake"), not the
    // descriptor vendor "claude-code" (which only selects the action definition).
    seedGate("gate-fa", dispatchActionGateTag("fake", "full-auto"));
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      ...BASE,
      vendor: "fake",
      action: "full-auto",
      actionVendor: "claude-code",
      gateApprovalId: "gate-fa",
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({ permissionMode: "full-auto" });
    // Single-use: the gate is consumed.
    expect(gateStore.get("gate-fa")?.consumedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it("agent tier, full-auto, WRONG gate payload (vendor mismatch) → 403; gate not consumed", async () => {
    seedGate("gate-fa", dispatchActionGateTag("codex", "full-auto")); // codex, not the "fake" lane
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      ...BASE,
      vendor: "fake",
      action: "full-auto",
      actionVendor: "claude-code",
      gateApprovalId: "gate-fa",
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    expect(gateStore.get("gate-fa")?.consumedAt).toBeNull();
    await app.close();
  });

  it("CONSENT INTEGRITY: a gate bound to the DESCRIPTOR vendor does NOT authorize a different EXECUTION vendor → 403", async () => {
    // A gate approved for "full-auto on claude-code" must NOT authorize a full-auto
    // run on the "fake" lane. The gate binds the vendor that actually executes, so an
    // agent can't get the operator to approve one vendor and run on another.
    seedGate("gate-fa", dispatchActionGateTag("claude-code", "full-auto"));
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      ...BASE,
      vendor: "fake", // executes on fake
      action: "full-auto",
      actionVendor: "claude-code", // resolves the (vendor-agnostic) descriptor
      gateApprovalId: "gate-fa",
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    expect(gateStore.get("gate-fa")?.consumedAt).toBeNull();
    await app.close();
  });

  it("operator tier, one-shot full-auto, NO gate → 201 (the human dispatches directly)", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "full-auto",
      actionVendor: "claude-code",
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
    expect(createdActionData().actionProfilePatch).toEqual({ permissionMode: "full-auto" });
    await app.close();
  });

  it("INTERACTIVE full-auto stays downgraded (bypass withheld), no gate needed", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      vendor: "claude-code",
      kind: "session",
      taskId: "task-1",
      brief: "live",
      action: "full-auto",
    });
    expect(res.statusCode).toBe(201);
    // The bypass is withheld: permission mode is forced back to default.
    expect(createdActionData().actionProfilePatch).toEqual({ permissionMode: "default" });
    await app.close();
  });

  // ── GUARD: --strict-mcp-config is refused ───────────────────────────────────
  it("strict-mcp-config → 400 refused; nothing enqueued (governed brain non-evictable)", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "strict-mcp-config",
      actionVendor: "claude-code",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  // ── subcommand channel (ultrareview) ────────────────────────────────────────
  it("ultrareview → resolved argvOverride (claude ultrareview <target> --json) persisted", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "ultrareview",
      actionVendor: "claude-code",
      target: "src/app.ts",
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionArgvOverride).toEqual({
      command: "claude",
      args: ["ultrareview", "src/app.ts", "--json"],
    });
    await app.close();
  });

  it("ultrareview with a '-'-prefixed target (--evil) → 400; nothing enqueued", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "ultrareview",
      actionVendor: "claude-code",
      target: "--evil",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  // ── profileField channel (model) ────────────────────────────────────────────
  it("model → the profilePatch is persisted onto the job", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "model",
      actionVendor: "claude-code",
      actionArgs: ["opus-4.8"],
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({ model: "opus-4.8" });
    await app.close();
  });

  // ── S6: the explicit `model` override field ─────────────────────────────────
  it("S6 model field → validated + persisted as actionProfilePatch {model}", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      model: "fake-model-1",
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({ model: "fake-model-1" });
    await app.close();
  });

  it("S6 model field, guarded value (--strict-mcp-config) → 400; nothing enqueued", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      model: "--strict-mcp-config",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("S6 model field, flag-shaped value (-x) → 400; nothing enqueued", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      model: "-x",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("S6 model field, unknown-and-refused for the vendor (fake) → 400", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      model: "ghost-model",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("S6 model field, unknown-but-custom (claude-code) → 201 + a warning surfaced", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "claude-code",
      model: "opus-9-unreleased",
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({
      model: "opus-9-unreleased",
    });
    expect(res.json().warnings?.length).toBeGreaterThan(0);
    await app.close();
  });

  it("S6 explicit model field WINS over an action:model patch", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "model",
      actionVendor: "claude-code",
      actionArgs: ["opus"],
      model: "fake-model-2",
    });
    expect(res.statusCode).toBe(201);
    // The explicit field wins; the action-derived model is overridden.
    expect(createdActionData().actionProfilePatch).toEqual({ model: "fake-model-2" });
    await app.close();
  });

  it("S6 explicit model MERGES into a non-model action patch (does not clobber it)", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "permission-mode",
      actionVendor: "claude-code",
      actionArgs: ["strict"],
      model: "fake-model-1",
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({
      permissionMode: "strict",
      model: "fake-model-1",
    });
    await app.close();
  });

  it("S6 cursor stays readiness-only: a model override never makes cursor dispatchable → 400", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "cursor",
      model: "sonnet",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  // ── egress-gate (cloud) ─────────────────────────────────────────────────────
  it("cloud WITHOUT egress opt-in → 400 withheld", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "cloud",
      actionVendor: "claude-code",
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("cloud with an AGENT-tier egressOptIn is still withheld (egress is operator-only) → 400", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, {
      ...BASE,
      vendor: "fake",
      action: "cloud",
      actionVendor: "claude-code",
      egressOptIn: true,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("cloud WITH an operator egress opt-in → 201 (the operator accepts egress)", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "cloud",
      actionVendor: "claude-code",
      egressOptIn: true,
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({ extraArgs: ["--cloud"] });
    await app.close();
  });

  // ── warn (append system-prompt), allowed, warning surfaced ─────────────────
  it("system-prompt → append-only patch persisted + the provenance warning surfaced", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, OPERATOR, {
      ...BASE,
      vendor: "fake",
      action: "system-prompt",
      actionVendor: "claude-code",
      actionArgs: ["be", "terse"],
    });
    expect(res.statusCode).toBe(201);
    expect(createdActionData().actionProfilePatch).toEqual({
      extraArgs: ["--append-system-prompt", "be terse"],
    });
    // The warning is surfaced to the caller (warn is allowed, not blocked).
    expect(res.json().warnings?.length).toBeGreaterThan(0);
    await app.close();
  });

  // ── back-compat ─────────────────────────────────────────────────────────────
  it("BACK-COMPAT: a plain dispatch (no action) enqueues unchanged, no action columns", async () => {
    const app = await buildTieredApp();
    const res = await dispatch(app, AGENT, { vendor: "claude-code", taskId: "task-1", brief: "plain" });
    expect(res.statusCode).toBe(201);
    const data = createdActionData();
    expect(data.action).toBeUndefined();
    expect(data.actionProfilePatch).toBeUndefined();
    expect(data.actionArgvOverride).toBeUndefined();
    expect(data.actionBriefPrefix).toBeUndefined();
    expect(data.vendor).toBe("claude-code");
    await app.close();
  });
});
