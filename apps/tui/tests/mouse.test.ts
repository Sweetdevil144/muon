import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  childWantsMouse,
  encodeMouse,
  isMouseReport,
  parseMouse,
  splitMouseReports,
} from "../src/shell/mouse.js";
import { Desk } from "../src/shell/desk.js";
import { Footer, footerHints } from "../src/shell/footer.js";
import type { SessionManager } from "../src/shell/session-manager.js";
import type { RestoreEntry } from "../src/shell/restore-snapshot.js";
import { intentForAction, routeKey } from "../src/shell/keys.js";
import { KEYMAP } from "../src/shell/keymap.js";
import { buildSpawnMenuState } from "../src/shell/spawn-menu.js";
import type { Component } from "../src/vendor/pi-tui/src/tui.ts";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { visibleWidth } from "../src/vendor/pi-tui/src/utils.ts";

/**
 * CLICKING THE DESK.
 *
 * The founder asked for the desktop's interaction model in the terminal: click
 * `+` to open a tab, click a session in the rail to go to it. There is a
 * second reason it matters, which the key doctor's first run made concrete —
 * what a terminal delivers is not MUON's decision. A desk drivable only by
 * chords is one that some terminal, somewhere, can lock a user out of.
 *
 * THE RULE THESE TESTS DEFEND: MUON takes clicks on chrome it drew, and never
 * on the pane. A vendor CLI may have armed mouse tracking of its own, and
 * stealing those clicks would break the tools this desk exists to host.
 */

const ESC = String.fromCodePoint(0x1b);
const sgr = (button: number, col: number, row: number, press = true) =>
  `${ESC}[<${button};${col};${row}${press ? "M" : "m"}`;

/**
 * Reveal the rail AND push the new state into the shell.
 *
 * `handleKey` alone is not enough: the desk publishes to the shell on render,
 * which the real app drives through `onChange`. Without this the rail is never
 * drawn and a hit-test lands on the pane behind it.
 */
function showSidebar(desk: Desk): Desk {
  desk.handleKey(String.fromCodePoint(2));
  desk.handleKey("s");
  desk.render();
  return desk;
}

/**
 * Pretend a LIVE PTY occupies the centre.
 *
 * `handleMouse` forwards a pane click only when `centreKind()` is `pty`,
 * because the same region also draws settings, help, the nav and a frozen
 * corpse — and a click forwarded through one of those reaches a child the
 * human cannot see. This harness cannot open a real pty, so the surface is
 * stubbed; the tests below are about ROUTING, not session lifecycle.
 */
function asPtyCentre(desk: Desk): Desk {
  (desk as unknown as { centreKind: () => string }).centreKind = () => "pty";
  return desk;
}

function makeDesk() {
  const snapshot = emptyBrainSnapshot();
  const desk = new Desk({
    client: {
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 80, rows: 20 }),
    terminalRows: () => 24,
    terminalColumns: () => 100,
    cwd: () => "/repo",
    branch: () => "dev",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
  return desk;
}

describe("reading an SGR mouse report", () => {
  it("decodes a left press, one-based to zero-based", () => {
    expect(parseMouse(sgr(0, 12, 3))).toEqual({
      col: 11,
      row: 2,
      kind: "press",
      button: 0,
    });
  });

  it("tells a release from a press", () => {
    expect(parseMouse(sgr(0, 5, 5, false))?.kind).toBe("release");
  });

  it("reads the wheel DIRECTION, including horizontal", () => {
    // 64-67 are up, down, left, right. The direction lives in the low two
    // bits; reading only the low bit reports a horizontal scroll as "up",
    // which is how a trackpad's sideways swipe becomes a wrong action.
    const wheel = [0, 1, 2, 3].map(
      (offset) => parseMouse(sgr(64 + offset, 1, 1))!
    );
    expect(wheel.map((event) => event.kind)).toEqual(Array(4).fill("wheel"));
    expect(wheel.map((event) => event.button)).toEqual([0, 1, 2, 3]);
  });

  it("marks a drag as a drag", () => {
    expect(parseMouse(sgr(32, 4, 4))?.kind).toBe("drag");
  });

  it("refuses anything that is not exactly a mouse report", () => {
    // Guessing here means swallowing a keystroke.
    for (const bytes of ["", "a", `${ESC}[A`, `${ESC}[<0;1M`, `${ESC}[<0;1;1X`]) {
      expect(parseMouse(bytes), JSON.stringify(bytes)).toBeNull();
      expect(isMouseReport(bytes)).toBe(false);
    }
  });
});

describe("the pane belongs to the child", () => {
  it("does NOT consume a click inside the pane", () => {
    // The load-bearing test. A vendor CLI that armed mouse tracking must get
    // its own clicks; if this ever returns true, every mouse-driven tool
    // running inside MUON silently breaks.
    const desk = asPtyCentre(makeDesk());
    expect(desk.handleMouse(sgr(0, 40, 12), 100)).toBe(false);
  });

  it("does not consume the wheel, so a pager still scrolls", () => {
    const desk = asPtyCentre(makeDesk());
    expect(desk.handleMouse(sgr(64, 40, 12), 100)).toBe(false);
    expect(desk.handleMouse(sgr(65, 40, 12), 100)).toBe(false);
  });

  it("ignores releases and drags entirely", () => {
    // Acting on release too would fire every click twice, and a drag that
    // started in the pane must not become a chrome click where it ends.
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(0, 2, 1, false), 100)).toBe(false);
    expect(desk.handleMouse(sgr(32, 2, 1), 100)).toBe(false);
  });

  it("ignores the right button, which terminals bind to paste", () => {
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(2, 2, 1), 100)).toBe(false);
  });
});

describe("clicking chrome does what the chord does", () => {
  it("clicking `+` opens the same picker as the new-tab chord", () => {
    const desk = makeDesk();
    const strip = desk.shell.render(100)[0]!;
    const plus = strip.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").indexOf("+");
    expect(plus, "the strip draws a + to click").toBeGreaterThan(-1);

    expect(desk.handleMouse(sgr(0, plus + 1, 1), 100)).toBe(true);
    expect(desk.centreKind()).toBe("spawn-menu");
  });

  it("a click on MUON's rail is consumed even when the row does nothing", () => {
    // Otherwise the raw report is forwarded and `<0;3;5M` is TYPED into the
    // pane — the same class of bug as an undecoded chord.
    //
    // The first version of this test asserted the same thing at row 1, where
    // the rail is not yet drawn — it hit a TAB and passed for the wrong
    // reason. The hit is asserted explicitly now so it cannot drift back.
    const desk = showSidebar(makeDesk());
    expect(desk.shell.hitTest(100, 3, 5).zone).toBe("sidebar");
    expect(desk.handleMouse(sgr(0, 4, 6), 100)).toBe(true);
  });

  it("a click outside every zone is not consumed", () => {
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(0, 999, 999), 100)).toBe(false);
  });
});

