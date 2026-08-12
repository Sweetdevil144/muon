// ADR-0032 D2 — the desk's center tabs.
//
// A tab is a persistent object; switching is an index change and nothing
// remounts or refetches. This module owns the tab LIST and its invariants only:
// which tabs exist, which is active, and what each one's retained state is.
// Rendering lives in the components; the per-kind payloads live in App state
// keyed by tab id.
//
// Why this is a module and not three `useState`s: the inventory found that
// opening an agent stream reset its cursor and REPLACED its buffer, losing
// history past 200 chunks. Dedup-by-id (`openTab` focusing an existing tab
// instead of creating a second one) is what makes re-opening cheap, and it is
// only correct if exactly one place decides tab identity.

export type DeskTabKind =
  | "chat"
  | "desk"
  | "memory"
  | "brain"
  | "crew"
  | "mcp"
  | "workflow"
  | "stream"
  | "task";

export type DeskTab = {
  /** Stable identity. Dynamic kinds carry their subject: `stream:<agentId>`. */
  readonly id: string;
  readonly kind: DeskTabKind;
  readonly title: string;
  /** Permanent tabs (chat, desk) refuse to close. */
  readonly closable: boolean;
  /**
   * The subject this tab is bound to (agent id, task id). Absent for the
   * singleton kinds. Kept so a tab can re-resolve its subject without the
   * renderer parsing the id string.
   */
  readonly subject?: string;
};

export type DeskTabsState = {
  readonly tabs: readonly DeskTab[];
  readonly activeId: string;
};

/**
 * The two permanent tabs. `chat` first because it is the front door, and both
 * exist at all widths — retiring the inventory's finding that widening the
 * terminal past 150 columns REMOVED the conversation (chat and desk were a
 * ternary, not tabs).
 */
export const CHAT_TAB: DeskTab = {
  id: "chat",
  kind: "chat",
  title: "chat",
  closable: false,
};

export const DESK_TAB: DeskTab = {
  id: "desk",
  kind: "desk",
  title: "crew",
  closable: false,
};

export function initialDeskTabs(): DeskTabsState {
  return { tabs: [CHAT_TAB, DESK_TAB], activeId: CHAT_TAB.id };
}

/** Dynamic tab ids are `kind` or `kind:subject` — one place, one spelling. */
export function deskTabId(kind: DeskTabKind, subject?: string): string {
  return subject ? `${kind}:${subject}` : kind;
}

export function findTab(
  state: DeskTabsState,
  id: string
): DeskTab | undefined {
  return state.tabs.find((tab) => tab.id === id);
}

export function activeTab(state: DeskTabsState): DeskTab {
  // The active id is an invariant of every transition below, but a caller
  // holding a stale snapshot should still get a real tab rather than undefined.
  return findTab(state, state.activeId) ?? state.tabs[0] ?? CHAT_TAB;
}

/**
 * Open a tab, or focus it if its id already exists — the dedup that keeps a
 * re-opened stream's scrollback and cursor intact. Never creates a duplicate.
 */
export function openTab(
  state: DeskTabsState,
  tab: DeskTab
): DeskTabsState {
  const existing = findTab(state, tab.id);
  if (existing) {
    return { tabs: state.tabs, activeId: existing.id };
  }
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Close a tab. Permanent tabs refuse. Closing the active tab activates its
 * left neighbour (never wrapping to the far end, which reads as a jump).
 */
export function closeTab(state: DeskTabsState, id: string): DeskTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const target = state.tabs[index]!;
  if (!target.closable) return state;

  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) return initialDeskTabs();
  if (state.activeId !== id) return { tabs, activeId: state.activeId };

  const neighbour = tabs[Math.max(0, index - 1)] ?? tabs[0]!;
  return { tabs, activeId: neighbour.id };
}

export function activateTab(
  state: DeskTabsState,
  id: string
): DeskTabsState {
  return findTab(state, id) ? { tabs: state.tabs, activeId: id } : state;
}

/** `1`-`9`: activate the Nth tab. Out of range is a no-op, never a wrap. */
export function activateTabByOrdinal(
  state: DeskTabsState,
  ordinal: number
): DeskTabsState {
  const tab = state.tabs[ordinal - 1];
  return tab ? { tabs: state.tabs, activeId: tab.id } : state;
}

/** `[` / `]`: cycle. Wraps, because cycling is explicitly a ring. */
export function cycleTab(
  state: DeskTabsState,
  direction: "next" | "prev"
): DeskTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  if (index < 0 || state.tabs.length === 0) return state;
  const delta = direction === "next" ? 1 : -1;
  const next =
    (index + delta + state.tabs.length) % state.tabs.length;
  return { tabs: state.tabs, activeId: state.tabs[next]!.id };
}

/**
 * Drop per-tab retained state for tabs that no longer exist.
 *
 * Called after a close so a long session cannot accumulate the state of every
 * stream ever opened. Deliberately takes and returns a plain record: the caller
 * owns the payload shape, this module owns only the key set.
 */
export function pruneTabState<T>(
  state: DeskTabsState,
  byTabId: Readonly<Record<string, T>>
): Record<string, T> {
  const live = new Set(state.tabs.map((tab) => tab.id));
  const kept: Record<string, T> = {};
  for (const [id, value] of Object.entries(byTabId)) {
    if (live.has(id)) kept[id] = value;
  }
  return kept;
}
