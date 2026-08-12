import { createWriteStream, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import { Writable } from "node:stream";

// Size-capped, rotating log sink for the supervised children's stdio.
//
// brain.log reached 83 MB of mostly 2-second HTTP polling noise on the founder's
// machine — large enough that opening it to debug a real failure was itself a
// chore. A supervisor writes a child's stdout/stderr through this sink instead
// of straight into an unbounded file: when the active file passes `maxBytes` it
// is rotated to `<file>.1` (one generation kept, the older one deleted), so the
// on-disk cost of logging is bounded to roughly 2 × maxBytes per stream.
//
// It is a real `Writable`, so `child.stdout.pipe(sink)` keeps working exactly as
// before — including backpressure, which is what makes the pipe safe: a slow
// disk pauses the child rather than growing an unbounded buffer in Electron main.
//
// Log loss is diagnostics loss, never health evidence: every filesystem error is
// swallowed and the sink keeps accepting writes.

export type LogSinkOptions = {
  /** Absolute path of the active log file. */
  file: string;
  /** Rotate once the active file passes this many bytes. */
  maxBytes?: number;
  /** File mode for the log (owner-only by default: logs are private). */
  mode?: number;
  /** Optional mirror, used by debug mode to tee the child's output to the terminal. */
  tee?: (chunk: string) => void;
};

/** 16 MB active + one 16 MB rotated generation per stream. */
export const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;

export class RotatingLogSink extends Writable {
  private stream: WriteStream | null = null;
  private bytes = 0;
  private shuttingDown = false;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly mode: number;
  private readonly tee?: (chunk: string) => void;

  constructor(options: LogSinkOptions) {
    super({ decodeStrings: true });
    this.file = options.file;
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.mode = options.mode ?? 0o600;
    this.tee = options.tee;
  }

  /** The rotated generation's path (`<file>.1`). */
  static rotatedPath(file: string): string {
    return `${file}.1`;
  }

  private open(): void {
    if (this.stream || this.shuttingDown) {
      return;
    }
    try {
      this.bytes = statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
    try {
      this.stream = createWriteStream(this.file, {
        flags: "a",
        mode: this.mode,
      });
      // A log write failure must never surface as an unhandled error event.
      this.stream.on("error", () => undefined);
    } catch {
      this.stream = null;
    }
  }

  private rotate(done: () => void): void {
    const stream = this.stream;
    this.stream = null;
    const swap = () => {
      try {
        rmSync(RotatingLogSink.rotatedPath(this.file), { force: true });
        renameSync(this.file, RotatingLogSink.rotatedPath(this.file));
      } catch {
        // Best effort: if the rename fails we keep appending to the same file
        // rather than losing the stream.
      }
      this.bytes = 0;
      done();
    };
    if (!stream) {
      swap();
      return;
    }
    stream.end(swap);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (this.tee) {
      try {
        this.tee(buffer.toString("utf8"));
      } catch {
        // A broken terminal must not stop the file sink.
      }
    }
    if (this.shuttingDown) {
      callback();
      return;
    }
    this.open();
    const stream = this.stream;
    if (!stream) {
      callback();
      return;
    }
    this.bytes += buffer.byteLength;
    const shouldRotate = this.bytes >= this.maxBytes;
    stream.write(buffer, () => {
      if (!shouldRotate || this.shuttingDown) {
        callback();
        return;
      }
      this.rotate(() => callback());
    });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.shuttingDown = true;
    const stream = this.stream;
    this.stream = null;
    if (!stream) {
      callback();
      return;
    }
    stream.end(() => callback());
  }
}

/** Convenience factory (keeps call sites free of `new` noise). */
export function createLogSink(options: LogSinkOptions): RotatingLogSink {
  return new RotatingLogSink(options);
}

/**
 * Resolve the per-stream cap from the environment. `MUON_LOG_MAX_BYTES=0`
 * disables rotation entirely (kept as an escape hatch for a long capture run).
 */
export function logMaxBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.MUON_LOG_MAX_BYTES?.trim();
  if (!raw) {
    return DEFAULT_LOG_MAX_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LOG_MAX_BYTES;
  }
  // 0 → effectively unbounded (Number.MAX_SAFE_INTEGER never trips in practice).
  return parsed === 0 ? Number.MAX_SAFE_INTEGER : parsed;
}
