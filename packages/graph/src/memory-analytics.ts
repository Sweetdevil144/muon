/**
 * Pure, deterministic analytics over the memory note↔module projection.
 *
 * The graph store remains responsible only for loading the bounded coordinates.
 * PageRank/degree centrality and label propagation live here so they are easy to
 * test, require no native dependency, and never need note text.
 */

export type MemoryAnalyticsInputNote = {
  id: string;
  modules: string[];
};

export type MemoryCentralityScore = {
  noteId: string;
  score: number;
  degree: number;
  communityId: string;
};

export type MemoryHotModule = {
  module: string;
  score: number;
  noteCount: number;
  communityId: string;
};

export type MemoryCommunitySummary = {
  id: string;
  noteCount: number;
  moduleCount: number;
};

export type MemoryAnalyticsSnapshot = {
  noteScores: MemoryCentralityScore[];
  hotModules: MemoryHotModule[];
  communities: MemoryCommunitySummary[];
  source: {
    notes: number;
    modules: number;
    edges: number;
    truncated: boolean;
  };
};

export type MemoryAnalyticsOptions = {
  damping?: number;
  iterations?: number;
  propagationIterations?: number;
  hotModuleLimit?: number;
  truncated?: boolean;
};

type NodeKind = "note" | "module";

const NOTE_PREFIX = "note:";
const MODULE_PREFIX = "module:";
const MAX_ANALYTICS_NOTES = 5_000;
const MAX_MODULES_PER_NOTE = 128;
const MAX_NOTE_ID_LENGTH = 512;
const MAX_MODULE_LENGTH = 1_024;
const MAX_ANALYTICS_EDGES = 20_000;

