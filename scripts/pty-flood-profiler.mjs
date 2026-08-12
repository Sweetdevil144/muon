#!/usr/bin/env node
//
// `npm run perf:flood` — PTY host backpressure under a synthetic byte flood.
//
// Hermetic: FakePtyDriver + PtyHost only. No node-pty, no network, no operator
// data dir. Measures how quickly backpressure pauses a flood and how fast acks
// drain the queue — the same contract Wave 4 §2.5 guards against a `yes`-flood
// pinning the UI.
//
// Usage:
//   node scripts/pty-flood-profiler.mjs [--json]

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
const CHUNK_BYTES = 1024;
const CHUNK = "y".repeat(CHUNK_BYTES);
const HIGH_WATER = 64 * 1024;
const LOW_WATER = 16 * 1024;
const MAX_CHUNKS = 256;

const startedAt = Date.now();

ensurePackageBuilt("packages/runner");

const runner = await import(
  pathToFileURL(`${REPO_ROOT}/packages/runner/dist/index.js`).href
);
const { PtyHost, FakePtyDriver } = runner;

function makeHost() {
  let driver;
  const factory = (opts) => {
    driver = new FakePtyDriver(opts);
    return driver;
  };
  const host = new PtyHost(factory, {
    highWaterMark: HIGH_WATER,
    lowWaterMark: LOW_WATER,
  });
  return {
    host,
    driver: () => {
      if (!driver) throw new Error("driver not spawned");
      return driver;
    },
  };
}

function profileAttachedFlood() {
  const { host, driver } = makeHost();
  host.open("flood-attached", { file: "yes", args: [], cwd: "/tmp" });
  const frames = [];
  host.attach("flood-attached", {
    onData: (frame) => frames.push(frame),
    onExit: () => {},
  });

  const emitStart = performance.now();
  let chunks = 0;
  let pausedAtMs = null;
  for (; chunks < MAX_CHUNKS; chunks += 1) {
    driver().emit(CHUNK);
    if (driver().paused && pausedAtMs === null) {
      pausedAtMs = performance.now() - emitStart;
      break;
    }
  }
  if (pausedAtMs === null) {
    throw new Error("attached flood never reached backpressure pause");
  }

  const ackStart = performance.now();
  for (const frame of frames) {
    host.ack("flood-attached", frame.seq);
  }
  const ackDrainMs = performance.now() - ackStart;
  if (driver().paused) {
    throw new Error("driver still paused after draining all acks");
  }

  return {
    timeToPauseMs: roundMs(pausedAtMs),
    framesBeforePause: frames.length,
    unackedBytesAtPause: frames.reduce(
      (sum, frame) => sum + Buffer.byteLength(frame.data, "utf8"),
      0
    ),
    ackDrainMs: roundMs(ackDrainMs),
    floodChunksAttempted: chunks + 1,
  };
}

function profileDetachedFlood() {
  const { host, driver } = makeHost();
  host.open("flood-detached", { file: "yes", args: [], cwd: "/tmp" });

  const emitStart = performance.now();
  let chunks = 0;
  let pausedAtMs = null;
  for (; chunks < MAX_CHUNKS; chunks += 1) {
    driver().emit(CHUNK);
    if (driver().paused && pausedAtMs === null) {
      pausedAtMs = performance.now() - emitStart;
      break;
    }
  }
  if (pausedAtMs === null) {
    throw new Error("detached flood never reached backpressure pause");
  }

  return {
    timeToPauseMs: roundMs(pausedAtMs),
    framesBeforePause: chunks + 1,
    floodChunksAttempted: chunks + 1,
  };
}

const attached = profileAttachedFlood();
const detached = profileDetachedFlood();

const metrics = {
  attachedTimeToPauseMs: attached.timeToPauseMs,
  attachedFramesBeforePause: attached.framesBeforePause,
  attachedUnackedBytesAtPause: attached.unackedBytesAtPause,
  attachedAckDrainMs: attached.ackDrainMs,
  detachedTimeToPauseMs: detached.timeToPauseMs,
  detachedFramesBeforePause: detached.framesBeforePause,
};

const baselines = loadBaselines();
const delta = deltaMetrics(metrics, baselines?.ptyFlood?.metrics);

const report = {
  schemaVersion: 1,
  benchmark: "muon-pty-flood",
  measuredAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  status: "passed",
  host: hostFacts(),
  config: {
    chunkBytes: CHUNK_BYTES,
    highWaterMark: HIGH_WATER,
    lowWaterMark: LOW_WATER,
    maxChunks: MAX_CHUNKS,
  },
  scenarios: { attached, detached },
  metrics,
  ...(delta ? { delta } : {}),
  scope:
    "Synthetic PTY byte flood through FakePtyDriver; measures backpressure pause and ack drain, not real node-pty throughput.",
};

writeReport(report, { json });
if (report.status !== "passed") {
  process.exitCode = 1;
}
