import Graph from "graphology";
import type {
  GitNexusGraphData,
  GitNexusGraphNode,
} from "../../shared/ipc.js";

// Renderer-side adapter: the flat IPC graph → a graphology graph carrying the
// same Sigma attribute contract GitNexus's own GraphCanvas renders (node
// color/size by label, curved edges colored by relationship type). Kept lean
// (force layout only) but faithful to the sigma + @sigma/edge-curve stack.
//
// The node/edge color+size tables below are PORTED from GitNexus OSS
// (github.com/abhigyanpatwari/GitNexus, gitnexus-web/src/lib/constants.ts —
// NODE_COLORS / NODE_SIZES / EDGE_INFO, and graph-adapter.ts's EDGE_STYLES +
// getScaledNodeSize) so MUON's graph reads like GitNexus's own: same kind→hue
// mapping, same relative size hierarchy, same edge palette for the six
// canonical relationship types. OSS's own canvas is ALSO near-black (`bg-void`,
// a `#06060a`→`#0a0a10` radial gradient — see GraphCanvas.tsx), so no light→dark
// re-theme was needed for the base palette; dim/bright mixing below targets
// MUON's exact `--bg` (#141414) instead of OSS's canvas hex.

export type SigmaNodeAttributes = {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeType: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /** Sigma display-data extras the click-selection nodeReducer sets. */
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
};

export type SigmaEdgeAttributes = {
  size: number;
  color: string;
  relationType: string;
  type: "curved";
  curvature: number;
  /** Sigma display-data extra the click-selection edgeReducer sets. */
  zIndex?: number;
};

/** Node fill by NodeLabel — ported verbatim from GitNexus OSS's
 * gitnexus-web/src/lib/constants.ts `NODE_COLORS` (kind → hue). `BasicBlock`
 * is OSS's taint/PDG substrate label; kept for parity even though MUON's
 * current schema rarely emits it. Unknown labels fall back to OSS's own
 * per-node fallback (`NODE_COLORS[label] || '#9ca3af'`). */
const NODE_COLORS: Record<string, string> = {
  Project: "#a855f7",
  Package: "#8b5cf6",
  Module: "#7c3aed",
  Namespace: "#7c3aed",
  Folder: "#6366f1",
  File: "#3b82f6",
  Class: "#f59e0b",
  Struct: "#f59e0b",
  Record: "#f59e0b",
  Interface: "#ec4899",
  Trait: "#ec4899",
  Enum: "#f97316",
  Union: "#f97316",
  Enum_: "#f97316",
  Impl: "#14b8a6",
  Method: "#14b8a6",
  Delegate: "#14b8a6",
  Function: "#10b981",
  Constructor: "#10b981",
  Macro: "#eab308",
  Decorator: "#eab308",
  Annotation: "#eab308",
  Variable: "#64748b",
  Const: "#64748b",
  Static: "#64748b",
  Property: "#64748b",
  CodeElement: "#64748b",
  Type: "#a78bfa",
  TypeAlias: "#a78bfa",
  Typedef: "#a78bfa",
  Template: "#a78bfa",
  Import: "#475569",
  BasicBlock: "#475569",
  Community: "#818cf8",
  Process: "#f43f5e",
  Route: "#f43f5e",
  Section: "#60a5fa",
  Tool: "#a855f7",
};

/** Base node radius by NodeLabel — ported verbatim from OSS's `NODE_SIZES`
 * (a deliberately DRAMATIC structural hierarchy: Project > Package > Module/
 * Namespace > Folder > Class-ish > File > Function-ish > Method-ish > leaf
 * values > Import). NOT degree-based — OSS sizes purely by symbol kind. */
const NODE_SIZES: Record<string, number> = {
  Project: 20,
  Package: 16,
  Module: 13,
  Namespace: 13,
  Folder: 10,
  Class: 8,
  Struct: 8,
  Record: 8,
  Section: 8,
  Interface: 7,
  Trait: 7,
  Enum: 5,
  Union: 5,
  Enum_: 5,
  Route: 5,
  Tool: 5,
  File: 6,
  Function: 4,
  Constructor: 4,
  Method: 3,
  Impl: 3,
  TypeAlias: 3,
  Typedef: 3,
  Delegate: 3,
  Template: 3,
  Type: 3,
  Variable: 2,
  Const: 2,
  Static: 2,
  Property: 2,
  Decorator: 2,
  Macro: 2,
  Annotation: 2,
  CodeElement: 2,
  BasicBlock: 2,
  Import: 1.5,
  Community: 0, // hidden by default — metadata node (OSS parity)
  Process: 0, // hidden by default — metadata node (OSS parity)
};

/** Edge color by relationship type. The six canonical types (+ the two
 * Kotlin/Java hierarchy aliases) are OSS's exact `EDGE_INFO`/`EDGE_STYLES`
 * hues (gitnexus-web/src/lib/constants.ts + graph-adapter.ts). MUON's graph
 * carries additional relationship types OSS has no equivalent for (USES,
 * MEMBER_OF, HANDLES_ROUTE, …); those keep distinct hues chosen to sit
 * alongside the OSS palette without colliding, echoed to the matching OSS
 * NODE hue where one exists (e.g. HANDLES_TOOL ≈ the Tool node's purple). */
