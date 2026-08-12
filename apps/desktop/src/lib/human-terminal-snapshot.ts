/**
 * ROADMAP T1 — detachable human terminal tabs, the COLD-RESTORE half.
 *
 * `PtyHost` already keeps a session registry + bounded scrollback so a
 * window RELOAD survives (Future.md 2026-07-30 §1); what it never had is
 * survival of the desktop PROCESS. `apps/desktop/src/main.ts`'s quit
 * coordinator calls `closeAllSessions()` on every `before-quit` — correct
 * for governed dispatch children (an unobserved `danger-full-access` writer
 * is a real invariant, `runner-parent-guard.ts` reaps those the same way) —
 * but the human's OWN interactive tabs (the vendor bar + the plain shell) had
 * no cold path back: their scrollback was memory-only, so a quit erased the
 * pane's whole history with nothing left to reattach to.
 *
 * This module is the disk-backed half of that fix, and ONLY that: capture a
 * human tab's session id + scrollback + tab metadata into one private
 * userData file right before the ptys die, and hand it back once — read once,
 * deleted — on the next launch. It never touches a live pty, never decides
 * WHEN to spawn a fresh one (that is an explicit operator acknowledge in the
 * renderer, T1 step 4), and never runs against anything but `terminal-chat:`
 * ids — a job's own worktree terminal is dispatch-adjacent and stays out of
 * scope (`terminal-host.ts`'s `snapshotHumanSessions` enforces the filter
 * upstream of this file).
 *
 * SECRECY: the file holds raw vendor-CLI scrollback bytes — the human's own
 * terminal output, exactly like `apps/desktop/src/lib/settings.ts`'s
 * credential-bearing `settings.json` — so it is written 0600 (owner-only) the
 * same way, under Electron's per-user `userData` dir. It carries no MUON
 * operator/agent token: those never reach a human pty's environment in the
 * first place (`resolveTerminalSpawn` strips them before spawn), so there is
 * nothing of MUON's own to redact out of a pty's OWN echoed bytes.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  parseChatTerminalSessionId,
  type ChatTerminalScope,
} from "./terminal-session-id.js";
import { terminalTabLabel } from "./terminal-vendor-tabs.js";
import {
  boundTerminalGeometry,
  type HumanTerminalScrollbackSnapshot,
} from "./terminal-host.js";

export const HUMAN_TERMINAL_SNAPSHOT_FILENAME = "human-terminal-snapshot.json";
export const HUMAN_TERMINAL_SNAPSHOT_VERSION = 1 as const;

/**
 * A generous, deliberately FINITE bound on restored tabs — mirrors
 * `MAX_TERMINAL_SESSIONS` (terminal-host.ts): nothing upstream can produce
 * more than that many live human sessions at once, but a hand-edited or
 * corrupted file is untrusted input the moment it is read back, and a launch
 * must never spend unbounded work re-hydrating one.
 */
export const MAX_SNAPSHOT_ENTRIES = 32;

/**
 * A per-entry text bound, restated here rather than trusted from the source.
 * `PtyHost`'s own scrollback ring already caps a LIVE session at 256 KiB, so
 * this is a backstop against a hand-edited file, not the primary control.
 */
export const MAX_SNAPSHOT_TEXT_CHARS = 256 * 1024;
export const MAX_SNAPSHOT_FILE_BYTES = 40 * 1024 * 1024;

/** One cold-restorable human tab: its identity, its tab metadata (recovered
 *  from the session id — the SAME parse the renderer used to build it), and
 *  its captured scrollback. */
export type HumanTerminalSnapshotEntry = {
  sessionId: string;
  chatId: string;
  kind: string;
  ordinal: number;
  label: string;
  text: string;
  cols: number;
  rows: number;
};

export type HumanTerminalSnapshotFile = {
  version: typeof HUMAN_TERMINAL_SNAPSHOT_VERSION;
  /** Epoch ms this quit's snapshot was captured, for diagnostics only. */
  capturedAt: number;
  entries: HumanTerminalSnapshotEntry[];
};

