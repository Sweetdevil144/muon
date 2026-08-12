import { describe, expect, it } from "vitest";
import {
  DANGEROUS_RANGES,
  EVASION_CORPUS,
  isDangerousCodePoint,
  residualDanger,
} from "@muon/protocol";
import {
  NO_PRINTABLE_TEXT,
  TERMINAL_UNSAFE,
  terminalSafe,
  terminalSafeBlock,
} from "../src/terminal-safe.js";

/**
 * The ONE sanitizer for agent-authored text, lifted out of the CLI and the TUI
 * (which each carried a byte-identical private copy). These cases are the union
 * of both surfaces' original suites, so neither loses coverage in the move, plus
 * the properties that must hold for a security control shared by two callers.
 */

// Built from char codes rather than escape literals so the intent survives any
// source-level escaping: these ARE the raw bytes an attacker sends.
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const CSI_8BIT = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

describe("terminalSafe (agent-authored text never reaches the terminal raw)", () => {
  it("strips ANSI, CR, newlines and bidi overrides so the untrusted frame survives", () => {
    // The attack the framing exists to survive: erase-line + CR repaints the
    // "UNTRUSTED agent-authored text" header this body is printed under.
    expect(terminalSafe(`${ESC}[2K${CR}SAFE: approved by the operator`)).toBe(
      "[2K SAFE: approved by the operator"
    );
    expect(terminalSafe(`a${RLO}b`)).toBe("a b");
    expect(terminalSafe(`first${LF}second`)).toBe("first second");
    expect(terminalSafe(`del${DEL}ete`)).toBe("del ete");
  });

  it("covers the whole C0 block, DEL, C1 and the bidi isolates", () => {
    expect(terminalSafe(`a${NUL}b`)).toBe("a b");
    expect(terminalSafe(`a${BEL}b`)).toBe("a b");
    // 8-bit CSI lives in C1; a sanitizer that only knew ESC would miss it.
    expect(terminalSafe(`a${CSI_8BIT}2Kb`)).toBe("a 2Kb");
    expect(terminalSafe(`${LRI}path${PDI}`)).toBe("path");
  });

  it("collapses a run of unsafe characters to a single space", () => {
    expect(terminalSafe(`a${ESC}${ESC}${CR}${LF}b`)).toBe("a b");
  });

  it("never returns empty: all-unsafe text becomes a visible marker", () => {
    // An empty string would let a hostile body silently collapse its labelled
    // row into blank space; the marker keeps the omission honest.
    expect(terminalSafe(`${ESC}${ESC}${CR}${LF}`)).toBe(NO_PRINTABLE_TEXT);
    expect(terminalSafe("   ")).toBe(NO_PRINTABLE_TEXT);
    expect(terminalSafe("")).toBe(NO_PRINTABLE_TEXT);
  });

  it("leaves ordinary printable text (including non-ASCII) untouched", () => {
    expect(terminalSafe("packages/core/src/gate.ts")).toBe(
      "packages/core/src/gate.ts"
    );
    expect(terminalSafe("café — 日本語")).toBe("café — 日本語");
  });

  it("is idempotent and stateless across calls (a shared /g regex must not carry lastIndex)", () => {
    const hostile = `${ESC}[31mred${CR}`;
    const once = terminalSafe(hostile);
    expect(terminalSafe(once)).toBe(once);
    // Same input, repeated: a leaked `lastIndex` would make call 2 differ.
    for (let i = 0; i < 5; i += 1) {
      expect(terminalSafe(hostile)).toBe(once);
    }
    expect(TERMINAL_UNSAFE.lastIndex).toBe(0);
  });

  it("keeps the character class WIDE — the control ranges are not negotiable", () => {
    for (let code = 0x00; code <= 0x1f; code += 1) {
      expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toBe("a b");
    }
    for (let code = 0x7f; code <= 0x9f; code += 1) {
      expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toBe("a b");
    }
    for (let code = 0x202a; code <= 0x202e; code += 1) {
      expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toBe("a b");
    }
    for (let code = 0x2066; code <= 0x2069; code += 1) {
      expect(terminalSafe(`a${String.fromCharCode(code)}b`)).toBe("a b");
    }
  });
});

