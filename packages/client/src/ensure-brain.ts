import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphDir,
  lockfilePath,
  probeBrainHealth,
  discoverLiveBrain,
  readLockfile,
  resolveDataDir,
  type BrainHealthFetcher,
} from "./paths.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type EnsureBrainResult = {
  /** A brain is confirmed live (was already up, or we started one). */
  live: boolean;
  /** We spawned a brain process this call. */
  started: boolean;
  /** The brain's loopback base, once confirmed healthy. */
  base?: string;
  /** The per-user data dir the brain uses (db, graph, lockfile). */
  dataDir: string;
  /** Where a spawned brain's logs go (for debugging a failed start). */
  logPath?: string;
  note?: string;
};

/**
 * What to tell someone whose machine has no brain — WHICH DEPENDS ON THE
 * MACHINE.
 *
 * This used to send every caller to the desktop download. The desktop app is
 * macOS-only, so on Linux that is a dead end dressed as an instruction:
 * measured on clean Debian through the published tarball, the CLI installs
 * fine and then advises an app that platform cannot run.
 */
export function brainNotFoundNote(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return "could not locate the MUON brain. Install the MUON desktop app from https://getmuon.com/download (it hosts the local brain), or set MUON_BRAIN_ENTRY.";
  }
  return "could not locate the MUON brain. The desktop app that hosts it is macOS-only today, so on this platform build it from source (https://github.com/Sweetdevil144/muon — `npm install && ./build.sh`) and re-run, or point MUON_BRAIN_ENTRY at an existing backend/dist/index.js.";
}

/**
 * Locate the embedded brain's entrypoint (`backend/dist/index.js`):
 *   1. `MUON_BRAIN_ENTRY`, an explicit override (packaged app / tests).
 *   2. a resolvable `muon-backend` dependency (installed/Homebrew layout).
 *   3. the installed desktop app's staged backend (Resources/backend) — the
 *      standalone CLI/TUI tarball ships no backend of its own, so a machine
 *      with MUON.app installed but not running can still auto-spawn a brain.
 *   4. an upward search for `backend/dist/index.js` (monorepo/dev layout).
 *
 * This module lives in `@muon/client` (node-only, beside paths.ts). Both the
 * `import.meta.url` upward walk and the `muon-backend` bare-specifier resolution
 * are location-relative: from `packages/client/dist/` the walk still reaches the
 * monorepo root (backend/dist/index.js), and `createRequire` still resolves a
 * hoisted `muon-backend` via the shared node_modules — identical to when this
 * lived in `apps/cli`. Exported so a test can assert the search still resolves
 * the backend from this new location (the move-verification requirement).
 */

export function resolveBrainEntry(): string | undefined {
  const override = process.env.MUON_BRAIN_ENTRY?.trim();
  if (override && existsSync(override)) {
    return override;
  }
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("muon-backend/dist/index.js");
  } catch {
    // not installed as a dependency, fall through to the app/dev search.
  }
  // The packaged desktop app stages the self-contained backend tree at
  // Resources/backend (see apps/desktop/electron-builder.yml extraResources);
  // `node <entry>` runs it exactly as the dev layout does.
  const appEntries = [
    "/Applications/MUON.app/Contents/Resources/backend/dist/index.js",
    join(
      process.env.HOME ?? "",
      "Applications/MUON.app/Contents/Resources/backend/dist/index.js"
    ),
  ];
  for (const candidate of appEntries) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, "backend", "dist", "index.js");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === root) {
      return undefined;
    }
    dir = dirname(dir);
  }
}

/**
 * Guarantees the local embedded brain is available before a command talks to
 * it, so the app "just works" with no server to start and no token to
 * configure. If the lockfile points at a healthy brain, it no-ops. Otherwise it
 * spawns a DETACHED `node backend/dist/index.js` (loopback-only; it picks a free
 * port, mints a local token, and writes the lockfile), then polls until healthy.
 * Failing to start is reported, never fatal.
 */
export async function ensureBrain(
  opts: {
    dataDir?: string;
    confirmMs?: number;
    /** Health-probe seam (defaults to global fetch); injectable for tests. */
    fetcher?: BrainHealthFetcher;
  } = {}
): Promise<EnsureBrainResult> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const probe = (base: string): Promise<boolean> =>
    probeBrainHealth(base, { fetcher: opts.fetcher });

  const existing = readLockfile(dataDir);
  if (existing) {
    const base = `http://127.0.0.1:${existing.port}`;
    if (await probe(base)) {
      return { live: true, started: false, base, dataDir };
    }
  }

  // Before spawning a SECOND brain: is one already running under a sibling
  // profile? In development the desktop's Electron `userData` is `@muon/desktop`
  // while every other surface resolves `MUON`, so booting here would give the
  // CLI its own ledger and its own (stale) runner while the desktop's brain
  // serves the actual work. Adopt the live one and SAY so — never migrate, and
  // never when the operator named a profile explicitly.
  const discovered = discoverLiveBrain(dataDir);
  if (discovered?.adopted) {
    const base = `http://127.0.0.1:${discovered.lock.port}`;
    if (await probe(base)) {
      return {
        live: true,
        started: false,
        base,
        dataDir: discovered.dataDir,
        note: `using the MUON brain already running under ${discovered.dataDir} (this surface's own profile ${dataDir} has none). Set MUON_DATA_DIR to pin a profile.`,
      };
    }
  }

  const entry = resolveBrainEntry();
  if (!entry) {
    return {
      live: false,
      started: false,
      dataDir,
      note: brainNotFoundNote(),
    };
  }

  const logDir = join(dataDir, "logs");
  const logPath = join(logDir, "brain.log");
  try {
    mkdirSync(logDir, { recursive: true });
    // Owner-only (0600): logs may capture brain diagnostics.
    const out = openSync(logPath, "a", 0o600);
    // Force the embedded SQLite path (drop any inherited hosted DATABASE_URL)
    // and pin the shared data dir so the brain and this client agree. cwd is
    // the data dir so the child never picks up a dev `.env`.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MUON_DATA_DIR: dataDir,
      MUON_GRAPH_DIR: graphDir(dataDir),
    };
    delete childEnv.DATABASE_URL;
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: dataDir,
      env: childEnv,
    });
    child.unref();
  } catch (error) {
    return {
      live: false,
      started: false,
      dataDir,
      logPath,
      note: `could not spawn the brain (${
        error instanceof Error ? error.message : error
      }); check ${logPath}`,
    };
  }

  // The brain writes the lockfile only once it is listening; poll it, then
  // confirm health before declaring success.
  const confirmMs = opts.confirmMs ?? 15_000;
  let waited = 0;
  while (waited < confirmMs) {
    await delay(250);
    waited += 250;
    const lock = readLockfile(dataDir);
    if (lock) {
      const base = `http://127.0.0.1:${lock.port}`;
      if (await probe(base)) {
        return { live: true, started: true, base, dataDir, logPath };
      }
    }
  }

  return {
    live: false,
    started: true,
    dataDir,
    logPath,
    note: `started the brain but it did not report healthy within ${Math.round(
      confirmMs / 1000
    )}s, check ${logPath} (lockfile: ${lockfilePath(dataDir)})`,
  };
}
