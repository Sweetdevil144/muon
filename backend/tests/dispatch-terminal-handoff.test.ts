import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FAKE_VENDOR_KEY } from "@muon/adapters";
import {
  buildHandoffPacket,
  parseWorkerFinalReport,
  parseWorkerMemoryProposals,
} from "@muon/core";
import {
  HANDOFF_DEGRADATION,
  handoffPacketSchema,
  type HandoffPacket,
} from "@muon/protocol";

// ── THE HANDOFF THAT WAS WRITTEN TO A TABLE NOBODY READS ─────────────────────
//
// In the founder's mission both children finished clean, both left a full
// schemaVersion-2 packet on `DispatchJob.packetJson` (6 980 and 27 438 bytes,
// with diffVerified, a diffHash, changedFiles, uncertainties, memory
// proposals), and the `Handoff` table held ZERO rows — it has never had one,
// because its only writer is `POST /api/tasks/:taskId/handoffs` and the
// dispatch path never called it. `handoff_read` and `dispatch_status`'s
// handoffCount both read `Task.handoffs`, so the coordinator was told "typed
// handoff packets were absent for both children (handoffCount 0)", fell back to
// truncated stream prose, and concluded a test edit "did NOT land … not
// verified" — while the unreachable packet said diffVerified with a hash.
//
// These tests pin the join: one writer (the terminal transaction), one reader
// (the Handoff table), and an ABSENCE that is a record rather than a gap.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

const OPERATOR = "operator-token-terminal-handoff";
const AGENT = "agent-token-terminal-handoff";
const HOST = "desktop-mac";
const LEASE = `lease-${"a".repeat(58)}`;
const WORKSPACE = process.cwd();
const TASK_ID = "task-terminal-handoff";
const CHAT_ID = "chat-terminal-handoff";
const ROOT_JOB_ID = "job-coordinator-root";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** The exact ten-label suffix WORKER_PREAMBLE asks a worker to end with. */
const CANONICAL_FINAL_REPORT = [
  "GOAL: add a --json flag to `muon crew coord`",
  "CHANGED: apps/cli/src/commands/crew.ts now registers --json",
  "FAILED: nothing",
  "COMMANDS RUN: npm test --prefix apps/cli",
  "CHECKS: crew coord --json prints the snapshot",
  "CHANGED FILES: apps/cli/tests/crew.test.ts",
  "OPEN QUESTIONS: should the JSON shape be versioned?",
  "UNCERTAINTIES: the isolated worktree could not resolve @muon/* packages",
  "NEXT ACTION: land the strengthened test and re-certify",
  "MEMORY PROPOSALS:",
  "- [convention] the CLI --json contract has exactly two top-level keys",
].join("\n");

const GARBAGE_FINAL_MESSAGE =
  "All done! I poked around a bit and things look fine to me. " +
  "Let me know if you want anything else — happy to keep going.";

type Db = typeof import("../src/lib/db.js");

let app: FastifyInstance;
let prisma: Db["prisma"];
let dataDir: string;

/**
 * Build the packet EXACTLY the way `buildTerminalPacket` does in the runner:
 * parse the worker's closing text, keep it on the packet either way, and name
 * the absence when the ten labels are not there.
 */
function packetFor(workerOutput: string): HandoffPacket {
  const report = parseWorkerFinalReport(workerOutput);
  return buildHandoffPacket({
    laneKey: FAKE_VENDOR_KEY,
    taskId: TASK_ID,
    brief: "ROLE: implementer\nOWNED SCOPE: apps/cli/**",
    outcome: { ok: true, summary: workerOutput },
    events: [],
    openQuestions: report?.openQuestions,
    uncertainties: report?.uncertainties,
    memoryProposals:
      report?.memoryProposals ?? parseWorkerMemoryProposals(workerOutput),
    finalMessage: workerOutput,
    ...(report === undefined
      ? { degradedReasons: [HANDOFF_DEGRADATION.noWorkerReport] }
      : {}),
    recommendedNextAction: report?.nextAction ?? `Continue task '${TASK_ID}'.`,
  });
}