/**
 * Recover a session's chat/kind/ordinal from its id — the exact inverse of
 * the renderer's `chatTerminalSessionId` (terminal-session-id.ts). The legacy
 * plain-shell id (`terminal-chat:<chatId>`, no slot) parses to a null
 * kind/ordinal and is deliberately DROPPED here: it is not part of the
 * `HumanTerminalTab` model the vendor-bar strip restores into, so there is no
 * tab shape to cold-restore it as. It is still captured-then-killed like every
 * other human session (`terminal-host.ts` does not special-case it); it is
 * simply not one this file can hand back as a tab.
 */
function resolvedTabScope(
  sessionId: string
): (ChatTerminalScope & { kind: string; ordinal: number }) | null {
  const scope = parseChatTerminalSessionId(sessionId);
  if (!scope || scope.kind === null || scope.ordinal === null) {
    return null;
  }
  return { chatId: scope.chatId, kind: scope.kind, ordinal: scope.ordinal };
}

/**
 * Pure: turn the live scrollback snapshots `terminal-host.ts` reads off
 * `PtyHost` into the on-disk entry shape. Bounded on both axes (entry count,
 * per-entry text) so a burst of tabs — or a single very chatty one — cannot
 * make an unbounded write on the way OUT the door, before the read-side bound
 * below ever gets a say.
 */
export function buildHumanTerminalSnapshotEntries(
  sessions: readonly HumanTerminalScrollbackSnapshot[]
): HumanTerminalSnapshotEntry[] {
  const entries: HumanTerminalSnapshotEntry[] = [];
  for (const session of sessions) {
    if (entries.length >= MAX_SNAPSHOT_ENTRIES) {
      break;
    }
    const scope = resolvedTabScope(session.sessionId);
    if (!scope) {
      continue;
    }
    entries.push({
      sessionId: session.sessionId,
      chatId: scope.chatId,
      kind: scope.kind,
      ordinal: scope.ordinal,
      label: terminalTabLabel(scope.kind, scope.ordinal),
      text:
        session.text.length > MAX_SNAPSHOT_TEXT_CHARS
          ? session.text.slice(-MAX_SNAPSHOT_TEXT_CHARS)
          : session.text,
      cols: session.cols,
      rows: session.rows,
    });
  }
  return entries;
}

export function serializeHumanTerminalSnapshot(
  file: HumanTerminalSnapshotFile
): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Type-narrowing helper — no `unknown`-typed field reaches a caller. */
function isValidEntry(value: unknown): value is HumanTerminalSnapshotEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const shapeIsValid =
    typeof entry.sessionId === "string" &&
    typeof entry.chatId === "string" &&
    typeof entry.kind === "string" &&
    typeof entry.ordinal === "number" &&
    Number.isInteger(entry.ordinal) &&
    typeof entry.label === "string" &&
    typeof entry.text === "string" &&
    typeof entry.cols === "number" &&
    typeof entry.rows === "number";
  if (!shapeIsValid) {
    return false;
  }
  const scope = resolvedTabScope(entry.sessionId as string);
  const geometry = boundTerminalGeometry({
    cols: entry.cols,
    rows: entry.rows,
  });
  return Boolean(
    scope &&
      entry.chatId === scope.chatId &&
      entry.kind === scope.kind &&
      entry.ordinal === scope.ordinal &&
      entry.label === terminalTabLabel(scope.kind, scope.ordinal) &&
      geometry.cols === entry.cols &&
      geometry.rows === entry.rows
  );
}

/**
 * Fail-closed parse of whatever is actually on disk. A snapshot file is
 * consumed once, on the launch right after a quit — but it is still
 * untrusted the moment it is read: a partial write from a killed-mid-flush
 * process, a hand edit, or a future format change must never throw into
 * startup or hand back a malformed entry. Anything that does not match the
 * exact shape is dropped (per-entry) or refused (whole file); a shorter,
 * honest restore beats a startup crash or a corrupt tab.
 */
