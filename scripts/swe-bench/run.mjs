// MUON SWE-bench runner, SCAFFOLD (P7 validation).
//
// A harness that takes a suite of task specs and, for each, prepares a temp
// workspace (validated by the P3-B allowlist because the dispatch route enforces
// it), dispatches a repair task through the REAL MUON dispatch API against the
// REAL runner, then runs the task's acceptance `check` through the SAME argv-safe
// path the loop uses (@muon/core `runShellCheck`). It records pass/fail, writes a
// JSON report + a human summary, and exits non-zero if any task fails.
//
// HONEST SCOPE: with the bundled synthetic fixture this proves the HARNESS is
// wired end-to-end using the deterministic `fake` vendor, it is NOT a real
// SWE-bench number. To produce a published number the founder plugs in the real
// SWE-bench dataset (as a suite) and a real, logged-in vendor. See
// docs/swe-bench.md.
//
// Usage:
//   node scripts/swe-bench/run.mjs [--suite <path.mjs>] [--out <report.json>] [--keep]
//
// A task spec:
//   { id, brief, vendor?, kind?, harnessKey?, repoSetup?(fn|dir), check{name,command,args?} }
// A suite module default-exports: { name, vendor?, tasks: TaskSpec[] }.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runShellCheck } from "../../packages/core/dist/index.js";
import {
  startInProcessRunner,
  startLiveBackend,
  until,
} from "../../backend/tests/e2e/live-backend.mjs";

process.env.MUON_FAKE_VENDOR = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { suite: path.join(HERE, "fixtures", "synthetic.mjs"), out: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--suite") args.suite = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "MUON SWE-bench runner (scaffold)",
      "",
      "  node scripts/swe-bench/run.mjs [--suite <path.mjs>] [--out <report.json>] [--keep]",
      "",
      "  --suite  Path to a suite module (default: fixtures/synthetic.mjs)",
      "  --out    Where to write the JSON report (default: scripts/swe-bench/reports/<ts>.json)",
      "  --keep   Keep the backend's temp workspaces (skip cleanup) for debugging",
      "",
      "See docs/swe-bench.md to plug in the real SWE-bench dataset + a real vendor.",
    ].join("\n")
  );
}

async function prepareWorkspace(root, task) {
  const workspace = path.join(root, `bench-${task.id}`);
  mkdirSync(workspace, { recursive: true });
  const setup = task.repoSetup;
  if (typeof setup === "function") {
    await setup(workspace);
  } else if (typeof setup === "string") {
    // A directory to copy in as the starting repo state.
    const src = path.isAbsolute(setup) ? setup : path.resolve(setup);
    cpSync(src, workspace, { recursive: true });
  }
  return workspace;
}

