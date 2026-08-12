// The LIVE TERMINAL of one dispatched job — the runner half.
//
// WHY IT LIVES HERE. Only the runner owns the vendor child, so only the runner
// can see what that child actually printed. The brain and the desktop are both
// downstream of this file: the runner publishes bounded frames, the brain holds
// them in a bounded ring, and a viewer attaches read-only. Nothing here can be
// reached from a renderer, and nothing here accepts input (see NO INPUT below).
//
// WHY IT IS A BYTE RELAY AND NOT A PSEUDO-TERMINAL. The obvious implementation
// is to re-parent the vendor onto a pty and stream the master. MUON must not,
// and the reasons are load-bearing rather than stylistic:
//
//   • `codex app-server` (the interactive Codex lane) speaks newline-delimited
//     JSON-RPC over stdin/stdout. A pty master ECHOES what is written to the
//     slave, so MUON's own `turn/start` frames would come back as inbound
//     messages and corrupt the pending-request map; canonical mode also caps a
//     line at MAX_CANON (1024 on macOS), which truncates any frame carrying a
//     real brief.
//   • `cursor-agent --print --output-format json` is accepted only when stdout
//     STARTS with `{`/`[` (cursor-adapter.ts). One tty banner or SGR prefix and
//     `detectCursorRunFailure` rewrites a successful review's exit code 0 → 1.
//     A pty would fail every Cursor job.
//   • A pty merges stderr into stdout. `errorOutput`, `onDiagnostic`, and with
//     them the whole liveness watchdog (`vendorStderrEvidence`) go blind, and
//     the stall report would start claiming a silence it never listened for.
//   • `parseWorkerFinalReport` anchors on `^GOAL:` and nine more literal
//     labels. A single `\x1b[1m` before a label drops the entire final report,
//     its open questions, and every memory proposal.
//
// So the transport stays exactly what it is today — pipes — and this file
// relays the bytes that already flow through them. A viewer sees the vendor's
// real console output, live, byte-for-byte, with stderr interleaved. The
// `PtyDriver` contract next door remains the swap point for a genuine pty if
// the node-pty packaging spike (D1) ever lands with a way to keep stdout and
// stderr separate; every route, record, and bound in this feature is unchanged
// by that swap.
//
// NO INPUT. There is no `write(data)` toward the child anywhere in this file or
// on any route that reads it. Typing into a governed agent would bypass the
// approval path that makes it governed; adding input is a governance decision
// with its own gate, never a side effect of a viewer.
//
// NEVER A DEPENDENCY. Every publish is fire-and-forget and every failure is
// swallowed. A job must never fail, stall, or slow down because nobody was
// watching it — and equally, it must never behave DIFFERENTLY because somebody
// is: this relay exerts no backpressure on the child. When the outbound queue
// overflows, the VIEW loses its oldest frames (visible as a gap in `seq`), the
// vendor is never paused.

import { randomBytes } from "node:crypto";
import { pendingSecretTailLength, redactSecrets } from "@muon/core";

/**
 * Session-id prefix. Deliberately NOT `terminal-<jobId>`: that shape means
 * "spawn a fresh interactive vendor CLI in this job's worktree" on the desktop,
 * and conflating the two is precisely the defect that made opening a worker tab
 * launch an ungoverned process. If one of these ids ever reached that path it
 * would fail to resolve a worktree and the open would be REFUSED — fail closed.
 */
export const JOB_TERMINAL_SESSION_PREFIX = "pty:job:";
/** Hex characters of per-execution epoch. See `jobTerminalSessionId`. */
const EPOCH_BYTES = 8;

/**
 * The identity of ONE execution's console: `pty:job:<jobId>:<epoch>`.
 *
 * Bound to the jobId, and stable for the whole of that job's execution — a
 * second attach derives the same string and JOINS. The trailing epoch exists
 * because a jobId alone is NOT stable across executions: a reclaimed job re-runs
 * under the same id, its frame sequence restarts at 1, and a brain still holding
 * the previous attempt's ring would either drop every new frame as a replay or —
 * worse — keep showing the DEAD attempt's output as live. A new epoch makes the
 * restart visible to every layer: the ring resets, and the viewer sees the id
 * change and starts a clean pane instead of splicing two runs together.
 */
