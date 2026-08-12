#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAge,
  formatBytes,
  fileFacts,
  isProcessAlive,
  logPaths,
  probeBrainHealth,
  readBrainLock,
  resolveDataDir,
} from "./lib/muon-debug.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export function parseArgs(argv) {
  let buildMode = "rebuild";
  let buildModeWasSet = false;
  let debug = false;

  for (const arg of argv) {
    if (arg === "--fresh" || arg === "--fast") {
      if (buildModeWasSet) {
        throw new Error("Choose only one build mode: --fresh or --fast.");
      }
      buildMode = arg === "--fresh" ? "fresh" : "fast";
      buildModeWasSet = true;
      continue;
    }
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { buildMode, debug };
}

/**
 * Debug mode is one switch that turns on everything a developer needs:
 *   MUON_DEBUG=1        main + renderer console TEE'd to logs/desktop.log, and
 *                       the brain/runner child stdio mirrored to this terminal
 *   MUON_LOG_LEVEL      raises the embedded brain's pino level (poll traffic is
 *                       logged at debug, so this is what un-hides it)
 * Both are read ONLY when set, so a normal `npm run dev:desktop` is unchanged.
 */
export function debugEnvironment(options) {
  if (!options.debug) {
    return {};
  }
  return {
    MUON_DEBUG: "1",
    MUON_LOG_LEVEL: process.env.MUON_LOG_LEVEL ?? "debug",
  };
}

export function buildCommandPlan(options) {
  const commands = [];
  if (options.buildMode !== "fast") {
    commands.push({
      command: "bash",
      args: ["scripts/ci-install.sh"],
      ...(options.buildMode === "rebuild"
        ? { env: { SKIP_INSTALL: "1" } }
        : {}),
      label:
        options.buildMode === "fresh"
          ? "Install and rebuild MUON"
          : "Rebuild MUON",
    });
  }
  commands.push({
    command: "npm",
    args: ["run", "--prefix", "apps/desktop", "ensure-electron"],
    label: "Verify Electron",
  });
  commands.push({
    command: "npm",
    args: ["run", "--prefix", "apps/desktop", "start"],
    // Local development ships node-pty and verifies its executable in the
    // step above, so the ordinary launcher should open an actual shell.
    // An explicit MUON_REAL_PTY=0 remains an opt-out for relay-only tests.
    env: {
      MUON_REAL_PTY: process.env.MUON_REAL_PTY ?? "1",
      ...debugEnvironment(options),
    },
    label: options.debug
      ? "Launch MUON Desktop (debug)"
      : "Launch MUON Desktop",
    longRunning: true,
  });
  return commands;
}

function verifyRepository() {
  const required = [
    "package.json",
    "scripts/ci-install.sh",
    "apps/desktop/package.json",
    "apps/tui/package.json",
  ];
  const missing = required.filter(
    (entry) => !existsSync(path.join(REPO_ROOT, entry))
  );
  if (missing.length > 0) {
    throw new Error(`MUON checkout is incomplete: missing ${missing.join(", ")}`);
  }
}

function verifyFastArtifacts() {
  const required = [
    "backend/dist/index.js",
    "packages/runner/dist/index.js",
    "apps/desktop/dist/main.js",
  ];
  const missing = required.filter(
    (entry) => !existsSync(path.join(REPO_ROOT, entry))
  );
  if (missing.length > 0) {
    throw new Error(
      `Fast launch needs existing build artifacts. Missing: ${missing.join(
        ", "
      )}. Run npm run dev:desktop first.`
    );
  }
}

/** Where everything lives, printed BEFORE Electron starts so it scrolls last. */
function printDebugPreamble() {
  const { dir, source } = resolveDataDir();
  const logs = logPaths(dir);
  const brain = fileFacts(logs.brain);
  const runner = fileFacts(logs.runner);
  console.log("");
  console.log("[MUON debug] data dir   %s  [%s]", dir, source);
  console.log("[MUON debug] database   %s", path.join(dir, "muon.db"));
  console.log(
    "[MUON debug] brain.log  %s  (%s)",
    logs.brain,
    brain.exists ? formatBytes(brain.bytes) : "not created yet"
  );
  console.log(
    "[MUON debug] runner.log %s  (%s)",
    logs.runner,
    runner.exists ? formatBytes(runner.bytes) : "not created yet"
  );
  console.log("[MUON debug] desktop.log %s  (main + renderer console)", logs.desktop);
  console.log(
    "[MUON debug] verbose backend logging is ON (MUON_LOG_LEVEL=%s)",
    process.env.MUON_LOG_LEVEL ?? "debug"
  );
  console.log("[MUON debug] triage any time with: npm run debug:report");
  console.log("");
  return dir;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Report the brain's resolved port + the runner's status once the app has
 * published them. Runs BESIDE the long-running Electron step (never blocks it)
 * and gives up quietly, so a slow or failed boot cannot wedge the launcher.
 */
async function watchStartup(dataDir, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(1000);
    const lock = readBrainLock(dataDir);
    if (!lock || !isProcessAlive(lock.pid)) {
      continue;
    }
    const healthy = await probeBrainHealth(lock.base);
    if (!healthy) {
      continue;
    }
    console.log("");
    console.log(
      "[MUON debug] brain READY on %s (pid %d, started %s)",
      lock.base,
      lock.pid,
      formatAge(lock.startedAt)
    );
    console.log(
      "[MUON debug] credentials minted: operator=%s agent=%s (values never printed)",
      lock.hasOperatorToken ? "yes" : "no",
      lock.hasAgentToken ? "yes" : "no"
    );
    console.log(
      "[MUON debug] runner status is printed by the app as `[runner] status=…`"
    );
    console.log("");
    return;
  }
  console.log(
    "[MUON debug] no healthy brain reported within %ds — check %s",
    Math.round(timeoutMs / 1000),
    logPaths(dataDir).brain
  );
}

async function runCommand(step) {
  console.log(`\n[MUON dev] ${step.label}`);
  await new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: "inherit",
    });

    const forward = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      if (code === 0 || (step.longRunning && signal === "SIGINT")) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${step.label} failed${
            signal ? ` from ${signal}` : ` with exit code ${code ?? "unknown"}`
          }.`
        )
      );
    });
  });
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("MUON Desktop development currently requires macOS.");
  }
  const options = parseArgs(process.argv.slice(2));
  verifyRepository();
  if (options.buildMode === "fast") {
    verifyFastArtifacts();
  }

  console.log(
    "[MUON dev] The native app will supervise the embedded brain and runner."
  );
  console.log(
    "[MUON dev] For TUI parity, open another terminal and run: npm run tui"
  );
  let dataDir = null;
  if (options.debug) {
    dataDir = printDebugPreamble();
  }
  for (const step of buildCommandPlan(options)) {
    if (step.longRunning && dataDir) {
      // Fire-and-forget: this only prints, and must never delay the launch.
      void watchStartup(dataDir).catch(() => undefined);
    }
    await runCommand(step);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(
      `[MUON dev] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
