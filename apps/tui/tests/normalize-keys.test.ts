import { describe, expect, it } from "vitest";
import { normalizeKeys } from "../src/shell/normalize-keys.js";
import { routeKey, type ShellScope } from "../src/shell/keys.js";

/**
 * THE P0 THIS FILE EXISTS FOR.
 *
 * A pre-merge review ran the compiled desk against the founder's real
 * terminal (Ghostty) and found that ctrl+q and ctrl+b did nothing: the
 * vendored engine asks the host for the KITTY KEYBOARD PROTOCOL at startup,
 * modern terminals accept, and from then on ctrl+q arrives as `ESC[113;5u`
 * rather than 0x11. The router compares raw bytes, so the desk had no quit,
 * the prefix never armed, EVERY advertised chord was dead, and the undecoded
 * sequence was written into the child — pressing ctrl+q at a shell prompt
 * typed `13;5u`.
 *
 * Every test in the suite was green. The compiled-entry smoke test could not
 * reach it either, because a bare node-pty never answers the capability
 * query, so the desk stayed in legacy mode. That is the specific blindness
 * these tests remove.
 */

const ESC = String.fromCodePoint(0x1b);
const CTRL_Q = String.fromCodePoint(0x11);
const CTRL_B = String.fromCodePoint(0x02);

describe("kitty CSI-u decodes to the legacy bytes the router knows", () => {
  it.each([
    [`${ESC}[113;5u`, CTRL_Q, "ctrl+q"],
    [`${ESC}[98;5u`, CTRL_B, "ctrl+b"],
    [`${ESC}[27u`, ESC, "escape"],
    [`${ESC}[13u`, "\r", "enter"],
    [`${ESC}[9u`, "\t", "tab"],
    [`${ESC}[9;2u`, `${ESC}[Z`, "shift+tab"],
    [`${ESC}[98;3u`, `${ESC}b`, "alt+b"],
    [`${ESC}[99;5u`, String.fromCodePoint(3), "ctrl+c"],
  ])("%s → %s (%s)", (input, expected) => {
    expect(normalizeKeys(input)).toBe(expected);
  });

  it("handles the disambiguating event/alternate-key sub-parameters", () => {
    // Kitty may send `ESC[113:81;5u` (base:shifted) or `…;5:1u` (event type).
    expect(normalizeKeys(`${ESC}[113:81;5u`)).toBe(CTRL_Q);
    expect(normalizeKeys(`${ESC}[113;5:1u`)).toBe(CTRL_Q);
  });
});

describe("xterm modifyOtherKeys decodes too", () => {
  it.each([
    [`${ESC}[27;5;113~`, CTRL_Q, "ctrl+q"],
    [`${ESC}[27;5;98~`, CTRL_B, "ctrl+b"],
    [`${ESC}[27;3;98~`, `${ESC}b`, "alt+b"],
  ])("%s → %s (%s)", (input, expected) => {
    expect(normalizeKeys(input)).toBe(expected);
  });
});

describe("it translates, it never filters", () => {
  // OVER-TRANSLATION is the risk a boundary translator carries: it can break
  // input that used to work. This enumerates what must survive byte-for-byte.
  it.each([
    ["q"],
    ["hello world"],
    ["caf\u00e9 na\u00efve"],
    ["\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8"],
    ["\ud83d\ude80 ship it"],
    [`${ESC}[A`],
    [`${ESC}[B`],
    [`${ESC}[D`],
    [`${ESC}[1;5A`],
    [`${ESC}[1;5C`],
    [`${ESC}[H`],
    [`${ESC}[F`],
    [`${ESC}[5~`],
    [`${ESC}[3~`],
    [`${ESC}[15~`],
    [`${ESC}OP`],
    [`${ESC}[200~pasted${ESC}[201~`],
    [`${ESC}[<0;10;5M`],
    [`${ESC}[<0;10;5m`],
    [`${ESC}[I`],
    [`${ESC}[O`],
    [`${ESC}b`],
    [CTRL_Q],
    [CTRL_B],
    [ESC],
    ["\r"],
    ["\t"],
  ])("passes %j through unchanged", (input) => {
    expect(normalizeKeys(input)).toBe(input);
  });

  it("translates a coalesced chunk piecewise", () => {
    // A fast typist's keystrokes arrive in one read.
    expect(normalizeKeys(`${ESC}[98;5u${ESC}[115;1u`)).toBe(`${CTRL_B}s`);
    // And a sequence mixed with literal text survives both halves.
    expect(normalizeKeys(`abc${ESC}[113;5u`)).toBe(`abc${CTRL_Q}`);
  });
});

