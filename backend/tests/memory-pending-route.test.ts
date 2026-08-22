import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// H5 — GET /api/memory/pending: the agent-tier, partition-scoped, IDS-ONLY read
// of what memory is waiting on a human.
//
// It exists because no agent read could see an unvouched note: recall and
// search both run the KG-6 gate (correctly), and `/library` — the queue that
// does see them — is operator-tier. The risk in adding such a read is obvious,
// so these tests are about the fences rather than the happy path: no text ever
// crosses, no other chat's note is listed, and no unpartitioned caller reaches it.

const OPERATOR = "operator-token-pending";
const AGENT = "agent-token-pending";
const JOB_A_TOKEN = `job-pa-${"a".repeat(57)}`;
const JOB_B_TOKEN = `job-pb-${"b".repeat(57)}`;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const UNVOUCHED_TEXT = "PENDING-NOTE-BODY-tango-victor";
const CONFIRMED_TEXT = "CONFIRMED-NOTE-BODY-sierra-kilo";
const FOREIGN_TEXT = "FOREIGN-NOTE-BODY-november-echo";
const WORKSPACE_TEXT = "WORKSPACE-NOTE-BODY-delta-romeo";

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-pending-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-pending-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-pending-a",
        chatId: "chat-P",
        brief: "chat P job",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-pending-b",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-pending-b",
        chatId: "chat-Q",
        brief: "chat Q job",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      {
        jobId: "job-pending-a",
        tokenHash: createHash("sha256").update(JOB_A_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-pending-b",
        tokenHash: createHash("sha256").update(JOB_B_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  await db.prisma.memoryNote.createMany({
    data: [
      {
        id: "mem-pending-unvouched",
        kind: "constraint",
        text: UNVOUCHED_TEXT,
        textHash: "pending-unvouched",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:job:job-pending-a",
        chatId: "chat-P",
        modules: [],
        topics: [],
        symbols: [],
      },
      {
        id: "mem-pending-confirmed",
        kind: "decision",
        text: CONFIRMED_TEXT,
        textHash: "pending-confirmed",
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human",
        chatId: "chat-P",
        modules: [],
        topics: [],
        symbols: [],
      },
      {
        id: "mem-pending-foreign",
        kind: "attempt",
        text: FOREIGN_TEXT,
        textHash: "pending-foreign",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:job:job-pending-b",
        chatId: "chat-Q",
        modules: [],
        topics: [],
        symbols: [],
      },
      {
        // Same chat, but ASSIGNED to a workspace. The caller's job has no
        // workspace, so its read fences to the unassigned residue and this row
        // must stay out — the ADR-0026 fence, not just the chat one.
        id: "mem-pending-otherworkspace",
        kind: "convention",
        text: WORKSPACE_TEXT,
        textHash: "pending-otherworkspace",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:job:job-pending-a",
        chatId: "chat-P",
        workspacePath: "/somewhere/else",
        modules: [],
        topics: [],
        symbols: [],
      },
    ],
  });
  await db.prisma.confirmation.create({
    data: {
      noteId: "mem-pending-confirmed",
      principal: "human",
      decision: "confirm",
    },
  });
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function pending(token: string) {
  return app.inject({
    method: "GET",
    url: "/api/memory/pending",
    headers: auth(token),
  });
}

describe("H5 GET /api/memory/pending", () => {
  it("returns this partition's unvouched note ids — and NEVER their text", async () => {
    const response = await pending(JOB_A_TOKEN);
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.notes).toEqual([
      {
        id: "mem-pending-unvouched",
        kind: "constraint",
        createdAt: expect.any(String),
      },
    ]);
    // THE invariant. The confirmed-only content gate is only untouched while
    // no content-bearing field rides this route; it has been defeated twice
    // before by exactly such a field arriving later.
    expect(response.body).not.toContain(UNVOUCHED_TEXT);
  });

  it("omits a note a human already confirmed — this is the queue, not the corpus", async () => {
    const payload = (await pending(JOB_A_TOKEN)).json();
    const ids = payload.notes.map((note: { id: string }) => note.id);
    expect(ids).not.toContain("mem-pending-confirmed");
  });

  it("omits another chat's pending note, and does not name it", async () => {
    // ADR-0026/0033: a foreign id is ABSENT, never refused by name — naming it
    // is how an agent maps the missions on the machine.
    const response = await pending(JOB_A_TOKEN);
    expect(response.body).not.toContain("mem-pending-foreign");
    expect(response.body).not.toContain("chat-Q");
    expect(response.body).not.toContain(FOREIGN_TEXT);
  });

  it("omits a same-chat note assigned to a workspace this capability does not hold", async () => {
    const response = await pending(JOB_A_TOKEN);
    expect(response.body).not.toContain("mem-pending-otherworkspace");
    expect(response.body).not.toContain("/somewhere/else");
  });

  it("answers each capability with its OWN partition, never a merged view", async () => {
    const b = (await pending(JOB_B_TOKEN)).json();
    expect(b.notes.map((note: { id: string }) => note.id)).toEqual([
      "mem-pending-foreign",
    ]);
  });

  it("reports its own bound rather than implying the page is the whole queue", async () => {
    const payload = (await pending(JOB_A_TOKEN)).json();
    expect(payload.limit).toBe(50);
    expect(payload.truncated).toBe(false);
    expect(payload.totalExact).toBe(true);
    expect(payload.total).toBe(1);
  });

  it("refuses a bare agent bearer with no job capability", async () => {
    // Without a capability there is no partition to scope to, and the tasks/
    // approvals routes show what an unfenced agent read looks like: everything.
    expect((await pending(AGENT)).statusCode).toBe(403);
  });

  it("refuses the operator tier and names the queue that is actually theirs", async () => {
    const response = await pending(OPERATOR);
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("/api/memory/library");
  });
});
