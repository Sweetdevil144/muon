// Shared, dependency-free helpers for MUON's developer debug surface:
// `npm run dev:desktop:debug` (scripts/dev-desktop.mjs --debug) and
// `npm run debug:report` (scripts/debug-report.mjs).
//
// Node built-ins ONLY. The root package has no runtime dependencies and these
// scripts must work in a checkout whose workspaces are not installed.
//
// Two invariants this module exists to hold:
//   1. READ-ONLY. Nothing here opens the database for write, and the SQLite
//      handle is opened `readOnly` so a live WAL brain is never disturbed.
//   2. NO SECRETS. The lockfile carries the operator + agent bearer tokens;
//      `readBrainLock` deliberately returns booleans for their presence and
//      NEVER the values, so no caller can print one by accident.

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

export const DB_FILE_NAME = "muon.db";
export const LOCKFILE_NAME = "brain.lock";

/**
 * Candidate data dirs, most-specific first. `MUON_DATA_DIR` always wins (that
 * is the override every surface honours). Otherwise the desktop's Electron
 * `userData` (derived from the package name `@muon/desktop`) is preferred over
 * the CLI/TUI convention from @muon/client/paths, because the desktop is what
 * this debug surface is for.
 */
export function dataDirCandidates(env = process.env) {
  const override = env.MUON_DATA_DIR?.trim();
  if (override) {
    return [{ dir: path.resolve(override), source: "MUON_DATA_DIR" }];
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      {
        dir: path.join(home, "Library", "Application Support", "@muon", "desktop"),
        source: "desktop userData",
      },
      {
        dir: path.join(home, "Library", "Application Support", "MUON"),
        source: "CLI/TUI convention",
      },
    ];
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return [
    {
      dir: xdg ? path.join(xdg, "muon") : path.join(home, ".local", "share", "muon"),
      source: "XDG convention",
    },
  ];
}

/** The data dir to inspect: the first candidate that actually holds a db. */
export function resolveDataDir(env = process.env) {
  const candidates = dataDirCandidates(env);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate.dir, DB_FILE_NAME))) {
      return candidate;
    }
  }
  return candidates[0];
}

export function logPaths(dataDir) {
  const logDir = path.join(dataDir, "logs");
  return {
    logDir,
    brain: path.join(logDir, "brain.log"),
    runner: path.join(logDir, "runner.log"),
    desktop: path.join(logDir, "desktop.log"),
  };
}

/**
 * The running brain's coordinates, WITHOUT its bearer tokens. `hasOperatorToken`
 * / `hasAgentToken` report presence so a reader can tell "the brain minted
 * credentials" from "it did not" without any caller ever holding the secret.
 */
export function readBrainLock(dataDir) {
  const file = path.join(dataDir, LOCKFILE_NAME);
  let parsed;
  try {
    parsed = JSON.parse(readFileTextSync(file));
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed.port !== "number" ||
    typeof parsed.pid !== "number"
  ) {
    return null;
  }
  return {
    port: parsed.port,
    pid: parsed.pid,
    dbPath: typeof parsed.dbPath === "string" ? parsed.dbPath : null,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    hasOperatorToken:
      typeof parsed.token === "string" && parsed.token.length > 0,
    hasAgentToken:
      typeof parsed.agentToken === "string" && parsed.agentToken.length > 0,
    base: `http://127.0.0.1:${parsed.port}`,
  };
}

function readFileTextSync(file) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const chunk = readSync(fd, buffer, read, size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Signal-0 existence probe (EPERM still means "alive, owned by someone else"). */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Does the brain answer GET /health? Open route, no token involved. */
export async function probeBrainHealth(base, timeoutMs = 1500) {
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Open the embedded SQLite database READ-ONLY. Safe against the live brain: a
 * read-only connection to a WAL database only ever reads the -wal/-shm the
 * writer maintains, and can never take a write lock or checkpoint.
 */
export async function openReadOnlyDb(dbPath) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      `this Node build has no node:sqlite (needs Node 22+); got ${process.version}`
    );
  }
  return new sqlite.DatabaseSync(dbPath, { readOnly: true });
}

/**
 * THE redaction control for anything vendor/agent-authored that this surface
 * prints: `redactedTail` from @muon/core (packages/core/src/build-handoff-packet.ts).
 * Deliberately imported rather than reimplemented — a second copy of a redactor
 * is the drift pattern this repo has been bitten by before.
 *
 * Fails CLOSED: if @muon/core is not built, callers get no redactor and must
 * omit the text rather than print it raw.
 */
export async function loadRedactedTail() {
  const entry = path.join(
    REPO_ROOT,
    "packages",
    "core",
    "dist",
    "build-handoff-packet.js"
  );
  if (!existsSync(entry)) {
    throw new Error(
      "packages/core is not built (run `npm run core:build`), so vendor-authored text cannot be redacted"
    );
  }
  // Not `module`: root eslint covers `scripts/`, and binding that identifier is a
  // lint ERROR (`no-assign-module-variable`) — it shadows the CommonJS global.
  const loaded = await import(pathToFileURL(entry).href);
  if (typeof loaded.redactedTail !== "function") {
    throw new Error("@muon/core no longer exports redactedTail");
  }
  return loaded.redactedTail;
}

/** Last `lines` lines of a file, reading at most `maxBytes` from the tail. */
export function tailFile(file, lines = 40, maxBytes = 256 * 1024) {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  const start = Math.max(0, stats.size - maxBytes);
  const length = stats.size - start;
  if (length <= 0) {
    return { truncated: false, text: "" };
  }
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    const all = text.split("\n");
    if (start > 0 && all.length > 0) {
      all.shift(); // a partial first line from the byte-window cut
    }
    const kept = all.slice(-lines);
    return { truncated: start > 0, text: kept.join("\n") };
  } finally {
    closeSync(fd);
  }
}

export function fileFacts(file) {
  try {
    const stats = statSync(file);
    return { path: file, exists: true, bytes: stats.size, mtime: stats.mtime.toISOString() };
  } catch {
    return { path: file, exists: false, bytes: 0, mtime: null };
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Prisma/SQLite DateTime columns arrive as epoch-ms integers or ISO strings. */
export function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") {
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return null;
}

export function formatAge(iso, now = Date.now()) {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
