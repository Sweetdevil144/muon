import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  forkSeedDir,
  hasForkSeed,
  locateTaskWorktreePath,
} from "@muon/core";

// ── ADR-0044/0071 — the fork route, end to end on a REAL temp brain ─────────
//
// The workspace is a REAL throwaway git repository with an owned source-task
// worktree, because the route's first act is captureForkSeed against it.
//
// What these pin:
//   D1  a fork is a NEW dispatch naming a RECORDED (terminal) step — a live
//       source refuses; the fork's root goes through the ordinary create path
//       (orchestrator capabilityMode, fresh delegation manifest, dispatchedBy
//       human) with nothing copied from the source;
//   D4  operator only — an agent bearer is refused;
//   D5  the fork mints its OWN chat + task with the materialization pointer
//       (`Task.forkSourceTaskId`), never the source's — and the recorded
//       state is CAPTURED AT THE GESTURE into the fork's seed stash (review
//       finding: claim-time seeding read MUTABLE source state);
//   D6  provenance (`forkedFromJobId`) rides the job row;
//   capture-first: a source whose worktree is GONE refuses with 409 BEFORE
//       anything is minted;
//   compensation: a refused root (e.g. unknown vendor) rolls the minted
//       chat + task + stash back — no orphan mission (review finding);
//   sole-minter: a direct create naming `forkedFromJobId` with an ordinary
//       task is refused — POST /fork is the only path that can satisfy the
//       consistency guard;
//   0071 D2  the offer-set prefix (source-chat offers with firstAt <= the
//       step's end) is inherited under the fork root's job id; later offers
//       do not cross.

