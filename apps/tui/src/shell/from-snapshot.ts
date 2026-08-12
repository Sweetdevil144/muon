import type { BrainSnapshot } from "../lib/brain-store.js";
import type { SidebarState } from "./sidebar.js";
import type { TabStripState } from "./tab-strip.js";

/**
 * BrainSnapshot → shell state. Pure, so the mapping is testable without a
 * terminal and the shell components never learn the store's shape.
 *
 * The grouping mirrors the desktop's left-nav: spaces = the workspace the
 * brain is bound to (multi-workspace arrives with the matrix's group-A rows),
 * agents = the crew with live status, in the fleet's own order.
 */

export function sidebarFromSnapshot(
  snapshot: BrainSnapshot,
  cursor: number,
  scopes: SidebarState["scopes"],
  workspace?: string
): SidebarState {
  const spaceName = workspace
    ? workspace.replace(/\/+$/, "").split("/").pop() || workspace
    : "muon";
  return {
    spaces: [
      {
        key: "workspace",
        name: spaceName,
        // `health` is null while the brain is unreachable — Health itself is
        // always {status:"ok"} when present, so null IS the failure signal.
        ...(snapshot.health === null ? { detail: "brain unreachable" } : {}),
      },
    ],
    agents: (snapshot.agents ?? []).map((agent) => ({
      key: agent.id,
      name: agent.name ?? agent.id,
      status: agent.status ?? "unknown",
      vendor: agent.vendor ?? "?",
    })),
    cursor,
    scopes,
  };
}

export function tabsFromState(
  tabs: readonly { id: string; title: string }[],
  activeId: string
): TabStripState {
  return { tabs, activeId };
}
