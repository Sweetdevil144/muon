// ADR-0032 D6 — one keymap table.
//
// Before this module the ~28 TUI bindings existed only as inline
// `if (input === "x")` branches inside one 880-line `useInput` cascade. Nothing
// enumerated them, so: the footer advertised six, the README documented eight
// and was wrong about scope, and `r` meant "reject" in one context and
// "refresh" in three others with no way to notice.
//
// The table below is the enumeration. It renders the `?` help overlay and
// generates the README table, and — since ADR-0042 D2 — `key-dispatch.ts`
// resolves keys against it. But dispatch is migrating INCREMENTALLY: only the
// ids in `DISPATCHED_ACTIONS` actually run from the table today (`cycle-zone`).
// Everything else is still dispatched inline by App.tsx.
//
// CORRECTION, kept because the false version of this sentence caused a bug:
// this comment used to claim "It drives dispatch for the cockpit mode". It did
// not. `App.tsx` never imported this file, so the table was a second
// description of the bindings rather than their source — and the two drifted
// exactly as that predicts. Pressing `/` killed Tab cycling, because the
// command-bar branch returned without checking a key the table said was live.
// `key-dispatch.ts` is what will make the original sentence true, one id at a
// time. It is NOT true yet, and the previous revision of this block said it
// was — replacing a false sentence with a different false sentence in the very
// comment that exists to record the first one. `DISPATCHED_ACTIONS` is the
// honest boundary: what is in it dispatches from here, what is not does not.
//
// Honest scope, stated because it would otherwise look like a lie: the eleven
// modal panels still dispatch their own keys inline. Their bindings are
// DECLARED here (so help and docs are complete) and marked `owner` accordingly;
// the drift-lock asserts handler parity only for `owner: "cockpit"`. Migrating
// the panels is phase 2, and the marker is what keeps that honest in the
// meantime rather than silently undocumented.

import type { FocusZone } from "./layout.js";

export type KeymapOwner =
  /** Dispatched from the table by the cockpit's `useInput`. */
  | "cockpit"
  /** Declared for help/docs; still dispatched inside its panel. */
  | "panel";

export type KeymapGroup =
  | "desk"
  | "tabs"
  | "crew"
  | "decide"
  | "memory"
  | "session"
  | "app";

export type KeymapEntry = {
  /** Stable action id; the handler map is keyed by it. */
  readonly id: string;
  /** Display form, e.g. `["1", "…", "9"]` or `["ctrl+k"]`. */
  readonly keys: readonly string[];
  readonly group: KeymapGroup;
  readonly description: string;
  readonly owner: KeymapOwner;
  /**
   * Cockpit entries that only apply while a zone holds focus. Absent = the
   * binding is live whenever the cockpit is taking keys.
   */
  readonly zone?: FocusZone;
  /** The panel that owns dispatch, for `owner: "panel"` entries. */
  readonly panel?: string;
};

