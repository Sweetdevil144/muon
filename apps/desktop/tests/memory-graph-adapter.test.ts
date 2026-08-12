import { describe, expect, it } from "vitest";
import type { MemoryLibrarySnapshot } from "@muon/client/memory-library";
import {
  ANCHOR_CAP,
  activeMemoryNotes,
  anchorNodeId,
  buildMemoryGraph,
  noteNodeId,
} from "../src/renderer/lib/memory-graph-adapter.js";

// Task #131 — Memory graph: force layout + per-node inspector. These tests
// exercise the PURE graph-model builder (no React/canvas), the same split
// graph-adapter.test.ts uses for the GitNexus graph.

function baseSnapshot(
  overrides: Partial<MemoryLibrarySnapshot> = {}
): MemoryLibrarySnapshot {
  return {
    notes: [
      {
        id: "mem-trusted",
        kind: "decision",
        text: "Use the streaming parser for large payloads.",
        taskId: "task-1",
        laneId: "lane-1",
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
        accessCount: 3,
      },
      {
        id: "mem-stale",
        kind: "convention",
        text: "Legacy retry policy — likely superseded.",
        modules: ["src/parser.ts"],
        topics: [],
        symbols: [],
        trust: "medium",
        confirmed: true,
        stale: true,
        status: "active",
        scope: "project",
        createdBy: "agent:codex",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
        accessCount: 0,
      },
      {
        id: "mem-pending",
        kind: "constraint",
        text: "Do not change parser tokenization.",
        modules: ["src/parser.ts"],
        topics: ["parser"],
        symbols: [],
        trust: "medium",
        confirmed: false,
        stale: false,
        status: "active",
        scope: "project",
        createdBy: "agent:claude-code",
        createdAt: "2026-07-16T01:00:00.000Z",
        updatedAt: "2026-07-16T01:00:00.000Z",
        accessCount: 0,
      },
      {
        id: "mem-rejected",
        kind: "attempt",
        text: "Rejected proposal, must never surface.",
        modules: ["src/parser.ts"],
        topics: [],
        symbols: [],
        trust: "low",
        confirmed: false,
        stale: false,
        status: "rejected",
        scope: "project",
        createdBy: "agent:cursor",
        createdAt: "2026-07-16T02:00:00.000Z",
        updatedAt: "2026-07-16T02:00:00.000Z",
        accessCount: 0,
      },
    ],
    edges: [
      {
        id: "edge-1",
        fromId: "mem-pending",
        toId: "mem-trusted",
        kind: "contradicts",
        weight: null,
        at: "2026-07-16T01:00:00.000Z",
      },
    ],
    confirmations: [],
    imports: [],
    total: 4,
    truncated: false,
    ...overrides,
  } as MemoryLibrarySnapshot;
}

describe("activeMemoryNotes", () => {
  it("excludes rejected notes and, by default, unconfirmed ones", () => {
    const notes = activeMemoryNotes(baseSnapshot(), false, false);
    expect(notes.map((n) => n.id).sort()).toEqual(["mem-stale", "mem-trusted"]);
  });

  it("includes unconfirmed (pending) notes when showUntrusted is true, still excluding rejected", () => {
    const notes = activeMemoryNotes(baseSnapshot(), true, false);
    expect(notes.map((n) => n.id).sort()).toEqual([
      "mem-pending",
      "mem-stale",
      "mem-trusted",
    ]);
  });
});