function boundedUnit(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function boundedCount(value: number, fallback: number, max: number): number {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function noteNode(id: string): string {
  return `${NOTE_PREFIX}${id}`;
}

function moduleNode(module: string): string {
  return `${MODULE_PREFIX}${module}`;
}

function entityId(node: string): string {
  return node.startsWith(NOTE_PREFIX)
    ? node.slice(NOTE_PREFIX.length)
    : node.slice(MODULE_PREFIX.length);
}

/**
 * Analyze a bounded note/module graph. Inputs and outputs are coordinates and
 * scalars only; no content-bearing field enters this surface.
 */
export function analyzeMemoryGraph(
  notes: readonly MemoryAnalyticsInputNote[],
  options: MemoryAnalyticsOptions = {}
): MemoryAnalyticsSnapshot {
  const damping = boundedUnit(options.damping ?? 0.85, 0.85);
  const iterations = boundedCount(options.iterations ?? 20, 20, 100);
  const propagationIterations = boundedCount(
    options.propagationIterations ?? 20,
    20,
    100
  );
  const hotModuleLimit = boundedCount(
    options.hotModuleLimit ?? 12,
    12,
    100
  );

  const kinds = new Map<string, NodeKind>();
  const adjacency = new Map<string, Set<string>>();
  const ensureNode = (node: string, kind: NodeKind) => {
    kinds.set(node, kind);
    if (!adjacency.has(node)) adjacency.set(node, new Set());
  };

  const noteModules = new Map<string, Set<string>>();
  let inputTruncated = notes.length > MAX_ANALYTICS_NOTES;
  let acceptedEdges = 0;
  for (const note of notes.slice(0, MAX_ANALYTICS_NOTES)) {
    if (!note.id || note.id.length > MAX_NOTE_ID_LENGTH) {
      inputTruncated = true;
      continue;
    }
    const n = noteNode(note.id);
    ensureNode(n, "note");
    const modules = noteModules.get(note.id) ?? new Set<string>();
    if ((note.modules?.length ?? 0) > MAX_MODULES_PER_NOTE) {
      inputTruncated = true;
    }
    for (const module of (note.modules ?? []).slice(0, MAX_MODULES_PER_NOTE)) {
      if (!module || module.length > MAX_MODULE_LENGTH) {
        inputTruncated = true;
        continue;
      }
      if (!modules.has(module)) {
        if (acceptedEdges >= MAX_ANALYTICS_EDGES) {
          inputTruncated = true;
          break;
        }
        modules.add(module);
        acceptedEdges += 1;
      }
    }
    noteModules.set(note.id, modules);
  }

  let edgeCount = 0;
  for (const [noteId, modules] of noteModules) {
    const n = noteNode(noteId);
    for (const module of modules) {
      const m = moduleNode(module);
      ensureNode(m, "module");
      if (!adjacency.get(n)!.has(m)) {
        adjacency.get(n)!.add(m);
        adjacency.get(m)!.add(n);
        edgeCount += 1;
      }
    }
  }

  const nodes = [...adjacency.keys()].sort();
  if (nodes.length === 0) {
    return {
      noteScores: [],
      hotModules: [],
      communities: [],
      source: {
        notes: 0,
        modules: 0,
        edges: 0,
        truncated: Boolean(options.truncated || inputTruncated),
      },
    };
  }

  const initial = 1 / nodes.length;
  let pageRank = new Map(nodes.map((node) => [node, initial]));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const dangling = nodes.reduce(
      (sum, node) =>
        adjacency.get(node)!.size === 0 ? sum + (pageRank.get(node) ?? 0) : sum,
      0
    );
    const base = (1 - damping) / nodes.length;
    const next = new Map(
      nodes.map((node) => [
        node,
        base + (damping * dangling) / nodes.length,
      ])
    );
    for (const node of nodes) {
      const neighbors = adjacency.get(node)!;
      if (neighbors.size === 0) continue;
      const share = (damping * (pageRank.get(node) ?? 0)) / neighbors.size;
      for (const neighbor of neighbors) {
        next.set(neighbor, (next.get(neighbor) ?? 0) + share);
      }
    }
    pageRank = next;
  }

  const maxRank = Math.max(...pageRank.values(), 1e-12);
  const maxDegree = Math.max(
    ...nodes.map((node) => adjacency.get(node)!.size),
    1
  );
  const centrality = new Map<string, number>();
  for (const node of nodes) {
    const rank = (pageRank.get(node) ?? 0) / maxRank;
    const degree = adjacency.get(node)!.size / maxDegree;
    centrality.set(node, rounded(0.75 * rank + 0.25 * degree));
  }

  // Deterministic asynchronous label propagation. Central neighbors have more
  // voting weight; stable lexical tie-breaking makes repeated runs identical.
  const labels = new Map(nodes.map((node) => [node, node]));
  for (
    let iteration = 0;
    iteration < propagationIterations;
    iteration += 1
  ) {
    let changed = false;
    for (const node of nodes) {
      const votes = new Map<string, number>();
      for (const neighbor of adjacency.get(node)!) {
        const label = labels.get(neighbor)!;
        votes.set(
          label,
          (votes.get(label) ?? 0) + 1 + (centrality.get(neighbor) ?? 0)
        );
      }
      if (votes.size === 0) continue;
      const nextLabel = [...votes.entries()].sort(
        (left, right) =>
          right[1] - left[1] || left[0].localeCompare(right[0])
      )[0]![0];
      if (labels.get(node) !== nextLabel) {
        labels.set(node, nextLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const membersByLabel = new Map<string, string[]>();
  for (const node of nodes) {
    const label = labels.get(node)!;
    const members = membersByLabel.get(label) ?? [];
    members.push(node);
    membersByLabel.set(label, members);
  }
  const orderedCommunities = [...membersByLabel.values()]
    .map((members) => members.sort())
    .sort(
      (left, right) =>
        right.length - left.length || left[0]!.localeCompare(right[0]!)
    );
  const communityByNode = new Map<string, string>();
  const communities = orderedCommunities.map((members, index) => {
    const id = `community-${index + 1}`;
    for (const member of members) communityByNode.set(member, id);
    return {
      id,
      noteCount: members.filter((node) => kinds.get(node) === "note").length,
      moduleCount: members.filter((node) => kinds.get(node) === "module").length,
    };
  });

  const noteScores = nodes
    .filter((node) => kinds.get(node) === "note")
    .map((node) => ({
      noteId: entityId(node),
      score: centrality.get(node) ?? 0,
      degree: adjacency.get(node)!.size,
      communityId: communityByNode.get(node)!,
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.noteId.localeCompare(right.noteId)
    );

  const hotModules = nodes
    .filter((node) => kinds.get(node) === "module")
    .map((node) => ({
      module: entityId(node),
      score: centrality.get(node) ?? 0,
      noteCount: adjacency.get(node)!.size,
      communityId: communityByNode.get(node)!,
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.module.localeCompare(right.module)
    )
    .slice(0, hotModuleLimit);

  return {
    noteScores,
    hotModules,
    communities,
    source: {
      notes: noteScores.length,
      modules: nodes.filter((node) => kinds.get(node) === "module").length,
      edges: edgeCount,
      truncated: Boolean(options.truncated || inputTruncated),
    },
  };
}
