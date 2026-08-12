import { mkdtempSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PRE_LAUNCH_INTERRUPT_RESULTS,
  budgetExhaustedResult,
} from "@muon/protocol";
import {
  buildRedispatchInput,
  classifyGate,
  computeLineageDigest,
  planResume,
  type DispatchJobRecord,
} from "@muon/client";

// ── P0.1 checkpoint+resume: the kill-at-each-phase ledger matrix ──────────────
//
// REAL SQLite + the REAL fastify app (no prisma mock): a "kill" here is
// exactly what a kill is to the ledger — the process stopped; the rows
// persist. Each case drives real routes via app.inject, then proves the
// durable truths a resume needs: the same lineage digest, the exact pending
// gate with its binding, no touched original rows, and the fail-closed gate
// semantics (consumed never revalidates; approved-undelivered never
// redeemable). The graph mirror is mocked (fire-and-forget side channel,
// irrelevant to the checkpoint) — the DATABASE is real.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));

const REC_025_FIXED_RESULT =
  "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.";

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

let prisma: typeof import("../src/lib/db.js")["prisma"];
let app: Awaited<ReturnType<typeof import("../src/app.js")["buildApp"]>>;
let dir: string;
let laneId: string;
// The embedded boot path mints a local operator token during ensureSchema();
// the matrix drives the API as the operator (the human surface).
let operatorToken: string | undefined;

function leaseToken(): string {
  return randomBytes(32).toString("hex");
}

async function api(
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown
) {
  const response = await app.inject({
    method,
    url,
    ...(operatorToken
      ? { headers: { authorization: `Bearer ${operatorToken}` } }
      : {}),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return {
    status: response.statusCode,
    json: response.body ? JSON.parse(response.body) : undefined,
  };
}

async function createTask(title: string): Promise<string> {
  const res = await api("POST", "/api/tasks", {
    title,
    description: `${title} (checkpoint matrix fixture)`,
  });
  expect(res.status).toBe(201);
  return res.json.task.id as string;
}

/** Mint an operator lease for a host and make it live (fresh lastSeenAt). */
async function mintLease(host: string): Promise<string> {
  const token = leaseToken();
  const res = await api("POST", "/api/runner/lease", { host, leaseToken: token });
  expect(res.status).toBe(200);
  return token;
}

async function seedIdleAgent(vendor: string, ordinal: number): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      vendor,
      name: `matrix-${vendor}-${ordinal}-${randomBytes(4).toString("hex")}`,
      ordinal,
      status: "idle",
    },
  });
  return agent.id;
}

async function getJob(jobId: string): Promise<DispatchJobRecord> {
  const res = await api("GET", `/api/dispatch/${jobId}`);
  expect(res.status).toBe(200);
  return res.json.job as DispatchJobRecord;
}

/** planResume over the live rows exactly as the CLI would assemble them. */
async function planLive(taskId: string) {
  const jobsRes = await api("GET", `/api/dispatch?taskId=${taskId}&limit=100`);
  const approvalsRes = await api("GET", "/api/approvals");
  const sessionsRes = await api("GET", `/api/sessions?taskId=${taskId}`);
  const jobs = jobsRes.json.jobs as DispatchJobRecord[];
  return planResume({
    live: {
      jobs,
      approvals: (approvalsRes.json.approvals as { taskId: string }[]).filter(
        (approval) => approval.taskId === taskId
      ) as never,
      sessions: sessionsRes.json.sessions as never,
    },
    sha256Hex,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-checkpoint-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  operatorToken = process.env.MUON_API_TOKEN;
  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
  // One lane row for LaneSession's FK.
  const lane = await prisma.lane.create({
    data: {
      key: "claude-code",
      name: "Claude Code",
      provider: "anthropic",
      role: "engineer",
    },
  });
  laneId = lane.id;
}, 30_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("kill@queued — the manifest alone is the checkpoint", () => {
  it("a queued job survives untouched and plans as none-still-queued (zero writes)", async () => {
    const taskId = await createTask("kill@queued");
    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "survive the kill",
    });
    expect(dispatched.status).toBe(201);
    const jobId = dispatched.json.job.id as string;

    // "Kill + restart": nothing but the rows. The manifest is intact.
    const job = await getJob(jobId);
    expect(job).toMatchObject({
      status: "queued",
      brief: "survive the kill",
      startedAt: null,
      resumedFromJobId: null,
    });

    const before = JSON.stringify(job);
    const plan = await planLive(taskId);
    expect(plan.refused).toBeUndefined();
    expect(plan.actions).toEqual([{ kind: "none-still-queued", jobId }]);
    // The plan is read-only: the row is byte-identical afterwards.
    expect(JSON.stringify(await getJob(jobId))).toBe(before);
  });
});

