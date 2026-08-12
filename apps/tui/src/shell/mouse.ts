/**
 * MOUSE ON THE DESK — chrome takes clicks, the pane belongs to the child.
 *
 * The founder asked for the desktop's interaction model in the terminal: click
 * `+` to open a tab, click a session in the rail to go to it. That is worth
 * having on its own, and it is worth MORE than convenience here — the key
 * doctor's first run showed that what a terminal delivers is not something
 * MUON gets to decide. A desk that can only be driven by chords is a desk that
 * some terminal, somewhere, can lock a user out of. The mouse is the path that
 * does not depend on a keyboard protocol negotiation.
 *
 * THE ONE RULE, and the reason this is safe to ship:
 *
 *   A vendor CLI that armed mouse tracking OWNS the mouse inside its pane.
 *
 * Claude Code, an editor, a pager — each may be listening for clicks. Stealing
 * those would break the very tools MUON exists to host. So MUON claims only
 * what it drew itself: the tab strip, the rail, and the chrome around them.
 * Everything inside the pane is forwarded untouched.
 */

const ESC = String.fromCodePoint(0x1b);

/** `ESC [ < button ; col ; row (M|m)` — SGR 1006, the only encoding we accept. */
const SGR_MOUSE = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

export type MouseEvent = {
  /** Zero-based, relative to the top-left of the frame MUON drew. */
  readonly col: number;
  readonly row: number;
  /**
   * `move` is pointer motion with NO button held — button bits `11` alongside
   * the motion bit. It was folded into `drag`, which made it look like a
   * gesture a child might want; it is the single most frequent report a
   * terminal produces and almost nothing asks for it.
   */
  readonly kind: "press" | "release" | "drag" | "move" | "wheel";
  /**
   * For a click: 0 left, 1 middle, 2 right.
   * For a wheel: 0 up, 1 down, 2 left, 3 right — a DIRECTION, not a button.
   */
  readonly button: number;
};

/**
 * Parse ONE mouse report, or null.
 *
 * Deliberately strict: anything that is not exactly an SGR report is not a
 * mouse event, and guessing would mean swallowing a keystroke. The older X10
 * and 1005 encodings are not accepted — they are ambiguous above column 223,
 * and every terminal MUON negotiates with supports 1006.
 */
export function parseMouse(data: string): MouseEvent | null {
  const match = SGR_MOUSE.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  const col = Number(match[2]) - 1;
  const row = Number(match[3]) - 1;
  if (!Number.isFinite(button) || col < 0 || row < 0) return null;

  // Bit 6 (64) marks the wheel; bit 5 (32) marks motion with a button held.
  const wheel = (button & 64) !== 0;
  const drag = (button & 32) !== 0;
  // Low bits `11` (3) mean "no button". With the motion bit that is a bare
  // pointer MOVE; without it, it is a release in the older encoding.
  const noButton = (button & 3) === 3;
  const kind = wheel
    ? "wheel"
    : match[4] === "m"
      ? "release"
      : drag
        ? noButton
          ? "move"
          : "drag"
        : "press";
  // The low two bits carry the button for a click and the DIRECTION for a
  // wheel (64-67 -> up, down, left, right). One mask serves both; taking only
  // the low bit for the wheel would report a horizontal scroll as "up".
  return { col, row, kind, button: button & 3 };
}

/** True for any byte sequence that is a mouse report at all. */
export function isMouseReport(data: string): boolean {
  return SGR_MOUSE.test(data);
}

/**
 * Re-encode a report at different coordinates.
 *
 * A child is drawn INSIDE the frame, not at its origin: the tab strip takes a
 * row and the rail takes columns. Forwarding the terminal's absolute position
 * would land every click one strip-height and one rail-width away from where
 * the human aimed — worse than not forwarding at all, because it looks like it
 * works.
 */
export function encodeMouse(event: MouseEvent, col: number, row: number): string {
  const wheel = event.kind === "wheel";
  const raw = wheel ? 64 + event.button : event.kind === "drag" ? 32 + event.button : event.button;
  const final = event.kind === "release" ? "m" : "M";
  return `${ESC}[<${raw};${col + 1};${row + 1}${final}`;
}

/**
 * `ESC[I` / `ESC[O` — the terminal saying the WINDOW gained or lost focus.
 *
 * The engine arms focus reporting (`?1004h`) for its own use, so these arrive
 * whether or not anything wants them, and MUON forwarded them to the child as
 * unrecognised bytes. A child that did not arm focus reporting has no reason
 * to receive it, and cannot distinguish it from someone typing.
 */
export function isFocusReport(data: string): boolean {
  return data === `${ESC}[I` || data === `${ESC}[O`;
}

/**
 * Would a child that armed `mode` want to hear about this event?
 *
 * MUON's host terminal has all-motion tracking armed for the engine's own
 * selection handling, so pointer movement produces a report continuously,
 * whether or not the program in the pane cares. A child that armed nothing
 * receives those as ordinary bytes and TYPES them: the founder's pane filled
 * with `<35;46;32M<35;47;31M…` the moment the mouse crossed it.
 *
 * So the child's own declared mode decides, exactly as it would if it were
 * running in a real terminal:
 *
 *   none    nothing at all — the default, and most CLIs never leave it
 *   x10     button presses only
 *   vt200   presses and releases
 *   drag    the above, plus motion WHILE a button is held
 *   any     the above, plus bare pointer motion
 */
export function childWantsMouse(
  mode: "none" | "x10" | "vt200" | "drag" | "any",
  event: MouseEvent
): boolean {
  switch (mode) {
    case "none":
      return false;
    case "x10":
      return event.kind === "press";
    case "vt200":
      return event.kind === "press" || event.kind === "release" || event.kind === "wheel";
    case "drag":
      return event.kind !== "move";
    case "any":
      return true;
  }
}

/**
 * Split a read that carries SEVERAL mouse reports.
 *
 * A press and its release are microseconds apart, and motion reports stream —
 * so a terminal routinely delivers two or more in one read. `isMouseReport`
 * matches exactly one, so a coalesced chunk matched nothing, fell through the
 * mouse router entirely, and was forwarded to the child as ordinary text:
 * chrome routing, the child's mouse-mode filter and the pane-relative
 * coordinate translation were all skipped at once.
 *
 * Returns null unless the WHOLE chunk is mouse reports — a chunk mixing a
 * report with real typing is left alone rather than guessed at.
 */
export function splitMouseReports(data: string): string[] | null {
  if (!data.startsWith(ESC)) return null;
  const reports: string[] = [];
  let rest = data;
  while (rest.length > 0) {
    const match = /^\u001b\[<\d+;\d+;\d+[Mm]/.exec(rest);
    if (!match) return null;
    reports.push(match[0]);
    rest = rest.slice(match[0].length);
  }
  return reports.length > 0 ? reports : null;
}
