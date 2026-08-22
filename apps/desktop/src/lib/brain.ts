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

/**
 * What the supervisor can say when it has NO coordinates to hand over.
 *
 * `onChange` is the happy path and carries a base + tokens; this is the other
 * half, for the cases where the honest answer is "the brain is not there" —
 * which used to be reported nowhere at all (finding H4: the late-readiness
 * watch expired in total silence).
 *
 * `booting` is the OTHER silence, and the one a human cannot diagnose from the
 * outside: a child that starts and never becomes healthy (a wedged migration, a
 * lockfile naming somebody else's pid) polled forever with nothing said, so the
 * only thing on any surface was the poll's own "fetch failed" — identical to a
 * brain that is never coming. It carries the elapsed time because that is the
 * whole distinction: "still starting (48s)" is a first packaged launch building
 * its graph, and the same line still climbing ten minutes later is a wedge.
 */
export type BrainStatus =
  | { state: "unavailable"; detail: string }
  | { state: "booting"; detail: string; elapsedMs: number };

/**
 * How often a still-booting child says so. The watch itself polls every 2s;
 * announcing every tick would rebuild the tray menu thirty times a minute for a
 * fact that changes on the scale of a migration.
 */
const BOOTING_NOTICE_INTERVAL_MS = 10_000;