describe("what is drawn is what is clicked", () => {
  it("the tab under the pointer is the tab that activates", () => {
    // Hit-testing reads the same layout() the frame is drawn from. This pins
    // the agreement: whatever the strip renders at a column, hitTest names.
    const desk = makeDesk();
    const zones = (desk.shell as never as {
      tabStrip: { zones: (w: number) => { start: number; end: number; target: unknown }[] };
    }).tabStrip.zones(100);
    for (const zone of zones) {
      const hit = desk.shell.hitTest(100, zone.start, 0);
      expect(hit.zone, `column ${zone.start}`).toBe("tab");
      if (hit.zone === "tab") expect(hit.target).toEqual(zone.target);
    }
  });

  it("a half-visible tab at the right edge is not a target", () => {
    // Clicking the sliver of a tab that got clipped would activate something
    // the human cannot see.
    const desk = makeDesk();
    const zones = (desk.shell as never as {
      tabStrip: { zones: (w: number) => { end: number }[] };
    }).tabStrip.zones(4);
    for (const zone of zones) expect(zone.end).toBeLessThanOrEqual(4);
  });
});

describe("a click forwarded to the child arrives in the CHILD's coordinates", () => {
  it("round-trips a report unchanged when nothing is offset", () => {
    const event = parseMouse(sgr(0, 12, 3))!;
    expect(encodeMouse(event, event.col, event.row)).toBe(sgr(0, 12, 3));
  });

  it("preserves the release marker and the wheel encoding", () => {
    const release = parseMouse(sgr(0, 9, 9, false))!;
    expect(encodeMouse(release, 0, 0)).toBe(`${ESC}[<0;1;1m`);
    const down = parseMouse(sgr(65, 9, 9))!;
    expect(encodeMouse(down, 0, 0)).toBe(`${ESC}[<65;1;1M`);
    const drag = parseMouse(sgr(32, 9, 9))!;
    expect(encodeMouse(drag, 0, 0)).toBe(`${ESC}[<32;1;1M`);
  });

  it("SUBTRACTS the chrome the child is drawn inside", () => {
    // The tab strip takes a row. A child told the absolute row would place
    // every click one line below where the human aimed — and it would look
    // like it works, which is the worst kind of wrong.
    const desk = makeDesk();
    const forwarded = (desk as never as {
      mouseForChild: (raw: string, width: number) => string;
    }).mouseForChild(sgr(0, 30, 5), 100);
    const moved = parseMouse(forwarded)!;
    expect(moved.row, "the strip's row is not the child's row").toBeLessThan(4);
    expect(moved.col).toBe(29);
  });

  it("shifts columns too once the rail is showing", () => {
    const desk = showSidebar(makeDesk());
    const forwarded = (desk as never as {
      mouseForChild: (raw: string, width: number) => string;
    }).mouseForChild(sgr(0, 60, 5), 100);
    expect(parseMouse(forwarded)!.col).toBeLessThan(59);
  });
});

describe("engine chrome is never typed into the child", () => {
  it("swallows focus in/out reports", () => {
    // `?1004h` is armed by the engine, so these arrive whether or not anything
    // asked for them. A child that did not arm focus reporting cannot tell
    // `ESC[I` from someone typing.
    const desk = makeDesk();
    expect(desk.handleKey(`${ESC}[I`).kind).toBe("none");
    expect(desk.handleKey(`${ESC}[O`).kind).toBe("none");
  });

  it("but a real escape sequence is still ROUTED, not swallowed", () => {
    // The narrow swallow must stay narrow. An arrow resolves to a move here
    // rather than to-child, which is why this asserts "not none" instead of
    // naming an intent the scope does not actually produce.
    const desk = makeDesk();
    expect(desk.handleKey(`${ESC}[A`).kind).not.toBe("none");
    expect(desk.handleKey(`${ESC}[B`).kind).not.toBe("none");
  });
});

describe("what is captured on the way out matches what was drawn", () => {
  it("the desk's pane geometry narrows when the rail is showing", () => {
    // ADR-0047 captures each session's screen WITH the geometry it was
    // rendered at. Shutdown used to read the terminal-wide fallback instead of
    // the desk's real pane, so a corpse captured with the sidebar open was
    // restored at full width and re-wrapped into nonsense.
    const desk = makeDesk();
    const wide = desk.paneGeometry();
    const narrow = showSidebar(desk).paneGeometry();
    expect(narrow.cols).toBeLessThan(wide.cols);
  });
});

describe("a split routes clicks to the half that was clicked", () => {
  /**
   * The bug an adversarial review found in the first version of this: every
   * pane hit was reported with CENTRE-relative coordinates and delivered to
   * the focused session. A click in the right half therefore reached the LEFT
   * child, at a column past its right edge — a wrong action on a wrong
   * session, which is worse than doing nothing.
   *
   * The panes are set DIRECTLY rather than by pressing the split chord. The
   * first version of these tests pressed `ctrl+b |`, which needs a live pty
   * this harness has none of, so paneCount stayed 1 and every assertion was
   * skipped behind a guard. Three green ticks, nothing tested.
   */
  const fakePane = (): Component => ({ render: () => [], invalidate: () => {} });

  function splitDesk() {
    const desk = asPtyCentre(makeDesk());
    desk.shell.setPanes([fakePane(), fakePane()], 0);
    expect(desk.shell.paneCount(), "the harness really is split").toBe(2);
    return desk;
  }

  it("names the pane, and gives coordinates local to it", () => {
    const desk = splitDesk();
    const left = desk.shell.hitTest(100, 5, 3);
    const right = desk.shell.hitTest(100, 90, 3);
    expect(left).toMatchObject({ zone: "pane", pane: 0, col: 5 });
    expect(right).toMatchObject({ zone: "pane", pane: 1 });
    if (right.zone === "pane") {
      // 90 is centre-relative; the right half starts at its own column 0.
      expect(right.col).toBe(90 - splitLeft(100) - 1);
      expect(right.col).toBeLessThan(50);
    }
  });

  it("the divider belongs to neither child", () => {
    const desk = splitDesk();
    expect(desk.shell.hitTest(100, splitLeft(100), 3).zone).toBe("none");
  });

  it("clicking the unfocused half FOCUSES it instead of acting in it", () => {
    const desk = splitDesk();
    expect(desk.focusedPaneIndex()).toBe(0);
    expect(desk.handleMouse(sgr(0, 91, 4), 100)).toBe(true);
    expect(desk.focusedPaneIndex()).toBe(1);
    // And a second click in the now-focused half is the child's.
    expect(desk.handleMouse(sgr(0, 91, 4), 100)).toBe(false);
  });

  it("a click in the FOCUSED half is forwarded, not consumed", () => {
    const desk = splitDesk();
    expect(desk.handleMouse(sgr(0, 5, 4), 100)).toBe(false);
  });
});

/** The divider column, mirroring the shell's own arithmetic. */
function splitLeft(centreWidth: number): number {
  return Math.max(10, Math.floor((centreWidth - 1) / 2));
}

