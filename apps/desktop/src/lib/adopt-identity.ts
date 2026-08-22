/**
 * ADR-0052 — the desktop ADOPTS the machine's shared identity credential.
 *
 * Founder acceptance testing (2026-08-19) hit the split this module closes:
 * `muon login` completed the device flow, registered the install, and wrote the
 * shared `github-identity.json` — and the desktop app still demanded a sign-in.
 * Worse, the gate screen's status row reported "Connected" (the LIVE brain the
 * CLI login had just connected) beside a lock that would not open, because gate
 * satisfaction reads `settings.githubCredential` — the desktop's OWN settings
 * file — and nothing ever carried the shared credential across.
 *
 * The asymmetry was already one-directional: the desktop's device flow writes
 * the shared file (via install registration) so the CLI and `muon-mcp` unlock,
 * but a CLI sign-in never reached the desktop. This is the missing direction:
 * one sign-in on any surface of this machine is a sign-in for all of them.
 *
 * Pure decision + translation only. Reading the file, persisting settings, and
 * crossing the gate boundary stay in main.ts, which owns both stores.
 */
import type { GitHubCredential } from "@muon/client";
import type { IdentityCredentialRead } from "@muon/client/github-identity-gate";

/**
 * Translate the shared identity credential (ADR-0052's `github-identity.json`,
 * written by `muon login` / install registration) into the desktop's own
 * credential shape.
 *
 * The shared file carries no expiry and no refresh token — `muon login` stores
 * the device-flow access token as-is — so the desktop credential carries none
 * either. That matches how the desktop treats its own credential: identity, not
 * connectivity; an expired-but-present token still names WHO the operator is.
 */
export function desktopCredentialFromShared(
  read: IdentityCredentialRead
): GitHubCredential | null {
  if (!read.ok) return null;
  return {
    accessToken: read.credential.token,
    login: read.credential.github.login,
  };
}

/**
 * Should this run adopt the shared credential, and as what?
 *
 * Positive conditions only (ADR-0022 — no subtraction):
 *  - the desktop has NO credential of its own. A present credential always
 *    wins, even over a newer shared one: overwriting a connected account with
 *    whatever the CLI last signed in as would make `muon login` a silent
 *    account switcher for a running app.
 *  - the shared file reads back as a VALID credential. `unreadable` is not
 *    adoptable — a file that fails schema/grant validation is either tampered
 *    or from a future build, and both are "sign in here" cases, not "trust it".
 */
export function adoptableSharedCredential(input: {
  readonly hasSettingsCredential: boolean;
  readonly read: () => IdentityCredentialRead;
}): GitHubCredential | null {
  if (input.hasSettingsCredential) return null;
  return desktopCredentialFromShared(input.read());
}
