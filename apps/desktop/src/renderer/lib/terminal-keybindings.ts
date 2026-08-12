/**
 * Ghostty / macOS-terminal style key → pty sequences for XTerm.
 *
 * XTerm's defaults miss several Mac edit chords (⌥⌫, ⌘⌫, ⌦, …). We map them
 * to the same control sequences readline/zsh expect, then inject via
 * `term.input()` so the existing onData → pty path stays unchanged.
 */

export type TerminalKeyChord = {
  key: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

/** Pure mapper — returns the bytes to send, or null to let XTerm handle it. */
export function resolveTerminalKeySequence(
  event: TerminalKeyChord
): string | null {
  const key = event.key;
  const alt = Boolean(event.altKey);
  const meta = Boolean(event.metaKey);
  const ctrl = Boolean(event.ctrlKey);
  const shift = Boolean(event.shiftKey);

  // Ignore bare modifier presses.
  if (
    key === "Meta" ||
    key === "Control" ||
    key === "Alt" ||
    key === "Shift" ||
    key === "CapsLock"
  ) {
    return null;
  }

  // Forward Delete (Mac Fn+Delete / dedicated Del).
  if (key === "Delete" && !alt && !meta && !ctrl) {
    return "\x1b[3~";
  }

  // ⌥⌫ / Alt+Backspace → backward-kill-word (readline unix-word-rubout).
  if (key === "Backspace" && alt && !meta && !ctrl) {
    return "\x17";
  }

  // ⌥⌦ / Alt+Delete → kill-word forward (meta-d).
  if (key === "Delete" && alt && !meta && !ctrl) {
    return "\x1bd";
  }

  // ⌃Delete → kill-word forward (common on Linux / Windows terminals).
  if (key === "Delete" && ctrl && !meta && !alt) {
    return "\x1bd";
  }

  // ⌘⌫ → kill line to beginning (Ctrl+U).
  if (key === "Backspace" && meta && !alt && !ctrl) {
    return "\x15";
  }

  // ⌘⌦ → kill line to end (Ctrl+K).
  if (key === "Delete" && meta && !alt && !ctrl) {
    return "\x0b";
  }

  // ⌘← / ⌘→ → beginning / end of line (Home / End).
  if (key === "ArrowLeft" && meta && !alt && !ctrl && !shift) {
    return "\x1b[H";
  }
  if (key === "ArrowRight" && meta && !alt && !ctrl && !shift) {
    return "\x1b[F";
  }

  // ⌥← / ⌥→ → backward / forward word.
  if (key === "ArrowLeft" && alt && !meta && !ctrl && !shift) {
    return "\x1bb";
  }
  if (key === "ArrowRight" && alt && !meta && !ctrl && !shift) {
    return "\x1bf";
  }

  // ⌃← / ⌃→ → same word motions (Windows / Linux habit).
  if (key === "ArrowLeft" && ctrl && !meta && !alt && !shift) {
    return "\x1bb";
  }
  if (key === "ArrowRight" && ctrl && !meta && !alt && !shift) {
    return "\x1bf";
  }

  return null;
}
