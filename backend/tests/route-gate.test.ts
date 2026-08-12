import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyWorkflowGateTag,
  fleetGateTag,
  workflowProposalSchema,
} from "@muon/protocol";
import { hashProposal } from "../src/lib/gate.js";

// ── ADR-0010 Part B: route-level gate enforcement (closes F3/F4) ──────────────
//
// The human gate on `PUT /api/fleet` and `POST /api/workflow-runs/:runId/apply`
// used to live ONLY in the MCP tool layer, so a bare agent-tier HTTP call to
// either route bypassed it. These tests prove the gate is now enforced AT THE
// ROUTE: an agent-tier caller must present a redeemed, tag-bound, operator-
// approved, SINGLE-USE gate, while the operator tier (and the no-token dev mode)
// applies directly.
//
// The real single-use/tag/kind semantics live in the prisma.approvalRequest
// .updateMany mock, an in-memory approvals store that faithfully models the
// atomic guarded update `redeemGateAtRoute` relies on, so no-gate, matching
// gate, replay, wrong-payload, and cross-kind are all exercised against the
// SAME behavior the route depends on, with the tag computed by the shared
// @muon/protocol helpers (proving the filer and the redeemer agree).

const OPERATOR = "operator-token-route-gate-1";
const AGENT = "agent-token-route-gate-1";
const WORKFLOW_TOKEN = `workflow-${"w".repeat(56)}`;

type StoredApproval = {
  kind: string;
  status: string;
  consumedAt: Date | null;
  gateTag: string | null;
};

// Module-level so both the hoisted updateMany impl and the test bodies can seed
// and inspect it. Reset in beforeEach.
const gateStore = new Map<string, StoredApproval>();

