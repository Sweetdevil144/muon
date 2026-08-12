import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── P0.4 slice 2: content-bound, expiring approval receipts ──────────────────
//
// End-to-end against a REAL temp-SQLite brain (graph mocked, no network).
// The invariants under test are the acceptance clauses verbatim:
//   • minting is an EXPLICIT operator opt-in on one approval decision — an
//     approve without the `receipt` field mints nothing, ever;
//   • a receipt is content-bound: exact tool + payload digest + workspace +
//     run (jobId) + manifest fingerprint, and it expires;
//   • network/merge/ship can never be remembered — but the receipt is a
//     best-effort add-on, so an ineligible "remember" SOFT-SKIPS (200 + the
//     decision lands + `receiptSkipped` reason), it never 400s away the
//     operator's approve/reject (BUG 1); redeem still filters;
//   • ANY drift — digest, workspace, tool, jobId, manifest, expiry, revocation
//     — is a miss, and a miss is 200/{redeemed:false}, never an error: the
//     caller's contract is "miss ⇒ file the gate exactly as today".

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-receipts-1";
const AGENT = "agent-token-receipts-1";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

const WORKSPACE = process.cwd();
const OTHER_WORKSPACE = path.join(process.cwd(), "somewhere-else");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const HARNESS_KEY = "receipts-test-harness";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-receipts-"));
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
      name: "Receipts test harness",
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

/** A task + worker job + corroborating lane session, the mint's happy scaffold. */
async function makeScaffold(options?: {
  capabilityMode?: string | null;
  workspacePath?: string | null;
  taskWorkspacePath?: string | null;
  harnessKey?: string | null;
  delegationManifest?: unknown;
  checks?: unknown;
}) {
  const task = await prisma.task.create({
    data: {
      title: "receipt scaffold",
      description: "receipt scaffold task",
      workspacePath: options?.taskWorkspacePath ?? null,
    },
  });
  const job = await prisma.dispatchJob.create({
    data: {
      vendor: "claude-code",
      taskId: task.id,
      brief: "receipt scaffold job",
      workspacePath:
        options?.workspacePath === undefined ? WORKSPACE : options.workspacePath,
      capabilityMode:
        options?.capabilityMode === undefined ? "worker" : options.capabilityMode,
      harnessKey: options?.harnessKey === undefined ? HARNESS_KEY : options.harnessKey,
      delegationManifest: (options?.delegationManifest as never) ?? undefined,
      checks: (options?.checks as never) ?? undefined,
    },
  });
  laneCounter += 1;
  const lane = await prisma.lane.create({
    data: {
      key: `receipts-lane-${laneCounter}`,
      name: `Receipts lane ${laneCounter}`,
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
  payloadDigest?: string | null;
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
    ...(input.payloadDigest === null
      ? {}
      : { payloadDigest: input.payloadDigest ?? DIGEST_A }),
    details,
  };
}

async function fileCommandApproval(input: {
  taskId: string;
  jobId?: string;
  evidence: unknown;
}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers: auth(AGENT),
    payload: {
      taskId: input.taskId,
      requestedBy: "claude-code",
      kind: "command",
      reason: "session tool request awaiting decision",
      evidence: input.evidence,
      jobId: input.jobId,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().approval as { id: string };
}

async function approveWithReceipt(approvalId: string, ttlMs = 300_000) {
  return app.inject({
    method: "PATCH",
    url: `/api/approvals/${approvalId}`,
    headers: auth(OPERATOR),
    payload: { status: "approved", receipt: { ttlMs } },
  });
}

async function redeem(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/receipts/redeem",
    headers: auth(AGENT),
    payload: body,
  });
}

/** Full happy mint: Bash byte-equal to the harness check ⇒ test-class receipt. */
async function mintTestClassReceipt() {
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
  const response = await approveWithReceipt(approval.id);
  expect(response.statusCode).toBe(200);
  const receipt = response.json().receipt as {
    id: string;
    actionClass: string;
    expiresAt: string;
  };
  expect(receipt).toBeTruthy();
  return { ...scaffold, approval, receipt };
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
    // SEC-1: the seam sends the operator-visible target (here the test command
    // line) alongside the digest; it must equal the minted target to redeem.
    resolvedTarget: "npm test",
  };
}

