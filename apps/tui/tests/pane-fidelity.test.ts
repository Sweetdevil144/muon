import { describe, expect, it } from "vitest";
import { Screen } from "../src/shell/screen.js";
import { CURSOR_MARKER } from "../src/vendor/pi-tui/src/tui.ts";

/**
 * WHAT THE PANE OWES THE CHILD (ADR-0046 D1: "the pane renders the child's own
 * look").
 *
 * Two founder screenshots, one root cause each, and both invisible to every
 * test in this repo because both are properties of the BYTES we hand the host
 * terminal rather than of any string a component returns.
 *
 *  1. A vendor CLI ran in a pane and came back nearly monochrome. `screen.ts`
 *     had the emulator's `0x2000000` colour-mode tag written down as
 *     truecolor. It is 256-COLOUR. Truecolor cells — which is most of what a
 *     modern CLI emits — matched no branch, fell through to the indexed one,
 *     and went out as `38;5;<24-bit integer>`: a palette index in the
 *     millions, which every terminal drops. The child's colours became the
 *     terminal's default foreground.
 *
 *  2. There was no cursor anywhere. The engine parks the hardware cursor and
 *     hides it unless a focused component emits CURSOR_MARKER; the pane never
 *     did. A terminal you cannot see the caret in does not look like it is
 *     listening, whatever it does with your keystrokes.
 *
 * These assert the emitted SGR and the marker's placement directly. A
 * screenshot cannot be a regression test; this can.
 */

const ESC = String.fromCodePoint(0x1b);

/**
 * Feed a child's bytes and read back what we would write to the host.
 *
 * The emulator parses ASYNCHRONOUSLY — `write` queues — so this flushes with a
 * zero-length write whose callback is ordered behind the real one. Reading
 * without it returns the frame BEFORE the child's bytes and passes for the
 * wrong reason.
 */
async function paint(bytes: string, cursorMarker?: string): Promise<string[]> {
  const screen = new Screen(40, 4);
  screen.write(bytes);
  await new Promise<void>((resolve) => screen.term.write("", resolve));
  return screen.renderScreen(cursorMarker);
}

/** The same, for assertions that only need the first row. */
async function row0(bytes: string, cursorMarker?: string): Promise<string> {
  return (await paint(bytes, cursorMarker))[0]!;
}

describe("the child's colours arrive intact", () => {
  it("keeps TRUECOLOR as truecolor", async () => {
    // The regression: this used to emit `38;5;14120791`.
    const line = await row0(`${ESC}[38;2;215;119;87mX`);
    expect(line).toContain("38;2;215;119;87");
    expect(line, "no impossible palette index").not.toMatch(/38;5;\d{4,}/);
  });

  it("keeps a 256-COLOUR index as an index", async () => {
    // The mirror-image regression: index 208 (orange) used to be re-read as
    // packed RGB and emitted as `38;2;0;0;208`, a dark blue.
    const line = await row0(`${ESC}[38;5;208mX`);
    expect(line).toContain("38;5;208");
    expect(line).not.toContain("38;2;0;0;208");
  });

  it("keeps the basic sixteen in their short forms", async () => {
    expect(await row0(`${ESC}[31mX`)).toContain(`${ESC}[31m`);
    expect(await row0(`${ESC}[92mX`)).toContain(`${ESC}[92m`);
  });

  it("keeps BACKGROUNDS, in all three colour depths", async () => {
    expect(await row0(`${ESC}[48;2;10;20;30mX`)).toContain("48;2;10;20;30");
    expect(await row0(`${ESC}[48;5;208mX`)).toContain("48;5;208");
    expect(await row0(`${ESC}[41mX`)).toContain(`${ESC}[41m`);
    expect(await row0(`${ESC}[102mX`)).toContain(`${ESC}[102m`);
  });

  it("keeps the attributes a CLI actually uses", async () => {
    // Bold/dim/italic/underline/inverse were already carried. Strikethrough
    // and blink were silently dropped, so a struck-through diff line and a
    // blinking warning both rendered as ordinary text.
    expect(await row0(`${ESC}[1;3;4;9mX`)).toContain(`${ESC}[1;3;4;9m`);
    expect(await row0(`${ESC}[2;5;7mX`)).toContain(`${ESC}[2;5;7m`);
  });

  it("says nothing when the child asked for the terminal's own colour", async () => {
    // A default-coloured cell must NOT be pinned to a concrete colour: the
    // host's theme is the child's intent here.
    const line = await row0("X");
    expect(line).not.toContain("38;");
    expect(line).not.toContain("48;");
  });
});