describe("kill@claimed/running — successor reclaim, never a replay", () => {
  it("reclaim marks job+session interrupted with the byte-exact REC-025 text; plan is human-review", async () => {
    const taskId = await createTask("kill@running");
    await seedIdleAgent("claude-code", 1);
    const host = `matrix-running-${randomBytes(4).toString("hex")}`;
    const leaseA = await mintLease(host);

    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "claimed then killed",
    });
    const jobId = dispatched.json.job.id as string;
    const claimed = await api("POST", `/api/dispatch/${jobId}/claim`, {
      host,
      leaseToken: leaseA,
    });
    expect(claimed.status).toBe(201);
    expect(claimed.json.job.status).toBe("running");

    // The dead incarnation's session (Slice A edge: jobId at create).
    const sessionRes = await api("POST", "/api/sessions", {
      laneId,
      taskId,
      jobId,
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = sessionRes.json.session.id as string;

    // Runner A dies (SIGKILL = nothing else happens). Successor lease B:
    const leaseB = await mintLease(host);
    const reclaimed = await api("POST", "/api/dispatch/reclaim", {
      host,
      leaseToken: leaseB,
    });
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.json.jobIds).toContain(jobId);

    const job = await getJob(jobId);
    expect(job.status).toBe("interrupted");
    // Byte-identical REC-025 promise (guard the fixed string).
    expect(job.result).toBe(REC_025_FIXED_RESULT);

    const session = await prisma.laneSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.status).toBe("interrupted");
    expect(session?.endedAt).not.toBeNull();

    // The claimed agent was released.
    const agents = await prisma.agent.findMany({
      where: { currentJobId: jobId },
    });
    expect(agents).toEqual([]);

    const plan = await planLive(taskId);
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: "human-review", jobId }),
    ]);
    expect(
      plan.actions.some((action) => action.kind === "redispatch-fresh")
    ).toBe(false);
  });
});

describe("kill@pre-launch — provably unstarted, fresh lineage-linked redispatch", () => {
  it("a pre-launch interrupt plans redispatch-fresh; POST with resumedFromJobId mints a NEW job and never mutates the old row", async () => {
    const taskId = await createTask("kill@pre-launch");
    await seedIdleAgent("claude-code", 2);
    const host = `matrix-prelaunch-${randomBytes(4).toString("hex")}`;
    const lease = await mintLease(host);

    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "killed before the vendor ever launched",
    });
    const jobId = dispatched.json.job.id as string;
    await api("POST", `/api/dispatch/${jobId}/claim`, {
      host,
      leaseToken: lease,
    });
    // The runner's own pre-launch refusal (exact protocol constant).
    const terminal = await api("PATCH", `/api/dispatch/${jobId}`, {
      status: "interrupted",
      result: PRE_LAUNCH_INTERRUPT_RESULTS[1],
      host,
      leaseToken: lease,
    });
    expect(terminal.status).toBe(200);

    const plan = await planLive(taskId);
    const action = plan.actions.find((entry) => entry.kind === "redispatch-fresh");
    expect(action).toBeDefined();
    if (action?.kind !== "redispatch-fresh") throw new Error("unreachable");
    expect(action.dispatch).toMatchObject({
      vendor: "claude-code",
      taskId,
      brief: "killed before the vendor ever launched",
      resumedFromJobId: jobId,
    });

    // Execute: fresh id, lineage column set. The interrupted original stays
    // immutable EXCEPT the append-once resume stamp (`resumedAt` /
    // `resumedByJobId`) — the one write-once claim that fences a duplicate
    // redispatch (P0.1 replay-safety).
    const originalBefore = await getJob(jobId);
    expect(originalBefore.resumedAt ?? null).toBeNull();
    expect(originalBefore.resumedByJobId ?? null).toBeNull();
    const fresh = await api("POST", "/api/dispatch", action.dispatch);
    expect(fresh.status).toBe(201);
    const freshId = fresh.json.job.id as string;
    expect(freshId).not.toBe(jobId);
    expect(fresh.json.job.resumedFromJobId).toBe(jobId);
    expect(fresh.json.job.status).toBe("queued");
    const originalAfter = await getJob(jobId);
    expect(originalAfter.resumedAt).not.toBeNull();
    expect(originalAfter.resumedByJobId).toBe(freshId);
    // Every OTHER column is byte-identical (the stamp + its `updatedAt` bump are
    // the sole mutation to the terminal row).
    const stripStamp = (job: DispatchJobRecord) => {
      const { resumedAt, resumedByJobId, updatedAt, ...rest } =
        job as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    expect(stripStamp(originalAfter)).toBe(stripStamp(originalBefore));
  });

  it("400s on an unknown resumedFromJobId and 409s while the referenced job is still live", async () => {
    const taskId = await createTask("resume-guards");
    const unknown = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "guard check",
      resumedFromJobId: "job-does-not-exist",
    });
    expect(unknown.status).toBe(400);

    const live = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "still live",
    });
    const liveId = live.json.job.id as string; // queued = not terminal
    const conflict = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "premature resume",
      resumedFromJobId: liveId,
    });
    expect(conflict.status).toBe(409);
  });
});

