import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function runHarness(script: string) {
  const run = spawnSync("node", [resolve(root, script), "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    timeout: 240_000,
  });
  expect(run.status, run.stderr || run.stdout).toBe(0);
  const report = JSON.parse(run.stdout);
  return report;
}

function assertPerfReport(
  report: Record<string, unknown>,
  benchmark: string,
  metricKeys: string[]
) {
  expect(report.schemaVersion).toBe(1);
  expect(report.benchmark).toBe(benchmark);
  expect(report.status).toBe("passed");
  expect(typeof report.measuredAt).toBe("string");
  expect(typeof report.durationMs).toBe("number");
  expect(report.durationMs).toBeGreaterThan(0);
  expect(report.host).toMatchObject({
    platform: expect.any(String),
    node: expect.any(String),
  });
  const metrics = report.metrics as Record<string, number>;
  expect(metrics).toBeTruthy();
  for (const key of metricKeys) {
    expect(typeof metrics[key]).toBe("number");
    expect(metrics[key]).toBeGreaterThanOrEqual(0);
  }
}

describe("performance harnesses (P15)", () => {
  it("pty flood profiler emits structured JSON", () => {
    const report = runHarness("scripts/pty-flood-profiler.mjs");
    assertPerfReport(report, "muon-pty-flood", [
      "attachedTimeToPauseMs",
      "attachedFramesBeforePause",
      "attachedUnackedBytesAtPause",
      "attachedAckDrainMs",
      "detachedTimeToPauseMs",
      "detachedFramesBeforePause",
    ]);
    expect(report.scenarios).toMatchObject({
      attached: { framesBeforePause: expect.any(Number) },
      detached: { framesBeforePause: expect.any(Number) },
    });
    expect(report.metrics.attachedFramesBeforePause).toBeGreaterThan(0);
    expect(report.metrics.attachedUnackedBytesAtPause).toBeGreaterThanOrEqual(
      65536
    );
  }, 240_000);

  it("memory bench emits structured JSON", () => {
    const report = runHarness("scripts/memory-bench.mjs");
    assertPerfReport(report, "muon-memory-bench", [
      "corpusNotes",
      "ingestMs",
      "searchMs",
      "neighbors2HopMs",
      "searchResultCount",
      "neighborNodeCount",
    ]);
    expect(report.metrics.corpusNotes).toBe(44);
    expect(report.metrics.searchResultCount).toBeGreaterThan(0);
    expect(report.metrics.neighborNodeCount).toBeGreaterThan(1);
    expect(report.config).toMatchObject({
      corpus: "DEFAULT_GRAPH_VALUE_EVAL_SET",
    });
  }, 240_000);
});
