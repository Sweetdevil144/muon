import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const workspacePath = process.cwd();
const chatId = "mission-paused-memory";
const modulePath = "backend/src/lib/memory-paused-fixture.ts";

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-paused-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await graphLib.awaitGraphMirrors();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("TODO 4.10 paused memory", () => {
  it("preserves the verdict while withholding every crew read, including after wipe+replay", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The pause sentinel substrate must remain operator controlled",
      modules: [modulePath],
      workspacePath,
      chatId,
      createdBy: "agent:codex",
    });
    const confirmed = await ledger.updateMemoryNote(created.note.id, {
      confirmed: true,
      principal: "human:operator",
    });
    expect(confirmed).toMatchObject({ confirmed: true, status: "active" });
    await graphLib.awaitGraphMirrors();

    const before = await graphLib.getGraph().searchMemory("pause sentinel substrate", 20, {
      workspacePath,
      chatId,
      governedOnly: true,
    });
    expect(before.map((note) => note.id)).toContain(created.note.id);

    const paused = await ledger.updateMemoryNote(created.note.id, {
      status: "paused",
    });
    expect(paused).toMatchObject({ confirmed: true, status: "paused" });
    await graphLib.awaitGraphMirrors();

    const row = await db.prisma.memoryNote.findUniqueOrThrow({
      where: { id: created.note.id },
    });
    expect(row).toMatchObject({ status: "paused", retiredAt: null, validTo: null });
    expect(
      await db.prisma.confirmation.count({
        where: {
          noteId: created.note.id,
          principal: "human:operator",
          decision: "confirm",
        },
      })
    ).toBe(1);

    const library = await ledger.listMemoryLibrary({
      workspacePath,
      status: "paused",
      showExpired: true,
    });
    expect(library.notes).toHaveLength(1);
    expect(library.notes[0]).toMatchObject({
      id: created.note.id,
      status: "paused",
      confirmed: true,
    });
    const reviewQueue = await ledger.listMemoryLibrary({
      workspacePath,
      confirmed: "unvouched",
      showExpired: true,
    });
    expect(reviewQueue.notes.map((note) => note.id)).not.toContain(created.note.id);

    const mirrored = await graphLib.getGraph().getMemoryNote(created.note.id);
    expect(mirrored).toMatchObject({ status: "paused", confirmed: false });
    for (const options of [
      { workspacePath, chatId },
      { workspacePath, chatId, governedOnly: true },
      {
        workspacePath,
        chatId,
        governedOnly: true,
        crewChatId: chatId,
        trustFloor: "low" as const,
      },
      { workspacePath, chatId, asOf: created.note.createdAt },
    ]) {
      const hidden = await graphLib
        .getGraph()
        .searchMemory("pause sentinel substrate", 20, options);
      expect(hidden.map((note) => note.id)).not.toContain(created.note.id);
    }
    const neighborhood = await graphLib.getGraph().memoryNeighbors(created.note.id, {
      hops: 1,
      workspacePath,
      chatId,
      crewVisible: true,
    });
    expect(
      neighborhood.nodes.find((node) => node.entityId === created.note.id)
    ).not.toHaveProperty("text");

    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);
    await ledger.projectLedgerToGraph();
    expect(await graphLib.getGraph().getMemoryNote(created.note.id)).toMatchObject({
      status: "paused",
      confirmed: false,
    });
    expect(
      await graphLib.getGraph().searchMemory("pause sentinel substrate", 20, {
        workspacePath,
        chatId,
        governedOnly: true,
      })
    ).toEqual([]);

    const resumed = await ledger.updateMemoryNote(created.note.id, {
      status: "active",
    });
    expect(resumed).toMatchObject({ status: "active", confirmed: true });
    await graphLib.awaitGraphMirrors();
    expect(await graphLib.getGraph().getMemoryNote(created.note.id)).toMatchObject({
      status: "active",
      confirmed: true,
    });
    expect(
      (
        await graphLib.getGraph().searchMemory("pause sentinel substrate", 20, {
          workspacePath,
          chatId,
          governedOnly: true,
        })
      ).map((note) => note.id)
    ).toContain(created.note.id);
  }, 30_000);
});