// ── Round-3 #8: the shared evasion corpus, replayed against this sanitizer ──
//
// The corpus lives in @muon/protocol so every untrusted-text surface replays
// the SAME payloads. Its first run against this module found a real gap: the
// class covered C0/C1/bidi but not the invisible format characters, so a
// zero-width directive, a word-joiner keyword split and a soft-hyphen split
// all survived. These tests are what keep that closed.

describe("evasion corpus replay", () => {
  it("terminalSafe leaves NOTHING dangerous, for every payload", () => {
    for (const payload of EVASION_CORPUS) {
      expect(
        residualDanger(terminalSafe(payload.text)),
        `${payload.id} survived terminalSafe`
      ).toEqual([]);
    }
  });

  it("terminalSafeBlock leaves nothing dangerous EXCEPT the newline/tab it documents", () => {
    for (const payload of EVASION_CORPUS) {
      expect(
        residualDanger(terminalSafeBlock(payload.text), ["\n", "\t"]),
        `${payload.id} survived terminalSafeBlock`
      ).toEqual([]);
    }
  });

  it("a row-forgery payload cannot forge a row through the single-line sanitizer", () => {
    const forgery = EVASION_CORPUS.find(
      (payload) => payload.id === "newline-row-forgery"
    )!;
    expect(terminalSafe(forgery.text)).not.toContain("\n");
    // The body sanitizer KEEPS the newline by design — which is exactly why a
    // line-oriented surface must use terminalSafe (or re-indent), and why the
    // CLI question renderer does.
    expect(terminalSafeBlock(forgery.text)).toContain("\n");
  });

  it("drift-lock: the two classes agree in BOTH directions, at every edge", () => {
    // Was `for (code = 0; code <= 0x2100)` — a bound that would have left the
    // ASTRAL Tags fix silently unverified by the very test written to prevent
    // this drift. It now walks the SHARED ranges themselves, so a range added
    // anywhere (BMP or astral) is covered the moment it is declared.
    for (const [low, high] of DANGEROUS_RANGES) {
      for (const code of [low, high, Math.floor((low + high) / 2)]) {
        const character = String.fromCodePoint(code);
        expect(
          terminalSafe(`a${character}b`),
          `U+${code.toString(16)} is dangerous per protocol but survives terminalSafe`
        ).not.toContain(character);
        expect(
          terminalSafeBlock(`a${character}b`),
          `U+${code.toString(16)} survives terminalSafeBlock`
        ).not.toContain(character);
      }
      // EDGE PINNING: narrowing a range keeps a midpoint test green, so the
      // character just OUTSIDE each edge is asserted to survive — which is
      // what makes a silent one-code-point narrowing fail here.
      for (const outside of [low - 1, high + 1]) {
        if (outside < 0 || outside > 0x10ffff) continue;
        if (isDangerousCodePoint(outside)) continue; // adjacent range
        if (outside >= 0xd800 && outside <= 0xdfff) continue; // lone surrogate
        const character = String.fromCodePoint(outside);
        expect(
          terminalSafeBlock(`a${character}b`),
          `U+${outside.toString(16)} is NOT dangerous but the sanitizer strips it`
        ).toContain(character);
      }
    }
  });

  it("the reverse direction: nothing the sanitizer strips is unknown to the protocol", () => {
    // The old loop only tested protocol → sanitizer, so widening the regex
    // without widening the shared ranges was uncaught. Sampling the whole
    // BMP plus the astral block closes that side.
    const probes: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) probes.push(code);
    for (let code = 0xe0000; code <= 0xe00ff; code += 1) probes.push(code);
    for (const code of probes) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates
      const character = String.fromCodePoint(code);
      const stripped = !terminalSafeBlock(`a${character}b`).includes(character);
      if (stripped) {
        expect(
          isDangerousCodePoint(code),
          `sanitizer strips U+${code.toString(16)} but the protocol does not call it dangerous`
        ).toBe(true);
      }
    }
  });
});