describe("chrome MUON drew is never forwarded, even where it does nothing yet", () => {
  it("consumes a click on the inbox rail", () => {
    // The inbox is MUON's chrome. Falling through sent the untranslated report
    // to the vendor pane, so clicking an approval fired something unrelated in
    // the child at unrelated coordinates — a wrong action, not a no-op.
    const desk = makeDesk();
    const hit = { zone: "inbox" } as const;
    expect(hit.zone).toBe("inbox");
    // Drive it through the real router with a stubbed hit-test, because the
    // inbox only takes a column when there is something in it.
    const shell = desk.shell as unknown as { hitTest: () => unknown };
    const real = shell.hitTest;
    shell.hitTest = () => hit;
    try {
      expect(desk.handleMouse(sgr(0, 95, 5), 100)).toBe(true);
    } finally {
      shell.hitTest = real;
    }
  });
});

describe("each half of a split is measured on its own", () => {
  it("gives the halves of an even centre their real, different widths", () => {
    // `paneGeometry()` reports the LEFT width, and resize applied it to both
    // children. The two halves of an even centre differ by a column, so the
    // right child was told it was one narrower than it is and rendered into a
    // dead or wrapped edge column.
    const desk = makeDesk();
    desk.shell.setPanes(
      [
        { render: () => [], invalidate: () => {} },
        { render: () => [], invalidate: () => {} },
      ],
      0
    );
    const left = desk.shell.paneViewportAt(100, 0);
    const right = desk.shell.paneViewportAt(100, 1);
    expect(left.cols + 1 + right.cols, "the halves and the divider fill the centre").toBe(
      100
    );
    expect(right.cols).not.toBe(left.cols);
  });

  it("an unsplit pane is unaffected", () => {
    const desk = makeDesk();
    expect(desk.shell.paneViewportAt(100, 0)).toEqual(desk.shell.paneViewport(100));
  });
});

describe("the focused half is the one measured", () => {
  it("paneViewport follows FOCUS, not the left half", () => {
    // It returned the left width unconditionally while claiming to answer for
    // the focused pane, so a newly opened right-hand pty started at the wrong
    // width — and its ADR-0047 snapshot was captured at that width — until a
    // terminal resize happened to correct it.
    const desk = makeDesk();
    const pane = (): Component => ({ render: () => [], invalidate: () => {} });
    desk.shell.setPanes([pane(), pane()], 1);
    expect(desk.shell.paneViewport(100)).toEqual(desk.shell.paneViewportAt(100, 1));
    desk.shell.setPanes([pane(), pane()], 0);
    expect(desk.shell.paneViewport(100)).toEqual(desk.shell.paneViewportAt(100, 0));
  });
});

describe("a shutdown snapshot records each session's OWN geometry", () => {
  it("gives the right half of a split its own width", () => {
    // ADR-0047 stores a screen with the size it was drawn for and re-wraps to
    // that size on restore. Capturing every session at the FOCUSED pane's size
    // meant the other half came back re-wrapped — the one place a human meets
    // this bug is after a restart, when the evidence of the cause is gone.
    const desk = makeDesk();
    const pane = (): Component => ({ render: () => [], invalidate: () => {} });
    desk.shell.setPanes([pane(), pane()], 0);
    // The harness cannot open real ptys, so the SPLIT RELATIONSHIP is stubbed
    // — that is the input `geometryOf` routes on, and routing is what broke.
    (desk as unknown as { sessions: unknown }).sessions = {
      topLevel: () => [{ id: "parent" }],
      splitOf: (id: string) => (id === "parent" ? { id: "child" } : null),
    };
    expect(desk.geometryOf("child")).toEqual(desk.shell.paneViewportAt(100, 1));
    expect(desk.geometryOf("parent")).toEqual(desk.shell.paneViewportAt(100, 0));
    expect(
      desk.geometryOf("child").cols,
      "and the two really are different sizes"
    ).not.toBe(desk.geometryOf("parent").cols);
  });
});

describe("a child hears about the mouse only if it ASKED", () => {
  /**
   * THE FOUNDER'S PANE FILLED WITH `<35;46;32M<35;47;31M…` on every mouse move.
   *
   * MUON's host terminal has all-motion tracking armed for the engine's own
   * selection handling, so pointer movement produces a report continuously —
   * whether or not the program in the pane wants one. Most CLIs never arm
   * mouse tracking at all, so those reports arrived as ordinary bytes and were
   * TYPED into the child, once per movement.
   *
   * The fix is the same principle as the pane rule itself: the child's own
   * declared mode decides, exactly as it would in a real terminal.
   */
  const press = parseMouse(sgr(0, 5, 5))!;
  const release = parseMouse(sgr(0, 5, 5, false))!;
  const drag = parseMouse(sgr(32, 5, 5))!;
  const move = parseMouse(sgr(35, 5, 5))!;
  const wheel = parseMouse(sgr(64, 5, 5))!;

  it("reads bare motion as a MOVE, not a drag", () => {
    // Button bits `11` mean no button held. Folded into `drag` it looked like
    // a gesture something might want; it is the most frequent report a
    // terminal produces and almost nothing asks for it.
    expect(move.kind).toBe("move");
    expect(drag.kind).toBe("drag");
  });

  it("a child that armed NOTHING gets nothing", () => {
    for (const event of [press, release, drag, move, wheel]) {
      expect(childWantsMouse("none", event), event.kind).toBe(false);
    }
  });

  it("x10 gets presses only", () => {
    expect(childWantsMouse("x10", press)).toBe(true);
    expect(childWantsMouse("x10", release)).toBe(false);
    expect(childWantsMouse("x10", move)).toBe(false);
  });

  it("drag-tracking gets everything EXCEPT bare motion", () => {
    expect(childWantsMouse("drag", drag)).toBe(true);
    expect(childWantsMouse("drag", press)).toBe(true);
    expect(childWantsMouse("drag", move), "the noisy one").toBe(false);
  });

  it("all-motion tracking gets bare motion too", () => {
    expect(childWantsMouse("any", move)).toBe(true);
  });

  it("the DESK consults the child's mode before forwarding", () => {
    // The first version of this asserted `kind === "none"` on a harness with
    // no live pane — where the answer is "none" whether or not the gate
    // exists. It passed with the fix removed. The two outcomes have to be
    // able to DIFFER for the test to mean anything, so a live pane and a
    // child mode are both stubbed.
    const withMode = (mode: "none" | "any") => {
      const desk = makeDesk();
      // `write` is needed because a forwarded intent is actually delivered.
      const live = { session: { mouseTracking: mode, write: () => {} } };
      Object.assign(desk as unknown as Record<string, unknown>, {
        focusedSession: () => live.session,
      });
      const scope = (desk as unknown as { scope: () => object }).scope.bind(desk);
      (desk as unknown as { scope: () => object }).scope = () => ({
        ...scope(),
        livePane: true,
      });
      return desk;
    };

    // A child that armed all-motion tracking gets the report…
    expect(withMode("any").handleKey(sgr(35, 40, 12)).kind).toBe("to-child");
    // …and one that armed nothing does not, which is the founder's bug.
    expect(withMode("none").handleKey(sgr(35, 40, 12)).kind).toBe("none");
  });
});

