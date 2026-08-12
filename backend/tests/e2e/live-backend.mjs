// MUON P7, shared live-backend + in-process-runner harness.
//
// Boots the REAL embedded backend as a CHILD PROCESS (node backend/dist/index.js)
// against a FRESH throwaway data dir, and (optionally) drives the REAL persistent
// runner IN-PROCESS via `runRunnerLoop` from the built @muon/runner. This is the
// same spine a production dispatch flows through, the ONLY substitution is the
// deterministic `fake` vendor leaf (MUON_FAKE_VENDOR=1), so there is no real
// vendor CLI, no token, and no network.
//
// Hermetic + deterministic by construction (mirrors e2e-smoke.mjs):
//   • fresh temp data dir (its own SQLite db + graph .lbug + lockfile); the
//     developer's real brain dir is never touched.
//   • DATABASE_URL explicitly targets the fresh temp SQLite file. This is set
//     before ESM imports initialize Prisma; relying on env.ts to fill it later
//     races Prisma module evaluation.
//   • MUON_EMBED_DISABLE=1 → pure lexical brain (no Ollama probe, no network).
//   • MUON_GRAPH_DISABLE_FTS=1 → no native FTS extension (mirrors CI).
//   • the backend child's PATH points at an EMPTY dir, so the readiness prober
//     can never spawn a real vendor CLI → every REAL vendor deterministically
//     reports not-installed, and no real vendor process is ever executed.
//   • MUON_FAKE_VENDOR=1 seeds ONLY the dev/test fake lane + one fake fleet agent.
//   • MUON_WORKSPACE_ROOTS is a temp dir → the dispatch's workspacePath is inside
//     the P3-B allowlist; nothing else on disk is reachable.
//   • child process killed + every temp dir removed on cleanup().

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Built runtime spine, imported from dist so the E2E drives the REAL runner,
// not a mock. Resolves relative to THIS file (backend/tests/e2e).
import {
  authorizeRunnerLease,
  MuonApiClient,
} from "../../../packages/client/dist/index.js";
import { runRunnerLoop } from "../../../packages/runner/dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const BACKEND_ENTRY =
  process.env.E2E_BACKEND_ENTRY ||
  path.join(REPO_ROOT, "backend", "dist", "index.js");
const NODE_BIN = process.execPath;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function assertStatus(res, expected, label) {
  assert(
    res.status === expected,
    `${label}: expected HTTP ${expected}, got ${res.status}, body: ${res.text}`
  );
}

// Read-after-write over HTTP is eventually consistent (memory writes are
// ledger-first then mirrored to the read graph). Poll a condition until it holds.
export async function until(fn, { tries = 60, delay = 250, label = "condition" } = {}) {
  let lastError;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(delay);
    }
  }
  throw new Error(`${label}: not satisfied after ${tries} tries, ${lastError?.message}`);
}

/**
 * Boot the real embedded backend with the fake-vendor seam enabled. Returns a
 * handle with a bound HTTP client, the two-token lockfile, and lifecycle hooks.
 */
