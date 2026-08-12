import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { cyan, dim } from "./theme.js";
import { KEYMAP } from "./keymap.js";
import { sliceByColumn, visibleWidth } from "../vendor/pi-tui/src/utils.ts";

/**
 * The shell footer — ONE status line, sanitized at the render boundary.
 *
 * The rule this carries over is the one four review rounds paid for on the
 * Ink desks: the status string collects backend, vendor and agent text from
 * ~40 writers, so it is flattened HERE, where it is finally drawn, not at
 * each writer. `fit` semantics: clip AFTER sanitizing, never before.
 */

/**
 * The idle hint, BUILT FROM THE KEYMAP. The previous literal advertised
 * `/ commands` and `? keys`, and a review measured both as dead: neither
 * resolved to an intent in any reachable scope. That is founder law 6's
 * "advertised-but-inert is a P0 bug", printed on the one line that is always
 * on screen. Now the hint can only name keys the table dispatches.
 */
const HINT_ACTIONS = [
  "toggle-sidebar",
  "split-pane",
  "focus-other-pane",
  "new-tab",
  "close-tab",
  "open-help",
  "quit",
];

/** One hint, and the action a click on it performs. */
export type FooterHint = {
  readonly action: string;
  readonly text: string;
  readonly start: number;
  /** Exclusive, in visible columns. */
  readonly end: number;
};

const SEPARATOR = " · ";

/**
 * THE HINTS ARE CLICKABLE, so the line that is always on screen is also the
 * one surface a human can drive without knowing a single chord. Positions are
 * computed once and both the rendering and the hit-test read them, so a click
 * cannot land on a neighbour.
 */
export function footerHints(): FooterHint[] {
  const hints: FooterHint[] = [];
  let column = 0;
  for (const action of HINT_ACTIONS) {
    const entry = KEYMAP.find((row) => row.action === action);
    if (!entry) continue;
    const word = entry.help.split(" —")[0]!.split(" ")[0];
    const text = `${entry.key} ${word}`;
    if (hints.length > 0) column += visibleWidth(SEPARATOR);
    hints.push({ action, text, start: column, end: column + visibleWidth(text) });
    column += visibleWidth(text);
  }
  return hints;
}

/**
 * THE CHORD IS COLOURED, THE WORD IS NOT.
 *
 * These are clickable, and a line of uniform dim grey reads as a legend — a
 * caption about the desk rather than part of it. Colouring the chord itself
 * (`ctrl+b s`) and leaving its label dim gives the eye something that looks
 * like a control, and keeps the separators quiet so the targets stay
 * separable. Cyan is already this desk's "you can act on this" colour, so this
 * borrows a meaning the human has met rather than inventing a sixth one.
 */
const HINTS = footerHints()
  .map((hint) => {
    const gap = hint.text.lastIndexOf(" ");
    return gap === -1
      ? cyan(hint.text)
      : `${cyan(hint.text.slice(0, gap))}${dim(hint.text.slice(gap))}`;
  })
  .join(dim(SEPARATOR));

export class Footer implements Component {
  private status = "";
  private statusAt = 0;
  private now: () => number = Date.now;

  /** Test seam for the expiry clock. */
  setClock(now: () => number): void {
    this.now = now;
  }

  /**
   * A status REPLACES the hints, and expires back to them. Without the
   * expiry, the first `✗ no split — ctrl+b | opens one` destroyed the one
   * always-visible line that teaches the keymap, for the rest of the session.
   * A transient message should be transient.
   */
  setStatus(status: string, now: () => number = Date.now): void {
    this.status = status;
    this.statusAt = now();
  }

  /** How long a status holds the line before the hints return. */
  static readonly STATUS_MS = 6_000;

  invalidate(): void {}

  /**
   * Are the clickable hints ON SCREEN right now?
   *
   * A status REPLACES the hint line for `STATUS_MS`. Hit-testing kept mapping
   * those columns to hints regardless, so a click during that window fired
   * whatever hint WOULD have been there — `close-tab` among them — with
   * nothing on screen to suggest a target existed. A control you cannot see is
   * not a control.
   */
  hintsVisible(): boolean {
    return !(this.status !== "" && this.now() - this.statusAt < Footer.STATUS_MS);
  }

  render(width: number): string[] {
    const fresh =
      this.status !== "" && this.now() - this.statusAt < Footer.STATUS_MS;
    // HINTS carries its OWN styling (coloured chord, dim label) — wrapping it
    // in dim() again flattened every chord back to grey.
    const text = fresh ? terminalSafe(this.status) : HINTS;
    // Clip by VISIBLE cells: `.length` counts escape bytes, so the styled
    // hint line truncated ~9 columns early — and the test that "covered" it
    // asserted the same wrong metric, passing BECAUSE of the bug.
    return [visibleWidth(text) > width ? sliceByColumn(text, 0, width) : text];
  }
}
