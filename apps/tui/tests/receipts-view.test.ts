import { describe, expect, it } from "vitest";
import type { ApprovalReceipt } from "@muon/client";
import { formatActiveReceiptsLine } from "../src/lib/receipts-view.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function receipt(overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt {
  return {
    id: "r1",
    approvalId: "ap-1",
    taskId: "task-1",
    jobId: "job-1",
    workspacePath: "/repo",
    actionClass: "edit",
    toolName: "edit_file",
    payloadDigest: "digest",
    expiresAt: "2026-07-18T12:05:00.000Z",
    useCount: 0,
    ...overrides,
  };
}

describe("formatActiveReceiptsLine (P0.4 TUI parity)", () => {
  it("renders nothing when receipts is null (unpolled or poll-fail — honest absence)", () => {
    expect(formatActiveReceiptsLine(null, NOW, false)).toBeNull();
  });

  it("renders nothing when receipts is undefined", () => {
    expect(formatActiveReceiptsLine(undefined, NOW, false)).toBeNull();
  });

  it("renders nothing when successfully polled but empty (no active receipts)", () => {
    expect(formatActiveReceiptsLine([], NOW, false)).toBeNull();
  });

  it("renders count + soonest expiry, singular receipt", () => {
    const line = formatActiveReceiptsLine(
      [receipt({ expiresAt: "2026-07-18T12:05:00.000Z" })],
      NOW,
      false
    );
    expect(line).toBe("1 receipt active · soonest expiry in 5m");
  });

  it("renders count + soonest expiry, plural, and picks the SOONEST of many", () => {
    const line = formatActiveReceiptsLine(
      [
        receipt({ id: "r1", expiresAt: "2026-07-18T13:00:00.000Z" }),
        receipt({ id: "r2", expiresAt: "2026-07-18T12:00:30.000Z" }),
        receipt({ id: "r3", expiresAt: "2026-07-18T12:30:00.000Z" }),
      ],
      NOW,
      false
    );
    expect(line).toBe("3 receipts active · soonest expiry in 30s");
  });

  it("compact mode drops the soonest-expiry detail (summary-only, per resolveRowBudget)", () => {
    const line = formatActiveReceiptsLine(
      [receipt({ expiresAt: "2026-07-18T12:05:00.000Z" })],
      NOW,
      true
    );
    expect(line).toBe("1 receipt active");
  });

  it("formats hours once past the minute tier", () => {
    const line = formatActiveReceiptsLine(
      [receipt({ expiresAt: "2026-07-18T15:00:00.000Z" })],
      NOW,
      false
    );
    expect(line).toBe("1 receipt active · soonest expiry in 3h");
  });

  it("treats an already-elapsed expiry as 'any moment', never negative", () => {
    const line = formatActiveReceiptsLine(
      [receipt({ expiresAt: "2026-07-18T11:00:00.000Z" })],
      NOW,
      false
    );
    expect(line).toBe("1 receipt active · soonest expiry any moment");
  });
});
