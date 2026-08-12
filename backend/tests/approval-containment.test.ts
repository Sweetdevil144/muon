import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { taskWorktreePath } from "@muon/core";
import { checkExecutionContainment } from "../src/lib/approval-containment.js";

// ── S0-2: the isolated worktree must actually bound what gets approved ───────
//
// A governed child was handed `<repo>/.muon/worktrees/<taskId>` and filed
// approvals to `cd <repo>` and edit `<repo>/apps/cli/README.md`. Every one was
// approved, the worktree was never touched, and the packet reported an empty
// diff over a tree nobody had edited. These tests pin that an approval which
// reaches outside the job's own execution tree is REFUSED at the one route that
// grants authority — so no surface, including Full Auto, can grant it.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-containment";
const AGENT = "agent-token-containment";
const WORKSPACE = process.cwd();
const WORKTREE = path.join(WORKSPACE, ".muon", "worktrees", "task-contained");

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;
const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;

function editEvidence(target: string) {
  return {
    action: "Edit",
    scope: `File: ${target}`,
    riskLevel: "medium" as const,
    impactIfApproved: "Writes content to one file in the selected workspace.",
    details: { path: target, sessionId: "session-1" },
  };
}

async function jobAt(id: string, executionPath: string | null) {
  await prisma.dispatchJob.create({
    data: {
      id,
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-contained",
      brief: "bounded work",
      workspacePath: WORKSPACE,
      status: "running",
      dispatchedBy: "orchestrator",
      executionPath,
    },
  });
  return id;
}

async function fileApproval(
  jobId: string | null,
  evidence: ReturnType<typeof editEvidence>
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/approvals",
    headers: auth(AGENT),
    payload: {
      taskId: "task-contained",
      requestedBy: "codex",
      kind: "command",
      reason: "Vendor requested a file edit.",
      evidence,
      ...(jobId ? { jobId } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().approval.id as string;
}

async function approve(approvalId: string) {
  return app.inject({
    method: "PATCH",
    url: `/api/approvals/${approvalId}`,
    headers: auth(OPERATOR),
    payload: { status: "approved" },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-containment-"));
  process.env.MUON_WORKTREE_ROOT = path.join(dataDir, "worktrees");
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dataDir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
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
      id: "task-contained",
      title: "Contained task",
      description: "Host task for the approval-containment tests.",
      status: "in_progress",
      workspacePath: WORKSPACE,
    },
  });
});