async function createChildJob(id: string): Promise<string> {
  await prisma.dispatchJob.create({
    data: {
      id,
      kind: "loop",
      vendor: FAKE_VENDOR_KEY,
      taskId: TASK_ID,
      brief: "bounded child work",
      workspacePath: WORKSPACE,
      status: "running",
      host: HOST,
      runnerLeaseHash: hashLease(LEASE),
      startedAt: new Date(),
      chatId: CHAT_ID,
      parentJobId: ROOT_JOB_ID,
      rootJobId: ROOT_JOB_ID,
      dispatchedBy: "orchestrator",
    },
  });
  return id;
}

async function commitTerminal(
  jobId: string,
  body: Record<string, unknown>
) {
  return app.inject({
    method: "PATCH",
    url: `/api/dispatch/${jobId}`,
    headers: auth(AGENT),
    payload: { status: "done", host: HOST, leaseToken: LEASE, ...body },
  });
}

/** Read the task the way `handoff_read` does: through the real HTTP route. */
async function readHandoffs(taskId = TASK_ID) {
  const res = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`,
    headers: auth(OPERATOR),
  });
  expect(res.statusCode).toBe(200);
  return res.json().task.handoffs as {
    id: string;
    status: string;
    packetTitle: string;
    packetBody: string;
    packetJson: unknown;
    fromLane: { key: string };
    toLane: { key: string };
  }[];
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-terminal-handoff-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dataDir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  const { buildApp } = await import("../src/app.js");
  app = buildApp();

  await prisma.lane.createMany({
    data: [
      {
        id: "lane-fake",
        key: FAKE_VENDOR_KEY,
        name: "Fake Vendor (dev/test)",
        provider: "muon-fake",
        role: "worker",
      },
      {
        id: "lane-claude-code",
        key: "claude-code",
        name: "Claude Code",
        provider: "anthropic",
        role: "peer",
      },
    ],
  });
  await prisma.task.create({
    data: {
      id: TASK_ID,
      title: "Add a --json flag to muon crew coord",
      description: "The founder's mission, reduced to one child task.",
      status: "in_progress",
      workspacePath: WORKSPACE,
    },
  });
});

beforeEach(async () => {
  await prisma.handoff.deleteMany({});
  await prisma.dispatchJob.deleteMany({});
  await prisma.runner.deleteMany({});
  await prisma.runner.create({
    data: { host: HOST, leaseHash: hashLease(LEASE), status: "online" },
  });
  // The mission's coordinator turn, so a child can name who it hands back to.
  await prisma.dispatchJob.create({
    data: {
      id: ROOT_JOB_ID,
      kind: "session",
      vendor: "claude-code",
      taskId: TASK_ID,
      brief: "coordinate the crew",
      status: "running",
      host: HOST,
      runnerLeaseHash: hashLease(LEASE),
      startedAt: new Date(),
      chatId: CHAT_ID,
      dispatchedBy: "orchestrator",
    },
  });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a terminal child files the handoff its coordinator reads", () => {
  it("turns a canonical final report into a typed packet handoff_read can return", async () => {
    const jobId = await createChildJob("job-child-reported");
    const packet = packetFor(
      `[fake] engaged\n[fake] wrote the flag\n\n${CANONICAL_FINAL_REPORT}`
    );

    const res = await commitTerminal(jobId, { exitCode: 0, packet });
    expect(res.statusCode).toBe(200);

    const handoffs = await readHandoffs();
    // THE REGRESSION: this list was empty for every dispatched child that has
    // ever run through MUON.
    expect(handoffs).toHaveLength(1);
    const filed = handoffs[0]!;
    expect(filed.fromLane.key).toBe(FAKE_VENDOR_KEY);
    // Handed back to the coordinator that dispatched it.
    expect(filed.toLane.key).toBe("claude-code");
    // Not `pending`: a filed record is not a queue item awaiting pickup.
    expect(filed.status).toBe("filed");

    // What `handoff_read` parses out of the row, field for field.
    const parsed = handoffPacketSchema.safeParse(filed.packetJson);
    expect(parsed.success).toBe(true);
    const typed = parsed.data!;
    expect(typed.schemaVersion).toBe(2);
    expect(typed.degraded.reasons).not.toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
    expect(typed.openQuestions.join(" ")).toContain("versioned");
    expect(typed.uncertainties.join(" ")).toContain("@muon/*");
    expect(typed.recommendedNextAction).toContain("re-certify");
    expect(typed.memoryProposals[0]!.kind).toBe("convention");
    // The worker's own closing words, durably, on the packet — the copy that
    // survives whatever the live stream did with its bounds.
    expect(typed.finalMessage).toContain("MEMORY PROPOSALS");
  });

  it("files a packet MARKED unparseable, with the raw text, when the report is garbage", async () => {
    const jobId = await createChildJob("job-child-garbage");
    const packet = packetFor(GARBAGE_FINAL_MESSAGE);

    expect(await commitTerminal(jobId, { exitCode: 0, packet })).toMatchObject({
      statusCode: 200,
    });

    const handoffs = await readHandoffs();
    expect(handoffs).toHaveLength(1);
    const typed = handoffPacketSchema.parse(handoffs[0]!.packetJson);

    // Marked, not absent — absence is what made a coordinator guess.
    expect(typed.degraded.flag).toBe(true);
    expect(typed.degraded.reasons).toContain(
      HANDOFF_DEGRADATION.noWorkerReport
    );
    // And the raw text is preserved, so a human can see WHY nothing parsed.
    expect(typed.finalMessage).toContain("happy to keep going");
    expect(handoffs[0]!.packetBody).toContain("NO typed report parsed");
  });

  it("records the ABSENCE of a packet rather than filing nothing", async () => {
    const jobId = await createChildJob("job-child-no-packet");

    const res = await commitTerminal(jobId, {
      status: "interrupted",
      result: "runner authority was lost during vendor execution",
    });
    expect(res.statusCode).toBe(200);

    const handoffs = await readHandoffs();
    expect(handoffs).toHaveLength(1);
    // `handoff_read` reports this row as `prose_only`; what it must never be is
    // missing, which reads identically to "no work was done".
    expect(handoffs[0]!.packetJson).toBeNull();
    expect(handoffs[0]!.packetBody).toContain("No typed handoff packet");
    expect(handoffs[0]!.packetBody).toContain("interrupted");
  });

  it("files exactly once, even when a fenced runner replays its terminal write", async () => {
    const jobId = await createChildJob("job-child-replay");
    const packet = packetFor(CANONICAL_FINAL_REPORT);

    const first = await commitTerminal(jobId, { exitCode: 0, result: "ok", packet });
    const replay = await commitTerminal(jobId, { exitCode: 0, result: "ok", packet });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(await readHandoffs()).toHaveLength(1);
  });

  it("does NOT file for the mission's own coordinator turn", async () => {
    // One row per coordinator turn would push a real child's packet out of
    // handoff_read's bounded window — the exact failure being fixed.
    const res = await commitTerminal(ROOT_JOB_ID, {
      exitCode: 0,
      result: "FINAL MISSION SUMMARY: …",
      packet: packetFor(CANONICAL_FINAL_REPORT),
    });

    expect(res.statusCode).toBe(200);
    expect(await readHandoffs()).toHaveLength(0);
  });

  it("never lets the handoff record cost a job its terminal status", async () => {
    // A job whose task row does not exist: the Handoff foreign key would
    // reject, and a rejection inside the terminal transaction would strand a
    // finished job as `running` forever. The record is never worth that.
    await prisma.dispatchJob.create({
      data: {
        id: "job-child-orphan",
        kind: "loop",
        vendor: FAKE_VENDOR_KEY,
        taskId: "task-that-does-not-exist",
        brief: "orphaned child",
        status: "running",
        host: HOST,
        runnerLeaseHash: hashLease(LEASE),
        startedAt: new Date(),
        chatId: CHAT_ID,
        parentJobId: ROOT_JOB_ID,
        rootJobId: ROOT_JOB_ID,
        dispatchedBy: "orchestrator",
      },
    });

    const res = await commitTerminal("job-child-orphan", {
      exitCode: 0,
      packet: packetFor(CANONICAL_FINAL_REPORT),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("done");
  });
});