describe("the footer chord list is clickable", () => {
  /**
   * The founder asked for it, and it is the strongest version of the mouse
   * argument: the footer is the only chord list always on screen, so making it
   * clickable means a human can drive the desk knowing no chords at all — and
   * a terminal that swallows a chord cannot take that away.
   */
  const hintCol = (action: string) => {
    const hint = footerHints().find((candidate) => candidate.action === action)!;
    expect(hint, `the footer advertises ${action}`).toBeDefined();
    // Middle of the hint, one-based for the SGR report.
    return Math.floor((hint.start + hint.end) / 2) + 1;
  };

  function footerRow(desk: Desk): number {
    // Last line of the frame, one-based.
    return desk.shell.render(200).length;
  }

  it("hit-tests every advertised hint to its own action", () => {
    const desk = makeDesk();
    const rows = desk.shell.render(200).length;
    for (const hint of footerHints()) {
      const hit = desk.shell.hitTest(200, hint.start, rows - 1);
      expect(hit, `${hint.action} at column ${hint.start}`).toMatchObject({
        zone: "hint",
        action: hint.action,
      });
    }
  });

  it("clicking `sessions` reveals the sidebar, exactly as the chord does", () => {
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(0, hintCol("toggle-sidebar"), footerRow(desk)), 200)).toBe(
      true
    );
    desk.render();
    expect(desk.shell.render(200).join("\n")).toContain("SPACES");
  });

  it("clicking `new` opens the same picker as ctrl+b t", () => {
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(0, hintCol("new-tab"), footerRow(desk)), 200)).toBe(true);
    expect(desk.centreKind()).toBe("spawn-menu");
  });

  it("a gap BETWEEN hints does nothing", () => {
    // The separators are not targets: a click that misses must be a no-op
    // rather than the nearest action.
    const desk = makeDesk();
    const first = footerHints()[0]!;
    const rows = desk.shell.render(200).length;
    expect(desk.shell.hitTest(200, first.end, rows - 1).zone).toBe("none");
  });

  it("and a click PAST the last hint does nothing", () => {
    const desk = makeDesk();
    const rows = desk.shell.render(200).length;
    expect(desk.shell.hitTest(200, 195, rows - 1).zone).toBe("none");
  });
});

describe("the frame is the terminal's size, never a hardcoded one", () => {
  /**
   * The founder read a mostly-empty pane as "the TUI is not full screen…
   * it should not be hardcoded". This pins the property that answers it: for
   * ANY terminal size the frame fills exactly that many rows and no line
   * exceeds that many columns. A hardcoded 80x24 anywhere fails this at the
   * first size that is not 80x24.
   *
   * (What that screenshot actually showed is a RESTORED CORPSE — a screen
   * captured at the size it was drawn at when MUON last quit, replayed as
   * text. It cannot be re-wrapped honestly, which is why it is labelled ENDED
   * rather than presented as a live pane.)
   */
  const strip = (line: string) =>
    line.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "g"), "");

  it.each([
    [80, 24],
    [100, 30],
    [120, 40],
    [200, 50],
    [240, 67],
    [60, 20],
  ])("fills %ix%i exactly", (cols, rows) => {
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols, rows: rows - 2 }),
      terminalRows: () => rows,
      terminalColumns: () => cols,
      cwd: () => "/repo",
      branch: () => "dev",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.render();
    const frame = desk.shell.render(cols);
    expect(frame.length, "one line per terminal row").toBe(rows);
    for (const line of frame) {
      expect(
        visibleWidth(strip(line)),
        `a line overflows ${cols} columns and would wrap`
      ).toBeLessThanOrEqual(cols);
    }
  });

  it("a wider terminal gives the CHILD more columns", () => {
    // The pane viewport is derived from the frame, so this cannot drift from
    // the assertion above.
    const desk = makeDesk();
    const narrow = desk.shell.paneViewport(80);
    const wide = desk.shell.paneViewport(240);
    expect(wide.cols).toBeGreaterThan(narrow.cols);
    expect(wide.cols).toBe(240);
  });
});

describe("an OVERLAY owns the centre it is drawn in", () => {
  /**
   * `hitTest` answers about the LAYOUT — where a pane would be. The same
   * centre region is also where settings, help, the nav, the composer and a
   * frozen corpse are drawn. Forwarding a click there sent it THROUGH the
   * visible overlay to a mouse-tracking child, which acted on something the
   * human could not see. Only a live pty pane is the child's.
   */
  it.each(["settings", "help", "nav", "spawn-menu", "frozen", "governed", "none"])(
    "consumes a centre click while %s is on screen",
    (surface) => {
      const desk = makeDesk();
      (desk as unknown as { centreKind: () => string }).centreKind = () => surface;
      expect(desk.handleMouse(sgr(0, 40, 12), 100), surface).toBe(true);
    }
  );

  it("and forwards it once a live pane is back", () => {
    expect(asPtyCentre(makeDesk()).handleMouse(sgr(0, 40, 12), 100)).toBe(false);
  });
});

describe("several mouse reports in ONE read", () => {
  /**
   * A press and its release are microseconds apart, and motion streams, so a
   * terminal routinely delivers two or more reports in one read. Matched as a
   * single report they matched NOTHING, fell through the mouse router, and
   * were typed into the child — skipping chrome routing, the child's
   * mouse-mode filter and the coordinate translation all at once. The same
   * failure as the founder's `<35;46;32M…` pane, in a costume.
   */
  it("splits a coalesced press and release", () => {
    expect(splitMouseReports(`${sgr(0, 5, 5)}${sgr(0, 5, 5, false)}`)).toEqual([
      sgr(0, 5, 5),
      sgr(0, 5, 5, false),
    ]);
  });

  it("splits a run of motion reports", () => {
    const run = [sgr(35, 1, 1), sgr(35, 2, 1), sgr(35, 3, 1)];
    expect(splitMouseReports(run.join(""))).toEqual(run);
  });

  it("refuses a chunk that is not ALL mouse reports", () => {
    // Guessing would swallow real typing.
    expect(splitMouseReports(`${sgr(0, 5, 5)}hello`)).toBeNull();
    expect(splitMouseReports("hello")).toBeNull();
    expect(splitMouseReports(`${ESC}[A`)).toBeNull();
  });

  it("the desk routes EVERY report in a coalesced read", () => {
    // COUNTED, not inferred. The first version asserted "the spawn picker
    // opened" — which an empty desk does for ANY unrecognised input, so it
    // passed with the fix removed and proved nothing. The mouse router
    // running once per report is the thing that actually differs.
    const desk = makeDesk();
    const seen: string[] = [];
    const real = desk.handleMouse.bind(desk);
    desk.handleMouse = (raw: string, width: number) => {
      seen.push(raw);
      return real(raw, width);
    };
    desk.handleKey(`${sgr(0, 5, 5)}${sgr(0, 5, 5, false)}${sgr(35, 6, 5)}`);
    expect(seen.length, "one routing pass per report").toBe(3);
  });

  it("a SINGLE report still routes exactly once", () => {
    const desk = makeDesk();
    const seen: string[] = [];
    const real = desk.handleMouse.bind(desk);
    desk.handleMouse = (raw: string, width: number) => {
      seen.push(raw);
      return real(raw, width);
    };
    desk.handleKey(sgr(0, 5, 5));
    expect(seen.length).toBe(1);
  });
});

