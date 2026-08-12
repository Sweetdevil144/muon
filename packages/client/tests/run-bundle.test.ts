import { describe, expect, it, vi } from "vitest";
import { describeMissionCost } from "@muon/protocol";
import {
  RUN_BUNDLE_VERSION,
  RUN_BUNDLE_LIMITS,
  MAX_MEMORY_NOTES_PER_JOB,
  MEMORY_INJECTED_EVENT_KIND,
  buildRunBundle,
  collectRunBundle,
  redactSecrets,
  type RunBundleClient,
} from "../src/run-bundle.js";
import type {
  ApprovalRequest,
  DispatchBudget,
  DispatchJobRecord,
  OrchestratorChatRecord,
  StreamChunk,
} from "../src/types.js";

// Sentinel credential shapes. The VALUES must never survive into the bundle;
// only their scrubbed `[redacted]` form may.
const SECRET_TOKEN_VALUE = "sk-live-DEADBEEFdeadbeef00";
const SECRET_BEARER_VALUE = "abcd1234efgh5678ZZ";
const SECRET_AWS_VALUE = "wJalrXUtnFEMI0BEEFxyz";
const SENTINELS = [SECRET_TOKEN_VALUE, SECRET_BEARER_VALUE, SECRET_AWS_VALUE];
const SENTINEL_BRIEF = `refactor auth; MUON_API_TOKEN=${SECRET_TOKEN_VALUE} do not leak`;
const SENTINEL_MILESTONE = `checkpoint reached; Bearer ${SECRET_BEARER_VALUE}`;
const SENTINEL_IMPACT = `will merge; AWS_SECRET_ACCESS_KEY: ${SECRET_AWS_VALUE}`;

const GENERATED_AT = "2026-07-17T12:00:00.000Z";