export function jobTerminalSessionId(jobId: string, epoch: string): string {
  return `${JOB_TERMINAL_SESSION_PREFIX}${jobId}:${epoch}`;
}

/** A fresh per-execution epoch. */
export function newJobTerminalEpoch(): string {
  return randomBytes(EPOCH_BYTES).toString("hex");
}

/** Inverse of the above; null for anything that is not one of our ids. */
export function jobIdFromTerminalSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(JOB_TERMINAL_SESSION_PREFIX)) return null;
  const rest = sessionId.slice(JOB_TERMINAL_SESSION_PREFIX.length);
  // The epoch is the LAST colon-separated field; a jobId is a cuid and carries
  // no colon, but parsing from the right is correct even if one ever did.
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const jobId = rest.slice(0, split);
  const epoch = rest.slice(split + 1);
  return jobId.length > 0 && /^[0-9a-f]+$/.test(epoch) ? jobId : null;
}

/** One relayed piece of console output. `seq` is per-session and 1-based. */
export type JobTerminalFrame = { seq: number; data: string };

/** Which of the child's two streams a chunk arrived on. */
export type JobTerminalStream = "stdout" | "stderr";

/**
 * Where frames go. Returns a promise so the host can keep exactly one publish
 * in flight; a rejection is swallowed by the host, never surfaced to the job.
 */
export type JobTerminalSink = (input: {
  jobId: string;
  sessionId: string;
  frames: JobTerminalFrame[];
  /**
   * Frames this session has lost so far, cumulative. Every loss path leaves a
   * hole in `seq`, and `firstSeq` on the read side only reports the brain's own
   * ring trimming — so without this a mid-stream hole would render as
   * continuous output, which is the class of lie this repo keeps closing.
   */
  dropped: number;
}) => Promise<unknown>;

export type JobTerminalHostOptions = {
  publish: JobTerminalSink;
  /** Bytes of console retained locally so a late viewer sees what happened. */
  scrollbackBytes?: number;
  /** Frames buffered for publication before the OLDEST are dropped. */
  maxPendingFrames?: number;
  /** Debounce before a batch is published. */
  flushMs?: number;
  /** Hard ceiling on how long `end()` may wait for the last batch to land. */
  endDrainMs?: number;
  onLog?: (line: string) => void;
};

/**
 * Byte budgets. `SCROLLBACK_BYTES` matches the desktop PtyHost's ring so the two
 * halves of the feature retain a comparable amount of history. An agent can emit
 * a LOT; every one of these is a hard cap, not a target.
 */
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING_FRAMES = 256;
const DEFAULT_FLUSH_MS = 200;
/**
 * `end()` runs inside `executeJob`'s finally, i.e. between the vendor finishing
 * and the job's terminal status being written. One publish can take up to the
 * client's 120s request timeout, and they are chained — so an unbounded wait
 * here would let a wedged brain delay a FINISHED job's terminal write by
 * minutes. That is precisely "the job stalled because someone was watching it".
 * The last batch gets this long and no longer; anything still in flight keeps
 * going harmlessly in the background (its rejection is already caught) and the
 * VIEW is what degrades.
 */
const DEFAULT_END_DRAIN_MS = 2_000;
/** A single frame is split at this size, so one huge write is never one frame. */
const MAX_FRAME_CHARS = 16 * 1024;
/**
 * Raw console characters per publish. This is a WIRE bound, not a memory one:
 * the brain's HTTP body limit is what a batch has to fit inside, and JSON
 * escaping inflates terminal output badly — every ESC becomes the six characters
 * ``, so a worst case is ~6x. 96 KiB of console can therefore reach ~576
 * KiB of body, comfortably under the 2 MiB the publish route declares and under
 * Fastify's 1 MiB default besides.
 *
 * Getting this wrong is silent by nature: an over-limit body is refused whole,
 * and the loudest jobs — the ones actually worth watching — are exactly the ones
 * that would hit it. `queue`/`runDrain` therefore split by this, and a batch the
 * brain still refuses is counted as dropped rather than vanishing.
 */
