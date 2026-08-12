import { describe, expect, it } from "vitest";
import {
  brightenColor,
  buildGraph,
  dimColor,
  edgeColor,
  nodeColor,
  nodeSize,
  presentEdgeTypes,
  presentLabels,
  scaledNodeSize,
} from "../src/renderer/lib/graph-adapter.js";
import type { GitNexusGraphData } from "../src/shared/ipc.js";

// Node/edge color+size mapping is PORTED from GitNexus OSS
// (gitnexus-web/src/lib/constants.ts NODE_COLORS/NODE_SIZES/EDGE_INFO, and
// graph-adapter.ts's EDGE_STYLES/getScaledNodeSize). These tests pin the
// kind→hue and kind→size table to the exact OSS values so a future edit can't
// silently drift MUON's graph away from reading like GitNexus's own.

describe("nodeColor (OSS kind→hue parity)", () => {
  it("matches OSS's NODE_COLORS for the structural + symbol kinds", () => {
    expect(nodeColor("Project")).toBe("#a855f7");
    expect(nodeColor("Package")).toBe("#8b5cf6");
    expect(nodeColor("Folder")).toBe("#6366f1");
    expect(nodeColor("File")).toBe("#3b82f6");
    expect(nodeColor("Class")).toBe("#f59e0b");
    expect(nodeColor("Function")).toBe("#10b981");
    expect(nodeColor("Method")).toBe("#14b8a6");
    expect(nodeColor("Interface")).toBe("#ec4899");
    expect(nodeColor("Import")).toBe("#475569");
  });

  it("falls back to OSS's per-node unknown-label color", () => {
    expect(nodeColor("SomeFutureLabel")).toBe("#9ca3af");
  });
});

describe("nodeSize (OSS structural hierarchy parity)", () => {
  it("keeps the dramatic Project > Package > Module > Folder > File hierarchy", () => {
    expect(nodeSize("Project")).toBeGreaterThan(nodeSize("Package"));
    expect(nodeSize("Package")).toBeGreaterThan(nodeSize("Module"));
    expect(nodeSize("Module")).toBeGreaterThan(nodeSize("Folder"));
    expect(nodeSize("Folder")).toBeGreaterThan(nodeSize("File"));
    expect(nodeSize("File")).toBeGreaterThan(nodeSize("Function"));
    expect(nodeSize("Function")).toBeGreaterThan(nodeSize("Method"));
    expect(nodeSize("Method")).toBeGreaterThan(nodeSize("Variable"));
    expect(nodeSize("Variable")).toBeGreaterThan(nodeSize("Import"));
  });

  it("hides Community/Process metadata nodes by default, matching OSS", () => {
    expect(nodeSize("Community")).toBe(0);
    expect(nodeSize("Process")).toBe(0);
  });

  it("falls back to OSS's per-node unknown-label size", () => {
    expect(nodeSize("SomeFutureLabel")).toBe(8);
  });
});

describe("scaledNodeSize (OSS density scaling parity)", () => {
  it("keeps the base size for small graphs", () => {
    expect(scaledNodeSize(10, 500)).toBe(10);
    expect(scaledNodeSize(10, 1000)).toBe(10);
  });

  it("scales down as the graph gets denser, floor-clamped", () => {
    expect(scaledNodeSize(10, 1500)).toBeCloseTo(8, 5); // >1000 ⇒ *0.8
    expect(scaledNodeSize(10, 6000)).toBeCloseTo(6.5, 5); // >5000 ⇒ *0.65
    expect(scaledNodeSize(10, 25000)).toBeCloseTo(5, 5); // >20000 ⇒ *0.5
    expect(scaledNodeSize(10, 60000)).toBeCloseTo(4, 5); // >50000 ⇒ *0.4
  });

  it("never scales a tiny base size below its floor", () => {
    expect(scaledNodeSize(1, 60000)).toBe(1); // floor 1
    expect(scaledNodeSize(1, 6000)).toBe(2); // floor 2 wins over 1*0.65
  });
});