describe("mint: explicit operator opt-in on one approval decision", () => {
  it("approving WITHOUT the receipt field mints nothing (never by default)", async () => {
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
    const response = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${approval.id}`,
      headers: auth(OPERATOR),
      payload: { status: "approved" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt).toBeUndefined();
    const rows = await prisma.approvalReceipt.findMany({
      where: { approvalId: approval.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("mints a test-class receipt for Bash byte-equal to a harness check", async () => {
    const minted = await mintTestClassReceipt();
    expect(minted.receipt.actionClass).toBe("test");
    const row = await prisma.approvalReceipt.findUnique({
      where: { approvalId: minted.approval.id },
    });
    expect(row).toMatchObject({
      taskId: minted.task.id,
      jobId: minted.job.id,
      workspacePath: WORKSPACE,
      actionClass: "test",
      toolName: "Bash",
      payloadDigest: DIGEST_A,
      // SEC-1: the operator-visible command line the human saw is persisted as
      // the enforced binding.
      resolvedTarget: "npm test",
      manifestFingerprint: null,
      useCount: 0,
      revokedAt: null,
    });
    // Expiry is decision time + ttl (5 minutes here), give-or-take the test.
    const expiresIn = new Date(row!.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(200_000);
    expect(expiresIn).toBeLessThanOrEqual(300_000);
    // The decision itself landed.
    const decided = await prisma.approvalRequest.findUnique({
      where: { id: minted.approval.id },
    });
    expect(decided?.status).toBe("approved");
  });

  it("mints an edit-class receipt bound to the job's manifest fingerprint", async () => {
    const scaffold = await makeScaffold({
      delegationManifest: { allowedTools: ["Read", "Edit"] },
    });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Edit",
        path: "src/parser.ts",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWithReceipt(approval.id);
    expect(response.statusCode).toBe(200);
    const receipt = response.json().receipt;
    expect(receipt.actionClass).toBe("edit");
    expect(receipt.manifestFingerprint).toMatch(/^[a-f0-9]{32}$/);
  });

  it("mints a test-class receipt for a job-level check too", async () => {
    const scaffold = await makeScaffold({
      harnessKey: null,
      checks: [{ name: "lint", command: "npm", args: ["run", "lint"] }],
    });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm run lint",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWithReceipt(approval.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.actionClass).toBe("test");
  });

  it("falls back to the task's workspacePath when the job has none", async () => {
    const scaffold = await makeScaffold({
      workspacePath: null,
      taskWorkspacePath: WORKSPACE,
    });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Read",
        path: "src/parser.ts",
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWithReceipt(approval.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.workspacePath).toBe(WORKSPACE);
  });

  // BUG 1: a receipt is a best-effort ADD-ON. When the operator opts to
  // "remember" an action that is not receipt-eligible, the approve/reject
  // decision MUST still land — the response is 200 with a soft `receiptSkipped`
  // signal + honest reason, NOT a 400 that drops the human's decision.
  async function expectReceiptSkipped(approvalId: string): Promise<string> {
    const response = await approveWithReceipt(approvalId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Nothing minted, but the decision landed.
    expect(body.receipt).toBeUndefined();
    expect(body.receiptSkipped).toBe(true);
    expect(typeof body.receiptSkippedReason).toBe("string");
    expect(body.approval.status).toBe("approved");
    const approval = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });
    expect(approval?.status).toBe("approved");
    const rows = await prisma.approvalReceipt.findMany({
      where: { approvalId },
    });
    expect(rows).toHaveLength(0);
    return body.receiptSkippedReason ?? "";
  }

  it("soft-skips (decision lands) for a non-command approval kind", async () => {
    const scaffold = await makeScaffold();
    const response = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: auth(AGENT),
      payload: {
        taskId: scaffold.task.id,
        requestedBy: "claude-code",
        kind: "merge",
        reason: "merge the reviewed change",
        jobId: scaffold.job.id,
      },
    });
    expect(response.statusCode).toBe(201);
    await expectReceiptSkipped(response.json().approval.id);
  });

  it("soft-skips when the evidence has no payload digest (no digest, no receipt)", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
        payloadDigest: null,
      }),
    });
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips when the approval carries no jobId", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips when the evidence sessionId does not corroborate the jobId", async () => {
    const scaffold = await makeScaffold();
    const other = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      // A session that belongs to ANOTHER job: the filer's jobId is not trusted.
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: other.session.id,
      }),
    });
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips when the evidence has no sessionId at all", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({ action: "Bash", command: "npm test" }),
    });
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips for a delegate-mode job (receipts never mint in a delegate context)", async () => {
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
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips when neither the job nor the task has a workspacePath", async () => {
    const scaffold = await makeScaffold({
      workspacePath: null,
      taskWorkspacePath: null,
    });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Read",
        path: "src/parser.ts",
        sessionId: scaffold.session.id,
      }),
    });
    await expectReceiptSkipped(approval.id);
  });

  it("soft-skips a network-class action, worded as always-ask (network never remembered)", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "WebFetch",
        sessionId: scaffold.session.id,
      }),
    });
    const reason = await expectReceiptSkipped(approval.id);
    expect(reason.toLowerCase()).toMatch(/always ask|network/);
  });

  it("soft-skips unclassifiable Bash (git push) with the honest 'only reads/edits/checks' reason", async () => {
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
    const reason = await expectReceiptSkipped(approval.id);
    // The honest wording for arbitrary Bash — NOT the misleading
    // "network, merge, and ship" text, which applies only to those classes.
    expect(reason.toLowerCase()).toMatch(/reads.*edits.*checks/);
    expect(reason.toLowerCase()).not.toContain("network, merge, and ship");
  });

  it("soft-skips Bash that is not byte-equal to a configured check", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        // Not the harness check "npm test": subcommand differs.
        command: "npm test2",
        sessionId: scaffold.session.id,
      }),
    });
    const reason = await expectReceiptSkipped(approval.id);
    expect(reason.toLowerCase()).toMatch(/reads.*edits.*checks/);
    expect(reason.toLowerCase()).not.toContain("network, merge, and ship");
  });

  it("still 400s (no decision) for ttlMs outside [60s, 60m] — a malformed request, not a skip", async () => {
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
    for (const ttlMs of [1_000, 3_600_001]) {
      const response = await approveWithReceipt(approval.id, ttlMs);
      expect(response.statusCode).toBe(400);
    }
    // A malformed body never reaches the handler, so the decision never landed.
    const row = await prisma.approvalRequest.findUnique({
      where: { id: approval.id },
    });
    expect(row?.status).toBe("pending");
    const rows = await prisma.approvalReceipt.findMany({
      where: { approvalId: approval.id },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("redeem: exact-match burn, every drift is a miss, a miss is 200/false", () => {
  it("redeems the exact action, stamps use, and stays multi-use within TTL", async () => {
    const minted = await mintTestClassReceipt();
    const first = await redeem(redemptionBody(minted));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      redeemed: true,
      receipt: { id: minted.receipt.id, useCount: 1 },
    });

    // Multi-use within TTL is the fatigue fix: the SECOND identical redemption
    // also lands, and every use is stamped.
    const second = await redeem(redemptionBody(minted));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      redeemed: true,
      receipt: { useCount: 2 },
    });
    const row = await prisma.approvalReceipt.findUnique({
      where: { id: minted.receipt.id },
    });
    expect(row?.useCount).toBe(2);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("cannot authorize changed content: wrong digest is a miss", async () => {
    const minted = await mintTestClassReceipt();
    const response = await redeem({
      ...redemptionBody(minted),
      payloadDigest: DIGEST_B,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("cannot authorize another workspace", async () => {
    const minted = await mintTestClassReceipt();
    const response = await redeem({
      ...redemptionBody(minted),
      workspacePath: OTHER_WORKSPACE,
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("cannot authorize a different tool", async () => {
    const minted = await mintTestClassReceipt();
    const response = await redeem({
      ...redemptionBody(minted),
      toolName: "Edit",
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("cannot authorize another run: a different jobId (descendant/later run) is a miss", async () => {
    const minted = await mintTestClassReceipt();
    const child = await makeScaffold();
    const response = await redeem({
      ...redemptionBody(minted),
      jobId: child.job.id,
      sessionId: child.session.id,
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("refuses redemption from a delegate-mode job outright", async () => {
    const minted = await mintTestClassReceipt();
    await prisma.dispatchJob.update({
      where: { id: minted.job.id },
      data: { capabilityMode: "delegate" },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("misses when the sessionId does not corroborate the jobId", async () => {
    const minted = await mintTestClassReceipt();
    const other = await makeScaffold();
    const response = await redeem({
      ...redemptionBody(minted),
      sessionId: other.session.id,
    });
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("cannot authorize a later run after expiry", async () => {
    const minted = await mintTestClassReceipt();
    await prisma.approvalReceipt.update({
      where: { id: minted.receipt.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const response = await redeem(redemptionBody(minted));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("misses after one-way operator revocation; revocation is operator-only", async () => {
    const minted = await mintTestClassReceipt();

    const agentRevoke = await app.inject({
      method: "POST",
      url: `/api/receipts/${minted.receipt.id}/revoke`,
      headers: auth(AGENT),
    });
    expect(agentRevoke.statusCode).toBe(403);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/receipts/${minted.receipt.id}/revoke`,
      headers: auth(OPERATOR),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().receipt.revokedAt).toBeTruthy();

    const response = await redeem(redemptionBody(minted));
    expect(response.json()).toEqual({ redeemed: false });
  });

  it("misses when the job's delegation manifest drifted after mint", async () => {
    const scaffold = await makeScaffold({
      delegationManifest: { allowedTools: ["Read"] },
    });
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Bash",
        command: "npm test",
        sessionId: scaffold.session.id,
      }),
    });
    const mintResponse = await approveWithReceipt(approval.id);
    expect(mintResponse.statusCode).toBe(200);

    // Same body redeems while the manifest is unchanged…
    const hit = await redeem(redemptionBody(scaffold));
    expect(hit.json().redeemed).toBe(true);

    // …but a widened manifest re-gates everything.
    await prisma.dispatchJob.update({
      where: { id: scaffold.job.id },
      data: { delegationManifest: { allowedTools: ["Read", "Bash"] } },
    });
    const drifted = await redeem(redemptionBody(scaffold));
    expect(drifted.json()).toEqual({ redeemed: false });
  });

  it("misses for an unknown job or session without erroring", async () => {
    const minted = await mintTestClassReceipt();
    const badSession = await redeem({
      ...redemptionBody(minted),
      sessionId: "no-such-session",
    });
    expect(badSession.statusCode).toBe(200);
    expect(badSession.json()).toEqual({ redeemed: false });
  });
});

