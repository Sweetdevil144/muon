import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { TuiAltScreen } from "../src/vendor/pi-tui/src/tui-alt-screen.ts";
import type { Component } from "../src/vendor/pi-tui/src/tui.ts";
import type { Terminal } from "../src/vendor/pi-tui/src/terminal.ts";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

/**
 * THE KEYS THE ENGINE WAS EATING.
 *
 * The founder reported that "ctrl and arrow keys" did not work in the TUI and
 * suspected it was our fault rather than a terminal restriction. It was ours,
 * and it was NOT the arrows: a pty probe showed arrows, ctrl+arrows, alt+arrows
 * and every ctrl+letter reaching the child intact, while Home, End, PageUp,
 * PageDown and ctrl+shift+arrow vanished.
 *
 * The cause is listener ORDER, not routing. `TuiAltScreen` registers an input
 * listener for its own scrollback, input listeners run BEFORE the focused
 * component, and a `{consume:true}` ends the dispatch. Its default bindings are
 * exactly those keys. So a scroll view with nothing to scroll — this desk
 * renders one screen and keeps no scrollback — was taking line-start and
 * line-end out of a vendor CLI, silently.
 *
 * The desk now answers, per byte, whether a child would receive it, and the
 * viewport stands down when the answer is yes. These tests drive the REAL
 * engine through the REAL listener chain, because a test of the router alone
 * would have passed throughout the bug: the router was never wrong.
 */

const ESC = String.fromCodePoint(0x1b);

/** Everything `Terminal` promises, and nothing that touches a real one. */
function fakeTerminal(): Terminal & { emit: (data: string) => void } {
  let onInput: (data: string) => void = () => {};
  return {
    emit: (data: string) => onInput(data),
    start(input) {
      onInput = input;
    },
    stop() {},
    drainInput: async () => {},
    write() {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return true;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

/** A component that records exactly what the dispatch chain handed it. */
function recorder(): Component & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    render: () => ["frame"],
    invalidate() {},
    handleInput(data: string) {
      seen.push(data);
    },
  } as Component & { seen: string[] };
}

/** The keys the viewport's own bindings claim. */
const CONTESTED: Array<[string, string]> = [
  ["Home", `${ESC}[H`],
  ["End", `${ESC}[F`],
  ["Home (vt)", `${ESC}[1~`],
  ["End (vt)", `${ESC}[4~`],
  ["PageUp", `${ESC}[5~`],
  ["PageDown", `${ESC}[6~`],
  ["ctrl+shift+up", `${ESC}[1;6A`],
  ["ctrl+shift+down", `${ESC}[1;6B`],
];

describe("with a live child, the viewport takes nothing", () => {
  function wire(guard: ((data: string) => boolean) | undefined) {
    const terminal = fakeTerminal();
    const tui = new TuiAltScreen(terminal);
    const component = recorder();
    tui.setLayoutRoot(component);
    tui.setFocus(component);
    tui.setChildInputGuard(guard);
    terminal.start(
      (data) => (tui as unknown as { handleTerminalInput(d: string): void })
        // The engine wires this itself in `start()`; calling it directly keeps
        // the test off the alt screen while exercising the same chain.
        .handleTerminalInput(data),
      () => {}
    );
    return { terminal, component };
  }

  it.each(CONTESTED)("%s reaches the child", (_name, seq) => {
    const { terminal, component } = wire(() => true);
    terminal.emit(seq);
    expect(component.seen).toEqual([seq]);
  });

  it("and every one of them was being eaten before the guard", () => {
    // THE MUTATION, PERMANENT. Without this the tests above would pass on a
    // build where the listener never consumed anything for any reason, and
    // would stop describing the defect they exist for.
    const { terminal, component } = wire(undefined);
    for (const [, seq] of CONTESTED) terminal.emit(seq);
    expect(component.seen, "the unguarded engine swallows all of them").toEqual(
      []
    );
  });

  it("mouse reports reach the child too", () => {
    // A vendor CLI that armed mouse tracking owns the wheel and the clicks.
    // The viewport consumed those as its own scroll, so scrolling inside a
    // child did nothing at all.
    const { terminal, component } = wire(() => true);
    terminal.emit(`${ESC}[<64;10;5M`);
    expect(component.seen).toEqual([`${ESC}[<64;10;5M`]);
  });

  it("focus events stay with the ENGINE, guard or no guard", () => {
    // These are not keys. The engine needs them to drop selection and drag
    // state, and forwarding `ESC[I` into a shell prompt would type garbage.
    const { terminal, component } = wire(() => true);
    terminal.emit(`${ESC}[I`);
    terminal.emit(`${ESC}[O`);
    expect(component.seen).toEqual([]);
  });
});

describe("the desk decides, and it asks the router", () => {
  function desk(): Desk {
    return new Desk({
      client: {
        listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
        getAutoConfirmAgentMemory: vi.fn(async () => false),
      } as unknown as MuonApiClient,
      getSnapshot: () => emptyBrainSnapshot(),
      geometry: () => ({ cols: 40, rows: 8 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
  }

  it("says no with no live pane — there is no child to give it to", () => {
    const d = desk();
    for (const [name, seq] of CONTESTED) {
      expect(d.childTakesKey(seq), name).toBe(false);
    }
  });

  it("says no while the desk's own prefix is armed", () => {
    // `ctrl+b` then PageUp is a desk gesture in flight, not the child's key.
    const d = desk();
    d.handleKey(String.fromCodePoint(2));
    expect(d.childTakesKey(`${ESC}[5~`)).toBe(false);
  });

  it("never claims the two keys reserved from a child", () => {
    const d = desk();
    expect(d.childTakesKey(String.fromCodePoint(17)), "ctrl+q").toBe(false);
    expect(d.childTakesKey(String.fromCodePoint(2)), "ctrl+b").toBe(false);
  });
});