describe("kill@budget — MUON's own wall-clock kill resumes by human decision only", () => {
  // The founder's case: two claude implementers stopped at 603s against a 600s
  // budget, mid-edit. The planner calls that `human-review` and the CLI
  // advertises `--redispatch <jobId>` as the ONLY way to act on it, so the route
  // that redispatch posts to must admit it. It refused every one of them ("only
  // an interrupted job can be resumed"), which made the printed plan a
  // guaranteed 409 dead end — the tool telling the human to do the one thing it
  // would then reject.
  async function budgetKilled(taskId: string, brief: string): Promise<string> {
    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief,
      maxWallMs: 600_000,
    });
    expect(dispatched.status).toBe(201);
    const jobId = dispatched.json.job.id as string;
    // Exactly what the runner commits on a budget kill: `failed` (nobody
    // interrupted it) carrying the machine-classifiable marker.
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        result: budgetExhaustedResult({
          vendor: "claude-code",
          budgetMs: 600_000,
          elapsedMs: 603_000,
        }),
        startedAt: new Date(Date.now() - 603_000),
        endedAt: new Date(),
        exitCode: 130,
      },
    });
    return jobId;
  }

  it("plans human-review, and the redispatch that plan advertises is ADMITTED — exactly once", async () => {
    const taskId = await createTask("kill@budget");
    const jobId = await budgetKilled(taskId, "killed by its own budget mid-edit");

    const plan = await planLive(taskId);
    const action = plan.actions.find((entry) => entry.jobId === jobId);
    expect(action?.kind).toBe("human-review");

    const original = await getJob(jobId);
    const fresh = await api(
      "POST",
      "/api/dispatch",
      buildRedispatchInput(original, [])
    );
    expect(fresh.status).toBe(201);
    expect(fresh.json.job.id).not.toBe(jobId);
    expect(fresh.json.job.resumedFromJobId).toBe(jobId);

    // The append-once claim still fences: a SECOND redispatch of the same
    // original is refused and no duplicate child exists. Widening the admission
    // must not widen the replay bound.
    const second = await api(
      "POST",
      "/api/dispatch",
      buildRedispatchInput(original, [])
    );
    expect(second.status).toBe(409);
    expect(
      await prisma.dispatchJob.count({ where: { resumedFromJobId: jobId } })
    ).toBe(1);
  });

  it("still refuses a job that failed on its own merits", async () => {
    const taskId = await createTask("kill@budget-negative");
    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "a real failure",
    });
    const jobId = dispatched.json.job.id as string;
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        result: "vendor exited 1: the checks did not pass",
        endedAt: new Date(),
      },
    });

    const refused = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "replay a genuine failure",
      resumedFromJobId: jobId,
    });
    expect(refused.status).toBe(409);
    expect(
      await prisma.dispatchJob.count({ where: { resumedFromJobId: jobId } })
    ).toBe(0);
  });
});