describe("SEC-1: receipt bait-and-switch — the enforced binding is the operator-visible target", () => {
  // The exploit: a worker files an approval whose VISIBLE evidence says
  // "Edit README.md" but whose agent-authored payloadDigest was precomputed
  // over a DIFFERENT, hidden input (Edit config/ci.yml). The operator sees the
  // README card, opts into the receipt, and — before this fix — the agent then
  // ran Edit{ci.yml}, whose digest matched the stored digest, and was silently
  // auto-allowed. The invariant: an approval whose visible evidence disagrees
  // with its payloadDigest can NEVER mint a redeemable receipt that later
  // allows the hidden action.
  const VISIBLE_PATH = "README.md";
  const HIDDEN_PATH = "config/ci.yml";
  // The digest the agent precomputed over the HIDDEN input and smuggled into the
  // approval it displayed as an edit of README.md.
  const HIDDEN_DIGEST = "c".repeat(64);
  // The digest the honest visible action (Edit README.md) would actually present.
  const VISIBLE_DIGEST = "d".repeat(64);

  async function mintBaitReceipt() {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      // Visible: "Edit README.md". Hidden: a digest over config/ci.yml.
      evidence: commandEvidence({
        action: "Edit",
        path: VISIBLE_PATH,
        payloadDigest: HIDDEN_DIGEST,
        sessionId: scaffold.session.id,
      }),
    });
    const response = await approveWithReceipt(approval.id);
    expect(response.statusCode).toBe(200);
    const receipt = response.json().receipt as { id: string };
    expect(receipt).toBeTruthy();
    return { scaffold, approval, receipt };
  }

  it("the hidden action can never redeem: its digest matches but its target does not", async () => {
    const { scaffold } = await mintBaitReceipt();
    // The seam derives BOTH the target and the digest from the ONE real input.
    // The hidden run is Edit{config/ci.yml}: digest matches the stored bait
    // digest, but its visible target is config/ci.yml, not README.md.
    const hidden = await redeem({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      sessionId: scaffold.session.id,
      workspacePath: WORKSPACE,
      toolName: "Edit",
      payloadDigest: HIDDEN_DIGEST,
      resolvedTarget: HIDDEN_PATH,
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ redeemed: false });
  });

  it("the visible action can never redeem either: its target matches but its digest does not", async () => {
    const { scaffold } = await mintBaitReceipt();
    // The honest run of what the operator SAW (Edit README.md) presents the
    // README target and README's real digest — which is not the smuggled bait
    // digest the receipt was minted with. The receipt is wholly inert.
    const visible = await redeem({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      sessionId: scaffold.session.id,
      workspacePath: WORKSPACE,
      toolName: "Edit",
      payloadDigest: VISIBLE_DIGEST,
      resolvedTarget: VISIBLE_PATH,
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual({ redeemed: false });
  });

  it("an HONEST edit approval still redeems when target AND digest agree", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Edit",
        path: VISIBLE_PATH,
        payloadDigest: VISIBLE_DIGEST,
        sessionId: scaffold.session.id,
      }),
    });
    const mint = await approveWithReceipt(approval.id);
    expect(mint.statusCode).toBe(200);
    const hit = await redeem({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      sessionId: scaffold.session.id,
      workspacePath: WORKSPACE,
      toolName: "Edit",
      payloadDigest: VISIBLE_DIGEST,
      resolvedTarget: VISIBLE_PATH,
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().redeemed).toBe(true);
  });

  it("an edit receipt is a miss when the seam omits the target (fail-closed)", async () => {
    const scaffold = await makeScaffold();
    const approval = await fileCommandApproval({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      evidence: commandEvidence({
        action: "Edit",
        path: VISIBLE_PATH,
        payloadDigest: VISIBLE_DIGEST,
        sessionId: scaffold.session.id,
      }),
    });
    expect((await approveWithReceipt(approval.id)).statusCode).toBe(200);
    // A redeem that names no target cannot claim a target-bound receipt.
    const noTarget = await redeem({
      taskId: scaffold.task.id,
      jobId: scaffold.job.id,
      sessionId: scaffold.session.id,
      workspacePath: WORKSPACE,
      toolName: "Edit",
      payloadDigest: VISIBLE_DIGEST,
    });
    expect(noTarget.json()).toEqual({ redeemed: false });
  });
});

