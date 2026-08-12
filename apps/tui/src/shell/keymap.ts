/**
 * THE KEYMAP — one table that is both the dispatcher's source and the help
 * text's source.
 *
 * ADR-0042 D2, made mechanical. The founder's law: "every key in `?` / README
 * / keymap works in every reachable scope, or it is removed from help.
 * Advertised-but-inert is a P0 bug." That cannot be enforced by discipline,
 * because the two lists drift the moment anyone edits one of them. So there
 * is only one list, `KEYMAP`, and:
 *
 *  - `?` renders from it,
 *  - `routeKey` resolves the PREFIX and DESK scopes against it,
 *  - a drift-lock test asserts every entry resolves to a live intent in the
 *    scope it advertises, AND (level two) that every prefix command changes
 *    the rendered frame.
 *
 * HONEST LIMIT, because an earlier version of this comment overstated it: the
 * overlay and gate scopes are still dispatched by hand in `routeKey`, not
 * through this table. A review named that correctly. What the drift-lock
 * guarantees today is that nothing ADVERTISED here is inert — not that every
 * dispatch path reads the table. Those overlay bindings are deliberately
 * uniform (arrows move, Enter selects, Esc pops one), which is why they read
 * as shape rather than as data; if they ever diverge per surface they belong
 * in the table too.
 *
 * THE PREFIX MODEL, and why. When a vendor CLI owns the pane it owns `q`,
 * `j`, `/`, the arrows and ctrl-c — every one of them. A desk chord on a bare
 * key is therefore either stolen FROM the child or steals FROM it. The
 * reference terminal app solves this with a pane-focus prefix and has a test
 * asserting the prefix does not leak; tmux solves it identically. MUON
 * reserves exactly TWO keys from a child: `ctrl+q` (quit) and `ctrl+b` (the
 * desk prefix). After the prefix, one keystroke selects a desk command.
 *
 * Where there is no child — the cockpit and every overlay — bare keys are
 * safe and are used, because there is nothing to steal from.
 */

export type Scope =
  | "always"
  | "prefix"
  | "terminal"
  | "desk"
  | "overlay"
  | "modal";

export type KeymapEntry = {
  /** The key as a human reads it in `?`. */
  readonly key: string;
  /** The literal input bytes this entry matches. */
  readonly match: readonly string[];
  readonly scope: Scope;
  readonly action: string;
  /** One line for `?`. */
  readonly help: string;
};

const ESC = String.fromCodePoint(0x1b);
const ctrl = (letter: string) =>
  String.fromCodePoint(letter.toUpperCase().charCodeAt(0) - 64);

export const DESK_PREFIX = ctrl("b");
export const KEY_QUIT = ctrl("q");

/** Arrow keys, as the host actually sends them, plus the vi pair. */
export const DOWN_KEYS = [`${ESC}[B`, "j"] as const;
export const UP_KEYS = [`${ESC}[A`, "k"] as const;
export const ESC_KEY = ESC;
export const ENTER_KEYS = ["\r", "\n"] as const;
export const TAB_KEY = "\t";
export const SHIFT_TAB_KEY = `${ESC}[Z`;

