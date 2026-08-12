/**
 * ROADMAP T4 — the PARKED-RUNTIME LRU's in-memory replay store.
 *
 * When a human terminal pane is backgrounded, `terminal-tab.tsx` may decide to
 * PARK it: dispose the XTerm instance to free its DOM/canvas/buffer memory,
 * while the pty host session and the byte channel stay exactly as they are
 * (see terminal-host.ts — nothing here ever touches a pty). What it captures
 * first is what this store holds, so `resume()` can replay it into a freshly
 * created XTerm instead of a blank pane:
 *
 *   - `serialized`  the SerializeAddon buffer at the instant of parking (full
 *                    cell state: colors, cursor, alt-screen) — the richest
 *                    replay source, captured ONCE per park.
 *   - `pending`     bytes the host delivered AFTER parking, while no XTerm
 *                    was alive to render them — appended live, bounded.
 *
 * BOUNDED ON PURPOSE, the same posture as `PtyHost`'s own scrollback ring:
 *   - an LRU cap on ENTRY COUNT (`maxEntries`) — parking a great many tabs at
 *     once must not grow this store without bound; the oldest-parked entry is
 *     evicted first, and losing one costs nothing correctness-wise (its pane
 *     still resumes correctly — `terminal-tab.tsx` falls back to the HOST's
 *     own live scrollback for a session this store no longer holds).
 *   - a per-entry BYTE cap on `pending` (mirrors PtyHost's `scrollbackBytes`
 *     default), so a session that stays parked through a very chatty run
 *     cannot grow one entry without bound either.
 *
 * Pure, dependency-free, and framework-agnostic — no xterm, no React, no
 * Electron — so the LRU and GC policy are unit-testable on their own.
 */

export type ParkedTerminalSnapshot = {
  serialized: string;
  pending: string;
  cols: number;
  rows: number;
  /** Epoch ms this entry was parked, for the boot-time GC below. */
  parkedAt: number;
};

/** Mirrors `PtyHost`'s own `DEFAULT_SCROLLBACK_BYTES` — the same "how much
 *  backlog is worth keeping" judgment, restated for the renderer's own copy. */
const DEFAULT_MAX_PENDING_CHARS = 256 * 1024;

/** Comfortably above how many terminal tabs a human plausibly keeps open at
 *  once (mirrors `MAX_TERMINAL_SESSIONS`'s reasoning) and far below the point
 *  where holding that many serialize buffers in memory matters. */
const DEFAULT_MAX_ENTRIES = 16;

export type ParkedTerminalStoreOptions = {
  maxEntries?: number;
  maxPendingChars?: number;
  now?: () => number;
};

export class ParkedTerminalStore {
  /** Map insertion order doubles as LRU order (re-`park`ing an id deletes +
   *  re-inserts it at the MRU end). */
  private readonly entries = new Map<string, ParkedTerminalSnapshot>();
  private readonly maxEntries: number;
  private readonly maxPendingChars: number;
  private readonly now: () => number;

  constructor(options: ParkedTerminalStoreOptions = {}) {
    this.maxEntries =
      Number.isInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
        ? (options.maxEntries as number)
        : DEFAULT_MAX_ENTRIES;
    this.maxPendingChars =
      Number.isInteger(options.maxPendingChars) &&
      (options.maxPendingChars ?? 0) > 0
        ? (options.maxPendingChars as number)
        : DEFAULT_MAX_PENDING_CHARS;
    this.now = options.now ?? Date.now;
  }

  /** Record a freshly parked pane's snapshot. Evicts the LEAST-recently-parked
   *  entry once the count exceeds `maxEntries`. */
  park(
    sessionId: string,
    snapshot: { serialized: string; cols: number; rows: number }
  ): void {
    this.entries.delete(sessionId); // re-insert at the MRU end
    this.entries.set(sessionId, {
      serialized: snapshot.serialized,
      pending: "",
      cols: snapshot.cols,
      rows: snapshot.rows,
      parkedAt: this.now(),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  /**
   * Append bytes the host delivered WHILE `sessionId` is parked. A no-op for
   * an id this store is not currently holding (already resumed, or evicted by
   * the LRU cap) — a stray late call must never throw or silently create a
   * new entry out of thin air.
   */
  appendPending(sessionId: string, data: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    entry.pending += data;
    if (entry.pending.length > this.maxPendingChars) {
      entry.pending = entry.pending.slice(-this.maxPendingChars);
    }
  }

  /**
   * Consume (remove) a parked entry on resume — one-shot, like
   * `human-terminal-snapshot.ts`'s own cold-restore read. `null` means
   * nothing was held (a session that was never parked, or one the LRU cap
   * evicted); the caller falls back to the host's own live scrollback.
   */
  take(sessionId: string): ParkedTerminalSnapshot | null {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    this.entries.delete(sessionId);
    return entry;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * BOOT-TIME BUFFER GC (ROADMAP T4) — drop any entry parked more than
   * `maxAgeMs` ago. Cheap by construction: one pass over whatever this
   * process's store currently holds, no I/O. On an ordinary cold boot the
   * store is freshly constructed and empty, so this costs nothing; the hook
   * exists so a park cycle that outlives its usefulness (a tab the operator
   * backgrounded and never returned to) does not sit in memory for the rest
   * of a long-running window. Returns the number of entries dropped, for
   * diagnostics only.
   */
  gcStale(maxAgeMs: number): number {
    const cutoff = this.now() - maxAgeMs;
    let dropped = 0;
    for (const [sessionId, entry] of this.entries) {
      if (entry.parkedAt < cutoff) {
        this.entries.delete(sessionId);
        dropped += 1;
      }
    }
    return dropped;
  }
}

/** One store shared by every human/takeover terminal tab in this renderer —
 *  the LRU cap is meant to bound the WHOLE app's parked memory, not one tab's. */
export const defaultParkedTerminalStore = new ParkedTerminalStore();

/** A parked pane older than this is not one the operator is about to tab back
 *  into imminently (T1's cold-restore already covers "gone for a whole app
 *  quit"); freeing it early costs nothing since the host scrollback fallback
 *  still covers the eventual return. */
export const PARKED_TERMINAL_MAX_AGE_MS = 30 * 60 * 1000;

/** Boot-time hook (ROADMAP T4) — call once at renderer startup to trim
 *  whatever the shared store is holding. */
export function gcParkedTerminalsAtBoot(
  store: ParkedTerminalStore = defaultParkedTerminalStore
): number {
  return store.gcStale(PARKED_TERMINAL_MAX_AGE_MS);
}
