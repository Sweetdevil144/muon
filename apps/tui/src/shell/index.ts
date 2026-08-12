#!/usr/bin/env node
// MUON TUI — THE desk (`npm run tui`).
//
// Cut over from the Ink desks on 2026-08-09 (ADR-0046 Phase 4, founder
// authorised). The Ink desks remain reachable for one release as
// `npm run tui:ink` and `npm run tui:legacy`, deprecated — kept only so a
// human who needs a classic-only command is not stranded mid-release.
//
// THIS FILE IS WIRING ONLY. It used to be a 600-line script holding every
// piece of state and every governed call, which meant no test could reach any
// of it — and four adversarial reviews found that every CRITICAL and HIGH
// defect lived exactly there. The behaviour now lives in `Desk` (desk.ts),
// which takes its client, its geometry and its clock as dependencies. What is
// left here is the part that genuinely needs a real terminal and a real
// process: startup, the engine, signals, and the ADR-0047 capture on exit.

import {
  MuonApiClient,
  resolveApiBase,
  resolveApiToken,
  resolveDataDir,
} from "@muon/client";
import { ensureBrain } from "@muon/client/ensure-brain";
import { createBrainStore } from "../lib/brain-store.js";
import { resolveStartupTarget } from "../lib/startup.js";
import { ProcessTerminal } from "../vendor/pi-tui/src/terminal.ts";
import { TuiAltScreen } from "../vendor/pi-tui/src/tui-alt-screen.ts";
import type { Shell } from "./shell.js";
import { Desk } from "./desk.js";
import { buildEntries, captureSnapshot, consumeSnapshot } from "./restore-snapshot.js";
import { KeyStreamReader } from "./key-stream.js";

// Same local-first startup as every other entry: ensure the embedded brain,
// never hijack an explicit --api-base (F1 no-hijack).
const startup = await resolveStartupTarget({
  ensureBrain,
  resolveApiBase,
  resolveDataDir,
});
if (startup.note) process.stderr.write(`muon-tui: ${startup.note}\n`);

const client = new MuonApiClient(resolveApiBase(), fetch, resolveApiToken());
const store = createBrainStore(client, undefined, { target: startup.target });
store.start(2000);

// TuiAltScreen IS the TUI (it extends TuiBase): terminal in, layout root set,
// input dispatched to the focused component's handleInput.
const tui = new TuiAltScreen(new ProcessTerminal());

// The SPACES row wants a branch. Read it once, cheaply, and never block the
// desk on it — a repo-less directory is a normal way to run a terminal.
let currentBranch = "—";
try {
  const { execFileSync } = await import("node:child_process");
  currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim() || "—";
} catch {
  // not a repo, or no git — the rail says "—" and the desk carries on.
}

// THE TERMINAL'S SIZE, not a guess at the pane's.
//
// This used to subtract 26 columns for the sidebar and 5 rows for the chrome —
// unconditionally, while the sidebar is HIDDEN by default. A vendor CLI was
// therefore told it had 26 fewer columns than it did and drew itself into a
// box with dead space beside it, which is what the founder's Claude Code
// screenshot shows. The desk asks the SHELL for the real viewport now; this
// stays only as the fallback for a Desk built without a terminal width.
const paneGeometry = () => ({
  cols: Math.max(20, process.stdout.columns ?? 100),
  rows: Math.max(5, (process.stdout.rows ?? 32) - 2),
});

const desk = new Desk({
  client,
  getSnapshot: () => store.getSnapshot(),
  geometry: paneGeometry,
  terminalRows: () => process.stdout.rows ?? 32,
  terminalColumns: () => process.stdout.columns ?? 100,
  cwd: () => process.cwd(),
  // ADR-0047: the last quit's screens, consumed ONCE at startup.
  frozen: consumeSnapshot(resolveDataDir()),
  onChange: () => repaint(),
  onQuit: () => shutdown(),
  // A governed decision re-reads the brain immediately; the 2s poll is too
  // slow to stop a second press from duplicating the write.
  refresh: () => store.refresh(),
  branch: () => currentBranch,
});

