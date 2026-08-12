import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  sandboxRequiredByEnv,
  sandboxedRunnerEnv,
  selectSandboxLauncher,
  type SandboxLauncher,
} from "@muon/adapters";
import { authorizeRunnerLease } from "@muon/client";
import { createLogSink, logMaxBytesFromEnv } from "./log-sink.js";
import {
  resolveRunnerEntry,
  type RunnerEntry,
} from "./runner-entry-config.js";
import { probeRunnerHost } from "./runner-probe.js";

// Desktop-side supervisor for the persistent runner (ADR-0010 Part A / F-1).
//
// The detached process is agent-token-only and sandbox-blinded to brain.lock.
// Its process existence is not treated as proof of health: startup becomes live
// only after this exact host appears in the brain's heartbeat ledger.

export type { RunnerEntry };

export type RunnerCoords = {
  /** Loopback base of the embedded brain. */
  apiBase: string;
  /** AGENT-tier token, the ONLY token handed to the runner (never operator). */
  agentToken?: string;
  /** OPERATOR token stays in trusted Electron main and only authorizes launch. */
  operatorToken?: string;
  /**
   * Full-Auto active: threads MUON_FULL_AUTO into the detached runner so workers
   * receive the FULL-AUTO safety block. Reversible — a restart with this false
   * (or unset) respawns the runner without the env var.
   */
  fullAuto?: boolean;
};

export type RunnerSupervisorPhase =
  | "stopped"
  | "starting"
  | "live"
  | "backoff"
  | "degraded";

export type RunnerSupervisorStatus = {
  phase: RunnerSupervisorPhase;
  host: string;
  sandboxed: boolean;
  restartAttempt: number;
  note?: string;
};

export type RunnerSupervisorOptions = {
  /** Per-user data dir the runner is BLINDED to under the sandbox. */
  dataDir: string;
  /** Runner host label, kept distinct from a CLI runner's (one-per-host). */
  host: string;
  /** Directory for the detached runner's log file. */
  logDir: string;
  onLog?: (line: string) => void;
  /**
   * Debug mode only: mirror the runner's raw stdout/stderr to the launching
   * terminal. Undefined in normal runs — runner.log stays the only destination.
   */
  teeToTerminal?: (chunk: string) => void;
  // --- injectable seams (tests / packaging) ---
  execPath?: string;
  spawn?: typeof nodeSpawn;
  launcher?: SandboxLauncher;
  resolveEntry?: () => RunnerEntry | undefined;
  probeLive?: (
    coords: RunnerCoords,
    host: string,
    pid: number
  ) => Promise<boolean>;
  authorizeLease?: (
    coords: RunnerCoords,
    host: string,
    leaseToken: string
  ) => Promise<void>;
  /** Signal the detached runner process group (runner + vendor descendants). */
  signalProcessGroup?: (
    pid: number,
    signal: NodeJS.Signals
  ) => boolean;
  /** Deprecated shared seam; specific delays below take precedence. */
  delay?: (ms: number) => Promise<void>;
  pollDelay?: (ms: number) => Promise<void>;
  restartDelay?: (ms: number) => Promise<void>;
  terminationDelay?: (ms: number) => Promise<void>;
  watchdogDelay?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  startupTimeoutMs?: number;
  startupPollMs?: number;
  maxRestartAttempts?: number;
  restartBaseMs?: number;
  restartCapMs?: number;
  watchdogIntervalMs?: number;
  watchdogMissLimit?: number;
  /** A live run this old resets the automatic crash budget. */
  restartStableMs?: number;
};

