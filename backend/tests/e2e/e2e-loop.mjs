// MUON P7, FULL-LOOP end-to-end harness (the automatable half of validation).
//
// Where e2e-smoke.mjs proves the MOAT loop (memory + governance + auth) over
// live HTTP, THIS proves the ORCHESTRATION SPINE end-to-end: it boots the REAL
// embedded backend AND drives the REAL persistent runner in-process, dispatches
// a task to a deterministic FAKE vendor over HTTP, and asserts the whole loop:
//
//   dispatch (queued) → runner claims a fleet agent (0–3 semaphore) → claims the
//   job (queued→running) → executeJob picks the driver → the fake vendor streams
//   + makes an additive workspace edit + a terminal exit-0 → StreamChunks land →
//   status `done` → the agent is released → (under the review harness) the real
//   self-filling-brain capture ingests a note that surfaces via recall/search →
//   the two-token boundary + the P3-B workspace sandbox still hold → the fake is
//   keyed STRICTLY on vendor:"fake" (a real claude-code dispatch never touches it).
//
// The ONLY substitution vs. production is the vendor leaf (MUON_FAKE_VENDOR=1):
// no real vendor CLI, no vendor token, no network. Hermetic temp dirs; the dev's
// real brain dir is never touched. Exits non-zero on any failed assertion.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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
  FAKE_ARTIFACT_FILENAME,
  FAKE_MEMORY_SENTINEL,
  FAKE_VENDOR_KEY,
  getFakeInvocations,
} from "../../../packages/adapters/dist/index.js";
import { locateTaskWorktreePath } from "../../../packages/core/dist/index.js";
import { dispatchActionGateTag } from "../../../packages/protocol/dist/index.js";

process.env.MUON_FAKE_VENDOR = "1";

