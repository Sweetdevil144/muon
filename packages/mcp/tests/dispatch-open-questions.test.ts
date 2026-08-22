import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { createOrchestratorToolDefinitions } from "../src/orchestrator-tools.js";

// A13 — an orchestrator must not be able to miss a human-blocking packet.
//
// The failure this closes: a child files `question_ask`, nothing stops (ADR-0043
// is powerless by design), and every status surface the coordinator reads shows
// `running` with no hint that a person is now in the loop. The two rules that
// shape these tests are (1) the join happens ONCE per call, not per job row,
// and (2) a failed question read degrades LOUDLY — an omitted field must never
// be readable as "nothing is waiting".

const JOB = {
  id: "job-child",
  kind: "oneshot",
  vendor: "codex",
  role: "implementer",
  taskId: "task-1",
  status: "running",
  agentId: "codex-1",
  exitCode: null,
  interruptRequested: false,
  result: null,
  chatId: "chat-1",
};

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    getDispatchJob: vi.fn(async () => JOB),
    listDispatchJobs: vi.fn(async () => [JOB]),
    listLoopRuns: vi.fn(async () => []),
    getFleet: vi.fn(async () => ({
      counts: { codex: 1 },
      agents: [
        {
          id: "codex-1",
          vendor: "codex",
          name: "codex-1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-1",
          currentJobId: "job-child",
          sessionId: "sess-1",
        },
      ],
    })),
    getVendorReadiness: vi.fn(async () => []),
    listCrewOpenQuestions: vi.fn(async () => ({
      questions: [
        {
          id: "q-1",
          taskId: "task-1",
          askedAt: new Date(Date.now() - 90_000).toISOString(),
        },
      ],
      truncated: false,
    })),
  };
  return { ...base, ...overrides } as unknown as MuonApiClient;
}

