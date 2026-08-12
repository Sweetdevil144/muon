import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One canonical per-user data dir so EVERY surface (backend, CLI, TUI, desktop)
// shares one embedded brain: its SQLite db, its graph store, and the lockfile
// that advertises the running brain's loopback port + token. Kept local, never
// a synced/network volume (WAL locking breaks there), to honor local-first /
// no-data-egress. See docs/adr/0008-embedded-brain-sqlite.md.

export const LOCKFILE_NAME = "brain.lock";
export const DB_FILE_NAME = "muon.db";
export const GRAPH_DIR_NAME = "graph";

/**
 * The running embedded brain's coordinates, published by the backend on boot in
 * `<dataDir>/brain.lock` (mode 0600) and read by every client to auto-target it.
 * `token` guards the LOCAL loopback API only, it is NOT a vendor token and is
 * never custodied off-machine.
 */
export type BrainLock = {
  /** Loopback port the OS assigned the brain (it binds 127.0.0.1:0). */
  port: number;
  /**
   * OPERATOR bearer token for the local API, human / govern authority (P3-A).
   * For LOCAL HUMAN surfaces (CLI/TUI/desktop). crypto.randomBytes(32).hex.
   * Optional / may be "" under ADR-0017 Keychain custody: a brain minted with the
   * operator token custodied out-of-band (Keychain) publishes token:"" here, and
   * readers fall through to `readOperatorToken()`. `readLockfile` still accepts a
   * string "", a non-empty value keeps the legacy meaning.
   */
  token?: string;
  /**
   * AGENT-tier bearer token (P3-A): reads + agent-writes, NEVER govern. What
   * gets injected into DISPATCHED SUB-AGENTS + the orchestrator, so a sub-agent
   * cannot self-approve/self-confirm/forge a human principal. Optional on READ
   * for back-compat with a lockfile written by a pre-P3-A brain; a current brain
   * always writes it.
   */
  agentToken?: string;
  /** The brain process's pid (used to detect a stale lockfile). */
  pid: number;
  /** Absolute path to the SQLite db the brain opened. */
  dbPath: string;
  /** ISO timestamp of when the brain started. */
  startedAt: string;
};

/**
 * The canonical per-user data dir. `MUON_DATA_DIR` overrides (the desktop app
 * passes its `app.getPath("userData")` so all surfaces agree); otherwise the
 * OS-conventional location: macOS `~/Library/Application Support/MUON`, else
 * `$XDG_DATA_HOME/muon`, else `~/.local/share/muon`.
 */
export function resolveDataDir(): string {
  const override = process.env.MUON_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MUON");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "muon");
  }
  return path.join(os.homedir(), ".local", "share", "muon");
}

/** Absolute path to the embedded SQLite database file. */
export function dbFilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, DB_FILE_NAME);
}

/** Per-user graph store dir (`MUON_GRAPH_DIR` points the backend here). */
export function graphDir(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, GRAPH_DIR_NAME);
}

/** Absolute path to the brain lockfile. */
export function lockfilePath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, LOCKFILE_NAME);
}

/**
 * Read + validate the lockfile. Returns null when it is missing or unparseable
 * (a truncated/corrupt lockfile is treated as "no brain" so callers fall back
 * cleanly). Does NOT probe liveness, see `readLiveLockfile`.
 */
