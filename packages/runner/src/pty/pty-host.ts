// Wave 4 slice 5.0 step 1 — the PTY host (design §2.5).
//
// WHERE THIS ACTUALLY RUNS. This header used to say the host "lives in the
// runner-family process (AGENT token, Seatbelt-confined), NEVER in Electron
// main". That is false: `apps/desktop/src/lib/terminal-host.ts` constructs a
// PtyHost IN Electron main — the process that holds the operator token — and
// spawns the human's vendor CLI from it. ADR-0023 §5 records that posture
// deliberately: a human-owned terminal is the same trust boundary as the user
// opening their own shell, so it runs unconfined with the host environment
// minus MUON's own control-plane tokens, and MUON does not claim OS
// confinement for it. GOVERNED dispatch consoles are the other case entirely
// and do NOT use this class — they live in `pty/job-terminal.ts` inside the
// runner, where no IPC channel can write to them.
//
// The consequence for this file: it must be safe to run inside the operator's
// own process, driven by session ids an untrusted renderer names. So the
// registry is bounded in three dimensions — a stable `sessionId` key, a
// per-session scrollback ring bounded in BYTES, and a bounded session COUNT
// (`maxSessions`) — and the UI window can still reload/crash without killing
// live sessions (session persistence).
//
// Backpressure is ack-driven: the host counts bytes emitted-but-unacked and
// pauses the driver (OS flow control → the child blocks) once they cross a
// high-water mark, resuming when the consumer's acks drain below the low-water
// mark. A detached session (no consumer to ack) therefore pauses its child
// rather than buffering without bound.

import type {
  PtyDriver,
  PtyDriverFactory,
  PtyExit,
  PtySpawnOptions,
} from "./pty-driver.js";

export interface PtyFrame {
  seq: number;
  data: string;
}

/**
 * A session's exit, stamped WHERE IT ACTUALLY HAPPENED.
 *
 * The driver reports only `exitCode`/`signal`, so every consumer used to date
 * the death itself — and a consumer only ever sees an exit when it is
 * ATTACHED. A tab that unmounted before its child died therefore learned about
 * the exit on its next attach (the replay below), minutes later, and anything
 * timing "did this ever become a session" from that moment measured the
 * human's tab switching, not the process. So the host stamps the exit at the
 * OS event and carries the stamp on the session record: `exitedAt` and the
 * `lifetimeMs` derived from the spawn are the SAME numbers on the live
 * delivery and on every later replay.
 */
export interface PtyExitEvent extends PtyExit {
  /** Epoch ms at which the driver reported the exit — never when a consumer
   *  observed it. */
  exitedAt: number;
  /** `exitedAt - spawnedAt`: how long the child actually lived. */
  lifetimeMs: number;
}

export interface PtyConsumer {
  onData(frame: PtyFrame): void;
  onExit(event: PtyExitEvent): void;
}

export interface PtyHostOptions {
  /** Max scrollback BYTES retained per session for reconnect replay. */
  scrollbackBytes?: number;
  /**
   * The most sessions this host will hold at once.
   *
   * A session is a real child process plus a scrollback ring, so an unbounded
   * registry is an unbounded process count in whatever process constructs this
   * host — and one of those is Electron main (header above, ADR-0023 §5),
   * driven by session ids an untrusted renderer supplies. `open` REFUSES past
   * this with a named throw rather than degrading quietly; the desktop door
   * checks the same bound first so the human gets a sentence instead of an
   * exception (terminal-host.ts). This is the backstop for every other caller.
   */
  maxSessions?: number;
  /** Pause the driver once unacked bytes exceed this. */
  highWaterMark?: number;
  /** Resume the driver once unacked bytes fall to/below this. */
  lowWaterMark?: number;
  /** The clock the spawn/exit stamps are taken from. Injectable so a test can
   *  pin the lifetime a fast-exit classification is judged by. */
  now?: () => number;
  /**
   * Fires ONCE per session, when the driver reports the exit — whether or not
   * a consumer is attached, and never again on a replay. This is the hook a
   * launch-failure guard must arm from: routing it through a consumer would
   * make the guard blind to exactly the case it exists for (the pane was
   * unmounted when the child died on startup).
   */
  onSessionExit?: (sessionId: string, event: PtyExitEvent) => void;
}

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
const DEFAULT_HIGH_WATER = 64 * 1024;
const DEFAULT_LOW_WATER = 16 * 1024;
/**
 * Comfortably above any human's real terminal count and far below the point
 * where the child processes or the scrollback rings (256 KiB each) matter.
 * Deliberately a DEFAULT, not an opt-in: a caller that never thought about the
 * bound still gets one.
 */