describe("the contract holds under the protocol, not just under legacy bytes", () => {
  const live: ShellScope = {
    reviewOpen: false,
    reviewApprovable: true,
    reviewResolving: false,
    memoryOpen: false,
    memoryBusy: false,
    helpOpen: false,
    navOpen: false,
    spawnMenuOpen: false,
    crewOpen: false,
    sidebarOpen: false,
    inboxFocused: false,
    inboxHasRows: false,
    livePane: true,
    governedOpen: false,
    corpseOnScreen: false,
    prefixArmed: false,
    composerOpen: false,
    composerBusy: false,
  };

  it("ctrl+q quits when the host speaks kitty", () => {
    expect(routeKey(normalizeKeys(`${ESC}[113;5u`), live)).toEqual({
      kind: "quit",
    });
  });

  it("ctrl+b arms the prefix when the host speaks kitty", () => {
    expect(routeKey(normalizeKeys(`${ESC}[98;5u`), live)).toEqual({
      kind: "arm-prefix",
    });
  });

  it("a CSI-u ctrl+c still reaches the CHILD, decoded", () => {
    // The child never negotiated kitty with our emulator, so it expects the
    // legacy byte. Forwarding the raw sequence is how `13;5u` appeared at a
    // shell prompt.
    expect(routeKey(normalizeKeys(`${ESC}[99;5u`), live)).toEqual({
      kind: "to-child",
      data: String.fromCodePoint(3),
    });
  });

  it("ctrl+q quits when the host speaks modifyOtherKeys", () => {
    expect(routeKey(normalizeKeys(`${ESC}[27;5;113~`), live)).toEqual({
      kind: "quit",
    });
  });
});

describe("what it must REFUSE to translate", () => {
  it("kitty's functional-key block never becomes an invisible character", () => {
    // 57344–57454 encode numpad Enter, F13+, media keys. `fromCodePoint`
    // turned them into INVISIBLE private-use characters that a review found
    // being injected into a child's stdin AND into a task title bound for the
    // brain — worse than the raw sequence, which is at least visible.
    for (const code of [57344, 57399, 57414, 57454]) {
      const seq = `${ESC}[${code}u`;
      expect(normalizeKeys(seq), `U+${code.toString(16)}`).toBe(seq);
    }
  });

  it("a super/meta chord is passed through, never flattened to a letter", () => {
    // cmd+q became a plain `q` typed into the child. There is no legacy form,
    // so it must stay raw and let the child decide.
    expect(normalizeKeys(`${ESC}[113;9u`)).toBe(`${ESC}[113;9u`);
  });

  it("alt+backspace deletes a WORD, not a character", () => {
    expect(normalizeKeys(`${ESC}[127;3u`)).toBe(
      `${ESC}${String.fromCodePoint(0x7f)}`
    );
    expect(normalizeKeys(`${ESC}[127u`)).toBe(String.fromCodePoint(0x7f));
  });
});

