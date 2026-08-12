import { describe, expect, it, vi } from "vitest";
import { MEMORY_TRAVERSAL_TEXT_POLICY } from "../src/index.js";
import { MuonApiClient } from "../src/api-client.js";
import { GRAPH_MIRROR_FAILED_EVENT_KIND } from "../src/run-bundle.js";
import { loadMemoryLibrary } from "../src/memory-library.js";

// ── ADR-0026 step 3+4 — THE WIRE LAYER ────────────────────────────────────────
//
// This file exists because three mutations walked past every other test in the
// repo. Nothing else covers it: the CLI/TUI/desktop tests mock `MuonApiClient`, so
// they see the OPTIONS a surface passes; the backend tests use `app.inject` with
// literal URLs, so they see the PARAMS a route receives. Between those two sits the
// client, and a defect there is invisible from both sides:
//
//   • the coordinate never reaches the URL → every fenced read silently becomes an
//     unscoped one, and the surface tests still pass because they assert on the
//     options object;
//   • `workspacePath` is missing from a response schema → ZOD STRIPS IT, the §8
//     label is deleted from every row on its way to the surface, and the backend
//     tests still pass because the route did emit it.
//
// The second failure mode is the one this repo has already paid for once:
// `confirmedBy` was omitted from `memoryNoteSchema` and the crew silently went back
// to human-confirmed-only memory with nothing anywhere reporting it.

