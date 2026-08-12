/**
 * Center workspace tabs (collision-proof `panel:` ids). Never overlays.
 * Mission chat is the default center surface (id "chat"); these are extra tabs.
 */

export type WorkspacePanelKind =
  | "memory"
  | "evidence"
  | "terminal"
  | "graph"
  | "crew"
  | "topology"
  | "control"
  | "timeline"
  | "settings";

/** The `panel:` id for a given kind — the collision-proof tab id itself. */
export type PanelTabId = `panel:${WorkspacePanelKind}`;

export const PANEL_TAB_LABELS: Record<WorkspacePanelKind, string> = {
  memory: "Memory",
  evidence: "Evidence",
  terminal: "Terminal",
  graph: "Graph",
  crew: "Crew",
  topology: "Topology",
  control: "Control",
  timeline: "Timeline",
  settings: "Settings",
};

/** Every panel kind — use for exhaustiveness (switch default: never). */
export const WORKSPACE_PANEL_KINDS: readonly WorkspacePanelKind[] = [
  "memory",
  "evidence",
  "terminal",
  "graph",
  "crew",
  "topology",
  "control",
  "timeline",
  "settings",
] as const;

/**
 * Panel kinds opened from left-nav as CENTER tabs.
 * Terminal is also strip-reachable ("+ Terminal") but not a left-nav row.
 */
export const CENTER_NAV_PANEL_KINDS: readonly WorkspacePanelKind[] = [
  "crew",
  "topology",
  "memory",
  "evidence",
  "control",
  "timeline",
  "graph",
  "settings",
] as const;

export function panelTabId(kind: WorkspacePanelKind): PanelTabId {
  return `panel:${kind}`;
}

export function isPanelTab(id: string): id is PanelTabId {
  return parsePanelTab(id) !== null;
}

export function parsePanelTab(id: string): WorkspacePanelKind | null {
  if (!id.startsWith("panel:")) return null;
  const kind = id.slice("panel:".length);
  switch (kind) {
    case "memory":
    case "evidence":
    case "terminal":
    case "graph":
    case "crew":
    case "topology":
    case "control":
    case "timeline":
    case "settings":
      return kind;
    default:
      return null;
  }
}
