import os from "node:os";

/**
 * Finder-launched apps inherit a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so the orchestrator's spawned vendor CLIs (claude, codex, muon-mcp) would
 * not resolve. Prepend the common install locations; terminal launches are
 * unaffected beyond ordering because entries are deduplicated.
 */
export function withDefaultPaths(
  current: string | undefined,
  home: string = os.homedir()
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
  for (const entry of [...defaults, ...existing, ...system]) {
    if (!merged.includes(entry)) {
      merged.push(entry);
    }
  }
  return merged.join(":");
}

export function fixSpawnPath(): void {
  process.env.PATH = withDefaultPaths(process.env.PATH);
}
