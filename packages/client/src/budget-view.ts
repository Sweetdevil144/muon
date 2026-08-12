import { DELEGATION_MAX_DESCENDANTS } from "@muon/protocol";
import type { DispatchBudget, DispatchBudgetChild } from "./types.js";

/**
 * The server-side ceiling on a mission's descendant pool
 * (backend raiseBudgetSchema: DELEGATION_MAX_DESCENDANTS x 30 min). Exported
 * so surfaces bound raise targets with the SAME constant the route enforces —
 * never a hardcoded duplicate that can silently drift.
 */
export const DESCENDANT_POOL_CEILING_MS = DELEGATION_MAX_DESCENDANTS * 1_800_000;

/**
 * S9 TUI/desktop budget surfacing: the four honest states a budget readout
 * can be in. `unknown` = no active mission root has been resolved yet (no
 * task selected, no dispatch lineage, never fetched). `poll-fail` = a fetch
 * for a KNOWN root job id errored; the caller must show THIS, never keep the
 * previous `ready`/`exhausted` numbers on screen (no stale data survives a
 * failed poll). `ready` and `exhausted` are both real reads of the S9
 * `GET /api/dispatch/:jobId/budget` contract; `exhausted` is the sole
 * needs-you state (remainingMs <= 0), mirrored in every surface's tone.
 */
export type BudgetLineStatus = "unknown" | "ready" | "exhausted" | "poll-fail";

/** One child's slice of the mission pool, numbers/enums only (no free text). */
export type BudgetDescendantView = {
  jobId: string;
  vendor: string;
  status: string;
  depth: number;
  reservedLabel: string;
  consumedLabel: string;
};

/**
 * The ONE view-model every surface (TUI first, desktop/CLI can converge
 * later) renders a mission budget from. READ-ONLY by design: no raise
 * affordance lives here — S9 raises stay operator/desktop-gated.
 */
export type BudgetLineView = {
  status: BudgetLineStatus;
  /** One-line compact summary, e.g. "15m left of 30m pool" / "pool exhausted". */
  summaryLabel: string;
  poolLabel: string;
  reservedLabel: string;
  consumedLabel: string;
  remainingLabel: string;
  /** Per-descendant breakdown; empty for unknown/poll-fail or a childless mission. */
  children: BudgetDescendantView[];
  /** Sanitized failure detail. Only ever set on the poll-fail state. */
  detail?: string;
};

const PLACEHOLDER = "—";

/**
 * Compact wall-clock label: sub-minute spans in ceiling seconds, everything
 * else in ceiling minutes. Negative input (an over-drawn pool) floors at 0
 * rather than ever rendering a signed number.
 */
export function compactBudgetDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) {
    return `${Math.ceil(clamped / 1000)}s`;
  }
  return `${Math.ceil(clamped / 60_000)}m`;
}

/** No active mission root has been resolved yet — an honest empty state, not a guess. */
export function unknownBudgetLine(): BudgetLineView {
  return {
    status: "unknown",
    summaryLabel: "no active mission",
    poolLabel: PLACEHOLDER,
    reservedLabel: PLACEHOLDER,
    consumedLabel: PLACEHOLDER,
    remainingLabel: PLACEHOLDER,
    children: [],
  };
}

/**
 * A poll for a known mission root failed. Replaces any prior ready/exhausted
 * view outright — the caller must never keep showing stale numbers.
 */
export function pollFailBudgetLine(detail: string): BudgetLineView {
  return {
    status: "poll-fail",
    summaryLabel: "budget unavailable",
    poolLabel: PLACEHOLDER,
    reservedLabel: PLACEHOLDER,
    consumedLabel: PLACEHOLDER,
    remainingLabel: PLACEHOLDER,
    children: [],
    detail,
  };
}

function descendantView(child: DispatchBudgetChild): BudgetDescendantView {
  return {
    jobId: child.jobId,
    vendor: child.vendor,
    status: child.status,
    depth: child.depth,
    reservedLabel: compactBudgetDuration(child.reservedMs),
    consumedLabel: compactBudgetDuration(child.consumedMs),
  };
}

/**
 * Projects the S9 `GET /api/dispatch/:jobId/budget` contract (numbers/enums
 * only, see `DispatchBudget`) into the shared view-model. This is the ONE
 * contract every budget-surfacing UI should project from — mirrors the P0.5
 * `buildCapabilityPreflight` pattern (the brain-store poll) so no surface
 * ever re-derives its own local budget arithmetic.
 */
export function buildBudgetLineView(budget: DispatchBudget): BudgetLineView {
  const remaining = Math.max(0, budget.remainingMs);
  const status: BudgetLineStatus =
    budget.remainingMs <= 0 ? "exhausted" : "ready";
  const poolLabel = compactBudgetDuration(budget.poolMs);
  const reservedLabel = compactBudgetDuration(budget.reservedMs);
  const consumedLabel = compactBudgetDuration(budget.consumedMs);
  const remainingLabel = compactBudgetDuration(remaining);
  return {
    status,
    summaryLabel:
      status === "exhausted"
        ? `pool exhausted (0s of ${poolLabel})`
        : `${remainingLabel} left of ${poolLabel} pool`,
    poolLabel,
    reservedLabel,
    consumedLabel,
    remainingLabel,
    children: budget.children.map(descendantView),
  };
}
