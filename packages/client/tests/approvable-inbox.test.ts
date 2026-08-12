import { describe, expect, it } from "vitest";
import { selectOneApprovableCard } from "../src/approvable-inbox.js";
import type { ApprovalRequest } from "../src/types.js";

function approval(
  overrides: Partial<ApprovalRequest> & { id: string }
): ApprovalRequest {
  return {
    taskId: "task-1",
    requestedBy: "agent",
    kind: "tool",
    reason: "needs a decision",
    status: "pending",
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("TODO 5.16: selectOneApprovableCard", () => {
  it("returns null primary when nothing is pending", () => {
    expect(selectOneApprovableCard([])).toEqual({
      primary: null,
      folded: [],
      queued: [],
    });
    expect(
      selectOneApprovableCard([
        approval({ id: "a", status: "approved" }),
      ]).primary
    ).toBeNull();
  });

  it("picks exactly one primary — the oldest pending", () => {
    const inbox = selectOneApprovableCard([
      approval({
        id: "newer",
        createdAt: "2026-07-31T00:02:00.000Z",
        jobId: "job-b",
      }),
      approval({
        id: "older",
        createdAt: "2026-07-31T00:01:00.000Z",
        jobId: "job-a",
      }),
    ]);
    expect(inbox.primary?.id).toBe("older");
    expect(inbox.folded).toEqual([]);
    expect(inbox.queued.map((a) => a.id)).toEqual(["newer"]);
  });

  it("folds same-job siblings into the primary, never a second card", () => {
    const inbox = selectOneApprovableCard([
      approval({
        id: "a1",
        jobId: "job-1",
        createdAt: "2026-07-31T00:01:00.000Z",
      }),
      approval({
        id: "a2",
        jobId: "job-1",
        createdAt: "2026-07-31T00:01:30.000Z",
        reason: "also this",
      }),
      approval({
        id: "b1",
        jobId: "job-2",
        createdAt: "2026-07-31T00:02:00.000Z",
      }),
    ]);
    expect(inbox.primary?.id).toBe("a1");
    expect(inbox.folded.map((a) => a.id)).toEqual(["a2"]);
    expect(inbox.queued.map((a) => a.id)).toEqual(["b1"]);
  });

  it("honours focusId when it still names a pending approval", () => {
    const inbox = selectOneApprovableCard(
      [
        approval({ id: "a", createdAt: "2026-07-31T00:01:00.000Z" }),
        approval({ id: "b", createdAt: "2026-07-31T00:02:00.000Z" }),
      ],
      "b"
    );
    expect(inbox.primary?.id).toBe("b");
    expect(inbox.queued.map((a) => a.id)).toEqual(["a"]);
  });

  it("ignores a focusId that is already decided", () => {
    const inbox = selectOneApprovableCard(
      [
        approval({
          id: "done",
          status: "approved",
          createdAt: "2026-07-31T00:01:00.000Z",
        }),
        approval({
          id: "live",
          createdAt: "2026-07-31T00:02:00.000Z",
        }),
      ],
      "done"
    );
    expect(inbox.primary?.id).toBe("live");
  });
});
