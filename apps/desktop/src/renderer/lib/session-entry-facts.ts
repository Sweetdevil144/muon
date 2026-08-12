import type { ApprovalRequest } from "@muon/client";
import type { BudgetLineView } from "@muon/client/budget-view";

/**
 * Audit-true session entry facts (session-desk G6).
 *
 * Only surfaces facts we can name from live desk state — never invents
 * "Recent activity" placeholders. Empty array → render nothing (silence is
 * honest when there is nothing to say).
 */
export type SessionEntryFact = {
  id: "gate" | "budget" | "finding";
  label: string;
  tone: "neutral" | "warn" | "danger" | "ready";
};

export function buildSessionEntryFacts(input: {
  approvals: readonly ApprovalRequest[];
  missionBudget?: BudgetLineView | null;
  /** Optional one-liner from the newest linked finding / handoff; omit if unknown. */
  lastFindingSummary?: string | null;
}): SessionEntryFact[] {
  const facts: SessionEntryFact[] = [];
  const pending = input.approvals.length;
  if (pending > 0) {
    facts.push({
      id: "gate",
      label:
        pending === 1
          ? "1 gate waiting"
          : `${pending} gates waiting`,
      tone: "warn",
    });
  } else {
    facts.push({
      id: "gate",
      label: "No pending gates",
      tone: "ready",
    });
  }

  const budget = input.missionBudget;
  if (budget && budget.status !== "unknown") {
    if (budget.status === "exhausted") {
      facts.push({
        id: "budget",
        label: budget.summaryLabel || "Budget exhausted",
        tone: "danger",
      });
    } else if (budget.status === "poll-fail") {
      facts.push({
        id: "budget",
        label: "Budget unread",
        tone: "warn",
      });
    } else {
      facts.push({
        id: "budget",
        label: budget.summaryLabel,
        tone: "neutral",
      });
    }
  }

  const finding = input.lastFindingSummary?.trim();
  if (finding) {
    facts.push({
      id: "finding",
      label: finding.length > 72 ? `${finding.slice(0, 69)}…` : finding,
      tone: "neutral",
    });
  }

  return facts;
}
