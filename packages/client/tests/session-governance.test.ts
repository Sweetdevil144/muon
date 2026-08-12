import { describe, expect, it } from "vitest";
import { buildSessionGovernance } from "../src/session-governance.js";
import type { ApprovalRequest } from "../src/types.js";

const base: ApprovalRequest = {
  id: "approval-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "command",
  reason: "Apply the bounded parser fix",
  status: "pending",
  evidence: {
    action: "Edit",
    scope: "src/parser/bounded.ts",
    impactIfApproved: "Writes the bounded parser fix to disk.",
    riskLevel: "medium",
    details: { path: "src/parser/bounded.ts" },
    payloadDigest: "abc123",
  },
};

const job = { id: "job-1", taskId: "task-1", vendor: "codex" };

describe("buildSessionGovernance (Wave 4.1 inline gate)", () => {
  it("no job → never blocked, no gates", () => {
    const g = buildSessionGovernance({ job: null, approvals: [base] });
    expect(g.blocked).toBe(false);
    expect(g.gates).toEqual([]);
    expect(g.headline).toMatch(/No decision pending/);
  });

  it("a pending approval bound to this exact job → a blocked, content-bound gate", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [{ ...base, jobId: "job-1" }],
    });
    expect(g.blocked).toBe(true);
    expect(g.gates).toHaveLength(1);
    expect(g.gates[0]!.approvalId).toBe("approval-1");
    expect(g.gates[0]!.boundToJob).toBe(true);
    // Governed projection rides through buildApprovalReview (exact server binding).
    expect(g.gates[0]!.review.action).toBe("Edit");
    expect(g.gates[0]!.review.scope).toBe("src/parser/bounded.ts");
    expect(g.headline).toMatch(/1 decision pending .* paused/);
  });

  it("legacy row (no jobId) falls back to task scope — never hide a pending gate", () => {
    const g = buildSessionGovernance({ job, approvals: [base] }); // no jobId
    expect(g.blocked).toBe(true);
    expect(g.gates[0]!.boundToJob).toBe(false);
  });

  it("a gate filed by a DIFFERENT job on the same task is NOT shown here (precise binding wins)", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [{ ...base, jobId: "job-OTHER" }],
    });
    expect(g.blocked).toBe(false);
    expect(g.gates).toEqual([]);
  });

  it("only PENDING requests are live gates; decided/consumed ones are history", () => {
    for (const status of ["approved", "rejected"] as const) {
      const g = buildSessionGovernance({
        job,
        approvals: [{ ...base, jobId: "job-1", status }],
      });
      expect(g.blocked).toBe(false);
      expect(g.gates).toEqual([]);
    }
  });

  it("an approval on a different task is excluded", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [{ ...base, taskId: "task-OTHER" }],
    });
    expect(g.gates).toEqual([]);
  });

  it("multiple pending gates → plural, fail-closed headline", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [
        { ...base, id: "a1", jobId: "job-1" },
        { ...base, id: "a2", jobId: "job-1", reason: "Run the test suite" },
      ],
    });
    expect(g.gates).toHaveLength(2);
    expect(g.headline).toMatch(/2 decisions pending .* paused/);
  });

  it("a fleet gate tag projects the governed action label", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [
        {
          id: "fleet-1",
          taskId: "task-1",
          jobId: "job-1",
          requestedBy: "human:desktop",
          kind: "gate",
          reason: "Resize the local fleet",
          status: "pending",
          gateTag: "[gate:set_fleet claude-code=1,codex=2]",
        },
      ],
    });
    expect(g.gates[0]!.review.action).toBe("Resize local agent fleet");
    expect(g.blocked).toBe(true);
  });
});

