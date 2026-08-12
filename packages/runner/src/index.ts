export { executeJob } from "./execute.js";
export type { ExecuteOptions, ExecuteResult } from "./execute.js";
// The stall-watchdog windows and the one place that chooses between them.
// Exported so the crew-liveness mirror (packages/client) can be drift-locked
// against the runner that actually owns the timer.
export {
  DEFAULT_ORCHESTRATOR_POST_OUTPUT_STALL_MS,
  DEFAULT_ORCHESTRATOR_STARTUP_STALL_MS,
  DEFAULT_POST_OUTPUT_STALL_MS,
  DEFAULT_STARTUP_STALL_MS,
  resolveStallWindows,
} from "./execute.js";
export { runRunnerHost } from "./host.js";
export type { RunnerHostOptions, RunnerHostRuntime } from "./host.js";
export { runRunnerLoop } from "./loop.js";
export type { RunnerLoopOptions } from "./loop.js";
// Wave 4 slice 5.0: the PTY host (design §2.5). node-pty itself is intentionally
// NOT wired here — the production driver + its packaging land after the D1 spike.
export { PtyHost } from "./pty/pty-host.js";
export type {
  PtyFrame,
  PtyConsumer,
  PtyExitEvent,
  PtyHostOptions,
} from "./pty/pty-host.js";
// The LIVE TERMINAL of a dispatched job (read-only byte relay; see the header
// of job-terminal.ts for why this is not a pseudo-terminal).
export {
  JobTerminalHost,
  JobTerminalSession,
  JOB_TERMINAL_SESSION_PREFIX,
  jobTerminalSessionId,
  jobIdFromTerminalSessionId,
  newJobTerminalEpoch,
} from "./pty/job-terminal.js";
export type {
  JobTerminalFrame,
  JobTerminalHostOptions,
  JobTerminalSink,
  JobTerminalStream,
} from "./pty/job-terminal.js";
export { FakePtyDriver } from "./pty/pty-driver.js";
export type {
  PtyDriver,
  PtyDriverFactory,
  PtyExit,
  PtySpawnOptions,
} from "./pty/pty-driver.js";