const prismaMock = vi.hoisted(() => ({
  approvalRequest: { updateMany: vi.fn() },
  agent: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  orchestratorChat: { findUnique: vi.fn() },
  dispatchJob: { findUnique: vi.fn() },
  delegationGrant: { findUnique: vi.fn() },
  event: { create: vi.fn() },
  workflowRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  task: { create: vi.fn() },
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

async function buildOpenApp() {
  delete process.env.MUON_OPERATOR_TOKEN;
  delete process.env.MUON_AGENT_TOKEN;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function workflowAgentHeaders() {
  return {
    ...auth(AGENT),
    "x-muon-caller-job-id": "job-root",
    "x-muon-delegation-token": WORKFLOW_TOKEN,
  };
}

function seedGate(id: string, tag: string) {
  gateStore.set(id, {
    kind: "gate",
    status: "approved",
    consumedAt: null,
    gateTag: tag,
  });
}

const PROPOSAL = {
  summary: "Apply this run",
  steps: [{ stepKey: "s1", title: "Step one", brief: "do the thing" }],
};

// The apply gate is bound to the runId AND the proposal-content hash (F-2), so
// seed the enforced tag exactly as the route recomputes it from the current
// (schema-parsed) proposal.
function applyTag(runId: string, proposal: unknown = PROPOSAL): string {
  return applyWorkflowGateTag(
    runId,
    hashProposal(workflowProposalSchema.parse(proposal))
  );
}

describe("ADR-0010 Part B: route-level gate enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateStore.clear();

    // The atomic guarded consume: matches exactly one row iff the stored
    // approval is a still-un-consumed, operator-approved gate bound to the EXACT
    // tag, then stamps consumedAt (single-use). Anything else → count 0.
    prismaMock.approvalRequest.updateMany.mockImplementation(
      async (args: {
        where: {
          id: string;
          kind: string;
          status: string;
          consumedAt: null;
          gateTag: string;
        };
        data: { consumedAt: Date };
      }) => {
        const { where, data } = args;
        const stored = gateStore.get(where.id);
        if (!stored) {
          return { count: 0 };
        }
        const matches =
          stored.kind === where.kind &&
          stored.status === where.status &&
          stored.consumedAt === where.consumedAt &&
          stored.gateTag === where.gateTag;
        if (!matches) {
          return { count: 0 };
        }
        stored.consumedAt = data.consumedAt;
        return { count: 1 };
      }
    );

    // Fleet write side.
    prismaMock.agent.findMany.mockResolvedValue([]);
    prismaMock.agent.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({
        id: `agent-${args.data.ordinal}`,
        ...args.data,
      })
    );
    prismaMock.agent.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.event.create.mockResolvedValue({ id: "event-1" });

    // Workflow apply write side.
    prismaMock.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "proposed",
      proposal: PROPOSAL,
      workspacePath: null,
      chatId: "chat-1",
      templateKey: null,
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    prismaMock.orchestratorChat.findUnique.mockResolvedValue({
      status: "active",
      workspacePath: "/repo",
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      chatId: "chat-1",
      status: "running",
      interruptRequested: false,
      capabilityMode: "orchestrator",
    });
    prismaMock.delegationGrant.findUnique.mockResolvedValue({
      tokenHash: createHash("sha256").update(WORKFLOW_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.task.create.mockResolvedValue({
      id: "t1",
      title: "Step one",
      status: "pending",
      stepKey: "s1",
    });
    prismaMock.workflowRun.update.mockResolvedValue({
      id: "run-1",
      appliedBy: "agent:muon",
      templateKey: null,
      status: "applied",
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    prismaMock.workflowRun.updateMany.mockResolvedValue({ count: 1 });

    prismaMock.$transaction.mockImplementation(
      async (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock)
    );
  });

  // ── PUT /api/fleet ──────────────────────────────────────────────────────────

  describe("PUT /api/fleet", () => {
    it("agent tier, NO gate → 403; the fleet is not touched (no write)", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: workflowAgentHeaders(),
        payload: { "claude-code": 2 },
      });
      expect(res.statusCode).toBe(403);
      // No gate id → the atomic redeem is never even attempted, and no write ran.
      expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.agent.create).not.toHaveBeenCalled();
      expect(prismaMock.event.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("agent tier, operator-approved gate bound to the EXACT counts → 200 applied + gate consumed", async () => {
      seedGate("gate-fleet", fleetGateTag({ "claude-code": 2 }));
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(AGENT),
        payload: { "claude-code": 2, gateApprovalId: "gate-fleet" },
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.agent.create).toHaveBeenCalledTimes(2);
      expect(prismaMock.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "fleet.updated" }),
        })
      );
      // Single-use: the gate is now consumed.
      expect(gateStore.get("gate-fleet")?.consumedAt).toBeInstanceOf(Date);
      await app.close();
    });

    it("agent tier, REPLAY of the same gate id → 403 (single-use)", async () => {
      seedGate("gate-fleet", fleetGateTag({ "claude-code": 2 }));
      const app = await buildTieredApp();
      const first = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(AGENT),
        payload: { "claude-code": 2, gateApprovalId: "gate-fleet" },
      });
      expect(first.statusCode).toBe(200);

      const replay = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(AGENT),
        payload: { "claude-code": 2, gateApprovalId: "gate-fleet" },
      });
      expect(replay.statusCode).toBe(403);
      // Exactly two agents were created (the replay applied nothing new).
      expect(prismaMock.agent.create).toHaveBeenCalledTimes(2);
      await app.close();
    });

    it("agent tier, WRONG payload (gate for claude-code=2, body claude-code=3) → 403; the gate is NOT consumed", async () => {
      seedGate("gate-fleet", fleetGateTag({ "claude-code": 2 }));
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(AGENT),
        payload: { "claude-code": 3, gateApprovalId: "gate-fleet" },
      });
      expect(res.statusCode).toBe(403);
      expect(prismaMock.agent.create).not.toHaveBeenCalled();
      // A mismatched tag matches no row, so the gate stays usable for its real payload.
      expect(gateStore.get("gate-fleet")?.consumedAt).toBeNull();
      await app.close();
    });

    it("agent tier, CROSS-KIND id (a merge approval) → 403", async () => {
      gateStore.set("approval-merge", {
        kind: "merge",
        status: "approved",
        consumedAt: null,
        gateTag: null,
      });
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(AGENT),
        payload: { "claude-code": 2, gateApprovalId: "approval-merge" },
      });
      expect(res.statusCode).toBe(403);
      expect(prismaMock.agent.create).not.toHaveBeenCalled();
      await app.close();
    });

    it("operator tier, NO gate → 200 (the human's direct path is unbroken)", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        headers: auth(OPERATOR),
        payload: { "claude-code": 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.agent.create).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("no-token dev mode, NO gate → 200 (tier defaults to operator)", async () => {
      const app = await buildOpenApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/fleet",
        payload: { "claude-code": 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.agent.create).toHaveBeenCalledTimes(1);
      await app.close();
    });
  });

  // ── POST /api/workflow-runs/:runId/apply ─────────────────────────────────────

  describe("POST /api/workflow-runs/:runId/apply", () => {
    it("binds the apply gate to parallel ownership and group metadata", () => {
      const base = workflowProposalSchema.parse({
        summary: "parallel proposal",
        steps: [
          {
            stepKey: "one",
            title: "First independent edit",
            brief: "Edit one.",
            laneKey: "codex",
            parallel: {
              group: "pair",
              independent: true,
              paths: ["src/one"],
            },
          },
          {
            stepKey: "two",
            title: "Second independent edit",
            brief: "Edit two.",
            laneKey: "claude-code",
            parallel: {
              group: "pair",
              independent: true,
              paths: ["src/two"],
            },
          },
        ],
      });
      const changed = workflowProposalSchema.parse({
        ...base,
        steps: base.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                parallel: {
                  group: "pair",
                  independent: true,
                  paths: ["src/shared"],
                },
              }
            : step
        ),
      });

      expect(hashProposal(base)).not.toBe(hashProposal(changed));
    });

    it("binds the apply gate to a step's LOOP BUDGET (ADR-0045's flagged hole)", () => {
      // `loop` carries maxIterations/maxWallMs, and maxWallMs is spent as a
      // real dispatch wall. It was absent from the digest, so a budget could be
      // raised AFTER the human approved the gate without breaking the binding.
      const base = workflowProposalSchema.parse({
        summary: "looped proposal",
        steps: [
          {
            stepKey: "s1",
            title: "Repair until green",
            brief: "Run the loop.",
            laneKey: "codex",
            loop: { kind: "check_repair", maxIterations: 2, maxWallMs: 60_000 },
          },
        ],
      });
      const wider = workflowProposalSchema.parse({
        summary: "looped proposal",
        steps: [
          {
            stepKey: "s1",
            title: "Repair until green",
            brief: "Run the loop.",
            laneKey: "codex",
            loop: {
              kind: "check_repair",
              maxIterations: 2,
              maxWallMs: 3_600_000,
            },
          },
        ],
      });
      const moreIterations = workflowProposalSchema.parse({
        summary: "looped proposal",
        steps: [
          {
            stepKey: "s1",
            title: "Repair until green",
            brief: "Run the loop.",
            laneKey: "codex",
            loop: { kind: "check_repair", maxIterations: 9, maxWallMs: 60_000 },
          },
        ],
      });
      const noLoop = workflowProposalSchema.parse({
        summary: "looped proposal",
        steps: [
          {
            stepKey: "s1",
            title: "Repair until green",
            brief: "Run the loop.",
            laneKey: "codex",
          },
        ],
      });
      expect(hashProposal(base)).not.toBe(hashProposal(wider));
      expect(hashProposal(base)).not.toBe(hashProposal(moreIterations));
      expect(hashProposal(base)).not.toBe(hashProposal(noLoop));
    });

    it("agent tier, NO gate → 403; the run stays proposed (no write)", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human" },
      });
      expect(res.statusCode).toBe(403);
      // The run may be read (to compute the content-bound tag), but nothing is
      // written, the run stays proposed.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.workflowRun.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("agent tier, operator-approved gate bound to the runId + proposal content → 201 applied", async () => {
      seedGate("gate-apply", applyTag("run-1"));
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human", gateApprovalId: "gate-apply" },
      });
      expect(res.statusCode).toBe(201);
      expect(prismaMock.workflowRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "applied" }),
        })
      );
      expect(gateStore.get("gate-apply")?.consumedAt).toBeInstanceOf(Date);
      await app.close();
    });

    it("agent tier, REPLAY of the same apply gate → 403 (single-use)", async () => {
      seedGate("gate-apply", applyTag("run-1"));
      const app = await buildTieredApp();
      const first = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human", gateApprovalId: "gate-apply" },
      });
      expect(first.statusCode).toBe(201);
      const replay = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human", gateApprovalId: "gate-apply" },
      });
      expect(replay.statusCode).toBe(403);
      await app.close();
    });

    it("agent tier, WRONG run (apply gate for run A used on run B) → 403; the run-A gate is NOT consumed", async () => {
      seedGate("gate-apply-A", applyTag("run-A"));
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-B/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human", gateApprovalId: "gate-apply-A" },
      });
      expect(res.statusCode).toBe(403);
      // The redeem tag for run-B never matches the run-A gate, so it is untouched.
      expect(gateStore.get("gate-apply-A")?.consumedAt).toBeNull();
      expect(prismaMock.workflowRun.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("agent tier, CROSS-KIND id (a command approval) → 403", async () => {
      gateStore.set("approval-cmd", {
        kind: "command",
        status: "approved",
        consumedAt: null,
        gateTag: null,
      });
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: workflowAgentHeaders(),
        payload: { appliedBy: "human", gateApprovalId: "approval-cmd" },
      });
      expect(res.statusCode).toBe(403);
      expect(prismaMock.workflowRun.updateMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("operator tier, NO gate → 201 (the human's `muon workflow apply` is unbroken)", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/workflow-runs/run-1/apply",
        headers: auth(OPERATOR),
        payload: { appliedBy: "human:carol" },
      });
      expect(res.statusCode).toBe(201);
      expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.workflowRun.updateMany).toHaveBeenCalledOnce();
      await app.close();
    });
  });

  // ── PATCH /api/workflow-runs/:runId, status transitions are operator-only ────
  describe("PATCH /api/workflow-runs/:runId (status transition)", () => {
    it("agent tier, {status:'abandoned'} → 403; the run is not mutated", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/workflow-runs/run-1",
        headers: auth(AGENT),
        payload: { status: "abandoned" },
      });
      expect(res.statusCode).toBe(403);
      expect(prismaMock.workflowRun.update).not.toHaveBeenCalled();
      await app.close();
    });

    it("operator tier, {status:'abandoned'} → 200 (the human manages the run)", async () => {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/workflow-runs/run-1",
        headers: auth(OPERATOR),
        payload: { status: "abandoned" },
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.workflowRun.update).toHaveBeenCalledOnce();
      await app.close();
    });
  });
});