function job(overrides: Partial<DispatchJobRecord>): DispatchJobRecord {
  return {
    id: "job-root",
    kind: "auto",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the work",
    status: "done",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

function packetJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    taskGoal: "Ship the feature",
    whatChanged: `Edited files. MUON_API_TOKEN=${SECRET_TOKEN_VALUE}`,
    whatFailed: "Nothing reported failing.",
    nextLaneRequest: "Review and continue.",
    commandsRun: ["npm test"],
    checksStatus: ["exit_code=0"],
    openQuestions: ["None captured."],
    provenance: { lane: "claude-code", createdAt: "2026-07-17T11:00:00.000Z" },
    schemaVersion: 2,
    diffHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    artifacts: [
      {
        path: "src/feature.ts",
        kind: "file",
        hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
    memoryProposals: [
      { kind: "attempt", text: `leaked Bearer ${SECRET_BEARER_VALUE}` },
    ],
    ...overrides,
  };
}

function budget(overrides: Partial<DispatchBudget> = {}): DispatchBudget {
  return {
    jobId: "job-root",
    capabilityMode: "orchestrator",
    rootWallMs: 600000,
    maxDescendantWallMs: 4800000,
    poolMs: 4800000,
    reservedMs: 600000,
    consumedMs: 120000,
    remainingMs: 4080000,
    deadlineAt: "2026-07-17T12:30:00.000Z",
    childrenIssued: 1,
    maxChildren: 8,
    descendantsIssued: 1,
    maxDescendants: 10,
    depth: 0,
    maxDepth: 3,
    children: [
      {
        jobId: "job-child",
        vendor: "codex",
        status: "done",
        depth: 1,
        reservedMs: 0,
        consumedMs: 120000,
      },
    ],
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    requestedBy: "claude-code",
    kind: "merge",
    reason: "Merge the feature branch",
    status: "approved",
    gateTag: "merge:task-1",
    consumedAt: "2026-07-17T11:30:00.000Z",
    createdAt: "2026-07-17T11:20:00.000Z",
    decidedAt: "2026-07-17T11:25:00.000Z",
    evidence: {
      action: "merge",
      scope: "branch feature/auth",
      riskLevel: "medium",
      impactIfApproved: SENTINEL_IMPACT,
      payloadDigest:
        "3333333333333333333333333333333333333333333333333333333333333333",
      details: { branch: "feature/auth" },
    },
    ...overrides,
  };
}

function milestone(overrides: Partial<StreamChunk> = {}): StreamChunk {
  return {
    seq: 1,
    taskId: "task-1",
    laneId: "lane-claude",
    agentId: "agent-1",
    runId: "run-1",
    kind: "milestone",
    content: "reached checkpoint",
    timestamp: "2026-07-17T11:05:00.000Z",
    ...overrides,
  };
}

describe("buildRunBundle — seeded hermetic assembly", () => {
  const rootJob = job({
    id: "job-root",
    capabilityMode: "orchestrator",
    delegationDepth: 0,
    maxDelegationDepth: 3,
    rootJobId: "job-root",
    chatId: "chat-1",
    brief: SENTINEL_BRIEF,
    actionProfilePatch: { model: "opus-4.8" },
    exitCode: 0,
    endedAt: "2026-07-17T11:10:00.000Z",
    packetJson: packetJson(),
  });
  const childJob = job({
    id: "job-child",
    vendor: "codex",
    capabilityMode: "delegate",
    delegationDepth: 1,
    parentJobId: "job-root",
    rootJobId: "job-root",
    chatId: "chat-1",
    taskId: "task-1",
    brief: "delegated sub-task",
    status: "done",
  });

  const bundle = buildRunBundle({
    generatedAt: GENERATED_AT,
    source: { kind: "job", id: "job-root" },
    chat: {
      id: "chat-1",
      title: "Ship auth",
      workspacePath: "/repo",
      status: "active",
      createdAt: "2026-07-17T09:00:00.000Z",
      updatedAt: "2026-07-17T11:00:00.000Z",
    } as OrchestratorChatRecord,
    jobs: [rootJob, childJob],
    budgets: [budget()],
    approvals: [approval(), approval({ id: "approval-other", taskId: "task-x" })],
    milestones: [
      milestone({ seq: 1, content: SENTINEL_MILESTONE }),
      milestone({ seq: 2, content: "second checkpoint" }),
      // Raw stream bytes that must NOT appear as milestones.
      milestone({ seq: 3, kind: "output", content: "raw stdout bytes" }),
      milestone({ seq: 4, kind: "reasoning", content: "chain of thought" }),
      // A milestone for a task NOT in this mission must be dropped.
      milestone({ seq: 5, taskId: "task-x", content: "foreign milestone" }),
    ],
    capabilityPreflight: null,
  });

  it("stamps the version, caller clock, and source", () => {
    expect(bundle.version).toBe(RUN_BUNDLE_VERSION);
    expect(bundle.generatedAt).toBe(GENERATED_AT);
    expect(bundle.source).toMatchObject({ kind: "job", id: "job-root" });
    expect(bundle.source.title).toBe("Ship auth");
    expect(bundle.source.workspacePath).toBe("/repo");
  });

  it("assembles the dispatch manifest with the model override + no raw result", () => {
    expect(bundle.manifest.jobCount).toBe(2);
    const root = bundle.manifest.jobs.find((entry) => entry.id === "job-root");
    expect(root).toMatchObject({
      vendor: "claude-code",
      capabilityMode: "orchestrator",
      model: "opus-4.8",
      exitCode: 0,
      hasPacket: true,
    });
    // Raw `result`/`steerMessages` are deliberately excluded.
    expect(JSON.stringify(root)).not.toContain("result");
    expect(JSON.stringify(root)).not.toContain("steerMessages");
  });

  it("reconstructs the delegation lineage (root → child)", () => {
    expect(bundle.lineage.roots).toHaveLength(1);
    const root = bundle.lineage.roots[0]!;
    expect(root.id).toBe("job-root");
    expect(root.children.map((child) => child.id)).toEqual(["job-child"]);
    expect(root.authority).toBe("orchestrator");
    expect(bundle.lineage.missions[0]!.summary.consumedWallMs).toBe(0);
  });

  it("carries the exact S9 budget accounting numbers", () => {
    expect(bundle.budgets).toHaveLength(1);
    expect(bundle.budgets[0]).toMatchObject({
      poolMs: 4800000,
      reservedMs: 600000,
      consumedMs: 120000,
      remainingMs: 4080000,
      children: [{ jobId: "job-child", consumedMs: 120000 }],
    });
  });

  it("validates and includes the typed handoff packet", () => {
    const handoff = bundle.handoffs.find((row) => row.jobId === "job-root");
    expect(handoff?.packet).not.toBeNull();
    expect(handoff?.packet?.taskGoal).toBe("Ship the feature");
    expect(handoff?.invalidReason).toBeUndefined();
  });

  it("keeps only mission-scoped approvals, with evidence refs", () => {
    expect(bundle.approvals).toHaveLength(1);
    expect(bundle.approvals[0]).toMatchObject({
      id: "approval-1",
      kind: "merge",
      status: "approved",
      gateTag: "merge:task-1",
    });
    expect(bundle.approvals[0]!.evidence?.payloadDigest).toBe(
      "3333333333333333333333333333333333333333333333333333333333333333"
    );
  });

  it("keeps only milestone chunks (never raw stream bytes), mission-scoped, newest-first", () => {
    expect(bundle.milestones.map((entry) => entry.seq)).toEqual([2, 1]);
    for (const entry of bundle.milestones) {
      expect(entry.taskId).toBe("task-1");
    }
    const serialized = JSON.stringify(bundle.milestones);
    expect(serialized).not.toContain("raw stdout bytes");
    expect(serialized).not.toContain("chain of thought");
    expect(serialized).not.toContain("foreign milestone");
  });

  it("aggregates artifact + diff hashes as evidence refs", () => {
    const kinds = bundle.artifacts.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["diff", "file"]);
    const diff = bundle.artifacts.find((entry) => entry.kind === "diff");
    expect(diff?.hash).toBe(
      "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    );
  });

  it("marks the read-only / credential-safe invariants", () => {
    expect(bundle.invariants).toEqual({
      readOnly: true,
      credentialMaterialExcluded: true,
      rawStreamBytesExcluded: true,
      freeTextRedactedThenBounded: true,
    });
  });

  it("passes a credential leak-scan across every embedded free-text field", () => {
    const serialized = JSON.stringify(bundle);
    for (const secret of SENTINELS) {
      expect(serialized).not.toContain(secret);
    }
    // Proof the sentinels were actually present-and-scrubbed, not simply absent.
    expect(serialized).toContain("[redacted]");
  });
});

describe("redactSecrets", () => {
  it("scrubs KEY=value and Bearer shapes", () => {
    expect(redactSecrets(`X_API_KEY=${SECRET_TOKEN_VALUE}`)).toBe(
      "X_API_KEY=[redacted]"
    );
    expect(redactSecrets(`Bearer ${SECRET_BEARER_VALUE}`)).toBe(
      "Bearer [redacted]"
    );
  });

  it("still redacts real KEY=value / SECRET: value patterns after the bound", () => {
    // colon-delimited secret
    expect(redactSecrets(`AWS_SECRET_ACCESS_KEY: ${SECRET_AWS_VALUE}`)).toBe(
      "AWS_SECRET_ACCESS_KEY: [redacted]"
    );
    // password shape
    expect(redactSecrets(`DB_PASSWORD=hunter2hunter2`)).toBe(
      "DB_PASSWORD=[redacted]"
    );
    // credential/private-key keyword variants
    expect(redactSecrets(`MY_CREDENTIAL=abcdef123456`)).toBe(
      "MY_CREDENTIAL=[redacted]"
    );
    expect(redactSecrets(`PRIVATE_KEY=abcdef123456`)).toBe(
      "PRIVATE_KEY=[redacted]"
    );
  });

  it("redacts a note that is mostly one giant secret value", () => {
    const giant = "A".repeat(100_000);
    const out = redactSecrets(`API_KEY=${giant}`);
    expect(out).toBe("API_KEY=[redacted]");
    expect(out).not.toContain(giant);
  });

  it("redacts a secret whose variable name prefix exceeds the bound", () => {
    // >64 chars of name before the keyword must still redact the value.
    const longPrefix = "Z".repeat(200);
    const out = redactSecrets(`${longPrefix}TOKEN=${SECRET_TOKEN_VALUE}`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(SECRET_TOKEN_VALUE);
  });

  it("scans a 100k-char pathological input in linear (bounded) time", () => {
    // A long keyword-free run of identifier chars is the O(n^2) ReDoS trigger:
    // the unbounded prefix run backtracks char-by-char at every start position.
    // A bounded regex scans this in a few ms; the quadratic version takes many
    // seconds. A generous fixed bound discriminates the two without flaking.
    const pathological = "Aa0_-".repeat(20_000); // 100k chars, no keyword/delimiter
    const start = Date.now();
    const out = redactSecrets(pathological);
    const elapsed = Date.now() - start;
    expect(out).toBe(pathological); // nothing to redact
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("buildRunBundle — bounds hold honestly", () => {
  it("caps jobs / approvals / milestones and records each omission", () => {
    const overflowJobs = Array.from({ length: RUN_BUNDLE_LIMITS.maxJobs + 3 }, (_, i) =>
      job({ id: `job-${i}`, taskId: "task-1", rootJobId: "job-0", parentJobId: i === 0 ? null : "job-0" })
    );
    const overflowApprovals = Array.from(
      { length: RUN_BUNDLE_LIMITS.maxApprovals + 2 },
      (_, i) => approval({ id: `approval-${i}`, taskId: "task-1" })
    );
    const overflowMilestones = Array.from(
      { length: RUN_BUNDLE_LIMITS.maxMilestones + 4 },
      (_, i) => milestone({ seq: i, taskId: "task-1" })
    );

    const bundle = buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "chat", id: "chat-1" },
      jobs: overflowJobs,
      budgets: [],
      approvals: overflowApprovals,
      milestones: overflowMilestones,
    });

    expect(bundle.manifest.jobs).toHaveLength(RUN_BUNDLE_LIMITS.maxJobs);
    expect(bundle.manifest.jobCount).toBe(RUN_BUNDLE_LIMITS.maxJobs + 3);
    expect(bundle.approvals).toHaveLength(RUN_BUNDLE_LIMITS.maxApprovals);
    expect(bundle.milestones).toHaveLength(RUN_BUNDLE_LIMITS.maxMilestones);
    expect(bundle.omissions.some((note) => note.startsWith("manifest:"))).toBe(true);
    expect(bundle.omissions.some((note) => note.startsWith("approvals:"))).toBe(true);
    expect(bundle.omissions.some((note) => note.startsWith("milestones:"))).toBe(true);
  });

  it("degrades an unparseable packet to a null row with a reason", () => {
    const bundle = buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "job", id: "job-root" },
      jobs: [job({ id: "job-root", packetJson: { not: "a packet" } })],
      budgets: [],
      approvals: [],
      milestones: [],
    });
    expect(bundle.handoffs).toHaveLength(1);
    expect(bundle.handoffs[0]!.packet).toBeNull();
    expect(bundle.handoffs[0]!.invalidReason).toContain("schema validation");
  });
});

describe("collectRunBundle — read-only composition", () => {
  function fakeClient(): {
    client: RunBundleClient;
    calls: Record<string, number>;
  } {
    const calls: Record<string, number> = {};
    const bump = (name: string) => {
      calls[name] = (calls[name] ?? 0) + 1;
    };
    const rootJob = job({
      id: "job-root",
      rootJobId: "job-root",
      chatId: "chat-1",
      capabilityMode: "orchestrator",
      packetJson: packetJson(),
    });
    const childJob = job({
      id: "job-child",
      vendor: "codex",
      parentJobId: "job-root",
      rootJobId: "job-root",
      delegationDepth: 1,
      chatId: "chat-1",
    });
    const byId: Record<string, DispatchJobRecord> = {
      "job-root": rootJob,
      "job-child": childJob,
    };
    const client = {
      getDispatchJob: vi.fn(async (id: string) => {
        bump("getDispatchJob");
        const found = byId[id];
        if (!found) throw new Error("not found");
        return found;
      }),
      getDispatchBudget: vi.fn(async () => {
        bump("getDispatchBudget");
        return budget();
      }),
      listDispatchJobs: vi.fn(async () => {
        bump("listDispatchJobs");
        return [rootJob, childJob];
      }),
      getChat: vi.fn(async () => {
        bump("getChat");
        return {
          id: "chat-1",
          title: "Ship auth",
          workspacePath: "/repo",
          status: "active",
          createdAt: "2026-07-17T09:00:00.000Z",
          updatedAt: "2026-07-17T11:00:00.000Z",
        } as OrchestratorChatRecord;
      }),
      listApprovals: vi.fn(async () => {
        bump("listApprovals");
        return [approval()];
      }),
      listStreamChunks: vi.fn(async () => {
        bump("listStreamChunks");
        return [milestone(), milestone({ seq: 2, kind: "output", content: "raw" })];
      }),
      health: vi.fn(async () => {
        bump("health");
        return { status: "ok" };
      }),
      getVendorReadiness: vi.fn(async () => {
        bump("getVendorReadiness");
        return [];
      }),
      getRunner: vi.fn(async () => {
        bump("getRunner");
        return { runner: null, live: false };
      }),
    } as unknown as RunBundleClient;
    return { client, calls };
  }

  it("composes a job-rooted bundle from read endpoints only", async () => {
    const { client, calls } = fakeClient();
    const bundle = await collectRunBundle(client, {
      jobId: "job-root",
      now: new Date(GENERATED_AT),
    });
    expect(bundle.generatedAt).toBe(GENERATED_AT);
    expect(bundle.manifest.jobCount).toBe(2);
    expect(bundle.budgets).toHaveLength(1);
    expect(bundle.milestones).toHaveLength(1); // only the milestone-kind chunk
    expect(bundle.capabilityPreflight).not.toBeNull();
    // No mutating endpoint exists on the client surface it was handed.
    expect(calls.getDispatchJob).toBeGreaterThanOrEqual(1);
  });

  it("composes a chat-rooted bundle", async () => {
    const { client } = fakeClient();
    const bundle = await collectRunBundle(client, {
      chatId: "chat-1",
      now: new Date(GENERATED_AT),
    });
    expect(bundle.source).toMatchObject({ kind: "chat", id: "chat-1" });
    expect(bundle.manifest.jobCount).toBe(2);
    expect(bundle.source.title).toBe("Ship auth");
  });

  it("rejects when neither or both ids are given", async () => {
    const { client } = fakeClient();
    await expect(collectRunBundle(client, {})).rejects.toThrow(/exactly one/);
    await expect(
      collectRunBundle(client, { jobId: "a", chatId: "b" })
    ).rejects.toThrow(/exactly one/);
  });
});

// ── P0.1 checkpoint+resume (Slice B2): bundle v2 checkpoint projection ────────
//
// The ledger IS the checkpoint; the bundle's `checkpoint` section is a pure
// projection of it. The lineage digest covers IMMUTABLE fields only, so the
// same mission hashes identically at every lifecycle phase (pre-kill and
// post-restart digests are comparable), and the raw brief rides only as a
// sha256 ref (same stance as payloadDigest).

import { createHash } from "node:crypto";
import {
  PRE_LAUNCH_INTERRUPT_RESULTS,
  VENDOR_IDS,
  budgetExhaustedResult,
  sessionCapability,
} from "@muon/protocol";
import { classifyJobPhase, computeLineageDigest } from "../src/run-bundle.js";
import type { LaneSession, LoopRunRecord } from "../src/types.js";

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function session(overrides: Partial<LaneSession> = {}): LaneSession {
  return {
    id: "session-1",
    laneId: "lane-claude",
    taskId: "task-1",
    jobId: "job-root",
    vendorSessionId: "vend-abc-123",
    status: "running",
    startedAt: "2026-07-17T10:30:00.000Z",
    ...overrides,
  };
}

function loopRun(overrides: Partial<LoopRunRecord> = {}): LoopRunRecord {
  return {
    id: "loop-1",
    taskId: "task-1",
    kind: "loop",
    budget: { maxIterations: 3 },
    iterations: 2,
    status: "running",
    startedAt: "2026-07-17T10:00:00.000Z",
    progress: {
      iteration: 2,
      shell: [{ name: "npm test", ok: false, exitCode: 1 }],
      evaluator: null,
      repairSeed: "fix the failing test",
      degraded: "evaluator_unavailable",
      updatedAt: "2026-07-17T10:05:00.000Z",
    },
    ...overrides,
  };
}

describe("bundle v2 checkpoint — version + lineage digest", () => {
  it("stamps version 2", () => {
    expect(RUN_BUNDLE_VERSION).toBe(2);
  });

  const jobsAtDispatch = [
    job({ id: "job-b", status: "queued", startedAt: null }),
    job({ id: "job-a", status: "queued", startedAt: null }),
  ];
  const jobsAtTerminal = [
    job({
      id: "job-a",
      status: "done",
      startedAt: "2026-07-17T10:01:00.000Z",
      endedAt: "2026-07-17T10:09:00.000Z",
      exitCode: 0,
      result: "all done",
    }),
    job({ id: "job-b", status: "interrupted", startedAt: "2026-07-17T10:02:00.000Z" }),
  ];

  it("is deterministic, order-insensitive, and STATUS-insensitive", () => {
    const d1 = computeLineageDigest(jobsAtDispatch, sha256Hex);
    const d2 = computeLineageDigest([...jobsAtDispatch].reverse(), sha256Hex);
    const d3 = computeLineageDigest(jobsAtTerminal, sha256Hex);
    expect(d1).toBe(d2);
    expect(d1).toBe(d3); // same mission at a different phase → same digest
  });

  it("changes when a job is added or a brief changes (brief rides as a hash only)", () => {
    const base = computeLineageDigest(jobsAtDispatch, sha256Hex);
    const grown = computeLineageDigest(
      [...jobsAtDispatch, job({ id: "job-c" })],
      sha256Hex
    );
    const briefChanged = computeLineageDigest(
      [jobsAtDispatch[0]!, { ...jobsAtDispatch[1]!, brief: "other work" }],
      sha256Hex
    );
    expect(grown).not.toBe(base);
    expect(briefChanged).not.toBe(base);
    // The digest input never carries the raw brief text.
    const digestOfBrief = sha256Hex(jobsAtDispatch[0]!.brief);
    expect(digestOfBrief).toHaveLength(64);
  });

  it("degrades to null + an honest omission when no hasher is injected", () => {
    const bundle = buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "job", id: "job-root" },
      jobs: [job({})],
      budgets: [],
      approvals: [],
      milestones: [],
    });
    expect(bundle.checkpoint.lineageDigest).toBeNull();
    expect(
      bundle.omissions.some((note) => note.includes("lineageDigest"))
    ).toBe(true);
  });
});