describe("opening a split leaves the desk in the state it just drew", () => {
  /**
   * `SessionManager.open()` emits its change SYNCHRONOUSLY, so the frame was
   * rendered — and the new pty created — while `focusedPane` was still 0. The
   * split opened showing the LEFT half focused and the right child sized as if
   * it owned the whole centre, and since nothing resized afterwards it stayed
   * that way until an unrelated repaint.
   *
   * Driven through `activateFocused`, the real method that owns this branch —
   * the first version of this test invented an intent that never reached it
   * and asserted against a desk that had done nothing.
   */
  it("focuses the NEW half and re-measures, in that order", () => {
    const desk = makeDesk();
    const resized: string[] = [];
    const focusWhenOpened: number[] = [];
    const internals = desk as unknown as {
      focusedPane: number;
      spawnMenu: unknown;
      sessions: unknown;
      resize: () => void;
      render: () => void;
      activateFocused: (rows: unknown[]) => void;
      revealStack: string[];
    };
    internals.sessions = {
      open: () => {
        focusWhenOpened.push(internals.focusedPane);
        return { id: "split-1" };
      },
      list: () => [],
      topLevel: () => [],
      active: () => null,
      splitOf: () => null,
    };
    internals.resize = () => resized.push("resize");
    internals.render = () => {};
    internals.revealStack = ["spawn-menu"];
    internals.spawnMenu = buildSpawnMenuState(null);
    (internals.spawnMenu as { intoSplitOf?: string }).intoSplitOf = "parent-1";

    internals.activateFocused([]);

    expect(focusWhenOpened.length, "the spawn branch really ran").toBe(1);
    expect(internals.focusedPane, "the new half takes focus").toBe(1);
    expect(resized.length, "and the halves are re-measured after").toBeGreaterThan(0);
  });
});

describe("a chrome press claims the WHOLE gesture", () => {
  /**
   * A click is a press AND a release. Consuming only the press sent the
   * matching release on to the child — so with a release-capable mouse mode
   * armed, clicking a TAB delivered an unpaired release at terminal-relative
   * coordinates: a phantom gesture in whatever was running there.
   */
  const tabCol = 2;

  it("consumes the release that follows a consumed press", () => {
    const desk = makeDesk();
    expect(desk.handleMouse(sgr(0, tabCol, 1), 100), "press on a tab").toBe(true);
    expect(
      desk.handleMouse(sgr(0, 40, 12, false), 100),
      "its release, even though it ended over the pane"
    ).toBe(true);
  });

  it("consumes a drag between the two", () => {
    const desk = makeDesk();
    desk.handleMouse(sgr(0, tabCol, 1), 100);
    expect(desk.handleMouse(sgr(32, 40, 12), 100)).toBe(true);
    expect(desk.handleMouse(sgr(0, 40, 12, false), 100)).toBe(true);
  });

  it("and releases the claim, so the NEXT gesture is judged fresh", () => {
    const desk = asPtyCentre(makeDesk());
    desk.handleMouse(sgr(0, tabCol, 1), 100);
    desk.handleMouse(sgr(0, tabCol, 1, false), 100);
    // A new press in the pane belongs to the child again.
    expect(desk.handleMouse(sgr(0, 40, 12), 100)).toBe(false);
  });

  it("a press that was NOT ours does not claim anything", () => {
    const desk = asPtyCentre(makeDesk());
    expect(desk.handleMouse(sgr(0, 40, 12), 100)).toBe(false);
    expect(desk.handleMouse(sgr(0, 40, 12, false), 100)).toBe(false);
  });
});

describe("EVERY clickable hint resolves to a real intent", () => {
  /**
   * Founder law 6 — advertised-but-inert is a P0 — applied to the mouse.
   *
   * The footer's hints carry keymap ACTION strings, and the first version of
   * this feature cast one straight to a `ShellIntent`. The two vocabularies
   * are not the same: `focus-other-pane` is an action, but the intent is
   * `{kind: "focus-pane", which: "other"}`. So the advertised `ctrl+b o focus`
   * hint reached no branch and did nothing when clicked — a dead control on
   * the one line that is always on screen.
   *
   * This walks the whole hint list rather than checking the one that broke.
   */
  it("maps every footer hint to a non-none intent", () => {
    for (const hint of footerHints()) {
      const intent = intentForAction(hint.action);
      expect(intent.kind, `${hint.action} ("${hint.text}") is inert`).not.toBe("none");
    }
  });

  it("and the mapper agrees with the CHORD for the same action", () => {
    // If these ever disagree, clicking and pressing would do different things
    // under the same label.
    const scope = { prefixArmed: true, livePane: true } as never;
    for (const hint of footerHints()) {
      const entry = KEYMAP.find((row) => row.action === hint.action);
      if (!entry || entry.scope !== "prefix") continue;
      const viaChord = routeKey(entry.match[0]!, scope);
      expect(viaChord, `${hint.action} differs between click and chord`).toEqual(
        intentForAction(hint.action)
      );
    }
  });
});

describe("clicking a hint whose ACTION differs from its INTENT", () => {
  /**
   * The mutation that survived the first version of these tests: casting the
   * action string to an intent WORKS for `toggle-sidebar`, because that name
   * happens to be both an action and an intent kind. It breaks only where the
   * two vocabularies differ — `focus-other-pane` vs `focus-pane` — so a test
   * that clicked `sessions` could never see the bug. This clicks the one that
   * actually differed.
   */
  it("hands `execute` the mapped intent, not the action string", () => {
    // Asserted on what the desk DISPATCHES: reaching the focus-pane branch for
    // real needs a live session this harness cannot open, and a test that
    // cannot run the branch would be no test at all.
    const desk = makeDesk();
    const dispatched: unknown[] = [];
    (desk as unknown as { execute: (i: unknown, r: unknown) => void }).execute = (
      intent
    ) => {
      dispatched.push(intent);
    };
    const hint = footerHints().find((h) => h.action === "focus-other-pane")!;
    expect(hint, "the footer still advertises focus").toBeDefined();
    const col = Math.floor((hint.start + hint.end) / 2) + 1;
    const row = desk.shell.render(200).length;

    expect(desk.handleMouse(sgr(0, col, row), 200)).toBe(true);
    expect(dispatched).toEqual([{ kind: "focus-pane", which: "other" }]);
  });
});

