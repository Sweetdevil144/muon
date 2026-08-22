/**
 * The one https rule for MUON's release reads, shared (cubic pass-3 #6: the
 * predicate briefly existed twice and would have drifted the moment one copy
 * gained an allowlist). Its consumers today: `muon update` (both halves,
 * apps/cli) and the bash mirror in `public/install.sh`. The desktop's
 * background CLI refresh no longer needs it at all — it is structurally
 * PINNED to the canonical host (no host input exists to validate), which is
 * the stronger property.
 *
 * Why the rule exists at all: every consumer of a download-host URL hands it
 * to something that EXECUTES what arrives — `npm install -g` runs the
 * tarball's lifecycle scripts, the app swap replaces /Applications/MUON.app —
 * and none of the artifacts carry a signature to verify yet (the unsigned
 * lane, ADR-0029). Transport integrity plus the feed's own digests ARE the
 * chain, so a plaintext host is a network position away from code execution.
 *
 * The one consumer that cannot import this module — `public/install.sh`, a
 * bash script — applies the same rule inline (a `case "$DOWNLOAD_HOST" in
 * https://*)` guard); a change to the rule here must be mirrored there.
 */
export function hostSchemeRefusal(host: string): string | null {
  return /^https:\/\//.test(host.trim())
    ? null
    : `release host ${host} is not https — MUON only fetches release artifacts over https`;
}
