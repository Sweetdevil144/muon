#!/usr/bin/env node
//
// `npm run perf:memory` — memory graph ingest + retrieval on the KG-12 eval corpus.
//
// Hermetic: disposable Ladybug store in os.tmpdir(), DEFAULT_GRAPH_VALUE_EVAL_SET
// only. No network, no operator brain, no note prose in the report beyond counts.
//
// Usage:
//   node scripts/memory-bench.mjs [--json]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  deltaMetrics,
  ensurePackageBuilt,
  hostFacts,
  loadBaselines,
  roundMs,
  writeReport,
} from "./lib/perf-report.mjs";

const json = process.argv.includes("--json");
const SEARCH_QUERY = "confirmed only gate unconfirmed agent note";
const NEIGHBOR_HOPS = 2;
const NEIGHBOR_LIMIT = 100;

const startedAt = Date.now();

ensurePackageBuilt("packages/graph");

const graphMod = await import(
  pathToFileURL(`${REPO_ROOT}/packages/graph/dist/index.js`).href
);
const { MuonGraph, DEFAULT_GRAPH_VALUE_EVAL_SET } = graphMod;

const corpus = DEFAULT_GRAPH_VALUE_EVAL_SET.notes;
const tasks = DEFAULT_GRAPH_VALUE_EVAL_SET.tasks ?? [];
let seedNoteId = "";

const dir = mkdtempSync(join(tmpdir(), "muon-perf-memory-"));
const storePath = join(dir, "bench.lbug");
const store = new MuonGraph(storePath, { disableFts: false });

try {
  await store.init();

  for (const task of tasks) {
    await store.upsertTask({ id: task.id, title: task.id, status: "open" });
    await store.touchModules(
      task.modules,
      "2026-07-20T00:00:00.000Z",
      task.id
    );
  }

  for (const principal of new Set(corpus.map((note) => note.principal))) {
    await store.projectPrincipal({
      id: principal,
      kind: principal.startsWith("human") ? "human" : "agent",
      displayName: principal,
      vendor: null,
      trust: "high",
      createdAt: "2026-07-20T00:00:00.000Z",
    });
  }
  await store.projectPrincipal({
    id: "human:founder",
    kind: "human",
    displayName: "founder",
    vendor: null,
    trust: "high",
    createdAt: "2026-07-20T00:00:00.000Z",
  });

  const ingestStart = performance.now();
  for (const note of corpus) {
    const created = await store.addMemoryNote({
      kind: note.kind,
      text: note.text,
      modules: note.modules,
      symbols: note.symbols,
      taskId: note.taskId,
      trust: note.trust,
      createdBy: note.principal,
      chatId: note.chatId,
    });
    await store.projectAuthoredBy(created.id, note.principal);
    if (note.confirmed) {
      await store.updateMemoryNote(created.id, { confirmed: true });
      await store.projectConfirmedBy(created.id, "human:founder");
    }
    if (note.id === "n-gate-confirmed-only") {
      seedNoteId = created.id;
    }
  }
  const ingestMs = performance.now() - ingestStart;

  if (!seedNoteId) {
    throw new Error("eval corpus missing n-gate-confirmed-only seed note");
  }

  const searchStart = performance.now();
  const searchResults = await store.searchMemory(SEARCH_QUERY, 10);
  const searchMs = performance.now() - searchStart;

  const neighborsStart = performance.now();
  const neighbors = await store.memoryNeighbors(seedNoteId, {
    hops: NEIGHBOR_HOPS,
    limit: NEIGHBOR_LIMIT,
  });
  const neighborsMs = performance.now() - neighborsStart;

  if (searchResults.length === 0) {
    throw new Error("searchMemory returned no results on eval corpus");
  }
  if (neighbors.nodes.length <= 1) {
    throw new Error("memoryNeighbors returned a trivial graph on eval corpus");
  }

  const metrics = {
    corpusNotes: corpus.length,
    ingestMs: roundMs(ingestMs),
    searchMs: roundMs(searchMs),
    neighbors2HopMs: roundMs(neighborsMs),
    searchResultCount: searchResults.length,
    neighborNodeCount: neighbors.nodes.length,
    neighborEdgeCount: neighbors.edges.length,
  };

  const baselines = loadBaselines();
  const delta = deltaMetrics(metrics, baselines?.memory?.metrics);

  const report = {
    schemaVersion: 1,
    benchmark: "muon-memory-bench",
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: "passed",
    host: hostFacts(),
    config: {
      corpus: "DEFAULT_GRAPH_VALUE_EVAL_SET",
      searchQuery: SEARCH_QUERY,
      neighborHops: NEIGHBOR_HOPS,
      neighborLimit: NEIGHBOR_LIMIT,
    },
    metrics,
    ...(delta ? { delta } : {}),
    scope:
      "KG-12 committed eval corpus in a disposable store; measures ingest and hot-path retrieval, not real operator brain scale.",
  };

  writeReport(report, { json });
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
} finally {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
