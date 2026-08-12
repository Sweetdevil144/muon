import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/**
 * The graph mirror is FIRE-AND-FORGET, so a graph assertion samples a chain
 * nobody awaited. A fixed sleep is the wrong instrument for that: one LadybugDB
 * write costs 30–130ms on a contended host and the clone chain is three of them
 * (clone node → source node → CLONED_FROM edge), so `await settle()` was
 * sampling mid-chain and the suite flaked under load — a test-timing bug that
 * looked exactly like a lost edge. Poll for the eventual state instead, which is
 * what "best-effort mirror" actually promises. Fast in the common case; the
 * assertion that follows still fails honestly if the mirror really dropped it.
 */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-lifecycle-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await settle();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("memory delete, clone, and compaction", () => {
  it("lets an agent tombstone only its own unconfirmed same-chat note", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Try a bounded parser cache.",
      modules: ["lifecycle/delete.ts"],
      createdBy: "agent:codex",
      chatId: "chat-a",
    });

    await expect(
      ledger.deleteMemoryNote(created.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-b",
      })
    ).resolves.toMatchObject({ status: "forbidden" });

    await expect(
      ledger.deleteMemoryNote(created.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-a",
      })
    ).resolves.toEqual({ status: "deleted", noteId: created.note.id });

    const tombstone = await db.prisma.memoryNote.findUnique({
      where: { id: created.note.id },
    });
    expect(tombstone).toMatchObject({ text: "", status: "rejected" });
    expect(tombstone?.textHash).toHaveLength(64);
    expect(tombstone?.modules).toEqual([]);
    expect(
      await db.prisma.memoryAnchor.count({
        where: { noteId: created.note.id },
      })
    ).toBe(0);
    expect(
      await db.prisma.confirmation.findFirst({
        where: { noteId: created.note.id, decision: "delete" },
      })
    ).toMatchObject({ principal: "agent:muon" });

    expect(await graphLib.getGraph().getMemoryNote(created.note.id)).toBeNull();
    await ledger.projectLedgerToGraph();
    expect(await graphLib.getGraph().getMemoryNote(created.note.id)).toBeNull();
    await expect(
      ledger.deleteMemoryNote(created.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-a",
      })
    ).resolves.toEqual({
      status: "already_deleted",
      noteId: created.note.id,
    });
  });

  it("protects confirmed and human-authored notes from the agent tier", async () => {
    const confirmed = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Never expose operator credentials.",
      modules: ["lifecycle/protected.ts"],
      createdBy: "agent:codex",
      chatId: "chat-a",
    });
    await ledger.updateMemoryNote(confirmed.note.id, {
      confirmed: true,
      principal: "human",
    });
    const human = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Keep the control plane loopback-only.",
      modules: ["lifecycle/human.ts"],
      createdBy: "human:operator",
      chatId: "chat-a",
    });

    for (const noteId of [confirmed.note.id, human.note.id]) {
      await expect(
        ledger.deleteMemoryNote(noteId, {
          tier: "agent",
          principal: "agent:muon",
          chatId: "chat-a",
        })
      ).resolves.toMatchObject({ status: "forbidden" });
    }
    await expect(
      ledger.deleteMemoryNote(confirmed.note.id, {
        tier: "operator",
        principal: "human",
      })
    ).resolves.toMatchObject({ status: "deleted" });
  });

  it("clones governed same-chat memory as unconfirmed with CLONED_FROM provenance", async () => {
    // ADR-0026: both the note and the caller carry the SAME workspace, which is
    // what a real install produces (the write path derives it from the
    // capability). This fixture predated the partition and had none at all, so
    // once `cloneMemoryNote` gained its workspace guard it read as a
    // cross-partition clone. Giving it the realistic shape keeps it testing clone
    // SEMANTICS; the guard itself is covered by its own both-directions test.
    const source = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Use one credential broker.",
      modules: ["lifecycle/clone.ts"],
      createdBy: "agent:codex",
      chatId: "chat-a",
      workspacePath: process.cwd(),
    });
    await ledger.updateMemoryNote(source.note.id, {
      confirmed: true,
      principal: "human",
    });

    const cloned = await ledger.cloneMemoryNote(source.note.id, {
      tier: "agent",
      principal: "agent:muon",
      chatId: "chat-a",
      workspacePath: process.cwd(),
      crewVisible: false,
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status !== "cloned") {
      throw new Error(cloned.reason);
    }
    expect(cloned.note).toMatchObject({
      text: source.note.text,
      createdBy: "agent:muon",
      chatId: "chat-a",
      confirmed: false,
      status: "active",
    });
    expect(cloned.note.id).not.toBe(source.note.id);
    expect(
      await db.prisma.memoryEdge.findUnique({
        where: {
          fromId_toId_kind: {
            fromId: cloned.note.id,
            toId: source.note.id,
            kind: "cloned_from",
          },
        },
      })
    ).not.toBeNull();

    const neighborhood = await eventually(
      () =>
        graphLib.getGraph().memoryNeighbors(cloned.note.id, {
          hops: 1,
          relFilter: ["CLONED_FROM"],
          chatId: "chat-a",
          crewVisible: false,
        }),
      (result) => result.edges.length > 0
    );
    expect(neighborhood.edges).toContainEqual({
      from: `note:${cloned.note.id}`,
      to: `note:${source.note.id}`,
      relation: "CLONED_FROM",
    });
    expect(
      neighborhood.nodes.find((node) => node.entityId === cloned.note.id)
    ).not.toHaveProperty("text");

    const unconfirmed = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Try another broker layout.",
      modules: ["lifecycle/clone-pending.ts"],
      createdBy: "agent:codex",
      chatId: "chat-a",
      workspacePath: process.cwd(),
    });
    await expect(
      ledger.cloneMemoryNote(unconfirmed.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-a",
        workspacePath: process.cwd(),
        crewVisible: false,
      })
    ).resolves.toMatchObject({ status: "forbidden" });
    await expect(
      ledger.cloneMemoryNote(unconfirmed.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-a",
        workspacePath: process.cwd(),
        crewVisible: true,
      })
    ).resolves.toMatchObject({ status: "forbidden" });

    await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Try another broker layout.",
      modules: ["lifecycle/clone-pending.ts"],
      createdBy: "agent:claude-code",
      chatId: "chat-a",
      workspacePath: process.cwd(),
    });
    await expect(
      ledger.cloneMemoryNote(unconfirmed.note.id, {
        tier: "agent",
        principal: "agent:muon",
        chatId: "chat-a",
        workspacePath: process.cwd(),
        crewVisible: true,
      })
    ).resolves.toMatchObject({ status: "cloned" });
  });

  it("compacts only old retired superseded or fully-retired contradiction rows", async () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const old = new Date("2026-06-01T12:00:00.000Z");
    const recent = new Date("2026-07-15T12:00:00.000Z");
    const create = async (label: string) =>
      (
        await ledger.ingestMemoryNote({
          kind: "attempt",
          text: `Lifecycle ${label} note`,
          modules: [`lifecycle/${label}.ts`],
          createdBy: "human",
        })
      ).note;

    const successor = await create("successor");
    const predecessor = await create("predecessor");
    const recentPredecessor = await create("recent");
    const contradictionA = await create("contradiction-a");
    const contradictionB = await create("contradiction-b");
    const activePeer = await create("active-peer");
    const retiredAgainstActive = await create("retired-against-active");

    await db.prisma.$transaction([
      db.prisma.memoryNote.update({
        where: { id: predecessor.id },
        data: {
          status: "rejected",
          supersededBy: successor.id,
          retiredAt: old,
          validTo: old,
        },
      }),
      db.prisma.memoryEdge.create({
        data: {
          fromId: successor.id,
          toId: predecessor.id,
          kind: "supersedes",
        },
      }),
      db.prisma.memoryNote.update({
        where: { id: recentPredecessor.id },
        data: {
          status: "rejected",
          supersededBy: successor.id,
          retiredAt: recent,
          validTo: recent,
        },
      }),
      db.prisma.memoryEdge.create({
        data: {
          fromId: successor.id,
          toId: recentPredecessor.id,
          kind: "supersedes",
        },
      }),
      ...[contradictionA.id, contradictionB.id, retiredAgainstActive.id].map(
        (id) =>
          db.prisma.memoryNote.update({
            where: { id },
            data: {
              status: "rejected",
              retiredAt: old,
              validTo: old,
            },
          })
      ),
      db.prisma.memoryEdge.create({
        data: {
          fromId: contradictionA.id,
          toId: contradictionB.id,
          kind: "contradicts",
        },
      }),
      db.prisma.memoryEdge.create({
        data: {
          fromId: retiredAgainstActive.id,
          toId: activePeer.id,
          kind: "contradicts",
        },
      }),
    ]);

    const result = await ledger.compactMemory(30, now);
    expect(result.noteIds).toEqual(
      [predecessor.id, contradictionA.id, contradictionB.id].sort()
    );
    expect(result.tombstoned).toBe(3);

    const rows = await db.prisma.memoryNote.findMany({
      where: {
        id: {
          in: [
            predecessor.id,
            recentPredecessor.id,
            contradictionA.id,
            contradictionB.id,
            activePeer.id,
            retiredAgainstActive.id,
          ],
        },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(predecessor.id)?.text).toBe("");
    expect(byId.get(contradictionA.id)?.text).toBe("");
    expect(byId.get(contradictionB.id)?.text).toBe("");
    expect(byId.get(recentPredecessor.id)?.text).not.toBe("");
    expect(byId.get(activePeer.id)?.status).toBe("active");
    expect(byId.get(retiredAgainstActive.id)?.text).not.toBe("");
  });
});
