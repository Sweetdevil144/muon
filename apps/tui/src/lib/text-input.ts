/**
 * The readline edits every terminal user already has in their fingers.
 *
 * The TUI had four separate text inputs — the command bar, the palette query,
 * and two form fields — and each one implemented exactly two behaviours:
 * append a character, or drop the last one. Ctrl+W, Ctrl+U and Alt+Backspace
 * did nothing at all, so correcting a mistyped path meant holding backspace.
 * That is the single most-used editing vocabulary in a terminal, and its
 * absence is why the input felt broken rather than merely sparse.
 *
 * Pure and renderer-agnostic on purpose. It takes the current value and the
 * key event and returns the next value, so every input site shares one
 * implementation — and so this survives a change of rendering layer, which is
 * live question for this surface.
 *
 * DELIBERATELY NOT HERE: Ctrl+A / Ctrl+E / arrow-key cursor movement. Those
 * need a cursor POSITION, and every input in this app stores a bare string
 * with an implicit cursor at the end. Adding them means changing that state
 * shape at four call sites, which is a bigger change than this one and should
 * not ride along inside it. Ctrl+K is also absent, and additionally reserved:
 * it opens the palette globally.
 */

export type TextInputKey = {
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly return?: boolean;
};

/** Everything up to and including the last run of non-space characters. */
function deleteWordBefore(value: string): string {
  // Trailing whitespace goes with the word, so `foo bar   ` + Ctrl+W leaves
  // `foo ` rather than stopping on the spaces — which is what readline does
  // and what a user expects when they overshoot.
  const trimmed = value.replace(/\s+$/, "");
  const lastBoundary = trimmed.lastIndexOf(" ");
  return lastBoundary === -1 ? "" : trimmed.slice(0, lastBoundary + 1);
}

/**
 * Apply one key to a text buffer.
 *
 * Returns the next value, or `null` when this key is not a text edit at all —
 * so a caller can fall through to its own handling (Enter, Escape, navigation)
 * without this module having to know what those mean.
 */
export function editText(
  value: string,
  key: TextInputKey,
  input: string
): string | null {
  // Word delete: Ctrl+W, and Alt/Meta+Backspace, which is the macOS habit.
  if ((key.ctrl && input === "w") || (key.meta && key.backspace)) {
    return deleteWordBefore(value);
  }
  // Line delete: Ctrl+U clears to the start of the line.
  if (key.ctrl && input === "u") {
    return "";
  }
  if (key.backspace || key.delete) {
    return value.slice(0, -1);
  }
  // A plain character. Modifier-bearing keys are NOT text — letting them
  // through is how `Ctrl+W` used to type a literal "w" into the buffer while
  // also failing to delete anything.
  if (input && !key.ctrl && !key.meta && !key.return) {
    return value + input;
  }
  return null;
}

/**
 * Is this key an edit at all?
 *
 * Value-INDEPENDENT by construction: `editText` decides `null` purely from the
 * key and the input string, never from the buffer. That is what lets a caller
 * branch on "did this key belong to the text field?" while still doing the
 * actual edit inside a FUNCTIONAL state updater — which it must, because Ink
 * delivers several key events synchronously per stdin chunk and a closure read
 * makes them all see the same stale value.
 *
 * Reading `handled` out of an updater callback instead would be the same class
 * of bug one level up: React may defer or repeat that call, so the flag is not
 * readable at the branch point.
 */
export function isTextEdit(key: TextInputKey, input: string): boolean {
  return editText("", key, input) !== null;
}
