/**
 * NORMALIZE WHAT THE HOST TERMINAL SENDS.
 *
 * This file exists because of a P0 that a pre-merge review found in the
 * founder's own terminal, and it is the most expensive kind of bug: every
 * test was green, the compiled binary booted, and the product was unusable.
 *
 * The vendored engine asks the host for the KITTY KEYBOARD PROTOCOL at
 * startup (`terminal.ts` sends `CSI > 7 u`), and falls back to xterm's
 * modifyOtherKeys when the host answers a plain DA. Modern terminals —
 * Ghostty, kitty, WezTerm, foot — say yes. From that moment on:
 *
 *     ctrl+q   arrives as  ESC [ 113 ; 5 u      (not 0x11)
 *     ctrl+b   arrives as  ESC [ 98  ; 5 u      (not 0x02)
 *     Esc      arrives as  ESC [ 27  u          (not 0x1b)
 *     alt+b    arrives as  ESC [ 98  ; 3 u      (not ESC b)
 *
 * The router compares RAW BYTES, so none of those matched: the desk had no
 * quit, the prefix never armed, every advertised chord was dead, and the
 * undecoded sequence was written into the child pty — so pressing ctrl+q at a
 * shell prompt typed `13;5u`.
 *
 * TWO reasons to fix it HERE rather than in the router:
 *
 *  1. The child needs it too. Our emulator never negotiated kitty with the
 *     vendor CLI, so the CLI expects legacy bytes. Forwarding CSI-u to it is
 *     how `13;5u` reached the prompt. Normalizing before the router means the
 *     child gets what it understands, for free.
 *  2. The router stays a pure byte-matcher, which is what makes its ~150
 *     routing tests meaningful. Encoding is a transport concern; routing is a
 *     product concern. They should not be the same function.
 *
 * Everything not recognised passes through untouched. This translates; it
 * never filters.
 */

import { firstKeystrokeLength } from "./key-stream.js";

const ESC = String.fromCodePoint(0x1b);

/**
 * EVERY PATTERN BELOW IS BUILT FROM `ESC`, never written with the byte.
 *
 * Two of them used to carry a RAW 0x1b in the source. It is invisible in an
 * editor and in a diff, so a new pattern written by copying the visible part
 * of a neighbouring one silently lacked it and matched nothing — which is
 * precisely how the arrow fix below shipped inert the first time. A control
 * byte nobody can see is a control byte nobody can review.
 */

/** Kitty CSI-u: `ESC [ <code> [; <modifiers>] u`. */
/**
 * Kitty CSI-u, in full: `CSI code[:shifted[:base]] ; mods[:event] [; text] u`
 *
 * The narrower earlier pattern allowed only ONE alternate-key subparameter and
 * no associated-text section, and — the real defect — it captured no event
 * type, so a key RELEASE decoded to the same byte as a press. Its two siblings
 * above both drop releases; this one silently doubled them, and a press and
 * release arriving in one read turned Enter into TWO Enters, which matches
 * nothing and reports as a broken chord.
 */
const KITTY = new RegExp(
  `^${ESC}\\[(\\d+)(?::(\\d+))?(?::(\\d+))?(?:;(\\d+)(?::(\\d+))?)?(?:;[\\d:]*)?u$`
);
/** xterm modifyOtherKeys level 2: `ESC [ 27 ; <modifiers> ; <code> ~`. */
const MODIFY_OTHER = new RegExp(`^${ESC}\\[27;(\\d+);(\\d+)~$`);

/**
 * THE FORM THAT ACTUALLY BROKE THE ARROWS.
 *
 * The engine asks for `CSI > 7 u`, and bit 2 of that is REPORT EVENT TYPES. A
 * terminal that grants it can no longer send a bare `ESC [ A` for an arrow —
 * it has nowhere to put press/repeat/release — so it sends the full form with
 * an event sub-parameter:
 *
 *     up (press)    ESC [ 1 ; 1 : 1 A
 *     up (repeat)   ESC [ 1 ; 1 : 2 A
 *     PageUp        ESC [ 5 ; 1 : 1 ~
 *
 * None of that matched anything here, so it reached the child verbatim and a
 * vendor CLI saw a sequence it does not know. That is why the founder's up and
 * down arrows still did nothing after the previous fix — and why the pty probe
 * that "proved" 79 of 79 keys arrive did not catch it: the probe sent
 * `ESC [ A`, which is not what their terminal sends once the protocol is
 * negotiated. A probe is only ever as good as its premise about the input.
 *
 * `1` in the modifier field means NO modifiers, so the honest translation is
 * the bare legacy form; anything else keeps the modifier and drops the event.
 */