async function runTask({ api, op, agent, root, suite, task }) {
  const startedAt = Date.now();
  const vendor = task.vendor ?? suite.vendor ?? "fake";
  const kind = task.kind ?? "oneshot";
  const workspace = await prepareWorkspace(root, task);

  const created = await api("POST", "/api/tasks", {
    token: op,
    body: { title: `bench: ${task.id}`, description: task.brief.slice(0, 200) },
  });
  if (created.status !== 201) {
    return {
      id: task.id,
      vendor,
      pass: false,
      jobStatus: "not-dispatched",
      reason: `task create failed (HTTP ${created.status}): ${created.text}`,
      durationMs: Date.now() - startedAt,
    };
  }
  const taskId = created.json.task.id;

  const dispatched = await api("POST", "/api/dispatch", {
    token: agent,
    body: {
      vendor,
      kind,
      ...(task.harnessKey ? { harnessKey: task.harnessKey } : {}),
      taskId,
      brief: task.brief,
      workspacePath: workspace,
    },
  });
  if (dispatched.status !== 201) {
    return {
      id: task.id,
      vendor,
      pass: false,
      jobStatus: "not-dispatched",
      reason: `dispatch failed (HTTP ${dispatched.status}): ${dispatched.text}`,
      durationMs: Date.now() - startedAt,
    };
  }
  const jobId = dispatched.json.job.id;

  // Wait for the REAL runner to claim + execute the job to a terminal state.
  let job;
  try {
    job = await until(
      async () => {
        const res = await api("GET", `/api/dispatch/${jobId}`, { token: agent });
        if (res.status !== 200) throw new Error(`GET dispatch ${res.status}`);
        const j = res.json.job;
        if (!["done", "failed", "interrupted"].includes(j.status)) {
          throw new Error(`still ${j.status}`);
        }
        return j;
      },
      { tries: 120, delay: 250, label: `job ${task.id}` }
    );
  } catch (error) {
    return {
      id: task.id,
      vendor,
      pass: false,
      jobStatus: "timeout",
      reason: error.message,
      durationMs: Date.now() - startedAt,
    };
  }

  // The acceptance check, reuse the SAME argv-safe check path the loop uses.
  const check = await runShellCheck(
    { name: task.check.name, command: task.check.command, args: task.check.args },
    workspace
  );

  const pass = job.status === "done" && check.ok;
  return {
    id: task.id,
    vendor,
    kind,
    harnessKey: task.harnessKey ?? null,
    pass,
    jobStatus: job.status,
    jobExitCode: job.exitCode ?? null,
    check: { name: check.name, ok: check.ok, exitCode: check.exitCode },
    workspace,
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const suiteUrl = pathToFileURL(path.resolve(args.suite)).href;
  const suiteModule = await import(suiteUrl);
  const suite = suiteModule.default ?? suiteModule;
  if (!suite || !Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    throw new Error(`suite '${args.suite}' has no tasks`);
  }

  console.log(
    `MUON SWE-bench harness, suite '${suite.name ?? path.basename(args.suite)}' (${suite.tasks.length} task(s))`
  );

  const backend = await startLiveBackend({ prefix: "muon-bench" });
  const runner = startInProcessRunner({
    baseUrl: backend.baseUrl,
    agentToken: backend.lock.agentToken,
    operatorToken: backend.lock.token,
    host: "swe-bench-host",
    onLog: () => undefined,
  });

  const results = [];
  try {
    for (const task of suite.tasks) {
      process.stdout.write(`  • ${task.id} … `);
      const result = await runTask({
        api: backend.api,
        op: backend.lock.token,
        agent: backend.lock.agentToken,
        root: backend.dirs.WORKSPACE_ROOT,
        suite,
        task,
      });
      results.push(result);
      console.log(
        result.pass
          ? `PASS (job=${result.jobStatus}, check=${result.check?.name})`
          : `FAIL (${result.reason ?? `job=${result.jobStatus}, check=${result.check?.name}:${result.check?.ok}`})`
      );
    }
  } finally {
    await runner.stop().catch(() => undefined);
    await backend.stop().catch(() => undefined);
    if (!args.keep) backend.cleanup();
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const report = {
    suite: suite.name ?? path.basename(args.suite),
    generatedAt: new Date().toISOString(),
    harness: "muon-swe-bench-scaffold",
    // Honesty flag: a fake-vendor run only proves the harness, not a real score.
    syntheticOnly: results.every((r) => r.vendor === "fake"),
    passed,
    total,
    passRate: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    results,
  };

  const outPath =
    args.out ??
    path.join(
      HERE,
      "reports",
      `report-${report.generatedAt.replace(/[:.]/g, "-")}.json`
    );
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("\n──────────── SWE-bench harness summary ────────────");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  (vendor=${r.vendor}, job=${r.jobStatus})`);
  }
  console.log("────────────────────────────────────────────────────");
  console.log(`${passed}/${total} task(s) passed  ·  pass rate ${(report.passRate * 100).toFixed(1)}%`);
  if (report.syntheticOnly) {
    console.log("NOTE: synthetic (fake-vendor) run, proves the harness, NOT a real SWE-bench score.");
  }
  console.log(`report: ${outPath}`);

  return passed === total ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\nSWE-bench harness FATAL: ${error.stack ?? error.message}`);
    process.exit(1);
  });
