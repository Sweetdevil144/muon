import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeLineageDigest, type MuonApiClient } from "@muon/client";
import { registerBundleCommand } from "../src/commands/bundle.js";

// Deterministic, fully mocked client (all read endpoints). The command must
// write ONE JSON file, print its path + a summary, and never leak a token.

const SECRET = "sk-live-DEADBEEFdeadbeef00";

function fakeClient(): MuonApiClient {
  const rootJob = {
    id: "job-root",
    kind: "auto",
    vendor: "claude-code",
    taskId: "task-1",
    brief: `do the work; MUON_API_TOKEN=${SECRET}`,
    status: "done",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    capabilityMode: "orchestrator",
    rootJobId: "job-root",
    chatId: "chat-1",
    createdAt: "2026-07-17T10:00:00.000Z",
    actionProfilePatch: { model: "opus-4.8" },
  };
  return {
    getDispatchJob: vi.fn(async () => rootJob),
    getDispatchBudget: vi.fn(async () => ({
      jobId: "job-root",
      capabilityMode: "orchestrator",
      rootWallMs: 600000,
      maxDescendantWallMs: 4800000,
      poolMs: 4800000,
      reservedMs: 0,
      consumedMs: 120000,
      remainingMs: 4680000,
      deadlineAt: null,
      childrenIssued: 0,
      maxChildren: 8,
      descendantsIssued: 0,
      maxDescendants: 10,
      depth: 0,
      maxDepth: 3,
      children: [],
    })),
    listDispatchJobs: vi.fn(async () => [rootJob]),
    getChat: vi.fn(async () => ({
      id: "chat-1",
      title: "Ship auth",
      workspacePath: "/repo",
      status: "active",
      createdAt: "2026-07-17T09:00:00.000Z",
      updatedAt: "2026-07-17T11:00:00.000Z",
    })),
    listApprovals: vi.fn(async () => [
      {
        id: "approval-1",
        taskId: "task-1",
        requestedBy: "claude-code",
        kind: "merge",
        reason: "Merge the branch",
        status: "approved",
      },
    ]),
    listStreamChunks: vi.fn(async () => [
      {
        seq: 1,
        taskId: "task-1",
        laneId: "lane-1",
        kind: "milestone",
        content: "reached checkpoint",
        timestamp: "2026-07-17T11:05:00.000Z",
      },
      {
        seq: 2,
        taskId: "task-1",
        laneId: "lane-1",
        kind: "output",
        content: "raw stdout",
        timestamp: "2026-07-17T11:06:00.000Z",
      },
    ]),
    health: vi.fn(async () => ({ status: "ok" })),
    getVendorReadiness: vi.fn(async () => []),
    getRunner: vi.fn(async () => ({ runner: null, live: false })),
  } as unknown as MuonApiClient;
}

async function runBundle(client: MuonApiClient, args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerBundleCommand(program, () => client);
  const out: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "bundle", "export", ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return out.join("");
}

let workDir: string | null = null;
afterEach(() => {
  process.exitCode = 0;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("muon bundle export", () => {
  it("writes a JSON bundle file and prints its path + summary", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-bundle-"));
    const outPath = path.join(workDir, "bundle.json");
    const output = await runBundle(fakeClient(), [
      "job-root",
      "--out",
      outPath,
    ]);

    expect(output).toContain(`Wrote run bundle to ${outPath}`);
    expect(output).toContain("source: job job-root");
    expect(output).toMatch(/jobs: 1\/1/);
    expect(output).toMatch(/milestones: 1/);
    expect(process.exitCode).toBe(0);

    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.version).toBe(2);
    expect(parsed.source).toMatchObject({ kind: "job", id: "job-root" });
    expect(parsed.manifest.jobs[0].model).toBe("opus-4.8");
    expect(parsed.milestones).toHaveLength(1);
    expect(parsed.invariants.readOnly).toBe(true);
    // v2: the CLI injects node:crypto, so the checkpoint carries a real digest,
    // and the summary renders the checkpoint line.
    expect(parsed.checkpoint.lineageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.checkpoint.invariants.noAutonomousReplay).toBe(true);
    expect(output).toMatch(/checkpoint:.*lineage [0-9a-f]{8}/);
  });

  it("supports a chat source via --chat", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-bundle-"));
    const outPath = path.join(workDir, "chat.json");
    const output = await runBundle(fakeClient(), [
      "chat-1",
      "--chat",
      "--out",
      outPath,
    ]);
    expect(output).toContain("source: chat chat-1");
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.source.kind).toBe("chat");
    expect(parsed.source.title).toBe("Ship auth");
  });

  it("never writes a raw token into the file or the summary", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-bundle-"));
    const outPath = path.join(workDir, "leak.json");
    const output = await runBundle(fakeClient(), [
      "job-root",
      "--out",
      outPath,
    ]);
    const fileContent = readFileSync(outPath, "utf8");
    expect(fileContent).not.toContain(SECRET);
    expect(fileContent).toContain("[redacted]");
    expect(output).not.toContain(SECRET);
  });
});