describe("buildMemoryGraph — per-node embedded data", () => {
  it("embeds the ENTIRE MemoryLibraryNote on its node (id, text, trust, confirmed, stale, status, coordinates, author, timestamps, taskId, laneId, scope, accessCount)", () => {
    const snapshot = baseSnapshot();
    const graph = buildMemoryGraph(snapshot, false, false);
    const trustedNote = snapshot.notes[0]!;
    const id = noteNodeId(trustedNote.id);
    expect(graph.hasNode(id)).toBe(true);
    const attrs = graph.getNodeAttributes(id);
    expect(attrs.kind).toBe("note");
    expect(attrs.note).toEqual(trustedNote);
  });

  it("colors a trusted node blue, a stale-but-confirmed node amber, and an untrusted node red", () => {
    const graph = buildMemoryGraph(baseSnapshot(), true, false);
    expect(graph.getNodeAttribute(noteNodeId("mem-trusted"), "color")).toBe(
      "#3b82f6"
    );
    expect(graph.getNodeAttribute(noteNodeId("mem-stale"), "color")).toBe(
      "#f59e0b"
    );
    expect(graph.getNodeAttribute(noteNodeId("mem-pending"), "color")).toBe(
      "#ef4444"
    );
  });

  // P0-3 — the canvas has to agree with the words above it. This graph's DEFAULT
  // view is titled "Settled memory" and admits MUON-vouched notes, yet painted
  // every one of them with the UNVOUCHED red — so the crew's settled, in-use
  // knowledge rendered as a wall of pending proposals one tab over from a card
  // that calls it auto-approved.
  it("paints a MUON-vouched note as settled, never with the unvouched red", () => {
    const snapshot = baseSnapshot({
      notes: [
        {
          ...baseSnapshot().notes[2]!,
          id: "mem-vouched",
          confirmed: false,
          confirmedBy: "orchestrator",
        },
        {
          ...baseSnapshot().notes[2]!,
          id: "mem-open",
          confirmed: false,
          confirmedBy: null,
        },
      ],
    } as Partial<MemoryLibrarySnapshot>);
    const graph = buildMemoryGraph(snapshot, true, false);
    expect(graph.getNodeAttribute(noteNodeId("mem-vouched"), "color")).toBe(
      "#3FB37F"
    );
    expect(graph.getNodeAttribute(noteNodeId("mem-open"), "color")).toBe(
      "#ef4444"
    );
    // Four tiers, four weights — a human confirm still outranks MUON's vouch,
    // which outranks crew-auto, which outranks an open proposal.
    expect(graph.getNodeAttribute(noteNodeId("mem-vouched"), "size")).toBe(8);
    expect(graph.getNodeAttribute(noteNodeId("mem-open"), "size")).toBe(6);
    expect(
      buildMemoryGraph(baseSnapshot(), false, false).getNodeAttribute(
        noteNodeId("mem-trusted"),
        "size"
      )
    ).toBe(9);
  });

  it("keeps a lapsed vouch OUT of the settled palette — nothing vouches for it now", () => {
    const snapshot = baseSnapshot({
      notes: [
        {
          ...baseSnapshot().notes[2]!,
          id: "mem-lapsed",
          confirmed: false,
          confirmedBy: "orchestrator",
          expired: true,
        },
      ],
    } as Partial<MemoryLibrarySnapshot>);
    const graph = buildMemoryGraph(snapshot, true, false);
    expect(graph.getNodeAttribute(noteNodeId("mem-lapsed"), "color")).toBe(
      "#ef4444"
    );
    // …and it is not admitted to the default "Settled memory" view at all.
    expect(activeMemoryNotes(snapshot, false, false)).toHaveLength(0);
  });

  it("never creates a node for a rejected note, even with showUntrusted", () => {
    const graph = buildMemoryGraph(baseSnapshot(), true, false);
    expect(graph.hasNode(noteNodeId("mem-rejected"))).toBe(false);
  });

  it("respects the showUntrusted filter — no node for a pending note by default", () => {
    const graph = buildMemoryGraph(baseSnapshot(), false, false);
    expect(graph.hasNode(noteNodeId("mem-pending"))).toBe(false);
    expect(graph.hasNode(noteNodeId("mem-trusted"))).toBe(true);
  });
});

// Mission 420c8bf4 aftermath: the Library showed 13 notes while this graph
// showed ONE — its private settled rule never learned the crew-visible "auto"
// tier, so 12 in-use crew notes were admitted to NEITHER view state and both
// header counts read past them. Admission now rides the shared memoryNoteTier.
describe("buildMemoryGraph — crew-visible auto tier (posture on)", () => {
  const autoSnapshot = () =>
    baseSnapshot({
      notes: [
        baseSnapshot().notes[0]!, // human-confirmed
        {
          ...baseSnapshot().notes[2]!,
          id: "mem-auto",
          confirmed: false,
          confirmedBy: null,
        },
      ],
    } as Partial<MemoryLibrarySnapshot>);

  it("admits an unvouched agent note to the DEFAULT view when the posture is on", () => {
    const notes = activeMemoryNotes(autoSnapshot(), false, true);
    expect(notes.map((n) => n.id).sort()).toEqual(["mem-auto", "mem-trusted"]);
    // …and paints it with the crew green, never the pending red.
    const graph = buildMemoryGraph(autoSnapshot(), false, true);
    expect(graph.getNodeAttribute(noteNodeId("mem-auto"), "color")).toBe(
      "#3FB37F"
    );
    expect(graph.getNodeAttribute(noteNodeId("mem-auto"), "size")).toBe(7);
  });

  it("posture OFF keeps the strict view: the same note is pending again", () => {
    const notes = activeMemoryNotes(autoSnapshot(), false, false);
    expect(notes.map((n) => n.id)).toEqual(["mem-trusted"]);
    const graph = buildMemoryGraph(autoSnapshot(), true, false);
    expect(graph.getNodeAttribute(noteNodeId("mem-auto"), "color")).toBe(
      "#ef4444"
    );
  });

  it("a human-authored unconfirmed note is never auto-tier — posture or not", () => {
    const snapshot = baseSnapshot({
      notes: [
        {
          ...baseSnapshot().notes[2]!,
          id: "mem-human-draft",
          confirmed: false,
          createdBy: "human",
        },
      ],
    } as Partial<MemoryLibrarySnapshot>);
    expect(activeMemoryNotes(snapshot, false, true)).toHaveLength(0);
  });
});

