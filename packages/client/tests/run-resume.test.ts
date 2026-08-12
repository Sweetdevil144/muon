import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRE_LAUNCH_INTERRUPT_RESULTS,
  budgetExhaustedResult,
} from "@muon/protocol";
import {
  buildRedispatchInput,
  classifyGate,
  planResume,
  type ResumePlanInput,
} from "../src/run-resume.js";
import { buildRunBundle } from "../src/run-bundle.js";
import type {
  ApprovalRequest,
  DispatchJobRecord,
  LaneSession,
} from "../src/types.js";

// ── P0.1 checkpoint+resume (Slice C2): the PURE resume planner ────────────────
//
// Resume is a human act. The planner only READS (live ledger authority, bundle
// as portable evidence), refuses on provable staleness instead of guessing,
// re-plans only provably-unstarted work as FRESH jobs, and sends everything
// uncertain to the human. A consumed/expired gate never revalidates.

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function job(overrides: Partial<DispatchJobRecord>): DispatchJobRecord {
  return {
    id: "job-1",
    kind: "oneshot",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the work",
    status: "queued",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    requestedBy: "claude-code",
    kind: "command",
    reason: "Run the command",
    status: "pending",
    jobId: "job-1",
    consumedAt: null,
    evidence: {
      action: "Bash",
      scope: "npm test",
      riskLevel: "high",
      impactIfApproved: "runs a shell command",
      payloadDigest: "d".repeat(64),
      details: {},
    },
    ...overrides,
  };
}

function session(overrides: Partial<LaneSession> = {}): LaneSession {
  return {
    id: "session-1",
    laneId: "lane-claude",
    taskId: "task-1",
    jobId: "job-1",
    vendorSessionId: "vend-123",
    status: "running",
    startedAt: "2026-07-17T10:01:00.000Z",
    ...overrides,
  };
}

function plan(input: Partial<ResumePlanInput> & { live: ResumePlanInput["live"] }) {
  return planResume({ sha256Hex, ...input });
}

