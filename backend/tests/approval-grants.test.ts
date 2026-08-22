import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  APPROVAL_GRANT_DURATION_TTL_MS,
  APPROVAL_GRANT_HORIZON_MS,
} from "@muon/protocol";

// ── ADR-0056: graded durable approval grants ─────────────────────────────────
//
// End-to-end against a REAL temp-SQLite brain (graph mocked, no network). The
// invariants under test are the ADR's decisions verbatim:
//   • three grades, `once` first: an approve with `once` (or with nothing)
//     mints no durable authority at all; `session` mints the P0.4 receipt;
//     `always` mints the chat-scoped grant;
//   • the ONE thing the grade buys is DURABILITY ACROSS RUNS — a second
//     dispatch in the same chat redeems, which a receipt structurally cannot;
//   • ANY drift is a miss and a miss is 200/{redeemed:false}: content hash,
//     visible target, workspace, chat, policy posture, expiry, revocation, a
//     hand-edited expiry beyond the horizon, a delegate context;
//   • the always-human kinds are never auto-resolved even with a matching
//     grant, and merge refuses the durable grades outright;
//   • every auto-resolution writes an `approval.auto` ledger row NAMING the
//     grant — a grant that resolved something invisibly is the failure mode;
//   • listing and revoking are operator-only.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-grants-1";
const AGENT = "agent-token-grants-1";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

const WORKSPACE = process.cwd();
const OTHER_WORKSPACE = path.join(process.cwd(), "somewhere-else");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const HARNESS_KEY = "grants-test-harness";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-grants-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();

  await prisma.harness.create({
    data: {
      key: HARNESS_KEY,
      name: "Grants test harness",
      config: {
        checks: [{ name: "unit", command: "npm", args: ["test"] }],
      },
    },
  });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

let laneCounter = 0;

/** A task + worker job + corroborating lane session — the mint's happy scaffold. */
async function makeScaffold(options?: {
  capabilityMode?: string | null;
  workspacePath?: string | null;
  taskId?: string;
}) {
  const task = options?.taskId
    ? await prisma.task.findUniqueOrThrow({ where: { id: options.taskId } })
    : await prisma.task.create({
        data: { title: "grant scaffold", description: "grant scaffold task" },
      });
  const job = await prisma.dispatchJob.create({
    data: {
      vendor: "claude-code",
      taskId: task.id,
      brief: "grant scaffold job",
      workspacePath:
        options?.workspacePath === undefined ? WORKSPACE : options.workspacePath,
      capabilityMode:
        options?.capabilityMode === undefined ? "worker" : options.capabilityMode,
      harnessKey: HARNESS_KEY,
    },
  });
  laneCounter += 1;
  const lane = await prisma.lane.create({
    data: {
      key: `grants-lane-${laneCounter}`,
      name: `Grants lane ${laneCounter}`,
      provider: "claude-code",
      role: "worker",
    },
  });
  const session = await prisma.laneSession.create({
    data: { laneId: lane.id, taskId: task.id, jobId: job.id },
  });
  return { task, job, session };
}

function commandEvidence(input: {
  action: string;
  sessionId?: string;
  command?: string;
  path?: string;
  payloadDigest?: string;
}) {
  const details: Record<string, string> = {};
  if (input.command) details.command = input.command;
  if (input.path) details.path = input.path;
  if (input.sessionId) details.sessionId = input.sessionId;
  return {
    action: input.action,
    scope: input.command
      ? `Command: ${input.command}`
      : input.path
        ? `File: ${input.path}`
        : "Tool request",
    riskLevel: "medium",
    impactIfApproved: "Runs this exact vendor tool request.",
    payloadDigest: input.payloadDigest ?? DIGEST_A,
    details,
  };
}

async function fileCommandApproval(input: {
  taskId: string;
  jobId?: string;
  kind?: string;
  evidence: unknown;
}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers: auth(AGENT),
    payload: {
      taskId: input.taskId,
      requestedBy: "claude-code",
      kind: input.kind ?? "command",
      reason: "session tool request awaiting decision",
      evidence: input.evidence,
      jobId: input.jobId,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().approval as { id: string };
}

async function approveWith(
  approvalId: string,
  body: Record<string, unknown>
) {
  return app.inject({
    method: "PATCH",
    url: `/api/approvals/${approvalId}`,
    headers: auth(OPERATOR),
    payload: { status: "approved", ...body },
  });
}

async function redeem(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/grants/redeem",
    headers: auth(AGENT),
    payload: body,
  });
}