const MAX_PUBLISH_CHARS = 96 * 1024;
/**
 * Pathological fallback for output carrying NO line terminator at all. See
 * `cut()`: a credential can only escape a streaming scrubber by straddling two
 * scrub passes, so the buffer is held — bounded — rather than split mid-line.
 * Under pipes (which is the transport here, deliberately) every vendor CLI
 * detects a non-tty and writes line-oriented output, so this ceiling is a
 * safety net, not a latency budget.
 */
const NO_TERMINATOR_CEILING_CHARS = 256 * 1024;

/**
 * One job's live console.
 *
 * Created by `JobTerminalHost.openOrAttach`, which is the ONLY entry point:
 * a second call for the same job returns this same object. There is no branch
 * anywhere in this file that starts anything — the child is owned by the
 * executor and this is a view onto it — so "could not find the session" can
 * never become "start a second process".
 */
export class JobTerminalSession {
  /** Frames retained locally, trimmed by total bytes. */
  private readonly ring: JobTerminalFrame[] = [];
  private ringBytes = 0;
  private pendingOut: JobTerminalFrame[] = [];
  /** Partial trailing line per stream, held until it can be safely scrubbed. */
  private readonly partial: Record<JobTerminalStream, string> = {
    stdout: "",
    stderr: "",
  };
  private seq = 0;
  private droppedFrames = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The single running drain, or null. NEVER a growing chain — see `flush`. */
  private drain: Promise<void> | null = null;
  private ended = false;
  /**
   * True after a ceiling emit, until a real line terminator resyncs the stream.
   * See `cut()`: while set, a SECOND ceiling emit would be the one thing that
   * could split a credential, so it drops instead.
   */
  private readonly unterminated: Record<JobTerminalStream, boolean> = {
    stdout: false,
    stderr: false,
  };

  constructor(
    readonly jobId: string,
    readonly sessionId: string,
    private readonly options: Required<
      Omit<JobTerminalHostOptions, "onLog">
    > & { onLog?: (line: string) => void }
  ) {}

  /** Console bytes retained locally (diagnostics + tests). */
  get scrollback(): readonly JobTerminalFrame[] {
    return this.ring;
  }

  /** Frames the outbound queue had to drop. A viewer sees these as a seq gap. */
  get dropped(): number {
    return this.droppedFrames;
  }

  /**
   * The child wrote `chunk` on `stream`. Cheap, synchronous, and total: it can
   * throw nothing back at the caller, because the caller is the vendor's own
   * data handler.
   */
  write(stream: JobTerminalStream, chunk: string): void {
    if (this.ended || chunk.length === 0) return;
    try {
      this.partial[stream] += chunk;
      const emit = this.cut(stream);
      if (emit.length > 0) {
        this.admit(emit);
      }
    } catch {
      // A viewer's buffer is never allowed to take a vendor run down.
    }
  }