// ── P0.1 checkpoint+resume (Slice C4): `muon bundle resume` ──────────────────
//
// Dry-run is the DEFAULT and performs zero ledger writes by construction; only
// an explicit --execute re-dispatches the provably-unstarted set, and only an
// explicit per-job --redispatch touches an uncertain job. A stale bundle
// refuses with a reason. Resume is always the human typing the command.

import { createHash } from "node:crypto";
import { writeFileSync as writeFileSyncNode } from "node:fs";

const PRE_LAUNCH_RESULT = "runner authority was lost before vendor launch";

type ResumeClientOptions = {
  jobs?: Record<string, unknown>[];
  /** Live vendor readiness rows (carry a `cliVersion` to exercise drift). */
  readiness?: Record<string, unknown>[];
  /** Override the approvals endpoint (e.g. make it reject to force a partial). */
  listApprovals?: () => Promise<unknown[]>;
};

function resumeClient(options: ResumeClientOptions = {}) {
  const preLaunchJob = {
    id: "job-pre",
    kind: "oneshot",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "provably unstarted work",
    status: "interrupted",
    result: PRE_LAUNCH_RESULT,
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    rootJobId: "job-pre",
    createdAt: "2026-07-17T10:00:00.000Z",
    startedAt: "2026-07-17T10:01:00.000Z",
    endedAt: "2026-07-17T10:02:00.000Z",
  };
  const uncertainJob = {
    id: "job-uncertain",
    kind: "oneshot",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "uncertain work",
    status: "interrupted",
    result:
      "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    rootJobId: "job-pre",
    createdAt: "2026-07-17T10:00:30.000Z",
    startedAt: "2026-07-17T10:01:30.000Z",
    endedAt: "2026-07-17T10:03:00.000Z",
  };
  const jobs = options.jobs ?? [preLaunchJob, uncertainJob];
  const byId = new Map(jobs.map((job) => [job.id as string, job]));
  const enqueueDispatch = vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    id: "job-fresh",
    status: "queued",
    dispatchedBy: "human:cli",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-17T14:00:00.000Z",
  }));
  const client = {
    health: vi.fn(async () => ({ status: "ok" })),
    getDispatchJob: vi.fn(async (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error("not found");
      return found;
    }),
    getDispatchBudget: vi.fn(async (id: string) => ({
      jobId: (byId.get(id)?.rootJobId as string) ?? id,
      capabilityMode: null,
      rootWallMs: 600000,
      maxDescendantWallMs: null,
      poolMs: 0,
      reservedMs: 0,
      consumedMs: 0,
      remainingMs: 0,
      deadlineAt: null,
      childrenIssued: 0,
      maxChildren: 0,
      descendantsIssued: 0,
      maxDescendants: 0,
      depth: 0,
      maxDepth: 0,
      children: jobs
        .filter((job) => job.id !== id)
        .map((job) => ({
          jobId: job.id,
          vendor: job.vendor,
          status: job.status,
          depth: 1,
          reservedMs: 0,
          consumedMs: 0,
        })),
    })),
    listDispatchJobs: vi.fn(async () => jobs),
    listApprovals: vi.fn(options.listApprovals ?? (async () => [])),
    listSessions: vi.fn(async () => []),
    listLoopRuns: vi.fn(async () => []),
    listStreamChunks: vi.fn(async () => []),
    getVendorReadiness: vi.fn(async () => options.readiness ?? []),
    getRunner: vi.fn(async () => ({ runner: null, live: false })),
    enqueueDispatch,
  } as unknown as MuonApiClient;
  return { client, enqueueDispatch, jobs };
}

async function runResume(client: MuonApiClient, args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerBundleCommand(program, () => client);
  const out: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "bundle", "resume", ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return out.join("");
}

