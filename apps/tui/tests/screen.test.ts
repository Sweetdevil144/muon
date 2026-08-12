import { describe, expect, it } from "vitest";
import { Screen } from "../src/shell/screen.js";

describe("DECTCEM is its BYTES, not its readable tail", () => {
  /**
   * `lastIndexOf("[?25l")` matched the bare text, so a child that PRINTED it —
   * a log line, a docs snippet, `cat` of a script that sets it — hid or showed
   * the pane's caret until the next real sequence arrived.
   */
  const ESC = String.fromCodePoint(0x1b);

  it("a child PRINTING the literal text does not move the caret", () => {
    const screen = new Screen(80, 24);
    const before = screen.cursor.shown;
    screen.write("docs: write [?25l to hide the cursor\r\n");
    expect(screen.cursor.shown).toBe(before);
  });

  it("but the real sequence still hides and shows it", () => {
    const screen = new Screen(80, 24);
    screen.write(`${ESC}[?25l`);
    expect(screen.cursor.shown).toBe(false);
    screen.write(`${ESC}[?25h`);
    expect(screen.cursor.shown).toBe(true);
  });

  it("and LAST one still wins inside one read", () => {
    const screen = new Screen(80, 24);
    screen.write(`${ESC}[?25l painting ${ESC}[?25h done`);
    expect(screen.cursor.shown).toBe(true);
  });
});
