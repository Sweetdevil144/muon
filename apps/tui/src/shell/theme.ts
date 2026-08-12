/**
 * Shell theme — ANSI helpers for the ADR-0046 desk.
 *
 * Deliberately tiny and dependency-free: the vendored engine composes plain
 * strings, so styling is a function from text to text. Palette mirrors the
 * desktop renderer's: dim chrome, cyan focus, status colors matching the crew
 * dots (green working · yellow blocked · red failed · gray idle).
 */

// The REAL escape byte, built from a code point so this file never carries a
// raw control character in source (the evasion-corpus rule).
const CSI = `${String.fromCodePoint(0x1b)}[`;

const wrap = (open: string, close: string) => (text: string) =>
  `${CSI}${open}m${text}${CSI}${close}m`;

export const dim = wrap("2", "22");
export const bold = wrap("1", "22");
export const cyan = wrap("36", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const red = wrap("31", "39");
export const gray = wrap("90", "39");
export const inverse = wrap("7", "27");

/** The same attention vocabulary the desktop's crew dots use. */
export function statusColor(status: string): (text: string) => string {
  switch (status) {
    case "working":
      return green;
    case "blocked":
      return yellow;
    case "failed":
    case "error":
      return red;
    default:
      return gray;
  }
}

export const STATUS_DOT = "●";
export const STATUS_DOT_IDLE = "○";

export function statusDot(status: string): string {
  const glyph =
    status === "idle" || status === "unknown" ? STATUS_DOT_IDLE : STATUS_DOT;
  return statusColor(status)(glyph);
}
