/**
 * TODO 7.9 — menu-bar / tray presence copy. Pure so the pending-approval
 * badge formatting stays unit-tested without booting Electron.
 */

export function trayPresenceTitle(input: {
  online: boolean;
  pendingCount: number;
}): string {
  if (!input.online) {
    return "◌";
  }
  return input.pendingCount > 0 ? `● ${input.pendingCount}` : "●";
}

export function trayPresenceTooltip(input: {
  online: boolean;
  pendingCount: number;
}): string {
  return input.online
    ? `MUON, ${input.pendingCount} pending approval(s)`
    : "MUON, brain offline";
}

/** Global hotkey that focuses MUON and opens the ⌘K palette (7.9). */
export const GLOBAL_PALETTE_SHORTCUT = "CommandOrControl+Shift+Space";
