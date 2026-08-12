import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type BrainLock, graphDir, readLockfile } from "@muon/client";
import { createLogSink, logMaxBytesFromEnv } from "./log-sink.js";

// Desktop-side supervisor for the embedded brain (the ADR's "detached loopback
// child discovered via a lockfile"): the app spawns and SUPERVISES the backend
// child so a native crash is contained to a restartable process instead of
// taking down the UI, while the lockfile still lets the CLI/TUI reuse the same
// brain. See docs/adr/0008-embedded-brain-sqlite.md.

// `token` = OPERATOR token (human/govern, for the desktop's own client);
// `agentToken` = AGENT-tier token injected into the orchestrator + runner (P3-A).
export type BrainCoords = { base: string; token?: string; agentToken?: string };

type BrainSupervisorOptions = {
  /** Per-user data dir (desktop passes app.getPath("userData")). */
  dataDir: string;
  /** Called whenever the brain (re)starts on a (possibly new) port. */
  onChange?: (coords: BrainCoords) => void;
  onLog?: (line: string) => void;
  /**
   * Debug mode only: mirror the brain's raw stdout/stderr chunks somewhere a
   * human can see them (the launching terminal). Undefined in normal runs, so
   * the brain's output goes only to brain.log exactly as before.
   */
  teeToTerminal?: (chunk: string) => void;
};

function coordsFrom(lock: BrainLock): BrainCoords {
  return {
    base: `http://127.0.0.1:${lock.port}`,
    token: lock.token,
    agentToken: lock.agentToken,
  };
}