export const KEYMAP: readonly KeymapEntry[] = [
  // ── always ────────────────────────────────────────────────────────────
  {
    key: "ctrl+q",
    match: [KEY_QUIT],
    scope: "always",
    action: "quit",
    help: "quit MUON, from anywhere",
  },
  {
    key: "ctrl+b",
    match: [DESK_PREFIX],
    scope: "always",
    action: "prefix",
    help: "desk prefix — the next key is a MUON command",
  },

  // ── after the prefix ──────────────────────────────────────────────────
  {
    key: "ctrl+b s",
    match: ["s"],
    scope: "prefix",
    action: "toggle-sidebar",
    help: "sessions sidebar (same chord closes it — Esc belongs to the child)",
  },
  {
    key: "ctrl+b c",
    match: ["c"],
    scope: "prefix",
    action: "toggle-crew",
    help: "crew drawer — lanes and what is blocked",
  },
  {
    key: "ctrl+b i",
    match: ["i"],
    scope: "prefix",
    action: "toggle-inbox",
    help: "inbox — approvals waiting on you",
  },
  {
    key: "ctrl+b g",
    match: ["g"],
    scope: "prefix",
    action: "open-destinations",
    help: "go to a destination",
  },
  // NO `ctrl+b /` YET. It advertised "command catalogue" and opened the
  // TERMINAL PICKER — the same frame as `ctrl+b t`, byte for byte. That is
  // founder law 6 in its subtler form: the key was not inert, it lied about
  // what it did, and a drift-lock that only asserts "the frame changed"
  // cannot catch a wrong label. It returns when there is a catalogue to open.
  {
    key: "ctrl+b m",
    match: ["m"],
    scope: "prefix",
    action: "open-memory",
    help: "memory — the brain's notes",
  },
  {
    // ADVERTISED UNSHIFTED. `?` still works — the decoder now reads the
    // terminal's own shifted key rather than guessing at the layout — but no
    // chord on this desk REQUIRES a shift to reach it. A binding a human has
    // to reach for two keys to press is one they use less.
    key: "ctrl+b /",
    match: ["/", "?"],
    scope: "prefix",
    action: "open-help",
    help: "this list (? works too)",
  },
  {
    key: "ctrl+b ⏎",
    match: ["\r", "\n"],
    scope: "prefix",
    action: "answer-gate",
    help: "answer the gate that is waiting on you",
  },
  {
    key: "ctrl+b a",
    match: ["a"],
    scope: "prefix",
    action: "open-composer",
    help: "new task — give MUON work to do",
  },
  {
    // Unshifted, same reasoning. `|` and tmux's `%` both still work.
    key: "ctrl+b \\",
    match: ["\\", "|", "%"],
    scope: "prefix",
    action: "split-pane",
    help: "split — a second terminal beside this one (| works too)",
  },
  {
    key: "ctrl+b o",
    match: ["o"],
    scope: "prefix",
    action: "focus-other-pane",
    help: "focus the other pane",
  },
  {
    key: "ctrl+b h",
    match: ["h"],
    scope: "prefix",
    action: "focus-left-pane",
    help: "focus the left pane",
  },
  {
    key: "ctrl+b l",
    match: ["l"],
    scope: "prefix",
    action: "focus-right-pane",
    help: "focus the right pane",
  },
  {
    key: "ctrl+b t",
    match: ["t"],
    scope: "prefix",
    action: "new-tab",
    help: "new session tab",
  },
  {
    key: "ctrl+b n",
    match: ["n"],
    scope: "prefix",
    action: "next-tab",
    help: "next tab",
  },
  {
    key: "ctrl+b p",
    match: ["p"],
    scope: "prefix",
    action: "prev-tab",
    help: "previous tab",
  },
  {
    key: "ctrl+b w",
    match: ["w"],
    scope: "prefix",
    action: "close-tab",
    // "this tab" was true until the chord learned about panes: with a split
    // focused it closes the PANE and the tab lives on. Keybindings never lie
    // includes what the help says they do.
    help: "close this pane (the tab, when it is the only one)",
  },

  // ── the cockpit (no child to steal from) ──────────────────────────────
  {
    key: "↑ / k",
    match: [...UP_KEYS],
    scope: "desk",
    action: "move-up",
    help: "move up in the focused list",
  },
  {
    key: "↓ / j",
    match: [...DOWN_KEYS],
    scope: "desk",
    action: "move-down",
    help: "move down in the focused list",
  },
  {
    key: "⏎",
    match: [...ENTER_KEYS],
    scope: "desk",
    action: "activate",
    help: "open what is selected",
  },
  {
    key: "tab",
    match: [TAB_KEY],
    scope: "desk",
    action: "cycle-zone",
    help: "cycle focus between zones",
  },
  {
    key: "shift+tab",
    match: [SHIFT_TAB_KEY],
    scope: "desk",
    action: "cycle-zone-back",
    help: "cycle focus backwards",
  },
  {
    key: "t",
    match: ["t"],
    scope: "desk",
    action: "open-spawn-menu",
    help: "open a terminal",
  },
  {
    key: "q",
    match: ["q"],
    scope: "desk",
    action: "quit",
    help: "quit (cockpit only — inside a pane, q is the child's)",
  },

  // ── any overlay list ──────────────────────────────────────────────────
  {
    key: "↑ ↓ / k j",
    match: [...UP_KEYS, ...DOWN_KEYS],
    scope: "overlay",
    action: "move",
    help: "move the selection",
  },
  {
    key: "⏎",
    match: [...ENTER_KEYS],
    scope: "overlay",
    action: "select",
    help: "choose",
  },
  {
    key: "tab",
    match: [TAB_KEY, SHIFT_TAB_KEY],
    scope: "overlay",
    action: "cycle-zone",
    help: "cycle focus — live inside every overlay",
  },
  {
    key: "esc",
    match: [ESC_KEY],
    scope: "overlay",
    action: "pop-layer",
    help: "close ONE layer — never two, never the app",
  },

  // ── a gate owns the keyboard ──────────────────────────────────────────
  {
    key: "esc",
    match: [ESC_KEY],
    scope: "modal",
    action: "pop-layer",
    help: "leave this gate without deciding",
  },
];

/** Everything `?` shows, grouped the way a human reads it. */
export function helpSections(): { scope: Scope; entries: KeymapEntry[] }[] {
  const order: Scope[] = ["always", "prefix", "desk", "overlay", "modal"];
  return order.map((scope) => ({
    scope,
    entries: KEYMAP.filter((entry) => entry.scope === scope),
  }));
}

/** The label a scope carries in `?`. */
export const SCOPE_LABEL: Record<Scope, string> = {
  always: "anywhere",
  prefix: "after ctrl+b",
  terminal: "in a live terminal",
  desk: "on the desk",
  overlay: "in a list or drawer",
  modal: "at a gate",
};

/**
 * Resolve a key WITHIN one scope. Returns the action, or null so the caller
 * can fall through to a parent scope — falling through is the model, not an
 * error path (rule 1 of the input contract).
 */
export function resolveKey(scope: Scope, data: string): string | null {
  for (const entry of KEYMAP) {
    if (entry.scope !== scope) continue;
    if (entry.match.includes(data)) return entry.action;
  }
  return null;
}