  /**
   * The child is done. Flushes the trailing partial lines and awaits the last
   * publish. Resolves even when publication failed — the live view degrading is
   * not the job's problem.
   */
  async end(): Promise<void> {
    if (this.ended) {
      await this.bounded(this.drain ?? Promise.resolve());
      return;
    }
    this.ended = true;
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = this.partial[stream];
        this.partial[stream] = "";
        if (rest.length === 0) continue;
        if (this.unterminated[stream]) {
          // Same rule as the second ceiling emit in `cut()`: this residue is the
          // continuation of an already-emitted unbroken run, so emitting it now
          // would split that run across two scrub passes.
          this.droppedFrames += 1;
          continue;
        }
        this.admit(rest);
      }
    } catch {
      // as above
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.bounded(this.flush());
  }

  /** Wait for `work`, but never longer than the end-drain ceiling. */
  private async bounded(work: Promise<void>): Promise<void> {
    if (this.options.endDrainMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.endDrainMs);
      timer.unref?.();
    });
    try {
      await Promise.race([work.catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Everything in `partial[stream]` that may be scrubbed and emitted.
   *
   * THE ONE RULE: cut only at a LINE TERMINATOR. A streaming scrubber has
   * exactly one way to leak that a whole-text one does not — a credential that
   * straddles two scrub passes, so neither pass sees the `KEY=value` or
   * `Bearer …` shape whole. Neither `\n` nor `\r` can occur inside either
   * shape, so a cut here provably cannot split one. (A holdback does NOT fix
   * this: it moves the boundary, it does not remove it, and the emitted side is
   * already gone by the time the held side is scrubbed.)
   *
   * `\r` counts as a terminator so a carriage-return progress redraw still
   * streams, at no cost to the rule above.
   */
  private cut(stream: JobTerminalStream): string {
    const pending = this.partial[stream];
    const boundary = Math.max(
      pending.lastIndexOf("\n"),
      pending.lastIndexOf("\r")
    );
    if (boundary >= 0) {
      if (this.unterminated[stream]) {
        // Everything up to this terminator is the CONTINUATION of a run the
        // ceiling already emitted, so emitting it would put two halves of one
        // unbroken run into two scrub passes — the straddle this whole function
        // exists to prevent. Drop through the terminator, count it, and resync:
        // the SAME rule the second-ceiling branch and `end()` apply.
        this.unterminated[stream] = false;
        this.partial[stream] = pending.slice(boundary + 1);
        this.droppedFrames += 1;
        return "";
      }
      // A real terminator resyncs the stream: from here every emit is again a
      // run of complete lines.
      return this.withheldPendingSecret(stream, pending, boundary + 1);
    }
    // No terminator anywhere. Rather than split mid-line, hold — and when the
    // hold would stop being bounded, emit the WHOLE buffer as a single piece so
    // the scrubber still sees every credential in it complete.
    if (pending.length >= NO_TERMINATOR_CEILING_CHARS) {
      if (this.unterminated[stream]) {
        this.partial[stream] = "";
        // A SECOND ceiling emit with still no terminator in sight. Emitting it
        // would put two consecutive halves of one unbroken run into two scrub
        // passes — the exact straddle `cut()` exists to prevent. Fail closed:
        // drop it, count it, and let the gap show. A vendor that has written
        // half a megabyte with no `\n` or `\r` is not producing terminal output
        // anyway, and losing a live VIEW beats leaking a credential.
        this.droppedFrames += 1;
        return "";
      }
      this.unterminated[stream] = true;
      return this.withheldPendingSecret(stream, pending, pending.length);
    }
    return "";
  }

  /**
   * Emit `pending[0..cut)`, minus any trailing fragment that is the OPENING of a
   * secret whose value has not arrived yet (`SOME_TOKEN=` at end of line, a bare
   * `Bearer `). Whole-text redaction matches those across the newline, because
   * its separator is `\s*[=:]\s*`; a line-by-line relay would hand key and value
   * to two passes and match in neither. Holding the opening back until its value
   * arrives makes the streaming result identical to the whole-text one.
   */
  private withheldPendingSecret(
    stream: JobTerminalStream,
    pending: string,
    cut: number
  ): string {
    const emit = pending.slice(0, cut);
    const hold = pendingSecretTailLength(emit);
    this.partial[stream] = pending.slice(cut - hold);
    return hold > 0 ? emit.slice(0, emit.length - hold) : emit;
  }

  /** Scrub, split, retain, and queue for publication. */
  private admit(text: string): void {
    // UNTRUSTED VENDOR OUTPUT. Whatever the child printed — including anything
    // it read out of its own environment — is scrubbed HERE, before it is
    // retained or leaves this process. The brain re-scrubs on arrival; neither
    // side treats the other's scrubbing as proof.
    const scrubbed = redactSecrets(text);
    for (let index = 0; index < scrubbed.length; index += MAX_FRAME_CHARS) {
      const data = scrubbed.slice(index, index + MAX_FRAME_CHARS);
      this.seq += 1;
      const frame: JobTerminalFrame = { seq: this.seq, data };
      this.retain(frame);
      this.queue(frame);
    }
    this.schedule();
  }

  private retain(frame: JobTerminalFrame): void {
    this.ring.push(frame);
    this.ringBytes += Buffer.byteLength(frame.data, "utf8");
    while (this.ringBytes > this.options.scrollbackBytes && this.ring.length > 1) {
      const dropped = this.ring.shift();
      if (dropped) {
        this.ringBytes -= Buffer.byteLength(dropped.data, "utf8");
      }
    }
  }

  /**
   * Bounded outbound queue. On overflow the OLDEST frame is dropped: the child
   * is never paused, because pausing it would make a job behave differently
   * depending on whether the publisher is keeping up.
   */
  private queue(frame: JobTerminalFrame): void {
    this.pendingOut.push(frame);
    const overflow = this.pendingOut.length - this.options.maxPendingFrames;
    if (overflow > 0) {
      // One splice, not a shift per frame: shift-in-a-loop is O(n) element
      // moves EACH time against a queue that is already at its cap.
      this.pendingOut.splice(0, overflow);
      this.droppedFrames += overflow;
    }
  }

  private schedule(): void {
    if (this.flushTimer || this.pendingOut.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushMs);
    this.flushTimer.unref?.();
  }

  /**
   * Drain the outbound queue, one publish at a time, never rejecting.
   *
   * A single running drain, NOT a chain of `.then()`s. Chaining looked
   * equivalent and was not: with a slow or wedged brain, every 200ms tick
   * appended another link, and each link's closure pinned its own batch — up to
   * `maxPendingFrames × MAX_FRAME_CHARS` of console text apiece — so the queue
   * cap bounded the queue while the CHAIN grew without limit. The drain loop
   * re-reads `pendingOut` instead, so the cap is the only thing that decides how
   * much a slow publisher can hold, and the overflow drops as designed.
   */
  private flush(): Promise<void> {
    if (!this.drain) {
      this.drain = this.runDrain().finally(() => {
        this.drain = null;
      });
    }
    return this.drain;
  }

  private async runDrain(): Promise<void> {
    while (this.pendingOut.length > 0) {
      const frames = this.takeBatch();
      try {
        await this.options.publish({
          jobId: this.jobId,
          sessionId: this.sessionId,
          frames,
          dropped: this.droppedFrames,
        });
      } catch (error: unknown) {
        // A refused batch is LOST — count it, so the gap it leaves in `seq` is
        // reported rather than rendering as continuous output. Then say so once
        // and carry on: silence here is how a permanently broken live view would
        // look identical to a quiet vendor.
        this.droppedFrames += frames.length;
        this.options.onLog?.(
          `live terminal publish degraded (${frames.length} frame(s) lost): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  /** The next publish-sized slice of the queue, bounded by `MAX_PUBLISH_CHARS`. */
  private takeBatch(): JobTerminalFrame[] {
    let chars = 0;
    let count = 0;
    for (const frame of this.pendingOut) {
      // Always take at least one frame: a single frame is already capped at
      // MAX_FRAME_CHARS, so it can never be too big to send on its own.
      if (count > 0 && chars + frame.data.length > MAX_PUBLISH_CHARS) break;
      chars += frame.data.length;
      count += 1;
    }
    return this.pendingOut.splice(0, count);
  }
}

/**
 * The registry. `openOrAttach` is the one entry point; there is no second
 * function that could create a duplicate for a job that already has one.
 */
export class JobTerminalHost {
  private readonly sessions = new Map<string, JobTerminalSession>();
  private readonly options: Required<Omit<JobTerminalHostOptions, "onLog">> & {
    onLog?: (line: string) => void;
  };

  constructor(options: JobTerminalHostOptions) {
    this.options = {
      publish: options.publish,
      scrollbackBytes: options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES,
      maxPendingFrames: options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
      flushMs: options.flushMs ?? DEFAULT_FLUSH_MS,
      endDrainMs: options.endDrainMs ?? DEFAULT_END_DRAIN_MS,
      ...(options.onLog ? { onLog: options.onLog } : {}),
    };
  }

  /**
   * Create this job's console, or JOIN the one that already exists.
   *
   * A fresh epoch is minted only on CREATE, never on join, so every attach for
   * the life of one execution resolves to the same session and the same id.
   */
  openOrAttach(jobId: string): JobTerminalSession {
    const existing = this.sessions.get(jobId);
    if (existing) return existing;
    const session = new JobTerminalSession(
      jobId,
      jobTerminalSessionId(jobId, newJobTerminalEpoch()),
      this.options
    );
    this.sessions.set(jobId, session);
    return session;
  }

  /** Whether this job already has a console. Never used to decide to create. */
  has(jobId: string): boolean {
    return this.sessions.has(jobId);
  }

  /** Flush and forget one job's console. Never throws. */
  async close(jobId: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    this.sessions.delete(jobId);
    await session.end().catch(() => undefined);
  }
}