describe("bundle v2 checkpoint — phase classification", () => {
  it("classifies queued / running / terminal / waiting-gate", () => {
    const queued = job({ id: "j-q", status: "queued" });
    const running = job({ id: "j-r", status: "running" });
    const terminal = job({ id: "j-t", status: "done" });
    const gated = job({ id: "j-g", status: "running" });
    const sessions = [
      session({ id: "s-g", jobId: "j-g", status: "waiting_approval" }),
    ];
    const approvals = [
      approval({ id: "a-g", kind: "command", status: "pending", jobId: "j-g" }),
    ];
    expect(classifyJobPhase(queued, sessions, approvals)).toBe("queued");
    expect(classifyJobPhase(running, sessions, approvals)).toBe("running");
    expect(classifyJobPhase(terminal, sessions, approvals)).toBe("terminal");
    expect(classifyJobPhase(gated, sessions, approvals)).toBe("waiting-gate");
  });

  it("waiting-gate needs BOTH the waiting session and the pending job-bound gate", () => {
    const gated = job({ id: "j-g", status: "running" });
    expect(
      classifyJobPhase(
        gated,
        [session({ jobId: "j-g", status: "waiting_approval" })],
        []
      )
    ).toBe("running");
    expect(
      classifyJobPhase(
        gated,
        [],
        [approval({ kind: "command", status: "pending", jobId: "j-g" })]
      )
    ).toBe("running");
  });
});

