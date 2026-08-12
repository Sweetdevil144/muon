import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { memoryDirectorySnapshotSchema } from "@muon/protocol";
import { memoryPassesGate } from "@muon/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const OPERATOR = "operator-memory-directory";
const AGENT = "agent-memory-directory";
const JOB_TOKEN = `job-memory-directory-${"a".repeat(48)}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let workspaceA: string;
let workspaceB: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

const ids = {
  kept: "mem-11111111-1111-4111-8111-111111111111",
  unconfirmed: "mem-22222222-2222-4222-8222-222222222222",
  foreign: "mem-33333333-3333-4333-8333-333333333333",
  rejected: "mem-44444444-4444-4444-8444-444444444444",
  paused: "mem-55555555-5555-4555-8555-555555555555",
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-directory-route-"));
  workspaceA = path.join(dir, "repo-a");
  workspaceB = path.join(dir, "repo-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  process.env.MUON_WORKSPACE_ROOTS = dir;
  delete process.env.MUON_API_TOKEN;

  vi.resetModules();
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
  await db.prisma.dispatchJob.create({
    data: {
      id: "job-memory-directory",
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-memory-directory",
      brief: "read governed memory",
      workspacePath: workspaceA,
      status: "running",
      dispatchedBy: "human",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: "job-memory-directory",
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });

  for (const [id, workspacePath, status] of [
    [ids.kept, workspaceA, "active"],
    [ids.unconfirmed, workspaceA, "active"],
    [ids.foreign, workspaceB, "active"],
    [ids.rejected, workspaceA, "active"],
    [ids.paused, workspaceA, "paused"],
  ] as const) {
    await db.prisma.memoryNote.create({
      data: {
        id,
        kind: "constraint",
        text: `graph text ${id}`,
        textHash: `${id}-hash`,
        createdBy: id === ids.unconfirmed ? "agent:codex" : "human",
        workspacePath,
        status,
        modules: ["src/gate.ts"],
        topics: [],
        symbols: [],
      },
    });
    if (id !== ids.unconfirmed) {
      await db.prisma.confirmation.create({
        data: { noteId: id, principal: "human", decision: "confirm" },
      });
    }
  }
  await ledger.projectLedgerToGraph();

  // The graph now contains the pre-mutation bytes/verdict. Ledger authority must
  // replace the text and revoke the rejected note without relying on reproject.
  await db.prisma.memoryNote.update({
    where: { id: ids.kept },
    data: { text: "ledger bytes exactly", textHash: "ledger-bytes-hash" },
  });
  await db.prisma.confirmation.create({
    data: { noteId: ids.rejected, principal: "human", decision: "reject" },
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  delete process.env.MUON_WORKSPACE_ROOTS;
  rmSync(dir, { recursive: true, force: true });
});

describe("TODO 4.14 governed memory directory", () => {
  it("is exact-job only, workspace-fenced, and byte-identical to the ledger-regated gate", async () => {
    for (const token of [OPERATOR, AGENT]) {
      const refused = await app.inject({
        method: "GET",
        url: "/api/memory/directory-snapshot",
        headers: auth(token),
      });
      expect(refused.statusCode).toBe(403);
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/directory-snapshot",
      headers: auth(JOB_TOKEN),
    });
    expect(response.statusCode, response.body).toBe(200);
    const snapshot = memoryDirectorySnapshotSchema.parse(response.json());
    expect(snapshot.noteCount).toBe(1);
    const noteFile = snapshot.files.find((file) =>
      file.path.endsWith(`${ids.kept}.txt`)
    );
    expect(noteFile?.content).toBe("ledger bytes exactly");
    for (const hidden of [ids.unconfirmed, ids.foreign, ids.rejected, ids.paused]) {
      expect(snapshot.files.some((file) => file.path.includes(hidden))).toBe(false);
    }

    const rawGate = await graphLib.getGraph().recallForGate(
      { workspacePath: workspaceA, showExpired: true },
      { limit: 200 }
    );
    const authoritative = (await ledger.applyMemoryExpiry(rawGate)).filter(
      (note) =>
        note.workspacePath === workspaceA &&
        note.status === "active" &&
        note.confirmed === true &&
        memoryPassesGate(note, { governedOnly: true })
    );
    expect(
      snapshot.files
        .filter((file) => file.path.startsWith("notes/"))
        .map((file) => file.path.slice(6, -4))
    ).toEqual(authoritative.map((note) => note.id));
  }, 30_000);
});