describe("muon bundle resume", () => {
  it("dry-run (default) prints the plan and performs ZERO ledger writes", async () => {
    const { client, enqueueDispatch } = resumeClient();
    const output = await runResume(client, ["job-pre"]);
    expect(process.exitCode).toBe(0);
    expect(output).toMatch(/redispatch-fresh/);
    expect(output).toMatch(/human-review/);
    expect(output).toMatch(/dry run/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("--execute re-dispatches ONLY the provably-unstarted set, as fresh lineage-linked jobs", async () => {
    const { client, enqueueDispatch } = resumeClient();
    const output = await runResume(client, ["job-pre", "--execute"]);
    expect(process.exitCode).toBe(0);
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "claude-code",
        taskId: "task-1",
        brief: "provably unstarted work",
        resumedFromJobId: "job-pre",
      })
    );
    // The uncertain job is NEVER auto-replayed by --execute.
    expect(enqueueDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ resumedFromJobId: "job-uncertain" })
    );
    expect(output).toMatch(/job-pre.*→.*job-fresh/);
  });

  it("--execute skips an original already claimed by a prior resume (no duplicate child)", async () => {
    // The append-once stamp is set: a fresh child already carries this work.
    // The planner classes it already-resumed, so --execute re-dispatches nothing.
    const alreadyResumed = {
      id: "job-pre",
      kind: "oneshot",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "provably unstarted work",
      status: "interrupted",
      result: PRE_LAUNCH_RESULT,
      dispatchedBy: "orchestrator",
      interruptRequested: false,
      steerMessages: [],
      rootJobId: "job-pre",
      createdAt: "2026-07-17T10:00:00.000Z",
      startedAt: "2026-07-17T10:01:00.000Z",
      endedAt: "2026-07-17T10:02:00.000Z",
      resumedAt: "2026-07-17T11:00:00.000Z",
      resumedByJobId: "job-child-earlier",
    };
    const { client, enqueueDispatch } = resumeClient({ jobs: [alreadyResumed] });
    const output = await runResume(client, ["job-pre", "--execute"]);
    expect(process.exitCode).toBe(0);
    expect(output).toMatch(/already-resumed/);
    expect(output).toMatch(/job-child-earlier/);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("--redispatch re-dispatches an uncertain job only by explicit id, with its evidence", async () => {
    const { client, enqueueDispatch } = resumeClient();
    const output = await runResume(client, [
      "job-pre",
      "--redispatch",
      "job-uncertain",
    ]);
    expect(process.exitCode).toBe(0);
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ resumedFromJobId: "job-uncertain" })
    );
    expect(output).toMatch(/lease takeover/); // the evidence block
  });

  it("--redispatch refuses a job the plan did not class human-review", async () => {
    const { client, enqueueDispatch } = resumeClient();
    await runResume(client, ["job-pre", "--redispatch", "job-pre"]);
    expect(process.exitCode).toBe(1);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("--execute refuses under unacknowledged vendor CLI version drift; --allow-version-drift acknowledges it", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-resume-"));
    const bundlePath = path.join(workDir, "drift.json");
    const sha256Hex = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const { client, enqueueDispatch, jobs } = resumeClient();
    // A LINEAGE-MATCHING bundle whose exported vendor fingerprint differs from
    // the live probe (the mock's live readiness carries no cliVersion).
    writeFileSyncNode(
      bundlePath,
      JSON.stringify({
        version: 2,
        manifest: {
          jobs: jobs.map((job) => ({ id: job.id })),
          jobCount: jobs.length,
        },
        checkpoint: {
          lineageDigest: computeLineageDigest(jobs as never, sha256Hex),
          jobs: [],
        },
        capabilityPreflight: {
          vendors: [{ vendor: "claude-code", cliVersion: "9.9.9 (exported)" }],
        },
      }),
      "utf8"
    );

    // Unacknowledged drift: writes are refused; the ledger is untouched.
    const refused = await runResume(client, [
      "job-pre",
      "--from",
      bundlePath,
      "--execute",
    ]);
    expect(process.exitCode).toBe(1);
    expect(refused).toMatch(/version drift/i);
    expect(refused).toMatch(/--allow-version-drift/);
    expect(enqueueDispatch).not.toHaveBeenCalled();

    // The drift never blocks the PLAN itself — dry-run still succeeds.
    const { client: dryClient, enqueueDispatch: dryEnqueue } = resumeClient();
    const dryRun = await runResume(dryClient, ["job-pre", "--from", bundlePath]);
    expect(process.exitCode).toBe(0);
    expect(dryRun).toMatch(/version drift/i);
    expect(dryRun).toMatch(/dry run/i);
    expect(dryEnqueue).not.toHaveBeenCalled();

    // Explicit human acknowledgement: --execute proceeds, provably-unstarted only.
    const { client: ackClient, enqueueDispatch: ackEnqueue } = resumeClient();
    await runResume(ackClient, [
      "job-pre",
      "--from",
      bundlePath,
      "--execute",
      "--allow-version-drift",
    ]);
    expect(process.exitCode).toBe(0);
    expect(ackEnqueue).toHaveBeenCalledTimes(1);
    expect(ackEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ resumedFromJobId: "job-pre" })
    );
  });

  it("refuses (exit 1, zero writes) when the bundle lineage does not match the live ledger", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-resume-"));
    const bundlePath = path.join(workDir, "stale.json");
    const sha256Hex = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    // A bundle naming a DIFFERENT mission (foreign job id).
    writeFileSyncNode(
      bundlePath,
      JSON.stringify({
        version: 2,
        manifest: { jobs: [{ id: "job-foreign" }], jobCount: 1 },
        checkpoint: { lineageDigest: sha256Hex("something-else"), jobs: [] },
      }),
      "utf8"
    );
    const { client, enqueueDispatch } = resumeClient();
    const output = await runResume(client, [
      "job-pre",
      "--from",
      bundlePath,
      "--execute",
    ]);
    expect(process.exitCode).toBe(1);
    expect(output).toMatch(/refus|missing|mismatch/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("with the brain down and --from, degrades to a report (no resume execution)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-resume-"));
    const bundlePath = path.join(workDir, "offline.json");
    writeFileSyncNode(
      bundlePath,
      JSON.stringify({
        version: 2,
        manifest: { jobs: [{ id: "job-pre" }], jobCount: 1 },
        checkpoint: {
          lineageDigest: null,
          jobs: [
            {
              jobId: "job-pre",
              phase: "queued",
              uncertain: false,
              provablyUnstarted: false,
              resume: { mechanism: "still-queued", reason: "still queued" },
            },
          ],
          pendingGates: [],
          spentGates: [],
          approvedUndelivered: [],
          sessions: [],
          loopChecks: [],
        },
      }),
      "utf8"
    );
    const down = {
      health: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as MuonApiClient;
    const output = await runResume(down, ["job-pre", "--from", bundlePath]);
    expect(output).toMatch(/live ledger unreachable/i);
    expect(output).toMatch(/job-pre/);
  });

  it("with the brain down and no bundle, errors", async () => {
    const down = {
      health: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as MuonApiClient;
    await runResume(down, ["job-pre"]);
    expect(process.exitCode).toBe(1);
  });

  it("bundle-less --execute PROCEEDS for a provably-unstarted job even when a live vendor is installed (no phantom drift)", async () => {
    // CODE-A: without --from there is no exported evidence to compare against,
    // so an installed vendor with a live cliVersion must NOT manufacture drift
    // and block the primary local-kill recovery path.
    const { client, enqueueDispatch } = resumeClient({
      readiness: [
        {
          vendor: "claude-code",
          installed: true,
          authenticated: true,
          detail: "ready",
          cliVersion: "2.1.207 (Claude Code)",
        },
      ],
    });
    const output = await runResume(client, ["job-pre", "--execute"]);
    expect(process.exitCode).toBe(0);
    expect(output).not.toMatch(/version drift/i);
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: "provably unstarted work",
        resumedFromJobId: "job-pre",
      })
    );
    expect(output).toMatch(/job-pre.*→.*job-fresh/);
  });

  it("a failed approvals fetch produces a visible DEGRADED warning and refuses --execute (never a clean plan)", async () => {
    // CODE-F: swallowing a listApprovals failure to [] silently drops pending
    // gates from the plan. The partiality must surface and writes must refuse.
    const { client, enqueueDispatch } = resumeClient({
      listApprovals: async () => {
        throw new Error("500 approvals unavailable");
      },
    });

    // Dry-run: the degraded warning is visible, still zero writes.
    const dry = await runResume(client, ["job-pre"]);
    expect(dry).toMatch(/DEGRADED PLAN/);
    expect(dry).toMatch(/approvals/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();

    // --execute: refuses from incomplete evidence rather than replaying blind.
    const { client: execClient, enqueueDispatch: execEnqueue } = resumeClient({
      listApprovals: async () => {
        throw new Error("500 approvals unavailable");
      },
    });
    const executed = await runResume(execClient, ["job-pre", "--execute"]);
    expect(process.exitCode).toBe(1);
    expect(executed).toMatch(/INCOMPLETE live evidence/i);
    expect(execEnqueue).not.toHaveBeenCalled();
  });
});