describe("planResume — per-phase actions", () => {
  it("a queued job needs zero writes (none-still-queued)", () => {
    const p = plan({ live: { jobs: [job({})], approvals: [], sessions: [] } });
    expect(p.actions).toEqual([{ kind: "none-still-queued", jobId: "job-1" }]);
    expect(p.invariants).toEqual({
      planIsReadOnly: true,
      noAutonomousReplay: true,
      consumedGatesNeverRevalidate: true,
    });
  });

  it("a running job with a (possibly dead) lease defers to the runner's startup reclaim", () => {
    const p = plan({
      live: {
        jobs: [job({ status: "running", startedAt: "2026-07-17T10:01:00.000Z" })],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toEqual([{ kind: "await-runner-reclaim", jobId: "job-1" }]);
  });

  it("each PRE_LAUNCH_INTERRUPT_RESULTS string plans a FRESH re-dispatch with lineage", () => {
    for (const result of PRE_LAUNCH_INTERRUPT_RESULTS) {
      const p = plan({
        live: {
          jobs: [
            job({
              status: "interrupted",
              startedAt: "2026-07-17T10:01:00.000Z",
              result,
              workspacePath: "/repo",
            }),
          ],
          approvals: [],
          sessions: [],
        },
      });
      expect(p.actions).toEqual([
        {
          kind: "redispatch-fresh",
          jobId: "job-1",
          dispatch: expect.objectContaining({
            vendor: "claude-code",
            taskId: "task-1",
            brief: "do the work",
            workspacePath: "/repo",
            resumedFromJobId: "job-1",
          }),
        },
      ]);
    }
  });

  it("a queued→interrupted (never started) job is provably unstarted", () => {
    const p = plan({
      live: {
        jobs: [job({ status: "interrupted", startedAt: null, result: "subtree interrupt" })],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions[0]!.kind).toBe("redispatch-fresh");
  });

  it("a post-launch interrupt is UNCERTAIN: human-review only, never redispatch-fresh", () => {
    const p = plan({
      live: {
        jobs: [
          job({
            status: "interrupted",
            startedAt: "2026-07-17T10:01:00.000Z",
            result:
              "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ kind: "human-review", jobId: "job-1" });
  });

  it("a wall-budget kill routes to human-review, not to 'nothing to resume'", () => {
    // F2: the status is `failed` (no human acted), but the vendor was stopped
    // mid-work, so the resume answer is identical to a post-launch interrupt —
    // unverified side effects, human decision only, never an autonomous replay.
    const p = plan({
      live: {
        jobs: [
          job({
            status: "failed",
            exitCode: 130,
            startedAt: "2026-07-17T10:01:00.000Z",
            result: budgetExhaustedResult({
              vendor: "claude-code",
              budgetMs: 600_000,
              elapsedMs: 603_297,
            }),
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ kind: "human-review", jobId: "job-1" });
    // Never redispatched on MUON's own authority.
    expect(p.actions.map((a) => a.kind)).not.toContain("redispatch-fresh");
  });

  it("an ORDINARY failure is unchanged: no human-review action is manufactured", () => {
    const p = plan({
      live: {
        jobs: [
          job({
            status: "failed",
            exitCode: 1,
            startedAt: "2026-07-17T10:01:00.000Z",
            result: "the tests did not pass",
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions.map((a) => a.kind)).not.toContain("human-review");
  });

  it("an original already claimed by a prior resume is already-resumed, never redispatch-fresh", () => {
    // Same row that WOULD be provably-unstarted (→ redispatch-fresh), but its
    // append-once resume stamp is set: a fresh child already carries the work.
    const p = plan({
      live: {
        jobs: [
          job({
            status: "interrupted",
            startedAt: null,
            result: "subtree interrupt",
            resumedAt: "2026-07-17T11:00:00.000Z",
            resumedByJobId: "job-child",
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toEqual([
      { kind: "already-resumed", jobId: "job-1", resumedByJobId: "job-child" },
    ]);
    expect(p.actions.some((action) => action.kind === "redispatch-fresh")).toBe(
      false
    );
  });

  it("an uncertain original that was explicitly redispatched is already-resumed, never human-review again", () => {
    const p = plan({
      live: {
        jobs: [
          job({
            status: "interrupted",
            startedAt: "2026-07-17T10:01:00.000Z",
            result:
              "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
            resumedAt: "2026-07-17T11:00:00.000Z",
            resumedByJobId: "job-child",
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toEqual([
      { kind: "already-resumed", jobId: "job-1", resumedByJobId: "job-child" },
    ]);
    expect(p.actions.some((action) => action.kind === "human-review")).toBe(
      false
    );
  });

  it("a terminal job with a packet diffHash plans a read-only artifact verification", () => {
    const p = plan({
      live: {
        jobs: [
          job({
            status: "done",
            workspacePath: "/repo",
            packetJson: {
              taskGoal: "goal",
              whatChanged: "changed",
              whatFailed: "nothing",
              nextLaneRequest: "review",
              commandsRun: [],
              checksStatus: [],
              openQuestions: [],
              provenance: { lane: "claude-code", createdAt: "2026-07-17T10:05:00.000Z" },
              schemaVersion: 2,
              diffHash: `sha256:${"a".repeat(64)}`,
              artifacts: [],
              memoryProposals: [],
            },
          }),
        ],
        approvals: [],
        sessions: [],
      },
    });
    expect(p.actions).toEqual([
      expect.objectContaining({
        kind: "verify-artifacts",
        jobId: "job-1",
        diffHash: `sha256:${"a".repeat(64)}`,
      }),
    ]);
  });
});

describe("planResume — gates decide first, and never revalidate", () => {
  it("a pending gate on an interrupted job → decide-gate with sessionInterrupted", () => {
    const p = plan({
      live: {
        jobs: [
          job({
            status: "interrupted",
            startedAt: "2026-07-17T10:01:00.000Z",
            result: "reclaimed",
          }),
        ],
        approvals: [approval()],
        sessions: [session({ status: "interrupted" })],
      },
    });
    expect(p.actions).toEqual([
      {
        kind: "decide-gate",
        jobId: "job-1",
        approvalId: "approval-1",
        payloadDigest: "d".repeat(64),
        sessionInterrupted: true,
      },
    ]);
  });

  it("classifyGate: consumed is terminally SPENT; approved-unconsumed command is expired-undelivered", () => {
    expect(
      classifyGate(approval({ status: "approved", consumedAt: "2026-07-17T11:00:00.000Z" }))
    ).toBe("spent");
    expect(classifyGate(approval({ status: "approved", consumedAt: null }))).toBe(
      "approved-undelivered"
    );
    expect(classifyGate(approval())).toBe("pending");
    expect(classifyGate(approval({ status: "rejected", kind: "gate" }))).toBe("decided");
  });

  it("a spent or undelivered gate produces NO decide-gate action (never revalidates)", () => {
    const p = plan({
      live: {
        jobs: [job({ status: "done" })],
        approvals: [
          approval({ status: "approved", consumedAt: "2026-07-17T11:00:00.000Z" }),
          approval({ id: "approval-2", status: "approved", consumedAt: null }),
        ],
        sessions: [],
      },
    });
    expect(p.actions.filter((a) => a.kind === "decide-gate")).toEqual([]);
  });
});

describe("planResume — bundle reconciliation (evidence, never authority)", () => {
  function bundleFor(jobs: DispatchJobRecord[]) {
    return buildRunBundle({
      generatedAt: "2026-07-17T12:00:00.000Z",
      source: { kind: "job", id: jobs[0]!.id },
      jobs,
      budgets: [],
      approvals: [],
      milestones: [],
      sha256Hex,
    });
  }

  it("matches when the live ledger equals the bundle at a later phase (digest is phase-stable)", () => {
    const atKill = [job({ status: "queued" })];
    const afterRestart = [job({ status: "done", endedAt: "2026-07-17T12:30:00.000Z" })];
    const p = plan({
      live: { jobs: afterRestart, approvals: [], sessions: [] },
      bundle: bundleFor(atKill),
    });
    expect(p.refused).toBeUndefined();
    expect(p.lineage.match).toBe(true);
  });

  it("REFUSES with a reason on a lineage mismatch (stale/corrupt bundle), planning nothing", () => {
    const p = plan({
      live: { jobs: [job({ brief: "entirely different work" })], approvals: [], sessions: [] },
      bundle: bundleFor([job({})]),
    });
    expect(p.refused?.reason).toMatch(/lineage/i);
    expect(p.actions).toEqual([]);
    expect(p.lineage.match).toBe(false);
  });

  it("REFUSES when the live ledger is missing a job the bundle names", () => {
    const p = plan({
      live: { jobs: [], approvals: [], sessions: [] },
      bundle: bundleFor([job({})]),
    });
    expect(p.refused?.reason).toMatch(/missing/i);
    expect(p.actions).toEqual([]);
  });

  it("a redispatched fresh job does not disturb the original set's digest match", () => {
    const original = job({});
    const fresh = job({
      id: "job-2",
      resumedFromJobId: "job-1",
      createdAt: "2026-07-17T13:00:00.000Z",
    });
    const p = plan({
      live: { jobs: [original, fresh], approvals: [], sessions: [] },
      bundle: bundleFor([original]),
    });
    expect(p.refused).toBeUndefined();
    expect(p.lineage.match).toBe(true);
  });

  it("reports version drift between exported and live vendor fingerprints", () => {
    const bundle = bundleFor([job({})]);
    bundle.capabilityPreflight = {
      vendors: [{ vendor: "claude-code", cliVersion: "2.1.100" }],
    } as never;
    const p = plan({
      live: { jobs: [job({})], approvals: [], sessions: [] },
      bundle,
      livePreflight: {
        vendors: [{ vendor: "claude-code", cliVersion: "2.1.207" }],
      } as never,
    });
    expect(p.versionDrift).toEqual([
      { vendor: "claude-code", exported: "2.1.100", live: "2.1.207" },
    ]);
    // Drift never blocks the PLAN itself.
    expect(p.refused).toBeUndefined();
  });
});

describe("buildRedispatchInput — fresh job, unweakened fences", () => {
  it("copies the original manifest and stamps resumedFromJobId (never parent/root lineage)", () => {
    const input = buildRedispatchInput(
      job({
        kind: "loop",
        maxIterations: 3,
        maxWallMs: 60000,
        checks: [{ command: "npm", args: ["test"] }],
        iterationTimeoutMs: 30000,
        harnessKey: "review",
        workspacePath: "/repo",
        actionProfilePatch: { model: "opus-4.8" },
      }),
      []
    );
    expect(input).toEqual({
      kind: "loop",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "do the work",
      harnessKey: "review",
      workspacePath: "/repo",
      maxWallMs: 60000,
      maxIterations: 3,
      checks: [{ command: "npm", args: ["test"] }],
      iterationTimeoutMs: 30000,
      model: "opus-4.8",
      resumedFromJobId: "job-1",
    });
    expect("parentJobId" in input).toBe(false);
    expect("rootJobId" in input).toBe(false);
  });

  it("hands a resumable vendor session its handle; codex never gets one", () => {
    const claude = buildRedispatchInput(
      job({ kind: "session", vendor: "claude-code" }),
      [session({ status: "interrupted" })]
    );
    expect(claude.resumeVendorSessionId).toBe("vend-123");

    const codex = buildRedispatchInput(
      job({ kind: "session", vendor: "codex" }),
      [session({ status: "interrupted" })]
    );
    expect(codex.resumeVendorSessionId).toBeUndefined();
  });

  it("never leaks loop/session-only fields onto other kinds (schema-valid copy)", () => {
    const oneshot = buildRedispatchInput(
      job({ kind: "oneshot", maxIterations: 3, approvalTimeoutMs: 1000 }),
      [session({})]
    );
    expect(oneshot.maxIterations).toBeUndefined();
    expect(oneshot.approvalTimeoutMs).toBeUndefined();
    expect(oneshot.resumeVendorSessionId).toBeUndefined();
  });

  it("carries the vendor action forward faithfully (action + argv override + brief prefix)", () => {
    // A resumed action job MUST run the SAME vendor invocation the human chose,
    // not the plain brief under the default argv (ADR-0013 #52 v2 fidelity).
    const input = buildRedispatchInput(
      job({
        kind: "oneshot",
        action: "review",
        actionArgvOverride: { command: "claude", args: ["--review", "--strict"] },
        actionBriefPrefix: "You are reviewing a PR.\n\n",
      }),
      []
    );
    expect(input.action).toBe("review");
    expect(input.actionArgvOverride).toEqual({
      command: "claude",
      args: ["--review", "--strict"],
    });
    expect(input.actionBriefPrefix).toBe("You are reviewing a PR.\n\n");
  });

  it("a plain (non-action) dispatch carries no action fields", () => {
    const input = buildRedispatchInput(job({ kind: "oneshot" }), []);
    expect("action" in input).toBe(false);
    expect("actionArgvOverride" in input).toBe(false);
    expect("actionBriefPrefix" in input).toBe(false);
  });
});

describe("planVersionDrift — only meaningful against exported evidence", () => {
  it("bundle-less resume reports NO drift even with live vendor fingerprints", () => {
    // The primary local-kill recovery: no --from bundle. Comparing every
    // installed vendor to an empty export set would manufacture phantom drift
    // and refuse 100% of the time (CODE-A). The live ledger is sole authority.
    const p = plan({
      live: {
        jobs: [job({ status: "interrupted", startedAt: null, result: "subtree interrupt" })],
        approvals: [],
        sessions: [],
      },
      livePreflight: {
        vendors: [{ vendor: "claude-code", cliVersion: "2.1.207" }],
      } as never,
    });
    expect(p.versionDrift).toEqual([]);
    expect(p.refused).toBeUndefined();
    expect(p.actions[0]!.kind).toBe("redispatch-fresh");
  });
});