const DEFAULT_MAX_SESSIONS = 64;

interface Session {
  readonly driver: PtyDriver;
  cols: number;
  rows: number;
  seq: number;
  /** Retained frames for reconnect replay (trimmed by total bytes). */
  scrollback: PtyFrame[];
  scrollbackBytes: number;
  /** Byte size of each emitted-but-unacked frame, for backpressure accounting. */
  unackedFrameBytes: Map<number, number>;
  unackedBytes: number;
  ackedSeq: number;
  paused: boolean;
  exited: PtyExit | null;
  /** Epoch ms of the pty's creation, for the exit event's `lifetimeMs`. */
  spawnedAt: number;
  /** Epoch ms of the driver's exit report; null while the child lives. */
  exitedAt: number | null;
  consumer: PtyConsumer | null;
}

export class PtyHost {
  private readonly sessions = new Map<string, Session>();
  private readonly scrollbackBytes: number;
  private readonly maxSessions: number;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly now: () => number;
  private readonly onSessionExit:
    | ((sessionId: string, event: PtyExitEvent) => void)
    | undefined;

  constructor(
    private readonly factory: PtyDriverFactory,
    options: PtyHostOptions = {}
  ) {
    this.scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    // A caller that states a nonsense bound gets the default, never "no bound":
    // `?? ` alone would let an explicit 0 or NaN through as a permanent refusal
    // or (via a negative) as no cap at all.
    this.maxSessions =
      Number.isInteger(options.maxSessions) && (options.maxSessions ?? 0) > 0
        ? (options.maxSessions as number)
        : DEFAULT_MAX_SESSIONS;
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER;
    this.lowWaterMark = options.lowWaterMark ?? DEFAULT_LOW_WATER;
    this.now = options.now ?? Date.now;
    this.onSessionExit = options.onSessionExit;
  }

  /** Whether a session id is registered and live (or exited-but-not-reaped). */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * A read-only export of a session's retained scrollback + last known
   * geometry — never a mutation, never a consumer attach/detach.
   *
   * Built for cold-restore across a HOST PROCESS quit (desktop Wave 4 §5.0
   * T1): the caller snapshots this to disk BEFORE killing every pty on
   * `before-quit`, so a human's own terminal tab can come back frozen/
   * read-only on the next launch instead of vanishing with no trace. Null for
   * an unknown id — the caller decides what "nothing to snapshot" means.
   */
  exportScrollback(
    sessionId: string
  ): { text: string; cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    return {
      text: session.scrollback.map((frame) => frame.data).join(""),
      cols: session.cols,
      rows: session.rows,
    };
  }

