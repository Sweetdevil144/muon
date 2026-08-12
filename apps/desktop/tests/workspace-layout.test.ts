import { describe, expect, it } from "vitest";
import {
  INITIAL_LAYOUT,
  activeNav,
  isCenterNavTarget,
  isContextPanel,
  layoutReducer,
  reconcileFocusedApproval,
  type LayoutState,
} from "../src/renderer/lib/workspace-layout.js";

const S = (over: Partial<LayoutState> = {}): LayoutState => ({
  ...INITIAL_LAYOUT,
  ...over,
});

describe("workspace layout manager (Quiet UI)", () => {
  it("opens quiet — no right panel, terminal closed (progressive disclosure)", () => {
    expect(INITIAL_LAYOUT).toEqual({ panel: null, terminalOpen: false });
    expect(activeNav(INITIAL_LAYOUT)).toBe("mission");
  });

  it("navigating to a dock panel opens exactly that one", () => {
    const s = layoutReducer(S(), { type: "nav", target: "control" });
    expect(s.panel).toBe("control");
    expect(activeNav(s)).toBe("control");
  });

  it("only ONE panel is ever open — selecting another swaps, never stacks", () => {
    let s = layoutReducer(S(), { type: "nav", target: "control" });
    s = layoutReducer(s, { type: "nav", target: "timeline" });
    expect(s.panel).toBe("timeline");
  });

  it("re-selecting the open panel toggles it closed (quiet again)", () => {
    const s = layoutReducer(S({ panel: "control" }), {
      type: "nav",
      target: "control",
    });
    expect(s.panel).toBeNull();
    expect(activeNav(s)).toBe("mission");
  });

  it("center tabs / settings NEVER become right-dock panels", () => {
    for (const target of [
      "memory",
      "evidence",
      "graph",
      "crew",
      "settings",
    ] as const) {
      const closed = S({ panel: null });
      expect(layoutReducer(closed, { type: "nav", target })).toBe(closed);
      const open = S({ panel: "control" });
      expect(layoutReducer(open, { type: "nav", target })).toBe(open);
    }
  });

  it("isCenterNavTarget covers sidebar destinations; dock stays ContextPanel-only", () => {
    expect(isCenterNavTarget("memory")).toBe(true);
    expect(isCenterNavTarget("graph")).toBe(true);
    expect(isCenterNavTarget("crew")).toBe(true);
    expect(isCenterNavTarget("settings")).toBe(true);
    // Control/Timeline are BOTH center tabs (nav) and ContextPanels (approval dock).
    expect(isCenterNavTarget("control")).toBe(true);
    expect(isCenterNavTarget("timeline")).toBe(true);
    expect(isContextPanel("control")).toBe(true);
    expect(isContextPanel("timeline")).toBe(true);
    expect(isContextPanel("graph")).toBe(false);
    expect(isContextPanel("crew")).toBe(false);
    expect(isContextPanel("settings")).toBe(false);
  });

  it("navigating to Mission closes the right dock (focus the conversation)", () => {
    const s = layoutReducer(S({ panel: "timeline" }), {
      type: "nav",
      target: "mission",
    });
    expect(s.panel).toBeNull();
  });

  it("close-panel is idempotent and returns the same object when already closed", () => {
    const closed = S({ panel: null });
    expect(layoutReducer(closed, { type: "close-panel" })).toBe(closed);
  });

  it("terminal docks independently of the right panel", () => {
    let s = layoutReducer(S({ panel: "control" }), { type: "toggle-terminal" });
    expect(s.terminalOpen).toBe(true);
    expect(s.panel).toBe("control");
    s = layoutReducer(s, { type: "set-terminal", open: false });
    expect(s.terminalOpen).toBe(false);
  });

  it("no-op actions preserve referential identity (stable renders)", () => {
    const s = S({ panel: "control" });
    expect(layoutReducer(s, { type: "nav", target: "control" }).panel).toBeNull();
    const open = S({ terminalOpen: true });
    expect(layoutReducer(open, { type: "set-terminal", open: true })).toBe(open);
  });

  describe("reconcileFocusedApproval — a stale focus can never pin the dock", () => {
    it("keeps a focused id that is still in the ledger", () => {
      expect(reconcileFocusedApproval("a-1", ["a-1", "a-2"])).toBe("a-1");
    });

    it("DROPS a focused id that has left the ledger", () => {
      expect(reconcileFocusedApproval("a-1", ["a-2"])).toBeNull();
      expect(reconcileFocusedApproval("a-1", [])).toBeNull();
    });

    it("null/undefined focus reconciles to null", () => {
      expect(reconcileFocusedApproval(null, ["a-1"])).toBeNull();
      expect(reconcileFocusedApproval(undefined, ["a-1"])).toBeNull();
    });
  });
});