describe("a press MUON does not act on must not eat its release", () => {
  /**
   * `chromeHoldsMouse` was set for every non-pane hit, including `zone: "none"`
   * — the dividers, the empty right of the footer, the gate-band row. Those
   * fall THROUGH to the child, so the press reached it and the release was
   * then consumed by the claim: the child saw a button go down and never come
   * up. A stuck button is the same failure the flag was added to prevent,
   * pointing the other way.
   */
  it("a click on dead chrome consumes neither press nor release", () => {
    const desk = asPtyCentre(makeDesk());
    // Far right of the footer row: past the last hint, so `zone: "none"`.
    const row = desk.shell.render(200).length;
    expect(desk.shell.hitTest(200, 195, row - 1).zone).toBe("none");
    expect(desk.handleMouse(sgr(0, 196, row), 200), "press").toBe(false);
    expect(desk.handleMouse(sgr(0, 196, row, false), 200), "release").toBe(false);
  });

  it("and a REAL chrome press still claims its release", () => {
    const desk = asPtyCentre(makeDesk());
    expect(desk.handleMouse(sgr(0, 2, 1), 100), "press on a tab").toBe(true);
    expect(desk.handleMouse(sgr(0, 40, 12, false), 100), "release").toBe(true);
  });
});

describe("a BACKGROUND split tab is measured as split", () => {
  /**
   * `paneViewportAt` defaulted its pane count to `this.panes`, which only ever
   * holds the tab ON SCREEN. So a split tab sitting in the background was
   * measured as if it owned the whole centre: `resize()` told both its halves
   * the full width, and ADR-0047 captured them at that width — the exact
   * re-wrapped-restore defect the per-half work set out to fix, still present
   * for any split tab that was not in front.
   */
  it("an explicit pane count beats whatever is on screen", () => {
    const desk = makeDesk();
    // Nothing split is rendered — the shell holds one pane or none.
    expect(desk.shell.paneCount()).toBeLessThan(2);
    const asWhole = desk.shell.paneViewportAt(100, 0, 1);
    const asLeft = desk.shell.paneViewportAt(100, 0, 2);
    const asRight = desk.shell.paneViewportAt(100, 1, 2);
    expect(asLeft.cols, "a split half is narrower than the whole").toBeLessThan(
      asWhole.cols
    );
    expect(asRight.cols).toBeLessThan(asWhole.cols);
    expect(asLeft.cols + 1 + asRight.cols).toBe(asWhole.cols);
  });

  it("and the default still follows the screen when no count is given", () => {
    const desk = makeDesk();
    expect(desk.shell.paneViewportAt(100, 0)).toEqual(
      desk.shell.paneViewportAt(100, 0, desk.shell.paneCount())
    );
  });
});

describe("a hint you cannot see is not a target", () => {
  /**
   * A status message REPLACES the footer's hint line for six seconds, but
   * hit-testing kept mapping those columns to hints regardless. A click in that
   * window fired whatever hint WOULD have been there — `close-tab` among them —
   * with nothing on screen to suggest a target existed.
   */
  it("a click on the footer does nothing while a status is showing", () => {
    const desk = makeDesk();
    const hint = footerHints().find((h) => h.action === "close-tab")!;
    const col = Math.floor((hint.start + hint.end) / 2);
    const row = desk.shell.render(200).length - 1;
    expect(desk.shell.hitTest(200, col, row).zone, "before").toBe("hint");

    desk.shell.footer.setStatus("✗ something went wrong");
    expect(desk.shell.hitTest(200, col, row).zone, "while shown").toBe("none");
  });

  it("and the hints are targets again once it expires", () => {
    const desk = makeDesk();
    const hint = footerHints()[0]!;
    const col = Math.floor((hint.start + hint.end) / 2);
    const row = desk.shell.render(200).length - 1;
    let now = 1_000;
    desk.shell.footer.setClock(() => now);
    desk.shell.footer.setStatus("✗ transient", () => now);
    expect(desk.shell.hitTest(200, col, row).zone).toBe("none");
    now += 7_000;
    expect(desk.shell.hitTest(200, col, row).zone).toBe("hint");
  });
});

describe("a restored session is a TAB, not a layer underneath", () => {
  /**
   * THE FOUNDER'S BUG, stated as they hit it: quit MUON with codex and claude
   * open, reopen, start a new claude, close it — and the OLD claude appeared as
   * if it had been running.
   *
   * The cause was `centreKind()` reading the corpse list as a FALLBACK: "the
   * active session, or else a corpse". Closing a live tab therefore did not
   * leave an empty desk, it surfaced whichever corpse was next. A restored
   * session is something a human CHOOSES from the strip, exactly like any other
   * tab; it is never what you land on by closing something else.
   */
  const corpse = (label: string, kind: string) => ({
    id: `frozen-${label}`,
    kind,
    label,
    ordinal: 1,
    text: `${label} was here`,
    cols: 80,
    rows: 24,
  });

  function deskWith(frozen: unknown[]) {
    const snapshot = emptyBrainSnapshot();
    return new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 80, rows: 20 }),
      terminalRows: () => 24,
      terminalColumns: () => 100,
      cwd: () => "/repo",
      branch: () => "dev",
      frozen: frozen as never,
      onChange: () => {},
      onQuit: () => {},
    });
  }

  it("SHOWS every restored session in the strip", () => {
    // They used to be invisible, so a human could not tell what had been
    // restored or choose between two of them.
    const desk = deskWith([corpse("codex", "codex"), corpse("claude", "claude-code")]);
    desk.render();
    const strip = desk.shell
      .render(120)[0]!
      .replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    expect(strip).toContain("codex");
    expect(strip).toContain("claude");
  });

  it("still opens on the first restored session", () => {
    const desk = deskWith([corpse("codex", "codex")]);
    expect(desk.centreKind()).toBe("frozen");
  });

  it("leaves the corpse layer when a live tab is chosen", () => {
    const desk = deskWith([corpse("codex", "codex")]);
    expect(desk.centreKind()).toBe("frozen");
    // `chat` is a live tab, and choosing it must win.
    (desk as unknown as { selectTab: (id: string) => void }).selectTab("chat");
    expect(desk.centreKind()).not.toBe("frozen");
  });

  it("and does NOT resurrect one when the human returns to an empty desk", () => {
    // The exact regression: leave the corpse layer, then have nothing live.
    // Today's desk must stay empty rather than surfacing the corpse again.
    const desk = deskWith([corpse("claude", "claude-code")]);
    (desk as unknown as { selectTab: (id: string) => void }).selectTab("chat");
    expect(desk.centreKind()).toBe("none");
    expect(desk.centreKind()).not.toBe("frozen");
  });

  it("but the restored tab is still THERE to be chosen again", () => {
    // Not resurrecting must not mean losing it — the strip keeps it, and
    // clicking it brings it back.
    const desk = deskWith([corpse("claude", "claude-code")]);
    const internals = desk as unknown as { selectTab: (id: string) => void };
    internals.selectTab("chat");
    expect(desk.centreKind()).toBe("none");
    internals.selectTab("frozen:0");
    expect(desk.centreKind()).toBe("frozen");
  });
});

