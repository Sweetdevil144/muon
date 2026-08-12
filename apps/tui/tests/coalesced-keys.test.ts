import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

function makeDesk() {
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
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
}


/**
 * THE OBSERVABLE: `ctrl+b s` reveals the sidebar, which draws "SPACES".
 *
 * The first version of these tests compared rendered frames without calling
 * `render()` first, so both sides were the pre-toggle frame and matched
 * trivially — the mutation that removed the fix left them green. Asserting a
 * visible consequence is the only version that can fail.
 */
function sidebarShowing(desk: Desk): boolean {
  desk.render();
  return desk.shell.render(100).join("\n").includes("SPACES");
}

describe("one read can carry two keystrokes", () => {
  /**
   * The bug the key doctor had first, and the desk kept. `ctrl+b` and its
   * command key are typed a fraction of a second apart, so a terminal
   * routinely delivers both in one read. Routed as a single key it matches
   * nothing and BOTH bytes go to the child: the chord silently does nothing
   * and an `s` appears in the pane.
   *
   * This is the shape that makes a shortcut "work sometimes" — it depends on
   * how fast you type and what else is in the pipe.
   */
  const PREFIX = String.fromCodePoint(2);
  const ESC = String.fromCodePoint(0x1b);

  it("acts on ctrl+b and s arriving together", () => {
    const coalesced = makeDesk();
    coalesced.handleKey(`${PREFIX}s`);
    expect(sidebarShowing(coalesced), "one read, same result").toBe(true);
  });

  it("matches what the two keys do arriving separately", () => {
    const separate = makeDesk();
    separate.handleKey(PREFIX);
    separate.handleKey("s");
    expect(sidebarShowing(separate)).toBe(true);
  });

  it("acts on the kitty form arriving together", () => {
    // `ESC[98;5u` + `s` in one read normalizes to `\x02s`.
    const coalesced = makeDesk();
    coalesced.handleKey(`${ESC}[98;5us`);
    expect(sidebarShowing(coalesced)).toBe(true);
  });

  it("does NOT split ordinary typing — a chord inside a PASTE is inert", () => {
    // The reason splitting is narrow. If every read were split into
    // keystrokes, a paste whose contents contain `\x02s` would toggle the
    // sidebar, and any other letter after a stray \x02 would run whatever
    // command it is bound to.
    const pasted = makeDesk();
    pasted.handleKey(`ab${PREFIX}scd`);
    expect(sidebarShowing(pasted), "a paste must not run commands").toBe(false);
  });

  it("does not split an escape sequence into pieces", () => {
    const arrow = makeDesk();
    expect(arrow.handleKey(`${ESC}[A`).kind).not.toBe("none");
  });
});

describe("there is NO time limit on a chord", () => {
  /**
   * The founder asked whether MUON forces a chord to be pressed faster than a
   * human normally would — the way `cmd` then `v` is really two presses a few
   * hundred milliseconds apart.
   *
   * It does not, and these pin both halves of why:
   *
   *  - A MODIFIER is not a keystroke. MUON negotiates kitty flags 7, which
   *    does NOT include "report all keys" (8), so holding ctrl sends nothing
   *    at all. The terminal emits ONE sequence when the letter goes down. How
   *    long ctrl was already held is invisible and cannot expire.
   *  - The PREFIX is a latch, not a window. `ctrl+b` sets a boolean that only
   *    the next keystroke clears.
   *
   * The one timer in the input path (25ms, key-stream.ts) applies solely to an
   * INCOMPLETE escape sequence — bytes that cannot be a chord yet.
   */
  const PREFIX = String.fromCodePoint(2);

  it("the prefix stays armed indefinitely", () => {
    vi.useFakeTimers();
    try {
      const desk = makeDesk();
      desk.handleKey(PREFIX);
      // Five minutes of a human reading their screen.
      vi.advanceTimersByTime(300_000);
      desk.handleKey("s");
      desk.render();
      expect(desk.shell.render(100).join("\n")).toContain("SPACES");
    } finally {
      vi.useRealTimers();
    }
  });

  it("and the negotiated flags exclude report-all-keys, so a held modifier is silent", () => {
    // If flag 8 were ever added, ctrl DOWN would arrive as its own event and
    // the desk would have to learn to ignore it — this is the tripwire.
    const source = readFileSync(
      new URL("../src/vendor/pi-tui/src/terminal.ts", import.meta.url),
      "utf8"
    );
    const flags = /DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = (\d+)/.exec(source);
    expect(flags, "the flags constant still exists").not.toBeNull();
    expect(Number(flags![1]) & 8, "report-all-keys must stay off").toBe(0);
  });
});