// FIRST PAINT IS NEVER EMPTY: with no session, open the picker so the first
// keystroke starts real work rather than staring at chrome.
desk.bootstrap();

const repaint = () => {
  desk.render();
  tui.requestRender();
};
store.subscribe(repaint);

let lastPresence = 0;
(desk.shell as Shell & { handleInput?: (data: string) => void }).handleInput = (
  data: string
) => {
  const now = Date.now();
  if (now - lastPresence > 30_000) {
    lastPresence = now;
    // ADR-0040 D3a — a keystroke is ASSERTED human presence, throttled.
    void client.noteHumanPresent("tui").catch(() => undefined);
  }
  desk.handleKey(data);
};

process.stdout.on("resize", () => {
  desk.resize();
  repaint();
});

// Draw ONCE before start: without this the centre was null at first paint, so
// a restored corpse never appeared and F7 was "PRESENT" against a done-when it
// did not meet.
repaint();

tui.setLayoutRoot(desk.shell);
tui.setFocus(desk.shell);

// THE KEYBOARD BELONGS TO THE CHILD (ADR-0046 D1). The engine's alt-screen
// viewport registers its own input listener, and input listeners run before
// the focused component — so `home`, `end`, `pageUp`, `pageDown` and
// `ctrl+shift+arrow` were consumed for a scrollback this desk does not have,
// and never reached the vendor CLI in the pane. The desk answers, per byte,
// whether a child would take it.
tui.setChildInputGuard((data) => desk.childTakesKey(data));

// AND IT KEEPS ITS CURSOR. Without this the engine hides the hardware cursor
// unconditionally, so a live shell rendered with no caret at all — see
// `PtyPane.render`, which marks where it goes.
tui.setShowHardwareCursor(true);

// A CHORD SPLIT ACROSS TWO READS IS STILL ONE CHORD. The terminal splits its
// reads wherever the pipe happened to be full, so `ESC[98;5u` can arrive as
// `ESC[98;` then `5u` — the first half dispatched as unknown bytes, the second
// half TYPED into the pane. It depends on timing, so it presents as "shortcuts
// sometimes don't work" rather than as a bug. Bounded and always-draining; see
// key-stream.ts.
// `emit` is late-bound because the reader can release bytes on its timer,
// after the read that produced them has returned. Every emit routes to the
// same engine entry point, so the latest one is always correct.
let dispatchKeys: (data: string) => void = () => {};
const keyStream = new KeyStreamReader((data) => dispatchKeys(data));
tui.setInputGate((data, emit) => {
  dispatchKeys = emit;
  keyStream.push(data);
});

tui.start();

function shutdown(): void {
  // ADR-0047 D1 — capture on the way out, bounded, 0600, best-effort, and
  // BEFORE anything is disposed.
  captureSnapshot(
    resolveDataDir(),
    buildEntries(
      desk.liveSessions().map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        ordinal: tab.ordinal,
        label: tab.label,
        screen: tab.session.renderScreen(),
        // The geometry the text was RENDERED at — PER SESSION, because the
        // two halves of a split are different widths. This used to call the
        // fallback below (full terminal width), and then the focused pane's
        // size for every session; both restored the other half re-wrapped.
        ...desk.geometryOf(tab.id),
      }))
    )
  );
  keyStream.release();
  desk.dispose();
  store.stop();
  tui.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// A throw inside the render tick is UNCAUGHT: without this the engine never
// stops, so the alt screen is never exited and raw mode never restored — the
// terminal is left wedged and the human has to `reset`. Restore the terminal
// FIRST, then report, then leave with a failing code.
process.on("uncaughtException", (error) => {
  restoreTerminal();
  process.stderr.write(`muon-tui: fatal: ${String(error)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  restoreTerminal();
  process.stderr.write(`muon-tui: fatal: ${String(reason)}\n`);
  process.exit(1);
});

/** Give the terminal back. Safe to call twice; never throws. */
function restoreTerminal(): void {
  try {
    desk.dispose();
    tui.stop();
  } catch {
    // Nothing here may prevent the process from leaving.
  }
}
