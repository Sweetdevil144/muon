import { spawn as nodeSpawn } from "node:child_process";
import { boundedProviderFailure } from "./provider-failure.js";

/**
 * Why MUON re-runs `muon-mcp` after a vendor reports it failed to start.
 *
 * A vendor that hosts the governed MCP server as a subprocess (codex
 * `app-server`) does NOT forward that subprocess's stderr — it reports only its
 * own opaque summary ("MCP client for `muon` failed to start … connection
 * closed: initialize response"). But `muon-mcp` states its cause precisely on
 * stderr before exiting ("orchestrator MCP mode requires MUON_JOB_ID lineage"),
 * and that sentence is the whole diagnosis. The only way to see it is to run the
 * exact same command with the exact same environment ourselves.
 *
 * Bounded by construction: FAILURE PATH ONLY, stdin closed immediately (a
 * HEALTHY server's stdio transport then ends at once, so the probe costs one
 * short-lived process and produces no stderr), hard deadline, SIGKILL, and the
 * captured text is redacted through the adapters' single credential control
 * before it is handed to anyone.
 */

const MUON_MCP_PROBE_TIMEOUT_MS = 3_000;
const MUON_MCP_PROBE_TAIL_CHARS = 600;

export type MuonMcpProbeInput = {
  command: string;
  args?: string[];
  /** The exact environment the vendor was asked to start the server with. */
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injection seam: the real `spawn` would need the real binary in tests. */
  spawn?: typeof nodeSpawn;
};

/**
 * Value-blocklist pass over the probe's own stderr.
 *
 * `boundedProviderFailure` redacts by SHAPE (`NAME=value`, bearer headers). It
 * cannot recognize a bare token printed on its own, so we additionally blank the
 * exact secret VALUES we know we injected. Not a competing redaction control —
 * the shape-based one still runs, this only adds what we uniquely know.
 */
function blankInjectedSecrets(
  text: string,
  env: Record<string, string>
): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i.test(name)) {
      continue;
    }
    // Short values would blank harmless substrings; a real credential is long.
    if (typeof value !== "string" || value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

/**
 * Run the governed MCP server exactly as the vendor was told to, and return its
 * own bounded, redacted stderr tail. Returns "" when it started cleanly or said
 * nothing — the caller must then keep the vendor's original message rather than
 * assert a cause it never observed.
 */
export function readMuonMcpStartupFailure(
  input: MuonMcpProbeInput
): Promise<string> {
  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve("");
      return;
    }
    let child;
    try {
      child = (input.spawn ?? nodeSpawn)(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      resolve(boundedProviderFailure(error, MUON_MCP_PROBE_TAIL_CHARS));
      return;
    }

    let stderr = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; the tail below is what we came for either way.
      }
      resolve(
        stderr.trim()
          ? boundedProviderFailure(
              blankInjectedSecrets(stderr, input.env),
              MUON_MCP_PROBE_TAIL_CHARS
            )
          : ""
      );
    };
    const deadline = setTimeout(finish, input.timeoutMs ?? MUON_MCP_PROBE_TIMEOUT_MS);
    deadline.unref?.();

    child.stderr?.on("data", (chunk: Buffer | string) => {
      // Bound each chunk BEFORE concatenating so one huge write is never held.
      const text = String(chunk).slice(-MUON_MCP_PROBE_TAIL_CHARS);
      stderr = `${stderr}${text}`.slice(-MUON_MCP_PROBE_TAIL_CHARS);
    });
    child.on("error", (error) => {
      // A spawn failure (missing binary, not executable) IS the diagnosis.
      stderr = `${stderr} ${boundedProviderFailure(error, 200)}`;
      finish();
    });
    child.on("close", finish);
    // EOF on stdin: a server that started correctly ends its stdio transport
    // here instead of waiting for a handshake that will never come.
    try {
      child.stdin?.end();
    } catch {
      // The deadline still settles this probe.
    }
  });
}
