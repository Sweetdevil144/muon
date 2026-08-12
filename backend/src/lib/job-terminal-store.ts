// The brain's side of a dispatched job's LIVE TERMINAL: a bounded, in-memory
// ring of console frames per job, written by the lease-holding runner and read
// back read-only by the operator.
//
// IN MEMORY ON PURPOSE. These are raw vendor console bytes — large, untrusted,
// and worthless once the run is over. Persisting them would grow the operator's
// local brain without bound for a view that expires. The trade is stated on the
// read side: a backend restart loses the ring, the attach route answers
// `available:false`, and the viewer falls back to the recorded stream instead of
// being told a live console exists when it does not.
//
// BOUNDED THREE WAYS. Bytes per session, sessions in total, and frames per
// session. An agent can emit a great deal; every cap here drops the OLDEST data
// and reports the loss as a gap in `seq`, so a reader can always tell "you
// missed some" from "there was none".
//
// READ-ONLY BY CONSTRUCTION. There is no method here that sends anything toward
// a job, and no route that reads this store offers one. Input into a governed
// agent would bypass the approval gate that makes it governed.

export type JobTerminalFrame = { seq: number; data: string };

export type JobTerminalRead = {
  sessionId: string;
  frames: JobTerminalFrame[];
  /** Earliest seq still retained; a reader below it has missed console bytes. */
  firstSeq: number;
  /** Highest seq accepted so far — the cursor for the next poll. */
  lastSeq: number;
  /**
   * Frames the RUNNER lost before they ever reached here (queue overflow, a
   * refused publish, a scrub-safety drop). `firstSeq` only reports this ring's
   * own trimming, so without this a mid-stream hole would render as continuous
   * output.
   */
  dropped: number;
};

/** Console bytes retained per job. Matches the runner-side ring budget. */
const MAX_SESSION_BYTES = 256 * 1024;
/** Frames retained per job, so a flood of tiny writes is capped too. */
const MAX_SESSION_FRAMES = 4_000;
/** Jobs with a live console retained at once; the least-recent is evicted. */
const MAX_SESSIONS = 64;

type Session = {
  sessionId: string;
  frames: JobTerminalFrame[];
  bytes: number;
  lastSeq: number;
  dropped: number;
  updatedAt: number;
};

export class JobTerminalStore {
  private readonly sessions = new Map<string, Session>();

  /**
   * Append one publish batch. Returns the session's new high-water seq.
   *
   * IDEMPOTENT AND MONOTONIC: a frame whose seq the store has already seen is
   * ignored, so a runner retry after a timeout can never duplicate console
   * output. A publish carrying a DIFFERENT sessionId for the same job resets
   * the ring — that is a fresh execution of the job, and showing the previous
   * attempt's output under the new one would be the same class of lie as a
   * replayed stream presented as live.
   */
  append(
    jobId: string,
    sessionId: string,
    frames: readonly JobTerminalFrame[],
    dropped = 0
  ): number {
    let session = this.sessions.get(jobId);
    if (!session || session.sessionId !== sessionId) {
      session = {
        sessionId,
        frames: [],
        bytes: 0,
        lastSeq: 0,
        dropped: 0,
        updatedAt: Date.now(),
      };
      this.sessions.set(jobId, session);
    }
    for (const frame of frames) {
      if (frame.seq <= session.lastSeq) continue;
      session.frames.push(frame);
      session.bytes += Buffer.byteLength(frame.data, "utf8");
      session.lastSeq = frame.seq;
    }
    // Cumulative and monotonic: a retried publish must not walk the count back.
    session.dropped = Math.max(session.dropped, dropped);
    while (
      session.frames.length > 1 &&
      (session.bytes > MAX_SESSION_BYTES ||
        session.frames.length > MAX_SESSION_FRAMES)
    ) {
      const trimmed = session.frames.shift();
      if (trimmed) {
        session.bytes -= Buffer.byteLength(trimmed.data, "utf8");
      }
    }
    session.updatedAt = Date.now();
    this.evict();
    return session.lastSeq;
  }

  /**
   * Frames after `afterSeq`, oldest first. `null` when this job has no live
   * console in this process — the honest answer that makes a viewer fall back
   * rather than render an empty pane labelled "live".
   */
  read(jobId: string, afterSeq: number, limit: number): JobTerminalRead | null {
    const session = this.sessions.get(jobId);
    if (!session) return null;
    const frames = session.frames
      .filter((frame) => frame.seq > afterSeq)
      .slice(0, limit);
    return {
      sessionId: session.sessionId,
      frames,
      firstSeq: session.frames[0]?.seq ?? session.lastSeq,
      lastSeq: session.lastSeq,
      dropped: session.dropped,
    };
  }

  /** Deliberately drop one job's console (job reaped, tests). */
  clear(jobId: string): void {
    this.sessions.delete(jobId);
  }

  /** Total retained sessions, for tests and diagnostics. */
  get size(): number {
    return this.sessions.size;
  }

  private evict(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      let oldestJob: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [jobId, session] of this.sessions) {
        if (session.updatedAt < oldestAt) {
          oldestAt = session.updatedAt;
          oldestJob = jobId;
        }
      }
      if (!oldestJob) return;
      this.sessions.delete(oldestJob);
    }
  }
}

/** The process-wide store. One brain process, one live-terminal buffer. */
export const jobTerminalStore = new JobTerminalStore();
