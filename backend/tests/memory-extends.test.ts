import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-extends-"));
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

describe("TODO 4.9 additive memory extensions", () => {
  it("keeps both facts active and restores the EXTENDS edge after a graph wipe", async () => {
    const module = "backend/src/lib/memory-extension-fixture.ts";
    const prior = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Use the SQLite ledger as the source of truth for memory",
      modules: [module],
      workspacePath: process.cwd(),
      chatId: "mission-extends",
      createdBy: "human:operator",
    });
    const detail = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Use the SQLite ledger as the source of truth for memory and preserve relation history",
      modules: [module],
      workspacePath: process.cwd(),
      chatId: "mission-extends",
      createdBy: "agent:codex",
    });

    expect(detail).toMatchObject({
      action: "extended",
      relatedNoteId: prior.note.id,
    });
    const rows = await db.prisma.memoryNote.findMany({
      where: { id: { in: [prior.note.id, detail.note.id] } },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "active")).toBe(true);
    expect(rows.every((row) => row.retiredAt === null)).toBe(true);
    expect(rows.every((row) => row.supersededBy === null)).toBe(true);
    expect(
      await db.prisma.memoryEdge.findUnique({
        where: {
          fromId_toId_kind: {
            fromId: detail.note.id,
            toId: prior.note.id,
            kind: "extends",
          },
        },
      })
    ).not.toBeNull();
    expect(
      await db.prisma.confirmation.findFirst({
        where: { noteId: detail.note.id, decision: "reconcile" },
      })
    ).toMatchObject({ principal: "system" });

    await graphLib.awaitGraphMirrors();
    const live = await graphLib.getGraph().memoryNeighbors(detail.note.id, {
      hops: 1,
      relFilter: ["EXTENDS"],
      workspacePath: process.cwd(),
      chatId: "mission-extends",
      crewVisible: true,
    });
    expect(live.edges).toContainEqual({
      from: `note:${detail.note.id}`,
      to: `note:${prior.note.id}`,
      relation: "EXTENDS",
    });
    const explanation = await graphLib.getGraph().memoryExplain(detail.note.id, {
      workspacePath: process.cwd(),
      chatId: "mission-extends",
      crewVisible: true,
    });
    // The derived relation is inspectable, but it cannot make the new detail
    // borrow the prior note's human provenance before a person approves it.
    expect(explanation.provenance.relations).not.toContain("EXTENDS");
    expect(explanation.provenance.relations).toHaveLength(12);

    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);

    await ledger.projectLedgerToGraph();
    const restored = await graphLib.getGraph().memoryNeighbors(detail.note.id, {
      hops: 1,
      relFilter: ["EXTENDS"],
      workspacePath: process.cwd(),
      chatId: "mission-extends",
      crewVisible: true,
    });
    expect(restored.edges).toContainEqual({
      from: `note:${detail.note.id}`,
      to: `note:${prior.note.id}`,
      relation: "EXTENDS",
    });
  }, 30_000);
});