describe("THE FORM A REAL TERMINAL SENDS ONCE EVENT REPORTING IS ON", () => {
  // The engine asks for `CSI > 7 u`, and bit 2 of that is REPORT EVENT TYPES.
  // A terminal that grants it cannot send a bare `ESC [ A` for an arrow — it
  // has nowhere to put press/repeat/release — so it sends the full form.
  //
  // This is what actually broke the founder's up and down arrows, and it
  // survived the previous fix AND a 79-case pty probe, because the probe sent
  // `ESC [ A`: a form their terminal never produces. A probe is only as good
  // as its premise about the input, and this suite is where that premise is
  // written down.
  it.each([
    [`${ESC}[1;1:1A`, `${ESC}[A`, "up, pressed"],
    [`${ESC}[1;1:2A`, `${ESC}[A`, "up, auto-repeat"],
    [`${ESC}[1;1:1B`, `${ESC}[B`, "down"],
    [`${ESC}[1;1:1C`, `${ESC}[C`, "right"],
    [`${ESC}[1;1:1D`, `${ESC}[D`, "left"],
    [`${ESC}[1;1:1H`, `${ESC}[H`, "home"],
    [`${ESC}[1;1:1F`, `${ESC}[F`, "end"],
    [`${ESC}[5;1:1~`, `${ESC}[5~`, "pageup"],
    [`${ESC}[6;1:1~`, `${ESC}[6~`, "pagedown"],
    [`${ESC}[3;1:1~`, `${ESC}[3~`, "delete"],
    [`${ESC}[2;1:1~`, `${ESC}[2~`, "insert"],
  ])("%s → %s (%s)", (input, expected) => {
    expect(normalizeKeys(input)).toBe(expected);
  });

  it("KEEPS a real modifier and drops only the event", () => {
    // `1` in the modifier field means none; anything else is a real chord and
    // the child needs it.
    expect(normalizeKeys(`${ESC}[1;2:1A`)).toBe(`${ESC}[1;2A`);
    expect(normalizeKeys(`${ESC}[1;5:1D`)).toBe(`${ESC}[1;5D`);
    expect(normalizeKeys(`${ESC}[5;3:1~`)).toBe(`${ESC}[5;3~`);
  });

  it("DROPS a release rather than passing the bytes on", () => {
    // This test used to assert the opposite, on the reasoning that "the engine
    // filters those before the desk sees them" — so not manufacturing a
    // keystroke was enough. That was wrong in a way the assertion then
    // protected: returning the release unchanged means it is forwarded to the
    // CHILD as raw escape bytes, and with event reporting negotiated that
    // happens on every keystroke. A key-up is not input. It is nothing.
    expect(normalizeKeys(`${ESC}[1;1:3A`)).toBe("");
    expect(normalizeKeys(`${ESC}[5;1:3~`)).toBe("");
    expect(normalizeKeys(`${ESC}[113;5:3u`)).toBe("");
  });

  it("and a press still survives the release that follows it", () => {
    expect(normalizeKeys(`${ESC}[1;1:1A${ESC}[1;1:3A`)).toBe(`${ESC}[A`);
  });

  it("leaves the legacy forms exactly alone", () => {
    for (const legacy of [`${ESC}[A`, `${ESC}[1;5A`, `${ESC}[5~`, `${ESC}OA`]) {
      expect(normalizeKeys(legacy), legacy).toBe(legacy);
    }
  });

  it("has NO raw escape byte in its own source", async () => {
    // Two patterns here carried a literal 0x1b. It is invisible in an editor
    // and in a diff, so the new patterns were written by copying the visible
    // part of a neighbour, silently lacked it, and matched nothing — the fix
    // shipped inert and the arrows stayed dead. A control byte nobody can see
    // is a control byte nobody can review.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/shell/normalize-keys.ts", import.meta.url),
      "utf8"
    );
    expect(source.includes(ESC), "build patterns from the ESC constant").toBe(
      false
    );
  });
});

describe("CSI-u must honour EVENT TYPES like its two siblings", () => {
  /**
   * Found by the key doctor's first real run: the founder's `ctrl+b ⏎`
   * reported `misrouted`. The navigation branches (CSI-letter, CSI-tilde) both
   * drop key RELEASES; the CSI-u branch captured no event type at all, so a
   * release decoded to the same byte as a press. When a press and its release
   * arrive in ONE read — which is ordinary, they are microseconds apart —
   * Enter became TWO Enters, matched nothing, and reported as a broken chord.
   *
   * The bug is not that Enter is special. It is that one branch of a
   * three-branch decoder did not implement the protocol the other two did.
   */
  const CSI = `${ESC}[`;

  it("a RELEASE is not a press", () => {
    expect(normalizeKeys(`${CSI}13;1:3u`)).toBe("");
    expect(normalizeKeys(`${CSI}113;5:3u`)).toBe("");
  });

  it("a press still decodes, with or without an event subparameter", () => {
    expect(normalizeKeys(`${CSI}13u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}13;1u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}13;1:1u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}13;1:2u`)).toBe("\r"); // key repeat IS a press
  });

  it("a press and its release in ONE read is ONE keystroke", () => {
    // The exact shape that broke Enter. Two Enters match nothing.
    expect(normalizeKeys(`${CSI}13;1:1u${CSI}13;1:3u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}113;5:1u${CSI}113;5:3u`)).toBe(
      String.fromCodePoint(17)
    );
  });

  it("reads the ASSOCIATED TEXT section instead of giving up on the chord", () => {
    // `CSI code ; mods:event ; text u`. Unparsed, the whole sequence was
    // forwarded to the child as though the human had typed it.
    expect(normalizeKeys(`${CSI}13;1:1;13u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}97;1:1;97u`)).toBe("a");
  });

  it("reads BOTH alternate-key subparameters", () => {
    // `code:shifted:base` — the earlier pattern allowed only one.
    expect(normalizeKeys(`${CSI}13:13;1u`)).toBe("\r");
    expect(normalizeKeys(`${CSI}97:65:97;1u`)).toBe("a");
  });
});

