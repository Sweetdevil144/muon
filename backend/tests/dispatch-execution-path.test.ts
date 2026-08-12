import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskWorktreePath } from "@muon/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── 0039: WHERE A DISPATCHED JOB ACTUALLY RAN (end-to-end, temp-SQLite brain) ─
//
// The runner resolves a job's cwd itself — the task's isolated worktree, or the
// canonical workspace — and now records it. These tests pin the properties that
// make the column trustworthy rather than merely present:
//
//   • it is WRITTEN by the exact lease-holding runner of a RUNNING job, and by
//     nobody else (a second lease, a queued job, and a vendor's own job
//     capability are all refused);
//   • it is NOT SETTABLE from a dispatch body, so no agent can aim a reviewer
//     at a directory of its choosing;
//   • it is bounded by the workspace allowlist OR the exact managed task tree;
//   • NULL keeps meaning "unknown", so every pre-0039 row still reads.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-execution-path";
const AGENT = "agent-token-execution-path";
const HOST = "desktop-mac";
const OTHER_HOST = "desktop-mac-successor";
const LEASE = `lease-${"a".repeat(58)}`;
const OTHER_LEASE = `lease-${"b".repeat(58)}`;
const JOB_TOKEN = `job-cap-${"c".repeat(56)}`;
const WORKSPACE = process.cwd();
// The runner's isolated tree for this task. Never created on disk: the route
// validates a path, it does not require the directory to exist yet.
const WORKTREE = path.join(WORKSPACE, ".muon", "worktrees", "task-exec");

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;
const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;

/** Put the job in the state a claim leaves it in: running, owned by `host`. */
async function claimedBy(jobId: string, host: string, leaseToken: string) {
  await prisma.dispatchJob.update({
    where: { id: jobId },
    data: {
      status: "running",
      host,
      runnerLeaseHash: hashLease(leaseToken),
      startedAt: new Date(),
    },
  });
}

async function record(
  jobId: string,
  body: Record<string, unknown>,
  token = AGENT
) {
  return app.inject({
    method: "POST",
    url: `/api/dispatch/${jobId}/execution-path`,
    headers: auth(token),
    payload: body,
  });
}