/** Full happy mint: Bash byte-equal to the harness check ⇒ test-class grant. */
async function mintAlwaysGrant(options?: { taskId?: string }) {
  const scaffold = await makeScaffold({ taskId: options?.taskId });
  const approval = await fileCommandApproval({
    taskId: scaffold.task.id,
    jobId: scaffold.job.id,
    evidence: commandEvidence({
      action: "Bash",
      command: "npm test",
      sessionId: scaffold.session.id,
    }),
  });
  const response = await approveWith(approval.id, {
    grant: { duration: "always" },
  });
  expect(response.statusCode).toBe(200);
  const grant = response.json().grant as {
    id: string;
    actionClass: string;
    expiresAt: string;
    policyFingerprint: string;
    originJobId: string;
  };
  expect(grant).toBeTruthy();
  return { ...scaffold, approval, grant };
}

function redemptionBody(scaffold: {
  task: { id: string };
  job: { id: string };
  session: { id: string };
}) {
  return {
    taskId: scaffold.task.id,
    jobId: scaffold.job.id,
    sessionId: scaffold.session.id,
    workspacePath: WORKSPACE,
    toolName: "Bash",
    payloadDigest: DIGEST_A,
    resolvedTarget: "npm test",
  };
}

describe("three grades, once first", () => {
  it("approving with no durable field mints nothing at all", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {});
    expect(response.statusCode).toBe(200);
    expect(response.json().grant).toBeUndefined();
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
    expect(
      await prisma.approvalReceipt.findMany({
        where: { approvalId: approval.id },
      })
    ).toHaveLength(0);
  });

  it("`once` is a real answer that mints nothing — the decision still lands", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "once" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().grant).toBeUndefined();
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
    expect(
      await prisma.approvalReceipt.findMany({
        where: { approvalId: approval.id },
      })
    ).toHaveLength(0);
    const decided = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(decided?.status).toBe("approved");
  });

  it("`session` mints the P0.4 RECEIPT at the graded TTL, never a grant", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "session" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().grant).toBeUndefined();
    const receipt = await prisma.approvalReceipt.findUnique({
      where: { approvalId: approval.id },
    });
    expect(receipt).toBeTruthy();
    expect(receipt!.jobId).toBe(scaffold.job.id);
    const ttl = new Date(receipt!.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(
      APPROVAL_GRANT_DURATION_TTL_MS.session - 60_000
    );
    expect(ttl).toBeLessThanOrEqual(APPROVAL_GRANT_DURATION_TTL_MS.session);
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
  });

  it("`always` mints a chat-scoped grant at the graded TTL, bound to the posture", async () => {
    const minted = await mintAlwaysGrant();
    const row = await prisma.approvalGrant.findUnique({
      where: { approvalId: minted.approval.id },
    });
    expect(row).toMatchObject({
      taskId: minted.task.id,
      workspacePath: WORKSPACE,
      actionClass: "test",
      toolName: "Bash",
      payloadDigest: DIGEST_A,
      resolvedTarget: "npm test",
      originJobId: minted.job.id,
      useCount: 0,
      revokedAt: null,
    });
    expect(row!.policyFingerprint).toMatch(/^[a-f0-9]{32}$/);
    const ttl = new Date(row!.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(APPROVAL_GRANT_DURATION_TTL_MS.always - 60_000);
    expect(ttl).toBeLessThanOrEqual(APPROVAL_GRANT_DURATION_TTL_MS.always);
    expect(ttl).toBeLessThan(APPROVAL_GRANT_HORIZON_MS);
  });

  it("refuses a decision carrying two durable authorities", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
      receipt: { ttlMs: 300_000 },
    });
    expect(response.statusCode).toBe(400);
    const undecided = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(undecided?.status).toBe("pending");
  });
});

describe("the grade buys durability across runs, and nothing else", () => {
  it("a LATER dispatch in the same chat redeems the grant", async () => {
    const minted = await mintAlwaysGrant();
    // A brand-new job + session in the SAME chat: exactly the boundary a
    // receipt cannot cross, and the entire reason this grade exists.
    const next = await makeScaffold({ taskId: minted.task.id });
    const response = await redeem(redemptionBody(next));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.redeemed).toBe(true);
    expect(body.grant.id).toBe(minted.grant.id);
    expect(body.grant.approvalId).toBe(minted.approval.id);
    expect(body.grant.useCount).toBe(1);
  });

  it("is MULTI-use inside its window and stamps every use", async () => {
    const minted = await mintAlwaysGrant();
    const first = await redeem(redemptionBody(minted));
    const second = await redeem(redemptionBody(minted));
    expect(first.json().redeemed).toBe(true);
    expect(second.json().redeemed).toBe(true);
    const row = await prisma.approvalGrant.findUnique({
      where: { id: minted.grant.id },
    });
    expect(row?.useCount).toBe(2);
    expect(row?.lastUsedAt).toBeTruthy();
  });
});

