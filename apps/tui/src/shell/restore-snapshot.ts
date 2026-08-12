import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * The one thing that outlives a run of the desk: the last quit's screens
 * (ADR-0047).
 *
 * Bounds and posture are the desktop's, deliberately (`terminal-snapshot` on
 * that side), because the same founder is trusting the same promise about the
 * same bytes. What differs is only the entry SHAPE — the desktop's is scoped
 * to a chat, the TUI's to a kind and ordinal — which is why this is a sibling
 * rather than a shared module: forcing chat semantics into the TUI to share a
 * serializer would be the tail wagging the dog.
 *
 * Everything here treats the file as UNTRUSTED INPUT on read, whatever wrote
 * it: a hand-edited or corrupted snapshot must cost a bounded amount of work
 * and then be discarded, never block a launch.
 */

export const SNAPSHOT_FILENAME = "tui-terminal-snapshot.json";
export const SNAPSHOT_VERSION = 1 as const;

/** Finite by intent — a corrupt file cannot make a launch do unbounded work. */
export const MAX_SNAPSHOT_ENTRIES = 32;
/** Per-entry text bound, restated on both sides rather than trusted. */
export const MAX_SNAPSHOT_TEXT_CHARS = 256 * 1024;
/** Refuse to even parse beyond this; a 40 MB "snapshot" is not one. */
export const MAX_SNAPSHOT_FILE_BYTES = 40 * 1024 * 1024;

/**
 * A LINE bound, distinct from the character bound and not implied by it: 256
 * KiB of newlines is ~262,000 lines, and a screen is never more than a few
 * hundred. The character bound alone let a within-bounds file drive the
 * renderer into a stack overflow.
 */
export const MAX_SNAPSHOT_LINES = 2_000;

export type RestoreEntry = {
  readonly id: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly label: string;
  /** The dead session's last screen. AGENT-AUTHORED — sanitized at render. */
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
};

export type SnapshotFile = {
  readonly version: typeof SNAPSHOT_VERSION;
  /** Epoch ms, diagnostics only. */
  readonly capturedAt: number;
  readonly entries: readonly RestoreEntry[];
};

export function snapshotPath(dataDir: string): string {
  return path.join(dataDir, SNAPSHOT_FILENAME);
}

/** Pure: bound the live sessions into on-disk entries. */
export function buildEntries(
  sessions: readonly {
    id: string;
    kind: string;
    ordinal: number;
    label: string;
    screen: readonly string[];
    cols: number;
    rows: number;
  }[]
): RestoreEntry[] {
  return sessions.slice(0, MAX_SNAPSHOT_ENTRIES).map((session) => ({
    id: session.id,
    kind: session.kind,
    ordinal: session.ordinal,
    label: session.label,
    // Keep the NEWEST text when trimming — the bottom of a screen is what a
    // human was reading.
    text: session.screen.join("\n").slice(-MAX_SNAPSHOT_TEXT_CHARS),
    cols: session.cols,
    rows: session.rows,
  }));
}

/** Pure: validate an unknown parsed value into entries, dropping the rest. */
export function parseSnapshot(raw: unknown): SnapshotFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as Record<string, unknown>;
  if (file.version !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(file.entries)) return null;
  const entries: RestoreEntry[] = [];
  for (const candidate of file.entries.slice(0, MAX_SNAPSHOT_ENTRIES)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.text !== "string" ||
      typeof entry.ordinal !== "number" ||
      typeof entry.cols !== "number" ||
      typeof entry.rows !== "number"
    ) {
      continue;
    }
    entries.push({
      id: entry.id,
      kind: entry.kind,
      ordinal: Math.max(1, Math.floor(entry.ordinal)),
      label: entry.label,
      // Re-bound on READ, on BOTH axes. The write-side bound is not evidence
      // about a file that may not have come from our write side.
      text: entry.text
        .slice(0, MAX_SNAPSHOT_TEXT_CHARS)
        .split("\n")
        .slice(0, MAX_SNAPSHOT_LINES)
        .join("\n"),
      cols: Math.max(1, Math.floor(entry.cols)),
      rows: Math.max(1, Math.floor(entry.rows)),
    });
  }
  return {
    version: SNAPSHOT_VERSION,
    capturedAt: typeof file.capturedAt === "number" ? file.capturedAt : 0,
    entries,
  };
}

/**
 * Write the snapshot at quit. `0600` on create AND an explicit chmod, because
 * `mode` only applies to a file this call creates — a pre-existing one would
 * otherwise keep whatever permissions it had (ADR-0047 D1).
 *
 * Best-effort: quitting must never hang or crash on a snapshot write.
 */
export function captureSnapshot(
  dataDir: string,
  entries: readonly RestoreEntry[],
  now: () => number = Date.now
): void {
  try {
    const filePath = snapshotPath(dataDir);
    if (entries.length === 0) {
      try {
        unlinkSync(filePath);
      } catch {
        // nothing to clear
      }
      return;
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    const file: SnapshotFile = {
      version: SNAPSHOT_VERSION,
      capturedAt: now(),
      entries: entries.slice(0, MAX_SNAPSHOT_ENTRIES),
    };
    writeFileSync(filePath, JSON.stringify(file), { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Read the last quit's snapshot and DELETE it — one-shot, per ADR-0047 D1.
 * Never throws: a missing file (the common case), a corrupt one, or an
 * oversized one all resolve to "nothing to restore".
 */
export function consumeSnapshot(dataDir: string): RestoreEntry[] {
  const filePath = snapshotPath(dataDir);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      // A directory at this path would otherwise fall into the catch, fail to
      // unlink, and wedge cold restore permanently.
      return [];
    }
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
      unlinkSync(filePath);
      return [];
    }
    const raw = readFileSync(filePath, "utf8");
    unlinkSync(filePath);
    const parsed = parseSnapshot(JSON.parse(raw) as unknown);
    return parsed ? [...parsed.entries] : [];
  } catch {
    try {
      unlinkSync(filePath);
    } catch {
      // already gone
    }
    return [];
  }
}
