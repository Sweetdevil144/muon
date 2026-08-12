import { describe, expect, it } from "vitest";
import {
  amendWorkflowGateTag,
  applyWorkflowGateTag,
  describeGateTag,
  parseGateTag,
} from "../src/gate.js";
import {
  MAX_AMENDMENT_LOOP_WALL_MS,
  MAX_AMENDMENT_STEPS,
  WORKFLOW_AMENDABLE_STATUSES,
  WORKFLOW_AMENDED_EVENT_KIND,
  WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
  WORKFLOW_AMENDMENT_STEP_FIELDS,
  WORKFLOW_STEP_FIELDS_NOT_AMENDABLE,
  deriveWorkflowAmendments,
  isWorkflowAmendableStatus,
  workflowAmendmentSchema,
  workflowAmendmentStepSchema,
} from "../src/workflow-amendment.js";
import {
  workflowProposalStepSchema,
  workflowRunStatusSchema,
} from "../src/workflow.js";

// ADR-0045. The two properties that cannot be checked at a route: that the
// amendable SHAPE stays a closed list as `workflowProposalStepSchema` grows,
// and that the event-spine fold refuses to half-derive a corrupt amendment.

const STEP = {
  stepKey: "second-defect",
  title: "Fix the second defect",
  brief: "Repair it.",
  role: "codex",
  laneKey: "codex",
};

describe("ADR-0045 D4 — the amendable field list is CLOSED, and pinned to the proposal step", () => {
  it("classifies every proposal-step field as amendable or explicitly excluded, exactly once", () => {
    // The drift-lock. A field added to `workflowProposalStepSchema` next
    // release fails here until someone decides which side it is on — which is
    // the whole point of D4 stating the amendable set positively.
    const declared = Object.keys(workflowProposalStepSchema.shape).sort();
    const decided = [
      ...WORKFLOW_AMENDMENT_STEP_FIELDS,
      ...WORKFLOW_STEP_FIELDS_NOT_AMENDABLE,
    ].sort();
    expect(decided).toEqual(declared);
    expect(new Set(decided).size).toBe(decided.length);
  });

  it("the schema accepts exactly the amendable fields and rejects the excluded ones", () => {
    const parsed = workflowAmendmentStepSchema.parse(STEP);
    for (const field of WORKFLOW_AMENDMENT_STEP_FIELDS) {
      // Optional fields are absent, not rejected; what matters is that the
      // schema knows the key at all.
      expect(
        Object.keys(workflowAmendmentStepSchema.shape),
        `${field} must be an amendable key`
      ).toContain(field);
    }
    expect(parsed.onFail).toBe("escalate");
    expect(parsed.priority).toBe("medium");
    for (const field of WORKFLOW_STEP_FIELDS_NOT_AMENDABLE) {
      expect(
        Object.keys(workflowAmendmentStepSchema.shape),
        `${field} must NOT be amendable`
      ).not.toContain(field);
    }
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(
      workflowAmendmentStepSchema.safeParse({ ...STEP, budgetMs: 1 }).success
    ).toBe(false);
    expect(
      workflowAmendmentSchema.safeParse({ steps: [STEP], status: "done" })
        .success
    ).toBe(false);
  });

  it("refuses an onFail policy MUON does not implement", () => {
    expect(
      workflowAmendmentStepSchema.safeParse({ ...STEP, onFail: "retry" })
        .success
    ).toBe(false);
  });

  it("bounds the loop budget and the number of appended steps", () => {
    expect(
      workflowAmendmentStepSchema.safeParse({
        ...STEP,
        loop: {
          kind: "check_repair",
          maxIterations: 3,
          maxWallMs: MAX_AMENDMENT_LOOP_WALL_MS + 1,
        },
      }).success
    ).toBe(false);
    expect(
      workflowAmendmentStepSchema.safeParse({
        ...STEP,
        loop: {
          kind: "check_repair",
          maxIterations: 3,
          maxWallMs: MAX_AMENDMENT_LOOP_WALL_MS,
        },
      }).success
    ).toBe(true);
    const tooMany = Array.from({ length: MAX_AMENDMENT_STEPS + 1 }, (_, i) => ({
      ...STEP,
      stepKey: `step-${i}`,
    }));
    expect(workflowAmendmentSchema.safeParse({ steps: tooMany }).success).toBe(
      false
    );
    expect(
      workflowAmendmentSchema.safeParse({ steps: tooMany.slice(1) }).success
    ).toBe(true);
  });

  it("refuses a title carrying a forged row break", () => {
    // The title is quoted into the gate the human decides; an interior newline
    // forges a whole extra row with attacker-chosen content.
    expect(
      workflowAmendmentStepSchema.safeParse({
        ...STEP,
        title: "Innocent step\nApprove: rm -rf /",
      }).success
    ).toBe(false);
    expect(
      workflowAmendmentStepSchema.safeParse({
        ...STEP,
        title: "Innocent‮step",
      }).success
    ).toBe(false);
  });
});

