import type { VendorId } from "@muon/client/vendors";

/**
 * The FIXED grid a dispatched agent's console was actually rendered at.
 *
 * U3 — WHY A VIEWER MAY NOT CHOOSE ITS OWN WIDTH.
 *
 * A lane that declares `prefersPtyConsole` runs its one-shot child on a REAL
 * pty, spawned at a fixed size (`LANE_PTY_COLS × LANE_PTY_ROWS` in
 * @muon/adapters). The bytes that reach MUON's live pane are that terminal's
 * native rendering: line wraps already decided, absolute cursor positions
 * (`ESC[row;colH`), in-place `\r` redraws, and box-drawing all computed
 * against that exact grid. There is no resize channel back to a dispatched
 * job's pty — deliberately; the pane is a read-only VIEWER of a governed
 * child, not a second controller of it.
 *
 * So a viewer that fits itself to whatever the panel happens to be wide is not
 * showing that console, it is showing that console's bytes replayed against a
 * DIFFERENT geometry: every over-width line hard-wraps a second time, and each
 * `\r` redraw returns to the start of the wrapped fragment instead of the
 * line, leaving the previous frame's tail behind. That is what "the codex
 * stream is distorted" looks like, and it is why claude-code looks fine — that
 * lane has no live console at all (in-process Agent SDK; MUON never owns the
 * child's stdio), so its tab renders the recorded stream as prose.
 *
 * @muon/adapters states this invariant in words already ("the viewer renders
 * at the same geometry so wrapping is byte-faithful"); this is the renderer's
 * half of it. The numbers are MIRRORED rather than imported because
 * lane-runner.ts pulls node-pty and child_process and must never enter the
 * renderer bundle — `agent-console-grid.test.ts` imports the real constants in
 * node and fails if the two ever drift.
 */
export type ConsoleGrid = { cols: number; rows: number };

/** Mirrors LANE_PTY_COLS / LANE_PTY_ROWS. Drift-locked by a test. */
export const LANE_CONSOLE_GRID: ConsoleGrid = { cols: 120, rows: 32 };

/**
 * Vendor → the grid its dispatched console is rendered at, or null when that
 * vendor has no pty console for MUON to view.
 *
 * KNOWN GAP — THIS TABLE IS KEYED ON THE VENDOR, NOT ON THE TRANSPORT.
 * `prefersPtyConsole` is a PREFERENCE the runner can fail to honour, and three
 * live paths defeat it while still publishing a console:
 *   1. the runner's node-pty failed to load (lib/runner-pty.ts returns null,
 *      so `ExecuteOptions.ptySpawn` is undefined);
 *   2. a resolved vendor action supplies an `argvOverride`, where pipes stay
 *      authoritative because stdout is a machine contract (`--json`);
 *   3. a loop iteration falling through to the DEFAULT execute — the loop
 *      runner forwards `onBytes` but never `pty` (packages/core/src/
 *      loop-runner.ts).
 * In all three the pane still fills, from PIPE bytes, and this table pins them
 * to 120x32 — a width nothing wrapped them at. That is the wrong direction of
 * the same defect U3 fixed, and it is NOT fixable here: the viewer cannot know
 * which transport produced the bytes, so the answer is for the runner to state
 * the grid on the wire beside the frames it publishes, and for this function
 * to read that instead of guessing from an id. Recorded rather than patched
 * with a heuristic — see docs/adr/0025 §4.
 *
 * TOTAL over VendorId, for the ADR-0022 §3.4 reason the rest of this codebase
 * keeps a table total: `null` is a STATEMENT ("this lane has no pty console"),
 * so a lane that later opts into `prefersPtyConsole` cannot inherit a silently
 * wrong geometry by being forgotten — it fails to compile until someone says.
 */
export const AGENT_CONSOLE_GRIDS: Readonly<
  Record<VendorId, ConsoleGrid | null>
> = {
  // In-process Agent SDK — MUON never owns this child's stdio, so there is no
  // console to view and nothing to pin.
  "claude-code": null,
  // The one lane with `prefersPtyConsole = true` (codex-adapter.ts).
  codex: LANE_CONSOLE_GRID,
  // Pipes are a CONTRACT for these lanes (cursor needs clean JSON on stdout,
  // opencode a line protocol), so they never get a pty console.
  cursor: null,
  opencode: null,
  fake: null,
};

/**
 * The grid a live attach pane must render this vendor's console at, or null to
 * fit the pane as usual.
 *
 * An unknown vendor answers null: fitting the pane is the honest default for a
 * console whose source geometry MUON does not know, and pinning one it guessed
 * would be the very defect this exists to fix.
 */
export function agentConsoleGrid(vendor: string | null | undefined): ConsoleGrid | null {
  if (!vendor) {
    return null;
  }
  return AGENT_CONSOLE_GRIDS[vendor as VendorId] ?? null;
}
