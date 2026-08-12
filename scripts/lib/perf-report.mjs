#!/usr/bin/env node
// Shared helpers for MUON's local performance harnesses (P15).
// Node built-ins only — no network, no operator data dir.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export const BASELINES_PATH = resolve(
  REPO_ROOT,
  "docs/benchmarks/performance-baselines.json"
);

/** Ensure a workspace package is built before importing from dist/. */
export function ensurePackageBuilt(packagePath) {
  const distIndex = resolve(REPO_ROOT, packagePath, "dist/index.js");
  if (existsSync(distIndex)) {
    return;
  }
  const run = spawnSync("npm", ["run", "build", "--prefix", packagePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    timeout: 180_000,
  });
  if (run.status !== 0) {
    const detail = `${run.error?.message ?? ""}\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
      .trim()
      .slice(-2_000);
    throw new Error(`failed to build ${packagePath}: ${detail}`);
  }
  if (!existsSync(distIndex)) {
    throw new Error(`build of ${packagePath} did not produce dist/index.js`);
  }
}

export function loadBaselines() {
  if (!existsSync(BASELINES_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(BASELINES_PATH, "utf8"));
}

export function hostFacts() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
  };
}

/**
 * @param {Record<string, number>} current
 * @param {Record<string, number>|undefined} baseline
 * @returns {Record<string, { current: number, baseline: number, deltaPct: number }>|undefined}
 */
export function deltaMetrics(current, baseline) {
  if (!baseline) {
    return undefined;
  }
  const out = {};
  for (const [key, value] of Object.entries(current)) {
    const base = baseline[key];
    if (typeof base !== "number" || typeof value !== "number") {
      continue;
    }
    const deltaPct =
      base === 0 ? (value === 0 ? 0 : 100) : ((value - base) / base) * 100;
    out[key] = {
      current: roundMs(value),
      baseline: roundMs(base),
      deltaPct: roundMs(deltaPct),
    };
  }
  return out;
}

export function roundMs(value) {
  return Math.round(value * 10) / 10;
}

export function writeReport(report, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `MUON ${report.benchmark}: ${report.status} (${report.durationMs}ms total)\n`
  );
  for (const [key, value] of Object.entries(report.metrics ?? {})) {
    process.stdout.write(`  ${key}: ${value}\n`);
  }
  if (report.delta) {
    process.stdout.write("  delta vs baseline:\n");
    for (const [key, row] of Object.entries(report.delta)) {
      const sign = row.deltaPct >= 0 ? "+" : "";
      process.stdout.write(
        `    ${key}: ${row.current} (was ${row.baseline}, ${sign}${row.deltaPct}%)\n`
      );
    }
  }
  if (report.scope) {
    process.stdout.write(`Scope: ${report.scope}\n`);
  }
}
