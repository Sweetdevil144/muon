// `openTuiCommand` and `platformUrl` were removed with their tray items: both
// backed dev-only coordinates (`npm run tui` fails outside the repo; the "Hub
// Dashboard" URL pointed at a localhost dev route that does not exist) and
// neither backing setting was editable in the UI. The AppleScript/shell
// quoting discipline they carried lives on in git history should a real
// "open in Terminal" feature return — re-read it there before rebuilding one.

/**
 * Is `value` a brain URL this app may point itself at?
 *
 * LOOPBACK ONLY, and that is a product invariant rather than a preference: the
 * desktop README states the app "makes no outbound calls except the opt-in
 * updater", and `settings.apiToken` is the OPERATOR bearer — the credential that
 * approves gates and confirms memory. `muon:saveSettings` accepted any string and
 * validated nothing, so one settings write could aim the control plane at a remote
 * host and every subsequent poll would carry that bearer to it, persist across
 * restart, and (through `restartRunner`) hand the same base to the sandboxed
 * runner as `MUON_API_BASE`.
 *
 * Rejects by CONSTRUCTION rather than by pattern: the string must parse as a URL,
 * its protocol must be http/https (so `file:`, `javascript:` and friends are out),
 * and its hostname must be a loopback literal. An unparseable or non-loopback
 * value is refused with a reason, never silently coerced.
 */
export function isLoopbackApiBase(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  // `URL` keeps IPv6 hosts bracketed; compare both spellings.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