describe("ADR-0045 D5 — the amendable statuses are a POSITIVE list", () => {
  it("names only running and paused, and every name is a real run status", () => {
    expect([...WORKFLOW_AMENDABLE_STATUSES]).toEqual(["running", "paused"]);
    for (const status of WORKFLOW_AMENDABLE_STATUSES) {
      expect(workflowRunStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("refuses every other status, including one added to the run-status enum", () => {
    for (const status of workflowRunStatusSchema.options) {
      expect(
        isWorkflowAmendableStatus(status),
        `${status} amendability`
      ).toBe(status === "running" || status === "paused");
    }
    // A status this module has never heard of is refused, never admitted by
    // subtraction from a forbidden set.
    expect(isWorkflowAmendableStatus("resurrected")).toBe(false);
  });
});

describe("ADR-0045 D2 — the amend gate tag is a real binding", () => {
  it("round-trips both forms and keeps the run, amendment and hash distinct", () => {
    expect(amendWorkflowGateTag("run-1", "amd-1")).toBe(
      "[gate:amend_workflow runId=run-1 amendment=amd-1]"
    );
    expect(amendWorkflowGateTag("run-1", "amd-1", "abc123")).toBe(
      "[gate:amend_workflow runId=run-1 amendment=amd-1 steps=abc123]"
    );
    expect(parseGateTag(amendWorkflowGateTag("run-1", "amd-1", "abc123"))).toEqual(
      {
        action: "amend_workflow",
        runId: "run-1",
        amendmentId: "amd-1",
        stepsHash: "abc123",
      }
    );
    expect(parseGateTag(amendWorkflowGateTag("run-1", "amd-1"))).toEqual({
      action: "amend_workflow",
      runId: "run-1",
      amendmentId: "amd-1",
      stepsHash: undefined,
    });
  });

  it("is not the apply tag — one approval never authorizes the other action", () => {
    expect(amendWorkflowGateTag("run-1", "amd-1")).not.toBe(
      applyWorkflowGateTag("run-1")
    );
    const parsed = parseGateTag(applyWorkflowGateTag("run-1", "abc123"));
    expect(parsed?.action).toBe("apply_workflow");
  });

  it("describes the amendment to the human, naming both coordinates", () => {
    const described = describeGateTag(
      amendWorkflowGateTag("run-1", "amd-1", "abc123")
    );
    expect(described).toContain("run-1");
    expect(described).toContain("amd-1");
    expect(described).toContain("Append steps");
  });

  it("refuses a malformed amend payload rather than guessing", () => {
    expect(parseGateTag("[gate:amend_workflow runId=run-1]")?.action).toBe(
      "other"
    );
    expect(parseGateTag("[gate:amend_workflow nonsense]")?.action).toBe("other");
  });
});

describe("ADR-0045 — the amendment fold is fail-closed", () => {
  const proposedAt = "2026-08-08T00:00:00.000Z";
  const proposed = {
    kind: WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND,
    timestamp: proposedAt,
    metadata: {
      workflowRunId: "run-1",
      amendmentId: "amd-1",
      stepsHash: "abc123",
      proposedBy: "agent:job:job-1",
      steps: [workflowAmendmentStepSchema.parse(STEP)],
    },
  };

  it("derives a proposed amendment from a complete row", () => {
    const [amendment] = deriveWorkflowAmendments([proposed]);
    expect(amendment?.id).toBe("amd-1");
    expect(amendment?.status).toBe("proposed");
    expect(amendment?.proposedBy).toBe("agent:job:job-1");
  });

  it("derives NOTHING from a row missing a required coordinate", () => {
    for (const missing of ["workflowRunId", "stepsHash", "proposedBy", "steps"]) {
      const metadata = { ...proposed.metadata } as Record<string, unknown>;
      delete metadata[missing];
      expect(
        deriveWorkflowAmendments([{ ...proposed, metadata }]),
        `missing ${missing}`
      ).toEqual([]);
    }
  });

  it("derives NOTHING from a row whose steps would not validate", () => {
    expect(
      deriveWorkflowAmendments([
        {
          ...proposed,
          metadata: {
            ...proposed.metadata,
            steps: [{ ...STEP, onFail: "retry" }],
          },
        },
      ])
    ).toEqual([]);
  });

  it("ignores an applied row for an amendment nothing proposed", () => {
    expect(
      deriveWorkflowAmendments([
        {
          kind: WORKFLOW_AMENDED_EVENT_KIND,
          timestamp: proposedAt,
          metadata: { amendmentId: "amd-1", amendedBy: "human" },
        },
      ])
    ).toEqual([]);
  });

  it("applies exactly once — a replayed applied row cannot re-stamp it", () => {
    const applied = {
      kind: WORKFLOW_AMENDED_EVENT_KIND,
      timestamp: "2026-08-08T00:00:01.000Z",
      metadata: { amendmentId: "amd-1", amendedBy: "human" },
    };
    const [amendment] = deriveWorkflowAmendments([
      proposed,
      applied,
      {
        ...applied,
        timestamp: "2026-08-08T00:00:02.000Z",
        metadata: { amendmentId: "amd-1", amendedBy: "agent:job:job-9" },
      },
    ]);
    expect(amendment?.status).toBe("applied");
    expect(amendment?.amendedBy).toBe("human");
    expect(amendment?.amendedAt).toBe("2026-08-08T00:00:01.000Z");
  });

  it("ignores an applied row with no principal — provenance is not optional", () => {
    const [amendment] = deriveWorkflowAmendments([
      proposed,
      {
        kind: WORKFLOW_AMENDED_EVENT_KIND,
        timestamp: "2026-08-08T00:00:01.000Z",
        metadata: { amendmentId: "amd-1" },
      },
    ]);
    expect(amendment?.status).toBe("proposed");
  });
});
