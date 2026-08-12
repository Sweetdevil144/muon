import { describe, expect, it } from "vitest";
import {
  GATE_ORDER,
  noteReveal,
  topSurface,
  type RevealSurface,
  type SurfaceFlags,
} from "../src/shell/surfaces.js";

/**
 * The precedence rule, now that there is exactly one of it.
 *
 * A review named the defect: "duplicated precedence logic across
 * `centreKind`, `topLayer`, `moveFocused`, and `cycleZone`". There were
 * SIX copies counting `pop-layer` and the router, and two of them had already
 * disagreed — a fixed precedence versus reveal order — which is how Esc came
 * to close the crew drawer when the human meant the inbox.
 *
 * These are the rules the copies were supposed to share.
 */

function flags(over: Partial<SurfaceFlags> = {}): SurfaceFlags {
  return {
    composer: false,
    review: false,
    memory: false,
    help: false,
    "spawn-menu": false,
    destinations: false,
    crew: false,
    inbox: false,
    ...over,
  };
}

describe("gates are innermost, whenever they opened", () => {
  it.each(GATE_ORDER)("%s outranks every reveal", (gate) => {
    const state = flags({
      [gate]: true,
      crew: true,
      inbox: true,
      destinations: true,
    } as Partial<SurfaceFlags>);
    // The reveals were opened FIRST, and still lose: a human reading evidence
    // or typing into a field must not have a keystroke taken by a list.
    expect(topSurface(state, ["crew", "inbox", "destinations"])).toBe(gate);
  });

  it("gates rank among themselves in a fixed order", () => {
    const all = flags({ composer: true, review: true, memory: true });
    expect(topSurface(all, [])).toBe("composer");
    expect(topSurface(flags({ review: true, memory: true }), [])).toBe("review");
  });
});

describe("reveals pop in the order they were opened", () => {
  it("most recent first, in BOTH directions", () => {
    // A fixed precedence passes one direction by luck, which is exactly how
    // the old bug survived. Both are asserted.
    const state = flags({ crew: true, inbox: true });
    expect(topSurface(state, ["crew", "inbox"])).toBe("inbox");
    expect(topSurface(state, ["inbox", "crew"])).toBe("crew");
  });

  it("a stack entry that is CLOSED is ignored, not trusted", () => {
    // The flags are the truth; the stack is only the ordering. A stale entry
    // must never make this disagree with what is actually open.
    expect(topSurface(flags({ crew: true }), ["inbox", "crew"])).toBe("crew");
    expect(topSurface(flags(), ["inbox", "crew"])).toBeNull();
  });

  it("a reveal opened WITHOUT touching the stack is still reachable", () => {
    // A missed `noteReveal` must degrade to a wrong order, never to a visible
    // surface that cannot be popped.
    expect(topSurface(flags({ destinations: true }), [])).toBe("destinations");
  });

  it("nothing open means the desk itself owns the keyboard", () => {
    expect(topSurface(flags(), [])).toBeNull();
  });
});

describe("noteReveal keeps the stack honest", () => {
  it("pushes on open and REMOVES on close", () => {
    let stack: RevealSurface[] = [];
    stack = noteReveal(stack, "crew", true);
    stack = noteReveal(stack, "inbox", true);
    expect(stack).toEqual(["crew", "inbox"]);
    stack = noteReveal(stack, "inbox", false);
    expect(stack).toEqual(["crew"]);
  });

  it("re-opening moves an entry to the top rather than duplicating it", () => {
    let stack: RevealSurface[] = [];
    stack = noteReveal(stack, "crew", true);
    stack = noteReveal(stack, "inbox", true);
    stack = noteReveal(stack, "crew", true);
    expect(stack).toEqual(["inbox", "crew"]);
  });
});

describe("the sidebar is not a surface", () => {
  it("has no representation here at all", () => {
    // It is visible, not focused. Listing it made the overlay branch swallow
    // every key meant for a live terminal — the P1 that started this.
    const keys = Object.keys(flags());
    expect(keys).not.toContain("sidebar");
  });
});

describe("EVERY reveal is routable, including through the empty-stack path", () => {
  // THE REGRESSION THIS PINS. `routeKey` asks `topSurface` with an EMPTY stack
  // (it is pure and owns no reveal order), so it depends entirely on the
  // fallback list. That list was an inline array, and adding `timeline` and
  // `settings` to `RevealSurface` did not add them to it — so with a live pane
  // underneath, arrows and Enter fell straight through to the CHILD while the
  // overlay was drawn on top. A human navigating a settings list would have
  // been typing into someone else's editor.
  const REVEALS = [
    "help",
    "spawn-menu",
    "destinations",
    "crew",
    "timeline",
    "settings",
    "inbox",
  ] as const;

  const closed = {
    composer: false,
    review: false,
    memory: false,
    help: false,
    "spawn-menu": false,
    destinations: false,
    crew: false,
    timeline: false,
    settings: false,
    inbox: false,
  };

  it.each(REVEALS)("%s is found with NO reveal stack at all", (surface) => {
    expect(topSurface({ ...closed, [surface]: true }, [])).toBe(surface);
  });

  it("and the router therefore keeps its keys away from a live child", async () => {
    const { routeKey } = await import("../src/shell/keys.js");
    const live = {
      reviewOpen: false,
      reviewApprovable: false,
      reviewResolving: false,
      memoryOpen: false,
      memoryBusy: false,
      helpOpen: false,
      navOpen: false,
      spawnMenuOpen: false,
      crewOpen: false,
      timelineOpen: false,
      settingsOpen: false,
      sidebarOpen: false,
      inboxFocused: false,
      inboxHasRows: false,
      livePane: true,
      governedOpen: false,
      corpseOnScreen: false,
      prefixArmed: false,
      composerOpen: false,
      composerBusy: false,
    };
    const ESCAPE = String.fromCodePoint(0x1b);
    for (const open of ["timelineOpen", "settingsOpen"] as const) {
      const scope = { ...live, [open]: true };
      expect(routeKey(`${ESCAPE}[B`, scope), open).toEqual({
        kind: "move",
        delta: 1,
      });
      expect(routeKey("\r", scope), open).toEqual({ kind: "activate" });
      expect(routeKey(ESCAPE, scope), open).toEqual({ kind: "pop-layer" });
    }
  });
});