async function readJob(jobId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/dispatch/${jobId}`,
    headers: auth(OPERATOR),
  });
  expect(res.statusCode).toBe(200);
  return res.json().job as { id: string; executionPath: string | null };
}

/** Create a queued job the way the dispatch route would, and return its id. */
async function createJob(id: string): Promise<string> {
  await prisma.dispatchJob.create({
    data: {
      id,
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-exec",
      brief: "bounded work",
      workspacePath: WORKSPACE,
      status: "queued",
      dispatchedBy: "orchestrator",
    },
  });
  return id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-execution-path-"));
  process.env.MUON_WORKTREE_ROOT = path.join(dataDir, "worktrees");
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dataDir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  // The allowlist under test must be the DEFAULT one (cwd + home); a widened
  // MUON_WORKSPACE_ROOTS in the ambient env would hide the containment check.
  delete process.env.MUON_WORKSPACE_ROOTS;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();

  await prisma.lane.create({
    data: {
      id: "lane-codex",
      key: "codex",
      name: "Codex",
      provider: "openai",
      role: "implementer",
    },
  });
  await prisma.task.create({
    data: {
      id: "task-exec",
      title: "Execution path task",
      description: "Host task for the execution-path tests.",
      status: "in_progress",
      workspacePath: WORKSPACE,
    },
  });
});

beforeEach(async () => {
  await prisma.dispatchJob.deleteMany({});
  await prisma.delegationGrant.deleteMany({});
  await prisma.runner.deleteMany({});
  // Two live runners: the one that owns the job, and a successor that does not.
  await prisma.runner.createMany({
    data: [
      { host: HOST, leaseHash: hashLease(LEASE), status: "online" },
      {
        host: OTHER_HOST,
        leaseHash: hashLease(OTHER_LEASE),
        status: "online",
      },
    ],
  });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
  else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("dispatch execution path — the runner records where it ran", () => {
  it("records the exact external managed tree a worktree-backed job ran in", async () => {
    const jobId = await createJob("job-external-worktree");
    await claimedBy(jobId, HOST, LEASE);
    const external = taskWorktreePath(WORKSPACE, "task-exec");

    const res = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: external,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().executionPath).toBe(external);
    expect((await readJob(jobId)).executionPath).toBe(external);
  });

  it("retains bounded recording compatibility for a legacy nested worktree", async () => {
    const jobId = await createJob("job-worktree");
    await claimedBy(jobId, HOST, LEASE);

    const res = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });

    expect(res.statusCode).toBe(200);
    const recorded = res.json().executionPath as string;
    expect(path.isAbsolute(recorded)).toBe(true);
    expect(recorded.endsWith(path.join(".muon", "worktrees", "task-exec"))).toBe(
      true
    );
    // What the writer stored is exactly what a reader gets back.
    expect((await readJob(jobId)).executionPath).toBe(recorded);
  });

  it("records the workspace root for a job that ran there", async () => {
    const jobId = await createJob("job-workspace");
    await claimedBy(jobId, HOST, LEASE);

    const res = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKSPACE,
    });

    expect(res.statusCode).toBe(200);
    // The whole point: "ran in the workspace root" is a STATED fact, distinct
    // from the NULL that means "MUON does not know".
    const job = await readJob(jobId);
    expect(job.executionPath).not.toBeNull();
    expect(job.executionPath?.endsWith("backend")).toBe(true);
  });

  it("lets the owning lease correct itself but refuses a second runner", async () => {
    const jobId = await createJob("job-fenced");
    await claimedBy(jobId, HOST, LEASE);
    const first = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });
    expect(first.statusCode).toBe(200);

    // A live runner that does NOT own this job cannot speak for where it ran,
    // even though its own lease is perfectly valid.
    const intruder = await record(jobId, {
      host: OTHER_HOST,
      leaseToken: OTHER_LEASE,
      executionPath: WORKSPACE,
    });
    expect(intruder.statusCode).toBe(409);
    expect((await readJob(jobId)).executionPath).toBe(
      first.json().executionPath
    );

    // The owner may re-record (a reclaimed job that runs again must report
    // where it ran THIS time), and a replay of the same value is a no-op.
    const replay = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().executionPath).toBe(first.json().executionPath);
  });

  it("refuses a job that is not running", async () => {
    const jobId = await createJob("job-queued");

    const queued = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });
    expect(queued.statusCode).toBe(409);
    expect((await readJob(jobId)).executionPath).toBeNull();

    await claimedBy(jobId, HOST, LEASE);
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: { status: "done", endedAt: new Date() },
    });
    const terminal = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });
    expect(terminal.statusCode).toBe(409);
    expect((await readJob(jobId)).executionPath).toBeNull();
  });

  it("refuses a path outside the allowed workspace roots", async () => {
    const jobId = await createJob("job-escape");
    await claimedBy(jobId, HOST, LEASE);

    const escaped = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: path.join(dataDir, "not-a-workspace"),
    });

    expect(escaped.statusCode).toBe(400);
    // A refused stamp leaves the column honest (unknown), never half-written.
    expect((await readJob(jobId)).executionPath).toBeNull();
  });

  it("refuses a sibling external task tree", async () => {
    const jobId = await createJob("job-sibling-tree");
    await claimedBy(jobId, HOST, LEASE);

    const escaped = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: taskWorktreePath(WORKSPACE, "task-other"),
    });

    expect(escaped.statusCode).toBe(400);
    expect((await readJob(jobId)).executionPath).toBeNull();
  });

  it("refuses a sibling even when a broad workspace allowlist contains it", async () => {
    const jobId = await createJob("job-allowlisted-sibling");
    await claimedBy(jobId, HOST, LEASE);
    const previous = process.env.MUON_WORKSPACE_ROOTS;
    process.env.MUON_WORKSPACE_ROOTS = dataDir;
    try {
      const escaped = await record(jobId, {
        host: HOST,
        leaseToken: LEASE,
        executionPath: taskWorktreePath(WORKSPACE, "task-other"),
      });

      expect(escaped.statusCode).toBe(400);
      expect((await readJob(jobId)).executionPath).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MUON_WORKSPACE_ROOTS;
      else process.env.MUON_WORKSPACE_ROOTS = previous;
    }
  });

  it("is not settable from a dispatch body", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-exec",
        brief: "smuggle an execution path",
        workspacePath: WORKSPACE,
        executionPath: "/etc",
      },
    });

    expect(created.statusCode).toBe(201);
    const jobId = created.json().job.id as string;
    // Not merely stripped to something harmless: never accepted at all.
    expect((await readJob(jobId)).executionPath).toBeNull();
    const row = await prisma.dispatchJob.findUnique({ where: { id: jobId } });
    expect(row?.executionPath).toBeNull();
  });

  it("refuses a vendor's own job capability", async () => {
    const jobId = await createJob("job-capability");
    await claimedBy(jobId, HOST, LEASE);
    await prisma.delegationGrant.create({
      data: {
        jobId,
        tokenHash: hashLease(JOB_TOKEN),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    // The credential the VENDOR process holds. It knows the job id and could
    // learn the host, but this route is not on its allowlist at all.
    const res = await record(
      jobId,
      { host: HOST, leaseToken: LEASE, executionPath: "/etc" },
      JOB_TOKEN
    );

    expect(res.statusCode).toBe(403);
    expect((await readJob(jobId)).executionPath).toBeNull();
  });

  it("never projects the path into an agent's own view of its job", async () => {
    const jobId = await createJob("job-orch");
    await prisma.dispatchJob.update({
      where: { id: jobId },
      data: { capabilityMode: "orchestrator", chatId: "chat-exec" },
    });
    await claimedBy(jobId, HOST, LEASE);
    await prisma.delegationGrant.create({
      data: {
        jobId,
        tokenHash: hashLease(JOB_TOKEN),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const stamped = await record(jobId, {
      host: HOST,
      leaseToken: LEASE,
      executionPath: WORKTREE,
    });
    expect(stamped.statusCode).toBe(200);

    // A coordinator may read its OWN job; the agent projection carries
    // coordinates, not filesystem geography (it already withholds
    // workspacePath). The operator, who owns the review surface, sees it.
    const asAgent = await app.inject({
      method: "GET",
      url: `/api/dispatch/${jobId}`,
      headers: auth(JOB_TOKEN),
    });
    expect(asAgent.statusCode).toBe(200);
    expect(asAgent.json().job.executionPath).toBeUndefined();
    expect((await readJob(jobId)).executionPath).toBe(
      stamped.json().executionPath
    );
  });

  it("reads a pre-0039 row back as unknown, in the job and in the list", async () => {
    const jobId = await createJob("job-legacy");

    // Never stamped — exactly the shape of every row that existed before this
    // column did. It must read (and list) cleanly as "we do not know".
    expect((await readJob(jobId)).executionPath).toBeNull();
    const listed = await app.inject({
      method: "GET",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
    });
    expect(listed.statusCode).toBe(200);
    const jobs = listed.json().jobs as { id: string; executionPath: unknown }[];
    expect(jobs.find((job) => job.id === jobId)?.executionPath).toBeNull();
  });
});
