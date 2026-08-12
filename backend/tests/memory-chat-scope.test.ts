import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// #126 PER-CHAT MEMORY PARTITIONING, real SQLite ledger + real LadybugDB graph +
// the real HTTP routes (no mocks on the store). Proves the invariant end-to-end:
// a note written in chat A is INVISIBLE to chat B via BOTH the /api/memory/search
// path AND the /api/memory/preedit hero-gate path, while an intentionally-global
// (NULL-chat) note still surfaces to a global (no-chatId) read. Also proves the
// additive migration applied with NULL back-compat (a note ingested without a
// chatId keeps chatId = NULL and is never matched by a chat-scoped read).

const OPERATOR = "operator-token-chat-scope";
const AGENT = "agent-token-chat-scope";
const JOB_A_TOKEN = `job-a-${"a".repeat(58)}`;
const JOB_B_TOKEN = `job-b-${"b".repeat(58)}`;
const TASK_JOB_TOKEN = `job-task-${"c".repeat(55)}`;
const MOD = "src/pay/charge.ts";
// A distinctive text so the lexical search matches deterministically (FTS off).
const CHAT_A_TEXT = "Charges are idempotent by request key zulu-alpha";
const LEGACY_TEXT = "Global legacy constraint yankee-oscar with no chat";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;
let chatANoteId: string;
let legacyNoteId: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-chat-scope-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  // Deterministic lexical recall in CI (the container FTS extension is optional).
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  // Applies every migration in prisma/migrations, INCLUDING 0024 (the additive
  // chatId column). If 0024 did not apply, the chat-scoped insert below throws.
  await db.ensureSchema();

  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-chat-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-chat-a",
        chatId: "chat-A",
        brief: "chat A memory job",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-chat-b",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-chat-b",
        chatId: "chat-B",
        brief: "chat B memory job",
        status: "running",
        dispatchedBy: "human",
      },
      {
        id: "job-task-local",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-standalone",
        brief: "standalone task memory job",
        status: "running",
        dispatchedBy: "human",
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      {
        jobId: "job-chat-a",
        tokenHash: createHash("sha256").update(JOB_A_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-chat-b",
        tokenHash: createHash("sha256").update(JOB_B_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        jobId: "job-task-local",
        tokenHash: createHash("sha256").update(TASK_JOB_TOKEN).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  chatANoteId = "mem-chat-scope-a";
  legacyNoteId = "mem-chat-scope-global";
  // Seed the authoritative ledger directly so this route/isolation test does not
  // race the intentionally fire-and-forget live graph mirror under suite load.
  // Other ledger tests cover ingest/update; this test awaits the real projector.
  await db.prisma.$transaction([
    db.prisma.memoryNote.create({
      data: {
        id: chatANoteId,
        kind: "decision",
        text: CHAT_A_TEXT,
        textHash: "chat-scope-a",
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human",
        chatId: "chat-A",
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    }),
    db.prisma.confirmation.create({
      data: {
        noteId: chatANoteId,
        principal: "human",
        decision: "confirm",
      },
    }),
    db.prisma.memoryNote.create({
      data: {
        id: legacyNoteId,
        kind: "constraint",
        text: LEGACY_TEXT,
        textHash: "chat-scope-global",
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human",
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    }),
    db.prisma.confirmation.create({
      data: {
        noteId: legacyNoteId,
        principal: "human",
        decision: "confirm",
      },
    }),
  ]);

  // The idempotent projection is the production recovery path from the durable
  // ledger to the derived graph. Await it before exercising either read surface.
  await ledger.projectLedgerToGraph();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("#126 per-chat memory partitioning (isolation)", () => {
  it("MIGRATION: 0024 applied; a chat-scoped write persists chatId, a NULL-chat write stays NULL (back-compat)", async () => {
    const applied = await db.prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT "version" FROM "_muon_migrations" WHERE "version" = '0024_memory_note_chat_scope'`
    );
    expect(applied).toHaveLength(1);

    const rowA = await db.prisma.memoryNote.findUnique({
      where: { id: chatANoteId },
    });
    expect(rowA?.chatId).toBe("chat-A");

    const rowLegacy = await db.prisma.memoryNote.findUnique({
      where: { id: legacyNoteId },
    });
    // No backfill: a note written without a chat keeps chatId = NULL.
    expect(rowLegacy?.chatId).toBeNull();
  });

  it("SEARCH: chat A's note is INVISIBLE to a chat-B search, VISIBLE to a chat-A search", async () => {
    const q = encodeURIComponent("idempotent request key zulu");

    const inChatB = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${q}&chatId=chat-B`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(inChatB.statusCode).toBe(200);
    const chatBIds = inChatB.json().notes.map((n: { id: string }) => n.id);
    expect(chatBIds).not.toContain(chatANoteId);

    const inChatA = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${q}&chatId=chat-A`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(inChatA.statusCode).toBe(200);
    const chatAIds = inChatA.json().notes.map((n: { id: string }) => n.id);
    expect(chatAIds).toContain(chatANoteId);
  });

  it("CONTENT GATE: search and recall admit unconfirmed notes only when crew-visible is explicitly enabled", async () => {
    const noteId = "mem-chat-scope-unconfirmed";
    await db.prisma.memoryNote.create({
      data: {
        id: noteId,
        kind: "attempt",
        text: "Unconfirmed crew observation uniform-kilo",
        textHash: "chat-scope-unconfirmed",
        scope: "project",
        trust: "medium",
        status: "active",
        createdBy: "agent:job:job-chat-a",
        taskId: "task-chat-a",
        chatId: "chat-A",
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    });
    await db.prisma.confirmation.create({
      data: {
        noteId,
        principal: "agent:orchestrator:corroborated:chat-A",
        decision: "confirm",
      },
    });
    await ledger.projectLedgerToGraph();

    const setCrewVisible = async (enabled: boolean) => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/memory/settings/auto-confirm-agent-memory",
        headers: auth(OPERATOR),
        payload: { enabled },
      });
      expect(response.statusCode).toBe(200);
    };
    const readIds = async () => {
      const search = await app.inject({
        method: "GET",
        url: "/api/memory/search?q=uniform-kilo&chatId=chat-A",
        headers: auth(JOB_A_TOKEN),
      });
      expect(search.statusCode).toBe(200);
      const recall = await app.inject({
        method: "GET",
        url: "/api/memory/recall?taskId=task-chat-a&chatId=chat-A",
        headers: auth(JOB_A_TOKEN),
      });
      expect(recall.statusCode).toBe(200);
      return {
        search: search.json().notes.map((note: { id: string }) => note.id),
        recall: recall.json().notes.map((note: { id: string }) => note.id),
      };
    };

    await setCrewVisible(false);
    const strict = await readIds();
    expect(strict.search).not.toContain(noteId);
    expect(strict.recall).not.toContain(noteId);
    const strictUsed = await app.inject({
      method: "POST",
      url: "/api/memory/used",
      headers: auth(JOB_A_TOKEN),
      payload: { noteIds: [noteId] },
    });
    expect(strictUsed.json()).toEqual({ buffered: 0 });

    await setCrewVisible(true);
    const shared = await readIds();
    expect(shared.search).toContain(noteId);
    expect(shared.recall).toContain(noteId);
    const sharedUsed = await app.inject({
      method: "POST",
      url: "/api/memory/used",
      headers: auth(JOB_A_TOKEN),
      payload: { noteIds: [noteId] },
    });
    expect(sharedUsed.json()).toEqual({ buffered: 1 });
  });

  it("PREEDIT GATE: chat A's confirmed note is INVISIBLE in chat B, VISIBLE in chat A", async () => {
    const preedit = async (token: string, chatId?: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/memory/preedit",
        headers: auth(token),
        payload: chatId ? { module: MOD, chatId } : { module: MOD },
      });
      expect(res.statusCode).toBe(200);
      return res.json().memories.map((m: { id: string }) => m.id) as string[];
    };

    // Chat B: chat A's note must NOT surface as governed evidence.
    const chatBMemories = await preedit(JOB_B_TOKEN, "chat-B");
    expect(chatBMemories).not.toContain(chatANoteId);

    // Chat A: its own confirmed on-target note DOES surface.
    const chatAMemories = await preedit(JOB_A_TOKEN, "chat-A");
    expect(chatAMemories).toContain(chatANoteId);
    // The NULL-chat global note is NOT pulled into a chat-scoped gate (strict).
    expect(chatAMemories).not.toContain(legacyNoteId);
  });

  it("AUTHORITY: shared agent bearer and a foreign claimed chat cannot enter memory content routes", async () => {
    const shared = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=idempotent&chatId=chat-A",
      headers: auth(AGENT),
    });
    expect(shared.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=idempotent&chatId=chat-A",
      headers: auth(JOB_B_TOKEN),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("AUTHORSHIP: the capability derives task, chat, and principal and only that job may delete its proposal", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_A_TOKEN),
      payload: {
        kind: "attempt",
        text: "Job-bound ownership proposal tango-sierra",
        taskId: "foreign-task",
        chatId: "chat-A",
        createdBy: "human:forged",
        modules: [MOD],
      },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().note.id as string;
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: noteId },
    });
    expect(row).toMatchObject({
      taskId: "task-chat-a",
      chatId: "chat-A",
      createdBy: "agent:job:job-chat-a",
    });

    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/memory/${noteId}?chatId=chat-B`,
      headers: auth(JOB_B_TOKEN),
    });
    expect(foreignDelete.statusCode).toBe(403);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/memory/${noteId}?chatId=chat-A`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(ownerDelete.statusCode).toBe(200);
  });

  it("NON-CHAT: a standalone job receives a task-local partition instead of the operator-wide view", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(TASK_JOB_TOKEN),
      payload: {
        kind: "decision",
        text: "Standalone task partition whiskey-victor",
        createdBy: "codex",
        modules: [MOD],
      },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().note.id as string;
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: noteId },
    });
    expect(row).toMatchObject({
      taskId: "task-standalone",
      chatId: "task:task-standalone",
      createdBy: "agent:job:job-task-local",
    });
    // This test is about the synthetic task-local partition, not D12-C. A human
    // confirmation makes the note readable without fabricating corroboration
    // for a legacy job that has no workspace coordinate.
    await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:operator",
    });

    const ownSearch = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=whiskey-victor",
      headers: auth(TASK_JOB_TOKEN),
    });
    expect(ownSearch.statusCode).toBe(200);
    expect(
      ownSearch.json().notes.map((note: { id: string }) => note.id)
    ).toContain(noteId);

    const foreignSearch = await app.inject({
      method: "GET",
      url: "/api/memory/search?q=whiskey-victor",
      headers: auth(JOB_A_TOKEN),
    });
    expect(
      foreignSearch.json().notes.map((note: { id: string }) => note.id)
    ).not.toContain(noteId);
  });

  it("GLOBAL: a no-chatId (operator) gate is the global view — sees BOTH the chat-A and the NULL-chat note", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth(OPERATOR),
      payload: { module: MOD },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().memories.map((m: { id: string }) => m.id) as string[];
    expect(ids).toContain(chatANoteId);
    expect(ids).toContain(legacyNoteId);
  });
});
