import { describe, expect, it } from "vitest";
import {
  CENTER_NAV_PANEL_KINDS,
  isPanelTab,
  panelTabId,
  parsePanelTab,
  PANEL_TAB_LABELS,
  WORKSPACE_PANEL_KINDS,
  type WorkspacePanelKind,
} from "../src/lib/workspace-panels.js";

const KINDS: WorkspacePanelKind[] = [...WORKSPACE_PANEL_KINDS];

describe("workspace-panels (task #130/#132 tab id model)", () => {
  it("round-trips panelTabId <-> parsePanelTab for every kind", () => {
    for (const kind of KINDS) {
      const id = panelTabId(kind);
      expect(id).toBe(`panel:${kind}`);
      expect(parsePanelTab(id)).toBe(kind);
      expect(isPanelTab(id)).toBe(true);
    }
  });

  it("has a human label for every kind", () => {
    for (const kind of KINDS) {
      expect(typeof PANEL_TAB_LABELS[kind]).toBe("string");
      expect(PANEL_TAB_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it("is collision-proof against bare job ids — a jobId is NEVER mistaken for a panel tab", () => {
    // DispatchJobRecord ids are opaque backend-generated strings with no
    // fixed shape; these are representative shapes (cuid/uuid/prefixed) that
    // must all read as "not a panel tab".
    const jobIds = [
      "job-1",
      "clv3x9f8a0000qzrmn8h2j5k1",
      "550e8400-e29b-41d4-a716-446655440000",
      "memory",
      "evidence",
      "graph",
      "panel",
      "panel:",
      "panel:job-1",
      "",
      "chat",
    ];
    for (const jobId of jobIds) {
      expect(isPanelTab(jobId)).toBe(false);
      expect(parsePanelTab(jobId)).toBeNull();
    }
  });

  it("isPanelTab is true only for the exact panel: id, never a prefix/suffix collision", () => {
    expect(isPanelTab("panel:memory")).toBe(true);
    expect(isPanelTab("panel:evidence")).toBe(true);
    expect(isPanelTab("panel:terminal")).toBe(true);
    expect(isPanelTab("panel:graph")).toBe(true);
    expect(isPanelTab("panel:memoryx")).toBe(false);
    expect(isPanelTab("xpanel:memory")).toBe(false);
    expect(isPanelTab("panel:evidencex")).toBe(false);
    expect(isPanelTab("panel:graphx")).toBe(false);
  });

  it("parsePanelTab rejects anything not shaped exactly like a panel tab id", () => {
    expect(parsePanelTab("panel:unknown")).toBeNull();
    expect(parsePanelTab("Panel:memory")).toBeNull();
    expect(parsePanelTab(" panel:memory")).toBeNull();
  });

  it("CENTER_NAV_PANEL_KINDS are the nav-reachable center tabs (not terminal)", () => {
    expect([...CENTER_NAV_PANEL_KINDS]).toEqual([
      "crew",
      "topology",
      "memory",
      "evidence",
      "control",
      "timeline",
      "graph",
      "settings",
    ]);
    expect(CENTER_NAV_PANEL_KINDS.includes("terminal" as never)).toBe(false);
  });

  it("topology is a first-class center panel tab, id-collision-proof like the rest", () => {
    expect(isPanelTab("panel:topology")).toBe(true);
    expect(parsePanelTab("panel:topology")).toBe("topology");
    expect(panelTabId("topology")).toBe("panel:topology");
    expect(PANEL_TAB_LABELS.topology).toBe("Topology");
    expect(WORKSPACE_PANEL_KINDS.includes("topology")).toBe(true);
    // A jobId that merely LOOKS like the new kind is never a panel tab.
    expect(isPanelTab("topology")).toBe(false);
    expect(isPanelTab("panel:topologyx")).toBe(false);
    expect(isPanelTab("xpanel:topology")).toBe(false);
    expect(parsePanelTab("panel:topo")).toBeNull();
  });

  it("crew and settings are first-class center panel tabs (not modals/drawers)", () => {
    expect(isPanelTab("panel:crew")).toBe(true);
    expect(parsePanelTab("panel:crew")).toBe("crew");
    expect(PANEL_TAB_LABELS.crew).toBe("Crew");
    expect(isPanelTab("panel:settings")).toBe(true);
    expect(parsePanelTab("panel:settings")).toBe("settings");
    expect(PANEL_TAB_LABELS.settings).toBe("Settings");
    expect(isPanelTab("panel:control")).toBe(true);
    expect(isPanelTab("panel:timeline")).toBe(true);
  });
});