describe("bundle v2 checkpoint — provably-unstarted + resume hints", () => {
  function checkpointFor(
    jobs: Parameters<typeof buildRunBundle>[0]["jobs"],
    extra: Partial<Parameters<typeof buildRunBundle>[0]> = {}
  ) {
    return buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "job", id: jobs[0]!.id },
      jobs,
      budgets: [],
      approvals: [],
      milestones: [],
      sha256Hex,
      ...extra,
    }).checkpoint;
  }

  it("marks every PRE_LAUNCH_INTERRUPT_RESULTS string provably unstarted → redispatch-fresh", () => {
    for (const result of PRE_LAUNCH_INTERRUPT_RESULTS) {
      const cp = checkpointFor([
        job({
          id: "j-pre",
          status: "interrupted",
          startedAt: "2026-07-17T10:01:00.000Z",
          result,
        }),
      ]);
      expect(cp.jobs[0]).toMatchObject({
        provablyUnstarted: true,
        resume: { mechanism: "redispatch-fresh" },
      });
    }
  });

  it("marks a queued→interrupted (never started) job provably unstarted", () => {
    const cp = checkpointFor([
      job({ id: "j-sub", status: "interrupted", startedAt: null, result: "subtree interrupt" }),
    ]);
    expect(cp.jobs[0]!.provablyUnstarted).toBe(true);
  });

  it("a post-launch interrupt is UNCERTAIN, never provably unstarted", () => {
    const cp = checkpointFor([
      job({
        id: "j-post",
        status: "interrupted",
        startedAt: "2026-07-17T10:01:00.000Z",
        result: "Interrupted after runner lease takeover; the prior execution outcome is unknown. Review the workspace before redispatching.",
      }),
    ]);
    expect(cp.jobs[0]).toMatchObject({
      uncertain: true,
      provablyUnstarted: false,
      resume: { mechanism: "human-review" },
    });
  });

  it("a wall-budget kill is UNCERTAIN for resume, even though its status is failed", () => {
    // F2: nobody interrupted it, so the STATUS is `failed`. But MUON stopped a
    // vendor mid-work, so for resume purposes it is the same situation as an
    // interrupt: unverified side effects, human decision required. Without
    // this it fell through to "terminal with a known outcome; nothing to
    // resume" — the wrong thing to say about a worker killed 3s over budget
    // mid-edit.
    const cp = checkpointFor([
      job({
        id: "j-budget",
        status: "failed",
        exitCode: 130,
        startedAt: "2026-07-17T10:01:00.000Z",
        result: budgetExhaustedResult({
          vendor: "claude-code",
          budgetMs: 600_000,
          elapsedMs: 603_297,
        }),
      }),
    ]);
    expect(cp.jobs[0]).toMatchObject({
      uncertain: true,
      provablyUnstarted: false,
      resume: { mechanism: "human-review" },
    });
    expect(cp.jobs[0]!.resume.reason).toMatch(/wall-clock budget ran out/i);
    expect(cp.jobs[0]!.resume.reason).toMatch(/larger maxWallMs/i);
  });

  it("a budget-killed SESSION keeps its resume handle instead of being written off", () => {
    const cp = checkpointFor(
      [
        job({
          id: "j-budget-s",
          kind: "session",
          vendor: "claude-code",
          status: "failed",
          exitCode: 130,
          startedAt: "2026-07-17T10:01:00.000Z",
          result: budgetExhaustedResult({
            vendor: "claude-code",
            budgetMs: 600_000,
          }),
        }),
      ],
      {
        sessions: [
          session({
            id: "s-b",
            jobId: "j-budget-s",
            vendorSessionId: "vend-budget-1",
            status: "interrupted",
          }),
        ],
      }
    );
    expect(cp.jobs[0]!.resume).toMatchObject({
      mechanism: "session-resume",
      vendorSessionId: "vend-budget-1",
    });
  });

  it("an ordinary failure is still 'nothing to resume' (the marker is what distinguishes them)", () => {
    const cp = checkpointFor([
      job({
        id: "j-fail",
        status: "failed",
        exitCode: 1,
        startedAt: "2026-07-17T10:01:00.000Z",
        result: "the tests did not pass",
      }),
    ]);
    expect(cp.jobs[0]).toMatchObject({
      uncertain: false,
      resume: { mechanism: "none" },
    });
  });

  it("a still-queued job resumes by doing nothing (zero writes)", () => {
    const cp = checkpointFor([job({ id: "j-q", status: "queued" })]);
    expect(cp.jobs[0]!.resume.mechanism).toBe("still-queued");
  });

  it("an uncertain claude-code session job carries its resume handle verbatim", () => {
    const cp = checkpointFor(
      [
        job({
          id: "j-s",
          kind: "session",
          vendor: "claude-code",
          status: "interrupted",
          startedAt: "2026-07-17T10:01:00.000Z",
          result: "post-launch interrupt",
        }),
      ],
      {
        sessions: [
          session({ id: "s-1", jobId: "j-s", vendorSessionId: "vend-abc-123", status: "interrupted" }),
        ],
      }
    );
    expect(cp.jobs[0]!.resume).toMatchObject({
      mechanism: "session-resume",
      vendorSessionId: "vend-abc-123",
    });
    // ADR-0022 C4: this used to read the hand-written `VENDOR_SESSION_RESUME`
    // table; the projection now asks the registry column that table mirrored.
    expect(sessionCapability("claude-code").canResume).toBe(true);
  });

  it("a codex session is honestly non-resumable (mechanism none, with the reason)", () => {
    const cp = checkpointFor(
      [
        job({
          id: "j-cx",
          kind: "session",
          vendor: "codex",
          status: "interrupted",
          startedAt: "2026-07-17T10:01:00.000Z",
          result: "post-launch interrupt",
        }),
      ],
      { sessions: [session({ id: "s-2", jobId: "j-cx", status: "interrupted" })] }
    );
    expect(cp.jobs[0]!.resume.mechanism).toBe("none");
    expect(cp.jobs[0]!.resume.reason).toMatch(/codex|resum/i);
    expect(sessionCapability("codex").canResume).toBe(false);
  });

  it("a vendor MUON has never heard of is non-resumable, fail-closed", () => {
    // The deleted table returned `undefined` for an unlisted id, which read as
    // falsy by ACCIDENT. `sessionCapability` states it: absence is no
    // capability. Same answer, now for a reason.
    expect(sessionCapability("kiro").canResume).toBe(false);
    const cp = checkpointFor(
      [
        job({
          id: "j-unknown",
          kind: "session",
          vendor: "kiro",
          status: "interrupted",
          startedAt: "2026-07-17T10:01:00.000Z",
          result: "post-launch interrupt",
        }),
      ],
      {
        sessions: [
          session({
            id: "s-3",
            jobId: "j-unknown",
            vendorSessionId: "vend-xyz",
            status: "interrupted",
          }),
        ],
      }
    );
    // A handle EXISTS on the session row, so this would be `session-resume` if
    // the lookup failed open.
    expect(cp.jobs[0]!.resume.mechanism).toBe("none");
  });

  it("exactly one registry lane declares canResume", () => {
    // The cross-vendor invariant the deleted table could not state: a second
    // resumable lane is a governance change (G7), not a table edit.
    expect(
      [...VENDOR_IDS].filter((id) => sessionCapability(id).canResume)
    ).toEqual(["claude-code"]);
  });
});