const CSI_LETTER = new RegExp(`^${ESC}\\[(\\d+);(\\d+)(?::(\\d+))?([A-HPQRS])$`);
const CSI_TILDE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)(?::(\\d+))?~$`);

/** Kitty event types. A RELEASE must never be translated into a press. */
const EVENT_RELEASE = "3";


/**
 * Kitty encodes modifiers as a 1-based bitmask: 1=none, and thereafter
 * bit0 shift, bit1 alt, bit2 ctrl, bit3 super.
 */
function decodeModifiers(raw: string | undefined): {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  superKey: boolean;
} {
  const mask = Math.max(0, (raw === undefined ? 1 : Number(raw)) - 1);
  return {
    shift: (mask & 1) !== 0,
    alt: (mask & 2) !== 0,
    ctrl: (mask & 4) !== 0,
    // SUPER/META IS NOT NOTHING. Ignoring bit 3 turned cmd+q into a plain `q`
    // typed into the child — a review caught it in a pty dump. There is no
    // legacy encoding for it, so it is REFUSED rather than flattened.
    superKey: (mask & 8) !== 0,
  };
}

/** The legacy bytes a terminal would have sent before the protocol upgrade. */
function toLegacy(
  code: number,
  mods: { shift: boolean; alt: boolean; ctrl: boolean; superKey: boolean }
): string | null {
  // A super/meta chord has no legacy form. Passing it through unchanged is
  // right: the raw sequence is at least visible, where flattening it typed a
  // silent `q` into a shell.
  if (mods.superKey) return null;

  // KITTY'S FUNCTIONAL-KEY BLOCK IS NOT TEXT. Codepoints 57344–57454 encode
  // numpad Enter, F13+, media keys and so on; `String.fromCodePoint` turns
  // them into INVISIBLE private-use characters, which a review found being
  // injected into a child's stdin and into a task title bound for the brain.
  // Refuse, so the raw sequence passes through and the child decides.
  if (code >= 0xe000 && code <= 0xf8ff) return null;
  // Special keys first: their legacy forms are single bytes, not letters.
  if (code === 27) return mods.alt || mods.ctrl ? null : ESC;
  if (code === 13) return "\r";
  if (code === 9) return mods.shift ? `${ESC}[Z` : "\t";
  if (code === 127 || code === 8) {
    // alt+backspace is "delete the previous WORD" in every readline; sending
    // a bare DEL deleted one character instead.
    return mods.alt ? `${ESC}${String.fromCodePoint(0x7f)}` : String.fromCodePoint(0x7f);
  }

  if (code < 32 || code > 0x10ffff) return null;

  const char = String.fromCodePoint(code);
  if (mods.ctrl) {
    const lower = char.toLowerCase();
    // ctrl+a..z → 0x01..0x1a, the mapping every CLI still expects.
    if (lower >= "a" && lower <= "z") {
      const byte = lower.charCodeAt(0) - 96;
      return mods.alt ? `${ESC}${String.fromCodePoint(byte)}` : String.fromCodePoint(byte);
    }
    // ctrl+[ ] \ ^ _ and ctrl+space have legacy forms too.
    if (code === 32) return String.fromCodePoint(0);
    if (code >= 91 && code <= 95) return String.fromCodePoint(code - 64);
    return null;
  }
  if (mods.alt) return `${ESC}${char}`;
  // A plain (or shifted) printable under the protocol: send the character.
  return mods.shift ? char.toUpperCase() : char;
}

/**
 * Translate one chunk of host input into the legacy encoding.
 *
 * Unrecognised input — plain text, arrows, mouse reports, pastes — is
 * returned unchanged. A chunk that carries several sequences at once is
 * translated piecewise, because a fast typist's keystrokes coalesce.
 */
export function normalizeKeys(data: string): string {
  // Fast path: no ESC means nothing to translate.
  if (!data.includes(ESC)) return data;

  // A key RELEASE is dropped outright. This has to be decided HERE rather than
  // inside translateOne, because null there means "unrecognised, forward it
  // unchanged" — so a release returned as null was passed through to the child
  // as raw escape bytes. With event reporting negotiated, that happened on
  // every keystroke, arrows included.
  if (isKeyRelease(data)) return "";

  // Whole-chunk match first — the common case, one keystroke.
  const whole = translateOne(data);
  if (whole !== null) return whole;

  // Otherwise walk it sequence by sequence, translating each and keeping
  // anything that does not parse.
  //
  // The walk used to cut only at the next ESC, which cannot separate a
  // sequence from TEXT that follows it: `ESC[98;5us` — a kitty ctrl+b with the
  // command key appended, the ordinary shape when two keys are typed quickly —
  // matched no pattern as a whole and was passed through untranslated. The
  // chord did nothing. Cutting at the end of each sequence handles it.
  let out = "";
  let rest = data;
  while (rest.length > 0) {
    if (rest[0] !== ESC) {
      const next = rest.indexOf(ESC);
      out += next === -1 ? rest : rest.slice(0, next);
      rest = next === -1 ? "" : rest.slice(next);
      continue;
    }
    const chunk = rest.slice(0, firstKeystrokeLength(rest));
    // A press and its release arrive in one read constantly — they are
    // microseconds apart. Keeping the release turned one Enter into two.
    if (!isKeyRelease(chunk)) out += translateOne(chunk) ?? chunk;
    rest = rest.slice(chunk.length);
  }
  return out;
}

/**
 * A key RELEASE, in any of the three reporting forms.
 *
 * Each pattern is asked for its OWN event group. They used to share index 3
 * and this read `match[3]` for whichever matched — then CSI-u grew capture
 * groups for the alternate keys, its event moved to 5, and every release
 * started decoding as a press again. A shared index that is true by
 * coincidence is a trap; the index now travels with its pattern.
 */
function isKeyRelease(chunk: string): boolean {
  const letter = CSI_LETTER.exec(chunk);
  if (letter) return letter[3] === EVENT_RELEASE;
  const tilde = CSI_TILDE.exec(chunk);
  if (tilde) return tilde[3] === EVENT_RELEASE;
  const kitty = KITTY.exec(chunk);
  return kitty?.[5] === EVENT_RELEASE;
}

function translateOne(chunk: string): string | null {
  // Navigation keys carrying an event sub-parameter, which is the shape a
  // terminal must use once it is reporting press/repeat/release.
  const letter = CSI_LETTER.exec(chunk);
  if (letter) {
    const [, first, mods, , final] = letter;
    return mods === "1" && first === "1"
      ? `${ESC}[${final}`
      : `${ESC}[${first};${mods}${final}`;
  }
  const tilde = CSI_TILDE.exec(chunk);
  if (tilde) {
    const [, number, mods] = tilde;
    return mods === "1" ? `${ESC}[${number}~` : `${ESC}[${number};${mods}~`;
  }

  const kitty = KITTY.exec(chunk);
  if (kitty) {
    const mods = decodeModifiers(kitty[4]);
    const shifted = kitty[2] === undefined ? undefined : Number(kitty[2]);
    // THE SHIFTED CHARACTER IS THE TERMINAL'S TO KNOW, NOT OURS.
    //
    // `?` is shift+`/` on a US layout and shift+`+` on a German one. The
    // protocol's first sub-parameter is the SHIFTED key for exactly this
    // reason, and MUON was discarding it and calling `toUpperCase()` on the
    // base character instead — which is right for letters and silently wrong
    // for every punctuation mark. `ctrl+b ?` arrived as `/` and `ctrl+b |`
    // arrived as `\\`, so both resolved to nothing.
    //
    // Only when shift is the ONLY modifier: `ctrl+shift+a` still means the
    // control chord on the base key, not the character `A`.
    if (mods.shift && shifted !== undefined && !mods.ctrl && !mods.alt && !mods.superKey) {
      return toLegacy(shifted, { ...mods, shift: false });
    }
    return toLegacy(Number(kitty[1]), mods);
  }
  const modify = MODIFY_OTHER.exec(chunk);
  if (modify) {
    return toLegacy(Number(modify[2]), decodeModifiers(modify[1]));
  }
  return null;
}
