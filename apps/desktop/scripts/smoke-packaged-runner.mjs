#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sandboxedRunnerEnv,
  selectSandboxLauncher,
} from "@muon/adapters";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(desktopDir, "release");
const startupTimeoutMs = 20_000;
const shutdownTimeoutMs = 10_000;
const entryProbeTimeoutMs = 30_000;
const maximumOutputBytes = 1024 * 1024;

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    timer.unref();
  });
}

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
      `MUON.app not found; run \`npm run package:dir\` first or set MUON_APP_PATH (checked ${candidates.join(
        ", "
      )})`
    );
  }
  return appPath;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      throw new Error("fake brain request exceeded 64 KiB");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function startFakeBrain({
  agentToken,
  host,
  leaseToken,
  operatorSentinel,
}) {
  const observed = {
    heartbeat: false,
    reclaim: false,
    dispatch: false,
  };
  let resolveReady;
  let rejectReady;
  let settled = false;
  let failure;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const markReady = () => {
    if (!settled && observed.heartbeat && observed.reclaim && observed.dispatch) {
      settled = true;
      resolveReady();
    }
  };

  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        request.headers.authorization,
        `Bearer ${agentToken}`,
        "runner must authenticate with the agent token"
      );
      assert.equal(
        JSON.stringify(request.headers).includes(operatorSentinel),
        false,
        "operator-token sentinel leaked into request headers"
      );

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/runner/heartbeat") {
        const body = await readJsonBody(request);
        assert.equal(body.host, host, "heartbeat host must match exactly");
        assert.equal(
          Number.isInteger(body.pid) && body.pid > 0,
          true,
          "heartbeat must include the packaged runner pid"
        );
        assert.equal(
          body.leaseToken,
          leaseToken,
          "heartbeat must present the exact preauthorized runner lease"
        );
        assert.equal(
          JSON.stringify(body).includes(operatorSentinel),
          false,
          "operator-token sentinel leaked into heartbeat"
        );
        observed.heartbeat = true;
        sendJson(response, 200, {
          runner: {
            id: `smoke-runner-${process.pid}`,
            host,
            pid: body.pid,
            status: "online",
            lastSeenAt: new Date().toISOString(),
          },
        });
        markReady();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/dispatch/reclaim") {
        const body = await readJsonBody(request);
        assert.equal(body.host, host, "reclaim host must match exactly");
        assert.equal(
          JSON.stringify(body).includes(operatorSentinel),
          false,
          "operator-token sentinel leaked into reclaim"
        );
        observed.reclaim = true;
        sendJson(response, 200, { reclaimed: 0, jobIds: [] });
        markReady();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/dispatch") {
        assert.equal(
          url.searchParams.get("status"),
          "queued",
          "runner must poll the queued dispatch view"
        );
        observed.dispatch = true;
        sendJson(response, 200, { jobs: [] });
        markReady();
        return;
      }

      throw new Error(`unexpected fake brain request: ${request.method} ${url}`);
    } catch (error) {
      failure ??= error;
      if (!settled) {
        settled = true;
        rejectReady(error);
      }
      sendJson(response, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    observed,
    ready,
    get failure() {
      return failure;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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

async function main() {
  assert.equal(process.platform, "darwin", "packaged runner smoke requires macOS");

  const appPath = await findPackagedApp();
  const appBinary = path.join(appPath, "Contents", "MacOS", "MUON");
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const runnerEntry = path.join(asarPath, "dist", "runner-entry.js");
  assert.equal(existsSync(appBinary), true, `packaged binary missing: ${appBinary}`);
  assert.equal(existsSync(asarPath), true, `app.asar missing: ${asarPath}`);
  const probeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete probeEnv.MUON_API_TOKEN;
  delete probeEnv.MUON_OPERATOR_TOKEN;
  const entryProbe = spawnSync(
    appBinary,
    [
      "-e",
      [
        'const fs = require("node:fs");',
        "const target = process.argv[1];",
        "process.exit(fs.existsSync(target) ? 0 : 42);",
      ].join(" "),
      runnerEntry,
    ],
    {
      env: probeEnv,
      encoding: "utf8",
      timeout: entryProbeTimeoutMs,
    }
  );
  assert.equal(
    entryProbe.status,
    0,
    `packaged runner entry missing or unreadable: ${runnerEntry}\n` +
      `signal=${entryProbe.signal ?? "none"} error=${
        entryProbe.error?.message ?? "none"
      }\n${entryProbe.stderr ?? ""}`
  );

  const scratchDir = await mkdtemp(
    path.join(tmpdir(), "muon-packaged-runner-smoke-")
  );
  const dataDir = path.join(scratchDir, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const host = `desktop-smoke-${process.pid}`;
  const agentToken = `agent-smoke-${process.pid}-${Date.now()}`;
  const leaseToken = randomBytes(32).toString("hex");
  const operatorSentinel = `operator-must-not-leak-${process.pid}-${Date.now()}`;
  await writeFile(
    path.join(dataDir, "brain.lock"),
    JSON.stringify({ token: operatorSentinel }),
    { mode: 0o600 }
  );

  let brain;
  let child;
  let exitResult;
  const stdout = { bytes: 0, chunks: [], overflow: false };
  const stderr = { bytes: 0, chunks: [], overflow: false };

  try {
    brain = await startFakeBrain({
      agentToken,
      host,
      leaseToken,
      operatorSentinel,
    });

    const launcher = selectSandboxLauncher({
      ...process.env,
      MUON_SANDBOX: "1",
    });
    assert.equal(
      launcher.isAvailable(),
      true,
      "MUON Seatbelt launcher is unavailable"
    );
    const wrapped = launcher.wrap(appBinary, [runnerEntry], { dataDir });
    assert.equal(wrapped.sandboxed, true, "runner must be wrapped by Seatbelt");

    const env = sandboxedRunnerEnv({
      apiBase: brain.apiBase,
      agentToken,
      leaseToken,
      sandboxed: true,
      parentEnv: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MUON_API_TOKEN: operatorSentinel,
        MUON_OPERATOR_TOKEN: operatorSentinel,
        MUON_RUNNER_HOST: host,
      },
    });
    delete env.ELECTRON_NO_ASAR;
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.MUON_RUNNER_HOST, host);
    assert.equal(env.MUON_AGENT_TOKEN, agentToken);
    assert.equal(env.MUON_RUNNER_LEASE_TOKEN, leaseToken);
    assert.equal(env.MUON_SANDBOX_ACTIVE, "1");
    assert.equal(env.MUON_API_TOKEN, undefined);
    assert.equal(env.MUON_OPERATOR_TOKEN, undefined);
    assert.equal(
      JSON.stringify(env).includes(operatorSentinel),
      false,
      "operator-token sentinel remained in the child environment"
    );

    const diagnosticCwd =
      process.env.MUON_SMOKE_RUNNER_CWD?.trim() || desktopDir;
    const diagnosticParentPipe =
      process.env.MUON_SMOKE_RUNNER_FD3 === "1";
    child = spawn(wrapped.command, wrapped.args, {
      cwd: diagnosticCwd,
      detached: true,
      env,
      stdio: diagnosticParentPipe
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
    });
    child.stdio[3]?.unref?.();
    captureOutput(child.stdout, stdout);
    captureOutput(child.stderr, stderr);
    const exited = waitForExit(child);

    await Promise.race([
      brain.ready,
      exited.then(({ code, signal }) => {
        const childOutput = `${stdout.chunks.join("")}\n${stderr.chunks.join(
          ""
        )}`.trim();
        throw new Error(
          `packaged runner exited before becoming ready (code=${code}, signal=${signal})` +
            (childOutput ? `\n${childOutput}` : "")
        );
      }),
      timeoutAfter(startupTimeoutMs, "packaged runner startup timed out"),
    ]);

    assert.equal(stdout.overflow, false, "runner stdout exceeded 1 MiB");
    assert.equal(stderr.overflow, false, "runner stderr exceeded 1 MiB");
    const bootOutput = `${stdout.chunks.join("")}\n${stderr.chunks.join("")}`;
    assert.match(
      bootOutput,
      new RegExp(
        `\\[runner\\] host=${host} tier=agent sandbox=on`
      ),
      "runner did not report its sandboxed agent identity"
    );
    assert.match(
      bootOutput,
      new RegExp(`\\[runner\\] online as ${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      "runner did not report an online state"
    );

    // The real supervisor closes its fd3 ownership pipe before signalling so
    // the runner cannot retain a parent-watch handle during graceful drain.
    child.stdio[3]?.destroy?.();
    assert.equal(child.kill("SIGTERM"), true, "failed to send SIGTERM to runner");
    exitResult = await Promise.race([
      exited,
      timeoutAfter(shutdownTimeoutMs, "packaged runner clean drain timed out"),
    ]);
    assert.deepEqual(
      exitResult,
      { code: 0, signal: null },
      "packaged runner did not exit cleanly"
    );

    assert.equal(stdout.overflow, false, "runner stdout exceeded 1 MiB");
    assert.equal(stderr.overflow, false, "runner stderr exceeded 1 MiB");
    const output = `${stdout.chunks.join("")}\n${stderr.chunks.join("")}`;
    assert.match(output, /\[runner\] draining/);
    assert.match(output, /\[runner\] offline/);
    assert.equal(
      output.includes(operatorSentinel),
      false,
      "operator-token sentinel leaked into runner output"
    );
    assert.deepEqual(brain.observed, {
      heartbeat: true,
      reclaim: true,
      dispatch: true,
    });
    assert.equal(
      brain.failure,
      undefined,
      `fake brain observed an invalid request: ${brain.failure}`
    );

    process.stdout.write(
      [
        "packaged runner smoke passed",
        `  app: ${appPath}`,
        `  entry: ${runnerEntry}`,
        `  host: ${host}`,
        "  sandbox: Seatbelt",
        "  auth: agent-only; operator sentinel absent",
        "  shutdown: SIGTERM drained cleanly",
      ].join("\n") + "\n"
    );
  } finally {
    if (
      child &&
      exitResult === undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    if (brain) {
      await brain.close();
    }
    await rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `packaged runner smoke failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
});
