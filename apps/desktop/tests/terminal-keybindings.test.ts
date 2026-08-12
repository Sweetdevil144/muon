import { describe, expect, it } from "vitest";
import { resolveTerminalKeySequence } from "../src/renderer/lib/terminal-keybindings.js";

describe("resolveTerminalKeySequence", () => {
  it("maps forward delete and Mac edit chords to readline sequences", () => {
    expect(resolveTerminalKeySequence({ key: "Delete" })).toBe("\x1b[3~");
    expect(
      resolveTerminalKeySequence({ key: "Backspace", altKey: true })
    ).toBe("\x17");
    expect(resolveTerminalKeySequence({ key: "Delete", altKey: true })).toBe(
      "\x1bd"
    );
    expect(resolveTerminalKeySequence({ key: "Delete", ctrlKey: true })).toBe(
      "\x1bd"
    );
    expect(
      resolveTerminalKeySequence({ key: "Backspace", metaKey: true })
    ).toBe("\x15");
    expect(resolveTerminalKeySequence({ key: "Delete", metaKey: true })).toBe(
      "\x0b"
    );
  });

  it("maps word and line navigation chords", () => {
    expect(
      resolveTerminalKeySequence({ key: "ArrowLeft", metaKey: true })
    ).toBe("\x1b[H");
    expect(
      resolveTerminalKeySequence({ key: "ArrowRight", metaKey: true })
    ).toBe("\x1b[F");
    expect(resolveTerminalKeySequence({ key: "ArrowLeft", altKey: true })).toBe(
      "\x1bb"
    );
    expect(
      resolveTerminalKeySequence({ key: "ArrowRight", altKey: true })
    ).toBe("\x1bf");
    expect(
      resolveTerminalKeySequence({ key: "ArrowLeft", ctrlKey: true })
    ).toBe("\x1bb");
  });

  it("leaves ordinary keys to XTerm", () => {
    expect(resolveTerminalKeySequence({ key: "a" })).toBeNull();
    expect(resolveTerminalKeySequence({ key: "Backspace" })).toBeNull();
    expect(resolveTerminalKeySequence({ key: "Meta" })).toBeNull();
  });
});
