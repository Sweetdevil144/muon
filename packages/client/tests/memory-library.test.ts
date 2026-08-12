import { describe, expect, it, vi } from "vitest";
import {
  loadMemoryAnalytics,
  loadMemoryLibrary,
} from "../src/memory-library.js";

describe("memory library client", () => {
  it("loads the bounded operator snapshot with filters and credentials", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          notes: [
            {
              id: "mem-1",
              kind: "decision",
              text: "Use the streaming parser.",
              modules: ["src/parser.ts"],
              topics: ["parser"],
              symbols: ["src/parser.ts#parse"],
              trust: "high",
              confirmed: true,
              stale: false,
              status: "active",
              scope: "project",
              createdBy: "agent:codex",
              createdAt: "2026-07-16T00:00:00.000Z",
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          edges: [],
          confirmations: [],
          total: 1,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const snapshot = await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000/",
      apiToken: "operator-token",
      query: {
        q: "parser",
        chatId: "chat-a",
        status: "all",
        confirmed: "confirmed",
        limit: 75,
      },
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/memory/library?q=parser&chatId=chat-a&status=all&confirmed=confirmed&limit=75",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer operator-token",
        }),
      })
    );
    expect(snapshot.notes[0]).toMatchObject({
      id: "mem-1",
      confirmed: true,
      symbols: ["src/parser.ts#parse"],
    });
    // Back-compat: an old snapshot without `imports` still parses (defaults []).
    expect(snapshot.imports).toEqual([]);
    expect(snapshot.analytics.hotModules).toEqual([]);
    // R3 back-compat: a pre-TTL backend omits both expiry fields, which must
    // read as "this note never expires" rather than failing the parse.
    expect(snapshot.notes[0]).toMatchObject({ expired: false });
    expect(snapshot.notes[0]!.expiresAt).toBeUndefined();
  });

  it("serializes the R5 filter as JSON and show_expired as a scalar", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          notes: [],
          edges: [],
          confirmations: [],
          total: 0,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000",
      query: {
        showExpired: true,
        filter: {
          and: [
            { field: "kind", op: "eq", value: "decision" },
            { field: "text", op: "icontains", value: "parser" },
          ],
        },
      },
      fetcher,
    });

    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toContain("showExpired=true");
    // Structured, so it must ride as JSON — `String(object)` would have sent
    // "[object Object]" and silently dropped every predicate.
    expect(decodeURIComponent(url)).toContain(
      '{"and":[{"field":"kind","op":"eq","value":"decision"},{"field":"text","op":"icontains","value":"parser"}]}'
    );
  });

  it("round-trips the paused operator-only library state", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          notes: [
            {
              id: "mem-paused",
              kind: "constraint",
              text: "Keep this out of crew context for now.",
              modules: [],
              topics: [],
              symbols: [],
              trust: "high",
              confirmed: true,
              stale: false,
              status: "paused",
              scope: "project",
              createdBy: "human:operator",
              createdAt: "2026-07-16T00:00:00.000Z",
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          edges: [],
          confirmations: [],
          total: 1,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const snapshot = await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000",
      query: { status: "paused" },
      fetcher,
    });
    expect(String(fetcher.mock.calls[0]![0])).toContain("status=paused");
    expect(snapshot.notes[0]).toMatchObject({
      id: "mem-paused",
      status: "paused",
      confirmed: true,
    });
  });

  // P1.4 Slice 3 — the snapshot schema must accept system "reconcile"
  // provenance rows (the ledger's KG-6 conflict marker, also written by pack
  // tombstones; a closed confirm/reject enum failed any conflicted brain) and
  // the additive `imports` provenance array.
  it("parses reconcile provenance rows and import provenance", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          notes: [],
          edges: [],
          confirmations: [
            {
              id: "conf-1",
              noteId: "mem-2",
              principal: "system",
              decision: "reconcile",
              at: "2026-07-16T00:00:00.000Z",
            },
          ],
          imports: [
            {
              id: "imp-1",
              noteId: "mem-2",
              originWorkspace: "ws-0123456789abcdef",
              originLabel: "repo",
              originNoteId: "mem-origin-1",
              recordHash: "a".repeat(64),
              textHash: "b".repeat(64),
              disposition: "proposed",
              originAuthor: "human:carol",
              originConfirmedBy: "human:carol",
              originConfirmedAt: "2026-07-02T10:00:00.000Z",
              importedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          total: 0,
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const snapshot = await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000",
      fetcher,
    });
    expect(snapshot.confirmations[0]).toMatchObject({
      principal: "system",
      decision: "reconcile",
    });
    expect(snapshot.imports[0]).toMatchObject({
      noteId: "mem-2",
      originWorkspace: "ws-0123456789abcdef",
      originLabel: "repo",
      disposition: "proposed",
      originAuthor: "human:carol",
      originConfirmedBy: "human:carol",
    });
  });

  it("loads coordinate-only analytics with the trusted chat scope", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          noteScores: [
            {
              noteId: "mem-1",
              score: 0.75,
              degree: 2,
              communityId: "community-1",
              text: "must be stripped",
            },
          ],
          hotModules: [
            {
              module: "src/core.ts",
              score: 1,
              noteCount: 2,
              communityId: "community-1",
              text: "must be stripped",
            },
          ],
          communities: [
            { id: "community-1", noteCount: 1, moduleCount: 1 },
          ],
          source: { notes: 1, modules: 1, edges: 2, truncated: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const analytics = await loadMemoryAnalytics({
      apiBase: "http://127.0.0.1:4000/",
      apiToken: "agent-token",
      chatId: "chat-a",
      limit: 50,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/memory/analytics?chatId=chat-a&limit=50",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer agent-token",
        }),
      })
    );
    expect(analytics.hotModules[0]).toEqual({
      module: "src/core.ts",
      score: 1,
      noteCount: 2,
      communityId: "community-1",
    });
    expect(analytics.hotModules[0]).not.toHaveProperty("text");
  });
});