describe("resume is append-once — no duplicate children, no replayed side effects", () => {
  // Drive an ORIGINAL into the provably-unstarted interrupted state (the exact
  // shape a pre-launch kill leaves), then prove that a second resume of that
  // same original — sequential OR concurrent — is refused (409) and never mints
  // a second child. This closes the P0.1 replay-safety HIGH: the redispatch was
  // the one unfenced write path (existence+terminal check, then a plain create).
  async function interruptedOriginal(taskId: string, brief: string): Promise<string> {
    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief,
    });
    expect(dispatched.status).toBe(201);
    const jobId = dispatched.json.job.id as string;
    // A provably-unstarted terminal row: the runner never launched the vendor.
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: {
        status: "interrupted",
        result: PRE_LAUNCH_INTERRUPT_RESULTS[0],
        startedAt: null,
        endedAt: new Date(),
      },
    });
    return jobId;
  }

  it("sequential double-resume: the second redispatch 409s; exactly ONE child; the original is stamped once", async () => {
    const taskId = await createTask("double-resume-seq");
    const jobId = await interruptedOriginal(taskId, "provably unstarted; resume me once");

    const first = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "resume attempt one",
      resumedFromJobId: jobId,
    });
    expect(first.status).toBe(201);
    const childId = first.json.job.id as string;
    expect(childId).not.toBe(jobId);
    expect(first.json.job.resumedFromJobId).toBe(jobId);

    const second = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "resume attempt two (replay)",
      resumedFromJobId: jobId,
    });
    expect(second.status).toBe(409);
    // The 409 names the claiming child but never amplifies free text (brief/token).
    const conflictBody = JSON.stringify(second.json);
    expect(conflictBody).toContain(childId);
    expect(conflictBody).not.toContain("resume attempt");

    // Exactly one child was ever born from this original.
    expect(
      await prisma.dispatchJob.count({ where: { resumedFromJobId: jobId } })
    ).toBe(1);

    // The interrupted original is immutable EXCEPT the append-once resume stamp.
    const original = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(original?.status).toBe("interrupted");
    expect(original?.result).toBe(PRE_LAUNCH_INTERRUPT_RESULTS[0]);
    expect(original?.resumedByJobId).toBe(childId);
    expect(original?.resumedAt).not.toBeNull();
  });

  it("concurrent double-resume: exactly one 201 + one 409; exactly ONE child row", async () => {
    const taskId = await createTask("double-resume-concurrent");
    const jobId = await interruptedOriginal(taskId, "provably unstarted; race the resume");

    const body = {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "concurrent resume",
      resumedFromJobId: jobId,
    };
    const settled = await Promise.allSettled([
      api("POST", "/api/dispatch", body),
      api("POST", "/api/dispatch", body),
    ]);
    const statuses = settled.map((entry) =>
      entry.status === "fulfilled" ? entry.value.status : 0
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);

    expect(
      await prisma.dispatchJob.count({ where: { resumedFromJobId: jobId } })
    ).toBe(1);
  });
});

describe("kill@waiting-gate — the exact pending gate survives", () => {
  it("reclaim leaves the pending approval untouched (same id/digest/jobId), session interrupted; plan = decide-gate", async () => {
    const taskId = await createTask("kill@waiting-gate");
    await seedIdleAgent("claude-code", 3);
    const host = `matrix-gate-${randomBytes(4).toString("hex")}`;
    const leaseA = await mintLease(host);

    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "session",
      taskId,
      brief: "session that parks on a gate",
    });
    const jobId = dispatched.json.job.id as string;
    await api("POST", `/api/dispatch/${jobId}/claim`, {
      host,
      leaseToken: leaseA,
    });

    const sessionRes = await api("POST", "/api/sessions", {
      laneId,
      taskId,
      jobId,
    });
    const sessionId = sessionRes.json.session.id as string;
    const waiting = await api("PATCH", `/api/sessions/${sessionId}`, {
      status: "waiting_approval",
    });
    expect(waiting.status).toBe(200);

    const payloadDigest = sha256Hex("rm -rf ./build");
    const filed = await api("POST", "/api/approvals", {
      taskId,
      requestedBy: "claude-code",
      kind: "command",
      reason: "Run the requested command",
      jobId,
      evidence: {
        action: "Bash",
        scope: "Command: rm -rf ./build",
        riskLevel: "high",
        impactIfApproved:
          "Runs a shell command in the selected workspace and may modify files.",
        payloadDigest,
        details: { sessionId },
      },
    });
    expect(filed.status).toBe(201);
    const approvalId = filed.json.approval.id as string;

    // Kill everything; successor reclaims.
    const leaseB = await mintLease(host);
    const reclaimed = await api("POST", "/api/dispatch/reclaim", {
      host,
      leaseToken: leaseB,
    });
    expect(reclaimed.json.jobIds).toContain(jobId);

    // THE SAME approval row survives with its exact binding — reclaim never
    // touches approvals.
    const approvals = await api("GET", "/api/approvals");
    const survived = (approvals.json.approvals as Record<string, unknown>[]).find(
      (row) => row.id === approvalId
    );
    expect(survived).toBeDefined();
    expect(survived).toMatchObject({
      id: approvalId,
      status: "pending",
      jobId,
      consumedAt: null,
    });
    expect(
      (survived!.evidence as { payloadDigest?: string }).payloadDigest
    ).toBe(payloadDigest);

    const session = await prisma.laneSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.status).toBe("interrupted");

    const plan = await planLive(taskId);
    expect(plan.actions).toEqual([
      {
        kind: "decide-gate",
        jobId,
        approvalId,
        payloadDigest,
        sessionInterrupted: true,
      },
    ]);
  });
});

