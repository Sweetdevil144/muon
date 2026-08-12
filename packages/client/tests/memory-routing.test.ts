import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "../src/types.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const note = {
  id: "mem-1",
  kind: "decision",
  text: "Use fuzzy palette",
  taskId: null,
  laneId: null,
  modules: ["apps/tui/src/lib/palette.ts"],
  topics: ["tui"],
  trust: "medium",
  confirmed: false,
  stale: false,
  status: "active",
  createdBy: "human",
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

describe("MuonApiClient memory + routing", () => {
  it("adds a memory note", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ note }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const created = await client.addMemoryNote({
      kind: "decision",
      text: "Use fuzzy palette",
      modules: ["apps/tui/src/lib/palette.ts"],
      topics: ["tui"],
      createdBy: "human",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory",
      expect.objectContaining({ method: "POST" })
    );
    expect(created.id).toBe("mem-1");
    expect(created.kind).toBe("decision");
  });

  it("preserves the non-destructive extended write verdict", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ note, action: "extended", relatedNoteId: "mem-prior" })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const created = await client.addMemoryNoteWithAction({
      kind: "decision",
      text: "Use fuzzy palette and preserve keyboard history",
      modules: ["apps/tui/src/lib/palette.ts"],
      createdBy: "agent:codex",
    });

    expect(created).toMatchObject({
      action: "extended",
      relatedNoteId: "mem-prior",
    });
  });

  it("searches and recalls notes", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ notes: [note] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const found = await client.searchMemory("fuzzy palette");
    // URLSearchParams encodes spaces as "+" (form-urlencoded); Fastify's
    // fast-querystring parser decodes "+"→space, so this is server-equivalent
    // to %20. (KG-5 switched to URLSearchParams to carry asOf/scope params.)
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/search?q=fuzzy+palette",
      expect.anything()
    );
    expect(found).toHaveLength(1);

    const recalled = await client.recallMemory({ topic: "tui" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/memory/recall?topic=tui",
      expect.anything()
    );
    expect(recalled[0]?.topics).toEqual(["tui"]);
  });

  it("updates a note (confirm/reject)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ note: { ...note, confirmed: true } }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const updated = await client.updateMemoryNote({
      noteId: "mem-1",
      confirmed: true,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/mem-1",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(updated.confirmed).toBe(true);
  });

  it("reads bounded memory neighbors through the allowlisted wire schema", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        nodes: [
          {
            id: "note:mem-1",
            entityId: "mem-1",
            type: "note",
            kind: "decision",
            trust: "high",
            confirmed: true,
            text: "Use fuzzy palette",
            title: "must be stripped",
          },
        ],
        edges: [],
        provenance: {
          root: "note:mem-1",
          hops: 2,
          relations: ["EXTENDS"],
          truncated: false,
          textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.memoryNeighbors("mem/1", {
      hops: 2,
      relations: ["EXTENDS"],
      limit: 20,
      chatId: "chat-a",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/neighbors/mem%2F1?hops=2&relations=EXTENDS&limit=20&chatId=chat-a",
      expect.anything()
    );
    expect(result.nodes[0]?.text).toBe("Use fuzzy palette");
    expect(result.nodes[0]).not.toHaveProperty("title");
  });

  it("reads a governed memory explanation", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        noteId: "mem-1",
        path: {
          nodes: [
            {
              id: "note:mem-1",
              entityId: "mem-1",
              type: "note",
              kind: "decision",
              trust: "medium",
              confirmed: false,
            },
          ],
          edges: [],
          goal: "note",
        },
        contradictions: [],
        provenance: {
          root: "note:mem-1",
          hops: 6,
          relations: [],
          truncated: false,
          textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.memoryExplain("mem-1", {
      chatId: "chat-a",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/explain/mem-1?chatId=chat-a",
      expect.anything()
    );
    expect(result.path.goal).toBe("note");
    expect(result.path.nodes[0]).not.toHaveProperty("text");
  });

  it("uses coordinate-only lifecycle routes for delete and clone", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          noteId: "mem-1",
          deleted: true,
          alreadyDeleted: false,
          text: "strip me",
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          noteId: "mem-clone",
          clonedFromNoteId: "mem-1",
          confirmed: false,
          text: "strip me too",
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const deletion = await client.deleteMemoryNote("mem-1", {
      chatId: "chat-a",
      createdBy: "codex",
    });
    const clone = await client.cloneMemoryNote("mem-1", {
      chatId: "chat-a",
      createdBy: "codex",
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/api/memory/mem-1?chatId=chat-a",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/api/memory/mem-1/clone",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chatId: "chat-a" }),
      })
    );
    expect(deletion).not.toHaveProperty("text");
    expect(clone).not.toHaveProperty("text");
  });

  it("loads chat-scoped analytics and promotes through the operator route", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          noteScores: [],
          hotModules: [],
          communities: [],
          source: { notes: 0, modules: 0, edges: 0, truncated: false },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          noteId: "mem/1",
          scope: "global",
          promoted: true,
          alreadyGlobal: false,
          text: "strip me",
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.memoryAnalytics({ chatId: "chat-a", limit: 75 });
    const promoted = await client.promoteMemoryToGlobal("mem/1");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/api/memory/analytics?chatId=chat-a&limit=75",
      expect.anything()
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/api/memory/mem%2F1/promote-global",
      expect.objectContaining({ method: "POST" })
    );
    expect(promoted).not.toHaveProperty("text");
  });

  it("configures and runs bounded memory compaction", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ retentionDays: 45 }))
      .mockResolvedValueOnce(
        mockResponse({
          retentionDays: 45,
          cutoff: "2026-06-06T00:00:00.000Z",
          scanned: 3,
          tombstoned: 2,
          noteIds: ["mem-a", "mem-b"],
          dryRun: false,
          batchId: "batch-compact-1",
          reason: null,
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    expect(await client.setMemoryCompactionRetentionDays(45)).toBe(45);
    expect(await client.compactMemory()).toMatchObject({
      retentionDays: 45,
      tombstoned: 2,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/api/memory/settings/memory-compaction-retention",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ retentionDays: 45 }),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/api/memory/compact",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      })
    );
  });

  it("fetches ranked lane suggestions", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        suggestions: [
          {
            laneId: "lane-1",
            laneKey: "codex",
            laneName: "Codex",
            score: 4.5,
            reason: "2/2 assignments completed",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const suggestions = await client.suggestLanes("task-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/routing/suggest?taskId=task-1",
      expect.anything()
    );
    expect(suggestions[0]?.reason).toContain("completed");
  });
});