export async function startLiveBackend({
  prefix = "muon-loop",
  allowGit = false,
} = {}) {
  const DATA_DIR = mkdtempSync(path.join(tmpdir(), `${prefix}-data-`));
  const RUN_CWD = mkdtempSync(path.join(tmpdir(), `${prefix}-cwd-`));
  const EMPTY_BIN = mkdtempSync(path.join(tmpdir(), `${prefix}-nobin-`));
  const WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), `${prefix}-ws-`));
  const WORKTREE_ROOT = path.join(WORKSPACE_ROOT, "managed-worktrees");
  const originalWorktreeRoot = process.env.MUON_WORKTREE_ROOT;
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  // The backend is a child process while the runner is in this process. Bind
  // both to ONE disposable worktree root, otherwise each resolves its own data
  // directory and the runner can leave E2E worktrees in the user's real MUON
  // profile while the backend looks somewhere else during review/merge.
  process.env.MUON_WORKTREE_ROOT = WORKTREE_ROOT;
  mkdirSync(path.join(DATA_DIR, "graph"), { recursive: true });
  if (allowGit) {
    const gitBinary = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => path.join(entry, "git"))
      .find((candidate) => existsSync(candidate));
    if (!gitBinary) {
      throw new Error("allowGit requested, but no git executable was found.");
    }
    symlinkSync(gitBinary, path.join(EMPTY_BIN, "git"));
  }
  const LOCK_PATH = path.join(DATA_DIR, "brain.lock");

  let child = null;
  const logRing = [];
  const pushLog = (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      logRing.push(line);
      if (logRing.length > 300) logRing.shift();
    }
  };
  const recentLogs = () => logRing.slice(-50).join("\n");

  const spawnBackend = () => {
    const proc = spawn(NODE_BIN, [BACKEND_ENTRY], {
      cwd: RUN_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: process.env.HOME,
        PATH: EMPTY_BIN,
        MUON_DATA_DIR: DATA_DIR,
        DATABASE_URL: `file:${path.join(DATA_DIR, "muon.db")}`,
        MUON_EMBED_DISABLE: "1",
        MUON_GRAPH_DISABLE_FTS: "1",
        // The DEV/TEST seam. Enables the fake lane + fleet agent + adapter, and
        // admits `vendor:"fake"` on dispatch/claim. Real vendors are unaffected.
        MUON_FAKE_VENDOR: "1",
        // P3-B allowlist: the dispatch workspacePath lives under this temp root.
        MUON_WORKSPACE_ROOTS: WORKSPACE_ROOT,
        MUON_WORKTREE_ROOT: WORKTREE_ROOT,
        NODE_ENV: "production",
      },
    });
    proc.stdout.on("data", pushLog);
    proc.stderr.on("data", pushLog);
    child = proc;
    return proc;
  };

  const readLock = () => {
    try {
      const parsed = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
      if (typeof parsed.port === "number" && typeof parsed.token === "string") {
        return parsed;
      }
    } catch {
      // truncated / not written yet
    }
    return null;
  };

  const waitForBrain = async () => {
    for (let i = 0; i < 120; i += 1) {
      const lock = readLock();
      if (lock) return lock;
      if (child && child.exitCode !== null) {
        throw new Error(
          `backend exited early (code ${child.exitCode}) before publishing its lockfile.\n--- boot log ---\n${recentLogs()}`
        );
      }
      await sleep(500);
    }
    throw new Error(
      `timed out (60s) waiting for the brain lockfile.\n--- boot log ---\n${recentLogs()}`
    );
  };

  const exitPromise = (proc) => new Promise((resolve) => proc.once("exit", resolve));

  const stop = async () => {
    if (!child) return;
    const proc = child;
    child = null;
    proc.kill("SIGTERM");
    await Promise.race([exitPromise(proc), sleep(8000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await Promise.race([exitPromise(proc), sleep(2000)]);
    }
  };

  const cleanup = () => {
    try {
      if (child) child.kill("SIGKILL");
    } catch {
      // best-effort
    }
    for (const dir of [DATA_DIR, RUN_CWD, EMPTY_BIN, WORKSPACE_ROOT]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    if (originalWorktreeRoot === undefined) {
      delete process.env.MUON_WORKTREE_ROOT;
    } else {
      process.env.MUON_WORKTREE_ROOT = originalWorktreeRoot;
    }
  };

  spawnBackend();
  const lock = await waitForBrain();
  // Mutable so kill()/restart() (P0.1 checkpoint+resume E2E) can re-point the
  // shared api() at the reborn process; `baseUrl` keeps the initial value for
  // existing callers that never restart.
  let currentBaseUrl = `http://127.0.0.1:${lock.port}`;
  const baseUrl = currentBaseUrl;

  const api = async (method, route, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${currentBaseUrl}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };

  /** SIGKILL the backend child — the real "the process stopped" kill. */
  const kill = async () => {
    if (!child) return;
    const proc = child;
    child = null;
    proc.kill("SIGKILL");
    await Promise.race([exitPromise(proc), sleep(4000)]);
  };

  /**
   * Reboot the SAME data dir (the resume acceptance path). The lockfile is
   * removed first so waitForBrain never reads the dead incarnation's stale
   * port/token. Returns the new lock + base url.
   */
  const restart = async () => {
    await kill();
    try {
      rmSync(LOCK_PATH, { force: true });
    } catch {
      // best-effort; waitForBrain tolerates a short race
    }
    spawnBackend();
    const newLock = await waitForBrain();
    currentBaseUrl = `http://127.0.0.1:${newLock.port}`;
    return { lock: newLock, baseUrl: currentBaseUrl };
  };

  return {
    baseUrl,
    getBaseUrl: () => currentBaseUrl,
    lock,
    api,
    kill,
    restart,
    stop,
    cleanup,
    recentLogs,
    dirs: {
      DATA_DIR,
      RUN_CWD,
      EMPTY_BIN,
      WORKSPACE_ROOT,
      WORKTREE_ROOT,
      LOCK_PATH,
    },
  };
}

/**
 * Drive the REAL persistent runner in-process against a booted backend. Uses the
 * built @muon/runner + @muon/client, NOT a mock. Returns the client and a
 * drain-and-stop hook (AbortSignal → the loop finishes in-flight work, releases
 * its agent, and exits).
 */
export function startInProcessRunner({
  baseUrl,
  agentToken,
  operatorToken,
  host = "e2e-loop-host",
  execute,
  heartbeatMs = 1000,
  pollMs = 200,
  onLog,
}) {
  // The runner runs the fake adapter IN THIS PROCESS, so the seam env must be
  // set here too (createDefaultAdapters reads process.env when a job executes).
  process.env.MUON_FAKE_VENDOR = "1";
  const client = new MuonApiClient(baseUrl, fetch, agentToken);
  const controller = new AbortController();
  const leaseToken = randomBytes(32).toString("hex");
  const loop = (async () => {
    await authorizeRunnerLease(
      { apiBase: baseUrl, operatorToken },
      host,
      leaseToken
    );
    await runRunnerLoop(client, {
      host,
      pid: process.pid,
      leaseToken,
      apiBase: baseUrl,
      apiToken: agentToken,
      concurrency: 4,
      pollMs,
      heartbeatMs,
      execute,
      signal: controller.signal,
      onLog: onLog ?? (() => undefined),
    });
  })();
  return {
    client,
    stop: async () => {
      controller.abort();
      await loop.catch(() => undefined);
    },
  };
}
