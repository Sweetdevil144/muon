import Graph from "graphology";
import type {
  MemoryLibraryNote,
  MemoryLibrarySnapshot,
} from "@muon/client/memory-library";
import { memoryNoteTier, type MemoryNoteTier } from "@muon/client/memory-tier";

// Task #131 — Memory graph: force layout + per-node inspector. Renderer-side
// adapter: MemoryLibrarySnapshot -> a graphology graph for the Memory
// workspace's interactive force-directed view. Mirrors graph-adapter.ts's
// shape (pure, no React/canvas — trivially unit-testable) so the graph swap
// keeps the SAME zero-dep sigma + graphology + graphology-layout-forceatlas2
// stack already proven CSP-clean in graph-view.tsx — no new force-graph dep.

export type MemoryNodeKind = "note" | "anchor";
export type MemoryAnchorKind = "module" | "symbol";

export type MemoryGraphNodeAttributes = {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  kind: MemoryNodeKind;
  /**
   * Present (and carries the ENTIRE MemoryLibraryNote — id, kind, text,
   * trust, confirmed, stale, status, modules, symbols, topics, createdBy,
   * createdAt, updatedAt, accessCount, taskId, laneId, scope) only when
   * `kind === "note"` — this IS the "per-node embedded data" the click
   * inspector reads. Untrusted note text is embedded here the same as
   * trusted text: the graph only ever renders a note the caller already
   * decided is in scope (via `showUntrusted`/MemoryWorkspace's existing
   * filter) — this is not a NEW trust boundary, it mirrors the accessible
   * table (memory-workspace.tsx) which has always shown full note text for
   * every row it renders.
   */
  note?: MemoryLibraryNote;
  anchorKind?: MemoryAnchorKind;
  /** Sigma display-data extras the click-selection reducers set. */
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
};

export type MemoryGraphEdgeAttributes = {
  size: number;
  color: string;
  /** "anchor" for a synthesized note→anchor edge, else the snapshot edge's
   *  own `kind` (e.g. "contradicts", "supersedes"). */
  edgeKind: string;
  type: "line";
  zIndex?: number;
};

/** Anchor nodes are synthesized from note coordinates and can otherwise grow
 *  unbounded on a large library — capped for a legible, responsive canvas.
 *  Notes themselves are NEVER capped (every note the caller passed through
 *  `showUntrusted` gets a node — this only bounds the anchor fan-out). */
export const ANCHOR_CAP = 60;

const NOTE_COLOR_TRUSTED = "#3b82f6"; // human-confirmed — the old .confirmed fill
const NOTE_COLOR_STALE = "#f59e0b"; // settled but stale
// P0-3: MUON-vouched — SETTLED, and the crew is already working from it. It used
// to be painted with the untrusted red below, so the graph's own default view
// ("Settled memory") rendered every note in it as a pending proposal — the same
// note the Crew-memory tab calls auto-approved. Matches --success (#3FB37F), the
// green the cards use for exactly this tier.
const NOTE_COLOR_VOUCHED = "#3FB37F";
const NOTE_COLOR_UNTRUSTED = "#ef4444"; // pending/unvouched — the old .untrusted outline
const ANCHOR_COLOR = "#9ca3af";
const EDGE_ANCHOR_COLOR = "#4a4a5a";
const EDGE_CONTRADICTS_COLOR = "#ef4444";
const EDGE_SUPERSEDES_COLOR = "#3b82f6";
const EDGE_DEFAULT_COLOR = "#6b7280";

export function noteNodeId(noteId: string): string {
  return `note:${noteId}`;
}

export function anchorNodeId(kind: MemoryAnchorKind, value: string): string {
  return `anchor:${kind}:${value}`;
}

function noteColor(note: MemoryLibraryNote, tier: MemoryNoteTier): string {
  if (tier === "open") return NOTE_COLOR_UNTRUSTED;
  if (note.stale) return NOTE_COLOR_STALE;
  // "muon" (vouched) and "auto" (crew-visible under the posture) share the
  // crew-memory green, exactly as the cards paint both "· crew memory". The
  // inspector badge and node size keep the finer distinction.
  return tier === "human" ? NOTE_COLOR_TRUSTED : NOTE_COLOR_VOUCHED;
}

function noteLabel(note: MemoryLibraryNote): string {
  return note.text.length > 40 ? `${note.text.slice(0, 37)}…` : note.text;
}

function edgeColorFor(kind: string): string {
  if (kind === "contradicts") return EDGE_CONTRADICTS_COLOR;
  if (kind === "supersedes") return EDGE_SUPERSEDES_COLOR;
  return EDGE_DEFAULT_COLOR;
}

