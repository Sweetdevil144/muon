#!/usr/bin/env node
/**
 * MUON MISSION SMOKE — the end-to-end that `scripts/e2e-smoke.sh` deliberately
 * is not.
 *
 * The hermetic E2E runs the backend with an EMPTY PATH so no real vendor CLI
 * can ever spawn. That is the right posture for CI determinism and exactly the
 * wrong posture for the question the founder keeps asking: "does a mission
 * that dispatches real vendor children actually land real work?" Three
 * regressions in a row (claude children denied by Claude's own permission
 * layer with ZERO approval rows filed; `codex resume` unable to find the
 * session a governed dispatch recorded; the Cursor tab respawn loop) shipped
 * with unit tests green because nothing ever exercised the real chain.
 *
 * This script runs ONE small real mission end to end and asserts every link:
 *
 *   1. a mission dispatches two governed children on disjoint scopes
 *   2. each child's tool calls reach MUON's approval gate (real
 *      ApprovalRequest rows attributed to that child's job — zero rows while
 *      the child's edits fail is the exact founder bug)
 *   3. under standing consent the approvals are decided and the child's edit
 *      actually lands on disk in its worktree
 *   4. the worktree is test-capable (the repo's own test command runs inside
 *      it — a broken link is what made a real mission report BLOCKED)
 *   5. each child reaches terminal with a typed handoff packet readable via
 *      the same path the coordinator uses (task detail -> handoffs[].packetJson,
 *      i.e. the `handoff_read` tool's read path)
 *   6. the orchestrator wakes on child-terminal and posts a final summary
 *      with no human nudge
 *   7. peer messaging delivers at least one message between the two children
 *   8. the recorded vendorSessionId for each child actually resumes
 *      (`claude --resume` / `codex exec resume`) — the dead-button check
 *   9. nothing is left running; no orphan vendor process survives
 *
 * SAFETY (hard constraints, all enforced below):
 *   - scratch git repo under a mkdtemp root; scratch MUON_DATA_DIR; scratch
 *     TMPDIR so the codex guard home (`$TMPDIR/muon-codex-home`) is scratch
 *     too. The operator's `~/.codex` is read for CREDENTIALS ONLY (the codex
 *     guard symlinks auth.json — the product's own documented pattern) and
 *     never written by this script.
 *   - Claude config is NOT redirected, on purpose and with evidence: Claude
 *     Code scopes its Keychain credentials per config dir, so a scratch
 *     CLAUDE_CONFIG_DIR is simply logged out (probed: fresh dir + copied
 *     oauthAccount stanza → "Not logged in · Please run /login"), and making
 *     it work would mean custodying the operator's OAuth secret — which this
 *     script refuses. This also matches the product: MUON isolates codex via
 *     the guard home but drives claude against its own default home. The only
 *     residue is additive session transcripts under `~/.claude/projects/` for
 *     our unique scratch paths; cleanup removes exactly those entries (matched
 *     by the run's unique mkdtemp basename) and touches nothing else.
 *   - The scratch repo is indexed into the operator's REAL ~/.gitnexus
 *     registry (real mode only) because the governed MCP server can read no
 *     other one — the deny-first lane env drops any GITNEXUS_HOME override.
 *     This is the same registration the product performs for any workspace it
 *     analyzes; cleanup deregisters the entry by absolute path (idempotent).
 *   - every spawned process gets its own process group and is SIGTERM→SIGKILL'd
 *     by group on exit, including on failure (trap + watchdog). A final
 *     `pgrep -f <scratch path>` sweep proves nothing survived (link 9).
 *   - no git commands anywhere near the real repo; the only `git init` is in
 *     the scratch repo.
 *
 * MODES
 *   real (default): drives `muon chat` → the real coordinator → two real
 *     vendor children (claude-code + codex). Requires those CLIs installed and
 *     logged in; `muon doctor --json` is the authority, and a not-ready vendor
 *     is an ENVIRONMENT skip (with the doctor row as evidence), never a false
 *     red. This is the pre-push gate on a dev machine.
 *   --fake: CI mode. MUON_FAKE_VENDOR=1, two direct governed dispatches on the
 *     fake lane with --require-approval. Exercises the spine (queue → runner →
 *     worktree → approval gate → edit lands → terminal → typed packet →
 *     handoff read → no orphans); orchestrator/peer/resume links are
 *     SKIP-with-reason (the fake vendor holds no coordinator seat, sends no
 *     peer messages, persists no session handle — and the handle being null is
 *     itself asserted as the honest answer).
 *
 * Every failure prints WHAT broke and WHERE with the evidence read (row
 * counts, job ids, file contents, log tails). ENV failures are SKIPs with
 * reasons; PRODUCT failures are FAILs. Exit 0 = no product FAILs; 1 = at
 * least one; 2 = harness error.
 *
 * Usage:
 *   npm run smoke:mission              # real vendors
 *   npm run smoke:mission -- --fake    # CI / no vendors
 *   node scripts/mission-smoke.mjs [--fake] [--keep] [--timeout-ms N]
 */

import { spawn, execFile as execFileCb } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ───────────────────────────── configuration ─────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BACKEND_ENTRY = path.join(REPO_ROOT, "backend", "dist", "index.js");
const CLI_ENTRY = path.join(REPO_ROOT, "apps", "cli", "dist", "index.js");
const NODE_BIN = process.execPath;

const argv = process.argv.slice(2);
const FAKE = argv.includes("--fake");
const KEEP = argv.includes("--keep");
const timeoutArgIdx = argv.indexOf("--timeout-ms");
const OVERALL_TIMEOUT_MS =
  timeoutArgIdx >= 0
    ? Number(argv[timeoutArgIdx + 1])
    : Number(process.env.MISSION_SMOKE_TIMEOUT_MS) ||
      (FAKE ? 5 * 60_000 : 25 * 60_000);

// Phase budgets (bounded runtime: if the mission cannot finish inside these,
// the mission gets SMALLER, not the assertions weaker).
const BOOT_MS = 90_000;
const RUNNER_MS = 45_000;
const TURN_MS = FAKE ? 60_000 : 10 * 60_000; // coordinator turn incl. dispatching
const CHILDREN_MS = FAKE ? 120_000 : 12 * 60_000; // mission quiescence (all waves terminal)
const WAKE_MS = 3 * 60_000; // grace for the wake summary chunk after quiescence
const RESUME_MS = 150_000; // one real resume turn per vendor
const APPROVER_POLL_MS = 1_200;

// ───────────────────────────── link registry ─────────────────────────────

const LINK_NAMES = {
  1: "mission dispatches two governed children on disjoint scopes",
  2: "child tool calls reach MUON's approval gate (ApprovalRequest rows per child job)",
  3: "standing consent decides the approvals and the edit lands on disk in the worktree",
  4: "the worktree is test-capable (repo test command runs inside it)",
  5: "child reaches terminal with a typed handoff packet on the coordinator's read path",
  6: "orchestrator wakes on child-terminal and posts a final summary unprompted",
  7: "peer messaging delivers at least one message between the children",
  8: "the recorded vendor session id actually resumes",
  9: "nothing left running; no orphan vendor process survives",
};

