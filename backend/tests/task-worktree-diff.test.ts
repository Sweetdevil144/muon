import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// The review lane's diff read (GET /api/tasks/:taskId/worktree-diff),
// end-to-end against a REAL git repo with a REAL linked task worktree.
//
// Mission 420c8bf4 (2026-08-06): an implementer's diff lived only in its
// job-scoped worktree, and TWO independently dispatched reviewers (two
// vendors) had zero paths to it — review_diff saw only their own trees, the
// sandbox refused cross-worktree reads, and cross-task handoff/task reads
// 403'd (correctly: packets and briefs are that task's AUTHORITY surface).
// This route is the deliberate, single-purpose exception: a sibling's
// uncommitted DIFF is the code the mission is jointly producing, so
// same-mission crew may READ it. Nothing here mutates, and the fence is the
// caller's own capability — never a body claim.

const OPERATOR = "operator-token-worktree-diff";
const AGENT = "agent-token-worktree-diff";
const REVIEWER_TOKEN = `job-wtd-reviewer-${"r".repeat(48)}`;
const FOREIGN_TOKEN = `job-wtd-foreign-${"f".repeat(48)}`;
const MISSION = "chat-wtd-mission";
const IMPLEMENTER_TASK = "task-wtd-implementer";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;
let repoRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-wtd-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  // Keep the managed-worktree store inside the fixture — never ~/.muon.
  process.env.MUON_WORKTREE_ROOT = path.join(dir, "worktrees");
  delete process.env.MUON_API_TOKEN;

  // A real repository with one base commit…
  repoRoot = path.join(dir, "repo");
  mkdirSync(repoRoot);
  git(repoRoot, "init");
  git(repoRoot, "config", "user.email", "test@example.com");
  git(repoRoot, "config", "user.name", "muon-test");
  writeFileSync(path.join(repoRoot, "hello.ts"), "export const v = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");

  // …and the implementer task's REAL linked worktree carrying an uncommitted
  // edit plus an untracked new file (both must appear in the served diff).
  const core = await import("@muon/core");
  const worktreePath = core.taskWorktreePath(repoRoot, IMPLEMENTER_TASK);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoRoot, "worktree", "add", "--detach", worktreePath);
  writeFileSync(path.join(worktreePath, "hello.ts"), "export const v = 2;\n");
  writeFileSync(
    path.join(worktreePath, "fresh.ts"),
    "export const fresh = true;\n"
  );

  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  await db.prisma.task.createMany({
    data: [
      {
        id: IMPLEMENTER_TASK,
        title: "implement the change",
        description: "the implementer task whose worktree holds the diff",
        chatId: MISSION,
        workspacePath: repoRoot,
      },
      {
        id: "task-wtd-review",
        title: "review the change",
        description: "the reviewer's own task in the same mission",
        chatId: MISSION,
        workspacePath: repoRoot,
      },
      {
        id: "task-wtd-undispatched",
        title: "planned only",
        description: "a task that was never dispatched, so it owns no tree",
        chatId: MISSION,
        workspacePath: repoRoot,
      },
    ],
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-wtd-reviewer",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-wtd-review",
        chatId: MISSION,
        workspacePath: repoRoot,
        brief: "reviewer: certify the implementer diff",
        status: "running",
        dispatchedBy: "orchestrator",
      },
      {
        id: "job-wtd-foreign",
        kind: "session",
        vendor: "codex",
        taskId: "task-wtd-foreign",
        chatId: "chat-wtd-other-mission",
        workspacePath: repoRoot,
        brief: "an unrelated mission in the same repository",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      {
        jobId: "job-wtd-reviewer",
        tokenHash: createHash("sha256").update(REVIEWER_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-wtd-foreign",
        tokenHash: createHash("sha256").update(FOREIGN_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("review lane — a sibling task's worktree diff", () => {
  it("a same-mission worker reads the implementer's full diff", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${IMPLEMENTER_TASK}/worktree-diff`,
      headers: auth(REVIEWER_TOKEN),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    // The complete changed-file set — tracked edit AND untracked new file.
    expect(body.changedFiles).toEqual(["fresh.ts", "hello.ts"]);
    expect(body.diff.truncated).toBe(false);
    expect(body.diff.text).toContain("export const v = 2;");
    expect(body.diff.text).toContain("export const fresh = true;");
    // The commit the diff applies to, for index-freshness judgment downstream.
    expect(body.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a foreign-mission capability is refused", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${IMPLEMENTER_TASK}/worktree-diff`,
      headers: auth(FOREIGN_TOKEN),
    });
    expect(response.statusCode).toBe(403);
  });

  it("a never-dispatched sibling answers no-worktree, not an error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-wtd-undispatched/worktree-diff",
      headers: auth(REVIEWER_TOKEN),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("no-worktree");
  });

  it("a task that does not exist is 404, same-mission or not", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-wtd-missing/worktree-diff",
      headers: auth(REVIEWER_TOKEN),
    });
    expect(response.statusCode).toBe(404);
  });

  it("the operator reads it too", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${IMPLEMENTER_TASK}/worktree-diff`,
      headers: auth(OPERATOR),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  // Tighter than the metadata routes' capability-less convention, on purpose:
  // the SHARED agent bearer (runner bookkeeping) holds no mission to fence by,
  // and this payload is source code — it is refused, where task metadata
  // routes would have answered.
  it("the shared agent bearer (no job capability) is refused", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${IMPLEMENTER_TASK}/worktree-diff`,
      headers: auth(AGENT),
    });
    expect(response.statusCode).toBe(403);
  });
});
