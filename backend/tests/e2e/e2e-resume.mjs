// MUON P0.1 — checkpoint + resume acceptance (the kill-at-each-phase E2E).
//
// Boots the REAL embedded backend, REALLY kills it (SIGKILL) at each lifecycle
// phase, reopens the SAME data dir, and proves the Future.md acceptance:
// the same root/lineage digest, the exact surviving ledger state, unchanged
// artifact hashes, and ZERO duplicate side effects (the fake vendor's additive
// sentinel is written exactly as many times as a human authorized).
//
// The resume act is exercised at the planner layer (`planResume` +
// `buildRedispatchInput` from the built @muon/client — the exact functions
// `muon bundle resume` runs); the CLI surface itself is unit-tested in
// apps/cli/tests/bundle.test.ts. Everything here is hermetic: temp dirs, the
// deterministic fake vendor (MUON_FAKE_VENDOR=1), no real vendor CLI, no
// network beyond loopback.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assert,
  assertStatus,
  sleep,
  startInProcessRunner,
  startLiveBackend,
  until,
} from "./live-backend.mjs";
import {
  MuonApiClient,
  buildRedispatchInput,
  collectRunBundle,
  planResume,
} from "../../../packages/client/dist/index.js";
import {
  collectWorktreeEvidence,
  ensureTaskWorktree,
  taskWorktreePath,
} from "../../../packages/core/dist/index.js";
import {
  FAKE_ARTIFACT_FILENAME,
  FAKE_VENDOR_KEY,
} from "../../../packages/adapters/dist/index.js";

process.env.MUON_FAKE_VENDOR = "1";

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const nonce = Math.random().toString(36).slice(2, 10);

// The REC-025 byte-identical promise (reclaim's fixed result text).
const REC_025_FIXED_RESULT =
  "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.";

