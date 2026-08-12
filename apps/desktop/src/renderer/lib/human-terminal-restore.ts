import type { HumanTerminalSnapshotEntry } from "../../lib/human-terminal-snapshot.js";

/**
 * ROADMAP T1 step 3/4 — the FROZEN-UNTIL-ACK gate for a cold-restored human
 * terminal tab.
 *
 * A restored tab is structurally the renderer's ordinary `HumanTerminalTab`
 * (app.tsx) PLUS one extra field: `frozenScrollback`. Its presence IS the
 * gate — while set, the tab renders its captured scrollback read-only
 * (`FrozenTerminalTab`) instead of mounting a live `TerminalPreview`; once
 * the operator explicitly acknowledges, `acknowledgeRestoredHumanTerminal`
 * clears the field and the tab's normal live body mounts, which opens a
 * FRESH pty under the same session id (the one `PtyHost` held is gone —
 * `closeAllSessions()` killed every human session at the quit that produced
 * this snapshot).
 *
 * Generic over the caller's own tab shape (`app.tsx`'s `HumanTerminalTab`) so
 * this stays a pure, dependency-free reducer: no React, no Electron, testable
 * on its own.
 */
export type RestoredHumanTerminalTab = {
  id: string;
  chatId: string;
  kind: string;
  ordinal: number;
  label: string;
  /** The scrollback captured at the LAST quit, before its pty was killed.
   *  Present ONLY while this tab is frozen. */
  frozenScrollback: string;
};

/** Build the renderer's restored-tab list from what main handed back on
 *  `getHumanTerminalRestore()`. Pure; every entry starts frozen. */
export function restoredHumanTerminalTabs(
  entries: readonly HumanTerminalSnapshotEntry[]
): RestoredHumanTerminalTab[] {
  return entries.map((entry) => ({
    id: entry.sessionId,
    chatId: entry.chatId,
    kind: entry.kind,
    ordinal: entry.ordinal,
    label: entry.label,
    frozenScrollback: entry.text,
  }));
}

/**
 * Merge restored tabs into the renderer's CURRENT list without duplicating
 * one that already exists under the same id — the restore call can only ever
 * race an ordinary open in a narrow startup window, but two tabs sharing one
 * session id is a broken tab strip (duplicate `id`, duplicate pty attach), so
 * this refuses the merge rather than trusting timing.
 */
export function mergeRestoredHumanTerminalTabs<
  T extends { id: string },
>(current: readonly T[], restored: readonly T[]): T[] {
  if (restored.length === 0) {
    return [...current];
  }
  const knownIds = new Set(current.map((tab) => tab.id));
  return [...current, ...restored.filter((tab) => !knownIds.has(tab.id))];
}

/**
 * THE ACK ITSELF. Clears `frozenScrollback` on exactly the acknowledged tab,
 * leaving every other tab (frozen or not) byte-identical — the property this
 * is unit-tested for: acknowledging tab A can never thaw tab B, and
 * acknowledging an id that is not frozen (already live, or unknown) is a
 * no-op rather than an error.
 */
export function acknowledgeRestoredHumanTerminal<
  T extends { id: string; frozenScrollback?: string },
>(tabs: readonly T[], sessionId: string): T[] {
  return tabs.map((tab) => {
    if (tab.id !== sessionId || tab.frozenScrollback === undefined) {
      return tab;
    }
    const { frozenScrollback: _frozenScrollback, ...rest } = tab;
    return rest as T;
  });
}