export function parseHumanTerminalSnapshot(
  raw: string
): HumanTerminalSnapshotFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const file = parsed as Record<string, unknown>;
  if (
    file.version !== HUMAN_TERMINAL_SNAPSHOT_VERSION ||
    !Array.isArray(file.entries)
  ) {
    return null;
  }
  const entries = file.entries
    .filter(isValidEntry)
    .slice(0, MAX_SNAPSHOT_ENTRIES)
    .map((entry) => ({
      ...entry,
      text:
        entry.text.length > MAX_SNAPSHOT_TEXT_CHARS
          ? entry.text.slice(-MAX_SNAPSHOT_TEXT_CHARS)
          : entry.text,
    }));
  const capturedAt =
    typeof file.capturedAt === "number" && Number.isFinite(file.capturedAt)
      ? file.capturedAt
      : 0;
  return { version: HUMAN_TERMINAL_SNAPSHOT_VERSION, capturedAt, entries };
}

export function humanTerminalSnapshotPath(userDataDir: string): string {
  return path.join(userDataDir, HUMAN_TERMINAL_SNAPSHOT_FILENAME);
}

/**
 * Best-effort delete — an absent file (the common case: most quits have no
 * open human tab) or a transient FS error is not fatal, and quit must never
 * hang or throw on it.
 */
function deleteSnapshotFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Nothing to clean up, or a transient FS error — either way this is not
    // on the critical path of quitting.
  }
}

/**
 * Capture whatever human tabs are live RIGHT NOW to the private snapshot
 * file — called from `before-quit`'s `onBegin`, BEFORE `closeAllSessions()`
 * kills the very ptys this reads. Zero live tabs deletes any stale prior
 * snapshot instead of writing an empty one, so a launch that follows a quit
 * with nothing open never resurrects an OLDER crash's frozen tabs.
 *
 * Never throws: a write failure (a full disk, a permissions problem) must
 * not block quit — the human's session dies the same way it always did, it
 * simply does not cold-restore next time.
 */
export function captureHumanTerminalSnapshot(
  userDataDir: string,
  sessions: readonly HumanTerminalScrollbackSnapshot[],
  now: () => number = Date.now
): void {
  const filePath = humanTerminalSnapshotPath(userDataDir);
  try {
    const entries = buildHumanTerminalSnapshotEntries(sessions);
    if (entries.length === 0) {
      deleteSnapshotFile(filePath);
      return;
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    const raw = serializeHumanTerminalSnapshot({
      version: HUMAN_TERMINAL_SNAPSHOT_VERSION,
      capturedAt: now(),
      entries,
    });
    // `mode` only applies when CREATING the file (masked by umask), so the
    // explicit chmod below TIGHTENS a pre-existing file too — same two-line
    // pattern as settings.ts's `saveSettings`, same reason: raw vendor
    // scrollback is private, never world-readable.
    writeFileSync(filePath, raw, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort: quitting must never hang or crash on a snapshot write.
  }
}

/**
 * Read the snapshot left by the LAST quit and delete it — a one-shot
 * artifact, consumed exactly once. Called once at startup; the entries this
 * returns then live in renderer memory for the rest of the run (until each
 * tab is acknowledged), so deleting the file immediately is safe: a second
 * crash before every tab is acknowledged loses only that run's still-frozen
 * tabs, the same "best effort across a crash" posture the rest of this
 * module keeps.
 *
 * Never throws: a missing file (the common case), a corrupt one, or a read
 * error all resolve to "nothing to restore" rather than blocking startup.
 */
export function consumeHumanTerminalSnapshot(
  userDataDir: string
): HumanTerminalSnapshotEntry[] {
  const filePath = humanTerminalSnapshotPath(userDataDir);
  let entries: HumanTerminalSnapshotEntry[] = [];
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) {
      deleteSnapshotFile(filePath);
      return [];
    }
    const raw = readFileSync(filePath, "utf8");
    entries = parseHumanTerminalSnapshot(raw)?.entries ?? [];
  } catch {
    entries = [];
  }
  deleteSnapshotFile(filePath);
  return entries;
}