describe("buildMemoryGraph — anchors and edges", () => {
  it("creates an anchor node per distinct module/symbol coordinate, with note→anchor edges", () => {
    const graph = buildMemoryGraph(baseSnapshot(), false, false);
    const moduleAnchor = anchorNodeId("module", "src/parser.ts");
    const symbolAnchor = anchorNodeId("symbol", "src/parser.ts#parse");
    expect(graph.hasNode(moduleAnchor)).toBe(true);
    expect(graph.getNodeAttribute(moduleAnchor, "anchorKind")).toBe("module");
    expect(graph.hasNode(symbolAnchor)).toBe(true);
    expect(
      graph.hasEdge(noteNodeId("mem-trusted"), moduleAnchor) ||
        graph.hasEdge(moduleAnchor, noteNodeId("mem-trusted"))
    ).toBe(true);
    expect(
      graph.hasEdge(noteNodeId("mem-trusted"), symbolAnchor) ||
        graph.hasEdge(symbolAnchor, noteNodeId("mem-trusted"))
    ).toBe(true);
  });

  it("synthesizes note→note edges from snapshot.edges only when BOTH endpoints are in scope", () => {
    // showUntrusted:false drops mem-pending, so edge-1 (mem-pending -> mem-trusted)
    // must NOT appear — one endpoint is out of scope.
    const trustedOnly = buildMemoryGraph(baseSnapshot(), false, false);
    expect(
      trustedOnly.hasEdge(noteNodeId("mem-pending"), noteNodeId("mem-trusted")) ||
        trustedOnly.edges().includes("edge-1")
    ).toBe(false);

    const withPending = buildMemoryGraph(baseSnapshot(), true, false);
    expect(withPending.hasEdge("edge-1")).toBe(true);
    expect(
      withPending.hasEdge(noteNodeId("mem-pending"), noteNodeId("mem-trusted"))
    ).toBe(true);
  });

  it("caps anchor nodes at ANCHOR_CAP and skips edges to anchors beyond the cap (no dangling edges)", () => {
    const notes = Array.from({ length: ANCHOR_CAP + 20 }, (_, index) => ({
      id: `mem-${index}`,
      kind: "decision" as const,
      text: `Decision ${index}.`,
      modules: [`src/module-${index}.ts`],
      topics: [],
      symbols: [],
      trust: "high" as const,
      confirmed: true,
      stale: false,
      status: "active" as const,
      scope: "project",
      createdBy: "agent:codex",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      accessCount: 0,
    }));
    const snapshot = baseSnapshot({
      notes,
      edges: [],
      total: notes.length,
    });
    const graph = buildMemoryGraph(snapshot, false, false);

    const anchorNodes = graph
      .nodes()
      .filter((id) => graph.getNodeAttribute(id, "kind") === "anchor");
    expect(anchorNodes.length).toBe(ANCHOR_CAP);

    // Every note still gets its own node (notes are NEVER capped) — only the
    // synthesized anchor fan-out is bounded.
    const noteNodes = graph
      .nodes()
      .filter((id) => graph.getNodeAttribute(id, "kind") === "note");
    expect(noteNodes.length).toBe(notes.length);

    // No edge dangles to a module beyond the cap.
    for (const edgeId of graph.edges()) {
      const [source, target] = graph.extremities(edgeId);
      expect(graph.hasNode(source)).toBe(true);
      expect(graph.hasNode(target)).toBe(true);
    }
  });

  it("gives every node a finite, non-degenerate seeded position (a starting frame for the force layout)", () => {
    const graph = buildMemoryGraph(baseSnapshot(), true, false);
    graph.forEachNode((_id, attrs) => {
      expect(Number.isFinite(attrs.x)).toBe(true);
      expect(Number.isFinite(attrs.y)).toBe(true);
    });
  });
});