export const KEYMAP: readonly KeymapEntry[] = [
  // — desk ————————————————————————————————————————————————
  {
    id: "focus-command",
    keys: ["/", "i"],
    group: "desk",
    description: "focus the command bar — tell the crew what to do",
    owner: "cockpit",
  },
  {
    id: "palette",
    keys: ["ctrl+k"],
    group: "desk",
    description: "command palette",
    owner: "cockpit",
  },
  {
    id: "help",
    keys: ["?"],
    group: "desk",
    description: "this keymap",
    owner: "cockpit",
  },
  {
    id: "cycle-zone",
    keys: ["tab", "shift+tab"],
    group: "desk",
    description: "cycle focus between rail zones",
    owner: "cockpit",
  },
  {
    id: "move-down",
    keys: ["j", "↓"],
    group: "desk",
    description: "move down in the focused zone",
    owner: "cockpit",
  },
  {
    id: "move-up",
    keys: ["k", "↑"],
    group: "desk",
    description: "move up in the focused zone",
    owner: "cockpit",
  },
  {
    id: "needs-you",
    keys: ["o"],
    group: "desk",
    description: "jump to the newest item that needs you",
    owner: "cockpit",
  },

  // — tabs ————————————————————————————————————————————————
  {
    id: "tab-ordinal",
    keys: ["1", "…", "9"],
    group: "tabs",
    description: "switch to tab N",
    owner: "cockpit",
  },
  {
    id: "tab-next",
    keys: ["]"],
    group: "tabs",
    description: "next tab",
    owner: "cockpit",
  },
  {
    id: "tab-prev",
    keys: ["["],
    group: "tabs",
    description: "previous tab",
    owner: "cockpit",
  },
  {
    id: "tab-close",
    keys: ["x"],
    group: "tabs",
    description: "close the active tab",
    owner: "cockpit",
  },

  // — crew ————————————————————————————————————————————————
  {
    id: "lane-stream",
    keys: ["enter"],
    group: "crew",
    description: "open the selected lane's live stream in a tab",
    owner: "cockpit",
    zone: "lanes",
  },
  {
    id: "lane-stop",
    keys: ["s"],
    group: "crew",
    description: "stop the selected lane",
    owner: "cockpit",
    zone: "lanes",
  },
  {
    id: "lane-budget",
    keys: ["b"],
    group: "crew",
    description: "mission budget breakdown",
    owner: "cockpit",
    zone: "lanes",
  },
  {
    id: "stop-all",
    keys: ["!"],
    group: "crew",
    description: "stop every dispatch",
    owner: "cockpit",
  },
  {
    id: "task-detail",
    keys: ["enter"],
    group: "crew",
    description: "open the selected task's detail in a tab",
    owner: "cockpit",
    zone: "tasks",
  },

  // — decide ——————————————————————————————————————————————
  // Two-press by design: the first press opens the content-bound evidence
  // view, the second decides. ADR-0032 D5 keeps the decision bound to the
  // approval id rather than a list index.
  {
    id: "approve",
    keys: ["a"],
    group: "decide",
    description: "approve (first press opens the evidence)",
    owner: "cockpit",
    zone: "approvals",
  },
  {
    id: "approve-remember",
    keys: ["A"],
    group: "decide",
    description: "approve + don't ask again for 15 minutes",
    owner: "cockpit",
    zone: "approvals",
  },
  {
    id: "reject",
    keys: ["r"],
    group: "decide",
    description: "reject (first press opens the evidence)",
    owner: "cockpit",
    zone: "approvals",
  },
  {
    id: "attest-review-blind",
    keys: ["m"],
    group: "decide",
    description: "merge gates only: attest REVIEW BLIND, then approve",
    owner: "panel",
    panel: "approval-review",
  },

  // — memory ——————————————————————————————————————————————
  {
    id: "memory-confirm",
    keys: ["c"],
    group: "memory",
    description: "confirm the selected note",
    owner: "panel",
    panel: "memory",
  },
  {
    id: "memory-reject",
    keys: ["x"],
    group: "memory",
    description: "reject the selected note (governed)",
    owner: "panel",
    panel: "memory",
  },
  {
    id: "memory-pause",
    keys: ["p"],
    group: "memory",
    description: "pause the selected note",
    owner: "panel",
    panel: "memory",
  },
  {
    id: "memory-expired",
    keys: ["e"],
    group: "memory",
    description: "toggle expired notes (re-runs the governed search)",
    owner: "panel",
    panel: "memory",
  },
  {
    id: "brain-view-proposal",
    keys: ["v"],
    group: "memory",
    description: "view the selected proposal's text",
    owner: "panel",
    panel: "brain",
  },

  // — session ——————————————————————————————————————————————
  {
    id: "panel-refresh",
    keys: ["r"],
    group: "session",
    description: "refresh the open panel",
    owner: "panel",
    panel: "crew · mcp · brain",
  },
  {
    id: "workflow-apply",
    keys: ["a"],
    group: "session",
    description: "apply the selected workflow run",
    owner: "panel",
    panel: "workflow",
  },
  {
    id: "workflow-execute",
    keys: ["x"],
    group: "session",
    description: "apply if needed, then execute",
    owner: "panel",
    panel: "workflow",
  },

  // — app ——————————————————————————————————————————————————
  {
    id: "back",
    keys: ["esc"],
    group: "app",
    description: "back — never remounts the desk",
    owner: "cockpit",
  },
  {
    id: "quit",
    keys: ["q"],
    group: "app",
    description: "quit",
    owner: "cockpit",
  },
];

export const KEYMAP_GROUP_ORDER: readonly KeymapGroup[] = [
  "desk",
  "tabs",
  "crew",
  "decide",
  "memory",
  "session",
  "app",
];

export const KEYMAP_GROUP_LABEL: Readonly<Record<KeymapGroup, string>> = {
  desk: "Desk",
  tabs: "Tabs",
  crew: "Crew",
  decide: "Decide",
  memory: "Memory",
  session: "Panels",
  app: "App",
};

/** Cockpit entries only — the set the table actually dispatches. */
export function cockpitBindings(): KeymapEntry[] {
  return KEYMAP.filter((entry) => entry.owner === "cockpit");
}

export function keymapByGroup(): { group: KeymapGroup; entries: KeymapEntry[] }[] {
  return KEYMAP_GROUP_ORDER.map((group) => ({
    group,
    entries: KEYMAP.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/** Filter for the `?` overlay's search line. Matches keys and description. */
export function filterKeymap(query: string): KeymapEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...KEYMAP];
  return KEYMAP.filter(
    (entry) =>
      entry.description.toLowerCase().includes(needle) ||
      entry.keys.some((key) => key.toLowerCase().includes(needle)) ||
      entry.group.includes(needle)
  );
}

export function formatKeys(entry: KeymapEntry): string {
  return entry.keys.join(" ");
}

/** The README's keymap table, generated so it cannot drift from the code. */
export function renderKeymapMarkdown(): string {
  const lines: string[] = [];
  for (const section of keymapByGroup()) {
    lines.push(`### ${KEYMAP_GROUP_LABEL[section.group]}`, "");
    lines.push("| Key | Action |", "| --- | --- |");
    for (const entry of section.entries) {
      const scope = entry.zone
        ? ` _(${entry.zone})_`
        : entry.panel
          ? ` _(${entry.panel})_`
          : "";
      lines.push(`| \`${formatKeys(entry)}\` | ${entry.description}${scope} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
