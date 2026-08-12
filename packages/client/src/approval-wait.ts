import type { ApprovalRequest } from "./types.js";

type ApprovalReader = {
  listApprovals: () => Promise<ApprovalRequest[]>;
};

export type WaitForApprovalOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onPoll?: (approval: ApprovalRequest) => void;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the approval queue until the request is approved. Anything other
 * than a clean "approved", rejection, unknown state, missing record, or
 * timeout, throws, so the caller fails closed and never runs unapproved.
 * Lives in the client package so every surface (CLI, TUI, desktop runner)
 * gates work through the exact same fail-closed logic.
 */
export async function waitForApproval(
  client: ApprovalReader,
  approvalId: string,
  options: WaitForApprovalOptions = {}
): Promise<ApprovalRequest> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  // A NaN/negative timeout would make the deadline comparison always false
  // and poll forever, reject it up front instead of failing open.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      `Invalid approval timeout '${timeoutMs}'. Failing closed; not running.`
    );
  }

  const deadline = now() + timeoutMs;

  for (;;) {
    const approvals = await client.listApprovals();
    const approval = approvals.find((entry) => entry.id === approvalId);

    if (!approval) {
      throw new Error(
        `Approval '${approvalId}' is no longer in the queue. Failing closed; not running.`
      );
    }

    if (approval.status === "approved") {
      return approval;
    }

    if (approval.status === "rejected") {
      const notes = approval.decisionNotes ? ` (${approval.decisionNotes})` : "";
      throw new Error(
        `Approval '${approvalId}' was rejected${notes}. Not running.`
      );
    }

    if (approval.status !== "pending") {
      throw new Error(
        `Approval '${approvalId}' is in unknown state '${approval.status}'. Failing closed; not running.`
      );
    }

    if (now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for approval '${approvalId}'. Failing closed; not running.`
      );
    }

    options.onPoll?.(approval);
    await sleep(pollIntervalMs);
  }
}