const nonce = Math.random().toString(36).slice(2, 10);
const results = [];
async function group(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const state = {};
let backend = null;
let runner = null;

async function pollJobTerminal(api, jobId, label) {
  return until(
    async () => {
      const res = await api("GET", `/api/dispatch/${jobId}`, { token: state.agent });
      assertStatus(res, 200, `GET /api/dispatch/${jobId}`);
      const job = res.json.job;
      assert(
        ["done", "failed", "interrupted"].includes(job.status),
        `${label}: job still ${job.status}`
      );
      return job;
    },
    { tries: 80, delay: 250, label }
  );
}

async function main() {
  backend = await startLiveBackend({ prefix: "muon-loop", allowGit: true });
  const { api, lock, dirs } = backend;
  state.op = lock.token;
  state.agent = lock.agentToken;

  // ── GROUP 1, boot, two-token contract, fake fleet seeded ───────────────────
  await group("1. Boot + two-token contract + fake fleet agent seeded", async () => {
    assert(typeof lock.port === "number" && lock.port > 0, "lockfile: no valid port");
    assert(typeof lock.token === "string" && lock.token.length >= 8, "missing operator token");
    assert(typeof lock.agentToken === "string" && lock.agentToken.length >= 8, "missing agent token");
    assert(lock.token !== lock.agentToken, "operator and agent tokens must differ");

    let health = await api("GET", "/health");
    for (let i = 0; i < 5 && health.status !== 200; i += 1) {
      await sleep(300);
      health = await api("GET", "/health");
    }
    assertStatus(health, 200, "GET /health");

    // The dev/test fake vendor is seeded as a lane plus the configured fleet
    // capacity. The exact count is registry policy; the contention scenario
    // below derives its expectation from this live snapshot.
    const lanes = await api("GET", "/api/lanes", { token: state.op });
    assertStatus(lanes, 200, "GET /api/lanes");
    assert(
      lanes.json.lanes.some((l) => l.key === FAKE_VENDOR_KEY),
      "fake lane must be seeded when MUON_FAKE_VENDOR=1"
    );
    const agents = await api("GET", "/api/fleet/agents", { token: state.op });
    assertStatus(agents, 200, "GET /api/fleet/agents");
    const fakeAgents = agents.json.agents.filter((a) => a.vendor === FAKE_VENDOR_KEY);
    assert(fakeAgents.length > 0, "expected at least one fake fleet agent");
    assert(fakeAgents.every((agent) => agent.status === "idle"), "fake agents should start idle");
    state.fakeAgentCount = fakeAgents.length;
  });

  // ── GROUP 2, real SQLite claim contention + lease fencing ──────────────────
  await group("2. SQLite contention: N fleet slots, N+1 simultaneous claims, one conflict", async () => {
    const task = await api("POST", "/api/tasks", {
      token: state.op,
      body: {
        title: `E2E contention ${nonce}`,
        description: "real SQLite atomic claim contention",
      },
    });
    assertStatus(task, 201, "POST /api/tasks (contention)");
    const taskId = task.json.task.id;

    const jobs = [];
    const capacity = state.fakeAgentCount;
    assert(Number.isInteger(capacity) && capacity > 0, "fake fleet capacity was not measured");
    for (let index = 0; index < capacity + 1; index += 1) {
      const suffix = String(index + 1);
      const workspace = path.join(
        dirs.WORKSPACE_ROOT,
        `contention-${nonce}-${suffix}`
      );
      mkdirSync(workspace, { recursive: true });
      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId,
          brief: `contention candidate ${suffix}`,
          workspacePath: workspace,
        },
      });
      assertStatus(dispatched, 201, `POST /api/dispatch (contention ${suffix})`);
      jobs.push(dispatched.json.job.id);
    }

    const host = `sqlite-contention-${nonce}`;
    const leaseToken = `lease-${nonce}-${"x".repeat(64)}`;
    const authorized = await api("POST", "/api/runner/lease", {
      token: state.op,
      body: { host, leaseToken },
    });
    assertStatus(authorized, 200, "POST /api/runner/lease");
    const heartbeat = await api("POST", "/api/runner/heartbeat", {
      token: state.agent,
      body: { host, pid: process.pid, leaseToken },
    });
    assertStatus(heartbeat, 200, "POST /api/runner/heartbeat");

    const attempts = await Promise.all(
      jobs.map((jobId) =>
        api("POST", `/api/dispatch/${jobId}/claim`, {
          token: state.agent,
          body: { host, leaseToken },
        })
      )
    );
    const winners = attempts
      .map((response, index) => ({ response, jobId: jobs[index] }))
      .filter(({ response }) => response.status === 201);
    const losers = attempts
      .map((response, index) => ({ response, jobId: jobs[index] }))
      .filter(({ response }) => response.status === 409);
    assert(winners.length === capacity, `expected ${capacity} claim winners, got ${winners.length}`);
    assert(losers.length === 1, `expected one claim conflict, got ${losers.length}`);

    const winner = winners[0];
    const loser = losers[0];
    const assignedAgent = winner.response.json.agent;
    assert(
      winner.response.json.job.status === "running",
      "winning claim must transition queued → running"
    );
    const loserState = await api("GET", `/api/dispatch/${loser.jobId}`, {
      token: state.agent,
    });
    assertStatus(loserState, 200, "GET loser after contention");
    assert(
      loserState.json.job.status === "queued",
      "losing job must remain queued after transaction rollback"
    );

    const replay = await api(
      "POST",
      `/api/dispatch/${winner.jobId}/claim`,
      {
        token: state.agent,
        body: { host, leaseToken },
      }
    );
    assertStatus(replay, 201, "same-lease claim replay");
    assert(
      replay.json.agent.id === assignedAgent.id,
      "same-lease replay must return the original fleet assignment"
    );

    const reassignment = await api(
      "PATCH",
      `/api/dispatch/${winner.jobId}`,
      {
        token: state.agent,
        body: {
          status: "done",
          result: "malicious reassignment attempt",
          agentId: "different-agent",
          host,
          leaseToken,
        },
      }
    );
    assertStatus(reassignment, 409, "terminal agent reassignment");

    const terminal = await api(
      "PATCH",
      `/api/dispatch/${winner.jobId}`,
      {
        token: state.agent,
        body: {
          status: "done",
          result: "contention winner complete",
          exitCode: 0,
          host,
          leaseToken,
        },
      }
    );
    assertStatus(terminal, 200, "winner terminal commit");

    for (const extraWinner of winners.slice(1)) {
      const cleanup = await api(
        "PATCH",
        `/api/dispatch/${extraWinner.jobId}`,
        {
          token: state.agent,
          body: {
            status: "interrupted",
            result: "capacity contention proof cleanup",
            host,
            leaseToken,
          },
        }
      );
      assertStatus(cleanup, 200, "additional winner cleanup terminal");
    }

    const agentsAfterRelease = await api("GET", "/api/fleet/agents", {
      token: state.op,
    });
    const released = agentsAfterRelease.json.agents.find(
      (agent) => agent.id === assignedAgent.id
    );
    assert(released?.status === "idle", "winner terminal must release its agent");
    assert(!released?.currentJobId, "winner terminal must clear currentJobId");
    const fakeAfterRelease = agentsAfterRelease.json.agents.filter(
      (agent) => agent.vendor === FAKE_VENDOR_KEY
    );
    assert(
      fakeAfterRelease.every((agent) => agent.status === "idle" && !agent.currentJobId),
      "all capacity winners must release their fleet seats"
    );

    const loserClaim = await api(
      "POST",
      `/api/dispatch/${loser.jobId}/claim`,
      {
        token: state.agent,
        body: { host, leaseToken },
      }
    );
    assertStatus(loserClaim, 201, "loser claim after winner release");
    const loserTerminal = await api(
      "PATCH",
      `/api/dispatch/${loser.jobId}`,
      {
        token: state.agent,
        body: {
          status: "interrupted",
          result: "contention proof cleanup",
          host,
          leaseToken,
        },
      }
    );
    assertStatus(loserTerminal, 200, "loser cleanup terminal");
  });

  // ── GROUP 3, two-runner split-brain fencing ────────────────────────────────
  await group("3. Lease takeover cancels the old execution and never replays it", async () => {
    let executeCalls = 0;
    let markStarted = () => undefined;
    let markCancelled = () => undefined;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const cancelled = new Promise((resolve) => {
      markCancelled = resolve;
    });
    const blockedExecute = async (_client, _job, _agent, options) => {
      executeCalls += 1;
      markStarted();
      await new Promise((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener("abort", resolve, { once: true });
      });
      markCancelled();
      return {
        status: "interrupted",
        result: "old execution observed explicit lease fencing",
      };
    };

    const host = `split-brain-${nonce}`;
    const first = startInProcessRunner({
      baseUrl: backend.baseUrl,
      agentToken: state.agent,
      operatorToken: state.op,
      host,
      execute: blockedExecute,
      heartbeatMs: 20,
      pollMs: 20,
      onLog: () => undefined,
    });
    let second = null;
    try {
      const task = await api("POST", "/api/tasks", {
        token: state.op,
        body: {
          title: `E2E split brain ${nonce}`,
          description: "blocked execution takeover proof",
        },
      });
      assertStatus(task, 201, "POST /api/tasks (split brain)");
      const workspace = path.join(
        dirs.WORKSPACE_ROOT,
        `split-brain-${nonce}`
      );
      mkdirSync(workspace, { recursive: true });
      const dispatched = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId: task.json.task.id,
          brief: "block until the runner lease is replaced",
          workspacePath: workspace,
        },
      });
      assertStatus(dispatched, 201, "POST /api/dispatch (split brain)");

      await Promise.race([
        started,
        sleep(10_000).then(() => {
          throw new Error("old runner never began the blocked execution");
        }),
      ]);

      second = startInProcessRunner({
        baseUrl: backend.baseUrl,
        agentToken: state.agent,
        operatorToken: state.op,
        host,
        execute: async () => {
          executeCalls += 1;
          return {
            status: "failed",
            result: "successor must never replay an uncertain old execution",
          };
        },
        heartbeatMs: 20,
        pollMs: 20,
        onLog: () => undefined,
      });

      await Promise.race([
        cancelled,
        sleep(10_000).then(() => {
          throw new Error("old runner execution was not cancelled after takeover");
        }),
      ]);
      const job = await pollJobTerminal(
        api,
        dispatched.json.job.id,
        "split-brain job reconciled"
      );
      assert(job.status === "interrupted", `expected interrupted, got ${job.status}`);
      assert(
        /lease takeover/i.test(job.result ?? ""),
        "reconciled job should explain the uncertain prior execution"
      );
      assert(executeCalls === 1, `successor replayed the job (${executeCalls} executions)`);

      const agents = await api("GET", "/api/fleet/agents", {
        token: state.op,
      });
      const fake = agents.json.agents.find((agent) => agent.id === job.agentId);
      assert(fake?.status === "idle", "takeover reconciliation must release the agent");
      assert(!fake?.currentJobId, "takeover reconciliation must clear currentJobId");
    } finally {
      await first.stop();
      await second?.stop();
    }
  });

  // Start the REAL runner in-process only after the manual contention proof.
  runner = startInProcessRunner({
    baseUrl: backend.baseUrl,
    agentToken: state.agent,
    operatorToken: state.op,
    onLog: () => undefined,
  });

  // ── GROUP 4, the full loop: dispatch → claim → run → stream → edit → done ──
  await group("4. Full loop: queued→claimed→running→streamed→edited→done (fake vendor)", async () => {
    const task = await api("POST", "/api/tasks", {
      token: state.op,
      body: { title: `E2E loop ${nonce}`, description: "full-loop spine E2E via the fake vendor" },
    });
    assertStatus(task, 201, "POST /api/tasks");
    const taskId = task.json.task.id;
    state.taskA = taskId;

    const workspace = path.join(dirs.WORKSPACE_ROOT, `task-${nonce}-a`);
    mkdirSync(workspace, { recursive: true });
    state.workspaceA = workspace;

    // Dispatch to the fake vendor over HTTP (agent tier = the orchestrator).
    const dispatched = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId,
        brief: `Make a deterministic additive edit for E2E ${nonce}.`,
        workspacePath: workspace,
      },
    });
    assertStatus(dispatched, 201, "POST /api/dispatch (fake)");
    const jobId = dispatched.json.job.id;
    // The create response is authoritative for the initial state (pre-claim).
    assert(dispatched.json.job.status === "queued", "a fresh dispatch must be 'queued'");

    // The REAL runner claims the agent + the job and executes the fake driver.
    const job = await pollJobTerminal(api, jobId, "loop job reaches terminal");
    assert(job.status === "done", `expected terminal 'done', got '${job.status}': ${job.result}`);
    assert(job.exitCode === 0, `expected exitCode 0, got ${job.exitCode}`);
    // Claim evidence: the runner stamped the claimed fleet agent + start/end.
    assert(typeof job.agentId === "string" && job.agentId.length > 0, "job must record the claimed agentId");
    assert(job.startedAt, "job must have a startedAt (queued→running claim)");
    assert(job.endedAt, "job must have an endedAt (terminal write)");
    state.jobA = jobId;

    // Release evidence: the fake agent is idle again (runOne released it).
    await until(
      async () => {
        const agents = await api("GET", "/api/fleet/agents", { token: state.op });
        const fake = agents.json.agents.find((a) => a.id === job.agentId);
        assert(fake && fake.status === "idle", "fake agent not released to idle");
        assert(!fake.currentTaskId, "released agent must clear its currentTaskId");
      },
      { label: "fake agent released to idle" }
    );

    // StreamChunks recorded: the fake's progress events reached the brain.
    await until(
      async () => {
        const res = await api("GET", `/api/streams?taskId=${encodeURIComponent(taskId)}`, {
          token: state.agent,
        });
        assertStatus(res, 200, "GET /api/streams");
        const chunks = res.json.chunks;
        assert(Array.isArray(chunks) && chunks.length >= 3, `expected ≥3 stream chunks, got ${chunks?.length}`);
        const blob = chunks.map((c) => c.content).join("\n");
        assert(blob.includes("[fake]"), "stream chunks must carry the fake vendor output");
        assert(blob.includes(FAKE_ARTIFACT_FILENAME), "stream should mention the additive artifact");
      },
      { label: "stream chunks recorded" }
    );

    // The additive workspace edit exists, inside the allowlisted workspace.
    const artifact = path.join(workspace, FAKE_ARTIFACT_FILENAME);
    assert(existsSync(artifact), `additive artifact missing: ${artifact}`);
    const contents = readFileSync(artifact, "utf8");
    assert(contents.includes(taskId), "artifact must reference the task id");
    assert(contents.includes(FAKE_MEMORY_SENTINEL), "artifact must carry the deterministic marker");
  });

  await group("4b. REVIEW BLIND manual attestation lands the exact governed worktree", async () => {
    const repo = path.join(dirs.WORKSPACE_ROOT, `merge-${nonce}`);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init");
    git("config", "user.email", "muon-e2e@example.invalid");
    git("config", "user.name", "MUON E2E");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(
      path.join(repo, ".gitignore"),
      ".gitnexus/\n.muon/\n",
      "utf8"
    );
    writeFileSync(path.join(repo, "src", "base.ts"), "export const base = 1;\n");
    git("add", ".gitignore", "src/base.ts");
    git("commit", "-m", "initial");
    const baseline = git("rev-parse", "HEAD");
    mkdirSync(path.join(repo, ".gitnexus"), { recursive: true });
    writeFileSync(
      path.join(repo, ".gitnexus", "meta.json"),
      JSON.stringify({
        lastCommit: baseline,
        fileHashes: {
          ".gitignore": "indexed-gitignore",
          "src/base.ts": "indexed-base",
        },
      }),
      "utf8"
    );

    const harness = await api("PUT", "/api/harnesses/e2e-edit", {
      token: state.op,
      body: {
        name: "E2E edit",
        config: {
          description: "Hermetic worktree edit without host-side checks.",
          profileOverlay: {
            permissionMode: "default",
            sandbox: "workspace-write",
          },
          requires: { interactive: false, worktree: true },
        },
      },
    });
    assertStatus(harness, 200, "PUT /api/harnesses/e2e-edit");

    const task = await api("POST", "/api/tasks", {
      token: state.op,
      body: {
        title: `E2E governed merge ${nonce}`,
        description: "prove exact-artifact manual merge review",
        workspacePath: repo,
      },
    });
    assertStatus(task, 201, "POST /api/tasks (governed merge)");
    const taskId = task.json.task.id;

    const dispatched = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        harnessKey: "e2e-edit",
        taskId,
        brief: "Create one deterministic new file in the governed worktree.",
        workspacePath: repo,
      },
    });
    assertStatus(dispatched, 201, "POST /api/dispatch (governed merge)");
    const job = await pollJobTerminal(
      api,
      dispatched.json.job.id,
      "governed edit job terminal"
    );
    assert(job.status === "done", `governed edit failed: ${job.result}`);

    const worktree = locateTaskWorktreePath(repo, taskId);
    assert(
      existsSync(path.join(worktree, FAKE_ARTIFACT_FILENAME)),
      "fake worker did not edit the governed task worktree"
    );
    assert(
      !existsSync(path.join(repo, FAKE_ARTIFACT_FILENAME)),
      "worker edit leaked into the primary checkout before approval"
    );

    const filed = await api("POST", "/api/approvals", {
      token: state.op,
      body: {
        taskId,
        requestedBy: "e2e operator",
        kind: "merge",
        reason: "Land the reviewed governed worktree.",
      },
    });
    assertStatus(filed, 201, "POST /api/approvals (merge)");
    const approvalId = filed.json.approval.id;

    const review = await api(
      "GET",
      `/api/approvals/${approvalId}/review`,
      { token: state.op }
    );
    assertStatus(review, 200, "GET merge review");
    const certification = review.json.certification;
    assert(
      certification.status === "blocked" &&
        certification.blockCode === "review-blind",
      `new file should be REVIEW BLIND, got ${JSON.stringify(certification)}`
    );
    assert(
      certification.blindFiles.includes(FAKE_ARTIFACT_FILENAME),
      "review did not name the unindexed artifact"
    );

    const plainApprove = await api(
      "PATCH",
      `/api/approvals/${approvalId}`,
      {
        token: state.op,
        body: { status: "approved" },
      }
    );
    assertStatus(plainApprove, 409, "plain REVIEW BLIND approval");

    const approved = await api(
      "PATCH",
      `/api/approvals/${approvalId}`,
      {
        token: state.op,
        body: {
          status: "approved",
          decisionNotes: "Reviewed every blind file in the exact artifact.",
          manualReview: {
            acknowledged: true,
            artifactDigest: certification.artifactDigest,
            blindFiles: certification.blindFiles,
          },
        },
      }
    );
    assertStatus(approved, 200, "manual REVIEW BLIND approval");
    assert(
      approved.json.merge?.status === "merged",
      `governed merge did not land: ${JSON.stringify(approved.json.merge)}`
    );
    assert(
      approved.json.approval.reviewCertification?.method ===
        "operator-manual",
      "approval response did not persist the operator-manual verdict"
    );
    assert(
      existsSync(path.join(repo, FAKE_ARTIFACT_FILENAME)),
      "reviewed artifact did not land in the primary checkout"
    );

    const approvals = await api("GET", "/api/approvals", {
      token: state.op,
    });
    assertStatus(approvals, 200, "GET approvals after merge");
    const audited = approvals.json.approvals.find(
      (candidate) => candidate.id === approvalId
    );
    assert(
      audited?.reviewCertification?.artifactDigest ===
        certification.artifactDigest,
      "durable approval audit lost the reviewed artifact digest"
    );
  });

  // ── GROUP 5, the self-filling brain: review harness → captured memory ──────
  await group("5. Self-filling brain: review-harness capture surfaces via recall/search", async () => {
    const task = await api("POST", "/api/tasks", {
      token: state.op,
      body: { title: `E2E capture ${nonce}`, description: "review-harness memory capture E2E" },
    });
    assertStatus(task, 201, "POST /api/tasks (capture)");
    const taskId = task.json.task.id;
    state.taskB = taskId;

    const workspace = path.join(dirs.WORKSPACE_ROOT, `task-${nonce}-b`);
    mkdirSync(workspace, { recursive: true });

    const dispatched = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        harnessKey: "review",
        taskId,
        brief: `Review the change for E2E ${nonce}.`,
        workspacePath: workspace,
      },
    });
    assertStatus(dispatched, 201, "POST /api/dispatch (review)");
    const job = await pollJobTerminal(api, dispatched.json.job.id, "review job terminal");
    assert(job.status === "done", `review job should be 'done', got '${job.status}': ${job.result}`);

    // The real captureMemories path mined the fake's VERDICT: CONCERNS line into a
    // durable, UNCONFIRMED note anchored to this task. It surfaces via recall.
    const note = await until(
      async () => {
        const res = await api("GET", `/api/memory/recall?taskId=${encodeURIComponent(taskId)}`, {
          token: state.op,
        });
        assertStatus(res, 200, "GET /api/memory/recall?taskId");
        const found = (res.json.notes ?? []).find((n) =>
          n.text.toLowerCase().includes(FAKE_MEMORY_SENTINEL)
        );
        assert(found, "captured note did not surface via recall(taskId)");
        return found;
      },
      { label: "captured memory surfaces via recall" }
    );
    assert(note.confirmed === false, "an auto-captured note must start UNCONFIRMED");
    assert(/review raised concerns/i.test(note.text), "note should be the review-concern capture");
    state.capturedNoteId = note.id;

    // And it is lexically searchable by the stable marker word.
    await until(
      async () => {
        const res = await api("GET", `/api/memory/search?q=${encodeURIComponent(FAKE_MEMORY_SENTINEL)}`, {
          token: state.op,
        });
        assertStatus(res, 200, "GET /api/memory/search");
        assert(
          (res.json.notes ?? []).some((n) => n.id === state.capturedNoteId),
          "captured note not found via search"
        );
      },
      { label: "captured memory searchable" }
    );
  });

  // ── GROUP 6, invariants hold under the fake seam ───────────────────────────
  await group("6. Invariants: two-token boundary, P3-B sandbox, vendor isolation, steer/interrupt", async () => {
    // Two-token: an agent-tier confirm on the captured note is 403; operator 200.
    assert(state.capturedNoteId, "no captured note carried from group 5");
    const agentConfirm = await api("PATCH", `/api/memory/${state.capturedNoteId}`, {
      token: state.agent,
      body: { confirmed: true },
    });
    assertStatus(agentConfirm, 403, "agent PATCH {confirmed:true} must be 403 (self-confirm closed)");
    const opConfirm = await api("PATCH", `/api/memory/${state.capturedNoteId}`, {
      token: state.op,
      body: { confirmed: true },
    });
    assertStatus(opConfirm, 200, "operator PATCH {confirmed:true} must be 200");
    assert(opConfirm.json.note.confirmed === true, "operator confirm did not take effect");

    // P3-B / S1 workspace containment: a traversal / absolute-escape workspacePath
    // is rejected 400 BEFORE any job is enqueued, even for the fake vendor.
    const escape = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "escape attempt",
        workspacePath: "/etc/muon-should-not-run",
      },
    });
    assertStatus(escape, 400, "absolute-escape workspacePath must be 400");
    const traversal = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "traversal attempt",
        workspacePath: path.join(dirs.WORKSPACE_ROOT, "..", "..", "..", "..", "etc"),
      },
    });
    assertStatus(traversal, 400, "traversal workspacePath must be 400");

    // Vendor isolation: a REAL claude-code dispatch is UNAFFECTED by the fake seam
    //, the runner fails it on readiness (no CLI on the empty PATH) and it NEVER
    // routes to the fake adapter (no artifact is written).
    const realWorkspace = path.join(dirs.WORKSPACE_ROOT, `task-${nonce}-real`);
    mkdirSync(realWorkspace, { recursive: true });
    const realTask = await api("POST", "/api/tasks", {
      token: state.op,
      body: { title: `E2E real vendor ${nonce}`, description: "real vendor isolation check" },
    });
    const realDispatch = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: "claude-code",
        kind: "oneshot",
        taskId: realTask.json.task.id,
        brief: "this must not touch the fake vendor",
        workspacePath: realWorkspace,
      },
    });
    assertStatus(realDispatch, 201, "POST /api/dispatch (claude-code)");
    const realJob = await pollJobTerminal(api, realDispatch.json.job.id, "claude-code job terminal");
    assert(realJob.status === "failed", `claude-code should fail (not installed), got '${realJob.status}'`);
    assert(/claude-code/i.test(realJob.result ?? ""), "failure should name the claude-code vendor");
    assert(
      !existsSync(path.join(realWorkspace, FAKE_ARTIFACT_FILENAME)),
      "the fake adapter must NOT have run for a real vendor dispatch"
    );

    // An unknown vendor is rejected 400 (the allowlist is closed).
    const unknown = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: "totally-not-a-vendor",
        kind: "oneshot",
        taskId: state.taskA,
        brief: "nope",
      },
    });
    assertStatus(unknown, 400, "unknown vendor must be 400");

    // Agent-tier control is job-capability-bound: a shared bearer alone cannot
    // steer an arbitrary job. Operator authority does not invent a transport
    // capability the selected vendor lacks: the fake driver refuses steering
    // with an actionable alternative and persists no undeliverable message.
    const unboundSteer = await api("POST", `/api/dispatch/${state.jobA}/steer`, {
      token: state.agent,
      body: { message: `steer-${nonce}` },
    });
    assertStatus(unboundSteer, 403, "agent steer without job capability");
    const steer = await api("POST", `/api/dispatch/${state.jobA}/steer`, {
      token: state.op,
      body: { message: `steer-${nonce}` },
    });
    assertStatus(steer, 400, "POST /api/dispatch/:id/steer for unsupported vendor");
    assert(
      /cannot accept a live steer/i.test(steer.json?.message ?? "") &&
        /interrupt|re-dispatch/i.test(steer.json?.message ?? ""),
      `unsupported steer should explain the alternative, got: ${steer.text}`
    );
    const steered = await api("GET", `/api/dispatch/${state.jobA}`, {
      token: state.op,
    });
    assertStatus(steered, 200, "GET steered dispatch");
    assert(
      !steered.json.job.steerMessages.includes(`steer-${nonce}`),
      "an undeliverable steer message must not be persisted"
    );

    // Stop the runner so cancellation is deterministic, enqueue a fresh job,
    // and prove the operator panic path fences it before any vendor launch.
    await runner.stop();
    runner = null;
    try {
      const interruptTask = await api("POST", "/api/tasks", {
        token: state.op,
        body: {
          title: `E2E interrupt ${nonce}`,
          description: "queued cancellation propagation proof",
        },
      });
      assertStatus(interruptTask, 201, "POST /api/tasks (interrupt)");
      const interruptWorkspace = path.join(
        dirs.WORKSPACE_ROOT,
        `interrupt-${nonce}`
      );
      mkdirSync(interruptWorkspace, { recursive: true });
      const queued = await api("POST", "/api/dispatch", {
        token: state.agent,
        body: {
          vendor: FAKE_VENDOR_KEY,
          kind: "oneshot",
          taskId: interruptTask.json.task.id,
          brief: "must be interrupted before launch",
          workspacePath: interruptWorkspace,
        },
      });
      assertStatus(queued, 201, "POST /api/dispatch (interrupt)");
      const interrupt = await api(
        "POST",
        `/api/dispatch/${queued.json.job.id}/interrupt`,
        { token: state.op }
      );
      assertStatus(interrupt, 200, "POST /api/dispatch/:id/interrupt");
      assert(
        interrupt.json.job.interruptRequested === true &&
          interrupt.json.job.status === "interrupted",
        "queued interrupt did not become terminal before launch"
      );
    } finally {
      runner = startInProcessRunner({
        baseUrl: backend.baseUrl,
        agentToken: state.agent,
        operatorToken: state.op,
        onLog: () => undefined,
      });
    }
  });

  // ── GROUP 7, ADR-0013 v2: vendor-native actions, ENFORCED at dispatch ───────
  await group("7. Vendor action surface: guards ENFORCED at the route + argv threaded to spawn", async () => {
    const workspace = path.join(dirs.WORKSPACE_ROOT, `task-${nonce}-action`);
    mkdirSync(workspace, { recursive: true });

    // GUARD, --strict-mcp-config is REFUSED (400); the governed brain is never
    // evicted. Resolved against the claude-code descriptor; runs on the fake lane.
    const strict = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "strict",
        action: "strict-mcp-config",
        actionVendor: "claude-code",
      },
    });
    assertStatus(strict, 400, "strict-mcp-config must be refused (400)");

    // GUARD, one-shot full-auto from the AGENT tier WITHOUT a gate → 403.
    const ungated = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "full-auto ungated",
        action: "full-auto",
        actionVendor: "claude-code",
      },
    });
    assertStatus(ungated, 403, "agent-tier one-shot full-auto without a gate must be 403");

    // GUARD, with a REAL operator-approved, single-use gate → dispatches, and the
    // compiled profile carries permissionMode:"full-auto". File the gate (agent),
    // approve it (operator), then redeem it in the dispatch (agent).
    const filed = await api("POST", "/api/approvals", {
      token: state.agent,
      body: {
        taskId: state.taskA,
        requestedBy: "orchestrator",
        kind: "gate",
        reason: "run full-auto",
        // The gate binds the EXECUTION vendor (the lane that runs = fake), not the
        // descriptor vendor, the operator approves the vendor that actually executes.
        gateTag: dispatchActionGateTag(FAKE_VENDOR_KEY, "full-auto"),
      },
    });
    assertStatus(filed, 201, "POST /api/approvals (dispatch gate)");
    const gateId = filed.json.approval.id;
    const approved = await api("PATCH", `/api/approvals/${gateId}`, {
      token: state.op,
      body: { status: "approved" },
    });
    assertStatus(approved, 200, "operator approves the dispatch gate");

    const gated = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "full-auto gated",
        workspacePath: workspace,
        action: "full-auto",
        actionVendor: "claude-code",
        gateApprovalId: gateId,
      },
    });
    assertStatus(gated, 201, "agent-tier full-auto WITH a redeemed gate must dispatch (201)");
    assert(
      gated.json.job.actionProfilePatch?.permissionMode === "full-auto",
      "the persisted profile patch must carry permissionMode:full-auto"
    );
    const gatedJob = await pollJobTerminal(api, gated.json.job.id, "full-auto job terminal");
    assert(gatedJob.status === "done", `full-auto job should be 'done', got '${gatedJob.status}'`);

    // REPLAY of the same gate → 403 (single-use).
    const replay = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "replay",
        action: "full-auto",
        actionVendor: "claude-code",
        gateApprovalId: gateId,
      },
    });
    assertStatus(replay, 403, "a replayed single-use gate must be 403");

    // SUBCOMMAND, ultrareview: the resolved argv (claude ultrareview <t> --json)
    // is persisted AND reaches the fake adapter's spawn (captured in-process).
    const uvWorkspace = path.join(dirs.WORKSPACE_ROOT, `task-${nonce}-uv`);
    mkdirSync(uvWorkspace, { recursive: true });
    const uv = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "ultrareview",
        workspacePath: uvWorkspace,
        action: "ultrareview",
        actionVendor: "claude-code",
        target: "src/app.ts",
      },
    });
    assertStatus(uv, 201, "ultrareview dispatch (201)");
    assert(
      JSON.stringify(uv.json.job.actionArgvOverride) ===
        JSON.stringify({ command: "claude", args: ["ultrareview", "src/app.ts", "--json"] }),
      `ultrareview argv override wrong: ${JSON.stringify(uv.json.job.actionArgvOverride)}`
    );
    await pollJobTerminal(api, uv.json.job.id, "ultrareview job terminal");
    // The runner is in-process, so the fake adapter's capture is observable: the
    // resolved subcommand argv actually reached (simulated) spawn.
    await until(
      async () => {
        const spawned = getFakeInvocations().find(
          (inv) => inv.command === "claude" && inv.args[0] === "ultrareview"
        );
        assert(spawned, "the ultrareview argv never reached the fake adapter's spawn");
        assert(
          spawned.args.join(" ") === "ultrareview src/app.ts --json",
          `spawned argv wrong: ${spawned.args.join(" ")}`
        );
        // Belt-and-suspenders: no guarded flag ever reaches spawn.
        assert(
          !spawned.args.some((a) => a.startsWith("--strict-mcp-config")),
          "a guarded flag reached spawn"
        );
      },
      { label: "ultrareview argv reached spawn" }
    );

    // A '-'-prefixed subcommand target is rejected (400).
    const evil = await api("POST", "/api/dispatch", {
      token: state.agent,
      body: {
        vendor: FAKE_VENDOR_KEY,
        kind: "oneshot",
        taskId: state.taskA,
        brief: "evil",
        action: "ultrareview",
        actionVendor: "claude-code",
        target: "--evil",
      },
    });
    assertStatus(evil, 400, "a '-'-prefixed ultrareview target must be 400");
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`\nFATAL: ${error.message}`);
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
console.log("\n──────────── E2E full-loop summary ────────────");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log("───────────────────────────────────────────────");
console.log(`${results.length - failed.length}/${results.length} scenario groups passed.`);

if (failed.length > 0 || exitCode !== 0) {
  console.error(`\nE2E FULL-LOOP FAILED (${failed.length} group(s) failed).`);
  process.exit(1);
}
console.log("\nE2E FULL-LOOP PASSED, the dispatch→runner→execute→stream→capture spine is wired.");
process.exit(0);
