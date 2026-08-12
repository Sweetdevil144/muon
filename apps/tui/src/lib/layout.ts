/** Columns need ~110 cols; below that we use a compact stacked cockpit. */
export const COLUMN_LAYOUT_MIN_WIDTH = 110;
/** Five live crew cards remain legible only once each can keep ~20 columns. */
export const DESK_LAYOUT_MIN_WIDTH = 150;

export type LayoutMode = "desk" | "columns" | "side-panel";

export function resolveLayoutMode(terminalWidth: number): LayoutMode {
  if (terminalWidth >= DESK_LAYOUT_MIN_WIDTH) return "desk";
  return terminalWidth >= COLUMN_LAYOUT_MIN_WIDTH ? "columns" : "side-panel";
}

/** Height-aware row budget so 80x24 / 100x30 get real compositions. */
export type RowBudget = {
  profile: "compact" | "standard" | "tall";
  agents: number;
  tasks: number;
  chat: number;
  approvals: number;
  handoffs: number;
};

/**
 * Side-panel chrome that is NOT covered by these budgets (Header 2 + Rule x3
 * 3 + Diagnostics 2 + DispatchHero 3 + CommandBar 2 + Footer 1 = 13
 * structural rows), plus every budgeted zone's own label/hint overhead that
 * sits outside its maxRows-bounded list (FleetRail label 1 [+ hint 1 once
 * not compact] + the fleet/task mission-budget row 1 (MissionBudgetLine, S9
 * TUI parity — replaced what used to be a blank spacer, same row count) +
 * TaskLedger label 1 + ChatPane label 1 + ReviewInbox label+counts+hint 3 +
 * HandoffsPanel label 1 = 8 compact / 9 standard), already claims ~21-22 rows
 * before a single list row renders. Budgets below are sized so chrome +
 * budgets fits the profile's floor (24 rows compact, 30 rows standard); see
 * layout.test.ts for the arithmetic. Whatever the arithmetic doesn't cover
 * (odd wraps, onboarding, error lines) is caught by the overflow="hidden"
 * regions in App.tsx, which clip instead of scrolling the terminal.
 */
export function resolveRowBudget(height: number): RowBudget {
  if (height <= 26) {
    return { profile: "compact", agents: 1, tasks: 1, chat: 1, approvals: 0, handoffs: 0 };
  }
  if (height <= 34) {
    return { profile: "standard", agents: 2, tasks: 2, chat: 2, approvals: 1, handoffs: 1 };
  }
  return { profile: "tall", agents: 9, tasks: 16, chat: 18, approvals: 4, handoffs: 8 };
}

export type FocusZone =
  | "tasks"
  | "lanes"
  | "approvals"
  | "handoffs"
  | "palette";

export function nextFocusZone(
  current: FocusZone,
  direction: "next" | "prev"
): FocusZone {
  const order: FocusZone[] = ["tasks", "lanes", "approvals", "handoffs"];
  if (current === "palette") {
    return direction === "next" ? "tasks" : "handoffs";
  }
  const index = order.indexOf(current);
  if (index < 0) {
    return "tasks";
  }
  const delta = direction === "next" ? 1 : -1;
  const next = (index + delta + order.length) % order.length;
  return order[next]!;
}
