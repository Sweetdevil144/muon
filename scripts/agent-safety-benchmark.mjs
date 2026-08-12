#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const groups = [
  {
    packagePath: "backend",
    file: "tests/live-terminal-tiers.test.ts",
    scenarios: [
      ["terminal-agent-read", "refuses the AGENT tier — a vendor process must not read a console"],
      ["terminal-job-read", "refuses a JOB CAPABILITY — the credential a vendor child actually holds"],
    ],
  },
  {
    packagePath: "backend",
    file: "tests/approval-containment.test.ts",
    scenarios: [
      ["primary-checkout-write", "refuses an edit to the primary checkout, terminally, naming both trees"],
      ["sibling-worktree-write", "refuses a reach into a SIBLING lane's worktree"],
    ],
  },
  {
    packagePath: "backend",
    file: "tests/dispatch-budget.test.ts",
    scenarios: [
      ["budget-raise-without-gate", "agent tier WITHOUT a gate → 403; the pool is not touched"],
      ["budget-receipt-payload-mismatch", "agent tier with a gate bound to a DIFFERENT pool → 403; the gate is not consumed"],
    ],
  },
  {
    packagePath: "packages/core",
    file: "tests/role-assignment.test.ts",
    scenarios: [
      ["orchestrator-capability-ceiling", "blocks a coordinator on a lane that cannot background or be interrupted"],
      ["empty-role-ceiling", "an empty ceiling is refused for EVERY role, in a full assignment too"],
    ],
  },
  {
    packagePath: "packages/adapters",
    file: "tests/codex-guard.test.ts",
    scenarios: [
      ["foreign-guard-directory", "refuses a guard directory it cannot prove is its own"],
      ["operator-home-as-guard", "refuses a guard home that IS the operator's home"],
      ["mcp-inventory-over-grant", "blocks a governed preflight whose inventory exceeds the grant"],
    ],
  },
  {
    packagePath: "packages/runner",
    file: "tests/preflight-coverage.test.ts",
    scenarios: [
      ["forged-edit-coverage", "rejects uncovered files and ignores forged, stale, or cross-job events"],
    ],
  },
  {
    packagePath: "packages/protocol",
    file: "tests/delegation.test.ts",
    scenarios: [
      ["unbounded-v2-delegation", "rejects a v2 root that omits the descendant pool"],
    ],
  },
  {
    packagePath: "packages/protocol",
    file: "tests/boundary-config.test.ts",
    scenarios: [
      ["implicit-boundary-posture", "refuses an entry that omits failClosed (Cursor's default is fail-open)"],
      ["fail-open-boundary", "refuses an entry that sets failClosed to fail-open"],
    ],
  },
  {
    packagePath: "packages/graph",
    file: "tests/memory-workspace-read-fence.test.ts",
    scenarios: [
      ["cross-workspace-confirmed-memory", "§6: a confirmed promoted-GLOBAL note still cannot cross a workspace"],
    ],
  },
];

const json = process.argv.includes("--json");
const startedAt = Date.now();
const results = [];

for (const group of groups) {
  const sourcePath = resolve(root, group.packagePath, group.file);
  const source = readFileSync(sourcePath, "utf8");
  const missing = group.scenarios.filter(([, title]) => !source.includes(title));
  if (missing.length > 0) {
    for (const [id, title] of group.scenarios) {
      results.push({
        id,
        title,
        source: `${group.packagePath}/${group.file}`,
        passed: false,
        reason: missing.some(([, candidate]) => candidate === title)
          ? "benchmark manifest drift: named hostile test is missing"
          : "not run because another named test in this file is missing",
      });
    }
    continue;
  }

  const npmArgs =
    group.packagePath === "packages/protocol"
      ? ["exec", "vitest", "run", `${group.packagePath}/${group.file}`]
      : ["run", "--prefix", group.packagePath, "test", "--", group.file];
  const run = spawnSync(
    "npm",
    npmArgs,
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    }
  );
  const passed = run.status === 0;
  const failure = passed
    ? undefined
    : `${run.error?.message ?? ""}\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
        .trim()
        .slice(-4_000);
  for (const [id, title] of group.scenarios) {
    results.push({
      id,
      title,
      source: `${group.packagePath}/${group.file}`,
      passed,
      ...(failure ? { reason: failure } : {}),
    });
  }
}

const passed = results.filter((result) => result.passed).length;
const report = {
  schemaVersion: 1,
  benchmark: "muon-agent-safety",
  measuredAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  passed,
  total: results.length,
  status: passed === results.length ? "passed" : "failed",
  scope:
    "Named hermetic hostile cases over shipping governance boundaries; not an exhaustive safety claim.",
  results,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `MUON agent-safety benchmark: ${report.passed}/${report.total} hostile cases refused\n`
  );
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? "PASS" : "FAIL"} ${result.id} — ${result.title}\n`
    );
    if (result.reason) process.stdout.write(`${result.reason}\n`);
  }
  process.stdout.write(`Scope: ${report.scope}\n`);
}

if (report.status !== "passed") process.exitCode = 1;