/** @type {{link:number, scope:string, status:"PASS"|"FAIL"|"SKIP", detail:string}[]} */
const results = [];
function record(link, scope, status, detail) {
  results.push({ link, scope, status, detail });
  const tag = status === "PASS" ? "✓" : status === "SKIP" ? "…" : "✗";
  log(`${tag} link ${link} [${scope}] ${status}: ${detail}`);
}

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${t}] ${msg}\n`);
}
function section(msg) {
  process.stdout.write(`\n───── ${msg} ─────\n`);
}

// ───────────────────────────── scratch layout ─────────────────────────────

const ROOT = mkdtempSync(path.join(tmpdir(), "muon-mission-smoke-"));
const DATA_DIR = path.join(ROOT, "data");
const WS_ROOT = path.join(ROOT, "ws");
// Unique basename: the repo registers in the operator's ~/.gitnexus registry
// under its basename (see indexScratchRepo for why the REAL registry is the
// only one the governed MCP server can see), so the name must never collide
// with a real repo of theirs. Deregistered by absolute path in cleanup.
const REPO = path.join(WS_ROOT, `msmoke-${path.basename(ROOT).replace("muon-mission-smoke-", "")}`);
const TMP = path.join(ROOT, "tmp"); // becomes children's TMPDIR → codex guard home lands here
const LOGS = path.join(ROOT, "logs");
for (const d of [DATA_DIR, path.join(DATA_DIR, "graph"), WS_ROOT, TMP, LOGS]) {
  mkdirSync(d, { recursive: true });
}
const CODEX_GUARD_HOME = path.join(TMP, "muon-codex-home"); // where the product's codex guard will live
const LOCK_PATH = path.join(DATA_DIR, "brain.lock");

// ─────────────────────────── process management ───────────────────────────

/** @type {{name:string, pid:number, child:import("node:child_process").ChildProcess, logPath:string}[]} */
const spawned = [];

function baseEnv(extra = {}) {
  // Explicit allowlist — never inherit the caller's whole env into the chain.
  const env = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    PATH: process.env.PATH, // real PATH: vendor CLIs, git, npm must resolve
    TMPDIR: TMP,
    MUON_DATA_DIR: DATA_DIR,
    // Deliberately NO GITNEXUS_HOME override: buildLaneEnvironment is a
    // deny-first allowlist, so a custom registry location can never reach the
    // governed muon-mcp server through the vendor — its graph tools ALWAYS
    // read ~/.gitnexus (proven by run 2 of this smoke: a hermetic registry
    // left every child graph-blind). The smoke therefore uses the real
    // registry exactly like a real mission does, and deregisters the scratch
    // repo by absolute path on exit. Product follow-up: consider adding
    // GITNEXUS_HOME to the lane env pass-through set.
    NODE_ENV: "production",
    ...extra,
  };
  if (FAKE) env.MUON_FAKE_VENDOR = "1";
  return env;
}

function launch(name, cmd, args, { env, cwd } = {}) {
  const logPath = path.join(LOGS, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, args, {
    cwd: cwd ?? ROOT,
    env: env ?? baseEnv(),
    detached: true, // own process group → we can kill the whole subtree
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  spawned.push({ name, pid: child.pid, child, logPath });
  log(`spawned ${name} pid ${child.pid} (log: ${logPath})`);
  return child;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shutdownAll() {
  for (const p of spawned) killGroup(p.pid, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && spawned.some((p) => pidAlive(p.pid))) {
    await sleep(300);
  }
  for (const p of spawned) {
    if (pidAlive(p.pid)) {
      log(`SIGKILL surviving group of ${p.name} (pid ${p.pid})`);
      killGroup(p.pid, "SIGKILL");
    }
  }
  await sleep(400);
}

let finalized = false;
function emergencyCleanup() {
  if (finalized && KEEP) return;
  for (const p of spawned) killGroup(p.pid, "SIGKILL");
  if (!KEEP) {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.on("exit", emergencyCleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    process.stdout.write(`\nreceived ${sig}, cleaning up scratch state...\n`);
    process.exitCode = 2;
    process.exit();
  });
}

// ─────────────────────────────── helpers ───────────────────────────────

function tail(file, lines = 25) {
  try {
    const content = readFileSync(file, "utf8").split("\n");
    return content.slice(-lines).join("\n");
  } catch {
    return "(log unreadable)";
  }
}

let lock = null;
function readLock() {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    if (typeof parsed.port === "number" && typeof parsed.token === "string") return parsed;
  } catch {
    /* not written yet */
  }
  return null;
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${lock.port}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${lock.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw new Error(`${method} ${route} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

