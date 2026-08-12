// Wave 4 slice 5.0 — the minimal pseudo-terminal contract the PTY host drives.
//
// Deliberately modeled on node-pty's `IPty` (write / resize / pause / resume /
// onData / onExit / kill) so the production adapter (`node-pty-driver.ts`) is a
// thin wrapper, while the host's registry / scrollback / backpressure logic is
// driven in tests by a scripted `FakePtyDriver` with ZERO native dependency.
// This is what lets slice 5.0 step 1 be verified headless (design §5.0) before
// the node-pty packaging spike (Founder Decision D1) is settled on real hardware.

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface PtySpawnOptions {
  file: string;
  args?: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  cols?: number;
  rows?: number;
}

/**
 * The host NEVER touches node-pty directly — only this contract. `pause`/`resume`
 * are OS-level flow control (node-pty stops/starts reading the pty master), which
 * is how backpressure propagates all the way to the child so a `yes`-flood can't
 * pin the UI.
 */
export interface PtyDriver {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExit) => void): void;
  kill(signal?: string): void;
}

export type PtyDriverFactory = (options: PtySpawnOptions) => PtyDriver;

/**
 * A scripted, dependency-free PtyDriver for headless tests. `emit()` plays vendor
 * output (buffered while paused, mirroring the OS holding data under flow
 * control); `finish()` ends the process. Records writes/resizes/kill for
 * assertions.
 */
export class FakePtyDriver implements PtyDriver {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed: string | undefined;
  paused = false;

  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: PtyExit) => void> = [];
  private readonly pausedBuffer: string[] = [];

  constructor(readonly options: PtySpawnOptions) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const buffered = this.pausedBuffer.splice(0);
    for (const chunk of buffered) {
      this.deliver(chunk);
    }
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  kill(signal?: string): void {
    this.killed = signal ?? "SIGTERM";
  }

  /** Test helper: the "vendor" produced output on the terminal. */
  emit(data: string): void {
    if (this.paused) {
      this.pausedBuffer.push(data);
      return;
    }
    this.deliver(data);
  }

  /** Test helper: the child process exited. */
  finish(exitCode = 0, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }

  private deliver(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
}