describe("the child's cursor is drawn where the child put it", () => {
  it("marks the cursor cell, and only when asked", async () => {
    expect(await row0("abc", CURSOR_MARKER)).toBe(`abc${CURSOR_MARKER}`);
    // Opt-in: the ADR-0047 snapshot capture and an unfocused split both call
    // this without a marker, and a stray APC in a file on disk is litter.
    expect(await row0("abc")).toBe("abc");
  });

  it("puts the marker on the cursor's ROW, not the first one", async () => {
    const lines = await paint(`one\r\ntwo\r\nthree`, CURSOR_MARKER);
    expect(lines[0]).not.toContain(CURSOR_MARKER);
    expect(lines[1]).not.toContain(CURSOR_MARKER);
    expect(lines[2]).toBe(`three${CURSOR_MARKER}`);
  });

  it("survives the trailing-blank trim when the cursor sits past the text", async () => {
    // The common case: a shell prompt with the caret one cell to the right of
    // everything visible. Trimming blanks after the marker is fine; trimming
    // THROUGH it would silently move the caret back to the end of the text.
    expect(await row0(`hi${ESC}[10G`, CURSOR_MARKER)).toBe(
      `hi${" ".repeat(7)}${CURSOR_MARKER}`
    );
  });

  it("honours the child hiding its own cursor (DECTCEM)", async () => {
    // A full-screen TUI that hides the caret must not have one drawn for it.
    expect(await row0(`${ESC}[?25labc`, CURSOR_MARKER)).toBe("abc");
    // …and gets it back when it asks.
    expect(await row0(`${ESC}[?25labc${ESC}[?25h`, CURSOR_MARKER)).toBe(
      `abc${CURSOR_MARKER}`
    );
  });

  it("takes the LAST word in a chunk that hides and shows", async () => {
    // One read routinely carries hide → repaint → show.
    expect(await row0(`${ESC}[?25l${ESC}[?25habc`, CURSOR_MARKER)).toContain(
      CURSOR_MARKER
    );
    expect(
      await row0(`${ESC}[?25h${ESC}[?25labc`, CURSOR_MARKER)
    ).not.toContain(CURSOR_MARKER);
  });

  it("a reset returns the cursor to its power-on visible state", () => {
    const screen = new Screen(40, 2);
    screen.write(`${ESC}[?25l`);
    expect(screen.cursor.shown).toBe(false);
    screen.reset();
    expect(screen.cursor.shown).toBe(true);
  });
});

describe("the child's own INPUT modes are honoured, not just its output", () => {
  // The second reason the founder's arrows did nothing. A full-screen TUI arms
  // application cursor keys (DECSET 1) and then listens for `ESC O A`, not
  // `ESC [ A`. Our host terminal is in whatever mode MUON's engine put it in —
  // the normal one — so forwarding verbatim hands the child a sequence it has
  // explicitly stopped listening for.
  async function sessionWith(mode: string) {
    const screen = new Screen(40, 8);
    screen.write(mode);
    await new Promise<void>((r) => screen.term.write("", r));
    return screen;
  }

  it("reports DECCKM the way the child set it", async () => {
    expect((await sessionWith("")).applicationCursorKeys).toBe(false);
    expect((await sessionWith(`${ESC}[?1h`)).applicationCursorKeys).toBe(true);
    expect(
      (await sessionWith(`${ESC}[?1h${ESC}[?1l`)).applicationCursorKeys
    ).toBe(false);
  });

  it("a reset returns it to the power-on state", async () => {
    const screen = await sessionWith(`${ESC}[?1h`);
    screen.reset();
    expect(screen.applicationCursorKeys).toBe(false);
  });
});
