import type { MuonApiClient } from "@muon/client";
import { terminateLanePtyChildren, type LanePtySpawn } from "@muon/core";
import { runRunnerLoop } from "./loop.js";

type RunnerHostSignal = "SIGINT" | "SIGTERM";

export type RunnerHostRuntime = {
  pid: number;
  onSignal(signal: RunnerHostSignal, handler: () => void): void;
  offSignal(signal: RunnerHostSignal, handler: () => void): void;
  forceExit(code: number): void;
};

export type RunnerHostOptions = {
  client: MuonApiClient;
  host: string;
  apiBase: string;
  apiToken?: string;
  /** Operator-authorized, per-launch runner capability. */
  leaseToken?: string;
  concurrency?: number;
  pollMs?: number;
  confined: boolean;
  output?: (line: string) => void;
  runtime?: RunnerHostRuntime;
  runLoop?: typeof runRunnerLoop;
  /** REAL-terminal factory for one-shot vendor children (see RunnerLoopOptions). */
  ptySpawn?: LanePtySpawn;
  /**
   * Reap every live pty child, group and all. Defaults to the lane runner's
   * own registry; injectable so a test can assert the teardown ORDER without
   * spawning real terminals.
   */
  terminatePtyChildren?: () => void;
};

const processRuntime: RunnerHostRuntime = {
  pid: process.pid,
  onSignal(signal, handler) {
    process.on(signal, handler);
  },
  offSignal(signal, handler) {
    process.off(signal, handler);
  },
  forceExit(code) {
    process.exit(code);
  },
};

/**
 * Own the process-facing lifecycle around the persistent runner loop.
 *
 * Callers retain responsibility for resolving the loopback URL and AGENT-tier
 * token. This host only reports confinement honestly, installs bounded drain
 * handlers, and passes those coordinates through to the runner unchanged.
 */
export async function runRunnerHost(options: RunnerHostOptions): Promise<void> {
  const runtime = options.runtime ?? processRuntime;
  const runLoop = options.runLoop ?? runRunnerLoop;
  const terminatePtyChildren =
    options.terminatePtyChildren ?? terminateLanePtyChildren;
  const output =
    options.output ?? ((line: string) => process.stdout.write(`${line}\n`));

  output(
    `[runner] host=${options.host} tier=agent sandbox=${
      options.confined ? "on" : "off"
    }`
  );
  if (options.confined && !options.apiToken) {
    output(
      "[runner] WARN: no agent token (MUON_AGENT_TOKEN unset / pre-P3-A lockfile), sandboxed runner cannot authenticate; restart the brain to mint one"
    );
  }

  const controller = new AbortController();
  let draining = false;
  const shutdown = () => {
    if (draining) {
      // Force quit: nothing else will run, so the pty children must be
      // reaped HERE. They are setsid'd (own process group), so the group
      // sweeps that reap every other runner child cannot see them.
      terminatePtyChildren();
      runtime.forceExit(0);
      return;
    }
    draining = true;
    output("\n[runner] draining, Ctrl-C again to force quit");
    // Signalled at the START of the drain, not after it: a vendor child gets
    // its SIGTERM grace while the loop unwinds, instead of being orphaned if
    // the drain itself is interrupted.
    terminatePtyChildren();
    controller.abort();
  };

  runtime.onSignal("SIGINT", shutdown);
  runtime.onSignal("SIGTERM", shutdown);

  try {
    await runLoop(options.client, {
      host: options.host,
      pid: runtime.pid,
      apiBase: options.apiBase,
      apiToken: options.apiToken,
      leaseToken: options.leaseToken,
      concurrency: options.concurrency,
      pollMs: options.pollMs,
      signal: controller.signal,
      onLog: (line) => output(`[runner] ${line}`),
      ...(options.ptySpawn ? { ptySpawn: options.ptySpawn } : {}),
    });
  } finally {
    runtime.offSignal("SIGINT", shutdown);
    runtime.offSignal("SIGTERM", shutdown);
  }
}