describe("list: powers CLI --receipts and inbox annotations", () => {
  it("C2: GET /receipts is operator-only — agent tier is refused", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: auth(AGENT),
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists receipts, and activeOnly hides revoked and expired rows", async () => {
    const live = await mintTestClassReceipt();
    const expired = await mintTestClassReceipt();
    await prisma.approvalReceipt.update({
      where: { id: expired.receipt.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const revoked = await mintTestClassReceipt();
    await app.inject({
      method: "POST",
      url: `/api/receipts/${revoked.receipt.id}/revoke`,
      headers: auth(OPERATOR),
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/receipts",
      headers: auth(OPERATOR),
    });
    expect(all.statusCode).toBe(200);
    const allIds = all.json().receipts.map((row: { id: string }) => row.id);
    expect(allIds).toEqual(
      expect.arrayContaining([
        live.receipt.id,
        expired.receipt.id,
        revoked.receipt.id,
      ])
    );

    const active = await app.inject({
      method: "GET",
      url: `/api/receipts?activeOnly=true&workspacePath=${encodeURIComponent(WORKSPACE)}`,
      headers: auth(OPERATOR),
    });
    const activeIds = active
      .json()
      .receipts.map((row: { id: string }) => row.id);
    expect(activeIds).toContain(live.receipt.id);
    expect(activeIds).not.toContain(expired.receipt.id);
    expect(activeIds).not.toContain(revoked.receipt.id);
  });
});
