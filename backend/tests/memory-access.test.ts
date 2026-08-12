import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let access: typeof import("../src/lib/memory-access.js");

const T0 = new Date("2026-07-01T10:00:00.000Z");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-memory-access-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  db = await import("../src/lib/db.js");
  access = await import("../src/lib/memory-access.js");
  await db.ensureSchema();

  for (const [id, workspacePath] of [
    ["mem-access-convert", "/ws/a"],
    ["mem-access-stays", "/ws/a"],
    ["mem-access-other", "/ws/b"],
    ["mem-access-cap", "/ws/cap"],
  ] as const) {
    await db.prisma.memoryNote.create({
      data: {
        id,
        kind: "decision",
        text: `${id} text`,
        textHash: `${id}-hash`,
        createdBy: "agent:codex",
        workspacePath,
        modules: [],
        topics: [],
        symbols: [],
      },
    });
  }
});

afterAll(async () => {
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("TODO 4.12 typed, bounded memory access evidence", () => {
  it("keeps ranking neutral, bounds rows in SQLite, and measures later human confirmation by type", async () => {
    const context = {
      principal: "agent:codex",
      taskId: "task-a",
      jobId: "job-a",
      missionId: "chat-a",
    };
    await access.appendMemoryAccesses(
      ["mem-access-convert", "mem-access-convert"],
      "explicit_recall",
      context,
      T0
    );
    await access.appendMemoryAccesses(
      ["mem-access-stays"],
      "preedit_gate",
      context,
      T0
    );
    await access.appendMemoryAccesses(
      ["mem-access-other"],
      "brief_injection",
      context,
      T0
    );

    const first = await db.prisma.memoryAccess.findFirstOrThrow({
      where: { noteId: "mem-access-convert" },
    });
    expect(first).toMatchObject({
      accessType: "explicit_recall",
      principal: "agent:codex",
      taskId: "task-a",
      jobId: "job-a",
      missionId: "chat-a",
      workspacePath: "/ws/a",
    });
    // The typed ledger is evidence only. The decayed graph/ledger reinforcement
    // path is still the sole writer of this ranking counter.
    expect(
      (
        await db.prisma.memoryNote.findUniqueOrThrow({
          where: { id: "mem-access-convert" },
        })
      ).accessCount
    ).toBe(0);

    const confirmedAt = new Date(T0.getTime() + 1_000);
    await db.prisma.confirmation.createMany({
      data: ["mem-access-convert", "mem-access-other"].map((noteId) => ({
        id: `${noteId}-confirm`,
        noteId,
        principal: "human:operator",
        decision: "confirm",
        at: confirmedAt,
      })),
    });
    await db.prisma.confirmation.create({
      data: {
        id: "mem-access-convert-pin",
        noteId: "mem-access-convert",
        principal: "human:operator",
        decision: "pin",
        at: new Date(T0.getTime() + 1_500),
      },
    });
    // Delivery after confirmation cannot make its own denominator look good.
    await access.appendMemoryAccesses(
      ["mem-access-convert"],
      "brief_injection",
      context,
      new Date(T0.getTime() + 2_000)
    );

    const workspaceA = await access.getMemoryAccessAnalytics({
      workspacePath: "/ws/a",
    });
    expect(workspaceA.byType).toEqual(
      expect.arrayContaining([
        {
          accessType: "explicit_recall",
          accessedUnconfirmedNotes: 1,
          laterHumanConfirmedNotes: 1,
          confirmationRate: 1,
        },
        {
          accessType: "preedit_gate",
          accessedUnconfirmedNotes: 1,
          laterHumanConfirmedNotes: 0,
          confirmationRate: 0,
        },
        {
          accessType: "brief_injection",
          accessedUnconfirmedNotes: 0,
          laterHumanConfirmedNotes: 0,
          confirmationRate: null,
        },
      ])
    );
    expect(workspaceA.interpretation).toBe("association_not_causation");

    const workspaceB = await access.getMemoryAccessAnalytics({
      workspacePath: "/ws/b",
    });
    expect(
      workspaceB.byType.find((row) => row.accessType === "brief_injection")
    ).toMatchObject({
      accessedUnconfirmedNotes: 1,
      laterHumanConfirmedNotes: 1,
      confirmationRate: 1,
    });

    for (let index = 0; index < 130; index += 1) {
      await access.appendMemoryAccesses(
        ["mem-access-cap"],
        "legacy_used",
        { principal: "agent:legacy" },
        new Date(T0.getTime() + index * 1_000)
      );
    }
    expect(
      await db.prisma.memoryAccess.count({
        where: { noteId: "mem-access-cap" },
      })
    ).toBe(128);
    const oldestRetained = await db.prisma.memoryAccess.findFirstOrThrow({
      where: { noteId: "mem-access-cap" },
      orderBy: [{ accessedAt: "asc" }, { id: "asc" }],
    });
    expect(oldestRetained.accessedAt.toISOString()).toBe(
      new Date(T0.getTime() + 2_000).toISOString()
    );
    // EXPLICIT BUDGET. This test ran against vitest's 5000ms default and was
    // the source of an intermittent full-suite failure — measured at 5008ms
    // once, then 1475/1475 across six later runs and 3/3 in isolation. It is a
    // scheduling fact under a loaded parallel run, not a behaviour change: it
    // writes and reads a real SQLite ledger, which is legitimately slower when
    // the other 126 files are competing for the same disk. Named and bounded
    // rather than retried, the same way the corpus replays in apps/tui were.
  }, 30_000);
});
