import { describe, expect, it, vi } from "vitest";
import { waitForApproval } from "../src/lib/approval-gate.js";
import type { ApprovalRequest } from "../src/types.js";

function approval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    requestedBy: "codex",
    kind: "command",
    reason: "muon run gate",
    status: "pending",
    ...overrides,
  };
}

describe("waitForApproval", () => {
  it("resolves once the approval is approved", async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([approval({ status: "pending" })])
      .mockResolvedValueOnce([approval({ status: "approved" })]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForApproval({ listApprovals }, "approval-1", {
      sleep,
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    expect(result.status).toBe("approved");
    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the approval is rejected", async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValue([
        approval({ status: "rejected", decisionNotes: "too risky" }),
      ]);

    await expect(
      waitForApproval({ listApprovals }, "approval-1", {
        sleep: async () => {},
      })
    ).rejects.toThrow(/rejected/i);
  });

  it("fails closed on unknown approval states", async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValue([
        approval({ status: "escalated" as ApprovalRequest["status"] }),
      ]);

    await expect(
      waitForApproval({ listApprovals }, "approval-1", {
        sleep: async () => {},
      })
    ).rejects.toThrow(/unknown/i);
  });

  it("fails closed when the approval disappears from the queue", async () => {
    const listApprovals = vi.fn().mockResolvedValue([]);

    await expect(
      waitForApproval({ listApprovals }, "approval-1", {
        sleep: async () => {},
      })
    ).rejects.toThrow(/fail(ing)? closed/i);
  });

  it("fails closed immediately on a non-finite timeout instead of polling forever", async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValue([approval({ status: "pending" })]);

    await expect(
      waitForApproval({ listApprovals }, "approval-1", {
        sleep: async () => {},
        timeoutMs: Number("not-a-number"),
      })
    ).rejects.toThrow(/invalid.*timeout/i);
    expect(listApprovals).not.toHaveBeenCalled();
  });

  it("fails closed when the wait times out while still pending", async () => {
    const listApprovals = vi
      .fn()
      .mockResolvedValue([approval({ status: "pending" })]);
    let clock = 0;
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    });

    await expect(
      waitForApproval({ listApprovals }, "approval-1", {
        sleep,
        pollIntervalMs: 100,
        timeoutMs: 250,
        now: () => clock,
      })
    ).rejects.toThrow(/timed out/i);
  });
});
