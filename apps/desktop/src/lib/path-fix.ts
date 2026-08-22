import os from "node:os";
import { resolveNpmGlobalRootSync } from "@muon/client/gitnexus-reindex";

/**
 * Finder-launched apps inherit a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so the orchestrator's spawned vendor CLIs (claude, codex, muon-mcp) would
 * not resolve. Prepend the common install locations; terminal launches are
 * unaffected beyond ordering because entries are deduplicated.
 */
export function withDefaultPaths(
  current: string | undefined,
  home: string = os.homedir(),
  /** Runtime-derived dirs (npm's global bin) appended after the static
   *  defaults — see fixSpawnPath's second stage. */
  extra: readonly string[] = []
): string {
  const defaults = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.local/share/mise/shims`,
    // opencode's installer puts the binary here and adds it to the SHELL
    // profile only — a Finder-launched app would miss the vendor tab's
    // spawn (and the readiness probe) without it.
    `${home}/.opencode/bin`,
    `${home}/bin`,
  ];
  const system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const existing = (current ?? "").split(":").filter(Boolean);

  const merged: string[] = [];
  for (const entry of [...defaults, ...extra, ...existing, ...system]) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  return merged.join(":");
}

/**
 * npm's global BIN dir, derived from `npm root -g`. npm's documented unix
 * layout is `<prefix>/lib/node_modules` beside `<prefix>/bin`; any other
 * shape returns null — a guessed directory must never go onto PATH.
 *
 * WHY THIS EXISTS (founder acceptance, 2026-08-20): version managers put
 * npm-global binaries in per-version dirs no static list can name —
 * `~/.local/share/mise/installs/node/lts/bin` on the founder's machine — so
 * a Finder-launched app reported "Codex CLI not found" for a codex that was
 * installed and working in every terminal. The mise SHIMS dir in the static
 * defaults only covers binaries mise has reshimmed, which `npm i -g` alone
 * does not do.
 */
export function npmGlobalBinDir(npmRoot: string | null): string | null {
  if (!npmRoot) return null;
  const normalized = npmRoot.replace(/\/+$/, "");
  const suffix = "/lib/node_modules";
  if (!normalized.endsWith(suffix)) return null;
  return `${normalized.slice(0, -suffix.length)}/bin`;
}

export function fixSpawnPath(): void {
  // Stage 1: the static defaults, so npm itself becomes resolvable (mise
  // shims always carry node/npm; homebrew carries them unmanaged).
  process.env.PATH = withDefaultPaths(process.env.PATH);
  // Stage 2: with npm reachable, ask IT where global binaries live and put
  // that dir on PATH too. Best-effort — a machine without npm changes
  // nothing, and the probe is process-cached and bounded (5s).
  const npmBin = npmGlobalBinDir(resolveNpmGlobalRootSync());
  if (npmBin) {
    process.env.PATH = withDefaultPaths(process.env.PATH, os.homedir(), [npmBin]);
  }
}