describe("the footer LOOKS clickable", () => {
  /**
   * These are controls, and a line of uniform grey reads as a legend — a
   * caption about the desk rather than part of it. The chord is coloured and
   * its label stays dim, so the eye finds the target and the separators stay
   * out of the way.
   */
  it("colours the chord and dims its label", () => {
    const line = new Footer().render(200)[0]!;
    const CYAN = `${ESC}[36m`;
    const DIM = `${ESC}[2m`;
    expect(line, "the chord carries colour").toContain(`${CYAN}ctrl+b s`);
    expect(line, "the label stays quiet").toContain(`${DIM} sessions`);
    // And nothing wraps the WHOLE line: an outer dim() would leave every
    // inner colour byte intact (so `toContain` above still passes) while
    // rendering the chords as dim-cyan — dimmer than the labels the eye is
    // meant to skip. The line must OPEN on the first chord's own colour.
    expect(line.startsWith(CYAN), "no wrapper swallows the hints").toBe(true);
  });

  it("colours EVERY hint, not just the first", () => {
    const line = new Footer().render(200)[0]!;
    const coloured = line.split(`${ESC}[36m`).length - 1;
    expect(coloured).toBe(footerHints().length);
  });

  it("and a STATUS still replaces the whole line", () => {
    const footer = new Footer();
    footer.setStatus("✗ that did not work");
    const line = footer.render(200)[0]!;
    expect(line).toContain("that did not work");
    expect(line).not.toContain("ctrl+b s");
  });
});

describe("ctrl+b w closes the pane the human is LOOKING at", () => {
  /**
   * The founder's report: claude on the left, codex on the right, closed the
   * left, and both quit.
   *
   * `close-tab` closed `sessions.active()`, and in a split that is ALWAYS the
   * left half — opening a split deliberately does not move `activeId`, so the
   * chord ignored `focusedPane` entirely. Combined with `close()` disposing
   * its children, either pane's close killed both.
   *
   * These drive REAL sessions through the desk, because the bug was in which
   * session got picked; a stub would have picked correctly by construction.
   */
  const PREFIX = String.fromCodePoint(2);

  function split(desk: Desk) {
    const sessions = (
      desk as unknown as { sessions: SessionManager }
    ).sessions;
    const left = sessions.open("shell");
    if (!("session" in left)) throw new Error("spawn failed");
    const right = sessions.open("shell", { parentId: left.id });
    if (!("session" in right)) throw new Error("split failed");
    return { sessions, left, right };
  }

  it("closes the RIGHT half when the right half is focused", () => {
    const desk = makeDesk();
    const { sessions, left, right } = split(desk);
    try {
      desk.handleKey(PREFIX);
      desk.handleKey("o"); // focus the other pane — now the right
      expect(desk.focusedPaneIndex()).toBe(1);

      desk.handleKey(PREFIX);
      desk.handleKey("w");

      expect(right.session.alive, "the focused half closed").toBe(false);
      expect(left.session.alive, "the other half kept running").toBe(true);
      expect(sessions.splitOf(left.id)).toBeNull();
      // Focus cannot stay on a pane that is no longer drawn.
      expect(desk.focusedPaneIndex()).toBe(0);
    } finally {
      sessions.disposeAll();
    }
  });

  it("closes the LEFT half and the right one goes FULL SCREEN — the reported bug", () => {
    const desk = makeDesk();
    const { sessions, left, right } = split(desk);
    try {
      expect(desk.focusedPaneIndex()).toBe(0);

      desk.handleKey(PREFIX);
      desk.handleKey("w");

      expect(left.session.alive).toBe(false);
      expect(right.session.alive, "codex must SURVIVE claude closing").toBe(
        true
      );
      // One pane, one tab, and the human is on it.
      expect(sessions.topLevel().map((tab) => tab.id)).toEqual([right.id]);
      expect(sessions.active()?.id).toBe(right.id);
      expect(sessions.splitOf(right.id)).toBeNull();
      expect(desk.focusedPaneIndex()).toBe(0);
    } finally {
      sessions.disposeAll();
    }
  });

  it("the survivor's PTY is re-widened, not just re-drawn", () => {
    // The defect a review caught and the bookkeeping assertions here missed:
    // `resize()` had exactly one caller — just after a split OPENS. Closing a
    // half promoted the other to a full-width tab and drew it as one pane,
    // while its child still believed it owned half a centre. The founder would
    // have seen a full-screen rectangle with the session rendering into the
    // left half of it and dead space beside, until they resized the terminal
    // by hand. State said "one pane"; the picture said otherwise.
    const desk = makeDesk();
    const { sessions, right } = split(desk);
    try {
      // Stub the pty so this reads what the CHILD was signalled. Reading
      // `lastCols` measured the desk's own request log — it is set before
      // `pty.resize()` is reached, so the test would pass even if the child
      // were never told, which is the one thing it exists to prove.
      const signalled: number[] = [];
      (right.session as unknown as { pty: { resize: unknown } }).pty.resize = (
        c: number
      ) => {
        signalled.push(c);
      };
      const cols = () => signalled.at(-1) ?? -1;
      desk.render();
      const half = cols();

      desk.handleKey(PREFIX);
      desk.handleKey("w");
      desk.render();

      expect(sessions.list().length).toBe(1);
      expect(sessions.list()[0]!.parentId).toBeUndefined();
      const full = cols();
      expect(full, "the survivor got the whole centre").toBeGreaterThan(half);
      // And it matches what the shell actually lays out for a single pane.
      expect(full).toBe(
        (
          desk as unknown as {
            shell: { paneViewportAt(w: number, i: number, n: number): { cols: number } };
          }
        ).shell.paneViewportAt(100, 0, 1).cols
      );
    } finally {
      sessions.disposeAll();
    }
  });

  it("closing the RIGHT half re-widens the LEFT one too", () => {
    const desk = makeDesk();
    const { sessions, left } = split(desk);
    try {
      const signalled: number[] = [];
      (left.session as unknown as { pty: { resize: unknown } }).pty.resize = (
        c: number
      ) => {
        signalled.push(c);
      };
      const cols = () => signalled.at(-1) ?? -1;
      desk.render();
      const half = cols();

      desk.handleKey(PREFIX);
      desk.handleKey("o"); // focus the right half
      desk.handleKey(PREFIX);
      desk.handleKey("w");
      desk.render();

      expect(sessions.splitOf(left.id)).toBeNull();
      expect(cols(), "the remaining pane got the whole centre").toBeGreaterThan(
        half
      );
    } finally {
      sessions.disposeAll();
    }
  });
});

