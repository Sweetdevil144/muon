import { describe, expect, it } from "vitest";
import { KeyStreamReader, trailingPartialAt } from "../src/shell/key-stream.js";

/**
 * The founder's requirement, in their words: make sure the shortcut buffer
 * reader is implemented correctly, and no overflow errors occur "due to which
 * even after configuration, shortcuts may work, and may not work depending on
 * characters pressed."
 *
 * That names the exact failure this file exists to prevent — INTERMITTENT
 * shortcuts. A reader that holds bytes it should release, or releases bytes it
 * should hold, produces a desk where the same chord works and then does not,
 * and no user can report that usefully.
 */

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function reader(options: { escDelayMs?: number; maxPending?: number } = {}) {
  const seen: string[] = [];
  let fire: (() => void) | undefined;
  const stream = new KeyStreamReader((data) => seen.push(data), {
    ...options,
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {
      fire = undefined;
    },
  });
  return {
    stream,
    seen,
    /** Run the pending escape-delay timer, if one is armed. */
    tick: () => fire?.(),
    armed: () => fire !== undefined,
  };
}

describe("a chord split across two reads is still ONE chord", () => {
  it("reassembles ctrl+b s arriving in pieces", () => {
    // Before this reader: chunk 1 was forwarded to the child as unknown bytes
    // and chunk 2 was TYPED into it as the literal text "5u". The chord did
    // nothing and the pane gained two junk characters.
    const { stream, seen } = reader();
    stream.push(`${ESC}[98;`);
    expect(seen, "nothing is dispatched from half a sequence").toEqual([]);
    stream.push("5u");
    expect(seen).toEqual([`${ESC}[98;5u`]);
  });

  it("reassembles a sequence split one byte at a time", () => {
    const { stream, seen } = reader();
    for (const byte of `${ESC}[113;5u`) stream.push(byte);
    expect(seen).toEqual([`${ESC}[113;5u`]);
  });

  it("emits the complete part immediately and holds only the tail", () => {
    // Latency matters: typing must not wait on a partial chord behind it.
    const { stream, seen } = reader();
    stream.push(`hello${ESC}[98;`);
    expect(seen).toEqual(["hello"]);
    stream.push("5u");
    expect(seen).toEqual(["hello", `${ESC}[98;5u`]);
  });

  it("passes ordinary typing through untouched, with no timer armed", () => {
    const { stream, seen, armed } = reader();
    stream.push("git status");
    expect(seen).toEqual(["git status"]);
    expect(armed()).toBe(false);
  });
});

describe("LIVENESS — nothing can be held forever", () => {
  it("a lone ESC is released by the timer, so Escape still works", () => {
    // The ambiguity that makes this hard: ESC is either the Escape key or the
    // first byte of a chord. Holding it without a timer would make Escape dead.
    const { stream, seen, tick } = reader();
    stream.push(ESC);
    expect(seen).toEqual([]);
    tick();
    expect(seen).toEqual([ESC]);
  });

  it("an abandoned half-sequence is released rather than wedged", () => {
    // If this were held, EVERY later keystroke would queue behind it and the
    // desk would appear frozen to input.
    const { stream, seen, tick } = reader();
    stream.push(`${ESC}[98;`);
    tick();
    expect(seen).toEqual([`${ESC}[98;`]);
    stream.push("x");
    expect(seen).toEqual([`${ESC}[98;`, "x"]);
  });

  it("the buffer is EMPTY after the timer runs, every time", () => {
    const { stream, tick } = reader();
    for (const chunk of [ESC, `${ESC}[`, `${ESC}[1;`, `${ESC}]11;rgb:`]) {
      stream.push(chunk);
      tick();
      expect(stream.held, `held after ${JSON.stringify(chunk)}`).toBe("");
    }
  });

  it("release() drains on shutdown so a half-typed chord is not swallowed", () => {
    const { stream, seen } = reader();
    stream.push(`${ESC}O`);
    stream.release();
    expect(seen).toEqual([`${ESC}O`]);
    expect(stream.held).toBe("");
  });
});

describe("BOUNDED — the overflow the founder asked about", () => {
  it("never holds more than maxPending, and dumps rather than growing", () => {
    // An unterminated OSC is the realistic shape: a string sequence with no
    // BEL and no ST. Without a bound it would absorb every subsequent
    // keystroke, and shortcuts would stop working with no visible cause.
    const { stream, seen } = reader({ maxPending: 32 });
    for (let round = 0; round < 20; round += 1) {
      stream.push(`${ESC}]11;${"a".repeat(10)}`);
      expect(stream.held.length).toBeLessThanOrEqual(32);
    }
    expect(seen.join("").length, "everything pushed came back out").toBeGreaterThan(0);
  });

  it("a big paste is not buffered — it flows straight through", () => {
    // `ESC[200~` is a COMPLETE sequence, so the body behind it is never a
    // trailing partial. If pastes were held this would be a memory bug and a
    // visible stall on every paste.
    const { stream, seen } = reader({ maxPending: 64 });
    const body = "x".repeat(5000);
    stream.push(`${ESC}[200~${body}${ESC}[201~`);
    expect(seen.join("")).toBe(`${ESC}[200~${body}${ESC}[201~`);
    expect(stream.held).toBe("");
  });

  it("no input sequence can leave bytes stranded", () => {
    // The invariant behind "shortcuts sometimes stop working": whatever is
    // pushed comes back out, in order, once the timer has run.
    const { stream, seen, tick } = reader({ maxPending: 48 });
    const chunks = [
      "ls",
      `${ESC}[98;`,
      "5u",
      ESC,
      "[",
      "A",
      `${ESC}]11;rgb:0000/0000/0000${BEL}`,
      `${ESC}[200~pasted${ESC}[201~`,
      `${ESC}O`,
    ];
    for (const chunk of chunks) stream.push(chunk);
    tick();
    expect(seen.join("")).toBe(chunks.join(""));
    expect(stream.held).toBe("");
  });
});

describe("what counts as an unfinished sequence", () => {
  const complete = [
    `${ESC}[A`,
    `${ESC}[113;5u`,
    `${ESC}[200~`,
    `${ESC}OA`,
    `${ESC}a`, // alt+a is two bytes and complete
    `${ESC}]11;rgb:1/2/3${BEL}`,
    `${ESC}]52;c;xyz${ESC}\\`, // ST-terminated
    `${ESC}[<0;10;5M`, // an SGR mouse report
  ];
  const partial = [ESC, `${ESC}[`, `${ESC}[113`, `${ESC}[113;5`, `${ESC}O`, `${ESC}]11;rgb:`];

  it("recognises finished sequences", () => {
    for (const bytes of complete) {
      expect(trailingPartialAt(bytes), JSON.stringify(bytes)).toBe(bytes.length);
    }
  });

  it("recognises unfinished ones", () => {
    for (const bytes of partial) {
      expect(trailingPartialAt(bytes), JSON.stringify(bytes)).toBe(0);
    }
  });

  it("treats MALFORMED bytes as finished rather than waiting on them", () => {
    // A reader that waits for a sequence which can never arrive is the wedge.
    // 0x07 is neither a parameter nor a final byte, so this CSI is over.
    const malformed = `${ESC}[12${BEL}`;
    expect(trailingPartialAt(malformed)).toBe(malformed.length);
  });

  it("only ever holds the LAST sequence in a chunk", () => {
    const buffer = `${ESC}[A${ESC}[B${ESC}[9`;
    expect(trailingPartialAt(buffer)).toBe(6);
  });
});
