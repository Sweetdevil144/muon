import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PortScanRunner } from "./port-scan.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 3_000;

/** Parse `lsof -a -p <pid> -d cwd -Fn` output (`n/path/to/cwd`). */
export function parseLsofCwdOutput(output: string): string | null {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("n")) {
      const path = line.slice(1).trim();
      return path || null;
    }
  }
  return null;
}

/** Parse `/proc/<pid>/cwd` readlink output (Linux tests inject this). */
export function parseProcCwdOutput(output: string): string | null {
  const trimmed = output.trim();
  return trimmed || null;
}

async function defaultRunner(
  command: string,
  args: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
  return stdout.toString();
}

/**
 * Resolve cwd for a bounded set of pids. Missing/unreadable entries are omitted
 * rather than guessed — association simply skips them.
 */
export async function lookupProcessCwds(
  pids: readonly number[],
  runner: PortScanRunner = defaultRunner
): Promise<Record<number, string>> {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const out: Record<number, string> = {};
  await Promise.all(
    unique.map(async (pid) => {
      try {
        if (process.platform === "linux") {
          const proc = await runner("readlink", [`/proc/${pid}/cwd`]);
          const cwd = parseProcCwdOutput(proc);
          if (cwd) {
            out[pid] = cwd;
          }
          return;
        }
        const lsof = await runner("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
        const cwd = parseLsofCwdOutput(lsof);
        if (cwd) {
          out[pid] = cwd;
        }
      } catch {
        // unreadable process — skip
      }
    })
  );
  return out;
}
