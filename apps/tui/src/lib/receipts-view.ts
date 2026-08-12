import type { ApprovalReceipt } from "@muon/client";

/**
 * P0.4 TUI parity (read-only): the ReviewInbox's active-receipts summary.
 * Receipts are INFORMATIONAL only here — no mint/revoke affordance in the
 * TUI, the operator desktop/CLI acts. `receipts` is `null`/`undefined` when
 * the last poll hasn't landed yet OR it failed: an honest absence, so the
 * caller renders NOTHING rather than a stale count (mirrors
 * MissionBudgetLine's poll-fail contract — a failure REPLACES the view,
 * never leaves a stale ready number on screen). An empty (but successfully
 * polled) array also renders nothing: there is nothing to tell the operator.
 *
 * `compact` mirrors DiagnosticsPanel's height-profile contract: a count-only
 * summary, no per-entry detail — never a NEW fixed row when the fixed-chrome
 * arithmetic (`lib/layout.ts` resolveRowBudget) has no room for one.
 */
export function formatActiveReceiptsLine(
  receipts: ApprovalReceipt[] | null | undefined,
  now: Date,
  compact: boolean
): string | null {
  if (!receipts || receipts.length === 0) {
    return null;
  }
  const count = receipts.length;
  const base = `${count} receipt${count === 1 ? "" : "s"} active`;
  if (compact) {
    return base;
  }
  const soonest = receipts
    .map((receipt) => receipt.expiresAt)
    // ISO 8601 timestamps compare correctly as strings (same convention used
    // by lib/lane-columns.ts's event-timestamp sort).
    .sort()[0]!;
  return `${base} · soonest expiry ${formatExpiry(soonest, now)}`;
}

function formatExpiry(expiresAt: string, now: Date): string {
  const deltaMs = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(deltaMs)) {
    return "unknown";
  }
  if (deltaMs <= 0) {
    return "any moment";
  }
  const seconds = Math.ceil(deltaMs / 1000);
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `in ${hours}h`;
  }
  const days = Math.ceil(hours / 24);
  return `in ${days}d`;
}