function tool(client: MuonApiClient, name: string) {
  const found = createOrchestratorToolDefinitions(client, {
    jobId: "job-root",
    delegationToken: "root-job-token",
    chatId: "chat-1",
    chatTaskId: "task-shadow",
    apiBase: "http://localhost:4000",
  }).find((entry) => entry.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function body(client: MuonApiClient, name: string, args = {}) {
  const result = await tool(client, name).handler(args);
  return JSON.parse(result.content[0]!.text as string);
}

describe("A13: dispatch_status surfaces the crew's open questions", () => {
  it("joins the open question onto the job and names it as the blocked reason", async () => {
    const payload = await body(makeClient(), "dispatch_status", {
      jobId: "job-child",
    });
    expect(payload.job.openQuestions).toEqual([
      { id: "q-1", ageMs: expect.any(Number) },
    ]);
    expect(payload.job.openQuestions[0].ageMs).toBeGreaterThan(0);
    expect(payload.job.blockedReason).toBe(
      "waiting on a human answer to question q-1"
    );
  });

  it("puts the human-blocking action FIRST, ahead of the loop's own advice", async () => {
    // A job waiting on a person is not unblocked by tailing its stream; if the
    // loop advice came first the coordinator would act on the wrong thing.
    const payload = await body(makeClient(), "dispatch_status", {
      jobId: "job-child",
    });
    expect(payload._muon.nextActions[0]).toMatch(/waiting on a human answer/);
    expect(payload._muon.nextActions[0]).toMatch(/muon questions answer/);
  });

  it("reads the questions ONCE for a whole roster, not once per job", async () => {
    const client = makeClient({
      listDispatchJobs: vi.fn(async () => [
        JOB,
        { ...JOB, id: "job-b", taskId: "task-2" },
        { ...JOB, id: "job-c", taskId: "task-3" },
      ]),
    });
    const payload = await body(client, "dispatch_status", {});
    expect(client.listCrewOpenQuestions).toHaveBeenCalledTimes(1);
    expect(payload.jobs).toHaveLength(3);
    expect(payload.jobs[0].blockedReason).toBe(
      "waiting on a human answer to question q-1"
    );
    // A job whose task has nothing open says so explicitly with an empty list.
    expect(payload.jobs[1].openQuestions).toEqual([]);
    expect(payload.jobs[1].blockedReason).toBeUndefined();
    expect(payload._muon.nextActions).toEqual([
      "job-child: waiting on a human answer to question q-1",
    ]);
  });

  it("omits the field and says WHY when the question read fails — never a silent empty", async () => {
    const client = makeClient({
      listCrewOpenQuestions: vi.fn(async () => {
        throw new Error("403 Forbidden");
      }),
    });
    const result = await tool(client, "dispatch_status").handler({
      jobId: "job-child",
    });
    // The status call still answers: a missing question read must not take the
    // whole status surface down with it.
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload.job.openQuestions).toBeUndefined();
    expect(payload.job.blockedReason).toBeUndefined();
    // …but it is LOUD about the difference between "none" and "could not look".
    expect(payload.questionEvidence.status).toBe("unavailable");
    expect(payload.questionEvidence.reason).toMatch(/403/);
    expect(payload.questionEvidence.action).toMatch(/muon questions list/);
  });

  it("degrades the roster read the same way, and warns against reporting the crew unblocked", async () => {
    const client = makeClient({
      listCrewOpenQuestions: vi.fn(async () => {
        throw new Error("brain unreachable");
      }),
    });
    const payload = await body(client, "dispatch_status", {});
    expect(payload.jobs[0].openQuestions).toBeUndefined();
    expect(payload._muon.degradation.active).toBe(true);
    expect(payload._muon.degradation.action).toMatch(
      /do not report the crew as unblocked/i
    );
  });

  it("treats an older-than-the-window read as a degradation, not as an answer", async () => {
    const client = makeClient({
      listCrewOpenQuestions: vi.fn(async () => ({
        questions: [],
        truncated: true,
      })),
    });
    const payload = await body(client, "dispatch_status", {});
    expect(payload._muon.degradation.active).toBe(true);
    expect(payload._muon.degradation.reason).toMatch(/hit its own bound/);
  });

  it("survives a client that has no crew-question read at all", async () => {
    // An older backend/client pairing must degrade, never throw.
    const client = makeClient({ listCrewOpenQuestions: undefined });
    const payload = await body(client, "dispatch_status", {
      jobId: "job-child",
    });
    expect(payload.questionEvidence.status).toBe("unavailable");
    expect(payload.job.openQuestions).toBeUndefined();
  });
});

describe("A13: fleet_status names the seat that is waiting on a person", () => {
  it("appends one line per live seat, naming job id and question id", async () => {
    const payload = await body(makeClient(), "fleet_status");
    expect(payload._muon.nextActions[0]).toContain("job-child");
    expect(payload._muon.nextActions[0]).toContain("q-1");
    expect(payload._muon.nextActions[0]).toMatch(/Only a human can clear it/);
    expect(payload.questionEvidence.status).toBe("available");
  });

  it("says nothing about a seat whose task has no open question", async () => {
    const client = makeClient({
      listCrewOpenQuestions: vi.fn(async () => ({
        questions: [
          {
            id: "q-elsewhere",
            taskId: "task-other",
            askedAt: new Date().toISOString(),
          },
        ],
        truncated: false,
      })),
    });
    const payload = await body(client, "fleet_status");
    expect(JSON.stringify(payload._muon.nextActions)).not.toContain(
      "q-elsewhere"
    );
  });

  it("degrades loudly rather than reporting an unblocked fleet it could not check", async () => {
    const client = makeClient({
      listCrewOpenQuestions: vi.fn(async () => {
        throw new Error("brain unreachable");
      }),
    });
    const payload = await body(client, "fleet_status");
    expect(payload.questionEvidence.status).toBe("unavailable");
    expect(payload._muon.degradation.active).toBe(true);
  });
});

// ── H2 + H10 on the same summary: degrade named, slug computed ───────────────

describe("H2/H10: dispatchSummary carries the packet contract and the slug", () => {
  const degradedPacket = {
    schemaVersion: 2,
    taskGoal: "fix the thing",
    whatChanged: "changed it",
    whatFailed: "nothing",
    nextLaneRequest: "review",
    commandsRun: [],
    checksStatus: [],
    openQuestions: [],
    provenance: { lane: "codex", createdAt: "2026-08-17T00:00:00.000Z" },
    degraded: { flag: true, reasons: ["no_check_evidence"] },
  };

  it("a done job with a typed_degraded packet says so and is not ship-ready", async () => {
    const client = makeClient({
      getDispatchJob: vi.fn(async () => ({
        ...JOB,
        status: "done",
        packetJson: degradedPacket,
      })),
    });
    const payload = await body(client, "dispatch_status", { jobId: "job-child" });
    expect(payload.job.packetContract).toBe("typed_degraded");
    // The degrade rides the STATUS surface itself, not only handoff_read.
    expect(payload.job.statusNote).toMatch(/NOT ship-ready/);
    expect(payload.job.statusNote).toMatch(/typed_degraded/);
  });

  it("a clean typed packet carries its contract with no alarm note", async () => {
    const client = makeClient({
      getDispatchJob: vi.fn(async () => ({
        ...JOB,
        status: "done",
        packetJson: { ...degradedPacket, degraded: { flag: false, reasons: [] } },
      })),
    });
    const payload = await body(client, "dispatch_status", { jobId: "job-child" });
    expect(payload.job.packetContract).toBe("typed");
    expect(payload.job.statusNote).toBeUndefined();
  });

  it("every summary names the job's deterministic slug beside the id", async () => {
    const payload = await body(makeClient(), "dispatch_status", {
      jobId: "job-child",
    });
    expect(payload.job.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    expect(payload.job.jobId).toBe("job-child");
  });
});

// ── A12: the dispatch tool passes the packet citation through to the route ───

describe("A12: dispatch passes sourcePacketId to the delegate route", () => {
  it("forwards a trimmed citation; the route's guard is the refusal point", async () => {
    const delegateDispatch = vi.fn(async () => ({ ...JOB, id: "job-new" }));
    const client = makeClient({
      delegateDispatch,
      listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
      getTaskDetail: vi.fn(async () => undefined),
      listTasks: vi.fn(async () => []),
    });
    await tool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief:
        "ROLE: implementer\nOWNED SCOPE: src/\nGOAL: repair per the packet\nMODE: implement\nCONTEXT: packet handoff-1\nGRAPH DISCIPLINE: code_query first\nCOORDINATION: claim src/\nDELIVERABLES: fix\nCHECKS: npm test\nAUTHORITY: no commit\nSTOP CONDITION: done\nFINAL REPORT: sections",
      sourcePacketId: "  handoff-1  ",
    });
    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-root",
      expect.objectContaining({ sourcePacketId: "handoff-1" }),
      "root-job-token"
    );
  });
});