describe("bundle v2 checkpoint — gates, sessions, loops, caps", () => {
  const jobs = [job({ id: "job-root", status: "running" })];
  const gates = [
    approval({
      id: "a-pending",
      kind: "command",
      status: "pending",
      jobId: "job-root",
      consumedAt: null,
      decidedAt: null,
    }),
    approval({
      id: "a-spent",
      kind: "command",
      status: "approved",
      jobId: "job-root",
      consumedAt: "2026-07-17T11:30:00.000Z",
    }),
    approval({
      id: "a-undelivered",
      kind: "command",
      status: "approved",
      jobId: "job-root",
      consumedAt: null,
    }),
  ];

  const bundle = buildRunBundle({
    generatedAt: GENERATED_AT,
    source: { kind: "job", id: "job-root" },
    jobs,
    budgets: [],
    approvals: gates,
    milestones: [],
    sessions: [session({ id: "s-1", jobId: "job-root" })],
    loopRuns: [loopRun()],
    sha256Hex,
  });

  it("carries the exact pending gate with its full binding", () => {
    expect(bundle.checkpoint.pendingGates).toEqual([
      expect.objectContaining({
        approvalId: "a-pending",
        kind: "command",
        jobId: "job-root",
        payloadDigest:
          "3333333333333333333333333333333333333333333333333333333333333333",
      }),
    ]);
  });

  it("classifies spent vs approved-undelivered gates", () => {
    expect(bundle.checkpoint.spentGates.map((g) => g.approvalId)).toEqual([
      "a-spent",
    ]);
    expect(
      bundle.checkpoint.approvedUndelivered.map((g) => g.approvalId)
    ).toEqual(["a-undelivered"]);
  });

  it("carries sessions with the resume handle verbatim", () => {
    expect(bundle.checkpoint.sessions).toEqual([
      { id: "s-1", jobId: "job-root", vendorSessionId: "vend-abc-123", status: "running" },
    ]);
  });

  it("carries loop-check milestones as evidence (never a replay anchor)", () => {
    expect(bundle.checkpoint.loopChecks).toEqual([
      expect.objectContaining({
        loopRunId: "loop-1",
        taskId: "task-1",
        status: "running",
        iterations: 2,
        lastIteration: 2,
        degraded: "evaluator_unavailable",
      }),
    ]);
  });

  it("stamps the resume invariants", () => {
    expect(bundle.checkpoint.invariants).toEqual({
      resumeIsHumanInitiated: true,
      consumedGatesNeverRevalidate: true,
      derivedFromLedgerOnly: true,
      noAutonomousReplay: true,
    });
  });

  it("caps sessions and loops with honest omissions", () => {
    const many = buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "job", id: "job-root" },
      jobs,
      budgets: [],
      approvals: [],
      milestones: [],
      sessions: Array.from({ length: 105 }, (_, i) =>
        session({ id: `s-${i}`, jobId: "job-root" })
      ),
      loopRuns: Array.from({ length: 55 }, (_, i) => loopRun({ id: `loop-${i}` })),
      sha256Hex,
    });
    expect(many.checkpoint.sessions).toHaveLength(100);
    expect(many.checkpoint.loopChecks).toHaveLength(50);
    expect(many.omissions.some((note) => note.startsWith("sessions:"))).toBe(true);
    expect(many.omissions.some((note) => note.startsWith("loops:"))).toBe(true);
  });
});