describe("spent gates never revalidate", () => {
  it("consume is single-use (200 once, 409 forever); approved-unconsumed is expired-undelivered", async () => {
    const taskId = await createTask("spent-gates");
    const file = async () => {
      const res = await api("POST", "/api/approvals", {
        taskId,
        requestedBy: "claude-code",
        kind: "command",
        reason: "Run the requested command",
        evidence: {
          action: "Bash",
          scope: "Command: npm test",
          riskLevel: "medium",
          impactIfApproved: "Runs the project's test suite in the workspace.",
          payloadDigest: sha256Hex("npm test"),
          details: {},
        },
      });
      return res.json.approval.id as string;
    };

    const consumedId = await file();
    await api("PATCH", `/api/approvals/${consumedId}`, { status: "approved" });
    const first = await api("POST", `/api/approvals/${consumedId}/consume`);
    expect(first.status).toBe(200);
    expect(first.json.consumed).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await api("POST", `/api/approvals/${consumedId}/consume`);
      expect(replay.status).toBe(409);
    }

    const undeliveredId = await file();
    await api("PATCH", `/api/approvals/${undeliveredId}`, { status: "approved" });

    const approvals = await api("GET", "/api/approvals");
    const rows = approvals.json.approvals as Record<string, unknown>[];
    const consumed = rows.find((row) => row.id === consumedId);
    const undelivered = rows.find((row) => row.id === undeliveredId);
    expect(consumed?.consumedAt).not.toBeNull();
    expect(classifyGate(consumed as never)).toBe("spent");
    expect(classifyGate(undelivered as never)).toBe("approved-undelivered");

    // A pending consume attempt is also refused (fail-closed until decided).
    const pendingId = await file();
    const premature = await api("POST", `/api/approvals/${pendingId}/consume`);
    expect(premature.status).toBe(409);
  });
});

describe("lineage digest — identical across restart, stable under redispatch", () => {
  it("the digest is byte-stable across a simulated restart and the original set never shifts", async () => {
    const taskId = await createTask("lineage-digest");
    const dispatched = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "digest anchor",
    });
    const jobId = dispatched.json.job.id as string;

    const readSet = async () => {
      const res = await api("GET", `/api/dispatch?taskId=${taskId}&limit=100`);
      return res.json.jobs as DispatchJobRecord[];
    };
    const before = computeLineageDigest(await readSet(), sha256Hex);
    // "Restart": re-read the persistent rows; nothing but the rows exists.
    const after = computeLineageDigest(await readSet(), sha256Hex);
    expect(after).toBe(before);

    // Terminalize + redispatch: the ORIGINAL set's digest is untouched.
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: {
        status: "interrupted",
        result: PRE_LAUNCH_INTERRUPT_RESULTS[0],
        endedAt: new Date(),
      },
    });
    const fresh = await api("POST", "/api/dispatch", {
      vendor: "claude-code",
      kind: "oneshot",
      taskId,
      brief: "digest anchor",
      resumedFromJobId: jobId,
    });
    expect(fresh.status).toBe(201);
    expect(fresh.json.job.resumedFromJobId).toBe(jobId);

    const jobsNow = await readSet();
    const originalSet = jobsNow.filter((job) => job.id === jobId);
    expect(computeLineageDigest(originalSet, sha256Hex)).toBe(before);
    // And the grown mission digests differently (the fresh job is real lineage).
    expect(computeLineageDigest(jobsNow, sha256Hex)).not.toBe(before);
  });
});
