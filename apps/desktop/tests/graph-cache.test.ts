import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGraphCacheStore,
  fingerprintFromMeta,
  fingerprintsMatch,
} from "../src/lib/graph-cache.js";
import type { GitNexusGraphData } from "../src/shared/ipc.js";

const sampleGraph = (workspacePath: string): GitNexusGraphData => ({
  nodes: [
    {
      id: "n1",
      label: "Function",
      name: "main",
      filePath: "a.ts",
      startLine: 1,
      endLine: 2,
    },
  ],
  relationships: [],
  truncated: false,
  workspacePath,
});

describe("graph cache", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("returns a hit only when the index fingerprint matches", async () => {
    dir = await mkdtemp(join(tmpdir(), "muon-gcache-"));
    const store = createGraphCacheStore(dir);
    const ws = "/Users/dev/code/muon";
    const fp = fingerprintFromMeta({
      lastCommit: "abc",
      indexedAt: "2026-07-22T00:00:00.000Z",
      stats: { nodes: 10, edges: 20 },
    });
    await store.set(ws, fp, sampleGraph(ws));
    expect(await store.get(ws, fp)).toMatchObject({
      nodes: [{ id: "n1" }],
      workspacePath: ws,
    });
    expect(
      await store.get(ws, { ...fp, lastCommit: "def" })
    ).toBeNull();
  });

  it("clears a single workspace entry", async () => {
    dir = await mkdtemp(join(tmpdir(), "muon-gcache-"));
    const store = createGraphCacheStore(dir);
    const ws = "/tmp/repo";
    const fp = fingerprintFromMeta({ lastCommit: "abc", indexedAt: "t" });
    await store.set(ws, fp, sampleGraph(ws));
    await store.clear(ws);
    expect(await store.get(ws, fp)).toBeNull();
  });

  it("fingerprintsMatch is strict on commit + indexedAt", () => {
    expect(
      fingerprintsMatch(
        { lastCommit: "a", indexedAt: "1" },
        { lastCommit: "a", indexedAt: "1" }
      )
    ).toBe(true);
    expect(
      fingerprintsMatch(
        { lastCommit: "a", indexedAt: "1" },
        { lastCommit: "a", indexedAt: "2" }
      )
    ).toBe(false);
  });
});