describe("a sequence followed by TEXT in one read", () => {
  /**
   * `ESC[98;5us` is a kitty ctrl+b with the command key appended — the
   * ordinary shape when two keys are typed quickly, and the shape the
   * founder's terminal produces because it negotiated the kitty protocol.
   *
   * The walk used to cut only at the next ESC, so this matched no pattern as
   * a whole and was passed through untranslated: the chord did nothing and
   * the letters were typed into the pane.
   */
  it("separates the chord from the letter after it", () => {
    expect(normalizeKeys(`${ESC}[98;5us`)).toBe(`${String.fromCodePoint(2)}s`);
    expect(normalizeKeys(`${ESC}[113;5uabc`)).toBe(
      `${String.fromCodePoint(17)}abc`
    );
  });

  it("separates an arrow from text after it", () => {
    expect(normalizeKeys(`${ESC}[Ahello`)).toBe(`${ESC}[Ahello`);
    expect(normalizeKeys(`${ESC}[1;1:1Ax`)).toBe(`${ESC}[Ax`);
  });

  it("handles several sequences and text interleaved", () => {
    expect(normalizeKeys(`a${ESC}[98;5ub${ESC}[113;5uc`)).toBe(
      `a${String.fromCodePoint(2)}b${String.fromCodePoint(17)}c`
    );
  });
});

describe("SHIFTED PUNCTUATION — the terminal knows the layout, MUON does not", () => {
  /**
   * The founder's second doctor run: `ctrl+b ?` arrived as 0x2f (`/`) and
   * `ctrl+b |` as 0x5c (`\`), so both resolved to nothing.
   *
   * The cause was `mods.shift ? char.toUpperCase() : char`, which is right for
   * letters and silently wrong for every punctuation mark — `'/'.toUpperCase()`
   * is `'/'`. Which character shift produces depends on the keyboard LAYOUT
   * (`?` is shift+`/` on US, shift+`+` on German), and only the terminal knows
   * it. Under flags 7 it TELLS us, in the first sub-parameter, and MUON was
   * discarding that.
   */
  it.each([
    [`${ESC}[47:63;2u`, "?", "shift+/ on a US layout"],
    [`${ESC}[92:124;2u`, "|", "shift+\\"],
    [`${ESC}[49:33;2u`, "!", "shift+1"],
    [`${ESC}[59:58;2u`, ":", "shift+;"],
    [`${ESC}[45:95;2u`, "_", "shift+-"],
  ])("%s → %s (%s)", (input, expected) => {
    expect(normalizeKeys(input)).toBe(expected);
  });

  it("still uppercases a letter when no alternate is offered", () => {
    // A terminal that did not grant report-alternate-keys sends no sub-param.
    expect(normalizeKeys(`${ESC}[97;2u`)).toBe("A");
  });

  it("prefers the terminal's alternate over our guess, for letters too", () => {
    expect(normalizeKeys(`${ESC}[97:65;2u`)).toBe("A");
  });

  it("does NOT substitute when shift rides another modifier", () => {
    // `ctrl+shift+a` is a control chord on the base key, not the character A.
    // Substituting the shifted key here would turn it into plain text.
    expect(normalizeKeys(`${ESC}[97:65;6u`)).toBe(String.fromCodePoint(1));
    // ctrl+shift+/ has no legacy form, so it passes through untranslated —
    // the point is that it does NOT become the text `?`, which would type a
    // character into the pane instead of delivering a chord.
    expect(normalizeKeys(`${ESC}[47:63;6u`)).not.toBe("?");
  });
})
