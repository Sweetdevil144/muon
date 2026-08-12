// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { xtermTerminalOptions } from "../src/renderer/lib/xterm-view.js";

// THE REAL LIBRARY, NO MOCKS. Every other terminal test injects fakes, which
// is exactly why nobody saw Unicode11Addon throw "You must set the
// allowProposedApi option to true" inside the mounting effect — unmounting
// the entire App to the error boundary the moment any terminal tab opened
// (the founder hit it clicking Claude Code/Codex/OpenCode; the same class as
// the earlier unexplained blank window, #23). A headless Terminal loads
// addons without a DOM, so this reproduces the crash byte-for-byte pre-fix.
describe("createXtermView's options against the REAL xterm", () => {
  it("loads every addon MUON ships on a real Terminal built from the real options", () => {
    const term = new Terminal(xtermTerminalOptions({ readOnly: false }));
    term.loadAddon(new FitAddon());
    term.loadAddon(new SearchAddon());
    // The line that crashed the window: proposed API behind allowProposedApi.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    expect(term.unicode.activeVersion).toBe("11");
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new SerializeAddon());
    term.dispose();
  });

  it("read-only options load the same addon set", () => {
    const term = new Terminal(xtermTerminalOptions({ readOnly: true }));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    expect(term.options.disableStdin).toBe(true);
    term.dispose();
  });

  it("pins allowProposedApi so a future options refactor cannot silently drop it", () => {
    // Belt AND suspenders with the loads above: the load test proves the
    // behavior, this names the exact load-bearing flag for the next reader.
    expect(xtermTerminalOptions({}).allowProposedApi).toBe(true);
  });
});