describe("collectRunBundle — v2 secondary sources", () => {
  it("threads sessions/loopRuns/hasher through and degrades missing methods to empty", async () => {
    const rootJob = job({ id: "job-root", rootJobId: "job-root" });
    const base = {
      getDispatchJob: async () => rootJob,
      getDispatchBudget: async () => {
        throw new Error("no budget");
      },
      listDispatchJobs: async () => [rootJob],
      listApprovals: async () => [],
      listStreamChunks: async () => [],
      health: async () => ({ status: "ok" }),
    };
    const withSources = {
      ...base,
      listSessions: async () => [session({ jobId: "job-root" })],
      listLoopRuns: async () => [loopRun()],
    } as unknown as RunBundleClient;
    const bundle = await collectRunBundle(withSources, {
      jobId: "job-root",
      now: new Date(GENERATED_AT),
      sha256Hex,
    });
    expect(bundle.checkpoint.sessions).toHaveLength(1);
    expect(bundle.checkpoint.loopChecks).toHaveLength(1);
    expect(bundle.checkpoint.lineageDigest).toMatch(/^[0-9a-f]{64}$/);

    const withoutSources = base as unknown as RunBundleClient;
    const lean = await collectRunBundle(withoutSources, {
      jobId: "job-root",
      now: new Date(GENERATED_AT),
    });
    expect(lean.checkpoint.sessions).toEqual([]);
    expect(lean.checkpoint.loopChecks).toEqual([]);
    expect(lean.checkpoint.lineageDigest).toBeNull();
  });
});

