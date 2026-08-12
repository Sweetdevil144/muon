import { describe, expect, it, vi } from "vitest";
import { handoffPacketSchema, workflowProposalSchema } from "@muon/protocol";
import {
  runWorkflowRun,
  type WorkflowLedger,
  type WorkflowTaskRef,
} from "../src/workflow-runner.js";

const PROPOSAL = workflowProposalSchema.parse({
  summary: "bugfix: rate limiter",
  templateKey: "bugfix",
  steps: [
    {
      stepKey: "reproduce",
      title: "Reproduce with a failing test",
      brief: "Write the failing test.",
      role: "suggest",
      laneKey: "claude-code",
      harnessKey: "implement",
      handoffTo: "fix",
    },
    {
      stepKey: "fix",
      title: "Fix until checks pass",
      brief: "Make the test pass.",
      role: "suggest",
      laneKey: "codex",
      harnessKey: "repair",
      gate: "gate",
    },
    {
      stepKey: "ship",
      title: "Ship review",
      brief: "Approve the merge.",
      role: "human",
      gate: "merge",
    },
  ],
});

function makeTasks(overrides?: Partial<Record<string, string>>): WorkflowTaskRef[] {
  return [
    {
      id: "task-a",
      stepKey: "reproduce",
      status: overrides?.reproduce ?? "backlog",
      title: "Reproduce",
      description: "Write the failing test.",
    },
    {
      id: "task-b",
      stepKey: "fix",
      status: overrides?.fix ?? "backlog",
      title: "Fix",
      description: "Make the test pass.",
    },
    {
      id: "task-c",
      stepKey: "ship",
      status: overrides?.ship ?? "backlog",
      title: "Ship",
      description: "Approve the merge.",
    },
  ];
}

function makeLedger(options?: { rejectApprovalIds?: string[] }) {
  const events: { kind: string; taskId: string; message: string }[] = [];
  const approvals: {
    id: string;
    kind: string;
    taskId: string;
    reason: string;
  }[] = [];
  const handoffs: { taskId: string; fromLaneId: string; toLaneId: string }[] = [];
  const handoffWrites: {
    packetTitle: string;
    packetBody: string;
    packet?: unknown;
  }[] = [];
  const statusUpdates: { taskId: string; status: string }[] = [];
  const runStatuses: string[] = [];
  let approvalCount = 0;

  const ledger: WorkflowLedger = {
    updateRunStatus: vi.fn(async (input) => {
      runStatuses.push(input.status);
    }),
    recordEvent: vi.fn(async (event) => {
      events.push({
        kind: event.kind,
        taskId: event.taskId,
        message: event.message,
      });
    }),
    requestApproval: vi.fn(async (input) => {
      approvalCount += 1;
      const id = `approval-${approvalCount}`;
      approvals.push({
        id,
        kind: input.kind,
        taskId: input.taskId,
        reason: input.reason,
      });
      return { id };
    }),
    waitForApproval: vi.fn(async (approvalId) => {
      if (options?.rejectApprovalIds?.includes(approvalId)) {
        throw new Error("approval approval-1 was rejected");
      }
    }),
    assignTask: vi.fn(async () => undefined),
    updateTaskStatus: vi.fn(async (taskId, status) => {
      statusUpdates.push({ taskId, status });
    }),
    createHandoff: vi.fn(async (input) => {
      handoffs.push({
        taskId: input.taskId,
        fromLaneId: input.fromLaneId,
        toLaneId: input.toLaneId,
      });
      handoffWrites.push({
        packetTitle: input.packetTitle,
        packetBody: input.packetBody,
        packet: input.packet,
      });
    }),
    resolveLaneId: vi.fn(async (laneKey) => `lane-${laneKey}`),
  };

  return {
    ledger,
    events,
    approvals,
    handoffs,
    handoffWrites,
    statusUpdates,
    runStatuses,
  };
}

