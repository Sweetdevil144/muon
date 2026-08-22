import { buildBudgetLineView } from "@muon/client/budget-view";
import type { ApprovalRequest, DispatchBudget } from "@muon/client/types";

/**
 * AUDIT-TRUE SESSION ENTRY HEADER (ROADMAP H6).
 *
 * Opening a session used to tell the operator the agent's name, its status and
 * a wall-clock cap — none of which answers the question a person actually opens
 * a session with: what happened here, and what is it allowed to do next. The
 * ledger held the answers (a decided gate, a budget, a worktree) and the header
 * simply did not read them.
 *
 * TWO RULES, and they are the whole design:
 *
 *  1. EVERY FACT COMES FROM A RECORD. `DispatchJobRecord` for the tree,
 *     `GET /api/dispatch/:jobId/budget` for the pool, the decided-approval
 *     window for the gate. Same fields, same records the CLI's
 *     `dispatch status` prints, so the two surfaces cannot disagree about the
 *     same job.
 *
 *  2. AN ABSENT FACT IS AN ABSENT LINE. No "Recent activity: none", no "Last
 *     gate: —". A placeholder that asserts a negative is worse than silence,
 *     because it is a claim: "no gate has been decided" is a very different
 *     statement from "this snapshot does not carry one", and the header cannot
 *     tell them apart. So it says neither.
 */
export type SessionHeaderFact = {
  id: "gate" | "budget" | "tree";
  /** The short label, e.g. "Last gate". */
  label: string;
  /** The fact itself. Always non-empty — an unknown fact yields no row. */
  value: string;
  /** Full text for a truncated/abbreviated value (a path), when it differs. */
  title?: string;
  tone: "neutral" | "warn" | "danger" | "ready";
};

/** Decided-gate tone: a rejection is not the same news as an approval. */
function gateTone(status: string): SessionHeaderFact["tone"] {
  if (status === "approved") return "ready";
  if (status === "rejected") return "danger";
  return "neutral";
}

/** `2026-08-17T09:04:11.000Z` → `2026-08-17 09:04`. Invalid input → null. */
function shortInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * The newest decision recorded against this task, within the bounded window.
 *
 * Exported because "which gate is the last one" is the part worth pinning: the
 * window arrives decision-ordered from main, but a header must not depend on a
 * producer's ordering to be correct about which record it is quoting.
 */
export function newestDecidedGate(input: {
  taskId?: string | null;
  decidedApprovals?: readonly ApprovalRequest[] | null;
}): ApprovalRequest | null {
  if (!input.taskId) return null;
  const decided = (input.decidedApprovals ?? []).filter(
    (approval) =>
      approval.taskId === input.taskId && approval.status !== "pending"
  );
  if (decided.length === 0) return null;
  return [...decided].sort((left, right) =>
    (right.decidedAt ?? right.createdAt ?? "").localeCompare(
      left.decidedAt ?? left.createdAt ?? ""
    )
  )[0]!;
}

export function buildSessionHeaderFacts(input: {
  taskId?: string | null;
  /** The bounded decided-gate window from `DesktopState.decidedApprovals`. */
  decidedApprovals?: readonly ApprovalRequest[] | null;
  /**
   * This mission's budget as the dispatch budget endpoint reported it, or null
   * when it has not been read / could not be read. Null yields NO budget line —
   * an unread pool is not an exhausted one.
   */
  budget?: DispatchBudget | null;
  /** `DispatchJobRecord.executionPath` — set when the run had its own worktree. */
  executionPath?: string | null;
  /** `DispatchJobRecord.workspacePath` — the primary checkout it ran against. */
  workspacePath?: string | null;
}): SessionHeaderFact[] {
  const facts: SessionHeaderFact[] = [];

  const gate = newestDecidedGate(input);
  if (gate) {
    const decidedAt = shortInstant(gate.decidedAt ?? gate.createdAt);
    facts.push({
      id: "gate",
      label: "Last gate",
      // kind + status + when: the three fields the ledger row actually holds.
      // No reason text — that is agent-authored prose and this is a header.
      value: `${gate.kind} ${gate.status}${decidedAt ? ` · ${decidedAt}` : ""}`,
      tone: gateTone(gate.status),
    });
  }

  if (input.budget) {
    // The SHARED projection every budget surface uses, so this header and the
    // TUI's budget line cannot drift into two different arithmetics.
    const line = buildBudgetLineView(input.budget);
    if (line.status !== "unknown") {
      facts.push({
        id: "budget",
        label: "Budget",
        value: line.summaryLabel,
        tone: line.status === "exhausted" ? "danger" : "neutral",
      });
    }
  }

  // WHICH TREE, said in the ledger's own terms. A run with an `executionPath`
  // worked in an isolated worktree and its changes are NOT in the checkout; a
  // run without one edited the workspace directly. Labelling both "workspace"
  // is the confusion that makes an operator look for changes in the wrong
  // directory, so the label names which of the two this is.
  const tree = input.executionPath?.trim() || null;
  const workspace = input.workspacePath?.trim() || null;
  if (tree) {
    facts.push({
      id: "tree",
      label: "Worktree",
      value: tree,
      title: tree,
      tone: "neutral",
    });
  } else if (workspace) {
    facts.push({
      id: "tree",
      label: "Workspace",
      value: workspace,
      title: workspace,
      tone: "neutral",
    });
  }

  return facts;
}
