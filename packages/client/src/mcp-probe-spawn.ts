/**
 * Ask a running MUON MCP server what it serves.
 *
 * The I/O half of `@muon/client/mcp-probe` — deliberately thin, because
 * everything worth arguing about (what counts as stale, what an unreachable
 * server means) lives in the pure comparison next to it. This function's only
 * job is to get a `tools/list` answer out of a real process, or to return
 * `null` and let the comparison call that an unknown.
 *
 * It speaks the handshake by hand rather than pulling in an MCP client: the
 * dependency exists to CALL tools, and every extra layer between "what does the
 * process serve" and the answer is a place the answer could come from
 * somewhere other than the process.
 *
 * It lives in @muon/client rather than in the CLI because the desk probes too
 * (surface-parity item 5). Two spawns, two handshakes, two timeout policies
 * would mean the desk and `muon mcp probe` could disagree about what the same
 * server serves — and this measurement exists precisely to settle that kind of
 * disagreement. NODE-SIDE ONLY: the desktop calls it from main, never from the
 * renderer.
 */

import { spawn } from "node:child_process";

export type McpProbeOutcome = {
  /** Tool names the server listed, or null when it never answered. */
  readonly toolNames: readonly string[] | null;
  /** Present only on failure — why there is no answer. */
  readonly failure?: string;
  /** Anything the server said on stderr, kept for the operator. */
  readonly stderr: string;
};

const PROTOCOL_VERSION = "2024-11-05";

/**
 * Spawn, handshake, list, kill.
 *
 * The server is started with the SAME command the vendor config points at, so
 * this measures the binary an agent would actually get rather than the one this
 * CLI was built beside — the entire point of probing.
 */
export async function probeMcpToolNames(options: {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<McpProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return await new Promise<McpProbeOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env ?? process.env,
      });
    } catch (error) {
      resolve({
        toolNames: null,
        failure: `could not start ${options.command}: ${String(error)}`,
        stderr: "",
      });
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";

    // One exit path, so a late timer cannot resolve after a real answer and a
    // failure cannot leave the child running.
    const finish = (outcome: Omit<McpProbeOutcome, "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ ...outcome, stderr: stderr.trim() });
    };

    const timer = setTimeout(() => {
      finish({
        toolNames: null,
        failure: `the server did not answer tools/list within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      finish({ toolNames: null, failure: `spawn failed: ${String(error)}` });
    });
    child.on("exit", (code, signal) => {
      finish({
        toolNames: null,
        failure: `the server exited (code ${code}, signal ${signal}) before listing its tools`,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Line-delimited JSON-RPC. A frame can arrive split across reads or two
      // to a read, so drain whole lines and keep the remainder.
      for (;;) {
        const cut = stdout.indexOf("\n");
        if (cut === -1) break;
        const line = stdout.slice(0, cut);
        stdout = stdout.slice(cut + 1);
        if (line.trim() === "") continue;
        let message: { id?: unknown; result?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue; // not our frame — a stray log line on stdout
        }
        if (message.id === 1) {
          write(child, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          });
          write(child, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          });
          continue;
        }
        if (message.id === 2) {
          const tools = (message.result as { tools?: { name?: unknown }[] })
            ?.tools;
          if (!Array.isArray(tools)) {
            finish({
              toolNames: null,
              failure: "the server answered tools/list without a tool array",
            });
            return;
          }
          finish({
            toolNames: tools
              .map((tool) => tool?.name)
              .filter((name): name is string => typeof name === "string"),
          });
          return;
        }
      }
    });

    write(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "muon-mcp-probe", version: "1" },
      },
    });
  });
}

function write(
  child: ReturnType<typeof spawn>,
  message: Record<string, unknown>
): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}