describe("runWorkflowRun", () => {
  it("runs steps in order with gates, handoffs, and completion events", async () => {
    const { ledger, events, approvals, handoffs, runStatuses } = makeLedger();
    const dispatched: string[] = [];

    const outcome = await runWorkflowRun({
      runId: "run-1",
      proposal: PROPOSAL,
      tasks: makeTasks(),
      ledger,
      dispatch: async ({ step }) => {
        dispatched.push(step.stepKey);
        return { ok: true, summary: `${step.stepKey} done` };
      },
    });

    expect(outcome.status).toBe("done");
    expect(outcome.completedSteps).toEqual(["reproduce", "fix", "ship"]);
    // Human steps are never dispatched to a lane.
    expect(dispatched).toEqual(["reproduce", "fix"]);
    // Gates: one `gate` after fix, one `merge` on the human ship step.
    expect(approvals.map((a) => a.kind)).toEqual(["gate", "merge"]);
    // Cross-lane handoff reproduce(claude-code) -> fix(codex).
    expect(handoffs).toEqual([
      {
        taskId: "task-b",
        fromLaneId: "lane-claude-code",
        toLaneId: "lane-codex",
      },
    ]);
    expect(events.map((e) => e.kind)).toContain("workflow.step.started");
    expect(events.map((e) => e.kind)).toContain("workflow.step.completed");
    expect(runStatuses).toEqual(["running", "done"]);
  });

  it("hands off a typed v2 packet, honestly degraded when dispatch carried no evidence", async () => {
    const { ledger, handoffWrites } = makeLedger();

    const outcome = await runWorkflowRun({
      runId: "run-typed",
      proposal: PROPOSAL,
      tasks: makeTasks(),
      ledger,
      dispatch: async ({ step }) => ({
        ok: true,
        summary: `${step.stepKey} done`,
      }),
    });

    expect(outcome.status).toBe("done");
    expect(handoffWrites).toHaveLength(1);
    const write = handoffWrites[0]!;
    expect(write.packetTitle).toBe("Workflow handoff: reproduce -> fix");
    expect(write.packet).toBeDefined();
    const packet = handoffPacketSchema.parse(write.packet);
    expect(packet.schemaVersion).toBe(2);
    // taskGoal is the RECEIVING step's goal.
    expect(packet.taskGoal).toBe("Make the test pass.");
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("no_check_evidence");
    expect(packet.degraded.reasons).toContain("no_diff_evidence");
    expect(packet.recommendedNextAction).toContain("fix");
    // Compat: the body stays rendered markdown of the same packet.
    expect(write.packetBody).toContain("## Task goal");
    expect(write.packetBody).toContain("Make the test pass.");
  });

  it("carries dispatch evidence (checks, changed files, diff hash) into the handoff packet", async () => {
    const { ledger, handoffWrites } = makeLedger();
    const diffHash = `sha256:${"d".repeat(64)}`;

    const outcome = await runWorkflowRun({
      runId: "run-evidence",
      proposal: PROPOSAL,
      tasks: makeTasks(),
      ledger,
      dispatch: async ({ step }) => ({
        ok: true,
        summary: `${step.stepKey} done`,
        changedFiles: ["a.ts"],
        checks: [
          {
            name: "unit tests",
            command: "npm test",
            outcome: "passed" as const,
            exitCode: 0,
            summary: "green",
          },
        ],
        diff: { hash: diffHash, totalBytes: 321 },
      }),
    });

    expect(outcome.status).toBe("done");
    expect(handoffWrites).toHaveLength(1);
    const packet = handoffPacketSchema.parse(handoffWrites[0]!.packet);
    expect(packet.changedFiles).toEqual(["a.ts"]);
    expect(packet.checks).toHaveLength(1);
    expect(packet.checks[0]).toMatchObject({
      name: "unit tests",
      outcome: "passed",
      exitCode: 0,
    });
    expect(packet.diffHash).toBe(diffHash);
    expect(packet.diffVerified).toBe(true);
    expect(packet.degraded.flag).toBe(false);
    expect(handoffWrites[0]!.packetBody).toContain("## Evidence");
  });

  it("falls back to a prose-only handoff when the receiving brief is too short for a packet", async () => {
    // A human can edit a step brief down to 1 char: the proposal schema allows
    // brief min(1) but the packet taskGoal requires min(3), so packet
    // construction throws. A completed step must not become a failure over it.
    const proposal = workflowProposalSchema.parse({
      summary: "short brief handoff",
      steps: [
        {
          stepKey: "reproduce",
          title: "Reproduce",
          brief: "Write the failing test.",
          role: "suggest",
          laneKey: "claude-code",
          handoffTo: "fix",
        },
        {
          stepKey: "fix",
          title: "Fix",
          brief: "a", // valid proposal, invalid packet taskGoal (min 3)
          role: "suggest",
          laneKey: "codex",
        },
      ],
    });
    const { ledger, handoffWrites } = makeLedger();

    const outcome = await runWorkflowRun({
      runId: "run-shortbrief",
      proposal,
      tasks: [
        {
          id: "task-a",
          stepKey: "reproduce",
          status: "backlog",
          title: "Reproduce",
          description: "Write the failing test.",
        },
        {
          id: "task-b",
          stepKey: "fix",
          status: "backlog",
          title: "Fix",
          description: "a",
        },
      ],
      ledger,
      dispatch: async ({ step }) => ({
        ok: true,
        summary: `${step.stepKey} done`,
      }),
    });

    // The successful step terminal is preserved; packet construction did not
    // turn it into a failure.
    expect(outcome.status).toBe("done");
    expect(outcome.completedSteps).toEqual(["reproduce", "fix"]);
    expect(handoffWrites).toHaveLength(1);
    const write = handoffWrites[0]!;
    // Prose-only fallback: the typed packet is omitted, the body still lands.
    expect(write.packet).toBeUndefined();
    expect(write.packetTitle).toBe("Workflow handoff: reproduce -> fix");
    expect(write.packetBody).toContain("reproduce");
  });

  it("resumes from ledger state: completed steps are not re-dispatched", async () => {
    const { ledger } = makeLedger();
    const dispatched: string[] = [];

    const outcome = await runWorkflowRun({
      runId: "run-1",
      proposal: PROPOSAL,
      tasks: makeTasks({ reproduce: "review" }),
      ledger,
      dispatch: async ({ step }) => {
        dispatched.push(step.stepKey);
        return { ok: true, summary: "ok" };
      },
    });

    expect(outcome.status).toBe("done");
    expect(dispatched).toEqual(["fix"]);
    expect(outcome.completedSteps).toEqual(["reproduce", "fix", "ship"]);
  });

  it("pauses (fail closed) when a gate is rejected", async () => {
    const { ledger, runStatuses } = makeLedger({
      rejectApprovalIds: ["approval-1"],
    });

    const outcome = await runWorkflowRun({
      runId: "run-1",
      proposal: PROPOSAL,
      tasks: makeTasks(),
      ledger,
      dispatch: async () => ({ ok: true, summary: "ok" }),
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.pausedAt).toBe("fix");
    expect(outcome.reason).toContain("gate not approved");
    expect(runStatuses).toEqual(["running", "paused"]);
  });

  it("escalates a failed step to a gate approval and pauses", async () => {
    const { ledger, approvals } = makeLedger();

    const outcome = await runWorkflowRun({
      runId: "run-1",
      proposal: PROPOSAL,
      tasks: makeTasks(),
      ledger,
      dispatch: async ({ step }) =>
        step.stepKey === "reproduce"
          ? { ok: false, summary: "loop escalated: budget exhausted" }
          : { ok: true, summary: "ok" },
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.pausedAt).toBe("reproduce");
    expect(approvals[0]).toMatchObject({ kind: "gate", taskId: "task-a" });
  });

  it("pauses when a non-human step has no lane resolved", async () => {
    const proposal = workflowProposalSchema.parse({
      summary: "unassigned",
      steps: [
        {
          stepKey: "solo",
          title: "Unassigned step",
          brief: "Do the thing.",
          role: "suggest",
        },
      ],
    });
    const { ledger } = makeLedger();

    const outcome = await runWorkflowRun({
      runId: "run-2",
      proposal,
      tasks: [
        {
          id: "task-x",
          stepKey: "solo",
          status: "backlog",
          title: "Unassigned",
          description: "Do the thing.",
        },
      ],
      ledger,
      dispatch: async () => ({ ok: true, summary: "ok" }),
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.reason).toContain("no lane assigned");
  });

  it("runs an explicitly independent, disjoint 2-step group concurrently after a human gate", async () => {
    const proposal = workflowProposalSchema.parse({
      summary: "parallel auth and docs",
      steps: [
        {
          stepKey: "auth",
          title: "Repair authentication",
          brief: "Repair authentication.",
          role: "suggest",
          laneKey: "codex",
          parallel: {
            group: "independent-fixes",
            independent: true,
            paths: ["src/auth"],
          },
        },
        {
          stepKey: "docs",
          title: "Document authentication",
          brief: "Document authentication.",
          role: "suggest",
          laneKey: "claude-code",
          parallel: {
            group: "independent-fixes",
            independent: true,
            paths: ["docs/auth"],
          },
        },
      ],
    });
    const { ledger, approvals } = makeLedger();
    const dispatched: string[] = [];

    const outcome = await runWorkflowRun({
      runId: "run-parallel",
      proposal,
      tasks: [
        {
          id: "task-auth",
          stepKey: "auth",
          status: "backlog",
          title: "Auth",
          description: "Repair authentication.",
        },
        {
          id: "task-docs",
          stepKey: "docs",
          status: "backlog",
          title: "Docs",
          description: "Document authentication.",
        },
      ],
      ledger,
      dispatch: async ({ step }) => {
        dispatched.push(step.stepKey);
        await Promise.resolve();
        if (step.stepKey === "auth") {
          expect(dispatched).toContain("docs");
        }
        return {
          ok: true,
          summary: `${step.stepKey} done`,
          changedFiles:
            step.stepKey === "auth"
              ? ["src/auth/login.ts"]
              : ["docs/auth/login.md"],
        };
      },
    });

    expect(outcome).toEqual({
      status: "done",
      completedSteps: ["auth", "docs"],
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "gate",
      taskId: "task-auth",
    });
    expect(approvals[0]?.reason).toMatch(
      /parallel group 'independent-fixes'.*src\/auth.*docs\/auth/i
    );
  });

  it("does not start fan-out when its human gate is rejected", async () => {
    const proposal = workflowProposalSchema.parse({
      summary: "gated parallel",
      steps: [
        {
          stepKey: "one",
          title: "First independent edit",
          brief: "Edit the first area.",
          laneKey: "codex",
          parallel: {
            group: "pair",
            independent: true,
            paths: ["src/one"],
          },
        },
        {
          stepKey: "two",
          title: "Second independent edit",
          brief: "Edit the second area.",
          laneKey: "claude-code",
          parallel: {
            group: "pair",
            independent: true,
            paths: ["src/two"],
          },
        },
      ],
    });
    const { ledger } = makeLedger({ rejectApprovalIds: ["approval-1"] });
    const dispatch = vi.fn(async () => ({
      ok: true,
      summary: "done",
      changedFiles: [],
    }));

    const outcome = await runWorkflowRun({
      runId: "run-gated",
      proposal,
      tasks: [
        {
          id: "task-one",
          stepKey: "one",
          status: "backlog",
          title: "One",
          description: "One",
        },
        {
          id: "task-two",
          stepKey: "two",
          status: "backlog",
          title: "Two",
          description: "Two",
        },
      ],
      ledger,
      dispatch,
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.reason).toMatch(/fan-out gate not approved/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects overlapping ownership before dispatch and pauses", async () => {
    const proposal = workflowProposalSchema.parse({
      summary: "colliding parallel",
      steps: [
        {
          stepKey: "one",
          title: "Edit auth routes",
          brief: "Edit auth routes.",
          laneKey: "codex",
          parallel: {
            group: "collision",
            independent: true,
            paths: ["src/auth"],
          },
        },
        {
          stepKey: "two",
          title: "Edit auth login",
          brief: "Edit auth login.",
          laneKey: "claude-code",
          parallel: {
            group: "collision",
            independent: true,
            paths: ["src/auth/login.ts"],
          },
        },
      ],
    });
    const { ledger } = makeLedger();
    const dispatch = vi.fn(async () => ({
      ok: true,
      summary: "done",
      changedFiles: [],
    }));

    const outcome = await runWorkflowRun({
      runId: "run-collision",
      proposal,
      tasks: [
        {
          id: "task-one",
          stepKey: "one",
          status: "backlog",
          title: "One",
          description: "One",
        },
        {
          id: "task-two",
          stepKey: "two",
          status: "backlog",
          title: "Two",
          description: "Two",
        },
      ],
      ledger,
      dispatch,
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.reason).toMatch(/ownership.*overlap/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pauses when a parallel lane edits outside its declared ownership", async () => {
    const proposal = workflowProposalSchema.parse({
      summary: "bounded parallel",
      steps: [
        {
          stepKey: "one",
          title: "Edit owned auth files",
          brief: "Edit auth.",
          laneKey: "codex",
          parallel: {
            group: "bounded",
            independent: true,
            paths: ["src/auth"],
          },
        },
        {
          stepKey: "two",
          title: "Edit owned docs files",
          brief: "Edit docs.",
          laneKey: "claude-code",
          parallel: {
            group: "bounded",
            independent: true,
            paths: ["docs/auth"],
          },
        },
      ],
    });
    const { ledger, approvals } = makeLedger();

    const outcome = await runWorkflowRun({
      runId: "run-bounded",
      proposal,
      tasks: [
        {
          id: "task-one",
          stepKey: "one",
          status: "backlog",
          title: "One",
          description: "One",
        },
        {
          id: "task-two",
          stepKey: "two",
          status: "backlog",
          title: "Two",
          description: "Two",
        },
      ],
      ledger,
      dispatch: async ({ step }) => ({
        ok: true,
        summary: "done",
        changedFiles:
          step.stepKey === "one"
            ? ["src/shared.ts"]
            : ["docs/auth/README.md"],
      }),
    });

    expect(outcome.status).toBe("paused");
    expect(outcome.pausedAt).toBe("one");
    expect(outcome.reason).toMatch(/outside declared ownership.*src\/shared.ts/i);
    expect(approvals.map((approval) => approval.kind)).toEqual(["gate", "gate"]);
  });

  it("rejects malformed fan-out declarations at proposal validation", () => {
    expect(() =>
      workflowProposalSchema.parse({
        summary: "too wide",
        steps: ["a", "b", "c", "d"].map((stepKey) => ({
          stepKey,
          title: `Step ${stepKey}`,
          brief: `Do ${stepKey}`,
          laneKey: "codex",
          parallel: {
            group: "too-wide",
            independent: true,
            paths: [`src/${stepKey}`],
          },
        })),
      })
    ).toThrow(/2-3 steps/i);

    expect(() =>
      workflowProposalSchema.parse({
        summary: "unsafe path",
        steps: [
          {
            stepKey: "a",
            title: "Unsafe path A",
            brief: "Do A",
            laneKey: "codex",
            parallel: {
              group: "unsafe",
              independent: true,
              paths: ["../outside"],
            },
          },
          {
            stepKey: "b",
            title: "Unsafe path B",
            brief: "Do B",
            laneKey: "claude-code",
            parallel: {
              group: "unsafe",
              independent: true,
              paths: ["src/b"],
            },
          },
        ],
      })
    ).toThrow(/relative workspace path/i);

    expect(() =>
      workflowProposalSchema.parse({
        summary: "empty ownership",
        steps: [
          {
            stepKey: "a",
            title: "Empty ownership A",
            brief: "Do A",
            laneKey: "codex",
            parallel: {
              group: "empty",
              independent: true,
              paths: ["./"],
            },
          },
          {
            stepKey: "b",
            title: "Empty ownership B",
            brief: "Do B",
            laneKey: "claude-code",
            parallel: {
              group: "empty",
              independent: true,
              paths: ["src/b"],
            },
          },
        ],
      })
    ).toThrow(/relative workspace path/i);
  });
});