describe("edgeColor (OSS relationship→hue parity)", () => {
  it("matches OSS's EDGE_INFO for the six canonical relationship types", () => {
    expect(edgeColor("CONTAINS")).toBe("#2d5a3d");
    expect(edgeColor("DEFINES")).toBe("#0e7490");
    expect(edgeColor("IMPORTS")).toBe("#1d4ed8");
    expect(edgeColor("CALLS")).toBe("#7c3aed");
    expect(edgeColor("EXTENDS")).toBe("#c2410c");
    expect(edgeColor("IMPLEMENTS")).toBe("#be185d");
  });

  it("aliases the Kotlin/Java hierarchy edges onto their logical equivalents", () => {
    expect(edgeColor("HAS_METHOD")).toBe(edgeColor("DEFINES"));
    expect(edgeColor("HAS_PROPERTY")).toBe(edgeColor("CONTAINS"));
    expect(edgeColor("INHERITS")).toBe(edgeColor("EXTENDS"));
  });

  it("falls back to OSS's unmatched-relationship-type color", () => {
    expect(edgeColor("SOME_FUTURE_RELATION")).toBe("#4a4a5a");
  });
});

describe("presentLabels / presentEdgeTypes", () => {
  const data: GitNexusGraphData = {
    nodes: [
      { id: "a", label: "Function" },
      { id: "b", label: "Class" },
      { id: "c", label: "Function" },
    ],
    relationships: [
      { id: "e1", sourceId: "a", targetId: "b", type: "CALLS" },
      { id: "e2", sourceId: "b", targetId: "c", type: "CONTAINS" },
      { id: "e3", sourceId: "a", targetId: "c", type: "CALLS" },
    ],
    truncated: false,
  };

  it("returns every distinct, sorted node label", () => {
    expect(presentLabels(data)).toEqual(["Class", "Function"]);
  });

  it("returns every distinct, sorted edge type", () => {
    expect(presentEdgeTypes(data)).toEqual(["CALLS", "CONTAINS"]);
  });
});

describe("dimColor / brightenColor", () => {
  it("dimColor(color, 1) is a no-op; dimColor(color, 0) collapses to the canvas bg", () => {
    expect(dimColor("#ff0000", 1)).toBe("#ff0000");
    expect(dimColor("#ff0000", 0)).toBe("#141414"); // MUON's --bg
  });

  it("dimColor mixes proportionally toward the canvas background", () => {
    // Halfway between #ff0000 (255,0,0) and --bg (20,20,20).
    expect(dimColor("#ff0000", 0.5)).toBe("#8a0a0a");
  });

  it("brightenColor(color, 1) is a no-op; a higher factor moves toward white", () => {
    expect(brightenColor("#202020", 1)).toBe("#202020");
    const brighter = brightenColor("#202020", 2);
    expect(brighter).not.toBe("#202020");
    // every channel should have moved strictly closer to 255
    expect(parseInt(brighter.slice(1, 3), 16)).toBeGreaterThan(0x20);
  });
});

describe("buildGraph", () => {
  const data: GitNexusGraphData = {
    nodes: [
      { id: "f1", label: "File", name: "index.ts" },
      { id: "fn1", label: "Function", name: "run" },
    ],
    relationships: [
      { id: "r1", sourceId: "f1", targetId: "fn1", type: "DEFINES" },
      { id: "dangling", sourceId: "f1", targetId: "ghost", type: "CALLS" },
    ],
    truncated: false,
  };

  it("adds every node with its OSS-mapped color/size and drops dangling edges", () => {
    const graph = buildGraph(data);
    expect(graph.order).toBe(2);
    expect(graph.size).toBe(1); // the dangling edge is skipped
    const fileAttrs = graph.getNodeAttributes("f1");
    expect(fileAttrs.color).toBe(nodeColor("File"));
    expect(fileAttrs.label).toBe("index.ts");
    expect(fileAttrs.nodeType).toBe("File");
  });

  it("colors the surviving edge by its relationship type", () => {
    const graph = buildGraph(data);
    const edgeAttrs = graph.getEdgeAttributes("r1");
    expect(edgeAttrs.color).toBe(edgeColor("DEFINES"));
    expect(edgeAttrs.type).toBe("curved");
  });
});
