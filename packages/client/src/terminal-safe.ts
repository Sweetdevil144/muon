/**
 * TERMINAL SAFETY for AGENT-AUTHORED text — the ONE implementation.
 *
 * Peer-message subjects/bodies/refs, claim paths, lane names and binding reasons
 * are written by another agent and are only LENGTH-bounded by the protocol. They
 * may therefore carry ANSI escapes, a bare CR, C1 command bytes, or a bidi
 * override — enough to repaint or reorder the very "UNTRUSTED agent-authored
 * text" header that is supposed to frame them. Framing has to survive its own
 * contents, so agent-authored text is flattened to printable, single-line text
 * before it reaches a terminal.
 *
 * SCOPE, stated honestly because the earlier wording ("EVERY agent-authored
 * field is flattened … before it reaches a terminal") was an absolute this
 * module cannot enforce and an adversarial review disproved with five live
 * counterexamples. This module is the ONE implementation; it cannot make
 * itself be CALLED. A renderer that interpolates an agent-authored string
 * without it is unprotected, and nothing here detects that. The known call
 * sites were swept on 2026-08-08 (approval projection + overlay, task-detail
 * overlay, handoffs panel, `muon report`), but "every surface" is a claim a
 * grep makes, not a guarantee this file provides.
 *
 * WHY IT LIVES HERE. This sanitizer used to exist twice — once in
 * `apps/cli/src/commands/crew.ts` and once in `apps/tui/src/lib/crew-view.ts` —
 * with a comment on each copy asking the other not to drift. Two copies of a
 * security control is exactly the producer/validator drift this repo has been
 * bitten by before, and the weaker copy always wins in the end. One
 * implementation, imported by both surfaces, cannot drift.
 *
 * The character class is deliberately WIDE and must never be narrowed. It is
 * NOT restated here as a list, because a hand-maintained list beside a regex
 * is a second statement of the same thing and it went stale within a day:
 * `DANGEROUS_RANGES` in `@muon/protocol`'s `evasion-corpus.ts` is the ONE
 * statement, this module's two regexes are generated from it, and
 * `terminal-safe.test.ts` walks every range in both directions so the two
 * cannot drift or be quietly narrowed at an edge.
 *
 * It covers C0/DEL/C1, the bidi controls INCLUDING U+061C, the invisible
 * format characters (soft hyphen, zero-width run, word joiner, BOM, the
 * Hangul/Mongolian fillers), U+2028/U+2029 — and the ASTRAL Tags block
 * U+E0000..U+E007F.
 *
 * The class grew twice under the round-3 #8 corpus, and the second time is
 * the instructive one. First: `AP<WJ>PRO<WJ>VE` rendered as "APPROVE" while
 * defeating every substring check. Then an adversarial review pointed out
 * the class had been built to the CORPUS rather than to the THREAT — U+FEFF,
 * U+2028, U+061C and the whole Tags block sailed through, and the detector
 * could not even express an astral code point. Tags is the sharpest of them:
 * U+E0041 carries a capital "A" that is invisible to the human reading the
 * frame and plain ASCII to the next model that tokenizes it.
 *
 * THE COST, measured rather than assumed: a stripped run becomes a SPACE, so
 * `U+200D` splits a family emoji into its parts and `U+200C` inserts a
 * spurious visible break inside a Persian word (it does not join words — an
 * earlier revision of this comment claimed that, and it was backwards).
 * Accepted: these are short agent-authored labels rendered beside a trusted
 * frame, the degradation is cosmetic, and the alternative is an invisible
 * channel into the one place a human reads MUON's own claims.
 *
 * Pure and browser-safe (no node built-ins): the same flattening is correct for
 * a terminal, and harmless anywhere else.
 */

/**
 * C0 + DEL + C1 (which is where ESC, CR and the terminal's own command
 * vocabulary live) plus the bidi overrides that can visually reorder a line.
 *
 * A global regex is safe to share at module scope here: `String.replace` starts
 * at index 0 and resets `lastIndex`, so there is no cross-call state.
 */
export const TERMINAL_UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]+/gu;

/**
 * Placeholder for text that is entirely unsafe. An empty string would let a
 * hostile body silently collapse a labelled row into blank space; a visible
 * marker keeps the frame intact and the omission honest.
 */
export const NO_PRINTABLE_TEXT = "(no printable text)";

/** Flatten agent-authored text to printable, single-line, terminal-safe text. */
export function terminalSafe(text: string): string {
  return text.replace(TERMINAL_UNSAFE, " ").trim() || NO_PRINTABLE_TEXT;
}

