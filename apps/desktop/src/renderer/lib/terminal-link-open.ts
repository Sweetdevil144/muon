import type { TerminalLinkTarget } from "./terminal-link-security.js";

/**
 * ROADMAP T4 — the production opener for an ALREADY-ALLOWLISTED OSC-8 target.
 * The renderer has no direct OS access (context-isolated preload), so this
 * crosses the typed bridge to trusted main, which RE-VALIDATES independently
 * (never trusting a renderer-side classification alone — the same
 * defense-in-depth `isAllowedGitHubExternalUrl` already gets a second check
 * at the IPC boundary) before doing anything: `shell.openExternal` for a URL,
 * a reveal-in-Finder for an in-workspace path.
 *
 * Best-effort: an older bridge without the method, or a call that throws
 * (main refused it, the window is gone), never surfaces past a click handler
 * — there is nothing actionable a human could do with that failure beyond
 * "the link did not open", which is already the visible outcome.
 */
export async function bridgeOpenTerminalLink(
  target: TerminalLinkTarget
): Promise<void> {
  const opener = window.muon?.terminal?.openLink;
  if (typeof opener !== "function") {
    return;
  }
  try {
    await opener(target);
  } catch {
    // Best-effort — see module doc.
  }
}
