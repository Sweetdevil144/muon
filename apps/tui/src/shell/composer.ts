import { terminalSafe, terminalSafeScreen } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import type { ActionForm } from "../lib/actions.js";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * The composer — the desk's way to START work, not merely watch it.
 *
 * Until this existed the shell desk could attach to a running agent, answer
 * its gates and read memory, but there was no way to tell MUON to do
 * anything. That is not a missing feature; it is the difference between a
 * terminal with governance bolted on and MUON's desk.
 *
 * IT DRIVES THE SHARED FORMS, NOT A PARALLEL PATH. `buildActionForm` and
 * `executeAction` (`lib/actions.ts`) are what the classic desk submits
 * through — same validation, same governed client calls, same error strings.
 * A second implementation here would be a second dialect of a governed write,
 * which is the drift this repo has already paid for four times.
 *
 * Editing is deliberately plain: one field at a time, printable characters
 * and backspace. A terminal composer that reimplements readline is a bug
 * farm, and the fields it collects are short.
 */

/**
 * WHICH command, then WHICH values.
 *
 * `ctrl+b a` used to hard-code `task-new`, so the composer could create a task
 * and nothing else — while `executeAction` already knew how to assign, set a
 * status and dispatch a run. Those were reachable from the classic desk and
 * from nowhere on this one.
 *
 * The picker lists `EXECUTABLE_ACTIONS`, NOT every form `buildActionForm` can
 * build. A form the desk can render but not run would take a human's input and
 * then answer "unknown action" — the advertised-but-inert defect with a wasted
 * keystroke on top.
 */
/**
 * TWO PHASES, and the type says which one you are in.
 *
 * It was one shape with a nullable `choices`, which meant the CHOOSING phase
 * still had to carry an `ActionForm` and a values map it had no use for — so
 * the desk built an arbitrary first form purely to open a picker, and one
 * `cursor` field meant "which command" or "which field" depending on state
 * nothing checked. An adversarial review called it phase-invalid data, which
 * is exactly right.
 *
 * A discriminated union instead: `choosing` has commands, `editing` has a
 * form. The shared fields are the ones both phases genuinely have — a cursor,
 * a busy flag and the last result.
 */
export type ComposerState = {
  readonly cursor: number;
  /** Set while the governed call is in flight — a second Enter must not resend. */
  readonly busy: boolean;
  /** The last result, kept on screen so a failure is not silently swallowed. */
  readonly result: { ok: boolean; message: string } | null;
} & (
  | {
      readonly phase: "choosing";
      readonly choices: readonly { id: string; label: string }[];
    }
  | {
      readonly phase: "editing";
      readonly form: ActionForm;
      readonly values: Record<string, string>;
    }
);

export function openComposer(form: ActionForm): ComposerState {
  const values: Record<string, string> = {};
  for (const field of form.fields) values[field.id] = field.prefill ?? "";
  return { phase: "editing", form, values, cursor: 0, busy: false, result: null };
}

/**
 * Open on the CHOICE of command. No form is constructed — the picker has
 * nothing to do with one, which is the whole reason the phases are separate.
 */
export function openComposerPicker(
  choices: readonly { id: string; label: string }[]
): ComposerState {
  return { phase: "choosing", choices, cursor: 0, busy: false, result: null };
}

/** The command a picker cursor is pointing at, or null when it is not a picker. */
export function composerChoice(state: ComposerState): string | null {
  return state.phase === "choosing"
    ? (state.choices[state.cursor]?.id ?? null)
    : null;
}

/** Apply one keystroke to the focused field. Pure. */
export function composerType(
  state: ComposerState,
  data: string
): ComposerState {
  // Typing is meaningless while choosing, and the type now says so rather than
  // leaving it to a runtime guard nobody has to remember.
  if (state.phase !== "editing") return state;
  const field = state.form.fields[state.cursor];
  if (!field) return state;
  const current = state.values[field.id] ?? "";
  // Backspace arrives as DEL (0x7f) from most terminals and BS (0x08) from
  // some; both mean the same thing to a human.
  if (data === String.fromCodePoint(0x7f) || data === String.fromCodePoint(8)) {
    return {
      ...state,
      values: { ...state.values, [field.id]: current.slice(0, -1) },
    };
  }
  // WHOLE SEQUENCES, then SGR TOO. `terminalSafeScreen` is a SCREEN
  // sanitizer: it deliberately KEEPS well-formed SGR, because colour is the
  // point of restoring a screen. A task title is not a screen — pasting
  // coloured text left `[31mRED[0m` in the field and sent it to the brain.
  // Strip the sequences first, then any SGR the screen sanitizer preserved,
  // then anything still non-printable.
  const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;:]*m`, "g");
  const cleaned = terminalSafeScreen(data)
    .replace(csi, "")
    .replaceAll("\n", "");
  const printable = [...cleaned].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    // The private-use block is invisible: it can carry a directive a human
    // cannot see in a field they are about to submit.
    if (code >= 0xe000 && code <= 0xf8ff) return false;
    return code >= 0x20 && code !== 0x7f;
  });
  if (printable.length === 0) return state;
  return {
    ...state,
    values: { ...state.values, [field.id]: current + printable.join("") },
  };
}

export function composerMove(state: ComposerState, delta: number): ComposerState {
  // The cursor means a CHOICE while picking and a FIELD once picked, so it is
  // clamped against whichever list is live. Clamping against the form's fields
  // in both phases would have let the picker's cursor sit past its last
  // command on any form with fewer fields than there are commands.
  const last =
    state.phase === "choosing"
      ? state.choices.length - 1
      : state.form.fields.length - 1;
  return {
    ...state,
    cursor: Math.min(Math.max(0, last), Math.max(0, state.cursor + delta)),
  };
}

export class Composer implements Component {
  private state: ComposerState;

  constructor(state: ComposerState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.state.phase === "choosing") {
      const lines: string[] = [bold(" What should MUON do?"), ""];
      this.state.choices.forEach((choice, index) => {
        const active = index === this.state.cursor;
        const label = terminalSafe(choice.label);
        lines.push(` ${active ? cyan("›") : " "} ${active ? bold(label) : label}`);
      });
      lines.push("", dim(" ⏎ choose · esc close"));
      return lines;
    }

    // Bound locally: narrowing on `this.state` does not survive into a
    // closure, and the alternative is a cast that would defeat the point of
    // splitting the phases.
    const editing = this.state;
    const lines: string[] = [
      bold(` ${terminalSafe(editing.form.title)}`),
      "",
    ];

    editing.form.fields.forEach((field, index) => {
      const active = index === editing.cursor;
      const marker = active ? cyan("›") : " ";
      const label = terminalSafe(field.label);
      const value = terminalSafe(editing.values[field.id] ?? "");
      const shown = active ? `${value}${cyan("▌")}` : value || dim("—");
      lines.push(
        ` ${marker} ${active ? bold(label) : dim(label)}${
          field.required ? red("*") : ""
        }`
      );
      lines.push(`     ${shown}`);
    });

    lines.push("");
    if (this.state.busy) {
      lines.push(dim(" submitting…"));
    } else if (this.state.result) {
      // A governed write's OUTCOME stays on screen. A form that clears itself
      // on failure tells the human it worked.
      lines.push(
        this.state.result.ok
          ? green(` ✓ ${terminalSafe(this.state.result.message)}`)
          : red(` ✗ ${terminalSafe(this.state.result.message)}`)
      );
    } else {
      lines.push(
        dim(" ↑/↓ field · type to edit · ⏎ submit · esc cancel"),
        yellow(" this creates real work in the brain")
      );
    }

    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