export function readLockfile(dataDir: string = resolveDataDir()): BrainLock | null {
  try {
    const raw = fs.readFileSync(lockfilePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<BrainLock>;
    if (
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.dbPath === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BrainLock;
    }
    return null;
  } catch {
    return null;
  }
}

/** Cheap synchronous liveness check, is a process with this pid running? */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user, alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the lockfile ONLY if its brain process is still alive. A lockfile left
 * by a crashed brain (dead pid) is treated as absent, so callers never target a
 * dead loopback port (review finding F1). Small pid-reuse risk is caught
 * downstream by the bearer-token gate.
 */
export function readLiveLockfile(
  dataDir: string = resolveDataDir()
): BrainLock | null {
  const lock = readLockfile(dataDir);
  return lock && isProcessAlive(lock.pid) ? lock : null;
}

/**
 * Data dirs a MUON brain may be running under on this machine BESIDES the
 * resolved one, newest convention first.
 *
 * The dev desktop derives its profile from Electron's `app.getPath("userData")`
 * — `@muon/desktop` from the package name — while every other surface resolves
 * `MUON`. A packaged build has `productName: MUON` so the two agree; in
 * DEVELOPMENT they do not, and the CLI would auto-boot a SECOND brain against a
 * different ledger, then report that profile's stale runner. Measured live: the
 * founder's `muon doctor` answered from a July-21 runner while the desktop's
 * was online. Every CLI-driven acceptance step (Runs A, C, D) hits this.
 */
function siblingProfileDirs(): string[] {
  if (process.env.MUON_DATA_DIR?.trim()) {
    // An explicit profile is the whole answer; never look elsewhere.
    return [];
  }
  if (process.platform !== "darwin") return [];
  const support = path.join(os.homedir(), "Library", "Application Support");
  return [path.join(support, "@muon", "desktop"), path.join(support, "MUON")];
}

/**
 * The LIVE brain to talk to: this profile's if one is running, otherwise a
 * sibling profile's.
 *
 * Adoption is deliberately narrow and non-destructive. It only fires when THIS
 * profile has no live brain, it never migrates or writes anything, and it
 * reports which profile it adopted so a surprising answer is legible instead of
 * silent. An explicit `MUON_DATA_DIR` disables it entirely.
 */
export function discoverLiveBrain(
  dataDir: string = resolveDataDir()
): { lock: BrainLock; dataDir: string; adopted: boolean } | null {
  const own = readLiveLockfile(dataDir);
  if (own) return { lock: own, dataDir, adopted: false };
  const resolvedOwn = path.resolve(dataDir);
  for (const candidate of siblingProfileDirs()) {
    if (path.resolve(candidate) === resolvedOwn) continue;
    const lock = readLiveLockfile(candidate);
    if (lock) return { lock, dataDir: candidate, adopted: true };
  }
  return null;
}

/** Minimal fetch seam so the health probe is unit-testable without a server. */
export type BrainHealthFetcher = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean }>;

/**
 * Cheap loopback liveness probe: does a brain at `base` answer `GET /health`
 * within `timeoutMs`? This is the SAME probe ensure-brain uses to confirm a
 * spawn, so every surface agrees on what "reachable" means. Never throws — a
 * refused connection, DNS error, or timeout all resolve to `false`. The
 * `fetcher` seam keeps it testable (defaults to the global fetch).
 */
export async function probeBrainHealth(
  base: string,
  opts: { timeoutMs?: number; fetcher?: BrainHealthFetcher } = {}
): Promise<boolean> {
  const fetcher =
    opts.fetcher ?? (globalThis.fetch as unknown as BrainHealthFetcher);
  try {
    const response = await fetcher(`${base}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Like `readLiveLockfile`, but ALSO confirms the advertised loopback port
 * actually answers `GET /health` before returning the lock. Catches what the
 * cheap pid check misses: a live pid whose HTTP port is dead or wrong (pid
 * reuse, a half-crashed brain). Async + opt-in on purpose — `resolveApiBase`
 * stays synchronous for the desktop/next callers that cannot await — so this is
 * for the local human surfaces (TUI startup / re-resolution) only.
 */
export async function readProbedLiveLockfile(
  dataDir: string = resolveDataDir(),
  opts: { timeoutMs?: number; fetcher?: BrainHealthFetcher } = {}
): Promise<BrainLock | null> {
  const lock = readLiveLockfile(dataDir);
  if (!lock) {
    return null;
  }
  const base = `http://127.0.0.1:${lock.port}`;
  return (await probeBrainHealth(base, opts)) ? lock : null;
}

/**
 * Write the lockfile atomically (write temp + rename) with owner-only 0600
 * perms, the local token lives here, so no other user may read it.
 */
export function writeLockfile(
  lock: BrainLock,
  dataDir: string = resolveDataDir()
): void {
  // 0700: the data dir holds the local token + task briefs + the graph, no
  // other user on a shared host should read it (review finding F8).
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = lockfilePath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Remove the lockfile (best-effort). When `ownerPid` is given, only removes it
 * if the lockfile still belongs to that pid, so a brain shutting down during a
 * handover can't delete a live successor's lockfile (review finding F7).
 */
export function removeLockfile(
  dataDir: string = resolveDataDir(),
  ownerPid?: number
): void {
  try {
    if (ownerPid !== undefined) {
      const lock = readLockfile(dataDir);
      if (lock && lock.pid !== ownerPid) {
        return; // a newer brain owns it now, leave it alone.
      }
    }
    fs.rmSync(lockfilePath(dataDir), { force: true });
  } catch {
    // best-effort: a brain that can't clean up its lockfile still exits.
  }
}
