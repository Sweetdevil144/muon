import type { UngovernedAgentEntry } from "@muon/client";

/**
 * ROADMAP P7 — the custom (ungoverned) agent half of the terminal tab bar.
 *
 * Renderer-safe by construction, mirroring `terminal-vendor-tabs.ts`: pure
 * functions over data the caller already has (the registered-entries list,
 * fetched over IPC from the main process's read of the on-disk store — this
 * module never touches the filesystem itself). No `process.env`, no
 * `@muon/adapters`, no spawn — spawn RESOLUTION stays host-side
 * (`terminal-spawn.ts`); this module only decides what BUTTON and what BADGE
 * the human sees.
 *
 * Every entry this module renders is `ungoverned: true`, unconditionally —
 * there is no code path here that could render a custom agent WITHOUT the
 * badge, because the type this module returns has no `false` state for that
 * field. That is the desktop half of "visibly marked Ungoverned."
 */

export type CustomAgentMenuEntry = {
  /** The spawn KIND the renderer sends — the entry's own id (`custom:<slug>`). */
  kind: string;
  label: string;
  /** Always `true`: MUON runs no readiness probe against an arbitrary,
   *  operator-typed binary (there is no vendor auth/install contract to
   *  check). A missing or broken binary is reported the same way any failed
   *  spawn is — the pane shows the exit and MUON's fast-exit guard refuses an
   *  automatic respawn (`terminal-vendor-tabs.ts`, `TERMINAL_FAST_EXIT_MS`). */
  enabled: true;
  detail: string;
  /** The one field `buildTerminalVendorMenu` entries never carry. Always
   *  `true` here — see module header. */
  ungoverned: true;
};

function customAgentDetail(entry: UngovernedAgentEntry): string {
  const argv = entry.args.length > 0 ? `${entry.command} ${entry.args.join(" ")}` : entry.command;
  return `Ungoverned — runs '${argv}' as a plain terminal tab. No MUON role, no dispatch, no brain/MCP access. Registered via \`muon custom-agents register\`.`;
}

/** Build the custom-agent portion of the terminal tab bar's button strip. */
export function buildCustomAgentMenu(
  entries: readonly UngovernedAgentEntry[]
): CustomAgentMenuEntry[] {
  return entries.map((entry) => ({
    kind: entry.id,
    label: entry.shortLabel,
    enabled: true,
    detail: customAgentDetail(entry),
    ungoverned: true,
  }));
}

/** Tab display name for a custom-agent kind: the entry's short label, then
 *  "<label> 2" for a second session — same numbering rule as a vendor tab
 *  (`terminalTabLabel`). Falls back to the raw kind if the entry has since
 *  been removed (a tab opened before a `muon custom-agents remove` survives
 *  the session it is already in). */
export function customAgentTabLabel(
  kind: string,
  ordinal: number,
  entries: readonly UngovernedAgentEntry[]
): string {
  const base = entries.find((entry) => entry.id === kind)?.shortLabel ?? kind;
  return ordinal > 1 ? `${base} ${ordinal}` : base;
}