export type RunnerStartResult = {
  started: boolean;
  live: boolean;
  sandboxed: boolean;
  note?: string;
};

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RunnerSupervisor {
  private child: ChildProcess | null = null;
  private coords: RunnerCoords | null = null;
  private sandboxed = false;
  private stopped = true;
  private generation = 0;
  private consecutiveFailures = 0;
  private scheduledGeneration: number | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly parentPipes = new WeakMap<
    ChildProcess,
    { unref?: () => void; destroy?: () => void }
  >();
  private readonly liveSince = new WeakMap<ChildProcess, number>();
  private status: RunnerSupervisorStatus;
  private readonly spawn: typeof nodeSpawn;
  private readonly launcher: SandboxLauncher;
  private readonly execPath: string;
  private readonly probeLive: (
    coords: RunnerCoords,
    host: string,
    pid: number
  ) => Promise<boolean>;
  private readonly signalProcessGroup: (
    pid: number,
    signal: NodeJS.Signals
  ) => boolean;
  private readonly authorizeLease: (
    coords: RunnerCoords,
    host: string,
    leaseToken: string
  ) => Promise<void>;
  private readonly pollDelay: (ms: number) => Promise<void>;
  private readonly restartDelay: (ms: number) => Promise<void>;
  private readonly terminationDelay: (ms: number) => Promise<void>;
  private readonly watchdogDelay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly startupTimeoutMs: number;
  private readonly startupPollMs: number;
  private readonly maxRestartAttempts: number;
  private readonly restartBaseMs: number;
  private readonly restartCapMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly watchdogMissLimit: number;
  private readonly restartStableMs: number;

  constructor(private readonly options: RunnerSupervisorOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.launcher = options.launcher ?? selectSandboxLauncher();
    this.execPath = options.execPath ?? process.execPath;
    this.probeLive = options.probeLive ?? probeRunnerHost;
    this.authorizeLease =
      options.authorizeLease ??
      ((coords, host, leaseToken) =>
        authorizeRunnerLease(
          {
            apiBase: coords.apiBase,
            operatorToken: coords.operatorToken,
          },
          host,
          leaseToken
        ));
    this.signalProcessGroup =
      options.signalProcessGroup ??
      ((pid, signal) => {
        try {
          process.kill(-pid, signal);
          return true;
        } catch {
          return false;
        }
      });
    const sharedDelay = options.delay ?? defaultDelay;
    this.pollDelay = options.pollDelay ?? sharedDelay;
    this.restartDelay = options.restartDelay ?? sharedDelay;
    this.terminationDelay = options.terminationDelay ?? sharedDelay;
    this.watchdogDelay = options.watchdogDelay ?? sharedDelay;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.startupTimeoutMs = Math.max(0, options.startupTimeoutMs ?? 10_000);
    this.startupPollMs = Math.max(50, options.startupPollMs ?? 250);
    this.maxRestartAttempts = Math.max(0, options.maxRestartAttempts ?? 6);
    this.restartBaseMs = Math.max(100, options.restartBaseMs ?? 1000);
    this.restartCapMs = Math.max(
      this.restartBaseMs,
      options.restartCapMs ?? 30_000
    );
    this.watchdogIntervalMs = Math.max(
      250,
      options.watchdogIntervalMs ?? 5000
    );
    this.watchdogMissLimit = Math.max(1, options.watchdogMissLimit ?? 2);
    this.restartStableMs = Math.max(1000, options.restartStableMs ?? 60_000);
    this.status = {
      phase: "stopped",
      host: options.host,
      sandboxed: false,
      restartAttempt: 0,
    };
  }

  /** A supervised runner child is currently alive (not proof of heartbeat). */
  isRunning(): boolean {
    // `ChildProcess.killed` means a signal was sent, not that the OS process has
    // exited. Keep treating it as owned until the exit event clears `child`.
    return this.child != null;
  }

  /** Immutable snapshot for IPC/operator diagnostics. */
  getStatus(): RunnerSupervisorStatus {
    return { ...this.status };
  }

  /**
   * Spawn the detached agent-tier runner. Resolve only after this exact host has
   * heartbeated, so another CLI runner cannot create a false-positive startup.
   */
  async start(coords: RunnerCoords): Promise<RunnerStartResult> {
    if (this.isRunning()) {
      return {
        started: false,
        live: this.status.phase === "live",
        sandboxed: this.sandboxed,
        note: this.status.note,
      };
    }
    this.stopped = false;
    this.coords = { ...coords };
    this.consecutiveFailures = 0;
    this.scheduledGeneration = null;
    const generation = ++this.generation;
    return this.enqueueOperation(async () => {
      if (this.stopped || generation !== this.generation || !this.coords) {
        return this.supersededResult();
      }
      if (this.isRunning()) {
        return {
          started: false,
          live: this.status.phase === "live",
          sandboxed: this.sandboxed,
          note: this.status.note,
        };
      }
      return this.launch(this.coords, generation);
    });
  }

  /**
   * SIGTERM the runner and wait (bounded) for it to drain. A stale delayed retry
   * is invalidated by the generation change and cannot resurrect the process.
   */
  async stop(deadlineMs = 6000): Promise<void> {
    // Publish the stop intent synchronously so an already-running restart or
    // delayed backoff observes it before it can spawn.
    this.stopped = true;
    this.coords = null;
    this.scheduledGeneration = null;
    this.consecutiveFailures = 0;
    ++this.generation;
    return this.enqueueOperation(async () => {
      await this.stopCurrentChild(deadlineMs, true);
    });
  }

  /** Re-point the runner at new brain coords: drain the old, then start fresh. */
  async restart(coords: RunnerCoords): Promise<RunnerStartResult> {
    this.stopped = false;
    this.coords = { ...coords };
    this.scheduledGeneration = null;
    this.consecutiveFailures = 0;
    const generation = ++this.generation;
    return this.enqueueOperation(async () => {
      const terminated = await this.stopCurrentChild(6000, false);
      if (!terminated) {
        return {
          started: false,
          live: false,
          sandboxed: this.sandboxed,
          note: this.status.note,
        };
      }
      if (this.stopped || generation !== this.generation || !this.coords) {
        return this.supersededResult();
      }
      return this.launch(this.coords, generation);
    });
  }

  private async stopCurrentChild(
    deadlineMs: number,
    markStopped: boolean
  ): Promise<boolean> {
    const child = this.child;
    if (markStopped) {
      this.setStatus("stopped", {
        sandboxed: this.sandboxed,
        restartAttempt: 0,
      });
    }
    if (!child) return true;

    const terminated = await this.terminateChild(child, deadlineMs);
    if (terminated) {
      if (this.child === child) this.child = null;
    } else {
      const note =
        "runner did not confirm exit after SIGTERM/SIGKILL; refusing to replace it";
      this.options.onLog?.(note);
      this.setStatus("degraded", {
        sandboxed: this.sandboxed,
        restartAttempt: 0,
        note,
      });
    }
    return terminated;
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private supersededResult(): RunnerStartResult {
    return {
      started: false,
      live: false,
      sandboxed: this.sandboxed,
      note: "runner start superseded",
    };
  }

  private async launch(
    coords: RunnerCoords,
    generation: number
  ): Promise<RunnerStartResult> {
    try {
      return await this.launchAttempt(coords, generation);
    } catch (error) {
      const note = `runner launch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.options.onLog?.(note);
      if (!this.stopped && generation === this.generation) {
        this.scheduleRestart(note, coords, generation);
      } else {
        this.setStatus("degraded", {
          sandboxed: this.sandboxed,
          restartAttempt: this.consecutiveFailures,
          note,
        });
      }
      return {
        started: false,
        live: false,
        sandboxed: this.sandboxed,
        note,
      };
    }
  }

  private async launchAttempt(
    coords: RunnerCoords,
    generation: number
  ): Promise<RunnerStartResult> {
    if (this.stopped || generation !== this.generation) {
      return {
        started: false,
        live: false,
        sandboxed: this.sandboxed,
        note: "runner start superseded",
      };
    }

    const entry = (
      this.options.resolveEntry ??
      (() => resolveRunnerEntry({ moduleDir: __dirname }))
    )();
    if (!entry) {
      const note =
        "desktop runner entry not found (set MUON_RUNNER_ENTRY; MUON_CLI_ENTRY remains a legacy fallback)";
      this.options.onLog?.(note);
      this.setStatus("degraded", {
        sandboxed: false,
        restartAttempt: this.consecutiveFailures,
        note,
      });
      return { started: false, live: false, sandboxed: false, note };
    }

    mkdirSync(this.options.logDir, { recursive: true });
    const runnerArgs =
      entry.kind === "desktop"
        ? [entry.path]
        : [
            entry.path,
            "runner",
            "--host",
            this.options.host,
            "--api-base",
            coords.apiBase,
          ];
    const wrapped = this.launcher.wrap(this.execPath, runnerArgs, {
      dataDir: this.options.dataDir,
    });

    if (!wrapped.sandboxed && sandboxRequiredByEnv()) {
      const note =
        "sandbox required but unavailable (MUON_REQUIRE_SANDBOX=1)";
      this.options.onLog?.(
        "MUON_REQUIRE_SANDBOX=1 but sandbox confinement is unavailable, refusing to start an UNSANDBOXED runner"
      );
      this.setStatus("degraded", {
        sandboxed: false,
        restartAttempt: this.consecutiveFailures,
        note,
      });
      return { started: false, live: false, sandboxed: false, note };
    }

    const leaseToken = randomBytes(32).toString("hex");
    await this.authorizeLease(coords, this.options.host, leaseToken);

    const env = sandboxedRunnerEnv({
      apiBase: coords.apiBase,
      agentToken: coords.agentToken,
      leaseToken,
      sandboxed: wrapped.sandboxed,
      fullAuto: coords.fullAuto,
      parentEnv: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MUON_RUNNER_HOST: this.options.host,
        // The brain child already receives this exact value (brain.ts). The
        // runner must resolve the SAME profile, or `managedWorktreesRoot`
        // splits between the process that creates a task tree (runner) and the
        // process that validates it (brain) — the backend then 400s every
        // execution-path record for a worktree job.
        MUON_DATA_DIR: this.options.dataDir,
      },
    });

    let child: ChildProcess;
    // Size-capped + rotating (see log-sink.ts); `tee` is set only in debug mode,
    // where the runner's output is also mirrored to the launching terminal.
    const out = createLogSink({
      file: path.join(this.options.logDir, "runner.log"),
      maxBytes: logMaxBytesFromEnv(),
      tee: this.options.teeToTerminal,
    });
    // Log loss is diagnostics loss, not runner-health evidence.
    out.on("error", () => undefined);
    try {
      child = this.spawn(wrapped.command, wrapped.args, {
        detached: true,
        // The confined child gets pipes—not inherited file descriptors inside
        // the denied data dir. Electron-as-node inspects stdio during ICU/Node
        // bootstrap; an inherited runner.log fd there aborts before JS starts.
        // Trusted Electron main forwards these pipes into the private log.
        // fd 3 is a parent-death pipe. If Electron crashes, the OS closes it and
        // the runner drains itself instead of surviving as an unowned process.
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      out.destroy();
      const note = `runner spawn failed: ${
        error instanceof Error ? error.message : error
      }`;
      this.options.onLog?.(note);
      this.setStatus("backoff", {
        sandboxed: wrapped.sandboxed,
        restartAttempt: this.consecutiveFailures,
        note,
      });
      this.scheduleRestart(note, coords, generation);
      return {
        started: false,
        live: false,
        sandboxed: wrapped.sandboxed,
        note,
      };
    }

    let logClosed = false;
    const closeLog = () => {
      if (logClosed) return;
      logClosed = true;
      out.end();
    };
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });

    this.child = child;
    this.sandboxed = wrapped.sandboxed;
    this.setStatus("starting", {
      sandboxed: wrapped.sandboxed,
      restartAttempt: this.consecutiveFailures,
    });
    child.on("error", (error) => {
      // ChildProcess "error" is not exit evidence: it can represent a failed
      // signal/send after a perfectly live spawn. Keep ownership until the OS
      // emits "exit"; replacing it here would create two runners.
      this.options.onLog?.(
        `runner process error (awaiting exit confirmation): ${error.message}`
      );
    });
    child.on("exit", (code, signal) => {
      closeLog();
      const outcome =
        code === null
          ? `signal ${signal ?? "unknown"}`
          : `code ${String(code)}`;
      this.handleExit(child, generation, outcome);
    });
    const parentPipe = child.stdio[3] as
      | (NodeJS.ReadableStream & {
          unref?: () => void;
          destroy?: () => void;
        })
      | null;
    if (parentPipe) {
      this.parentPipes.set(child, parentPipe);
    }
    parentPipe?.unref?.();
    child.unref();

    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      const note =
        "runner spawn returned no positive PID; refusing heartbeat confirmation";
      this.options.onLog?.(note);
      await this.terminateChild(child, 750);
      if (this.child === child) this.child = null;
      this.setStatus("degraded", {
        sandboxed: wrapped.sandboxed,
        restartAttempt: this.consecutiveFailures,
        note,
      });
      return {
        started: false,
        live: false,
        sandboxed: wrapped.sandboxed,
        note,
      };
    }

    const live = await this.waitForHeartbeat(
      child,
      pid,
      coords,
      generation
    );
    if (
      live &&
      !this.stopped &&
      generation === this.generation &&
      this.child === child
    ) {
      this.liveSince.set(child, this.now());
      this.setStatus("live", {
        sandboxed: wrapped.sandboxed,
        restartAttempt: 0,
      });
      this.options.onLog?.(
        `runner live (host=${this.options.host} sandbox=${
          wrapped.sandboxed ? "on" : "off"
        })`
      );
      this.startWatchdog(child, pid, coords, generation);
      return {
        started: true,
        live: true,
        sandboxed: wrapped.sandboxed,
      };
    }

    if (this.child === child) {
      const terminated = await this.terminateChild(child, 750);
      if (!terminated) {
        const note =
          "could not confirm the stale runner terminated; refusing to spawn a replacement";
        this.options.onLog?.(note);
        this.setStatus("degraded", {
          sandboxed: wrapped.sandboxed,
          restartAttempt: this.consecutiveFailures,
          note,
        });
        return {
          started: false,
          live: false,
          sandboxed: wrapped.sandboxed,
          note,
        };
      }
      if (this.child === child) this.child = null;
    }
    if (!this.stopped && generation === this.generation) {
      const note = "runner exited or missed its host heartbeat during startup";
      this.options.onLog?.(note);
      this.scheduleRestart(note, coords, generation);
      return {
        started: false,
        live: false,
        sandboxed: wrapped.sandboxed,
        note,
      };
    }
    return {
      started: false,
      live: false,
      sandboxed: wrapped.sandboxed,
      note: "runner start superseded",
    };
  }

  private async waitForHeartbeat(
    child: ChildProcess,
    pid: number,
    coords: RunnerCoords,
    generation: number
  ): Promise<boolean> {
    const deadline = this.now() + this.startupTimeoutMs;
    while (
      !this.stopped &&
      generation === this.generation &&
      this.child === child &&
      !child.killed
    ) {
      if (
        await this.probeLive(
          coords,
          this.options.host,
          pid
        ).catch(() => false)
      ) {
        return true;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      await this.pollDelay(Math.min(this.startupPollMs, remaining));
    }
    return false;
  }

  private handleExit(
    child: ChildProcess,
    generation: number,
    outcome: string
  ): void {
    if (this.child !== child) return;
    this.child = null;
    const parentPipe = this.parentPipes.get(child);
    this.parentPipes.delete(child);
    // The child is already gone, so closing our fd-3 endpoint cannot generate
    // a second parent-loss signal inside it.
    parentPipe?.destroy?.();
    const liveAt = this.liveSince.get(child);
    this.liveSince.delete(child);
    if (
      liveAt !== undefined &&
      this.now() - liveAt >= this.restartStableMs
    ) {
      this.consecutiveFailures = 0;
    }
    this.options.onLog?.(`runner exited (${outcome})`);
    if (
      this.stopped ||
      generation !== this.generation ||
      this.status.phase !== "live"
    ) {
      return;
    }
    // The runner process may have died before it could reap a vendor CLI.
    // Its detached process-group id remains addressable while descendants are
    // alive, so fence the old generation before launching a replacement.
    const pid = child.pid;
    if (Number.isInteger(pid) && (pid ?? 0) > 0) {
      this.signalProcessGroup(pid as number, "SIGKILL");
    }
    const coords = this.coords;
    if (coords) {
      this.scheduleRestart(
        `runner exited unexpectedly (${outcome})`,
        coords,
        generation
      );
    }
  }

  /** Recover an alive-but-wedged child whose exact PID stops heartbeating. */
  private startWatchdog(
    child: ChildProcess,
    pid: number,
    coords: RunnerCoords,
    generation: number
  ): void {
    void (async () => {
      let misses = 0;
      while (
        !this.stopped &&
        generation === this.generation &&
        this.child === child &&
        this.status.phase === "live"
      ) {
        await this.watchdogDelay(this.watchdogIntervalMs);
        if (
          this.stopped ||
          generation !== this.generation ||
          this.child !== child ||
          this.status.phase !== "live"
        ) {
          return;
        }
        let live: boolean;
        try {
          live = await this.probeLive(
            coords,
            this.options.host,
            pid
          );
        } catch (error) {
          // Brain/auth/transport availability is not evidence the child died.
          // Reset stale evidence and preserve active vendor work.
          misses = 0;
          this.options.onLog?.(
            `runner watchdog could not reach the brain: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          continue;
        }
        if (live) {
          misses = 0;
          continue;
        }
        misses += 1;
        if (misses < this.watchdogMissLimit) continue;

        const reason = `runner heartbeat stale for ${misses} watchdog checks`;
        const terminated = await this.terminateChild(child, 750);
        if (!terminated) {
          this.setStatus("degraded", {
            sandboxed: this.sandboxed,
            restartAttempt: this.consecutiveFailures,
            note: `${reason}; could not confirm the child terminated`,
          });
          return;
        }
        if (this.child === child) this.child = null;
        if (!this.stopped && generation === this.generation) {
          this.scheduleRestart(reason, coords, generation);
        }
        return;
      }
    })().catch((error) => {
      if (this.stopped || generation !== this.generation) return;
      this.scheduleRestart(
        `runner watchdog failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        coords,
        generation
      );
    });
  }

  /**
   * A sent signal is not exit evidence. Wait for the process event, escalate to
   * SIGKILL once, and refuse replacement if the OS still does not confirm exit.
   */
  private async terminateChild(
    child: ChildProcess,
    deadlineMs: number
  ): Promise<boolean> {
    let exited = false;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const onExit = () => {
      exited = true;
      resolveExit();
    };
    child.once("exit", onExit);
    try {
      this.signalChildTree(child, "SIGTERM");
      await Promise.race([
        exit,
        this.terminationDelay(Math.max(0, deadlineMs)),
      ]);
      if (!exited) {
        this.signalChildTree(child, "SIGKILL");
        await Promise.race([exit, this.terminationDelay(250)]);
      }
      return exited;
    } finally {
      child.removeListener("exit", onExit);
    }
  }

  private signalChildTree(
    child: ChildProcess,
    signal: NodeJS.Signals
  ): boolean {
    const pid = child.pid;
    if (
      Number.isInteger(pid) &&
      (pid ?? 0) > 0 &&
      this.signalProcessGroup(pid as number, signal)
    ) {
      return true;
    }
    return child.kill(signal);
  }

  private scheduleRestart(
    reason: string,
    coords: RunnerCoords,
    generation: number
  ): void {
    if (
      this.stopped ||
      generation !== this.generation ||
      this.scheduledGeneration === generation
    ) {
      return;
    }
    if (this.consecutiveFailures >= this.maxRestartAttempts) {
      this.setStatus("degraded", {
        sandboxed: this.sandboxed,
        restartAttempt: this.consecutiveFailures,
        note: `${reason}; automatic restart limit reached`,
      });
      return;
    }

    this.consecutiveFailures += 1;
    const attempt = this.consecutiveFailures;
    const exponential = Math.min(
      this.restartBaseMs * 2 ** (attempt - 1),
      this.restartCapMs
    );
    const delayMs = Math.min(
      Math.round(exponential * (1 + this.random() * 0.2)),
      this.restartCapMs
    );
    this.scheduledGeneration = generation;
    this.setStatus("backoff", {
      sandboxed: this.sandboxed,
      restartAttempt: attempt,
      note: `${reason}; retrying in ${delayMs}ms`,
    });
    this.options.onLog?.(
      `runner recovery attempt ${attempt}/${this.maxRestartAttempts} in ${delayMs}ms`
    );

    void this.restartDelay(delayMs)
      .then(async () => {
        if (
          this.stopped ||
          generation !== this.generation ||
          this.scheduledGeneration !== generation
        ) {
          return;
        }
        this.scheduledGeneration = null;
        await this.launch(coords, generation);
      })
      .catch((error) => {
        if (this.stopped || generation !== this.generation) return;
        this.scheduledGeneration = null;
        this.setStatus("degraded", {
          sandboxed: this.sandboxed,
          restartAttempt: this.consecutiveFailures,
          note: `runner restart scheduler failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }

  private setStatus(
    phase: RunnerSupervisorPhase,
    detail: Omit<RunnerSupervisorStatus, "phase" | "host">
  ): void {
    this.status = {
      phase,
      host: this.options.host,
      ...detail,
    };
  }
}
