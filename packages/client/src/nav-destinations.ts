/**
 * The left-nav destinations — MUON's product fact about "where can I go",
 * shared so two surfaces cannot disagree about what the app contains.
 *
 * The desktop renders these from `left-nav.tsx`; the TUI's shell desk renders
 * the same list. Keeping it here means a destination added to the product is
 * added once, and a surface that has not implemented it yet must say so
 * rather than silently omitting it — which is the whole point of the
 * `implemented` flag below.
 *
 * COUNT, stated because a doc got it wrong: there are NINE rows, not ten.
 * Eight in the desktop's `NAV_ITEMS` plus a Settings row pinned to the foot.
 * `Terminal` is a centre TAB on the desktop, reached from the workspace tab
 * strip, and has never been a left-nav destination — the parity matrix row
 * claimed ten and was corrected against this source.
 */

export type NavDestination =
  | "mission"
  | "crew"
  | "topology"
  | "memory"
  | "evidence"
  | "control"
  | "timeline"
  | "graph"
  | "settings";

export type NavDestinationEntry = {
  readonly target: NavDestination;
  readonly label: string;
  /**
   * A one-line description of what the destination is FOR. The desktop shows
   * an icon and a word; a terminal has room for a sentence, and a nav that
   * only says "Evidence" makes a human guess.
   */
  readonly hint: string;
};

/** In the desktop's own order — Settings last, as it is pinned to the foot. */
export const NAV_DESTINATIONS: readonly NavDestinationEntry[] = [
  { target: "mission", label: "Mission", hint: "the chat and its running work" },
  { target: "crew", label: "Crew", hint: "your agents, their lanes and cost" },
  { target: "topology", label: "Topology", hint: "hub → vendor lanes → subagents" },
  { target: "memory", label: "Memory", hint: "the brain's notes and what needs you" },
  { target: "evidence", label: "Evidence", hint: "what a run actually did" },
  { target: "control", label: "Control", hint: "pending decisions and policy" },
  { target: "timeline", label: "Timeline", hint: "the ledger, in order" },
  { target: "graph", label: "Graph", hint: "the code and memory graph" },
  { target: "settings", label: "Settings", hint: "vendors, posture, workspace" },
] as const;