/**
 * Same character class MINUS newline and tab: agent OUTPUT bodies (stream
 * chunks, chat turns) are legitimately multi-line, and flattening them would
 * destroy the very readability the pane exists for. ESC/CSI/C1, a bare CR,
 * and the bidi overrides are still stripped — an escape cannot repaint and a
 * CR cannot overwrite — while paragraphs stay paragraphs.
 */
export const TERMINAL_UNSAFE_BLOCK =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]+/gu;

/** Multi-line-preserving sanitizer for agent-authored BODIES. */
export function terminalSafeBlock(text: string): string {
  return text.replace(TERMINAL_UNSAFE_BLOCK, " ");
}

/**
 * Sanitize a CAPTURED TERMINAL SCREEN — not prose.
 *
 * `terminalSafeBlock` is for agent-authored BODIES: it strips the ESC byte
 * and keeps the rest, which is right for a paragraph and catastrophic for a
 * screen. A captured screen is full of `ESC[38;5;141m`; removing only the ESC
 * leaves `[38;5;141m` as VISIBLE TEXT, and a restored session renders as a
 * wall of colour codes. That is exactly what the founder saw.
 *
 * What a screen needs instead:
 *
 *  - KEEP well-formed SGR (`ESC[...m`). Colour is the point of restoring a
 *    screen, and SGR cannot move a cursor, arm a mode, or repaint anything
 *    outside the run it opens.
 *  - DROP every other escape sequence WHOLE — introducer and parameters
 *    together — so nothing is left behind as text. Cursor moves, mode sets
 *    (`?1049h`, `?1002h`), OSC, DCS and the rest.
 *  - DROP bare control bytes, keeping newline and tab's expansion.
 *
 * The result is renderable, coloured, and carries no authority over the
 * host's terminal.
 */
export function terminalSafeScreen(text: string): string {
  const esc = String.fromCodePoint(0x1b);
  let out = "";
  let index = 0;
  while (index < text.length) {
    // CODE POINT, not code unit. Walking by index splits an astral character
    // into surrogates, so the tag block (U+E0000–U+E007F) never matched and
    // the smuggled-tag corpus payload walked straight through. `codePointAt`
    // plus a width-aware step is the whole fix.
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    if (char !== esc) {
      // Printable, plus newline. Everything else in C0/C1 is dropped.
      const printable =
        char === "\n" ||
        (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f));
      // Zero-width spaces, joiners and the bidi overrides are PRINTABLE by
      // code point and are the evasion corpus's whole payload, so they are
      // dropped here — while walking the text, never as a final pass.
      if (printable && !isInvisible(char)) out += char;
      index += char.length;
      continue;
    }
    // An escape: consume the WHOLE sequence, and keep it only if it is SGR.
    const rest = text.slice(index);
    const sgr = /^\u001b\[[0-9;:]*m/.exec(rest);
    if (sgr) {
      out += sgr[0];
      index += sgr[0].length;
      continue;
    }
    // Any other CSI — cursor motion, mode set/reset — dropped entirely.
    const csi = /^\u001b\[[0-9;:?<>!]*[ -\/]*[@-~]/.exec(rest);
    if (csi) {
      index += csi[0].length;
      continue;
    }
    // OSC / DCS / APC / PM run to a terminator; drop through it.
    const stringy = /^\u001b[\]PX^_][\s\S]*?(?:\u001b\\|\u0007)/.exec(rest);
    if (stringy) {
      index += stringy[0].length;
      continue;
    }
    // A lone ESC, or a two-byte escape: drop the ESC and its selector.
    index += rest.length > 1 ? 2 : 1;
  }
  return out;
}

/**
 * The invisible/bidi class, as a per-CHARACTER test.
 *
 * It cannot be applied as a final `replace` over the result: that class
 * includes ESC itself, so it would strip the very SGR introducers the screen
 * sanitizer just took care to keep, and the colour codes would reappear as
 * text. It has to be checked while walking the TEXT, before an escape is ever
 * reached — which is what the loop above does.
 */
function isInvisible(char: string): boolean {
  // BY CODE POINT, not by regex class: the tag block (U+E0000–U+E007F) is
  // astral, and a class that mixes BMP ranges with an astral range is easy to
  // get subtly wrong — it was, and the smuggled-tag corpus payload walked
  // straight through. Numbers do not have that failure mode.
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0xe0000 && code <= 0xe007f) return true;
  return (
    code === 0x00ad ||
    code === 0x061c ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0x3164 ||
    code === 0xfeff ||
    (code >= 0xfff9 && code <= 0xfffb)
  );
}
