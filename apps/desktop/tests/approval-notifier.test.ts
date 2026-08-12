import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@muon/client";
import { createApprovalNotifier } from "../src/lib/approval-notifier.js";

// BUG 2: the "review required" native notification must fire exactly once per
// approval id, even when the same pending approval is polled/announced again.

function approval(id: string): ApprovalRequest {
  return {
    id,
    taskId: "task-1",
    requestedBy: "claude-code",
    kind: "command",
    reason: "run something",
    status: "pending",
  };
}

describe("createApprovalNotifier", () => {
  it("the same approval polled twice notifies once", () => {
    const shown: string[] = [];
    const notifier = createApprovalNotifier({
      show: (approval) => shown.push(approval.id),
    });

    const ap = approval("ap-1");
    notifier.notify(ap);
    notifier.notify(ap); // second poll of the SAME pending approval

    expect(shown).toEqual(["ap-1"]);
  });

  it("distinct approvals each notify once", () => {
    const shown: string[] = [];
    const notifier = createApprovalNotifier({
      show: (approval) => shown.push(approval.id),
    });

    notifier.notify(approval("ap-1"));
    notifier.notify(approval("ap-2"));
    notifier.notify(approval("ap-1"));

    expect(shown).toEqual(["ap-1", "ap-2"]);
  });

  it("reconcile forgets ids that leave the pending set (bounded dedup)", () => {
    const show = vi.fn();
    const notifier = createApprovalNotifier({ show });

    notifier.notify(approval("ap-1"));
    expect(show).toHaveBeenCalledTimes(1);

    // The approval is decided → no longer pending → forgotten.
    notifier.reconcile([]);

    // A brand-new approval that happens to reuse the id would notify again
    // (proves the id was cleared); a still-remembered id would be swallowed.
    notifier.notify(approval("ap-1"));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("reconcile keeps ids still pending (no re-fire on the next poll)", () => {
    const show = vi.fn();
    const notifier = createApprovalNotifier({ show });

    notifier.notify(approval("ap-1"));
    // Still pending on the next poll → stays remembered → no second toast.
    notifier.reconcile([approval("ap-1")]);
    notifier.notify(approval("ap-1"));

    expect(show).toHaveBeenCalledTimes(1);
  });
});
