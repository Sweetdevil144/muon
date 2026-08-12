import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const graphMock = vi.hoisted(() => ({
  memoryAnalytics: vi.fn().mockResolvedValue({
    noteScores: [],
    hotModules: [],
    communities: [],
    source: { notes: 0, modules: 0, edges: 0, truncated: false },
  }),
}));

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => graphMock,
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
  awaitGraphMirrors: () => Promise.resolve(),
}));

const OPERATOR = "operator-token-memory-library";
const AGENT = "agent-token-memory-library";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function addNote(text: string, chatId?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/memory",
    headers: auth(OPERATOR),
    payload: {
      kind: "decision",
      text,
      modules: ["src/parser.ts"],
      topics: ["parser"],
      symbols: ["src/parser.ts#parse"],
      createdBy: "codex",
      ...(chatId ? { chatId } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().note as { id: string };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-memory-library-"));
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
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("operator memory library", () => {
  it("accepts pause only from the operator and returns it through the explicit paused shelf", async () => {
    const note = await addNote("Temporarily withhold this launch constraint.");
    const confirm = await app.inject({
      method: "PATCH",
      url: `/api/memory/${note.id}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true, principal: "human:founder" },
    });
    expect(confirm.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: "PATCH",
      url: `/api/memory/${note.id}`,
      headers: auth(AGENT),
      payload: { status: "paused" },
    });
    expect(forbidden.statusCode).toBe(403);

    const paused = await app.inject({
      method: "PATCH",
      url: `/api/memory/${note.id}`,
      headers: auth(OPERATOR),
      payload: { status: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().note).toMatchObject({
      id: note.id,
      status: "paused",
      confirmed: true,
    });
    const shelf = await app.inject({
      method: "GET",
      url: "/api/memory/library?status=paused&showExpired=true&limit=50",
      headers: auth(OPERATOR),
    });
    expect(shelf.statusCode).toBe(200);
    expect(shelf.json().notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: note.id,
          status: "paused",
          confirmed: true,
        }),
      ])
    );
    const queue = await app.inject({
      method: "GET",
      url: "/api/memory/library?confirmed=unvouched&showExpired=true&limit=50",
      headers: auth(OPERATOR),
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().notes.map((row: { id: string }) => row.id)).not.toContain(
      note.id
    );
  });

  it("keeps the ledger library available when derived analytics degrade", async () => {
    graphMock.memoryAnalytics.mockRejectedValueOnce(
      new Error("derived graph unavailable")
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/library?status=all&limit=10",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().analytics).toEqual({
      noteScores: [],
      hotModules: [],
      communities: [],
      source: { notes: 0, modules: 0, edges: 0, truncated: false },
    });
  });

  it("returns active, rejected, provenance, and graph relationships without exposing it to agents", async () => {
    const confirmed = await addNote("Use the streaming parser.");
    const rejected = await addNote("Never use the streaming parser.");

    await app.inject({
      method: "PATCH",
      url: `/api/memory/${confirmed.id}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true, principal: "human:founder" },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/memory/${rejected.id}`,
      headers: auth(OPERATOR),
      payload: { status: "rejected", principal: "human:founder" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/library?status=all&limit=50",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: confirmed.id, confirmed: true }),
        expect.objectContaining({ id: rejected.id, status: "rejected" }),
      ])
    );
    expect(response.json().edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: rejected.id,
          toId: confirmed.id,
          kind: "contradicts",
        }),
      ])
    );
    expect(response.json().confirmations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: confirmed.id,
          principal: "human:founder",
          decision: "confirm",
        }),
      ])
    );

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/memory/library",
      headers: auth(AGENT),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  // P1.4 Slice 3 — review provenance: the snapshot carries the MemoryImport
  // rows (origin workspace/author/confirmation as DATA, never authority) for
  // the returned notes, and a system "reconcile" provenance row (the KG-6
  // conflict marker, also written by pack tombstones) must ROUND-TRIP through
  // the client loader. Before the schema widening, any brain with a conflict
  // failed the `loadMemoryLibrary` parse — a pre-existing bug this proves.
  it("carries import provenance and reconcile rows that round-trip through loadMemoryLibrary", async () => {
    const note = await addNote("Prefer the governed loop over raw dispatch.");
    await prisma.memoryImport.create({
      data: {
        originWorkspace: "ws-0123456789abcdef",
        originLabel: "repo",
        originNoteId: "mem-origin-1",
        recordHash: "a".repeat(64),
        textHash: "b".repeat(64),
        noteId: note.id,
        disposition: "proposed",
        originAuthor: "human:carol",
        originConfirmedBy: "human:carol",
        originConfirmedAt: new Date("2026-07-02T10:00:00.000Z"),
      },
    });
    await prisma.confirmation.create({
      data: { noteId: note.id, principal: "system", decision: "reconcile" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/library?status=all&limit=50",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: note.id,
          originWorkspace: "ws-0123456789abcdef",
          originLabel: "repo",
          originNoteId: "mem-origin-1",
          disposition: "proposed",
          originAuthor: "human:carol",
          originConfirmedBy: "human:carol",
          originConfirmedAt: "2026-07-02T10:00:00.000Z",
        }),
      ])
    );
    expect(body.confirmations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: note.id,
          principal: "system",
          decision: "reconcile",
        }),
      ])
    );

    // Round-trip the exact wire payload through the client loader.
    const { loadMemoryLibrary } = await import("@muon/client/memory-library");
    const snapshot = await loadMemoryLibrary({
      apiBase: "http://brain.local",
      fetcher: (async () =>
        new Response(response.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(
      snapshot.confirmations.some(
        (row) => row.noteId === note.id && row.decision === "reconcile"
      )
    ).toBe(true);
    expect(
      snapshot.imports.some(
        (row) =>
          row.noteId === note.id &&
          row.originWorkspace === "ws-0123456789abcdef" &&
          row.originConfirmedBy === "human:carol"
      )
    ).toBe(true);
  });

  it("chat-scopes every library field while retaining only confirmed global memory", async () => {
    const chatA = await addNote("Chat A decision.", "chat-a");
    const chatB = await addNote("Chat B secret.", "chat-b");
    const unconfirmedGlobalResponse = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(OPERATOR),
      payload: {
        kind: "decision",
        text: "Unconfirmed global draft.",
        modules: ["src/global.ts"],
        topics: ["global"],
        symbols: [],
        scope: "global",
        createdBy: "human:founder",
      },
    });
    expect(unconfirmedGlobalResponse.statusCode).toBe(201);
    const unconfirmedGlobal = unconfirmedGlobalResponse.json().note as {
      id: string;
    };
    const confirmedGlobalResponse = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(OPERATOR),
      payload: {
        kind: "constraint",
        text: "Confirmed global rule.",
        modules: ["src/global.ts"],
        topics: ["global"],
        symbols: [],
        scope: "global",
        createdBy: "human:founder",
      },
    });
    expect(confirmedGlobalResponse.statusCode).toBe(201);
    const confirmedGlobal = confirmedGlobalResponse.json().note as {
      id: string;
    };
    await app.inject({
      method: "PATCH",
      url: `/api/memory/${confirmedGlobal.id}`,
      headers: auth(OPERATOR),
      payload: { confirmed: true, principal: "human:founder" },
    });
    // A relationship with one hidden endpoint must not leak that endpoint id.
    await prisma.memoryEdge.create({
      data: {
        fromId: chatA.id,
        toId: chatB.id,
        kind: "related",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/library?chatId=chat-a&status=all&limit=200",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.notes.map((note: { id: string }) => note.id);
    expect(ids).toContain(chatA.id);
    expect(ids).toContain(confirmedGlobal.id);
    expect(ids).not.toContain(chatB.id);
    expect(ids).not.toContain(unconfirmedGlobal.id);
    expect(body.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: chatA.id, toId: chatB.id }),
      ])
    );
    expect(graphMock.memoryAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-a",
        governedOnly: true,
      })
    );

    // Hidden global drafts must be removed before pagination. If filtering
    // happened after `take`, this newest hidden row would produce an empty page
    // even though the selected chat has visible memory.
    await prisma.memoryNote.update({
      where: { id: unconfirmedGlobal.id },
      data: { updatedAt: new Date("2032-01-01T00:00:00.000Z") },
    });
    await prisma.memoryNote.update({
      where: { id: chatA.id },
      data: { updatedAt: new Date("2031-01-01T00:00:00.000Z") },
    });
    const bounded = await app.inject({
      method: "GET",
      url: "/api/memory/library?chatId=chat-a&status=all&limit=1",
      headers: auth(OPERATOR),
    });
    expect(bounded.statusCode).toBe(200);
    expect(bounded.json().notes).toEqual([
      expect.objectContaining({ id: chatA.id }),
    ]);
    expect(bounded.json().total).toBe(2);
    expect(bounded.json().truncated).toBe(true);
  });
});
