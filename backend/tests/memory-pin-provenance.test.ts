import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { memoryPassesGate } from "@muon/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const OPERATOR = "operator-memory-pin";
const AGENT = "agent-memory-pin";
const JOB_TOKEN = `job-memory-pin-${"a".repeat(48)}`;
const JOB_ID = "job-memory-pin";
const CHAT_ID = "chat-memory-pin";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let workspace: string;
let app: FastifyInstance;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-pin-"));
  workspace = path.join(dir, "repo");
  mkdirSync(workspace, { recursive: true });
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
      id: JOB_ID,
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-memory-pin",
      brief: "learn a governed memory",
      workspacePath: workspace,
      chatId: CHAT_ID,
      status: "running",
      dispatchedBy: "human",
      action: "review-pr",
    },
  });
  await db.prisma.delegationGrant.create({
    data: {
      jobId: JOB_ID,
      tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.awaitGraphMirrors();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  delete process.env.MUON_WORKSPACE_ROOTS;
  rmSync(dir, { recursive: true, force: true });
});

describe("TODO 4.21 memory provenance, pinning, and forgetting", () => {
  it("derives job provenance and keeps pin authority in the ledger", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_TOKEN),
      payload: {
        kind: "constraint",
        text: "Keep launch checks bounded and replayable.",
        modules: ["src/launch.ts"],
        createdBy: "human:forged",
        chatId: CHAT_ID,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdNote = created.json().note as {
      id: string;
      createdBy: string;
      pinned: boolean;
      provenance: {
        sourceType: string;
        rawRef: string | null;
        createdAt: string;
      };
    };
    expect(createdNote).toMatchObject({
      createdBy: `agent:job:${JOB_ID}`,
      pinned: false,
      provenance: { sourceType: "job", rawRef: `job:${JOB_ID}` },
    });
    expect(Number.isNaN(Date.parse(createdNote.provenance.createdAt))).toBe(false);

    const episode = await db.prisma.episode.findFirst({
      where: { rawRef: `job:${JOB_ID}` },
    });
    expect(episode).toMatchObject({ sourceType: "job" });

    const refused = await app.inject({
      method: "PATCH",
      url: `/api/memory/${createdNote.id}`,
      headers: auth(AGENT),
      payload: { pinned: true },
    });
    expect(refused.statusCode).toBe(403);

    const pinned = await app.inject({
      method: "PATCH",
      url: `/api/memory/${createdNote.id}`,
      headers: auth(OPERATOR),
      payload: { pinned: true },
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json().note).toMatchObject({
      id: createdNote.id,
      pinned: true,
      expiresAt: null,
      confirmed: false,
    });
    expect(
      await db.prisma.confirmation.findFirst({
        where: { noteId: createdNote.id, decision: "pin" },
      })
    ).toMatchObject({ principal: "human" });

    // Re-introduce the exact side-effect class pin must defeat: a stale deadline
    // in the durable row while the graph still carries the earlier projection.
    await db.prisma.memoryNote.update({
      where: { id: createdNote.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await ledger.projectLedgerToGraph();
    const projected = await graphLib.getGraph().getMemoryNote(createdNote.id);
    expect(projected).not.toBeNull();
    const [governed] = await ledger.applyMemoryExpiry([projected!]);
    expect(governed).toMatchObject({ pinned: true, expired: false });
    // Pin is retention protection, not a trust promotion or gate bypass.
    expect(memoryPassesGate(governed!, { governedOnly: true })).toBe(false);

    const protectedDelete = await app.inject({
      method: "DELETE",
      url: `/api/memory/${createdNote.id}`,
      headers: auth(OPERATOR),
    });
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.body).toContain("Unpin");

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/memory/${createdNote.id}`,
      headers: auth(OPERATOR),
      payload: { text: "Keep launch checks bounded, replayable, and measured." },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const successor = edited.json().note as {
      id: string;
      pinned: boolean;
      provenance: { sourceType: string; rawRef: string | null };
    };
    expect(successor).toMatchObject({
      pinned: true,
      provenance: { sourceType: "edit", rawRef: `note:${createdNote.id}` },
    });

    const compactWhilePinned = await ledger.compactMemory(
      1,
      new Date(Date.now() + 2 * 24 * 60 * 60_000)
    );
    expect(compactWhilePinned.noteIds).not.toContain(createdNote.id);
    expect(
      await db.prisma.memoryNote.findUnique({ where: { id: createdNote.id } })
    ).toMatchObject({ text: "Keep launch checks bounded and replayable." });

    for (const noteId of [createdNote.id, successor.id]) {
      const unpinned = await app.inject({
        method: "PATCH",
        url: `/api/memory/${noteId}`,
        headers: auth(OPERATOR),
        payload: { pinned: false },
      });
      expect(unpinned.statusCode, unpinned.body).toBe(200);
      expect(unpinned.json().note.pinned).toBe(false);
    }

    const compactAfterUnpin = await ledger.compactMemory(
      1,
      new Date(Date.now() + 2 * 24 * 60 * 60_000)
    );
    expect(compactAfterUnpin.noteIds).toContain(createdNote.id);

    const forgotten = await app.inject({
      method: "DELETE",
      url: `/api/memory/${successor.id}`,
      headers: auth(OPERATOR),
    });
    expect(forgotten.statusCode, forgotten.body).toBe(200);
    expect(forgotten.json()).toMatchObject({
      noteId: successor.id,
      deleted: true,
      alreadyDeleted: false,
    });
    expect(
      await db.prisma.memoryNote.findUnique({ where: { id: successor.id } })
    ).toMatchObject({ text: "", status: "rejected" });
    expect(await graphLib.getGraph().getMemoryNote(successor.id)).toBeNull();

    // The Confirmation table carries more than confirm/reject. Pin verdicts
    // must be neutral to a pre-existing human confirmation in both live reads
    // and a graph rebuild.
    const durable = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Publish only after the governed launch review passes.",
      modules: ["src/release.ts"],
      createdBy: "agent:codex",
      chatId: CHAT_ID,
      workspacePath: workspace,
    });
    await ledger.updateMemoryNote(durable.note.id, {
      confirmed: true,
      principal: "human",
    });
    const durablePinned = await ledger.updateMemoryNote(durable.note.id, {
      pinned: true,
      principal: "human",
    });
    expect(durablePinned).toMatchObject({
      confirmed: true,
      confirmedBy: "human",
      pinned: true,
    });
    const durableUnpinned = await ledger.updateMemoryNote(durable.note.id, {
      pinned: false,
      principal: "human",
    });
    expect(durableUnpinned).toMatchObject({
      confirmed: true,
      confirmedBy: "human",
      pinned: false,
      expiresAt: null,
    });
    await ledger.projectLedgerToGraph();
    expect(await graphLib.getGraph().getMemoryNote(durable.note.id)).toMatchObject({
      confirmed: true,
    });

    // A first pin can arrive in the same request as a text correction. That
    // transaction must persist the named human principal before its pin verdict;
    // an earlier implementation only did so on the non-text PATCH path.
    const firstPinOnEdit = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Run the launch rehearsal once.",
      createdBy: "agent:codex",
      chatId: CHAT_ID,
      workspacePath: workspace,
    });
    const correctedAndPinned = await ledger.updateMemoryNote(
      firstPinOnEdit.note.id,
      {
        text: "Run the launch rehearsal twice.",
        pinned: true,
        principal: "human:editor",
      }
    );
    expect(correctedAndPinned).toMatchObject({ pinned: true, expiresAt: null });
    expect(
      await db.prisma.principal.findFirst({
        where: { displayName: "editor", kind: "human" },
      })
    ).toMatchObject({ displayName: "editor", kind: "human" });
    expect(
      await db.prisma.confirmation.findFirst({
        where: { noteId: correctedAndPinned!.id, decision: "pin" },
      })
    ).toMatchObject({ principal: "human:editor" });

    // Nullable episodeId exists only for legacy compatibility. A damaged or
    // pre-backfill residue still returns honest row-derived provenance instead
    // of making the UI's "Saved from" explanation disappear.
    await db.prisma.memoryNote.update({
      where: { id: firstPinOnEdit.note.id },
      data: { episodeId: null },
    });
    const legacyRead = await app.inject({
      method: "GET",
      url: `/api/memory/${firstPinOnEdit.note.id}?chatId=${CHAT_ID}`,
      headers: auth(OPERATOR),
    });
    expect(legacyRead.statusCode, legacyRead.body).toBe(200);
    expect(legacyRead.json().note.provenance).toMatchObject({
      sourceType: "agent",
      rawRef: null,
    });
  }, 30_000);
});