/** ONE definition drives the node-count effect and the graph build alike.
 *
 * Admission is by TIER, from the shared `memoryNoteTier` rule — the same
 * vocabulary the cards, the Crew-memory tab, and the CLI read. This adapter
 * used to keep a private settled rule (`confirmed || confirmedBy ===
 * "orchestrator"`), which never learned the crew-visible "auto" tier: after a
 * mission, the Library showed 13 notes while the graph showed the ONE
 * corroboration-vouched note, filed the other 12 under "pending proposals"
 * red, and counted them in NEITHER bucket of its own header. The default view
 * is the memory the crew is working from: human, muon, and auto tiers;
 * `showUntrusted` adds the genuinely-open proposals. */
export function activeMemoryNotes(
  snapshot: MemoryLibrarySnapshot,
  showUntrusted: boolean,
  autoConfirmAgentMemory: boolean
): MemoryLibraryNote[] {
  return snapshot.notes.filter(
    (note) =>
      note.status === "active" &&
      (showUntrusted ||
        memoryNoteTier(note, autoConfirmAgentMemory) !== "open")
  );
}

/**
 * Builds the graphology graph: one node per active note (embedding the full
 * note), anchor nodes for every distinct module/symbol coordinate (capped —
 * see ANCHOR_CAP), note→anchor edges synthesized from each note's own
 * modules/symbols, and note→note edges from `snapshot.edges` (contradicts/
 * supersedes/…). Positions are seeded on a deterministic ring (index-derived,
 * no RNG), mirroring graph-adapter.ts's buildGraph, so the force layout has a
 * non-degenerate frame to start from.
 */
export function buildMemoryGraph(
  snapshot: MemoryLibrarySnapshot,
  showUntrusted: boolean,
  autoConfirmAgentMemory: boolean
): Graph<MemoryGraphNodeAttributes, MemoryGraphEdgeAttributes> {
  const graph = new Graph<MemoryGraphNodeAttributes, MemoryGraphEdgeAttributes>({
    multi: true,
    type: "undirected",
  });
  const notes = activeMemoryNotes(
    snapshot,
    showUntrusted,
    autoConfirmAgentMemory
  );
  const noteIds = new Set(notes.map((note) => note.id));

  const anchorMeta = new Map<string, { kind: MemoryAnchorKind; value: string }>();
  for (const note of notes) {
    for (const value of note.modules) {
      const id = anchorNodeId("module", value);
      if (!anchorMeta.has(id) && anchorMeta.size < ANCHOR_CAP) {
        anchorMeta.set(id, { kind: "module", value });
      }
    }
    for (const value of note.symbols) {
      const id = anchorNodeId("symbol", value);
      if (!anchorMeta.has(id) && anchorMeta.size < ANCHOR_CAP) {
        anchorMeta.set(id, { kind: "symbol", value });
      }
    }
  }

  const total = Math.max(1, notes.length + anchorMeta.size);
  const radius = Math.max(80, Math.sqrt(total) * 26);
  let seedIndex = 0;
  const seedPosition = () => {
    const angle = (seedIndex / total) * Math.PI * 2;
    seedIndex += 1;
    return {
      x: Math.cos(angle) * radius + (seedIndex % 7) - 3,
      y: Math.sin(angle) * radius + (seedIndex % 5) - 2,
    };
  };

  for (const note of notes) {
    const tier = memoryNoteTier(note, autoConfirmAgentMemory);
    graph.addNode(noteNodeId(note.id), {
      ...seedPosition(),
      // Four tiers, four weights: a human confirm is the heaviest, MUON's
      // vouch next, crew-visible auto next, an open proposal the lightest.
      size:
        tier === "human" ? 9 : tier === "muon" ? 8 : tier === "auto" ? 7 : 6,
      color: noteColor(note, tier),
      label: noteLabel(note),
      kind: "note",
      note,
    });
  }
  for (const [anchorId, meta] of anchorMeta) {
    graph.addNode(anchorId, {
      ...seedPosition(),
      size: 5,
      color: ANCHOR_COLOR,
      label: meta.value,
      kind: "anchor",
      anchorKind: meta.kind,
    });
  }

  const addAnchorEdge = (noteId: string, anchorId: string) => {
    if (!anchorMeta.has(anchorId)) return; // beyond ANCHOR_CAP — no dangling edge
    graph.addEdge(noteId, anchorId, {
      size: 1,
      color: EDGE_ANCHOR_COLOR,
      edgeKind: "anchor",
      type: "line",
    });
  };
  for (const note of notes) {
    const source = noteNodeId(note.id);
    for (const value of note.modules) {
      addAnchorEdge(source, anchorNodeId("module", value));
    }
    for (const value of note.symbols) {
      addAnchorEdge(source, anchorNodeId("symbol", value));
    }
  }

  for (const edge of snapshot.edges) {
    if (!noteIds.has(edge.fromId) || !noteIds.has(edge.toId)) continue;
    try {
      graph.addEdgeWithKey(
        edge.id,
        noteNodeId(edge.fromId),
        noteNodeId(edge.toId),
        {
          size: 1.5,
          color: edgeColorFor(edge.kind),
          edgeKind: edge.kind,
          type: "line",
        }
      );
    } catch {
      // duplicate key across multi-edges: skip, never throw during build
    }
  }

  return graph;
}