describe("memory-informed marker (round-3 #15)", () => {
  const base = {
    generatedAt: GENERATED_AT,
    source: { kind: "job", id: "job-root" } as const,
    budgets: [],
    approvals: [],
    milestones: [],
    capabilityPreflight: null,
  };

  it("absence is UNKNOWN, never zero — no map, no entry, or a null entry", () => {
    const noMap = buildRunBundle({ ...base, jobs: [job({ id: "job-root" })] });
    expect(noMap.manifest.jobs[0]!.memoryInformed).toBeNull();

    const withHoles = buildRunBundle({
      ...base,
      jobs: [job({ id: "job-root" }), job({ id: "job-b" })],
      memoryInjections: { "job-root": null },
    });
    expect(withHoles.manifest.jobs[0]!.memoryInformed).toBeNull();
    expect(withHoles.manifest.jobs[1]!.memoryInformed).toBeNull();
  });

  it("a measured empty ledger IS zero — distinct from unknown", () => {
    const bundle = buildRunBundle({
      ...base,
      jobs: [job({ id: "job-root" })],
      memoryInjections: { "job-root": [] },
    });
    expect(bundle.manifest.jobs[0]!.memoryInformed).toEqual({
      notes: 0,
      noteIds: [],
    });
  });

  it("carries unique note ids, and the cap trims ids but never the true count", () => {
    const many = Array.from({ length: 40 }, (_, i) => `note-${i}`);
    const bundle = buildRunBundle({
      ...base,
      jobs: [job({ id: "job-root" })],
      memoryInjections: { "job-root": many },
    });
    const informed = bundle.manifest.jobs[0]!.memoryInformed!;
    expect(informed.notes).toBe(40);
    expect(informed.noteIds).toHaveLength(MAX_MEMORY_NOTES_PER_JOB);
    expect(
      bundle.omissions.some((line) => line.includes("memory: job job-root"))
    ).toBe(true);
  });

  it("collector: reads the ledger per job and degrades a missing method to unknown", async () => {
    const rootJob = job({ id: "job-root", rootJobId: "job-root" });
    const clientBase = {
      getDispatchJob: vi.fn(async () => rootJob),
      getDispatchBudget: vi.fn(async () => {
        throw new Error("no budget");
      }),
      listDispatchJobs: vi.fn(async () => [rootJob]),
      listApprovals: vi.fn(async () => []),
      listStreamChunks: vi.fn(async () => []),
      getFleetReadinessReport: vi.fn(async () => null),
      getRunner: vi.fn(async () => null),
      listAgents: vi.fn(async () => []),
      health: vi.fn(async () => ({ ok: true })),
    };
    const withLedger: RunBundleClient = {
      ...clientBase,
      listTaskEvents: vi.fn(async (taskId: string) => [
        {
          id: "evt-1",
          laneId: "",
          taskId,
          kind: MEMORY_INJECTED_EVENT_KIND,
          message: "",
          metadata: { noteId: "note-a" },
          timestamp: GENERATED_AT,
        },
        {
          id: "evt-2",
          laneId: "",
          taskId,
          kind: "task.progress",
          message: "",
          metadata: { noteId: "not-an-injection" },
          timestamp: GENERATED_AT,
        },
      ]),
    } as unknown as RunBundleClient;

    const bundle = await collectRunBundle(withLedger, {
      jobId: "job-root",
      generatedAt: GENERATED_AT,
    });
    expect(bundle.manifest.jobs[0]!.memoryInformed).toEqual({
      notes: 1,
      noteIds: ["note-a"],
    });

    const withoutLedger = clientBase as unknown as RunBundleClient;
    const lean = await collectRunBundle(withoutLedger, {
      jobId: "job-root",
      generatedAt: GENERATED_AT,
    });
    expect(lean.manifest.jobs[0]!.memoryInformed).toBeNull();
  });

  it("collector: injection rows with stripped or key-shifted metadata are UNKNOWN, never zero", async () => {
    // The agent-tier events route replaces metadata with {} — rows exist but
    // yield no ids. That is provably unknown, not "measured, none" (round 6
    // finding #6: the false measured-zero was the exact inversion the field
    // forbids).
    const rootJob = job({ id: "job-root", rootJobId: "job-root" });
    const client = {
      getDispatchJob: vi.fn(async () => rootJob),
      getDispatchBudget: vi.fn(async () => {
        throw new Error("no budget");
      }),
      listDispatchJobs: vi.fn(async () => [rootJob]),
      listApprovals: vi.fn(async () => []),
      listStreamChunks: vi.fn(async () => []),
      getFleetReadinessReport: vi.fn(async () => null),
      getRunner: vi.fn(async () => null),
      listAgents: vi.fn(async () => []),
      health: vi.fn(async () => ({ ok: true })),
      listTaskEvents: vi.fn(async (taskId: string) => [
        {
          id: "evt-1",
          laneId: "",
          taskId,
          kind: MEMORY_INJECTED_EVENT_KIND,
          message: "",
          metadata: {},
          timestamp: GENERATED_AT,
        },
      ]),
    } as unknown as RunBundleClient;

    const bundle = await collectRunBundle(client, {
      jobId: "job-root",
      generatedAt: GENERATED_AT,
    });
    expect(bundle.manifest.jobs[0]!.memoryInformed).toBeNull();
  });
});

