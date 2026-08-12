import { KEYMAP, type KeymapEntry } from "./keymap.js";
import type { FocusZone } from "./layout.js";

/**
 * ADR-0042 D2 — the keymap table DISPATCHES, in scopes that fall through by
 * construction.
 *
 * The defect this exists to end: `App.tsx` handled input as one long cascade
 * of `if (mode) { …; return; }` blocks, so every mode was a black hole for
 * every key it did not personally name. Pressing `/` entered the command bar,
 * which returned without checking Tab, and panel cycling silently died until
 * Escape — with the single `key.tab` handler sitting unreachable a thousand
 * lines below.
 *
 * `keymap.ts` was supposed to have prevented that. Its docstring said "It
 * drives dispatch for the cockpit mode"; `App.tsx` never imported it. The
 * table drove the help overlay and the README and nothing else, so it was a
 * second description of the bindings rather than their source — which is
 * exactly the drift the Tab bug is an instance of.
 *
 * The model here is a SCOPE CHAIN. A mode declares which scope it is in; a key
 * is resolved against that scope and then against its ancestors. Nothing has
 * to remember to re-check a parent binding, because falling through is the
 * default rather than an act. That is the property, and it is why this cannot
 * regress the same way: making Tab work inside the command bar is a table
 * entry, not a line someone must not forget.
 */

/**
 * Where a key is being pressed. `cockpit` is the root — the desk with no modal
 * surface open — and everything else narrows it.
 */
export type KeyScope =
  | "cockpit"
  | "command-bar"
  | "palette"
  | "help"
  | "form"
  /** The approval review is open: the human is looking at the evidence and
   *  the NEXT press decides. Its own scope so a decision key cannot fire
   *  from the cockpit, and so the cockpit's movement keys cannot scroll the
   *  list out from under a decision bound to the approval on screen. */
  | "approval"
  /** Memory search results are on screen. Its own scope because the cockpit's
   *  `a`/`r` mean approve/reject, and a stray press over a note list must not
   *  reach a governed decision — the same reason `approval` is separate. */
  | "memory";

/**
 * Bindings a modal scope keeps from its parent.
 *
 * POSITIVE, and deliberately so (ADR-0022 rule 2): a scope lists what it
 * inherits rather than what it blocks, so a binding added to the cockpit
 * tomorrow does not silently start firing inside a text field where it would
 * be a character the user meant to type. `j` must stay a letter in the command
 * bar; `tab` must not.
 */
const INHERITED: Record<KeyScope, readonly string[]> = {
  cockpit: [],
  // Navigation only. Anything printable belongs to the text buffer.
  "command-bar": ["cycle-zone"],
  palette: ["cycle-zone"],
  help: ["cycle-zone"],
  form: [],
  // Navigation only. `a`/`r`/`A` are DECIDED here, not inherited — the
  // cockpit entries for them are the FIRST press (open the evidence), and
  // letting them fall through would collapse the two-press rule ADR-0032 D5
  // exists for.
  approval: ["cycle-zone"],
  // Navigation, plus the catalogue. The memory pane's own keys (esc, ↑/↓, e)
  // are handled by the desk; nothing from the cockpit that DECIDES anything is
  // inherited. `/` IS inherited — a results pane that cannot reach the command
  // surface is a dead end, and the pane is a read, not a decision.
  memory: ["cycle-zone", "palette", "focus-command"],
};

/** The key event shape this module needs, kept renderer-agnostic (ADR-0042). */
export type DispatchKey = {
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
};

/** Canonical spelling of one physical key press, matched against `keys`. */
export function keyToken(key: DispatchKey, input: string): string | null {
  if (key.tab) return key.shift ? "shift+tab" : "tab";
  if (key.upArrow) return "↑";
  if (key.downArrow) return "↓";
  if (key.escape) return "esc";
  if (key.return) return "enter";
  if (key.ctrl && input) return `ctrl+${input.toLowerCase()}`;
  if (key.meta) return null;
  return input || null;
}

/**
 * `1`…`9` share one entry (`tab-ordinal`), declared as `["1", "…", "9"]` — the
 * ellipsis is display, not a binding, so a literal match would miss `4`.
 */
function matchesEntry(entry: KeymapEntry, token: string): boolean {
  if (entry.id === "tab-ordinal") return /^[1-9]$/.test(token);
  return entry.keys.includes(token);
}

export type ResolvedAction = {
  readonly id: string;
  readonly entry: KeymapEntry;
};

/**
 * Resolve one key press to an action id, or null.
 *
 * `zone` gates entries that only apply while a rail zone holds focus — a
 * cockpit `r` means reject only in the approvals zone, which the table already
 * records and nothing previously enforced.
 */
export function resolveKeyAction(
  scope: KeyScope,
  key: DispatchKey,
  input: string,
  zone?: FocusZone
): ResolvedAction | null {
  const token = keyToken(key, input);
  if (!token) return null;

  // Every table entry is cockpit-scoped — the table has no per-scope bindings
  // and does not need any. So the rule is: at the cockpit, all of them are
  // live; inside a modal scope, ONLY the ids that scope inherits are.
  //
  // Written as a filter rather than a parent-walk because the walk was wrong
  // in a way worth recording: it treated the starting scope as "everything is
  // live", which made a modal scope inherit the ENTIRE cockpit — the exact
  // opposite of the property, and it would have eaten `j` in a text field.
  const inheritable = scope === "cockpit" ? null : INHERITED[scope];
  for (const entry of KEYMAP) {
    if (entry.owner !== "cockpit") continue;
    if (inheritable && !inheritable.includes(entry.id)) continue;
    if (entry.zone && entry.zone !== zone) continue;
    if (matchesEntry(entry, token)) return { id: entry.id, entry };
  }
  return null;
}

/** Every action id the table expects a cockpit handler for. */
export function dispatchableIds(): string[] {
  return KEYMAP.filter((entry) => entry.owner === "cockpit").map(
    (entry) => entry.id
  );
}

/**
 * The action ids `App.tsx` currently runs FROM the table, as opposed to from
 * its inline cascade.
 *
 * Declared here rather than left implicit so the split is reviewable and
 * testable: an id in this set must have a dispatch branch, and an id outside it
 * is still owned by the cascade. That honesty is the same shape as `keymap.ts`'s
 * `owner` field, and it exists for the same reason — a partial migration that
 * does not say it is partial reads as a finished one.
 *
 * `cycle-zone` is first because it is the binding the Tab-after-`/` bug was
 * about: it is inherited by every modal scope, so dispatching it here is what
 * makes the fix structural instead of a patch repeated per mode.
 */
export const DISPATCHED_ACTIONS: ReadonlySet<string> = new Set(["cycle-zone"]);