beforeEach(async () => {
  await prisma.approvalRequest.deleteMany({});
  await prisma.dispatchJob.deleteMany({});
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (originalWorktreeRoot === undefined) delete process.env.MUON_WORKTREE_ROOT;
  else process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("approval containment — a worktree-bound job cannot be approved out of its tree", () => {
  it("refuses an edit to the primary checkout, terminally, naming both trees", async () => {
    const jobId = await jobAt("job-escape", WORKTREE);
    const target = path.join(WORKSPACE, "apps", "cli", "README.md");
    const approvalId = await fileApproval(jobId, editEvidence(target));

    // This is the exact call every surface makes, Full Auto included: there is
    // no separate auto-approve path to bypass.
    const res = await approve(approvalId);

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(WORKTREE);
    expect(res.json().message).toContain(target);
    const stored = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });
    // Terminal: an automatic approver must not be able to spin on it.
    expect(stored?.status).toBe("rejected");
    expect(stored?.decisionNotes).toContain("refuses it");
  });

  it("refuses a command that leaves the tree, even a read", async () => {
    const jobId = await jobAt("job-cd", WORKTREE);
    const approvalId = await fileApproval(jobId, {
      action: "Bash",
      scope: `Command: cd ${WORKSPACE} && ls apps/cli/src`,
      riskLevel: "high",
      impactIfApproved: "Runs a shell command in the selected workspace.",
      details: { command: `cd ${WORKSPACE} && ls apps/cli/src`, sessionId: "s" },
    });

    const res = await approve(approvalId);

    // A read is how the child learned the wrong paths in the first place.
    expect(res.statusCode).toBe(409);
  });

  it("allows the identical edit inside the job's own worktree", async () => {
    const jobId = await jobAt("job-inside", WORKTREE);
    const target = path.join(WORKTREE, "apps", "cli", "README.md");
    const approvalId = await fileApproval(jobId, editEvidence(target));

    const res = await approve(approvalId);

    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("approved");
  });

  it("refuses a reach into a SIBLING lane's worktree", async () => {
    const jobId = await jobAt("job-sibling", WORKTREE);
    const sibling = path.join(WORKSPACE, ".muon", "worktrees", "task-other");
    const approvalId = await fileApproval(
      jobId,
      editEvidence(path.join(sibling, "src", "index.ts"))
    );

    expect((await approve(approvalId)).statusCode).toBe(409);
  });

  it("refuses primary and sibling writes from the new external layout", async () => {
    const external = taskWorktreePath(WORKSPACE, "task-contained");
    const jobId = await jobAt("job-external", external);
    const primaryApproval = await fileApproval(
      jobId,
      editEvidence(path.join(WORKSPACE, "src", "index.ts"))
    );
    expect((await approve(primaryApproval)).statusCode).toBe(409);

    const sibling = taskWorktreePath(WORKSPACE, "task-other");
    const siblingApproval = await fileApproval(
      jobId,
      editEvidence(path.join(sibling, "src", "index.ts"))
    );
    expect((await approve(siblingApproval)).statusCode).toBe(409);
  });

  it("leaves a workspace-rooted job untouched — there is no box to be outside of", async () => {
    const jobId = await jobAt("job-workspace", WORKSPACE);
    const target = path.join(WORKSPACE, "apps", "cli", "README.md");
    const approvalId = await fileApproval(jobId, editEvidence(target));

    expect((await approve(approvalId)).statusCode).toBe(200);
  });

  it("leaves an unknown execution path untouched — null means UNKNOWN", async () => {
    const jobId = await jobAt("job-unknown", null);
    const target = path.join(WORKSPACE, "apps", "cli", "README.md");
    const approvalId = await fileApproval(jobId, editEvidence(target));

    expect((await approve(approvalId)).statusCode).toBe(200);
  });

  it("never blocks a REJECT — refusing an escape must not strand the inbox", async () => {
    const jobId = await jobAt("job-reject", WORKTREE);
    const approvalId = await fileApproval(
      jobId,
      editEvidence(path.join(WORKSPACE, "apps", "cli", "README.md"))
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${approvalId}`,
      headers: auth(OPERATOR),
      payload: { status: "rejected" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().approval.status).toBe("rejected");
  });
});

describe("checkExecutionContainment — the pure boundary rule", () => {
  const box = "/repo/.muon/worktrees/task-1";

  it("ignores an absolute path outside the job's repository", () => {
    // `/usr/bin/git` in a command is not an isolation escape, and refusing it
    // would block ordinary work.
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: { details: { command: "/usr/bin/git status" } },
      })
    ).toEqual({ ok: true });
  });

  it("catches the repo root itself, not just files under it", () => {
    const verdict = checkExecutionContainment({
      executionPath: box,
      evidence: { details: { command: "cd /repo && ls" } },
    });
    expect(verdict.ok).toBe(false);
  });

  it("recognizes the deterministic external tree from persisted coordinates", () => {
    const external = taskWorktreePath("/repo", "task-1");
    const verdict = checkExecutionContainment({
      executionPath: external,
      workspacePath: "/repo",
      taskId: "task-1",
      evidence: { action: "Edit", details: { path: "/repo/src/index.ts" } },
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses an external tree that does not match the persisted task", () => {
    const wrongTask = taskWorktreePath("/repo", "task-other");
    const verdict = checkExecutionContainment({
      executionPath: wrongTask,
      workspacePath: "/repo",
      taskId: "task-1",
      evidence: { action: "Edit", details: { path: `${wrongTask}/x.ts` } },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("cannot verify");
  });

  it("fails closed when worktree-root configuration cannot be verified", () => {
    const previous = process.env.MUON_WORKTREE_ROOT;
    process.env.MUON_WORKTREE_ROOT = "/repo/.muon/invalid-external-root";
    try {
      const verdict = checkExecutionContainment({
        executionPath: "/outside/repo/task-1",
        workspacePath: "/repo",
        taskId: "task-1",
        evidence: { action: "Edit", details: { path: "/repo/x.ts" } },
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("cannot verify");
    } finally {
      if (previous === undefined) delete process.env.MUON_WORKTREE_ROOT;
      else process.env.MUON_WORKTREE_ROOT = previous;
    }
  });

  it("is a no-op without an execution path or outside a governed worktree", () => {
    expect(
      checkExecutionContainment({ executionPath: null, evidence: {} })
    ).toEqual({ ok: true });
    expect(
      checkExecutionContainment({
        executionPath: "/repo",
        evidence: { details: { path: "/elsewhere/x.ts" } },
      })
    ).toEqual({ ok: true });
  });

  it("tolerates evidence with no paths at all", () => {
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: { action: "Read", scope: "Tool request in session s" },
      })
    ).toEqual({ ok: true });
    expect(
      checkExecutionContainment({ executionPath: box, evidence: null })
    ).toEqual({ ok: true });
  });

  // 2026-07-28, from the founder's live mission: three worker `Read`s of files
  // the workers' OWN briefs declared were REJECTED here, with the write-shaped
  // reason "approving would write outside the tree" — false of a read. The
  // module's whole stated threat is a child EDITING the operator's real tree;
  // a read mutates nothing and returns bytes the job's own worktree (a checkout
  // of that same repository) already holds.
  it("does NOT refuse a proven read of the primary checkout", () => {
    for (const toolName of ["Read", "Grep", "Glob"]) {
      expect(
        checkExecutionContainment({
          executionPath: box,
          evidence: {
            action: toolName,
            details: { path: "/repo/packages/graph/src/memory-expiry.ts" },
          },
        }),
        `${toolName} of the primary checkout must be allowed`
      ).toEqual({ ok: true });
    }
  });

  it("still refuses a WRITE to the primary checkout", () => {
    for (const toolName of ["Edit", "Write", "MultiEdit"]) {
      const verdict = checkExecutionContainment({
        executionPath: box,
        evidence: {
          action: toolName,
          details: { path: "/repo/packages/graph/src/memory-expiry.ts" },
        },
      });
      expect(verdict.ok, `${toolName} must stay contained`).toBe(false);
    }
  });

  // Fail-closed: the exemption is only for what the shared classifier PROVES is
  // read-class. Anything it returns `null` for keeps today's containment.
  it("refuses anything it cannot prove is a read", () => {
    // A read tool that also carries a command is not provably a read.
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: {
          action: "Read",
          details: { path: "/repo/x.ts", command: "rm -rf /repo/x.ts" },
        },
      }).ok
    ).toBe(false);
    // Bash is never auto-classified as a read.
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: { action: "Bash", details: { command: "cat /repo/x.ts" } },
      }).ok
    ).toBe(false);
    // An unknown/absent tool name keeps the old behaviour exactly.
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: { details: { path: "/repo/x.ts" } },
      }).ok
    ).toBe(false);
    expect(
      checkExecutionContainment({
        executionPath: box,
        evidence: { action: "mcp__muon__code_query", details: { path: "/repo/x.ts" } },
      }).ok
    ).toBe(false);
  });
});
