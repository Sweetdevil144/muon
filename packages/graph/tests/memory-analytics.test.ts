import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CENTRALITY_PRIOR_WEIGHT,
  DEFAULT_CALIBRATED_WEIGHTS,
  analyzeMemoryGraph,
  explainCalibratedScore,
  MuonGraph,
} from "../src/index.js";
import type { MemoryNoteRecord } from "../src/types.js";

function note(id: string): MemoryNoteRecord {
  return {
    id,
    kind: "decision",
    text: `text-${id}`,
    taskId: null,
    laneId: null,
    modules: [],
    topics: [],
    symbols: [],
    trust: "medium",
    confirmed: true,
    stale: false,
    status: "active",
    scope: "project",
    createdBy: "human",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    validFrom: "2026-07-20T00:00:00.000Z",
    invalidatedAt: null,
    invalidatedBy: null,
    staleSince: null,
    supersededBy: null,
    accessCount: 0,
    lastAccessedAt: null,
    conflictsWith: null,
  };
}

describe("memory graph analytics", () => {
  it("finds deterministic load-bearing notes/modules and communities", () => {
    const input = [
      { id: "bridge", modules: ["src/core.ts", "src/api.ts"] },
      { id: "core-a", modules: ["src/core.ts"] },
      { id: "core-b", modules: ["src/core.ts"] },
      { id: "ui-a", modules: ["src/ui.ts"] },
      { id: "ui-b", modules: ["src/ui.ts"] },
    ];

    const first = analyzeMemoryGraph(input);
    const second = analyzeMemoryGraph([...input].reverse());

    expect(second).toEqual(first);
    expect(first.source).toEqual({
      notes: 5,
      modules: 3,
      edges: 6,
      truncated: false,
    });
    expect(first.hotModules[0]).toMatchObject({
      module: "src/core.ts",
      noteCount: 3,
    });
    expect(first.noteScores.find((row) => row.noteId === "bridge")!.score).toBeGreaterThan(
      first.noteScores.find((row) => row.noteId === "core-a")!.score
    );
    expect(first.communities.length).toBeGreaterThanOrEqual(2);
  });

  it("is coordinates-and-scalars only", () => {
    const serialized = JSON.stringify(
      analyzeMemoryGraph([
        {
          id: "mem-safe",
          modules: ["src/poison.ts"],
        },
      ])
    );

    expect(serialized).toContain("mem-safe");
    expect(serialized).toContain("src/poison.ts");
    expect(serialized).not.toContain("ignore prior instructions");
    expect(Object.keys(analyzeMemoryGraph([]))).toEqual([
      "noteScores",
      "hotModules",
      "communities",
      "source",
    ]);
  });

  it("bounds hostile fan-out per note and reports truncation", () => {
    const analytics = analyzeMemoryGraph([
      {
        id: "mem-wide",
        modules: Array.from({ length: 300 }, (_, index) => `src/${index}.ts`),
      },
    ]);

    expect(analytics.source.edges).toBe(128);
    expect(analytics.source.modules).toBe(128);
    expect(analytics.source.truncated).toBe(true);
    expect(analytics.hotModules).toHaveLength(12);
  });

  it("KG-12: the centrality prior is OFF by default — a load-bearing note scores identically", () => {
    // The prior used to fire unconditionally. The graph-value ablation measured
    // it and it LOST at every width profile (nDCG −0.0141 / MRR −0.0313 at the
    // shipped defaults) while never adding a candidate, so it was cut from
    // DEFAULT_CALIBRATED_WEIGHTS. This pins that the cut is real: passing a
    // maximal centrality now changes nothing at all.
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const base = explainCalibratedScore(
      { note: note("ranked"), relevance: 0.5 },
      DEFAULT_CALIBRATED_WEIGHTS,
      now
    );
    const loadBearing = explainCalibratedScore(
      { note: note("ranked"), relevance: 0.5, centrality: 1 },
      DEFAULT_CALIBRATED_WEIGHTS,
      now
    );

    expect(base.centrality).toBe(0);
    expect(loadBearing.centrality).toBe(0);
    expect(loadBearing.total).toBe(base.total);
    expect(loadBearing.governanceApplied).toBe(base.governanceApplied);
  });

  it("KG-12: the prior is retained as an OPT-IN weight so the ablation stays reproducible", () => {
    // The constant and the code path survive deliberately — the eval's
    // `+centrality` arm needs them to reproduce the disqualifying number, and a
    // future corpus should be able to re-argue for the prior with evidence.
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const opted = explainCalibratedScore(
      { note: note("ranked"), relevance: 0.5, centrality: 1 },
      { ...DEFAULT_CALIBRATED_WEIGHTS, centralityPrior: CENTRALITY_PRIOR_WEIGHT },
      now
    );
    const base = explainCalibratedScore(
      { note: note("ranked"), relevance: 0.5 },
      DEFAULT_CALIBRATED_WEIGHTS,
      now
    );
    expect(opted.centrality).toBeCloseTo(CENTRALITY_PRIOR_WEIGHT, 12);
    expect(opted.total - base.total).toBeCloseTo(CENTRALITY_PRIOR_WEIGHT, 12);
    // The breakdown SHAPE is unchanged either way, so existing "why this memory"
    // readers keep working and simply render a zero contribution.
    expect(Object.keys(opted).sort()).toEqual(Object.keys(base).sort());
  });

  it("loads bounded analytics from the real graph with confirmed-global chat visibility", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-memory-analytics-"));
    const graph = new MuonGraph(join(dir, "analytics.lbug"), {
      disableFts: true,
    });
    try {
      const global = await graph.addMemoryNote({
        kind: "decision",
        text: "Promoted global lesson",
        chatId: "chat-a",
        scope: "global",
        modules: ["src/global.ts"],
        createdBy: "human",
      });
      await graph.updateMemoryNote(global.id, { confirmed: true });
      await graph.addMemoryNote({
        kind: "attempt",
        text: "Private chat note",
        chatId: "chat-a",
        modules: ["src/private.ts"],
        createdBy: "agent:codex",
      });

      const analytics = await graph.memoryAnalytics({
        chatId: "chat-b",
        governedOnly: true,
      });
      expect(analytics.noteScores.map((row) => row.noteId)).toEqual([global.id]);
      expect(analytics.hotModules.map((row) => row.module)).toEqual([
        "src/global.ts",
      ]);
      expect(
        (await graph.searchMemory("Promoted global", 20, { chatId: "chat-b" }))
          .map((row) => row.id)
      ).toContain(global.id);
      expect(
        (
          await graph.searchMemory("Promoted global", 20, {
            chatId: "chat-b",
            asOf: new Date(Date.now() + 1_000).toISOString(),
          })
        ).map((row) => row.id)
      ).not.toContain(global.id);
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts only durably corroborated notes in the crew-visible analytics arm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muon-memory-analytics-vouch-"));
    const graph = new MuonGraph(join(dir, "analytics-vouch.lbug"), {
      disableFts: true,
    });
    try {
      const human = {
        ...note("human"),
        chatId: "chat-crew",
        modules: ["src/human.ts"],
      };
      const singleWriter = {
        ...note("single-writer"),
        chatId: "chat-crew",
        modules: ["src/single.ts"],
        confirmed: false,
        createdBy: "agent:job:a",
      };
      const corroborated = {
        ...note("corroborated"),
        chatId: "chat-crew",
        modules: ["src/corroborated.ts"],
        confirmed: false,
        confirmedBy: "orchestrator" as const,
        createdBy: "agent:job:b",
      };
      await graph.projectMemoryNote(human);
      await graph.projectMemoryNote(singleWriter);
      await graph.projectMemoryNote(corroborated);

      const analytics = await graph.memoryAnalytics({
        chatId: "chat-crew",
        governedOnly: true,
        crewChatId: "chat-crew",
        crewVouchedOnly: true,
      });
      expect(analytics.noteScores.map((row) => row.noteId).sort()).toEqual([
        "corroborated",
        "human",
      ]);
      expect(analytics.hotModules.map((row) => row.module)).not.toContain(
        "src/single.ts"
      );
    } finally {
      await graph.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