export const EDGE_COLORS: Record<string, string> = {
  CONTAINS: "#2d5a3d",
  DEFINES: "#0e7490",
  IMPORTS: "#1d4ed8",
  CALLS: "#7c3aed",
  EXTENDS: "#c2410c",
  INHERITS: "#c2410c",
  IMPLEMENTS: "#be185d",
  METHOD_IMPLEMENTS: "#be185d",
  HAS_METHOD: "#0e7490", // ≈ DEFINES (Kotlin/Java Class→Method hierarchy)
  HAS_PROPERTY: "#2d5a3d", // ≈ CONTAINS (Kotlin/Java Class→Property hierarchy)
  METHOD_OVERRIDES: "#fca5a5",
  USES: "#94a3b8",
  ACCESSES: "#94a3b8",
  DECORATES: "#f0abfc",
  MEMBER_OF: "#818cf8",
  STEP_IN_PROCESS: "#f43f5e", // matches the Process node hue
  HANDLES_ROUTE: "#fb7185",
  HANDLES_TOOL: "#a855f7", // matches the Tool node hue
  FETCHES: "#38bdf8",
  ENTRY_POINT_OF: "#f59e0b",
  WRAPS: "#a78bfa", // matches the Type/TypeAlias node hue
  QUERIES: "#2dd4bf",
};

export function nodeColor(label: string): string {
  return NODE_COLORS[label] ?? "#9ca3af";
}

export function nodeSize(label: string): number {
  return NODE_SIZES[label] ?? 8;
}

/**
 * Density-scale a base node size down for large graphs — ported verbatim
 * (thresholds + multipliers) from OSS's `getScaledNodeSize`. Preserves the
 * relative type hierarchy while keeping a big graph's canvas legible.
 */
export function scaledNodeSize(baseSize: number, nodeCount: number): number {
  if (nodeCount > 50000) return Math.max(1, baseSize * 0.4);
  if (nodeCount > 20000) return Math.max(1.5, baseSize * 0.5);
  if (nodeCount > 5000) return Math.max(2, baseSize * 0.65);
  if (nodeCount > 1000) return Math.max(2.5, baseSize * 0.8);
  return baseSize;
}

export function edgeColor(type: string): string {
  return EDGE_COLORS[type] ?? "#4a4a5a";
}

/** Every distinct node label present, for the legend. */
export function presentLabels(data: GitNexusGraphData): string[] {
  return [...new Set(data.nodes.map((n) => n.label))].sort();
}

/** Every distinct edge type present, for the legend. */
export function presentEdgeTypes(data: GitNexusGraphData): string[] {
  return [...new Set(data.relationships.map((r) => r.type))].sort();
}

function nodeLabelText(node: GitNexusGraphNode): string {
  return node.name ?? node.filePath?.split("/").pop() ?? node.id;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) }
    : { r: 100, g: 100, b: 100 };
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b].map((x) => clampByte(x).toString(16).padStart(2, "0")).join("")
  );
}

/** MUON's dark canvas background (`--bg` #141414), as RGB. */
const CANVAS_BG = { r: 20, g: 20, b: 20 };

/**
 * Dim a color by mixing it TOWARD the canvas background (so a dimmed node/edge
 * still hints its original hue instead of going flat gray) — the same
 * technique OSS's `useSigma.ts` `dimColor` uses (mixed toward its own #12121c
 * canvas); MUON mixes toward its actual `--bg` instead. `amount` in [0,1]:
 * 1 = unchanged, 0 = fully the background color.
 */
export function dimColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    CANVAS_BG.r + (rgb.r - CANVAS_BG.r) * amount,
    CANVAS_BG.g + (rgb.g - CANVAS_BG.g) * amount,
    CANVAS_BG.b + (rgb.b - CANVAS_BG.b) * amount
  );
}

/** Brighten a color toward white — ported verbatim from OSS's `useSigma.ts`
 * `brightenColor`. `factor` > 1; higher = brighter. */
export function brightenColor(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  return rgbToHex(
    rgb.r + ((255 - rgb.r) * (factor - 1)) / factor,
    rgb.g + ((255 - rgb.g) * (factor - 1)) / factor,
    rgb.b + ((255 - rgb.b) * (factor - 1)) / factor
  );
}

/**
 * Build the graphology graph. Positions are seeded on a deterministic ring
 * (index-derived, no RNG) so the initial frame is non-degenerate and the force
 * layout has somewhere to push from. Dangling edges are already dropped in main.
 */
export function buildGraph(
  data: GitNexusGraphData
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({
    multi: true,
    type: "directed",
  });
  const n = Math.max(1, data.nodes.length);
  const radius = Math.max(50, Math.sqrt(n) * 12);
  data.nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    graph.addNode(node.id, {
      x: Math.cos(angle) * radius + (i % 7) - 3,
      y: Math.sin(angle) * radius + (i % 5) - 2,
      size: scaledNodeSize(nodeSize(node.label), data.nodes.length),
      color: nodeColor(node.label),
      label: nodeLabelText(node),
      nodeType: node.label,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
    });
  });
  for (const rel of data.relationships) {
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) continue;
    try {
      graph.addEdgeWithKey(rel.id, rel.sourceId, rel.targetId, {
        size: 1,
        color: edgeColor(rel.type),
        relationType: rel.type,
        type: "curved",
        curvature: 0.25,
      });
    } catch {
      // duplicate key across multi-edges: skip, never throw during build
    }
  }
  return graph;
}
