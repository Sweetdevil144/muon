import { describe, expect, it, vi } from "vitest";
import { MuonApiClient, type ApprovalRequest } from "@muon/client";
import {
  createApprovalsMonitor,
  decideApproval,
  mergeOutcomesSnapshot,
  onMergeLanded,
  recordMergeOutcome,
  type MonitorState,
} from "../src/lib/approvals-monitor.js";
import type { ApprovalMergeResult } from "@muon/client";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

function approval(id: string, status = "pending"): ApprovalRequest {
  return {
    id,
    taskId: "task-1",
    requestedBy: "codex",
    kind: "command",
    reason: `run something (${id})`,
    status: status as ApprovalRequest["status"],
  };
}

describe("approvals monitor", () => {
  it("does not notify for approvals that existed at startup, but does for new ones", async () => {
    let approvals = [approval("ap-old")];
    const fetcher = vi.fn(async () => mockResponse({ approvals }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const notified: string[] = [];
    const states: MonitorState[] = [];
    const monitor = createApprovalsMonitor(client, {
      onState: (state) => states.push(state),
      onNewApproval: (entry) => notified.push(entry.id),
    });

    await monitor.poll();
    expect(notified).toEqual([]);
    expect(states[0]?.pending.map((p) => p.id)).toEqual(["ap-old"]);

    approvals = [approval("ap-old"), approval("ap-new")];
    await monitor.poll();
    expect(notified).toEqual(["ap-new"]);

    // Repeated polls never re-announce.
    await monitor.poll();
    expect(notified).toEqual(["ap-new"]);
  });

  it("reports offline state on errors and recovers", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(mockResponse({ approvals: [] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const states: MonitorState[] = [];
    const monitor = createApprovalsMonitor(client, {
      onState: (state) => states.push(state),
      onNewApproval: () => undefined,
    });

    await monitor.poll();
    expect(states[0]).toMatchObject({ online: false });
    expect(states[0]?.lastError).toContain("ECONNREFUSED");

    await monitor.poll();
    expect(states[1]).toMatchObject({ online: true, pending: [] });
  });

  it("decides approvals through the client", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ approval: { ...approval("ap-1"), status: "approved" } })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const message = await decideApproval(client, "ap-1", "approved");

    expect(message).toContain("approved");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/approvals/ap-1",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("decideApproval defaults to today's note (human path byte-identical)", async () => {
    const calls: any[] = [];
    const fetcher = vi.fn(async (_u, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return mockResponse({ approval: approval("ap-1", "approved") });
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    await decideApproval(client, "ap-1", "approved");
    expect(calls[0].decisionNotes).toBe("decided from MUON desktop"); // unchanged
  });

  it("decideApproval carries an explicit note when given (audit attribution)", async () => {
    const calls: any[] = [];
    const fetcher = vi.fn(async (_u, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return mockResponse({ approval: approval("ap-1", "approved") });
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    await decideApproval(
      client,
      "ap-1",
      "approved",
      "auto-approved by full-auto (standing operator consent)"
    );
    // The note keeps the caller's words AND gains the surface. Before this
    // went through `buildApprovalDecision`, a supplied note REPLACED the
    // attribution — so Full Auto's auto-approvals, the decisions whose origin
    // matters most, were the only ones that did not say where they came from.
    expect(calls[0].decisionNotes).toBe(
      "auto-approved by full-auto (standing operator consent) (decided from MUON desktop)"
    );
  });

  it("keeps the merge outcome the resolve reported, keyed by approval id", async () => {
    // The fact used to exist for one stack frame and die — a Full Auto merge
    // could never be shown as "landed as <sha>". Now every decide records it.
    const fetcher = vi.fn(async () =>
      mockResponse({
        approval: { ...approval("ap-merge", "approved") },
        merge: { status: "merged", sha: "abc1234def5678", changedFiles: 3 },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    await decideApproval(client, "ap-merge", "approved");
    expect(mergeOutcomesSnapshot()["ap-merge"]).toEqual({
      status: "merged",
      sha: "abc1234def5678",
      changedFiles: 3,
    });
    // A decision with no merge half records nothing (absence ≠ verdict).
    recordMergeOutcome("ap-none", undefined);
    expect(mergeOutcomesSnapshot()["ap-none"]).toBeUndefined();
  });

  // ── ADR-0054: the post-merge catch-up hook ──────────────────────────────
  //
  // `recordMergeOutcome` is the ONE funnel every resolve path already flows
  // through (human click, receipts, manual-review attest, Full Auto), which is
  // why the hook hangs here and not at the four call sites: a per-call-site hook
  // is a set a fifth surface joins without wiring.

  it("fires the merge-landed hook for a MERGED result", async () => {
    const landed: ApprovalMergeResult[] = [];
    onMergeLanded((merge) => landed.push(merge));
    try {
      recordMergeOutcome("ap-landed", {
        status: "merged",
        sha: "deadbeef",
        changedFiles: 2,
      });
      expect(landed).toHaveLength(1);
      expect(landed[0]).toMatchObject({ status: "merged", sha: "deadbeef" });
    } finally {
      onMergeLanded(null);
    }
  });

  it("does NOT fire for no-op, conflict, blocked or failed", async () => {
    // None of those moved a commit, so waking the indexer would spend a full
    // index run proving the graph was already current.
    const landed: ApprovalMergeResult[] = [];
    onMergeLanded((merge) => landed.push(merge));
    try {
      for (const status of ["no-op", "conflict", "blocked", "failed"] as const) {
        recordMergeOutcome(`ap-${status}`, { status, reason: "r" });
      }
      expect(landed).toHaveLength(0);
    } finally {
      onMergeLanded(null);
    }
  });

  it("fires through decideApproval — the Full Auto path is wired too", async () => {
    const landed: ApprovalMergeResult[] = [];
    onMergeLanded((merge) => landed.push(merge));
    const fetcher = vi.fn(async () =>
      mockResponse({
        approval: { ...approval("ap-auto", "approved") },
        merge: { status: "merged", sha: "cafe1234" },
      })
    );
    try {
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      await decideApproval(client, "ap-auto", "approved", "standing consent");
      expect(landed).toHaveLength(1);
    } finally {
      onMergeLanded(null);
    }
  });

  it("a THROWING listener never turns a landed merge into an error", async () => {
    onMergeLanded(() => {
      throw new Error("supervisor exploded");
    });
    try {
      expect(() =>
        recordMergeOutcome("ap-safe", { status: "merged", sha: "beef" })
      ).not.toThrow();
      // And the outcome is still recorded: the hook is a side channel, never a
      // precondition for the fact the Changes panel reads.
      expect(mergeOutcomesSnapshot()["ap-safe"]).toMatchObject({
        status: "merged",
      });
    } finally {
      onMergeLanded(null);
    }
  });

  it("bounds the retained merge outcomes (oldest evicted first)", () => {
    for (let index = 0; index < 60; index += 1) {
      recordMergeOutcome(`ap-bulk-${index}`, {
        status: "no-op",
        reason: "nothing to merge",
      });
    }
    const snapshot = mergeOutcomesSnapshot();
    expect(Object.keys(snapshot).length).toBeLessThanOrEqual(50);
    expect(snapshot["ap-bulk-59"]).toBeDefined();
    expect(snapshot["ap-bulk-0"]).toBeUndefined();
  });
});