async function probe(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signals are the observable boundary for native faults (LadybugDB, Prisma,
 * Electron's Node runtime): the child cannot catch a SIGSEGV and report which
 * native subsystem failed. Exit-code fallbacks cover wrappers that translate a
 * Unix signal into 128 + signal instead of preserving `signal` on ChildProcess.
 */
export function shouldForceGraphRecoveryAfterExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stopped: boolean
): boolean {
  return (
    !stopped &&
    (signal !== null || (code !== null && code >= 128 && code <= 159))
  );
}

export class BrainSupervisor {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restarts = 0;
  private graphRecoveryRequested = false;
  private adoptWatch: ReturnType<typeof setInterval> | null = null;
  /** The pid of an ADOPTED (not spawned) brain on our own dataDir, so quit
   *  can reap it — the desktop owns its profile's lifecycle. */
  private adoptedPid: number | null = null;
  private readonly dataDir: string;
  private readonly onChange?: (coords: BrainCoords) => void;
  private readonly onLog?: (line: string) => void;
  private readonly teeToTerminal?: (chunk: string) => void;

  constructor(options: BrainSupervisorOptions) {
    this.dataDir = options.dataDir;
    this.onChange = options.onChange;
    this.onLog = options.onLog;
    this.teeToTerminal = options.teeToTerminal;
  }

  /**
   * Ensure a brain is available. Adopts an already-healthy one (e.g. started by
   * the CLI) via the lockfile; otherwise spawns and supervises a child. Returns
   * the coordinates to talk to it, or null if it could not be started.
   */
  async start(): Promise<BrainCoords | null> {
    this.clearAdoptWatch();
    const existing = readLockfile(this.dataDir);
    if (existing && (await probe(coordsFrom(existing).base))) {
      this.onLog?.(`adopted running brain on port ${existing.port}`);
      // The DESKTOP owns its profile's lifecycle: an adopted brain on OUR
      // dataDir is almost always the orphan of a previous run (a CLI's
      // detached auto-spawn, or a dev session killed without teardown) —
      // remember its pid so quit can reap it. Observed live 2026-08-05: a
      // PPID-1 brain from 01:14 survived a whole day, got adopted by every
      // later desktop, and outlived each of them; "no zombie processes when
      // MUON exits" is a founder requirement.
      this.adoptedPid = existing.pid ?? null;
      // We don't own this child, so there's no exit event, poll its health so
      // a dead adopted brain doesn't strand the UI on a dead port (finding F5).
      this.watchAdopted(coordsFrom(existing).base);
      return coordsFrom(existing);
    }
    this.adoptedPid = null;
    return this.spawnAndWait();
  }

  stop(): void {
    this.stopped = true;
    this.clearAdoptWatch();
    this.child?.kill();
    this.child = null;
    // Reap an ADOPTED brain too — but only after re-reading the lockfile and
    // confirming the pid we remembered is still the pid the lock names, so a
    // recycled pid can never be signalled by mistake. Best-effort: a brain
    // that already exited (ESRCH) or was replaced is simply left alone.
    if (this.adoptedPid !== null) {
      const current = readLockfile(this.dataDir);
      if (current?.pid === this.adoptedPid) {
        try {
          process.kill(this.adoptedPid, "SIGTERM");
          this.onLog?.(
            `stopped adopted brain (pid ${this.adoptedPid}) — the desktop owns its profile's lifecycle`
          );
        } catch {
          // Already gone, or not ours to signal — either way, not a zombie.
        }
      }
      this.adoptedPid = null;
    }
  }

  private clearAdoptWatch(): void {
    if (this.adoptWatch) {
      clearInterval(this.adoptWatch);
      this.adoptWatch = null;
    }
  }

  /** Poll an adopted (not-owned) brain; recover if it goes away. */
  private watchAdopted(base: string): void {
    this.clearAdoptWatch();
    this.adoptWatch = setInterval(() => {
      void (async () => {
        if (this.stopped) {
          this.clearAdoptWatch();
          return;
        }
        if (await probe(base)) {
          return;
        }
        this.clearAdoptWatch();
        this.onLog?.("adopted brain went away, recovering");
        const coords = await this.start(); // re-adopt a new one or spawn our own
        if (coords) {
          this.onChange?.(coords);
        }
      })();
    }, 3_000);
    this.adoptWatch.unref?.();
  }

  private resolveEntry(): string | undefined {
    const override = process.env.MUON_BRAIN_ENTRY?.trim();
    if (override && existsSync(override)) {
      return override;
    }
    const candidates = [
      // Packaged: bundled as an unpacked resource (see packaging follow-up).
      path.join(process.resourcesPath ?? "", "backend", "dist", "index.js"),
      path.join(
        process.resourcesPath ?? "",
        "app.asar.unpacked",
        "backend",
        "dist",
        "index.js"
      ),
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
    // Dev/monorepo: walk up from dist/lib looking for backend/dist/index.js.
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, "backend", "dist", "index.js");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return undefined;
  }

  private async spawnAndWait(): Promise<BrainCoords | null> {
    const entry = this.resolveEntry();
    if (!entry) {
      this.onLog?.(
        "could not locate the brain entrypoint (set MUON_BRAIN_ENTRY)"
      );
      return null;
    }

    const logDir = path.join(this.dataDir, "logs");
    mkdirSync(logDir, { recursive: true });
    // Size-capped sink instead of a raw appended fd: brain.log grew to 83 MB of
    // HTTP polling noise on the founder's machine. The sink rotates at the cap
    // (one generation kept) and, in debug mode, mirrors the stream to the
    // terminal — the backend's logs were otherwise invisible during dev.
    const out = createLogSink({
      file: path.join(logDir, "brain.log"),
      maxBytes: logMaxBytesFromEnv(),
      tee: this.teeToTerminal,
    });
    out.on("error", () => undefined);

    // Force the embedded SQLite path and pin the shared data dir so every
    // surface agrees; cwd is the data dir so no dev `.env` leaks in.
    const forceGraphRecovery = this.graphRecoveryRequested;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MUON_DATA_DIR: this.dataDir,
      MUON_GRAPH_DIR: graphDir(this.dataDir),
      // The brain runs as a plain Node process. In a PACKAGED app `process.execPath`
      // is the Electron binary, which would otherwise relaunch the app instead of
      // executing `entry` as a script, so we MUST run it in Node mode. This is
      // also correct in dev (`electron .`): the backend never uses Electron APIs,
      // and the LadybugDB/Prisma native modules are N-API (ABI-stable), so they
      // load fine under Electron's bundled Node with no electron-rebuild.
      ELECTRON_RUN_AS_NODE: "1",
    };
    if (forceGraphRecovery) {
      childEnv.MUON_GRAPH_FORCE_RECOVER = "1";
    }
    delete childEnv.DATABASE_URL;

    // Supervised (NOT detached): we want the exit event to restart on a crash,
    // and the child dies with the app on quit.
    const child = spawn(process.execPath, [entry], {
      // Piped (not an inherited fd) so the rotating sink above owns the file and
      // debug mode can tee it. Backpressure keeps the child honest if the disk
      // stalls, exactly as it does for the detached runner.
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.dataDir,
      env: childEnv,
    });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    this.child = child;
    child.on("exit", (code, signal) => {
      out.end();
      this.onLog?.(`brain exited (code ${code ?? "signal"})`);
      if (shouldForceGraphRecoveryAfterExit(code, signal, this.stopped)) {
        this.graphRecoveryRequested = true;
        this.onLog?.(
          "unexpected native brain exit; rebuilding the derived graph before restart"
        );
      }
      if (this.child === child) {
        this.child = null;
      }
      void this.maybeRestart();
    });

    // The child writes the lockfile only once it is listening; poll + confirm.
    let waited = 0;
    while (waited < 15_000) {
      await delay(250);
      waited += 250;
      if (this.stopped) {
        return null;
      }
      const lock = readLockfile(this.dataDir);
      if (lock && lock.pid === child.pid && (await probe(coordsFrom(lock).base))) {
        this.restarts = 0;
        if (forceGraphRecovery) {
          this.graphRecoveryRequested = false;
        }
        this.onLog?.(`brain ready on port ${lock.port}`);
        return coordsFrom(lock);
      }
    }
    this.onLog?.("brain did not report healthy within 15s");
    return null;
  }

  private async maybeRestart(): Promise<void> {
    if (this.stopped) {
      return;
    }
    // Backoff caps the crash-loop (the segfault class the child-process choice
    // is meant to contain) instead of spinning hot.
    const backoff = Math.min(1_000 * 2 ** this.restarts, 30_000);
    this.restarts += 1;
    this.onLog?.(`restarting brain in ${backoff}ms (attempt ${this.restarts})`);
    await delay(backoff);
    if (this.stopped) {
      return;
    }
    const coords = await this.spawnAndWait();
    if (coords) {
      this.onChange?.(coords);
    }
  }
}
