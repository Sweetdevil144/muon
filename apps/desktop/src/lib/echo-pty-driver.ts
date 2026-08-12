import type {
  PtyDriver,
  PtyExit,
  PtySpawnOptions,
} from "@muon/runner";

// Wave 4 slice 5.0 (fake path) — a dependency-free PtyDriver that echoes input +
// prints a banner, so the terminal spine is watchable END TO END (relay → XTerm)
// WITHOUT a real vendor or node-pty. It remains the deterministic diagnostic
// fallback and proves the pipe (bytes render, keystrokes round-trip,
// resize/exit/backpressure flow) when the native module is unavailable.
export class EchoPtyDriver implements PtyDriver {
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: PtyExit) => void> = [];
  private paused = false;
  private readonly pausedBuffer: string[] = [];
  private exited = false;

  constructor(options: PtySpawnOptions) {
    // Banner on the next tick, so listeners attach first (goes to scrollback).
    queueMicrotask(() => {
      this.emit(
        `\x1b[2mmuon dev terminal — ${options.file} (echo driver, no vendor)\x1b[0m\r\n$ `
      );
    });
  }

  write(data: string): void {
    // Echo keystrokes back so typing feels live; translate CR → CRLF + prompt.
    this.emit(data === "\r" ? "\r\n$ " : data);
  }

  resize(): void {
    // No geometry to honor for an echo; accepted so the contract holds.
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pausedBuffer.splice(0).forEach((chunk) => this.deliver(chunk));
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  kill(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of this.exitListeners) {
      listener({ exitCode: 0 });
    }
  }

  private emit(data: string): void {
    if (this.paused) {
      this.pausedBuffer.push(data);
      return;
    }
    this.deliver(data);
  }

  private deliver(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
}