/** Run the muon CLI (bounded). Returns {code, stdout, stderr}; never throws on nonzero exit. */
async function muon(args, { timeoutMs = 60_000, cwd, env } = {}) {
  try {
    const { stdout, stderr } = await execFile(NODE_BIN, [CLI_ENTRY, ...args], {
      cwd: cwd ?? ROOT,
      env: env ?? baseEnv(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}${error.killed ? "\n(killed: timeout)" : ""}`,
    };
  }
}

async function until(fn, { deadlineMs, delay = 1_000, label }) {
  let lastError;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined && value !== false && value !== null) return value;
      lastError = new Error("condition returned falsy");
    } catch (error) {
      lastError = error;
    }
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? "never satisfied"}`);
}

// ─────────────────────────── standing consent ───────────────────────────

// The headless equivalent of the desktop's Full-Auto auto-approver: an
// OPERATOR loop that decides every pending non-merge approval through the SAME
// governed CLI surface (`muon approve resolve`, the exact payload the real
// campaign used). Merge gates are left pending on purpose — the mission brief
// forbids merging, and a merge approval requires a review certification that
// standing consent must never counterfeit.
const approver = {
  resolved: [], // {id, kind, jobId, taskId}
  failures: [], // {id, error}
  skippedMerge: [],
  seen: new Set(),
  timer: null,
  busy: false,
};

async function approverSweep() {
  if (approver.busy || !lock) return;
  approver.busy = true;
  try {
    const payload = await api("GET", "/api/approvals");
    for (const a of payload?.approvals ?? []) {
      if (a.status !== "pending" || approver.seen.has(a.id)) continue;
      if (a.kind === "merge") {
        if (!approver.skippedMerge.includes(a.id)) {
          approver.skippedMerge.push(a.id);
          log(`standing consent: leaving merge approval ${a.id} pending (merging is out of scope)`);
        }
        continue;
      }
      approver.seen.add(a.id);
      const res = await muon(
        ["approve", "resolve", "--approval-id", a.id, "--status", "approved"],
        { timeoutMs: 30_000 }
      );
      if (res.code === 0) {
        approver.resolved.push({ id: a.id, kind: a.kind, jobId: a.jobId ?? null, taskId: a.taskId });
        log(`standing consent: approved ${a.kind} approval ${a.id} (job ${a.jobId ?? "?"})`);
      } else {
        approver.seen.delete(a.id); // retry next sweep
        approver.failures.push({ id: a.id, error: (res.stderr || res.stdout).slice(0, 300) });
      }
    }
  } catch (error) {
    // transient (backend restarting etc.) — next sweep retries
    approver.failures.push({ id: "(sweep)", error: String(error.message).slice(0, 200) });
  } finally {
    approver.busy = false;
  }
}
function startApprover() {
  approver.timer = setInterval(approverSweep, APPROVER_POLL_MS);
}
function stopApprover() {
  if (approver.timer) clearInterval(approver.timer);
  approver.timer = null;
}

// ─────────────────────────── scratch target repo ───────────────────────────

function scaffoldRepo() {
  mkdirSync(path.join(REPO, "src"), { recursive: true });
  mkdirSync(path.join(REPO, "test"), { recursive: true });
  writeFileSync(
    path.join(REPO, "package.json"),
    JSON.stringify(
      {
        name: "muon-mission-smoke-target",
        private: true,
        type: "module",
        description: "Disposable target repo for MUON's mission smoke. Safe to delete.",
        scripts: { test: "node --test" },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(REPO, "src", "greet.js"),
    `/**
 * Return a friendly greeting for \`name\`.
 * BUG (intentional, for the smoke): the name is dropped. The fix is to
 * interpolate it so greet("MUON") === "Hello, MUON!". Minimal diff only.
 */
export function greet(name) {
  return "Hello, !";
}
`
  );
  writeFileSync(
    path.join(REPO, "test", "greet.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greet.js";

test("greet() includes the given name", () => {
  assert.equal(greet("MUON"), "Hello, MUON!");
});
test("greet() works for a different name too", () => {
  assert.equal(greet("world"), "Hello, world!");
});
`
  );
  writeFileSync(
    path.join(REPO, "README.md"),
    "# mission-smoke target\n\nDisposable. One failing test in test/greet.test.js.\n"
  );
  writeFileSync(path.join(REPO, ".gitignore"), "node_modules/\n.muon/\n");
  const git = (args) =>
    execFile("git", args, { cwd: REPO, env: baseEnv(), timeout: 20_000 });
  return (async () => {
    await git(["init", "-q"]);
    await git(["config", "--local", "user.email", "mission-smoke@example.invalid"]);
    await git(["config", "--local", "user.name", "MUON Mission Smoke"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "baseline: intentionally failing test"]);
  })();
}

const BROKEN_GREET_MARKER = `return "Hello, !";`;

// ─────────────────────────────── phases ───────────────────────────────

async function bootBackend() {
  section("boot: embedded backend on a scratch data dir");
  launch("backend", NODE_BIN, [BACKEND_ENTRY], {
    env: baseEnv({
      DATABASE_URL: `file:${path.join(DATA_DIR, "muon.db")}`,
      MUON_EMBED_DISABLE: "1", // lexical brain: no Ollama probe, no network
      MUON_GRAPH_DISABLE_FTS: "1",
      MUON_WORKSPACE_ROOTS: WS_ROOT, // P3-B allowlist: only the scratch repo is reachable
    }),
  });
  lock = await until(() => readLock(), {
    deadlineMs: BOOT_MS,
    delay: 500,
    label: "brain.lock",
  }).catch((error) => {
    throw new Error(
      `backend never published its lockfile: ${error.message}\n--- backend log tail ---\n${tail(path.join(LOGS, "backend.log"))}`
    );
  });
  log(`backend live on 127.0.0.1:${lock.port} (data: ${DATA_DIR})`);
}

async function bootRunner() {
  section("boot: persistent runner");
  launch("runner", NODE_BIN, [CLI_ENTRY, "runner", "--host", "mission-smoke"], {
    env: baseEnv(),
  });
  await until(
    async () => {
      const payload = await api("GET", "/api/runner");
      return payload?.live === true;
    },
    { deadlineMs: RUNNER_MS, delay: 1_000, label: "runner heartbeat (GET /api/runner live=true)" }
  ).catch((error) => {
    throw new Error(
      `runner never came live: ${error.message}\n--- runner log tail ---\n${tail(path.join(LOGS, "runner.log"))}`
    );
  });
  log("runner live");
}

/** Real mode: which of claude-code/codex are actually dispatch-ready, per MUON's own prober. */
async function vendorGate() {
  section("preflight: vendor readiness (muon doctor --json is the authority)");
  // NOTE: `doctor --json` exits 1 whenever overall status != "ready" (e.g.
  // degraded because SOME vendor is logged out) while still printing the full
  // contract — so parse stdout regardless of the exit code.
  const res = await muon(["doctor", "--json"], { timeoutMs: 90_000 });
  let doctor;
  try {
    doctor = JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `muon doctor --json printed unparseable output (rc=${res.code}): ${(res.stdout || res.stderr).slice(0, 400)}`
    );
  }
  log(`doctor: overall status=${doctor.status} (${doctor.headline ?? ""})`);
  const rows = doctor.vendors ?? [];
  const wanted = ["claude-code", "codex"];
  const ready = [];
  for (const vendor of wanted) {
    const row = rows.find((v) => v.vendor === vendor);
    const ok =
      row?.dispatchReady === true &&
      row?.authMethod &&
      !["none", "unknown"].includes(row.authMethod);
    log(
      `doctor: ${vendor} installed=${row?.installed} auth=${row?.auth} dispatchReady=${row?.dispatchReady} authMethod=${row?.authMethod} cliVersion=${row?.cliVersion ?? "?"}`
    );
    if (ok) ready.push(vendor);
    else {
      record(
        0,
        `env:${vendor}`,
        "SKIP",
        `ENVIRONMENT: ${vendor} is not dispatch-ready per muon doctor (installed=${row?.installed}, auth=${row?.auth}, authMethod=${row?.authMethod}). Its links will be skipped, not failed.`
      );
    }
  }
  return ready;
}

function missionBrief(vendors) {
  const [vA, vB] = vendors.length >= 2 ? vendors : [vendors[0], vendors[0]];
  return [
    "MISSION SMOKE (governed, keep it small and additive). Dispatch exactly TWO workers in parallel, then stop dispatching — no reviewer, no third worker.",
    `Worker 1 on lane ${vA}: edit ONLY src/greet.js so both tests in test/greet.test.js pass (interpolate the name; minimal diff), then run \`npm test\` and report the result.`,
    `Worker 2 on lane ${vB}: create ONLY the new file CONTRIBUTING.md at the repo root containing exactly this single line: "Contributions welcome — see README.md." Do not modify any existing file.`,
    "The two scopes are disjoint (src/greet.js vs CONTRIBUTING.md); keep them disjoint.",
    "In each worker's brief, instruct it to send exactly ONE peer message to its sibling worker (peer messaging tools are available) reporting what it changed, before finishing.",
    "Do NOT merge any worktree; leave both worktrees unmerged for human review.",
    "When both workers reach terminal, produce the FINAL MISSION SUMMARY.",
  ].join("\n");
}

async function jobsForChat(chatId) {
  const payload = await api("GET", `/api/dispatch?chatId=${encodeURIComponent(chatId)}&limit=200`);
  return payload?.jobs ?? [];
}

const TERMINAL = new Set(["done", "failed", "interrupted"]);

function describeJob(j) {
  return `job ${j.id} vendor=${j.vendor} kind=${j.kind} status=${j.status} parent=${j.parentJobId ?? "-"} task=${j.taskId}`;
}

/** Map an approval's jobId to the child whose subtree filed it. */
function attributeToChild(jobId, jobs, children) {
  if (!jobId) return null;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  let cursor = byId.get(jobId);
  const childIds = new Set(children.map((c) => c.id));
  while (cursor) {
    if (childIds.has(cursor.id)) return cursor.id;
    cursor = cursor.parentJobId ? byId.get(cursor.parentJobId) : null;
  }
  return null;
}

async function runPackageTest(cwd) {
  try {
    const { stdout, stderr } = await execFile("npm", ["test"], {
      cwd,
      env: baseEnv(),
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}${error.killed ? "(killed: timeout)" : ""}`,
    };
  }
}

function looksLikeTestRun(out) {
  // node --test output — proof the command executed tests rather than dying on
  // spawn/module resolution (the broken-@muon/*-link failure mode).
  return /(?:# tests|# pass|# fail|tests \d|pass \d|fail \d)/.test(out);
}

function packetTypedness(packet) {
  if (!packet || typeof packet !== "object") return "missing";
  const required = ["taskGoal", "whatChanged", "whatFailed", "nextLaneRequest", "checksStatus", "provenance"];
  const absent = required.filter((k) => packet[k] === undefined || packet[k] === null);
  return absent.length === 0 ? "typed" : `untyped (missing ${absent.join(",")})`;
}

const BUNDLED_GITNEXUS = path.join(
  REPO_ROOT,
  "packages",
  "mcp",
  "node_modules",
  "gitnexus",
  "dist",
  "cli",
  "index.js"
);

/**
 * Index the scratch repo's code graph with the SAME bundled gitnexus binary
 * the product's graph tools shell out to (packages/mcp dependency). Founder
 * repos are always indexed, so an indexed target is the honest baseline for
 * the mission chain. Run 1 of this smoke against an UNINDEXED repo proved the
 * documented fail-closed rule: preflight_edit cannot mint coverage without a
 * graph, and BOTH real children then terminate `failed` ("loop checks passed,
 * but MUON blocked completion") even though their edits landed and checks
 * passed — a product finding, recorded in that run's output.
 *
 * The index registers in the operator's REAL ~/.gitnexus registry — the only
 * one the governed MCP server can read (deny-first lane env; see baseEnv) and
 * exactly what the product's own refresh path does for any workspace. The
 * entry is store metadata for a throwaway path, never operator code, and
 * `deregisterScratchRepo` removes it by absolute path on every exit.
 */
async function indexScratchRepo() {
  if (!existsSync(BUNDLED_GITNEXUS)) {
    log(`WARNING: bundled gitnexus CLI not found at ${BUNDLED_GITNEXUS}; the mission will run against an UNINDEXED repo and implement children are expected to fail closed at completion`);
    return false;
  }
  const res = await runBounded(NODE_BIN, [BUNDLED_GITNEXUS, "analyze", REPO, "--index-only"], {
    cwd: REPO,
    timeoutMs: 240_000,
  });
  if (res.code === 0) {
    log(`scratch repo indexed (gitnexus analyze --index-only; registry entry for ${REPO} will be removed on exit)`);
    return true;
  }
  log(`WARNING: gitnexus analyze failed rc=${res.code}; mission runs unindexed. Output tail:\n${res.out.split("\n").slice(-8).join("\n")}`);
  return false;
}

/** Idempotent by-absolute-path removal of the scratch repo's registry entry. */
async function deregisterScratchRepo() {
  if (!existsSync(BUNDLED_GITNEXUS)) return;
  const res = await runBounded(NODE_BIN, [BUNDLED_GITNEXUS, "remove", REPO, "-f"], {
    timeoutMs: 30_000,
  });
  log(
    res.code === 0
      ? `deregistered scratch repo from ~/.gitnexus (gitnexus remove ${REPO})`
      : `WARNING: could not deregister scratch repo (rc=${res.code}): ${res.out.trim().slice(0, 200)}`
  );
}

// ─────────────────────────────── real mode ───────────────────────────────

async function realMission(readyVendors) {
  const vendors = readyVendors;
  section("preflight: index the scratch repo's code graph (hermetic GITNEXUS_HOME)");
  await indexScratchRepo();
  section("mission: create chat + run the coordinator turn");
  const { chat } = await api("POST", "/api/chats", { workspacePath: REPO });
  log(`chat ${chat.id} (workspace ${REPO})`);

  const brief = missionBrief(vendors);
  log(`brief:\n${brief.replace(/^/gm, "  | ")}`);
  const turn = await muon(["chat", "--chat-id", chat.id, "--message", brief], {
    timeoutMs: TURN_MS,
    cwd: REPO,
  });
  const turnLog = path.join(LOGS, "chat-turn.log");
  writeFileSync(turnLog, `--- stdout ---\n${turn.stdout}\n--- stderr ---\n${turn.stderr}\n`);
  log(`coordinator turn exited rc=${turn.code} (transcript: ${turnLog})`);
  if (turn.code !== 0) {
    log(`turn stderr tail:\n${turn.stderr.split("\n").slice(-15).join("\n")}`);
  }

  // ── link 1: two governed children on disjoint scopes ──
  section("link 1: two governed children");
  let jobs = await jobsForChat(chat.id).catch(() => []);
  let children = jobs.filter((j) => j.parentJobId);
  try {
    await until(
      async () => {
        jobs = await jobsForChat(chat.id);
        children = jobs.filter((j) => j.parentJobId);
        return children.length >= 2;
      },
      { deadlineMs: 45_000, delay: 2_000, label: ">=2 child jobs" }
    );
  } catch {
    /* judged below */
  }
  if (children.length >= 2) {
    record(
      1,
      "mission",
      "PASS",
      `${children.length} governed children dispatched: ${children.map(describeJob).join(" ; ")}`
    );
  } else {
    record(
      1,
      "mission",
      "FAIL",
      `expected 2 governed children under chat ${chat.id}, found ${children.length}. ` +
        `Jobs seen: ${jobs.map(describeJob).join(" ; ") || "(none)"}. ` +
        `Coordinator turn rc=${turn.code}; transcript tail:\n${(turn.stdout + turn.stderr).split("\n").slice(-20).join("\n")}`
    );
    return { chat, jobs, children }; // downstream links have no subject — reported by finalize
  }

  // Wait for MISSION QUIESCENCE, not merely "the first two children": a
  // coordinator may re-dispatch a failed scope and wake itself repeatedly
  // (observed live: four codex attempts across three waves), and judging the
  // links mid-wave produces false reds. Quiescent ⇔ every job of the chat —
  // workers AND wake roots — is terminal. The approver keeps deciding gates
  // throughout.
  section("mission: waiting for quiescence (every chat job terminal)");
  try {
    await until(
      async () => {
        jobs = await jobsForChat(chat.id);
        children = jobs.filter((j) => j.parentJobId);
        return (
          children.length >= 2 &&
          jobs.length > 0 &&
          jobs.every((j) => TERMINAL.has(j.status))
        );
      },
      { deadlineMs: CHILDREN_MS, delay: 3_000, label: "mission quiescence" }
    );
  } catch (error) {
    log(`mission never went quiescent: ${error.message} — judging the links from the current state`);
  }
  jobs = await jobsForChat(chat.id);
  children = jobs.filter((j) => j.parentJobId);
  for (const c of children) log(describeJob(c));

  // Identify which child(ren) owned which scope. A coordinator may legally
  // RE-dispatch a scope after a failed/no-op first attempt (observed live in
  // runs 3-4), and all attempts at one scope share the scope's TASK — so group
  // by taskId, classify each group by hard evidence (artifact on disk, then
  // packet changedFiles, then brief text with the more specific CONTRIBUTING
  // token first: EVERY brief mentions "greet" via the disjointness clause, so
  // a bare /greet/ match over briefs misclassifies). Each scope then binds to
  // the attempt whose worktree actually carries the artifact when one exists,
  // else the latest terminal attempt — and the evidence names every attempt so
  // a re-dispatch story reads at a glance.
  const artifactPath = (label, child) =>
    label === "greet"
      ? path.join(child.executionPath ?? REPO, "src", "greet.js")
      : path.join(child.executionPath ?? REPO, "CONTRIBUTING.md");
  const artifactLanded = (label, child) => {
    const file = artifactPath(label, child);
    if (!child.executionPath || !existsSync(file)) return false;
    const content = readFileSync(file, "utf8");
    return label === "greet" ? !content.includes(BROKEN_GREET_MARKER) : content.trim().length > 0;
  };
  const taskGroups = new Map();
  for (const c of children) {
    if (!taskGroups.has(c.taskId)) taskGroups.set(c.taskId, []);
    taskGroups.get(c.taskId).push(c);
  }
  const classifyGroup = (attempts) => {
    if (attempts.some((c) => artifactLanded("contributing", c))) return "contributing";
    if (attempts.some((c) => artifactLanded("greet", c))) return "greet";
    const changed = attempts.flatMap((c) => c.packetJson?.changedFiles ?? []);
    if (changed.some((f) => /CONTRIBUTING/i.test(f))) return "contributing";
    if (changed.some((f) => /greet/.test(f))) return "greet";
    if (attempts.some((c) => /CONTRIBUTING/i.test(c.brief ?? ""))) return "contributing";
    if (attempts.some((c) => /greet/i.test(c.brief ?? ""))) return "greet";
    return "unclassified";
  };
  const greetCandidates = [];
  const contribCandidates = [];
  for (const attempts of taskGroups.values()) {
    const scope = classifyGroup(attempts);
    if (scope === "greet") greetCandidates.push(...attempts);
    else if (scope === "contributing") contribCandidates.push(...attempts);
    else log(`unclassified scope group: ${attempts.map(describeJob).join(" ; ")}`);
  }
  const bind = (label, candidates) =>
    candidates.find((c) => artifactLanded(label, c)) ??
    [...candidates].reverse().find((c) => TERMINAL.has(c.status)) ??
    candidates.at(-1);
  const greetChild = bind("greet", greetCandidates);
  const contribChild = bind("contributing", contribCandidates);
  const labelled = [
    ["greet", greetChild, greetCandidates],
    ["contributing", contribChild, contribCandidates],
  ];

  const disjoint =
    greetChild && contribChild && greetChild.executionPath !== contribChild.executionPath;
  log(
    `scope mapping: greet→${greetChild?.id ?? "?"} (${greetChild?.vendor ?? "?"}, wd ${greetChild?.executionPath ?? "?"}) | ` +
      `contributing→${contribChild?.id ?? "?"} (${contribChild?.vendor ?? "?"}, wd ${contribChild?.executionPath ?? "?"}) | disjoint worktrees=${disjoint}`
  );

  // ── links 2 + 3 per child ──
  section("links 2-3: approval gate + standing consent + edit lands");
  const approvalsPayload = await api("GET", "/api/approvals").catch(() => ({ approvals: [] }));
  const approvals = approvalsPayload.approvals ?? [];
  const rowsFor = (child) =>
    approvals.filter((a) => attributeToChild(a.jobId, jobs, [child]) === child.id);
  const attemptLine = (label, cs) =>
    cs
      .map(
        (c) =>
          `${c.id.slice(0, 8)}(${c.vendor},${c.status},approvals=${rowsFor(c).length},artifact=${artifactLanded(label, c)})`
      )
      .join(" ; ");
  for (const [label, child, candidates] of labelled) {
    const scope = `${label}/${child?.vendor ?? "?"}`;
    if (!child) {
      record(2, scope, "FAIL", `no child job owned the ${label} scope — cannot attribute approvals`);
      record(3, scope, "FAIL", `no child job owned the ${label} scope`);
      continue;
    }
    const attempts = candidates.length > 1 ? ` [all ${label} attempts: ${attemptLine(label, candidates)}]` : "";
    const mine = rowsFor(child);
    if (mine.length > 0) {
      const kinds = [...new Set(mine.map((a) => a.kind))].join(",");
      record(
        2,
        scope,
        "PASS",
        `${mine.length} ApprovalRequest row(s) attributed to job ${child.id} (kinds: ${kinds}) — MUON is the gate for this transport${attempts}`
      );
    } else {
      record(
        2,
        scope,
        "FAIL",
        `ZERO ApprovalRequest rows attributed to job ${child.id} (${child.vendor}) while its status is '${child.status}'. ` +
          `Either its write tool calls bypassed MUON's gate (the founder bug) or it never attempted a write at all — a no-op child scored '${child.status}'; read its stream to tell which. ` +
          `Total approvals in the run: ${approvals.length} (jobIds: ${[...new Set(approvals.map((a) => a.jobId))].join(",") || "none"}). ` +
          `result=${JSON.stringify(child.result ?? "").slice(0, 300)}${attempts}`
      );
    }

    // link 3: decided + edit on disk in the worktree
    const undecided = mine.filter((a) => a.status === "pending");
    const targetFile = artifactPath(label, child);
    const editLanded = artifactLanded(label, child);
    const fileEvidence = editLanded
      ? `${targetFile}: ${JSON.stringify(readFileSync(targetFile, "utf8").slice(0, 160))}`
      : `${targetFile} ${existsSync(targetFile) ? "still carries the baseline content" : "does not exist"} (executionPath=${child.executionPath ?? "NULL — runner never stamped where it ran"})`;
    if (undecided.length === 0 && mine.length > 0 && editLanded) {
      record(3, scope, "PASS", `all ${mine.length} approvals decided under standing consent; edit landed — ${fileEvidence}${attempts}`);
    } else if (!editLanded) {
      record(
        3,
        scope,
        "FAIL",
        `the edit did NOT land in the worktree. ${fileEvidence}. approvals decided=${mine.length - undecided.length}/${mine.length}, child status=${child.status}, result=${JSON.stringify(child.result ?? "").slice(0, 300)}${attempts}`
      );
    } else {
      record(
        3,
        scope,
        "FAIL",
        `${undecided.length} approval(s) still pending for job ${child.id} (${undecided.map((a) => `${a.id}:${a.kind}`).join(",")}) — standing consent did not decide them${attempts}`
      );
    }
  }

  // ── link 4: worktree test-capable ──
  section("link 4: package test inside each worktree");
  for (const [label, child] of labelled) {
    const scope = `${label}/${child?.vendor ?? "?"}`;
    if (!child?.executionPath || !existsSync(child.executionPath)) {
      record(4, scope, "FAIL", `no executionPath recorded/left on disk for job ${child?.id ?? "?"} — cannot prove the worktree is test-capable`);
      continue;
    }
    const t = await runPackageTest(child.executionPath);
    const ran = looksLikeTestRun(t.out);
    if (label === "greet") {
      if (t.code === 0 && ran) {
        record(4, scope, "PASS", `\`npm test\` PASSED inside ${child.executionPath} — worktree test-capable and the fix is real`);
      } else {
        record(
          4,
          scope,
          "FAIL",
          `\`npm test\` in ${child.executionPath} rc=${t.code}, ran=${ran}. Output tail:\n${t.out.split("\n").slice(-12).join("\n")}`
        );
      }
    } else if (ran) {
      record(4, scope, "PASS", `\`npm test\` executed inside ${child.executionPath} (rc=${t.code}; a failing greet test here is expected — this scope never touched it)`);
    } else {
      record(
        4,
        scope,
        "FAIL",
        `\`npm test\` did not execute tests inside ${child.executionPath} (rc=${t.code}) — the worktree is not test-capable. Output tail:\n${t.out.split("\n").slice(-12).join("\n")}`
      );
    }
  }

  // ── link 5: terminal + typed packet via the coordinator's read path ──
  section("link 5: typed handoff packets");
  for (const [label, child] of labelled) {
    const scope = `${label}/${child?.vendor ?? "?"}`;
    if (!child) continue;
    if (!TERMINAL.has(child.status)) {
      record(5, scope, "FAIL", `job ${child.id} never reached terminal (status=${child.status} after ${CHILDREN_MS / 1000}s)`);
      continue;
    }
    const onJob = packetTypedness(child.packetJson);
    let onReadPath = "missing";
    let readPathEvidence = "";
    try {
      const { task } = await api("GET", `/api/tasks/${encodeURIComponent(child.taskId)}`);
      const withPacket = (task.handoffs ?? []).filter((h) => h.packetJson);
      if (withPacket.length > 0) {
        onReadPath = packetTypedness(withPacket[0].packetJson);
        readPathEvidence = `handoff ${withPacket[0].id}, whatChanged=${JSON.stringify(withPacket[0].packetJson.whatChanged ?? "").slice(0, 140)}`;
      } else {
        readPathEvidence = `task ${child.taskId} has ${task.handoffs?.length ?? 0} handoff row(s), none carrying packetJson`;
      }
    } catch (error) {
      readPathEvidence = `task detail read failed: ${error.message}`;
    }
    if (child.status === "done" && onJob === "typed" && onReadPath === "typed") {
      record(5, scope, "PASS", `terminal '${child.status}' with a typed packet on the job row AND on the handoff_read path (${readPathEvidence})`);
    } else {
      record(
        5,
        scope,
        "FAIL",
        `terminal=${child.status}; packet on job row: ${onJob}; packet on coordinator read path: ${onReadPath} (${readPathEvidence}); result=${JSON.stringify(child.result ?? "").slice(0, 300)}`
      );
    }
  }

  // ── link 6: orchestrator wake + final summary, no human nudge ──
  section("link 6: wake + final mission summary");
  // Proof of "no human nudge": this harness sends exactly ONE human turn, so
  // the FIRST root (earliest createdAt) is the only human-initiated one — any
  // later root is machine-initiated (a wake), however many reconciliation
  // waves the mission needs. (v1 of this detector snapshotted the root set
  // AFTER the children-wait window and raced multi-wave missions: a wake root
  // admitted during that window looked "first" and the link false-failed.)
  let wakeEvidence = null;
  try {
    wakeEvidence = await until(
      async () => {
        const chunksPayload = await api(
          "GET",
          `/api/streams?taskId=${encodeURIComponent(chat.id)}&limit=200&latest=true`
        );
        const chunks = chunksPayload?.chunks ?? [];
        const continuation = chunks.find((c) => /continuation root .* opened for terminal job/.test(c.content ?? ""));
        if (!continuation) return false;
        const currentJobs = await jobsForChat(chat.id);
        const roots = currentJobs
          .filter((j) => !j.parentJobId)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const humanRootId = roots[0]?.id;
        const machineRoots = roots.filter((r) => r.id !== humanRootId);
        if (machineRoots.some((r) => !TERMINAL.has(r.status))) return false; // a wave is still running
        const summaryChunk = [...chunks]
          .reverse()
          .find(
            (c) =>
              machineRoots.some((r) => r.id === c.runId) &&
              !String(c.content ?? "").startsWith("[you]") &&
              !String(c.content ?? "").startsWith("[event]") &&
              !String(c.content ?? "").startsWith("[task.") &&
              String(c.content ?? "").length > 120
          );
        if (!summaryChunk) return false;
        return { continuation, summaryChunk, machineRoots };
      },
      { deadlineMs: WAKE_MS, delay: 4_000, label: "continuation root + final summary chunk" }
    );
  } catch (error) {
    record(
      6,
      "mission",
      "FAIL",
      `the orchestrator never woke + summarized on its own within ${WAKE_MS / 1000}s of the children finishing: ${error.message}. ` +
        `A human nudge should NOT be needed. Runner log tail:\n${tail(path.join(LOGS, "runner.log"), 15)}`
    );
  }
  if (wakeEvidence) {
    record(
      6,
      "mission",
      "PASS",
      `wake proven: "${wakeEvidence.continuation.content}" (${wakeEvidence.machineRoots.length} machine-initiated root(s) after the single human turn). ` +
        `Final summary posted by wake root ${wakeEvidence.summaryChunk.runId}: ${JSON.stringify(String(wakeEvidence.summaryChunk.content).slice(0, 260))}`
    );
  }

  // ── link 7: peer messaging between the children ──
  section("link 7: peer messages");
  try {
    const { messages } = await api(
      "GET",
      `/api/a2a/messages?chatId=${encodeURIComponent(chat.id)}&limit=50`
    );
    if ((messages ?? []).length > 0) {
      const m = messages[0];
      const from = `${m.fromRole ?? "?"}/${String(m.fromJobId ?? "?").slice(0, 8)}`;
      const to = m.toRole ?? m.toJobId?.slice(0, 8) ?? m.toKind ?? "?";
      record(
        7,
        "mission",
        "PASS",
        `${messages.length} peer message(s) delivered; e.g. ${from} → ${to}: ${JSON.stringify(String(m.subject ?? m.body ?? "").slice(0, 120))}`
      );
    } else {
      record(
        7,
        "mission",
        "FAIL",
        `zero PeerMessage rows for chat ${chat.id} although both worker briefs required one. ` +
          `Either the peer tools were unavailable to the children or delivery broke; check the worker streams in ${LOGS}.`
      );
    }
  } catch (error) {
    record(7, "mission", "FAIL", `peer message read path failed: ${error.message}`);
  }

  // ── link 8: recorded session ids actually resume ──
  section("link 8: vendor session resume (the dead-button check)");
  for (const [label, child] of labelled) {
    const scope = `${label}/${child?.vendor ?? "?"}`;
    if (!child) continue;
    await checkResume(scope, child);
  }

  return { chat, jobs, children };
}

async function checkResume(scope, child) {
  const sid = child.vendorSessionId;
  if (!sid) {
    record(
      8,
      scope,
      "FAIL",
      `job ${child.id} (${child.vendor}) reached '${child.status}' with vendorSessionId=NULL — MUON recorded no resume handle, so the "open the real session" button is dead by construction`
    );
    return;
  }
  const cwd = child.executionPath && existsSync(child.executionPath) ? child.executionPath : REPO;
  if (child.vendor === "claude-code") {
    const res = await runBounded(
      "claude",
      ["--resume", sid, "-p", "Reply with exactly RESUME_OK and nothing else."],
      { cwd, timeoutMs: RESUME_MS }
    );
    if (res.code === 0 && res.out.trim().length > 0) {
      record(8, scope, "PASS", `\`claude --resume ${sid}\` resumed and answered: ${JSON.stringify(res.out.trim().slice(0, 80))}`);
    } else {
      record(
        8,
        scope,
        "FAIL",
        `\`claude --resume ${sid} -p ...\` (cwd ${cwd}) rc=${res.code}: ${res.out.trim().slice(0, 400) || "(no output)"} — the recorded session id does not reopen the dispatched session`
      );
    }
  } else if (child.vendor === "codex") {
    // Non-interactive resume probe. The governed run's rollouts live in the
    // codex guard home under our scratch TMPDIR — resume must look THERE.
    const env = baseEnv({ CODEX_HOME: CODEX_GUARD_HOME });
    const help = await runBounded("codex", ["exec", "resume", "--help"], { cwd, env, timeoutMs: 20_000 });
    if (help.code !== 0) {
      record(
        8,
        scope,
        "SKIP",
        `ENVIRONMENT: this codex CLI has no non-interactive \`codex exec resume\` (rc=${help.code}); cannot verify headlessly. Manual check: CODEX_HOME=${CODEX_GUARD_HOME} codex resume ${sid}`
      );
      return;
    }
    const res = await runBounded(
      "codex",
      ["exec", "resume", sid, "Reply with exactly RESUME_OK and nothing else."],
      { cwd, env, timeoutMs: RESUME_MS }
    );
    const noSession = /no.*session|not.*found|does not exist/i.test(res.out);
    if (res.code === 0 && !noSession) {
      record(8, scope, "PASS", `\`codex exec resume ${sid}\` resumed the recorded session (CODEX_HOME=${CODEX_GUARD_HOME})`);
    } else {
      record(
        8,
        scope,
        "FAIL",
        `\`codex exec resume ${sid}\` (CODEX_HOME=${CODEX_GUARD_HOME}) rc=${res.code}: ${res.out.trim().slice(0, 400) || "(no output)"} — ` +
          (noSession
            ? "this is the founder's dead button: the recorded id does not match any saved session in the transport's session store"
            : "resume did not complete cleanly")
      );
    }
  } else {
    record(8, scope, "SKIP", `no resume probe implemented for vendor '${child.vendor}'`);
  }
}

async function runBounded(cmd, args, { cwd, env, timeoutMs }) {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      cwd: cwd ?? ROOT,
      env: env ?? baseEnv(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}${error.killed ? "(killed: timeout)" : ""}`,
    };
  }
}

// ─────────────────────────────── fake mode ───────────────────────────────

async function fakeMission() {
  section("fake mode: two direct governed dispatches on the fake lane");
  // Two tasks on disjoint scopes.
  const mkTask = async (title, description) => {
    const res = await muon(
      ["task", "create", "--title", title, "--description", description, "--priority", "low", "--workspace", REPO, "--json"],
      { timeoutMs: 30_000 }
    );
    if (res.code !== 0) throw new Error(`task create failed: ${res.stderr || res.stdout}`);
    return JSON.parse(res.stdout).task;
  };
  const taskA = await mkTask("fake scope A", "governed fake dispatch A (scope: src/greet.js)");
  const taskB = await mkTask("fake scope B", "governed fake dispatch B (scope: CONTRIBUTING.md)");

  const dispatch = (task, name) => {
    const child = launch(`run-${name}`, NODE_BIN, [
      CLI_ENTRY,
      "run",
      "--lane",
      "fake",
      "--task-id",
      task.id,
      "--brief",
      `mission-smoke fake dispatch for ${name}; additive only`,
      "--require-approval",
      "--cwd",
      REPO,
    ]);
    return child;
  };
  const runA = dispatch(taskA, "A");
  const runB = dispatch(taskB, "B");

  const exited = (child) =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once("exit", resolve);
    });
  const codes = await Promise.race([
    Promise.all([exited(runA), exited(runB)]),
    sleep(CHILDREN_MS).then(() => null),
  ]);
  if (codes === null) {
    log(`fake dispatches did not finish within ${CHILDREN_MS / 1000}s; killing`);
    killGroup(runA.pid, "SIGKILL");
    killGroup(runB.pid, "SIGKILL");
  } else {
    log(`fake dispatch exits: A=${codes[0]} B=${codes[1]}`);
  }

  const { jobs } = await api("GET", "/api/dispatch?limit=100");
  const jobA = jobs.filter((j) => j.taskId === taskA.id).at(-1);
  const jobB = jobs.filter((j) => j.taskId === taskB.id).at(-1);

  // link 1 (adapted: no coordinator in fake mode — two governed dispatches on disjoint tasks)
  if (jobA && jobB && jobA.id !== jobB.id) {
    record(1, "fake", "PASS", `two governed dispatches ran: ${describeJob(jobA)} ; ${describeJob(jobB)} (coordinator not exercised — fake vendor holds no coordinator seat)`);
  } else {
    record(1, "fake", "FAIL", `expected one job per task, got A=${jobA?.id ?? "none"} B=${jobB?.id ?? "none"}. run-A log tail:\n${tail(path.join(LOGS, "run-A.log"), 10)}`);
  }

  const approvals = (await api("GET", "/api/approvals").catch(() => ({ approvals: [] }))).approvals ?? [];
  for (const [name, task, job] of [
    ["A", taskA, jobA],
    ["B", taskB, jobB],
  ]) {
    const scope = `fake/${name}`;
    const mine = approvals.filter((a) => a.taskId === task.id);
    if (mine.length > 0) {
      record(2, scope, "PASS", `${mine.length} ApprovalRequest row(s) filed for task ${task.id} (kinds: ${[...new Set(mine.map((a) => a.kind))].join(",")})`);
    } else {
      record(2, scope, "FAIL", `--require-approval was passed but ZERO ApprovalRequest rows exist for task ${task.id}`);
    }
    const pending = mine.filter((a) => a.status === "pending");
    const wd = job?.executionPath ?? REPO;
    const artifact = path.join(wd, "MUON_FAKE_VENDOR.touched.md");
    const landed = existsSync(artifact);
    if (pending.length === 0 && landed) {
      record(3, scope, "PASS", `approvals decided under standing consent and the fake lane's additive artifact landed: ${artifact}`);
    } else {
      record(
        3,
        scope,
        "FAIL",
        `pending approvals=${pending.length}; artifact ${artifact} exists=${landed}; job status=${job?.status}; result=${JSON.stringify(job?.result ?? "").slice(0, 200)}`
      );
    }
    if (job?.executionPath && existsSync(job.executionPath)) {
      const t = await runPackageTest(job.executionPath);
      if (looksLikeTestRun(t.out)) {
        record(4, scope, "PASS", `\`npm test\` executed inside ${job.executionPath} (rc=${t.code}; failing greet test expected — the fake never fixes it)`);
      } else {
        record(4, scope, "FAIL", `\`npm test\` did not execute inside ${job.executionPath} (rc=${t.code}):\n${t.out.split("\n").slice(-10).join("\n")}`);
      }
    } else {
      record(4, scope, "FAIL", `no executionPath recorded for job ${job?.id ?? "?"}`);
    }
    if (job && TERMINAL.has(job.status)) {
      const onJob = packetTypedness(job.packetJson);
      let onReadPath = "missing";
      try {
        const { task: detail } = await api("GET", `/api/tasks/${encodeURIComponent(task.id)}`);
        const withPacket = (detail.handoffs ?? []).filter((h) => h.packetJson);
        if (withPacket.length > 0) onReadPath = packetTypedness(withPacket[0].packetJson);
      } catch {
        /* judged below */
      }
      if (job.status === "done" && onJob === "typed" && onReadPath === "typed") {
        record(5, scope, "PASS", `terminal 'done' with a typed packet on the job row and the handoff_read path`);
      } else {
        record(5, scope, "FAIL", `terminal=${job.status}; packet on job=${onJob}; packet on read path=${onReadPath}; result=${JSON.stringify(job?.result ?? "").slice(0, 200)}`);
      }
    } else {
      record(5, scope, "FAIL", `job for task ${task.id} never reached terminal (status=${job?.status ?? "missing"})`);
    }
    // link 8, honesty half: the fake lane persists no resume handle, and must say so.
    if (job && !job.vendorSessionId) {
      record(8, scope, "SKIP", `fake lane persists no session handle; vendorSessionId=NULL is the honest answer (asserted)`);
    } else if (job) {
      record(8, scope, "FAIL", `fake lane claims a vendorSessionId (${job.vendorSessionId}) it cannot resume — dishonest handle`);
    }
  }
  record(6, "fake", "SKIP", "orchestrator wake not exercised: the fake vendor holds no coordinator seat, so a fake mission has no coordinator (real mode covers this link)");
  record(7, "fake", "SKIP", "peer messaging not exercised: the fake worker is a deterministic double that sends no peer messages (real mode covers this link)");
}

// ─────────────────────────────── finalize ───────────────────────────────

async function orphanSweep() {
  section("link 9: shutdown + orphan sweep");
  stopApprover();
  await shutdownAll();
  // Anything still alive that references our scratch root is an orphan the
  // product leaked (vendor child, pty, app-server...). pgrep -f matches argv.
  const patterns = [ROOT];
  const orphans = [];
  for (const pattern of patterns) {
    try {
      const { stdout } = await execFile("pgrep", ["-lf", pattern], { timeout: 10_000 });
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const pid = Number(trimmed.split(/\s+/)[0]);
        if (pid === process.pid) continue;
        orphans.push(trimmed);
      }
    } catch {
      /* pgrep rc=1 → no match, the good case */
    }
  }
  // Residue sweep: claude (not config-isolated, see header) records additive
  // session transcripts under ~/.claude/projects/<encoded-cwd>. Remove ONLY
  // entries whose encoded name contains this run's unique mkdtemp basename;
  // nothing else in the operator's claude home is ever touched.
  const scratchBase = path.basename(ROOT); // e.g. muon-mission-smoke-Ab12Cd
  const projectsDir = path.join(homedir(), ".claude", "projects");
  try {
    for (const entry of readdirSync(projectsDir)) {
      if (entry.includes(scratchBase)) {
        rmSync(path.join(projectsDir, entry), { recursive: true, force: true });
        log(`removed additive claude transcript residue: ~/.claude/projects/${entry}`);
      }
    }
  } catch {
    /* no projects dir / nothing recorded */
  }
  await deregisterScratchRepo();
  if (orphans.length === 0) {
    record(9, "run", "PASS", "no process referencing the scratch root survived shutdown");
  } else {
    record(
      9,
      "run",
      "FAIL",
      `${orphans.length} orphan process(es) survived shutdown and were SIGKILLed:\n${orphans.join("\n")}`
    );
    for (const line of orphans) {
      const pid = Number(line.split(/\s+/)[0]);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

function summarize(startedAt) {
  section("SUMMARY");
  const width = Math.max(...Object.values(LINK_NAMES).map((n) => n.length));
  for (const link of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const rows = results.filter((r) => r.link === link);
    const line = rows.length
      ? rows.map((r) => `${r.status === "PASS" ? "PASS" : r.status === "SKIP" ? "skip" : "FAIL"}(${r.scope})`).join(" ")
      : "not-evaluated";
    process.stdout.write(`  link ${link}  ${LINK_NAMES[link].padEnd(width)}  ${line}\n`);
  }
  const envSkips = results.filter((r) => r.link === 0);
  for (const s of envSkips) process.stdout.write(`  env     ${s.detail}\n`);
  const fails = results.filter((r) => r.status === "FAIL");
  const notEvaluated = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
    (l) => !results.some((r) => r.link === l)
  );
  process.stdout.write(
    `\n  standing consent decided ${approver.resolved.length} approval(s)` +
      (approver.skippedMerge.length ? `, left ${approver.skippedMerge.length} merge gate(s) pending by design` : "") +
      (approver.failures.length ? `, ${approver.failures.length} sweep error(s)` : "") +
      `\n  wall time ${Math.round((Date.now() - startedAt) / 1000)}s; scratch root ${KEEP ? `kept at ${ROOT}` : "removed"}\n`
  );
  if (fails.length > 0) {
    process.stdout.write(`\nRESULT: FAIL — ${fails.length} link check(s) failed:\n`);
    for (const f of fails) process.stdout.write(`  ✗ link ${f.link} [${f.scope}]: ${f.detail.split("\n")[0]}\n`);
    return 1;
  }
  if (notEvaluated.length > 0) {
    process.stdout.write(`\nRESULT: FAIL — links never evaluated (run aborted early): ${notEvaluated.join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`\nRESULT: PASS${results.some((r) => r.status === "SKIP") ? " (with skips, see above)" : ""}\n`);
  return 0;
}

// ─────────────────────────────── main ───────────────────────────────

async function main() {
  const startedAt = Date.now();
  log(`MUON mission smoke — mode: ${FAKE ? "FAKE (CI spine)" : "REAL vendors"}; scratch: ${ROOT}; overall cap ${Math.round(OVERALL_TIMEOUT_MS / 1000)}s`);

  if (!FAKE && process.env.MUON_FAKE_VENDOR) {
    throw new Error("MUON_FAKE_VENDOR is set in this shell; a real-vendor smoke under the fake seam would be a false green. Unset it or pass --fake.");
  }
  for (const [what, file] of [
    ["backend build", BACKEND_ENTRY],
    ["CLI build", CLI_ENTRY],
  ]) {
    if (!existsSync(file)) {
      throw new Error(`ENVIRONMENT: ${what} missing at ${file}. Run the package builds first (scripts/ci-install.sh or the */build npm scripts).`);
    }
  }

  // Hard watchdog: whatever phase hangs, the run ends with a diagnosis.
  const watchdog = setTimeout(() => {
    process.stdout.write(`\nWATCHDOG: overall cap ${OVERALL_TIMEOUT_MS / 1000}s exceeded — killing everything and reporting what was proven so far.\n`);
    record(0, "watchdog", "FAIL", `overall timeout after ${OVERALL_TIMEOUT_MS / 1000}s`);
    stopApprover();
    for (const p of spawned) killGroup(p.pid, "SIGKILL");
    const code = summarize(startedAt);
    process.exitCode = code || 1;
    process.exit();
  }, OVERALL_TIMEOUT_MS);
  watchdog.unref?.();

  await scaffoldRepo();
  log(`scratch target repo scaffolded at ${REPO} (baseline test intentionally failing)`);
  await bootBackend();
  startApprover();
  await bootRunner();

  try {
    if (FAKE) {
      await fakeMission();
    } else {
      const ready = await vendorGate();
      if (ready.length === 0) {
        for (const link of [1, 2, 3, 4, 5, 6, 7, 8]) {
          record(link, "env", "SKIP", "ENVIRONMENT: neither claude-code nor codex is dispatch-ready on this machine (see doctor rows above) — real-mode links skipped, not failed");
        }
      } else {
        if (ready.length === 1) {
          log(`only ${ready[0]} is dispatch-ready; running BOTH children on it (the other vendor's links are env-skipped above)`);
        }
        await realMission(ready);
      }
    }
  } finally {
    await orphanSweep();
  }

  clearTimeout(watchdog);
  const code = summarize(startedAt);
  finalized = true;
  if (!KEEP) rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = code;
}

main().catch(async (error) => {
  process.stdout.write(`\nHARNESS ERROR: ${error.message}\n${error.stack?.split("\n").slice(1, 4).join("\n") ?? ""}\n`);
  stopApprover();
  await shutdownAll().catch(() => {});
  const isEnv = /^ENVIRONMENT:/.test(error.message);
  process.exitCode = isEnv ? 0 : 2;
  if (isEnv) process.stdout.write("RESULT: SKIP (environment, see above)\n");
});
