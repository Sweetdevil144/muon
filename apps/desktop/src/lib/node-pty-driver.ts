import type { PtyDriver, PtySpawnOptions } from "@muon/runner";

// Wave 4 / Founder Decision D1 (P5) — the PRODUCTION PtyDriver, backed by
// node-pty. It is a THIN adapter: node-pty's IPty maps 1:1 onto the PtyDriver
// contract the tested PtyHost/relay already drive, so swapping the fake echo
// driver for this changes NOTHING upstream. node-pty is a NATIVE module — its
// binary must be rebuilt for the Electron ABI and unpacked from the asar in a
// notarized build (the packaging spike that needs macOS hardware). So this module
// is LAZY-loaded (createNodePtyDriverAsync) only when the real terminal is
// enabled; the default echo path — and every test — never touches it.

/** The subset of node-pty's spawn we depend on (kept local so this file only
 *  pulls the native module at call time, never at import time). */
type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      env?: Record<string, string>;
    }
  ): {
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    pause(): void;
    resume(): void;
    kill(signal?: string): void;
  };
};

function toDriver(pty: ReturnType<NodePtyModule["spawn"]>): PtyDriver {
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(({ exitCode, signal }) =>
        listener({ exitCode, ...(signal !== undefined ? { signal } : {}) })
      );
    },
    kill: (signal) => pty.kill(signal),
  };
}

/** Build a PtyDriver from an already-loaded node-pty module (unit-testable). */
export function createNodePtyDriver(
  nodePty: NodePtyModule,
  options: PtySpawnOptions
): PtyDriver {
  const pty = nodePty.spawn(options.file, [...(options.args ?? [])], {
    name: "xterm-256color",
    cwd: options.cwd,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    ...(options.env ? { env: { ...options.env } } : {}),
  });
  return toDriver(pty);
}

/** Lazy-load node-pty and spawn. Only reached when the real terminal is enabled;
 *  a load failure (native binary not rebuilt for this Electron) surfaces as a
 *  clear error rather than crashing at import. */
export async function createNodePtyDriverAsync(
  options: PtySpawnOptions
): Promise<PtyDriver> {
  const nodePty = (await import("node-pty")) as unknown as NodePtyModule;
  return createNodePtyDriver(nodePty, options);
}
