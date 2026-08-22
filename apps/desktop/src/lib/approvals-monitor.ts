import { buildApprovalDecision } from "@muon/client";
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

/**
 * ADR-0054 — who to tell when a governed merge actually LANDS.
 *
 * `recordMergeOutcome` is the one funnel every resolve path already goes
 * through (human click, receipts, manual-review attest, Full Auto), which is
 * why the hook hangs here rather than at the four call sites: a per-call-site
 * hook is a set that a fifth surface joins without wiring, and this repository
 * has already shipped a governed op whose surfaces drifted apart.
 *
 * The listener must be cheap and non-throwing. It runs inline on an approval
 * decision, and a merge must never fail because a code-graph catch-up did.
 */
type MergeLandedListener = (merge: ApprovalMergeResult) => void;
let mergeLandedListener: MergeLandedListener | null = null;

/** Register the single listener (main process). Replaces any previous one. */
export function onMergeLanded(listener: MergeLandedListener | null): void {
  mergeLandedListener = listener;
}

export function recordMergeOutcome(
  approvalId: string,
  merge: ApprovalMergeResult | undefined
): void {
  if (!merge) {
    return;
  }
  // `merged` ONLY. A `no-op` moved no commit, and a `conflict`/`blocked`/
  // `failed` landed nothing at all — waking the indexer for those would spend
  // a full index run proving the graph was already current.
  if (merge.status === "merged") {
    try {
      mergeLandedListener?.(merge);
    } catch {
      // The merge is already done and recorded. A listener failure is never
      // allowed to turn a landed merge into an error the operator sees.
    }
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
  // Full-Auto passes an explicit note so each standing-consent auto-approval is
  // attributed in the decision record (audit trail).
  //
  // This used to default to the literal "decided from MUON desktop" — a
  // hand-copy of what the shared builder produces, which meant a supplied note
  // REPLACED the surface attribution instead of carrying it. Full Auto's
  // auto-approvals were the ones losing it, which is exactly backwards: those
  // are the decisions whose origin matters most. The builder appends, so both
  // survive. With no note the string is byte-identical to before.
  notes?: string
): Promise<string> {
  const approval = await client.resolveApproval(
    buildApprovalDecision({
      approvalId,
      status: decision,
      surface: "MUON desktop",
      notes,
    })
  );
  // Keep the merge fact (signature unchanged on purpose: the Full Auto
  // auto-approver calls this too, and ITS merges are exactly the ones the
  // Changes panel could otherwise never report).
  recordMergeOutcome(approval.id, approval.merge);
  return `${approval.id} ${approval.status}`;
}