describe("what the human SEES after closing a pane", () => {
  /**
   * Both of the founder's screenshots, reproduced at the RENDER level.
   *
   * The earlier tests for this fix asserted `SessionManager` state — which
   * tab survived, who owned what id — and every one of them passed while the
   * screen showed a black void. State is not a picture. These drive the desk
   * to `render()` and read the lines the terminal would actually receive.
   */
  const PREFIX = String.fromCodePoint(2);

  function corpse(label: string): RestoreEntry {
    return {
      id: `dead-${label}`,
      kind: "opencode",
      ordinal: 1,
      label,
      text: `${label} was here`,
      cols: 80,
      rows: 20,
    };
  }

  /** A desk booted with a restored corpse, exactly like the founder's. */
  function deskWithCorpse(): Desk {
    const snapshot = emptyBrainSnapshot();
    return new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 80, rows: 20 }),
      terminalRows: () => 24,
      terminalColumns: () => 100,
      cwd: () => "/repo",
      branch: () => "dev",
      frozen: [corpse("OpenCode")],
      onChange: () => {},
      onQuit: () => {},
    });
  }

  function shellOf(desk: Desk) {
    return (desk as unknown as { shell: { paneCount(): number; render(w: number): string[] } })
      .shell;
  }

  function sessionsOf(desk: Desk) {
    return (desk as unknown as { sessions: SessionManager }).sessions;
  }

  it("the survivor of a closed split is DRAWN, as the only pane", () => {
    const desk = deskWithCorpse();
    const sessions = sessionsOf(desk);
    try {
      const left = sessions.open("shell");
      if (!("session" in left)) throw new Error("spawn failed");
      // Opening clears the corpse selection, exactly as the real boot does.
      (desk as unknown as { frozenIndex: number | null }).frozenIndex = null;
      const right = sessions.open("shell", { parentId: left.id });
      if (!("session" in right)) throw new Error("split failed");
      desk.render();
      expect(shellOf(desk).paneCount(), "two panes while split").toBe(2);

      desk.handleKey(PREFIX);
      desk.handleKey("w");
      desk.render();

      // The promoted session is the centre, full width — not a corpse, not
      // a void.
      expect(
        (desk as unknown as { centreKind(): string }).centreKind()
      ).toBe("pty");
      expect(shellOf(desk).paneCount(), "one pane after the close").toBe(1);
      expect(right.session.alive).toBe(true);
    } finally {
      sessions.disposeAll();
    }
  });

  it("closing the LAST session shows the corpse tab, never a black screen", () => {
    // The second screenshot: a strip reading `chat  OpenCode ⏹  +` above an
    // entirely empty terminal. `frozenIndex` was null (opening a session
    // clears it) and nothing put it back, so centreKind() walked past a
    // frozen tab it could see and returned "none".
    const desk = deskWithCorpse();
    const sessions = sessionsOf(desk);
    try {
      const only = sessions.open("shell");
      if (!("session" in only)) throw new Error("spawn failed");
      (desk as unknown as { frozenIndex: number | null }).frozenIndex = null;
      desk.render();

      desk.handleKey(PREFIX);
      desk.handleKey("w");
      desk.render();

      expect(sessions.topLevel().length).toBe(0);
      expect(
        (desk as unknown as { centreKind(): string }).centreKind(),
        "a visible tab must have a visible centre"
      ).toBe("frozen");

      const screen = shellOf(desk).render(100).join("\n");
      expect(screen, "the corpse explains itself").toContain("ENDED");
      expect(screen).toContain("OpenCode");
    } finally {
      sessions.disposeAll();
    }
  });

  it("a live session still WINS over a corpse — the default never steals focus", () => {
    // The selection default must fire only when there is nothing else to be
    // on. If it ran while a session was live it would hide the human's
    // actual work behind a dead one.
    const desk = deskWithCorpse();
    const sessions = sessionsOf(desk);
    try {
      const live = sessions.open("shell");
      if (!("session" in live)) throw new Error("spawn failed");
      (desk as unknown as { frozenIndex: number | null }).frozenIndex = null;
      desk.render();
      expect(
        (desk as unknown as { centreKind(): string }).centreKind()
      ).toBe("pty");
      expect(
        (desk as unknown as { frozenIndex: number | null }).frozenIndex
      ).toBeNull();
    } finally {
      sessions.disposeAll();
    }
  });
});

describe("chrome that narrows the centre re-sizes the child", () => {
  /**
   * The trigger class is LAYOUT, not sessions.
   *
   * The first version of the resize fix hooked the SessionManager
   * subscription, which sounds complete and is not: `ctrl+b s` reveals a rail
   * and takes ~27 columns off the centre without touching a single session.
   * The child kept the wider size, so the pane clipped its rightmost columns
   * until the human resized the terminal by hand — the same defect as the
   * unresized survivor, arrived at from the other direction.
   */
  const PREFIX = String.fromCodePoint(2);

  it("revealing the sidebar narrows the child, and hiding it widens it back", () => {
    const desk = makeDesk();
    const sessions = (desk as unknown as { sessions: SessionManager }).sessions;
    try {
      const tab = sessions.open("shell");
      if (!("session" in tab)) throw new Error("spawn failed");
      const signalled: number[] = [];
      (tab.session as unknown as { pty: { resize: unknown } }).pty.resize = (
        c: number
      ) => {
        signalled.push(c);
      };

      desk.render();
      const full = signalled.at(-1)!;
      expect(full, "a child was sized at all").toBeGreaterThan(0);

      desk.handleKey(PREFIX);
      desk.handleKey("s");
      desk.render();
      expect(desk.revealed().sidebar).toBe(true);
      const narrowed = signalled.at(-1)!;
      expect(narrowed, "the rail took columns from the child").toBeLessThan(
        full
      );

      desk.handleKey(PREFIX);
      desk.handleKey("s");
      desk.render();
      expect(desk.revealed().sidebar).toBe(false);
      expect(signalled.at(-1), "and gave them back").toBe(full);
    } finally {
      sessions.disposeAll();
    }
  });

  it("a repaint with nothing moved does not re-size at all", () => {
    // The other half of the same mistake: the session subscription fires on
    // every chunk of child OUTPUT, so hooking it recomputed geometry per byte
    // for a layout that could not have changed.
    const desk = makeDesk();
    const sessions = (desk as unknown as { sessions: SessionManager }).sessions;
    try {
      const tab = sessions.open("shell");
      if (!("session" in tab)) throw new Error("spawn failed");
      desk.render();
      let calls = 0;
      (desk as unknown as { resize(): void }).resize = () => {
        calls += 1;
      };
      desk.render();
      desk.render();
      desk.render();
      expect(calls, "an unchanged frame costs nothing").toBe(0);
    } finally {
      sessions.disposeAll();
    }
  });
});
