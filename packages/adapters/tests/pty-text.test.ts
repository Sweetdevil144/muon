import { describe, expect, it } from "vitest";
import {
  codexSessionIdFromOutput,
  normalizePtyOutput,
  stripAnsi,
} from "../src/pty-text.js";

describe("stripAnsi", () => {
  it("removes CSI sequences whole, keeping their payload text", () => {
    expect(stripAnsi("\x1b[1mworkdir:\x1b[0m /tmp/x")).toBe("workdir: /tmp/x");
  });

  it("removes OSC sequences including their arguments", () => {
    expect(stripAnsi("\x1b]0;title\x07visible")).toBe("visible");
    expect(stripAnsi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("removes bare two-byte escapes (charset, keypad)", () => {
    expect(stripAnsi("\x1b(Btext\x1b=")).toBe("text");
  });
});

describe("normalizePtyOutput", () => {
  it("folds carriage-return overdraws to what a human last saw", () => {
    // A spinner redraws in place; only the final write is the real line.
    expect(normalizePtyOutput("⠋ thinking…\r⠙ thinking…\rdone: ok\n")).toBe(
      "done: ok\n"
    );
  });

  it("treats \\r\\n as a plain line ending, not an overdraw", () => {
    expect(normalizePtyOutput("line one\r\nline two\r\n")).toBe(
      "line one\nline two\n"
    );
  });

  it("keeps final-report anchors parseable through ANSI styling", () => {
    const raw = "\x1b[36muser\x1b[0m\r\nbrief\r\n\x1b[1mGOAL:\x1b[0m done\r\n";
    expect(normalizePtyOutput(raw)).toContain("GOAL: done");
  });

  it("drops residual control characters but keeps tabs and newlines", () => {
    expect(normalizePtyOutput("a\tb\x07c\n")).toBe("a\tbc\n");
  });
});

describe("codexSessionIdFromOutput", () => {
  it("recovers the exec banner session id through ANSI styling", () => {
    const raw =
      "\x1b[1msession id:\x1b[0m 019FA043-E5C2-7731-B2F3-11312F91D2D2\r\n";
    expect(codexSessionIdFromOutput(raw)).toBe(
      "019fa043-e5c2-7731-b2f3-11312f91d2d2"
    );
  });

  it("returns null until the banner has actually arrived", () => {
    expect(codexSessionIdFromOutput("OpenAI Codex v0.145.0\r\n")).toBeNull();
    expect(codexSessionIdFromOutput("session id: not-a-uuid\r\n")).toBeNull();
  });
});