const NOTE = {
  id: "mem-1",
  kind: "decision",
  text: "Charges are idempotent by request key.",
  modules: ["src/pay/charge.ts"],
  topics: [],
  symbols: [],
  trust: "high",
  confirmed: true,
  stale: false,
  status: "active",
  scope: "project",
  chatId: "chat-a",
  workspacePath: "/Users/dev/SWE/repo-a",
  createdBy: "human",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function jsonFetcher(body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

/** The URL a single-call fetcher was handed. */
function calledUrl(fetcher: ReturnType<typeof jsonFetcher>): URL {
  expect(fetcher).toHaveBeenCalledTimes(1);
  return new URL(String(fetcher.mock.calls[0]![0]));
}

/** A minimal, schema-valid pack-import report. The assertions here are about the
 *  REQUEST, so the response only has to parse. */
const IMPORT_REPORT = {
  origin: { fingerprint: "ws-0123456789abcdef", label: "repo-a" },
  proposed: [],
  duplicates: [],
  duplicatesOfConfirmed: [],
  alreadyImported: [],
  conflicts: [],
  revocations: [],
  refused: [],
  counts: { records: 0 },
};

describe("ADR-0026: the workspace coordinate reaches the URL", () => {
  it("search sends `workspace`, and `unscoped` as its own param", async () => {
    const fenced = jsonFetcher({ notes: [] });
    await new MuonApiClient("http://127.0.0.1:4000", fenced).searchMemory("x", {
      workspace: "/Users/dev/SWE/repo-a",
    });
    expect(calledUrl(fenced).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );

    const residue = jsonFetcher({ notes: [] });
    await new MuonApiClient("http://127.0.0.1:4000", residue).searchMemory("x", {
      unscoped: true,
    });
    const params = calledUrl(residue).searchParams;
    expect(params.get("unscoped")).toBe("true");
    // TWO PARAMS FOR TWO POWERS: the residue view must never be spelled as a
    // reserved `workspace` value, or a directory genuinely named that changes
    // meaning — and the server 400s the pair, so both must never be sent together.
    expect(params.get("workspace")).toBeNull();
  });

  it("recall sends it too — the module-anchored read ADR-0026 exists for", async () => {
    const fetcher = jsonFetcher({ notes: [] });
    await new MuonApiClient("http://127.0.0.1:4000", fetcher).recallMemory({
      module: "src/pay/charge.ts",
      workspace: "/Users/dev/SWE/repo-a",
    });
    expect(calledUrl(fetcher).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );
  });

  it("the traversal reads send it — a provenance walk is a read", async () => {
    const neighbors = jsonFetcher({
      nodes: [],
      edges: [],
      provenance: {
        root: "note:mem-1",
        hops: 1,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    await new MuonApiClient("http://127.0.0.1:4000", neighbors).memoryNeighbors(
      "note:mem-1",
      { workspace: "/Users/dev/SWE/repo-a" }
    );
    expect(calledUrl(neighbors).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );

    const explain = jsonFetcher({
      noteId: "mem-1",
      path: { nodes: [], edges: [], goal: "missing" },
      contradictions: [],
      provenance: {
        root: "note:mem-1",
        hops: 6,
        relations: [],
        truncated: false,
        textPolicy: MEMORY_TRAVERSAL_TEXT_POLICY,
      },
    });
    await new MuonApiClient("http://127.0.0.1:4000", explain).memoryExplain(
      "mem-1",
      { workspace: "/Users/dev/SWE/repo-a" }
    );
    expect(calledUrl(explain).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );
  });

  it("the library loader sends it, through its generic param serializer", async () => {
    const fetcher = jsonFetcher({
      notes: [],
      edges: [],
      confirmations: [],
      total: 0,
      truncated: false,
    });
    await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000/",
      query: { workspace: "/Users/dev/SWE/repo-a" },
      fetcher,
    });
    expect(calledUrl(fetcher).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );
  });

  it("recallRelatedToTask sends it — the runner's brief-seeding traversal", async () => {
    const fetcher = jsonFetcher({ notes: [] });
    await new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher
    ).recallRelatedToTask("task-1", "chat-a", undefined, "/Users/dev/SWE/repo-a");
    expect(calledUrl(fetcher).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );
  });
});

describe("ADR-0026 §8: the LABEL survives the wire schemas (zod strips)", () => {
  it("search and recall carry `workspacePath` onto the returned notes", async () => {
    for (const call of [
      (client: MuonApiClient) => client.searchMemory("x"),
      (client: MuonApiClient) => client.recallMemory({}),
    ]) {
      const fetcher = jsonFetcher({
        notes: [NOTE, { ...NOTE, id: "mem-2", workspacePath: null }],
      });
      const notes = await call(
        new MuonApiClient("http://127.0.0.1:4000", fetcher)
      );
      expect(notes[0]!.workspacePath).toBe("/Users/dev/SWE/repo-a");
      // `null` IS the §8 label ("unassigned"), and it has to arrive as null rather
      // than be stripped into `undefined` by an absent schema key.
      expect(notes[1]!.workspacePath).toBeNull();
    }
  });

  it("the library snapshot carries it — the page §1 measured spanning two repos", async () => {
    const snapshot = await loadMemoryLibrary({
      apiBase: "http://127.0.0.1:4000/",
      fetcher: jsonFetcher({
        notes: [NOTE, { ...NOTE, id: "mem-2", workspacePath: null }],
        edges: [],
        confirmations: [],
        total: 2,
        truncated: false,
      }),
    });
    expect(snapshot.notes[0]!.workspacePath).toBe("/Users/dev/SWE/repo-a");
    expect(snapshot.notes[1]!.workspacePath).toBeNull();
  });

  it("the HERO GATE's memories carry it too", async () => {
    const context = await new MuonApiClient(
      "http://127.0.0.1:4000",
      jsonFetcher({
        target: { module: "src/pay/charge.ts" },
        blastRadius: { modules: ["src/pay/charge.ts"], source: "target-only" },
        memories: [{ ...NOTE, proximity: 1, onTarget: true, onSymbol: false }],
        warnings: [],
        pendingProposals: [],
        activity: [],
        duplicateWork: [],
      })
    ).preEditContext({ module: "src/pay/charge.ts" });
    expect(context.memories[0]!.workspacePath).toBe("/Users/dev/SWE/repo-a");
  });

  it("D4: recall sends the SYMBOL anchor — the finest coordinate, previously writable and unreadable", async () => {
    // The chain is graph → route → client → MCP tool, and it was complete only as
    // far as the route: `MemoryRecallFilter.symbol` and the graph predicate have
    // worked since the symbol tier landed, D4 exposed it on `/recall`, and neither
    // the client nor the MCP tool could send it. A coordinate reachable over HTTP
    // and not from the tool an agent uses is not reachable.
    const fetcher = jsonFetcher({ notes: [] });
    await new MuonApiClient("http://127.0.0.1:4000", fetcher).recallMemory({
      symbol: "src/pay/charge.ts#applyCharge",
      workspace: "/Users/dev/SWE/repo-a",
    });
    const params = calledUrl(fetcher).searchParams;
    expect(params.get("symbol")).toBe("src/pay/charge.ts#applyCharge");
    // And it composes with the workspace fence rather than replacing it — a symbol
    // anchor is workspace-RELATIVE, so an unfenced symbol read is the same
    // cross-repo collision ADR-0026 exists for, one coordinate finer.
    expect(params.get("workspace")).toBe("/Users/dev/SWE/repo-a");
  });

  it("§7 step 5: pack IMPORT sends the receiving workspace as a QUERY param, never in the body", async () => {
    // The gap this closes: step 5 taught the route to stamp the receiving
    // workspace, and no surface could send one — so every CLI-driven import landed
    // in §8's residue, invisible to every agent read and non-exportable.
    //
    // A query param and NOT a body field, asserted here rather than trusted: the
    // body IS the untrusted pack, and the one rule §7 states about these two
    // columns is that the local partition must never be settable by a pack's
    // contents. If it ever moves into the body, this test is the thing that says so.
    const fetcher = jsonFetcher(IMPORT_REPORT);
    const pack = {
      manifest: {
        version: 1,
        origin: { fingerprint: "ws-fedcba9876543210", label: "repo-b" },
        generatedAt: "2026-07-30T00:00:00.000Z",
        counts: { records: 0, tombstones: 0, omitted: 0 },
        omissions: [],
        records: [],
        tombstones: [],
      },
      records: [],
    };
    await new MuonApiClient("http://127.0.0.1:4000", fetcher).importMemoryPack(
      pack as never,
      "/Users/dev/SWE/repo-a"
    );
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(new URL(String(url)).searchParams.get("workspace")).toBe(
      "/Users/dev/SWE/repo-a"
    );
    expect(String(init.body)).not.toContain("/Users/dev/SWE/repo-a");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("workspace");
  });

  it("§7 step 5: omitting it sends NO param, so the note lands in the residue rather than a guessed repo", async () => {
    // Fail-closed, and deliberately not defaulted client-side: a client that
    // substituted its own cwd would be a SECOND evaluator of the partition, and the
    // server's is the only one that validates and reduces.
    const fetcher = jsonFetcher(IMPORT_REPORT);
    await new MuonApiClient("http://127.0.0.1:4000", fetcher).importMemoryPack({
      manifest: {
        version: 1,
        origin: { fingerprint: "ws-fedcba9876543210", label: "repo-b" },
        generatedAt: "2026-07-30T00:00:00.000Z",
        counts: { records: 0, tombstones: 0, omitted: 0 },
        omissions: [],
        records: [],
        tombstones: [],
      },
      records: [],
    } as never);
    expect(String(fetcher.mock.calls[0]![0])).not.toContain("workspace");
  });

  it("listRecentEvents can ask for ONE kind, so the degradation signal stops racing volume", async () => {
    // `memory.graph_mirror_failed` had exactly one consumer — a 50-row poll — and
    // `reportMirrorFailure` coalesces on the stated assumption that an operator
    // surface reading the event log would show it. Once every pre-edit gate read
    // files its own Event, losing that race became the normal case. Asking by name
    // removes the race; omitting the kind stays byte-for-byte the old call.
    const named = jsonFetcher({ events: [] });
    await new MuonApiClient("http://127.0.0.1:4000", named).listRecentEvents(
      1,
      GRAPH_MIRROR_FAILED_EVENT_KIND
    );
    const params = calledUrl(named).searchParams;
    expect(params.get("kind")).toBe("memory.graph_mirror_failed");
    expect(params.get("limit")).toBe("1");

    const plain = jsonFetcher({ events: [] });
    await new MuonApiClient("http://127.0.0.1:4000", plain).listRecentEvents(50);
    expect(calledUrl(plain).searchParams.get("kind")).toBeNull();
  });

  it("an OLDER backend that omits the field reads as unassigned, never as absent", async () => {
    // §5 monotonicity at the wire: a pre-ADR brain sends no `workspacePath`, and the
    // honest reading of that is "nothing was learned about this note's workspace" —
    // which is exactly what the residue label means.
    const { workspacePath: _omitted, ...legacy } = NOTE;
    const notes = await new MuonApiClient(
      "http://127.0.0.1:4000",
      jsonFetcher({ notes: [legacy] })
    ).searchMemory("x");
    expect(notes[0]!.workspacePath ?? null).toBeNull();
  });
});
