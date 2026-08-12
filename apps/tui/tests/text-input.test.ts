import { describe, expect, it } from "vitest";
import { editText, isTextEdit } from "../src/lib/text-input.js";

// The founder's report, verbatim: "even the word-delete, line-delete etc basic
// functionalities don't work". They did not: all four text inputs handled
// exactly `backspace` and `append a character`, so the readline vocabulary
// every terminal user has in their fingers did nothing.

const NONE = {} as const;

describe("word delete", () => {
  it("deletes the last word on Ctrl+W", () => {
    expect(editText("fix the failing login test", { ctrl: true }, "w")).toBe(
      "fix the failing login "
    );
  });

  it("takes trailing whitespace with the word, like readline", () => {
    // Overshooting past a word should not leave you deleting spaces one by one.
    expect(editText("fix the login   ", { ctrl: true }, "w")).toBe("fix the ");
  });

  it("clears a single-word buffer rather than leaving a fragment", () => {
    expect(editText("login", { ctrl: true }, "w")).toBe("");
  });

  it("also answers to Alt+Backspace, which is the macOS habit", () => {
    expect(editText("fix the login", { meta: true, backspace: true }, "")).toBe(
      "fix the "
    );
  });
});

describe("line delete", () => {
  it("clears the buffer on Ctrl+U", () => {
    expect(editText("a whole mistyped path", { ctrl: true }, "u")).toBe("");
  });
});

describe("the ordinary keys still behave", () => {
  it("appends a printable character", () => {
    expect(editText("fi", NONE, "x")).toBe("fix");
  });

  it("deletes one character on backspace", () => {
    expect(editText("fix", { backspace: true }, "")).toBe("fi");
  });

  it("backspaces an empty buffer without going negative", () => {
    expect(editText("", { backspace: true }, "")).toBe("");
  });
});

describe("modifiers are not text", () => {
  it("does not type a literal 'w' while also failing to delete", () => {
    // The old code's exact bug: `input && !key.ctrl` guarded the append, but
    // nothing handled Ctrl+W, so the key was simply swallowed. Anything that
    // relaxed that guard would have typed "w" instead.
    expect(editText("hello", { ctrl: true }, "w")).not.toContain("w");
  });

  it("returns null for keys that are not edits, so callers can own them", () => {
    // Enter, Escape and navigation belong to the caller; this module must not
    // silently consume them.
    expect(editText("hello", { return: true }, "")).toBeNull();
    expect(editText("hello", NONE, "")).toBeNull();
    expect(editText("hello", { ctrl: true }, "k")).toBeNull();
  });

  it("leaves Ctrl+K alone — it opens the palette globally", () => {
    expect(editText("hello", { ctrl: true }, "k")).toBeNull();
  });
});

describe("a burst of keys in ONE stdin chunk", () => {
  // The regression this pins, which shipped green because the pure function was
  // fine and only the CALL SITES were wrong: Ink splits one stdin chunk into
  // several SYNCHRONOUS key events (`splitBackspaceBytes` exists precisely
  // because holding a key sends repeated bytes in one chunk), and React does
  // not commit between them. A call site that reads the value from its render
  // closure therefore has every event in the burst see the SAME stale value,
  // and the last write wins.
  //
  // Modelled here as "fold the burst through the reducer" — which is exactly
  // what a functional updater does, and exactly what a closure read does not.
  function burst(start: string, events: [object, string][]): string {
    return events.reduce(
      (value, [key, input]) => editText(value, key, input) ?? value,
      start
    );
  }

  const DEL = [{ backspace: true }, ""] as [object, string];

  it("deletes every character when backspace is held", () => {
    expect(burst("abcdef", [DEL, DEL, DEL])).toBe("abc");
    expect(burst("hello", [DEL, DEL, DEL, DEL, DEL])).toBe("");
  });

  it("does not lose a character typed in the same chunk", () => {
    expect(burst("", [[{}, "a"], [{}, "b"], DEL])).toBe("a");
  });

  it("does not lose the delete when a keystroke follows it", () => {
    // The corrupting case: a closure read produced "hellox" — the delete
    // silently dropped — rather than "hellx".
    expect(burst("hello", [DEL, [{}, "x"]])).toBe("hellx");
  });

  it("applies word-delete then typing in one burst", () => {
    expect(burst("fix the login", [[{ ctrl: true }, "w"], [{}, "t"]])).toBe(
      "fix the t"
    );
  });
});

describe("isTextEdit is value-independent", () => {
  // Load-bearing: call sites branch on it OUTSIDE the state updater and do the
  // edit INSIDE one. If the answer depended on the buffer, that split would be
  // wrong and the form field would drop keys.
  it("gives the same answer for any buffer", () => {
    for (const [key, input] of [
      [{ backspace: true }, ""],
      [{ ctrl: true }, "w"],
      [{ ctrl: true }, "u"],
      [{}, "a"],
      [{ return: true }, ""],
      [{ ctrl: true }, "k"],
      [{}, ""],
    ] as [object, string][]) {
      const answers = ["", "x", "a longer buffer with spaces"].map((buffer) =>
        editText(buffer, key, input) !== null
      );
      expect(new Set(answers).size, JSON.stringify([key, input])).toBe(1);
      expect(answers[0]).toBe(isTextEdit(key, input));
    }
  });
});
