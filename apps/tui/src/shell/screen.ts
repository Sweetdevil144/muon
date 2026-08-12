import xterm from "@xterm/headless";
const { Terminal } = xterm;
type Terminal = InstanceType<typeof Terminal>;

/**
 * A terminal SCREEN: a headless emulator plus the one renderer that turns its
 * buffer into lines the shell can compose.
 *
 * Extracted so the two feeders share it rather than copy it. A pty session
 * feeds bytes from a child it owns; a governed session feeds frames the brain
 * recorded from an agent it dispatched. Both need the same thing afterwards —
 * a viewport rendered as text + SGR ONLY, because anything else (mode arming,
 * cursor motion, alt-screen enters) escapes into the host terminal and
 * hijacks it. That rule was learned the expensive way and now has one
 * implementation instead of two that agree today.
 */
const ESC = String.fromCodePoint(0x1b);

export class Screen {
  readonly term: Terminal;
  private rows: number;
  /**
   * DECTCEM, tracked by hand.
   *
   * The emulator exposes `modes` for bracketed paste, origin, wraparound and
   * the rest, but NOT for cursor visibility — so the only way to know whether
   * the child wants a cursor drawn is to watch its own `?25h` / `?25l` go by.
   * Power-on default is visible, which is also what a child that never says
   * anything means.
   */
  private cursorShown = true;

  constructor(cols: number, rows: number) {
    this.rows = rows;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      // MEASURED, not inherited. The desktop's 5000 lines cost ~8 MB per
      // saturated pane here (heap + the ArrayBuffers holding the cell grid —
      // `heapUsed` alone hides most of it, which is how a published figure of
      // "~1 MB" was wrong by an order of magnitude). At 32 panes that is a
      // quarter-gigabyte of scrollback nobody asked for, so this desk keeps a
      // smaller window: still far more than a screen, bounded by intent.
      scrollback: 2000,
    });
  }

  write(data: string): void {
    // LAST ONE WINS: a single read can carry a hide, a repaint and a show.
    // Scanning for the final occurrence is what a real terminal ends up at.
    //
    // THE ESC IS PART OF THE SEQUENCE. Matching the bare `[?25l` made any
    // child that PRINTED that text — a log line, a docs snippet, `cat` of a
    // script that sets it — toggle the pane's caret until the next real
    // DECTCEM arrived. A control sequence is its bytes, not its readable tail.
    const hide = data.lastIndexOf(`${ESC}[?25l`);
    const show = data.lastIndexOf(`${ESC}[?25h`);
    if (hide !== -1 || show !== -1) this.cursorShown = show > hide;
    this.term.write(data);
  }

  /**
   * Where the CHILD's cursor is, in viewport coordinates, and whether it asked
   * for one to be drawn.
   *
   * The pane hands this to the engine's hardware-cursor contract so the real
   * terminal cursor sits where the child put it. Without it the desk rendered
   * a live shell with NO cursor anywhere — the founder's report — because the
   * engine parks the hardware cursor and hides it unless a focused component
   * says otherwise, and the pane never did.
   */
  get cursor(): { row: number; col: number; shown: boolean } {
    const buffer = this.term.buffer.active;
    return {
      // `cursorY` is already relative to the viewport top; `baseY`/`viewportY`
      // only diverge while scrolled back, and this desk never scrolls back.
      row: buffer.cursorY,
      col: buffer.cursorX,
      shown: this.cursorShown,
    };
  }

  resize(cols: number, rows: number): void {
    this.rows = rows;
    this.term.resize(cols, rows);
  }

  /**
   * Wipe the emulated screen and its scrollback — a HARD reset, for when the
   * feed changes identity (a dispatched job re-executing) rather than merely
   * continuing. `term.reset()` clears the buffers and returns modes to their
   * power-on state, which is exactly right here: the new execution has not
   * armed anything yet, and inheriting the dead run's modes would be the same
   * class of lie as inheriting its output.
   */
  reset(): void {
    this.cursorShown = true;
    this.term.reset();
  }

  /** True when the CHILD armed bracketed paste (DECSET 2004). */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /**
   * True when the CHILD armed APPLICATION CURSOR KEYS (DECSET 1).
   *
   * A full-screen TUI routinely does, and it then expects `ESC O A` for Up
   * rather than `ESC [ A` — that is the whole point of the mode. Our host
   * terminal is in whatever mode MUON's own engine put it in, so it sends the
   * NORMAL form; forwarding that verbatim hands the child a sequence it is no
   * longer listening for. A real terminal re-encodes; so do we.
   */
  /**
   * WHAT MOUSE REPORTS THIS CHILD ASKED FOR, if any.
   *
   * `none` is the default and the common case: most CLIs never arm mouse
   * tracking. MUON's HOST terminal has it armed regardless — the engine turns
   * on all-motion tracking for its own selection handling — so every pointer
   * movement produces a report whether or not anything wants it. Forwarding
   * those to a child that never asked types `<35;46;32M` into it, once per
   * mouse move.
   */
  get mouseTracking(): "none" | "x10" | "vt200" | "drag" | "any" {
    return this.term.modes.mouseTrackingMode;
  }

  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /**
   * Disarm the emulated modes a dead child may have left set — mouse
   * tracking, bracketed paste, the alt screen — so the final frame renders
   * sanely. Only the EMULATED state needs it: our host terminal was never
   * armed, because the emulator absorbed those sequences.
   */
  disarm(): void {
    const esc = String.fromCodePoint(0x1b);
    this.term.write(`${esc}[?1000l${esc}[?2004l${esc}[?1049l`);
  }

  /**
   * The viewport as text + SGR.
   *
   * `cursorMarker`, when given, is spliced in at the child's cursor cell — a
   * zero-width APC the engine finds, strips, and turns into a real hardware
   * cursor. It is OPT-IN because this same method feeds the ADR-0047 snapshot
   * capture, and a marker written to a file on disk would be a stray escape
   * in a corpse nobody can see it in.
   */
  renderScreen(cursorMarker?: string): string[] {
    const esc = String.fromCodePoint(0x1b);
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    const cell = this.term.buffer.active.getNullCell();
    const cursor = cursorMarker ? this.cursor : null;
    for (let row = 0; row < this.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) {
        lines.push("");
        continue;
      }
      const markerCol =
        cursor && cursor.shown && cursor.row === row ? cursor.col : -1;
      let out = "";
      let prev = "";
      for (let col = 0; col < line.length; col += 1) {
        line.getCell(col, cell);
        const sgr = sgrFor(cell);
        if (sgr !== prev) {
          out += `${esc}[0m`;
          if (sgr) out += `${esc}[${sgr}m`;
          prev = sgr;
        }
        if (col === markerCol) out += cursorMarker;
        out += cell.getChars() || " ";
      }
      // A cursor sitting past the last cell (a full line, or a right margin)
      // still has to be drawn: pad out to it rather than drop it.
      if (markerCol >= line.length) {
        out += " ".repeat(markerCol - line.length) + cursorMarker;
      }
      if (prev) out += `${esc}[0m`;
      // Trailing blanks go, but never the marker — `out` ends at the marker
      // when the cursor sits beyond the text, which is the common case at a
      // prompt, and stripping past it would move the cursor to the left.
      lines.push(out.replace(/ +$/, ""));
    }
    return lines;
  }

  dispose(): void {
    this.term.dispose();
  }
}

