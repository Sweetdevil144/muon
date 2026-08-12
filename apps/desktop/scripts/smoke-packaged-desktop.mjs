#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(desktopDir, "release");
const startupTimeoutMs = 60_000;
const runnerExitTimeoutMs = 15_000;
const maximumOutputBytes = 1024 * 1024;
const keepArtifacts = process.env.MUON_SMOKE_KEEP === "1";

async function findPackagedApp() {
  const override = process.env.MUON_APP_PATH?.trim();
  const candidates = override
    ? [path.resolve(override)]
    : [
        path.join(releaseDir, "mac-arm64", "MUON.app"),
        path.join(releaseDir, "mac-x64", "MUON.app"),
        path.join(releaseDir, "mac", "MUON.app"),
        path.join(releaseDir, "MUON.app"),
      ];
  if (!override && existsSync(releaseDir)) {
    for (const entry of await readdir(releaseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(releaseDir, entry.name, "MUON.app"));
      }
    }
  }
  const appPath = candidates.find((candidate) => existsSync(candidate));
  if (!appPath) {
    throw new Error(
      "MUON.app not found; run `npm run package:dir` first or set MUON_APP_PATH"
    );
  }
  return appPath;
}

function captureOutput(stream, state) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    state.bytes += Buffer.byteLength(chunk);
    if (state.bytes <= maximumOutputBytes) {
      state.chunks.push(chunk);
    } else {
      state.overflow = true;
    }
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitUntil(label, predicate, timeoutMs = startupTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${label} timed out after ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockfile(lockPath) {
  return waitUntil("packaged brain lockfile", async () => {
    if (!existsSync(lockPath)) return undefined;
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    return Number.isInteger(lock.port) && lock.port > 0 ? lock : undefined;
  });
}

async function requestJson(
  base,
  pathname,
  token,
  { method = "GET", body } = {}
) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(new URL(pathname, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  const parsedBody = await response.json().catch(() => ({}));
  return { response, body: parsedBody };
}

async function dispatchFakeJob({
  apiBase,
  operatorToken,
  agentToken,
  workspacePath,
  label,
}) {
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const created = await requestJson(apiBase, "/api/tasks", operatorToken, {
    method: "POST",
    body: {
      title: `Packaged runner ${label}`,
      description:
        "Production-path packaged desktop recovery and process-tree proof.",
      priority: "high",
      workspacePath,
    },
  });
  assert.equal(created.response.status, 201, "packaged task creation failed");

  const dispatched = await requestJson(apiBase, "/api/dispatch", agentToken, {
    method: "POST",
    body: {
      vendor: "fake",
      kind: "oneshot",
      taskId: created.body.task.id,
      brief: `Exercise the packaged runner ${label}.`,
      workspacePath,
    },
  });
  assert.equal(
    dispatched.response.status,
    201,
    `packaged fake dispatch failed: ${JSON.stringify(dispatched.body)}`
  );

  return waitUntil(`packaged fake job ${label}`, async () => {
    const current = await requestJson(
      apiBase,
      `/api/dispatch/${encodeURIComponent(dispatched.body.job.id)}`,
      agentToken
    );
    if (!current.response.ok) return undefined;
    return ["done", "failed", "interrupted"].includes(current.body.job?.status)
      ? current.body.job
      : undefined;
  });
}

async function waitForFakeAgentRelease(apiBase, operatorToken) {
  return waitUntil("packaged fake fleet agent release", async () => {
    const snapshot = await requestJson(
      apiBase,
      "/api/fleet/agents",
      operatorToken
    );
    if (!snapshot.response.ok) return undefined;
    const agent = snapshot.body.agents?.find(
      (candidate) => candidate.vendor === "fake"
    );
    return agent?.status === "idle" ? agent : undefined;
  });
}

async function readPositivePid(label, filePath) {
  return waitUntil(label, async () => {
    if (!existsSync(filePath)) return undefined;
    const pid = Number((await readFile(filePath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  });
}

async function prepareLegacyDatabase(appPath, dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, "muon.db");
  const migrationsRoot = path.join(
    appPath,
    "Contents",
    "Resources",
    "backend",
    "prisma",
    "migrations"
  );
  const versions = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name < "0009_runner_host_lease"
    )
    .map((entry) => entry.name)
    .sort();
  let sql = [
    `CREATE TABLE "_muon_migrations" ("version" TEXT PRIMARY KEY NOT NULL, "appliedAt" TEXT NOT NULL);`,
  ];
  for (const version of versions) {
    sql.push(
      await readFile(path.join(migrationsRoot, version, "migration.sql"), "utf8")
    );
    sql.push(
      `INSERT INTO "_muon_migrations" ("version","appliedAt") VALUES ('${version}','2026-07-13T00:00:00.000Z');`
    );
  }
  sql.push(
    `INSERT INTO "Runner" ("id","host","pid","status","lastSeenAt","createdAt")
     VALUES
       ('runner-old','desktop-legacy',41,'online','2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z'),
       ('runner-new','desktop-legacy',42,'online','2026-07-13T00:01:00.000Z','2026-07-13T00:01:00.000Z');`
  );
  const prepared = spawnSync("/usr/bin/sqlite3", [dbPath], {
    input: sql.join("\n"),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    prepared.status,
    0,
    `could not prepare pre-0009 packaged database: ${prepared.stderr}`
  );
  return dbPath;
}

async function assertMuonBranding(appPath) {
  assert.equal(
    path.basename(appPath),
    "MUON.app",
    "packaged application must be named MUON.app"
  );
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const readPlistValue = (key) => {
    const result = spawnSync(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", infoPlist],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 0, `could not read ${key}: ${result.stderr}`);
    return result.stdout.trim();
  };
  for (const key of ["CFBundleDisplayName", "CFBundleName", "CFBundleExecutable"]) {
    assert.equal(readPlistValue(key), "MUON", `${key} must be exactly MUON`);
  }
  assert.equal(readPlistValue("CFBundleIconFile"), "icon.icns");

  const sourceIcon = path.join(desktopDir, "build", "icon.icns");
  const packagedIcon = path.join(
    appPath,
    "Contents",
    "Resources",
    "icon.icns"
  );
  assert.equal(existsSync(packagedIcon), true, "packaged MUON icon is missing");
  assert.deepEqual(
    await readFile(packagedIcon),
    await readFile(sourceIcon),
    "packaged icon does not match the canonical public/logo.png-derived icon"
  );
}

async function main() {
  assert.equal(process.platform, "darwin", "packaged desktop smoke requires macOS");

  const appPath = await findPackagedApp();
  await assertMuonBranding(appPath);
  const appBinary = path.join(appPath, "Contents", "MacOS", "MUON");
  const migrationsRoot = path.join(
    appPath,
    "Contents",
    "Resources",
    "backend",
    "prisma",
    "migrations"
  );
  const expectedMigrations = (
    await readdir(migrationsRoot, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latestMigration = expectedMigrations.at(-1);
  assert.equal(existsSync(appBinary), true, `packaged binary missing: ${appBinary}`);
  assert.equal(
    latestMigration !== undefined &&
      existsSync(path.join(migrationsRoot, latestMigration, "migration.sql")),
    true,
    `packaged latest migration missing: ${latestMigration ?? "none"}`
  );

  const scratchDir = await mkdtemp(
    path.join(tmpdir(), "muon-packaged-desktop-smoke-")
  );
  const dataDir = path.join(scratchDir, "data");
  const descendantFile = path.join(scratchDir, "fake-descendant.pid");
  await chmod(scratchDir, 0o700);
  const legacyDbPath = await prepareLegacyDatabase(appPath, dataDir);

  const env = {
    ...process.env,
    MUON_DATA_DIR: dataDir,
    MUON_GRAPH_DISABLE_FTS: "1",
    MUON_REQUIRE_SANDBOX: "1",
    MUON_SANDBOX: "1",
    MUON_FAKE_VENDOR: "1",
    MUON_FAKE_VENDOR_DESCENDANT_FILE: descendantFile,
    MUON_WORKSPACE_ROOTS: scratchDir,
    NODE_ENV: "production",
  };
  delete env.DATABASE_URL;
  delete env.MUON_API_TOKEN;
  delete env.MUON_OPERATOR_TOKEN;
  delete env.MUON_AGENT_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;

  const output = { bytes: 0, chunks: [], overflow: false };
  let appProcess;
  let appExited;
  let lock;
  let runnerPid;
  let descendantPid;
  let finalDescendantPid;

  try {
    appProcess = spawn(appBinary, [], {
      cwd: scratchDir,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    captureOutput(appProcess.stdout, output);
    captureOutput(appProcess.stderr, output);
    appExited = waitForExit(appProcess);

    const lockPath = path.join(dataDir, "brain.lock");
    lock = await Promise.race([
      readLockfile(lockPath),
      appExited.then(({ code, signal }) => {
        throw new Error(
          `packaged desktop exited before brain boot (code=${code}, signal=${signal})`
        );
      }),
    ]);
    assert.equal(
      (await stat(lockPath)).mode & 0o777,
      0o600,
      "brain lockfile must be owner-only"
    );
    assert.equal(typeof lock.token, "string");
    assert.equal(typeof lock.agentToken, "string");
    assert.notEqual(lock.token, lock.agentToken, "operator and agent tokens collapsed");
    assert.equal(lock.dbPath, legacyDbPath);

    const apiBase = `http://127.0.0.1:${lock.port}`;
    await waitUntil("embedded brain health", async () => {
      const { response, body } = await requestJson(apiBase, "/health");
      return response.ok && body.status === "ok";
    });

    const unauthenticated = await requestJson(apiBase, "/api/runner");
    assert.equal(
      unauthenticated.response.status,
      401,
      "real two-token middleware did not reject an unauthenticated runner read"
    );
    const agentGovernAttempt = await requestJson(
      apiBase,
      "/api/fleet",
      lock.agentToken,
      { method: "PUT", body: { codex: 0 } }
    );
    assert.equal(
      agentGovernAttempt.response.status,
      403,
      "agent token crossed the govern one-way valve"
    );
    const operatorGovernAttempt = await requestJson(
      apiBase,
      "/api/fleet",
      lock.token,
      { method: "PUT", body: { codex: 0 } }
    );
    assert.equal(
      operatorGovernAttempt.response.status,
      200,
      "operator token could not perform a govern-tier fleet update"
    );

    const host = `desktop-${hostname()}`;
    const runner = await waitUntil("real supervised packaged runner", async () => {
      const { response, body } = await requestJson(
        apiBase,
        `/api/runner?host=${encodeURIComponent(host)}`,
        lock.agentToken
      );
      if (!response.ok || body.live !== true) return undefined;
      return body.runner;
    });
    assert.equal(runner.host, host);
    assert.equal(Number.isInteger(runner.pid) && runner.pid > 0, true);
    assert.equal(
      Object.hasOwn(runner, "leaseHash"),
      false,
      "runner lease hash leaked through the public status route"
    );
    runnerPid = runner.pid;
    assert.equal(processIsAlive(runnerPid), true, "supervised runner PID is not alive");

    const sqlite = spawnSync(
      "/usr/bin/sqlite3",
      [
        lock.dbPath,
        `SELECT version FROM "_muon_migrations" ORDER BY version;`,
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(
      sqlite.status,
      0,
      `could not inspect packaged SQLite migrations: ${sqlite.stderr}`
    );
    assert.equal(
      sqlite.stdout.trim(),
      expectedMigrations.join("\n"),
      "packaged embedded backend did not apply every shipped migration"
    );
    const deduped = spawnSync(
      "/usr/bin/sqlite3",
      [
        lock.dbPath,
        `SELECT id FROM "Runner" WHERE host='desktop-legacy' ORDER BY id;`,
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(deduped.status, 0, deduped.stderr);
    assert.equal(
      deduped.stdout.trim(),
      "runner-new",
      "packaged migration did not keep only the freshest historical runner"
    );

    const firstJob = await dispatchFakeJob({
      apiBase,
      operatorToken: lock.token,
      agentToken: lock.agentToken,
      workspacePath: path.join(scratchDir, "workspace-first"),
      label: "first dispatch",
    });
    assert.equal(
      firstJob.status,
      "done",
      `packaged fake dispatch failed: ${firstJob.result ?? firstJob.status}`
    );
    const released = await waitForFakeAgentRelease(apiBase, lock.token);
    assert.equal(
      released.currentTaskId,
      null,
      "terminal dispatch did not clear the fleet task ownership"
    );
    assert.equal(
      released.currentJobId,
      null,
      "terminal dispatch did not clear the exact fleet job ownership"
    );
    descendantPid = await readPositivePid(
      "first fake vendor descendant",
      descendantFile
    );
    assert.equal(
      processIsAlive(descendantPid),
      true,
      "fake vendor cleanup descendant did not remain alive for the proof"
    );

    // Crash only the runner. The supervisor must fence the old process group
    // (including an intentionally orphaned vendor descendant) and replace it.
    process.kill(runnerPid, "SIGKILL");
    await waitUntil(
      "unexpected runner exit cleanup",
      () =>
        !processIsAlive(runnerPid) && !processIsAlive(descendantPid),
      runnerExitTimeoutMs
    );
    const replacement = await waitUntil(
      "automatic packaged runner restart",
      async () => {
        const { response, body } = await requestJson(
          apiBase,
          `/api/runner?host=${encodeURIComponent(host)}`,
          lock.agentToken
        );
        if (
          !response.ok ||
          body.live !== true ||
          !Number.isInteger(body.runner?.pid) ||
          body.runner.pid === runnerPid
        ) {
          return undefined;
        }
        return body.runner;
      }
    );
    runnerPid = replacement.pid;
    assert.equal(
      processIsAlive(runnerPid),
      true,
      "replacement runner PID is not alive"
    );

    await rm(descendantFile, { force: true });
    const secondJob = await dispatchFakeJob({
      apiBase,
      operatorToken: lock.token,
      agentToken: lock.agentToken,
      workspacePath: path.join(scratchDir, "workspace-after-restart"),
      label: "post-restart dispatch",
    });
    assert.equal(
      secondJob.status,
      "done",
      `replacement runner did not execute work: ${
        secondJob.result ?? secondJob.status
      }`
    );
    await waitForFakeAgentRelease(apiBase, lock.token);
    finalDescendantPid = await readPositivePid(
      "post-restart fake vendor descendant",
      descendantFile
    );
    assert.equal(processIsAlive(finalDescendantPid), true);

    // Hard-crash Electron main. fd3 must close, making the runner drain itself;
    // no graceful quit coordinator or supervisor cleanup is available here.
    // The parent guard must terminate the whole detached process group.
    appProcess.kill("SIGKILL");
    await appExited;
    await waitUntil(
      "runner parent-death process-tree shutdown",
      () =>
        !processIsAlive(runnerPid) &&
        !processIsAlive(finalDescendantPid),
      runnerExitTimeoutMs
    );

    assert.equal(output.overflow, false, "desktop output exceeded 1 MiB");
    process.stdout.write(
      [
        "packaged desktop production-path smoke passed",
        `  app: ${appPath}`,
        "  branding: MUON bundle name + canonical public/logo.png icon",
        `  data: ${dataDir}`,
        `  backend: existing embedded SQLite upgraded through ${latestMigration}`,
        "  auth: 401 unauthenticated; agent 403 govern; operator 200 govern",
        "  runner: real dispatch completed, exact job ownership released",
        "  recovery: unexpected runner SIGKILL cleaned descendants + auto-restarted",
        "  crash: Electron SIGKILL closed fd3; full runner process group exited",
      ].join("\n") + "\n"
    );
  } finally {
    for (const pid of [descendantPid, finalDescendantPid]) {
      if (pid && processIsAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (runnerPid && processIsAlive(runnerPid)) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        try {
          process.kill(runnerPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    if (appProcess?.pid) {
      try {
        process.kill(-appProcess.pid, "SIGKILL");
      } catch {
        // app process group already gone
      }
    }
    if (lock?.pid && processIsAlive(lock.pid)) {
      try {
        process.kill(lock.pid, "SIGKILL");
      } catch {
        // brain already gone
      }
    }
    if (keepArtifacts) {
      process.stderr.write(`packaged desktop smoke artifacts kept at ${scratchDir}\n`);
    } else {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `packaged desktop smoke failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
