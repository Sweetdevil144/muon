import { redactSecrets, type ApprovalRequest, type MuonApiClient } from "@muon/client";
import { decideApproval } from "./approvals-monitor.js";

const FULL_AUTO_NOTE = "auto-approved by full-auto (standing operator consent)";

/**
 * How much of the approved SUBJECT the receipt carries. Long enough for a real
 * command or path to survive whole (the founder's mission auto-approved twelve
 * high-risk Bash calls whose command lines ran to ~100 characters), short
 * enough that a receipt stays a receipt.
 */
const FULL_AUTO_SUBJECT_CHARS = 240;

/**
 * The subject of ONE auto-approval, safe to store in the audit trail.
 *
 * UNTRUSTED, AGENT-ADJACENT TEXT. The scope is written by whatever the agent
 * asked to run, so it is redacted (secrets first, over the FULL string, before
 * any slice can cut one in half), stripped of control characters that could
 * re-shape a log line or a rendered receipt, and bounded. It is placed AFTER a
 * `— ` delimiter so a reader can always tell MUON's own sentence from the
 * agent's words; it is never allowed to become the whole note.
 */
function approvedSubject(approval: ApprovalRequest): string {
  const evidence = approval.evidence;
  if (!evidence) return "";
  // `scope` is the operator-visible target of the call (the Bash command line,
  // the edited path); `action` is the verb. Both already exist on every
  // session-tool approval — the receipt simply stopped carrying them.
  const raw = [evidence.action, evidence.scope]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ");
  if (!raw) return "";
  // Newlines and C0/C1 collapse to whitespace: a receipt is ONE line, and a
  // multi-line "command" must not be able to forge extra log records.
  const clean = redactSecrets(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > FULL_AUTO_SUBJECT_CHARS
    ? `${clean.slice(0, FULL_AUTO_SUBJECT_CHARS - 1)}…`
    : clean;
}

/**
 * The receipt ONE auto-approval leaves behind.
 *
 * `auto-approved by full-auto (standing operator consent)` was the whole note
 * on all seventeen approvals of the founder's mission — twelve of them
 * `riskLevel: "high"` Bash calls — so the durable record of what standing
 * consent authorized named nothing at all. A decision recorded without its
 * subject is not a reviewable decision.
 */
export function fullAutoDecisionNote(approval: ApprovalRequest): string {
  const subject = approvedSubject(approval);
  const risk = approval.evidence?.riskLevel;
  const qualifier = risk ? ` [risk: ${risk}]` : "";
  return subject ? `${FULL_AUTO_NOTE}${qualifier} — ${subject}` : FULL_AUTO_NOTE;
}

/**
 * How long a pending approval may sit under Full Auto before MUON stops saying
 * it is auto-approving and hands it back as an ordinary fail-closed gate.
 *
 * The auto-approver polls on `pollIntervalMs` (5s by default), so this is
 * deliberately more than two cycles: a grant that has not landed by then is not
 * in flight, it is not coming, and the honest answer is the blocking prompt.
 */
export const FULL_AUTO_GRACE_MS = 12_000;

/**
 * The main process's memory of what standing consent has actually managed to do.
 * Bounded: `reconcileFullAutoWatch` prunes both to the live pending set.
 */
export interface FullAutoWatch {
  /** When the auto-approver first saw each still-pending approval. */
  firstSeenAt: Map<string, number>;
  /** Ids the brain REFUSED to auto-approve; these fall back to the human. */
  refused: Set<string>;
}

export function createFullAutoWatch(): FullAutoWatch {
  return { firstSeenAt: new Map(), refused: new Set() };
}

/**
 * Vendor-scoped standing consent: split the pending queue into the approvals
 * the selected lanes cover and the ones that stay fail-closed human gates.
 *
 * The vendor of an approval is `laneVendor` — SERVER-derived by the brain from
 * the approval's persisted job binding (jobId → DispatchJob.vendor). It is
 * never inferred desktop-side from agent-supplied text.
 *
 * Two rules, both deliberate:
 *   1. Every selectable lane selected == the legacy "Auto-approve all",
 *      byte-for-byte — INCLUDING approvals with no resolvable lane vendor
 *      (chat-level gates, CLI-filed ship gates), which is what the single
 *      checkbox always covered.
 *   2. Under a SUBSET, an approval with no resolvable lane vendor is NOT
 *      covered. An unattributable request must never ride a narrower consent —
 *      the bounded-surface rule: absence of a coordinate fails closed.
 */
export function splitFullAutoCoverage(
  pending: ApprovalRequest[],
  selectedVendors: readonly string[],
  selectableVendors: readonly string[]
): { covered: ApprovalRequest[]; uncovered: ApprovalRequest[] } {
  const selected = new Set(selectedVendors);
  if (selected.size === 0) {
    return { covered: [], uncovered: [...pending] };
  }
  const allSelected = selectableVendors.every((id) => selected.has(id));
  if (allSelected) {
    return { covered: [...pending], uncovered: [] };
  }
  const covered: ApprovalRequest[] = [];
  const uncovered: ApprovalRequest[] = [];
  for (const approval of pending) {
    if (approval.laneVendor && selected.has(approval.laneVendor)) {
      covered.push(approval);
    } else {
      uncovered.push(approval);
    }
  }
  return { covered, uncovered };
}

/**
 * Whether a newly-seen pending approval should fire a "review required"
 * notification under the current standing-consent posture.
 *
 * Covered by an armed lane → silent (the auto-approver grants it on the next
 * tick). Uncovered, already refused, or standing consent off → notify. Egress
 * never reaches `pending` (withheld pre-filing); blocked merge reviews land
 * here as refused after the standing grant fails, and those MUST notify —
 * see `promoteSilencedStandingApprovals`.
 */
export function shouldNotifyApproval(input: {
  approval: ApprovalRequest;
  selectedVendors: readonly string[];
  selectableVendors: readonly string[];
  refusedIds?: ReadonlySet<string>;
}): boolean {
  if (input.refusedIds?.has(input.approval.id)) {
    return true;
  }
  if (input.selectedVendors.length === 0) {
    return true;
  }
  const { covered } = splitFullAutoCoverage(
    [input.approval],
    input.selectedVendors,
    input.selectableVendors
  );
  return covered.length === 0;
}

/**
 * Drop silenced ids that left the pending set so the set stays bounded.
 */
export function reconcileSilencedStanding(input: {
  silenced: Set<string>;
  pending: ApprovalRequest[];
}): void {
  const live = new Set(input.pending.map((approval) => approval.id));
  for (const id of [...input.silenced]) {
    if (!live.has(id)) {
      input.silenced.delete(id);
    }
  }
}

/**
 * Approvals that were silenced because standing consent covered them, then
 * became uncovered (brain refused, grace expired) — those now need a human
 * and MUST notify. Only previously-silenced ids are promoted, so a cold-start
 * pending queue never storms the notification layer.
 */
export function promoteSilencedStandingApprovals(input: {
  silenced: Set<string>;
  uncoveredIds: readonly string[];
  pending: ApprovalRequest[];
}): ApprovalRequest[] {
  const out: ApprovalRequest[] = [];
  for (const id of input.uncoveredIds) {
    if (!input.silenced.has(id)) {
      continue;
    }
    input.silenced.delete(id);
    const approval = input.pending.find((entry) => entry.id === id);
    if (approval) {
      out.push(approval);
    }
  }
  return out;
}

/**
 * ONE monitor tick's standing-consent decisions, as pure data.
 *
 * Extracted from the makeMonitor wiring after that wiring shipped a regression
 * no unit test could see: the approver was gated on the derived ALL-lanes
 * `fullAuto` boolean, so a SUBSET selection was silently inert — the sidebar
 * promised "checked lanes approve automatically" while nothing did, and a
 * covered lane's coordinator blocked for the full 300s approval timeout. The
 * rule lives here now, pinned: ANY armed lane drives the approver; the global
 * boolean exists for the three unscoped consumers (lease, runner env,
 * schedule canClaim) and gates nothing in this function.
 *
 * Returns:
 *  - `toApprove`: what autoApprovePending should resolve this tick (empty when
 *    offline — never queue a grant against a brain that is not there).
 *  - `covered`: ids the calm "approving automatically" label is TRUE for,
 *    stamped by this same tick. The renderer treats membership as the only way
 *    to say it — an id on neither list is an ordinary human gate (fail-closed
 *    default for the unclassified).
 *  - `uncovered`: ids standing consent is NOT covering (unselected lane, no
 *    resolvable lane under a subset, refused, or past the grace window).
 */
export function planFullAutoTick(input: {
  pending: ApprovalRequest[];
  selectedVendors: readonly string[];
  selectableVendors: readonly string[];
  online: boolean;
  watch: FullAutoWatch;
  now?: number;
}): { toApprove: ApprovalRequest[]; covered: string[]; uncovered: string[] } {
  const reconcile = (pending: ApprovalRequest[]) =>
    reconcileFullAutoWatch({
      pending,
      watch: input.watch,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
  if (input.selectedVendors.length === 0) {
    // Not armed: drain the watch so a later re-arm starts grace windows fresh.
    reconcile([]);
    return { toApprove: [], covered: [], uncovered: [] };
  }
  const coverage = splitFullAutoCoverage(
    input.pending,
    input.selectedVendors,
    input.selectableVendors
  );
  const graceUncovered = reconcile(coverage.covered);
  const uncovered = [
    ...coverage.uncovered.map((approval) => approval.id),
    ...graceUncovered,
  ];
  const uncoveredSet = new Set(uncovered);
  const covered = coverage.covered
    .map((approval) => approval.id)
    .filter((id) => !uncoveredSet.has(id));
  return {
    // toApprove is filtered by the SAME uncovered set the display uses: an id
    // the brain refused or that outlived its grace window has been HANDED TO
    // THE HUMAN, and retrying it every tick meant the auto-approver could
    // pre-empt a reject the operator was in the middle of making. The grace
    // window (12s) is the retry budget for transient failures; past it,
    // uncertainty resolves toward the gate and stays there.
    toApprove: input.online
      ? coverage.covered.filter((approval) => !uncoveredSet.has(approval.id))
      : [],
    covered,
    uncovered,
  };
}

/**
 * Standing operator consent: resolve every pending approval as APPROVED via the
 * SAME operator resolveApproval path a human click uses. Idempotent — an id
 * already being resolved (overlapping poll cycle) is skipped, so no double-
 * resolve. Each auto-approval is attributed in the decision record (audit trail)
 * AND emitted to `log` so it is never silent. This also grants vendor full
 * access: the #52 full-auto dispatch-gate approvals arrive here as ordinary
 * pending approvals. Egress-gate actions are withheld PRE-filing by
 * resolveVendorAction, so they never reach this list — egress stays explicit.
 */
export async function autoApprovePending(
  client: MuonApiClient,
  pending: ApprovalRequest[],
  inFlight: Set<string>,
  log: (line: string) => void,
  /**
   * P0-1: ids the brain REFUSED the standing grant. Recorded here rather than
   * only logged, because the UI reads it to put the fail-closed gate back in
   * front of the human instead of claiming an auto-approval that never lands.
   */
  refused?: Set<string>
): Promise<void> {
  await Promise.all(
    pending.map(async (a) => {
      if (inFlight.has(a.id)) return; // dedupe across overlapping cycles
      inFlight.add(a.id);
      try {
        const note = fullAutoDecisionNote(a);
        await decideApproval(client, a.id, "approved", note);
        refused?.delete(a.id);
        // The log line names the subject for the same reason the receipt does:
        // an operator reading either one must be able to see WHAT was allowed.
        log(`[full-auto] auto-approved approval ${a.id} (${a.kind}): ${note}`);
      } catch (error) {
        refused?.add(a.id);
        log(
          `[full-auto] auto-approve failed for ${a.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        inFlight.delete(a.id); // approval leaves `pending` once approved; safe to clear
      }
    })
  );
}

/**
 * Decide, per pending approval, whether Full Auto is still honestly going to
 * grant it — and return the ids it is NOT covering.
 *
 * Those ids stay fail-closed: the operator sees the ordinary blocking prompt,
 * exactly as with Full Auto off. Two conditions put an id here, both of which
 * mean "standing consent did not work":
 *   1. the brain refused the grant (e.g. a merge whose review certification is
 *      blocked — that needs an explicit operator attestation, which Full Auto
 *      by design cannot supply);
 *   2. the grant has not landed within FULL_AUTO_GRACE_MS.
 *
 * Never the other way round. An id is only called "auto-approving" while that
 * claim is still plausibly true, so a silent auto-approver can never leave a
 * real gate wearing a calm label.
 */
export function reconcileFullAutoWatch(input: {
  pending: ApprovalRequest[];
  watch: FullAutoWatch;
  now?: number;
}): string[] {
  const now = input.now ?? Date.now();
  const live = new Set(input.pending.map((approval) => approval.id));
  // Prune to the live set first, so both collections stay bounded and a
  // re-filed id starts its grace window fresh.
  for (const id of [...input.watch.firstSeenAt.keys()]) {
    if (!live.has(id)) input.watch.firstSeenAt.delete(id);
  }
  for (const id of [...input.watch.refused]) {
    if (!live.has(id)) input.watch.refused.delete(id);
  }
  const uncovered: string[] = [];
  for (const id of live) {
    const seenAt = input.watch.firstSeenAt.get(id) ?? now;
    input.watch.firstSeenAt.set(id, seenAt);
    if (input.watch.refused.has(id) || now - seenAt >= FULL_AUTO_GRACE_MS) {
      uncovered.push(id);
    }
  }
  return uncovered;
}
