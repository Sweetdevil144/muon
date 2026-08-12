import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { terminateLanePtyChildren } from "@muon/adapters";

export type RunnerParentGuardOptions = {
  /** Child fd 3 is a pipe owned by Electron main. */
  createPipe?: () => Readable;
  onParentGone: () => void;
};

export type ParentLossRuntime = {
  /**
   * Reap the pty children FIRST. Every other runner descendant is inside the
   * runner's process group and dies with `signalTree`/`forceTree`; a node-pty
   * child is not — it calls setsid() and leads its own group, so on an
   * Electron crash a `danger-full-access` vendor child would otherwise survive
   * both sweeps and keep editing the worktree with nothing observing it.
   */
  killPtyChildren(): void;
  signalTree(): void;
  scheduleForce(callback: () => void, deadlineMs: number): void;
  forceTree(): void;
};

export type ParentLossHandlerOptions = {
  deadlineMs?: number;
  runtime?: ParentLossRuntime;
};

const processParentLossRuntime: ParentLossRuntime = {
  killPtyChildren() {
    try {
      terminateLanePtyChildren();
    } catch {
      // Never block the drain on the reaper; the group sweeps still run.
    }
  },
  signalTree() {
    try {
      // Parent loss is different from a normal runner stop: Electron cannot
      // supervise descendants anymore, so begin a graceful GROUP drain.
      process.kill(-process.pid, "SIGTERM");
    } catch {
      process.kill(process.pid, "SIGTERM");
    }
  },
  scheduleForce(callback, deadlineMs) {
    // Keep this authoritative. If the runner drains before an untracked vendor
    // descendant, an unref'ed timer would disappear with the runner and leave
    // the child orphaned forever.
    setTimeout(callback, deadlineMs);
  },
  forceTree() {
    try {
      // The desktop runner is detached and leads its own process group. Kill
      // the runner plus any vendor descendants that failed to drain.
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  },
};

/** Graceful parent-loss drain with a hard process-group deadline. */
export function createParentLossHandler(
  options: ParentLossHandlerOptions = {}
): () => void {
  const runtime = options.runtime ?? processParentLossRuntime;
  const deadlineMs = Math.max(1000, options.deadlineMs ?? 10_000);
  let started = false;
  return () => {
    if (started) return;
    started = true;
    // Ordered deliberately: the pty children are signalled BEFORE the group
    // drain, because `forceTree` may SIGKILL this process out from under any
    // later step, and these children are the only ones that would survive it.
    runtime.killPtyChildren();
    runtime.scheduleForce(() => {
      runtime.killPtyChildren();
      runtime.forceTree();
    }, deadlineMs);
    runtime.signalTree();
  };
}

/**
 * Drain the detached runner when Electron disappears, including a hard crash.
 * The OS closes the inherited pipe when the parent process dies; no PID polling
 * or reusable process identity is involved.
 */
export function watchRunnerParent(
  options: RunnerParentGuardOptions
): () => void {
  const pipe =
    options.createPipe ??
    (() => createReadStream("", { fd: 3, autoClose: true }));
  const stream = pipe();
  let settled = false;

  const cleanup = () => {
    stream.removeListener("end", onGone);
    stream.removeListener("close", onGone);
    stream.removeListener("error", onUnavailable);
  };
  const onGone = () => {
    if (settled) return;
    settled = true;
    cleanup();
    options.onParentGone();
  };
  const onUnavailable = () => {
    // Direct/debug launches may not inherit fd 3. Keep the runner usable; the
    // host lease still fences duplicates, just without parent-death acceleration.
    if (settled) return;
    settled = true;
    cleanup();
  };

  stream.once("end", onGone);
  stream.once("close", onGone);
  stream.once("error", onUnavailable);
  stream.resume();

  return () => {
    settled = true;
    cleanup();
    stream.destroy();
  };
}