// P0-1 — with standing operator consent ON, a filed gate is NOT a human pause:
// MUON is about to resolve it as the operator through the same governed path a
// click uses. Calling it "paused until you decide, nothing runs on your behalf"
// was false, and the operator saw that false sentence for a whole poll cycle
// before the grant landed. The projection now picks the true one.
describe("buildSessionGovernance under Full Auto", () => {
  const bound = { ...base, jobId: "job-1" };

  it("is byte-identical when the caller passes no Full-Auto input", () => {
    const g = buildSessionGovernance({ job, approvals: [bound] });
    expect(g.blocked).toBe(true);
    expect(g.gates).toHaveLength(1);
    expect(g.autoApproving).toEqual([]);
    expect(g.autoHeadline).toBe("");
  });

  it("moves a POSITIVELY covered gate out of the human column", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [bound],
      fullAuto: { enabled: true, coveredApprovalIds: ["approval-1"] },
    });
    expect(g.blocked).toBe(false);
    expect(g.gates).toEqual([]);
    expect(g.autoApproving).toHaveLength(1);
    // Nothing is dropped: the same governed projection is still carried.
    expect(g.autoApproving[0]!.review.action).toBe("Edit");
    expect(g.autoHeadline).toMatch(/1 decision approving automatically/);
    expect(g.headline).toMatch(/No decision pending/);
  });

  // F7: the calm label used to be the DEFAULT — enabled + not-yet-uncovered
  // earned "approving automatically" before any classifier had seen the id.
  // The approvals fetch and the auto-approver run on independent cadences, so
  // every brand-new gate wore the calm label for the gap. Absence from the
  // covered list must present as an ordinary fail-closed human gate.
  it("an UNCLASSIFIED gate (on neither list) stays a human gate", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [bound],
      fullAuto: { enabled: true },
    });
    expect(g.blocked).toBe(true);
    expect(g.gates).toHaveLength(1);
    expect(g.autoApproving).toEqual([]);
    expect(g.headline).toMatch(/1 decision pending .* paused/);
  });

  it("covered AND uncovered disagreeing → the gate wins", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [bound],
      fullAuto: {
        enabled: true,
        coveredApprovalIds: ["approval-1"],
        uncoveredApprovalIds: ["approval-1"],
      },
    });
    expect(g.blocked).toBe(true);
    expect(g.autoApproving).toEqual([]);
  });

  it("keeps an UNCOVERED gate fail-closed — uncertainty resolves toward the gate", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [bound],
      fullAuto: { enabled: true, uncoveredApprovalIds: ["approval-1"] },
    });
    expect(g.blocked).toBe(true);
    expect(g.gates).toHaveLength(1);
    expect(g.autoApproving).toEqual([]);
    expect(g.headline).toMatch(/1 decision pending .* paused/);
  });

  it("splits a mixed set rather than letting one refusal calm the others", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [
        bound,
        { ...base, id: "approval-2", jobId: "job-1" },
        { ...base, id: "approval-3", jobId: "job-1" },
      ],
      fullAuto: {
        enabled: true,
        coveredApprovalIds: ["approval-1", "approval-2", "approval-3"],
        uncoveredApprovalIds: ["approval-2"],
      },
    });
    expect(g.gates.map((gate) => gate.approvalId)).toEqual(["approval-2"]);
    expect(g.autoApproving.map((gate) => gate.approvalId)).toEqual([
      "approval-1",
      "approval-3",
    ]);
    expect(g.blocked).toBe(true);
    expect(g.autoHeadline).toMatch(/2 decisions approving automatically/);
  });

  it("an explicitly DISABLED Full Auto never calms a gate", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [bound],
      fullAuto: {
        enabled: false,
        coveredApprovalIds: ["approval-1"],
        uncoveredApprovalIds: [],
      },
    });
    expect(g.blocked).toBe(true);
    expect(g.autoApproving).toEqual([]);
  });

  it("a non-pending approval is still history, never an auto-approving card", () => {
    const g = buildSessionGovernance({
      job,
      approvals: [{ ...bound, status: "approved" }],
      fullAuto: { enabled: true, coveredApprovalIds: ["approval-1"] },
    });
    expect(g.gates).toEqual([]);
    expect(g.autoApproving).toEqual([]);
  });
});
