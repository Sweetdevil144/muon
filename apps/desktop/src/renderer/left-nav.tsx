import type { NavTarget } from "./lib/workspace-layout.js";
import { NavIcon } from "./ui-icons.js";
import {
  NAV_DESTINATIONS,
  type NavDestination,
} from "@muon/client/nav-destinations";

// Quiet UI — the compact, LABELED left nav (never icon-only). It reports intent
// through onNavigate; the frame routes each target:
//   Mission                              → focus Mission chat tab
//   Crew / Memory / Evidence / Control /
//   Timeline / Graph / Settings          → CENTER workspace tabs (never overlays)
// Approval deep-links may still open the right Control dock separately.
// A quiet fleet summary sits at the foot.

export interface NavFleetLane {
  vendor: string;
  count: number;
  ready: boolean;
}

// The SHARED destination list (`@muon/client/nav-destinations`). "Where can
// I go" is a product fact, not a rendering detail, so the desktop and the
// TUI's shell desk read the same one — a destination added to the product is
// added once. Settings is rendered separately below, pinned to the foot, so
// it is filtered out here rather than duplicated.
//
// Notes kept from the previous literal: Topology is the live crew topology
// (MUON hub → vendor lanes → subagents), a CENTER tab like every other row
// here and never an overlay; Evidence sits beside Memory because task #130
// made both first-class CENTER workspace tabs, not a shared modal.
// EXHAUSTIVE, NOT ASSERTED. `as NavTarget` silenced the one check that
// matters: adding a destination to the shared list that the desktop's router
// cannot handle would have rendered a clickable nav item wired to nothing.
// This map makes every shared destination name a desktop target explicitly,
// so a new one is a TYPE ERROR here until someone routes it.
const DESKTOP_TARGET: Record<NavDestination, NavTarget> = {
  mission: "mission",
  crew: "crew",
  topology: "topology",
  memory: "memory",
  evidence: "evidence",
  control: "control",
  timeline: "timeline",
  graph: "graph",
  settings: "settings",
};

const NAV_ITEMS: Array<{ target: NavTarget; label: string }> =
  NAV_DESTINATIONS.filter((entry) => entry.target !== "settings").map(
    (entry) => ({ target: DESKTOP_TARGET[entry.target], label: entry.label })
  );

export function LeftNav(props: {
  active: NavTarget;
  /** Count for the Control badge (pending decisions). 0 hides it. */
  pendingDecisions: number;
  /** Whether any crew is active (a quiet dot on Crew). */
  crewActive: boolean;
  fleet: NavFleetLane[];
  onNavigate: (target: NavTarget) => void;
}) {
  return (
    <nav className="left-nav" aria-label="Workspace navigation">
      <div className="left-nav-items">
        {NAV_ITEMS.map((item) => {
          const active = props.active === item.target;
          return (
            <button
              key={item.target}
              type="button"
              aria-current={active ? "page" : undefined}
              className={`nav-item${active ? " active" : ""}`}
              onClick={() => props.onNavigate(item.target)}
            >
              <span className="nav-glyph" aria-hidden="true">
                <NavIcon target={item.target} />
              </span>
              <span className="nav-label">{item.label}</span>
              {item.target === "control" && props.pendingDecisions > 0 ? (
                <span className="nav-badge" aria-label={`${props.pendingDecisions} pending`}>
                  {props.pendingDecisions}
                </span>
              ) : null}
              {item.target === "crew" && props.crewActive ? (
                <span className="nav-dot" aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="left-nav-spacer" />

      <button
        type="button"
        aria-current={props.active === "settings" ? "page" : undefined}
        className={`nav-item${props.active === "settings" ? " active" : ""}`}
        onClick={() => props.onNavigate("settings")}
      >
        <span className="nav-glyph" aria-hidden="true">
          <NavIcon target="settings" />
        </span>
        <span className="nav-label">Settings</span>
      </button>

      {props.fleet.length > 0 ? (
        <div className="left-nav-fleet" aria-label="Fleet">
          {props.fleet.map((lane) => (
            <div className="nav-fleet-row" key={lane.vendor}>
              <span
                className={`nav-dot ${lane.ready && lane.count > 0 ? "good" : "muted"}`}
                aria-hidden="true"
              />
              <span className="nav-fleet-vendor">{lane.vendor}</span>
              <b>{lane.count}</b>
            </div>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