  /** Spawn a pseudo-terminal and register it under a stable id. */
  open(sessionId: string, spawn: PtySpawnOptions): void {
    if (this.sessions.has(sessionId)) {
      throw new Error(`pty session '${sessionId}' already exists`);
    }
    // THE COUNT BOUND, checked before the factory runs — a refused open must
    // never leave a child process behind that the registry does not know about.
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `pty session limit reached (${this.maxSessions} live sessions); refusing to open '${sessionId}'`
      );
    }
    const driver = this.factory(spawn);
    const session: Session = {
      driver,
      cols: spawn.cols ?? 80,
      rows: spawn.rows ?? 24,
      seq: 0,
      scrollback: [],
      scrollbackBytes: 0,
      unackedFrameBytes: new Map(),
      unackedBytes: 0,
      ackedSeq: 0,
      paused: false,
      exited: null,
      spawnedAt: this.now(),
      exitedAt: null,
      consumer: null,
    };
    this.sessions.set(sessionId, session);
    driver.onData((data) => this.onData(session, data));
    driver.onExit((event) => this.onExit(sessionId, session, event));
  }

  /** Forward operator/human keystrokes to the terminal. */
  write(sessionId: string, data: string): void {
    this.require(sessionId).driver.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId);
    session.cols = cols;
    session.rows = rows;
    session.driver.resize(cols, rows);
  }

  /**
   * Attach a consumer (the relay, on a MessagePort). Replays retained scrollback
   * so a reloaded renderer re-materializes the live session, then streams live.
   * Only ONE consumer at a time; a new attach replaces the old.
   */
  attach(sessionId: string, consumer: PtyConsumer): void {
    const session = this.require(sessionId);
    session.consumer = consumer;
    for (const frame of session.scrollback) {
      consumer.onData(frame);
    }
    // A REPLAYED exit carries the original stamps, not this attach's clock —
    // the child died when it died, and a consumer arriving an hour later must
    // not be able to read that as an hour-long session.
    const exit = this.exitEvent(session);
    if (exit) {
      consumer.onExit(exit);
    }
  }

  /**
   * Detach a consumer. IDENTITY-SCOPED: only clears if THIS consumer is still the
   * attached one, so a late `close` of a SUPERSEDED port (reconnect race) can
   * never null the consumer that already re-attached after it. Reaps a session
   * whose pty has already exited and whose UI is now gone — no reconnect will
   * come, so it (and its scrollback) must not linger in the registry forever.
   */
  detach(sessionId: string, consumer?: PtyConsumer): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (consumer && session.consumer !== consumer) {
      return;
    }
    session.consumer = null;
    if (session.exited) {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * The consumer confirms receipt through `uptoSeq`. Drains the backpressure
   * accounting and resumes the paused driver once unacked bytes fall to the low
   * water mark.
   */
  ack(sessionId: string, uptoSeq: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    // The seq is renderer-supplied and UNTRUSTED. Reject a non-integer and never
    // loop past what we actually sent (`session.seq`): an out-of-range ack would
    // spin this loop in trusted Electron main (DoS) and pin `ackedSeq` to a bogus
    // value, permanently killing backpressure so the pty could never resume.
    if (!Number.isInteger(uptoSeq) || uptoSeq <= session.ackedSeq) {
      return;
    }
    const bounded = Math.min(uptoSeq, session.seq);
    for (let seq = session.ackedSeq + 1; seq <= bounded; seq += 1) {
      const bytes = session.unackedFrameBytes.get(seq);
      if (bytes !== undefined) {
        session.unackedBytes -= bytes;
        session.unackedFrameBytes.delete(seq);
      }
    }
    session.ackedSeq = bounded;
    if (session.paused && session.unackedBytes <= this.lowWaterMark) {
      session.paused = false;
      session.driver.resume();
    }
  }

  /** Destroy a session's PTY and drop it from the registry (never orphaned). */
  close(sessionId: string, signal?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (!session.exited) {
      session.driver.kill(signal);
    }
    session.consumer = null;
    this.sessions.delete(sessionId);
  }

  private onData(session: Session, data: string): void {
    session.seq += 1;
    const frame: PtyFrame = { seq: session.seq, data };
    // REAL UTF-8 byte length, not String#length (UTF-16 code units): terminal
    // output is dense in multibyte glyphs (box-drawing, CJK, emoji), so the
    // documented byte caps (scrollback ring + backpressure watermarks) must
    // count bytes or a CJK/emoji flood would silently blow past the budget.
    const bytes = Buffer.byteLength(data, "utf8");

    // Retain for reconnect replay; trim the ring by total bytes.
    session.scrollback.push(frame);
    session.scrollbackBytes += bytes;
    while (
      session.scrollbackBytes > this.scrollbackBytes &&
      session.scrollback.length > 1
    ) {
      const dropped = session.scrollback.shift();
      if (dropped) {
        session.scrollbackBytes -= Buffer.byteLength(dropped.data, "utf8");
      }
    }

    // Backpressure accounting.
    session.unackedFrameBytes.set(frame.seq, bytes);
    session.unackedBytes += bytes;
    if (!session.paused && session.unackedBytes > this.highWaterMark) {
      session.paused = true;
      session.driver.pause();
    }

    session.consumer?.onData(frame);
  }

  /**
   * The driver reported the child's exit.
   *
   * The session is NOT reaped here even when nobody is attached: the exit (and
   * the scrollback that explains it) is the only evidence a human who steps
   * away has, and dropping the record would let the very next open of this id
   * spawn a second process under the first one's identity. Reaping stays with
   * `detach` (the UI is gone and the pty already ended) and `close` (a
   * deliberate teardown).
   */
  private onExit(sessionId: string, session: Session, event: PtyExit): void {
    // A driver that reports twice must never re-stamp the death.
    if (session.exited) {
      return;
    }
    session.exited = event;
    session.exitedAt = this.now();
    const exit = this.exitEvent(session);
    if (!exit) {
      return;
    }
    // The guard hook FIRST: an unattached session's exit must be recorded
    // before any consumer (present or future) can act on the frame.
    this.onSessionExit?.(sessionId, exit);
    session.consumer?.onExit(exit);
  }

  /** The stamped exit for a session that has one; null while it lives. */
  private exitEvent(session: Session): PtyExitEvent | null {
    if (!session.exited || session.exitedAt === null) {
      return null;
    }
    return {
      ...session.exited,
      exitedAt: session.exitedAt,
      // A clock that stepped backwards must not mint a negative lifetime and
      // turn a launch failure into a "long session".
      lifetimeMs: Math.max(0, session.exitedAt - session.spawnedAt),
    };
  }

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`pty session '${sessionId}' does not exist`);
    }
    return session;
  }
}