const results = [];
async function group(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}\n      ${error.stack ?? error.message}`);
  }
}

const state = {};
let backend = null;
let runner = null;

const client = () =>
  new MuonApiClient(backend.getBaseUrl(), fetch, state.agent);

function sentinelBlocks(workspace) {
  const file = path.join(workspace, FAKE_ARTIFACT_FILENAME);
  if (!existsSync(file)) return 0;
  return (
    readFileSync(file, "utf8").match(/<!-- muon-fake-vendor -->/g) ?? []
  ).length;
}

async function createTask(api, title) {
  const res = await api("POST", "/api/tasks", {
    token: state.op,
    body: { title, description: `${title} (resume E2E)` },
  });
  assertStatus(res, 201, "POST /api/tasks");
  return res.json.task.id;
}

async function liveState(taskId) {
  const c = client();
  const [jobs, approvals, sessions] = await Promise.all([
    c.listDispatchJobs({ taskId, limit: 100 }),
    c.listApprovals(),
    c.listSessions({ taskId }).catch(() => []),
  ]);
  return {
    jobs,
    approvals: approvals.filter((approval) => approval.taskId === taskId),
    sessions,
  };
}

async function pollJobStatus(api, jobId, statuses, label) {
  return until(
    async () => {
      const res = await api("GET", `/api/dispatch/${jobId}`, {
        token: state.agent,
      });
      assertStatus(res, 200, `GET /api/dispatch/${jobId}`);
      assert(
        statuses.includes(res.json.job.status),
        `${label}: job still ${res.json.job.status}`
      );
      return res.json.job;
    },
    { tries: 120, delay: 250, label }
  );
}

/** Re-read the fresh lockfile tokens after a kill+restart. */
function adoptLock(lock) {
  state.op = lock.token;
  state.agent = lock.agentToken;
}

async function main() {
  backend = await startLiveBackend({ prefix: "muon-resume" });
  const { api, dirs } = backend;
  adoptLock(backend.lock);

  // ── PHASE 1: kill@queued — same lineage, zero writes, exactly ONE side effect
  await group(
    "1. kill@queued: digest stable across SIGKILL+reopen; dry-run writes nothing; sentinel exactly once",
    async () => {
      const taskId = await createTask(api, `resume queued ${nonce}`);
      const workspace = path.join(dirs.WORKSPACE_ROOT, `queued-${nonce}`);
      mkdirSync(workspace, { recursive: true });
      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId,
          brief: `queued-then-killed ${nonce}`,
          workspacePath: workspace,
        },
      });
      assertStatus(dispatched, 201, "POST /api/dispatch (queued)");
      const jobId = dispatched.json.job.id;

      const bundlePre = await collectRunBundle(client(), { jobId, sha256Hex });
      assert(
        bundlePre.checkpoint.jobs.find((j) => j.jobId === jobId)?.phase ===
          "queued",
        "pre-kill phase must be queued"
      );
      const digestPre = bundlePre.checkpoint.lineageDigest;
      assert(digestPre, "pre-kill bundle must carry a lineage digest");

      // THE KILL: SIGKILL the backend; reopen the same data dir.
      const { lock } = await backend.restart();
      adoptLock(lock);

      const bundlePost = await collectRunBundle(client(), { jobId, sha256Hex });
      assert(
        bundlePost.checkpoint.lineageDigest === digestPre,
        `lineage digest changed across restart: ${digestPre} → ${bundlePost.checkpoint.lineageDigest}`
      );
      assert(
        bundlePost.checkpoint.jobs.find((j) => j.jobId === jobId)?.phase ===
          "queued",
        "post-restart phase must still be queued"
      );

      // Resume dry-run: the plan is pure; the ledger stays byte-identical.
      const before = JSON.stringify(
        (await api("GET", `/api/dispatch?taskId=${taskId}`, { token: state.agent }))
          .json.jobs
      );
      const plan = planResume({
        live: await liveState(taskId),
        bundle: bundlePost,
        sha256Hex,
      });
      assert(!plan.refused, `plan refused: ${plan.refused?.reason}`);
      assert(plan.lineage.match === true, "bundle/live lineage must match");
      assert(
        plan.actions.length === 1 &&
          plan.actions[0].kind === "none-still-queued",
        `expected none-still-queued, got ${JSON.stringify(plan.actions)}`
      );
      const after = JSON.stringify(
        (await api("GET", `/api/dispatch?taskId=${taskId}`, { token: state.agent }))
          .json.jobs
      );
      assert(before === after, "dry-run must leave the job list byte-identical");

      // The still-queued job now runs to completion — exactly ONE side effect.
      runner = startInProcessRunner({
        baseUrl: backend.getBaseUrl(),
        agentToken: state.agent,
        operatorToken: state.op,
        host: `resume-r1-${nonce}`,
        onLog: () => undefined,
      });
      const done = await pollJobStatus(
        api,
        jobId,
        ["done", "failed"],
        "queued job resumes to terminal"
      );
      assert(done.status === "done", `expected done, got ${done.status}: ${done.result}`);
      await runner.stop();
      runner = null;
      assert(
        sentinelBlocks(workspace) === 1,
        `sentinel must be written exactly once, found ${sentinelBlocks(workspace)}`
      );
    }
  );

  // ── PHASE 2: kill@running — reclaim, uncertain, never auto-replayed ─────────
  await group(
    "2. kill@running: successor reclaims (REC-025 byte-exact); uncertain never auto-replays; explicit --redispatch runs once",
    async () => {
      const taskId = await createTask(api, `resume running ${nonce}`);
      const workspace = path.join(dirs.WORKSPACE_ROOT, `running-${nonce}`);
      mkdirSync(workspace, { recursive: true });
      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId,
          brief: `mid-run kill ${nonce}`,
          workspacePath: workspace,
        },
      });
      const jobId = dispatched.json.job.id;

      // A "runner" claims the job over HTTP, then DIES (it never existed as a
      // process — exactly what the ledger sees after a SIGKILL mid-claim: a
      // running row under a lease nobody is renewing).
      const host = `resume-r2-${nonce}`;
      const deadLease = `lease-${nonce}-${"a".repeat(64)}`;
      assertStatus(
        await api("POST", "/api/runner/lease", {
          token: state.op,
          body: { host, leaseToken: deadLease },
        }),
        200,
        "POST /api/runner/lease (doomed incarnation)"
      );
      assertStatus(
        await api("POST", "/api/runner/heartbeat", {
          token: state.agent,
          body: { host, pid: process.pid, leaseToken: deadLease },
        }),
        200,
        "heartbeat (doomed incarnation)"
      );
      const claimed = await api("POST", `/api/dispatch/${jobId}/claim`, {
        token: state.agent,
        body: { host, leaseToken: deadLease },
      });
      assertStatus(claimed, 201, "claim (doomed incarnation)");

      const bundlePre = await collectRunBundle(client(), { jobId, sha256Hex });
      const digestPre = bundlePre.checkpoint.lineageDigest;

      // The SUCCESSOR runner on the same host: startup reclaim owns this.
      runner = startInProcessRunner({
        baseUrl: backend.getBaseUrl(),
        agentToken: state.agent,
        operatorToken: state.op,
        host,
        onLog: () => undefined,
      });
      const reclaimedJob = await pollJobStatus(
        api,
        jobId,
        ["interrupted"],
        "successor reclaim interrupts the orphaned job"
      );
      assert(
        reclaimedJob.result === REC_025_FIXED_RESULT,
        `REC-025 text drifted: ${JSON.stringify(reclaimedJob.result)}`
      );

      const bundlePost = await collectRunBundle(client(), { jobId, sha256Hex });
      assert(
        bundlePost.checkpoint.lineageDigest === digestPre,
        "digest must be unchanged across the mid-run kill"
      );
      const checkpointJob = bundlePost.checkpoint.jobs.find(
        (j) => j.jobId === jobId
      );
      assert(checkpointJob?.uncertain === true, "reclaimed job must be uncertain");
      assert(
        checkpointJob?.provablyUnstarted === false,
        "a reclaimed post-claim job is NEVER provably unstarted"
      );

      // Resume: the plan sends it to the human; an --execute pass would
      // re-dispatch nothing (no redispatch-fresh in the plan).
      const live = await liveState(taskId);
      const plan = planResume({ live, bundle: bundlePost, sha256Hex });
      assert(!plan.refused, `plan refused: ${plan.refused?.reason}`);
      const mine = plan.actions.filter((action) => action.jobId === jobId);
      assert(
        mine.length === 1 && mine[0].kind === "human-review",
        `expected human-review, got ${JSON.stringify(mine)}`
      );
      assert(
        plan.actions.every((action) => action.kind !== "redispatch-fresh"),
        "an uncertain job must never appear as redispatch-fresh"
      );
      assert(
        sentinelBlocks(workspace) === 0,
        "no side effect may exist before the human authorizes the redispatch"
      );

      // The explicit human act: --redispatch <jobId> (planner's own manifest copy).
      const originalRow = (
        await api("GET", `/api/dispatch/${jobId}`, { token: state.agent })
      ).json.job;
      const originalJob = live.jobs.find((job) => job.id === jobId);
      const fresh = await client().enqueueDispatch(
        buildRedispatchInput(originalJob, live.sessions)
      );
      assert(fresh.id !== jobId, "redispatch must mint a FRESH job id");
      assert(
        fresh.resumedFromJobId === jobId,
        "the fresh job must carry resumedFromJobId lineage"
      );
      const freshDone = await pollJobStatus(
        api,
        fresh.id,
        ["done", "failed"],
        "redispatched job runs"
      );
      assert(freshDone.status === "done", `redispatch: ${freshDone.result}`);

      assert(
        sentinelBlocks(workspace) === 1,
        `human-authorized redispatch must produce exactly one sentinel block, found ${sentinelBlocks(workspace)}`
      );

      // APPEND-ONCE (P0.1 replay-safety): the interrupted original stays
      // immutable EXCEPT the one write-once resume stamp (resumedAt +
      // resumedByJobId = the fresh child that claimed it).
      const originalAfter = (
        await api("GET", `/api/dispatch/${jobId}`, { token: state.agent })
      ).json.job;
      assert(
        originalAfter.resumedByJobId === fresh.id && originalAfter.resumedAt != null,
        "the original must carry the append-once resume stamp (resumedByJobId + resumedAt)"
      );
      const stripStamp = (job) => {
        const { resumedAt, resumedByJobId, updatedAt, ...rest } = job;
        return JSON.stringify(rest);
      };
      assert(
        stripStamp(originalRow) === stripStamp(originalAfter),
        "the original interrupted row must stay byte-identical except the append-once resume stamp"
      );

      // A SECOND resume of the SAME original is refused (409) and mints NO child.
      // The runner is deliberately still live: a leaked duplicate child WOULD be
      // claimed and would write a second sentinel — this proves it never exists.
      let secondRefused = false;
      try {
        await client().enqueueDispatch(
          buildRedispatchInput(originalJob, live.sessions)
        );
      } catch {
        secondRefused = true;
      }
      assert(
        secondRefused,
        "a second resume of the same original must be refused (409)"
      );
      await sleep(500);
      assert(
        sentinelBlocks(workspace) === 1,
        `a refused second resume must not add a side effect (sentinel stays 1), found ${sentinelBlocks(workspace)}`
      );

      // The planner now classes the spent original as already-resumed (skip).
      const rePlan = planResume({ live: await liveState(taskId), sha256Hex });
      const spent = rePlan.actions.find((action) => action.jobId === jobId);
      assert(
        spent && spent.kind === "already-resumed",
        `the spent original must plan as already-resumed, got ${JSON.stringify(spent)}`
      );

      await runner.stop();
      runner = null;
    }
  );

  // ── PHASE 3: kill@terminal — artifact hashes re-verified from disk ──────────
  await group(
    "3. kill@terminal: packet diffHash re-verifies from the on-disk worktree; a mutation reads DIVERGED",
    async () => {
      // A real git repo inside the workspace allowlist + a governed worktree.
      const repoRoot = path.join(dirs.WORKSPACE_ROOT, `repo-${nonce}`);
      mkdirSync(repoRoot, { recursive: true });
      const git = (...args) =>
        execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("config", "user.email", "e2e@example.com");
      git("config", "user.name", "MUON E2E");
      writeFileSync(path.join(repoRoot, "base.txt"), "base\n");
      git("add", ".");
      git("commit", "-m", "base");

      const taskId = await createTask(api, `resume terminal ${nonce}`);
      const worktree = await ensureTaskWorktree({ repoRoot, taskId });
      writeFileSync(path.join(worktree.path, "artifact.txt"), "made by the run\n");
      const evidence = await collectWorktreeEvidence(worktree.path);
      assert("hash" in evidence.diff, "worktree evidence must produce a hash");
      const diffHash = evidence.diff.hash;

      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId,
          brief: `terminal ${nonce}`,
          workspacePath: repoRoot,
        },
      });
      const jobId = dispatched.json.job.id;
      const host = `resume-r3-${nonce}`;
      const lease = `lease-${nonce}-${"b".repeat(64)}`;
      await api("POST", "/api/runner/lease", {
        token: state.op,
        body: { host, leaseToken: lease },
      });
      await api("POST", "/api/runner/heartbeat", {
        token: state.agent,
        body: { host, pid: process.pid, leaseToken: lease },
      });
      assertStatus(
        await api("POST", `/api/dispatch/${jobId}/claim`, {
          token: state.agent,
          body: { host, leaseToken: lease },
        }),
        201,
        "claim (terminal phase)"
      );
      const terminal = await api("PATCH", `/api/dispatch/${jobId}`, {
        token: state.agent,
        body: {
          status: "done",
          result: "run complete",
          exitCode: 0,
          host,
          leaseToken: lease,
          packet: {
            taskGoal: "produce the artifact",
            whatChanged: "wrote artifact.txt in the governed worktree",
            whatFailed: "nothing reported failing",
            nextLaneRequest: "review the artifact",
            commandsRun: [],
            checksStatus: ["exit_code=0"],
            openQuestions: [],
            provenance: { lane: FAKE_VENDOR_KEY, createdAt: new Date().toISOString() },
            schemaVersion: 2,
            diffHash,
          },
        },
      });
      assertStatus(terminal, 200, "terminal PATCH with packet diffHash");

      // THE KILL, after terminal. Reopen and re-verify from disk.
      const { lock } = await backend.restart();
      adoptLock(lock);

      const job = await client().getDispatchJob(jobId);
      const plan = planResume({
        live: { jobs: [job], approvals: [], sessions: [] },
        sha256Hex,
      });
      const verify = plan.actions.find(
        (action) => action.kind === "verify-artifacts"
      );
      assert(verify, "terminal job with a packet diffHash must plan verify-artifacts");
      assert(verify.diffHash === diffHash, "planned diffHash must be the packet's");

      const located = taskWorktreePath(repoRoot, taskId);
      assert(located === worktree.path, "pure path helper must locate the worktree");
      const reVerified = await collectWorktreeEvidence(located);
      assert(
        "hash" in reVerified.diff && reVerified.diff.hash === diffHash,
        "verified-unchanged: the on-disk worktree must re-hash to the packet diffHash"
      );

      // Mutate the worktree → the same verification reads DIVERGED.
      writeFileSync(path.join(located, "artifact.txt"), "tampered after the run\n");
      const diverged = await collectWorktreeEvidence(located);
      assert(
        "hash" in diverged.diff && diverged.diff.hash !== diffHash,
        "a mutated worktree must NOT re-hash to the packet diffHash (DIVERGED)"
      );
    }
  );

  // ── PHASE 4: kill@waiting-gate — the exact pending gate survives the kill ───
  await group(
    "4. kill@waiting-gate: the exact pending gate (id + jobId + payloadDigest) survives SIGKILL+reopen and successor reclaim; consume stays fail-closed",
    async () => {
      const taskId = await createTask(api, `resume gate ${nonce}`);
      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "session",
          taskId,
          brief: `gate-parked ${nonce}`,
        },
      });
      assertStatus(dispatched, 201, "POST /api/dispatch (session, gate phase)");
      const jobId = dispatched.json.job.id;

      // A doomed incarnation claims, then the vendor parks on an approval.
      const host = `resume-r4-${nonce}`;
      const deadLease = `lease-${nonce}-${"c".repeat(64)}`;
      assertStatus(
        await api("POST", "/api/runner/lease", {
          token: state.op,
          body: { host, leaseToken: deadLease },
        }),
        200,
        "POST /api/runner/lease (gate phase)"
      );
      assertStatus(
        await api("POST", "/api/runner/heartbeat", {
          token: state.agent,
          body: { host, pid: process.pid, leaseToken: deadLease },
        }),
        200,
        "heartbeat (gate phase)"
      );
      assertStatus(
        await api("POST", `/api/dispatch/${jobId}/claim`, {
          token: state.agent,
          body: { host, leaseToken: deadLease },
        }),
        201,
        "claim (gate phase)"
      );

      const payloadDigest = sha256Hex(`rm -rf ./build ${nonce}`);
      const filed = await api("POST", "/api/approvals", {
        token: state.agent,
        body: {
          taskId,
          requestedBy: FAKE_VENDOR_KEY,
          kind: "command",
          reason: "Run the requested command",
          jobId,
          evidence: {
            action: "Bash",
            scope: "Command: rm -rf ./build",
            riskLevel: "high",
            impactIfApproved:
              "Runs a shell command in the selected workspace and may modify files.",
            payloadDigest,
            details: {},
          },
        },
      });
      assertStatus(filed, 201, "POST /api/approvals (pending gate)");
      const approvalId = filed.json.approval.id;

      const bundlePre = await collectRunBundle(client(), { jobId, sha256Hex });
      const digestPre = bundlePre.checkpoint.lineageDigest;
      const gatePre = bundlePre.checkpoint.pendingGates.find(
        (gate) => gate.approvalId === approvalId
      );
      assert(gatePre, "pre-kill bundle must carry the pending gate");
      assert(
        gatePre.jobId === jobId && gatePre.payloadDigest === payloadDigest,
        "pre-kill gate must carry its exact binding"
      );

      // THE KILL: SIGKILL the backend mid-gate; reopen the same data dir.
      const { lock } = await backend.restart();
      adoptLock(lock);

      // The successor reclaims the orphaned running job. Approvals untouched.
      const leaseB = `lease-${nonce}-${"d".repeat(64)}`;
      assertStatus(
        await api("POST", "/api/runner/lease", {
          token: state.op,
          body: { host, leaseToken: leaseB },
        }),
        200,
        "POST /api/runner/lease (successor, gate phase)"
      );
      const reclaimed = await api("POST", "/api/dispatch/reclaim", {
        token: state.agent,
        body: { host, leaseToken: leaseB },
      });
      assertStatus(reclaimed, 200, "POST /api/dispatch/reclaim (gate phase)");
      assert(
        reclaimed.json.jobIds.includes(jobId),
        "the successor reclaim must interrupt the orphaned gate-parked job"
      );
      const jobAfter = (
        await api("GET", `/api/dispatch/${jobId}`, { token: state.agent })
      ).json.job;
      assert(
        jobAfter.result === REC_025_FIXED_RESULT,
        `REC-025 text drifted at the gate phase: ${JSON.stringify(jobAfter.result)}`
      );

      // The bundle after the kill: same lineage, the SAME exact pending gate.
      const bundlePost = await collectRunBundle(client(), { jobId, sha256Hex });
      assert(
        bundlePost.checkpoint.lineageDigest === digestPre,
        "digest must be unchanged across the waiting-gate kill"
      );
      const gatePost = bundlePost.checkpoint.pendingGates.find(
        (gate) => gate.approvalId === approvalId
      );
      assert(gatePost, "the pending gate must survive the kill in the bundle");
      assert(
        gatePost.jobId === jobId && gatePost.payloadDigest === payloadDigest,
        "the surviving gate must keep its exact binding (jobId + payloadDigest)"
      );

      // Resume: the human decision comes first — decide-gate, nothing else
      // planned for this job (never redispatch, never auto-anything).
      const live = await liveState(taskId);
      const plan = planResume({ live, bundle: bundlePost, sha256Hex });
      assert(!plan.refused, `plan refused: ${plan.refused?.reason}`);
      const mine = plan.actions.filter((action) => action.jobId === jobId);
      assert(
        mine.length === 1 &&
          mine[0].kind === "decide-gate" &&
          mine[0].approvalId === approvalId &&
          mine[0].payloadDigest === payloadDigest,
        `expected exactly one decide-gate with the exact binding, got ${JSON.stringify(mine)}`
      );

      // Fail-closed across the restart: a pending gate can never be consumed,
      // and the refusal never mutates it.
      const premature = await api(
        "POST",
        `/api/approvals/${approvalId}/consume`,
        { token: state.agent }
      );
      assert(
        premature.status === 409,
        `consuming a PENDING gate must 409, got ${premature.status}`
      );
      const rows = await client().listApprovals();
      const survivor = rows.find((row) => row.id === approvalId);
      assert(
        survivor && survivor.status === "pending" && survivor.consumedAt == null,
        "the pending gate must remain pending and unconsumed after the refused consume"
      );
    }
  );
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`\nFATAL: ${error.stack ?? error.message}`);
  if (backend) console.error(`--- recent backend log ---\n${backend.recentLogs()}`);
  exitCode = 1;
} finally {
  if (runner) await runner.stop().catch(() => undefined);
  if (backend) {
    await backend.stop().catch(() => undefined);
    backend.cleanup();
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n──────────── E2E resume summary ────────────");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log("─────────────────────────────────────────────");
console.log(`${results.length - failed.length}/${results.length} phase groups passed.`);
if (failed.length > 0 || exitCode !== 0) {
  console.error(`\nE2E RESUME FAILED (${failed.length} group(s) failed).`);
  process.exit(1);
}
console.log(
  "\nE2E RESUME PASSED — same lineage, exact surviving state, unchanged artifact hashes, zero duplicate side effects."
);
process.exit(0);
