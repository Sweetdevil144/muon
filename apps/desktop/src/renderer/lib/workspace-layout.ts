// Wave 4 / Quiet UI — workspace layout manager.
// Center tabs (Memory / Evidence / Graph / Crew / Control / Timeline / Settings /
// Terminal) live only in app.tsx openPanelTabs — NEVER right-dock overlays.
// This reducer only stores true right-dock panels (legacy control/timeline dock
// kept for approval-focus deep links) + the terminalOpen flag (unused for UI
// once Terminal is a center tab; kept for layout tests / future dock).

import { useCallback, useMemo, useReducer } from "react";

/** Right-dock panels ONLY. Never center tabs. Never modals. */
export type ContextPanel = "control" | "timeline";

/** Left-nav destinations that open CENTER workspace tabs (app.tsx openPanelTab). */
export type CenterNavTarget =
  | "memory"
  | "evidence"
  | "graph"
  | "crew"
  | "topology"
  | "control"
  | "timeline"
  | "settings";

/**
 * All left-nav / palette destinations. Center tabs + settings are NOT stored
 * as ContextPanels — onNavigate routes them; this reducer no-ops them.
 */
export type NavTarget = "mission" | ContextPanel | CenterNavTarget;

export const CENTER_NAV_TARGETS: readonly CenterNavTarget[] = [
  "memory",
  "evidence",
  "graph",
  "crew",
  "topology",
  "control",
  "timeline",
  "settings",
] as const;

export function isCenterNavTarget(target: string): target is CenterNavTarget {
  return (
    target === "memory" ||
    target === "evidence" ||
    target === "graph" ||
    target === "crew" ||
    target === "topology" ||
    target === "control" ||
    target === "timeline" ||
    target === "settings"
  );
}

export function isContextPanel(target: string): target is ContextPanel {
  return target === "control" || target === "timeline";
}

export interface LayoutState {
  /** The single open right panel, or null when the workspace is quiet. */
  panel: ContextPanel | null;
  /** Whether a bottom terminal dock is open (legacy; UI uses center tab). */
  terminalOpen: boolean;
}

export type LayoutAction =
  | { type: "nav"; target: NavTarget }
  | { type: "close-panel" }
  | { type: "toggle-terminal" }
  | { type: "set-terminal"; open: boolean };

export const INITIAL_LAYOUT: LayoutState = {
  panel: null,
  terminalOpen: false,
};

export function layoutReducer(
  state: LayoutState,
  action: LayoutAction
): LayoutState {
  switch (action.type) {
    case "nav": {
      if (action.target === "mission") {
        return state.panel === null ? state : { ...state, panel: null };
      }
      // Center tabs — NEVER stored as dock panels.
      if (!isContextPanel(action.target)) {
        return state;
      }
      const panel = state.panel === action.target ? null : action.target;
      return panel === state.panel ? state : { ...state, panel };
    }
    case "close-panel":
      return state.panel === null ? state : { ...state, panel: null };
    case "toggle-terminal":
      return { ...state, terminalOpen: !state.terminalOpen };
    case "set-terminal":
      return state.terminalOpen === action.open
        ? state
        : { ...state, terminalOpen: action.open };
    default:
      return state;
  }
}

export function activeNav(state: LayoutState): NavTarget {
  return state.panel ?? "mission";
}

export function reconcileFocusedApproval(
  focusedId: string | null | undefined,
  approvalIds: ReadonlyArray<string>
): string | null {
  if (!focusedId) return null;
  return approvalIds.includes(focusedId) ? focusedId : null;
}

export interface WorkspaceLayout extends LayoutState {
  activeNav: NavTarget;
  navigate(target: NavTarget): void;
  closePanel(): void;
  toggleTerminal(): void;
  setTerminal(open: boolean): void;
}

export function useWorkspaceLayout(
  initial: LayoutState = INITIAL_LAYOUT
): WorkspaceLayout {
  const [state, dispatch] = useReducer(layoutReducer, initial);
  const navigate = useCallback(
    (target: NavTarget) => dispatch({ type: "nav", target }),
    []
  );
  const closePanel = useCallback(() => dispatch({ type: "close-panel" }), []);
  const toggleTerminal = useCallback(
    () => dispatch({ type: "toggle-terminal" }),
    []
  );
  const setTerminal = useCallback(
    (open: boolean) => dispatch({ type: "set-terminal", open }),
    []
  );
  return useMemo(
    () => ({
      ...state,
      activeNav: activeNav(state),
      navigate,
      closePanel,
      toggleTerminal,
      setTerminal,
    }),
    [state, navigate, closePanel, toggleTerminal, setTerminal]
  );
}
