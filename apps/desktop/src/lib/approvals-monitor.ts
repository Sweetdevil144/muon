import type {
  ApprovalMergeResult,
  ApprovalRequest,
  MuonApiClient,
} from "@muon/client";

export type MonitorState = {
  online: boolean;
  pending: ApprovalRequest[];
  lastError: string | null;
};

export type MonitorEvents = {
  onState: (state: MonitorState) => void;
  /** Fired once per newly seen pending approval, drives notifications. */
  onNewApproval: (approval: ApprovalRequest) => void;
};

/**
 * Polls the brain for pending approvals. Remembers which ids it has already
 * announced so each approval notifies exactly once, even across flaps.
 */
export function createApprovalsMonitor(
  client: MuonApiClient,
  events: MonitorEvents
) {
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let firstPoll = true;

  const poll = async () => {
    try {
      const approvals = await client.listApprovals();
      const pending = approvals.filter((entry) => entry.status === "pending");

      for (const approval of pending) {
        if (!seen.has(approval.id)) {
          seen.add(approval.id);
          // Approvals that predate app start are shown in state but not
          // notified, no notification storm on launch.
          if (!firstPoll) {
            events.onNewApproval(approval);
          }
        }
      }
      firstPoll = false;

      events.onState({ online: true, pending, lastError: null });
    } catch (error) {
      events.onState({
        online: false,
        pending: [],
        lastError: error instanceof Error ? error.message : "poll failed",
      });
    }
  };

  return {
    poll,
    start: (intervalMs: number) => {
      if (timer) {
        return;
      }
      void poll();
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * What deciding a `merge` gate ACTUALLY did to the primary checkout, keyed by
 * approval id. The brain reports `merge` on the resolve call itself; before
 * this registry every caller dropped it, so a Full Auto merge could never be
 * shown as "landed as <sha>" — the fact existed for one stack frame and died.
 *
 * Recorded from EVERY resolve path (human click, Full Auto, receipts), read by
 * `collectState()` into `DesktopState.mergeOutcomes`. Bounded: absence of an
 * id means "not decided here recently", never "not merged" — surfaces must
 * not read absence as a verdict.
 */
const MERGE_OUTCOME_CAP = 50;
const decidedMergeOutcomes = new Map<string, ApprovalMergeResult>();

export function recordMergeOutcome(
  approvalId: string,
  merge: ApprovalMergeResult | undefined
): void {
  if (!merge) {
    return;
  }
  decidedMergeOutcomes.set(approvalId, merge);
  while (decidedMergeOutcomes.size > MERGE_OUTCOME_CAP) {
    const oldest = decidedMergeOutcomes.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    decidedMergeOutcomes.delete(oldest);
  }
}

export function mergeOutcomesSnapshot(): Record<string, ApprovalMergeResult> {
  return Object.fromEntries(decidedMergeOutcomes);
}

export async function decideApproval(
  client: MuonApiClient,
  approvalId: string,
  decision: "approved" | "rejected",
  // Default = today's exact string, so the human-click path is byte-identical.
  // Full-Auto passes an explicit note so each standing-consent auto-approval is
  // attributed in the decision record (audit trail).
  decisionNotes = "decided from MUON desktop"
): Promise<string> {
  const approval = await client.resolveApproval({
    approvalId,
    status: decision,
    decisionNotes,
  });
  // Keep the merge fact (signature unchanged on purpose: the Full Auto
  // auto-approver calls this too, and ITS merges are exactly the ones the
  // Changes panel could otherwise never report).
  recordMergeOutcome(approval.id, approval.merge);
  return `${approval.id} ${approval.status}`;
}
