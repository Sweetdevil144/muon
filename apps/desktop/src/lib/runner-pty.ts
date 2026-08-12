import type { LanePtySpawn } from "@muon/core";

// The RUNNER-side real-terminal factory. The desktop app owns the node-pty
// dependency (the runner package deliberately does not), so the runner entry
// loads it HERE and injects it down through RunnerHostOptions → executeJob.
// node-pty ≥1.x is N-API based, so the same prebuilt binary loads under
// Electron-as-node without an ABI rebuild (verified live on Electron 39).
//
// Failure is a stated downgrade, never a crash: with no loadable pty the
// runner keeps spawning on pipes exactly as before.
//
// WHAT THE DOWNGRADE ACTUALLY COSTS THE VIEW — stated here because the log
// line below used to claim something else. Losing the pty does NOT take the
// live pane away: `onBytes` is wired on the PIPE leg of `runLaneCommand` too,
// so a console is still published and `ptySessionId` is still stamped. What
// changes is the RENDERING. The desktop pins a `prefersPtyConsole` lane's
// pane to the source pty's fixed grid (renderer/lib/agent-console-grid.ts),
// and that table is keyed on the VENDOR rather than on the transport this run
// actually got — so pipe output, which has no fixed geometry at all, is
// replayed against a 120-column grid and long lines hard-wrap where nothing
// wrapped them. See docs/adr/0025 §4 for the defect and why the fix is a
// wire-level fact rather than a guess in the viewer.

/** The node-pty subset this factory drives (kept local, loaded at call time). */
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
    /** node-pty setsids, so this pid is also the child's process-GROUP id. */
    pid: number;
    onData(listener: (data: string) => void): unknown;
    onExit(
      listener: (event: { exitCode: number; signal?: number }) => void
    ): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
};

/** Build a LanePtySpawn from an already-loaded node-pty module (unit-testable). */
export function runnerPtySpawnFromModule(nodePty: NodePtyModule): LanePtySpawn {
  return (options) => {
    const child = nodePty.spawn(options.file, [...options.args], {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { ...options.env },
    });
    return {
      // Forwarded so the lane runner can signal the child's own group; without
      // it a setsid'd vendor child survives every teardown MUON performs.
      pid: child.pid,
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: (signal) => child.kill(signal),
      onData: (listener) => {
        child.onData(listener);
      },
      onExit: (listener) => {
        child.onExit(({ exitCode, signal }) =>
          listener({
            exitCode,
            ...(signal !== undefined ? { signal } : {}),
          })
        );
      },
    };
  };
}

/**
 * Lazy-load node-pty and return the factory, or null (with the reason logged)
 * when the native module cannot load in this runtime.
 */
export async function loadRunnerPtySpawn(
  log: (line: string) => void
): Promise<LanePtySpawn | null> {
  try {
    const nodePty = (await import("node-pty")) as unknown as NodePtyModule;
    return runnerPtySpawnFromModule(nodePty);
  } catch (error) {
    log(
      `real vendor terminal unavailable (node-pty failed to load: ${
        error instanceof Error ? error.message : String(error)
      }); one-shot vendor children run on pipes. The live pane still fills — it does NOT fall back to the recorded stream — but a lane whose viewer pins the source terminal's grid will render that pipe output at a fixed width it never had`
    );
    return null;
  }
}
