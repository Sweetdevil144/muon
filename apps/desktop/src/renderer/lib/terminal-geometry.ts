// The renderer half of "a pty is born at the size it will be read at".
//
// A terminal pane measures itself, then hands that geometry to the host with
// the OPEN. Kept as a pure function so the rule — an unmeasurable pane sends
// NO geometry rather than a guess — is unit-testable without a DOM, an XTerm,
// or an Electron runtime. The host bounds whatever arrives besides
// (terminal-host.ts): this is a hint, never authority.

import type { TerminalSpawn } from "../../shared/terminal-protocol.js";
import type { TerminalView } from "./terminal-wire.js";

/**
 * Whether a measured grid is worth sending. A 0/negative/non-integer or absurd
 * value is not a measurement, it is an artifact of a pane that has no box yet,
 * and sending one would resize the child to a size nobody is reading at.
 */
export function isUsableTerminalSize(size: {
  cols: number;
  rows: number;
}): boolean {
  return (
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols >= 2 &&
    size.rows >= 2 &&
    size.cols <= 10_000 &&
    size.rows <= 10_000
  );
}

/**
 * The spawn hint to send for this open: the caller's spawn, plus the view's
 * measured grid when it has one.
 *
 * Returns the ORIGINAL object when there is nothing to add, so a view without
 * `size()` (every fake in the tests, and the pre-existing production view
 * before this change) produces a byte-identical request to what it sent before.
 */
export function spawnWithMeasuredSize(
  spawn: TerminalSpawn,
  view: Pick<TerminalView, "size">
): TerminalSpawn {
  const measured = view.size?.() ?? null;
  if (!measured || !isUsableTerminalSize(measured)) {
    return spawn;
  }
  return { ...spawn, cols: measured.cols, rows: measured.rows };
}
