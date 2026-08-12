import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readProjectSetupConfirmation,
  resolveEffectiveProjectSetup,
} from "@muon/core";
import { projectSetupConfirmationRequest } from "@muon/protocol/project-setup";
import { mkdirSync, writeFileSync } from "node:fs";

// T5 (week1) — the operator decision surface for repo-declared lifecycle
// commands is the ORDINARY approvals inbox: a dispatch files ONE deduped
// command gate keyed `project-setup:<hash>`, and approving it records the
// confirmation the next dispatch honors.

const OPERATOR = "operator-token-t5-gate";
const AGENT = "agent-token-t5-gate";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let repoDir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

// Computed in beforeAll from the REAL plan committed into repoDir — the
// approve hook re-resolves the repo (review finding 2), so a made-up hash
// can never be recorded.
let SETUP_HASH = "";

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-t5-gate-"));
  repoDir = mkdtempSync(path.join(tmpdir(), "muon-t5-gate-repo-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  // recordProjectSetupConfirmation writes under the resolved data dir.
  process.env.MUON_DATA_DIR = path.join(dir, "muon-data");
  delete process.env.MUON_API_TOKEN;

  // A real repo-declared plan: the hash the operator approves is the hash
  // the repo actually binds.
  mkdirSync(path.join(repoDir, ".muon"), { recursive: true });
  writeFileSync(
    path.join(repoDir, ".muon", "project.json"),
    JSON.stringify({ version: 1, setup: [{ command: "npm", args: ["install"] }] })
  );
  const plan = await resolveEffectiveProjectSetup({ repoRoot: repoDir });
  SETUP_HASH = projectSetupConfirmationRequest(plan)!.setupHash;

  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  await db.prisma.task.create({
    data: {
      id: "task-t5",
      title: "t5 task",
      description: "d",
      status: "in_progress",
      workspacePath: repoDir,
    },
  });
  app = (await import("../src/app.js")).buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db.prisma.$disconnect();
  delete process.env.MUON_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function fileGate() {
  return app.inject({
    method: "POST",
    url: "/api/approvals",
    headers: auth(AGENT),
    payload: {
      taskId: "task-t5",
      requestedBy: "runner",
      kind: "command",
      reason: "Repo-declared project lifecycle wants 1 command (npm install).",
      gateTag: `project-setup:${SETUP_HASH}`,
      evidence: {
        action: "project-setup",
        scope: repoDir,
        riskLevel: "high",
        impactIfApproved:
          "Repo-declared setup commands execute in this task's worktree on future dispatches.",
        details: { repoRoot: repoDir, setupHash: SETUP_HASH },
      },
    },
  });
}

describe("T5 project-setup gate", () => {
  let approvalId: string;

  it("keeps the confirmation key on a command approval and dedupes refiles", async () => {
    const first = await fileGate();
    expect(first.statusCode, first.body).toBe(201);
    approvalId = first.json().approval.id as string;
    expect(first.json().approval.gateTag).toBe(`project-setup:${SETUP_HASH}`);

    // Every later dispatch refiles; the operator must still see ONE decision.
    const second = await fileGate();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().approval.id).toBe(approvalId);
    expect(second.json().deduplicated).toBe(true);
  });

  it("approving records the confirmation the next dispatch honors", async () => {
    expect(
      await readProjectSetupConfirmation({ repoRoot: repoDir })
    ).toBeUndefined();

    const approve = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${approvalId}`,
      headers: auth(OPERATOR),
      payload: { status: "approved" },
    });
    expect(approve.statusCode, approve.body).toBe(200);

    const record = await readProjectSetupConfirmation({ repoRoot: repoDir });
    expect(record).toBeTruthy();
    expect(record!.setupHash).toBe(SETUP_HASH);
  });

  it("a consistent-but-fabricated hash that does not match the repo is refused", async () => {
    const fake = "d".repeat(64);
    const filed = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: auth(AGENT),
      payload: {
        taskId: "task-t5",
        requestedBy: "runner",
        kind: "command",
        reason: "Repo-declared project lifecycle wants 1 command (npm install).",
        gateTag: `project-setup:${fake}`,
        evidence: {
          action: "project-setup",
          scope: repoDir,
          riskLevel: "high",
          impactIfApproved: "Repo-declared setup commands execute later.",
          details: { repoRoot: repoDir, setupHash: fake },
        },
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const approve = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${filed.json().approval.id}`,
      headers: auth(OPERATOR),
      payload: { status: "approved" },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    // The repo's real plan hash stays the only recorded confirmation.
    const record = await readProjectSetupConfirmation({ repoRoot: repoDir });
    expect(record!.setupHash).toBe(SETUP_HASH);
  });

  it("a mismatched evidence hash never records a confirmation", async () => {
    const forged = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: auth(AGENT),
      payload: {
        taskId: "task-t5",
        requestedBy: "runner",
        kind: "command",
        reason: "Repo-declared project lifecycle wants 1 command (rm -rf /).",
        gateTag: `project-setup:${"b".repeat(64)}`,
        evidence: {
          action: "project-setup",
          scope: repoDir,
          riskLevel: "high",
          impactIfApproved: "Repo-declared setup commands execute later.",
          // The details hash disagrees with the gateTag — the recorder must
          // refuse rather than trust either side alone.
          details: { repoRoot: repoDir, setupHash: "c".repeat(64) },
        },
      },
    });
    expect(forged.statusCode, forged.body).toBe(201);
    const approve = await app.inject({
      method: "PATCH",
      url: `/api/approvals/${forged.json().approval.id}`,
      headers: auth(OPERATOR),
      payload: { status: "approved" },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const record = await readProjectSetupConfirmation({ repoRoot: repoDir });
    // Still the FIRST hash only; the inconsistent one was refused.
    expect(record!.setupHash).toBe(SETUP_HASH);
  });
});