type BrainSupervisorOptions = {
  /** Per-user data dir (desktop passes app.getPath("userData")). */
  dataDir: string;
  /** Called whenever the brain (re)starts on a (possibly new) port. */
  onChange?: (coords: BrainCoords) => void;
  /** Called when the supervisor gives up without coordinates to hand over. */
  onStatus?: (status: BrainStatus) => void;
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
  private lateReadyWatch: ReturnType<typeof setInterval> | null = null;
  /** When the still-booting child last said so, so the notice is periodic
   *  rather than per-tick. Reset when a new watch is armed. */
  private lastBootingNoticeAt = 0;
  /** The pid of an ADOPTED (not spawned) brain on our own dataDir, so quit
   *  can reap it — the desktop owns its profile's lifecycle. */
  private adoptedPid: number | null = null;
  private readonly dataDir: string;
  private readonly onChange?: (coords: BrainCoords) => void;
  private readonly onStatus?: (status: BrainStatus) => void;
  private readonly onLog?: (line: string) => void;
  private readonly teeToTerminal?: (chunk: string) => void;

  constructor(options: BrainSupervisorOptions) {
    this.dataDir = options.dataDir;
    this.onChange = options.onChange;
    this.onStatus = options.onStatus;
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
    this.clearLateReadyWatch();
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
    this.clearLateReadyWatch();
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
      })().catch((error) => {
        // Same reason as the late-readiness watch below: an interval body that
        // rejects with nothing attached is an unhandled rejection, and this app
        // has no `unhandledRejection` handler to survive one.
        this.onLog?.(
          `adopted-brain watch tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
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
      // THE ONE GIVE-UP WITH NO WATCH BEHIND IT. Every other failure here either
      // keeps polling (watchLateReady) or stands down out loud when the child
      // dies; a missing entrypoint is a packaging defect that no amount of
      // waiting fixes, and reporting it only to the log left the UI showing
      // whatever it had last been told — "the brain is starting" forever, which
      // is a claim rather than a symptom. Say it on the channel a human sees.
      const detail =
        "MUON could not find the brain to start (its backend bundle is missing). Reinstall MUON, or set MUON_BRAIN_ENTRY to backend/dist/index.js.";
      this.onLog?.(
        "could not locate the brain entrypoint (set MUON_BRAIN_ENTRY)"
      );
      this.onStatus?.({ state: "unavailable", detail });
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
    // Measured from the spawn, not from the moment the late watch arms: what a
    // human wants to know is how long THIS brain has been starting.
    const spawnedAt = Date.now();
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
      // `.catch()` for the same reason as both watch bodies above and below: a
      // `void`ed async call with nothing attached is an unhandled rejection, and
      // this app installs no `unhandledRejection` handler. This one was the last
      // bare `void` in the file and the worst of the three — it awaits a full
      // respawn and then fires `onChange`, whose main-side fan-out persists
      // settings SYNCHRONOUSLY. So a brain crash plus an unwritable
      // settings.json used to exit the main process, taking the window and every
      // runner-hosted vendor session with it.
      void this.maybeRestart().catch((error) => {
        this.onLog?.(
          `brain restart failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
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
    // A SLOW boot is not a FAILED boot. First boot after landed migrations, a
    // graph rebuild, or a big profile can take far longer than 15s — and the
    // child is still ours, still coming up. Giving up here used to strand the
    // desktop TOKENLESS forever: main launched against its settings default,
    // every request 401'd (auth failure never triggers the lockfile rebase —
    // only connection-refused does), while the brain became perfectly healthy
    // seconds later. Live-observed 2026-08-17: 400/400 requests 401 with both
    // lockfile tokens verifying 200 from outside. So keep watching: when the
    // child's lockfile finally passes the probe, hand the coords to onChange
    // (the same applyBrainCoords path a restart uses) so the token rides.
    this.watchLateReady(child, spawnedAt);
    return null;
  }

  /** Poll a still-booting child until it publishes a healthy lockfile, then
   *  fire onChange with its coords. Bounded by the CHILD'S OWN LIFE, and
   *  self-clearing on stop or supersession by a newer start(). */
  private watchLateReady(child: ChildProcess, spawnedAt: number): void {
    this.clearLateReadyWatch();
    if (this.stopped || this.child !== child) {
      // Already superseded — including the case where the child exited inside
      // the 15s window, so its `exit` has fired and can never fire for us.
      return;
    }
    // A new watch announces itself on its first tick; the interval only paces
    // the ones after that.
    this.lastBootingNoticeAt = 0;
    const watch = setInterval(() => {
      void (async () => {
        if (this.stopped || this.child !== child) {
          this.clearLateReadyWatch();
          return;
        }
        const lock = readLockfile(this.dataDir);
        if (!lock || lock.pid !== child.pid) {
          // ALIVE BUT NOT HEALTHY — say so. No lockfile yet, or one naming
          // somebody else's pid: both are ordinary mid-boot states and both used
          // to poll in total silence for as long as the child lived.
          this.noteStillBooting(spawnedAt);
          return;
        }
        const coords = coordsFrom(lock);
        const ready = await probe(coords.base);
        // The guard above was checked BEFORE this ≤1s probe and never after.
        // A stop() or a child crash inside that window used to deliver onChange
        // with DEAD coordinates, and main's applyBrainCoords fan-out restarts
        // the runner — which SIGTERMs every live vendor session. Re-assert it
        // here, on the near side of the await, where the decision is made.
        if (this.stopped || this.child !== child) {
          return;
        }
        if (!ready) {
          // The lockfile is ours and /health still refuses: a wedged migration
          // or a graph rebuild. The one case that most needs a voice.
          this.noteStillBooting(spawnedAt);
          return;
        }
        this.clearLateReadyWatch();
        this.restarts = 0;
        // Cleared HERE too, beside `restarts`, and for the same reason: the
        // in-window success branch was the only place that cleared it, while a
        // forced graph rebuild is itself what makes boot exceed 15s. So every
        // rebuild that finished LATE re-armed MUON_GRAPH_FORCE_RECOVER for the
        // next launch — a permanent per-launch quarantine loop.
        this.graphRecoveryRequested = false;
        this.onLog?.(
          `brain became ready late on port ${lock.port} — adopting its coordinates now`
        );
        this.onChange?.(coords);
      })().catch((error) => {
        // A `void async` body with NO catch is an unhandled rejection, and this
        // app installs no `unhandledRejection` handler — a throw in here (a
        // torn lockfile read, say) took the whole main process down.
        this.onLog?.(
          `late-readiness watch tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }, 2_000);
    this.lateReadyWatch = watch;
    // Never hold the event loop open on its own (the adopt-watch sibling above
    // already does this).
    watch.unref?.();
    // LIVENESS, not a stopwatch. The former 10-minute bound cleared this watch
    // in silence, and no second recovery path exists — the client's rebase runs
    // only on a CONNECTION failure and /health needs no token — so a desktop
    // that had given up stayed 401 forever with nothing anywhere saying why.
    // While the child LIVES it may still finish booting (migrations + a graph
    // rebuild are minutes, not seconds); once it DIES the supervisor's own
    // restart path owns recovery, so that is what stands the watch down.
    child.once("exit", () => {
      if (this.lateReadyWatch !== watch) {
        return; // superseded already; not ours to end
      }
      this.standDownLateReady(
        "the brain exited before it became ready — the supervisor is restarting it",
        "the brain exited before it became ready — MUON is restarting it; check the brain log if this repeats"
      );
    });
  }

  /**
   * "Still starting, and here is how long" — on the SAME two channels the
   * stand-down uses, at a human cadence.
   *
   * A child that lives and never becomes healthy is the one state nothing on the
   * machine could name: the watch polled every 2s with no log and no `onStatus`,
   * so the renderer showed the poll's own "fetch failed" and a first packaged
   * launch (migrations + graph build) was indistinguishable from a brain that is
   * never coming. No new IPC surface — main already consumes `onStatus.detail`
   * for the tray's brain line and the offline banner, and `applyBrainCoords`
   * clears it the moment coordinates arrive.
   */
  private noteStillBooting(spawnedAt: number): void {
    const now = Date.now();
    if (now - this.lastBootingNoticeAt < BOOTING_NOTICE_INTERVAL_MS) {
      return;
    }
    this.lastBootingNoticeAt = now;
    const elapsedMs = Math.max(0, now - spawnedAt);
    const seconds = Math.round(elapsedMs / 1_000);
    this.onLog?.(
      `brain still starting after ${seconds}s — no healthy lockfile yet`
    );
    this.onStatus?.({
      state: "booting",
      detail: `MUON's brain is still starting (${seconds}s). A first launch runs database migrations and builds the code graph; see brain.log if this keeps climbing.`,
      elapsedMs,
    });
  }

  /**
   * Clear the late-readiness watch and SAY SO — on both channels. Standing down
   * used to be entirely silent: no log line, no UI state, and no other recovery
   * path, which is how a tokenless desktop ended up with nothing to explain
   * itself on any surface.
   */
  private standDownLateReady(log: string, detail: string): void {
    this.clearLateReadyWatch();
    this.onLog?.(log);
    this.onStatus?.({ state: "unavailable", detail });
  }

  private clearLateReadyWatch(): void {
    if (this.lateReadyWatch) {
      clearInterval(this.lateReadyWatch);
      this.lateReadyWatch = null;
    }
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
