import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitNexusGraphData } from "../shared/ipc.js";
import type { GitNexusMeta } from "./gitnexus-index.js";

/**
 * Disk + memory cache for Open Graph payloads. Keyed by workspace path +
 * index fingerprint (meta lastCommit/indexedAt/stats). Survives app restarts
 * until the user clears it or the index fingerprint changes (e.g. after a
 * commit triggers reindex).
 */

export type GraphCacheFingerprint = {
  lastCommit?: string;
  indexedAt?: string;
  nodes?: number;
  edges?: number;
};

export type GraphCacheEntry = {
  fingerprint: GraphCacheFingerprint;
  graph: GitNexusGraphData;
  savedAt: string;
};

export function fingerprintFromMeta(meta: GitNexusMeta | null | undefined): GraphCacheFingerprint {
  return {
    ...(meta?.lastCommit ? { lastCommit: meta.lastCommit } : {}),
    ...(meta?.indexedAt ? { indexedAt: meta.indexedAt } : {}),
    ...(typeof meta?.stats?.nodes === "number" ? { nodes: meta.stats.nodes } : {}),
    ...(typeof meta?.stats?.edges === "number"
      ? { edges: meta.stats.edges }
      : {}),
  };
}

export function fingerprintsMatch(
  a: GraphCacheFingerprint,
  b: GraphCacheFingerprint
): boolean {
  return (
    (a.lastCommit ?? "") === (b.lastCommit ?? "") &&
    (a.indexedAt ?? "") === (b.indexedAt ?? "") &&
    (a.nodes ?? -1) === (b.nodes ?? -1) &&
    (a.edges ?? -1) === (b.edges ?? -1)
  );
}

function cacheKey(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
}

export type GraphCacheStore = {
  get(
    workspacePath: string,
    fingerprint: GraphCacheFingerprint
  ): Promise<GitNexusGraphData | null>;
  set(
    workspacePath: string,
    fingerprint: GraphCacheFingerprint,
    graph: GitNexusGraphData
  ): Promise<void>;
  clear(workspacePath?: string): Promise<void>;
};

export function createGraphCacheStore(cacheDir: string): GraphCacheStore {
  const memory = new Map<string, GraphCacheEntry>();

  const fileFor = (workspacePath: string) =>
    join(cacheDir, `${cacheKey(workspacePath)}.json`);

  const ensureDir = async () => {
    await mkdir(cacheDir, { recursive: true });
  };

  return {
    async get(workspacePath, fingerprint) {
      if (!workspacePath || graphUnusable(fingerprint)) return null;
      const key = cacheKey(workspacePath);
      const mem = memory.get(key);
      if (mem && fingerprintsMatch(mem.fingerprint, fingerprint)) {
        return mem.graph;
      }
      try {
        const raw = await readFile(fileFor(workspacePath), "utf8");
        const parsed = JSON.parse(raw) as GraphCacheEntry;
        if (
          !parsed?.graph ||
          !fingerprintsMatch(parsed.fingerprint ?? {}, fingerprint)
        ) {
          return null;
        }
        memory.set(key, parsed);
        return parsed.graph;
      } catch {
        return null;
      }
    },

    async set(workspacePath, fingerprint, graph) {
      if (!workspacePath || graph.error || graph.nodes.length === 0) return;
      if (graphUnusable(fingerprint)) return;
      const entry: GraphCacheEntry = {
        fingerprint,
        graph: { ...graph, workspacePath },
        savedAt: new Date().toISOString(),
      };
      memory.set(cacheKey(workspacePath), entry);
      try {
        await ensureDir();
        await writeFile(fileFor(workspacePath), JSON.stringify(entry), "utf8");
      } catch {
        // Disk write is best-effort; memory still warms the session.
      }
    },

    async clear(workspacePath) {
      if (workspacePath) {
        memory.delete(cacheKey(workspacePath));
        await rm(fileFor(workspacePath), { force: true }).catch(() => undefined);
        return;
      }
      memory.clear();
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function graphUnusable(fingerprint: GraphCacheFingerprint): boolean {
  // Without a commit or indexedAt we cannot know staleness — skip cache.
  return !fingerprint.lastCommit && !fingerprint.indexedAt;
}
