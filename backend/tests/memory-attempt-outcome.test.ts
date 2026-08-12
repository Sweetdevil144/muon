import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let settings: typeof import("../src/lib/operator-settings.js");

const mirrors = () => graphLib.awaitGraphMirrors();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-attempt-outcome-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  settings = await import("../src/lib/operator-settings.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await mirrors();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("substrate §3.4 attempt outcomes", () => {
  it("stores outcome on attempt ingest and recalls by kind + outcome + chat", async () => {
    const chatId = `chat-attempt-${Date.now()}`;
    const module = `src/attempt-${Date.now()}.ts`;

    const inserted = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Tried feature flag rollout; rolled back after metrics dip.",
      outcome: "abandoned",
      chatId,
      modules: [module],
      createdBy: "agent:claude-code",
    });
    expect(inserted.action).toBe("inserted");
    expect(inserted.note.outcome).toBe("abandoned");
    await mirrors();

    const recalled = await graphLib.getGraph().recallMemory({
      kind: "attempt",
      outcome: "abandoned",
      chatId,
      module,
    });
    expect(recalled.map((note) => note.id)).toContain(inserted.note.id);
  });

  it("patches outcome on an existing attempt note", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Tried cache warming; latency improved.",
      modules: [`src/warm-${Date.now()}.ts`],
      createdBy: "human:operator",
    });
    const updated = await ledger.updateMemoryNote(created.note.id, {
      outcome: "worked",
    });
    expect(updated?.outcome).toBe("worked");
    await mirrors();
  });

  it("refuses ingest when deny policy matches", async () => {
    await settings.setMemoryIngestPolicy({ deny: ["forbidden-token"], allow: [] });
    expect((await settings.getMemoryIngestPolicy()).deny).toEqual([
      "forbidden-token",
    ]);

    await expect(
      ledger.ingestMemoryNote({
        kind: "attempt",
        text: "Contains forbidden-token in prose.",
        createdBy: "human:operator",
      })
    ).rejects.toThrow(/deny pattern/i);

    await settings.setMemoryIngestPolicy({ deny: [], allow: [] });
  });
});