describe("any drift is a miss, and a miss is 200/{redeemed:false}", () => {
  it("a different CONTENT HASH does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    const response = await redeem({
      ...redemptionBody(minted),
      payloadDigest: DIGEST_B,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("a different VISIBLE TARGET does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    const response = await redeem({
      ...redemptionBody(minted),
      resolvedTarget: "npm run lint",
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("another WORKSPACE does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    const response = await redeem({
      ...redemptionBody(minted),
      workspacePath: OTHER_WORKSPACE,
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("another CHAT does not resolve, even with identical content", async () => {
    const minted = await mintAlwaysGrant();
    const elsewhere = await makeScaffold();
    const response = await redeem(redemptionBody(elsewhere));
    expect(response.json()).toEqual({ redeemed: false });
    const untouched = await prisma.approvalGrant.findUnique({
      where: { id: minted.grant.id },
    });
    expect(untouched?.useCount).toBe(0);
  });

  it("an EXPIRED grant does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    await prisma.approvalGrant.update({
      where: { id: minted.grant.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("an expiry beyond the horizon no issuer could mint does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    await prisma.approvalGrant.update({
      where: { id: minted.grant.id },
      data: {
        expiresAt: new Date(Date.now() + APPROVAL_GRANT_HORIZON_MS + 60_000),
      },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("REVOCATION takes effect immediately — the very next call misses", async () => {
    const minted = await mintAlwaysGrant();
    expect((await redeem(redemptionBody(minted))).json().redeemed).toBe(true);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/grants/${minted.grant.id}/revoke`,
      headers: auth(OPERATOR),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().grant.revokedAt).toBeTruthy();

    const after = await redeem(redemptionBody(minted));
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ redeemed: false });
  });

  it("a POLICY CHANGE invalidates the grant", async () => {
    const minted = await mintAlwaysGrant();
    expect((await redeem(redemptionBody(minted))).json().redeemed).toBe(true);

    const stored = await app.inject({
      method: "PUT",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: {
        workspacePath: WORKSPACE,
        taskId: minted.task.id,
        profile: {
          version: 1,
          label: "tightened",
          postures: {
            read: "allow",
            test: "gate",
            edit: "gate",
            network: "gate",
            merge: "gate",
            ship: "gate",
          },
          editInRadius: "allow",
          taskRadius: [],
        },
      },
    });
    expect(stored.statusCode).toBe(200);

    const after = await redeem(redemptionBody(minted));
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ redeemed: false });

    // Removing the profile restores the posture the grant was minted under, so
    // the fingerprint is a real binding rather than a one-way kill switch.
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/policy/profile",
      headers: auth(OPERATOR),
      payload: { workspacePath: WORKSPACE, taskId: minted.task.id },
    });
    expect(removed.statusCode).toBe(200);
    expect((await redeem(redemptionBody(minted))).json().redeemed).toBe(true);
  });

  it("a session that does not corroborate the run does not resolve", async () => {
    const minted = await mintAlwaysGrant();
    const other = await makeScaffold();
    const response = await redeem({
      ...redemptionBody(minted),
      sessionId: other.session.id,
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("a DELEGATE context never redeems", async () => {
    const minted = await mintAlwaysGrant();
    await prisma.dispatchJob.update({
      where: { id: minted.job.id },
      data: { capabilityMode: "delegate" },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.json()).toEqual({ redeemed: false });
  });
});

describe("what a grant may never cover", () => {
  it("a MERGE approval refuses the durable grades outright", async () => {
    const scaffold = await makeScaffold();
    const approval = await prisma.approvalRequest.create({
      data: {
        taskId: scaffold.task.id,
        requestedBy: "claude-code",
        kind: "merge",
        reason: "land the branch",
        status: "pending",
      },
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
    });
    expect(response.statusCode).toBe(400);
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
    const undecided = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(undecided?.status).toBe("pending");
  });

  it("a DANGEROUS_ACTION approval soft-skips the mint and still decides", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      kind: "dangerous_action",
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receiptSkipped).toBe(true);
    expect(response.json().grant).toBeUndefined();
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
    const decided = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(decided?.status).toBe("approved");
  });

  it("a NETWORK tool can never be remembered", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "WebFetch",
        path: "https://example.com",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receiptSkipped).toBe(true);
    expect(response.json().receiptSkippedReason).toContain("Network");
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
  });

  it("an unclassifiable Bash can never be remembered", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "git push origin main",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receiptSkipped).toBe(true);
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
  });

  it("a DELEGATE job never mints", async () => {
    const scaffold = await makeScaffold({ capabilityMode: "delegate" });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWith(approval.id, {
      grant: { duration: "always" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receiptSkipped).toBe(true);
    expect(
      await prisma.approvalGrant.findMany({ where: { approvalId: approval.id } })
    ).toHaveLength(0);
  });

  it("a hand-forged network-class row still cannot redeem", async () => {
    const minted = await mintAlwaysGrant();
    await prisma.approvalGrant.update({
      where: { id: minted.grant.id },
      data: { actionClass: "network" },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.json()).toEqual({ redeemed: false });
  });
});

describe("nothing resolves invisibly", () => {
  it("every auto-resolution writes an approval.auto row NAMING the grant", async () => {
    const minted = await mintAlwaysGrant();
    const response = await redeem(redemptionBody(minted));
    expect(response.json().redeemed).toBe(true);

    const events = await prisma.event.findMany({
      where: { taskId: minted.task.id, kind: "approval.auto" },
    });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      source: "grant",
      grantId: minted.grant.id,
      approvalId: minted.approval.id,
      duration: "always",
      actionClass: "test",
      toolName: "Bash",
      payloadDigest: DIGEST_A,
      useCount: 1,
    });
    // Dual-keyed: the agent spent it, the human who granted it is accountable.
    expect(events[0]!.principalKind).toBe("agent");
    expect(events[0]!.accountablePrincipalId).toBeTruthy();
    expect(events[0]!.requestId).toBe(minted.approval.id);
  });

  it("a MISS writes no audit row (nothing happened to record)", async () => {
    const minted = await mintAlwaysGrant();
    await redeem({ ...redemptionBody(minted), payloadDigest: DIGEST_B });
    const events = await prisma.event.findMany({
      where: { taskId: minted.task.id, kind: "approval.auto" },
    });
    expect(events).toHaveLength(0);
  });

  it("lists live grants for the operator and refuses the agent tier", async () => {
    const minted = await mintAlwaysGrant();
    const operatorList = await app.inject({
      method: "GET",
      url: `/api/grants?activeOnly=true&taskId=${minted.task.id}`,
      headers: auth(OPERATOR),
    });
    expect(operatorList.statusCode).toBe(200);
    const ids = (operatorList.json().grants as { id: string }[]).map(
      (grant) => grant.id
    );
    expect(ids).toContain(minted.grant.id);

    const agentList = await app.inject({
      method: "GET",
      url: "/api/grants",
      headers: auth(AGENT),
    });
    expect(agentList.statusCode).toBe(403);
  });

  it("an expired grant is not 'live' on the operator's list either", async () => {
    const minted = await mintAlwaysGrant();
    await prisma.approvalGrant.update({
      where: { id: minted.grant.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/grants?activeOnly=true&taskId=${minted.task.id}`,
      headers: auth(OPERATOR),
    });
    const ids = (list.json().grants as { id: string }[]).map(
      (grant) => grant.id
    );
    expect(ids).not.toContain(minted.grant.id);
  });

  it("revocation is operator-only and idempotent", async () => {
    const minted = await mintAlwaysGrant();
    const agentRevoke = await app.inject({
      method: "POST",
      url: `/api/grants/${minted.grant.id}/revoke`,
      headers: auth(AGENT),
    });
    expect(agentRevoke.statusCode).toBe(403);

    const first = await app.inject({
      method: "POST",
      url: `/api/grants/${minted.grant.id}/revoke`,
      headers: auth(OPERATOR),
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/grants/${minted.grant.id}/revoke`,
      headers: auth(OPERATOR),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().grant.revokedAt).toBe(first.json().grant.revokedAt);
  });

  it("revoking an unknown grant is a 404, not a silent success", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/grants/grant-that-never-existed/revoke",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(404);
  });
});