const OPERATOR = "operator-token-fork";
const AGENT = "agent-token-fork";
const SOURCE_CHAT = "chat-fork-source";
const SOURCE_TASK = "task-fork-source";
const GONE_TASK = "task-fork-gone-tree";
// The live sibling rides its OWN task: a non-terminal job on the source
// task would (correctly) trip the latest-settled-step guard for every fork.
const LIVE_TASK = "task-fork-live";
const STEP_ENDED_AT = new Date("2026-08-22T10:00:00.000Z");

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let workspace: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-fork-")));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  process.env.MUON_WORKSPACE_ROOTS = dir;
  // Separate roots: the worktree-root override refuses to live inside the
  // data dir (the sandboxed runner is blinded to that subpath, ADR-0010 F2).
  process.env.MUON_WORKTREE_ROOT = path.join(dir, "worktrees");
  process.env.MUON_DATA_DIR = path.join(dir, "data");
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  // The recorded step's REAL state: a repo at commit A, a source-task
  // worktree with one tracked edit and one untracked file.
  workspace = path.join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
  git(workspace, "init", "--initial-branch=main");
  git(workspace, "config", "user.email", "test@example.com");
  git(workspace, "config", "user.name", "Test");
  writeFileSync(path.join(workspace, "a.txt"), "base content\n");
  git(workspace, "add", "a.txt");
  git(workspace, "commit", "-m", "commit A (the step's base)");
  const sourceTree = locateTaskWorktreePath(workspace, SOURCE_TASK);
  mkdirSync(path.dirname(sourceTree), { recursive: true });
  git(workspace, "worktree", "add", "--detach", sourceTree);
  writeFileSync(path.join(sourceTree, "a.txt"), "the step's edit\n");
  mkdirSync(path.join(sourceTree, "docs"), { recursive: true });
  writeFileSync(path.join(sourceTree, "docs", "new.md"), "untracked note\n");

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  await db.prisma.task.createMany({
    data: [
      {
        id: SOURCE_TASK,
        title: "Mission Fork Source",
        description: "The mission whose step gets forked.",
        status: "in_progress",
        workspacePath: workspace,
        chatId: SOURCE_CHAT,
      },
      {
        id: GONE_TASK,
        title: "Mission whose tree vanished",
        description: "Terminal step, no surviving worktree.",
        status: "in_progress",
        workspacePath: workspace,
      },
      {
        id: LIVE_TASK,
        title: "Mission still running",
        description: "Holds the live job the SETTLED-refusal test forks.",
        status: "in_progress",
        workspacePath: workspace,
      },
    ],
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: SOURCE_CHAT,
      title: "Fork source",
      workspacePath: workspace,
      taskId: SOURCE_TASK,
    },
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-step-done",
        kind: "session",
        vendor: "claude-code",
        taskId: SOURCE_TASK,
        chatId: SOURCE_CHAT,
        capabilityMode: "orchestrator",
        brief: "The recorded step.",
        workspacePath: workspace,
        status: "done",
        dispatchedBy: "human",
        endedAt: STEP_ENDED_AT,
      },
      {
        id: "job-step-live",
        kind: "session",
        vendor: "claude-code",
        taskId: LIVE_TASK,
        chatId: SOURCE_CHAT,
        brief: "Still running.",
        workspacePath: workspace,
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-step-no-workspace",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: SOURCE_TASK,
        brief: "No workspace recorded.",
        status: "done",
        dispatchedBy: "human",
      },
      {
        // Settled, has a workspace, but no recorded end: it cannot be
        // ordered against its siblings, so it is not forkable. Harmless to
        // the latest-settled guard (a null endedAt never counts as later).
        id: "job-step-no-end",
        kind: "session",
        vendor: "claude-code",
        taskId: SOURCE_TASK,
        brief: "Settled without an end timestamp.",
        workspacePath: workspace,
        status: "done",
        dispatchedBy: "human",
      },
      {
        id: "job-step-gone-tree",
        kind: "session",
        vendor: "claude-code",
        taskId: GONE_TASK,
        brief: "Terminal, but its worktree no longer exists.",
        workspacePath: workspace,
        status: "done",
        dispatchedBy: "human",
        endedAt: STEP_ENDED_AT,
      },
    ],
  });
  // 0071 D2 fixture: two offers BEFORE the step's end, one AFTER.
  await db.prisma.memoryOffer.createMany({
    data: [
      {
        partition: SOURCE_CHAT,
        jobId: "job-step-done",
        principal: "agent:job:job-step-done",
        noteId: "mem-fork-before-1",
        surface: "recall",
        firstAt: new Date("2026-08-22T09:00:00.000Z"),
      },
      {
        partition: SOURCE_CHAT,
        jobId: "job-step-done",
        principal: "agent:job:job-step-done",
        noteId: "mem-fork-before-2",
        surface: "standing-pack",
        firstAt: new Date("2026-08-22T09:30:00.000Z"),
      },
      {
        partition: SOURCE_CHAT,
        jobId: "job-step-live",
        principal: "agent:job:job-step-live",
        noteId: "mem-fork-after-1",
        surface: "recall",
        firstAt: new Date("2026-08-22T11:00:00.000Z"),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  delete process.env.MUON_WORKSPACE_ROOTS;
  delete process.env.MUON_WORKTREE_ROOT;
  delete process.env.MUON_DATA_DIR;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("POST /api/dispatch/fork", () => {
  it("forks a terminal step: own chat+task, gesture-time seed stash, re-derived root, provenance, inherited offer prefix", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-done",
        brief: "Explore the alternative continuation from the recorded step.",
        vendor: "claude-code",
        title: "Alt exploration",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // D5: its OWN mission, with the materialization pointer.
    expect(body.chat.id).not.toBe(SOURCE_CHAT);
    expect(body.task.id).not.toBe(SOURCE_TASK);
    const task = await db.prisma.task.findUnique({
      where: { id: body.task.id },
    });
    expect(task).toMatchObject({
      forkSourceTaskId: SOURCE_TASK,
      workspacePath: workspace,
      chatId: body.chat.id,
    });

    // D5 capture half: the recorded state was stashed AT THE GESTURE, keyed
    // by the fork task — base commit + tracked diff + the untracked file.
    expect(hasForkSeed(body.task.id)).toBe(true);
    const meta = JSON.parse(
      await readFile(path.join(forkSeedDir(body.task.id), "meta.json"), "utf8")
    );
    expect(meta).toMatchObject({
      version: 1,
      sourceTaskId: SOURCE_TASK,
      hasDiff: true,
      untrackedCount: 1,
    });
    expect(meta.baseCommit).toBe(git(workspace, "rev-parse", "HEAD").trim());

    // D1/D2/D6: the root went through the ordinary create path with fresh
    // authority, and carries the provenance edge + the runner's pointer.
    const root = await db.prisma.dispatchJob.findUnique({
      where: { id: body.job.id },
    });
    expect(root).toMatchObject({
      chatId: body.chat.id,
      taskId: body.task.id,
      capabilityMode: "orchestrator",
      dispatchedBy: "human",
      forkedFromJobId: "job-step-done",
      forkSourceTaskId: SOURCE_TASK,
      status: "queued",
    });
    expect(root!.delegationManifest).toBeTruthy();

    // 0071 D2: the prefix (<= the step's end) crossed under the ROOT's id in
    // the fork's partition; the later offer did not.
    const inherited = await db.prisma.memoryOffer.findMany({
      where: { partition: body.chat.id },
      orderBy: { firstAt: "asc" },
    });
    expect(inherited.map((row) => row.noteId)).toEqual([
      "mem-fork-before-1",
      "mem-fork-before-2",
    ]);
    expect(inherited.every((row) => row.jobId === body.job.id)).toBe(true);
  });

  it("capture-first: a terminal step whose worktree is GONE refuses 409 with nothing minted", async () => {
    const tasksBefore = await db.prisma.task.count();
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-gone-tree",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("nothing was minted");
    expect(await db.prisma.task.count()).toBe(tasksBefore);
  });

  it("compensation: a refused root rolls back the minted chat + task + stash — no orphan mission", async () => {
    const tasksBefore = await db.prisma.task.count();
    const chatsBefore = await db.prisma.orchestratorChat.count();
    const stashesBefore = (
      await readdir(path.dirname(forkSeedDir("probe")), {
        withFileTypes: true,
      }).catch(() => [])
    ).length;

    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-done",
        brief: "a fork whose root the create path refuses",
        vendor: "not-a-vendor",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("rolled back");

    expect(await db.prisma.task.count()).toBe(tasksBefore);
    expect(await db.prisma.orchestratorChat.count()).toBe(chatsBefore);
    const stashesAfter = (
      await readdir(path.dirname(forkSeedDir("probe")), {
        withFileTypes: true,
      }).catch(() => [])
    ).length;
    expect(stashesAfter).toBe(stashesBefore);
  });

  it("latest-settled-step guard: a step reshaped by later or live sibling work refuses 409", async () => {
    // A LATER settled sibling on the source task: the worktree now holds
    // its state, not job-step-done's — the older step's state is gone.
    await db.prisma.dispatchJob.create({
      data: {
        id: "job-step-later",
        kind: "session",
        vendor: "claude-code",
        taskId: SOURCE_TASK,
        chatId: SOURCE_CHAT,
        brief: "Later settled work on the same task.",
        workspacePath: workspace,
        status: "done",
        dispatchedBy: "human",
        endedAt: new Date("2026-08-22T12:00:00.000Z"),
      },
    });
    const stale = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-done",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toContain("latest settled step");
    await db.prisma.dispatchJob.delete({ where: { id: "job-step-later" } });

    // A LIVE sibling: the tree is mutating under any capture.
    await db.prisma.dispatchJob.create({
      data: {
        id: "job-step-live-sibling",
        kind: "session",
        vendor: "claude-code",
        // No chatId: the one-active-root-per-chat unique index would refuse
        // a second running root on SOURCE_CHAT, and the guard keys on task.
        taskId: SOURCE_TASK,
        brief: "Live work on the same task.",
        workspacePath: workspace,
        status: "running",
        dispatchedBy: "human",
      },
    });
    const racing = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-done",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(racing.statusCode).toBe(409);
    expect(racing.json().message).toContain("latest settled step");
    await db.prisma.dispatchJob.delete({
      where: { id: "job-step-live-sibling" },
    });
  });

  it("refuses a LIVE source (409), an unknown source (404), and a workspace-less source (400)", async () => {
    const live = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-live",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(live.statusCode).toBe(409);
    expect(live.json().message).toContain("SETTLED");

    const missing = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: { sourceJobId: "job-nope", brief: "no", vendor: "claude-code" },
    });
    expect(missing.statusCode).toBe(404);

    const bare = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-no-workspace",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toContain("no state to materialize");

    // A settled step with no recorded end cannot be ordered against its
    // siblings — its recorded state cannot be identified.
    const unordered = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-no-end",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(unordered.statusCode).toBe(409);
    expect(unordered.json().message).toContain("no end timestamp");
  });

  it("D4: an agent bearer is refused — an agent DELEGATES, it never forks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(AGENT),
      payload: {
        sourceJobId: "job-step-done",
        brief: "no",
        vendor: "claude-code",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("forged provenance: a settled fork task refuses a SECOND fork-flagged root naming another step", async () => {
    const forked = await app.inject({
      method: "POST",
      url: "/api/dispatch/fork",
      headers: auth(OPERATOR),
      payload: {
        sourceJobId: "job-step-done",
        brief: "The mission whose task the forgery targets.",
        vendor: "claude-code",
      },
    });
    expect(forked.statusCode).toBe(201);
    const mission = forked.json();

    // A direct create on the fork-minted task naming a step of the same
    // source task passes the pointer check — but the fork root is the
    // task's FIRST job, so the edge cannot be re-minted with different
    // provenance after the fact.
    const forged = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: mission.task.id,
        chatId: mission.chat.id,
        workspacePath: workspace,
        brief: "record a fork edge whose state was never captured",
        dispatchedBy: "human",
        forkedFromJobId: "job-step-done",
      },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().message).toContain("already has its root");

    // An ORDINARY job on the fork task (no fork edge) is allowed — and it
    // carries the materialization pointer, so the runner's fail-closed
    // gate covers every job in the fork's tree, not just the root.
    const ordinary = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "oneshot",
        vendor: "claude-code",
        taskId: mission.task.id,
        workspacePath: workspace,
        brief: "later ordinary work inside the fork mission",
        dispatchedBy: "human",
      },
    });
    expect(ordinary.statusCode).toBe(201);
    const ordinaryRow = await db.prisma.dispatchJob.findUnique({
      where: { id: ordinary.json().job.id },
    });
    expect(ordinaryRow).toMatchObject({
      forkSourceTaskId: SOURCE_TASK,
      forkedFromJobId: null,
    });
  });

  it("sole-minter guard: a direct create naming forkedFromJobId with an ordinary task is refused", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        kind: "session",
        vendor: "claude-code",
        taskId: SOURCE_TASK, // NOT a fork-minted task
        chatId: SOURCE_CHAT,
        workspacePath: workspace,
        brief: "smuggle a fork",
        dispatchedBy: "human",
        forkedFromJobId: "job-step-done",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("fork-minted task");
  });
});
