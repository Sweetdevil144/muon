import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const mirrors = () => graphLib.awaitGraphMirrors();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-derivation-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await mirrors();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("TODO 4.8 — note derivation + support-ordered review queue", () => {
  it("stores NULL derivation on legacy ingest and reads it as authored", async () => {
    const result = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Authored fact with no derivation column set at ingest",
      createdBy: "human:founder",
    });
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: result.note.id },
    });
    expect(row?.derivation).toBeNull();
    const library = await ledger.listMemoryLibrary({ q: result.note.text });
    expect(library.notes[0]?.derivation).toBe("authored");
    expect(library.notes[0]?.reviewStatus).toBeNull();
    expect(library.notes[0]?.supportCount).toBe(1);
  });

  it("persists inferred derivation when explicitly supplied at ingest", async () => {
    const result = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Inferred convention reserved for future derivation machinery",
      createdBy: "agent:job:derivation-test",
      derivation: "inferred",
    });
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: result.note.id },
    });
    expect(row?.derivation).toBe("inferred");
    const note = await ledger.getMemoryNote(result.note.id);
    expect(note?.derivation).toBe("inferred");
  });

  it("stamps reviewStatus separately from confirm/reject", async () => {
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(false);
    const result = await ledger.ingestMemoryNote({
      kind: "question",
      text: "Should this note be deferred without a verdict?",
      createdBy: "agent:job:review-stamp",
      chatId: "chat-review-stamp",
    });
    const deferred = await ledger.updateMemoryNote(result.note.id, {
      reviewStatus: "deferred",
    });
    expect(deferred?.reviewStatus).toBe("deferred");
    expect(deferred?.confirmed).toBe(false);
    const row = await db.prisma.memoryNote.findUnique({
      where: { id: result.note.id },
    });
    expect(row?.reviewStatus).toBe("deferred");
    expect(
      await db.prisma.confirmation.count({ where: { noteId: result.note.id } })
    ).toBe(0);
    await settings.setAutoConfirmAgentMemory(true);
  });

  it("orders the unvouched review queue by support count then inferred tier", async () => {
    const settings = await import("../src/lib/operator-settings.js");
    await settings.setAutoConfirmAgentMemory(false);
    const sharedText = "Deploy uses pnpm, not npm, in this repo";
    const workspace = "/tmp/muon-derivation-workspace";
    const sharedHash = ledger.computeMemoryTextHash(sharedText);
    const solo = (
      await ledger.ingestMemoryNote({
        kind: "convention",
        text: "Solo unvouched note with no corroboration",
        chatId: "chat-support-a",
        workspacePath: workspace,
        createdBy: "agent:job:support-solo",
      })
    ).note.id;
    const seedNote = async (args: {
      id: string;
      chatId: string;
      derivation?: "inferred" | "authored";
    }) => {
      await db.prisma.memoryNote.create({
        data: {
          id: args.id,
          kind: "convention",
          text: sharedText,
          textHash: sharedHash,
          workspacePath: workspace,
          chatId: args.chatId,
          createdBy: "agent:job:seed",
          derivation: args.derivation ?? null,
          modules: [],
          topics: [],
          symbols: [],
        },
      });
    };
    await seedNote({
      id: "note-support-inferred",
      chatId: "chat-support-b",
      derivation: "inferred",
    });
    await seedNote({ id: "note-support-c1", chatId: "chat-support-c" });
    await seedNote({ id: "note-support-c2", chatId: "chat-support-d" });
    const inferredLow = "note-support-inferred";
    const corroboratedA = "note-support-c1";
    const corroboratedB = "note-support-c2";

    const queue = await ledger.listMemoryLibrary({
      confirmed: "unvouched",
      workspacePath: workspace,
      orderBy: "supportCount",
      limit: 10,
    });
    const corroborationRows = await db.prisma.memoryNote.count({
      where: {
        textHash: sharedHash,
        status: "active",
        workspacePath: workspace,
      },
    });
    expect(corroborationRows).toBe(3);
    const corroboratedRow = await db.prisma.memoryNote.findUnique({
      where: { id: corroboratedA },
    });
    expect(corroboratedRow?.textHash).toBe(sharedHash);
    const counts = await ledger.computeTextHashSupportCounts([sharedHash], {
      workspacePath: workspace,
    });
    expect(counts.get(sharedHash)).toBe(3);
    const ids = queue.notes.map((note) => note.id);
    expect(ids.indexOf(corroboratedA)).toBeLessThan(ids.indexOf(solo));
    expect(ids.indexOf(corroboratedB)).toBeLessThan(ids.indexOf(solo));
    expect(queue.notes.find((note) => note.id === corroboratedA)?.supportCount).toBe(
      3
    );
    expect(ids.indexOf(inferredLow)).toBeLessThan(ids.indexOf(solo));
    await settings.setAutoConfirmAgentMemory(true);
  });

  it("filters the library by derivation tier", async () => {
    const inferredOnly = await ledger.listMemoryLibrary({
      derivation: "inferred",
      q: "Inferred convention reserved",
    });
    expect(inferredOnly.notes.every((note) => note.derivation === "inferred")).toBe(
      true
    );
    const authoredOnly = await ledger.listMemoryLibrary({
      derivation: "authored",
      q: "Authored fact with no derivation",
    });
    expect(authoredOnly.notes.every((note) => note.derivation === "authored")).toBe(
      true
    );
  });
});