// ── L2: the traversal text policy is a CONTRACT, not a decorative label ───────
//
// The label has been wrong twice and corrected twice. `confirmed-or-crew-visible`
// stopped being true when R3 TTL began withholding a lapsed unconfirmed note's
// text; the label then carried `unmined` while F9 also withheld model-extracted
// prose, and lost it again when that exclusion was removed (mined notes now ride
// the operator's crew posture like any other agent note). Either way a consumer
// reading a stale label learns something false about why prose was or was not
// returned, so the client REFUSES an unrecognised one rather than guessing.
describe("memory traversal text policy", () => {
  it("REJECTS a payload carrying a stale policy label", async () => {
    // A backend still announcing the old policy is a backend whose text gate we
    // cannot reason about, so the client refuses the payload rather than
    // rendering prose under a contract it no longer honours.
    for (const stale of [
      // Pre-TTL.
      "confirmed-or-crew-visible",
      // The F9 era: a backend still announcing this one withholds mined text,
      // which the current client would render as "no prose exists".
      "confirmed-or-unexpired-unmined-crew-visible",
    ]) {
      const fetcher = vi.fn().mockResolvedValue(
        mockResponse({
          nodes: [],
          edges: [],
          provenance: {
            root: "note:mem-1",
            hops: 1,
            relations: [],
            truncated: false,
            textPolicy: stale,
          },
        })
      );
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      await expect(client.memoryNeighbors("mem-1")).rejects.toThrow();
    }
  });

  // P0-2 — the vouch has to SURVIVE THE WIRE. `memoryNoteSchema` is a zod
  // object, so it silently STRIPS any key it does not declare: with
  // `confirmedBy` missing, every recall response arrived with the field deleted,
  // `renderMemorySlice` (which admits a human confirm OR an orchestrator vouch)
  // never saw a vouch, and the crew went on coordinating from human-confirmed
  // memory alone — with no error raised anywhere. There is no way to notice that
  // from either end, which is why the guard lives here.
  it("carries `confirmedBy` through recall instead of stripping it", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        notes: [{ ...note, confirmedBy: "orchestrator" }],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const [recalled] = await client.recallRelatedToTask("task-1", "chat-1");
    expect(recalled?.confirmed).toBe(false);
    expect(recalled?.confirmedBy).toBe("orchestrator");
  });

  it("reads an older backend's omission as `nobody has vouched`, never as a vouch", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ notes: [note] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const [recalled] = await client.recallRelatedToTask("task-1", "chat-1");
    expect(recalled?.confirmedBy).toBeNull();
  });

  it("carries the preview-bound lifecycle migration over the wire", async () => {
    const policy = {
      version: 1 as const,
      trustCeiling: "medium" as const,
      daysByKind: {
        decision: 90,
        constraint: 90,
        convention: 90,
        attempt: 30,
        question: 7,
      },
      permanentWhenConfirmedByKind: {
        decision: true as const,
        constraint: true as const,
        convention: true as const,
        attempt: true as const,
        question: true as const,
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          source: "kind_table",
          legacyFallbackDays: null,
          policy,
          recommended: policy,
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          policy,
          previousSource: "kind_table",
          dryRun: false,
          applied: true,
          previewDigest: "a".repeat(64),
          scanned: 3,
          changed: 2,
          wouldHideNow: 1,
          wouldRestoreNow: 0,
          wouldBecomePermanent: 0,
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    expect((await client.getMemoryLifecyclePolicy()).source).toBe("kind_table");
    const applied = await client.migrateMemoryLifecyclePolicy(policy, {
      dryRun: false,
      previewDigest: "a".repeat(64),
    });
    expect(applied.applied).toBe(true);
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:4000/api/memory/settings/memory-lifecycle/migrate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          policy,
          dryRun: false,
          previewDigest: "a".repeat(64),
        }),
      })
    );
  });

  it("labels used signals and parses text-free access cohorts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ buffered: 1 }, 202))
      .mockResolvedValueOnce(
        mockResponse({
          rowsScanned: 3,
          distinctNotes: 2,
          retainedPerNote: 128,
          truncated: false,
          firstAccessAt: "2026-07-01T10:00:00.000Z",
          lastAccessAt: "2026-07-01T10:01:00.000Z",
          byType: [
            {
              accessType: "preedit_gate",
              accessedUnconfirmedNotes: 2,
              laterHumanConfirmedNotes: 1,
              confirmationRate: 0.5,
            },
          ],
          interpretation: "association_not_causation",
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.markMemoryUsed(["mem-1"], "preedit_gate");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://localhost:4000/api/memory/used",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          noteIds: ["mem-1"],
          accessType: "preedit_gate",
        }),
      })
    );
    const analytics = await client.memoryAccessAnalytics({
      workspace: "/ws/a",
      limit: 100,
    });
    expect(analytics.interpretation).toBe("association_not_causation");
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4000/api/memory/analytics/access-types?workspace=%2Fws%2Fa&limit=100",
      expect.any(Object)
    );
  });

  it("pins the mirror to @muon/graph's constant (drift canary)", async () => {
    // @muon/client is browser-safe and takes NO graph dependency, so the policy
    // literal is MIRRORED rather than imported. If this fails, @muon/graph
    // changed the wire contract: update packages/client/src/types.ts (and every
    // consumer the closed union then breaks) before touching this assertion.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const graphTypes = readFileSync(
      resolve(import.meta.dirname, "../../graph/src/types.ts"),
      "utf8"
    );
    expect(graphTypes).toContain(
      `export const MEMORY_TRAVERSAL_TEXT_POLICY =\n  "${MEMORY_TRAVERSAL_TEXT_POLICY}" as const;`
    );
  });
});