/**
 * The emulator's colour-MODE tags, which are the top two bits of the attribute
 * word rather than an enum you can guess.
 *
 * THE BUG THESE CONSTANTS FIX. This file had `0x2000000` written down as
 * truecolor. It is 256-COLOUR. The consequences were both directions of wrong,
 * and together they are why the founder's screenshot of a vendor CLI running
 * in a pane came back almost monochrome:
 *
 *   - A truecolor cell (mode `0x3000000`, e.g. `38;2;215;119;87`) matched
 *     neither branch and fell through to the 256-colour one, emitting
 *     `38;5;14120791` — a palette index six orders of magnitude out of range.
 *     Terminals drop it, so every truecolor cell rendered in the DEFAULT
 *     foreground. Vendor CLIs are almost entirely truecolor.
 *   - A 256-colour cell (mode `0x2000000`, e.g. index 208 orange) was
 *     re-emitted as `38;2;0;0;208`, reading the index as packed RGB: a dark
 *     blue where the child asked for orange.
 *
 * Palette indexes were also tested BEFORE the mode, so a truecolor cell whose
 * packed value happened to be small (`rgb(0,0,5)`) came out as SGR 35.
 */
const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;
const CM_RGB = 0x3000000;

/** The SGR parameters for one cell — fg, bg, and the flags the engine keeps. */
function sgrFor(cell: {
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
}): string {
  const parts: string[] = [];
  if (cell.isBold()) parts.push("1");
  if (cell.isDim()) parts.push("2");
  if (cell.isItalic()) parts.push("3");
  if (cell.isUnderline()) parts.push("4");
  if (cell.isBlink()) parts.push("5");
  if (cell.isInverse()) parts.push("7");
  if (cell.isInvisible()) parts.push("8");
  if (cell.isStrikethrough()) parts.push("9");
  parts.push(...colourParts(cell.getFgColorMode(), cell.getFgColor(), 30));
  parts.push(...colourParts(cell.getBgColorMode(), cell.getBgColor(), 40));
  return parts.join(";");
}

/**
 * One cell's colour, as SGR parameters. `base` is 30 for foreground and 40 for
 * background; every other number follows from it, so the two can never drift
 * apart the way the two hand-written copies above them did.
 */
function colourParts(mode: number, colour: number, base: 30 | 40): string[] {
  if (mode === CM_RGB) {
    return [
      String(base + 8),
      "2",
      String((colour >> 16) & 0xff),
      String((colour >> 8) & 0xff),
      String(colour & 0xff),
    ];
  }
  if (mode === CM_P16 || mode === CM_P256) {
    // The 16 ANSI colours have short forms every terminal understands; the
    // rest go out as an indexed colour.
    if (colour < 8) return [String(base + colour)];
    if (colour < 16) return [String(base + 60 + (colour - 8))];
    return [String(base + 8), "5", String(colour)];
  }
  // CM_DEFAULT (0) — the child asked for the terminal's own colour, which is
  // said by saying nothing.
  return [];
}
