import { spawn, spawnSync } from "node:child_process";

// Resolve a command WITHOUT a shell. `which`/`where` receive the command as a
// literal argv token (no shell parsing), so a name containing shell
// metacharacters can never be interpreted, defense-in-depth against a future
// caller that passes anything other than a fixed vendor literal. (`command -v`
// via `sh -lc "…${command}"` was the previous, shell-interpolated form.)
function lookupTool(): string {
  return process.platform === "win32" ? "where" : "which";
}

export function commandExists(command: string): boolean {
  return (
    spawnSync(lookupTool(), [command], { stdio: "ignore" }).status === 0
  );
}

export function firstAvailableCommand(candidates: string[]): string | undefined {
  return candidates.find((candidate) => commandExists(candidate));
}

/**
 * Async, non-blocking equivalent of `commandExists`. The sync `spawnSync`
 * version blocks the event loop, which is unacceptable on hot paths in the
 * embedded backend (e.g. readiness probing while runner heartbeats are due).
 * Resolves false on any spawn error; never rejects.
 */
export function commandExistsAsync(command: string): Promise<boolean> {
  const file = lookupTool();
  const args = [command];
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(file, args, { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}