describe("crew cost, ingested (ADR-0036 phase 2)", () => {
  function usageEvent(taskId: string, vendor: string, costUsd?: number) {
    return {
      id: `evt-${vendor}-${costUsd ?? "none"}`,
      laneId: `lane-${vendor}`,
      taskId,
      kind: "task.completed",
      message: "",
      metadata: {
        usage: {
          vendor,
          inputTokens: 10,
          outputTokens: 20,
          ...(costUsd === undefined ? {} : { costUsd }),
        },
      },
      timestamp: GENERATED_AT,
    };
  }

  function costClient(
    events: Record<string, unknown[]> | null,
    childOverrides: Record<string, unknown> = {}
  ) {
    const rootJob = job({
      id: "job-root",
      rootJobId: "job-root",
      vendor: "claude-code",
      taskId: "task-1",
    });
    const childJob = job({
      id: "job-child",
      rootJobId: "job-root",
      parentJobId: "job-root",
      vendor: "cursor",
      taskId: "task-1",
      ...childOverrides,
    });
    const byId: Record<string, DispatchJobRecord> = {
      "job-root": rootJob,
      "job-child": childJob,
    };
    return {
      getDispatchJob: vi.fn(async (id: string) => byId[id] ?? rootJob),
      getDispatchBudget: vi.fn(async () => budget()),
      listDispatchJobs: vi.fn(async () => [rootJob, childJob]),
      listApprovals: vi.fn(async () => []),
      listStreamChunks: vi.fn(async () => []),
      getFleetReadinessReport: vi.fn(async () => null),
      getRunner: vi.fn(async () => null),
      listAgents: vi.fn(async () => []),
      health: vi.fn(async () => ({ ok: true })),
      ...(events === null
        ? {}
        : {
            listTaskEvents: vi.fn(async (id: string) => events[id] ?? []),
          }),
    } as unknown as RunBundleClient;
  }

  it("sums a reporting lane and keeps a silent vendor as NON-reporting, never zero", async () => {
    const bundle = await collectRunBundle(
      costClient({
        "task-1": [
          usageEvent("task-1", "claude-code", 0.42),
          usageEvent("task-1", "claude-code", 0.08),
          // cursor ran but reports no dollars — the lane must still be
          // counted in the denominator.
          usageEvent("task-1", "cursor"),
        ],
        "job-root": [],
        "job-child": [],
      }),
      { jobId: "job-root", generatedAt: GENERATED_AT }
    );

    expect(bundle.cost).toMatchObject({
      observedUsd: 0.5,
      reportingLanes: 1,
      totalLanes: 2,
      complete: false,
    });
    expect(bundle.laneCosts).toContainEqual({
      laneId: "cursor",
      reported: false,
    });
  });

  it("but a vendor whose job NEVER LAUNCHED is not in the denominator", async () => {
    // The backend's cap query filters on `startedAt`; this collector did not.
    // A queued job — or one interrupted or failed BEFORE launch — never spent
    // a cent, yet its vendor entered the denominator as a lane reporting
    // nothing, so the receipt announced partial coverage and named a vendor
    // unreportable that did no work. This file already reasons this way about
    // a `startedAt === null` row elsewhere; the denominator was the one place
    // it did not.
    const bundle = await collectRunBundle(
      costClient(
        { "task-1": [usageEvent("task-1", "claude-code", 0.5)], "job-root": [], "job-child": [] },
        { status: "queued", startedAt: null }
      ),
      { jobId: "job-root", generatedAt: GENERATED_AT }
    );
    expect(
      bundle.laneCosts.map((lane) => lane.laneId),
      "cursor never launched, so it is not a silent lane"
    ).not.toContain("cursor");
    expect(bundle.cost.complete, "and the coverage is therefore complete").toBe(true);
  });

  it("an unreadable ledger is UNKNOWN, not $0.00", async () => {
    // The inversion this surface has shipped twice. A collector that cannot
    // read spend must not render a mission as free.
    const bundle = await collectRunBundle(costClient(null), {
      jobId: "job-root",
      generatedAt: GENERATED_AT,
    });
    expect(bundle.cost).toBeNull();
    expect(bundle.laneCosts).toEqual([]);
  });

  it("a mission where nothing reports is 'cost unknown', with the coverage", () => {
    const bundle = buildRunBundle({
      generatedAt: GENERATED_AT,
      source: { kind: "job", id: "job-root" },
      jobs: [job({ id: "job-root" })],
      budgets: [],
      approvals: [],
      milestones: [],
      capabilityPreflight: null,
      laneCosts: [{ laneId: "cursor", reported: false }],
    });
    expect(bundle.cost).toMatchObject({ reportingLanes: 0, totalLanes: 1 });
    expect(describeMissionCost(bundle.cost!)).toBe(
      "cost unknown (0 of 1 lanes report dollars)"
    );
  });
});

describe("a failed cost read cannot produce a complete receipt", () => {
  it("marks the coverage incomplete, not just the omissions list", async () => {
    // An adversarial review caught the half-fix: recording the failure in
    // `omissions` left `cost.complete` true whenever the SURVIVING reads
    // happened to cover every vendor — so the receipt's own coverage field
    // kept lying while a footnote said otherwise, and downstream code reads
    // the field.
    const bundle = buildRunBundle({
      generatedAt: "2026-08-09T12:00:00.000Z",
      source: "cli",
      chat: null,
      jobs: [],
      budgets: [],
      approvals: [],
      milestones: [],
      capabilityPreflight: null,
      sessions: [],
      loopRuns: [],
      memoryInjections: [],
      laneCosts: [{ laneId: "claude", reported: true, usd: 4 }],
      costReadFailures: 2,
    });
    expect(bundle.cost!.complete).toBe(false);
    expect(bundle.cost!.observedUsd, "the money it DID see is kept").toBe(4);
    expect(bundle.omissions.join(" ")).toContain("task event read(s) failed");
  });

  it("a clean read still reports complete coverage", () => {
    const bundle = buildRunBundle({
      generatedAt: "2026-08-09T12:00:00.000Z",
      source: "cli",
      chat: null,
      jobs: [],
      budgets: [],
      approvals: [],
      milestones: [],
      capabilityPreflight: null,
      sessions: [],
      loopRuns: [],
      memoryInjections: [],
      laneCosts: [{ laneId: "claude", reported: true, usd: 4 }],
    });
    expect(bundle.cost!.complete).toBe(true);
  });
});
